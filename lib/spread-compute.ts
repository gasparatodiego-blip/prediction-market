// lib/spread-compute.ts — single source of truth for funding-spread computation.
// Server-only (reads /tmp via fs). For client-safe types + position sizing,
// see lib/spread-types.ts.
//
// Imported by:
//   app/api/crypto/route.ts        (fetched by the funding-arb dashboard)
//   app/page.tsx                   (landing "live inside" card)
//
// DO NOT re-derive fundingRate → $/day math anywhere else. getCryptoSpreadsData()
// and calcSpreadSizing() (lib/spread-types.ts) are the only places that turn raw
// exchange-prices.json data into a spread's dollar value — every surface that
// shows that number must call through here so the dashboard and the landing
// page can never disagree.
import fs from 'fs';
import {
  annualize,
  roundTripFeeByVenue,
  netApy30d,
  breakevenDays,
  spreadStatus,
  VENUE_FEE_PCT,
} from '@/lib/funding-math';
import type { FuturesCoin, SpreadItem, SlipPoint, CryptoSpreadsData } from '@/lib/spread-types';

export type { FuturesCoin, SlipPoint, SpreadItem, SpreadsMeta, CryptoSpreadsData, Leverage } from '@/lib/spread-types';
export { calcSpreadSizing } from '@/lib/spread-types';

const EXCHANGE_FILE = '/tmp/exchange-prices.json';
const UNI_FILE      = '/tmp/unified-opportunities.json';
// treat as missing if agent15 hasn't written within 10 min (runs every 60 s)
const UNI_STALE_MS  = 10 * 60_000;

function isDex(exchange: string): boolean {
  return exchange === 'hyperliquid' || exchange === 'dydx' || exchange === 'aster' || exchange === 'paradex' || exchange === 'edgex' || exchange === 'grvt' || exchange === 'lighter';
}

function liqUsd(data: FuturesCoin | undefined): number {
  return Math.max(data?.openInterestUsd ?? 0, data?.vol24hUsd ?? 0);
}

function liqTier(usd: number): string {
  if (usd >= 50_000_000) return 'DEEP';
  if (usd >= 10_000_000) return 'OK';
  if (usd >= 1_000_000)  return 'THIN';
  return 'VERY THIN';
}

export function computeSpreads(
  futures: Record<string, Record<string, FuturesCoin>>
): SpreadItem[] {
  const byExchange: Record<string, { exchange: string; fr: number; intervalHours: number; nextFundingTime?: number; dex: boolean }[]> = {};

  for (const [ex, coins] of Object.entries(futures)) {
    for (const [coin, data] of Object.entries(coins || {})) {
      const fr = data?.fundingRate;
      if (fr == null || typeof fr !== 'number' || !isFinite(fr)) continue;
      const intervalHours = data.fundingIntervalHours ?? 8;
      // Carry the venue's real next-funding timestamp through when it captured one
      // (display-only, for the per-leg countdown). Undefined stays undefined.
      const nextFundingTime = typeof data.nextFundingTime === 'number' && data.nextFundingTime > 0
        ? data.nextFundingTime : undefined;
      if (!byExchange[coin]) byExchange[coin] = [];
      byExchange[coin].push({ exchange: ex, fr, intervalHours, nextFundingTime, dex: isDex(ex) });
    }
  }

  const out: SpreadItem[] = [];

  for (const [coin, list] of Object.entries(byExchange)) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];

        const annA     = annualize(A.fr, A.intervalHours);
        const annB     = annualize(B.fr, B.intervalHours);
        const grossApy = +(Math.abs(annA - annB)).toFixed(2);
        if (grossApy === 0) continue;

        const shortSide = annA >= annB ? A : B;
        const longSide  = annA >= annB ? B : A;

        // Per-venue fees: HL=0.025%, dYdX=0.05%, CEX=0.04%
        const totalFees = roundTripFeeByVenue(shortSide.exchange, longSide.exchange);
        const net30d    = netApy30d(grossApy, totalFees);
        // Honest-engine: payback recovers entry+exit fees from NET $/day (after
        // fees), not gross. net30d and totalFees are both %/yr → basis-consistent.
        // Non-positive net has no valid payback → null (renders "—", never cashable).
        const beDays    = net30d > 0 ? breakevenDays(net30d, totalFees) : null;
        const status    = beDays === null ? 'MARGINAL' : spreadStatus(beDays);
        const dexLeg    = shortSide.dex || longSide.dex;

        // Liquidity from the thinner leg
        const shortLiq  = liqUsd(futures[shortSide.exchange]?.[coin]);
        const longLiq   = liqUsd(futures[longSide.exchange]?.[coin]);
        const minLiq    = shortLiq > 0 && longLiq > 0
          ? Math.min(shortLiq, longLiq)
          : Math.max(shortLiq, longLiq);
        const tier      = minLiq > 0 ? liqTier(minLiq) : null;
        const capUsd    = minLiq > 0 ? Math.round(Math.min(minLiq * 0.01, 500_000)) : null;
        const thin      = tier === 'THIN' || tier === 'VERY THIN';

        out.push({
          coin,
          shortExchange:      shortSide.exchange,
          longExchange:       longSide.exchange,
          frShort:            +shortSide.fr.toFixed(6),
          frLong:             +longSide.fr.toFixed(6),
          intervalHoursShort: shortSide.intervalHours,
          intervalHoursLong:  longSide.intervalHours,
          nextFundingTimeShort: shortSide.nextFundingTime,
          nextFundingTimeLong:  longSide.nextFundingTime,
          shortIsDex:         shortSide.dex,
          longIsDex:          longSide.dex,
          hasDexLeg:          dexLeg,
          grossApy,
          netApy30d:          net30d,
          totalFeesPct:       +totalFees.toFixed(3),
          breakevenDays:      beDays,
          status,
          liquidityTier:      tier,
          capacityUsd:        capUsd,
          thinFlag:             thin,
          depthThin:            false,  // overwritten by UNI lookup
          depthNote:            null,   // overwritten by UNI lookup
          oneLegUnverified:     false,  // overwritten by UNI lookup
          slipCurve:            null,   // overwritten by UNI lookup
          greenCapacityUsd:     null,   // overwritten by UNI lookup
          slipCurveMaxFillable: null,   // overwritten by UNI lookup
        });
      }
    }
  }

  // netApy30d is always freshly computed (non-null) at this point — redaction
  // for free tier happens later, in app/api/crypto/route.ts via redactForTier.
  return out.sort((a, b) => (b.netApy30d ?? 0) - (a.netApy30d ?? 0));
}

/**
 * Reads /tmp/exchange-prices.json + /tmp/unified-opportunities.json and returns
 * the exact payload app/api/crypto/route.ts serves. Both the funding-arb dashboard
 * (via that API) and the landing page (calling this directly, server-side) read
 * through this one function — there is no second implementation of this math.
 */
export function getCryptoSpreadsData(): CryptoSpreadsData {
  try {
    const raw          = JSON.parse(fs.readFileSync(EXCHANGE_FILE, 'utf8'));
    const generatedAt  = typeof raw.fetchedAt === 'number' ? raw.fetchedAt : null;
    const staleMinutes = generatedAt != null
      ? Math.floor((Date.now() - generatedAt) / 60_000)
      : null;

    // Build direction-independent lookup: agent15 keys by trailing-rate SHORT/LONG order;
    // this module keys by predicted-rate order — these can differ. Normalize to sorted pair.
    // Unknown (stale/missing file, key absent) → oneLegUnverified: true. Never default to false.
    interface UniEntry {
      oneLegUnverified:    boolean;
      capacityUsd?:        number | null;
      depthThin?:          boolean;
      depthNote?:          string | null;
      slipCurve?:          SlipPoint[] | null;
      greenCapacityUsd?:   number | null;
      slipCurveMaxFillable?: number | null;
    }
    const uniLookup = new Map<string, UniEntry>();
    try {
      const uniRaw     = JSON.parse(fs.readFileSync(UNI_FILE, 'utf8'));
      const fundingAge = Date.now() - (uniRaw.sources?.funding?.updatedAt ?? 0);
      if (fundingAge < UNI_STALE_MS) {
        for (const opp of (uniRaw.opportunities ?? []) as {
          type: string; id: string;
          oneLegUnverified: boolean;
          capacityUsd?: number | null;
          depthThin?: boolean;
          depthNote?: string | null;
          slipCurve?: SlipPoint[] | null;
          greenCapacityUsd?: number | null;
          slipCurveMaxFillable?: number | null;
        }[]) {
          if (opp.type !== 'FUNDING') continue;
          const parts = (opp.id ?? '').split('-');
          if (parts.length !== 4 || parts[0] !== 'funding') continue;
          const [, coin, ex1, ex2] = parts;
          uniLookup.set(`${coin}|${[ex1, ex2].sort().join('|')}`, {
            oneLegUnverified:    opp.oneLegUnverified === true,
            capacityUsd:         typeof opp.capacityUsd === 'number' ? opp.capacityUsd : undefined,
            depthThin:           opp.depthThin === true,
            depthNote:           typeof opp.depthNote === 'string' ? opp.depthNote : null,
            slipCurve:           Array.isArray(opp.slipCurve) ? opp.slipCurve : null,
            greenCapacityUsd:    typeof opp.greenCapacityUsd === 'number' ? opp.greenCapacityUsd : null,
            slipCurveMaxFillable: typeof opp.slipCurveMaxFillable === 'number' ? opp.slipCurveMaxFillable : null,
          });
        }
      }
      // stale branch falls through: uniLookup stays empty → all keys missing → all demote
    } catch { /* missing/unreadable: uniLookup empty → all rows default oneLegUnverified: true */ }

    const spreads = computeSpreads(raw.futures ?? {}).map(s => {
      const key = `${s.coin}|${[s.shortExchange, s.longExchange].sort().join('|')}`;
      const lu  = uniLookup.get(key);
      return {
        ...s,
        oneLegUnverified:     lu === undefined ? true : lu.oneLegUnverified,
        capacityUsd:          lu?.capacityUsd          !== undefined ? lu.capacityUsd          : s.capacityUsd,
        depthThin:            lu?.depthThin            !== undefined ? lu.depthThin            : false,
        depthNote:            lu?.depthNote            !== undefined ? lu.depthNote            : null,
        slipCurve:            lu?.slipCurve            !== undefined ? lu.slipCurve            : null,
        greenCapacityUsd:     lu?.greenCapacityUsd     !== undefined ? lu.greenCapacityUsd     : null,
        slipCurveMaxFillable: lu?.slipCurveMaxFillable !== undefined ? lu.slipCurveMaxFillable : null,
      };
    });

    return {
      ok:          true,
      generatedAt,
      staleMinutes,
      futures:     raw.futures     ?? {},
      spot:        raw.exchanges   ?? {},
      basisTrades: raw.basisTrades ?? [],
      highFunding: raw.highFunding ?? [],
      cexArb:      raw.cexArb      ?? [],
      spreads,
      meta: {
        feePerLeg:    { cex: VENUE_FEE_PCT.cex, dex: VENUE_FEE_PCT.dex, gateio: VENUE_FEE_PCT.gateio, bitget: VENUE_FEE_PCT.bitget },
        legCount:     4,
        periodsPerYr: { cex: 1095, hl: 8760 },
        note:         'CEX/Gate.io/Bitget settle every 8h; Hyperliquid/dYdX settle hourly. annualize(rate, intervalHours) normalises all venues to %/yr.',
      },
    };
  } catch {
    return {
      ok:          false,
      generatedAt: null,
      staleMinutes: null,
      futures:     {},
      spot:        {},
      basisTrades: [],
      highFunding: [],
      cexArb:      [],
      spreads:     [],
      meta:        null,
    };
  }
}

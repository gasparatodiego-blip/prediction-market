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
  estimatePerpSpot,
  venueFeePct,
  spotVenueFeePct,
} from '@/lib/funding-math';
import type { FuturesCoin, SpreadItem, SlipPoint, CryptoSpreadsData, RwaObservation, Persistence, PerpSpotRow, PerpSpotRegime, UsdcArbRow } from '@/lib/spread-types';
import { isRwaKey } from '@/lib/rwa';
// Shared dead/illiquid/cap-pinned contract guard — the SAME one agent15 applies when it
// builds the producer feed. Applying it here keeps the serve path from re-manufacturing
// phantom legs (e.g. edgeX dust/cap-pinned funding) that agent15 already excluded and
// that display-sanity would otherwise reject at the 200%/yr cap every request.
import { isDeadContract, buildPeerMarks } from '@/lib/contract-liveness';
// USDC-margined divergence lane. Plain-JS SSOT shared with agent29-verifier so the
// served rows and the independent re-read derive identically from the same snapshot.
import { computeUsdcArb } from '@/lib/usdc-arb';

export type { FuturesCoin, SlipPoint, SpreadItem, SpreadsMeta, CryptoSpreadsData, Leverage, Persistence } from '@/lib/spread-types';
export { calcSpreadSizing } from '@/lib/spread-types';

const EXCHANGE_FILE = '/tmp/exchange-prices.json';
const UNI_FILE      = '/tmp/unified-opportunities.json';
const HISTORY_FILE  = '/tmp/funding-history-cache.json';   // agent15 48h ring buffer (real settled rates)
const PERP_SPOT_FILE = '/tmp/perp-spot.json';              // agent28 best-short-venue carry feed
// treat as missing if agent15 hasn't written within 10 min (runs every 60 s)
const UNI_STALE_MS  = 10 * 60_000;
const PERP_SPOT_STALE_MS = 10 * 60_000;   // agent28 runs every 60 s → stale after 10 min

// Reference capital ($1,000 per leg) at which perp-spot dollar figures are precomputed.
// Every $ field scales linearly with capital, so the client multiplies by capital/1000.
const PERP_SPOT_REF_CAPITAL = 1000;

// Read agent28's perp-spot feed and attach honest per-$1k dollar math (estimatePerpSpot).
// Raw inputs pass through as teaser; the `edge` object is what paid-gating redacts.
// Missing/stale/unreadable → empty list + stale flag (shown calmly downstream).
function readPerpSpot(): { rows: PerpSpotRow[]; stale: boolean } {
  try {
    const raw = JSON.parse(fs.readFileSync(PERP_SPOT_FILE, 'utf8'));
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0;
    const stale = raw.stale === true || (Date.now() - updatedAt) > PERP_SPOT_STALE_MS;
    const src: unknown[] = Array.isArray(raw.rows) ? raw.rows : [];
    const rows: PerpSpotRow[] = src.map((r) => {
      const row = r as Record<string, unknown>;
      const coin        = String(row.coin ?? '');
      const shortVenue  = String(row.shortVenue ?? '');
      const spotVenue   = String(row.spotVenueSuggested ?? 'binance');
      const fundingPct8h = typeof row.fundingPct8h === 'number' ? row.fundingPct8h : 0;
      const trailing    = typeof row.trailingPositiveSettlements === 'number' ? row.trailingPositiveSettlements : 0;

      const e = estimatePerpSpot({
        capitalPerLeg: PERP_SPOT_REF_CAPITAL,
        fundingPct8h,
        shortVenue,
        spotVenue,
        trailingPositiveSettlements: trailing,
      });

      return {
        coin,
        shortVenue,
        spotVenueSuggested:          spotVenue,
        spotVenueVerified:           row.spotVenueVerified === true,
        spotExecutable:              row.spotExecutable === true,
        spotAsk:                     typeof row.spotAsk === 'number' ? row.spotAsk : null,
        spotBid:                     typeof row.spotBid === 'number' ? row.spotBid : null,
        spotCapacityUsd:             typeof row.spotCapacityUsd === 'number' ? row.spotCapacityUsd : null,
        spotBookAt:                  typeof row.spotBookAt === 'number' ? row.spotBookAt : null,
        perpShortDepthUsd:           typeof row.perpShortDepthUsd === 'number' ? row.perpShortDepthUsd : null,
        perpDepthWalked:             row.perpDepthWalked === true,
        perpBookAt:                  typeof row.perpBookAt === 'number' ? row.perpBookAt : null,
        wholeTradeCapacityUsd:       typeof row.wholeTradeCapacityUsd === 'number' ? row.wholeTradeCapacityUsd : null,
        capacityBind:                (['spot', 'perp', 'spot-only', 'perp-only', 'none'].includes(row.capacityBind as string)
                                       ? row.capacityBind : 'none') as PerpSpotRow['capacityBind'],
        fundingRateNative:           typeof row.fundingRateNative === 'number' ? row.fundingRateNative : 0,
        intervalH:                   typeof row.intervalH === 'number' ? row.intervalH : 8,
        fundingPct8h,
        trailingPositiveSettlements: trailing,
        markPrice:                   typeof row.markPrice === 'number' ? row.markPrice : null,
        vol24hUsd:                   typeof row.vol24hUsd === 'number' ? row.vol24hUsd : null,
        edge: {
          grossPerDay1k:             e.grossPerDay,
          feesOneTime1k:             e.feesOneTime,
          netPerDay1k:               e.netPerDayAmortized30,
          breakevenDays:             isFinite(e.breakevenDays) ? e.breakevenDays : null,
          annualizedRunRatePct:      e.annualizedRunRatePct,
          netAnnualizedOnCapitalPct: e.netAnnualizedOnCapitalPct,
          annualizedCapped:          e.annualizedCapped,
          perpFeePct:                e.perpFeePct,
          spotFeePct:                e.spotFeePct,
        },
      };
    });
    return { rows, stale };
  } catch {
    return { rows: [], stale: true };
  }
}

// Live funding-regime banner: is funding HOT (best rates clear the fee hurdle) or CALM
// (even the best rates are below it)? Real computation from current rates — no hardcoded
// mood. Metric = median of the top-quartile |funding| across all venue×coin observations,
// normalized to %/8h. Threshold = the %/8h needed to recover a typical perp-spot round-trip
// fee over a 30-day hold (fee / (30d × 3 settlements/day)).
function computePerpSpotRegime(futures: Record<string, Record<string, FuturesCoin>>): PerpSpotRegime | null {
  const abs: number[] = [];
  let positiveCount = 0;
  for (const coins of Object.values(futures || {})) {
    for (const [coin, d] of Object.entries(coins || {})) {
      if (isRwaKey(coin)) continue;
      const fr = (d as { fundingRate?: number })?.fundingRate;
      const ih = (d as { fundingIntervalHours?: number })?.fundingIntervalHours;
      if (typeof fr !== 'number' || !isFinite(fr)) continue;
      const intervalH = typeof ih === 'number' && ih > 0 ? ih : 8;
      const pct8h = fr * (8 / intervalH);   // normalize to %/8h (already ×100)
      abs.push(Math.abs(pct8h));
      if (pct8h > 0) positiveCount++;
    }
  }
  if (abs.length === 0) return null;

  // Typical perp-spot round-trip fee: cex perp (open+close) + binance spot (buy+sell).
  const refRoundTripPct = venueFeePct('binance') * 2 + spotVenueFeePct('binance') * 2;
  const feeBreakevenPct8h = refRoundTripPct / (30 * 3);   // recover over a 30-day hold

  const sorted = abs.slice().sort((a, b) => b - a);           // desc
  const qCount = Math.max(1, Math.ceil(sorted.length / 4));   // top quartile
  const topQ   = sorted.slice(0, qCount);
  const mid    = Math.floor(topQ.length / 2);
  const medianTopQuartile = topQ.length % 2 === 1
    ? topQ[mid]
    : (topQ[mid - 1] + topQ[mid]) / 2;

  // How many observations' magnitude clears the fee hurdle (context for the copy).
  const aboveBk = abs.filter(v => v > feeBreakevenPct8h).length;

  return {
    state: medianTopQuartile > feeBreakevenPct8h ? 'HOT' : 'CALM',
    medianTopQuartilePct8h: +medianTopQuartile.toFixed(5),
    feeBreakevenPct8h:      +feeBreakevenPct8h.toFixed(5),
    sampleCount:            abs.length,
    positiveCount,
    aboveBreakevenCount:    aboveBk,
  };
}

// ── Spread-persistence (real 48h history) ─────────────────────────────────────
// Reads agent15's ring buffer: data.<venue>.<coin> = [{ t, rate }, …] newest-first (t ms).
// Everything here is derived ONLY from real accumulated settlements — no interpolation,
// no assumed 48h; windowHours always equals the true available span. See Persistence type.
type HistPoint  = { t: number; rate: number };
type HistCache  = Record<string, Record<string, Array<HistPoint | number>>>;
const MAX_SPARK   = 48;    // display cap for the sparkline/timeline (points), not a monetary knob
const STABLE_CV   = 0.35;  // net-spread coeff-of-variation below this → "stabile" (task-sanctioned flag)

function readHistory(): HistCache {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')).data || {}; }
  catch { return {}; }
}

// Normalize a stored series to sorted-ascending { t, rate }. Legacy flat-number entries carry
// no timestamp → unusable for time alignment, so they're dropped (the buffer re-seeds them
// with timestamps within one refresh; see agent15 migration).
function legSeries(hCache: HistCache, venue: string, coin: string): HistPoint[] {
  const raw = (hCache[venue] || {})[coin] || [];
  const pts: HistPoint[] = [];
  for (const p of raw) {
    if (typeof p === 'number') continue;
    if (p && isFinite(p.t) && isFinite(p.rate)) pts.push({ t: p.t, rate: p.rate });
  }
  return pts.sort((a, b) => a.t - b.t);
}

function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  out[out.length - 1] = arr[arr.length - 1];   // always keep the newest
  return out;
}

// Per pair: align the two legs' real history and compute how long the FIXED position
// (short shortEx / long longEx) has stayed profitable. Reuses the card's own net-funding
// math — net(t) = annualize(shortRate, shortInt) − annualize(longRate, longInt), SIGNED —
// so "profitable" means the position we display would have earned at that settlement.
function computePersistence(
  coin: string,
  shortEx: string, shortInt: number,
  longEx: string,  longInt: number,
  hCache: HistCache,
): Persistence | null {
  const sHist = legSeries(hCache, shortEx, coin);
  const lHist = legSeries(hCache, longEx,  coin);
  if (sHist.length < 2 || lHist.length < 2) return null;

  // Aligned window = where BOTH legs have real coverage (from the later of the two starts).
  const start = Math.max(sHist[0].t, lHist[0].t);
  const times = Array.from(new Set([...sHist, ...lHist].map(p => p.t)))
    .filter(t => t >= start)
    .sort((a, b) => a - b);
  if (times.length < 2) return null;

  // Forward-fill each leg's last settled rate at each event time. A funding rate is a step
  // function that holds until the next settlement — using the most-recent settlement ≤ t is
  // the leg's TRUE state, not interpolation.
  const net: { t: number; v: number }[] = [];
  let si = 0, li = 0;
  for (const t of times) {
    while (si + 1 < sHist.length && sHist[si + 1].t <= t) si++;
    while (li + 1 < lHist.length && lHist[li + 1].t <= t) li++;
    if (sHist[si].t > t || lHist[li].t > t) continue;   // no settlement yet on one leg
    net.push({ t, v: annualize(sHist[si].rate, shortInt) - annualize(lHist[li].rate, longInt) });
  }
  if (net.length < 2) return null;

  const newest = net[net.length - 1];
  const oldest = net[0];
  const windowHours = +((newest.t - oldest.t) / 3_600_000).toFixed(1);

  // Contiguous profitable run ending at the newest sample, measured by TIME (handles mixed
  // 1h/8h cadences). 0 if the newest settled spread is not profitable.
  let hours = 0;
  if (newest.v > 0) {
    let boundaryT = newest.t;
    for (let k = net.length - 1; k >= 0; k--) {
      if (net[k].v > 0) boundaryT = net[k].t; else break;
    }
    hours = +((newest.t - boundaryT) / 3_600_000).toFixed(1);
  }

  // Stability: coefficient of variation of the net-spread series (honest magnitude-wobble read).
  const vals = net.map(p => p.v);
  const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
  const stdev = Math.sqrt(vals.reduce((s, x) => s + (x - mean) ** 2, 0) / vals.length);
  const cvRaw = Math.abs(mean) > 1e-9 ? stdev / Math.abs(mean) : (stdev > 1e-9 ? 9.99 : 0);
  const cv = Math.min(+cvRaw.toFixed(2), 9.99);
  const stability: 'stabile' | 'variabile' = cv < STABLE_CV ? 'stabile' : 'variabile';

  // Timeline bar (sign-only) + normalized spark SHAPE. Neither exposes the absolute %/yr edge
  // (redacted premium) — only how long it was green and how much it wobbled.
  const capped = downsample(net, MAX_SPARK);
  const bar = capped.map(p => (p.v > 0 ? 1 : 0));
  const lo = Math.min(...capped.map(p => p.v));
  const hi = Math.max(...capped.map(p => p.v));
  const range = hi - lo;
  const spark = capped.map(p => (range > 1e-9 ? +(((p.v - lo) / range).toFixed(3)) : 0.5));

  return { hours, windowHours, stability, cv, spark, bar };
}

function isDex(exchange: string): boolean {
  return exchange === 'hyperliquid' || exchange === 'dydx' || exchange === 'aster' || exchange === 'paradex' || exchange === 'edgex' || exchange === 'grvt' || exchange === 'lighter' || exchange === 'extended' || exchange === 'pacifica' || exchange === 'apex';
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
  futures: Record<string, Record<string, FuturesCoin>>,
  history: HistCache = {},
): SpreadItem[] {
  const byExchange: Record<string, { exchange: string; fr: number; intervalHours: number; nextFundingTime?: number; dex: boolean }[]> = {};

  // Mirror agent15's producer-side guard: exclude dead/illiquid/cap-pinned legs (dust OI,
  // frozen mark, funding pinned at cap, stalled clock) so they never form a phantom pair
  // on the serve path. Silent here — computeSpreads runs per request, and agent15 already
  // logs each exclusion once per cycle; display-sanity remains the last-line backstop.
  const now       = Date.now();
  const peerMarks = buildPeerMarks(futures);

  for (const [ex, coins] of Object.entries(futures)) {
    for (const [coin, data] of Object.entries(coins || {})) {
      const fr = data?.fundingRate;
      if (fr == null || typeof fr !== 'number' || !isFinite(fr)) continue;
      const hist = history[ex]?.[coin] ?? [];
      if (isDeadContract(ex, coin, data, hist, { now, peerMarks: peerMarks[coin] }).dead) continue;
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
    if (isRwaKey(coin)) continue;   // RWA commodities are a separate observation lane (see getCryptoSpreadsData → rwa)
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];

        const annA     = annualize(A.fr, A.intervalHours);
        const annB     = annualize(B.fr, B.intervalHours);
        const grossApy = +(Math.abs(annA - annB)).toFixed(2);
        if (grossApy === 0) continue;

        const shortSide = annA >= annB ? A : B;
        const longSide  = annA >= annB ? B : A;

        // Past track record from real 48h history (null when not enough aligned points yet).
        const persistence = computePersistence(
          coin,
          shortSide.exchange, shortSide.intervalHours,
          longSide.exchange,  longSide.intervalHours,
          history,
        );

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
          downgradeReason:    null,   // set later, once UNI-lookup guards are known
          liquidityTier:      tier,
          capacityUsd:        capUsd,
          thinFlag:             thin,
          depthThin:            false,  // overwritten by UNI lookup
          depthNote:            null,   // overwritten by UNI lookup
          oneLegUnverified:     false,  // overwritten by UNI lookup
          slipCurve:            null,   // overwritten by UNI lookup
          greenCapacityUsd:     null,   // overwritten by UNI lookup
          slipCurveMaxFillable: null,   // overwritten by UNI lookup
          persistence,
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
    const rwaRows: RwaObservation[] = [];
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
          // RWA commodities (beta) — observation lane. Pass through per-leg funding + REAL
          // two-legged 20bps book-depth (bookDepthUsd). Never carries a cashable net/day.
          if (opp.type === 'RWA') {
            const o = opp as unknown as {
              underlying?: string; label?: string; note?: string;
              bookDepthUsd?: number | null; depthThin?: boolean; slipCurveMaxFillable?: number | null;
              monolegOnly?: boolean;
              legs?: { venue?: string; platform?: string; price?: number; intervalHours?: number; rate8h?: number; settledRate8h?: number; trailingRate?: number; spike?: boolean; confirmed?: boolean }[];
              divergence?: RwaObservation['divergence'];
            };
            if (Array.isArray(o.legs) && o.legs.length >= 2) {
              rwaRows.push({
                underlying: String(o.underlying ?? ''),
                label:      String(o.label ?? o.underlying ?? ''),
                assetClass: 'commodity',
                legs: o.legs.map(l => ({
                  venue:         String(l.venue ?? ''),
                  platform:      String(l.platform ?? l.venue ?? ''),
                  fundingRate:   typeof l.price === 'number' ? l.price : 0,
                  intervalHours: typeof l.intervalHours === 'number' ? l.intervalHours : 8,
                  rate8h:        typeof l.rate8h === 'number' ? l.rate8h : 0,
                  // Settled (trailing) %/8h is the honest headline; fall back to the
                  // instantaneous rate only if a pre-settled snapshot lacks it.
                  settledRate8h: typeof l.settledRate8h === 'number' ? l.settledRate8h : (typeof l.rate8h === 'number' ? l.rate8h : 0),
                  trailingRate:  typeof l.trailingRate === 'number' ? l.trailingRate : 0,
                  spike:         l.spike === true,
                  confirmed:     l.confirmed === true,
                })),
                // Real two-legged trailing divergence (beta). Pass through as-is; netApy is
                // paid-gated downstream (lib/paid-gating.ts crypto: 'rwa[].divergence.netApy').
                // Single-leg rows never carry a two-sided divergence (belt-and-suspenders:
                // the producer already nulls it, but never trust a two-sided figure here).
                divergence:   o.monolegOnly === true ? null : (o.divergence ?? null),
                monolegOnly:  o.monolegOnly === true,
                // Real 20bps two-legged executable depth (limiting leg). Fall back to the
                // ladder max-fillable only if a pre-Block-#2 snapshot lacks it.
                bookDepthUsd: typeof o.bookDepthUsd === 'number' ? o.bookDepthUsd
                            : typeof o.slipCurveMaxFillable === 'number' ? o.slipCurveMaxFillable : null,
                depthThin:    o.depthThin === true,
                note:         String(o.note ?? 'beta · signal-only · not cashable yet'),
              });
            }
            continue;
          }
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

    const spreads = computeSpreads(raw.futures ?? {}, readHistory()).map(s => {
      const key = `${s.coin}|${[s.shortExchange, s.longExchange].sort().join('|')}`;
      const lu  = uniLookup.get(key);
      const oneLegUnverified = lu === undefined ? true : lu.oneLegUnverified;

      // Honest tiering: HARVEST is the most attractive label and must imply a cashable,
      // real-depth opportunity. Downgrade to CAUTION (never hide) when the book is VERY THIN
      // or one leg contributes no funding (frShort/frLong === 0 → single-leg pseudo-spread).
      // Classification ONLY — net/day, capacity, and fees are untouched; this just refuses to
      // paint a thin/single-leg pair as HARVEST. A one-leg-unverified (predicted-rate) pair is
      // intentionally NOT downgraded here — it ranks by payback like any other pair (owner
      // decision); the oneLegUnverified field is preserved for downstream alert suppression.
      const veryThin  = s.liquidityTier === 'VERY THIN';
      const singleLeg = s.frShort === 0 || s.frLong === 0;
      const downgraded = s.status === 'HARVEST' && (veryThin || singleLeg);
      const status    = downgraded ? 'CAUTION' as const : s.status;
      // Preserve WHY the demotion happened so the card can show a transparent
      // reason chip (thin book vs one-sided) instead of a bare, contradictory
      // "CAUTION" next to a short payback. VERY THIN wins when both apply.
      const downgradeReason: 'thin-book' | 'one-sided' | null =
        !downgraded ? null : veryThin ? 'thin-book' : 'one-sided';

      return {
        ...s,
        status,
        downgradeReason,
        oneLegUnverified,
        capacityUsd:          lu?.capacityUsd          !== undefined ? lu.capacityUsd          : s.capacityUsd,
        depthThin:            lu?.depthThin            !== undefined ? lu.depthThin            : false,
        depthNote:            lu?.depthNote            !== undefined ? lu.depthNote            : null,
        slipCurve:            lu?.slipCurve            !== undefined ? lu.slipCurve            : null,
        greenCapacityUsd:     lu?.greenCapacityUsd     !== undefined ? lu.greenCapacityUsd     : null,
        slipCurveMaxFillable: lu?.slipCurveMaxFillable !== undefined ? lu.slipCurveMaxFillable : null,
      };
    });

    const perpSpotFeed = readPerpSpot();
    const perpSpotRegime = computePerpSpotRegime(raw.futures ?? {});

    // USDC-margined divergence lane (majors). Same guards + sourced fees; net/day primary.
    // Non-silent: every guard exclusion is logged (the auditor watches this signal).
    const usdc = computeUsdcArb(raw.futures ?? {}, raw.futuresUsdc ?? {}, readHistory(), Date.now());
    for (const e of usdc.excluded) console.log(`usdc-arb-exclude ${e.venue}:${e.coin} — ${e.reason}`);

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
      rwa:         rwaRows,
      perpSpot:      perpSpotFeed.rows,
      perpSpotStale: perpSpotFeed.stale,
      perpSpotRegime,
      usdcArb:       usdc.rows as UsdcArbRow[],
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
      rwa:         [],
      perpSpot:      [],
      perpSpotStale: true,
      perpSpotRegime: null,
      usdcArb:       [],
      meta:        null,
    };
  }
}

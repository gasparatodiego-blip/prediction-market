import { NextResponse } from 'next/server';
import fs from 'fs';
import {
  annualize,
  roundTripFee,
  netApy30d,
  breakevenDays,
  spreadStatus,
  VENUE_FEE_PCT,
} from '@/lib/funding-math';

export const dynamic = 'force-dynamic';

const EXCHANGE_FILE = '/tmp/exchange-prices.json';

interface FuturesCoin {
  markPrice?:            number | null;
  fundingRate:           number;
  fundingIntervalHours?: number;
  nextFundingTime?:      number;
  openInterest?:         number | null;
}

export interface SpreadItem {
  coin:              string;
  shortExchange:     string;
  longExchange:      string;
  frShort:           number;
  frLong:            number;
  intervalHoursShort: number;
  intervalHoursLong:  number;
  shortIsDex:        boolean;
  longIsDex:         boolean;
  hasDexLeg:         boolean;
  grossApy:          number;
  netApy30d:         number;
  totalFeesPct:      number;
  breakevenDays:     number;
  status:            'HARVEST' | 'CAUTION' | 'MARGINAL';
}

function isDex(exchange: string): boolean {
  return exchange === 'hyperliquid';
}

function computeSpreads(
  futures: Record<string, Record<string, FuturesCoin>>
): SpreadItem[] {
  const byExchange: Record<string, { exchange: string; fr: number; intervalHours: number; dex: boolean }[]> = {};

  for (const [ex, coins] of Object.entries(futures)) {
    for (const [coin, data] of Object.entries(coins || {})) {
      const fr = data?.fundingRate;
      if (fr == null || typeof fr !== 'number' || !isFinite(fr)) continue;
      const intervalHours = data.fundingIntervalHours ?? 8;
      if (!byExchange[coin]) byExchange[coin] = [];
      byExchange[coin].push({ exchange: ex, fr, intervalHours, dex: isDex(ex) });
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

        const totalFees = roundTripFee(shortSide.dex, longSide.dex);
        const net30d    = netApy30d(grossApy, totalFees);
        const beDays    = breakevenDays(grossApy, totalFees);
        const status    = spreadStatus(beDays);
        const dexLeg    = shortSide.dex || longSide.dex;

        out.push({
          coin,
          shortExchange:     shortSide.exchange,
          longExchange:      longSide.exchange,
          frShort:           +shortSide.fr.toFixed(6),
          frLong:            +longSide.fr.toFixed(6),
          intervalHoursShort: shortSide.intervalHours,
          intervalHoursLong:  longSide.intervalHours,
          shortIsDex:        shortSide.dex,
          longIsDex:         longSide.dex,
          hasDexLeg:         dexLeg,
          grossApy,
          netApy30d:         net30d,
          totalFeesPct:      +totalFees.toFixed(3),
          breakevenDays:     beDays,
          status,
        });
      }
    }
  }

  return out.sort((a, b) => b.grossApy - a.grossApy);
}

export async function GET() {
  try {
    const raw          = JSON.parse(fs.readFileSync(EXCHANGE_FILE, 'utf8'));
    const generatedAt  = typeof raw.fetchedAt === 'number' ? raw.fetchedAt : null;
    const staleMinutes = generatedAt != null
      ? Math.floor((Date.now() - generatedAt) / 60_000)
      : null;

    const spreads = computeSpreads(raw.futures ?? {});

    return NextResponse.json({
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
        feePerLeg:    { cex: VENUE_FEE_PCT.cex, dex: VENUE_FEE_PCT.dex },
        legCount:     4,
        periodsPerYr: { cex: 1095, hl: 8760 },
        note:         'CEX rounds every 8h; Hyperliquid rounds hourly. annualize(rate, intervalHours) is the shared formula.',
      },
    });
  } catch {
    return NextResponse.json({
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
    });
  }
}

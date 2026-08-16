import { NextResponse } from 'next/server';
import fs from 'fs';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getIsPaid, redactForTier } from '@/lib/paid-gating';

export const dynamic = 'force-dynamic';

const FILE = '/tmp/liquidity-positions.json';

export interface LpPosition {
  marketId:     string;
  question:     string;
  url:          string | null;
  entryPrice:   number;
  currentPrice: number;
  priceDiff:    number;
  notionalUSD:  number;
  il:           number;
  lpApy:        number;
  daysHeld:     number;
  feesEarned:   number;
  netPnl:       number;
  status:       string;
  needsRebalance: boolean;
}

export interface LpMarket {
  id:              string;
  question:        string;
  url:             string | null;
  price:           number;
  volume24h:       number;
  lpApyEstimate:   number;
  isNear50:        boolean;
}

export interface LpResponse {
  updatedAt:       number | null;
  positions:       LpPosition[];
  topMarketsForLp: LpMarket[];
  summary: {
    totalPositions:  number;
    needsRebalance:  number;
    totalNotional:   number;
    totalNetPnl:     number;
  };
  dataAge: number;
}

export async function GET(): Promise<NextResponse<LpResponse>> {
  let data: any = null;
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}

  const now     = Date.now();
  const updated = data?.updatedAt ?? null;

  // Free users: null derived APY / fees / P&L / notional exposure server-side.
  // Raw entry/current prices and volume stay visible as public reference.
  const session = await getServerSession(authOptions);
  const isPaid  = await getIsPaid(session);
  const body    = redactForTier<LpResponse>({
    updatedAt:       updated,
    positions:       data?.positions ?? [],
    topMarketsForLp: data?.topMarketsForLp ?? [],
    summary:         data?.summary ?? { totalPositions: 0, needsRebalance: 0, totalNotional: 0, totalNetPnl: 0 },
    dataAge:         updated ? now - updated : 9999999,
  }, 'liquidity', isPaid);

  return NextResponse.json(body);
}

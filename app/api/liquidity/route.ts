import { NextResponse } from 'next/server';
import fs from 'fs';

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

  return NextResponse.json({
    updatedAt:       updated,
    positions:       data?.positions ?? [],
    topMarketsForLp: data?.topMarketsForLp ?? [],
    summary:         data?.summary ?? { totalPositions: 0, needsRebalance: 0, totalNotional: 0, totalNetPnl: 0 },
    dataAge:         updated ? now - updated : 9999999,
  });
}

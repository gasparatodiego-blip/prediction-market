import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const UNIFIED_FILE  = '/tmp/unified-opportunities.json';
const EXCHANGE_FILE = '/tmp/exchange-prices.json';
const HFT_FILE      = '/tmp/poly-hft-signals.json';

export interface TickerItem {
  key:        string;
  label:      string;
  bestNetPct: number | null;
  unit:       string;
  status:     'live' | 'offline' | 'coming-soon' | 'no-opp';
  count:      number;
  href:       string;
  note:       string;
}

export async function GET() {
  // ── Read unified opportunities ────────────────────────────────────────────
  let opps: any[]            = [];
  let unifiedAt: number | null = null;
  try {
    const u  = JSON.parse(fs.readFileSync(UNIFIED_FILE, 'utf8'));
    opps     = u.opportunities ?? [];
    unifiedAt = u.generatedAt ?? null;
  } catch { /* file absent */ }

  // ── Read exchange prices (for CEX arb) ───────────────────────────────────
  let cexArb: any[]          = [];
  let exchangeAt: number | null = null;
  try {
    const e   = JSON.parse(fs.readFileSync(EXCHANGE_FILE, 'utf8'));
    cexArb    = e.cexArb ?? [];
    exchangeAt = e.fetchedAt ?? null;
  } catch { /* file absent */ }

  // ── Read HFT signals ──────────────────────────────────────────────────────
  let hftSignals: any[] = [];
  let hftMonitored = 0;
  let hftRunning   = false;
  try {
    const hft    = JSON.parse(fs.readFileSync(HFT_FILE, 'utf8'));
    const age    = Date.now() - new Date(hft.updatedAt ?? 0).getTime();
    hftRunning   = age < 90_000;
    hftSignals   = hft.liveSignals ?? [];
    hftMonitored = (hft.monitoredMarkets ?? []).length;
  } catch { /* file absent */ }

  // ── Derive per-category bests ─────────────────────────────────────────────

  const fundingOpps = opps
    .filter(o => o.type === 'FUNDING' && typeof o.netROI === 'number')
    .sort((a: any, b: any) => b.netROI - a.netROI);

  const cashableOpps = opps
    .filter(o => o.type === 'CASHABLE' && typeof o.annualizedROI === 'number')
    .sort((a: any, b: any) => b.annualizedROI - a.annualizedROI);

  const sportsOpps = opps.filter(o => o.type === 'SPORTS');

  const cexSorted = [...cexArb].sort(
    (a: any, b: any) => (b.spreadPct ?? 0) - (a.spreadPct ?? 0)
  );

  // ── Build categories ──────────────────────────────────────────────────────

  const categories: TickerItem[] = [
    {
      key:        'funding',
      label:      'Crypto & Funding',
      bestNetPct: fundingOpps[0]?.netROI ?? null,
      unit:       '%/yr',
      status:     fundingOpps.length > 0 ? 'live' : 'no-opp',
      count:      fundingOpps.length,
      href:       '/dashboard/crypto',
      note:       'net after fees · variable rate',
    },
    {
      key:        'prediction',
      label:      'Prediction Markets',
      bestNetPct: cashableOpps[0]?.annualizedROI ?? null,
      unit:       '%/yr',
      status:     cashableOpps.length > 0 ? 'live' : 'no-opp',
      count:      cashableOpps.length,
      href:       '/dashboard/opportunities',
      note:       'annualized · capital locked to resolution',
    },
    {
      key:        'sports',
      label:      'Sports Arbitrage',
      bestNetPct: null,
      unit:       '%',
      status:     sportsOpps.length > 0 ? 'live' : 'offline',
      count:      sportsOpps.length,
      href:       '/dashboard/sports',
      note:       'OddsAPI live: off',
    },
    {
      key:        'cex',
      label:      'CEX Arbitrage',
      bestNetPct: cexSorted[0]?.spreadPct ?? null,
      unit:       '%',
      status:     cexSorted.length > 0 ? 'live' : 'no-opp',
      count:      cexSorted.length,
      href:       '/dashboard/crypto',
      note:       'spot price spread · execution risk',
    },
    {
      key:        'hft',
      label:      'HFT / 5-Min',
      bestNetPct: hftSignals.length > 0
        ? Math.max(...hftSignals.map((s: any) => s.edgeP ?? 0)) * 100
        : null,
      unit:       'pp edge',
      status:     !hftRunning ? 'offline'
                : hftSignals.length > 0 ? 'live'
                : 'no-opp',
      count:      hftSignals.length,
      href:       '/dashboard/hft',
      note:       hftSignals.length > 0
        ? `best: ${hftSignals[0]?.coin} ${hftSignals[0]?.duration} · signal-only`
        : hftRunning
          ? `monitoring ${hftMonitored} market${hftMonitored !== 1 ? 's' : ''}`
          : 'agent offline',
    },
    {
      key:        'liquidity',
      label:      'LP / Liquidity',
      bestNetPct: null,
      unit:       '',
      status:     'coming-soon',
      count:      0,
      href:       '/dashboard',
      note:       'engine in development',
    },
  ];

  const generatedAt  = unifiedAt ?? exchangeAt;
  const staleMinutes = generatedAt != null
    ? Math.floor((Date.now() - generatedAt) / 60_000)
    : null;

  return NextResponse.json({
    ok:          opps.length > 0 || cexArb.length > 0,
    generatedAt,
    staleMinutes,
    categories,
  });
}

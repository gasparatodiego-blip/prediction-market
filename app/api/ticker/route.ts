import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const UNIFIED_FILE      = '/tmp/unified-opportunities.json';
const EXCHANGE_FILE     = '/tmp/exchange-prices.json';
const MM_FILE           = '/tmp/mm-analysis.json';
const BASIS_FILE        = '/tmp/basis-opportunities.json';
const LEADERBOARD_FILE  = '/tmp/leaderboard.json';
const COPY_FILE         = '/tmp/copy-watcher.json';
const SPORTS_FILE       = '/tmp/sports-odds.json';

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

  // ── Read Basis (Cash & Carry) data ───────────────────────────────────────
  let basisRunning  = false;
  let basisSummary: any = null;
  let basisOpps:    any[] = [];
  try {
    const b  = JSON.parse(fs.readFileSync(BASIS_FILE, 'utf8'));
    const age = Date.now() - new Date(b.updatedAt ?? 0).getTime();
    basisRunning  = age < 15 * 60_000;   // stale after 15 min (agent runs every 5)
    basisSummary  = b.summary ?? null;
    basisOpps     = b.opportunities ?? [];
  } catch { /* file absent */ }

  // ── Read MM Analyzer data ─────────────────────────────────────────────────
  let mmRunning    = false;
  let mmAgg:       any = null;
  let mmMarkets:   number = 0;
  try {
    const mm  = JSON.parse(fs.readFileSync(MM_FILE, 'utf8'));
    const age = Date.now() - new Date(mm.updatedAt ?? 0).getTime();
    mmRunning  = age < 10 * 60_000;  // stale after 10 min
    mmAgg      = mm.aggregate ?? null;
    mmMarkets  = mm.markets?.length ?? 0;
  } catch { /* file absent */ }

  // ── Read Leaderboard data ─────────────────────────────────────────────────
  let lbRunning   = false;
  let lbTopPnl:   number | null = null;
  let lbWallets:  number = 0;
  let lbTopName:  string = '';
  try {
    const lb  = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    const age = Date.now() - new Date(lb.updatedAt ?? 0).getTime();
    lbRunning   = age < 40 * 60_000;
    lbWallets   = lb.totalWallets ?? 0;
    const top   = lb.categories?.All?.[0];
    if (top) { lbTopPnl = top.pnlUsdc; lbTopName = top.name; }
  } catch { /* file absent */ }

  // ── Read Sports Arb data ──────────────────────────────────────────────────
  let sportsRunning   = false;
  let sportsArbCount  = 0;
  let sportsBestMargin: number | null = null;
  let sportsPaused    = false;
  let sportsCredits:   number | null = null;
  try {
    const sp  = JSON.parse(fs.readFileSync(SPORTS_FILE, 'utf8'));
    const age = Date.now() - (sp.fetchedAt ?? 0);
    sportsRunning    = age < 2 * 60 * 60_000;  // stale after 2h (agent polls 45 min)
    sportsPaused     = sp.paused ?? false;
    sportsArbCount   = sp.totalArb ?? 0;
    sportsCredits    = sp.creditsRemaining ?? null;
    const best       = (sp.arbOpportunities ?? [])[0];
    if (best) sportsBestMargin = best.netMargin;
  } catch { /* file absent */ }

  // ── Read Copy Watcher data ────────────────────────────────────────────────
  let copyOnline    = false;
  let copyWatched   = 0;
  let copyAlertCnt  = 0;
  let copyLastAlert = '';
  try {
    const cw  = JSON.parse(fs.readFileSync(COPY_FILE, 'utf8'));
    const age = Date.now() - new Date(cw.updatedAt ?? 0).getTime();
    copyOnline    = age < 10 * 60_000;
    copyWatched   = cw.walletsMonitored ?? 0;
    const alerts  = cw.recentAlerts ?? [];
    copyAlertCnt  = alerts.length;
    const last    = alerts[0];
    if (last) copyLastAlert = `${last.name || 'trader'}: ${last.side} ${last.outcome}`;
  } catch { /* file absent */ }

  // ── Derive per-category bests ─────────────────────────────────────────────

  const fundingOpps = opps
    .filter(o => o.type === 'FUNDING' && typeof o.netROI === 'number')
    .sort((a: any, b: any) => b.netROI - a.netROI);

  const cashableOpps = opps
    .filter(o => o.type === 'CASHABLE' && typeof o.annualizedROI === 'number')
    .sort((a: any, b: any) => b.annualizedROI - a.annualizedROI);

  // sportsOpps from unified file replaced by agent12 → /tmp/sports-odds.json (see above)

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
      href:       '/dashboard/funding-arb',
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
      bestNetPct: sportsRunning && sportsBestMargin != null ? sportsBestMargin : null,
      unit:       '%',
      status:     !sportsRunning ? 'offline'
                : sportsPaused   ? 'offline'
                : sportsArbCount > 0 ? 'live'
                : 'no-opp',
      count:      sportsArbCount,
      href:       '/dashboard/sports',
      note:       !sportsRunning  ? 'agent offline'
                : sportsPaused   ? `paused — ${sportsCredits ?? '?'} API credits left`
                : sportsArbCount > 0 ? `${sportsArbCount} surebet${sportsArbCount !== 1 ? 's' : ''} · h2h only`
                : 'no surebets found — all implied sums ≥ 1',
    },
    {
      key:        'cex',
      label:      'CEX Arbitrage',
      bestNetPct: cexSorted[0]?.spreadPct ?? null,
      unit:       '%',
      status:     cexSorted.length > 0 ? 'live' : 'no-opp',
      count:      cexSorted.length,
      href:       '/dashboard/funding-arb#cex-arb',
      note:       'spot price spread · execution risk',
    },
    {
      // MM Analyzer tile: shows measured-only P&L (no rewards).
      // Rewards are shown separately on the MM page, clearly labeled as assumption.
      key:        'mm',
      label:      'MM Analyzer',
      bestNetPct: (() => {
        if (!mmAgg || mmAgg.totalCycles < 10) return null;
        // Express measured P&L as % of deployed notional (QUOTE_SIZE × markets)
        const deployed = 50 * (mmMarkets || 1);
        return deployed > 0 ? (mmAgg.measuredPnl / deployed) * 100 : null;
      })(),
      unit:       '% cumul.',
      status:     !mmRunning ? 'offline'
                : mmAgg && mmAgg.totalCycles >= 10 && mmAgg.measuredPnl > 0 ? 'live'
                : 'no-opp',
      count:      mmAgg?.totalCycles ?? 0,
      href:       '/dashboard/mm',
      note:       !mmRunning ? 'agent offline'
                : !mmAgg || mmAgg.totalCycles < 10
                  ? `measuring: ${mmAgg?.totalCycles ?? 0} cycles · need 10+`
                  : `${mmAgg.totalCycles} cycles · cumulative since launch · not annualized`,
    },
    {
      key:        'carry',
      label:      'Cash & Carry',
      bestNetPct: basisRunning && basisSummary?.bestNetAnnualized != null
        ? basisSummary.bestNetAnnualized * 100
        : null,
      unit:       '%/yr locked',
      status:     !basisRunning ? 'offline'
                : basisOpps.length > 0 ? 'live'
                : 'no-opp',
      count:      basisSummary?.count ?? 0,
      href:       '/dashboard/carry',
      note:       basisRunning && basisSummary?.bestContract
        ? `${basisSummary.bestContract} · ${basisSummary.bestExchange} · basis locked at entry`
        : basisRunning ? 'no qualifying contracts' : 'agent offline',
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
    {
      key:        'traders',
      label:      'Traders Hub',
      bestNetPct: null,
      unit:       '',
      status:     !lbRunning ? 'offline'
                : lbWallets > 0 ? 'live'
                : 'no-opp',
      count:      lbWallets,
      href:       '/dashboard/traders',
      note:       lbRunning && lbTopPnl != null
        ? `#1 ${lbTopName}: +$${Math.round(lbTopPnl).toLocaleString()} · ${lbWallets} ranked${copyWatched > 0 ? ` · ${copyWatched} followed` : ''}`
        : lbRunning ? 'accumulating data…' : 'agent warming up',
    },
  ];

  // Use whichever source is freshest so staleMinutes reflects current data age
  const generatedAt  = exchangeAt ?? unifiedAt;
  const staleMinutes = generatedAt != null
    ? Math.floor((Date.now() - generatedAt) / 60_000)
    : null;

  return NextResponse.json(
    { ok: opps.length > 0 || cexArb.length > 0, generatedAt, staleMinutes, categories },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  );
}

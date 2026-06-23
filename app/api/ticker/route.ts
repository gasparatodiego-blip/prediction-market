import { NextResponse } from 'next/server';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const UNIFIED_FILE      = '/tmp/unified-opportunities.json';
const BASIS_FILE        = '/tmp/basis-opportunities.json';
const LEADERBOARD_FILE  = '/tmp/leaderboard.json';
const COPY_FILE         = '/tmp/copy-watcher.json';
const SPORTS_FILE       = '/tmp/sports-odds.json';
// Prediction: same post-gate sources as the detail page (/api/prediction)
const REPRICED_FILE     = '/tmp/repriced-opportunities.json';
const DISCOVERY_FILE    = '/tmp/arbitrage-opportunities.json';
const REWARDS_FILE         = '/root/prediction-market/data/liquidity-rewards.json';
const KALSHI_REWARDS_FILE  = '/root/prediction-market/data/kalshi-rewards.json';
const LIMITLESS_REWARDS_FILE = '/root/prediction-market/data/limitless-rewards.json';

export interface TickerItem {
  key:         string;
  label:       string;
  bestNetPct:  number | null;
  unit:        string;
  status:      'live' | 'offline' | 'coming-soon' | 'no-opp';
  count:       number;
  href:        string;
  note:        string;
  // displayKind drives the de-emphasis badge in StrategyCards:
  //   'net'        → confirmed net ROI (honest, no annualization)
  //   'annualized' → annualized with locked resolution date (Cash & Carry)
  //   'ceiling'    → theoretical ceiling, variable/not locked (Crypto & Funding)
  //   'estimate'   → linear share estimate, gross, adverse-fill risk not subtracted
  displayKind?: 'net' | 'annualized' | 'ceiling' | 'estimate';
  platforms?:  string[];  // rewards card: live-data platform names
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

  // ── Read Liquidity Rewards data ───────────────────────────────────────────
  let rewardsRunning   = false;
  let rewardsBestPct:   number | null = null;
  let rewardsBestGross: number | null = null;
  let rewardsSaneCount = 0;
  let rewardsNote      = '';
  try {
    const rw  = JSON.parse(fs.readFileSync(REWARDS_FILE, 'utf8'));
    const age = Date.now() - new Date(rw.meta?.generatedAt ?? 0).getTime();
    rewardsRunning = age < 40 * 60_000;  // agent runs every 15 min; stale after 40 min

    const mkts: any[] = rw.markets ?? [];
    const VOL_ORD: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

    // Sane at $500: no thin-book flag, no below-floor flag
    const sane = mkts.filter((m: any) => {
      const lv = m.levels?.['500'];
      return lv && !lv.thinBookFlag && !lv.belowFloorFlag;
    });
    rewardsSaneCount = sane.length;

    // Match the page's sort: LOW vol first, then by grossRewardDay desc
    sane.sort((a: any, b: any) => {
      const vA = VOL_ORD[a.volatilityRisk] ?? 2;
      const vB = VOL_ORD[b.volatilityRisk] ?? 2;
      if (vA !== vB) return vA - vB;
      return (b.levels['500']?.grossRewardDay ?? 0) - (a.levels['500']?.grossRewardDay ?? 0);
    });

    const best = sane[0];
    if (best) {
      const lv = best.levels['500'];
      rewardsBestPct   = lv.dayYieldPct;
      rewardsBestGross = lv.grossRewardDay;
      rewardsNote = `$${lv.grossRewardDay.toFixed(2)}/day est · $500 · gross`;
    }
  } catch { /* file absent */ }

  // ── Check which reward platforms have fresh data ───────────────────────────
  let kalshiRewardsLive = false;
  try {
    const kr  = JSON.parse(fs.readFileSync(KALSHI_REWARDS_FILE, 'utf8'));
    const age = Date.now() - new Date(kr._meta?.timestamp ?? 0).getTime();
    kalshiRewardsLive = age < 40 * 60_000 && (kr.markets?.length ?? 0) > 0;
  } catch { /* file absent */ }

  let limitlessRewardsLive = false;
  try {
    const lr = JSON.parse(fs.readFileSync(LIMITLESS_REWARDS_FILE, 'utf8'));
    limitlessRewardsLive = (lr.markets?.length ?? 0) > 0;
  } catch { /* file absent */ }

  const rewardsPlatforms: string[] = [];
  if (rewardsRunning)       rewardsPlatforms.push('Polymarket');
  if (kalshiRewardsLive)    rewardsPlatforms.push('Kalshi');
  if (limitlessRewardsLive) rewardsPlatforms.push('Limitless');

  // ── Prediction: read from the same post-gate sources as the detail page ─────
  // repriced-opportunities.json has live prices (evaporated pairs removed);
  // fall back to arbitrage-opportunities.json (discovery snapshot) if repricer hasn't run.
  // Field names differ from the unified file: `roi` (not `netROI`), `cashable` (boolean).
  const PRED_ROI_CEILING = 15;  // matches dashboard's SUSPICIOUS_ROI quarantine
  let predCashableOpps: any[] = [];
  try {
    const repriced = JSON.parse(fs.readFileSync(REPRICED_FILE, 'utf8'));
    predCashableOpps = (repriced.opportunities ?? []).filter(
      (o: any) => o.cashable === true && typeof o.roi === 'number' && o.roi > 0 && o.roi <= PRED_ROI_CEILING
    );
  } catch {
    try {
      const disc = JSON.parse(fs.readFileSync(DISCOVERY_FILE, 'utf8'));
      predCashableOpps = (disc.opportunities ?? []).filter(
        (o: any) => o.cashable === true && typeof o.roi === 'number' && o.roi > 0 && o.roi <= PRED_ROI_CEILING
      );
    } catch { /* no data */ }
  }
  predCashableOpps.sort((a: any, b: any) => b.roi - a.roi);
  const bestPred = predCashableOpps[0] ?? null;

  // ── Derive per-category bests ─────────────────────────────────────────────

  const fundingOpps = opps
    .filter(o => o.type === 'FUNDING' && typeof o.netROI === 'number')
    .sort((a: any, b: any) => b.netROI - a.netROI);

  // sportsOpps from unified file replaced by agent12 → /tmp/sports-odds.json (see above)

  // ── Build categories ──────────────────────────────────────────────────────

  const categories: TickerItem[] = [
    {
      key:         'funding',
      label:       'Funding Arb',
      // Show the best net-of-fees rate, but always flag it as a ceiling:
      // this is the instantaneous annualized spread — not a locked, guaranteed return.
      bestNetPct:  fundingOpps[0]?.netROI ?? null,
      unit:        '%/yr',
      status:      fundingOpps.length > 0 ? 'live' : 'no-opp',
      count:       fundingOpps.length,
      href:        '/dashboard/funding-arb',
      note:        'net after fees · theoretical ceiling · variable, not locked',
      displayKind: 'ceiling',
    },
    {
      key:         'prediction',
      label:       'Prediction Markets',
      // Show confirmed net ROI — never annualize short-dated positions.
      // annualizedROI for a 7-day 7.91% arb = 400%+; that is technically correct
      // but misleading as a headline. The net ROI is what the trader actually earns.
      // Source: repriced-opportunities.json (live prices) → arbitrage-opportunities.json
      // (same post-same-event-gate sources as /api/prediction, never the stale unified file).
      bestNetPct:  bestPred?.roi ?? null,
      unit:        '% net',
      status:      predCashableOpps.length > 0 ? 'live' : 'no-opp',
      count:       predCashableOpps.length,
      href:        '/dashboard/prediction',
      note:        bestPred != null
        ? `confirmed · ${bestPred.daysToResolution ?? '?'}d to resolution · fees deducted`
        : 'confirmed cashable · fees deducted',
      displayKind: 'net',
    },
    {
      key:        'sports',
      label:      'Sports Arb',
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
      key:         'carry',
      label:       'Cash & Carry',
      bestNetPct:  basisRunning && basisSummary?.bestNetAnnualized != null
        ? basisSummary.bestNetAnnualized * 100
        : null,
      unit:        '%/yr locked',
      status:      !basisRunning ? 'offline'
                 : basisOpps.length > 0 ? 'live'
                 : 'no-opp',
      count:       basisSummary?.count ?? 0,
      href:        '/dashboard/carry',
      note:        basisRunning && basisSummary?.bestContract
        ? `${basisSummary.bestContract} · ${basisSummary.bestExchange} · basis locked at entry`
        : basisRunning ? 'no qualifying contracts' : 'agent offline',
      displayKind: 'annualized',  // honest locked basis — no de-emphasis needed
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
    {
      key:         'rewards',
      label:       'Liquidity Rewards',
      bestNetPct:  rewardsRunning && rewardsBestPct != null ? rewardsBestPct : null,
      unit:        '%/day',
      status:      !rewardsRunning ? 'offline'
                 : rewardsSaneCount > 0 ? 'live'
                 : 'no-opp',
      count:       rewardsSaneCount,
      href:        '/dashboard/liquidity-rewards',
      note:        rewardsRunning && rewardsBestGross != null
        ? rewardsNote
        : rewardsRunning ? 'no sane markets · try later'
        : 'agent warming up',
      displayKind: 'estimate' as const,
      platforms:   rewardsPlatforms,
    },
  ];

  const generatedAt  = unifiedAt;
  const staleMinutes = generatedAt != null
    ? Math.floor((Date.now() - generatedAt) / 60_000)
    : null;

  return NextResponse.json(
    { ok: opps.length > 0, generatedAt, staleMinutes, categories },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  );
}

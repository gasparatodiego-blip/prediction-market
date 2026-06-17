import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const DATA_API = 'https://data-api.polymarket.com';
const TIMEOUT  = 10_000;

function fetchJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    fetch(url, { signal: ctrl.signal })
      .then(r => r.json())
      .then(d => { clearTimeout(timer); resolve(d); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

// Infer category from market title text
const CRYPTO_RE   = /bitcoin|ethereum|solana|btc|eth|sol|bnb|crypto|xrp|up or down/i;
const SPORTS_RE   = /nba|nfl|mlb|nhl|soccer|ufc|tennis|golf|super bowl|champion|world cup|finals|playoff|quarterback|lebron|mahomes|match|game/i;
const POLITICS_RE = /trump|biden|harris|president|elect|congress|senate|democrat|republican|vote|fed rate|fomc|inflation|policy|cabinet|supreme court/i;
const POPCULTURE_RE = /oscar|grammy|emmy|kardashian|taylor swift|elon musk|celebrity|movie|album|song|award|show|bachelorette|bachelor/i;

function inferCatFromTitle(title: string): string {
  if (CRYPTO_RE.test(title))      return 'Crypto';
  if (SPORTS_RE.test(title))      return 'Sports';
  if (POLITICS_RE.test(title))    return 'Politics';
  if (POPCULTURE_RE.test(title))  return 'Pop Culture';
  return 'World';
}

interface Trade {
  proxyWallet: string;
  side: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  name: string;
  pseudonym: string;
  transactionHash: string;
}

interface Position {
  proxyWallet: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  title: string;
  slug: string;
  outcome: string;
  endDate: string | null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { address: string } }
) {
  const raw = (params.address ?? '').trim().toLowerCase();

  if (!/^0x[0-9a-f]{40}$/.test(raw)) {
    return NextResponse.json({ error: 'Invalid wallet address — must be 0x followed by 40 hex chars' }, { status: 400 });
  }

  // Parallel fetch: trades, positions, portfolio value
  const [tradesRes, posRes, valueRes] = await Promise.allSettled([
    fetchJSON(`${DATA_API}/trades?user=${raw}&limit=200`),
    fetchJSON(`${DATA_API}/positions?user=${raw}&limit=200`),
    fetchJSON(`${DATA_API}/value?user=${raw}`),
  ]);

  const trades: Trade[]     = (tradesRes.status === 'fulfilled' && Array.isArray(tradesRes.value))    ? tradesRes.value    : [];
  const positions: Position[] = (posRes.status === 'fulfilled' && Array.isArray(posRes.value))        ? posRes.value       : [];
  const valueArr: any[]     = (valueRes.status === 'fulfilled' && Array.isArray(valueRes.value))      ? valueRes.value     : [];

  const portfolioValue = valueArr[0]?.value ?? null;

  // If no data at all, honest empty state
  if (trades.length === 0 && positions.length === 0) {
    return NextResponse.json({
      address: raw,
      name: null,
      notFound: true,
      resolvedMarkets: 0,
      estimatedPnl: 0,
      winRate: 0,
      wins: 0,
      losses: 0,
      avgPositionSize: 0,
      totalVolume: 0,
      firstActive: null,
      lastActive: null,
      portfolioValue: null,
      pnlHistory: [],
      categoryBreakdown: [],
      recentTrades: [],
      disclaimer: 'No trades or positions found for this wallet on Polymarket.',
    });
  }

  // Pick username from any trade that has one
  const name = trades.find(t => t.pseudonym || t.name)?.pseudonym
            || trades.find(t => t.name)?.name
            || null;

  // ── Stats from trades ──────────────────────────────────────────────────────
  const tradeCount = trades.length;
  const totalVolume = trades.reduce((s, t) => s + (t.size || 0), 0);
  const avgPositionSize = tradeCount > 0 ? totalVolume / tradeCount : 0;
  const firstActive = trades.length > 0 ? Math.min(...trades.map(t => t.timestamp)) : null;
  const lastActive  = trades.length > 0 ? Math.max(...trades.map(t => t.timestamp)) : null;

  // Category breakdown from trade titles
  const catCounts: Record<string, number> = {};
  for (const t of trades) {
    const cat = inferCatFromTitle(t.title || '');
    catCounts[cat] = (catCounts[cat] || 0) + 1;
  }
  const categoryBreakdown = Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({
      category,
      count,
      pct: Math.round(count / tradeCount * 100),
    }));

  // Recent trades (last 30, already sorted newest-first from API)
  const recentTrades = trades.slice(0, 30).map(t => ({
    title:     t.title,
    side:      t.side,
    outcome:   t.outcome,
    size:      t.size,
    price:     t.price,
    timestamp: t.timestamp,
  }));

  // ── Stats from positions ───────────────────────────────────────────────────
  const resolved = positions.filter(p => p.redeemable && p.endDate);

  const wins   = resolved.filter(p => p.cashPnl > 0).length;
  const losses = resolved.filter(p => p.cashPnl <= 0).length;
  const winRate = resolved.length > 0 ? Math.round(wins / resolved.length * 1000) / 10 : 0;
  const estimatedPnl = positions.reduce((s, p) => s + (p.cashPnl || 0), 0);
  const resolvedMarkets = resolved.length;

  // ── P&L history for chart ──────────────────────────────────────────────────
  // Sort resolved positions by endDate, accumulate cashPnl
  const dated = resolved
    .filter(p => p.endDate)
    .sort((a, b) => (a.endDate! < b.endDate! ? -1 : a.endDate! > b.endDate! ? 1 : 0));

  // Group by date → daily P&L sum → cumulate
  const dailyPnl: Record<string, number> = {};
  for (const p of dated) {
    dailyPnl[p.endDate!] = (dailyPnl[p.endDate!] || 0) + p.cashPnl;
  }

  const sortedDays = Object.keys(dailyPnl).sort();
  let cum = 0;
  const pnlHistory = sortedDays.map(date => {
    cum += dailyPnl[date];
    return { date, cumulativePnl: Math.round(cum * 100) / 100 };
  });

  return NextResponse.json({
    address: raw,
    name: name && !name.startsWith('0x') ? name : null,
    notFound: false,

    resolvedMarkets,
    estimatedPnl: Math.round(estimatedPnl * 100) / 100,
    winRate,
    wins,
    losses,
    avgPositionSize: Math.round(avgPositionSize * 100) / 100,
    totalVolume:     Math.round(totalVolume * 100) / 100,
    tradeCount,
    firstActive,
    lastActive,
    portfolioValue,

    pnlHistory,
    categoryBreakdown,
    recentTrades,

    disclaimer: 'P&L estimated from position data — may differ from actual balances (partial fills, gas, open positions). ' +
      `Sample: ${tradeCount} recent trades, ${resolvedMarkets} resolved positions shown. Past performance ≠ future results. Not financial advice.`,
  });
}

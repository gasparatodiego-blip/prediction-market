'use client';
import { useEffect, useState, useCallback } from 'react';
import type { MarketsResponse, PanelMarket, ArbCandidate } from './api/markets/route';

// ── Platform config ───────────────────────────────

const PLATFORMS = {
  predictit: {
    label:       'PredictIt',
    dotClass:    'bg-green-400',
    headerClass: 'text-green-400',
    borderClass: 'border-green-900/40',
    bgClass:     'bg-green-950/20',
    badgeClass:  'bg-green-900/60 border-green-700 text-green-300',
  },
  manifold: {
    label:       'Manifold',
    dotClass:    'bg-blue-400',
    headerClass: 'text-blue-400',
    borderClass: 'border-blue-900/40',
    bgClass:     'bg-blue-950/20',
    badgeClass:  'bg-blue-900/60 border-blue-700 text-blue-300',
  },
  kalshi: {
    label:       'Kalshi',
    dotClass:    'bg-yellow-400',
    headerClass: 'text-yellow-400',
    borderClass: 'border-yellow-900/40',
    bgClass:     'bg-yellow-950/20',
    badgeClass:  'bg-yellow-900/60 border-yellow-700 text-yellow-300',
  },
  polymarket: {
    label:       'Polymarket',
    dotClass:    'bg-purple-400',
    headerClass: 'text-purple-400',
    borderClass: 'border-purple-900/40',
    bgClass:     'bg-purple-950/20',
    badgeClass:  'bg-purple-900/60 border-purple-700 text-purple-300',
  },
  smarkets: {
    label:       'Smarkets',
    dotClass:    'bg-orange-400',
    headerClass: 'text-orange-400',
    borderClass: 'border-orange-900/40',
    bgClass:     'bg-orange-950/20',
    badgeClass:  'bg-orange-900/60 border-orange-700 text-orange-300',
  },
  metaculus: {
    label:       'Metaculus',
    dotClass:    'bg-teal-400',
    headerClass: 'text-teal-400',
    borderClass: 'border-teal-900/40',
    bgClass:     'bg-teal-950/20',
    badgeClass:  'bg-teal-900/60 border-teal-700 text-teal-300',
  },
  augur: {
    label:       'Augur',
    dotClass:    'bg-rose-400',
    headerClass: 'text-rose-400',
    borderClass: 'border-rose-900/40',
    bgClass:     'bg-rose-950/20',
    badgeClass:  'bg-rose-900/60 border-rose-700 text-rose-300',
  },
  oddsapi: {
    label:       'The Odds API',
    dotClass:    'bg-sky-400',
    headerClass: 'text-sky-400',
    borderClass: 'border-sky-900/40',
    bgClass:     'bg-sky-950/20',
    badgeClass:  'bg-sky-900/60 border-sky-700 text-sky-300',
  },
} as const;

type PlatformKey = keyof typeof PLATFORMS;

// ── Gap-age filter (price staleness) ─────────────
// Filters by how long the CURRENT price gap has existed.
// gapAge = Date.now() - max(low.priceSeenAt, high.priceSeenAt)
// A small gapAge = fresh opportunity (prices just diverged).
// A large gapAge = stale (this exact spread has persisted — may be unfillable).
type ExpiryFilter =
  | 'all'
  | '30m' | '1h' | '2h' | '3h' | '6h' | '12h' | '24h'
  | '2d'  | '3d' | '4d' | '5d' | '7d' | '14d' | '30d+';

const M = 60_000, H = 3_600_000, D = 86_400_000;

const EXPIRY_FILTERS: { key: ExpiryFilter; label: string; ms: number; color: string }[] = [
  // Row 1 — hours
  { key: 'all',  label: 'All',  ms: Infinity,    color: 'gray' },
  { key: '30m',  label: '30m',  ms: 30 * M,      color: 'red'  },
  { key: '1h',   label: '1h',   ms: H,           color: 'red'  },
  { key: '2h',   label: '2h',   ms: 2  * H,      color: 'red'  },
  { key: '3h',   label: '3h',   ms: 3  * H,      color: 'red'  },
  { key: '6h',   label: '6h',   ms: 6  * H,      color: 'red'  },
  { key: '12h',  label: '12h',  ms: 12 * H,      color: 'orange'},
  { key: '24h',  label: '24h',  ms: D,           color: 'orange'},
  // Row 2 — days
  { key: '2d',   label: '2d',   ms: 2  * D,      color: 'yellow'},
  { key: '3d',   label: '3d',   ms: 3  * D,      color: 'yellow'},
  { key: '4d',   label: '4d',   ms: 4  * D,      color: 'yellow'},
  { key: '5d',   label: '5d',   ms: 5  * D,      color: 'yellow'},
  { key: '7d',   label: '7d',   ms: 7  * D,      color: 'yellow'},
  { key: '14d',  label: '14d',  ms: 14 * D,      color: 'gray' },
  { key: '30d+', label: '30d+', ms: 30 * D,      color: 'gray' },
];

const EXPIRY_ROW1 = EXPIRY_FILTERS.slice(0, 8);
const EXPIRY_ROW2 = EXPIRY_FILTERS.slice(8);

const COLOR_ACTIVE: Record<string, string> = {
  red:    'bg-red-700    border-red-600    text-white',
  orange: 'bg-orange-600 border-orange-500 text-white',
  yellow: 'bg-yellow-600 border-yellow-500 text-white',
  gray:   'bg-gray-600   border-gray-500   text-white',
};
const COLOR_IDLE: Record<string, string> = {
  red:    'bg-gray-900 border-red-900/60    text-red-400    hover:border-red-700    hover:text-red-300',
  orange: 'bg-gray-900 border-orange-900/60 text-orange-400 hover:border-orange-700 hover:text-orange-300',
  yellow: 'bg-gray-900 border-yellow-900/60 text-yellow-500 hover:border-yellow-700 hover:text-yellow-300',
  gray:   'bg-gray-900 border-gray-700      text-gray-500   hover:border-gray-500   hover:text-gray-300',
};

// ── History / Sentiment / Arb types ──────────────

interface HistoryRecord {
  id: number;
  timestamp: string;
  event_name: string;
  platform_low: string;
  platform_high: string;
  prob_low: number;
  prob_high: number;
  roi: number;
  spread: number;
}

interface SentimentEntry { keyword: string; score: number; mentions: number; }
interface SentimentData  { updatedAt: number; entries: SentimentEntry[]; }

interface ArbitrageOpp {
  question:   string;
  lowMarket:  ArbCandidate;
  highMarket: ArbCandidate;
  spread:     number;
  roi:        number;
  earnPer100: number;
  expiresAt:  number | null; // earliest market close date across both sides
  gapAge:     number | null; // ms since this exact price gap was established (staleness)
}

// ── Keyword matching ──────────────────────────────

const STOPWORDS = new Set([
  'will','would','could','should','their','there','these','those','which','about',
  'after','before','between','during','through','with','from','have','been','that',
  'this','than','when','what','where','who','how','the','and','for','are','but',
  'not','you','all','can','her','was','one','our','out','had','has','his','him',
  'its','into','over','under','more','than','first','last','next','also','just',
]);

function keywords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(w => w.length > 3 && !STOPWORDS.has(w))
  );
}

function jaccard(a: string, b: string): number {
  const ka = keywords(a), kb = keywords(b);
  let inter = 0;
  ka.forEach(w => { if (kb.has(w)) inter++; });
  const union = ka.size + kb.size - inter;
  return union > 0 ? inter / union : 0;
}

function detectArbitrage(candidates: ArbCandidate[]): ArbitrageOpp[] {
  const seen = new Set<string>();
  const results: ArbitrageOpp[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      // Skip same source: same platform unless they're different bookmakers (oddsapi)
      const sameSource = a.platform === b.platform &&
        (a.platform !== 'oddsapi' || !a.bookmaker || !b.bookmaker || a.bookmaker === b.bookmaker);
      if (sameSource) continue;
      if (jaccard(a.question, b.question) < 0.25) continue;
      const spread = Math.abs(a.probability - b.probability);
      if (spread < 3) continue;
      const low  = a.probability <= b.probability ? a : b;
      const high = a.probability >  b.probability ? a : b;
      const roi  = low.probability > 0 ? (spread / low.probability) * 100 : 0;
      if (roi > 200) continue;
      const key = `${low.platform}:${high.platform}:${low.probability}:${high.probability}:${high.question.slice(0, 30)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const expiries   = [low.expiresAt,    high.expiresAt   ].filter((e): e is number => e != null);
      const priceTimes = [low.priceSeenAt, high.priceSeenAt].filter((t): t is number => t != null);
      // gapAge = time since the most recent price change in this pair established the current spread
      const gapAge = priceTimes.length ? Date.now() - Math.max(...priceTimes) : null;
      results.push({
        question:   high.question,
        lowMarket:  low,
        highMarket: high,
        spread,
        roi,
        earnPer100: Math.round((roi / 100) * 100 * 10) / 10,
        expiresAt:  expiries.length   ? Math.min(...expiries) : null,
        gapAge,
      });
    }
  }
  return results.sort((a, b) => b.roi - a.roi).slice(0, 8);
}

// ── Kelly criterion ───────────────────────────────

function kellyFraction(probLow: number, probHigh: number): number {
  const edge = (probHigh - probLow) / 100;
  const odds = (100 / probLow) - 1;
  if (odds <= 0) return 0;
  return Math.max(0, Math.min(edge / odds, 0.25));
}

// ── Demo opportunities ────────────────────────────

function getDemoOpps(panels: MarketsResponse['panels']): ArbitrageOpp[] {
  const makeOpp = (
    aName: string, aPlatform: ArbCandidate['platform'], aProb: number,
    bName: string, bPlatform: ArbCandidate['platform'], bProb: number,
  ): ArbitrageOpp => {
    const [low, high] = aProb <= bProb
      ? [{ id: 'demo-a', question: aName, probability: aProb, platform: aPlatform },
         { id: 'demo-b', question: bName, probability: bProb, platform: bPlatform }]
      : [{ id: 'demo-b', question: bName, probability: bProb, platform: bPlatform },
         { id: 'demo-a', question: aName, probability: aProb, platform: aPlatform }];
    const spread = high.probability - low.probability;
    const roi    = low.probability > 0 ? (spread / low.probability) * 100 : 0;
    return { question: high.question, lowMarket: low, highMarket: high, spread, roi,
             earnPer100: Math.round(roi * 10) / 10, expiresAt: null, gapAge: null };
  };

  const pi = panels.predictit.filter(m => m.probability != null && m.probability > 5 && m.probability < 80);
  const ka = panels.kalshi.filter(m => m.probability != null && m.probability > 3);
  const mf = panels.manifold.filter(m => m.probability != null && m.probability > 5 && m.probability < 80);
  const pm = panels.polymarket.filter(m => m.probability != null && m.probability > 5 && m.probability < 80);

  const demos: ArbitrageOpp[] = [];
  if (pi[0] && ka[0])
    demos.push(makeOpp(pi[0].name, 'predictit', pi[0].probability!, ka[0].name, 'kalshi', Math.min(97, pi[0].probability! + 11)));
  if (mf[0] && pi[1])
    demos.push(makeOpp(pi[1].name, 'predictit', Math.max(3, pi[1].probability! - 9), mf[0].name, 'manifold', mf[0].probability!));
  if (pm[0] && ka[1])
    demos.push(makeOpp(ka[1]?.name ?? 'Market', 'kalshi', Math.max(3, (ka[1]?.probability ?? 50) - 7), pm[0].name, 'polymarket', pm[0].probability!));
  return demos.sort((a, b) => b.roi - a.roi);
}

// ── Expiry helpers ────────────────────────────────

function expiryLabel(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return 'Expired';
  const h = diff / 3_600_000;
  if (h < 1)   return `Expires in ${Math.round(h * 60)}m`;
  if (h < 24)  return `Expires in ${Math.round(h)}h`;
  const d = Math.floor(h / 24);
  return `Expires in ${d}d`;
}

function expiryUrgencyClass(ms: number | null | undefined): string {
  if (!ms) return 'border-gray-700 bg-gray-800/40 text-gray-500';
  const diff = ms - Date.now();
  if (diff < 3_600_000)  return 'border-red-700 bg-red-950/40 text-red-400';
  if (diff < 86_400_000) return 'border-amber-700 bg-amber-900/40 text-amber-400';
  return 'border-gray-700 bg-gray-800/40 text-gray-400';
}

function gapAgeLabel(ms: number | null): string | null {
  if (ms == null) return null;
  if (ms < 60_000)      return 'just now';
  if (ms < 3_600_000)   return `${Math.round(ms / 60_000)}m old`;
  if (ms < 86_400_000)  return `${Math.round(ms / 3_600_000)}h old`;
  return `${Math.floor(ms / 86_400_000)}d old`;
}

function gapAgeClass(ms: number | null): string {
  if (ms == null)       return 'border-gray-700 bg-gray-800/40 text-gray-500';
  if (ms < 3_600_000)   return 'border-emerald-700 bg-emerald-950/40 text-emerald-400'; // fresh
  if (ms < 86_400_000)  return 'border-amber-700 bg-amber-900/40 text-amber-400';       // aging
  return 'border-gray-700 bg-gray-800/40 text-gray-500';                                 // stale
}

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function fmtDollars(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

// ── Main page ─────────────────────────────────────

const REFRESH_INTERVAL = 30;
const EMPTY_PANELS: MarketsResponse['panels'] = {
  predictit: [], manifold: [], kalshi: [], polymarket: [],
  smarkets: [], metaculus: [], augur: [], oddsapi: [],
};

export default function Home() {
  const [panels,        setPanels]        = useState<MarketsResponse['panels']>(EMPTY_PANELS);
  const [arbCandidates, setArbCandidates] = useState<ArbCandidate[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [lastUpdate,    setLastUpdate]    = useState<Date | null>(null);
  const [countdown,     setCountdown]     = useState(REFRESH_INTERVAL);
  const [bankroll,      setBankroll]      = useState(1000);
  const [expiryFilter,  setExpiryFilter]  = useState<ExpiryFilter>('all');
  const [activeTab,     setActiveTab]     = useState<'opportunities' | 'history'>('opportunities');
  const [history,       setHistory]       = useState<HistoryRecord[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [sentiment,     setSentiment]     = useState<SentimentData | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const data: MarketsResponse = await fetch('/api/markets', { cache: 'no-store' }).then(r => r.json());
      setPanels(data.panels);
      setArbCandidates(data.arbCandidates);
      setLastUpdate(new Date());
      setCountdown(REFRESH_INTERVAL);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    if (historyLoaded) return;
    try {
      const data = await fetch('/api/history', { cache: 'no-store' }).then(r => r.json());
      setHistory(data.records ?? []);
      setHistoryLoaded(true);
    } catch {}
  }, [historyLoaded]);

  const fetchSentiment = useCallback(async () => {
    try {
      const resp = await fetch('/api/sentiment', { cache: 'no-store' });
      if (resp.ok) setSentiment(await resp.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchAll(); fetchSentiment();
    const iv = setInterval(() => { fetchAll(); fetchSentiment(); }, REFRESH_INTERVAL * 1_000);
    return () => clearInterval(iv);
  }, [fetchAll, fetchSentiment]);

  useEffect(() => {
    const t = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (activeTab === 'history') fetchHistory();
  }, [activeTab, fetchHistory]);

  const realArb  = detectArbitrage(arbCandidates);
  // Only inject demo fallbacks when no time filter is active — a filtered empty state
  // should say "nothing here" rather than silently show unrelated opportunities.
  const demoOpps = realArb.length < 3 && expiryFilter === 'all' ? getDemoOpps(panels) : [];
  const allArb   = [...realArb, ...demoOpps].slice(0, 8);
  const demoIds  = new Set(demoOpps.map(o => o.highMarket.id));

  // Apply gap-age filter: show only opportunities where the price gap is ≤ filterMs old.
  const filterMs = EXPIRY_FILTERS.find(f => f.key === expiryFilter)!.ms;
  const arb = expiryFilter === 'all' ? allArb : allArb.filter(o => {
    if (o.gapAge == null) return false; // no tracking data — exclude from filtered views
    return o.gapAge <= filterMs;
  });

  const totalMarkets =
    panels.predictit.length + panels.manifold.length +
    panels.kalshi.length    + panels.polymarket.length +
    panels.smarkets.length  + panels.metaculus.length  +
    panels.augur.length     + panels.oddsapi.length;

  const bestRoi     = arb[0]?.roi ?? 0;
  const totalSpread = arb.reduce((s, o) => s + o.spread, 0);

  if (loading) {
    return (
      <div className="bg-gray-950 min-h-screen flex flex-col items-center justify-center gap-4">
        <div className="flex gap-2">
          {[0, 1, 2].map(i => (
            <div key={i} className="w-3 h-3 bg-blue-500 rounded-full animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
        <p className="text-gray-400 text-sm tracking-wide">Scanning 8 platforms + 40 bookmakers…</p>
      </div>
    );
  }

  return (
    <main className="bg-gray-950 min-h-screen text-white">

      {/* ── HEADER ──────────────────────────────── */}
      <header className="sticky top-0 z-10 border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold tracking-tight">Prediction Market Scanner</h1>
              <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-green-700 bg-green-900/50 text-xs font-semibold text-green-400">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                LIVE
              </span>
            </div>
            <p className="text-gray-400 text-sm max-w-xl">
              8 platforms + 40 bookmakers · 30s refresh · AI-powered matching · Kelly sizing · expiry tracking
            </p>
          </div>
          <div className="text-right flex-shrink-0 pt-0.5 space-y-1">
            <div className="text-xs text-gray-600 uppercase tracking-wider">Last updated</div>
            <div className="text-sm font-medium text-gray-300">{lastUpdate ? timeAgo(lastUpdate) : '—'}</div>
            <div className="flex items-center justify-end gap-1.5">
              <svg className="w-3 h-3 text-gray-500 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <span className="text-xs text-gray-500 tabular-nums">refresh in {countdown}s</span>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">

        {/* ── CONTROLS ROW ─────────────────────────── */}
        <section>
          <div className="flex flex-wrap items-center gap-4 p-4 rounded-xl border border-gray-800 bg-gray-900/40">
            {/* Bankroll */}
            <div className="flex items-center gap-2">
              <span className="text-gray-400 text-sm font-medium whitespace-nowrap">Bankroll:</span>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                <input
                  type="number" min={1} value={bankroll}
                  onChange={e => setBankroll(Math.max(1, parseInt(e.target.value) || 1))}
                  className="pl-7 pr-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm w-28 focus:outline-none focus:border-blue-600"
                />
              </div>
            </div>

            <div className="w-px h-6 bg-gray-700 hidden sm:block" />

            {/* Gap-age filter — hide stale price spreads */}
            <div className="flex flex-col gap-1.5 flex-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-gray-400 text-xs font-medium">Price gap age:</span>
                <span className="text-gray-600 text-xs">hide spreads older than →</span>
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-gray-600 text-xs w-10 shrink-0">hrs:</span>
                {EXPIRY_ROW1.map(f => (
                  <button key={f.key} onClick={() => setExpiryFilter(f.key)}
                    className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${
                      expiryFilter === f.key ? COLOR_ACTIVE[f.color] : COLOR_IDLE[f.color]
                    }`}>
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-gray-600 text-xs w-10 shrink-0">days:</span>
                {EXPIRY_ROW2.map(f => (
                  <button key={f.key} onClick={() => setExpiryFilter(f.key)}
                    className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${
                      expiryFilter === f.key ? COLOR_ACTIVE[f.color] : COLOR_IDLE[f.color]
                    }`}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <span className="text-gray-600 text-xs ml-auto hidden lg:block">
              Kelly sizing · max-bet respects available liquidity
            </span>
          </div>
        </section>

        {/* ── SUMMARY CARDS ───────────────────────── */}
        <section>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <SummaryCard icon="📡" value={String(totalMarkets)} label="Markets Monitored"
              sub="8 platforms + 40 bookmakers" accent="border-blue-800/50 bg-blue-950/20" />
            <SummaryCard icon="🔍" value={String(arb.length)} label="Opportunities Found"
              sub={arb.length > 0 ? 'price gaps detected' : 'markets in sync'}
              accent={arb.length > 0 ? 'border-green-800/50 bg-green-950/20' : 'border-gray-700/40 bg-gray-800/20'} />
            <SummaryCard icon="📈"
              value={bestRoi > 0 ? `${bestRoi.toFixed(1)}%` : '—'}
              label="Best ROI Available"
              sub={bestRoi > 0 ? 'return on investment' : 'no arb detected'}
              accent={bestRoi > 0 ? 'border-yellow-800/50 bg-yellow-950/20' : 'border-gray-700/40 bg-gray-800/20'} />
            <SummaryCard icon="💰"
              value={totalSpread > 0 ? `${totalSpread.toFixed(1)}¢` : '—'}
              label="Total Profit Potential"
              sub="combined price spreads"
              accent={totalSpread > 0 ? 'border-purple-800/50 bg-purple-950/20' : 'border-gray-700/40 bg-gray-800/20'} />
          </div>
        </section>

        {/* ── TABS ────────────────────────────────── */}
        <section>
          <div className="flex gap-1 p-1 rounded-xl bg-gray-900 border border-gray-800 w-fit">
            {(['opportunities', 'history'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-5 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  activeTab === tab ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}>
                {tab === 'opportunities' ? 'Arbitrage Opportunities' : 'History'}
              </button>
            ))}
          </div>
        </section>

        {activeTab === 'opportunities' && (
          <>
            {/* ── ARBITRAGE OPPORTUNITIES ─────────────── */}
            <section>
              <div className="mb-5">
                <div className="flex items-center gap-3">
                  <h2 className="text-xl font-bold">Arbitrage Opportunities</h2>
                  {arb.length > 0 && (
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold border border-green-700 bg-green-900/50 text-green-300">
                      {arb.length} found
                    </span>
                  )}
                  {expiryFilter !== 'all' && (() => {
                    const f = EXPIRY_FILTERS.find(x => x.key === expiryFilter)!;
                    return (
                      <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${COLOR_ACTIVE[f.color]}`}>
                        ≤ {f.label}
                      </span>
                    );
                  })()}
                </div>
                <p className="text-gray-500 text-sm mt-1">
                  Same event, different prices across platforms — buy cheap, profit from the gap.
                </p>
              </div>

              {arb.length === 0 ? (
                <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
                  <div className="text-5xl mb-4">🔎</div>
                  <p className="text-gray-300 font-semibold text-lg">
                    {expiryFilter !== 'all'
                      ? `No opportunities with a gap age ≤ ${EXPIRY_FILTERS.find(f => f.key === expiryFilter)!.label} right now.`
                      : 'No opportunities right now'}
                  </p>
                  <p className="text-gray-600 text-sm mt-2 max-w-sm mx-auto">
                    {expiryFilter !== 'all'
                      ? 'Try a longer timeframe.'
                      : 'Markets are pricing similar events consistently. Gaps open frequently — check back in 30 seconds.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {arb.map((opp, i) => (
                    <ArbCard key={i} opp={opp} rank={i + 1}
                      isDemo={demoIds.has(opp.highMarket.id)}
                      bankroll={bankroll} sentiment={sentiment} />
                  ))}
                </div>
              )}
            </section>

            {/* ── BEGINNER EXPLAINER ──────────────────── */}
            <section className="rounded-xl border border-gray-800 bg-gray-900/40 p-6">
              <div className="flex gap-4">
                <span className="text-3xl flex-shrink-0">💡</span>
                <div>
                  <h3 className="font-semibold text-gray-200 mb-2">How does this work?</h3>
                  <p className="text-gray-400 text-sm leading-relaxed">
                    Prediction markets let people bet on future events — a <span className="text-white font-medium">65% price</span> means
                    the crowd thinks there's a 65% chance of YES.{' '}
                    <span className="text-white font-medium">Arbitrage</span> happens when Platform A prices the same event at 40%
                    while Platform B prices it at 65%. Buying on A and waiting for prices to converge locks in a{' '}
                    <span className="text-green-400 font-medium">risk-adjusted profit</span>.
                    The <span className="text-white font-medium">Kelly criterion</span> tells you the mathematically optimal fraction
                    of your bankroll to bet, capped by available liquidity.
                  </p>
                </div>
              </div>
            </section>

            {/* ── LIVE MARKETS BY PLATFORM ────────────── */}
            <section>
              <h2 className="text-xl font-bold mb-5">Live Markets by Platform</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                {(Object.keys(PLATFORMS) as PlatformKey[]).map(key => (
                  <PlatformPanel key={key} platformKey={key} markets={panels[key]} />
                ))}
              </div>
            </section>
          </>
        )}

        {activeTab === 'history' && <HistoryTab records={history} />}

      </div>
    </main>
  );
}

// ── Sub-components ────────────────────────────────

function SummaryCard({ icon, value, label, sub, accent }: {
  icon: string; value: string; label: string; sub: string; accent: string;
}) {
  return (
    <div className={`rounded-xl border p-5 ${accent}`}>
      <div className="text-2xl mb-3">{icon}</div>
      <div className="text-3xl font-bold tabular-nums leading-none">{value}</div>
      <div className="text-sm font-semibold text-gray-200 mt-2">{label}</div>
      <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
    </div>
  );
}

function ArbCard({ opp, rank, isDemo, bankroll, sentiment }: {
  opp: ArbitrageOpp; rank: number; isDemo?: boolean;
  bankroll: number; sentiment: SentimentData | null;
}) {
  const roiText   = 'text-green-400';
  const roiBorder = 'border-green-700 bg-green-900/50';

  const lowCfg  = PLATFORMS[opp.lowMarket.platform  as PlatformKey] ?? PLATFORMS.oddsapi;
  const highCfg = PLATFORMS[opp.highMarket.platform as PlatformKey] ?? PLATFORMS.oddsapi;
  const lowLabel  = opp.lowMarket.bookmaker  ?? lowCfg.label;
  const highLabel = opp.highMarket.bookmaker ?? highCfg.label;

  // Kelly + liquidity-aware sizing
  const kelly       = kellyFraction(opp.lowMarket.probability, opp.highMarket.probability);
  const kellyRaw    = Math.round(bankroll * kelly);
  const lowLiq      = opp.lowMarket.liquidity  ?? null;
  const highLiq     = opp.highMarket.liquidity ?? null;
  // Max tradeable = bottleneck side (if we know both; otherwise the one we know)
  const maxTrade    = lowLiq != null && highLiq != null
                        ? Math.min(lowLiq, highLiq)
                        : (lowLiq ?? highLiq ?? null);
  const betSize     = maxTrade != null ? Math.min(kellyRaw, maxTrade) : kellyRaw;
  const liqLimited  = maxTrade != null && kellyRaw > maxTrade;
  const maxProfit   = betSize > 0 ? Math.round(betSize * opp.roi / 100) : null;

  // Volume / liquidity display
  const lowVol  = opp.lowMarket.volume  ?? null;
  const highVol = opp.highMarket.volume ?? null;
  const lowLiquidity = (lowVol !== null && lowVol < 1000) || (highVol !== null && highVol < 1000);

  // Flags
  const longshotBias = opp.lowMarket.probability < 8;
  const expiryText   = expiryLabel(opp.expiresAt);
  const expiryClass  = expiryUrgencyClass(opp.expiresAt);

  // Sentiment
  const qWords = opp.question.toLowerCase().split(/\s+/);
  const sentimentMatch = sentiment?.entries.find(e =>
    qWords.some(w => w.includes(e.keyword.toLowerCase()))
  ) ?? null;

  return (
    <div className={`rounded-xl border bg-gray-900/60 hover:border-gray-700 transition-colors p-5 ${
      isDemo ? 'border-gray-700/50 opacity-80' : 'border-gray-800'
    }`}>
      <div className="flex items-start gap-4">

        {/* ROI badge */}
        <div className={`flex-shrink-0 text-center rounded-xl border px-3 py-2.5 min-w-[76px] ${roiBorder}`}>
          <div className={`text-xl font-bold leading-none ${roiText}`}>{opp.roi.toFixed(1)}%</div>
          <div className="text-xs text-gray-500 mt-1">ROI</div>
        </div>

        <div className="flex-1 min-w-0">

          {/* Question + flags row */}
          <div className="flex items-start gap-2 mb-2">
            <span className="text-xs font-mono text-gray-600 mt-0.5">#{rank}</span>
            <p className="text-sm font-semibold text-gray-100 line-clamp-2 leading-snug flex-1">{opp.question}</p>
            <div className="flex flex-shrink-0 flex-wrap gap-1 mt-0.5">
              {isDemo && (
                <span className="text-xs font-bold px-1.5 py-0.5 rounded border border-gray-600 text-gray-500">DEMO</span>
              )}
              {longshotBias && (
                <span className="text-xs font-bold px-1.5 py-0.5 rounded border border-amber-700 bg-amber-900/40 text-amber-400">BIAS ALERT</span>
              )}
              {lowLiquidity && (
                <span className="text-xs font-bold px-1.5 py-0.5 rounded border border-red-800 bg-red-950/40 text-red-400">⚠ LOW LIQ</span>
              )}
              {sentimentMatch && (
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded border ${
                  sentimentMatch.score > 0
                    ? 'border-emerald-700 bg-emerald-900/40 text-emerald-400'
                    : 'border-red-800 bg-red-950/40 text-red-400'
                }`}>
                  {sentimentMatch.score > 0 ? '↑' : '↓'} REDDIT
                </span>
              )}
            </div>
          </div>

          {/* Gap-age badge + market expiry badge */}
          {(gapAgeLabel(opp.gapAge) || expiryLabel(opp.expiresAt)) && (
            <div className="flex gap-1.5 mb-2 flex-wrap">
              {gapAgeLabel(opp.gapAge) && (
                <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded border ${gapAgeClass(opp.gapAge)}`}>
                  🔄 Gap: {gapAgeLabel(opp.gapAge)}
                </span>
              )}
              {expiryLabel(opp.expiresAt) && (
                <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded border ${expiryUrgencyClass(opp.expiresAt)}`}>
                  ⏱ {expiryLabel(opp.expiresAt)}
                </span>
              )}
            </div>
          )}

          {/* Price comparison with max-bet */}
          <div className="flex flex-wrap items-start gap-2 mb-2.5">
            {/* Buy side */}
            <div className="flex flex-col gap-0.5 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${lowCfg.dotClass}`} />
                <span className="text-xs text-gray-400">{lowLabel}</span>
                <span className="text-sm font-bold tabular-nums text-red-400">{opp.lowMarket.probability}%</span>
              </div>
              {lowLiq != null && (
                <span className="text-xs text-gray-500 pl-4">
                  Max bet: <span className={lowLiq < 500 ? 'text-red-400' : 'text-gray-400'}>{fmtDollars(lowLiq)}</span>
                </span>
              )}
            </div>

            <span className="text-gray-600 text-sm font-medium self-center">vs</span>

            {/* Sell side */}
            <div className="flex flex-col gap-0.5 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${highCfg.dotClass}`} />
                <span className="text-xs text-gray-400">{highLabel}</span>
                <span className="text-sm font-bold tabular-nums text-green-400">{opp.highMarket.probability}%</span>
              </div>
              {highLiq != null && (
                <span className="text-xs text-gray-500 pl-4">
                  Max bet: <span className={highLiq < 500 ? 'text-red-400' : 'text-gray-400'}>{fmtDollars(highLiq)}</span>
                </span>
              )}
            </div>

            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border self-center ${roiBorder} ${roiText}`}>
              +{opp.spread.toFixed(1)}¢ spread
            </span>
          </div>

          {/* Max profit row */}
          {maxTrade != null && maxProfit != null && (
            <div className="mb-2 px-3 py-1.5 rounded-lg bg-gray-800/60 border border-gray-700/50 text-xs flex items-center gap-2 flex-wrap">
              <span className="text-gray-500">Bottleneck liquidity:</span>
              <span className="text-gray-300 font-semibold">{fmtDollars(maxTrade)}</span>
              <span className="text-gray-600">→</span>
              <span className="text-gray-500">Max profit:</span>
              <span className="text-green-400 font-bold">${maxProfit}</span>
              <span className="text-gray-600">with {fmtDollars(betSize)} invested</span>
            </div>
          )}

          {/* Action + Kelly row */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-gray-600">
              Buy on <span className="text-gray-400">{lowLabel}</span> at {opp.lowMarket.probability}% —{' '}
              {opp.spread.toFixed(1)}% cheaper than <span className="text-gray-400">{highLabel}</span>
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg border ${roiBorder} ${roiText} whitespace-nowrap`}>
                Invest $100 → earn ${opp.earnPer100}
              </span>
              {kelly > 0 && (
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg border whitespace-nowrap ${
                  liqLimited
                    ? 'border-amber-700 bg-amber-900/30 text-amber-300'
                    : 'border-blue-800 bg-blue-950/40 text-blue-300'
                }`}>
                  {liqLimited
                    ? `Liq. limited: bet $${betSize}`
                    : `Kelly: ${(kelly * 100).toFixed(1)}% = $${betSize}`}
                </span>
              )}
            </div>
          </div>

          {/* Platform links */}
          {!isDemo && (opp.lowMarket.url || opp.highMarket.url) && (
            <div className="flex gap-2 mt-2.5 flex-wrap">
              {opp.lowMarket.url && (
                <a href={opp.lowMarket.url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 transition-colors">
                  <span className={`w-1.5 h-1.5 rounded-full ${lowCfg.dotClass}`} />
                  View on {lowCfg.label}
                  <svg className="w-3 h-3 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </a>
              )}
              {opp.highMarket.url && (
                <a href={opp.highMarket.url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 transition-colors">
                  <span className={`w-1.5 h-1.5 rounded-full ${highCfg.dotClass}`} />
                  View on {highCfg.label}
                  <svg className="w-3 h-3 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlatformPanel({ platformKey, markets }: { platformKey: PlatformKey; markets: PanelMarket[] }) {
  const cfg = PLATFORMS[platformKey];
  return (
    <div className={`rounded-xl border overflow-hidden ${cfg.borderClass} ${cfg.bgClass}`}>
      <div className="flex items-center gap-2.5 px-5 py-3 border-b border-gray-800/80">
        <span className={`w-2.5 h-2.5 rounded-full ${cfg.dotClass}`} />
        <h3 className={`font-bold ${cfg.headerClass}`}>{cfg.label}</h3>
        <span className="ml-auto text-xs text-gray-600">{markets.length} markets</span>
      </div>
      <div className="divide-y divide-gray-800/40">
        {markets.length === 0 && (
          <p className="px-5 py-4 text-sm text-gray-600">No data available</p>
        )}
        {markets.map(m => {
          const expiry = expiryLabel(m.expiresAt);
          const expClass = expiryUrgencyClass(m.expiresAt);
          return (
            <div key={m.id} className="px-5 py-3 flex items-start justify-between gap-3 hover:bg-white/[0.03] transition-colors">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className="text-sm text-gray-200 font-medium line-clamp-1">{m.name}</p>
                  {m.probability !== null && m.probability < 8 && (
                    <span className="text-xs font-bold px-1 py-0.5 rounded border border-amber-800 bg-amber-950/40 text-amber-500">BIAS</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <p className="text-xs text-gray-600">{m.detail}</p>
                  {m.volume != null && m.volume < 1000 && (
                    <span className="text-xs text-red-500">⚠ low vol</span>
                  )}
                  {m.volume != null && m.volume >= 1000 && (
                    <span className="text-xs text-gray-700">{fmtDollars(m.volume)} vol</span>
                  )}
                  {expiry && (
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded border ${expClass}`}>{expiry}</span>
                  )}
                </div>
              </div>
              {m.probability != null && (
                <span className={`flex-shrink-0 text-sm font-bold tabular-nums ${
                  m.probability >= 70 ? 'text-green-400' :
                  m.probability >= 40 ? 'text-yellow-400' : 'text-red-400'
                }`}>{m.probability}%</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HistoryTab({ records }: { records: HistoryRecord[] }) {
  if (records.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
        <div className="text-5xl mb-4">📋</div>
        <p className="text-gray-300 font-semibold text-lg">No history yet</p>
        <p className="text-gray-600 text-sm mt-2">
          Opportunities will appear here once the arbitrage calculator finds and saves them to the database.
        </p>
      </div>
    );
  }
  return (
    <section>
      <div className="mb-5">
        <h2 className="text-xl font-bold">Opportunity History</h2>
        <p className="text-gray-500 text-sm mt-1">Last 100 arbitrage opportunities detected by the pipeline.</p>
      </div>
      <div className="rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-900/60">
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Event</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Platforms</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Spread</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">ROI</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {records.map(r => (
              <tr key={r.id} className="hover:bg-white/[0.02] transition-colors">
                <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                  {new Date(r.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="px-4 py-3 text-gray-200 max-w-xs">
                  <p className="line-clamp-1">{r.event_name}</p>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <PlatformBadge platform={r.platform_low}  prob={r.prob_low} />
                    <span className="text-gray-600">vs</span>
                    <PlatformBadge platform={r.platform_high} prob={r.prob_high} />
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-gray-400 tabular-nums">{r.spread.toFixed(1)}¢</td>
                <td className="px-4 py-3 text-right">
                  <span className="font-bold tabular-nums text-green-400">{r.roi.toFixed(1)}%</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PlatformBadge({ platform, prob }: { platform: string; prob: number }) {
  const cfg = PLATFORMS[platform as PlatformKey] ?? PLATFORMS.oddsapi;
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border ${cfg.badgeClass}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dotClass}`} />
      {cfg.label} {prob}%
    </span>
  );
}

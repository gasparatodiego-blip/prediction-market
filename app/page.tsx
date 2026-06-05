'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { MarketsResponse, PanelMarket, ArbCandidate } from './api/markets/route';
import type { CryptoResponse, ExchangePrice, CryptoMarket, CexArbOpp, FuturesInfo, BasisTrade, HighFunding, DexPrice } from './api/crypto/route';
import type { SportsResponse, SportsMarket } from './api/sports/route';
import type { WeatherResponse, WeatherMarket, CityForecast } from './api/weather/route';

interface AuthUser { id: number; email: string; role: 'free' | 'pro' | 'admin'; }

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
  betfair: {
    label:       'Betfair Exchange',
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
  opinionmarkets: {
    label:       'Opinion Markets',
    dotClass:    'bg-pink-400',
    headerClass: 'text-pink-400',
    borderClass: 'border-pink-900/40',
    bgClass:     'bg-pink-950/20',
    badgeClass:  'bg-pink-900/60 border-pink-700 text-pink-300',
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
  expiresAt:  number | null;
  gapAge:     number | null;
  biasScore:  number | null; // calibration bias on low-market probability (positive = overpriced)
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
        expiresAt:  expiries.length ? Math.min(...expiries) : null,
        gapAge,
        biasScore:  low.biasScore ?? null,
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
             earnPer100: Math.round(roi * 10) / 10, expiresAt: null, gapAge: null, biasScore: null };
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
  betfair: [], metaculus: [], augur: [], oddsapi: [], opinionmarkets: [],
};

export default function Home() {
  const router = useRouter();
  const [user,          setUser]          = useState<AuthUser | null>(null);
  const [panels,        setPanels]        = useState<MarketsResponse['panels']>(EMPTY_PANELS);
  const [arbCandidates, setArbCandidates] = useState<ArbCandidate[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [lastUpdate,    setLastUpdate]    = useState<Date | null>(null);
  const [countdown,     setCountdown]     = useState(REFRESH_INTERVAL);
  const [bankroll,      setBankroll]      = useState(1000);
  const [expiryFilter,  setExpiryFilter]  = useState<ExpiryFilter>('all');
  const [activeTab,     setActiveTab]     = useState<'opportunities' | 'history' | 'crypto' | 'sports' | 'weather'>('opportunities');
  const [history,       setHistory]       = useState<HistoryRecord[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [sentiment,     setSentiment]     = useState<SentimentData | null>(null);
  const [crypto,        setCrypto]        = useState<CryptoResponse | null>(null);
  const [sports,        setSports]        = useState<SportsResponse | null>(null);
  const [weather,       setWeather]       = useState<WeatherResponse | null>(null);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
  }

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

  const fetchCrypto = useCallback(async () => {
    try {
      const resp = await fetch('/api/crypto', { cache: 'no-store' });
      if (resp.ok) setCrypto(await resp.json());
    } catch {}
  }, []);

  const fetchSports = useCallback(async () => {
    try {
      const resp = await fetch('/api/sports', { cache: 'no-store' });
      if (resp.ok) setSports(await resp.json());
    } catch {}
  }, []);

  const fetchWeather = useCallback(async () => {
    try {
      const resp = await fetch('/api/weather', { cache: 'no-store' });
      if (resp.ok) setWeather(await resp.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(data => {
      if (data.user) setUser(data.user);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchAll(); fetchSentiment(); fetchCrypto(); fetchSports(); fetchWeather();
    const iv = setInterval(() => { fetchAll(); fetchSentiment(); fetchCrypto(); fetchSports(); fetchWeather(); }, REFRESH_INTERVAL * 1_000);
    return () => clearInterval(iv);
  }, [fetchAll, fetchSentiment, fetchCrypto, fetchSports, fetchWeather]);

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
    panels.betfair.length   + panels.metaculus.length  +
    panels.augur.length     + panels.oddsapi.length    +
    panels.opinionmarkets.length;

  const isPro = user?.role === 'pro' || user?.role === 'admin';
  const FREE_LIMIT = 3;

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
          <div className="flex items-start gap-4 flex-shrink-0 pt-0.5">
            <div className="text-right space-y-1">
              <div className="text-xs text-gray-600 uppercase tracking-wider">Last updated</div>
              <div className="text-sm font-medium text-gray-300">{lastUpdate ? timeAgo(lastUpdate) : '—'}</div>
              <div className="flex items-center justify-end gap-1.5">
                <svg className="w-3 h-3 text-gray-500 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <span className="text-xs text-gray-500 tabular-nums">refresh in {countdown}s</span>
              </div>
            </div>
            {user && (
              <div className="flex flex-col items-end gap-1.5">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                  user.role === 'admin' ? 'border-purple-700 bg-purple-900/40 text-purple-300' :
                  user.role === 'pro'   ? 'border-blue-700 bg-blue-900/40 text-blue-300' :
                                          'border-gray-700 bg-gray-800/40 text-gray-400'
                }`}>{user.role.toUpperCase()}</span>
                <span className="text-xs text-gray-600 truncate max-w-[120px]">{user.email}</span>
                <div className="flex gap-1.5">
                  {user.role === 'admin' && (
                    <button onClick={() => router.push('/admin')}
                      className="text-xs px-2 py-1 rounded border border-purple-800 text-purple-400 hover:border-purple-600 transition-colors">
                      Admin
                    </button>
                  )}
                  <button onClick={logout}
                    className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300 transition-colors">
                    Logout
                  </button>
                </div>
              </div>
            )}
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
          <div className="flex flex-wrap gap-1 p-1 rounded-xl bg-gray-900 border border-gray-800 w-fit">
            {([
              { key: 'opportunities', label: 'Arbitrage' },
              { key: 'crypto',        label: '⚡ Crypto Intel' },
              { key: 'sports',        label: '🏟️ Sports' },
              { key: 'weather',       label: '🌤️ Weather' },
              { key: 'history',       label: 'History' },
            ] as const).map(({ key, label }) => (
              <button key={key} onClick={() => setActiveTab(key)}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                  activeTab === key ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}>
                {label}
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
                  {arb.map((opp, i) => {
                    const isLocked = !isPro && i >= FREE_LIMIT;
                    return isLocked ? (
                      <div key={i} className="relative rounded-xl border border-gray-800 overflow-hidden">
                        <div className="blur-sm pointer-events-none select-none opacity-50">
                          <ArbCard opp={opp} rank={i + 1}
                            isDemo={demoIds.has(opp.highMarket.id)}
                            bankroll={bankroll} sentiment={sentiment} />
                        </div>
                        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-950/70 backdrop-blur-sm gap-3">
                          <span className="text-2xl">🔒</span>
                          <p className="text-white font-semibold text-sm">Pro opportunity</p>
                          <p className="text-gray-400 text-xs">Upgrade to see all {arb.length} opportunities</p>
                          <a href="mailto:gasparatodiego@gmail.com?subject=Upgrade to Pro"
                            className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors">
                            Upgrade to Pro
                          </a>
                        </div>
                      </div>
                    ) : (
                      <ArbCard key={i} opp={opp} rank={i + 1}
                        isDemo={demoIds.has(opp.highMarket.id)}
                        bankroll={bankroll} sentiment={sentiment} />
                    );
                  })}
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
                  <PlatformPanel key={key} platformKey={key} markets={(panels as any)[key] ?? []} />
                ))}
              </div>
            </section>
          </>
        )}

        {activeTab === 'history' && <HistoryTab records={history} />}
        {activeTab === 'crypto'  && <CryptoTab data={crypto} />}
        {activeTab === 'sports'  && <SportsTab data={sports} />}
        {activeTab === 'weather' && <WeatherTab data={weather} />}

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

  // Calibration bias (replaces simple < 8% threshold)
  const bs         = opp.biasScore;
  const biasStrong = bs != null && bs > 0.30;
  const biasMild   = bs != null && bs > 0.15 && !biasStrong;
  const biasClass  = biasStrong ? 'text-red-400' : biasMild ? 'text-yellow-400' : 'text-green-400';
  const biasBarPct = bs != null ? Math.min(100, Math.round(Math.abs(bs) * 100)) : 0;
  const biasBarBg  = biasStrong ? 'bg-red-500' : biasMild ? 'bg-yellow-500' : 'bg-green-500';
  // Fall back to simple heuristic when no calibration data
  const longshotBias = biasStrong || (bs == null && opp.lowMarket.probability < 8);

  const expiryText  = expiryLabel(opp.expiresAt);
  const expiryClass = expiryUrgencyClass(opp.expiresAt);

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
                <span className="text-xs font-bold px-1.5 py-0.5 rounded border border-amber-700 bg-amber-900/40 text-amber-400">
                  {biasStrong && bs != null
                    ? `BIAS: overpriced ${(bs * 100).toFixed(0)}%`
                    : 'BIAS ALERT'}
                </span>
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

          {/* Bias calibration bar — shown when bias data is available */}
          {bs != null && (
            <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-gray-800/50 border border-gray-700/40">
              <span className="text-xs text-gray-500 shrink-0">Longshot bias:</span>
              <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden max-w-28">
                <div
                  className={`h-full rounded-full transition-all ${biasBarBg}`}
                  style={{ width: `${biasBarPct}%` }}
                />
              </div>
              <span className={`text-xs font-semibold shrink-0 ${biasClass}`}>
                {biasStrong
                  ? `Historically overpriced ${biasBarPct}%`
                  : biasMild
                  ? `Slight bias (${biasBarPct}%)`
                  : `Well calibrated`}
              </span>
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
          <p className="px-5 py-4 text-sm text-gray-600">
            {platformKey === 'metaculus'      ? 'API now requires authentication' :
             platformKey === 'augur'          ? 'Platform inactive (subgraph moved)' :
             platformKey === 'opinionmarkets' ? 'API unavailable (connection timeout)' :
             'No data available'}
          </p>
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

// ── Crypto Tab ────────────────────────────────────

const COIN_META: Record<string, { label: string; emoji: string }> = {
  BTC:  { label: 'Bitcoin',  emoji: '₿' },
  ETH:  { label: 'Ethereum', emoji: 'Ξ' },
  SOL:  { label: 'Solana',   emoji: '◎' },
  BNB:  { label: 'BNB',      emoji: '⬡' },
  XRP:  { label: 'XRP',      emoji: '✕' },
  DOGE: { label: 'Dogecoin', emoji: 'Ð' },
};

const EXCHANGE_LABEL: Record<string, string> = {
  binance: 'Binance', coinbase: 'Coinbase', okx: 'OKX',
  bybit: 'Bybit', kraken: 'Kraken', gateio: 'Gate.io',
};

const DEX_LABEL: Record<string, string> = {
  jupiter: 'Jupiter (SOL)', dydx: 'dYdX', uniswap: 'Uniswap V3', '1inch': '1inch',
};

function fmtPrice(p: number): string {
  if (p >= 1000) return `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (p >= 1)    return `$${p.toFixed(2)}`;
  return `$${p.toFixed(4)}`;
}

function fundingClass(fr: number): string {
  if (fr > 0.1)  return 'text-red-400 font-bold';
  if (fr > 0)    return 'text-red-400';
  if (fr < -0.1) return 'text-green-400 font-bold';
  return 'text-green-400';
}

function CryptoTab({ data }: { data: CryptoResponse | null }) {
  if (!data) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
        <div className="text-5xl mb-4">⚡</div>
        <p className="text-gray-300 font-semibold text-lg">Loading exchange prices…</p>
        <p className="text-gray-600 text-sm mt-2">agent10-binance (WebSocket + REST) + agent11-dex fetch every 60s / 5min.</p>
      </div>
    );
  }

  const { exchanges, cexArb, infoLag, futures, basisTrades, highFunding, dex, dexCexSpread, cryptoMarkets, dataAge } = data;
  const dataStale      = dataAge > 180_000;
  const infoLagMarkets = cryptoMarkets.filter(m => m.infoLag);
  const coins          = Object.keys(COIN_META);
  const exchangeNames  = Object.keys(exchanges);
  const perpCoins      = ['BTC','ETH','SOL'];
  const dexSources     = Object.keys(dex).filter(s => Object.keys(dex[s]).length > 0);

  function bestPrice(coin: string): number | null {
    const prices = exchangeNames.map(ex => exchanges[ex]?.[coin]?.price).filter((p): p is number => p > 0);
    if (!prices.length) return null;
    prices.sort((a, b) => a - b);
    return prices[Math.floor(prices.length / 2)];
  }

  function change24h(coin: string) { return exchanges.binance?.[coin]?.change24hPct ?? null; }

  return (
    <div className="space-y-8">

      {/* ── Alert banners ──────────────────────────── */}
      <div className="space-y-3">
        {highFunding.length > 0 && (
          <div className="rounded-xl border border-red-700 bg-red-950/30 p-4 flex gap-3 items-start">
            <span className="text-2xl flex-shrink-0">🔥</span>
            <div className="flex-1">
              <p className="font-semibold text-red-300 mb-2">Funding Rate Arbitrage — {highFunding.length} contract{highFunding.length > 1 ? 's' : ''}</p>
              <div className="space-y-2">
                {highFunding.map((h, i) => (
                  <div key={i} className="text-xs font-mono px-3 py-2 rounded border border-red-700 bg-red-900/40 text-red-200 flex flex-wrap items-center gap-2">
                    <span className="font-bold text-white">{h.coin}</span>
                    <span className="text-red-300">Hold {h.coin} {h.fundingRate > 0 ? 'SHORT' : 'LONG'} on {EXCHANGE_LABEL[h.exchange] ?? h.exchange} Perp</span>
                    <span className="text-gray-400">|</span>
                    <span>Earn <span className="text-yellow-300 font-bold">{Math.abs(h.fundingRate).toFixed(4)}% every 8h</span></span>
                    <span className="text-gray-400">|</span>
                    <span className="text-green-400 font-bold">= {h.annualizedApy != null ? Math.abs(h.annualizedApy).toFixed(1) : (Math.abs(h.fundingRate) * 3 * 365).toFixed(1)}% APY</span>
                    <span className="text-gray-500 italic ml-1">(hedge with {h.fundingRate > 0 ? 'spot long' : 'spot short'} to stay neutral)</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {basisTrades.length > 0 && (
          <div className="rounded-xl border border-violet-700 bg-violet-950/30 p-4 flex gap-3 items-start">
            <span className="text-2xl flex-shrink-0">⚖️</span>
            <div className="flex-1">
              <p className="font-semibold text-violet-300 mb-2">Cash &amp; Carry Arbitrage — {basisTrades.length} opportunit{basisTrades.length > 1 ? 'ies' : 'y'}</p>
              <div className="space-y-2">
                {basisTrades.map(b => (
                  <div key={b.coin} className="text-xs font-mono px-3 py-2 rounded border border-violet-700 bg-violet-900/40 text-violet-200 flex flex-wrap items-center gap-2">
                    <span className="font-bold text-white">{b.coin}</span>
                    {b.direction === 'contango' ? (
                      <>
                        <span>Buy <span className="text-blue-300">{b.coin} spot</span> at {fmtPrice(b.spot)}</span>
                        <span className="text-gray-400">|</span>
                        <span>Sell <span className="text-red-300">{b.coin} perp</span> at {fmtPrice(b.futures)}</span>
                        <span className="text-gray-400">|</span>
                        <span>Lock <span className="text-green-400 font-bold">{b.basisPct.toFixed(2)}%</span></span>
                        {b.profitPerUnit != null && <span className="text-yellow-300">(${b.profitPerUnit.toFixed(0)} per coin)</span>}
                      </>
                    ) : (
                      <>
                        <span>Buy <span className="text-blue-300">{b.coin} perp</span> at {fmtPrice(b.futures)}</span>
                        <span className="text-gray-400">|</span>
                        <span>Sell <span className="text-red-300">{b.coin} spot</span> at {fmtPrice(b.spot)}</span>
                        <span className="text-gray-400">|</span>
                        <span>Lock <span className="text-green-400 font-bold">{Math.abs(b.basisPct).toFixed(2)}%</span> discount</span>
                      </>
                    )}
                    {b.annualizedReturn != null && (
                      <><span className="text-gray-400">|</span><span className="text-emerald-400 font-bold">~{b.annualizedReturn.toFixed(1)}% annualized</span></>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {cexArb.length > 0 && (
          <div className="rounded-xl border border-blue-700 bg-blue-950/30 p-4 flex gap-3 items-start">
            <span className="text-2xl flex-shrink-0">💱</span>
            <div className="flex-1">
              <p className="font-semibold text-blue-300 mb-2">CEX Arbitrage — {cexArb.length} pair{cexArb.length > 1 ? 's' : ''}</p>
              <div className="flex flex-wrap gap-2">
                {cexArb.map(a => (
                  <span key={a.coin} className="text-xs font-mono px-2 py-1 rounded border border-blue-700 bg-blue-900/40 text-blue-200">
                    {a.coin}: {EXCHANGE_LABEL[a.low]??a.low} {fmtPrice(a.lowPrice)} vs {EXCHANGE_LABEL[a.high]??a.high} {fmtPrice(a.highPrice)} — <span className="font-bold">{a.spreadPct.toFixed(3)}%</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
        {infoLagMarkets.length > 0 && (
          <div className="rounded-xl border border-orange-700 bg-orange-950/30 p-4 flex gap-3 items-start">
            <span className="text-2xl flex-shrink-0">⚠️</span>
            <div>
              <p className="font-semibold text-orange-300">Information Lag — {infoLagMarkets.length} prediction market{infoLagMarkets.length > 1 ? 's' : ''} may not have priced in Binance move</p>
              <p className="text-orange-400/70 text-sm mt-0.5">Binance price moved ≥3% in the last hour.</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Live CEX prices ─────────────────────────── */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-xl font-bold">Live Prices — 6 CEX · WebSocket + REST</h2>
          <span className={`text-xs px-2 py-0.5 rounded-full border ${dataStale ? 'border-red-700 bg-red-950/40 text-red-400' : 'border-green-700 bg-green-900/40 text-green-400'}`}>
            {dataStale ? 'stale — agent10 offline?' : `ws live · REST ${Math.round(dataAge / 1000)}s ago`}
          </span>
        </div>

        {/* Coin summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
          {coins.map(coin => {
            const bp = bestPrice(coin), chg = change24h(coin), lag = infoLag[coin], up = (chg ?? 0) >= 0;
            const hasFutures = futures.binance?.[coin];
            const fr = hasFutures?.fundingRate ?? null;
            return (
              <div key={coin} className={`rounded-xl border p-3 ${lag ? 'border-orange-700 bg-orange-950/30' : up ? 'border-green-900/50 bg-green-950/20' : 'border-red-900/50 bg-red-950/20'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-base font-bold">{COIN_META[coin].emoji}</span>
                  {lag && <span className="text-xs font-bold px-1 rounded border border-orange-600 bg-orange-900/60 text-orange-300">LAG</span>}
                </div>
                <div className="text-xs text-gray-500">{COIN_META[coin].label}</div>
                {bp != null
                  ? <div className="text-base font-bold tabular-nums mt-1 leading-none">{fmtPrice(bp)}</div>
                  : <div className="text-xs text-gray-600 mt-1">loading…</div>}
                {chg != null && <div className={`text-xs font-semibold mt-0.5 ${up ? 'text-green-400' : 'text-red-400'}`}>{up ? '▲' : '▼'} {Math.abs(chg).toFixed(2)}%</div>}
                {fr != null && <div className={`text-xs mt-0.5 ${fundingClass(fr)}`}>fr {fr > 0 ? '+' : ''}{fr.toFixed(4)}%</div>}
              </div>
            );
          })}
        </div>

        {/* Exchange × Coin price table */}
        <div className="rounded-xl border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900/60">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Coin</th>
                {exchangeNames.map(ex => <th key={ex} className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">{EXCHANGE_LABEL[ex]??ex}</th>)}
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Spread</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {coins.map(coin => {
                const prices      = exchangeNames.map(ex => ({ ex, p: exchanges[ex]?.[coin]?.price ?? null }));
                const validPrices = prices.filter(x => x.p != null).map(x => x.p!);
                const minP = validPrices.length ? Math.min(...validPrices) : null;
                const maxP = validPrices.length ? Math.max(...validPrices) : null;
                const spread = minP && maxP && minP > 0 ? ((maxP - minP) / minP * 100) : 0;
                const arb = cexArb.find(a => a.coin === coin);
                return (
                  <tr key={coin} className={`hover:bg-white/[0.02] ${arb ? 'bg-blue-950/10' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-gray-100">{COIN_META[coin].emoji} {coin}</span>
                        {arb && <span className="text-xs font-bold px-1 rounded border border-blue-600 bg-blue-900/50 text-blue-300">CEX ARB</span>}
                        {infoLag[coin] && <span className="text-xs font-bold px-1 rounded border border-orange-600 bg-orange-900/50 text-orange-300">LAG</span>}
                      </div>
                    </td>
                    {prices.map(({ ex, p }) => (
                      <td key={ex} className={`px-3 py-3 text-right tabular-nums text-sm ${
                        p == null ? 'text-gray-700' :
                        p === minP && validPrices.length > 1 ? 'text-red-400 font-semibold' :
                        p === maxP && validPrices.length > 1 ? 'text-green-400 font-semibold' : 'text-gray-300'
                      }`}>{p != null ? fmtPrice(p) : '—'}</td>
                    ))}
                    <td className={`px-3 py-3 text-right text-xs font-bold tabular-nums ${spread >= 0.3 ? 'text-blue-400' : spread > 0 ? 'text-gray-500' : 'text-gray-700'}`}>
                      {spread > 0 ? `${spread.toFixed(3)}%` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Perpetual Futures + Funding Rates ─────────── */}
      <section>
        <h2 className="text-xl font-bold mb-4">Perpetual Futures — Funding Rates</h2>
        <div className="rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900/60">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Asset</th>
                {['binance','bybit','okx'].map(ex => (
                  <th key={ex} colSpan={2} className="px-3 py-3 text-center text-xs font-semibold text-gray-500 uppercase border-l border-gray-800">
                    {EXCHANGE_LABEL[ex]??ex} Futures
                  </th>
                ))}
              </tr>
              <tr className="border-b border-gray-800 bg-gray-900/40">
                <th className="px-4 py-2 text-left text-xs text-gray-600" />
                {['binance','bybit','okx'].map(ex => (
                  <>
                    <th key={`${ex}-mark`} className="px-3 py-2 text-right text-xs text-gray-600 border-l border-gray-800">Mark</th>
                    <th key={`${ex}-fr`} className="px-3 py-2 text-right text-xs text-gray-600">Funding/8h</th>
                  </>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {perpCoins.map(coin => {
                const spotPrice = exchanges.binance?.[coin]?.price;
                return (
                  <tr key={coin} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-gray-100">{COIN_META[coin]?.emoji} {coin}</span>
                        {spotPrice && <span className="text-xs text-gray-600">spot {fmtPrice(spotPrice)}</span>}
                      </div>
                    </td>
                    {['binance','bybit','okx'].map(ex => {
                      const info = futures[ex]?.[coin];
                      const fr   = info?.fundingRate;
                      const mark = info?.markPrice;
                      const highFund = fr != null && Math.abs(fr) >= 0.1;
                      return (
                        <>
                          <td key={`${ex}-${coin}-mark`} className="px-3 py-3 text-right tabular-nums text-sm text-gray-300 border-l border-gray-800">
                            {mark ? fmtPrice(mark) : <span className="text-gray-700">—</span>}
                          </td>
                          <td key={`${ex}-${coin}-fr`} className="px-3 py-3 text-right tabular-nums text-sm">
                            {fr != null ? (
                              <span className={`font-mono ${fundingClass(fr)} ${highFund ? 'px-1 rounded border border-current' : ''}`}>
                                {fr > 0 ? '+' : ''}{fr.toFixed(4)}%
                                {highFund && ' 🔥'}
                              </span>
                            ) : <span className="text-gray-700">—</span>}
                          </td>
                        </>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-600 mt-2">
          Positive funding = longs pay shorts (market is leveraged long — bullish sentiment).
          Negative funding = shorts pay longs. High funding (&gt;0.1%) = crowded trade risk.
        </p>
      </section>

      {/* ── Cash & Carry Opportunities ────────────── */}
      {basisTrades.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4">Cash &amp; Carry (Spot vs Perp Arbitrage)</h2>
          <div className="space-y-3">
            {basisTrades.map(b => (
              <div key={b.coin} className="rounded-xl border border-violet-800/50 bg-violet-950/20 p-5">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{COIN_META[b.coin]?.emoji ?? '?'}</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-lg">{b.coin}</span>
                        <span className="text-xs font-bold px-1.5 py-0.5 rounded border border-violet-600 bg-violet-900/60 text-violet-300">CASH &amp; CARRY</span>
                        <span className={`text-xs font-semibold ${b.direction === 'contango' ? 'text-orange-400' : 'text-blue-400'}`}>{b.direction}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">{b.exchange} · market neutral</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-violet-400">{b.basisPct > 0 ? '+' : ''}{b.basisPct.toFixed(3)}%</div>
                    <div className="text-xs text-gray-500">premium</div>
                    {b.annualizedReturn != null && (
                      <div className="text-sm font-bold text-emerald-400 mt-1">~{b.annualizedReturn.toFixed(1)}% / yr</div>
                    )}
                  </div>
                </div>
                {/* Trade instruction */}
                <div className="flex flex-wrap items-center gap-2 text-sm bg-gray-900/60 rounded-lg px-4 py-3 font-mono">
                  {b.direction === 'contango' ? (
                    <>
                      <span className="text-blue-400">Buy {b.coin} spot</span>
                      <span className="text-gray-600">at</span>
                      <span className="text-white font-bold">{fmtPrice(b.spot)}</span>
                      <span className="text-gray-600 mx-1">|</span>
                      <span className="text-red-400">Sell {b.coin} perp</span>
                      <span className="text-gray-600">at</span>
                      <span className="text-white font-bold">{fmtPrice(b.futures)}</span>
                      <span className="text-gray-600 mx-1">|</span>
                      <span className="text-green-400 font-bold">Lock {b.basisPct.toFixed(2)}%</span>
                      {b.profitPerUnit != null && <span className="text-yellow-300">(${b.profitPerUnit.toFixed(0)} per {b.coin})</span>}
                    </>
                  ) : (
                    <>
                      <span className="text-blue-400">Buy {b.coin} perp</span>
                      <span className="text-gray-600">at</span>
                      <span className="text-white font-bold">{fmtPrice(b.futures)}</span>
                      <span className="text-gray-600 mx-1">|</span>
                      <span className="text-red-400">Sell {b.coin} spot</span>
                      <span className="text-gray-600">at</span>
                      <span className="text-white font-bold">{fmtPrice(b.spot)}</span>
                      <span className="text-gray-600 mx-1">|</span>
                      <span className="text-green-400 font-bold">Lock {Math.abs(b.basisPct).toFixed(2)}% discount</span>
                    </>
                  )}
                </div>
                {/* Funding bonus */}
                {b.fundingRate != null && Math.abs(b.fundingRate) >= 0.01 && (
                  <p className="text-xs text-gray-500 mt-2 ml-1">
                    {b.direction === 'contango' && b.fundingRate > 0
                      ? `+ Funding bonus: earn ${b.fundingRate.toFixed(4)}%/8h as short (${(b.fundingRate * 3 * 365).toFixed(1)}% APY) on top of basis`
                      : b.direction === 'contango' && b.fundingRate < 0
                      ? `⚠ Negative funding: pay ${Math.abs(b.fundingRate).toFixed(4)}%/8h as short — reduces net return`
                      : `Funding: ${b.fundingRate > 0 ? '+' : ''}${b.fundingRate.toFixed(4)}%/8h`}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── DEX Prices ────────────────────────────── */}
      {dexSources.length > 0 && (
        <section>
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-xl font-bold">DEX Prices</h2>
            <span className="text-xs px-2 py-0.5 rounded-full border border-gray-700 text-gray-500">
              {dexSources.map(s => DEX_LABEL[s] ?? s).join(' · ')}
            </span>
          </div>
          <div className="rounded-xl border border-gray-800 overflow-x-auto mb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/60">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Coin</th>
                  {dexSources.map(s => <th key={s} className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">{DEX_LABEL[s]??s}</th>)}
                  <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Binance</th>
                  <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Max Spread</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {coins.filter(coin => dexSources.some(s => dex[s]?.[coin]?.price)).map(coin => {
                  const binRef = exchanges.binance?.[coin]?.price;
                  const dexPrices = dexSources.map(s => dex[s]?.[coin]?.price ?? null);
                  const validDex = dexPrices.filter((p): p is number => p != null && p > 0);
                  const maxSpread = binRef && validDex.length
                    ? Math.max(...validDex.map(p => Math.abs((p - binRef) / binRef * 100)))
                    : null;
                  return (
                    <tr key={coin} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-3 font-bold text-gray-100">{COIN_META[coin]?.emoji} {coin}</td>
                      {dexSources.map((s, i) => {
                        const p = dexPrices[i];
                        const spread = p && binRef ? ((p - binRef) / binRef * 100) : null;
                        return (
                          <td key={s} className="px-3 py-3 text-right tabular-nums">
                            {p ? (
                              <div>
                                <span className="text-gray-300">{fmtPrice(p)}</span>
                                {spread != null && Math.abs(spread) >= 0.1 && (
                                  <span className={`ml-1 text-xs ${spread > 0 ? 'text-green-500' : 'text-red-500'}`}>
                                    {spread > 0 ? '+' : ''}{spread.toFixed(2)}%
                                  </span>
                                )}
                              </div>
                            ) : <span className="text-gray-700">—</span>}
                          </td>
                        );
                      })}
                      <td className="px-3 py-3 text-right tabular-nums text-gray-400">{binRef ? fmtPrice(binRef) : '—'}</td>
                      <td className={`px-3 py-3 text-right text-xs font-bold tabular-nums ${maxSpread != null && maxSpread >= 0.5 ? 'text-orange-400' : 'text-gray-600'}`}>
                        {maxSpread != null ? `${maxSpread.toFixed(3)}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Crypto Prediction Markets ─────────────── */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-xl font-bold">Crypto Prediction Markets</h2>
          <span className="text-xs px-2 py-0.5 rounded-full border border-gray-700 text-gray-500">
            {cryptoMarkets.length} markets · Polymarket + Kalshi
          </span>
        </div>
        {cryptoMarkets.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-8 text-center">
            <p className="text-gray-500">No crypto markets found on Polymarket or Kalshi right now.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/60">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Market</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Platform</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Asset</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Spot Price</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Mkt Prob</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {cryptoMarkets.map(m => {
                  const binPrice = m.coin ? exchanges.binance?.[m.coin] : null;
                  const platCfg  = m.platform === 'polymarket' ? PLATFORMS.polymarket : PLATFORMS.kalshi;
                  return (
                    <tr key={m.id} className={`hover:bg-white/[0.02] transition-colors ${m.infoLag ? 'bg-orange-950/10' : ''}`}>
                      <td className="px-4 py-3 text-gray-200 max-w-xs">
                        <a href={m.url} target="_blank" rel="noopener noreferrer" className="line-clamp-1 hover:text-white transition-colors hover:underline">{m.question}</a>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border ${platCfg.badgeClass}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${platCfg.dotClass}`} />
                          {platCfg.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{m.coin ? (COIN_META[m.coin]?.label ?? m.coin) : '—'}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {binPrice?.price
                          ? <span className={(binPrice.change24hPct ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}>{fmtPrice(binPrice.price)}</span>
                          : <span className="text-gray-600">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`font-bold tabular-nums ${m.probability >= 70 ? 'text-green-400' : m.probability >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>{m.probability}%</span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {m.infoLag
                          ? <span className="text-xs font-bold px-1.5 py-0.5 rounded border border-orange-600 bg-orange-900/50 text-orange-300">INFO LAG</span>
                          : <span className="text-xs text-gray-600">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Sports Tab ────────────────────────────────────

const SPORT_BADGE: Record<string, string> = {
  'soccer_italy_serie_a':      'border-green-700 bg-green-900/40 text-green-300',
  'soccer_uefa_champs_league': 'border-yellow-700 bg-yellow-900/40 text-yellow-300',
  'basketball_nba':            'border-orange-700 bg-orange-900/40 text-orange-300',
  'americanfootball_nfl':      'border-blue-700 bg-blue-900/40 text-blue-300',
  'tennis_atp_french_open':    'border-rose-700 bg-rose-900/40 text-rose-300',
};

function fmtOdds(o: number): string {
  return o.toFixed(2);
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function SportsTab({ data }: { data: SportsResponse | null }) {
  const [sportFilter, setSportFilter] = useState<string>('all');
  const [arbOnly,     setArbOnly]     = useState(false);

  if (!data || data.dataAge > 3_600_000) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
        <div className="text-5xl mb-4">🏟️</div>
        <p className="text-gray-300 font-semibold text-lg">Loading sports odds…</p>
        <p className="text-gray-600 text-sm mt-2">agent12-sports fetches The Odds API every 5 minutes.</p>
      </div>
    );
  }

  const { sportsMeta, markets, arbOpportunities, totalEvents, totalArb, dataAge } = data;
  const dataStale = dataAge > 600_000;

  const filtered = markets.filter(m => {
    if (sportFilter !== 'all' && m.sport !== sportFilter) return false;
    if (arbOnly && !m.arbOpportunity) return false;
    return true;
  });

  return (
    <div className="space-y-6">

      {/* Arb alert banner */}
      {arbOpportunities.length > 0 && (
        <div className="rounded-xl border border-green-700 bg-green-950/30 p-4 flex gap-3 items-start">
          <span className="text-2xl flex-shrink-0">🎯</span>
          <div className="flex-1">
            <p className="font-semibold text-green-300 mb-2">
              Bookmaker Arbitrage — {totalArb} opportunit{totalArb > 1 ? 'ies' : 'y'} found
            </p>
            <div className="space-y-2">
              {arbOpportunities.slice(0, 5).map(m => (
                <div key={m.id} className="text-xs font-mono px-3 py-2 rounded border border-green-700 bg-green-900/30 text-green-200 flex flex-wrap items-center gap-2">
                  <span>{m.sportEmoji}</span>
                  <span className="font-bold text-white">{m.homeTeam} vs {m.awayTeam}</span>
                  <span className="text-gray-400">|</span>
                  {m.arbBets.map(b => (
                    <span key={b.outcome}>
                      <span className="text-yellow-300">{b.outcome}</span>
                      <span className="text-gray-400"> @ </span>
                      <span className="text-white font-bold">{fmtOdds(b.odds)}</span>
                      <span className="text-gray-400"> ({b.bookmaker}, stake ${b.stake.toFixed(0)})</span>
                    </span>
                  ))}
                  <span className="text-gray-400">|</span>
                  <span className="text-green-400 font-bold">+{m.arbPct.toFixed(2)}% profit</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Stats + filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-3">
          <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-2 text-center">
            <div className="text-xl font-bold tabular-nums">{totalEvents}</div>
            <div className="text-xs text-gray-500">Events</div>
          </div>
          <div className={`rounded-lg border px-4 py-2 text-center ${totalArb > 0 ? 'border-green-800 bg-green-950/30' : 'border-gray-800 bg-gray-900/40'}`}>
            <div className={`text-xl font-bold tabular-nums ${totalArb > 0 ? 'text-green-400' : ''}`}>{totalArb}</div>
            <div className="text-xs text-gray-500">Arb Opps</div>
          </div>
          <div className={`rounded-lg border px-4 py-2 text-center ${dataStale ? 'border-red-800 bg-red-950/30' : 'border-gray-800 bg-gray-900/40'}`}>
            <div className={`text-sm font-semibold ${dataStale ? 'text-red-400' : 'text-gray-400'}`}>{Math.round(dataAge / 60000)}m ago</div>
            <div className="text-xs text-gray-500">Data age</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 ml-auto">
          <button onClick={() => setArbOnly(v => !v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
              arbOnly ? 'border-green-600 bg-green-900/50 text-green-300' : 'border-gray-700 text-gray-500 hover:text-gray-300'
            }`}>
            🎯 Arb only
          </button>
          {[{ key: 'all', label: 'All Sports' }, ...(sportsMeta ?? []).map(s => ({ key: s.key, label: `${s.emoji} ${s.label}` }))].map(f => (
            <button key={f.key} onClick={() => setSportFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                sportFilter === f.key ? 'border-blue-600 bg-blue-900/50 text-blue-300' : 'border-gray-700 text-gray-500 hover:text-gray-300'
              }`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Events table */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
          <div className="text-5xl mb-4">🔎</div>
          <p className="text-gray-300 font-semibold">No events match your filter.</p>
          {arbOnly && totalEvents > 0 && <p className="text-gray-500 text-sm mt-2">No bookmaker arbitrage detected right now.</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(m => (
            <div key={m.id} className={`rounded-xl border p-4 ${m.arbOpportunity ? 'border-green-800 bg-green-950/10' : 'border-gray-800 bg-gray-900/20'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xl">{m.sportEmoji}</span>
                    <span className="font-bold text-white text-base">{m.homeTeam} vs {m.awayTeam}</span>
                    {m.arbOpportunity && (
                      <span className="text-xs font-bold px-2 py-0.5 rounded-full border border-green-600 bg-green-900/50 text-green-300">
                        ARB +{m.arbPct.toFixed(2)}%
                      </span>
                    )}
                    <span className={`text-xs px-1.5 py-0.5 rounded border ${SPORT_BADGE[m.sport] ?? 'border-gray-700 bg-gray-800 text-gray-400'}`}>
                      {m.sportLabel}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{fmtTime(m.commenceTime)} · {m.bookmakers.length} bookmakers</p>
                </div>
                <div className="text-right text-xs text-gray-500">
                  implied: {(m.impliedSum * 100).toFixed(1)}%
                  {m.impliedSum < 1 && <span className="text-green-400 font-bold ml-1">(under 100% ✓)</span>}
                </div>
              </div>
              {/* Best odds per outcome */}
              <div className="flex flex-wrap gap-2">
                {m.bestOdds.map(o => {
                  const arbBet = m.arbBets.find(b => b.outcome === o.name);
                  return (
                    <div key={o.name} className={`rounded-lg border px-3 py-2 text-xs ${arbBet ? 'border-green-700 bg-green-900/20' : 'border-gray-700 bg-gray-800/40'}`}>
                      <div className="text-gray-400 mb-0.5">{o.name}</div>
                      <div className="font-bold text-white tabular-nums text-sm">{fmtOdds(o.price)}</div>
                      <div className="text-gray-500">{o.bookmaker}</div>
                      {arbBet && <div className="text-green-400 mt-0.5">Stake: ${arbBet.stake.toFixed(0)}</div>}
                    </div>
                  );
                })}
              </div>
              {/* Arb breakdown */}
              {m.arbOpportunity && m.arbBets.length > 0 && (
                <div className="mt-3 rounded-lg border border-green-800 bg-green-950/20 px-3 py-2 text-xs font-mono text-green-200">
                  <span className="font-bold text-green-400 mr-2">ARB TRADE ($100 bankroll):</span>
                  {m.arbBets.map((b, i) => (
                    <span key={b.outcome}>
                      {i > 0 && <span className="text-gray-500 mx-1">|</span>}
                      <span className="text-yellow-300">{b.outcome}</span>
                      <span className="text-gray-400"> @ </span>
                      <span className="text-white">{fmtOdds(b.odds)}</span>
                      <span className="text-gray-400"> on </span>
                      <span className="text-blue-300">{b.bookmaker}</span>
                      <span className="text-gray-400">: $</span>
                      <span className="text-white">{b.stake.toFixed(2)}</span>
                    </span>
                  ))}
                  <span className="text-gray-400 mx-2">→</span>
                  <span className="text-green-400 font-bold">profit: ${m.arbPct.toFixed(2)}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Weather Tab ───────────────────────────────────

function WeatherTab({ data }: { data: WeatherResponse | null }) {
  if (!data || data.dataAge > 3_600_000) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
        <div className="text-5xl mb-4">🌤️</div>
        <p className="text-gray-300 font-semibold text-lg">Loading weather markets…</p>
        <p className="text-gray-600 text-sm mt-2">agent13-weather fetches Kalshi weather markets + Open-Meteo forecasts every 10 minutes.</p>
      </div>
    );
  }

  const { markets, forecasts, totalMarkets, dataAge } = data;
  const dataStale = dataAge > 1_200_000;

  return (
    <div className="space-y-8">

      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-4 py-2 text-center">
          <div className="text-xl font-bold tabular-nums">{totalMarkets}</div>
          <div className="text-xs text-gray-500">Weather Markets</div>
        </div>
        <div className={`rounded-lg border px-4 py-2 text-center ${dataStale ? 'border-red-800 bg-red-950/30' : 'border-gray-800 bg-gray-900/40'}`}>
          <div className={`text-sm font-semibold ${dataStale ? 'text-red-400' : 'text-gray-400'}`}>{Math.round(dataAge / 60000)}m ago</div>
          <div className="text-xs text-gray-500">Data age</div>
        </div>
        <span className="text-xs text-gray-600 ml-2">Source: Kalshi · Open-Meteo</span>
      </div>

      {/* 7-day forecasts */}
      {forecasts.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4">7-Day Forecasts — Key Cities</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {forecasts.map(city => (
              <div key={city.city} className="rounded-xl border border-gray-800 bg-gray-900/20 p-4">
                <h3 className="font-bold text-white mb-3">{city.city}</h3>
                <div className="space-y-1.5">
                  {city.days.slice(0, 5).map(day => (
                    <div key={day.date} className="flex items-center gap-2 text-xs">
                      <span className="text-gray-500 w-16 flex-shrink-0">
                        {new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                      </span>
                      {day.maxTempF != null && (
                        <span className={`font-bold tabular-nums ${day.maxTempF >= 90 ? 'text-red-400' : day.maxTempF >= 70 ? 'text-yellow-400' : day.maxTempF >= 50 ? 'text-blue-300' : 'text-blue-500'}`}>
                          {Math.round(day.maxTempF)}°F
                        </span>
                      )}
                      {day.minTempF != null && <span className="text-gray-600">/{Math.round(day.minTempF)}°F</span>}
                      {day.precipProbPct != null && day.precipProbPct > 20 && (
                        <span className="text-blue-400">💧{day.precipProbPct}%</span>
                      )}
                      {day.precipIn != null && day.precipIn > 0.1 && (
                        <span className="text-blue-300">{day.precipIn.toFixed(2)}&quot;</span>
                      )}
                      {day.maxWindMph != null && day.maxWindMph > 25 && (
                        <span className="text-gray-400">💨{Math.round(day.maxWindMph)}mph</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Kalshi weather markets */}
      <section>
        <h2 className="text-xl font-bold mb-4">Kalshi Weather Prediction Markets</h2>
        {markets.length === 0 ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-8 text-center">
            <p className="text-gray-500">No active weather markets found on Kalshi right now.</p>
            <p className="text-gray-600 text-sm mt-2">Weather markets appear during extreme weather events and seasonal forecasts.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 bg-gray-900/60">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Market</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Category</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">YES%</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Volume</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {markets.map(m => (
                  <tr key={m.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3 text-gray-200 max-w-xs">
                      <a href={m.url} target="_blank" rel="noopener noreferrer"
                        className="line-clamp-2 hover:text-white transition-colors hover:underline leading-snug">
                        {m.title}
                      </a>
                      {m.subtitle && <p className="text-xs text-gray-600 mt-0.5 line-clamp-1">{m.subtitle}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-1.5 py-0.5 rounded border border-sky-700 bg-sky-900/40 text-sky-300 capitalize">
                        {m.category}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {m.probability != null ? (
                        <span className={`font-bold tabular-nums ${m.probability >= 70 ? 'text-green-400' : m.probability >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>
                          {m.probability}%
                        </span>
                      ) : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-400">
                      {m.volume != null ? `$${m.volume.toLocaleString()}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-gray-500">
                      {m.expiresAt ? new Date(m.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

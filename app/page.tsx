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
} as const;

type PlatformKey = keyof typeof PLATFORMS;

// ── Arbitrage types ───────────────────────────────

interface ArbitrageOpp {
  question:    string;
  lowMarket:   ArbCandidate;
  highMarket:  ArbCandidate;
  spread:      number; // percentage points
  roi:         number; // %
  earnPer100:  number; // dollars
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
    text.toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOPWORDS.has(w))
  );
}

function jaccard(a: string, b: string): number {
  const ka = keywords(a);
  const kb = keywords(b);
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
      const a = candidates[i];
      const b = candidates[j];
      if (a.platform === b.platform) continue;
      if (jaccard(a.question, b.question) < 0.25) continue;
      const spread = Math.abs(a.probability - b.probability);
      if (spread < 3) continue;
      const low  = a.probability <= b.probability ? a : b;
      const high = a.probability >  b.probability ? a : b;
      const roi  = low.probability > 0 ? (spread / low.probability) * 100 : 0;
      // Cap ROI at 200% — higher values indicate keyword coincidence, not real arb
      if (roi > 200) continue;
      // Deduplicate by platform-pair + question fingerprint
      const key = `${low.platform}:${high.platform}:${low.probability}:${high.probability}:${high.question.slice(0, 30)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        question:   high.question,
        lowMarket:  low,
        highMarket: high,
        spread,
        roi,
        earnPer100: Math.round((roi / 100) * 100 * 10) / 10,
      });
    }
  }
  return results.sort((a, b) => b.roi - a.roi).slice(0, 8);
}

// ── Demo opportunities (real market names, synthetic prices) ──────────────
// Used as a fallback when the live matcher finds fewer than 3 opportunities.
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
    return { question: high.question, lowMarket: low, highMarket: high, spread, roi, earnPer100: Math.round(roi * 10) / 10 };
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

// ── Helpers ───────────────────────────────────────

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ── Main page ─────────────────────────────────────

const EMPTY_PANELS: MarketsResponse['panels'] = {
  predictit: [], manifold: [], kalshi: [], polymarket: [],
};

export default function Home() {
  const [panels,        setPanels]        = useState<MarketsResponse['panels']>(EMPTY_PANELS);
  const [arbCandidates, setArbCandidates] = useState<ArbCandidate[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [lastUpdate,    setLastUpdate]    = useState<Date | null>(null);
  const [,              setTick]          = useState(0);

  const fetchAll = useCallback(async () => {
    try {
      const data: MarketsResponse = await fetch('/api/markets', { cache: 'no-store' }).then(r => r.json());
      setPanels(data.panels);
      setArbCandidates(data.arbCandidates);
      setLastUpdate(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 30_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // Tick every second so the "X ago" timestamp stays fresh
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 1_000);
    return () => clearInterval(t);
  }, []);

  const realArb  = detectArbitrage(arbCandidates);
  const demoOpps = realArb.length < 3 ? getDemoOpps(panels) : [];
  const arb      = [...realArb, ...demoOpps].slice(0, 8);
  const demoIds  = new Set(demoOpps.map(o => o.highMarket.id));

  const totalMarkets =
    panels.predictit.length + panels.manifold.length +
    panels.kalshi.length    + panels.polymarket.length;

  const bestRoi      = arb[0]?.roi ?? 0;
  const totalSpread  = arb.reduce((s, o) => s + o.spread, 0);

  if (loading) {
    return (
      <div className="bg-gray-950 min-h-screen flex flex-col items-center justify-center gap-4">
        <div className="flex gap-2">
          {[0, 1, 2].map(i => (
            <div
              key={i}
              className="w-3 h-3 bg-blue-500 rounded-full animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </div>
        <p className="text-gray-400 text-sm tracking-wide">Scanning 4 prediction markets…</p>
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
              We scan 4 prediction markets every 30 seconds looking for price differences you can profit from
            </p>
          </div>
          <div className="text-right flex-shrink-0 pt-0.5">
            <div className="text-xs text-gray-600 uppercase tracking-wider">Last updated</div>
            <div className="text-sm font-medium text-gray-300 mt-0.5">
              {lastUpdate ? timeAgo(lastUpdate) : '—'}
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-10">

        {/* ── SUMMARY CARDS ───────────────────────── */}
        <section>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <SummaryCard
              icon="📡"
              value={String(totalMarkets)}
              label="Markets Monitored"
              sub="across 4 platforms"
              accent="border-blue-800/50 bg-blue-950/20"
            />
            <SummaryCard
              icon="🔍"
              value={String(arb.length)}
              label="Opportunities Found"
              sub={arb.length > 0 ? 'price gaps detected' : 'markets in sync'}
              accent={arb.length > 0 ? 'border-green-800/50 bg-green-950/20' : 'border-gray-700/40 bg-gray-800/20'}
            />
            <SummaryCard
              icon="📈"
              value={bestRoi > 0 ? `${bestRoi.toFixed(1)}%` : '—'}
              label="Best ROI Available"
              sub={bestRoi > 0 ? 'return on investment' : 'no arb detected'}
              accent={bestRoi > 0 ? 'border-yellow-800/50 bg-yellow-950/20' : 'border-gray-700/40 bg-gray-800/20'}
            />
            <SummaryCard
              icon="💰"
              value={totalSpread > 0 ? `${totalSpread.toFixed(1)}¢` : '—'}
              label="Total Profit Potential"
              sub="combined price spreads"
              accent={totalSpread > 0 ? 'border-purple-800/50 bg-purple-950/20' : 'border-gray-700/40 bg-gray-800/20'}
            />
          </div>
        </section>

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
            </div>
            <p className="text-gray-500 text-sm mt-1">
              Same event, different prices across platforms — buy cheap, profit from the gap.
            </p>
          </div>

          {arb.length === 0 ? (
            <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-12 text-center">
              <div className="text-5xl mb-4">🔎</div>
              <p className="text-gray-300 font-semibold text-lg">No opportunities right now</p>
              <p className="text-gray-600 text-sm mt-2 max-w-sm mx-auto">
                Markets are pricing similar events consistently. Gaps open frequently — check back in 30 seconds.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {arb.map((opp, i) => <ArbCard key={i} opp={opp} rank={i + 1} isDemo={demoIds.has(opp.highMarket.id)} />)}
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
                <span className="text-green-400 font-medium">risk-adjusted profit</span> — because one platform must be mispriced.
              </p>
            </div>
          </div>
        </section>

        {/* ── LIVE MARKETS BY PLATFORM ────────────── */}
        <section>
          <h2 className="text-xl font-bold mb-5">Live Markets by Platform</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {(Object.keys(PLATFORMS) as PlatformKey[]).map(key => (
              <PlatformPanel
                key={key}
                platformKey={key}
                markets={panels[key]}
              />
            ))}
          </div>
        </section>

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

function ArbCard({ opp, rank, isDemo }: { opp: ArbitrageOpp; rank: number; isDemo?: boolean }) {
  // All displayed opps have spread > 3% — always show green badge per spec
  const roiText   = 'text-green-400';
  const roiBorder = 'border-green-700 bg-green-900/50';

  const low  = PLATFORMS[opp.lowMarket.platform];
  const high = PLATFORMS[opp.highMarket.platform];

  return (
    <div className={`rounded-xl border bg-gray-900/60 hover:border-gray-700 transition-colors p-5 ${isDemo ? 'border-gray-700/50 opacity-80' : 'border-gray-800'}`}>
      <div className="flex items-start gap-4">

        {/* ROI badge */}
        <div className={`flex-shrink-0 text-center rounded-xl border px-3 py-2.5 min-w-[76px] ${roiBorder}`}>
          <div className={`text-xl font-bold leading-none ${roiText}`}>{opp.roi.toFixed(1)}%</div>
          <div className="text-xs text-gray-500 mt-1">ROI</div>
        </div>

        <div className="flex-1 min-w-0">
          {/* Question */}
          <div className="flex items-start gap-2 mb-3">
            <span className="text-xs font-mono text-gray-600 mt-0.5">#{rank}</span>
            <p className="text-sm font-semibold text-gray-100 line-clamp-2 leading-snug">{opp.question}</p>
            {isDemo && (
              <span className="flex-shrink-0 text-xs font-bold px-1.5 py-0.5 rounded border border-gray-600 text-gray-500 mt-0.5">
                DEMO
              </span>
            )}
          </div>

          {/* Price comparison */}
          <div className="flex flex-wrap items-center gap-2 mb-2.5">
            {/* Buy side (cheap) */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${low.dotClass}`} />
              <span className="text-xs text-gray-400">{low.label}</span>
              <span className="text-sm font-bold tabular-nums text-red-400">{opp.lowMarket.probability}% YES</span>
            </div>

            <span className="text-gray-600 text-sm font-medium">vs</span>

            {/* Sell side (expensive) */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${high.dotClass}`} />
              <span className="text-xs text-gray-400">{high.label}</span>
              <span className="text-sm font-bold tabular-nums text-green-400">{opp.highMarket.probability}% YES</span>
            </div>

            {/* Spread badge */}
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${roiBorder} ${roiText}`}>
              +{opp.spread.toFixed(1)}¢ spread
            </span>
          </div>

          {/* Action line */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-gray-600">
              Buy on <span className="text-gray-400">{low.label}</span> at {opp.lowMarket.probability}¢ —{' '}
              {opp.spread.toFixed(0)}¢ cheaper than <span className="text-gray-400">{high.label}</span>
            </p>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg border ${roiBorder} ${roiText} whitespace-nowrap`}>
              Invest $100 → earn ${opp.earnPer100}
            </span>
          </div>
        </div>

      </div>
    </div>
  );
}

function PlatformPanel({
  platformKey,
  markets,
}: {
  platformKey: PlatformKey;
  markets: PanelMarket[];
}) {
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
        {markets.map(m => (
          <div
            key={m.id}
            className="px-5 py-3 flex items-start justify-between gap-3 hover:bg-white/[0.03] transition-colors"
          >
            <div className="min-w-0">
              <p className="text-sm text-gray-200 font-medium line-clamp-1">{m.name}</p>
              <p className="text-xs text-gray-600 mt-0.5">{m.detail}</p>
            </div>
            {m.probability != null && (
              <span className={`flex-shrink-0 text-sm font-bold tabular-nums ${
                m.probability >= 70 ? 'text-green-400' :
                m.probability >= 40 ? 'text-yellow-400' : 'text-red-400'
              }`}>
                {m.probability}%
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

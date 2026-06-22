'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

// ── Types ─────────────────────────────────────────────────────────────────────

type VolRisk = 'LOW' | 'MEDIUM' | 'HIGH';
type Capital = 500 | 5000 | 50000;

interface LevelData {
  capital:         number;
  share:           number;
  grossRewardDay:  number;
  dayYieldPct:     number;
  thinBookFlag:    boolean;
  belowFloorFlag:  boolean;
  flags:           string[];
}

interface Market {
  question:          string;
  conditionId:       string;
  rewardsDailyRate:  number;
  rewardsMaxSpread:  number;
  rewardsMinSize:    number;
  existing_depth_usd: number;
  volatilityRisk:    VolRisk;
  volatilityStdev:   number | null;
  endDate:           string | null;
  negRisk:           boolean;
  mid:               number;
  bookSpread:        number | null;
  sane500:           boolean;
  levels:            Record<string, LevelData>;
}

interface Meta {
  generatedAt:        string;
  totalMarkets:       number;
  saneAt500:          number;
  flaggedAt500:       number;
  capitalLevels:      number[];
  disclaimer:         string;
}

interface ApiResponse {
  meta:    Meta | null;
  markets: Market[];
  stale:   boolean;
  error?:  string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CAPITAL_OPTIONS: Capital[] = [500, 5000, 50000];
const CAPITAL_LABELS: Record<Capital, string> = { 500: '$500', 5000: '$5k', 50000: '$50k' };
const POLL_MS = 5 * 60_000;

const VOL_ORDER: Record<VolRisk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

const VOL_CLS: Record<VolRisk, string> = {
  LOW:    'text-emerald-400 border-emerald-700/40 bg-emerald-950/20',
  MEDIUM: 'text-amber-400   border-amber-600/40   bg-amber-950/20',
  HIGH:   'text-red-400     border-red-700/40     bg-red-950/20',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function ago(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function fmtDepth(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n}`;
}

function fmtReward(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 10)   return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

function daysLeft(endDate: string | null): number | null {
  if (!endDate) return null;
  return (new Date(endDate).getTime() - Date.now()) / 86_400_000;
}

// ── Sort markets by selected capital level ────────────────────────────────────
function sortMarkets(markets: Market[], capital: Capital): Market[] {
  const key = String(capital);
  return [...markets].sort((a, b) => {
    const la = a.levels[key];
    const lb = b.levels[key];
    if (!la || !lb) return 0;

    const aFlagged = la.flags.length > 0 ? 1 : 0;
    const bFlagged = lb.flags.length > 0 ? 1 : 0;
    if (aFlagged !== bFlagged) return aFlagged - bFlagged;

    const vA = VOL_ORDER[a.volatilityRisk] ?? 2;
    const vB = VOL_ORDER[b.volatilityRisk] ?? 2;
    if (vA !== vB) return vA - vB;

    return lb.grossRewardDay - la.grossRewardDay;
  });
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function FlagBadge({ text }: { text: string }) {
  const isThin  = text.includes('THIN BOOK');
  const isFloor = text.includes('payout floor');
  const cls = isThin
    ? 'border-orange-600/50 bg-orange-950/30 text-orange-400'
    : isFloor
      ? 'border-zinc-600/50 bg-zinc-900/50 text-zinc-500'
      : 'border-yellow-600/50 bg-yellow-950/30 text-yellow-400';
  return (
    <span className={`inline-block px-1.5 py-px border text-[9px] font-mono uppercase tracking-wide ${cls}`}>
      {isThin ? 'THIN BOOK' : isFloor ? 'BELOW FLOOR' : text.split('—')[0].trim()}
    </span>
  );
}

function MarketCard({
  market,
  capital,
  rank,
}: {
  market:  Market;
  capital: Capital;
  rank:    number;
}) {
  const lv     = market.levels[String(capital)];
  if (!lv) return null;

  const volCls   = VOL_CLS[market.volatilityRisk] ?? VOL_CLS.HIGH;
  const isFlagged = lv.flags.length > 0;
  const days      = daysLeft(market.endDate);
  const shareStr  = `${(lv.share * 100).toFixed(2)}%`;

  return (
    <Link
      href={`/dashboard/liquidity-rewards/${encodeURIComponent(market.conditionId)}`}
      className={`border-t py-3 grid grid-cols-12 gap-2 items-start text-xs font-mono
        hover:bg-zinc-800/30 transition-colors cursor-pointer
        ${isFlagged ? 'border-zinc-800/60 opacity-75' : 'border-zinc-800'}`}
    >

      {/* Rank */}
      <div className="col-span-1 text-zinc-600 pt-0.5 tabular-nums">#{rank}</div>

      {/* Question + badges */}
      <div className="col-span-5 min-w-0">
        <p className={`leading-snug line-clamp-2 ${isFlagged ? 'text-zinc-500' : 'text-zinc-200'}`}>
          {market.question}
        </p>
        <div className="flex flex-wrap gap-1 mt-1.5">
          <span className={`px-1 py-px border text-[9px] uppercase ${volCls}`}>
            {market.volatilityRisk} risk
          </span>
          {market.negRisk && (
            <span className="px-1 py-px border border-zinc-700 bg-zinc-800 text-zinc-600 text-[9px] uppercase">
              negRisk
            </span>
          )}
          <span className="px-1 py-px border border-zinc-700 bg-zinc-800 text-zinc-600 text-[9px] uppercase">
            mid {market.mid.toFixed(3)}
          </span>
          <span className="px-1 py-px border border-zinc-700 bg-zinc-800 text-zinc-600 text-[9px] uppercase">
            ±{market.rewardsMaxSpread}¢ band
          </span>
          {days !== null && days > 0 && days < 30 && (
            <span className={`px-1 py-px border text-[9px] uppercase ${days < 7 ? 'border-red-700/40 text-red-500' : 'border-zinc-700 bg-zinc-800 text-zinc-600'}`}>
              {Math.floor(days)}d left
            </span>
          )}
          {lv.flags.map((f, i) => <FlagBadge key={i} text={f} />)}
        </div>
      </div>

      {/* Pool + depth */}
      <div className="col-span-2 space-y-0.5">
        <div className="text-zinc-200 tabular-nums">${market.rewardsDailyRate.toFixed(0)}</div>
        <div className="text-zinc-600 text-[10px]">pool/day (real)</div>
        <div className="text-zinc-500 tabular-nums">{fmtDepth(market.existing_depth_usd)}</div>
        <div className="text-zinc-600 text-[10px]">existing depth</div>
      </div>

      {/* Share estimate */}
      <div className="col-span-2 space-y-0.5">
        <div className="text-zinc-300 tabular-nums">{shareStr}</div>
        <div className="text-zinc-600 text-[10px]">est. share</div>
        <div className="text-zinc-600 text-[10px]">min {market.rewardsMinSize} size</div>
      </div>

      {/* Gross reward — primary number */}
      <div className="col-span-2 space-y-0.5">
        <div className={`tabular-nums font-semibold ${isFlagged ? 'text-zinc-500' : 'text-emerald-400'}`}>
          {fmtReward(lv.grossRewardDay)}
        </div>
        <div className="text-zinc-600 text-[10px]">est. gross/day</div>
        <div className="text-zinc-500 tabular-nums text-[10px]">{lv.dayYieldPct.toFixed(2)}%/day yield</div>
        <div className="text-zinc-700 text-[9px]">adverse risk not sub.</div>
      </div>
    </Link>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function LiquidityRewardsPage() {
  const [data,       setData]       = useState<ApiResponse | null>(null);
  const [capital,    setCapital]    = useState<Capital>(500);
  const [howToOpen,  setHowToOpen]  = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastFetch,  setLastFetch]  = useState<Date | null>(null);

  async function poll() {
    try {
      const res = await fetch('/api/liquidity-rewards', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as ApiResponse;
      setData(json);
      setFetchError(null);
      setLastFetch(new Date());
    } catch (e: any) {
      setFetchError(e.message ?? 'fetch error');
    }
  }

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const markets = data?.markets ?? [];
  const meta    = data?.meta;
  const isStale = data?.stale ?? true;

  const sorted    = sortMarkets(markets, capital);
  const levelKey  = String(capital);
  const saneCount = sorted.filter(m => m.levels[levelKey]?.flags.length === 0).length;

  const totalPool = markets.reduce((s, m) => s + m.rewardsDailyRate, 0);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-7">

        {/* Context chip */}
        <p className="font-mono text-[11px] text-zinc-600 uppercase tracking-widest">
          Polymarket CLOB · Read-only · Linear first-order estimate · No orders placed
        </p>

        {/* Header */}
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="font-mono text-xl font-bold text-zinc-100 tracking-tight">
            LIQUIDITY REWARDS
          </h1>
          {meta && !isStale && (
            <span className="flex items-center gap-1.5 font-mono text-xs text-emerald-400 border border-emerald-600/40 bg-emerald-950/30 px-2 py-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LIVE
            </span>
          )}
          {isStale && (
            <span className="font-mono text-xs text-orange-400 border border-orange-500/40 px-2 py-0.5">STALE</span>
          )}
          <span className="font-mono text-[10px] text-zinc-600 ml-auto">
            {lastFetch ? `fetched ${ago(lastFetch.toISOString())}` : '—'}
            {meta ? ` · data ${ago(meta.generatedAt)}` : ''}
          </span>
        </div>

        {/* Subtitle */}
        <p className="font-mono text-sm text-zinc-400 leading-relaxed">
          Polymarket pays makers who rest limit orders near the mid — filled or not.{' '}
          <span className="text-zinc-300">Real pools, your measured share.</span>
        </p>

        {/* Stale warning */}
        {isStale && meta && (
          <div className="border border-orange-600/40 bg-orange-950/15 px-4 py-3 font-mono text-xs text-orange-400">
            Data is stale (last scan: {ago(meta.generatedAt)}). Agent may be restarting or scanning — check back shortly.
          </div>
        )}

        {fetchError && (
          <div className="font-mono text-xs text-red-400 border border-red-800 bg-red-950/20 px-3 py-2">
            {fetchError}
          </div>
        )}

        {/* Honest framing banner */}
        <div className="border border-zinc-700/50 bg-zinc-900/40">
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-left"
            onClick={() => setHowToOpen(v => !v)}
          >
            <span className="font-mono text-[10px] text-zinc-400 uppercase tracking-widest">
              How to read these numbers
            </span>
            <span className="font-mono text-[10px] text-zinc-600">{howToOpen ? '▲ close' : '▼ expand'}</span>
          </button>

          {howToOpen && (
            <div className="px-4 pb-4 space-y-2 border-t border-zinc-800">
              <ul className="mt-3 space-y-2">
                {[
                  ['Pool $/day (real)', 'The dollar amount Polymarket allocates to reward makers on this market per day. This is the actual program rate — not an estimate.'],
                  ['Existing depth', 'Dollar notional (price × size) of all qualifying resting orders currently in the CLOB within the reward band. This is your competition. It changes continuously.'],
                  ['Est. share', 'Your estimated fraction of the pool: C ÷ (C + existing depth). LINEAR first-order only — real scoring weights orders closer to mid quadratically and rewards two-sided depth.'],
                  ['Est. gross reward/day', 'share × pool $/day. GROSS — adverse-fill risk (being picked off when you\'re wrong) is not subtracted. That risk rises with volatility.'],
                  ['THIN BOOK flag', 'Gross yield >5%/day at this capital: the book is very thin and your share will compress as other makers arrive.'],
                  ['BELOW FLOOR flag', 'Gross reward <$1/day at this capital: Polymarket pays out in whole dollars; this position likely earns nothing.'],
                  ['Adverse risk class', 'LOW = slow-moving market, far from resolution. HIGH = near expiry or high recent volatility. HIGH-risk markets are likely to see informed flow picking off your orders.'],
                ].map(([term, def]) => (
                  <li key={term} className="font-mono text-[11px] text-zinc-500 leading-relaxed pl-3 border-l border-zinc-700/40">
                    <span className="text-zinc-400">{term}:</span> {def}
                  </li>
                ))}
              </ul>
              <p className="font-mono text-[10px] text-zinc-700 pt-2">
                No "profit", "guaranteed", or "signal" implied. These are estimates for educational and research purposes only.
              </p>
            </div>
          )}
        </div>

        {/* Capital selector */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest mr-1">Capital:</span>
          {CAPITAL_OPTIONS.map(c => (
            <button
              key={c}
              onClick={() => setCapital(c)}
              className={`font-mono text-xs px-3 py-1.5 border transition-colors duration-100
                ${capital === c
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
            >
              {CAPITAL_LABELS[c]}
            </button>
          ))}
          <span className="font-mono text-[10px] text-zinc-600 ml-2">
            per-side estimate — two-sided posting assumed
          </span>
        </div>

        {/* Summary bar */}
        {meta && markets.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
              <div className="font-mono text-lg font-bold text-zinc-200 tabular-nums">{meta.totalMarkets}</div>
              <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">markets scanned</div>
            </div>
            <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
              <div className="font-mono text-lg font-bold text-emerald-400 tabular-nums">{saneCount}</div>
              <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">
                clean at {CAPITAL_LABELS[capital]}
              </div>
            </div>
            <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
              <div className="font-mono text-lg font-bold text-zinc-300 tabular-nums">
                ${totalPool.toLocaleString()}
              </div>
              <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">total pool $/day</div>
            </div>
            <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
              <div className="font-mono text-[11px] font-bold text-zinc-500 tabular-nums pt-1">
                {meta.generatedAt ? ago(meta.generatedAt) : '—'}
              </div>
              <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">last scan</div>
            </div>
          </div>
        )}

        {/* Market table */}
        {sorted.length > 0 ? (
          <section className="space-y-1">
            <div className="flex items-center gap-3 flex-wrap mb-2">
              <span className="font-mono text-xs text-zinc-400 uppercase tracking-widest">
                Reward markets — LOW adverse-risk sane first, flagged last
              </span>
              <span className="font-mono text-[10px] text-zinc-600">
                {CAPITAL_LABELS[capital]} capital · depth snapshot every 15 min
              </span>
            </div>

            {/* Column headers */}
            <div className="grid grid-cols-12 gap-2 pb-1 border-b border-zinc-800 font-mono text-[10px] text-zinc-600 uppercase tracking-widest">
              <div className="col-span-1">#</div>
              <div className="col-span-5">Market / risk / flags</div>
              <div className="col-span-2">Pool + depth</div>
              <div className="col-span-2">Est. share</div>
              <div className="col-span-2">Est. gross/day</div>
            </div>

            {sorted.map((m, i) => (
              <MarketCard key={m.conditionId} market={m} capital={capital} rank={i + 1} />
            ))}
          </section>
        ) : (
          <div className="border border-zinc-800 bg-zinc-900 p-8 text-center space-y-2">
            <p className="font-mono text-sm text-zinc-400">
              {data === null
                ? 'Loading reward data…'
                : isStale
                  ? 'Agent is scanning — data will appear once the first cycle completes (~3 min).'
                  : 'No reward-eligible markets found in this scan.'}
            </p>
            <p className="font-mono text-xs text-zinc-600">
              First scan runs ~10 s after agent start. Refreshes every 15 min.
            </p>
          </div>
        )}

        {/* Disclaimer footer */}
        <div className="border-t border-zinc-800 pt-4 space-y-1">
          <p className="font-mono text-[10px] text-zinc-700 leading-relaxed">
            {meta?.disclaimer ?? 'Estimates only. Adverse-fill risk not subtracted. Not financial advice.'}
          </p>
          <p className="font-mono text-[10px] text-zinc-700">
            Read-only. No orders placed. No login required.
          </p>
        </div>

      </div>
    </div>
  );
}

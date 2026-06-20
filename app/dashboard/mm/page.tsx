'use client';

import { useEffect, useState } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

interface RewardMarket {
  cid:                   string;
  title:                 string;
  slug:                  string;
  negRisk:               boolean;
  mid:                   number;
  bid:                   number;
  ask:                   number;
  spread:                number;
  vol24:                 number;
  daysLeft:              number;
  rewardsMaxSpread:      number;
  rewardsMinSize:        number;
  takerFeeRate:          number;
  rebateRate:            number;
  sampleCapital:         number;
  lpRewardRateAvailable: boolean;
  makerRebatePerFill:    number;
  competingDepth:        number | null;
  adverseRiskLevel:      'LOW' | 'MED' | 'MED-HIGH' | 'HIGH';
  adverseRiskNote:       string;
}

interface Aggregate {
  totalMarkets:          number;
  marketsWithDepth:      number;
  lowRiskMarkets:        number;
  emptyBookMarkets:      number;
  lpRewardRatePublished: boolean;
  headlineNote:          string;
}

interface MMData {
  agentStatus:           'running' | 'stale' | 'offline';
  updatedAt:             string | null;
  sampleCapital:         number;
  note:                  string;
  lpRewardRatePublished: boolean;
  lpRewardRateNote:      string;
  markets:               RewardMarket[];
  aggregate:             Aggregate;
  disclaimer:            string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function fmtDepth(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtVol(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

const RISK_CLS: Record<string, string> = {
  'LOW':      'text-emerald-400 border-emerald-700/40 bg-emerald-950/20',
  'MED':      'text-amber-400   border-amber-600/40   bg-amber-950/20',
  'MED-HIGH': 'text-orange-400  border-orange-600/40  bg-orange-950/20',
  'HIGH':     'text-red-400     border-red-700/40     bg-red-950/20',
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: MMData['agentStatus'] }) {
  if (status === 'running') return (
    <span className="flex items-center gap-1.5 font-mono text-xs text-emerald-400 border border-emerald-600/40 bg-emerald-950/30 px-2 py-0.5">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      LIVE
    </span>
  );
  if (status === 'stale') return (
    <span className="font-mono text-xs text-orange-400 border border-orange-500/40 px-2 py-0.5">STALE</span>
  );
  return (
    <span className="font-mono text-xs text-red-400 border border-red-600/40 px-2 py-0.5">OFFLINE</span>
  );
}

function MarketRow({ m, rank }: { m: RewardMarket; rank: number }) {
  const riskCls    = RISK_CLS[m.adverseRiskLevel] ?? RISK_CLS['MED'];
  const isEmptyBook = m.competingDepth !== null && m.competingDepth < 100;

  return (
    <div className="border-t border-zinc-800 py-3 grid grid-cols-12 gap-2 items-start text-xs font-mono">
      {/* Rank */}
      <div className="col-span-1 text-zinc-600 pt-0.5">#{rank}</div>

      {/* Title + badges */}
      <div className="col-span-4 min-w-0">
        <p className="text-zinc-200 leading-snug line-clamp-2">{m.title}</p>
        <div className="flex flex-wrap gap-1 mt-1.5">
          {m.negRisk && (
            <span className="px-1 py-px border border-zinc-700 bg-zinc-800 text-zinc-500 text-[9px] uppercase">
              negRisk
            </span>
          )}
          <span className="px-1 py-px border border-zinc-700 bg-zinc-800 text-zinc-500 text-[9px] uppercase">
            mid {m.mid.toFixed(3)}
          </span>
          <span className="px-1 py-px border border-zinc-700 bg-zinc-800 text-zinc-500 text-[9px] uppercase">
            ±{m.rewardsMaxSpread}¢ band
          </span>
          {m.daysLeft > 0 && (
            <span className="px-1 py-px border border-zinc-700 bg-zinc-800 text-zinc-500 text-[9px] uppercase">
              {m.daysLeft.toFixed(0)}d left
            </span>
          )}
        </div>
      </div>

      {/* Competing depth */}
      <div className="col-span-2 space-y-0.5">
        <div className={isEmptyBook ? 'text-emerald-400 tabular-nums' : 'text-zinc-300 tabular-nums'}>
          {fmtDepth(m.competingDepth)}
        </div>
        <div className="text-zinc-600 text-[10px]">competing</div>
        {isEmptyBook && (
          <div className="text-emerald-600 text-[9px] uppercase">thin/empty</div>
        )}
      </div>

      {/* Vol 24h */}
      <div className="col-span-2 space-y-0.5">
        <div className="text-zinc-400 tabular-nums">{fmtVol(m.vol24)}</div>
        <div className="text-zinc-600 text-[10px]">vol 24h</div>
        <div className="text-zinc-600 text-[10px]">fee {(m.takerFeeRate * 100).toFixed(0)}%</div>
      </div>

      {/* Rebate per fill */}
      <div className="col-span-2 space-y-0.5">
        <div className="text-amber-400 tabular-nums font-semibold">
          ${m.makerRebatePerFill.toFixed(2)}
        </div>
        <div className="text-zinc-600 text-[10px]">rebate/fill</div>
        <div className="text-zinc-600 text-[10px]">fill-dependent</div>
      </div>

      {/* Risk */}
      <div className="col-span-1">
        <span className={`inline-block px-1 py-0.5 border text-[9px] uppercase tracking-wide ${riskCls}`}>
          {m.adverseRiskLevel}
        </span>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const POLL_MS = 60_000;

export default function LiquidityRewardsPage() {
  const [data,     setData]     = useState<MMData | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [lastPoll, setLastPoll] = useState<Date | null>(null);

  async function poll() {
    try {
      const res = await fetch('/api/mm', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setLastPoll(new Date());
      setError(null);
    } catch (e: any) {
      setError(e.message ?? 'fetch error');
    }
  }

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const status   = data?.agentStatus ?? 'offline';
  const markets  = data?.markets ?? [];
  const agg      = data?.aggregate;
  const capital  = data?.sampleCapital ?? 200;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">

        {/* Context line */}
        <p className="font-mono text-[11px] text-zinc-600 uppercase tracking-widest">
          Polymarket CLOB · Read-only · Eligibility scanner · No orders placed
        </p>

        {/* Header */}
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="font-mono text-xl font-bold text-zinc-100 tracking-tight">
            Liquidity Rewards
          </h1>
          <StatusBadge status={status} />
          <span className="font-mono text-[10px] text-zinc-600 ml-auto">
            {lastPoll ? `updated ${ago(lastPoll.toISOString())}` : '—'}
          </span>
        </div>

        {/* Honest-first banner — the key finding */}
        <div className="border border-amber-600/40 bg-amber-950/15 p-4 space-y-2">
          <p className="font-mono text-[10px] text-amber-500 uppercase tracking-widest">
            LP Reward rates not published in public API
          </p>
          <p className="font-mono text-sm text-zinc-300 leading-relaxed">
            Polymarket's LP Reward program pays daily to qualified liquidity providers,
            but the per-market daily rate is <span className="text-amber-400">not available in any public API</span>{' '}
            (<code className="text-zinc-400">rewards.rates</code> returns <code className="text-zinc-400">null</code> for all markets in the CLOB API).
            No yield estimate is possible from public data.
          </p>
          <p className="font-mono text-xs text-zinc-500 leading-relaxed">
            What IS known: each market's reward-band parameters, the competing book depth (your competition),
            and the maker rebate you'd earn per fill (a separate, fill-dependent fee-rebate program).
            Markets are sorted by competing depth — lowest first means you'd be closer to sole provider.
          </p>
        </div>

        {error && (
          <div className="font-mono text-xs text-red-400 border border-red-800 bg-red-950/20 px-3 py-2">
            {error}
          </div>
        )}

        {/* Summary bar — no yield, only verifiable counts */}
        {agg && agg.totalMarkets > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
              <div className="font-mono text-lg font-bold text-emerald-400 tabular-nums">
                {agg.totalMarkets}
              </div>
              <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">eligible markets</div>
            </div>
            <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
              <div className="font-mono text-lg font-bold text-emerald-400 tabular-nums">
                {agg.emptyBookMarkets ?? 0}
              </div>
              <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">thin/empty book</div>
            </div>
            <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
              <div className="font-mono text-lg font-bold text-zinc-300 tabular-nums">
                {agg.lowRiskMarkets}
              </div>
              <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">low adverse risk</div>
            </div>
            <div className="border border-zinc-800 bg-zinc-900 p-3 text-center">
              <div className="font-mono text-lg font-bold text-amber-400/60 tabular-nums">N/A</div>
              <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">LP yield — not available</div>
            </div>
          </div>
        )}

        {/* What the maker rebate per fill means */}
        <div className="border border-zinc-700/40 bg-zinc-900/40 p-4 space-y-2">
          <p className="font-mono text-[10px] text-zinc-400 uppercase tracking-widest">
            What "rebate/fill" means
          </p>
          <p className="font-mono text-xs text-zinc-500 leading-relaxed">
            When a taker crosses your resting order, Polymarket returns{' '}
            <span className="text-zinc-300">{(0.25 * 100).toFixed(0)}% of the taker fee</span> to you as
            the maker. For a ${capital} position: rebate = ${capital} × fee_rate × 0.25. This is the
            fee-rebate program — separate from, and much smaller than, the LP Rewards program.
            It is <span className="text-amber-400">fill-dependent</span>: you only earn it when a taker
            actually hits your order. How often that happens depends on your queue position, price
            level chosen, and market activity — none of which are estimable from book snapshots.
          </p>
        </div>

        {/* Market table */}
        {markets.length > 0 ? (
          <section className="space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-mono text-xs text-zinc-400 uppercase tracking-widest">
                Eligible markets — sorted by competing depth (lowest = least competition)
              </span>
              <span className="font-mono text-[10px] text-zinc-600">
                ${capital} sample · depth snapshot every 15 min
              </span>
            </div>

            {/* Column headers */}
            <div className="grid grid-cols-12 gap-2 pb-1 border-b border-zinc-800 font-mono text-[10px] text-zinc-600 uppercase tracking-widest">
              <div className="col-span-1">#</div>
              <div className="col-span-4">Market</div>
              <div className="col-span-2">Competing $</div>
              <div className="col-span-2">Vol 24h</div>
              <div className="col-span-2">Rebate/fill</div>
              <div className="col-span-1">Risk</div>
            </div>

            {markets.map((m, i) => (
              <MarketRow key={m.cid} m={m} rank={i + 1} />
            ))}
          </section>
        ) : (
          <div className="border border-zinc-800 bg-zinc-900 p-8 text-center space-y-2">
            <p className="font-mono text-sm text-zinc-400">
              {status === 'offline'
                ? 'Agent is offline — reward data will appear once it connects.'
                : 'Scanning for reward-eligible markets…'}
            </p>
            <p className="font-mono text-xs text-zinc-600">
              First scan runs ~10 s after agent start. Refreshes every 15 min.
            </p>
          </div>
        )}

        {/* Methodology */}
        <div className="border border-zinc-800/60 bg-zinc-900/30 p-4 space-y-3">
          <p className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest">
            Methodology — what is and isn't known
          </p>
          <ul className="space-y-2">
            {[
              'LP Reward rate: NOT published. rewards.rates field in CLOB API returns null for all markets. Polymarket calculates rewards on-chain; the per-market daily rate is not exposed.',
              'Maker rebate per fill: REAL number from published feeSchedule (takerFeeRate × rebateRate). Fill-dependent — you earn it only when a taker hits your order.',
              'Competing depth: CLOB book snapshot of USDC resting within the reward band (±rewardsMaxSpread of mid). Snapshot is stale immediately; competition moves continuously.',
              'Adverse risk: qualitative structural proxy. HIGH near resolution (informed flow likely). LOW for negRisk correlated outcomes (slow drift). Cannot measure without live fill history.',
              'This page is read-only. No orders are placed. Not financial advice.',
            ].map((t, i) => (
              <li key={i} className="font-mono text-[11px] text-zinc-600 leading-relaxed pl-3 border-l border-zinc-700/40">
                {t}
              </li>
            ))}
          </ul>
          <details className="mt-2">
            <summary className="font-mono text-[10px] text-zinc-700 cursor-pointer hover:text-zinc-500 uppercase tracking-widest select-none">
              Raw methodology note ▸
            </summary>
            <p className="font-mono text-[10px] text-zinc-700 mt-2 leading-relaxed">
              {data?.note ?? ''}
            </p>
          </details>
        </div>

        {/* Footer */}
        <p className="font-mono text-[10px] text-zinc-700 border-t border-zinc-800 pt-4">
          {data?.disclaimer ?? 'Read-only. No orders placed. Not financial advice.'}
        </p>

      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

interface MarketSummary {
  cid:             string;
  title:           string;
  rewardTag:       'reward' | 'balanced';
  mid:             number;
  quoteBid:        number;
  quoteAsk:        number;
  spread:          number;
  spreadPct:       number;
  vol24:           number;
  days:            number;
  negRisk:         boolean;
  rms:             number;
  rmn:             number;
  takerFeeRate:    number;
  rebateRate:      number;
  dailyPool:       number | null;
  competingDepth:  number | null;
  ourShare:        number | null;
  estRewardPerDay: number | null;
  estRewardCum:    number | null;
  hasOpenPosition: boolean;
  positionDirection: 'long' | 'short' | null;
  totalCycles:     number;
  perfectCycles:   number;
  adverseCycles:   number;
  measuredPnl:     number;
  quotedHours:     number;
}

interface RecentCycle {
  id:           string;
  title:        string;
  rewardTag:    string;
  direction:    string;
  type:         string;
  entryTs:      number;
  exitTs:       number | null;
  entryPrice:   number;
  exitPrice:    number | null;
  exitReason:   string | null;
  measuredPnl:  number | null;
  winner:       string | null;
}

interface Aggregate {
  totalMarkets:     number;
  rewardMarkets:    number;
  balancedMarkets:  number;
  totalCycles:      number;
  openCycles:       number;
  perfectCycles:    number;
  adverseCycles:    number;
  resolvedCycles:   number;
  measuredPnl:      number;
  estRewardPerDay:  number;
  estimatedRewards: number;
  totalWithRewards: number;
  quotedHours:      number;
}

interface MMData {
  agentStatus:    'running' | 'stale' | 'offline';
  updatedAt:      string | null;
  rewardPoolNote: string;
  markets:        MarketSummary[];
  aggregate:      Aggregate;
  recentCycles:   RecentCycle[];
  disclaimer:     string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt$(n: number | null | undefined, decimals = 2): string {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${n.toFixed(0)}`;
  if (abs >= 10)   return `$${n.toFixed(1)}`;
  return `$${n.toFixed(decimals)}`;
}

function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(decimals)}%`;
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function sign$(n: number): string {
  if (n === 0) return '$0.00';
  return n > 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Chip({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <span className={['inline-flex gap-1 items-center px-1.5 py-0.5 rounded font-mono text-[10px] border', accent ?? 'border-zinc-700 bg-zinc-800 text-zinc-300'].join(' ')}>
      <span className="text-zinc-500">{label}</span>
      <span>{value}</span>
    </span>
  );
}

function MeasuredPanel({ agg }: { agg: Aggregate }) {
  const measured = agg.measuredPnl ?? 0;
  const isPos    = measured >= 0;
  const enough   = agg.totalCycles >= 10;
  return (
    <div className="border-l-4 border-indigo-500 border border-zinc-700 bg-zinc-900 p-5" style={{ borderLeftWidth: '4px' }}>
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="font-mono text-xs text-indigo-400 uppercase tracking-widest">Measured net P&amp;L</span>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-indigo-500/40 text-indigo-400 bg-indigo-950/40">VERIFIABLE</span>
      </div>
      <div className={`font-mono text-3xl font-bold tabular-nums mt-2 ${isPos ? 'text-emerald-400' : 'text-red-400'}`}>
        {sign$(measured)}
      </div>
      <p className="font-mono text-xs text-zinc-500 mt-2">
        {enough
          ? `${agg.totalCycles} closed cycles — spread captures minus adverse losses. No rewards included.`
          : `${agg.totalCycles}/10 cycles — need ≥10 closed cycles before this is meaningful.`}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="font-mono text-sm text-emerald-400 tabular-nums">{agg.perfectCycles}</div>
          <div className="font-mono text-[10px] text-zinc-600 uppercase">perfect</div>
        </div>
        <div>
          <div className="font-mono text-sm text-red-400 tabular-nums">{agg.adverseCycles}</div>
          <div className="font-mono text-[10px] text-zinc-600 uppercase">adverse</div>
        </div>
        <div>
          <div className="font-mono text-sm text-zinc-400 tabular-nums">{(agg.quotedHours ?? 0).toFixed(1)}h</div>
          <div className="font-mono text-[10px] text-zinc-600 uppercase">quoted</div>
        </div>
      </div>
    </div>
  );
}

function RewardsPanel({ agg }: { agg: Aggregate }) {
  const perDay = agg.estRewardPerDay ?? 0;
  const cum    = agg.estimatedRewards ?? 0;
  return (
    <div className="border border-dashed border-amber-500/60 bg-zinc-900/60 p-5">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="font-mono text-xs text-amber-400 uppercase tracking-widest">Estimated rewards</span>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-400 bg-amber-950/40">ASSUMPTION</span>
        <span className="font-mono text-[10px] text-zinc-500">competition-dependent</span>
      </div>
      <div className="font-mono text-3xl font-bold tabular-nums mt-2 text-amber-400">
        {fmt$(cum)}
      </div>
      <p className="font-mono text-xs text-zinc-500 mt-2">
        Real daily pool × estimated share (CLOB book depth snapshot — changes continuously).
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-center">
        <div>
          <div className="font-mono text-sm text-amber-400 tabular-nums">{fmt$(perDay)}/day</div>
          <div className="font-mono text-[10px] text-zinc-600 uppercase">pool × our share</div>
        </div>
        <div>
          <div className="font-mono text-sm text-zinc-400 tabular-nums">{agg.rewardMarkets}</div>
          <div className="font-mono text-[10px] text-zinc-600 uppercase">reward markets</div>
        </div>
      </div>
    </div>
  );
}

function VerdictLine({ agg }: { agg: Aggregate }) {
  const enough   = agg.totalCycles >= 10;
  const measured = agg.measuredPnl ?? 0;
  const total    = agg.totalWithRewards ?? 0;
  const perDay   = agg.estRewardPerDay ?? 0;
  if (!enough) {
    return (
      <p className="font-mono text-xs text-zinc-500 border-l-2 border-zinc-700 pl-3">
        Need {10 - agg.totalCycles} more cycles before meaningful verdict. Collecting data…
      </p>
    );
  }
  if (measured >= 0 && total >= 0) {
    return (
      <p className="font-mono text-xs text-emerald-400 border-l-2 border-emerald-700 pl-3">
        Above breakeven on both measured ({sign$(measured)}) and with estimated rewards ({sign$(total)}).
        {perDay > 0 ? ` Reward income: ~${fmt$(perDay)}/day (estimate).` : ''}
      </p>
    );
  }
  if (measured < 0 && total >= 0) {
    return (
      <p className="font-mono text-xs text-amber-400 border-l-2 border-amber-700 pl-3">
        Measured net is negative ({sign$(measured)}) but estimated rewards flip it positive ({sign$(total)}).
        Interpretation: adverse selection is being subsidised by the reward program.
      </p>
    );
  }
  return (
    <p className="font-mono text-xs text-red-400 border-l-2 border-red-800 pl-3">
      Below breakeven measured ({sign$(measured)}) and with rewards ({sign$(total)}).
      Adverse selection exceeds both spread captures and estimated reward income.
    </p>
  );
}

function HonestyBlock() {
  const items = [
    'Fill inference is APPROXIMATE — Polymarket data-api has no maker/taker flag. Fills inferred from price-crossing; queue position and partial fills unknown.',
    'Adverse selection is the dominant risk. If informed flow consistently crosses our simulated quotes, measured P&L will trend negative regardless of reward income.',
    'Reward pool split is estimated from a CLOB book snapshot (changes continuously). Actual reward allocations are not published in any public endpoint.',
    'No orders are placed. This is a read-only simulation. Not financial advice.',
  ];
  return (
    <div className="border border-zinc-700 bg-zinc-900/40 p-4 space-y-1.5">
      <p className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest mb-2">Honesty disclosure</p>
      {items.map((t, i) => (
        <p key={i} className="font-mono text-[11px] text-zinc-500 leading-relaxed pl-3 border-l border-zinc-700">{t}</p>
      ))}
    </div>
  );
}

function MeasurementBar({ agg }: { agg: Aggregate }) {
  const filled = Math.min(agg.totalCycles, 10);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest">Measurement status</span>
        <span className="font-mono text-[10px] text-zinc-400">{agg.totalCycles}/10 cycles</span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className={['h-2 flex-1 rounded-sm', i < filled ? 'bg-indigo-500' : 'bg-zinc-800'].join(' ')} />
        ))}
      </div>
      {agg.totalCycles < 10 && (
        <p className="font-mono text-[10px] text-zinc-600 mt-1">
          {10 - agg.totalCycles} more closed cycles needed for a meaningful measured P&amp;L.
        </p>
      )}
    </div>
  );
}

function MarketCard({ m }: { m: MarketSummary }) {
  const isReward = m.rewardTag === 'reward';
  const pnlColor = m.measuredPnl >= 0 ? 'text-emerald-400' : 'text-red-400';
  const vol24Fmt = m.vol24 >= 1000 ? `$${(m.vol24 / 1000).toFixed(1)}k` : `$${m.vol24.toFixed(0)}`;

  return (
    <div className={['border bg-zinc-900 p-4', isReward ? 'border-amber-500/30' : 'border-zinc-700'].join(' ')}>
      <div className="flex items-start gap-2 mb-3 flex-wrap">
        <span className={['shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded border uppercase', isReward ? 'border-amber-500/40 bg-amber-950/30 text-amber-400' : 'border-indigo-500/40 bg-indigo-950/30 text-indigo-400'].join(' ')}>
          {isReward ? 'REWARD' : 'BALANCED'}
        </span>
        {m.negRisk && <span className="shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded border border-zinc-600 bg-zinc-800 text-zinc-400 uppercase">negRisk</span>}
        {m.hasOpenPosition && <span className="shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded border border-zinc-600 bg-zinc-800 text-zinc-400 uppercase">{m.positionDirection}</span>}
      </div>

      <p className="font-mono text-xs text-zinc-300 leading-relaxed mb-3 line-clamp-2">{m.title}</p>

      <div className="flex flex-wrap gap-1.5 mb-3">
        <Chip label="mid"    value={m.mid.toFixed(3)} />
        <Chip label="spread" value={`${(m.spread * 100).toFixed(1)}¢`} />
        <Chip label="vol24"  value={vol24Fmt} />
        {m.days > 0 && <Chip label="days" value={m.days.toFixed(0)} />}
        {isReward && m.rms > 0 && (
          <Chip label="max-spr" value={`±${m.rms}¢`} accent="border-amber-700/50 bg-amber-950/20 text-amber-300" />
        )}
        {isReward && m.rmn > 0 && (
          <Chip label="min-sz" value={`$${m.rmn}`} accent="border-amber-700/50 bg-amber-950/20 text-amber-300" />
        )}
        {isReward && m.dailyPool != null && (
          <Chip label="pool" value={`${fmt$(m.dailyPool)}/d`} accent="border-amber-600/50 bg-amber-950/30 text-amber-300" />
        )}
        {isReward && m.ourShare != null && (
          <Chip label="our%" value={fmtPct(m.ourShare, 1)} accent="border-amber-700/50 bg-amber-950/20 text-amber-300" />
        )}
        {isReward && m.competingDepth != null && (
          <Chip label="competing" value={`$${m.competingDepth}`} />
        )}
      </div>

      <div className="grid grid-cols-3 gap-2 pt-2 border-t border-zinc-800 text-center">
        <div>
          <div className={`font-mono text-xs tabular-nums ${pnlColor}`}>{sign$(m.measuredPnl)}</div>
          <div className="font-mono text-[10px] text-zinc-600">meas.P&amp;L</div>
        </div>
        <div>
          <div className="font-mono text-xs tabular-nums text-amber-400">{m.estRewardCum != null ? fmt$(m.estRewardCum) : '—'}</div>
          <div className="font-mono text-[10px] text-zinc-600">est.reward</div>
        </div>
        <div>
          <div className="font-mono text-xs tabular-nums text-zinc-400">{m.quotedHours.toFixed(1)}h</div>
          <div className="font-mono text-[10px] text-zinc-600">quoted</div>
        </div>
      </div>
    </div>
  );
}

function CycleRow({ c }: { c: RecentCycle }) {
  const typeColor = c.type === 'perfect'  ? 'text-emerald-400'
                  : c.type === 'adverse'  ? 'text-red-400'
                  : c.type === 'resolved' ? 'text-indigo-400'
                  :                         'text-zinc-500';
  const pnlColor  = (c.measuredPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400';
  return (
    <div className="flex items-center gap-3 py-2 border-t border-zinc-800 text-xs font-mono">
      <span className={`shrink-0 w-16 uppercase ${typeColor}`}>{c.type}</span>
      <span className="shrink-0 w-12 text-zinc-500">{c.direction}</span>
      <span className="flex-1 text-zinc-400 truncate min-w-0">{c.title}</span>
      <span className={`shrink-0 w-16 text-right tabular-nums ${pnlColor}`}>
        {c.measuredPnl != null ? sign$(c.measuredPnl) : '—'}
      </span>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const POLL_MS = 30_000;

export default function MMPage() {
  const [data, setData]         = useState<MMData | null>(null);
  const [error, setError]       = useState<string | null>(null);
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

  const agg: Aggregate = data?.aggregate ?? {
    totalMarkets: 0, rewardMarkets: 0, balancedMarkets: 0,
    totalCycles: 0, openCycles: 0, perfectCycles: 0,
    adverseCycles: 0, resolvedCycles: 0,
    measuredPnl: 0, estRewardPerDay: 0, estimatedRewards: 0,
    totalWithRewards: 0, quotedHours: 0,
  };

  const status       = data?.agentStatus ?? 'offline';
  const allMarkets   = data?.markets ?? [];
  const cycles       = data?.recentCycles ?? [];
  const rewardMkts   = allMarkets.filter(m => m.rewardTag === 'reward');
  const balancedMkts = allMarkets.filter(m => m.rewardTag === 'balanced');

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">

        {/* Context line */}
        <p className="font-mono text-[11px] text-zinc-600 uppercase tracking-widest">
          Polymarket CLOB · Read-only simulation · Zero Claude · No orders placed
        </p>

        {/* Header */}
        <div className="flex items-center gap-4 flex-wrap">
          <h1 className="font-mono text-xl font-bold text-zinc-100 tracking-tight">MM Analyzer</h1>
          {status === 'running' && (
            <span className="flex items-center gap-1.5 font-mono text-xs text-amber-400 border border-amber-500/40 bg-amber-950/30 px-2 py-0.5 rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              Measuring
            </span>
          )}
          {status === 'stale'   && <span className="font-mono text-xs text-orange-400 border border-orange-500/40 px-2 py-0.5 rounded">stale</span>}
          {status === 'offline' && <span className="font-mono text-xs text-red-400   border border-red-500/40    px-2 py-0.5 rounded">offline</span>}
          <span className="font-mono text-[10px] text-zinc-600 ml-auto">
            updated {lastPoll ? ago(lastPoll.toISOString()) : '—'}
          </span>
        </div>

        {error && (
          <div className="font-mono text-xs text-red-400 border border-red-800 bg-red-950/20 px-3 py-2">{error}</div>
        )}

        {/* Lede */}
        <p className="font-mono text-sm text-zinc-400 leading-relaxed max-w-2xl">
          Simulates a passive $50 YES quote on eligible Polymarket binary markets. Infers fills
          from the public trade stream (price-crossing heuristic — no maker/taker flag exists).
          Two P&L numbers:{' '}
          <span className="text-indigo-400">Measured net</span> tracks spread captures minus
          adverse losses with zero assumptions;{' '}
          <span className="text-amber-400">Estimated rewards</span> derives the real LP reward
          pool from public fee schedules and estimates our share from CLOB book depth.
        </p>

        {/* SIGNATURE two-number panel */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <MeasuredPanel agg={agg} />
          <RewardsPanel  agg={agg} />
        </div>

        {/* Total with rewards */}
        <div className="flex items-center gap-3 border border-zinc-700 bg-zinc-900 px-5 py-3">
          <span className="font-mono text-xs text-zinc-500 uppercase tracking-widest">Total (meas. + est. rewards)</span>
          <span className={`font-mono text-xl font-bold tabular-nums ml-auto ${(agg.totalWithRewards ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {sign$(agg.totalWithRewards ?? 0)}
          </span>
        </div>

        {/* Verdict */}
        <VerdictLine agg={agg} />

        {/* Honesty disclosure */}
        <HonestyBlock />

        {/* Measurement status bar */}
        <MeasurementBar agg={agg} />

        {/* REWARD markets */}
        {rewardMkts.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-mono text-xs text-amber-400 uppercase tracking-widest">Reward markets ({rewardMkts.length})</span>
              <span className="font-mono text-[10px] text-zinc-600">LP reward program · any mid · tight spreads · real pool formula</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {rewardMkts.map(m => <MarketCard key={m.cid} m={m} />)}
            </div>
          </section>
        )}

        {/* BALANCED markets */}
        {balancedMkts.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-mono text-xs text-indigo-400 uppercase tracking-widest">Balanced markets ({balancedMkts.length})</span>
              <span className="font-mono text-[10px] text-zinc-600">mid 0.30–0.70 · vol≥$100/d · 14+ days · no reward program</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {balancedMkts.map(m => <MarketCard key={m.cid} m={m} />)}
            </div>
          </section>
        )}

        {allMarkets.length === 0 && (
          <div className="border border-zinc-800 bg-zinc-900 p-8 text-center">
            <p className="font-mono text-sm text-zinc-500">No markets yet — agent discovering…</p>
          </div>
        )}

        {/* Recent cycles */}
        {cycles.length > 0 && (
          <section className="space-y-2">
            <span className="font-mono text-xs text-zinc-500 uppercase tracking-widest">Recent cycles</span>
            <div className="border border-zinc-800 bg-zinc-900 px-4">
              {cycles.slice(0, 20).map(c => <CycleRow key={c.id} c={c} />)}
            </div>
          </section>
        )}

        {/* Methodology note (collapsible) */}
        {data?.rewardPoolNote && (
          <details>
            <summary className="font-mono text-[10px] text-zinc-600 cursor-pointer hover:text-zinc-400 uppercase tracking-widest select-none">
              Reward pool methodology ▸
            </summary>
            <p className="font-mono text-[11px] text-zinc-600 mt-2 leading-relaxed pl-3 border-l border-zinc-800">
              {data.rewardPoolNote}
            </p>
          </details>
        )}

        {/* Disclaimer footer */}
        <p className="font-mono text-[10px] text-zinc-700 border-t border-zinc-800 pt-4">
          {data?.disclaimer ?? 'Read-only simulation. No orders placed. Not financial advice.'}
        </p>

      </div>
    </div>
  );
}

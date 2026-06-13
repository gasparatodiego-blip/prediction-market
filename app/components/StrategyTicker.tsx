'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { TickerItem } from '@/app/api/ticker/route';

interface TickerData {
  ok:           boolean;
  generatedAt:  number | null;
  staleMinutes: number | null;
  categories:   TickerItem[];
}

const STATUS_CLS: Record<string, string> = {
  'live':        'bg-positive/10 text-positive border-positive/25',
  'no-opp':      'bg-border/50 text-text-muted border-border',
  'offline':     'bg-warning/10 text-warning/70 border-warning/20',
  'coming-soon': 'bg-border/20 text-text-muted/40 border-border/30',
};

const STATUS_BADGE: Record<string, string> = {
  'live':        'LIVE',
  'no-opp':      'EMPTY',
  'offline':     'OFFLINE',
  'coming-soon': 'SOON',
};

const STATUS_WORD: Record<string, string> = {
  'no-opp':      'NO LIVE OPP',
  'offline':     'OFFLINE',
  'coming-soon': 'COMING SOON',
};

function TickerTile({ cat }: { cat: TickerItem }) {
  const isLive     = cat.status === 'live';
  const isDisabled = cat.status === 'coming-soon';

  const inner = (
    <div className={`
      flex-none w-48 h-40 border flex flex-col p-4
      transition-colors duration-100
      ${isLive
        ? 'border-border bg-bg-panel hover:bg-bg-elevated hover:border-positive/40 cursor-pointer'
        : cat.status === 'offline'
        ? 'border-border/50 bg-bg-panel/70 hover:bg-bg-elevated/70 cursor-pointer'
        : cat.status === 'no-opp'
        ? 'border-border bg-bg-panel hover:bg-bg-elevated cursor-pointer'
        : 'border-border/30 bg-bg-panel/40 opacity-50 cursor-default pointer-events-none'
      }
    `}>
      {/* Label row */}
      <div className="flex items-center gap-1.5 mb-auto">
        {isLive && (
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-positive shrink-0 animate-pulse-slow"
            style={{ boxShadow: '0 0 4px #22C55E' }} />
        )}
        <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted leading-snug">
          {cat.label}
        </span>
      </div>

      {/* Metric */}
      <div className="flex-1 flex flex-col justify-center">
        {isLive && cat.bestNetPct != null ? (
          <>
            <div className="font-mono font-bold tabular-nums text-positive leading-none">
              <span className="text-[26px]">
                +{cat.bestNetPct.toFixed(1)}
              </span>
              <span className="text-[12px] font-normal text-positive/70 ml-0.5">
                {cat.unit}
              </span>
            </div>
            <div className="font-mono text-[9px] text-text-muted mt-1.5 leading-snug">
              {cat.note}
            </div>
          </>
        ) : (
          <>
            <div className={`font-mono text-[11px] font-semibold tracking-wider ${
              cat.status === 'offline'     ? 'text-warning/60' :
              cat.status === 'coming-soon' ? 'text-text-muted/40' :
              'text-text-muted'
            }`}>
              {STATUS_WORD[cat.status] ?? '—'}
            </div>
            <div className="font-mono text-[9px] text-text-muted/60 mt-1 leading-snug">
              {cat.note}
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 mt-3">
        <span className="font-mono text-[9px] text-text-muted/50 tabular-nums">
          {cat.count > 0 ? `${cat.count} found` : ''}
        </span>
        <span className={`font-mono text-[8px] uppercase tracking-widest px-1.5 py-[2px] border shrink-0 ${STATUS_CLS[cat.status]}`}>
          {STATUS_BADGE[cat.status]}
        </span>
      </div>
    </div>
  );

  if (isDisabled) return <div key={cat.key}>{inner}</div>;
  return (
    <Link key={cat.key} href={cat.href} className="block flex-none">
      {inner}
    </Link>
  );
}

export default function StrategyTicker() {
  const [data,    setData]    = useState<TickerData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res  = await fetch('/api/ticker', { cache: 'no-store' });
        const json = await res.json();
        setData(json);
      } catch { /* keep stale */ }
      finally { setLoading(false); }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  if (loading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none' }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex-none w-48 h-40 bg-bg-panel border border-border animate-pulse" />
        ))}
      </div>
    );
  }

  if (!data?.categories?.length) {
    return (
      <div className="font-mono text-[10px] text-text-muted py-4">
        Agents not running — start agent10-binance and agent15-funding-writer.
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        {data.categories.map(cat => (
          <TickerTile key={cat.key} cat={cat} />
        ))}
      </div>
      {(data.staleMinutes ?? 0) > 5 && (
        <div className="font-mono text-[9px] text-warning/60 mt-2">
          Data {data.staleMinutes}m old — agents may be paused
        </div>
      )}
    </div>
  );
}

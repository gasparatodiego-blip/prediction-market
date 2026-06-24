'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
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

function TickerTile({ cat, flashKey }: { cat: TickerItem; flashKey: number }) {
  const isLive     = cat.status === 'live';
  const isDisabled = cat.status === 'coming-soon';

  const inner = (
    <div className={`
      h-full min-h-[136px] flex flex-col p-3.5
      border-r border-b border-border
      transition-colors duration-100
      ${isLive
        ? 'bg-bg-panel hover:bg-bg-elevated hover:border-positive/40'
        : cat.status === 'offline'
        ? 'bg-bg-panel/80 hover:bg-bg-elevated/80'
        : cat.status === 'no-opp'
        ? 'bg-bg-panel hover:bg-bg-elevated'
        : 'bg-bg-panel/40 opacity-50 cursor-default pointer-events-none'
      }
    `}>
      {/* Label row */}
      <div className="flex items-center gap-1.5 mb-auto pb-2">
        {isLive && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-positive shrink-0 animate-pulse-slow"
            style={{ boxShadow: '0 0 4px #22C55E' }}
          />
        )}
        <span className="font-mono text-[8px] uppercase tracking-widest text-text-muted leading-snug">
          {cat.label}
        </span>
      </div>

      {/* Metric — key={flashKey} forces remount → CSS animation restarts on real value change */}
      <div className="flex-1 flex flex-col justify-center" key={flashKey}>
        {isLive && cat.bestNetPct != null ? (
          <>
            <div className="font-mono font-bold tabular-nums text-positive leading-none">
              <span
                className={`text-[22px] ${flashKey > 0 ? 'animate-number-flash' : ''}`}
              >
                +{cat.bestNetPct.toFixed(1)}
              </span>
              <span className="text-[10px] font-normal text-positive/70 ml-0.5">
                {cat.unit}
              </span>
            </div>
            {/* Context badges for figures that need qualification */}
            {cat.displayKind === 'ceiling' && (
              <div className="mt-1">
                <span className="font-mono text-[6.5px] uppercase tracking-widest px-1 py-[2px] border border-text-muted/20 text-text-muted/40">
                  CEILING · VARIABLE
                </span>
              </div>
            )}
            {cat.displayKind === 'net' && (
              <div className="mt-1">
                <span className="font-mono text-[6.5px] uppercase tracking-widest px-1 py-[2px] border border-positive/20 text-positive/40">
                  CONFIRMED · NET
                </span>
              </div>
            )}

            <div className="font-mono text-[8px] text-text-muted mt-1 leading-snug">
              {cat.note}
            </div>
          </>
        ) : (
          <>
            <div className={`font-mono text-[10px] font-semibold tracking-wider ${
              cat.status === 'offline'     ? 'text-warning/60' :
              cat.status === 'coming-soon' ? 'text-text-muted/40' :
              'text-text-muted'
            }`}>
              {STATUS_WORD[cat.status] ?? '—'}
            </div>
            <div className="font-mono text-[8px] text-text-muted/60 mt-1 leading-snug">
              {cat.note}
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 mt-2.5">
        <span className="font-mono text-[8px] text-text-muted/50 tabular-nums">
          {cat.count > 0 ? `${cat.count} found` : ''}
        </span>
        <span className={`font-mono text-[7px] uppercase tracking-widest px-1.5 py-[2px] border shrink-0 ${STATUS_CLS[cat.status]}`}>
          {STATUS_BADGE[cat.status]}
        </span>
      </div>
    </div>
  );

  if (isDisabled) return <div>{inner}</div>;
  return (
    <Link href={cat.href} className="block">
      {inner}
    </Link>
  );
}

function fmt(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function StrategyTicker() {
  const [data,      setData]      = useState<TickerData | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [error,     setError]     = useState(false);

  // Per-category flash keys — incremented only when a value actually changes
  const [flashKeys,    setFlashKeys]    = useState<Record<string, number>>({});
  const prevValuesRef = useRef<Record<string, number | null>>({});

  const load = useCallback(async () => {
    try {
      const res  = await fetch(`/api/ticker?_=${Date.now()}`);
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      setData(json);
      setFetchedAt(new Date());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  // Detect which categories changed value and bump their flash key
  useEffect(() => {
    if (!data) return;
    const prev = prevValuesRef.current;
    const changed: string[] = [];

    for (const cat of data.categories) {
      const pv = prev[cat.key];
      if (pv !== undefined && pv !== cat.bestNetPct) changed.push(cat.key);
      prev[cat.key] = cat.bestNetPct;
    }

    if (changed.length > 0) {
      setFlashKeys(fk => {
        const next = { ...fk };
        for (const k of changed) next[k] = (next[k] ?? 0) + 1;
        return next;
      });
    }
    prevValuesRef.current = prev;
  }, [data]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 border border-border overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="min-h-[136px] border-r border-b border-border bg-bg-panel animate-pulse" />
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
      {/* Responsive grid — fills full width, wraps on mobile */}
      <div className="grid grid-cols-2 sm:grid-cols-4 border border-border overflow-hidden">
        {data.categories.map(cat => (
          <TickerTile
            key={cat.key}
            cat={cat}
            flashKey={flashKeys[cat.key] ?? 0}
          />
        ))}
      </div>

      {/* Live status footer */}
      <div className="flex items-center justify-between mt-2 gap-4 flex-wrap">
        <div className="flex items-center gap-1.5">
          {error ? (
            <span className="font-mono text-[9px] text-warning/60">fetch failed · showing last good data</span>
          ) : fetchedAt ? (
            <>
              <span className="inline-block w-1 h-1 rounded-full bg-positive animate-pulse-slow shrink-0" />
              <span className="font-mono text-[9px] text-positive/50 tabular-nums">
                LIVE · data as of {fmt(fetchedAt)} · polls every 30 s
              </span>
            </>
          ) : null}
        </div>
        {(data.staleMinutes ?? 0) > 5 && (
          <span className="font-mono text-[9px] text-warning/60">
            Agent data {data.staleMinutes}m old — agents may be paused
          </span>
        )}
      </div>
    </div>
  );
}

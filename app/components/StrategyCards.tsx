'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import type { TickerItem } from '@/app/api/ticker/route';

interface TickerData {
  categories: TickerItem[];
}

const TAGLINES: Record<string, string> = {
  funding:    'Collect funding while you sleep. Delta-neutral, net of fees.',
  prediction: 'Two prices, one outcome. Pocket the gap.',
  carry:      'Lock the basis. Hands-off yield to expiry.',
  traders:    'Shadow the wallets that win. Real P&L, zero hype.',
  rewards:    'Get paid to quote near the mid — real pools, your measured share.',
  // strip-only (shown when offline / empty / coming-soon)
  sports:     'Books disagree, you win either way.',
};

const HREF_OVERRIDE: Record<string, string> = {
  prediction: '/dashboard/prediction',
};

const STATUS_BADGE: Record<string, string> = {
  'live':             'LIVE',
  'no-opp':           'EMPTY',
  'snapshot-no-opp':  'NO CASHABLE ARB',
  'offline':          'OFFLINE',
  'coming-soon':      'SOON',
};

const CARD_BADGE_CLS: Record<string, string> = {
  'live':             'bg-positive/10 text-positive border-positive/25',
  'no-opp':           'bg-border/50 text-text-muted/50 border-border/50',
  'snapshot-no-opp':  'bg-border/50 text-text-muted/50 border-border/50',
  'offline':          'bg-warning/10 text-warning/60 border-warning/20',
  'coming-soon':      'bg-border/20 text-text-muted/30 border-border/20',
};

const STRIP_BADGE_CLS: Record<string, string> = {
  'no-opp':           'text-text-muted/40 border-border/40',
  'snapshot-no-opp':  'text-text-muted/40 border-border/40',
  'offline':          'text-warning/50 border-warning/20',
  'coming-soon':      'text-text-muted/30 border-border/30',
};

const STATUS_WORD: Record<string, string> = {
  'no-opp':           'NO LIVE OPP',
  'snapshot-no-opp':  'NO CASHABLE ARB',
  'offline':          'OFFLINE',
  'coming-soon':      'COMING SOON',
};

// ── Compact live card ────────────────────────────────────────────────────────
function LiveCard({ cat, flashKey }: { cat: TickerItem; flashKey: number }) {
  const href = HREF_OVERRIDE[cat.key] ?? cat.href;

  return (
    <Link href={href} className="block">
      <div className={[
        'flex flex-col h-full p-3 border border-border bg-bg-panel',
        'transition-colors duration-150',
        'motion-safe:hover:-translate-y-0.5 motion-safe:transition-all motion-safe:duration-200',
        'hover:border-accent/25 hover:bg-bg-elevated hover:shadow-[0_4px_16px_rgba(99,102,241,0.07)]',
      ].join(' ')}>

        {/* Header */}
        <div className="flex items-start justify-between gap-1.5 mb-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {cat.status === 'live' ? (
              <span
                className="inline-block w-1.5 h-1.5 rounded-full bg-positive shrink-0 animate-pulse-slow"
                style={{ boxShadow: '0 0 4px #22C55E' }}
              />
            ) : (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-text-muted/30 shrink-0" />
            )}
            <span className="font-mono text-[8px] uppercase tracking-widest text-text-muted truncate">
              {cat.label}
            </span>
          </div>
          <span className={`font-mono text-[6.5px] uppercase tracking-widest px-1 py-[2px] border shrink-0 ${CARD_BADGE_CLS[cat.status]}`}>
            {STATUS_BADGE[cat.status]}
          </span>
        </div>

        {/* Tagline */}
        <div className="flex-1 mb-2">
          <p className="font-mono text-[8.5px] text-text-secondary leading-relaxed">
            {TAGLINES[cat.key] ?? cat.note}
          </p>
          {cat.platforms && cat.platforms.length > 0 && (
            <p className="font-mono text-[7px] text-text-muted/40 mt-0.5">
              {cat.platforms.join(' · ')}
            </p>
          )}
        </div>

        {/* Metric — remounts on value change → flash plays */}
        <div key={flashKey}>
          {cat.bestNetPct != null ? (
            <>
              <div
                className={`font-mono font-bold tabular-nums leading-none ${flashKey > 0 ? 'animate-number-flash' : ''}`}
                style={{ fontSize: '1.15rem', color: '#22C55E' }}
              >
                +{cat.bestNetPct.toFixed(1)}
                <span className="text-[9px] font-normal ml-0.5" style={{ color: 'rgba(34,197,94,0.6)' }}>
                  {cat.unit}
                </span>
              </div>
              {/* Context badge — de-emphasizes figures that need qualification */}
              {cat.displayKind === 'ceiling' && (
                <div className="mt-1 mb-0.5">
                  <span className="font-mono text-[6.5px] uppercase tracking-widest px-1 py-[2px] border border-text-muted/20 text-text-muted/40">
                    CEILING · VARIABLE RATE
                  </span>
                </div>
              )}
              {cat.displayKind === 'net' && (
                <div className="mt-1 mb-0.5">
                  <span className="font-mono text-[6.5px] uppercase tracking-widest px-1 py-[2px] border border-positive/20 text-positive/40">
                    CONFIRMED · NET OF FEES
                  </span>
                </div>
              )}
              {cat.displayKind === 'estimate' && (
                <div className="mt-1 mb-0.5">
                  <span className="font-mono text-[6.5px] uppercase tracking-widest px-1 py-[2px] border border-amber-500/20 text-amber-400/40">
                    ESTIMATE · GROSS · NOT NET
                  </span>
                </div>
              )}
              {cat.displayKind === 'snapshot' && (
                <div className="mt-1 mb-0.5">
                  <span className="font-mono text-[6.5px] uppercase tracking-widest px-1 py-[2px] border border-text-muted/20 text-text-muted/40">
                    SNAPSHOT · DAILY SCAN
                  </span>
                </div>
              )}
              <div className="font-mono text-[7.5px] text-text-muted/45 mt-0.5 truncate">
                {cat.note}
              </div>
            </>
          ) : (
            <div className="font-mono text-[8.5px] text-text-muted/60 leading-snug">
              {cat.note}
            </div>
          )}
        </div>

      </div>
    </Link>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export default function StrategyCards() {
  const [data,      setData]      = useState<TickerData | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [flashKeys, setFlashKeys] = useState<Record<string, number>>({});
  const prevValuesRef             = useRef<Record<string, number | null>>({});

  const load = useCallback(async () => {
    try {
      const res  = await fetch(`/api/ticker?_=${Date.now()}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!data) return;
    const prev    = prevValuesRef.current;
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
      <div className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[110px] border border-border bg-bg-panel animate-pulse" />
          ))}
        </div>
        <div className="h-[72px] border border-border/40 bg-bg-panel/40 animate-pulse" />
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

  // Full cards: live agents AND honest-but-empty results (scanner ran, found 0).
  // Dim strip: genuinely offline (missing/stale data file) or coming-soon only.
  const FULL_CARD_STATUSES = new Set(['live', 'snapshot-no-opp', 'no-opp']);
  const liveCards   = data.categories.filter(c => FULL_CARD_STATUSES.has(c.status));
  const nonLiveItems = data.categories.filter(c => !FULL_CARD_STATUSES.has(c.status));

  return (
    <div>
      {/* ── Live strategy cards (compact grid) ─────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {liveCards.map(cat => (
          <LiveCard
            key={cat.key}
            cat={cat}
            flashKey={flashKeys[cat.key] ?? 0}
          />
        ))}
      </div>

      {/* ── Non-live strip — honest status, no phantom empty cards ─────────── */}
      {nonLiveItems.length > 0 && (
        <div className="mt-3 border border-border/35 overflow-hidden">
          {nonLiveItems.map((cat, i) => {
            const href = HREF_OVERRIDE[cat.key] ?? cat.href;
            return (
              <Link
                key={cat.key}
                href={href}
                className={[
                  'flex items-center gap-3 px-3 py-2 bg-bg-panel/40',
                  i > 0 ? 'border-t border-border/25' : '',
                  'hover:bg-bg-elevated/40 transition-colors duration-100',
                ].join(' ')}
              >
                <span className="font-mono text-[8.5px] text-text-muted/60 shrink-0 w-28">
                  {cat.label}
                </span>
                <span className="font-mono text-[8px] text-text-muted/35 flex-1 truncate hidden sm:block">
                  {cat.status === 'snapshot-no-opp' ? cat.note : TAGLINES[cat.key]}
                </span>
                <span className={`font-mono text-[7px] uppercase tracking-widest px-1.5 py-[2px] border shrink-0 ${STRIP_BADGE_CLS[cat.status] ?? 'text-text-muted/40 border-border/40'}`}>
                  {STATUS_BADGE[cat.status]}
                </span>
              </Link>
            );
          })}
        </div>
      )}

      <p className="font-mono text-[8px] text-text-muted/35 mt-2 leading-relaxed">
        Live numbers are best current result per category — net of fees. Empty categories show an honest status word. Refreshes every 30 s.
      </p>
    </div>
  );
}

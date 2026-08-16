'use client';

import { useEffect, useRef, useState } from 'react';
import CollectionStoppedNote from '@/app/components/CollectionStoppedNote';
import { STOPPED_DASH } from '@/lib/collection-status';

interface Opp {
  id: string;
  title: string;
  type: string;
  platform_a: string;
  platform_b: string;
  expected_return: string;
  roi: number;
  confidence: number;
  urgency: string;
}

const TYPE_LABELS: Record<string, string> = {
  prediction_market: 'PRED-MKT',
  funding_rate:      'FUND-RATE',
  cash_carry:        'CASH+CRY',
  cex_arb:           'CEX-ARB',
  sports_arb:        'SPORTS',
};

const CHIP_COLORS: Record<string, string> = {
  Polymarket:            'bg-mint/10 text-mint border-mint/20',
  Kalshi:                'bg-mint-deep/10 text-mint-deep border-mint-deep/20',
  PredictIt:             'bg-coral-ink/10 text-coral-ink border-coral-ink/20',
  Manifold:              'bg-gold/10 text-gold border-gold/20',
  'Binance Spot':        'bg-gold/10 text-gold border-gold/20',
  'Binance BTC-PERP':    'bg-gold/10 text-gold border-gold/20',
  'Binance ETH-PERP':    'bg-gold/10 text-gold border-gold/20',
  'Coinbase Spot':       'bg-violet/10 text-violet border-violet/20',
  'CME BTC Quarterly':   'bg-muted/10 text-ink-2 border-line',
};

function Chip({ name }: { name: string }) {
  const cls = CHIP_COLORS[name] ?? 'bg-bg-soft text-ink-2 border-line';
  return (
    <span className={`inline-block px-1.5 py-[2px] font-body text-[9px] uppercase tracking-[0.06em] border ${cls} leading-none rounded-sm`}>
      {name}
    </span>
  );
}

function SkeletonRow() {
  return (
    <div className="px-3 py-3 border-b border-line last:border-b-0">
      <div className="h-2.5 w-4/5 bg-bg-soft animate-pulse mb-2 rounded" />
      <div className="flex gap-1.5 items-center">
        <div className="h-4 w-16 bg-bg-soft animate-pulse rounded" />
        <div className="h-4 w-14 bg-bg-soft animate-pulse rounded" />
        <div className="ml-auto h-2.5 w-12 bg-bg-soft animate-pulse rounded" />
      </div>
    </div>
  );
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}
function fmtTime(d: Date) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export default function LiveOpportunitiesPanel() {
  const [opps, setOpps]       = useState<Opp[]>([]);
  const [loading, setLoading] = useState(true);
  const [stale, setStale]     = useState(false);
  const [asOf, setAsOf]       = useState<number | string | null>(null);
  const [flash, setFlash]     = useState(false);
  const prevIds               = useRef<string>('');

  const fetchOpps = async () => {
    try {
      const res  = await fetch('/api/opportunities', { cache: 'no-store' });
      const data = await res.json();
      const list: Opp[] = data.opportunities ?? [];

      const newIds = list.map((o) => o.id).join(',');
      if (newIds !== prevIds.current && prevIds.current !== '') {
        setFlash(true);
        setTimeout(() => setFlash(false), 600);
      }
      prevIds.current = newIds;

      // Collection stopped = the route's own file-age verdict. Never the client clock, never "empty
      // == error": show the real last-observation stamp and, when stopped, the honest stopped note.
      setStale(data?.stale === true);
      setAsOf(data?.updatedAt ?? null);
      setOpps(list);
    } catch {
      // A failed fetch is unknown freshness — treat as stopped (no frozen rows, no error tone).
      setStale(true);
      setAsOf(null);
      setOpps([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOpps();
    const iv = setInterval(fetchOpps, 20_000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="bg-surface border border-line flex flex-col rounded-card shadow-card">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-line shrink-0">
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-mint-deep animate-pulse-slow shrink-0"
            style={{ boxShadow: '0 0 4px #0A9D6B' }}
          />
          <span className="font-body text-[10px] uppercase tracking-[0.14em] text-muted">
            Live Opportunities
          </span>
        </div>
        <span className="font-mono text-[10px] tabular-nums text-muted">
          {stale ? STOPPED_DASH : asOf != null ? fmtTime(new Date(asOf)) : '--:--:--'}
        </span>
      </div>

      {/* Body */}
      {loading ? (
        <div>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : stale ? (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <CollectionStoppedNote asOf={asOf} />
        </div>
      ) : opps.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <span
            className="inline-block w-2 h-2 rounded-full bg-gold animate-pulse-slow"
            style={{ boxShadow: '0 0 6px #C8821C' }}
          />
          <span className="font-body text-[10px] uppercase tracking-[0.14em] text-muted">
            Scanning…
          </span>
        </div>
      ) : (
        <div>
          {opps.map((opp) => {
            const isPositive = !opp.expected_return?.startsWith('-');
            const retColor   = isPositive ? 'text-mint-deep' : 'text-coral-ink';
            const typeLabel  = TYPE_LABELS[opp.type] ?? opp.type?.toUpperCase();

            return (
              <div
                key={opp.id}
                className={`px-3 py-2.5 border-b border-line last:border-b-0 transition-colors duration-500 ${
                  flash ? 'bg-mint/[0.04]' : 'bg-transparent'
                }`}
              >
                {/* Title row */}
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <span className="font-body text-[11px] text-ink leading-snug truncate flex-1 min-w-0">
                    {opp.title}
                  </span>
                  <span className={`font-mono text-[11px] tabular-nums shrink-0 ${retColor}`}>
                    {opp.expected_return}
                  </span>
                </div>

                {/* Chips row */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {opp.platform_a && <Chip name={opp.platform_a} />}
                  {opp.platform_b && opp.platform_b !== opp.platform_a && (
                    <Chip name={opp.platform_b} />
                  )}
                  {typeLabel && (
                    <span className="font-body text-[9px] uppercase tracking-[0.06em] text-muted ml-auto">
                      {typeLabel}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer */}
      {!loading && !stale && (
        <div className="px-3 py-1.5 border-t border-line mt-auto">
          <span className="font-body text-[9px] uppercase tracking-[0.1em] text-muted">
            Auto-refresh 20s
          </span>
        </div>
      )}
    </div>
  );
}

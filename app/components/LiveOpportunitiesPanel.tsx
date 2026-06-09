'use client';

import { useEffect, useRef, useState } from 'react';

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
  Polymarket:            'bg-accent/10 text-accent-bright border-accent/20',
  Kalshi:                'bg-positive/10 text-positive border-positive/20',
  PredictIt:             'bg-negative/10 text-negative border-negative/20',
  Manifold:              'bg-warning/10 text-warning border-warning/20',
  'Binance Spot':        'bg-warning/10 text-warning border-warning/20',
  'Binance BTC-PERP':    'bg-warning/10 text-warning border-warning/20',
  'Binance ETH-PERP':    'bg-warning/10 text-warning border-warning/20',
  'Coinbase Spot':       'bg-blue-400/10 text-blue-400 border-blue-400/20',
  'CME BTC Quarterly':   'bg-text-muted/10 text-text-secondary border-border',
};

function Chip({ name }: { name: string }) {
  const cls = CHIP_COLORS[name] ?? 'bg-bg-elevated text-text-secondary border-border';
  return (
    <span className={`inline-block px-1.5 py-[2px] font-mono text-[9px] uppercase tracking-[0.06em] border ${cls} leading-none`}>
      {name}
    </span>
  );
}

function SkeletonRow() {
  return (
    <div className="px-3 py-3 border-b border-border last:border-b-0">
      <div className="h-2.5 w-4/5 bg-bg-elevated animate-pulse mb-2" />
      <div className="flex gap-1.5 items-center">
        <div className="h-4 w-16 bg-bg-elevated animate-pulse" />
        <div className="h-4 w-14 bg-bg-elevated animate-pulse" />
        <div className="ml-auto h-2.5 w-12 bg-bg-elevated animate-pulse" />
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
  const [opps, setOpps]           = useState<Opp[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string>('--:--:--');
  const [flash, setFlash]         = useState(false);
  const prevIds                   = useRef<string>('');

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

      setOpps(list);
      setUpdatedAt(fmtTime(new Date()));
      setError(list.length === 0);
    } catch {
      setError(true);
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
    <div className="bg-bg-panel border border-border flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-positive animate-pulse-slow shrink-0"
            style={{ boxShadow: '0 0 4px #22C55E' }}
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
            Live Opportunities
          </span>
        </div>
        <span className="font-mono text-[10px] tabular-nums text-text-muted">{updatedAt}</span>
      </div>

      {/* Body */}
      {loading ? (
        <div>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <span
            className="inline-block w-2 h-2 rounded-full bg-warning animate-pulse-slow"
            style={{ boxShadow: '0 0 6px #F59E0B' }}
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
            Scanning…
          </span>
        </div>
      ) : (
        <div>
          {opps.map((opp, i) => {
            const isPositive = !opp.expected_return?.startsWith('-');
            const retColor   = isPositive ? 'text-positive' : 'text-negative';
            const typeLabel  = TYPE_LABELS[opp.type] ?? opp.type?.toUpperCase();

            return (
              <div
                key={opp.id}
                className={`px-3 py-2.5 border-b border-border last:border-b-0 transition-colors duration-500 ${
                  flash ? 'bg-accent/[0.04]' : 'bg-transparent'
                }`}
              >
                {/* Title row */}
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <span className="font-sans text-[11px] text-text-primary leading-snug truncate flex-1 min-w-0">
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
                    <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-text-muted ml-auto">
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
      {!loading && !error && (
        <div className="px-3 py-1.5 border-t border-border mt-auto">
          <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-text-muted">
            Auto-refresh 20s
          </span>
        </div>
      )}
    </div>
  );
}

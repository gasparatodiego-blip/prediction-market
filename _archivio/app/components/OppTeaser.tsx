'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { OppPreviewItem } from '@/app/api/opps-preview/route';
import CollectionStoppedNote from '@/app/components/CollectionStoppedNote';

const SHOW_COUNT = 8;

interface PreviewData {
  items:       OppPreviewItem[];
  total:       number;
  generatedAt: number;
  updatedAt?:  number | string | null;
  stale?:      boolean;
}

const TYPE_CLS: Record<string, string> = {
  'Funding Rate':   'bg-mint-deep/10 text-mint-deep border-mint-deep/25',
  'Cash & Carry':   'bg-violet/10 text-violet/80 border-violet/25',
  'Prediction Arb': 'bg-gold/10 text-gold/80 border-gold/25',
};

function OppRow({ item, rank }: { item: OppPreviewItem; rank: number }) {
  const badge = TYPE_CLS[item.type] ?? 'bg-line/50 text-muted border-line';
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3 border-b border-line last:border-b-0">
      <span className="font-mono text-[9px] text-muted/40 w-4 shrink-0 tabular-nums">#{rank}</span>
      <span className={`font-body text-[8px] uppercase tracking-wider border px-1.5 py-[2px] shrink-0 rounded-sm ${badge}`}>
        {item.type}
      </span>
      <span className="font-body text-[11px] text-ink flex-1 truncate min-w-0">
        {item.label}
      </span>
      <span className="font-body text-[9px] text-muted/60 shrink-0 hidden sm:block truncate max-w-[140px]">
        {item.venue}
      </span>
      <span className="font-mono text-[15px] font-semibold text-mint-deep tabular-nums shrink-0">
        +{item.netPct.toFixed(1)}<span className="text-[10px] font-normal text-mint-deep/70 ml-0.5">{item.unit}</span>
      </span>
    </div>
  );
}

export default function OppTeaser() {
  const [data, setData] = useState<PreviewData | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/opps-preview?_=${Date.now()}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {}
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) {
    return (
      <div className="border border-line overflow-hidden rounded-card">
        <div className="px-4 py-2.5 border-b border-line bg-bg-soft flex items-center justify-between">
          <span className="font-body text-[9px] uppercase tracking-widest text-muted">LIVE OPPORTUNITIES</span>
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 border-b border-line bg-surface last:border-b-0 animate-pulse" />
        ))}
      </div>
    );
  }

  // Collection stopped: the route drops frozen legs and flags `stale`. Show the honest stopped note
  // in place of the teaser rows — never a frozen number and never the fresh-empty "Scanner" copy.
  if (data.stale) {
    return (
      <div className="border border-line bg-surface px-5 py-8 text-center rounded-card">
        <CollectionStoppedNote asOf={data.updatedAt ?? null} />
      </div>
    );
  }

  if (data.items.length === 0) {
    return (
      <div className="border border-line bg-surface px-5 py-8 text-center rounded-card">
        <div className="font-body text-[11px] text-muted mb-2">NO LIVE OPPORTUNITIES RIGHT NOW</div>
        <div className="font-body text-[9px] text-muted/50">Scanner is watching — rates update every 60 s</div>
      </div>
    );
  }

  const shown      = data.items.slice(0, SHOW_COUNT);
  const remaining  = data.total - shown.length;

  return (
    <div>
      <div className="border border-line overflow-hidden rounded-card shadow-card">
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-line bg-bg-soft flex items-center justify-between gap-4">
          <span className="font-body text-[9px] uppercase tracking-widest text-muted">LIVE OPPORTUNITIES</span>
          <span className="font-mono text-[9px] text-muted/60 tabular-nums">
            {data.total} found · ranked by net %
          </span>
        </div>

        {/* All shown rows — fully visible, no blur */}
        {shown.map((item, i) => (
          <OppRow key={item.id} item={item} rank={i + 1} />
        ))}

        {/* Footer: link to full list */}
        <div className="border-t border-line px-4 py-3 bg-bg-soft">
          <Link
            href="/dashboard/prediction"
            className="inline-flex items-center gap-1.5 font-body text-[10px] text-mint hover:text-mint-deep transition-colors"
          >
            See all {data.total} opportunities in the dashboard
            <ArrowRight className="w-3 h-3" strokeWidth={2} />
          </Link>
          {remaining > 0 && (
            <span className="font-body text-[9px] text-muted/50 ml-3">
              (+{remaining} more not shown here)
            </span>
          )}
        </div>
      </div>

      {/* Honest Pro teaser — no fake lock, promises real future value */}
      <div className="mt-3 border border-line/50 bg-surface/60 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-card">
        <div>
          <span className="font-body text-[9px] uppercase tracking-widest text-mint/70 mr-2">PRO · COMING SOON</span>
          <span className="font-body text-[9px] text-muted">
Email alerts · priority Telegram (all strategies) · Kelly position sizing · full opportunity history
          </span>
        </div>
        <span className="font-body text-[8px] text-muted/40 border border-line/40 px-2 py-1 cursor-default shrink-0 whitespace-nowrap rounded-sm">
          Not yet available
        </span>
      </div>
    </div>
  );
}

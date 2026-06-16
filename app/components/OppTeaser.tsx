'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { OppPreviewItem } from '@/app/api/opps-preview/route';

const SHOW_COUNT = 8;

interface PreviewData {
  items:       OppPreviewItem[];
  total:       number;
  generatedAt: number;
}

const TYPE_CLS: Record<string, string> = {
  'Funding Rate':   'bg-positive/10 text-positive border-positive/25',
  'Cash & Carry':   'bg-accent/10 text-accent/80 border-accent/25',
  'Prediction Arb': 'bg-warning/10 text-warning/80 border-warning/25',
};

function OppRow({ item, rank }: { item: OppPreviewItem; rank: number }) {
  const badge = TYPE_CLS[item.type] ?? 'bg-border/50 text-text-muted border-border';
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3 border-b border-border last:border-b-0">
      <span className="font-mono text-[9px] text-text-muted/40 w-4 shrink-0 tabular-nums">#{rank}</span>
      <span className={`font-mono text-[8px] uppercase tracking-wider border px-1.5 py-[2px] shrink-0 ${badge}`}>
        {item.type}
      </span>
      <span className="font-mono text-[11px] text-text-primary flex-1 truncate min-w-0">
        {item.label}
      </span>
      <span className="font-mono text-[9px] text-text-muted/60 shrink-0 hidden sm:block truncate max-w-[140px]">
        {item.venue}
      </span>
      <span className="font-mono text-[15px] font-semibold text-positive tabular-nums shrink-0">
        +{item.netPct.toFixed(1)}<span className="text-[10px] font-normal text-positive/70 ml-0.5">{item.unit}</span>
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
      <div className="border border-border overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border bg-bg-elevated flex items-center justify-between">
          <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted">LIVE OPPORTUNITIES</span>
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 border-b border-border bg-bg-panel last:border-b-0 animate-pulse" />
        ))}
      </div>
    );
  }

  if (data.items.length === 0) {
    return (
      <div className="border border-border bg-bg-panel px-5 py-8 text-center">
        <div className="font-mono text-[11px] text-text-muted mb-2">NO LIVE OPPORTUNITIES RIGHT NOW</div>
        <div className="font-mono text-[9px] text-text-muted/50">Scanner is watching — rates update every 60 s</div>
      </div>
    );
  }

  const shown      = data.items.slice(0, SHOW_COUNT);
  const remaining  = data.total - shown.length;

  return (
    <div>
      <div className="border border-border overflow-hidden">
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-border bg-bg-elevated flex items-center justify-between gap-4">
          <span className="font-mono text-[9px] uppercase tracking-widest text-text-muted">LIVE OPPORTUNITIES</span>
          <span className="font-mono text-[9px] text-text-muted/60 tabular-nums">
            {data.total} found · ranked by net %
          </span>
        </div>

        {/* All shown rows — fully visible, no blur */}
        {shown.map((item, i) => (
          <OppRow key={item.id} item={item} rank={i + 1} />
        ))}

        {/* Footer: link to full list */}
        <div className="border-t border-border px-4 py-3 bg-bg-elevated">
          <Link
            href="/dashboard/opportunities"
            className="inline-flex items-center gap-1.5 font-mono text-[10px] text-accent hover:text-accent-bright transition-colors"
          >
            See all {data.total} opportunities in the dashboard
            <ArrowRight className="w-3 h-3" strokeWidth={2} />
          </Link>
          {remaining > 0 && (
            <span className="font-mono text-[9px] text-text-muted/50 ml-3">
              (+{remaining} more not shown here)
            </span>
          )}
        </div>
      </div>

      {/* Honest Pro teaser — no fake lock, promises real future value */}
      <div className="mt-3 border border-border/50 bg-bg-panel/60 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <span className="font-mono text-[9px] uppercase tracking-widest text-accent/70 mr-2">PRO · COMING SOON</span>
          <span className="font-mono text-[9px] text-text-muted">
            Real-time alerts · Telegram &amp; email · Kelly position sizing · full opportunity history
          </span>
        </div>
        <span className="font-mono text-[8px] text-text-muted/40 border border-border/40 px-2 py-1 cursor-default shrink-0 whitespace-nowrap">
          Not yet available
        </span>
      </div>
    </div>
  );
}

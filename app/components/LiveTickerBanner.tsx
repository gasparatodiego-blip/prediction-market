'use client';

import { useEffect, useState, useCallback } from 'react';
import type { OppPreviewItem } from '@/app/api/opps-preview/route';

const MAX_ITEMS = 14; // cap so the loop isn't too long

export default function LiveTickerBanner() {
  const [items, setItems] = useState<OppPreviewItem[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/opps-preview?_=${Date.now()}`);
      if (!res.ok) throw new Error();
      const d = await res.json();
      setItems((d.items ?? []).slice(0, MAX_ITEMS));
    } catch {}
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (items.length === 0) return null;

  // Duplicate for seamless loop: animation scrolls 0 → -50% of total width
  const doubled = [...items, ...items];

  return (
    <div
      className="overflow-hidden border-b border-border bg-bg-panel/80 py-2"
      aria-hidden  // decorative — screen readers skip this
    >
      <div className="animate-marquee flex gap-10 w-max">
        {doubled.map((item, i) => (
          <span key={i} className="inline-flex items-center gap-2 shrink-0">
            <span className="font-mono text-[8px] uppercase tracking-wider text-text-muted/50">
              {item.type}
            </span>
            <span className="font-mono text-[9px] text-text-muted/30">·</span>
            <span className="font-mono text-[9px] text-text-secondary/80">
              {item.label.length > 38 ? item.label.slice(0, 38) + '…' : item.label}
            </span>
            <span className="font-mono text-[9px] text-text-muted/30">·</span>
            <span className="font-mono text-[10px] font-semibold text-positive tabular-nums">
              +{item.netPct.toFixed(1)}{item.unit}
            </span>
            <span className="font-mono text-[8px] text-accent/30 ml-3 select-none">▸</span>
          </span>
        ))}
      </div>
    </div>
  );
}

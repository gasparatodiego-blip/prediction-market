'use client';

// Markets tab — live Polymarket markets grouped by Polymarket's OWN native
// categories (from event.tags[], via /api/poly-markets). Honest-engine: the big
// number is the market-implied YES probability (CLOB bid/ask mid or last trade),
// explicitly labelled "indicative" — it is NOT our forecast and there is NO
// edge/ROI here. Missing values render as "—", never fabricated. Empty categories
// are hidden; a selected-but-empty category shows a calm "— no active markets".
//
// Self-contained + lazily mounted (only when the Markets tab is active), so it adds
// zero cost to the Leaderboard/Bots tabs and never touches their data.

import { useEffect, useMemo, useState } from 'react';
import PlatformLogo from '@/components/PlatformLogo';
import InfoDot from '@/app/components/ui/InfoDot';
import { PlatformLink } from '@/app/components/ui/PlatformLink';
import CollectionStoppedNote from '@/app/components/CollectionStoppedNote';
import { fmtVol } from './format';

type PolyRow = {
  question: string | null;
  slug: string | null;
  impliedProb: number | null;   // 0..1 YES probability, or null
  volume24hr: number | null;
  volumeTotal: number | null;
  endDate: string | null;
  polyUrl: string | null;
};
type PolyCat = { key: string; label: string; count: number; markets: PolyRow[] };
type PolyData = {
  ok: boolean;
  platform: string;
  updatedAt: number | null;
  stale?: boolean;
  totalActive?: number;
  categories: PolyCat[];
};

function fmtEnd(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtProb(p: number | null): string {
  if (p == null || !isFinite(p)) return '—';
  return Math.round(p * 100) + '%';
}

export default function MarketsTab() {
  const [data, setData]       = useState<PolyData | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [cat, setCat]         = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch('/api/poly-markets');
        const j = (await r.json()) as PolyData;
        if (!live) return;
        setData(j);
        // default to the first (highest-priority) category with markets
        if (j?.categories?.length) setCat(prev => prev ?? j.categories[0].key);
      } catch (e: any) {
        if (live) setError(e?.message || 'Failed to load markets');
      }
    })();
    return () => { live = false; };
  }, []);

  const cats = data?.categories ?? [];
  const selected = useMemo(() => cats.find(c => c.key === cat) ?? cats[0] ?? null, [cats, cat]);
  // Collector stopped → its /tmp dump is frozen; the market-implied prices below are
  // abandoned, so we dash them and show WHEN collection last ran (never a frozen number).
  const stopped = data?.stale === true;

  // Loading / empty states — calm, never an error wall.
  if (!data && !error) {
    return (
      <div className="rounded-card border border-line bg-surface shadow-card p-8 text-center">
        <div className="font-body font-medium text-sm text-ink-2 mb-1">Loading live Polymarket markets…</div>
        <div className="font-body text-[11px] text-muted">Grouping by native category.</div>
      </div>
    );
  }

  return (
    <>
      {/* Header — honest labelling: CLOB market-implied probability, indicative. */}
      <div className="mb-3 flex items-start gap-2 p-3 rounded-card border border-[#6b46c1]/25 bg-[#6b46c1]/[0.06]">
        <PlatformLogo platform="polymarket" size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div className="font-body text-[12px] font-medium text-ink flex items-center gap-1 flex-wrap">
            Polymarket · market-implied probability
            <InfoDot term="market_implied" />
            <span className="text-muted">· indicative</span>
            <InfoDot term="indicative" />
          </div>
          <div className="font-body text-[11px] text-muted mt-0.5 leading-relaxed">
            Live prediction markets by category. Prices are CLOB bid/ask mid — not our forecast.
          </div>
          {stopped && <CollectionStoppedNote asOf={data?.updatedAt ?? null} className="mt-2" />}
        </div>
      </div>

      {/* Category chips — Polymarket's real categories; only those with ≥1 market
          (same hide-empty honesty as the leaderboard chips). */}
      {cats.length > 0 && (
        <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1 scrollbar-none">
          {cats.map(c => {
            const active = c.key === selected?.key;
            return (
              <button key={c.key} onClick={() => setCat(c.key)}
                className={[
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-button border font-body font-medium text-[11px] uppercase tracking-wide whitespace-nowrap transition-colors shrink-0',
                  active ? 'border-mint-deep/40 bg-mint-tint text-mint-deep'
                         : 'border-line text-muted hover:border-mint-deep/30 hover:text-ink-2 bg-surface',
                ].join(' ')}>
                {c.label}
                <span className={`font-body text-[9px] px-1.5 py-0.5 rounded-pill ${active ? 'bg-mint-deep/20 text-mint-deep' : 'bg-line text-muted'}`}>{c.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Rows */}
      {!selected || selected.markets.length === 0 ? (
        <div className="rounded-card border border-line bg-surface shadow-card p-8 text-center font-body text-sm text-muted">
          — no active markets
        </div>
      ) : (
        <div className="rounded-card border border-line bg-surface shadow-card overflow-hidden divide-y divide-line">
          {selected.markets.map((m, i) => {
            const pct = m.impliedProb == null ? null : Math.max(0, Math.min(100, m.impliedProb * 100));
            const vol = m.volume24hr ?? m.volumeTotal ?? null;
            const volIs24h = m.volume24hr != null;
            const row = (
              <div className="flex items-center gap-3 px-4 py-3">
                {/* Question + meta */}
                <div className="min-w-0 flex-1">
                  <div className="font-body text-[13px] text-ink leading-snug line-clamp-2">
                    {m.question || '—'}
                  </div>
                  <div className="mt-1 flex items-center gap-3 font-body text-[10.5px] text-muted">
                    <span>{stopped || vol == null ? '—' : `${fmtVol(vol)} ${volIs24h ? '24h vol' : 'vol'}`}</span>
                    <span>ends {fmtEnd(m.endDate)}</span>
                  </div>
                </div>
                {/* YES implied probability + bar — dashed (no frozen bar) once collection stopped */}
                <div className="w-[92px] shrink-0 text-right">
                  <div className="font-mono font-semibold text-[18px] text-ink tabular-nums leading-none">
                    {stopped ? '—' : fmtProb(m.impliedProb)}
                  </div>
                  <div className="font-body text-[9px] uppercase tracking-wide text-muted mt-0.5">YES</div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-line overflow-hidden">
                    {!stopped && pct != null && (
                      <div className="h-full rounded-full bg-mint-deep" style={{ width: `${pct}%` }} />
                    )}
                  </div>
                </div>
                {/* Honest source link (null → no link rendered) */}
                <div className="shrink-0">
                  {m.polyUrl
                    ? <PlatformLink href={m.polyUrl} label="Polymarket" compact />
                    : <span className="font-body text-[10px] text-muted px-1.5">—</span>}
                </div>
              </div>
            );
            // Whole row opens the honest Polymarket URL when we have one.
            return m.polyUrl ? (
              <a key={i} href={m.polyUrl} target="_blank" rel="noopener noreferrer"
                 className="block hover:bg-bg-soft transition-colors">
                {row}
              </a>
            ) : (
              <div key={i}>{row}</div>
            );
          })}
        </div>
      )}

      {/* Footer — reinforce the honest framing. */}
      <p className="mt-6 font-body text-[11px] text-muted border-t border-line pt-4 leading-relaxed">
        Prices are Polymarket&apos;s own CLOB bid/ask mid (or last trade), read as a market-implied YES probability —
        the crowd&apos;s live price, <span className="text-ink-2">not our forecast and not an edge</span>. Categories
        come from Polymarket&apos;s native event tags. Missing prices show as &ldquo;—&rdquo;. Markets are public on
        polymarket.com. Not financial advice.
      </p>
    </>
  );
}

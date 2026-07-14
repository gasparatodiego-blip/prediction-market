'use client';

// Liquidity Provider (LP) — LIGHT, professional layout matching the site pattern
// (sports / paper / traders / carry / prediction / liquidity-rewards). Previously
// the ONLY dark page. Data is intentionally THIN: this is the simulated Polymarket
// LP agent's book — 5 flat-sized paper positions, no AMM pool depth. We build ONLY
// the controls the data actually supports (2 real sorts + text search) and render
// "—" for everything the feed genuinely lacks (TVL, impermanent loss, capacity).
//
// HONEST-ENGINE:
//   • estimatedAPY is a flat run-rate assumption (the 200%/yr cap) — labeled
//     "run-rate · capped · not guaranteed", never presented as a real per-pool yield.
//   • feesEarned is genuinely $0 (simulation, nothing filled) → shown as $0
//     "none accrued", not hidden or inflated.
//   • TVL / impermanent loss / capacity are NOT in this feed → "—", never fabricated.
//   • Everything here is SIMULATION (no real trade) → prominent honest banner.
//   • Free tier: server nulls the $ fields (exposure/APY/fees/price) → <Redacted> lock.

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Search, ExternalLink, Info } from 'lucide-react';
import Eyebrow from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import StatCard from '@/app/components/ui/StatCard';
import PlatformLogo from '@/components/PlatformLogo';
import { Redacted } from '@/app/components/ui/Redacted';

// $ fields (amountUSD/estimatedAPY/feesEarned, summary totals, candidate price)
// are null on the free tier (server redaction, lib/paid-gating.ts → 'lp').
interface Position {
  marketId:     string;
  question:     string;
  source:       string;
  entryPrice:   number;
  amountUSD:    number | null;
  estimatedAPY: number | null;
  volume24h:    number;
  enteredAt:    number;
  status:       string;
  feesEarned:   number | null;
  isSimulated?: boolean;
}
interface Summary {
  totalExposure:    number | null;
  totalFees:        number | null;
  avgAPY:           number | null;
  activeCount:      number;
  maxPositions:     number;
  maxExposure:      number;
  remainingCapital: number | null;
}
interface Candidate {
  id:        string;
  question:  string;
  price:     number | null;
  volume24h: number;
  url:       string;
}

const POLL_MS = 30_000;

// ── helpers ───────────────────────────────────────────────────────────────────
function ago(ms: number): string {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}
function fmtUsd0(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

// ── sort/filter primitives ─────────────────────────────────────────────────────
type SortKey = 'volume' | 'recent';
const SORT_LABEL: Record<SortKey, string> = { volume: 'volume 24h', recent: 'most recent' };
const SORT_TITLE: Record<SortKey, string> = {
  volume: 'Polymarket 24h volume of the position market (real, public field)',
  recent: 'when the position was opened — newest first (real, public field)',
};
function sortVal(p: Position, k: SortKey): number {
  return k === 'volume' ? p.volume24h : p.enteredAt;
}

function Pill({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button onClick={onClick} title={title}
      className={['font-body text-[11px] px-2.5 py-1 rounded-button border whitespace-nowrap transition-colors',
        active ? 'text-mint-deep border-mint-deep/50 bg-mint-tint' : 'text-muted border-line bg-surface hover:text-ink-2'].join(' ')}>
      {children}
    </button>
  );
}
function DCell({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div className="rounded-lg bg-bg-soft border border-line px-2.5 py-2">
      <p className="font-body text-[9px] uppercase tracking-wide text-muted mb-0.5">{label}</p>
      <p className="font-body text-[12px] text-ink-2 tabular-nums leading-tight">{children}</p>
      {note && <p className="font-body text-[9px] text-muted/80 leading-tight mt-0.5">{note}</p>}
    </div>
  );
}
const DASH = <span className="text-muted">—</span>;

// ── explainer ───────────────────────────────────────────────────────────────
function Explainer() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      <button className="w-full flex items-center justify-between px-5 py-4 text-left" onClick={() => setOpen(v => !v)}>
        <span className="font-body font-medium text-sm text-ink-2 flex items-center gap-2"><Info size={15} className="text-muted" /> How the LP agent works (simulation)</span>
        <span className="font-body text-[11px] text-muted">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 border-t border-line">
          <p className="font-body text-[13px] text-ink-2 leading-relaxed mt-4">
            The LP-Provider agent scans Polymarket every ~5 minutes. When it finds a high-volume market priced near the
            middle (35–65¢), it opens a <span className="font-medium text-ink">simulated</span> liquidity position, sizing it with the Kelly criterion.
            This is a <span className="font-medium text-ink">paper book</span> — no real orders are placed and no capital is at risk.
          </p>
          <p className="font-body text-[12px] text-muted leading-relaxed mt-3">
            The APY shown is a flat run-rate assumption (capped, not a measured per-pool yield), fees accrued are $0 while
            simulated, and pool-depth metrics (TVL, impermanent loss, executable capacity) aren&apos;t tracked by this agent —
            those render &quot;—&quot; rather than a fabricated number.
          </p>
        </div>
      )}
    </div>
  );
}

// ── expandable position row ────────────────────────────────────────────────────
function PositionRow({ p, open, onToggle }: { p: Position; open: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-line">
      <button onClick={onToggle} className="w-full grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-3 py-2.5 text-left hover:bg-bg-soft/60 transition-colors">
        <span className="w-8 h-8 rounded-[9px] bg-bg-soft border border-line grid place-items-center shrink-0">
          <PlatformLogo platform="polymarket" size={16} />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 flex-wrap">
            <span className="font-body text-[12.5px] font-medium text-ink truncate max-w-[280px]">{p.question}</span>
            <span className="font-body text-[8.5px] uppercase tracking-wide text-mint-deep border border-mint-deep/30 bg-mint-tint rounded px-1">LIVE</span>
            <span className="font-body text-[8.5px] uppercase tracking-wide text-gold border border-gold/40 bg-gold-tint rounded px-1">sim</span>
          </span>
          <span className="font-body text-[10px] text-muted truncate block">
            {p.source} · entry {p.entryPrice}¢ · opened {ago(p.enteredAt)} · vol {fmtUsd(p.volume24h)}
          </span>
        </span>
        <span className="text-right tabular-nums shrink-0">
          <span className="block font-display font-bold text-mint-deep" style={{ fontSize: 15 }}>
            <Redacted value={p.estimatedAPY}>{v => `${(v as number).toFixed(0)}%`}</Redacted>
          </span>
          <span className="block font-body text-[8.5px] uppercase tracking-wide text-muted mt-0.5">APY · run-rate · not guaranteed</span>
        </span>
        <ChevronRight className={`w-3.5 h-3.5 text-muted shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="px-3 pb-3 pt-0.5 bg-bg-soft/40">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            <DCell label="Venue">Polymarket</DCell>
            <DCell label="Entry price">{p.entryPrice}¢</DCell>
            <DCell label="Exposure" note="simulated sizing (Kelly)">
              <span className="text-mint-deep"><Redacted value={p.amountUSD}>{v => fmtUsd0(v as number)}</Redacted></span>
            </DCell>
            <DCell label="Est. APY" note="run-rate · capped · not guaranteed">
              <span className="text-mint-deep"><Redacted value={p.estimatedAPY}>{v => `${(v as number).toFixed(0)}%/yr`}</Redacted></span>
            </DCell>
            <DCell label="Fees earned" note="none accrued (simulation)">
              <Redacted value={p.feesEarned}>{v => (v as number) === 0 ? '$0' : fmtUsd0(v as number)}</Redacted>
            </DCell>
            <DCell label="Volume 24h">{fmtUsd0(p.volume24h)}</DCell>
            <DCell label="Opened">{new Date(p.enteredAt).toLocaleDateString('en-GB')}<span className="text-muted"> · {ago(p.enteredAt)}</span></DCell>
            <DCell label="Status"><span className="text-mint-deep">● active</span></DCell>
            <DCell label="Pool TVL" note="not tracked by this agent">{DASH}</DCell>
            <DCell label="Impermanent loss" note="n/a · binary market">{DASH}</DCell>
            <DCell label="Capacity" note="no book depth in feed">{DASH}</DCell>
            <DCell label="Market ID"><span className="text-[10px]">{p.marketId}</span></DCell>
          </div>
          <div className="rounded-lg bg-surface border border-line px-3 py-2 mt-1.5">
            <p className="font-body text-[11px] text-muted leading-snug">
              Simulated position — opened when the market sat in the 35–65¢ balance band with high volume. No real order was
              placed; APY is an assumed run-rate, not a realized return. Pool-depth metrics aren&apos;t available for this book.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── page ────────────────────────────────────────────────────────────────────
export default function LPDashboard() {
  const [positions, setPositions]   = useState<Position[]>([]);
  const [summary, setSummary]       = useState<Summary | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading]       = useState(true);
  const [lastFetch, setLastFetch]   = useState<Date | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>('volume');
  const [query, setQuery]     = useState('');
  const [openId, setOpenId]   = useState<string | null>(null);

  const fetchData = async () => {
    try {
      const res  = await fetch('/api/lp', { cache: 'no-store' });
      const data = await res.json();
      if (data.success) {
        setPositions(data.positions ?? []);
        setSummary(data.summary ?? null);
        setCandidates(data.candidates ?? []);
        setLastFetch(new Date());
      }
    } catch (err) {
      console.error('Error fetching LP data:', err);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { fetchData(); const id = setInterval(fetchData, POLL_MS); return () => clearInterval(id); }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = positions.filter(p => !q || p.question.toLowerCase().includes(q));
    return list.slice().sort((a, b) => sortVal(b, sortKey) - sortVal(a, sortKey)); // both sorts are desc (biggest vol / newest)
  }, [positions, query, sortKey]);

  return (
    <div className="min-h-screen" style={{ background: 'radial-gradient(circle at 50% -10%, rgba(15,190,130,.05), transparent 60%), #F5F8F6' }}>
      <div className="dash-container px-4 py-6 sm:py-8 space-y-6">

        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow className="mb-1">Liquidity Provider</Eyebrow>
            <SectionHeading as="h1" className="text-xl sm:text-2xl flex items-center gap-3 flex-wrap">
              <PlatformLogo platform="polymarket" size={20} />
              Polymarket LP book
            </SectionHeading>
            <p className="font-body text-sm text-muted mt-1">
              The LP-Provider agent&apos;s simulated positions in balanced, high-volume Polymarket markets. Paper book — no real capital, no orders placed.
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1.5 font-body font-medium text-xs text-mint-deep border border-mint-deep/30 bg-mint-tint px-2.5 py-1 rounded-pill">
              <span className="w-1.5 h-1.5 rounded-full bg-mint" aria-hidden /> LIVE
            </span>
            <span className="font-body text-[12px] text-muted">{lastFetch ? `fetched ${ago(lastFetch.getTime())}` : '—'}</span>
          </div>
        </div>

        {/* Simulation banner — honest, prominent */}
        <div className="px-4 py-3 rounded-card border border-gold/25 bg-gold-tint font-body text-sm text-gold flex items-center gap-2">
          <Info size={16} className="shrink-0" />
          <span><b>Simulation mode</b> — every position below is paper. No real trade is executed; APY is an assumed run-rate and fees accrued are $0.</span>
        </div>

        <Explainer />

        {/* Hero stats */}
        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <StatCard label="Active positions" value={`${summary.activeCount}/${summary.maxPositions}`} note="paper book" />
            <StatCard label="Total exposure" value={<Redacted value={summary.totalExposure}>{v => fmtUsd0(v as number)}</Redacted>} demoted="simulated capital" />
            <StatCard label="Avg APY" value={<Redacted value={summary.avgAPY}>{v => `${v}%`}</Redacted>} demoted="run-rate · not guaranteed" />
            <StatCard label="Fees accrued" value={<Redacted value={summary.totalFees}>{v => fmtUsd0(v as number)}</Redacted>} demoted="none in simulation" />
            <StatCard label="Remaining capital" value={<Redacted value={summary.remainingCapital}>{v => fmtUsd0(v as number)}</Redacted>} demoted={`of ${fmtUsd0(summary.maxExposure)} cap`} />
          </div>
        )}

        {/* Positions */}
        <div>
          <SectionHeading as="h2" className="text-lg mb-1">Active LP positions</SectionHeading>
          <p className="font-body text-sm text-muted mb-3">Simulated positions in the 35–65¢ balance band. Tap a row for the full breakdown.</p>

          {/* Sort pills + search (only controls the thin data supports) */}
          {positions.length > 0 && (
            <>
              <div className="flex items-center gap-3 flex-wrap mb-2">
                <span className="font-body text-[10px] uppercase tracking-wide text-muted">Sort</span>
                {(Object.keys(SORT_LABEL) as SortKey[]).map(k => (
                  <button key={k} onClick={() => setSortKey(k)} title={SORT_TITLE[k]}
                    className={['font-body text-[11px] uppercase tracking-wide pb-0.5 border-b-2 transition-colors', sortKey === k ? 'text-ink border-[#0c9d6e]' : 'text-muted border-transparent hover:text-ink-2'].join(' ')}>
                    {SORT_LABEL[k]}
                  </button>
                ))}
                <label className="flex items-center gap-1.5 ml-auto rounded-button border border-line bg-surface px-2 py-1">
                  <Search size={13} className="text-muted" />
                  <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search market…"
                    className="font-body text-[11px] text-ink bg-transparent focus:outline-none w-32 sm:w-44 placeholder:text-muted" />
                </label>
                <span className="font-body text-[10px] text-muted tabular-nums">{shown.length} of {positions.length}</span>
              </div>

              {/* Column header */}
              <div className="grid grid-cols-[auto_1fr_auto_auto] gap-3 px-3 pb-1.5 text-[9px] uppercase tracking-wider text-muted border-b border-line">
                <span className="w-8" aria-hidden />
                <span>Market</span>
                <span className="text-right">APY · run-rate</span>
                <span className="w-3.5" aria-hidden />
              </div>
            </>
          )}

          {/* Rows */}
          <div className="rounded-b-lg overflow-hidden bg-surface border-x border-b border-line shadow-card">
            {loading ? (
              <p className="font-body text-[12px] text-muted text-center py-10">Loading LP positions…</p>
            ) : positions.length === 0 ? (
              <div className="text-center py-12">
                <div className="text-3xl mb-2">📭</div>
                <p className="font-body text-sm text-ink-2">No active LP positions</p>
                <p className="font-body text-[12px] text-muted mt-1">The agent opens simulated positions when it finds a balanced, high-volume market.</p>
              </div>
            ) : shown.length === 0 ? (
              <div className="text-center py-10">
                <p className="font-body text-sm text-muted">No positions match &quot;{query}&quot;.</p>
                <button onClick={() => setQuery('')} className="font-body text-[12px] text-mint-deep underline mt-2">clear search</button>
              </div>
            ) : (
              shown.map(p => (
                <PositionRow key={p.marketId} p={p} open={openId === p.marketId} onToggle={() => setOpenId(openId === p.marketId ? null : p.marketId)} />
              ))
            )}
          </div>
        </div>

        {/* Candidates */}
        {candidates.length > 0 && (
          <div>
            <SectionHeading as="h2" className="text-lg mb-1">Candidate markets</SectionHeading>
            <p className="font-body text-sm text-muted mb-3">High-volume Polymarket markets in the balance band the agent may open next.</p>
            <div className="rounded-card overflow-hidden bg-surface border border-line shadow-card divide-y divide-line">
              {candidates.map(c => (
                <div key={c.id} className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-bg-soft/60 transition-colors">
                  <div className="min-w-0">
                    <p className="font-body text-[13px] font-medium text-ink truncate">{c.question}</p>
                    <div className="flex gap-3 mt-0.5 font-body text-[11px] text-muted">
                      <span>price <Redacted value={c.price}>{v => `${v}¢`}</Redacted></span>
                      <span>vol 24h {fmtUsd0(c.volume24h)}</span>
                    </div>
                  </div>
                  {c.url && (
                    <a href={c.url} target="_blank" rel="noopener noreferrer"
                      className="shrink-0 inline-flex items-center gap-1 font-body text-[11px] text-mint-deep hover:text-mint transition-colors">
                      View <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="pt-2 border-t border-line space-y-1">
          <p className="font-body text-[11px] text-muted/60 leading-relaxed">
            Simulation only. APY is a flat run-rate assumption (capped), never a realized or guaranteed return. Fees accrued are
            $0 while simulated. Pool TVL, impermanent loss and executable capacity aren&apos;t tracked by this agent and show &quot;—&quot;. Not financial advice.
          </p>
          <p className="font-body text-[11px] text-muted/60">Read-only. No orders placed. Live execution OFF. No login required.</p>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronRight, Landmark, Trophy, Bitcoin, TrendingUp, CloudSun, Search, ShieldCheck, Send, Copy, Check } from 'lucide-react';
import Eyebrow from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import StatCard from '@/app/components/ui/StatCard';
import EdgeChip, { type EdgeChipVariant } from '@/app/components/ui/EdgeChip';
import { Redacted } from '@/app/components/ui/Redacted';
import EventCard, { arbRank, arbBadge } from './_components/EventCard';
import { platformLabel, formatCents, formatResolutionDate } from './_components/format';
import type { Freshness, Opportunity, EventBucket, ApiResponse, Leg } from './_components/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function CategoryIcon({ category, size = 18 }: { category: string; size?: number }) {
  const c = category?.toLowerCase() ?? '';
  if (c.includes('politic') || c.includes('election')) return <Landmark size={size} />;
  if (c.includes('sport')   || c.includes('nfl') || c.includes('nba')) return <Trophy size={size} />;
  if (c.includes('crypto')  || c.includes('bitcoin') || c.includes('btc')) return <Bitcoin size={size} />;
  if (c.includes('finance') || c.includes('econ')) return <TrendingUp size={size} />;
  if (c.includes('weather')) return <CloudSun size={size} />;
  return <Search size={size} />;
}

// Relative time string for a scan timestamp — "just now" / "12s ago" / "5m ago" / "2h ago".
function relativeTime(ts: number | null | undefined): string {
  if (!ts) return 'unknown';
  const ms = Date.now() - ts;
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

function chipVariant(opp: Opportunity): EdgeChipVariant {
  if (opp.type === 'cashable') return 'cashable';
  const reason = opp.nonCashableReason;
  if (reason === 'stage_mismatch') return 'trap';
  if (reason === 'play_money')     return 'paper';
  return 'signal';
}

function reasonNote(opp: Opportunity): string | null {
  if (opp.type === 'cashable') return null;
  const reason = opp.nonCashableReason;
  if (reason === 'play_money')     return 'mid-price or play money — signal only';
  if (reason === 'stage_mismatch') return 'resolution criteria differ';
  if (reason === 'low_confidence') return opp.confidenceNote
    ? `confidence ${opp.confidenceNote}`
    : 'confidence below threshold';
  if (reason === 'small_capacity') return opp.capacityNote
    ? `capacity ${opp.capacityNote}`
    : 'capacity below minimum';
  return 'spread collapses at executable depth';
}

function nextCheckMin(freshness: Freshness | null): number {
  if (!freshness?.nextDiscoveryAt) return 180;
  return Math.max(1, Math.round((freshness.nextDiscoveryAt - Date.now()) / 60_000));
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function CardSkeleton() {
  return (
    <div className="rounded-card shadow-card bg-surface px-5 py-5 animate-pulse">
      <div className="h-3 w-24 bg-bg-soft rounded mb-3" />
      <div className="h-8 w-16 bg-bg-soft rounded" />
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="rounded-card shadow-card bg-surface px-4 py-3 animate-pulse flex items-center gap-3">
      <div className="w-10 h-10 bg-bg-soft rounded-[11px] flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-3 bg-bg-soft rounded w-3/4" />
        <div className="h-2.5 bg-bg-soft rounded w-1/2" />
      </div>
      <div className="w-12 h-5 bg-bg-soft rounded" />
    </div>
  );
}

// ── Filter-rich opportunity list (new pattern: pills · sort · expandable rows) ──
// Every sort/filter ranks on a REAL served field. Volume is NOT a per-pair field
// → that sort is omitted. Derived $ (roi/spread/prob/capacity) stay <Redacted> on
// the free tier. Prediction arb is ONE-TIME → total ROI + unlock date, never $/day.
type PredSort = 'edge' | 'unlock' | 'capacity';
const PRED_SORT_LABEL: Record<PredSort, string> = { edge: 'edge / ROI', unlock: 'unlock (soonest)', capacity: 'capacity' };
const PRED_SORT_TITLE: Record<PredSort, string> = {
  edge:     'total ROI (cashable) / spread (signal) — one-time, gated on free tier',
  unlock:   'days to resolution — soonest first (public field)',
  capacity: 'executable size estimate — gated on free tier',
};
function predSortVal(o: Opportunity, k: PredSort): number | null {
  if (k === 'unlock')   return o.daysToResolution ?? null;
  if (k === 'capacity') return o.capacityUsd ?? null;
  return o.type === 'cashable' ? (o.roi ?? null) : (o.spread ?? null); // edge
}
// near-zero flag — either leg's implied prob <3% or >97% (edge is liquidity/rounding
// noise). probability is gated on free → flag only surfaces for paid.
function nearZero(o: Opportunity): boolean {
  return [o.lowMarket.probability, o.highMarket.probability]
    .filter((p): p is number => p != null).some(p => p < 3 || p > 97);
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
function DCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-bg-soft border border-line px-2.5 py-2">
      <p className="font-body text-[9px] uppercase tracking-wide text-muted mb-0.5">{label}</p>
      <p className="font-body text-[12px] text-ink-2 tabular-nums leading-tight">{children}</p>
    </div>
  );
}

function OppRowExpandable({ opp, open, onToggle }: { opp: Opportunity; open: boolean; onToggle: () => void }) {
  const variant  = chipVariant(opp);
  const cashable = opp.type === 'cashable';
  const nz       = nearZero(opp);
  const edge     = cashable ? opp.roi : opp.spread;
  const dash     = <span className="text-muted">—</span>;
  const legP = (l: Leg): number | null => l.probability;   // implied YES % (gated)
  return (
    <div className="border-b border-line">
      <button onClick={onToggle} className="w-full grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 px-3 py-2.5 text-left hover:bg-bg-soft/60 transition-colors">
        <span className="w-8 h-8 rounded-[9px] bg-bg-soft border border-line grid place-items-center shrink-0"><CategoryIcon category={opp.category} size={15} /></span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 flex-wrap">
            <span className="font-body text-[12.5px] font-medium text-ink truncate max-w-[240px]">{opp.question}</span>
            <EdgeChip variant={variant} />
            {nz && <span className="font-body text-[8.5px] uppercase tracking-wide text-gold border border-gold/40 rounded px-1">near-zero</span>}
          </span>
          <span className="font-body text-[10px] text-muted truncate block">
            {platformLabel(opp.lowMarket.platform)} × {platformLabel(opp.highMarket.platform)}
            {opp.resolutionDate ? ` · unlock ${formatResolutionDate(opp.resolutionDate)}` : opp.daysToResolution != null ? ` · ${opp.daysToResolution}d to resolve` : ''}
          </span>
        </span>
        <span className="text-right tabular-nums shrink-0">
          <span className={`block font-body text-[13px] font-semibold ${cashable ? 'text-mint-deep' : 'text-violet'}`}>
            <Redacted value={edge}>{v => `${cashable ? '+' : ''}${(v as number).toFixed(cashable ? 2 : 1)}%`}</Redacted>
          </span>
          <span className="block font-body text-[8.5px] uppercase tracking-wide text-muted">{cashable ? 'total ROI · one-time' : 'spread · signal'}</span>
        </span>
        <ChevronRight className={`w-3.5 h-3.5 text-muted shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-0.5 bg-bg-soft/40">
          {!cashable && (
            <div className="rounded-lg bg-violet-tint/60 border border-violet/20 px-3 py-1.5 mb-1.5">
              <p className="font-body text-[11px] text-violet leading-snug">Indicative, not cashable — {reasonNote(opp) ?? 'signal only'}. Never counted as a locked return.</p>
            </div>
          )}
          {nz && (
            <div className="rounded-lg bg-gold-tint border border-gold/25 px-3 py-1.5 mb-1.5">
              <p className="font-body text-[11px] text-gold leading-snug">Near-zero price (a leg &lt;3% or &gt;97%) — the edge here is largely liquidity/rounding noise.</p>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            <DCell label={`Leg 1 · ${platformLabel(opp.lowMarket.platform)}`}>YES <Redacted value={legP(opp.lowMarket)}>{v => `${(v as number).toFixed(0)}%`}</Redacted></DCell>
            <DCell label={`Leg 2 · ${platformLabel(opp.highMarket.platform)}`}>YES <Redacted value={legP(opp.highMarket)}>{v => `${(v as number).toFixed(0)}%`}</Redacted></DCell>
            <DCell label={cashable ? 'Total ROI (one-time)' : 'Spread (signal)'}><span className={cashable ? 'text-mint-deep' : 'text-violet'}><Redacted value={edge}>{v => `${cashable ? '+' : ''}${(v as number).toFixed(2)}%`}</Redacted></span></DCell>
            <DCell label="Unlock / resolves">{opp.resolutionDate ? formatResolutionDate(opp.resolutionDate) : dash}{opp.daysToResolution != null && <span className="text-muted"> · {opp.daysToResolution}d</span>}</DCell>
            <DCell label="Confidence"><Redacted value={opp.confidence}>{v => `${Math.round((v as number) * 100)}%`}</Redacted></DCell>
            <DCell label="Volume">{dash}<span className="text-muted"> · not stored</span></DCell>
            <DCell label="Capacity"><Redacted value={opp.capacityUsd}>{v => `$${Math.round(v as number).toLocaleString()}`}</Redacted><span className="text-muted"> · exec size</span></DCell>
            <DCell label="Label">{cashable ? 'Cashable' : 'Signal-only'}</DCell>
          </div>
          <div className="rounded-lg bg-surface border border-line px-3 py-2 mt-1.5">
            <p className="font-body text-[9px] uppercase tracking-wide text-muted mb-1">How it resolves</p>
            <p className="font-body text-[11.5px] text-ink-2 leading-snug">
              {cashable
                ? <>Buy YES on <b>{platformLabel(opp.lowMarket.platform)}</b>, buy NO on <b>{platformLabel(opp.highMarket.platform)}</b>. Settles <b>once</b> at resolution ({opp.resolutionDate ? formatResolutionDate(opp.resolutionDate) : 'date —'}) → total ROI <Redacted value={opp.roi}>{v => `+${(v as number).toFixed(2)}%`}</Redacted>, one-time (not a per-day yield).</>
                : <>{reasonNote(opp) ?? 'Divergence only'}. {opp.settlementType === 'one_time' ? 'Would settle once at resolution' : 'Settlement —'} — shown as an indicative signal, never a cashable claim.</>}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const INITIAL_EVENTS_SHOWN = 12;

// Lockable-edge-first, highest-ROI-first — the comparator leads with the events
// that actually have an executable pair, same ordering rule as the existing
// pairwise list below.
// Events WITH a live ARB badge surface to the TOP (real arb 3 > wide "check" 2 >
// raw-edge 1 > none 0 — the SAME guarded logic the card badge uses, so ordering
// and badge can never disagree), then by real edge % desc. On the free tier every
// lockableEdge is gated null → arbRank 0 for all → order is unchanged (honest).
function sortEvents(events: EventBucket[]): EventBucket[] {
  return [...events].sort((a, b) => {
    const ar = arbRank(a), br = arbRank(b);
    if (ar !== br) return br - ar;
    const ae = arbBadge(a)?.edgePct ?? a.lockableEdge?.matchedOpportunity?.roi ?? -Infinity;
    const be = arbBadge(b)?.edgePct ?? b.lockableEdge?.matchedOpportunity?.roi ?? -Infinity;
    return be - ae;
  });
}

export default function PredictionPage() {
  const [data,         setData]         = useState<ApiResponse | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [fetchedAt,    setFetchedAt]    = useState<Date | null>(null);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [copiedSignal, setCopiedSignal] = useState(false);

  // filter/sort state for the pairwise list — initialized from URL, mirrored back.
  const qp0 = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const [sortKey, setSortKey] = useState<PredSort>((['unlock', 'capacity'].includes(qp0.get('sort') ?? '') ? qp0.get('sort') : 'edge') as PredSort);
  const [typeF,  setTypeF]    = useState(qp0.get('type') ?? '');   // '' | 'cashable' | 'signal'
  const [venueF, setVenueF]   = useState(qp0.get('venue') ?? '');
  const [catF,   setCatF]     = useState(qp0.get('cat') ?? '');
  const [resWin, setResWin]   = useState<number | null>(() => { const n = Number(qp0.get('res')); return Number.isFinite(n) && n > 0 ? n : null; });
  const [minRoi, setMinRoi]   = useState(() => { const n = Number(qp0.get('minRoi')); return Number.isFinite(n) && n > 0 ? n : 0; });
  const [openId, setOpenId]   = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const res  = await fetch('/api/prediction');
      const json: ApiResponse = await res.json();
      setData(json);
      setFetchedAt(new Date());
    } catch {
      // keep previous data on transient error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const t = setInterval(loadData, 30_000);
    return () => clearInterval(t);
  }, [loadData]);

  const stats     = data?.stats;
  const opps      = data?.valid ?? [];
  const events    = data?.events ?? [];
  const freshness = data?.freshness ?? null;
  const isStale   = freshness?.repriceStale || freshness?.discoveryStale;

  const sortedEvents = useMemo(() => sortEvents(events), [events]);

  // mirror filter state → URL (replaceState, no history spam)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams();
    if (sortKey !== 'edge') p.set('sort', sortKey);
    if (typeF)  p.set('type', typeF);
    if (venueF) p.set('venue', venueF);
    if (catF)   p.set('cat', catF);
    if (resWin) p.set('res', String(resWin));
    if (minRoi > 0) p.set('minRoi', String(minRoi));
    const qs = p.toString();
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [sortKey, typeF, venueF, catF, resWin, minRoi]);

  // real facets present in the served pairs (never a hardcoded menu)
  const venues = useMemo(() => Array.from(new Set(opps.flatMap(o => [o.lowMarket.platform, o.highMarket.platform]))).sort(), [opps]);
  const cats   = useMemo(() => Array.from(new Set(opps.map(o => o.category).filter(c => c && c !== 'unknown'))).sort(), [opps]);

  // filtered + sorted pairwise list. Gated-field filters (minRoi) only EXCLUDE
  // visible (paid) rows — free tier can't hide behind data it can't see (honest).
  const shownOpps = useMemo(() => {
    const list = opps.filter(o => {
      if (typeF && o.type !== typeF) return false;
      if (venueF && o.lowMarket.platform !== venueF && o.highMarket.platform !== venueF) return false;
      if (catF && o.category !== catF) return false;
      if (resWin != null && (o.daysToResolution == null || o.daysToResolution > resWin)) return false;
      if (minRoi > 0 && o.type === 'cashable' && o.roi != null && o.roi < minRoi) return false; // visible-only
      return true;
    });
    const asc = sortKey === 'unlock';
    return list.slice().sort((a, b) => {
      const av = predSortVal(a, sortKey), bv = predSortVal(b, sortKey);
      if (av == null && bv == null) { /* fall through to cashable-first */ }
      else if (av == null) return 1;
      else if (bv == null) return -1;
      else { const d = asc ? av - bv : bv - av; if (d !== 0) return d; }
      return a.type !== b.type ? (a.type === 'cashable' ? -1 : 1) : 0; // tiebreak: cashable first
    });
  }, [opps, typeF, venueF, catF, resWin, minRoi, sortKey]);
  const filtersActive = !!(typeF || venueF || catF || resWin || minRoi);
  const resetFilters = () => { setTypeF(''); setVenueF(''); setCatF(''); setResWin(null); setMinRoi(0); };

  // Best available signal to copy — leads with a matched event edge (has real
  // ROI + resolution date), falls back to the top pairwise cashable pair.
  const topSignalText = useMemo(() => {
    const bestEvent = sortedEvents.find(e => e.lockableEdge?.matchedOpportunity);
    if (bestEvent?.lockableEdge?.matchedOpportunity) {
      const edge = bestEvent.lockableEdge;
      const mo   = edge.matchedOpportunity!;
      return `${bestEvent.title}\n` +
        `Buy YES @ ${formatCents(edge.yesPrice)} on ${platformLabel(edge.yesPlatform)}\n` +
        `Buy NO @ ${formatCents(edge.noPrice)} on ${platformLabel(edge.noPlatform)}\n` +
        `Total ROI: ${mo.roi.toFixed(2)}% · one-time · unlock ${formatResolutionDate(mo.resolutionDate)}`;
    }
    const bestOpp = opps.find(o => o.type === 'cashable' && o.roi != null);
    if (bestOpp && bestOpp.roi != null) {
      return `${bestOpp.question}\n` +
        `Buy YES on ${platformLabel(bestOpp.lowMarket.platform)} · buy NO on ${platformLabel(bestOpp.highMarket.platform)}\n` +
        `Total ROI: ${bestOpp.roi.toFixed(2)}%`;
    }
    return null;
  }, [sortedEvents, opps]);

  const copySignal = useCallback(async () => {
    if (!topSignalText) return;
    try {
      await navigator.clipboard.writeText(topSignalText);
      setCopiedSignal(true);
      setTimeout(() => setCopiedSignal(false), 1500);
    } catch {}
  }, [topSignalText]);

  return (
    <div className="dash-container px-4 py-8">

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <Eyebrow className="mb-1">Prediction Markets</Eyebrow>
          <SectionHeading as="h1" className="text-2xl">
            Cross-Platform Arbitrage
          </SectionHeading>
          <p className="font-body text-sm text-muted mt-1">
            Polymarket · Kalshi · PredictIt · Manifold — AI-confirmed pairs, fee-adjusted net ROI
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={copySignal}
            disabled={!topSignalText}
            className="inline-flex items-center gap-1.5 font-body font-medium text-sm px-4 py-2 rounded-button bg-mint-deep text-white shadow-card hover:bg-mint transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {copiedSignal ? <Check size={15} /> : <Copy size={15} />}
            {copiedSignal ? 'Copied' : 'Copy signal'}
          </button>
          <a
            href="https://t.me/Gaspola_bot?start=follow_prediction"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-body font-medium text-sm px-4 py-2 rounded-button border border-line text-ink-2 hover:border-mint hover:text-mint-deep transition-colors duration-150 whitespace-nowrap"
          >
            <Send size={15} />
            Follow on Telegram
          </a>
          {fetchedAt && !loading && (
            <span className="font-body text-[12px] text-muted">
              Updated {fetchedAt.toLocaleTimeString('en-GB')}
            </span>
          )}
        </div>
      </div>

      {/* ── Freshness bar ───────────────────────────────────────────────────── */}
      {!loading && (
        <div className={`mb-6 px-4 py-3 rounded-card border font-body text-[12px] ${
          isStale
            ? 'border-gold/30 bg-gold-tint text-gold'
            : 'border-line bg-surface text-muted'
        }`}>
          <div className="flex flex-wrap gap-x-5 gap-y-1 items-center">
            {/* Prices */}
            <span className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                freshness?.repriceStale ? 'bg-gold' : 'bg-mint'
              }`} />
              {freshness?.pricesAt
                ? <>Prices {new Date(freshness.pricesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · refresh ~15 min</>
                : freshness?.discoveryAt
                  ? 'Prices from discovery snapshot — re-pricer starting'
                  : 'No price data yet'}
              {freshness?.repriceStale && freshness.repriceLabel && (
                <span className="text-gold"> ({freshness.repriceLabel} — stalled?)</span>
              )}
            </span>

            <span className={isStale ? 'text-gold/40' : 'text-line'}>|</span>

            {/* Discovery */}
            <span className="flex items-center gap-1.5">
              {freshness?.discoveryStale && (
                <span className="w-1.5 h-1.5 rounded-full bg-gold flex-shrink-0" />
              )}
              {freshness?.discoveryAt ? (
                <>
                  Markets rescanned {new Date(freshness.discoveryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {freshness.nextDiscoveryAt != null && (
                    <> · next {new Date(freshness.nextDiscoveryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>
                  )}{' '}· 3h cadence
                </>
              ) : 'Discovery not run yet'}
              {freshness?.discoveryStale && freshness.discoveryLabel && (
                <span className="text-gold"> ({freshness.discoveryLabel} — missed slot?)</span>
              )}
            </span>
          </div>
        </div>
      )}

      {/* ── Stats strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => <CardSkeleton key={i} />)
        ) : (
          <>
            <StatCard
              label="Cashable now"
              value={`${stats?.cashableCount ?? 0}`}
              note={
                (stats?.cashableCount ?? 0) === 0
                  ? `Checking again in ${nextCheckMin(freshness)}m`
                  : `of ${stats?.totalCashableCandidates ?? stats?.cashableCount ?? 0} cashable found at discovery`
              }
            />
            <StatCard
              label="Event buckets"
              value={`${events.length}`}
              note="comparator groups across platforms"
            />
            <StatCard
              label="Markets tracked"
              value={stats?.marketsTracked ? String(stats.marketsTracked) : '—'}
              note="across 4 platforms"
            />
            <StatCard
              label="Signals watching"
              value={`${stats?.signalCount ?? 0}`}
              note="divergence detected, below threshold"
            />
            <StatCard
              label="Quarantined"
              value={`${data?.rejected ?? 0}`}
              note="excluded — ROI > 50%, bad URLs, or mismatch"
            />
          </>
        )}
      </div>

      {/* ── Event comparator ────────────────────────────────────────────────── */}
      <div className="mb-8">
        <SectionHeading as="h2" className="text-lg mb-1">Event comparator</SectionHeading>
        <p className="font-body text-sm text-muted mb-4">
          Same event, side by side across platforms — Kalshi/Polymarket are executable, Manifold/PredictIt are reference-only.
        </p>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : sortedEvents.length === 0 ? (
          <div className="rounded-card shadow-card bg-surface px-6 py-14 text-center">
            <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-mint-tint text-mint-deep flex items-center justify-center">
              <ShieldCheck size={22} />
            </div>
            <p className="font-display font-bold text-4xl text-ink mb-3">0</p>
            <p className="font-body text-base text-ink-2 mb-2">No comparable events right now</p>
            <p className="font-body text-sm text-muted max-w-lg mx-auto leading-relaxed">
              The comparator groups markets that reference the same real-world event across
              platforms. None currently clear that bar — showing zero calmly, not as an error.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-4">
              {(showAllEvents ? sortedEvents : sortedEvents.slice(0, INITIAL_EVENTS_SHOWN)).map(event => (
                <EventCard key={event.eventKey} event={event} valid={opps} />
              ))}
            </div>
            {sortedEvents.length > INITIAL_EVENTS_SHOWN && (
              <button
                type="button"
                onClick={() => setShowAllEvents(s => !s)}
                className="mt-4 font-body text-sm font-medium text-mint-deep hover:text-mint transition-colors duration-150"
              >
                {showAllEvents ? 'Show fewer' : `Show all ${sortedEvents.length} events`}
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Opportunity list ─────────────────────────────────────────────────── */}
      <SectionHeading as="h2" className="text-lg mb-1">Pairwise opportunities</SectionHeading>
      <p className="font-body text-sm text-muted mb-4">
        Every confirmed pair. <b className="text-mint-deep">Cashable</b> = both legs on real-money books (Polymarket / Kalshi). <b className="text-violet">Signal</b> = mid-price / play-money venue — indicative, never cashable. One-time payout → total ROI + unlock date, never $/day.
      </p>
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <RowSkeleton key={i} />)}
        </div>
      ) : opps.length === 0 ? (
        <div className="rounded-card shadow-card bg-surface px-6 py-14 text-center">
          <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-mint-tint text-mint-deep flex items-center justify-center">
            <ShieldCheck size={22} />
          </div>
          <p className="font-display font-bold text-4xl text-ink mb-3">0</p>
          <p className="font-body text-base text-ink-2 mb-2">
            No confirmed arb right now — checking again in {nextCheckMin(freshness)}m
          </p>
          <p className="font-body text-sm text-muted max-w-lg mx-auto leading-relaxed mb-4">
            Cross-platform cashable arb is rare by design — it only exists when the same event
            is priced differently on two real-money venues, with enough executable depth to lock
            in profit after fees. Showing zero calmly is the honest result of this scan, not a
            broken page.
          </p>
          <p className="font-body text-[11px] text-muted uppercase tracking-wide">
            Checked {relativeTime(freshness?.pricesAt ?? freshness?.discoveryAt)}
            {stats?.marketsTracked ? ` · ${stats.marketsTracked.toLocaleString()} markets tracked` : ''}
            {stats?.platforms ? ` · ${stats.platforms} platforms scanned` : ''}
            {(data?.rejected ?? 0) > 0 ? ` · ${data!.rejected} pair${data!.rejected === 1 ? '' : 's'} quarantined` : ''}
          </p>
        </div>
      ) : (
        <>
          {/* Sort pills (only sorts with real data — volume omitted, no per-pair field) */}
          <div className="flex items-center gap-3 flex-wrap mb-2">
            <span className="font-body text-[10px] uppercase tracking-wide text-muted">Sort</span>
            {(Object.keys(PRED_SORT_LABEL) as PredSort[]).map(k => (
              <button key={k} onClick={() => setSortKey(k)} title={PRED_SORT_TITLE[k]}
                className={['font-body text-[11px] uppercase tracking-wide pb-0.5 border-b-2 transition-colors', sortKey === k ? 'text-ink border-[#0c9d6e]' : 'text-muted border-transparent hover:text-ink-2'].join(' ')}>
                {PRED_SORT_LABEL[k]}
              </button>
            ))}
          </div>

          {/* Type + venue pills */}
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            <Pill active={!typeF} onClick={() => setTypeF('')}>All</Pill>
            <Pill active={typeF === 'cashable'} onClick={() => setTypeF(typeF === 'cashable' ? '' : 'cashable')} title="Cashable — both legs on real-money books">Cashable</Pill>
            <Pill active={typeF === 'signal'} onClick={() => setTypeF(typeF === 'signal' ? '' : 'signal')} title="Signal-only — mid-price / play-money, never cashable">Signal</Pill>
            <span className="h-3.5 w-px bg-line shrink-0" aria-hidden />
            <Pill active={!venueF} onClick={() => setVenueF('')}>All venues</Pill>
            {venues.map(v => <Pill key={v} active={venueF === v} onClick={() => setVenueF(venueF === v ? '' : v)}>{platformLabel(v)}</Pill>)}
          </div>

          {/* Category pills (only when real categories exist) */}
          {cats.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mb-2">
              <Pill active={!catF} onClick={() => setCatF('')}>All categories</Pill>
              {cats.map(c => <Pill key={c} active={catF === c} onClick={() => setCatF(catF === c ? '' : c)}>{c}</Pill>)}
            </div>
          )}

          {/* Resolution timeframe + Min ROI */}
          <div className="flex items-center gap-3 flex-wrap mb-3">
            <span className="font-body text-[10px] uppercase tracking-wide text-muted">Resolving</span>
            {[7, 30, 90].map(dd => <Pill key={dd} active={resWin === dd} onClick={() => setResWin(resWin === dd ? null : dd)} title={`Resolving within ${dd} days`}>≤{dd}d</Pill>)}
            <span className="h-3.5 w-px bg-line shrink-0" aria-hidden />
            <label className="flex items-center gap-1.5 whitespace-nowrap" title="Min total ROI % on cashable pairs (gated field — filters visible/paid rows)">
              <span className="font-body text-[10px] uppercase tracking-wide text-muted">ROI ≥</span>
              <input type="number" inputMode="decimal" min={0} step={0.5} value={minRoi === 0 ? '' : minRoi} placeholder="0"
                onChange={e => { const n = Number(e.target.value); setMinRoi(Number.isFinite(n) && n > 0 ? n : 0); }}
                className="w-14 px-1.5 py-0.5 rounded-button border border-line bg-surface text-ink font-mono text-[11px] tabular-nums text-right focus:outline-none focus:border-mint-deep/50" />
              <span className="font-body text-[10px] text-muted">%</span>
            </label>
            {filtersActive && <button onClick={resetFilters} className="font-body text-[10px] uppercase tracking-wide text-muted hover:text-coral-ink transition-colors">Reset</button>}
            <span className="ml-auto font-body text-[10px] text-muted tabular-nums">{shownOpps.length} of {opps.length}</span>
          </div>

          {/* Column header */}
          <div className="grid grid-cols-[auto_1fr_auto_auto] gap-3 px-3 py-1.5 text-[9px] uppercase tracking-wider text-muted border-b border-line">
            <span className="w-8" aria-hidden />
            <span>Market</span>
            <span className="text-right">Edge</span>
            <span className="w-3.5" aria-hidden />
          </div>

          {/* Rows */}
          <div className="rounded-b-lg overflow-hidden bg-surface border-x border-b border-line shadow-card">
            {shownOpps.length === 0 ? (
              <p className="font-body text-[12px] text-muted text-center py-8">No pairs match these filters. <button onClick={resetFilters} className="text-mint-deep">Reset</button></p>
            ) : shownOpps.map(opp => (
              <OppRowExpandable key={opp.id} opp={opp} open={openId === opp.id} onToggle={() => setOpenId(openId === opp.id ? null : opp.id)} />
            ))}
          </div>
        </>
      )}

    </div>
  );
}

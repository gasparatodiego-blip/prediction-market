'use client';

// Liquidity Rewards — beginner-friendly, dual-venue (Polymarket + Kalshi).
// Explainer → filters → market list (news-risk aware) → order-book estimator →
// "what I'd do". Every number is wired to the live unified snapshot
// (/api/rewards-unified ← /tmp/liquidity-rewards.json) and lib/rewards-estimate.ts.
// Honest-engine: net $/day primary, annualized capped + demoted, executable book
// depth only, adverse-selection subtracted, no fabricated pools, no login wall.

import { useEffect, useMemo, useState } from 'react';
import Eyebrow from '@/app/components/ui/Eyebrow';
import SectionHeading from '@/app/components/ui/SectionHeading';
import StatCard from '@/app/components/ui/StatCard';
import PlatformLogo from '@/components/PlatformLogo';
import { Redacted } from '@/app/components/ui/Redacted';
import { estimateReward, type MarketSnapshot, type Venue } from '@/lib/rewards-estimate';

// ── Types (mirror /api/rewards-unified) ─────────────────────────────────────
type NewsRisk = 'low' | 'medium' | 'high' | 'unknown';

interface NormalizedMarket {
  venue:               Venue;
  marketId:            string;
  title:               string;
  category:            string;
  midpoint:            number | null;
  maxSpread:           number | null;
  minSize:             number | null;
  dailyPool:           number | null;
  qualifyingLiquidity: number | null;
  bookDepthAtBand:     number | null;
  hoursToResolution:   number | null;
  updatedAt:           string | null;
  volatilityStdev:     number | null;
  volatilityRisk:      string | null;
  lastPrice:           number | null;
  twoSidedRequired:    boolean;
  bookSpread:          number | null;
  scoringModel:        string;
  flags:               string[];
  tokenId:             string | null;
  // merged from news-guard
  newsRisk?:           NewsRisk;
  newsSignals?:        { source: string; note: string }[] | null;
  protect?:            { action: string; detail: string } | null;
}

interface UnifiedResponse {
  meta: {
    generatedAt: string;
    totalMarkets: number;
    polymarket: number;
    kalshi: number;
    withRealPool: number;
    poolUnknown: number;
  } | null;
  markets: NormalizedMarket[];
  stale: boolean;
  error?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────
const POLL_MS = 5 * 60_000;
const CAPITAL_PRESETS = [50, 200, 1000, 5000];
const DEFAULT_CAPITAL = 1000;

// ── Small helpers ────────────────────────────────────────────────────────────
function ago(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}
function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  if (n >= 10)        return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}
function fmtHours(h: number | null): string {
  if (h == null) return '—';
  if (h < 48)  return `${h.toFixed(0)}h`;
  return `${(h / 24).toFixed(0)}d`;
}
function toSnapshot(m: NormalizedMarket): MarketSnapshot {
  return {
    venue: m.venue,
    midpoint: m.midpoint,
    maxSpread: m.maxSpread,
    minSize: m.minSize,
    dailyPool: m.dailyPool,
    qualifyingLiquidity: m.qualifyingLiquidity,
    bookDepthAtBand: m.bookDepthAtBand,
    volatilityStdev: m.volatilityStdev,
    twoSidedRequired: m.twoSidedRequired,
  };
}
// typical placement used for list-card estimates: two-sided, mid-band distance, $1k.
function typicalNet(m: NormalizedMarket): number | null {
  const dist = (m.maxSpread ?? 2) / 2;
  const r = estimateReward({ venue: m.venue, capital: DEFAULT_CAPITAL, twoSided: true, distanceCents: dist, market: toSnapshot(m) });
  return r.netPerDay;
}

// ── News-risk badge ──────────────────────────────────────────────────────────
function NewsBadge({ risk }: { risk: NewsRisk }) {
  const map: Record<NewsRisk, { label: string; cls: string; title: string }> = {
    high:    { label: 'NEWS RISK · HIGH', cls: 'bg-coral-tint text-coral-ink border-coral-ink/25', title: 'Breaking signal or volatility spike — the guard advises withdrawing liquidity.' },
    medium:  { label: 'news risk · med',  cls: 'bg-gold-tint text-gold border-gold/25',           title: 'Elevated chatter/volatility around this event — watch closely.' },
    low:     { label: 'calm',             cls: 'bg-mint-tint text-mint-deep border-mint-deep/20',  title: 'No adverse news/volatility signal detected right now.' },
    unknown: { label: 'no signal',        cls: 'bg-bg-soft text-muted border-line',                title: 'News-guard has no reading for this market yet.' },
  };
  const s = map[risk] ?? map.unknown;
  return (
    <span title={s.title} className={`inline-flex items-center px-2 py-[2px] rounded-md font-body font-medium text-[10px] border ${s.cls}`}>
      {s.label}
    </span>
  );
}

// ── Explainer block ──────────────────────────────────────────────────────────
function Explainer() {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      <button className="w-full flex items-center justify-between px-5 py-4 text-left" onClick={() => setOpen(v => !v)}>
        <span className="font-body font-medium text-sm text-ink-2">What are liquidity rewards? (start here)</span>
        <span className="font-body text-[11px] text-muted">{open ? '▲ hide' : '▼ show'}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 border-t border-line space-y-4">
          <p className="font-body text-[13px] text-ink-2 leading-relaxed mt-4">
            Both Polymarket and Kalshi <span className="font-medium text-ink">pay you daily just for posting limit orders near the middle price</span> —
            even if nobody trades against them. You&apos;re providing liquidity, and the exchange rewards you from a pool for it.
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-button bg-bg-soft border border-line px-4 py-3">
              <div className="flex items-center gap-2 mb-1"><PlatformLogo platform="polymarket" size={14} /><span className="font-body font-medium text-[12px] text-ink">Polymarket</span></div>
              <p className="font-body text-[12px] text-muted leading-relaxed">Rewards pool &gt;$5M/month. Score = size × closeness-to-mid (quadratic) × time resting. Two-sided pays more and is <span className="text-ink-2">required</span> when the price is below 10¢ or above 90¢. Paid daily ~midnight UTC, $1/day minimum.</p>
            </div>
            <div className="rounded-button bg-bg-soft border border-line px-4 py-3">
              <div className="flex items-center gap-2 mb-1"><PlatformLogo platform="kalshi" size={14} /><span className="font-body font-medium text-[12px] text-ink">Kalshi</span></div>
              <p className="font-body text-[12px] text-muted leading-relaxed">Liquidity Incentive Program, $10–$1,000 per market per day, through Sep&nbsp;1&nbsp;2026. Per-second book snapshots; your order must rest the whole second. Two-sided required to score. Payout = your score ÷ total score × pool.</p>
            </div>
          </div>
          <div className="rounded-button bg-coral-tint/50 border border-coral-ink/20 px-4 py-3">
            <p className="font-body text-[12px] text-coral-ink leading-relaxed">
              <span className="font-semibold">Not free money.</span> When your resting order actually gets filled, it&apos;s usually because the
              price is about to move against you (adverse selection). Naive reward calculators read 3–5× too high because they ignore this.
              Every net number below <span className="font-medium">already subtracts the expected adverse-fill cost</span> — that&apos;s why it&apos;s the number that matters.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Filter bar ───────────────────────────────────────────────────────────────
interface Filters {
  venue: 'all' | 'polymarket' | 'kalshi';
  categories: Set<string>;
  minPool: number;
  maxHours: number | null;
  hideHighNews: boolean;
}

function FilterBar({
  filters, setFilters, categories, maxPoolBound,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  categories: string[];
  maxPoolBound: number;
}) {
  const venueBtn = (v: Filters['venue'], label: string) => (
    <button
      key={v}
      onClick={() => setFilters({ ...filters, venue: v })}
      className={`inline-flex items-center gap-1.5 font-body font-medium text-[13px] px-3.5 py-1.5 rounded-pill transition-colors
        ${filters.venue === v ? 'bg-surface shadow-sm text-ink' : 'text-muted hover:text-ink-2'}`}
    >
      {v !== 'all' && <PlatformLogo platform={v} size={14} />}{label}
    </button>
  );
  const toggleCat = (c: string) => {
    const next = new Set(filters.categories);
    if (next.has(c)) next.delete(c); else next.add(c);
    setFilters({ ...filters, categories: next });
  };
  return (
    <div className="rounded-card shadow-card bg-surface px-5 py-4 space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {/* Venue */}
        <div className="flex items-center gap-2">
          <span className="font-body text-[11px] uppercase tracking-wide text-muted">Venue</span>
          <div className="flex items-center gap-1 p-1 rounded-pill bg-bg-soft border border-line">
            {venueBtn('all', 'All')}{venueBtn('polymarket', 'Polymarket')}{venueBtn('kalshi', 'Kalshi')}
          </div>
        </div>
        {/* Min pool */}
        <div className="flex items-center gap-2">
          <span className="font-body text-[11px] uppercase tracking-wide text-muted">Min pool</span>
          <input
            type="range" min={0} max={maxPoolBound} step={10} value={filters.minPool}
            onChange={e => setFilters({ ...filters, minPool: Number(e.target.value) })}
            className="w-32 accent-mint-deep"
          />
          <span className="font-body text-[12px] text-ink-2 tabular-nums w-16">${filters.minPool.toLocaleString()}/day</span>
        </div>
        {/* Hours to resolution */}
        <div className="flex items-center gap-2">
          <span className="font-body text-[11px] uppercase tracking-wide text-muted">Resolves in ≥</span>
          <select
            value={filters.maxHours ?? 0}
            onChange={e => setFilters({ ...filters, maxHours: Number(e.target.value) || null })}
            className="font-body text-[12px] text-ink-2 bg-bg-soft border border-line rounded-button px-2 py-1"
          >
            <option value={0}>any</option>
            <option value={24}>24h+</option>
            <option value={72}>3d+</option>
            <option value={168}>7d+</option>
            <option value={720}>30d+</option>
          </select>
        </div>
        {/* News risk */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={filters.hideHighNews} onChange={e => setFilters({ ...filters, hideHighNews: e.target.checked })} className="accent-coral-ink" />
          <span className="font-body text-[12px] text-ink-2">Hide high news-risk</span>
        </label>
      </div>
      {/* Category chips */}
      {categories.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-body text-[11px] uppercase tracking-wide text-muted mr-1">Category</span>
          {categories.map(c => {
            const on = filters.categories.size === 0 || filters.categories.has(c);
            const active = filters.categories.has(c);
            return (
              <button
                key={c}
                onClick={() => toggleCat(c)}
                className={`font-body text-[11px] px-2.5 py-1 rounded-pill border transition-colors
                  ${active ? 'bg-mint-tint text-mint-deep border-mint-deep/30'
                           : 'bg-surface text-muted border-line hover:text-ink-2'} ${!active && filters.categories.size > 0 ? 'opacity-60' : ''}`}
              >
                {c}
              </button>
            );
          })}
          {filters.categories.size > 0 && (
            <button onClick={() => setFilters({ ...filters, categories: new Set() })} className="font-body text-[11px] text-muted underline ml-1">clear</button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Market card ──────────────────────────────────────────────────────────────
function MarketCard({ m, selected, onSelect }: { m: NormalizedMarket; selected: boolean; onSelect: () => void }) {
  const net = typicalNet(m);
  const risk = (m.newsRisk ?? 'unknown') as NewsRisk;
  const poolKnown = m.dailyPool != null;
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-card shadow-card bg-surface overflow-hidden transition-shadow hover:shadow-lg
        ${selected ? 'ring-2 ring-mint-deep/50' : ''}`}
    >
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <PlatformLogo platform={m.venue} size={14} />
              <span className="font-body text-[11px] text-muted">{m.category}</span>
              {m.twoSidedRequired && <span className="font-body text-[10px] text-gold">· two-sided required</span>}
            </div>
            <p className="font-body font-medium text-[13px] text-ink leading-snug truncate">{m.title}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="font-display font-bold text-ink leading-none" style={{ fontSize: 20 }}>
              {poolKnown ? <Redacted value={net}>{v => fmtUsd(v)}</Redacted> : <span className="text-muted text-[13px] font-body">pool unknown</span>}
            </p>
            <p className="font-body text-[10px] text-muted mt-1">est. net/day · $1k</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          <Chip label="pool/day" value={poolKnown ? <Redacted value={m.dailyPool}>{v => `$${v.toFixed(0)}`}</Redacted> : 'unknown'} />
          <Chip label="mid" value={<Redacted value={m.midpoint}>{v => v.toFixed(3)}</Redacted>} />
          {m.maxSpread != null && <Chip label="band" value={<Redacted value={m.maxSpread}>{v => `±${v}¢`}</Redacted>} />}
          <Chip label="depth" value={<Redacted value={m.bookDepthAtBand}>{v => fmtUsd(v)}</Redacted>} />
          <Chip label="resolves" value={fmtHours(m.hoursToResolution)} />
          <NewsBadge risk={risk} />
          {m.flags.filter(f => ['TRAP', 'SHORT_BURST', 'ONE_SIDED'].includes(f)).map(f => (
            <span key={f} className="inline-flex items-center px-2 py-[2px] rounded-md font-body font-medium text-[10px] border bg-gold-tint text-gold border-gold/25">{f.replace('_', ' ')}</span>
          ))}
        </div>
      </div>
    </button>
  );
}
function Chip({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 font-body text-[11px] px-2 py-[3px] rounded-md bg-bg-soft border border-line">
      <span className="text-muted">{label}</span><span className="text-ink-2 font-medium tabular-nums">{value}</span>
    </span>
  );
}

// ── Estimator panel ──────────────────────────────────────────────────────────
function Estimator({ m }: { m: NormalizedMarket }) {
  const [capital, setCapital] = useState<number>(DEFAULT_CAPITAL);
  const [twoSided, setTwoSided] = useState(true);
  const bandMax = m.maxSpread ?? 5;
  const [dist, setDist] = useState<number>(Number((bandMax / 2).toFixed(2)));

  // keep distance within the (possibly changed) band when switching markets
  useEffect(() => { setDist(Number(((m.maxSpread ?? 5) / 2).toFixed(2))); }, [m.marketId, m.maxSpread]);

  const r = useMemo(
    () => estimateReward({ venue: m.venue, capital, twoSided, distanceCents: dist, market: toSnapshot(m) }),
    [m, capital, twoSided, dist],
  );

  const gated = m.dailyPool == null && !m.flags.includes('POOL_UNKNOWN'); // redacted vs truly unknown
  const netTone = r.netPerDay == null ? 'text-muted' : r.netPerDay > 0 ? 'text-mint-deep' : 'text-coral-ink';

  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden sticky top-4">
      <div className="px-5 py-4 border-b border-line">
        <div className="flex items-center gap-2 mb-1"><PlatformLogo platform={m.venue} size={14} /><span className="font-body text-[11px] text-muted">{m.category} · estimate</span></div>
        <p className="font-body font-medium text-[13px] text-ink leading-snug">{m.title}</p>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* capital */}
        <div>
          <span className="font-body text-[11px] uppercase tracking-wide text-muted">Capital deployed</span>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {CAPITAL_PRESETS.map(c => (
              <button key={c} onClick={() => setCapital(c)}
                className={`font-body font-medium text-[12px] px-3 py-1.5 rounded-button border transition-colors
                  ${capital === c ? 'border-mint-deep/40 bg-mint-tint text-mint-deep' : 'border-line bg-surface text-muted hover:text-ink-2'}`}>
                ${c >= 1000 ? `${c / 1000}k` : c}
              </button>
            ))}
            <input type="number" min={1} value={capital} onChange={e => setCapital(Math.max(1, Number(e.target.value) || 0))}
              className="w-24 font-body text-[12px] text-ink-2 bg-bg-soft border border-line rounded-button px-2 py-1.5" />
          </div>
        </div>

        {/* two-sided */}
        <div>
          <span className="font-body text-[11px] uppercase tracking-wide text-muted">Posting</span>
          <div className="flex items-center gap-1.5 mt-1.5">
            <button onClick={() => setTwoSided(true)}
              className={`font-body font-medium text-[12px] px-3 py-1.5 rounded-button border transition-colors ${twoSided ? 'border-mint-deep/40 bg-mint-tint text-mint-deep' : 'border-line bg-surface text-muted'}`}>
              Two-sided
            </button>
            <button onClick={() => setTwoSided(false)}
              className={`font-body font-medium text-[12px] px-3 py-1.5 rounded-button border transition-colors ${!twoSided ? 'border-gold/40 bg-gold-tint text-gold' : 'border-line bg-surface text-muted'}`}>
              Single-sided
            </button>
            {m.twoSidedRequired && !twoSided && (
              <span className="font-body text-[11px] text-coral-ink">scores 0 — two-sided required at this price</span>
            )}
          </div>
        </div>

        {/* distance */}
        <div>
          <div className="flex items-center justify-between">
            <span className="font-body text-[11px] uppercase tracking-wide text-muted">Distance from mid</span>
            <span className="font-body text-[12px] text-ink-2 tabular-nums">{dist.toFixed(2)}¢ {m.maxSpread != null ? `/ ${m.maxSpread}¢ band` : ''}</span>
          </div>
          <input type="range" min={0.1} max={bandMax} step={0.1} value={dist} onChange={e => setDist(Number(e.target.value))} className="w-full accent-mint-deep mt-1.5" />
          <p className="font-body text-[10px] text-muted mt-0.5">Closer to mid → more reward but more fills (adverse cost).</p>
        </div>

        {/* results */}
        <div className="pt-2 border-t border-line space-y-2.5">
          <Row label="Pool share" value={<Redacted value={r.shareOfPool}>{v => `${(v * 100).toFixed(2)}%`}</Redacted>} />
          <Row label="Fill probability" value={<Redacted value={r.fillProbability}>{v => `${(v * 100).toFixed(0)}%`}</Redacted>} sub="how often you get picked off" />
          <Row label="Gross reward" value={<Redacted value={r.grossReward}>{v => `${fmtUsd(v)}/day`}</Redacted>} />
          <Row
            label="Adverse-fill cost"
            value={<span className="text-coral-ink"><Redacted value={r.adverseSelectionCost}>{v => `− ${fmtUsd(v)}/day`}</Redacted></span>}
            sub={r.adverseMoveSource === 'market-vol' ? 'from this market’s 24h volatility' : r.adverseMoveSource === 'conservative-default' ? 'conservative 2–5% (no vol data)' : undefined}
          />
          {/* NET — primary */}
          <div className="rounded-button bg-bg-soft border border-line px-4 py-3 flex items-end justify-between">
            <div>
              <p className="font-body text-[11px] uppercase tracking-wide text-muted">Net reward · primary</p>
              <p className={`font-display font-bold leading-none mt-1 ${netTone}`} style={{ fontSize: 30 }}>
                <Redacted value={r.netPerDay}>{v => `${fmtUsd(v)}/day`}</Redacted>
              </p>
            </div>
            <div className="text-right">
              <p className="font-body text-[12px] text-ink-2 tabular-nums"><Redacted value={r.dayYieldPct}>{v => `${v.toFixed(3)}%/day`}</Redacted></p>
              <p className="font-body text-[11px] text-muted tabular-nums">
                <Redacted value={r.annualizedPct}>{v => `${r.annualizedCapped ? '>' : ''}${v.toFixed(0)}%/yr`}</Redacted>
              </p>
              <p className="font-body text-[9px] text-muted/70">{r.annualizedLabel}</p>
            </div>
          </div>

          {r.belowMinPayout && (
            <p className="font-body text-[11px] text-muted">Below the $1/day minimum payout — this position likely earns nothing. Shown for completeness.</p>
          )}
          {r.reasons.length > 0 && (
            <ul className="space-y-1">
              {r.reasons.map((x, i) => <li key={i} className="font-body text-[10px] text-muted/80 leading-snug">· {x}</li>)}
            </ul>
          )}
          {gated && r.netPerDay == null && (
            <p className="font-body text-[11px] text-muted">Numbers are locked on the free tier — the estimate runs on real book/pool data once unlocked.</p>
          )}
        </div>
      </div>
    </div>
  );
}
function Row({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <span className="font-body text-[12px] text-ink-2">{label}</span>
        {sub && <span className="font-body text-[10px] text-muted ml-2">{sub}</span>}
      </div>
      <span className="font-body text-[13px] text-ink font-medium tabular-nums">{value}</span>
    </div>
  );
}

// ── "What I'd do" block ──────────────────────────────────────────────────────
function WhatIdDo({ m }: { m: NormalizedMarket }) {
  const dist = ((m.maxSpread ?? 2) / 2).toFixed(1);
  const mid = m.midpoint;
  const bidPx = mid != null ? Math.max(0.01, mid - Number(dist) / 100) : null;
  const askPx = mid != null ? Math.min(0.99, mid + Number(dist) / 100) : null;
  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      <div className="px-5 py-4 border-b border-line">
        <span className="font-body font-medium text-sm text-ink-2">What I&apos;d do (soon, via API)</span>
        <span className="font-body text-[11px] text-muted ml-2">advisory — live execution is OFF</span>
      </div>
      <ol className="px-5 py-4 space-y-2.5 list-decimal list-inside">
        <li className="font-body text-[12px] text-ink-2 leading-relaxed">
          Post a <span className="font-medium text-ink">two-sided</span> quote about {dist}¢ from mid:{' '}
          {bidPx != null && askPx != null
            ? <>bid at <span className="tabular-nums text-ink">{bidPx.toFixed(3)}</span>, ask at <span className="tabular-nums text-ink">{askPx.toFixed(3)}</span></>
            : <span className="text-muted">(prices shown once unlocked)</span>}
          {m.minSize != null && <> — at least <span className="tabular-nums">{m.minSize.toLocaleString()}</span> shares/side to qualify.</>}
        </li>
        <li className="font-body text-[12px] text-ink-2 leading-relaxed">On a partial fill, immediately <span className="font-medium text-ink">re-quote the opposite side</span> to stay balanced and keep scoring.</li>
        <li className="font-body text-[12px] text-ink-2 leading-relaxed">Keep both orders resting through each snapshot ({m.venue === 'kalshi' ? 'per-second on Kalshi' : 'per-minute on Polymarket'}) — that&apos;s what earns.</li>
        <li className="font-body text-[12px] text-ink-2 leading-relaxed">
          <span className="font-medium text-ink">News-guard:</span> on a high adverse-news signal, <span className="text-coral-ink">withdraw liquidity immediately</span>; if already partially filled, exit at the best executable book price. All advisory while live execution is OFF.
        </li>
      </ol>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function LiquidityRewardsPage() {
  const [data, setData] = useState<UnifiedResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<'pool' | 'net'>('net');
  const [filters, setFilters] = useState<Filters>({ venue: 'all', categories: new Set(), minPool: 0, maxHours: null, hideHighNews: false });

  async function poll() {
    try {
      const res = await fetch('/api/rewards-unified', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as UnifiedResponse;
      setData(json); setErr(null); setLastFetch(new Date());
    } catch (e: any) { setErr(e?.message ?? 'fetch error'); }
  }
  useEffect(() => { poll(); const id = setInterval(poll, POLL_MS); return () => clearInterval(id); }, []);

  const markets = data?.markets ?? [];
  const meta = data?.meta;
  const isStale = data?.stale ?? true;

  const categories = useMemo(
    () => Array.from(new Set(markets.map(m => m.category))).filter(Boolean).sort(),
    [markets],
  );
  const maxPoolBound = useMemo(() => {
    const pools = markets.map(m => m.dailyPool ?? 0);
    return Math.max(100, Math.ceil(Math.max(0, ...pools) / 100) * 100);
  }, [markets]);

  const filtered = useMemo(() => {
    let out = markets.filter(m => {
      if (filters.venue !== 'all' && m.venue !== filters.venue) return false;
      if (filters.categories.size > 0 && !filters.categories.has(m.category)) return false;
      if (m.dailyPool != null && m.dailyPool < filters.minPool) return false;
      if (filters.maxHours && (m.hoursToResolution == null || m.hoursToResolution < filters.maxHours)) return false;
      if (filters.hideHighNews && m.newsRisk === 'high') return false;
      return true;
    });
    out = [...out].sort((a, b) => {
      if (sortMode === 'pool') return (b.dailyPool ?? -1) - (a.dailyPool ?? -1);
      return (typicalNet(b) ?? -1e9) - (typicalNet(a) ?? -1e9);
    });
    return out;
  }, [markets, filters, sortMode]);

  const selected = useMemo(
    () => filtered.find(m => m.marketId === selectedId) ?? filtered[0] ?? null,
    [filtered, selectedId],
  );

  const highNews = markets.filter(m => m.newsRisk === 'high').length;
  const poolVals = markets.map(m => m.dailyPool).filter((v): v is number => v != null);
  const totalPool = markets.length > 0 && poolVals.length === 0 ? null : poolVals.reduce((s, v) => s + v, 0);

  return (
    <div className="min-h-screen" style={{ background: 'radial-gradient(circle at 50% -10%, rgba(15,190,130,.05), transparent 60%), #F5F8F6' }}>
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">

        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow className="mb-1">Liquidity Rewards</Eyebrow>
            <SectionHeading as="h1" className="text-2xl flex items-center gap-3 flex-wrap">
              <PlatformLogo platform="polymarket" size={20} /><PlatformLogo platform="kalshi" size={20} />
              Get paid to post limit orders
            </SectionHeading>
            <p className="font-body text-sm text-muted mt-1">
              Real reward pools from Polymarket &amp; Kalshi. Net $/day after the adverse-fill cost — the number that actually matters.
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <LiveBadge live={!!(meta && !isStale)} />
            <span className="font-body text-[12px] text-muted">
              {lastFetch ? `fetched ${ago(lastFetch.toISOString())}` : '—'}{meta ? ` · data ${ago(meta.generatedAt)}` : ''}
            </span>
          </div>
        </div>

        {isStale && meta && (
          <div className="px-4 py-3 rounded-card border border-gold/25 bg-gold-tint font-body text-sm text-gold">
            Data is stale (last scan {ago(meta.generatedAt)}). The scanners run every 15 min — check back shortly.
          </div>
        )}
        {err && !data && (
          <div className="px-4 py-3 rounded-card border border-coral-ink/25 bg-coral-tint font-body text-sm text-coral-ink">{err}</div>
        )}

        <Explainer />

        {/* Summary */}
        {meta && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Reward markets" value={String(meta.totalMarkets)} note={`${meta.polymarket} Polymarket · ${meta.kalshi} Kalshi`} />
            <StatCard label="Real pools" value={String(meta.withRealPool)} demoted={meta.poolUnknown > 0 ? `${meta.poolUnknown} pool unknown` : 'all pools known'} />
            <StatCard label="Total pool / day" value={<Redacted value={totalPool}>{v => `$${Math.round(v).toLocaleString()}`}</Redacted>} demoted="real pool — est. share not included" />
            <StatCard label="High news-risk" value={String(highNews)} note="guard advises withdraw" demoted="advisory · live exec OFF" />
          </div>
        )}

        <FilterBar filters={filters} setFilters={setFilters} categories={categories} maxPoolBound={maxPoolBound} />

        {/* List + estimator */}
        <div className="grid lg:grid-cols-[1fr_380px] gap-4 items-start">
          <div className="space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-body text-[11px] uppercase tracking-wide text-muted">{filtered.length} market{filtered.length === 1 ? '' : 's'}</p>
              <div className="ml-auto flex items-center gap-1 p-1 rounded-pill bg-bg-soft border border-line">
                {(['net', 'pool'] as const).map(mode => (
                  <button key={mode} onClick={() => setSortMode(mode)}
                    className={`font-body font-medium text-[11px] px-3 py-1 rounded-pill transition-colors ${sortMode === mode ? 'bg-surface shadow-sm text-ink' : 'text-muted'}`}>
                    {mode === 'net' ? 'est. net/day' : 'pool/day'}
                  </button>
                ))}
              </div>
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-card shadow-card bg-surface px-5 py-10 text-center">
                <p className="font-body text-sm text-muted">
                  {data === null ? 'Loading reward markets…' : 'No markets match these filters.'}
                </p>
                {data !== null && markets.length > 0 && (
                  <button onClick={() => setFilters({ venue: 'all', categories: new Set(), minPool: 0, maxHours: null, hideHighNews: false })}
                    className="font-body text-[12px] text-mint-deep underline mt-2">reset filters</button>
                )}
              </div>
            ) : (
              filtered.map(m => (
                <MarketCard key={m.marketId} m={m} selected={selected?.marketId === m.marketId} onSelect={() => setSelectedId(m.marketId)} />
              ))
            )}
          </div>

          <div className="space-y-4">
            {selected ? (<><Estimator m={selected} /><WhatIdDo m={selected} /></>) : (
              <div className="rounded-card shadow-card bg-surface px-5 py-10 text-center">
                <p className="font-body text-sm text-muted">Select a market to estimate your reward.</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="pt-4 border-t border-line space-y-1">
          <p className="font-body text-[11px] text-muted/60 leading-relaxed">
            Estimates only, from live order-book depth (executable prices, never midpoint for fills). Net subtracts expected adverse-fill cost.
            Polymarket uses its quadratic CLOB scoring; Kalshi&apos;s LIP formula is not public — its share is an observed flat pro-rata inference. Not financial advice.
          </p>
          <p className="font-body text-[11px] text-muted/60">Read-only. No orders placed. Live execution OFF. No login required.</p>
        </div>
      </div>
    </div>
  );
}

function LiveBadge({ live }: { live: boolean }) {
  return live ? (
    <span className="flex items-center gap-1.5 font-body font-medium text-xs text-mint-deep border border-mint-deep/30 bg-mint-tint px-2.5 py-1 rounded-pill">
      <span className="w-1.5 h-1.5 rounded-full bg-mint" aria-hidden /> LIVE
    </span>
  ) : (
    <span className="font-body font-medium text-xs text-gold border border-gold/30 bg-gold-tint px-2.5 py-1 rounded-pill">STALE</span>
  );
}

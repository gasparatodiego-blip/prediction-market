'use client';

import { useEffect, useMemo, useState } from 'react';
import { Redacted } from './ui/Redacted';
import { EmptyState } from './ds';
import { estimateReward, type MarketSnapshot, type Venue } from '@/lib/rewards-estimate';
import { scaleToCapitalBasis } from '@/lib/honest-display';
// Pure, node-verifiable filter/sort/derive logic — shared VERBATIM so the list the user
// sees and any measurement of the filter behaviour cannot diverge (see lib/rewards-filter.js).
import { deriveOptions, defaultState, applyFilters, sortRows, saturationView } from '@/lib/rewards-filter';

/**
 * Liquidity rewards — FILTERABLE LIST (mirrors the Cash & Carry list surface).
 *
 * A stacked filter panel (category/venue chips, sliders, hide-TRAP checkbox) over compact
 * rows. Each row carries a pool-competition (saturation) bar; tapping a row expands a
 * share→reward calculator. Every $ figure comes from lib/rewards-estimate (the SSOT this
 * lane already used) — this component never re-derives a number.
 *
 * HONEST-ENGINE
 *  - PRIMARY figure is net $/day at a $1,000 basis, straight from estimateReward (already
 *    net of adverse selection; WITHHELD as null when the implied run-rate breaches 200%/yr).
 *  - APR is DEMOTED to the sub line, capped at 200% and labelled ">200%/yr" by the SSOT.
 *  - Capacity is real book depth at the reward band; unknown renders "—", never fabricated.
 *  - SATURATION is DERIVED, not fabricated: saturation = 1 - shareOfPool for a reference
 *    $1k maker, i.e. the fraction of the pool existing makers already hold. It needs the
 *    (redacted) qualifyingLiquidity, so it is null when unmeasured AND automatically null
 *    on the free tier — the bar hides/locks rather than inventing a value.
 *  - Risk flags are the feed's OWN flags (TRAP, THIN_CAP, SHORT_BURST, ONE_SIDED, …); the
 *    hide-TRAP filter is a user choice, default OFF — flags are shown, not hidden.
 *  - Derived fields (net/APR/capacity/saturation) redact to the free-tier lock via Redacted.
 */

const CAPITAL_BASIS = 1000;

interface Side { midpoint: number | null; qualifyingLiquidity: number | null; bookDepthAtBand: number | null; bookSpread: number | null; volatilityStdev: number | null }
interface Market {
  venue: Venue;
  marketId: string;
  title: string;
  groupItemTitle?: string | null;
  category?: string | null;
  midpoint: number | null;
  maxSpread: number | null;
  minSize: number | null;
  dailyPool: number | null;
  qualifyingLiquidity: number | null;
  bookDepthAtBand: number | null;
  volatilityStdev: number | null;
  bookSpread: number | null;
  hoursToResolution: number | null;
  volatilityRisk?: string | null;
  twoSidedRequired?: boolean;
  flags?: string[] | null;
  sides?: { yes?: Side; no?: Side } | null;
}
interface Payload { meta: any; markets: Market[]; stale: boolean; isPaid?: boolean }

/** Enriched row = the market + the SSOT-derived numbers the list/filters read. */
interface Row {
  m: Market;
  flags: string[];
  category: string | null;
  venue: Venue;
  poolDayUsd: number | null;
  netUsdPerDay: number | null;
  apr: number | null;            // capped 200% by the SSOT
  aprCapped: boolean;
  aprLabel: string;
  capacityUsd: number | null;
  saturation: number | null;     // 0..1, DERIVED (null when unmeasured / free tier)
  isTrap: boolean;
}

interface FilterState {
  categories: string[];
  venues: string[];
  minPool: number;
  maxSaturationPct: number;   // 100 = off
  minApr: number;
  minCapacity: number;
  hideTrap: boolean;
  sortByPool: boolean;
}

const fmtUsd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000   ? `$${(n / 1_000).toFixed(0)}k`
  : `$${n.toFixed(0)}`;

const toggle = (arr: string[], v: string) =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

/** Snapshot + distance convention identical to the previous card surface, so the estimator
 *  is fed the same inputs it always was — only the presentation around it changed. */
function toSnapshot(m: Market): MarketSnapshot {
  return {
    venue:               m.venue,
    midpoint:            m.midpoint,
    maxSpread:           m.maxSpread,
    minSize:             m.minSize,
    dailyPool:           m.dailyPool,
    qualifyingLiquidity: m.qualifyingLiquidity,
    bookDepthAtBand:     m.bookDepthAtBand,
    volatilityStdev:     m.volatilityStdev,
    twoSidedRequired:    m.twoSidedRequired,
    sides:               (m.sides as any) ?? null,
  };
}
const distOf = (m: Market) => (m.maxSpread ?? 2) / 2;

export default function RewardsUnified() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(() => defaultState() as FilterState);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch('/api/rewards-unified', { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        setData(j); setErr(null);
      } catch (e: any) {
        if (alive) setErr(e?.message ?? 'fetch failed');
      }
    }
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const isPaid = data?.isPaid ?? false;

  // Enrich once through the SSOT: net $/day, APR (capped), capacity, and DERIVED saturation.
  const enriched: Row[] = useMemo(() => {
    const ms = data?.markets ?? [];
    return ms.map((m) => {
      const est = estimateReward({ venue: m.venue, capital: CAPITAL_BASIS, twoSided: true, distanceCents: distOf(m), market: toSnapshot(m) });
      const flags = (m.flags ?? []).filter(Boolean);
      return {
        m,
        flags,
        category:     m.category ?? null,
        venue:        m.venue,
        poolDayUsd:   m.dailyPool,
        netUsdPerDay: est.netPerDay,
        apr:          est.annualizedPct,
        aprCapped:    est.annualizedCapped,
        aprLabel:     est.annualizedLabel,
        capacityUsd:  m.bookDepthAtBand,
        // saturation = 1 - reference $1k maker's share of the pool (existing makers' share).
        saturation:   est.shareOfPool != null ? 1 - est.shareOfPool : null,
        isTrap:       flags.some((f) => /^TRAP$/i.test(f)),
      };
    });
  }, [data]);

  const opts = useMemo(() => deriveOptions(enriched), [enriched]);
  const visible: Row[] = useMemo(
    () => sortRows(applyFilters(enriched, filters), filters) as Row[],
    [enriched, filters],
  );

  const set = (patch: Partial<FilterState>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="rewards">
      <div className="cc-shell">

        <header className="cc-head">
          <h1 className="cc-title">
            <span className="cc-title-dim">Edgeradar /</span> liquidity rewards
            <span className="cc-title-accent"> · maker</span>
          </h1>
          <p className="cc-sub">
            quote both sides inside the reward band — earn the pool share, net of adverse selection
          </p>
        </header>

        {err && <EmptyState prefix="cc" title="Rewards feed unavailable" sub={err} />}
        {!err && !data && <EmptyState prefix="cc" sub="Loading reward markets…" />}
        {!err && data && enriched.length === 0 && (
          <EmptyState prefix="cc" title="No reward markets clear the sanity gate right now" />
        )}

        {!err && data && enriched.length > 0 && (
          <>
            <div className="cc-filterbar">
              {/* CATEGORY */}
              <div className="cc-fgroup">
                <span className="cc-flabel">Category</span>
                <div className="cc-chips">
                  {opts.categories.map((c: string) => (
                    <button key={c} type="button"
                      className={`cc-fchip ${filters.categories.includes(c) ? 'is-on' : ''}`}
                      onClick={() => set({ categories: toggle(filters.categories, c) })}>{c}</button>
                  ))}
                  {opts.categories.length === 0 && <span className="cc-slider-val">—</span>}
                </div>
              </div>

              {/* VENUE */}
              <div className="cc-fgroup">
                <span className="cc-flabel">Venue</span>
                <div className="cc-chips">
                  {opts.venues.map((v: string) => (
                    <button key={v} type="button"
                      className={`cc-fchip ${filters.venues.includes(v) ? 'is-on' : ''}`}
                      onClick={() => set({ venues: toggle(filters.venues, v) })}>{v}</button>
                  ))}
                </div>
              </div>

              {/* MIN REWARD POOL */}
              <div className="cc-fgroup cc-slider">
                <div className="cc-slider-head">
                  <span className="cc-flabel">Min reward pool ($/day)</span>
                  <span className="cc-slider-val">≥ {filters.minPool > 0 ? fmtUsd(filters.minPool) : '$0'}</span>
                </div>
                <input className="cc-frange" type="range" min={0} max={Math.max(opts.poolMax, 1)} step={Math.max(1, Math.round(opts.poolMax / 100))}
                  value={filters.minPool}
                  onChange={(e) => set({ minPool: Number(e.target.value) })} aria-label="minimum reward pool" />
              </div>

              {/* MAX POOL COMPETITION (saturation) — derived; disabled if the feed exposes none */}
              <div className={`cc-fgroup cc-slider ${opts.hasSaturation ? '' : 'is-disabled'}`}>
                <div className="cc-slider-head">
                  <span className="cc-flabel">Max pool competition</span>
                  <span className="cc-slider-val">
                    {opts.hasSaturation
                      ? (filters.maxSaturationPct >= 100 ? 'any' : `≤ ${filters.maxSaturationPct}%`)
                      : 'n/a'}
                  </span>
                </div>
                <input className="cc-frange" type="range" min={0} max={100} step={5}
                  value={filters.maxSaturationPct}
                  disabled={!opts.hasSaturation}
                  onChange={(e) => set({ maxSaturationPct: Number(e.target.value) })} aria-label="maximum pool competition" />
                {!opts.hasSaturation && <span className="cc-slider-val rw-dim">saturation not available from this feed</span>}
              </div>

              {/* MIN APR */}
              <div className="cc-fgroup cc-slider">
                <div className="cc-slider-head">
                  <span className="cc-flabel">Min APR</span>
                  <span className="cc-slider-val">≥ {filters.minApr.toFixed(0)}%/yr</span>
                </div>
                <input className="cc-frange" type="range" min={0} max={Math.max(opts.aprMax, 1)} step={1}
                  value={filters.minApr}
                  onChange={(e) => set({ minApr: Number(e.target.value) })} aria-label="minimum APR" />
              </div>

              {/* MIN CAPACITY */}
              <div className="cc-fgroup cc-slider">
                <div className="cc-slider-head">
                  <span className="cc-flabel">Min capacity (book depth)</span>
                  <span className="cc-slider-val">≥ {filters.minCapacity > 0 ? fmtUsd(filters.minCapacity) : '$0'}</span>
                </div>
                <input className="cc-frange" type="range" min={0} max={Math.max(opts.capMax, 1)} step={Math.max(1, Math.round(opts.capMax / 100))}
                  value={filters.minCapacity}
                  onChange={(e) => set({ minCapacity: Number(e.target.value) })} aria-label="minimum capacity" />
              </div>

              {/* CHECKBOXES */}
              <div className="cc-checks">
                <label className={`cc-check ${filters.hideTrap ? 'is-on' : ''}`}>
                  <input type="checkbox" checked={filters.hideTrap}
                    onChange={(e) => set({ hideTrap: e.target.checked })} />
                  Hide ⚠ TRAP
                </label>
                <label className={`cc-check ${filters.sortByPool ? 'is-on' : ''}`}>
                  <input type="checkbox" checked={filters.sortByPool}
                    onChange={(e) => set({ sortByPool: e.target.checked })} />
                  Sort by reward pool
                </label>
              </div>
            </div>

            <p className="cc-count">
              {visible.length} of {enriched.length} rows · sorted by {filters.sortByPool ? 'reward pool' : 'net $/day'}
            </p>

            {visible.length === 0 ? (
              <EmptyState prefix="cc" title="No reward markets match these filters." sub="Loosen a filter to see more." />
            ) : (
              <div className="cc-list">
                {visible.map((row) => {
                  const { m } = row;
                  const id = `${m.venue}-${m.marketId}`;
                  const isOpen = expandedId === id;
                  const satv = saturationView(row.saturation);
                  return (
                    <div key={id}>
                      <div
                        className={`cc-row ${isOpen ? 'is-open' : ''}`}
                        role="button" tabIndex={0} aria-expanded={isOpen}
                        onClick={() => setExpandedId(isOpen ? null : id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedId(isOpen ? null : id); }
                        }}
                      >
                        <span className="cc-row-l">
                          <span className="rw-row-top">
                            <span className="rw-venue">{m.venue}</span>
                            <span className="rw-cat">{row.category ?? '—'}</span>
                            {row.isTrap && <span className="rw-trap">⚠ TRAP</span>}
                          </span>
                          <span className="cc-row-title">{m.groupItemTitle || m.title}</span>
                          <span className="cc-row-sub">
                            pool{' '}
                            <Redacted value={row.poolDayUsd} isPaid={isPaid}>{(v) => <>${Number(v).toFixed(0)}/day</>}</Redacted>
                            {' · '}APR{' '}
                            <Redacted value={row.apr} isPaid={isPaid}>
                              {(v) => row.aprCapped ? <span title={row.aprLabel}>&gt;200%</span> : <>{Number(v).toFixed(0)}%</>}
                            </Redacted>
                            {' · '}cap{' '}
                            <Redacted value={row.capacityUsd} isPaid={isPaid}>{(v) => <>{fmtUsd(Number(v))}</>}</Redacted>
                          </span>
                          {/* SATURATION BAR — derived; hidden/locked when unavailable */}
                          <span className="rw-satwrap">
                            <Redacted
                              value={row.saturation}
                              isPaid={isPaid}
                              nullDisplay={<span className="rw-dim">competition · not measured</span>}
                            >
                              {(sat) => {
                                const v = saturationView(Number(sat));
                                if (!v) return null;
                                return (
                                  <>
                                    <span className="rw-satbar-track" title="derived: existing makers' share vs a $1k maker">
                                      <span className={`rw-satbar-fill is-${v.band}`} style={{ width: `${v.pct}%` }} />
                                    </span>
                                    <span className={`rw-sat-label is-${v.band}`}>{Math.round(v.pct)}% {v.label}</span>
                                  </>
                                );
                              }}
                            </Redacted>
                          </span>
                        </span>
                        <span className="cc-row-r">
                          <span className="cc-row-net">
                            <Redacted value={row.netUsdPerDay} isPaid={isPaid}>{(v) => <>${Number(v).toFixed(2)}/day</>}</Redacted>
                          </span>
                          <span className="cc-row-apy">
                            <Redacted value={row.apr} isPaid={isPaid}>
                              {(v) => row.aprCapped ? <span title={row.aprLabel}>&gt;200%/yr</span> : <>{Number(v).toFixed(0)}%/yr</>}
                            </Redacted>
                          </span>
                        </span>
                      </div>

                      {isOpen && (
                        <div className="cc-expand">
                          <RewardShareCalc row={row} satv={satv} isPaid={isPaid} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <p className="cc-note">
              Net is after estimated adverse selection, at ${CAPITAL_BASIS.toLocaleString()} deployed. Pool competition is
              derived from existing qualifying liquidity vs a reference $1k maker. A reward pool can be re-weighted or end
              at any time — these are not promised yields.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Row-expand share → reward calculator. Reuses the SSOT: the row's net $/day is per
 * $1,000, and reward scales linearly with deployed share (scaleToCapitalBasis) — no
 * second math path. Share is clamped to the market's real capacity (book depth at band).
 */
function RewardShareCalc({ row, satv, isPaid }: {
  row: Row;
  satv: ReturnType<typeof saturationView>;
  isPaid: boolean;
}) {
  const cap = row.capacityUsd;
  const maxShare = cap != null && cap > 0 ? Math.floor(cap) : 100_000;
  const [share, setShare] = useState<number>(Math.min(1000, maxShare));

  const clampShare = (v: number) => Math.max(1, Math.min(maxShare, Math.round(v)));
  const rewardPerDay = row.netUsdPerDay != null ? scaleToCapitalBasis(row.netUsdPerDay, CAPITAL_BASIS, share) : null;

  return (
    <div className="rw-calc">
      {/* POOL COMPETITION */}
      <div className="rw-calc-block">
        <span className="rw-calc-h">Pool competition</span>
        <span className="rw-satwrap rw-satwrap-lg">
          <Redacted value={row.saturation} isPaid={isPaid} nullDisplay={<span className="rw-dim">not measured from this feed</span>}>
            {(sat) => {
              const v = saturationView(Number(sat));
              if (!v) return null;
              return (
                <>
                  <span className="rw-satbar-track"><span className={`rw-satbar-fill is-${v.band}`} style={{ width: `${v.pct}%` }} /></span>
                  <span className={`rw-sat-label is-${v.band}`}>{Math.round(v.pct)}% of the reward pool is already claimed by other makers</span>
                </>
              );
            }}
          </Redacted>
        </span>
      </div>

      {/* YOUR QUALIFYING SHARE → reward */}
      <div className="rw-calc-block">
        <span className="rw-calc-h">Your qualifying share</span>
        <div className="rw-calc-row">
          <div className="rw-calc-field">
            <span className="rw-calc-lbl">deploy ($, clamped to capacity)</span>
            <input
              className="rw-calc-input" type="number" min={1} max={maxShare} step={100}
              value={share}
              onChange={(e) => setShare(clampShare(Number(e.target.value)))}
              aria-label="your qualifying share in dollars"
            />
            <span className="rw-calc-cap">
              max{' '}
              <Redacted value={cap} isPaid={isPaid}>{(v) => <>{fmtUsd(Number(v))}</>}</Redacted>
              {' '}· book depth at band
            </span>
          </div>
          <div className="rw-calc-out">
            <span className="rw-calc-out-val">
              <Redacted value={rewardPerDay} isPaid={isPaid}>{(v) => <>${Number(v).toFixed(2)}</>}</Redacted>
            </span>
            <span className="rw-calc-out-cap">your reward · per day</span>
          </div>
        </div>
        <div className="rw-calc-meta">
          <span>
            pool{' '}
            <Redacted value={row.poolDayUsd} isPaid={isPaid}>{(v) => <strong>${Number(v).toFixed(0)}/day</strong>}</Redacted>
          </span>
          <span className="rw-dim">net of adverse selection · run-rate, not guaranteed</span>
          {row.isTrap && <span className="rw-trap">⚠ trap market</span>}
        </div>
      </div>
    </div>
  );
}

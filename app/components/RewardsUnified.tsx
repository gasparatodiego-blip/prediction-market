'use client';

import { useEffect, useMemo, useState } from 'react';
import { Redacted } from './ui/Redacted';
import { EmptyState } from './ds';
import { APY_CAP, APY_CAP_LABEL } from '@/lib/honest-display';
// REAL reward-share math (published Polymarket quadratic + Kalshi observed flat pro-rata).
// The saturation bar + calculator now derive from the MEASURED competitor score agent24
// scored from the live CLOB book — not the simplified lib/rewards-estimate model.
import { quadraticUserShare, flatUserShare } from '@/lib/rewardScore';
// Pure, node-verifiable filter/sort/derive — shared VERBATIM so the list the user sees and
// any measurement of the filter behaviour cannot diverge (see lib/rewards-filter.js).
import { deriveOptions, defaultState, applyFilters, sortRows, saturationView } from '@/lib/rewards-filter';

/**
 * Liquidity rewards — FILTERABLE LIST on the REAL measured reward path.
 *
 * A stacked filter bar over compact rows, each carrying a pool-competition (saturation)
 * bar; tapping a row expands a share→reward calculator. Saturation and expected reward
 * come from lib/rewardScore (the SAME published formula agent24 runs against the live
 * book), via the rewardScore block lib/rewards-normalize attaches per row — NOT the
 * hardcoded lib/rewards-estimate model.
 *
 * HONEST-ENGINE
 *  - Polymarket = MEASURED: saturation = 1 − userShare, userShare = Q_user/(Q_comp+Q_user)
 *    with Q_comp the REAL quadratic score recovered from the live CLOB book and Q_user
 *    scored by the published S(v,s)=((v−s)/v)² for the user's chosen size/distance. Expected
 *    reward = poolDay × userShare. No REF_PROXIMITY/TIME_BASE/sizeFactor anywhere.
 *  - Kalshi = OBSERVED: real pool_day + real in-band depth, but the flat pro-rata split is
 *    an inferred model (Kalshi publishes no band/formula) — labelled "observed split".
 *  - Reward $/day is GROSS from the pool (0% maker fee). Adverse selection is a separate
 *    trading cost, disclosed, not folded in. APR demoted, capped ">200%/yr".
 *  - Point-in-time snapshot: competitors re-quote continuously; excludes your uptime.
 *  - Missing real inputs → "—", never fabricated. Derived fields redact to the free lock.
 */

interface RewardScore {
  source: string;                 // 'measured-clob-quadratic' | 'observed-flat-prorata'
  model: 'polymarket' | 'kalshi';
  poolDay: number | null;
  mid: number | null;
  maxSpreadCents: number | null;  // full reward band (Polymarket); null for Kalshi
  minSize: number | null;
  competitorQ: number | null;     // real Q_min (poly) or limiting qualifying shares (kalshi)
  refCapital: number;
  refShare: number | null;        // reference $refCapital maker's pool share
}
interface Market {
  venue: 'polymarket' | 'kalshi';
  marketId: string;
  title: string;
  groupItemTitle?: string | null;
  category?: string | null;
  dailyPool: number | null;
  bookDepthAtBand: number | null;
  hoursToResolution: number | null;
  flags?: string[] | null;
  rewardScore?: RewardScore | null;
}
interface Payload { meta: any; markets: Market[]; stale: boolean; isPaid?: boolean }

/** Enriched row = the market + the REAL-path numbers the list/filters/bar read. */
interface Row {
  m: Market;
  rs: RewardScore | null;
  flags: string[];
  category: string | null;
  venue: 'polymarket' | 'kalshi';
  poolDayUsd: number | null;
  netUsdPerDay: number | null;   // GROSS reward/day at refCapital (0% maker fee)
  apr: number | null;            // annualized, capped
  aprCapped: boolean;
  capacityUsd: number | null;
  saturation: number | null;     // 0..1, 1 − refShare (measured/observed; null = unmeasured)
  measured: boolean;             // true = Polymarket live-book; false = Kalshi observed
  isTrap: boolean;
}

interface FilterState {
  categories: string[];
  venues: string[];
  minPool: number;
  maxSaturationPct: number;
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

/** Reward $/day → annualized %, capped at the honest-engine ceiling. */
function annualize(netPerDay: number | null, capital: number): { apr: number | null; capped: boolean } {
  if (netPerDay == null || capital <= 0) return { apr: null, capped: false };
  const raw = (netPerDay / capital) * 100 * 365;
  return { apr: Math.min(raw, APY_CAP), capped: raw > APY_CAP };
}

/** userShare at a chosen size (+ distance for Polymarket) via the REAL rewardScore path. */
function userShareFor(rs: RewardScore, sizeUsd: number, distanceCents: number): number | null {
  if (rs.model === 'polymarket') {
    return quadraticUserShare(rs.competitorQ, rs.mid, rs.maxSpreadCents, rs.minSize, sizeUsd, distanceCents);
  }
  return flatUserShare(rs.competitorQ, rs.mid, sizeUsd);   // Kalshi observed (distance N/A)
}

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

  // Enrich from the REAL rewardScore block: saturation, gross reward/day, APR — measured
  // (Polymarket) or observed (Kalshi). No hardcoded competition model.
  const enriched: Row[] = useMemo(() => {
    const ms = data?.markets ?? [];
    return ms.map((m) => {
      const rs = m.rewardScore ?? null;
      const flags = (m.flags ?? []).filter(Boolean);
      const refShare = rs?.refShare ?? null;
      const poolDay = rs?.poolDay ?? m.dailyPool ?? null;
      const net = (poolDay != null && refShare != null) ? poolDay * refShare : null;
      const { apr, capped } = annualize(net, rs?.refCapital ?? 1000);
      return {
        m, rs, flags,
        category:     m.category ?? null,
        venue:        m.venue,
        poolDayUsd:   poolDay,
        netUsdPerDay: net,
        apr,
        aprCapped:    capped,
        capacityUsd:  m.bookDepthAtBand,
        saturation:   refShare != null ? 1 - refShare : null,
        measured:     rs?.source === 'measured-clob-quadratic',
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
            quote both sides inside the reward band — earn the pool share, from the live order book
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

              {/* MAX POOL COMPETITION (saturation) */}
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
              {visible.length} of {enriched.length} rows · sorted by {filters.sortByPool ? 'reward pool' : 'reward $/day'}
            </p>

            {visible.length === 0 ? (
              <EmptyState prefix="cc" title="No reward markets match these filters." sub="Loosen a filter to see more." />
            ) : (
              <div className="cc-list">
                {visible.map((row) => {
                  const { m } = row;
                  const id = `${m.venue}-${m.marketId}`;
                  const isOpen = expandedId === id;
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
                            <span className={`rw-src ${row.measured ? 'is-measured' : 'is-observed'}`}>
                              {row.measured ? 'measured · live book' : 'observed split'}
                            </span>
                            {row.isTrap && <span className="rw-trap">⚠ TRAP</span>}
                          </span>
                          <span className="cc-row-title">{m.groupItemTitle || m.title}</span>
                          <span className="cc-row-sub">
                            pool{' '}
                            <Redacted value={row.poolDayUsd} isPaid={isPaid}>{(v) => <>${Number(v).toFixed(0)}/day</>}</Redacted>
                            {' · '}APR{' '}
                            <Redacted value={row.apr} isPaid={isPaid}>
                              {(v) => row.aprCapped ? <span title={APY_CAP_LABEL}>&gt;{APY_CAP}%</span> : <>{Number(v).toFixed(0)}%</>}
                            </Redacted>
                            {' · '}cap{' '}
                            <Redacted value={row.capacityUsd} isPaid={isPaid}>{(v) => <>{fmtUsd(Number(v))}</>}</Redacted>
                          </span>
                          {/* SATURATION BAR — measured / observed; hidden/locked when unavailable */}
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
                                    <span className="rw-satbar-track" title={row.measured
                                      ? 'measured: existing makers’ quadratic pool share from the live CLOB book'
                                      : 'observed: existing makers’ share under Kalshi’s inferred flat pro-rata split'}>
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
                              {(v) => row.aprCapped ? <span title={APY_CAP_LABEL}>&gt;{APY_CAP}%/yr</span> : <>{Number(v).toFixed(0)}%/yr</>}
                            </Redacted>
                          </span>
                        </span>
                      </div>

                      {isOpen && (
                        <div className="cc-expand">
                          <RewardShareCalc row={row} isPaid={isPaid} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <p className="cc-note">
              Reward $/day is the GROSS pool share (0% maker fee), from the live order book —
              Polymarket via its published quadratic formula (measured), Kalshi via an observed
              flat pro-rata split (inferred). It is a point-in-time snapshot: competitors re-quote
              continuously, it excludes your own uptime, and adverse selection is a separate cost of
              being filled. Pools can be re-weighted or end — these are not promised yields.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Row-expand share → reward calculator, on the REAL rewardScore path. Your size (and, for
 * Polymarket, your distance from mid) are inputs to the published quadratic S(v,s); expected
 * reward = poolDay × userShare. Kalshi uses the observed flat pro-rata split (no band).
 */
function RewardShareCalc({ row, isPaid }: { row: Row; isPaid: boolean }) {
  const rs = row.rs;
  const cap = row.capacityUsd;
  const maxShare = cap != null && cap > 0 ? Math.floor(cap) : 100_000;
  const isPoly = rs?.model === 'polymarket';
  const band = rs?.maxSpreadCents ?? null;               // full band (cents)
  const typicalDist = band != null ? band / 4 : 0;       // agent24 "typical" placement

  const [share, setShare] = useState<number>(Math.min(1000, maxShare));
  const [dist, setDist] = useState<number>(typicalDist);

  const clampShare = (v: number) => Math.max(1, Math.min(maxShare, Math.round(v)));

  const userShare = rs ? userShareFor(rs, share, isPoly ? dist : 0) : null;
  const rewardPerDay = (rs?.poolDay != null && userShare != null) ? rs.poolDay * userShare : null;
  const satNow = userShare != null ? saturationView(1 - userShare) : null;

  return (
    <div className="rw-calc">
      {/* POOL COMPETITION */}
      <div className="rw-calc-block">
        <span className="rw-calc-h">
          Pool competition
          <span className={`rw-src ${row.measured ? 'is-measured' : 'is-observed'}`}>
            {row.measured ? 'measured · live book' : 'observed split'}
          </span>
        </span>
        <span className="rw-satwrap rw-satwrap-lg">
          <Redacted value={rs?.refShare ?? null} isPaid={isPaid} nullDisplay={<span className="rw-dim">not measured from this feed</span>}>
            {() => {
              const v = satNow;
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
            <span className="rw-calc-out-cap">gross reward · per day</span>
          </div>
        </div>

        {/* Polymarket: distance from mid is a real input to the quadratic score */}
        {isPoly && band != null && (
          <div className="rw-calc-dist">
            <div className="cc-slider-head">
              <span className="rw-calc-lbl">distance from mid (¢) · closer scores higher</span>
              <span className="cc-slider-val">{dist.toFixed(2)}¢ / band {band}¢</span>
            </div>
            <input className="cc-frange" type="range" min={0} max={band / 2} step={0.05}
              value={dist} onChange={(e) => setDist(Number(e.target.value))} aria-label="distance from mid in cents" />
          </div>
        )}

        <div className="rw-calc-meta">
          <span>
            pool{' '}
            <Redacted value={rs?.poolDay ?? row.poolDayUsd} isPaid={isPaid}>{(v) => <strong>${Number(v).toFixed(0)}/day</strong>}</Redacted>
          </span>
          <span className="rw-dim">
            gross of adverse selection · point-in-time snapshot · excludes your uptime
            {row.measured ? '' : ' · split inferred (observed)'}
          </span>
          {row.isTrap && <span className="rw-trap">⚠ trap market</span>}
        </div>
      </div>
    </div>
  );
}

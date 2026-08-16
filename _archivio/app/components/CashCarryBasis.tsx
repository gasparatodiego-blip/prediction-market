'use client';

import { useEffect, useMemo, useState } from 'react';
import { Redacted } from './ui/Redacted';
import { EmptyState } from './ds';
import CarryPositionCalculator from './CarryPositionCalculator';
import { APY_CAP, APY_CAP_LABEL, isOverApyCap } from '@/lib/honest-display';
// Pure, node-tested filter/sort/derive logic — shared verbatim so the list the user
// sees and any measurement of the filter behaviour cannot diverge (see lib/carry-filter.js).
import { deriveOptions, defaultState, applyFilters, sortRows } from '@/lib/carry-filter';
// When the producing agent (agent19) is stopped its JSON freezes; we must not present the frozen
// net/APY/capacity as current. This note + the "—" convention keep the surface honest.
import CollectionStoppedNote from '@/app/components/CollectionStoppedNote';
import { STOPPED_DASH } from '@/lib/collection-status';

/**
 * Cash & Carry (basis) tab — FILTERABLE LIST.
 *
 * Classic desk surface: a stacked filter panel (venue/asset chips, sliders, checkboxes)
 * over compact rows. Each row shows the round-trip fee IN DOLLARS inline; tapping a row
 * expands the EXISTING position calculator (CarryPositionCalculator, embedded) — the same
 * fetch + fee math + risk-free comparison + armed-only auto-execute, never a second path.
 *
 * HONEST-ENGINE, unchanged from the card surface:
 *  - net $/day is the primary $ figure, at the stated $1,000 basis.
 *  - annualized is demoted, rendered AMBER below the risk-free reference, and capped +
 *    labelled above 200%/yr via lib/honest-display.
 *  - prices are the executable legs (spot ask / future bid), never mid.
 *  - capacity is real order-book depth; unknown is "—", never fabricated.
 *  - fees shown in $ from the real fee model, marked "~" where the venue rate is estimated.
 *  - derived fields (net/annualized/capacity/fee/basis) are redacted for the free tier;
 *    raw spot/future prices stay as teaser.
 *  - filters run on the real API fields; a row missing a field is excluded from that
 *    filter, never fabricated.
 */

interface FeeLeg { label: string | null; pct: number | null }
interface FeeModel {
  legs: FeeLeg[] | null; totalPct: number | null; verified: boolean;
  isAssumption: boolean; source: string; note: string;
}
interface BasisCard {
  id: string;
  asset: string | null;
  venue: string | null;
  contract: string | null;
  expiryDate: string | null;
  daysToExpiry: number | null;
  tenorDays: number | null;
  spotAsk: number | null;
  futureBid: number | null;
  executableBasisPct: number | null;
  annualizedPct: number | null;
  annualizedLabel: string | null;
  belowRiskFree: boolean | null;
  riskFreePct: number;
  netUsdPerDay: number | null;
  capitalBasisUsd: number;
  capacityUsd: number | null;
  bindingLeg: string | null;
  direction: string | null;
  coinMargined: boolean;
  feeModel: FeeModel | null;
  feeUsd: number | null;
  feeIsAssumption: boolean | null;
}
interface CarryMeta {
  riskFreePct: number;
  capitalBasisUsd: number;
  bestApyPct: number | null;
  bestBeatsRiskFree: boolean | null;
  convergenceObserved: boolean;
  convergenceNote: string;
}
interface Payload {
  agentStatus: string;
  updatedAt: string | null;
  basisCards: BasisCard[];
  carryMeta: CarryMeta;
  isPaid?: boolean;
}

interface FilterState {
  assets: string[];
  venues: string[];
  directions: string[];
  minAnnualized: number;
  minCapacity: number;
  maxDays: number;          // Infinity = no cap (slider sits at the data max)
  expiring30: boolean;
  aboveRiskFreeOnly: boolean;
  sortByLowestFee: boolean;
}

const fmtUsd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000   ? `$${(n / 1_000).toFixed(0)}k`
  : `$${n.toFixed(0)}`;

const toggle = (arr: string[], v: string) =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

export default function CashCarryBasis() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(() => defaultState({}) as FilterState);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch('/api/carry', { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        setData(j); setErr(null);
      } catch (e: any) {
        if (alive) setErr(e?.message ?? 'fetch failed');
      }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const meta = data?.carryMeta;
  const isPaid = data?.isPaid ?? false;
  // Collection stopped = the API's freshness signal is anything other than 'running' ('stale'|'offline').
  const stopped = !!(data?.agentStatus && data.agentStatus !== 'running');
  const cards: BasisCard[] = data?.basisCards ?? [];
  const riskFree = meta?.riskFreePct ?? 4.0;

  const opts = useMemo(() => deriveOptions(cards), [cards]);
  const visible: BasisCard[] = useMemo(
    () => sortRows(applyFilters(cards, filters, riskFree), filters),
    [cards, filters, riskFree],
  );

  const set = (patch: Partial<FilterState>) => setFilters((f) => ({ ...f, ...patch }));
  const maxDaysVal = Number.isFinite(filters.maxDays) ? filters.maxDays : opts.dteMax;

  return (
    <div className="cashcarry">
      <div className="cc-shell">

        {/* ── header ─────────────────────────────────────────────── */}
        <header className="cc-head">
          <h1 className="cc-title">
            <span className="cc-title-dim">Edgeradar /</span> cash &amp; carry
            <span className="cc-title-accent"> · basis</span>
          </h1>
          <p className="cc-sub">buy spot, short the dated future, hold to expiry — capture the basis</p>
          {stopped && <CollectionStoppedNote asOf={data?.updatedAt ?? null} className="cc-stopped" />}
        </header>

        {/* ── signal banner (NOT auto-fire) ──────────────────────── */}
        <div className="cc-signal">
          <span className="cc-signal-txt">
            <span className="cc-diamond" aria-hidden>◆</span> carry signal · hold-to-expiry · execution is your call
          </span>
          {meta && (
            <span className={`cc-ceiling ${meta.bestBeatsRiskFree === false ? 'is-amber' : ''}`}>
              ceiling{' '}
              <Redacted value={meta.bestApyPct} isPaid={isPaid}>{(v) => <>{Number(v).toFixed(2)}%/yr</>}</Redacted>
              {meta.bestBeatsRiskFree === false ? ` < risk-free ${riskFree}%` : ` vs risk-free ${riskFree}%`}
            </span>
          )}
        </div>

        {/* ── persistent honest note ─────────────────────────────── */}
        {meta && !meta.convergenceObserved && <p className="cc-note">{meta.convergenceNote}</p>}

        {/* ── states ─────────────────────────────────────────────── */}
        {err && <EmptyState prefix="cc" title="Basis feed unavailable" sub={err} />}
        {!err && !data && <EmptyState prefix="cc" sub="Loading basis book…" />}
        {!err && data && cards.length === 0 && (
          <EmptyState prefix="cc" title="No basis rows right now" sub="The carry scanner found nothing that clears fees." />
        )}

        {/* ── filter bar + list ──────────────────────────────────── */}
        {!err && data && cards.length > 0 && (
          <>
            <div className="cc-filterbar">
              {/* ASSET */}
              <div className="cc-fgroup">
                <span className="cc-flabel">Asset</span>
                <div className="cc-chips">
                  {opts.assets.map((a: string) => (
                    <button key={a} type="button"
                      className={`cc-fchip ${filters.assets.includes(a) ? 'is-on' : ''}`}
                      onClick={() => set({ assets: toggle(filters.assets, a) })}>{a}</button>
                  ))}
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

              {/* DIRECTION */}
              <div className="cc-fgroup">
                <span className="cc-flabel">Direction</span>
                <div className="cc-chips">
                  {opts.directions.map((d: string) => (
                    <button key={d} type="button"
                      className={`cc-fchip ${filters.directions.includes(d) ? 'is-on' : ''}`}
                      onClick={() => set({ directions: toggle(filters.directions, d) })}>{d}</button>
                  ))}
                  {opts.directions.length === 0 && <span className="cc-slider-val">—</span>}
                </div>
              </div>

              {/* MIN ANNUALIZED */}
              <div className="cc-fgroup cc-slider">
                <div className="cc-slider-head">
                  <span className="cc-flabel">Min annualized</span>
                  <span className="cc-slider-val">≥ {filters.minAnnualized.toFixed(1)}%/yr</span>
                </div>
                <input className="cc-frange" type="range" min={0} max={Math.max(opts.annMax, 0.1)} step={0.1}
                  value={filters.minAnnualized}
                  onChange={(e) => set({ minAnnualized: Number(e.target.value) })} aria-label="minimum annualized" />
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

              {/* MAX DAYS TO EXPIRY */}
              <div className="cc-fgroup cc-slider">
                <div className="cc-slider-head">
                  <span className="cc-flabel">Max days to expiry</span>
                  <span className="cc-slider-val">≤ {maxDaysVal}d</span>
                </div>
                <input className="cc-frange" type="range" min={opts.dteMin} max={Math.max(opts.dteMax, opts.dteMin + 1)} step={1}
                  value={maxDaysVal}
                  onChange={(e) => set({ maxDays: Number(e.target.value) })} aria-label="maximum days to expiry" />
              </div>

              {/* CHECKBOXES */}
              <div className="cc-checks">
                <label className={`cc-check ${filters.expiring30 ? 'is-on' : ''}`}>
                  <input type="checkbox" checked={filters.expiring30}
                    onChange={(e) => set({ expiring30: e.target.checked })} />
                  Expiring ≤30d
                </label>
                <label className={`cc-check ${filters.aboveRiskFreeOnly ? 'is-on' : ''}`}>
                  <input type="checkbox" checked={filters.aboveRiskFreeOnly}
                    onChange={(e) => set({ aboveRiskFreeOnly: e.target.checked })} />
                  Above risk-free only
                </label>
                <label className={`cc-check ${filters.sortByLowestFee ? 'is-on' : ''}`}>
                  <input type="checkbox" checked={filters.sortByLowestFee}
                    onChange={(e) => set({ sortByLowestFee: e.target.checked })} />
                  Sort by lowest fee
                </label>
              </div>
            </div>

            <p className="cc-count">
              {visible.length} of {cards.length} rows · sorted by {filters.sortByLowestFee ? 'lowest fee' : 'net $/day'}
            </p>

            {visible.length === 0 ? (
              <EmptyState prefix="cc" title="No basis rows match these filters." sub="Loosen a filter to see more." />
            ) : (
              <div className="cc-list">
                {visible.map((c) => {
                  const isOpen = expandedId === c.id;
                  return (
                    <div key={c.id}>
                      <div
                        className={`cc-row ${isOpen ? 'is-open' : ''}`}
                        role="button"
                        tabIndex={0}
                        aria-expanded={isOpen}
                        onClick={() => setExpandedId(isOpen ? null : c.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedId(isOpen ? null : c.id); }
                        }}
                      >
                        <span className="cc-row-l">
                          <span className="cc-row-title">
                            {c.asset ?? '—'} · {c.venue ?? '—'} · exp {c.expiryDate ?? '—'}
                          </span>
                          <span className="cc-row-sub">
                            basis{' '}
                            <Redacted value={c.executableBasisPct} isPaid={isPaid}>
                              {(v) => <>{Number(v) >= 0 ? '+' : ''}{Number(v).toFixed(2)}%</>}
                            </Redacted>
                            {' · '}fee {c.feeIsAssumption ? '~' : ''}
                            <Redacted value={c.feeUsd} isPaid={isPaid}>{(v) => <>${Number(v).toFixed(2)}</>}</Redacted>
                            {' · '}{c.daysToExpiry ?? '—'}d
                            {' · '}cap{' '}
                            {stopped ? STOPPED_DASH : (
                              <Redacted value={c.capacityUsd} isPaid={isPaid}>{(v) => <>{fmtUsd(Number(v))}</>}</Redacted>
                            )}
                          </span>
                        </span>
                        <span className="cc-row-r">
                          <span className="cc-row-net">
                            {stopped ? STOPPED_DASH : (
                              <Redacted value={c.netUsdPerDay} isPaid={isPaid}>{(v) => <>${Number(v).toFixed(2)}/day</>}</Redacted>
                            )}
                          </span>
                          <span className={`cc-row-apy ${!stopped && c.belowRiskFree ? 'is-amber' : ''}`}>
                            {stopped ? STOPPED_DASH : (
                              <Redacted value={c.annualizedPct} isPaid={isPaid}>
                                {(v) => isOverApyCap(Number(v))
                                  ? <span title={APY_CAP_LABEL}>&gt;{APY_CAP}%/yr</span>
                                  : <>{Number(v).toFixed(2)}%/yr</>}
                              </Redacted>
                            )}
                          </span>
                        </span>
                      </div>

                      {isOpen && (
                        <div className="cc-expand">
                          <CarryPositionCalculator id={c.id.replace('|', '-')} embedded />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

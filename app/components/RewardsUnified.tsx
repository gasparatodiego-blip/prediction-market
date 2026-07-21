'use client';

import { useEffect, useMemo, useState } from 'react';
import { Redacted } from './ui/Redacted';
import { EmptyState } from './ds';
import { APY_CAP } from '@/lib/honest-display';
import { computeLiquidityYield } from '@/lib/liquidity-yield';
// Pure, node-verifiable filter/sort/derive — shared VERBATIM so the list the user sees and
// any measurement of the filter behaviour cannot diverge (see lib/rewards-filter.js).
import { deriveOptions, defaultState, applyFilters, sortRows, saturationView } from '@/lib/rewards-filter';

/**
 * Liquidity rewards — BALANCE-DRIVEN yield list.
 *
 * A sticky balance control drives every row: each $/day is computed from the user's own
 * balance via lib/liquidity-yield (deploy min(balance, book space), dilute share against the
 * qualifying liquidity already there). This replaces the old inflated aggregate number
 * (pool × filled%, i.e. the whole-book share as if you owned the book) — that path is gone.
 *
 * HONEST-ENGINE
 *  - $/day = poolDay × deployed/(competitorDepth + deployed); deploying more shrinks your share.
 *  - competitorDepth is the qualifying liquidity you really compete with. Polymarket rewards are
 *    two-sided (Qmin), so it is BOTH sides' in-band depth (Qnear + Qopp) — a thin near side no
 *    longer reads as domination. Kalshi is one-sided (Qopp absent → near side only). See
 *    lib/liquidity-yield.ts for the derivation. The depth shown on the card IS competitorDepth,
 *    so "depth $X · share Y%" is always internally consistent.
 *  - Deployment caps at remaining book space (cap − Q); the rest is idle, shown calmly.
 *  - Real fields only: pool = rewardsDailyRate, near/far depth = per-side in-band book depth.
 *    Polymarket = measured (quadratic CLOB); Kalshi = observed (inferred flat pro-rata).
 *  - Net $/day is the sole headline; the annualized line was removed from the cards.
 *  - Missing pool / qualifying liquidity ⇒ "—", never fabricated. Free tier redacts to lock.
 */

const BAL_MIN = 1;
const BAL_MAX = 500_000;
const BAL_DEFAULT = 1_000;
const BAL_CHIPS = [100, 1_000, 10_000, 100_000];

// log-scale slider ↔ dollars (0..1000 slider units span $1..$500k)
const balToPos = (b: number) => Math.round((Math.log(Math.max(BAL_MIN, b)) / Math.log(BAL_MAX)) * 1000);
const posToBal = (p: number) => Math.min(BAL_MAX, Math.max(BAL_MIN, Math.round(Math.exp((p / 1000) * Math.log(BAL_MAX)))));

interface RewardScore {
  source: string;
  model: 'polymarket' | 'kalshi';
  poolDay: number | null;
  refShare: number | null;        // reference maker's live-book pool share = 1 − saturation
  refCapital: number;
}
interface SideBook { bookDepthAtBand: number | null }
interface Market {
  venue: 'polymarket' | 'kalshi';
  marketId: string;
  title: string;
  groupItemTitle?: string | null;
  category?: string | null;
  dailyPool: number | null;
  bookDepthAtBand: number | null;   // near-side (== sides.yes) in-band qualifying depth
  // Per-side in-band depth. Polymarket exposes both; the opposite (NO) side feeds the honest
  // two-sided dilution. Redacted to null on the free tier (compute degrades to the lock state).
  sides?: { yes?: SideBook | null; no?: SideBook | null } | null;
  flags?: string[] | null;
  rewardScore?: RewardScore | null;
}
interface Payload { meta: any; markets: Market[]; stale: boolean; isPaid?: boolean }

/** Balance-independent base derived from the payload (recomputed only when data changes). */
interface Base {
  m: Market;
  flags: string[];
  category: string | null;
  venue: 'polymarket' | 'kalshi';
  poolDayUsd: number | null;      // real reward pool $/day
  cap: number | null;             // real in-band book depth
  filled: number | null;          // live-book reference share (= 1 − saturation)
  qualifyingLiquidity: number | null; // near-side in-band depth (Q)
  oppDepth: number | null;        // opposite-side in-band depth (Polymarket two-sided; else null)
  saturation: number | null;      // 1 − filled (bar value)
  measured: boolean;
  isTrap: boolean;
}
/** Base + the balance-driven yield the list/filters/row read. */
interface Row extends Base {
  poolDayUsd: number | null;
  netUsdPerDay: number | null;    // dailyUsd (primary) — sort key reused by rewards-filter
  apr: number | null;             // annualized on DEPLOYED, capped — filter-only (not rendered)
  capacityUsd: number | null;     // = cap (filter field name)
  deployed: number;
  idle: number;
  space: number;
  share: number;
  unknown: boolean;
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

// Depth formatter — keeps ONE decimal in the $k range (trailing .0 dropped) so the shown
// "depth $X" stays consistent with the Q used in the share calc. fmtUsd rounds $1,328 → "$1k",
// which makes a 16% share look like a math error; fmtDepth shows "$1.3k".
const fmtDepth = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000   ? `$${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  : `$${n.toFixed(0)}`;

const toggle = (arr: string[], v: string) =>
  arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

export default function RewardsUnified() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [balance, setBalance] = useState<number>(BAL_DEFAULT);
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

  // Balance-INDEPENDENT base: real fields only. filled = reference live-book share; cap = book
  // depth; Q = cap × filled. Any missing → the row yields "—" (never fabricated).
  const base: Base[] = useMemo(() => {
    const ms = data?.markets ?? [];
    return ms.map((m) => {
      const rs = m.rewardScore ?? null;
      const flags = (m.flags ?? []).filter(Boolean);
      const depth = m.bookDepthAtBand;         // REAL near-side in-band qualifying liquidity (Q)
      const filled = rs?.refShare ?? null;     // reference maker's live-book share → bar only
      // Opposite-side in-band depth — ONLY for Polymarket, whose reward is a two-sided Qmin. Kalshi
      // is an observed flat pro-rata split (one-sided model), so it never gets the opposite side.
      const oppDepth = m.venue === 'polymarket' ? (m.sides?.no?.bookDepthAtBand ?? null) : null;
      return {
        m, flags,
        category:     m.category ?? null,
        venue:        m.venue,
        poolDayUsd:   rs?.poolDay ?? m.dailyPool ?? null,
        cap:          null,                    // Polymarket exposes no reward cap → unbounded space
        filled,
        qualifyingLiquidity: depth,            // near-side Q = real in-band depth (never fabricated)
        oppDepth,                              // far-side in-band depth (two-sided dilution)
        saturation:   filled != null ? 1 - filled : null,
        measured:     rs?.source === 'measured-clob-quadratic',
        isTrap:       flags.some((f) => /^TRAP$/i.test(f)),
      };
    });
  }, [data]);

  // Balance-DRIVEN yield: recomputed live as the slider moves.
  const enriched: Row[] = useMemo(() => base.map((b) => {
    const y = computeLiquidityYield({
      poolPerDay: b.poolDayUsd, cap: b.cap, qualifyingLiquidity: b.qualifyingLiquidity,
      qualifyingLiquidityOpposite: b.oppDepth, balance,
    });
    // apr stays computed — the min-APR list FILTER (lib/rewards-filter) reads it — but it is
    // no longer rendered on the cards; net $/day is the sole headline metric.
    const apr = y.unknown ? null : Math.min(y.apyRaw, APY_CAP);
    return {
      ...b,
      netUsdPerDay: y.unknown ? null : y.dailyUsd,
      apr,
      // The depth we SHOW is the depth the share dilutes against (both sides on Polymarket),
      // so "depth $X · share Y%" is internally consistent. Also the min-capacity filter field.
      capacityUsd:  y.unknown ? null : y.competitorDepth,
      deployed:     y.deployed,
      idle:         y.idle,
      space:        y.space,
      share:        y.unknown ? 0 : y.share,
      unknown:      y.unknown,
    };
  }), [base, balance]);

  const opts = useMemo(() => deriveOptions(enriched), [enriched]);
  const visible: Row[] = useMemo(
    () => sortRows(applyFilters(enriched, filters), filters) as Row[],
    [enriched, filters],
  );

  const set = (patch: Partial<FilterState>) => setFilters((f) => ({ ...f, ...patch }));
  const clampBal = (v: number) => Math.min(BAL_MAX, Math.max(BAL_MIN, Math.round(v || 0)));

  return (
    <div className="rewards">
      <div className="cc-shell">

        <header className="cc-head">
          <h1 className="cc-title">
            <span className="cc-title-dim">Edgeradar /</span> liquidity rewards
            <span className="cc-title-accent"> · maker</span>
          </h1>
          <p className="cc-sub">
            your real $/day for the balance you deploy — diluted by the qualifying liquidity already in the book
          </p>
        </header>

        {/* ── STICKY BALANCE CONTROL ─────────────────────────────── */}
        <div className="rw-balbar">
          <div className="rw-bal-head">
            <span className="rw-bal-lbl">Your balance</span>
            <div className="rw-bal-inputwrap">
              <span className="rw-bal-dollar">$</span>
              <input
                className="rw-bal-input" type="number" min={BAL_MIN} max={BAL_MAX} step={100}
                value={balance}
                onChange={(e) => setBalance(clampBal(Number(e.target.value)))}
                aria-label="your balance in dollars"
              />
            </div>
          </div>
          <input
            className="rw-bal-range" type="range" min={0} max={1000} step={1}
            value={balToPos(balance)}
            onChange={(e) => setBalance(posToBal(Number(e.target.value)))}
            aria-label="balance slider"
          />
          <div className="rw-bal-chips">
            {BAL_CHIPS.map((c) => (
              <button key={c} type="button"
                className={`rw-bal-chip ${balance === c ? 'is-on' : ''}`}
                onClick={() => setBalance(c)}>{fmtUsd(c)}</button>
            ))}
          </div>
        </div>

        {err && <EmptyState prefix="cc" title="Rewards feed unavailable" sub={err} />}
        {!err && !data && <EmptyState prefix="cc" sub="Loading reward markets…" />}
        {!err && data && base.length === 0 && (
          <EmptyState prefix="cc" title="No reward markets clear the sanity gate right now" />
        )}

        {!err && data && base.length > 0 && (
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
              {visible.length} of {base.length} rows · your ${balance.toLocaleString()} · sorted by {filters.sortByPool ? 'reward pool' : '$/day'}
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
                            {' · '}depth{' '}
                            <Redacted value={row.capacityUsd} isPaid={isPaid}>{(v) => <>{fmtDepth(Number(v))}</>}</Redacted>
                            {!row.unknown && row.share > 0 && (
                              <> · your share <span className="rw-nowrap">{(row.share * 100).toFixed(1)}%</span></>
                            )}
                          </span>
                          {/* idle-capital note — calm, not an error */}
                          {!row.unknown && row.idle > 0 && (
                            <span className="rw-idle">
                              ${row.deployed.toFixed(0)} deployed · <span className="rw-nowrap">${row.idle.toFixed(0)} idle</span> (book full)
                            </span>
                          )}
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
                            {/* Net $/day is the sole headline metric on these cards — the
                                annualized run-rate line was removed (it dwarfed the honest
                                daily figure). "—" ONLY when pool/depth are genuinely missing
                                (unknown); a known depth always yields a finite number here. */}
                            <Redacted
                              value={row.unknown ? null : row.netUsdPerDay}
                              isPaid={isPaid}
                              nullDisplay={<span title="no reward pool or in-band depth from the feed">—</span>}
                            >
                              {(v) => <>${Number(v).toFixed(2)}/day</>}
                            </Redacted>
                          </span>
                        </span>
                      </div>

                      {isOpen && (
                        <div className="cc-expand">
                          <RewardYieldBreakdown row={row} balance={balance} isPaid={isPaid} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <p className="cc-note">
              Your $/day is what you would earn deploying your balance NOW: you take share
              deployed/(qualifying liquidity + deployed) of the pool — adding capital shrinks your
              own share. Polymarket rewards are TWO-SIDED (you must quote both sides), so your share
              dilutes against the in-band qualifying liquidity on BOTH sides — the depth shown is
              that two-sided total, which is why a thin near side beside a thick far side no longer
              reads as domination. Polymarket exposes no reward cap, so the whole balance deploys; if
              a venue ever caps qualifying liquidity, capital beyond the room left is shown idle.
              Polymarket depth/competition is measured from the live CLOB; Kalshi is an observed
              one-sided flat pro-rata split. Point-in-time snapshot; competitors re-quote; adverse
              selection is a separate cost; not a promised yield.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Row-expand breakdown — the same lib/liquidity-yield numbers, itemised, at the current
 * global balance. No second math path; nothing the row doesn't already compute.
 */
function RewardYieldBreakdown({ row, balance, isPaid }: { row: Row; balance: number; isPaid: boolean }) {
  const hasCap = Number.isFinite(row.space);   // a real venue cap → idle capital can occur
  const rowset: Array<[string, React.ReactNode]> = [
    ['reward pool',              <Redacted key="p" value={row.poolDayUsd} isPaid={isPaid}>{(v) => <>${Number(v).toFixed(0)}/day</>}</Redacted>],
    [row.venue === 'polymarket' ? 'in-band depth already there · both sides (Q)' : 'in-band depth already there (Q)',
      <Redacted key="q" value={row.capacityUsd} isPaid={isPaid}>{(v) => <>{fmtDepth(Number(v))}</>}</Redacted>],
  ];
  return (
    <div className="rw-calc">
      <div className="rw-calc-block">
        <span className="rw-calc-h">
          Your ${balance.toLocaleString()} in this book
          <span className={`rw-src ${row.measured ? 'is-measured' : 'is-observed'}`}>
            {row.measured ? 'measured · live book' : 'observed split'}
          </span>
        </span>
        <div className="rw-brk">
          {rowset.map(([k, v]) => (
            <div className="rw-brk-item" key={k}><span className="rw-brk-k">{k}</span><span className="rw-brk-v">{v}</span></div>
          ))}
        </div>
        <div className="rw-brk rw-brk-strong">
          <div className="rw-brk-item"><span className="rw-brk-k">you deploy</span>
            <span className="rw-brk-v"><Redacted value={row.unknown ? null : row.deployed} isPaid={isPaid}>{(v) => <>${Number(v).toFixed(0)}</>}</Redacted></span></div>
          {hasCap && row.idle > 0 && (
            <div className="rw-brk-item"><span className="rw-brk-k">idle (book full)</span>
              <span className="rw-brk-v rw-idle-v"><Redacted value={row.unknown ? null : row.idle} isPaid={isPaid}>{(v) => <>${Number(v).toFixed(0)}</>}</Redacted></span></div>
          )}
          <div className="rw-brk-item"><span className="rw-brk-k">your pool share</span>
            <span className="rw-brk-v"><Redacted value={row.unknown ? null : row.share} isPaid={isPaid}>{(v) => <>{(Number(v) * 100).toFixed(1)}%</>}</Redacted></span></div>
          <div className="rw-brk-item"><span className="rw-brk-k">your reward</span>
            <span className="rw-brk-v rw-brk-primary"><Redacted value={row.unknown ? null : row.netUsdPerDay} isPaid={isPaid}>{(v) => <>${Number(v).toFixed(2)}/day</>}</Redacted></span></div>
        </div>
        <div className="rw-calc-meta">
          <span className="rw-dim">
            share = deployed/(Q + deployed) · point-in-time · adverse selection is a separate cost
            {row.measured ? '' : ' · split inferred (observed)'}
          </span>
          {row.isTrap && <span className="rw-trap">⚠ trap market</span>}
        </div>
      </div>
    </div>
  );
}

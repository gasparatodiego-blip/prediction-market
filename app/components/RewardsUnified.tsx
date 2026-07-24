'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Redacted } from './ui/Redacted';
import { EmptyState } from './ds';
import MakerUniverseControl from './MakerUniverseControl';
import { APY_CAP, APY_CAP_LABEL } from '@/lib/honest-display';
// The per-operator estimated share/day — the ONE headline number, from the shared quadratic scorer
// (lib/rewardScore → rewards-normalize refShare). estUsdPerDay = poolDay × refShare; assumptions are
// explicit constants surfaced on the page. NOT the pot, NOT computed in this component.
import {
  estimatedOperatorSharePerDay,
  ASSUMED_ORDER_SIZE_USD,
  ASSUMED_PLACEMENT_LABEL,
} from '@/lib/reward-operator-estimate';
// The SAME two-sided in-band depth the filter and the old yield lib use — shown as context, not headline.
import { competitorDepthUsd } from '@/lib/reward-depth-floor';
// The 2%/day sane-reward gate — the SINGLE implementation (was wired only to the paper book). Surfacing it
// here makes a thin / over-cap reward row read as a flagged run-rate, never a clean cashable $/day.
import { REWARD_SANITY_CAP_PCT, isSanePolymarketLevel } from '@/lib/reward-gating';
// Sort + saturation view stay client presentation. FILTERING now happens SERVER-SIDE
// (app/api/rewards-unified via lib/rewards-server-filter) so the row COUNT is correct for every
// tier and the payload is genuinely filtered — the browser no longer fetches-all-and-hides.
import { sortRows, saturationView } from '@/lib/rewards-filter';

/**
 * Liquidity rewards — per-operator ESTIMATED share list.
 *
 * The headline on every row is what ONE maker would earn per day: its own modelled share of the
 * reward pot, NOT the pot (the whole prize everyone shares). It is a "stima" — a modelled figure,
 * never an observed payout — computed by the shared quadratic scorer, not in this component.
 *
 * HONEST-ENGINE
 *  - est $/day = poolDay × refShare, where refShare is a $1,000 maker's scored pool share from
 *    lib/rewardScore (Polymarket's published S(v,s) = ((v−s)/v)², Qmin two-sided) stamped by
 *    lib/rewards-normalize. Surfaced via lib/reward-operator-estimate (poolDay × refShare). The
 *    assumptions (order size, quarter-band placement) are FIXED, explicit constants, stated on the page.
 *  - It reads the market's REAL min_incentive_size and max_incentive_spread; distant competitors are
 *    down-weighted by tightness-to-mid, which is why this is higher than a naive depth split.
 *  - The pot, the two-sided in-band depth, the spread and the competition level are CONTEXT — a quiet
 *    metadata line, never the headline.
 *  - Polymarket = measured (quadratic CLOB); Kalshi = observed (inferred flat pro-rata).
 *  - Book couldn't be scored ⇒ "—", the pot stays visible, never fabricated, never 0. Free tier locks.
 */

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
  // Kalshi EXECUTABILITY inputs. qualifyingLiquidity here is the LIMITING (thinner) side in USD:
  // it is 0 exactly when a side of the book is empty (one-sided). bookSpread is non-null only when
  // BOTH best_bid and best_ask are real executable prices (never mid-derived). Both are redacted to
  // null on the free tier (→ lock, unchanged). Used ONLY to guard Kalshi rows; Polymarket ignores.
  qualifyingLiquidity?: number | null;
  bookSpread?: number | null;
  // Hours until the market resolves (real feed field, from lib/rewards-normalize). <= 0 means it
  // has ALREADY resolved → no active rewards. null when the feed didn't carry a resolution time.
  hoursToResolution?: number | null;
  flags?: string[] | null;
  rewardScore?: RewardScore | null;
}

// Honest-engine: a settled market (resolution time in the past) can never pay active LP rewards,
// so it must not appear as an actionable row. Read the REAL feed field only — a missing (null)
// hoursToResolution is NOT treated as resolved (we never fabricate a resolution time; those rows
// are left in place, matching the detail page's isResolvedMarket guard).
const isResolved = (m: Market): boolean =>
  typeof m.hoursToResolution === 'number' && Number.isFinite(m.hoursToResolution) && m.hoursToResolution <= 0;
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
  // Kalshi only: reason the row is not priceable (one-sided / non-executable book). When set, the
  // row renders "—" with this reason instead of a fabricated $/day. null on Polymarket + valid rows.
  nonExecReason: string | null;
  grossKalshi: boolean;           // Kalshi executable row → show the calm "gross" qualifier
  belowGate: boolean;             // fails the 2%/day sane-reward gate (reward-gating) → flagged, not clean
  thin: boolean;                  // carries a THIN_CAP / "THIN BOOK" flag specifically
}
/** Base + the balance-driven yield the list/filters/row read. */
interface Row extends Base {
  poolDayUsd: number | null;
  netUsdPerDay: number | null;    // dailyUsd (primary) — sort key reused by rewards-filter
  apr: number | null;             // annualized on DEPLOYED, capped — filter-only (not rendered)
  apyRaw: number | null;          // annualized on DEPLOYED, UNCAPPED — drives the run-rate cap label
  apyCapped: boolean;             // apyRaw > APY_CAP → render ">200%/yr · run-rate, not guaranteed"
  capacityUsd: number | null;     // = cap (filter field name)
  deployed: number;
  idle: number;
  space: number;
  share: number;
  unknown: boolean;
}

// Slider/chip ranges + option sets computed SERVER-SIDE over the full set (lib/rewards-server-filter
// deriveRanges), returned in meta.ranges so tightening one filter never shrinks another's range.
interface Ranges {
  poolMax: number;
  depthMax: number;
  spreadMaxCents: number;
  categories: string[];
  venues: string[];
  hasCompetition: boolean;
}

// The six required server filters + category. These are the ONLY controls that hit the API; they
// live in the URL query string so the view survives refresh and is shareable. Sort + balance are
// client presentation/compute (also mirrored to the URL for a fully reproducible shared view).
interface FilterState {
  venue: 'all' | 'polymarket' | 'kalshi';
  categories: string[];
  minPool: number;
  minDepth: number;        // min book depth at touch ($)
  maxSpreadCents: number;  // max spread (¢); at the range max ⇒ no constraint
  maxCompetitionPct: number;
  hideThin: boolean;
  // client presentation only:
  sortByPool: boolean;
  sortDir: 'asc' | 'desc';
}

const SENTINEL_SPREAD = -1;   // "not yet initialised from ranges" → treated as any
const DEFAULT_FILTERS: FilterState = {
  venue: 'all',
  categories: [],
  minPool: 0,
  minDepth: 0,
  maxSpreadCents: SENTINEL_SPREAD,
  maxCompetitionPct: 100,
  hideThin: false,
  sortByPool: false,
  sortDir: 'desc',
};

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

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Parse the URL query string into filter state (shareable / survives refresh). */
function parseFiltersFromUrl(sp: URLSearchParams): FilterState {
  const nOr = (k: string, d: number) => {
    const v = sp.get(k);
    const n = Number(v);
    return v != null && v !== '' && Number.isFinite(n) ? n : d;
  };
  const venueRaw = (sp.get('venue') || 'all').toLowerCase();
  const venue: FilterState['venue'] =
    venueRaw === 'polymarket' || venueRaw === 'kalshi' ? venueRaw : 'all';
  const cats = sp.get('category');
  return {
    venue,
    categories: cats ? cats.split(',').map((s) => s.trim()).filter(Boolean) : [],
    minPool: Math.max(0, nOr('minPool', 0)),
    minDepth: Math.max(0, nOr('minDepth', 0)),
    maxSpreadCents: sp.get('maxSpread') != null ? Math.max(0, nOr('maxSpread', SENTINEL_SPREAD)) : SENTINEL_SPREAD,
    maxCompetitionPct: Math.min(100, Math.max(0, nOr('maxCompetition', 100))),
    hideThin: sp.get('hideThin') === '1' || sp.get('hideThin') === 'true',
    sortByPool: sp.get('sort') === 'pool',
    sortDir: sp.get('dir') === 'asc' ? 'asc' : 'desc',
  };
}

/** The server-filter subset → query params (only constraining values; the six API filters). */
function serverParams(f: FilterState, r: Ranges | null): URLSearchParams {
  const p = new URLSearchParams();
  if (f.venue !== 'all') p.set('venue', f.venue);
  if (f.categories.length) p.set('category', f.categories.join(','));
  if (f.minPool > 0) p.set('minPool', String(f.minPool));
  if (f.minDepth > 0) p.set('minDepth', String(f.minDepth));
  // maxSpread constrains only when set AND below the full-set max (otherwise "any").
  if (f.maxSpreadCents >= 0 && (!r || f.maxSpreadCents < r.spreadMaxCents)) p.set('maxSpread', String(f.maxSpreadCents));
  if (f.maxCompetitionPct < 100) p.set('maxCompetition', String(f.maxCompetitionPct));
  if (f.hideThin) p.set('hideThin', '1');
  return p;
}

export default function RewardsUnified() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [ranges, setRanges] = useState<Ranges | null>(null);
  const [filters, setFilters] = useState<FilterState>(
    () => parseFiltersFromUrl(searchParams as unknown as URLSearchParams),
  );

  // The ONLY inputs that hit the API. Sort is excluded on purpose (client presentation).
  const apiQuery = serverParams(filters, ranges).toString();

  // FETCH — re-runs when the server-filter query changes (debounced for slider drags) + a 60s
  // refresh. The API returns the FILTERED rows + meta.{totalMarkets,matchedMarkets,ranges}.
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch(`/api/rewards-unified${apiQuery ? `?${apiQuery}` : ''}`, { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        setData(j);
        if (j?.meta?.ranges) setRanges(j.meta.ranges);
        setErr(null);
      } catch (e: any) {
        if (alive) setErr(e?.message ?? 'fetch failed');
      }
    }
    const deb = setTimeout(load, 200);
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearTimeout(deb); clearInterval(t); };
  }, [apiQuery]);

  // URL SYNC — mirror the full view (filters + sort) to the query string so it survives refresh and
  // is shareable. replace (not push) + scroll:false so it never spams history/jumps.
  useEffect(() => {
    const p = serverParams(filters, ranges);
    if (filters.sortByPool) p.set('sort', 'pool');
    if (filters.sortDir === 'asc') p.set('dir', 'asc');
    const qs = p.toString();
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
  }, [filters, ranges, router]);

  const isPaid = data?.isPaid ?? false;

  // Balance-INDEPENDENT base: real fields only. filled = reference live-book share; cap = book
  // depth; Q = cap × filled. Any missing → the row yields "—" (never fabricated).
  const base: Base[] = useMemo(() => {
    // Drop already-resolved markets before any yield math — a settled pool is not an opportunity.
    // Rows with no resolution time in the feed are kept as-is (never fabricated as resolved).
    const ms = (data?.markets ?? []).filter((m) => !isResolved(m));
    return ms.map((m) => {
      const rs = m.rewardScore ?? null;
      const flags = (m.flags ?? []).filter(Boolean);
      const depth = m.bookDepthAtBand;         // REAL near-side in-band qualifying liquidity (Q)
      const filled = rs?.refShare ?? null;     // reference maker's live-book share → bar only
      // Opposite-side in-band depth — ONLY for Polymarket, whose reward is a two-sided Qmin. Kalshi
      // is an observed flat pro-rata split (one-sided model), so it never gets the opposite side.
      const oppDepth = m.venue === 'polymarket' ? (m.sides?.no?.bookDepthAtBand ?? null) : null;

      // ── Kalshi EXECUTABLE-DEPTH GUARD ──────────────────────────────────────────────────────
      // Kalshi's flat pro-rata dilutes against BOTH sides summed (bookDepthAtBand = bothUsd). But
      // that number is only honest when the book is genuinely two-sided & executable. When a side
      // is empty (limiting qualifyingLiquidity ≤ 0) OR the best bid/ask is missing so the price was
      // mid-derived (bookSpread null), the "share" collapses to spurious dominance ($1k "owning"
      // ~88% of a $139 one-sided book → thousands/day). That is exactly the non-executable-depth /
      // "too good to be true" violation, so the row renders "—" with a reason instead of a number.
      // Guard fires ONLY when the real fields are present (paid tier); on the free tier they are
      // redacted to null → guard skipped → the row degrades to the normal lock (unchanged).
      const isKalshi   = m.venue === 'kalshi';
      const limitingUsd = m.qualifyingLiquidity;   // feed LIMITING (thinner) side, USD
      let nonExecReason: string | null = null;
      if (isKalshi && fin(limitingUsd)) {
        if (limitingUsd <= 0)          nonExecReason = 'one-sided book · no executable two-sided depth';
        else if (m.bookSpread == null) nonExecReason = 'no executable bid/ask · price would be mid-derived';
      }
      // null Q ⇒ the lib returns unknown ⇒ the row renders "—". Polymarket path is untouched.
      const execQ = nonExecReason ? null : depth;

      // ── 2%/day SANE-REWARD GATE, wired here from the single reward-gating implementation. A row that
      //    carries any gate flag (THIN_CAP/"THIN BOOK", below-floor, one-sided, …) does NOT pass, so it is
      //    surfaced as flagged rather than presented as a clean cashable $/day. `thin` is the specific
      //    dayYield > REWARD_SANITY_CAP_PCT case. ──
      const passesSaneGate = isSanePolymarketLevel({ flags });   // flags.length === 0, venue-agnostic on the string[]
      const thin = flags.some((f) => /THIN/i.test(f));

      return {
        m, flags,
        category:     m.category ?? null,
        venue:        m.venue,
        poolDayUsd:   rs?.poolDay ?? m.dailyPool ?? null,
        cap:          null,                    // Polymarket exposes no reward cap → unbounded space
        filled,
        qualifyingLiquidity: execQ,            // near-side Q (Kalshi: nulled when non-executable)
        oppDepth,                              // far-side in-band depth (two-sided dilution)
        saturation:   filled != null ? 1 - filled : null,
        measured:     rs?.source === 'measured-clob-quadratic',
        isTrap:       flags.some((f) => /^TRAP$/i.test(f)),
        nonExecReason,
        grossKalshi:  isKalshi,                // executable Kalshi rows show the calm "gross" tag
        belowGate:    !passesSaneGate,
        thin,
      };
    });
  }, [data]);

  // FIXED-ASSUMPTION estimate: the modelled $/day for a $1,000 order quoted a quarter-band off the
  // mid, from the shared quadratic scorer (poolDay × refShare). No balance slider, no second math
  // path. A row that couldn't be scored (est.unknown) OR a non-executable Kalshi book renders "—".
  const enriched: Row[] = useMemo(() => base.map((b) => {
    const est = estimatedOperatorSharePerDay(b.m.rewardScore ?? null);
    const unknown = est.unknown || b.nonExecReason != null;
    const netUsdPerDay = unknown ? null : est.estUsdPerDay;
    const share = unknown ? 0 : (est.share ?? 0);
    // Annualized on the ASSUMED order size — a pure run-rate VIEW of the same estimate (drives the
    // >200%/yr cap caveat only; never a separate share computation).
    const apyRaw = unknown || netUsdPerDay == null
      ? null
      : (netUsdPerDay * 365 / est.assumedOrderSizeUsd) * 100;
    return {
      ...b,
      netUsdPerDay,
      apr:          apyRaw == null ? null : Math.min(apyRaw, APY_CAP),
      apyRaw,
      apyCapped:    apyRaw != null && apyRaw > APY_CAP,
      // The two-sided in-band depth already in the book — shown as CONTEXT (never the headline), the
      // exact number the filter reads (lib/reward-depth-floor competitorDepthUsd). Real tier ⇒ "—"
      // when the feed didn't carry it; free tier ⇒ redacted lock (depth is null).
      capacityUsd:  competitorDepthUsd(b.m),
      deployed:     est.assumedOrderSizeUsd,   // the fixed assumed order the estimate is priced for
      idle:         0,
      space:        Infinity,
      share,
      unknown,
    };
  }), [base]);

  // Rows are ALREADY filtered by the server (lib/rewards-server-filter). The client only SORTS
  // (presentation) — no second filter pass, so the shown count can never diverge from the API's
  // matched count.
  const visible: Row[] = useMemo(
    () => sortRows(enriched, filters) as Row[],
    [enriched, filters],
  );

  const set = (patch: Partial<FilterState>) => setFilters((f) => ({ ...f, ...patch }));

  // Counts come from the server (meta) — the visible proof the filter is wired: total → matched.
  const total = data?.meta?.totalMarkets ?? base.length;
  const rg: Ranges = ranges ?? { poolMax: 0, depthMax: 0, spreadMaxCents: 0, categories: [], venues: [], hasCompetition: false };
  const VENUE_CHIPS: Array<FilterState['venue']> = ['all', 'polymarket', 'kalshi'];
  // The REAL depth-at-touch floor ($) from the server (env REWARD_DEPTH_TOUCH_FLOOR_USD or $25 default).
  // Stated in the "hide thin books" help so the copy can never drift from the code.
  const depthFloor = fin(data?.meta?.rewardDepthFloorUsd) ? (data!.meta.rewardDepthFloorUsd as number) : null;
  // Human summary of the constraints in force — shown in the calm zero-match empty state.
  const spreadActive = filters.maxSpreadCents >= 0 && filters.maxSpreadCents < rg.spreadMaxCents;
  const activeFilters: string[] = [
    filters.venue !== 'all' ? `venue: ${filters.venue}` : null,
    filters.categories.length ? `category: ${filters.categories.join(', ')}` : null,
    filters.minPool > 0 ? `min pot ≥ ${fmtUsd(filters.minPool)}/day` : null,
    filters.minDepth > 0 ? `min depth ≥ ${fmtUsd(filters.minDepth)}` : null,
    spreadActive ? `spread ≤ ${filters.maxSpreadCents}¢` : null,
    filters.maxCompetitionPct < 100 ? `competition ≤ ${filters.maxCompetitionPct}%` : null,
    filters.hideThin ? 'hiding thin books' : null,
  ].filter(Boolean) as string[];

  return (
    <div className="rewards">
      <div className="cc-shell">

        <header className="cc-head">
          <h1 className="cc-title">
            <span className="cc-title-dim">Edgeradar /</span> liquidity rewards
            <span className="cc-title-accent"> · maker</span>
          </h1>
          <p className="cc-sub">
            the modelled $/day a single maker earns — its own share of the pot, not the whole prize
          </p>
        </header>

        {err && <EmptyState prefix="cc" title="Rewards feed unavailable" sub={err} />}
        {!err && !data && <EmptyState prefix="cc" sub="Loading reward markets…" />}
        {!err && data && total === 0 && (
          <EmptyState prefix="cc" title="No reward markets clear the sanity gate right now" />
        )}

        {!err && data && total > 0 && (
          <>
            <div className="cc-filterbar">
              {/* SU QUALE PIATTAFORMA — single select: all / Polymarket / Kalshi (server filter) */}
              <div className="cc-fgroup">
                <span className="cc-flabel">Su quale piattaforma</span>
                <span className="cc-fhelp">Kalshi paga solo i residenti negli Stati Uniti.</span>
                <div className="cc-chips">
                  {VENUE_CHIPS.map((v) => (
                    <button key={v} type="button"
                      className={`cc-fchip ${filters.venue === v ? 'is-on' : ''}`}
                      onClick={() => set({ venue: v })}>{v === 'all' ? 'tutte' : v}</button>
                  ))}
                </div>
                {filters.venue !== 'polymarket' && (
                  <span className="cc-fnote-amber" role="note">
                    Stai includendo Kalshi: quei premi potrebbero non essere riscuotibili da questo operatore.
                  </span>
                )}
              </div>

              {/* CATEGORIA — multi-select (server filter; not one of the six, kept for browsing) */}
              <div className="cc-fgroup">
                <span className="cc-flabel">Categoria</span>
                <span className="cc-fhelp">Restringe l&rsquo;elenco al tema del mercato.</span>
                <div className="cc-chips">
                  {rg.categories.map((c: string) => (
                    <button key={c} type="button"
                      className={`cc-fchip ${filters.categories.includes(c) ? 'is-on' : ''}`}
                      onClick={() => set({ categories: toggle(filters.categories, c) })}>{c}</button>
                  ))}
                  {rg.categories.length === 0 && <span className="cc-slider-val">—</span>}
                </div>
              </div>

              {/* DEVE PAGARE ALMENO — min daily pot (server filter) */}
              <div className="cc-fgroup cc-slider">
                <div className="cc-slider-head">
                  <span className="cc-flabel">Deve pagare almeno</span>
                  <span className="cc-slider-val">≥ {filters.minPool > 0 ? fmtUsd(filters.minPool) : '$0'}/giorno</span>
                </div>
                <span className="cc-fhelp">Il montepremi giornaliero che la piattaforma mette su quel mercato. Sotto questa cifra non vale la pena esserci.</span>
                <input className="cc-frange" type="range" min={0} max={Math.max(rg.poolMax, 1)} step={Math.max(1, Math.round(rg.poolMax / 100))}
                  value={Math.min(filters.minPool, Math.max(rg.poolMax, 1))}
                  onChange={(e) => set({ minPool: Number(e.target.value) })} aria-label="deve pagare almeno" />
              </div>

              {/* IL LIBRO DEVE REGGERE ALMENO — min book depth at touch (server filter) */}
              <div className="cc-fgroup cc-slider">
                <div className="cc-slider-head">
                  <span className="cc-flabel">Il libro deve reggere almeno</span>
                  <span className="cc-slider-val">≥ {filters.minDepth > 0 ? fmtUsd(filters.minDepth) : '$0'}</span>
                </div>
                <span className="cc-fhelp">Quanti soldi ci sono già sul book al miglior prezzo. Un libro sottile significa che il premio è alto solo perché non c&rsquo;è nessuno.</span>
                <input className="cc-frange" type="range" min={0} max={Math.max(rg.depthMax, 1)} step={Math.max(1, Math.round(rg.depthMax / 100))}
                  value={Math.min(filters.minDepth, Math.max(rg.depthMax, 1))}
                  onChange={(e) => set({ minDepth: Number(e.target.value) })} aria-label="il libro deve reggere almeno" />
              </div>

              {/* DISTANZA MASSIMA FRA DOMANDA E OFFERTA — max spread (server filter). Max ⇒ "qualsiasi". */}
              <div className="cc-fgroup cc-slider">
                <div className="cc-slider-head">
                  <span className="cc-flabel">Distanza massima fra domanda e offerta</span>
                  <span className="cc-slider-val">{spreadActive ? `≤ ${filters.maxSpreadCents}¢` : 'qualsiasi'}</span>
                </div>
                <span className="cc-fhelp">Più è larga, più il prezzo si muove sotto i tuoi ordini prima che qualcuno li prenda.</span>
                <input className="cc-frange" type="range" min={0} max={Math.max(rg.spreadMaxCents, 1)} step={1}
                  value={filters.maxSpreadCents < 0 ? Math.max(rg.spreadMaxCents, 1) : Math.min(filters.maxSpreadCents, Math.max(rg.spreadMaxCents, 1))}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    set({ maxSpreadCents: v >= rg.spreadMaxCents ? SENTINEL_SPREAD : v });
                  }}
                  aria-label="distanza massima fra domanda e offerta" />
              </div>

              {/* QUANTI ALTRI SE LO DIVIDONO — competition level (server filter).
                  Disabled when no row carries a measured competition/saturation value. */}
              <div className={`cc-fgroup cc-slider ${rg.hasCompetition ? '' : 'is-disabled'}`}>
                <div className="cc-slider-head">
                  <span className="cc-flabel">Quanti altri se lo dividono</span>
                  <span className="cc-slider-val">
                    {rg.hasCompetition ? (filters.maxCompetitionPct >= 100 ? 'qualsiasi' : `≤ ${filters.maxCompetitionPct}%`) : 'n/d'}
                  </span>
                </div>
                <span className="cc-fhelp">Il premio si spartisce fra tutti quelli che quotano. Più concorrenti, meno tocca a te.</span>
                <input className="cc-frange" type="range" min={0} max={100} step={5}
                  value={filters.maxCompetitionPct}
                  disabled={!rg.hasCompetition}
                  onChange={(e) => set({ maxCompetitionPct: Number(e.target.value) })} aria-label="quanti altri se lo dividono" />
                {!rg.hasCompetition && <span className="cc-slider-val rw-dim">concorrenza non misurata da questo feed</span>}
              </div>

              {/* NASCONDI I LIBRI TROPPO SOTTILI + sort (server filter + presentation) */}
              <div className="cc-checks">
                <label className={`cc-check ${filters.hideThin ? 'is-on' : ''}`}>
                  <input type="checkbox" checked={filters.hideThin}
                    onChange={(e) => set({ hideThin: e.target.checked })} />
                  Nascondi i libri troppo sottili
                </label>
                <span className="cc-fhelp cc-fhelp-check">
                  Toglie i mercati dove sotto la soglia di profondità{depthFloor != null ? ` (${fmtUsd(depthFloor)})` : ''} il rendimento annualizzato diventa una cifra irreale.
                </span>
                <label className={`cc-check ${filters.sortByPool ? 'is-on' : ''}`}>
                  <input type="checkbox" checked={filters.sortByPool}
                    onChange={(e) => set({ sortByPool: e.target.checked })} />
                  Ordina per montepremi
                </label>
              </div>
            </div>

            <div className="cc-count cc-count-row">
              <span className="cc-count-text">
                {visible.length} of {total} markets after filters · sorted by {filters.sortByPool
                  ? 'reward pool high→low'
                  : `$/day ${filters.sortDir === 'asc' ? 'low→high' : 'high→low'}`}
              </span>
              {/* $/day sort direction — presentational only; reuses the engine's netUsdPerDay.
                  Tapping an arrow selects $/day sort in that direction (overrides reward-pool
                  sort); withheld/"—" rows stay pinned last in both directions (see sortRows). */}
              <span className="cc-sortdir" role="group" aria-label="sort by net $/day direction">
                <button type="button" title="Sort $/day ascending (low → high)" aria-label="sort $/day ascending"
                  className={`cc-sortbtn ${!filters.sortByPool && filters.sortDir === 'asc' ? 'is-on' : ''}`}
                  aria-pressed={!filters.sortByPool && filters.sortDir === 'asc'}
                  onClick={() => set({ sortByPool: false, sortDir: 'asc' })}>▲</button>
                <button type="button" title="Sort $/day descending (high → low)" aria-label="sort $/day descending"
                  className={`cc-sortbtn ${!filters.sortByPool && filters.sortDir === 'desc' ? 'is-on' : ''}`}
                  aria-pressed={!filters.sortByPool && filters.sortDir === 'desc'}
                  onClick={() => set({ sortByPool: false, sortDir: 'desc' })}>▼</button>
              </span>
            </div>

            {/* Bot universe: the always-visible active universe + the deliberate "Set as bot universe"
                promotion (gated write). Browsing never auto-syncs to the bot. */}
            <MakerUniverseControl apiQuery={apiQuery} />

            {visible.length === 0 ? (
              <EmptyState prefix="cc" title="No reward markets match these filters."
                sub={activeFilters.length ? `Active: ${activeFilters.join(' · ')}. Loosen a filter to see more.` : 'Loosen a filter to see more.'} />
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
                            {/* 2%/day sane-reward gate (reward-gating), now wired to the list: a thin/flagged
                                row reads as a run-rate, never a clean cashable $/day. */}
                            {!row.isTrap && row.thin && (
                              <span className="rw-trap" title={`thin book — reference yield exceeds ${REWARD_SANITY_CAP_PCT}%/day; your share compresses as makers arrive`}>
                                ⚠ thin book
                              </span>
                            )}
                            {!row.isTrap && !row.thin && row.belowGate && (
                              <span className="rw-trap" title="below the sane-reward gate (below-floor / one-sided / short-burst)">⚠ flagged</span>
                            )}
                          </span>
                          <span className="cc-row-title">{m.groupItemTitle || m.title}</span>
                          <span className="cc-row-sub">
                            {/* pool $/day is a PUBLIC teaser (owner freemium split) — always the real
                                number for every tier; null ⇒ genuine "—", never a paywall lock. */}
                            pool{' '}
                            <Redacted value={row.poolDayUsd} isPaid>{(v) => <>${Number(v).toFixed(0)}/day</>}</Redacted>
                            {' · '}depth{' '}
                            {/* depth $ is LOCKED. Pass the REAL tier so free → 🔒 unlock, while a paid
                                user with a genuinely non-priceable row still gets a calm "—". */}
                            <Redacted value={row.capacityUsd} isPaid={isPaid}>{(v) => <>{fmtDepth(Number(v))}</>}</Redacted>
                            {/* your share % is LOCKED — always shown so free sees a 🔒, paid sees the
                                real % (or "—" when the row is genuinely non-priceable / zero share). */}
                            {' · '}your share{' '}
                            <Redacted value={row.unknown || row.share <= 0 ? null : row.share} isPaid={isPaid}>
                              {(v) => <span className="rw-nowrap">{(Number(v) * 100).toFixed(1)}%</span>}
                            </Redacted>
                          </span>
                          {/* idle-capital note — calm, not an error */}
                          {!row.unknown && row.idle > 0 && (
                            <span className="rw-idle">
                              ${row.deployed.toFixed(0)} deployed · <span className="rw-nowrap">${row.idle.toFixed(0)} idle</span> (book full)
                            </span>
                          )}
                          {/* SATURATION BAR — PUBLIC teaser (owner freemium split): the qualitative
                              saturated/open status shows for every tier. isPaid forced so a genuinely
                              unmeasured bar reads "competition · not measured", never a paywall lock. */}
                          <span className="rw-satwrap">
                            <Redacted
                              value={row.saturation}
                              isPaid
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
                            {/* HEADLINE = the maker's own MODELLED share of the pot per day, from the
                                shared quadratic scorer (poolDay × refShare). Carries a visible "stima"
                                so it never reads as an observed payout. "—" when the book couldn't be
                                scored OR (Kalshi) it is one-sided / non-executable — reason on hover. */}
                            {/* est share/day is the LOCKED headline. Real tier: free → 🔒 unlock;
                                paid → the number, or a calm "—" (with reason) when non-priceable. */}
                            <Redacted
                              value={row.unknown ? null : row.netUsdPerDay}
                              isPaid={isPaid}
                              nullDisplay={<span title={row.nonExecReason ?? 'this book could not be scored — no pool or in-band depth from the feed'}>—</span>}
                            >
                              {(v) => (
                                <span className="rw-nowrap">
                                  ${Number(v).toFixed(2)}/day <span className="cc-row-stima" title="modelled figure, not an observed payout">stima</span>
                                </span>
                              )}
                            </Redacted>
                            {/* ANNUALIZED CAP LABEL — restored on the cards (paid tier too). The displayed
                                $/day is unchanged; when its annualized run-rate on deployed capital exceeds the
                                APY_CAP, the honest ">200%/yr · run-rate, not guaranteed" caveat renders beside
                                it. Free tier has no depth ⇒ unknown ⇒ no label (the $/day is 🔒). */}
                            {!row.unknown && row.apyCapped && (
                              <span className="cc-row-runrate" title="annualized on the capital you deploy — a run-rate that compresses as makers arrive, not a guaranteed return">
                                {APY_CAP_LABEL}
                              </span>
                            )}
                            {!row.unknown && !row.apyCapped && row.apyRaw != null && row.apyRaw > 50 && (
                              <span className="cc-row-runrate" title="annualized on the capital you deploy — a run-rate, not a guaranteed return">
                                run-rate, not guaranteed
                              </span>
                            )}
                          </span>
                          {/* Kalshi gross qualifier — replaces the removed APY line. Calm, once.
                              The feed prices full qualifying size at best bid/ask; Kalshi's real
                              score also applies distance-from-mid weighting, an uptime requirement
                              and a target-size gate the free feed does not capture, so this $/day
                              is GROSS of them. Polymarket rows never render this. */}
                          {row.grossKalshi && !row.unknown && (
                            <span
                              className="cc-row-gross"
                              title="gross reward from full qualifying size at best bid/ask — before Kalshi's distance-from-mid weighting, uptime requirement and target-size gate (not captured by the free feed)"
                            >
                              gross · before uptime/distance scoring
                            </span>
                          )}
                        </span>
                      </div>

                      {isOpen && (
                        <div className="cc-expand">
                          <RewardYieldBreakdown row={row} isPaid={isPaid} />
                          {/* Into the interactive order-book detail page for THIS exact market.
                              marketId is the raw feed id (Polymarket conditionId / Kalshi ticker) —
                              the same key the detail route resolves against /api/rewards-unified. */}
                          <Link
                            href={`/dashboard/liquidity-rewards/${encodeURIComponent(m.marketId)}`}
                            prefetch={false}
                            className="rw-open-book"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Open order book →
                          </Link>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <p className="cc-note">
              The headline is a MODELLED share ("stima"): the reward pool times a ${ASSUMED_ORDER_SIZE_USD.toLocaleString()} maker's
              scored share of it, {ASSUMED_PLACEMENT_LABEL}. Polymarket rewards are two-sided — the
              share is scored with the published quadratic formula S(v,s) = ((v−s)/v)², weighting each
              order by its tightness to the size-cutoff-adjusted midpoint and diluting against the
              qualifying depth already on BOTH sides. Polymarket depth/competition is measured from the
              live CLOB; Kalshi is an observed one-sided flat pro-rata split. All figures are gross
              reward accrual — inventory P&amp;L when your orders fill is not included. Point-in-time
              snapshot; competitors re-quote; not a promised yield.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Row-expand breakdown — the SAME shared-lib numbers the headline uses (poolDay × refShare),
 * itemised at the fixed assumed order. No second math path; nothing the row doesn't already compute.
 */
function RewardYieldBreakdown({ row, isPaid }: { row: Row; isPaid: boolean }) {
  const rowset: Array<[string, React.ReactNode]> = [
    ['reward pool (the whole prize)', <Redacted key="p" value={row.poolDayUsd} isPaid>{(v) => <>${Number(v).toFixed(0)}/day</>}</Redacted>],
    [row.venue === 'polymarket' ? 'depth already there · both sides' : 'depth already there',
      <Redacted key="q" value={row.capacityUsd} isPaid={isPaid}>{(v) => <>{fmtDepth(Number(v))}</>}</Redacted>],
  ];
  return (
    <div className="rw-calc">
      <div className="rw-calc-block">
        <span className="rw-calc-h">
          A ${row.deployed.toLocaleString()} order in this book
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
          <div className="rw-brk-item"><span className="rw-brk-k">assumed order</span>
            <span className="rw-brk-v">${row.deployed.toLocaleString()}</span></div>
          <div className="rw-brk-item"><span className="rw-brk-k">your pool share</span>
            <span className="rw-brk-v"><Redacted value={row.unknown ? null : row.share} isPaid={isPaid}>{(v) => <>{(Number(v) * 100).toFixed(1)}%</>}</Redacted></span></div>
          <div className="rw-brk-item"><span className="rw-brk-k">your reward · stima</span>
            <span className="rw-brk-v rw-brk-primary"><Redacted value={row.unknown ? null : row.netUsdPerDay} isPaid={isPaid}>{(v) => <>${Number(v).toFixed(2)}/day</>}</Redacted></span></div>
        </div>
        <div className="rw-calc-meta">
          <span className="rw-dim">
            share scored by the published quadratic formula · gross accrual · point-in-time
            {row.measured ? '' : ' · split inferred (observed)'}
          </span>
          {row.isTrap && <span className="rw-trap">⚠ trap market</span>}
        </div>
      </div>
    </div>
  );
}

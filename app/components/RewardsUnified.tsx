'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Redacted } from './ui/Redacted';
import { EmptyState } from './ds';
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
// PRICE-FIRST row (Part A): posted prices from the scoring mid + offset, and expected gross $/day at the
// user's size via the published quadratic against the feed's competitorQ. Pure lib, no parallel math.
import { computePriceRow, type PriceRow } from '@/lib/reward-price-row';
// The ONE shared venue-rules validator (Part B1–B3) — the UI band warning CALLS this, never reimplements
// the check. validateQuotePair applies the qMin coupling (a two-sided quote is only as good as its weaker leg).
import { validateQuotePair, type PairVerdict } from '@/lib/maker/venue-rules';
// Measured band-relative price stability (7d window) — the ONE definition, shared with the server
// filter (lib/rewards-server-filter). Unknown ⇒ score null ⇒ the cell renders "—" with the reason.
import { stabilityOf, type Stability, type StabilityReason } from '@/lib/reward-stability';
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
  // Price-first inputs (Part A). All REAL from lib/rewards-normalize; redacted → null on the free tier.
  mid?: number | null;            // scoring mid = size-cutoff-adjusted mid (the ONE mid all math keys off)
  maxSpreadCents?: number | null; // full reward band (cents); eligible half-width = this / 2
  minSize?: number | null;        // min_incentive_size (shares)
  competitorQ?: number | null;    // REAL Q_min the live book scored (the quadratic denominator)
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
  // Real 24h price-move stdev (agent24) — the estimator's adverse-move input. Redacted on the free tier.
  volatilityStdev?: number | null;
  maxSpread?: number | null;
  // STABILITY inputs (agent24, 7d window) — raw measurements, scored by lib/reward-stability.
  // `stability` carries the dispersion + sample counts; volume24hUsd is the trade-flow evidence
  // (null = Gamma omitted the key, i.e. NO measured flow — never read as zero). Both redacted on
  // the free tier, which is what makes the free stability cell resolve to "—".
  stability?: { stdev?: number | null; range?: number | null; nPts?: number | null; nDistinct?: number | null; windowHours?: number | null } | null;
  volume24hUsd?: number | null;
  flags?: string[] | null;
  rewardScore?: RewardScore | null;
  // Price-first inputs (Part A). tickSize is a static market param (public); bestBid/bestAsk are the live
  // YES-token touch (redacted → null on the free tier). All null when the feed didn't carry them yet.
  tickSize?: number | null;
  bestBid?: number | null;
  bestAsk?: number | null;
}

// ── Stability, in words ──────────────────────────────────────────────────────────────────────
// The hover text on a MEASURED stability cell: only the numbers the score was actually computed
// from, so the reader can check the score instead of trusting it. No suggestion of where to quote.
function stabilityDriverText(s: Stability): string {
  const parts: string[] = [];
  if (s.movedCents != null && s.windowHours != null) {
    parts.push(`prezzo mosso ${s.movedCents.toFixed(2)}c (1σ) in ${Math.round(s.windowHours / 24)}g`);
  }
  if (s.consumedBandPct != null) parts.push(`= ${s.consumedBandPct}% della semi-banda premiante`);
  if (s.bookDepthUsd != null)    parts.push(`book in banda $${Math.round(s.bookDepthUsd).toLocaleString('it-IT')}`);
  if (s.volume24hUsd != null)    parts.push(`scambiato 24h $${Math.round(s.volume24hUsd).toLocaleString('it-IT')}`);
  if (s.nPts != null)            parts.push(`${s.nPts} rilevazioni${s.nDistinct != null ? `, ${s.nDistinct} prezzi distinti` : ''}`);
  return parts.join(' · ');
}

// Why a cell reads "—". Each reason names the MISSING measurement, never implies instability:
// unmeasured is not "moves a lot", and an untraded market is not "calm".
function stabilityUnknownText(reason: StabilityReason | null): string {
  switch (reason) {
    case 'no-band':       return 'non misurata: questo mercato non espone una banda premiante';
    case 'no-history':    return 'non misurata: nessuno storico prezzi utilizzabile';
    case 'thin-sample':   return 'non misurata: troppe poche rilevazioni di prezzo per misurare il movimento';
    case 'no-trade-data': return 'non misurata: nessun volume scambiato rilevato nelle 24h — un prezzo fermo senza scambi non è calma, è assenza di dati';
    case 'no-pool':       return 'non misurata: nessun premio giornaliero con cui confrontare il flusso scambiato';
    case 'no-flow':       return 'non misurata: scambia meno di quanto paga in premi al giorno — il prezzo fermo non è prodotto dagli scambi';
    case 'no-book':       return 'non misurata: book in banda assente o sotto la soglia minima';
    default:              return 'non misurata per questo mercato';
  }
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
  apr: number | null;             // annualized on MEASURED CAPACITY, capped — filter-only (not rendered)
  apyRaw: number | null;          // annualized on MEASURED CAPACITY, UNCAPPED — null when capacity too thin to annualize
  apyCapped: boolean;             // apyRaw > APY_CAP → render ">200%/yr · run-rate, not guaranteed"
  capacityThin: boolean;          // priceable row whose measured capacity is below the annualization floor → annualized "—"
  capacityUsd: number | null;     // measured reward-eligible book depth (both sides) — the annualization denominator
  deployed: number;
  idle: number;
  space: number;
  share: number;
  unknown: boolean;
  potTooSmall: boolean;               // reward pot below POT_DEMOTE_FLOOR_USD → demoted + labelled
  notCollectable: boolean;            // Kalshi rewards are US-only → not collectable from the EU → non-actionable
  demoted: boolean;                   // potTooSmall || notCollectable → ranked last by sortRows
  stabilityScore: number | null;      // measured band-relative stability (0..100) or null (unmeasured)
  stability: Stability;               // full measurement — label, drivers, and the unknown reason
  hoursToResolution: number | null;   // real expiry field for the expiry cell + expiry sort
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
  stabMax: number;
  hasStability: boolean;
}

// ── VIEW filters (the six server filters + category + sort) ─────────────────────────────────────
// These are the ONLY controls that hit the API. They are DELIBERATELY NOT PERSISTED: every page load
// starts from DEFAULT_FILTERS. A filter is a momentary question about the board, not a setting — a
// stale one silently hiding markets on a later visit is the failure mode this split removes.
//
// The state that DOES survive a refresh is separate and lives elsewhere: "La tua size" and "Distanza
// dal mid" (localStorage rw_size/rw_dist — they describe the operator, not the view) and the
// bot-universe selection (localStorage rw_selected + the persisted MakerUniverseSelection row — it is
// an operating decision). "Azzera filtri" resets THIS interface only and never touches those.
interface FilterState {
  venue: 'all' | 'polymarket' | 'kalshi';
  categories: string[];
  minPool: number;
  minDepth: number;        // min book depth at touch ($)
  maxSpreadCents: number;  // max spread (¢); at the range max ⇒ no constraint
  maxCompetitionPct: number;
  hideThin: boolean;
  minStab: number;         // "Stabilità minima" 0–100 (server filter; unknown-stability rows NOT excluded)
  // client presentation only:
  sortMode: 'stability' | 'day' | 'expiry';
  sortByPool: boolean;
  sortDir: 'asc' | 'desc';
}

// OPERATIONALLY-MEANINGFUL CAPACITY FLOOR for annualization. The annualized run-rate is
// $/day × 365 / measured-reward-eligible-depth. When that depth is below the reference order the
// estimate is priced for, the denominator is too small for the annualization to mean anything
// (a $1k maker would dominate the book), so the annualized renders "—" — the row, its real $/day
// and its real measured capacity all stay visible. Reuses the SAME constant the estimate assumes
// (ASSUMED_ORDER_SIZE_USD == REWARD_REF_CAPITAL) — NOT a new threshold.
const ANNUALIZE_MIN_CAPACITY_USD = ASSUMED_ORDER_SIZE_USD;

// PHASE 1 — POT DEMOTION FLOOR. The pool-share estimate is arithmetically correct (it reproduces on a
// fresh CLOB book), but a high share of a TINY pot is not an opportunity: on these markets the qualifying
// two-sided in-band depth is genuinely thin, so a $1k maker would dominate — of $11/day. Below this floor
// even total dominance of the pot is a trivial gross subsidy. $15/day sits at ~the 30th percentile of the
// 116-row pot distribution (median $18), where the "you take 84–99.5%" rows all cluster (their pots are
// $10–50, mostly ≤ $20). Demoted rows are ranked last and told plainly — their share is never rewritten.
const POT_DEMOTE_FLOOR_USD = 15;

const SENTINEL_SPREAD = -1;   // "not yet initialised from ranges" → treated as any
const DEFAULT_FILTERS: FilterState = {
  venue: 'all',
  categories: [],
  minPool: 0,
  minDepth: 0,
  maxSpreadCents: SENTINEL_SPREAD,
  maxCompetitionPct: 100,
  hideThin: false,
  minStab: 0,
  sortMode: 'stability',   // default = stability (the real 24h-volatility field exists); "—" rows sort last
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

// Expiry from the REAL hoursToResolution feed field. Never guesses a date: null/absent → "— scad.".
// "45g" under ~60 days, "2 mesi" beyond. Urgency band: ≤3d red, ≤14d amber, else neutral.
function expiryView(hoursToResolution: number | null | undefined):
  { label: string; band: 'red' | 'amber' | 'neutral' | 'none' } {
  if (!fin(hoursToResolution) || hoursToResolution <= 0) return { label: '— scad.', band: 'none' };
  const days = hoursToResolution / 24;
  const label = days < 1 ? `${Math.max(1, Math.round(hoursToResolution))}h`
    : days < 60 ? `${Math.round(days)}g`
    : `${Math.round(days / 30)} mesi`;
  const band = days <= 3 ? 'red' : days <= 14 ? 'amber' : 'neutral';
  return { label, band };
}

/** Is any VIEW filter currently constraining the board? Drives the reset button's enabled state. */
function anyFilterActive(f: FilterState, r: Ranges | null): boolean {
  return f.venue !== 'all'
    || f.categories.length > 0
    || f.minPool > 0
    || f.minDepth > 0
    || (f.maxSpreadCents >= 0 && (!r || f.maxSpreadCents < r.spreadMaxCents))
    || f.maxCompetitionPct < 100
    || f.hideThin
    || f.minStab > 0
    || f.sortMode !== DEFAULT_FILTERS.sortMode
    || f.sortDir !== DEFAULT_FILTERS.sortDir;
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
  if (f.minStab > 0) p.set('minStab', String(f.minStab));
  return p;
}

export default function RewardsUnified() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [ranges, setRanges] = useState<Ranges | null>(null);
  // VIEW filters always start at their defaults — never restored from the URL, localStorage or the DB.
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);

  // ── STICKY STATE (1/2) · PRICE-FIRST per-user controls, persisted to localStorage so they survive
  //    refresh. These describe the OPERATOR (how much capital, how far off the mid), not the view, so
  //    they are deliberately outside FilterState and "Azzera filtri" never clears them. ──
  // ── PRICE-FIRST per-user controls (Part A4), persisted to localStorage so they survive refresh.
  //    "Your size" is the TOTAL deployed across BOTH sides; default EMPTY (while empty, $/day + yield
  //    render "—" — no default, no placeholder number). "Distance from mid" is the posting offset in
  //    cents (default 1¢); the posted prices shown are snapped to each market's real tick. ──
  const [sizeInput, setSizeInput] = useState<string>('');
  const [distInput, setDistInput] = useState<string>('1');
  useEffect(() => {
    try {
      const s = localStorage.getItem('rw_size'); if (s != null) setSizeInput(s);
      const d = localStorage.getItem('rw_dist'); if (d != null) setDistInput(d);
    } catch { /* private mode — controls just start at their defaults */ }
  }, []);
  useEffect(() => { try { localStorage.setItem('rw_size', sizeInput); } catch { /* ignore */ } }, [sizeInput]);
  useEffect(() => { try { localStorage.setItem('rw_dist', distInput); } catch { /* ignore */ } }, [distInput]);
  const totalSizeUsd = useMemo(() => {
    const n = Number(sizeInput);
    return sizeInput.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
  }, [sizeInput]);
  const offsetCents = useMemo(() => {
    const n = Number(distInput);
    return distInput.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
  }, [distInput]);

  // ── STICKY STATE (2/2) · BOT-UNIVERSE selection. Survives refresh (localStorage rw_selected) and,
  //    once promoted, lives in the persisted MakerUniverseSelection row. Cleared ONLY by an explicit
  //    deselect (the row checkbox or the panel's own clear action) — never by a refresh, never by
  //    "Azzera filtri". A filter reset that silently emptied the bot's universe would be a control
  //    action disguised as a view action. ──
  // ── BOT-UNIVERSE per-row SELECTION (persisted). Selecting a row toggles it into the explicit
  //    selection that "Imposta come universo bot" force-includes (allowlist) into the maker-universe
  //    store. This is a VIEW/selection state only — it arms nothing; nothing persists until the button. ──
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    try { const s = localStorage.getItem('rw_selected'); if (s) setSelected(JSON.parse(s)); } catch { /* ignore */ }
  }, []);
  useEffect(() => { try { localStorage.setItem('rw_selected', JSON.stringify(selected)); } catch { /* ignore */ } }, [selected]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggleSelected = (marketId: string) =>
    setSelected((prev) => (prev.includes(marketId) ? prev.filter((x) => x !== marketId) : [...prev, marketId]));

  // A single price-first computation per market at the CURRENT size/offset — used for the row headline
  // ($/day at your size), the own-impact chip, AND the header totals across selected. One math path.
  const priceRowFor = useCallback(
    (m: Market) => computePriceRow({
      rewardScore: m.rewardScore ?? null,
      tick: fin(m.tickSize) ? (m.tickSize as number) : null,
      totalSizeUsd, offsetCents, market: m,
    }),
    [totalSizeUsd, offsetCents],
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

  // NO URL SYNC. View filters are intentionally not mirrored to the query string: a URL that carried
  // them would restore them on refresh (and on any bookmark/back-navigation), which is exactly the
  // persistence this split removes. A leftover query string from an older shared link is stripped once
  // on mount via the History API — no navigation, no re-render, so it can never fight the fetch effect.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.location.search) return;
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

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
    // The assumed capital is capped by the MEASURED in-band depth (same competitorDepthUsd used for
    // capacity below): a $1,000 share scored against a $618 book is a statement about the book, not a
    // forecast. When the cap binds the headline $/day IS the capped figure and the row says so.
    const est = estimatedOperatorSharePerDay(b.m.rewardScore ?? null, { inBandDepthUsd: competitorDepthUsd(b.m) });
    const unknown = est.unknown || b.nonExecReason != null;
    const stab = stabilityOf(b.m);
    const netUsdPerDay = unknown ? null : est.estUsdPerDay;
    const share = unknown ? 0 : (est.share ?? 0);
    // The two-sided in-band depth already resting in the book — the MEASURED reward-eligible
    // capacity (lib/reward-depth-floor competitorDepthUsd: near + far side for Polymarket). This
    // is the annualization denominator: real book depth, never a hardcoded capital constant, never
    // OI, never a modeled proxy. Real tier ⇒ null when the feed didn't carry it; free tier ⇒ lock.
    const capacityUsd = competitorDepthUsd(b.m);
    // ANNUALIZED = $/day × 365 / MEASURED CAPACITY. Three distinct states, never conflated:
    //   • capacity MEASURED and ≥ the reference order → real run-rate on real depth (capped/labelled).
    //   • capacity MEASURED but < the reference order → too thin to annualize → "—" + thin label
    //     (row + $/day + capacity stay visible; nothing rewritten).
    //   • capacity UNKNOWN (feed didn't carry it, or free-tier redaction) → annualized is simply
    //     unmeasurable → "—" with NO "too thin" claim (never fabricated, never defaulted).
    const capacityKnown = fin(capacityUsd);
    const capacityThin  = !unknown && netUsdPerDay != null && capacityKnown && (capacityUsd as number) < ANNUALIZE_MIN_CAPACITY_USD;
    const apyRaw = unknown || netUsdPerDay == null || !capacityKnown || capacityThin
      ? null
      : (netUsdPerDay * 365 / (capacityUsd as number)) * 100;
    return {
      ...b,
      netUsdPerDay,
      apr:          apyRaw == null ? null : Math.min(apyRaw, APY_CAP),
      apyRaw,
      apyCapped:    apyRaw != null && apyRaw > APY_CAP,
      capacityThin,
      capacityUsd,
      deployed:     est.assumedOrderSizeUsd,   // the fixed assumed order the estimate is priced for
      idle:         0,
      space:        Infinity,
      share,
      unknown,
      // A pot below the floor makes any share of it meaningless — flagged here, demoted in sortRows,
      // labelled on the row. Uses the REAL pool $/day; a null pot is NOT "too small" (it renders "—").
      potTooSmall:  fin(b.poolDayUsd) && (b.poolDayUsd as number) < POT_DEMOTE_FLOOR_USD,
      // Kalshi's liquidity-rewards program is US-only (help.kalshi.com/.../liquidity-incentive-program);
      // this operator is in the EU, so those rewards are not collectable → the row is non-actionable.
      notCollectable: b.venue === 'kalshi',
      demoted:      (fin(b.poolDayUsd) && (b.poolDayUsd as number) < POT_DEMOTE_FLOOR_USD) || b.venue === 'kalshi',
      // Sort/stat inputs (real fields). stability: the measured band-relative score — unknown (score
      // null) whenever any input is missing → sorts last, cell "—". hoursToResolution: real expiry.
      // Same stabilityOf() the SERVER filter calls, so the shown score can never disagree with the
      // score the "Stabilità minima" filter matched on.
      stability:      stab,
      stabilityScore: stab.score,
      hoursToResolution: fin(b.m.hoursToResolution) ? (b.m.hoursToResolution as number) : null,
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
  const rg: Ranges = ranges ?? { poolMax: 0, depthMax: 0, spreadMaxCents: 0, categories: [], venues: [], hasCompetition: false, stabMax: 100, hasStability: false };
  const VENUE_CHIPS: Array<FilterState['venue']> = ['all', 'polymarket', 'kalshi'];
  // The REAL depth-at-touch floor ($) from the server (env REWARD_DEPTH_TOUCH_FLOOR_USD or $25 default).
  // Stated in the "hide thin books" help so the copy can never drift from the code.
  const depthFloor = fin(data?.meta?.rewardDepthFloorUsd) ? (data!.meta.rewardDepthFloorUsd as number) : null;
  // At zero matches the server names the filter removing the most rows (meta.mostRestrictiveFilter).
  // Map its key to the plain-language control label so the calm zero-state says what to relax.
  const MOST_RESTRICT_LABELS: Record<string, string> = {
    venue: 'Su quale piattaforma', category: 'Categoria', minPool: 'Deve pagare almeno',
    minDepth: 'Il libro deve reggere almeno', maxSpread: 'Distanza massima fra domanda e offerta',
    maxCompetition: 'Quanti altri se lo dividono', hideThin: 'Nascondi i libri troppo sottili',
    minStab: 'Stabilità minima',
  };
  // Header totals across the SELECTED markets (bot-universe selection): total expected GROSS $/day at
  // the user's size + total committed capital (size × count). net is ALWAYS "—". Only counts rows the
  // user explicitly selected AND that are priceable at the current size — unknowns never inflate a total.
  const selectedRows = visible.filter((r) => selectedSet.has(r.m.marketId));
  const selTotals = selectedRows.reduce(
    (acc, r) => {
      const pr = priceRowFor(r.m);
      if (fin(pr.grossPerDay)) { acc.gross += pr.grossPerDay as number; acc.grossKnown++; }
      if (totalSizeUsd != null) acc.capital += totalSizeUsd;
      return acc;
    },
    { gross: 0, grossKnown: 0, capital: 0 },
  );
  const mostRestrictiveKey: string | null = data?.meta?.mostRestrictiveFilter?.key ?? null;
  const mostRestrictiveLabel = mostRestrictiveKey ? MOST_RESTRICT_LABELS[mostRestrictiveKey] ?? null : null;
  // At the range max the spread filter imposes no constraint ("qualsiasi") — used in the slider value.
  const spreadActive = filters.maxSpreadCents >= 0 && filters.maxSpreadCents < rg.spreadMaxCents;
  // Is anything constraining the board right now? Drives the reset button's enabled state (the button
  // itself is always rendered — see the filter-card head).
  const filtersActive = anyFilterActive(filters, ranges);

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

        {/* ── ASSUMPTIONS · stated once, always visible (never a tooltip, never collapsed) ── */}
        <div className="rw-assume" role="note">
          <span className="rw-assume-k">La stima si basa su</span> un ordine da ${ASSUMED_ORDER_SIZE_USD.toLocaleString()},
          {' '}{ASSUMED_PLACEMENT_LABEL}. Sono <strong>premi lordi maturati</strong>: il P&amp;L di
          inventario quando i tuoi ordini vengono eseguiti <strong>non è incluso</strong> in nessuna
          cifra di questa pagina. Mostriamo solo il <strong>lordo</strong> — l&rsquo;<strong>adverse
          selection</strong> non è modellata, quindi il <strong>rendimento netto è sconosciuto (netto
          —)</strong> e non viene stimato. L&rsquo;annualizzato è calcolato sulla profondità reale del
          book, non su un capitale fisso: quando il book è troppo sottile diventa «—». I premi Kalshi
          sono riservati ai membri residenti negli Stati Uniti.
        </div>

        {err && <EmptyState prefix="cc" title="Rewards feed unavailable" sub={err} />}
        {!err && !data && <EmptyState prefix="cc" sub="Loading reward markets…" />}
        {!err && data && total === 0 && (
          <EmptyState prefix="cc" title="Nessun mercato premio supera il controllo di sanità in questo momento" />
        )}

        {!err && data && total > 0 && (
          <div className="rw-layout">
            {/* ── LEFT: filter column (side on ≥768px, stacked above the list below) ── */}
            <aside className="rw-side">
            {/* ── LA TUA POSIZIONE · price-first controls (persisted per-user) ── The size drives the
                expected gross $/day inside each row; the distance drives the posted prices + the band rail.
                Empty size ⇒ every $/day and yield renders "—" (no default). ── */}
            <div className="rw-pos" role="group" aria-label="la tua posizione">
              <div className="rw-pos-ctl">
                <label className="rw-pos-label" htmlFor="rw-size">
                  La tua size <span className="rw-pos-hint">totale, entrambi i lati</span>
                </label>
                <div className="rw-pos-inputwrap">
                  <span className="rw-pos-affix">$</span>
                  <input id="rw-size" className="rw-pos-input" inputMode="decimal" type="number" min={0} step={100}
                    placeholder="—" value={sizeInput} onChange={(e) => setSizeInput(e.target.value)}
                    aria-label="la tua size totale in dollari" />
                </div>
                <span className="rw-pos-sub">
                  {totalSizeUsd != null ? `${fmtUsd(totalSizeUsd / 2)} per lato` : 'vuota → $/giorno e resa restano «—»'}
                </span>
              </div>
              <div className="rw-pos-ctl">
                <label className="rw-pos-label" htmlFor="rw-dist">
                  Distanza dal punto medio <span className="rw-pos-hint">offset in centesimi</span>
                </label>
                <div className="rw-pos-inputwrap">
                  <input id="rw-dist" className="rw-pos-input" inputMode="decimal" type="number" min={0} step={0.1}
                    placeholder="—" value={distInput} onChange={(e) => setDistInput(e.target.value)}
                    aria-label="distanza dal punto medio in centesimi" />
                  <span className="rw-pos-affix rw-pos-affix-r">¢</span>
                </div>
                <span className="rw-pos-sub">i prezzi mostrati sono arrotondati al tick di ogni mercato</span>
              </div>
            </div>

            {/* ── FILTER CARD ── one card, six controls, each on its own hairline-divided row.
                Sliders show the current value to the RIGHT of the track; venue and the thin toggle
                are segmented controls. */}
            <div className="cc-fcard">
              {/* ── FILTER-CARD HEAD · "Azzera filtri" is ALWAYS rendered (never conditional, never
                  hidden behind a menu) so the way out of a filtered board is visible before you
                  remember which control you moved. It resets the VIEW filters only: la tua size, la
                  distanza dal mid and the bot-universe selection are untouched — said in the note so
                  the guarantee is on screen, not just in the code. ── */}
              <div className="cc-fhead">
                <span className="cc-fhead-t">Filtri</span>
                <button
                  type="button"
                  className="cc-freset"
                  data-filter-reset="1"
                  disabled={!filtersActive}
                  onClick={() => setFilters(DEFAULT_FILTERS)}
                  title="Riporta tutti i filtri ai valori predefiniti. Size, distanza dal mid e universo bot non vengono toccati."
                >
                  Azzera filtri
                </button>
                <span className="cc-fhead-note">
                  I filtri ripartono da zero a ogni ricarica. Size, distanza dal mid e selezione per
                  l&rsquo;universo bot restano.
                </span>
              </div>

              {/* SU QUALE PIATTAFORMA — segmented (server filter) */}
              <div className="cc-fctl">
                <span className="cc-flabel">Su quale piattaforma</span>
                <span className="cc-fhelp">Kalshi paga solo i residenti negli Stati Uniti.</span>
                <div className="cc-seg" role="group" aria-label="su quale piattaforma">
                  {VENUE_CHIPS.map((v) => (
                    <button key={v} type="button" aria-pressed={filters.venue === v}
                      className={`cc-seg-btn ${filters.venue === v ? 'is-on' : ''}`}
                      onClick={() => set({ venue: v })}>{v === 'all' ? 'tutte' : v}</button>
                  ))}
                </div>
                {filters.venue !== 'polymarket' && (
                  <span className="cc-fnote-amber" role="note">
                    Stai includendo Kalshi: quei premi potrebbero non essere riscuotibili da questo operatore.
                  </span>
                )}
              </div>

              {/* CATEGORIA — multi-select chips (server filter; kept for browsing) */}
              <div className="cc-fctl">
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
              <div className="cc-fctl">
                <span className="cc-flabel">Deve pagare almeno</span>
                <span className="cc-fhelp">Il montepremi giornaliero che la piattaforma mette su quel mercato. Sotto questa cifra non vale la pena esserci.</span>
                <div className="cc-slider-body">
                  <input className="cc-frange" type="range" min={0} max={Math.max(rg.poolMax, 1)} step={Math.max(1, Math.round(rg.poolMax / 100))}
                    value={Math.min(filters.minPool, Math.max(rg.poolMax, 1))}
                    onChange={(e) => set({ minPool: Number(e.target.value) })} aria-label="deve pagare almeno" />
                  <span className="cc-slider-val">≥ {filters.minPool > 0 ? fmtUsd(filters.minPool) : '$0'}/giorno</span>
                </div>
              </div>

              {/* IL LIBRO DEVE REGGERE ALMENO — min book depth at touch (server filter) */}
              <div className="cc-fctl">
                <span className="cc-flabel">Il libro deve reggere almeno</span>
                <span className="cc-fhelp">Quanti soldi ci sono già sul book al miglior prezzo. Un libro sottile significa che il premio è alto solo perché non c&rsquo;è nessuno.</span>
                <div className="cc-slider-body">
                  <input className="cc-frange" type="range" min={0} max={Math.max(rg.depthMax, 1)} step={Math.max(1, Math.round(rg.depthMax / 100))}
                    value={Math.min(filters.minDepth, Math.max(rg.depthMax, 1))}
                    onChange={(e) => set({ minDepth: Number(e.target.value) })} aria-label="il libro deve reggere almeno" />
                  <span className="cc-slider-val">≥ {filters.minDepth > 0 ? fmtUsd(filters.minDepth) : '$0'}</span>
                </div>
              </div>

              {/* DISTANZA MASSIMA FRA DOMANDA E OFFERTA — max spread (server filter). Max ⇒ "qualsiasi". */}
              <div className="cc-fctl">
                <span className="cc-flabel">Distanza massima fra domanda e offerta</span>
                <span className="cc-fhelp">Più è larga, più il prezzo si muove sotto i tuoi ordini prima che qualcuno li prenda.</span>
                <div className="cc-slider-body">
                  <input className="cc-frange" type="range" min={0} max={Math.max(rg.spreadMaxCents, 1)} step={1}
                    value={filters.maxSpreadCents < 0 ? Math.max(rg.spreadMaxCents, 1) : Math.min(filters.maxSpreadCents, Math.max(rg.spreadMaxCents, 1))}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      set({ maxSpreadCents: v >= rg.spreadMaxCents ? SENTINEL_SPREAD : v });
                    }}
                    aria-label="distanza massima fra domanda e offerta" />
                  <span className="cc-slider-val">{spreadActive ? `≤ ${filters.maxSpreadCents}¢` : 'qualsiasi'}</span>
                </div>
              </div>

              {/* QUANTI ALTRI SE LO DIVIDONO — competition level (server filter).
                  Disabled when no row carries a measured competition/saturation value. */}
              <div className={`cc-fctl ${rg.hasCompetition ? '' : 'is-disabled'}`}>
                <span className="cc-flabel">Quanti altri se lo dividono</span>
                <span className="cc-fhelp">Il premio si spartisce fra tutti quelli che quotano. Più concorrenti, meno tocca a te.</span>
                <div className="cc-slider-body">
                  <input className="cc-frange" type="range" min={0} max={100} step={5}
                    value={filters.maxCompetitionPct}
                    disabled={!rg.hasCompetition}
                    onChange={(e) => set({ maxCompetitionPct: Number(e.target.value) })} aria-label="quanti altri se lo dividono" />
                  <span className="cc-slider-val">
                    {rg.hasCompetition ? (filters.maxCompetitionPct >= 100 ? 'qualsiasi' : `≤ ${filters.maxCompetitionPct}%`) : 'n/d'}
                  </span>
                </div>
                {!rg.hasCompetition && <span className="cc-fhelp rw-dim">concorrenza non misurata da questo feed</span>}
              </div>

              {/* NASCONDI I LIBRI TROPPO SOTTILI — segmented (server filter) */}
              <div className="cc-fctl">
                <span className="cc-flabel">Nascondi i libri troppo sottili</span>
                <span className="cc-fhelp">
                  Toglie i mercati dove sotto la soglia di profondità{depthFloor != null ? ` (${fmtUsd(depthFloor)})` : ''} il rendimento annualizzato diventa una cifra irreale.
                </span>
                <div className="cc-seg" role="group" aria-label="nascondi i libri troppo sottili">
                  <button type="button" aria-pressed={!filters.hideThin}
                    className={`cc-seg-btn ${!filters.hideThin ? 'is-on' : ''}`}
                    onClick={() => set({ hideThin: false })}>Mostra tutti</button>
                  <button type="button" aria-pressed={filters.hideThin}
                    className={`cc-seg-btn ${filters.hideThin ? 'is-on' : ''}`}
                    onClick={() => set({ hideThin: true })}>Nascondi sottili</button>
                </div>
              </div>

              {/* STABILITÀ MINIMA — provisional 24h-volatility floor (server filter). Structure-only:
                  a market with NO measured stability is NOT excluded (its cell shows "—"). */}
              <div className="cc-fctl">
                <span className="cc-flabel">Stabilità minima</span>
                <span className="cc-fhelp">
                  Provvisorio — quanto poco il prezzo si è mosso nelle 24h rispetto alla banda premiante.
                  I mercati senza misura non vengono nascosti.
                </span>
                <div className="cc-slider-body">
                  <input className="cc-frange" type="range" min={0} max={100} step={5}
                    value={filters.minStab}
                    onChange={(e) => set({ minStab: Number(e.target.value) })} aria-label="stabilità minima" />
                  <span className="cc-slider-val">{filters.minStab > 0 ? `≥ ${filters.minStab}` : 'qualsiasi'}</span>
                </div>
              </div>
            </div>

            {/* ── UNIVERSO BOT — persist the current filters + explicit selection to the shared
                maker-universe store. Arms nothing. ── */}
            <BotUniversePanel apiQuery={apiQuery} selected={selected} onCleared={() => setSelected([])} />
            </aside>

            {/* ── RIGHT: the market list (the protagonist) ── */}
            <div className="rw-main">

            {/* ── HEADER TOTALS across SELECTED markets. Gross only; net is ALWAYS "—". ── */}
            <div className="rw-totals" role="note">
              <div className="rw-tot">
                <span className="rw-tot-k">selezionati</span>
                <span className="rw-tot-v">{selectedRows.length}</span>
              </div>
              <div className="rw-tot">
                <span className="rw-tot-k">$/giorno lordo tot.</span>
                <span className="rw-tot-v rw-tot-primary">
                  {selectedRows.length === 0 || totalSizeUsd == null
                    ? <span className="rw-dim">—</span>
                    : !isPaid
                      ? <span className="rw-dim" title="sblocca per vedere le cifre">🔒</span>
                      : <>${selTotals.gross.toFixed(2)}{selTotals.grossKnown < selectedRows.length ? <span className="rw-dim"> (parziale)</span> : null}</>}
                </span>
              </div>
              <div className="rw-tot">
                <span className="rw-tot-k">capitale impegnato</span>
                <span className="rw-tot-v">
                  {selectedRows.length === 0 || totalSizeUsd == null ? <span className="rw-dim">—</span> : fmtUsd(selTotals.capital)}
                </span>
              </div>
              <div className="rw-tot">
                <span className="rw-tot-k">netto</span>
                <span className="rw-tot-v rw-dim" title="adverse selection non modellata — il netto resta sconosciuto">—</span>
              </div>
            </div>

            <div className="cc-count cc-count-row">
              <span className="cc-count-text">
                {visible.length} mercati su {total} passano · ordinati per {
                  filters.sortMode === 'stability' ? 'stabilità (alta→bassa)'
                  : filters.sortMode === 'expiry' ? 'scadenza (prima le vicine)'
                  : `$/giorno (${filters.sortDir === 'asc' ? 'basso→alto' : 'alto→basso'})`}
              </span>
              {/* Sort — presentation only; reuses the engine's stabilityScore / netUsdPerDay /
                  hoursToResolution. Withheld/"—" rows stay pinned LAST in every mode (see sortRows). */}
              <span className="cc-sortdir" role="group" aria-label="ordinamento">
                <button type="button" title="Ordina per stabilità (alta → bassa)"
                  className={`cc-sortbtn ${filters.sortMode === 'stability' ? 'is-on' : ''}`}
                  aria-pressed={filters.sortMode === 'stability'}
                  onClick={() => set({ sortMode: 'stability' })}>stabilità</button>
                <button type="button" title="Ordina per $/giorno (alto → basso)"
                  className={`cc-sortbtn ${filters.sortMode === 'day' ? 'is-on' : ''}`}
                  aria-pressed={filters.sortMode === 'day'}
                  onClick={() => set({ sortMode: 'day', sortDir: 'desc' })}>$/giorno</button>
                <button type="button" title="Ordina per scadenza (prima le vicine)"
                  className={`cc-sortbtn ${filters.sortMode === 'expiry' ? 'is-on' : ''}`}
                  aria-pressed={filters.sortMode === 'expiry'}
                  onClick={() => set({ sortMode: 'expiry' })}>scadenza</button>
              </span>
            </div>
            {/* PERMANENT caveat — the stability score is a backward-looking measurement, and the two
                columns are meant to be read together. Never collapsed, never dismissible. */}
            <p className="cc-stab-note" data-stab-caveat="1">
              La stabilità misura quanto il prezzo si è <strong>già</strong> mosso: non prevede il futuro.
              Un mercato fermo può muoversi su una notizia. Usa la <strong>scadenza</strong> come correzione —
              un evento lontano ha meno motivi di muoversi adesso. Dove non è misurata leggi “—”, mai uno zero.
            </p>

            {visible.length === 0 ? (
              <EmptyState prefix="cc" title="Nessun mercato passa questi filtri."
                sub={mostRestrictiveLabel
                  ? `Il filtro che ne toglie di più adesso è «${mostRestrictiveLabel}»: allentalo per vederne altri.`
                  : 'Allenta un filtro per vederne altri.'} />
            ) : (
              <div className="cc-list">
                {visible.map((row) => {
                  const { m } = row;
                  const id = `${m.venue}-${m.marketId}`;
                  const isOpen = expandedId === id;
                  const isSel = selectedSet.has(m.marketId);
                  const pr = priceRowFor(m);                       // user-size gross + own-impact (one math path)
                  const exp = expiryView(row.hoursToResolution);   // real expiry, "— scad." when unreadable
                  return (
                    <div key={id}>
                      <div className={`cc-row ${isOpen ? 'is-open' : ''} ${isSel ? 'is-sel' : ''}`}>
                        {/* SELECTION toggle → bot-universe selection. stopPropagation so it never expands the row. */}
                        <label className="rw-sel" title="seleziona per l'universo bot" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={isSel} onChange={() => toggleSelected(m.marketId)}
                            aria-label={`seleziona ${m.title} per l'universo bot`} />
                        </label>
                        <span
                          className="cc-row-body"
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
                            {/* PHASE 2 — Kalshi rewards are US-only (this operator is in the EU): a permanent,
                                non-dismissible "not collectable" badge, so the row can never read as actionable. */}
                            {row.notCollectable && (
                              <span className="rw-nocollect" title="il programma premi di Kalshi è riservato ai membri residenti negli Stati Uniti (help.kalshi.com) e questo operatore è nell'UE: questi premi non sono riscuotibili. La riga resta visibile ma non è un'opportunità.">
                                non riscuotibile · solo USA
                              </span>
                            )}
                            {/* EXPIRY — real hoursToResolution → "45g"/"2 mesi"; "— scad." when unreadable.
                                ≤3d red, ≤14d amber. Never guesses a date. */}
                            <span className={`rw-exp rw-exp-${exp.band}`} title="tempo alla risoluzione del mercato">{exp.label}</span>
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
                          {/* The market question, FULL text, wrapping — this is what the operator
                              recognises a market by, so it is never truncated to one line. */}
                          <span className="cc-row-title">{m.groupItemTitle || m.title}</span>
                          {/* QUIET METADATA LINE — context, not headline: the pot (whole prize),
                              the two-sided book depth, the spread, the competition. All the same
                              small size, middot-separated. Any unavailable value renders "—" (free
                              tier → 🔒 unlock), never 0. */}
                          <span className="cc-row-meta">
                            {/* PRICE-FIRST lead: the scoring mid (size-cutoff-adjusted) — the price the
                                whole reward band is centred on. Redacted → 🔒 on the free tier. */}
                            <span className="cc-meta-item">
                              <span className="cc-meta-k">prezzo medio</span>{' '}
                              <Redacted value={fin(m.rewardScore?.mid) ? (m.rewardScore!.mid as number) : null} isPaid={isPaid}>
                                {(v) => <span className="rw-nowrap rw-mid-lead">{(Number(v) * 100).toFixed(1)}¢</span>}
                              </Redacted>
                            </span>
                            <span className="cc-meta-dot">·</span>
                            <span className="cc-meta-item">
                              <span className="cc-meta-k">montepremi</span>{' '}
                              {/* pot is a PUBLIC teaser (owner freemium split) — real for every tier. */}
                              <Redacted value={row.poolDayUsd} isPaid>{(v) => <span className="rw-nowrap">${Number(v).toFixed(0)}/giorno</span>}</Redacted>
                            </span>
                            <span className="cc-meta-dot">·</span>
                            <span className="cc-meta-item">
                              <span className="cc-meta-k">profondità</span>{' '}
                              <Redacted value={row.capacityUsd} isPaid={isPaid}>{(v) => <span className="rw-nowrap">{fmtDepth(Number(v))}</span>}</Redacted>
                            </span>
                            <span className="cc-meta-dot">·</span>
                            <span className="cc-meta-item">
                              <span className="cc-meta-k">spread</span>{' '}
                              <Redacted value={fin(m.bookSpread) ? (m.bookSpread as number) : null} isPaid={isPaid}>{(v) => <span className="rw-nowrap">{Math.round(Number(v) * 100)}¢</span>}</Redacted>
                            </span>
                            <span className="cc-meta-dot">·</span>
                            <span className="cc-meta-item">
                              <span className="cc-meta-k">concorrenza</span>{' '}
                              {/* competition = saturation (how occupied the pool already is). Public teaser. */}
                              <Redacted value={row.saturation} isPaid nullDisplay={<span className="rw-dim">—</span>}>
                                {(sat) => {
                                  const v = saturationView(Number(sat));
                                  return v ? <span className="rw-nowrap">{Math.round(v.pct)}% occupato</span> : <span className="rw-dim">—</span>;
                                }}
                              </Redacted>
                            </span>
                          </span>
                          {/* ── COMPACT STAT STRIP — own-impact (size ÷ eligible depth) + stability (structure).
                              Wraps 2×2 on the narrowest widths rather than overflowing. ── */}
                          <span className="rw-strip">
                            <span className="rw-stat">
                              <span className="rw-stat-k">tuo peso</span>
                              {pr.ownImpactPct == null
                                ? <span className="rw-stat-v rw-dim">—</span>
                                : <span className={`rw-stat-v rw-impact rw-impact-${pr.ownImpactBand}`} title="la tua size rispetto alla profondità premiante già presente (entrambi i lati)">
                                    {pr.ownImpactPct < 100 ? pr.ownImpactPct.toFixed(1) : Math.round(pr.ownImpactPct)}%
                                  </span>}
                            </span>
                            {/* STABILITÀ — score + plain label, with the MEASURED driver on hover.
                                Facts only (movement, book, flow, sample); no placement advice. */}
                            <span className="rw-stat">
                              <span className="rw-stat-k">stabilità</span>
                              {row.stabilityScore == null
                                ? <span className="rw-stat-v rw-dim" data-stab-driver="unknown" title={stabilityUnknownText(row.stability.reason)}>— <i className="rw-stab-bar rw-stab-none" /></span>
                                : <span className="rw-stat-v" data-stab-driver="measured" title={stabilityDriverText(row.stability)}>
                                    {row.stabilityScore}<span className="rw-stab-lab">{row.stability.label}</span>
                                    <i className={`rw-stab-bar rw-stab-${row.stabilityScore >= 70 ? 'hi' : row.stabilityScore >= 35 ? 'mid' : 'lo'}`} style={{ ['--v' as any]: `${row.stabilityScore}%` }} />
                                  </span>}
                            </span>
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
                            {/* HEADLINE = expected GROSS $/day AT THE USER'S SIZE (price-first) — the shared
                                quadratic (poolDay × share) at the chosen offset vs the feed's competitorQ.
                                "—" while the size box is empty (no default). Free tier → 🔒 unlock. */}
                            <Redacted
                              value={pr.grossPerDay}
                              isPaid={isPaid}
                              nullDisplay={<span title={
                                totalSizeUsd == null ? 'inserisci la tua size in alto per stimare il $/giorno'
                                : row.nonExecReason ?? 'questo book non è valutabile — nessun pool o profondità in banda dal feed'
                              }>—</span>}
                            >
                              {(v) => (
                                <span className="rw-nowrap">
                                  ${Number(v).toFixed(2)}/day <span className="cc-row-stima" title="cifra modellata al tuo size, non un pagamento osservato">stima</span>
                                </span>
                              )}
                            </Redacted>
                            {/* PHASE 1 — the POT the share/estimate is a share OF, always adjacent so a % or a
                                $/day is never read without the money behind it. A pot below the floor is
                                labelled "troppo piccolo": a high share of it is not an opportunity. */}
                            <span className="cc-row-pot">
                              <span className="cc-row-pot-k">montepremi</span>{' '}
                              <Redacted value={row.poolDayUsd} isPaid>{(v) => <span className="rw-nowrap">${Number(v).toFixed(0)}/giorno</span>}</Redacted>
                              {row.potTooSmall && (
                                <span className="cc-row-potwarn" title="il montepremi è troppo piccolo perché una quota alta significhi un'opportunità: anche prendendolo quasi tutto sono pochi dollari al giorno — questa riga è retrocessa in fondo">
                                  {' '}· troppo piccolo
                                </span>
                              )}
                            </span>
                            {/* ANNUALIZED — the user-size run-rate (resa/giorno × 365), demoted behind the
                                SHARED APY_CAP + ">200%/yr" label from lib/honest-display (never forked). Only
                                when a size is set AND the row is priceable; else no line. */}
                            {(() => {
                              const dy = pr.dayYieldPct;
                              if (totalSizeUsd == null || !fin(dy) || !isPaid) return null;
                              const annual = (dy as number) * 365;
                              return annual > APY_CAP
                                ? <span className="cc-row-runrate" title="annualizzato sul tuo size — un run-rate che si comprime quando arrivano altri maker, non un rendimento garantito">{APY_CAP_LABEL}</span>
                                : <span className="cc-row-runrate" title="annualizzato sul tuo size — un run-rate, non un rendimento garantito">~{Math.round(annual)}%/yr · run-rate, not guaranteed</span>;
                            })()}
                            {/* ADVERSE-SELECTION DISCLOSURE — persistent, non-dismissible, on EVERY row.
                                Rewards $/day is a GROSS subsidy; the cost of adverse selection / inventory
                                risk on resting maker orders is NOT modelled, so the NET return is unknown.
                                No net figure is invented anywhere. */}
                            <span className="cc-row-adv" title="i premi mostrati sono lordi; il costo di adverse selection e il rischio di inventario sugli ordini a riposo non sono modellati — il rendimento netto è sconosciuto e non viene stimato">
                              lordo · adverse selection non modellata · netto —
                            </span>
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
                        </span>
                      </div>

                      {isOpen && (
                        <div className="cc-expand">
                          {/* PRICE-FIRST block (Part A): scoring mid centre, BUY YES | MID | BUY NO,
                              complementary-identity line, reward-band rail, expected gross $/day at YOUR
                              size, own-impact chip, net "—". The band warning CALLS the shared validator. */}
                          <RewardPriceFirst row={row} isPaid={isPaid} totalSizeUsd={totalSizeUsd} offsetCents={offsetCents} />
                          <RewardYieldBreakdown row={row} isPaid={isPaid} />
                          {/* Into the interactive order-book detail page for THIS exact market.
                              marketId is the raw feed id (Polymarket conditionId / Kalshi ticker) —
                              the same key the detail route resolves against /api/rewards-unified. */}
                          <div className="rw-open-row">
                            <Link
                              href={`/dashboard/liquidity-rewards/${encodeURIComponent(m.marketId)}`}
                              prefetch={false}
                              className="rw-open-book"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Apri il book →
                            </Link>
                            {/* The READ-ONLY event terminal: rules, identifiers, dates, live book, chain
                                state. Declares what this market is; suggests nothing. */}
                            <Link
                              href={`/dashboard/liquidity-rewards/${encodeURIComponent(m.marketId)}/event`}
                              prefetch={false}
                              className="rw-open-book"
                              data-open-event="1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Scheda mercato →
                            </Link>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <p className="cc-note">
              Il numero in testa è la <strong>stima al tuo size</strong>: il montepremi per la quota
              di pool che il tuo ordine otterrebbe, quotato a due lati alla distanza scelta dal punto
              medio (mid a taglio-dimensione), diluita contro la profondità già presente su entrambi i
              lati con la formula quadratica pubblicata S(v,s) = ((v−s)/v)². Profondità e concorrenza su
              Polymarket sono misurate dal CLOB live; Kalshi è uno split osservato a pro-rata. Tutte le
              cifre sono premio <strong>lordo</strong> — il P&amp;L di inventario quando i tuoi ordini
              vengono eseguiti non è incluso. Istantanea puntuale; i concorrenti riquotano; non è un
              rendimento promesso.
            </p>
            </div>
          </div>
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
          {/* PHASE 2 — Kalshi rewards are not collectable from the EU, so no earnable share/reward is
              shown (a number you cannot collect is not honest to display): "—" + the jurisdiction reason. */}
          <div className="rw-brk-item"><span className="rw-brk-k">your pool share</span>
            <span className="rw-brk-v">{row.notCollectable
              ? <span className="rw-dim" title="programma Kalshi riservato ai membri USA — non riscuotibile da questo operatore (UE)">—</span>
              : <Redacted value={row.unknown ? null : row.share} isPaid={isPaid}>{(v) => <>{(Number(v) * 100).toFixed(1)}%{fin(row.poolDayUsd) ? <span className="rw-dim"> · di ${(row.poolDayUsd as number).toFixed(0)}/g</span> : null}</>}</Redacted>}</span></div>
          <div className="rw-brk-item"><span className="rw-brk-k">{row.notCollectable ? 'your reward · non riscuotibile' : 'your reward · stima (gross)'}</span>
            <span className="rw-brk-v rw-brk-primary">{row.notCollectable
              ? <span className="rw-dim" title="i premi Kalshi sono riservati ai residenti USA; questo operatore è nell'UE — nessuna cifra guadagnabile viene mostrata">—</span>
              : <Redacted value={row.unknown ? null : row.netUsdPerDay} isPaid={isPaid}>{(v) => <>${Number(v).toFixed(2)}/day</>}</Redacted>}</span></div>
          {/* Net is NOT modelled — adverse selection / inventory risk on fills is excluded. No figure invented. */}
          <div className="rw-brk-item"><span className="rw-brk-k">net (adverse selection non modellata)</span>
            <span className="rw-brk-v rw-dim" title="il rendimento netto sottrae il costo di adverse selection quando i tuoi ordini vengono eseguiti — non è modellato, quindi resta sconosciuto">—</span></div>
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

/**
 * PRICE-FIRST expansion (Part A) — the reward row rebuilt around PRICE.
 *  • three-cell price block BUY YES | MID | BUY NO (MID largest), derived from the SCORING mid + the
 *    user's offset, tick-snapped; complementary-identity line under it.
 *  • reward-band rail: mid tick, eligible band (mid ± maxSpread/2), posted bid/ask markers, live touch.
 *  • expected GROSS $/day at the user's TOTAL size via the published quadratic (poolDay × share) at the
 *    chosen offset against the feed's competitorQ; own-impact chip; net "—" (adverse selection unmodelled).
 * Every number is REAL or "—". The band warning CALLS the shared venue-rules validator (never reimplemented).
 */
function RewardPriceFirst({ row, isPaid, totalSizeUsd, offsetCents }:
  { row: Row; isPaid: boolean; totalSizeUsd: number | null; offsetCents: number | null }) {
  const m = row.m;
  const pr: PriceRow = computePriceRow({
    rewardScore: m.rewardScore ?? null,
    tick: fin(m.tickSize) ? (m.tickSize as number) : null,
    totalSizeUsd,
    offsetCents,
    market: m,
  });

  // Free tier redacts rewardScore.mid/competitorQ → scoringMid null → the calm unlock/"—" state (never a
  // fabricated price). Paid but genuinely unscored (no book) → "—" with no unlock.
  if (!fin(pr.scoringMid)) {
    return (
      <div className="rw-pf">
        <div className="rw-pf-locked">
          {isPaid
            ? <span className="rw-dim">— prezzo non calcolabile: il book non è stato valutato (nessun mid dal feed)</span>
            : <Redacted value={null} isPaid={isPaid}>{() => <>—</>}</Redacted>}
        </div>
      </div>
    );
  }

  const mid = pr.scoringMid as number;
  const c1 = (p: number) => (p * 100).toFixed(1);   // price (0..1) → cents, one decimal

  // Rail geometry — map a price to x% across a rail spanning mid ± railRadius cents; clamp to [0,100].
  const railHalf = fin(pr.railRadiusC) ? (pr.railRadiusC as number) / 100 : null;
  const xOf = (price: number | null): number | null => {
    if (price == null || !fin(price) || railHalf == null || railHalf <= 0) return null;
    return Math.max(0, Math.min(100, 50 + ((price - mid) / railHalf) * 50));
  };
  // Eligible band fills the central bandRadius/railRadius fraction (= 50%, since rail = 2× band radius).
  const bandFrac = (fin(pr.bandRadiusC) && fin(pr.railRadiusC) && (pr.railRadiusC as number) > 0)
    ? (pr.bandRadiusC as number) / (pr.railRadiusC as number) : null;
  const bandLeftPct = bandFrac != null ? 50 - bandFrac * 50 : null;
  const bandWidthPct = bandFrac != null ? bandFrac * 100 : null;
  const xBid = xOf(pr.buyYes);
  const xAsk = xOf(pr.sellYes);
  const xTouchBid = xOf(fin(m.bestBid) ? (m.bestBid as number) : null);
  const xTouchAsk = xOf(fin(m.bestAsk) ? (m.bestAsk as number) : null);

  // ── B1–B3: the band warning CALLS the shared validator (validateQuotePair applies the qMin coupling).
  //    Only run it when we have posted prices (an offset). Size in SHARES = per-side $ / leg price when the
  //    user set a size; null otherwise (the price-level reasons hold regardless of size). ──
  const canValidate = fin(pr.buyYes) && fin(pr.sellYes);
  const rules = { tick: pr.tick, scoringMid: pr.scoringMid, maxSpreadCents: pr.maxSpreadCents, minSize: pr.minSize };
  const bidShares = (pr.perSideUsd != null && fin(pr.buyYes) && (pr.buyYes as number) > 0) ? pr.perSideUsd / (pr.buyYes as number) : null;
  const askShares = (pr.perSideUsd != null && fin(pr.sellYes) && (pr.sellYes as number) > 0) ? pr.perSideUsd / (pr.sellYes as number) : null;
  const verdict: PairVerdict | null = canValidate
    ? validateQuotePair(rules,
        { side: 'BUY', price: pr.buyYes as number, size: bidShares as number },
        { side: 'SELL', price: pr.sellYes as number, size: askShares as number })
    : null;
  const priceCodes = new Set(['OUT_OF_BAND', 'OFF_TICK', 'PRICE_OUT_OF_RANGE', 'RULES_UNREADABLE']);
  const bandReasons = verdict ? verdict.reasons.filter((r) => priceCodes.has(r.code)) : [];
  const outOfBand = bandReasons.some((r) => r.code === 'OUT_OF_BAND');
  // Min-size reasons only matter once a size is set — surfaced near the $/day, not the band rail.
  const sizeReasons = (verdict && totalSizeUsd != null) ? verdict.reasons.filter((r) => r.code === 'BELOW_MIN_SIZE') : [];
  // BELOW-MIN CLARITY: when the per-side order is below the venue's min_incentive_size the reward is a
  // CORRECT $0 — but a bare "$0.00" hides WHY. Surface the venue minimum (in shares) inline by the $/day so
  // the reason is legible. The $ needed scales with price (≈ minSize × price), so we state the share minimum.
  const belowMin = sizeReasons.length > 0;
  const minSizeShares = fin(pr.minSize) ? (pr.minSize as number) : null;

  return (
    <div className="rw-pf">
      {/* ── PRICE BLOCK · the visual centre ── */}
      <div className="rw-pf-prices" role="group" aria-label="prezzi da quotare">
        <div className="rw-pf-cell">
          <span className="rw-pf-k">compra YES</span>
          <span className="rw-pf-v">{fin(pr.buyYes) ? `${c1(pr.buyYes as number)}¢` : '—'}</span>
        </div>
        <div className="rw-pf-cell rw-pf-mid">
          <span className="rw-pf-k">punto medio</span>
          <span className="rw-pf-v rw-pf-vbig">{c1(mid)}¢</span>
        </div>
        <div className="rw-pf-cell">
          <span className="rw-pf-k">compra NO</span>
          <span className="rw-pf-v">{fin(pr.buyNo) ? `${c1(pr.buyNo as number)}¢` : '—'}</span>
        </div>
      </div>
      {fin(pr.buyNo) && fin(pr.sellYesForNoIdentity) && (
        <div className="rw-pf-ident">
          compra NO a {c1(pr.buyNo as number)}¢ = vendi YES a {c1(pr.sellYesForNoIdentity as number)}¢ — <strong>stesso ordine</strong>
        </div>
      )}
      {!pr.tickKnown && (
        <div className="rw-pf-ticknote">tick di mercato non disponibile dal feed — prezzi non arrotondati al tick</div>
      )}

      {/* ── REWARD-BAND RAIL ── centred on the mid, spanning ± max_spread; eligible band = ± max_spread/2 ── */}
      {railHalf != null ? (
        <div className="rw-rail-wrap">
          <div className="rw-rail" aria-hidden="true">
            {bandLeftPct != null && bandWidthPct != null && (
              <span className="rw-rail-band" style={{ left: `${bandLeftPct}%`, width: `${bandWidthPct}%` }} />
            )}
            <span className="rw-rail-mid" style={{ left: '50%' }} />
            {xTouchBid != null && <span className="rw-rail-touch" style={{ left: `${xTouchBid}%` }} title="miglior offerta reale sul book" />}
            {xTouchAsk != null && <span className="rw-rail-touch" style={{ left: `${xTouchAsk}%` }} title="miglior domanda reale sul book" />}
            {xBid != null && <span className={`rw-rail-order ${pr.bidInBand === false ? 'is-out' : ''}`} style={{ left: `${xBid}%` }} title="il tuo ordine di acquisto YES" />}
            {xAsk != null && <span className={`rw-rail-order ${pr.askInBand === false ? 'is-out' : ''}`} style={{ left: `${xAsk}%` }} title="il tuo ordine di vendita YES" />}
          </div>
          <div className="rw-rail-legend">
            <span className="rw-rail-lg"><i className="rw-lg-band" /> banda premiante (±{fin(pr.bandRadiusC) ? (pr.bandRadiusC as number).toFixed(1) : '—'}¢)</span>
            <span className="rw-rail-lg"><i className="rw-lg-order" /> i tuoi ordini</span>
            {(fin(m.bestBid) || fin(m.bestAsk)) && <span className="rw-rail-lg"><i className="rw-lg-touch" /> book reale</span>}
          </div>
        </div>
      ) : (
        <div className="rw-pf-ticknote">banda premiante non disponibile dal feed — nessun rail</div>
      )}

      {/* ── BAND WARNING — from the shared validator (B1–B3), plain language ── */}
      {outOfBand && (
        <div className="rw-pf-warn" role="note">
          ⚠ A {offsetCents != null ? `${offsetCents}¢` : 'questa distanza'} dal punto medio i tuoi ordini sono <strong>fuori dalla banda premiante</strong>:
          non maturano premi pur restando eseguibili (puoi comunque essere colpito).{verdict?.degraded && verdict.note ? ` Punteggio a due lati: ${verdict.note}.` : ''}
        </div>
      )}
      {!outOfBand && bandReasons.length > 0 && (
        <div className="rw-pf-warn" role="note">⚠ {bandReasons.map((r) => r.detail).join(' · ')}</div>
      )}

      {/* The capacity cap on the ESTIMATE: when the in-band depth binds, the $/day and the resa below
          are the CAPPED figures and say so; when the depth cannot be read there is no figure at all. */}
      {pr.capNote && (
        <div className="rw-pf-warn" role="note">
          {pr.capitalCapped ? `⚠ limitato dalla profondità in banda ($${Math.round(pr.capitalCapUsd ?? 0)}) — ` : '⚠ '}{pr.capNote}
        </div>
      )}

      {/* ── NUMBERS BELOW THE PRICE BLOCK (A5) ── */}
      <div className="rw-pf-nums">
        <div className="rw-pf-num">
          <span className="rw-pf-nk">premio lordo · al tuo size</span>
          <span className="rw-pf-nv rw-pf-primary">
            {totalSizeUsd == null
              ? <span className="rw-dim" title="inserisci la tua size in alto per stimare il $/giorno">—</span>
              : belowMin
                ? <span
                    className="rw-pf-belowmin"
                    data-belowmin
                    title={`la tua size è sotto il minimo del venue: servono almeno ${minSizeShares ?? '—'} shares per lato (≈ minSize × prezzo in $) per maturare premi`}
                    style={{ color: '#E8B23A', fontWeight: 600, fontSize: '13px', whiteSpace: 'normal' }}
                  >
                    $0.00/day · sotto il minimo del venue{minSizeShares != null ? ` (≥ ${minSizeShares} shares/lato)` : ''}
                  </span>
                : <Redacted value={pr.grossPerDay} isPaid={isPaid} nullDisplay={<span className="rw-dim">—</span>}>
                    {(v) => <span className="rw-nowrap">${Number(v).toFixed(2)}/day <span className="cc-row-stima">stima</span></span>}
                  </Redacted>}
          </span>
        </div>
        <div className="rw-pf-num">
          <span className="rw-pf-nk">resa</span>
          <span className="rw-pf-nv">
            {totalSizeUsd == null || pr.dayYieldPct == null
              ? <span className="rw-dim">—</span>
              : <Redacted value={pr.dayYieldPct} isPaid={isPaid} nullDisplay={<span className="rw-dim">—</span>}>{(v) => <span className="rw-nowrap">{Number(v).toFixed(3)}%/giorno</span>}</Redacted>}
          </span>
        </div>
        <div className="rw-pf-num">
          <span className="rw-pf-nk">tuo peso sul book</span>
          <span className="rw-pf-nv">
            {pr.ownImpactPct == null
              ? <span className="rw-dim">—</span>
              : <span className={`rw-impact rw-impact-${pr.ownImpactBand}`} title="la tua size rispetto alla profondità premiante già presente sul book (entrambi i lati)">
                  {pr.ownImpactPct < 100 ? pr.ownImpactPct.toFixed(1) : Math.round(pr.ownImpactPct)}%{pr.ownImpactBand === 'high' ? ' · diventi tu il book' : ''}
                </span>}
          </span>
        </div>
      </div>

      {pr.shareIsCeiling && (
        <div className="rw-pf-ceil" role="note">
          Con questo peso sul book la quota stimata è un <strong>tetto ottimistico</strong>: presuppone che gli altri maker non riquotino.
        </div>
      )}
      {sizeReasons.length > 0 && (
        <div className="rw-pf-warn" role="note">⚠ {sizeReasons.map((r) => r.detail).join(' · ')}</div>
      )}

      {/* NET — always "—": adverse selection / inventory risk on fills is not modelled. */}
      <div className="rw-pf-net" title="il rendimento netto sottrae il costo di adverse selection quando i tuoi ordini vengono eseguiti — non è modellato, quindi resta sconosciuto">
        netto <span className="rw-dim">—</span> · adverse selection non modellata · una quota di premio più alta = la quota più stretta, cioè quella più facilmente colpita
      </div>
    </div>
  );
}

/**
 * BOT-UNIVERSE panel (filter-column). Persists the CURRENT filters + the explicit per-row selection to
 * the EXISTING maker-universe store (Prisma singleton via lib/maker/selection → POST /api/maker/universe).
 * The explicit selection is sent as `allowlist` (force-include). This ONLY persists selection — it arms
 * nothing, enables no trading, places/signs nothing. Two-step (button → confirm) so browsing never
 * auto-syncs. The gated POST (admin-only) is the ONLY write; a 401 tells the user to log in.
 */
function BotUniversePanel({ apiQuery, selected, onCleared }:
  { apiQuery: string; selected: string[]; onCleared: () => void }) {
  const [active, setActive] = useState<any | null>(null);
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadActive = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/universe', { cache: 'no-store' });
      if (r.ok) setActive(await r.json());
    } catch { /* leave prior */ }
  }, []);
  useEffect(() => { loadActive(); }, [loadActive]);

  const filtersObj = useMemo(() => {
    const o: Record<string, string> = {};
    new URLSearchParams(apiQuery).forEach((v, k) => { o[k] = v; });
    return o;
  }, [apiQuery]);
  // maxMarkets covers the explicit selection so a picked market is never capped below the selection size.
  const maxMarkets = Math.max(5, selected.length);

  const confirm = useCallback(async () => {
    setPhase('busy'); setMsg(null);
    try {
      const r = await fetch('/api/maker/universe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters: filtersObj, venues: ['polymarket'], allowlist: selected, maxMarkets }),
      });
      if (r.status === 401) setMsg({ ok: false, text: 'Serve l’accesso admin per cambiare l’universo del bot — /settings/login.' });
      else if (!r.ok) { const d = await r.json().catch(() => ({})); setMsg({ ok: false, text: d.error || 'Impossibile impostare l’universo del bot.' }); }
      else { setMsg({ ok: true, text: 'Universo del bot aggiornato — nessun ordine è stato inviato.' }); setPhase('idle'); await loadActive(); return; }
    } catch { setMsg({ ok: false, text: 'Impossibile impostare l’universo del bot.' }); }
    setPhase('idle');
  }, [filtersObj, selected, maxMarkets, loadActive]);

  const activeCount = active?.resolved?.marketIds?.length ?? null;

  return (
    <div className="rw-bu">
      <div className="rw-bu-title">Universo bot</div>
      <p className="rw-bu-note">
        I filtri cambiano la <strong>vista</strong>. Il bot si muove solo quando <strong>confermi</strong> —
        e questa azione salva soltanto la selezione: non arma nulla, non invia nessun ordine.
      </p>
      <div className="rw-bu-kv">
        <span>attivo ora</span>
        <span className="rw-bu-v">{activeCount != null ? `${activeCount} mercati` : '—'}</span>
      </div>
      <div className="rw-bu-kv">
        <span>selezionati qui</span>
        <span className="rw-bu-v">{selected.length}</span>
      </div>

      {phase !== 'confirm' ? (
        <button type="button" className="rw-bu-btn" disabled={phase === 'busy'} onClick={() => { setMsg(null); setPhase('confirm'); }}>
          {phase === 'busy' ? 'Imposto…' : 'Imposta come universo bot'}
        </button>
      ) : (
        <div className="rw-bu-confirm">
          <p className="rw-bu-note">
            L’universo diventa: i mercati che passano i filtri correnti{selected.length ? `, più i ${selected.length} selezionati (forzati)` : ''},
            ordinati per montepremi e limitati a {maxMarkets}. Salva solo la selezione.
          </p>
          <div className="rw-bu-actions">
            <button type="button" className="rw-bu-btn" onClick={confirm}>Conferma</button>
            <button type="button" className="rw-bu-cancel" onClick={() => setPhase('idle')}>Annulla</button>
          </div>
        </div>
      )}
      {selected.length > 0 && phase === 'idle' && (
        <button type="button" className="rw-bu-clear" onClick={onCleared}>deseleziona tutto</button>
      )}
      {msg && <div className={msg.ok ? 'rw-bu-ok' : 'rw-bu-err'}>{msg.text}</div>}
    </div>
  );
}

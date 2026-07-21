'use client';

// Liquidity Rewards — unified per-market DETAIL page (Polymarket + Kalshi).
// Opens when a market card is tapped (/dashboard/liquidity-rewards/[marketId]).
//
// Sections:
//   A) sticky header (back, venue, title, meta)
//   B) earnings block (net $/day primary + pool share / fill prob / adverse cost)
//   C) order controls (side · qty/side · distance)  → recompute via lib/rewards-estimate
//   D) LIVE order book (real executable prices) with the user's planned orders inline
//   E) fill-handling choice (requote | flatten)      → persisted
//   F) news-guard choice   (withdraw | alert | off)  → persisted, wired to agent27 risk
//   G) CTA "Simulate placement · paper" → POST /api/rewards/placement
//
// HONEST-ENGINE: executable book prices only (never midpoint for fills); GROSS $/day is the
// primary ticket metric via the shared two-sided model (lib/reward-score → lib/liquidity-yield),
// so it can never disagree with the list; NO annualized figure anywhere; no fabricated pools/PnL;
// no login wall on view; live execution OFF everywhere (EXECUTION_ENABLED=false, simulation only —
// no keys, no order path). Book/pool numbers are server-redacted on the free tier — the page
// degrades to a calm "unlock" state, never a fake number.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ChevronLeft, RefreshCw, X } from 'lucide-react';
import PlatformLogo from '@/components/PlatformLogo';
import { Redacted } from '@/app/components/ui/Redacted';
import InfoTip from '@/app/components/ui/InfoTip';
import { PlatformLink } from '@/app/components/ui/PlatformLink';
import { polymarketMarketUrl, polymarketOutcomeUrl, kalshiMarketUrl } from '@/lib/platform-links';
import { estimateReward, type MarketSnapshot, type SideKey, type SideSnapshot, type Venue } from '@/lib/rewards-estimate';
// Two-sided scoring SSOT — the SAME model the list view ships (reuses lib/liquidity-yield), so the
// ticket and the list can never disagree for the same market/capital. See scripts/assert-reward-score.js.
import { computeRewardScore, type LevelAlloc } from '@/lib/reward-score';
// Execution-ready scaffold — SIMULATION ONLY. EXECUTION_ENABLED is a hard compile-time false; the
// only adapter placed no order. NO key/credential path is imported anywhere reachable from here.
import { EXECUTION_ENABLED, type ExecutionPlan } from '@/lib/execution/types';
import { activeAdapter } from '@/lib/execution/simulation-adapter';

// Book snapshot older than this ⇒ estimate is marked STALE and not actionable (no fresh-looking
// number on stale data). Poll is ~4s, so this tolerates a couple of missed polls before flagging.
const STALE_BOOK_MS = 15_000;

// ── Types ─────────────────────────────────────────────────────────────────────
type NewsRisk = 'low' | 'medium' | 'high' | 'unknown';
type SideMode = 'both' | 'buy' | 'sell';
type OnFill   = 'requote' | 'close';
type NewsMode = 'withdraw' | 'alert' | 'off';

// Legacy single onFill ('requote' | 'flatten') → per-side rule ('flatten' == 'close').
const legacyToRule = (v: unknown): OnFill | null =>
  v === 'requote' ? 'requote' : (v === 'close' || v === 'flatten') ? 'close' : null;

interface NormalizedMarket {
  venue:               Venue;
  marketId:            string;
  slug?:               string | null;
  marketSlug?:         string | null;   // per-outcome slug for multi-outcome deep-link
  groupItemTitle?:     string | null;   // outcome label (e.g. "England")
  negRisk?:            boolean;          // true → multi-outcome event
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
  tokenIdNo?:          string | null;
  sides?:              { yes: SideSnapshot | null; no: SideSnapshot | null } | null;
  newsRisk?:           NewsRisk;
  newsSignals?:        { source: string; note: string }[] | null;
  protect?:            { action: string; detail: string; liveExecution?: string } | null;
}

interface BookRow { price: number; size: number }   // price 0..1 fraction, size shares
// asksComplement=true means the ask ladder is the CONTRACT COMPLEMENT of the other
// side's bids (Kalshi returns bids only; asks are the real 100¢−bid identity), so the UI
// can label it honestly. Polymarket books are real independent CLOBs → false.
interface NormBook { bids: BookRow[]; asks: BookRow[]; lastTrade: number | null; hasBook: boolean; note: string | null; asksComplement: boolean }
interface DualBook { yes: NormBook; no: NormBook }

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtC   = (p: number) => `${(p * 100).toFixed(1)}¢`;
const fmtSh  = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0));
function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  if (n >= 10)        return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}
function fmtHours(h: number | null) {
  if (h == null) return '—';
  if (h < 48) return `${h.toFixed(0)}h`;
  return `${(h / 24).toFixed(0)}d`;
}
function ago(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function toSnapshot(m: NormalizedMarket): MarketSnapshot {
  return {
    venue: m.venue, midpoint: m.midpoint, maxSpread: m.maxSpread, minSize: m.minSize,
    dailyPool: m.dailyPool, qualifyingLiquidity: m.qualifyingLiquidity,
    bookDepthAtBand: m.bookDepthAtBand, volatilityStdev: m.volatilityStdev,
    twoSidedRequired: m.twoSidedRequired,
    sides: m.sides ?? null,   // per-side (YES/NO) books drive per-side estimates
  };
}

const emptyBook = (note: string | null = null): NormBook =>
  ({ bids: [], asks: [], lastTrade: null, hasBook: false, note, asksComplement: false });

// ── Book normalization — BOTH sides, executable prices only ───────────────────
// Polymarket: the /book route returns { yes:{bids,asks}, no:{bids,asks} } — two REAL
//   independent CLOB token books (real bids AND asks each), in 0..1 already.
// Kalshi: /orderbook returns bids only for both sides (yes_dollars, no_dollars). Each
//   side's ASK ladder is the contract complement of the OTHER side's bids: a NO bid at
//   $p is an offer to SELL YES at $(1−p), and vice-versa. That is the real Kalshi
//   contract identity — we transform real levels, never synthesize one — and we flag it
//   asksComplement:true so the UI labels those asks as complement-derived.
function normalizeBooks(venue: Venue, raw: any): DualBook {
  if (!raw) return { yes: emptyBook(), no: emptyBook() };

  if (venue === 'polymarket') {
    const one = (tok: any): NormBook => {
      if (!tok) return emptyBook(raw.error ?? null);
      const bids = (tok.bids ?? []).map((r: any) => ({ price: parseFloat(r.price), size: parseFloat(r.size) }))
        .filter((r: BookRow) => r.price > 0 && r.size > 0).sort((a: BookRow, b: BookRow) => b.price - a.price);
      const asks = (tok.asks ?? []).map((r: any) => ({ price: parseFloat(r.price), size: parseFloat(r.size) }))
        .filter((r: BookRow) => r.price > 0 && r.size > 0).sort((a: BookRow, b: BookRow) => a.price - b.price);
      const lastTrade = tok.last_trade_price != null ? parseFloat(tok.last_trade_price) : null;
      return { bids, asks, lastTrade, hasBook: bids.length > 0 || asks.length > 0, note: null, asksComplement: false };
    };
    return { yes: one(raw.yes), no: one(raw.no) };
  }

  // Kalshi — resolve the two real bid stacks (dollars 0..1), then build each side.
  const fp = raw.orderbook_fp;
  const ob = raw.orderbook;
  let yesRaw: any[], noRaw: any[], scale: number;
  if (fp && (Array.isArray(fp.yes_dollars) || Array.isArray(fp.no_dollars))) {
    yesRaw = fp.yes_dollars ?? []; noRaw = fp.no_dollars ?? []; scale = 1;      // already dollars 0..1
  } else if (ob && (Array.isArray(ob.yes) || Array.isArray(ob.no))) {
    yesRaw = ob.yes ?? []; noRaw = ob.no ?? []; scale = 1 / 100;                // cents → dollars
  } else {
    return { yes: emptyBook(raw.error ?? null), no: emptyBook(raw.error ?? null) };
  }
  const bidsOf = (rawLevels: any[]): BookRow[] => rawLevels
    .map((r: any[]) => ({ price: Number(r[0]) * scale, size: Number(r[1]) }))
    .filter((r: BookRow) => r.price > 0 && r.price < 1 && r.size > 0).sort((a, b) => b.price - a.price);
  // asks for a side = complement of the OTHER side's bids
  const asksFrom = (rawLevels: any[]): BookRow[] => rawLevels
    .map((r: any[]) => ({ price: 1 - Number(r[0]) * scale, size: Number(r[1]) }))
    .filter((r: BookRow) => r.price > 0 && r.price < 1 && r.size > 0).sort((a, b) => a.price - b.price);

  const yesBids = bidsOf(yesRaw), yesAsks = asksFrom(noRaw);   // YES asks ← NO bids complement
  const noBids  = bidsOf(noRaw),  noAsks  = asksFrom(yesRaw);  // NO asks  ← YES bids complement
  return {
    yes: { bids: yesBids, asks: yesAsks, lastTrade: null, hasBook: yesBids.length > 0 || yesAsks.length > 0, note: null, asksComplement: true },
    no:  { bids: noBids,  asks: noAsks,  lastTrade: null, hasBook: noBids.length  > 0 || noAsks.length  > 0, note: null, asksComplement: true },
  };
}

const midOf = (b: NormBook | null | undefined): number | null =>
  b && b.bids[0] && b.asks[0] ? (b.bids[0].price + b.asks[0].price) / 2 : null;
const spreadOf = (b: NormBook | null | undefined): number | null =>
  b && b.bids[0] && b.asks[0] ? b.asks[0].price - b.bids[0].price : null;
const depthOf = (b: NormBook | null | undefined): number =>
  b ? [...b.bids, ...b.asks].reduce((s, r) => s + r.price * r.size, 0) : 0;

// ── Persist placement config (auth to write; no login wall on view) ───────────
interface PlacementConfig {
  side: SideMode; qtyPerSide: number; distanceC: number;
  onFillYes: OnFill; onFillNo: OnFill; newsMode: NewsMode;
}
const LS_KEY = (id: string) => `rewards-placement:${id}`;

// A manually-tapped leg: the real executable book price the user placed on.
type LegState = { price: number } | null;
type LegKind = 'buy' | 'sell';

// The market's REAL venue page URL — the same honest, null-safe builders the header
// uses (never a fabricated slug). Neither Polymarket nor Kalshi accepts a price/side/size
// prefill in the URL, so this is the market page only; the caller states the exact
// side+price+size to enter by hand. Returns null when no real page is constructible.
function venueMarketUrl(m: { venue: Venue; slug?: string | null; marketSlug?: string | null; negRisk?: boolean; marketId: string }): string | null {
  if (m.venue === 'polymarket') {
    return (m.negRisk && m.marketSlug ? polymarketOutcomeUrl(m.slug, m.marketSlug) : null) ?? polymarketMarketUrl(m.slug);
  }
  if (m.venue === 'kalshi') return kalshiMarketUrl(m.marketId);
  return null;
}

// Honest-engine: a market whose resolution time is in the PAST is settled — it can never pay
// active LP rewards, so it must not be offered as a live ticket. Read the REAL feed field only;
// a missing (null) hoursToResolution is NOT treated as resolved (we never fabricate a time).
const isResolvedMarket = (m: { hoursToResolution: number | null } | null | undefined): boolean =>
  !!m && typeof m.hoursToResolution === 'number' && Number.isFinite(m.hoursToResolution) && m.hoursToResolution <= 0;

// ── Page ──────────────────────────────────────────────────────────────────────
export default function MarketDetailPage() {
  const params = useParams();
  const marketId = decodeURIComponent(params.marketId as string);

  const [mkt, setMkt]           = useState<NormalizedMarket | null>(null);
  const [mktErr, setMktErr]     = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);
  // Server-evaluated tier, straight from the /api/rewards-unified payload (lib/paid-gating).
  // Drives the whole cockpit/book lock: paid → full numbers, free/anon → calm unlock state.
  const [isPaid, setIsPaid]     = useState(false);

  // live book (both sides)
  const [books, setBooks]       = useState<DualBook | null>(null);
  const [bookAge, setBookAge]   = useState<Date | null>(null);
  // Server-stamped book fetch time (accounts for the route's 2s cache) — the true snapshot age
  // used by the staleness guard, more accurate than client receipt time.
  const [bookFetchedAt, setBookFetchedAt] = useState<number | null>(null);
  const [nowMs, setNowMs]       = useState<number>(() => Date.now());
  const [bookErr, setBookErr]   = useState<string | null>(null);
  // Real per-market min price increment (fraction, e.g. 0.01 = 1¢). Polymarket returns it
  // on the /book payload; Kalshi trades in whole cents (1¢). Order controls clamp to this so
  // we never offer — or silently drop a click on — a price the book can't accept.
  const [tickSize, setTickSize] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  // controls
  const [tradeSide, setTradeSide] = useState<SideKey>('yes');   // which outcome token to make
  const [side, setSide]         = useState<SideMode>('both');
  // Default size aligns with the list's "typical net" preset: the list estimates at
  // capital = $1000 TOTAL two-sided (DEFAULT_CAPITAL). Here qty is PER SIDE and
  // capital = qty × sides, so $500/side × 2 = $1000 total — same basis as the list.
  const [qty, setQty]           = useState<number>(500);
  const [dist, setDist]         = useState<number>(1.75);   // pre-load placeholder; set from maxSpread on load

  // ── tap-to-place: two INDEPENDENT legs (buy + sell coexist, never overwrite) ──
  // A leg is null until the user taps a real book level. A non-null leg is a MANUAL
  // placement that detaches from the distance slider (Phase 3). Per-leg USD qty is
  // independent. Tapping a level BELOW mid sets buy; ABOVE mid sets sell.
  const [legs, setLegs]     = useState<{ buy: LegState; sell: LegState }>({ buy: null, sell: null });
  const [legQty, setLegQty] = useState<{ buy: number; sell: number }>({ buy: 500, sell: 500 });
  const [onFillYes, setOnFillYes] = useState<OnFill>('requote');
  const [onFillNo,  setOnFillNo]  = useState<OnFill>('requote');
  const [newsMode, setNewsMode] = useState<NewsMode>('withdraw');

  // persistence
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'local' | 'error'>('idle');
  const [saveMsg, setSaveMsg]     = useState<string>('');

  // ── load market snapshot ──
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/rewards-unified', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const m = (d.markets as NormalizedMarket[]).find(x => x.marketId === marketId);
        if (!alive) return;
        if (!m) { setMktErr('Market not found in the current snapshot.'); setLoading(false); return; }
        setIsPaid(!!d.isPaid);
        setMkt(m);
        // Match the list's typicalNet distance preset exactly: (maxSpread ?? 2) / 2
        // (the list uses `?? 2`, not `?? 4`) so a null-maxSpread market — e.g. Kalshi —
        // defaults to the same 1¢ band the list priced, not a different 2¢.
        setDist(Number((((m.maxSpread ?? 2) / 2)).toFixed(2)));
        setLoading(false);
      } catch (e: any) { if (alive) { setMktErr(e?.message ?? 'load error'); setLoading(false); } }
    })();
    return () => { alive = false; };
  }, [marketId]);

  // ── prefill saved config (localStorage first for instant paint; then API) ──
  useEffect(() => {
    try {
      const cached = localStorage.getItem(LS_KEY(marketId));
      if (cached) {
        const c = JSON.parse(cached) as PlacementConfig;
        applyConfig(c);
      }
    } catch { /* ignore */ }
    (async () => {
      try {
        const r = await fetch(`/api/rewards/placement?marketId=${encodeURIComponent(marketId)}`, { cache: 'no-store' });
        if (!r.ok) return; // 401 (not logged in) is fine — view has no login wall
        const d = await r.json();
        if (d?.placement) applyConfig(d.placement);
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketId]);

  function applyConfig(c: Partial<PlacementConfig> & { onFill?: unknown }) {
    if (c.side) setSide(c.side);
    if (typeof c.qtyPerSide === 'number') setQty(c.qtyPerSide);
    if (typeof c.distanceC === 'number') setDist(c.distanceC);
    // Per-side rules first; fall back to the legacy single `onFill` (maps to both).
    const legacy = legacyToRule(c.onFill);
    const y = legacyToRule(c.onFillYes) ?? legacy;
    const n = legacyToRule(c.onFillNo)  ?? legacy;
    if (y) setOnFillYes(y);
    if (n) setOnFillNo(n);
    if (c.newsMode) setNewsMode(c.newsMode);
  }

  // ── live book fetch ──
  const fetchBook = useCallback(async () => {
    if (!mkt) return;
    try {
      const url = mkt.venue === 'polymarket'
        ? `/api/liquidity-rewards/book?conditionId=${encodeURIComponent(mkt.marketId)}`
        : `/api/kalshi-rewards/book?ticker=${encodeURIComponent(mkt.marketId)}`;
      const r = await fetch(url, { cache: 'no-store' });
      const d = await r.json();
      const nb = normalizeBooks(mkt.venue, d);
      setBooks(nb);
      // Real min tick: Polymarket serves it on the book payload; Kalshi is universally 1¢.
      if (mkt.venue === 'polymarket') {
        setTickSize(typeof d?.tickSize === 'number' && d.tickSize > 0 ? d.tickSize : null);
      } else {
        setTickSize(0.01);
      }
      setBookErr(nb.yes.hasBook || nb.no.hasBook ? null : (d?.error ?? null));
      setBookAge(new Date());
      // Prefer the server's fetchedAt (true snapshot time) for the staleness guard; fall back to
      // client receipt time. Only advance freshness when the book actually has data.
      const serverTs = typeof d?.fetchedAt === 'string' ? Date.parse(d.fetchedAt) : NaN;
      if (nb.yes.hasBook || nb.no.hasBook) setBookFetchedAt(Number.isFinite(serverTs) ? serverTs : Date.now());
    } catch (e: any) { setBookErr(e?.message ?? 'book error'); }
  }, [mkt]);

  useEffect(() => {
    if (!mkt) return;
    fetchBook();
    // ~4s live poll (task spec). The route adds a short server cache so this never hammers a venue.
    pollRef.current = setInterval(fetchBook, 4_000);
    return () => clearInterval(pollRef.current);
  }, [mkt, fetchBook]);

  // Tick a clock so the staleness guard re-evaluates even if polling stalls (tab hidden / error).
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 2_000);
    return () => clearInterval(t);
  }, []);

  // Once the real tick is known, snap the distance onto its grid (and never below one tick)
  // so the slider readout matches the placeable price. Fires only when tickSize changes —
  // repeat polls set the same value, so a user's later slider drag is never overridden.
  useEffect(() => {
    if (!tickSize) return;
    const tc = tickSize * 100;
    setDist(prev => Number(Math.max(tc, Math.round(prev / tc) * tc).toFixed(2)));
  }, [tickSize]);

  // ── derived: per-side live mids, chosen side, estimate ──
  const yesBook = books?.yes ?? null;
  const noBook  = books?.no  ?? null;
  const chosenBook = tradeSide === 'yes' ? yesBook : noBook;

  // per-side executable live mids, with the snapshot's per-side mid as fallback
  const snapYesMid = mkt?.sides?.yes?.midpoint ?? mkt?.midpoint ?? null;
  const snapNoMid  = mkt?.sides?.no?.midpoint ?? (mkt?.midpoint != null ? 1 - mkt.midpoint : null);
  const yesMid = midOf(yesBook) ?? snapYesMid;
  const noMid  = midOf(noBook)  ?? snapNoMid;
  const mid = tradeSide === 'yes' ? yesMid : noMid;

  const twoSided = side === 'both';
  const sidesN = twoSided ? 2 : 1;
  const capital = qty * sidesN;   // qty is per-side; estimator capital is total working USD
  const distMax = mkt?.maxSpread ?? 10;

  // estimate recomputes for the CHOSEN trading side (its own real book)
  const est = useMemo(() => {
    if (!mkt) return null;
    return estimateReward({ venue: mkt.venue, capital, twoSided, distanceCents: dist, market: toSnapshot(mkt), side: tradeSide });
  }, [mkt, capital, twoSided, dist, tradeSide]);

  // Snap any price to the market's REAL min tick and keep it inside the placeable band
  // [tick, 1−tick]. Without a known tick we fall back to the old 0.001 floor/ceiling.
  // This guarantees every planned/placed price is one the book genuinely accepts.
  const snapPrice = useCallback((p: number): number => {
    if (tickSize && tickSize > 0) {
      const snapped = Math.round(p / tickSize) * tickSize;
      // avoid binary float dust (e.g. 0.30000000000000004) so it matches a real grid level
      const clean = Math.round(snapped / tickSize) * tickSize;
      return Math.min(1 - tickSize, Math.max(tickSize, Number(clean.toFixed(6))));
    }
    return Math.min(0.999, Math.max(0.001, p));
  }, [tickSize]);

  // Slider-derived planned prices in the CHOSEN side's book (mid ± distance), snapped to the
  // real tick. These are the DEFAULT quotes; a manually-tapped leg overrides its side.
  const sliderBid = mid != null && (side === 'both' || side === 'buy')  ? snapPrice(mid - dist / 100) : null;
  const sliderAsk = mid != null && (side === 'both' || side === 'sell') ? snapPrice(mid + dist / 100) : null;
  // Honest feedback: if the requested (pre-snap) price sat outside the placeable band, say so
  // instead of silently moving it — never fabricate a fill at a price the book can't take.
  const clampNote = (() => {
    if (!tickSize) return null;
    const rawBid = mid != null ? mid - dist / 100 : null;
    const rawAsk = mid != null ? mid + dist / 100 : null;
    if ((side === 'both' || side === 'buy')  && rawBid != null && rawBid < tickSize)
      return `Your buy would fall below this market's ${fmtC(tickSize)} min tick — snapped up to ${fmtC(tickSize)}.`;
    if ((side === 'both' || side === 'sell') && rawAsk != null && rawAsk > 1 - tickSize)
      return `Your sell would exceed the ${fmtC(1 - tickSize)} max price — snapped down to ${fmtC(1 - tickSize)}.`;
    return null;
  })();
  // Effective quote per side: the tapped price when a leg is manually placed, else the slider.
  const userBid = legs.buy  ? legs.buy.price  : sliderBid;
  const userAsk = legs.sell ? legs.sell.price : sliderAsk;
  // Real venue page for this market (null when not constructible). A tapped/placed leg is an
  // in-app plan only (live execution OFF), so this is the honest bridge to actually placing it.
  const venueUrl = mkt ? venueMarketUrl(mkt) : null;

  // ── TWO-SIDED REWARD SCORE (primary detail metric; agrees with the list SSOT) ──────────────
  // competitorDepthUsd is the SAME both-sides depth the list dilutes against — poly: near + far;
  // kalshi: bookDepthAtBand (already both sides). Feeding it here is what makes the ticket == list.
  const competitorDepthUsd = useMemo<number | null>(() => {
    if (!mkt) return null;
    const near = mkt.bookDepthAtBand;
    if (typeof near !== 'number' || !Number.isFinite(near)) return null;
    return mkt.venue === 'polymarket' ? near + (mkt.sides?.no?.bookDepthAtBand ?? 0) : near;
  }, [mkt]);

  const buyActive  = side === 'both' || side === 'buy';    // a bid leg (one reward direction)
  const sellActive = side === 'both' || side === 'sell';   // an ask leg (the other direction)
  const buySize    = legs.buy  ? legQty.buy  : qty;
  const sellSize   = legs.sell ? legQty.sell : qty;

  // Score the exact placed orders. bid ⇒ one reward-side, ask ⇒ the other; two-sided = both present.
  const scoreEst = useMemo(() => {
    if (!mkt || mid == null) return null;
    const bidLegs:  LevelAlloc[] = buyActive  && userBid != null ? [{ priceCents: userBid  * 100, sizeUsd: buySize  }] : [];
    const askLegs:  LevelAlloc[] = sellActive && userAsk != null ? [{ priceCents: userAsk * 100, sizeUsd: sellSize }] : [];
    return computeRewardScore({
      venue: mkt.venue, midCents: mid * 100, maxSpreadC: mkt.maxSpread ?? 50,
      pool: mkt.dailyPool, competitorDepthUsd, yes: bidLegs, no: askLegs,
    });
  }, [mkt, mid, buyActive, sellActive, userBid, userAsk, buySize, sellSize, competitorDepthUsd]);

  // Staleness guard — snapshot age from the server fetchedAt. Older than STALE_BOOK_MS ⇒ the
  // estimate is NOT actionable and must not read as a fresh number on stale data.
  const bookAgeMs = bookFetchedAt != null ? nowMs - bookFetchedAt : null;
  const bookStale = bookAgeMs == null || bookAgeMs > STALE_BOOK_MS;

  // ExecutionPlan — the EXACT structured object real execution would consume later. Emitted here
  // for the (disabled) arm button; SIMULATION ONLY, no order path is reachable. Ask ⇒ complement
  // bid (Polymarket/Kalshi identity: a YES ask == a NO bid), so every leg is a bid on its token.
  const execPlan = useMemo<ExecutionPlan | null>(() => {
    if (!mkt || mid == null) return null;
    const other = tradeSide === 'yes' ? 'no' : 'yes';
    const legsOut: ExecutionPlan['legs'] = [];
    if (buyActive  && userBid != null) legsOut.push({ side: tradeSide, priceCents: Math.round(userBid * 100), sizeUsd: buySize });
    if (sellActive && userAsk != null) legsOut.push({ side: other,     priceCents: Math.round((1 - userAsk) * 100), sizeUsd: sellSize });
    if (!legsOut.length) return null;
    return { venue: mkt.venue, marketId: mkt.marketId, legs: legsOut, distanceFromMid: dist, createdAtIso: new Date().toISOString() };
  }, [mkt, mid, tradeSide, buyActive, sellActive, userBid, userAsk, buySize, sellSize, dist]);

  // Sim result is lifted here (out of the old ScoreTicket) so the reward hero at the TOP of the
  // cockpit and the "Run simulation" action at the BOTTOM of the cockpit can be two separate cards
  // yet share one simulation message. SIMULATION ONLY — activeAdapter places no order.
  const [simMsg, setSimMsg] = useState<string | null>(null);
  const runSim = useCallback(async () => {
    if (!execPlan) { setSimMsg('No in-band legs to simulate.'); return; }
    const r = await activeAdapter.submit(execPlan);   // SimulationAdapter — places no order
    setSimMsg(r.message);
  }, [execPlan]);

  // ── tap-to-place handlers ──
  // A tapped BELOW-mid level sets the buy leg; ABOVE-mid sets the sell leg. The two never
  // overwrite each other. Seed a freshly-placed leg's qty from the current Size-per-side.
  const placeLeg = useCallback((kind: LegKind, price: number) => {
    setLegs(prev => (prev[kind]?.price === price ? prev : { ...prev, [kind]: { price } }));
    setLegQty(prev => (legs[kind] ? prev : { ...prev, [kind]: qty }));
  }, [legs, qty]);
  const removeLeg = useCallback((kind: LegKind) => setLegs(prev => ({ ...prev, [kind]: null })), []);
  // Side gate: switching to a single side clears the disallowed leg (buy/sell can't coexist there).
  const changeSide = useCallback((v: SideMode) => {
    setSide(v);
    if (v === 'buy')  setLegs(prev => ({ ...prev, sell: null }));
    if (v === 'sell') setLegs(prev => ({ ...prev, buy: null }));
  }, []);

  // free-tier detection — tier-driven, straight from the server-evaluated isPaid on the
  // /api/rewards-unified payload. (The old "midpoint==null && dailyPool==null" heuristic no
  // longer works: dailyPool is now a PUBLIC teaser, so it's non-null even for free.) A paid
  // user is never behind the paywall → isRedacted false; a genuinely non-priceable market for
  // a paid user degrades honestly via the resolved / side-unavailable / "—" paths, not "unlock".
  const isRedacted = !isPaid;

  // ── save placement ──
  async function savePlacement() {
    if (!mkt) return;
    // Single-sided placements carry one rule → mirror it onto both fields so the
    // persisted config is coherent (and legacy single-field compat holds).
    const yesRule = side === 'both' ? onFillYes : (tradeSide === 'yes' ? onFillYes : onFillNo);
    const noRule  = side === 'both' ? onFillNo  : (tradeSide === 'yes' ? onFillYes : onFillNo);
    const cfg: PlacementConfig = { side, qtyPerSide: qty, distanceC: dist, onFillYes: yesRule, onFillNo: noRule, newsMode };
    try { localStorage.setItem(LS_KEY(marketId), JSON.stringify(cfg)); } catch { /* ignore */ }
    setSaveState('saving'); setSaveMsg('');
    try {
      const r = await fetch('/api/rewards/placement', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId, venue: mkt.venue, ...cfg, mode: 'paper' }),
      });
      if (r.status === 401) { setSaveState('local'); setSaveMsg('Saved on this device only — sign in to sync and enable the news-guard.'); return; }
      if (!r.ok) { const e = await r.json().catch(() => ({})); setSaveState('error'); setSaveMsg(e?.error ?? `HTTP ${r.status}`); return; }
      setSaveState('saved'); setSaveMsg('Paper config saved. Advisory only — no real order (live execution OFF).');
    } catch (e: any) { setSaveState('error'); setSaveMsg(e?.message ?? 'save error'); }
  }

  const risk = (mkt?.newsRisk ?? 'unknown') as NewsRisk;
  // Settled market opened directly → render a calm "resolved" state, never a live ticket.
  const resolved = isResolvedMarket(mkt);

  // ── render ──
  if (mktErr) {
    return (
      <div className="min-h-screen bg-bg text-ink p-6 font-body">
        <Link href="/dashboard/liquidity-rewards" className="inline-flex items-center gap-1 text-muted hover:text-ink-2 text-sm">
          <ChevronLeft size={16} /> Liquidity Rewards
        </Link>
        <p className="mt-6 text-coral-ink text-sm">{mktErr}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'radial-gradient(circle at 50% -10%, rgba(15,190,130,.05), transparent 60%), #F5F8F6' }}>
      {/* ── A) Sticky header — FULLY OPAQUE so scrolled content never bleeds through it.
             Solid surface (this is a light page — surface is #FFFFFF, the honest equivalent of a
             solid dark bar), a bottom border, a shadow for separation, and z-30 above all content. ── */}
      <div className="sticky top-0 z-30 bg-surface border-b border-line shadow-card">
        <div className="max-w-3xl mx-auto px-4 py-2.5">
          <Link href="/dashboard/liquidity-rewards" className="inline-flex items-center gap-1 font-body text-[12px] text-muted hover:text-ink-2">
            <ChevronLeft size={15} /> Rewards
          </Link>
          {mkt ? (
            <>
              <div className="flex items-start gap-2 mt-1.5">
                <PlatformLogo platform={mkt.venue} size={18} className="mt-0.5" />
                {/* Compact: clamp a long title to 2 lines so the mini-header stays small; the full
                    title is still reachable (native tooltip + the venue deep-link beside it). */}
                <h1 title={mkt.title} className="font-display font-bold text-ink text-[15px] sm:text-lg leading-snug flex-1 min-w-0 line-clamp-2">{mkt.title}</h1>
                {(() => {
                  // Multi-outcome (negRisk) events → deep-link the exact outcome via the real
                  // two-segment …/event/<eventSlug>/<marketSlug>; fall back to the plain event
                  // link when that isn't constructible. Single-outcome markets are unchanged.
                  const u = venueMarketUrl(mkt);
                  return u ? <PlatformLink href={u} label={mkt.venue === 'polymarket' ? 'Polymarket' : 'Kalshi'} className="mt-0.5 shrink-0" /> : null;
                })()}
              </div>
              <p className="font-body text-[11px] text-muted mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                <span className="capitalize">{mkt.venue}</span>·<span>{mkt.category}</span>·
                <span>mid <Redacted value={mid}>{v => fmtC(v)}</Redacted></span>·
                {/* pool $/day is a PUBLIC teaser (owner freemium split) — isPaid forced so it's the
                    real number for every tier, and a null pool reads "—" rather than a paywall lock. */}
                <span>pool <Redacted value={mkt.dailyPool} isPaid>{v => `${fmtUsd(v)}/day`}</Redacted></span>·
                {isResolvedMarket(mkt)
                  ? <span className="text-coral-ink font-semibold">resolved</span>
                  : <span>resolves {fmtHours(mkt.hoursToResolution)}</span>}
              </p>
            </>
          ) : (
            <div className="h-10 mt-2 bg-bg-soft/50 rounded animate-pulse w-2/3" />
          )}
        </div>
      </div>

      {/* Sections carry scroll-mt so an in-page jump (or the browser restoring scroll) never
          parks a heading UNDER the opaque sticky header. */}
      <div className="max-w-3xl mx-auto px-4 py-5 space-y-5 [&>section]:scroll-mt-24">
        {loading && !mkt && <p className="font-body text-sm text-muted">Loading market…</p>}

        {/* ── Resolved market → calm, honest state; no live ticket, no fabricated ROI ── */}
        {mkt && resolved && (
          <ResolvedNotice title={mkt.groupItemTitle || mkt.title} venue={mkt.venue}
            venueUrl={venueMarketUrl(mkt)} hoursPast={mkt.hoursToResolution} />
        )}

        {mkt && !resolved && (
          <>
            {/* ══════════════════════════════════════════════════════════════════════════
                ZONE A — COCKPIT. Reward hero → which side → side/size/distance → run sim.
                Tight spacing so the whole payoff + its controls fit ~one mobile viewport
                before the order book begins. (Pure layout/IA — no reward math touched.)
                ══════════════════════════════════════════════════════════════════════════ */}
            <div className="space-y-1.5 scroll-mt-28">
              {/* ── (2) REWARD hero — big gross $/day FIRST, share + min-side + disclaimer ── */}
              <RewardHero score={scoreEst} pool={mkt.dailyPool} isRedacted={isRedacted}
                stale={bookStale} bookAgeMs={bookAgeMs} />

              {/* ── (3) Which side to make — 2-up segmented, each with its live mid ── */}
              <TradeSideToggle
                tradeSide={tradeSide} setTradeSide={setTradeSide}
                yesMid={yesMid} noMid={noMid} isRedacted={isRedacted}
                yesHasBook={yesBook?.hasBook ?? (mkt.sides?.yes?.hasBook !== false)}
                noHasBook={noBook?.hasBook ?? (mkt.sides?.no?.hasBook !== false)}
              />

              {/* ── (4)(5)(6) Side mode · size per side · distance — compact control stack ── */}
              <div className="rounded-card shadow-card bg-surface px-2.5 py-2 space-y-1.5">
                {/* (4) side mode — 3-up segmented */}
                <div>
                  <span className="font-body text-[10px] uppercase tracking-wide text-muted">Side</span>
                  <div className="grid grid-cols-3 gap-1.5 mt-0.5">
                    {([['both', 'Both'], ['buy', 'Buy only'], ['sell', 'Sell only']] as [SideMode, string][]).map(([v, label]) => (
                      <button key={v} onClick={() => changeSide(v)}
                        className={`min-w-0 font-body font-medium text-[12px] py-1.5 rounded-button border transition-colors
                          ${side === v ? 'border-mint-deep/45 bg-mint-tint text-mint-deep' : 'border-line bg-surface text-muted hover:text-ink-2'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {est?.twoSidedRequired && side !== 'both' && (
                    <p className="font-body text-[11px] text-coral-ink mt-1">
                      At this price the {tradeSide.toUpperCase()} side requires both bid and ask — a single side earns no rewards here.
                    </p>
                  )}
                </div>

                {/* (5) size per side — presets + input, total hint on the label row */}
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-body text-[10px] uppercase tracking-wide text-muted">Size per side</span>
                    <span className="font-body text-[10px] text-muted tabular-nums whitespace-nowrap">total {fmtUsd(capital)} on {sidesN} side{sidesN === 1 ? '' : 's'}</span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    {[100, 500, 1000, 5000].map(c => (
                      <button key={c} onClick={() => setQty(c)}
                        className={`font-body font-medium text-[12px] px-3 py-1 rounded-button border transition-colors tabular-nums
                          ${qty === c ? 'border-mint-deep/45 bg-mint-tint text-mint-deep' : 'border-line bg-surface text-muted hover:text-ink-2'}`}>
                        ${c >= 1000 ? `${c / 1000}k` : c}
                      </button>
                    ))}
                    <input type="number" min={1} value={qty} onChange={e => setQty(Math.max(1, Number(e.target.value) || 0))}
                      className="w-20 font-body text-[12px] text-ink-2 bg-bg-soft border border-line rounded-button px-2 py-1 tabular-nums" />
                  </div>
                </div>

                {/* (6) distance from spread — band value on the label row; verbose notes are
                    single lines / expand-on-tap so the control stack stays short. */}
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-body text-[10px] uppercase tracking-wide text-muted">Distance from spread</span>
                    <span className="font-body text-[12px] text-ink-2 tabular-nums whitespace-nowrap">{dist.toFixed(2)}¢{mkt.maxSpread != null ? ` / ${mkt.maxSpread}¢ band` : ''}</span>
                  </div>
                  <input type="range" min={tickSize ? tickSize * 100 : 0.1} max={distMax} step={tickSize ? tickSize * 100 : 0.1} value={dist}
                    onChange={e => setDist(Number(e.target.value))} className="w-full accent-mint-deep mt-1" />
                  <div className="flex items-center justify-between font-body text-[10px] text-muted mt-0.5">
                    <span>closer = more reward, more fills</span>
                    <span>farther = safer</span>
                  </div>
                  {tickSize && (
                    <p className="font-body text-[10px] text-muted mt-0.5 truncate">
                      Min tick {fmtC(tickSize)} — snaps to grid ({mkt.venue === 'polymarket' ? 'Polymarket' : 'Kalshi'} won&apos;t accept a finer price).
                    </p>
                  )}
                  {clampNote && <p className="font-body text-[10px] text-coral-ink mt-0.5">{clampNote}</p>}
                  {mkt.maxSpread == null && (
                    <p className="font-body text-[10px] text-muted mt-0.5 truncate">Kalshi doesn&apos;t publish a reward band — distance here only affects fill risk.</p>
                  )}
                  {(legs.buy || legs.sell) && (
                    <details className="mt-0.5">
                      <summary className="list-none cursor-pointer font-body text-[10px] text-gold flex items-center gap-1">
                        <span className="whitespace-nowrap">Manual placement active for {[legs.buy && 'BUY', legs.sell && 'SELL'].filter(Boolean).join(' + ')}</span>
                        <button onClick={(e) => { e.preventDefault(); if (legs.buy) removeLeg('buy'); if (legs.sell) removeLeg('sell'); }}
                          className="underline underline-offset-2 hover:text-ink-2 shrink-0">reset</button>
                      </summary>
                      <p className="font-body text-[10px] text-gold leading-snug mt-0.5">
                        {legs.buy && legs.sell ? 'Those sides are' : 'That side is'} detached from this slider — the tapped book price is used instead. Reset to return to the slider quote.
                      </p>
                    </details>
                  )}
                </div>
              </div>

              {/* ── (7) Run simulation (primary) + (disabled) Arm execution — bottom of cockpit ── */}
              <SimActions plan={execPlan} stale={bookStale} onRun={runSim} simMsg={simMsg} />
            </div>

            {/* ══════════════════════════════════════════════════════════════════════════
                ZONE B — ORDER BOOK. Its own section below the cockpit: the windowed YES/NO
                ladder (≈5 levels/side around the mid) with tap-to-place and a "show full
                depth" toggle. HONEST-ENGINE: only real book levels, never a fabricated one.
                ══════════════════════════════════════════════════════════════════════════ */}
            <div className="space-y-4 pt-1">
              {/* ── (c) Live DUAL order book (YES | NO), windowed, with tap-to-place ── */}
              <DualOrderBook
                yesBook={yesBook} noBook={noBook} tradeSide={tradeSide}
                bookAge={bookAge} bookErr={bookErr} isRedacted={isRedacted}
                yesMid={yesMid} noMid={noMid} maxSpread={mkt.maxSpread}
                userBid={userBid} userAsk={userAsk} onRefresh={fetchBook} venue={mkt.venue}
                side={side} onTap={placeLeg} venueUrl={venueUrl}
                buyManual={legs.buy != null} sellManual={legs.sell != null}
              />

              {/* Order tickets: one per active (tapped) leg — sits with the book it came from */}
              <LegTickets
                legs={legs} legQty={legQty} setLegQty={setLegQty} removeLeg={removeLeg}
                tradeSide={tradeSide} mid={mid} maxSpread={mkt.maxSpread}
                venue={mkt.venue} snapshot={toSnapshot(mkt)} isRedacted={isRedacted}
                venueUrl={venueUrl}
              />

              {/* ── (f) Net earnings (Pro) + sanity note ── */}
              <EarningsBlock est={est} isRedacted={isRedacted} flags={mkt.flags} tradeSide={tradeSide} />

            {/* ── E) Fill-handling choice — per-side when quoting both ── */}
            <div className="rounded-card shadow-card bg-surface px-4 py-4 space-y-4">
              {twoSided ? (
                <>
                  <p className="font-body font-medium text-sm text-ink-2">If one side gets filled</p>
                  <FillRuleCard side="yes" value={onFillYes} onChange={setOnFillYes} />
                  <FillRuleCard side="no"  value={onFillNo}  onChange={setOnFillNo} />
                  <p className="font-body text-[11px] text-muted leading-relaxed">
                    <span className="text-ink-2 font-medium">Chosen:</span>{' '}
                    {fillSummary('yes', onFillYes)} · {fillSummary('no', onFillNo)}.
                    {' '}On adverse news the news-guard can still force a close (see below). Advisory only — live execution OFF.
                  </p>
                </>
              ) : (
                <>
                  <p className="font-body font-medium text-sm text-ink-2">If your order gets filled</p>
                  <FillRuleCard
                    side={tradeSide}
                    value={tradeSide === 'yes' ? onFillYes : onFillNo}
                    onChange={tradeSide === 'yes' ? setOnFillYes : setOnFillNo}
                  />
                  <p className="font-body text-[11px] text-muted leading-relaxed">
                    <span className="text-ink-2 font-medium">Chosen:</span>{' '}
                    {fillSummary(tradeSide, tradeSide === 'yes' ? onFillYes : onFillNo)}.
                    {' '}On adverse news the news-guard can still force a close (see below). Advisory only — live execution OFF.
                  </p>
                </>
              )}
            </div>

            {/* ── F) News-guard choice ── */}
            <div className="rounded-card shadow-card bg-surface px-4 py-4 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="font-body font-medium text-sm text-ink-2">News-guard</p>
                <NewsRiskPill risk={risk} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <ChoiceBtn active={newsMode === 'withdraw'} onClick={() => setNewsMode('withdraw')}
                  title="🛡 Withdraw liquidity" desc="On adverse news, automatically pull your orders; if already filled, exit at the best price." />
                <ChoiceBtn active={newsMode === 'alert'} onClick={() => setNewsMode('alert')}
                  title="🔔 Alert only" desc="Telegram + on-page alert, no automatic action: you decide." />
                <ChoiceBtn active={newsMode === 'off'} onClick={() => setNewsMode('off')}
                  title="⊘ Off" desc="No news monitoring on this market." />
              </div>
              <p className="font-body text-[10px] text-muted leading-snug">
                {newsMode === 'withdraw'
                  ? 'Chosen: on a HIGH signal the news-guard advises withdrawing liquidity and, if filled, exiting at the best price (advisory — live execution OFF).'
                  : newsMode === 'alert'
                  ? 'Chosen: you only get an alert on an adverse signal, with no automatic action.'
                  : 'Chosen: no monitoring. Caution: without the guard, a resting order can fill right as the price moves against you (adverse selection).'}
              </p>
              {mkt.protect && risk === 'high' && (
                <div className="rounded-button bg-coral-tint border border-coral-ink/25 px-3 py-2">
                  <p className="font-body text-[11px] text-coral-ink leading-relaxed">
                    <span className="font-semibold">HIGH signal now.</span> {mkt.protect.detail}
                  </p>
                </div>
              )}
            </div>

            {/* ── G) CTA ── */}
            <div className="rounded-card shadow-card bg-surface px-2.5 py-2 space-y-1">
              <button onClick={savePlacement} disabled={saveState === 'saving'}
                className="w-full min-h-[44px] font-body font-semibold text-[14px] py-2 rounded-button bg-mint-deep text-white hover:bg-mint-deep/90 disabled:opacity-60 transition-colors">
                {saveState === 'saving' ? 'Saving…' : 'Simulate placement · paper'}
              </button>
              <p className="font-body text-[10px] text-center text-muted">
                Advisory only · live execution <span className="font-semibold text-ink-2">OFF</span> · no real order is sent.
              </p>
              {saveMsg && (
                <p className={`font-body text-[11px] text-center ${saveState === 'error' ? 'text-coral-ink' : saveState === 'saved' ? 'text-mint-deep' : 'text-muted'}`}>
                  {saveMsg}
                </p>
              )}
            </div>

            {/* Footer */}
            <p className="font-body text-[10px] text-muted leading-snug pt-2 border-t border-line">
              Order book from live {mkt.venue === 'polymarket' ? 'Polymarket CLOB' : 'Kalshi'} data (executable prices, never midpoint for fills).
              The gross reward ticket uses the same two-sided model as the list; the net view subtracts expected adverse-fill cost. No annualized figure.
              Read-only, no orders placed, live execution OFF, no login required to view.
            </p>
            </div>{/* /Zone B */}
          </>
        )}
      </div>
    </div>
  );
}

// ── Resolved-market notice — a settled market opened directly. Calm, honest, NO live ticket
// and NO fabricated ROI: the reward pool is over, so we say so and offer the venue link only.
function ResolvedNotice({
  title, venue, venueUrl, hoursPast,
}: { title: string; venue: Venue; venueUrl: string | null; hoursPast: number | null }) {
  const venueLabel = venue === 'polymarket' ? 'Polymarket' : venue === 'kalshi' ? 'Kalshi' : venue;
  const daysPast = typeof hoursPast === 'number' && Number.isFinite(hoursPast) ? Math.round(Math.abs(hoursPast) / 24) : null;
  return (
    <section className="rounded-card shadow-card bg-surface px-5 py-6 text-center space-y-3">
      <div className="inline-flex items-center gap-2 rounded-pill bg-coral-tint border border-coral-ink/25 px-3 py-1">
        <span className="w-2 h-2 rounded-full bg-coral-ink" />
        <span className="font-body font-semibold text-[12px] text-coral-ink uppercase tracking-wide">Market resolved</span>
      </div>
      <h2 className="font-display font-bold text-ink text-lg leading-snug max-w-xl mx-auto">{title}</h2>
      <p className="font-body text-[13px] text-ink-2 leading-relaxed max-w-md mx-auto">
        This market has already resolved{daysPast != null ? ` (about ${daysPast} day${daysPast === 1 ? '' : 's'} ago)` : ''}, so there are
        no active liquidity rewards to earn here. It&apos;s shown for reference only — no ticket, no estimate.
      </p>
      <div className="flex items-center justify-center gap-3 pt-1 flex-wrap">
        <Link href="/dashboard/liquidity-rewards"
          className="font-body font-medium text-[13px] px-4 py-2.5 rounded-button border border-line text-ink-2 hover:bg-bg-soft transition-colors">
          ← Back to active rewards
        </Link>
        {venueUrl && <PlatformLink href={venueUrl} label={`View on ${venueLabel}`} />}
      </div>
    </section>
  );
}

// ── B0) Reward hero — the cockpit's FIRST, most-prominent card ────────────────────
// PRIMARY earnings metric, computed by the SAME two-sided model as the list (lib/reward-score →
// lib/liquidity-yield). GROSS $/day only (no annualized), your share, per-side score, min-side,
// the ÷3 one-sided penalty, and a single calm gross qualifier. When the book snapshot is stale,
// the number is muted and marked not-actionable. The Run-simulation actions live in SimActions
// (the bottom of the cockpit) so they can sit AFTER the controls the user tunes.
function RewardHero({
  score, pool, isRedacted, stale, bookAgeMs,
}: {
  score: ReturnType<typeof computeRewardScore> | null;
  pool: number | null;
  isRedacted: boolean;
  stale: boolean;
  bookAgeMs: number | null;
}) {
  const daily = score?.dailyUsd ?? null;
  const showNumber = daily != null && !stale;   // never a fresh-looking number on stale data
  const ageS = bookAgeMs != null ? Math.round(bookAgeMs / 1000) : null;

  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      <div className="px-2.5 py-2">
        <div className="flex items-end justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <p className="font-body text-[10px] uppercase tracking-wide text-muted flex items-center gap-1">
              Reward · gross / day
              <InfoTip label="How this is scored" size={12}>
                Your quadratic distance-from-mid score against the in-band qualifying depth on both sides — the SAME model the list uses, so this equals the list&apos;s $/day when you place the same capital balanced at the mid. Gross of inventory/adverse-selection cost. Simulation only.
              </InfoTip>
            </p>
            <p className={`font-mono font-bold leading-none mt-0.5 tabular-nums whitespace-nowrap ${showNumber ? 'text-mint-deep' : 'text-muted'}`} style={{ fontSize: 28 }}>
              {stale
                ? '— '
                : <Redacted value={daily} isPaid={!isRedacted}>{v => `${fmtUsd(v)}/day`}</Redacted>}
              {stale && <span className="font-body text-[10px] align-middle text-gold"> STALE</span>}
            </p>
          </div>
        </div>

        {/* One wrapping muted line — share · per-side scores · min-side · the gross/sim qualifier
            (merged from the old right-hand stack + the standalone disclaimer to save height). */}
        <p className="font-body text-[10px] text-muted mt-1 leading-snug tabular-nums">
          share <span className="text-ink-2"><Redacted value={score && !isRedacted ? score.share : null} isPaid={!isRedacted}>{v => `${(v * 100).toFixed(2)}%`}</Redacted></span>
          {' · '}bid {score ? fmtUsd(score.yesScore) : '—'} · ask {score ? fmtUsd(score.noScore) : '—'}
          {' · '}min-side {score ? fmtUsd(score.minSideScore) : '—'}
          {' · '}gross, pre-cost · sim only
        </p>

        {/* ÷3 penalty / two-sided-required — compact chip, full copy expands on tap (no info lost) */}
        {score?.penaltyApplied && !stale && (
          <details className="mt-1.5">
            <summary className="list-none cursor-pointer rounded-button bg-gold-tint border border-gold/25 px-2 py-1 flex items-center gap-1.5">
              <span className="font-body text-[10px] font-semibold text-gold whitespace-nowrap">One-sided ÷3 penalty</span>
              <span className="font-body text-[9px] text-gold/70 truncate">— quote both sides to remove · tap</span>
            </summary>
            <p className="font-body text-[10px] text-gold leading-snug px-2 pt-1">
              You&apos;re quoting a single side; Polymarket credits one-sided liquidity at a third. Quote BOTH sides to remove it and maximize your share.
            </p>
          </details>
        )}
        {score?.twoSidedRequiredUnmet && !stale && (
          <details className="mt-1.5">
            <summary className="list-none cursor-pointer rounded-button bg-coral-tint border border-coral-ink/25 px-2 py-1 flex items-center gap-1.5">
              <span className="font-body text-[10px] font-semibold text-coral-ink whitespace-nowrap">Two-sided required — scores $0</span>
              <span className="font-body text-[9px] text-coral-ink/70 truncate">tap for why</span>
            </summary>
            <p className="font-body text-[10px] text-coral-ink leading-snug px-2 pt-1">
              The mid is outside 10¢–90¢, where one-sided liquidity earns nothing. This placement scores $0 until you quote both sides.
            </p>
          </details>
        )}

        {/* Staleness note */}
        {stale && (
          <p className="font-body text-[10px] text-gold mt-1.5">
            Book snapshot {ageS != null ? `${ageS}s old` : 'unavailable'} — estimate not actionable. Waiting for a fresh book…
          </p>
        )}
      </div>
    </div>
  );
}

// Run-simulation / arm-execution actions — the last card in the cockpit, below the controls.
// EXECUTION scaffold is DISABLED (EXECUTION_ENABLED is a hard false in this build); the arm
// button carries its verbatim "not enabled (simulation only)" label. simMsg is lifted to the page
// so this and the reward hero stay in sync across two cards.
function SimActions({
  plan, stale, onRun, simMsg,
}: {
  plan: ExecutionPlan | null; stale: boolean; onRun: () => void; simMsg: string | null;
}) {
  return (
    <div className="rounded-card shadow-card bg-surface px-2.5 py-2 space-y-1">
      <button onClick={onRun} disabled={!plan || stale}
        className="w-full min-h-[44px] font-body font-semibold text-[13px] py-2 rounded-button bg-mint-deep text-white hover:bg-mint-deep/90 disabled:opacity-50 transition-colors">
        Run simulation
      </button>
      {/* Execution scaffold is a hard compile-time false — keep the verbatim "not enabled" copy as
          a tight muted line directly under the button (no separate big disabled button). */}
      <p className="font-body text-[10px] text-muted leading-snug">
        {EXECUTION_ENABLED ? 'Arm execution' : 'Arm execution — not enabled (simulation only)'}
        {simMsg ? <> · <span className="text-ink-2">{simMsg}</span></> : null}
      </p>
    </div>
  );
}

// ── B) Earnings block ─────────────────────────────────────────────────────────
function EarningsBlock({ est, isRedacted, flags = [], tradeSide }: { est: ReturnType<typeof estimateReward> | null; isRedacted: boolean; flags?: string[]; tradeSide: SideKey }) {
  const net = est?.netPerDay ?? null;
  const sideUnavailable = !!est && est.usedSideBook && !est.sideBookAvailable;
  // Honest-engine: a flagged (TRAP/THIN_CAP/SHORT_BURST) market can post an inflated
  // net from a thin book — mute the headline and warn, rather than show green.
  const cautionFlag = flags.some(f => ['TRAP', 'THIN_CAP', 'SHORT_BURST'].includes(f));
  const netTone = net == null ? 'text-muted' : cautionFlag ? 'text-ink-2' : net > 0 ? 'text-mint-deep' : 'text-coral-ink';
  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      <div className="px-4 py-4">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <p className="font-body text-[11px] uppercase tracking-wide text-muted flex items-center gap-1">
              Net earnings · per day ·
              <span className={tradeSide === 'yes' ? 'text-mint-deep font-semibold' : 'text-coral-ink font-semibold'}>{tradeSide.toUpperCase()} side</span>
              <InfoTip label="How net earnings is computed" size={12}>
                Net = your estimated share of the daily reward pool − the expected adverse-fill cost (what you lose when a resting order fills right as the price moves against you). Built from the real book depth and pool, never a midpoint fill. This is the NET view; the gross ticket above matches the list.
              </InfoTip>
            </p>
            <p className={`font-mono font-bold leading-none mt-1 ${netTone}`} style={{ fontSize: 34 }}>
              <Redacted value={net} isPaid={!isRedacted}>{v => `${fmtUsd(v)}/day`}</Redacted>
            </p>
          </div>
          <div className="text-right">
            <p className="font-body text-[12px] text-ink-2 tabular-nums"><Redacted value={est?.dayYieldPct ?? null} isPaid={!isRedacted}>{v => `${v.toFixed(3)}%/day`}</Redacted></p>
            <p className="font-body text-[9px] text-muted">net of expected adverse-fill cost</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-4">
          <MiniBox label="Pool share" value={<Redacted value={est?.shareOfPool ?? null} isPaid={!isRedacted}>{v => `${(v * 100).toFixed(2)}%`}</Redacted>} />
          <MiniBox label="Fill prob." value={<Redacted value={est?.fillProbability ?? null} isPaid={!isRedacted}>{v => `${(v * 100).toFixed(0)}%`}</Redacted>} sub="how often you get picked off" />
          <MiniBox label="Adverse cost" value={<span className="text-coral-ink"><Redacted value={est?.adverseSelectionCost ?? null} isPaid={!isRedacted}>{v => `−${fmtUsd(v)}`}</Redacted></span>} sub="adverse selection" />
        </div>

        {cautionFlag && net != null && (
          <div className="rounded-button bg-gold-tint border border-gold/25 px-3 py-2 mt-3">
            <p className="font-body text-[11px] text-gold leading-relaxed">
              <span className="font-semibold">Flagged: {flags.filter(f => ['TRAP', 'THIN_CAP', 'SHORT_BURST'].includes(f)).map(f => f.replace('_', ' ').toLowerCase()).join(', ')}.</span>{' '}
              This book is thin or the price is extreme, so the estimate above is a run-rate you likely can&apos;t fill in size — treat it as a ceiling, not a promise.
            </p>
          </div>
        )}
        {est?.belowMinPayout && (
          <p className="font-body text-[11px] text-muted mt-3">Below the $1/day minimum — this position likely pays nothing. Shown for completeness.</p>
        )}
        {sideUnavailable && !isRedacted && (
          <p className="font-body text-[11px] text-muted mt-3">
            The {tradeSide.toUpperCase()} side&apos;s book is empty or unavailable right now — its earnings can&apos;t be computed and are shown as missing (never fabricated). Try the other side, or check back shortly.
          </p>
        )}
        {isRedacted && net == null && (
          <p className="font-body text-[11px] text-muted mt-3">Numbers are locked on the free plan — the estimate runs on real book/pool once unlocked. No fabricated values.</p>
        )}
        {!isRedacted && est && est.reasons.length > 0 && (
          <ul className="mt-3 space-y-1">
            {est.reasons.map((r, i) => <li key={i} className="font-body text-[10px] text-muted leading-snug">· {r}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
function MiniBox({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-button bg-bg-soft border border-line px-2 py-1.5 min-w-0">
      <p className="font-body text-[9px] uppercase tracking-wide text-muted truncate">{label}</p>
      <p className="font-body text-[13px] font-semibold text-ink tabular-nums mt-0.5 whitespace-nowrap">{value}</p>
      {sub && <p className="font-body text-[8px] text-muted mt-0.5 leading-tight truncate">{sub}</p>}
    </div>
  );
}

// ── Trade YES / Trade NO toggle (prominent) ───────────────────────────────────
function TradeSideToggle({
  tradeSide, setTradeSide, yesMid, noMid, isRedacted, yesHasBook, noHasBook,
}: {
  tradeSide: SideKey; setTradeSide: (s: SideKey) => void;
  yesMid: number | null; noMid: number | null; isRedacted: boolean;
  yesHasBook: boolean; noHasBook: boolean;
}) {
  const Btn = ({ s, mid, has }: { s: SideKey; mid: number | null; has: boolean }) => {
    const active = tradeSide === s;
    const isYes  = s === 'yes';
    const activeCls = isYes ? 'border-mint-deep bg-mint-tint text-mint-deep' : 'border-coral-ink bg-coral-tint text-coral-ink';
    const idleCls   = 'border-line bg-surface text-muted hover:text-ink-2';
    return (
      <button onClick={() => setTradeSide(s)} aria-pressed={active}
        className={`flex-1 min-h-[44px] rounded-button border px-3 py-2 text-left transition-colors ${active ? activeCls : idleCls}`}>
        <span className="font-body font-semibold text-[12px] flex items-center gap-1.5">
          {active && <span className={`w-1.5 h-1.5 rounded-full ${isYes ? 'bg-mint-deep' : 'bg-coral-ink'}`} />}
          Trade {isYes ? 'YES' : 'NO'}
        </span>
        <span className="font-mono text-[15px] font-bold tabular-nums block mt-0.5">
          {isRedacted ? '••¢' : mid != null ? fmtC(mid) : (has ? '—' : 'no book')}
        </span>
      </button>
    );
  };
  return (
    <div className="rounded-card shadow-card bg-surface px-2.5 py-2.5">
      <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
        <p className="font-body font-medium text-[13px] text-ink-2">Which side do you want to make?</p>
        <span className="font-body text-[10px] text-muted">YES + NO ≈ 100¢ · own book each</span>
      </div>
      <div className="flex gap-2">
        <Btn s="yes" mid={yesMid} has={yesHasBook} />
        <Btn s="no"  mid={noMid}  has={noHasBook} />
      </div>
    </div>
  );
}

// ── Order tickets — one panel per active (tapped) leg. Buy and sell are INDEPENDENT:
// both can be live at once; each has its own USD qty. A leg exists only after the user
// taps a real book level, so every ticket is a manual placement at a real executable price.
function LegTickets({
  legs, legQty, setLegQty, removeLeg, tradeSide, mid, maxSpread, venue, snapshot, isRedacted, venueUrl,
}: {
  legs: { buy: LegState; sell: LegState }; legQty: { buy: number; sell: number };
  setLegQty: React.Dispatch<React.SetStateAction<{ buy: number; sell: number }>>;
  removeLeg: (kind: LegKind) => void; tradeSide: SideKey; mid: number | null; maxSpread: number | null;
  venue: Venue; snapshot: MarketSnapshot; isRedacted: boolean; venueUrl: string | null;
}) {
  const venueLabel = venue === 'polymarket' ? 'Polymarket' : venue === 'kalshi' ? 'Kalshi' : venue;
  const active: LegKind[] = [];
  if (legs.buy)  active.push('buy');
  if (legs.sell) active.push('sell');
  if (active.length === 0) return null;
  const bothActive = legs.buy != null && legs.sell != null;
  const total = (legs.buy ? legQty.buy : 0) + (legs.sell ? legQty.sell : 0);
  return (
    <div className="rounded-card shadow-card bg-surface px-4 py-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-body font-medium text-sm text-ink-2">Your tapped orders</p>
        {bothActive && <span className="font-body text-[11px] text-muted tabular-nums">Total on 2 sides {fmtUsd(total)}</span>}
      </div>
      {active.map(kind => {
        const leg    = legs[kind]!;
        const q      = legQty[kind];
        const shares = leg.price > 0 ? q / leg.price : 0;
        const distC  = mid != null ? Math.abs(leg.price - mid) * 100 : null;
        const half   = maxSpread != null ? maxSpread / 2 : null;
        const closer = distC != null && half != null ? distC <= half : null;
        const isBuy  = kind === 'buy';
        // Honest-engine: recompute the reward from the REAL tapped price's proximity to mid
        // via the SAME estimator the slider uses — NEVER a stale slider figure or a guess.
        // If it can't produce a value (redacted / no mid / null result) → "reward n/d".
        const est    = (!isRedacted && distC != null)
          ? estimateReward({ venue, capital: q, twoSided: bothActive, distanceCents: distC, market: snapshot, side: tradeSide })
          : null;
        const reward = est?.netPerDay ?? null;
        return (
          <div key={kind} className={`rounded-button border px-3 py-2.5 ${isBuy ? 'border-mint-deep/35 bg-mint-tint/40' : 'border-coral-ink/35 bg-coral-tint/40'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className={`font-body font-semibold text-[13px] flex items-center gap-1.5 ${isBuy ? 'text-mint-deep' : 'text-coral-ink'}`}>
                {isBuy ? 'BUY' : 'SELL'} {tradeSide.toUpperCase()} @ {fmtC(leg.price)}
                <span className="px-1 rounded-sm bg-surface border border-current/30 uppercase tracking-wide text-[7px] font-semibold">manual</span>
              </span>
              <button onClick={() => removeLeg(kind)} className="text-muted hover:text-ink-2 shrink-0" title="remove this leg" aria-label={`remove ${kind} leg`}><X size={14} /></button>
            </div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="font-body text-[11px] uppercase tracking-wide text-muted">qty</span>
              <button onClick={() => setLegQty(p => ({ ...p, [kind]: Math.max(250, p[kind] - 250) }))}
                className="w-7 h-7 rounded-button border border-line text-ink-2 font-mono leading-none">−</button>
              <span className="font-mono text-[13px] text-ink-2 tabular-nums w-24 text-center">{fmtUsd(q)}</span>
              <button onClick={() => setLegQty(p => ({ ...p, [kind]: p[kind] + 250 }))}
                className="w-7 h-7 rounded-button border border-line text-ink-2 font-mono leading-none">+</button>
              <span className="font-body text-[11px] text-muted tabular-nums ml-auto">≈ {fmtSh(shares)} shares</span>
            </div>
            <div className="flex items-center justify-between gap-2 mt-1.5 flex-wrap">
              <span className="font-body text-[11px] text-ink-2 tabular-nums">
                est. reward {reward != null ? <span className={reward > 0 ? 'text-mint-deep font-medium' : 'text-coral-ink'}>{fmtUsd(reward)}/day</span> : <span className="text-muted">n/d</span>}
                <span className="text-muted"> · from tapped price, not the slider</span>
              </span>
              <button onClick={() => removeLeg(kind)} className="font-body text-[10px] text-muted hover:text-ink-2 underline underline-offset-2">reset to slider</button>
            </div>
            {closer != null && (
              <p className="font-body text-[10px] text-muted mt-1">
                {closer ? 'closer to mid · more reward, more fill risk' : 'farther from mid · safer, less reward'}
              </p>
            )}
            {/* Honest execution bridge: the plan lives in-app (live execution OFF); this opens the
                REAL venue market page. Neither venue accepts a price/side/size URL prefill, so we
                spell out exactly what to enter by hand rather than fabricate a prefilled link. */}
            {venueUrl ? (
              <div className="mt-2 pt-2 border-t border-current/15 flex items-center justify-between gap-2 flex-wrap">
                <span className="font-body text-[10px] text-muted">
                  Place on {venueLabel}: <span className="text-ink-2 font-medium tabular-nums">{isBuy ? 'BUY' : 'SELL'} {tradeSide.toUpperCase()} @ {fmtC(leg.price)} · {fmtUsd(q)}</span>
                  <span className="text-muted"> — {venueLabel} can’t pre-fill; enter it there.</span>
                </span>
                <PlatformLink href={venueUrl} label={`Place on ${venueLabel}`} className="shrink-0" />
              </div>
            ) : (
              <p className="font-body text-[10px] text-muted mt-2 pt-2 border-t border-current/15">No linkable {venueLabel} page for this market — place {isBuy ? 'BUY' : 'SELL'} {tradeSide.toUpperCase()} @ {fmtC(leg.price)} manually on the venue.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── D) DUAL order book (YES | NO), chosen side highlighted, planned orders inline ─
function DualOrderBook({
  yesBook, noBook, tradeSide, bookAge, bookErr, isRedacted, yesMid, noMid, maxSpread, userBid, userAsk, onRefresh, venue,
  onTap, venueUrl, buyManual, sellManual,
}: {
  yesBook: NormBook | null; noBook: NormBook | null; tradeSide: SideKey;
  bookAge: Date | null; bookErr: string | null; isRedacted: boolean;
  yesMid: number | null; noMid: number | null; maxSpread: number | null;
  userBid: number | null; userAsk: number | null; onRefresh: () => void; venue: Venue;
  onTap: (columnSide: SideKey, kind: LegKind, price: number) => void; venueUrl: string | null; buyManual: boolean; sellManual: boolean;
}) {
  const anyBook = (yesBook?.hasBook || noBook?.hasBook) ?? false;
  // Window the ladder to the actionable levels around the mid: N per side per column, collapsed
  // by default so both columns + the mid divider fit ~one viewport. HONEST-ENGINE: no level is
  // dropped or fabricated — the far-from-mid levels stay one tap away via "show full depth", and
  // each column's "depth $Y" summary keeps counting the FULL real book (see depthOf).
  const WINDOW_N = 5;
  const [showFull, setShowFull] = useState(false);
  const hasMore = [yesBook, noBook].some(
    b => !!b && ((b.asks?.length ?? 0) > WINDOW_N || (b.bids?.length ?? 0) > WINDOW_N),
  );
  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
        <div className="flex items-center gap-2">
          <span className="font-body font-medium text-sm text-ink-2">Live order book · YES / NO</span>
          {bookAge && anyBook && (
            <span className="flex items-center gap-1 font-body text-[10px] text-mint-deep">
              <span className="w-1.5 h-1.5 rounded-full bg-mint-deep animate-pulse" /> updated {ago(bookAge.toISOString())} ago
            </span>
          )}
        </div>
        <button onClick={onRefresh} className="inline-flex items-center gap-1 font-body text-[11px] text-muted hover:text-ink-2">
          <RefreshCw size={12} /> refresh
        </button>
      </div>

      {isRedacted ? (
        <div className="px-4 py-8 text-center">
          <p className="font-body text-sm text-muted">Live book available once the plan is unlocked.</p>
        </div>
      ) : !anyBook ? (
        <div className="px-4 py-8 text-center">
          <p className="font-body text-sm text-muted">Book unavailable — data refreshing, try again shortly.</p>
          {bookErr && <p className="font-body text-[10px] text-muted mt-1">{bookErr}</p>}
        </div>
      ) : (
        <div className="px-3 py-3">
          <div className="flex gap-2 items-start">
            <SideColumn side="yes" book={yesBook} mid={yesMid} maxSpread={maxSpread}
              chosen={tradeSide === 'yes'} userBid={userBid} userAsk={userAsk}
              orderSide={side} onTap={onTap} venueUrl={venueUrl} buyManual={buyManual} sellManual={sellManual}
              windowN={WINDOW_N} showFull={showFull} />
            <SideColumn side="no" book={noBook} mid={noMid} maxSpread={maxSpread}
              chosen={tradeSide === 'no'} userBid={userBid} userAsk={userAsk}
              orderSide={side} onTap={onTap} venueUrl={venueUrl} buyManual={buyManual} sellManual={sellManual}
              windowN={WINDOW_N} showFull={showFull} />
          </div>
          {hasMore && (
            <button onClick={() => setShowFull(v => !v)}
              className="mt-2 w-full inline-flex items-center justify-center gap-1 font-body text-[11px] text-muted hover:text-ink-2 py-2 rounded-button border border-line hover:bg-bg-soft transition-colors">
              {showFull ? `▲ hide far levels — back to ${WINDOW_N} per side` : `▼ show full depth — all levels`}
            </button>
          )}
          <p className="font-body text-[9px] text-muted px-1 pt-2 leading-relaxed">
            Real executable prices from {venue === 'polymarket' ? 'each token’s own CLOB book (both fetched live; YES + NO mids ≈ 100¢, but each side’s in-band reward depth differs)' : 'the Kalshi book — bids are real, asks are the contract complement'}.
            The <span className="font-semibold">{tradeSide.toUpperCase()}</span> column is highlighted; your <span className="font-semibold">planned orders</span> (mid ± distance) show in bold there, never midpoint for fills.
          </p>
        </div>
      )}
    </div>
  );
}

// One side's book column. Chosen side is full-opacity + tinted; the other is dimmed.
function SideColumn({
  side, book, mid, maxSpread, chosen, userBid, userAsk, orderSide, onTap, venueUrl, buyManual, sellManual, windowN, showFull,
}: {
  side: SideKey; book: NormBook | null; mid: number | null; maxSpread: number | null;
  chosen: boolean; userBid: number | null; userAsk: number | null;
  orderSide: SideMode; onTap: (kind: LegKind, price: number) => void; venueUrl: string | null; buyManual: boolean; sellManual: boolean;
  windowN: number; showFull: boolean;
}) {
  const isYes    = side === 'yes';
  // Levels are already sorted best-first (asks ascending, bids descending), so the ones nearest
  // the mid are the FIRST windowN. Collapsed → just those; expanded → every real level (none is
  // dropped). No fabrication: we only ever slice the real book, never pad it.
  const allAsks  = book?.asks ?? [];
  const allBids  = book?.bids ?? [];
  const asks     = showFull ? allAsks : allAsks.slice(0, windowN);
  const bids     = showFull ? allBids : allBids.slice(0, windowN);
  // Depth bars scale to the max size WITHIN the visible window (task spec), so a collapsed view
  // isn't dwarfed by a far level that isn't on screen.
  const maxSize  = Math.max(1, ...asks.map(a => a.size), ...bids.map(b => b.size));
  const halfBand = maxSpread != null ? (maxSpread / 100) / 2 : null;
  const spread   = spreadOf(book);
  const depth    = depthOf(book);   // FULL real book depth — never windowed (honest capacity)
  // Planned orders render ONLY in the chosen side's column.
  const askRows  = mergeUserRow(asks, chosen ? userAsk : null, 'sell', 'asc');
  const bidRows  = mergeUserRow(bids, chosen ? userBid : null, 'buy', 'desc');
  const hasBook  = book?.hasBook;
  // Tappable only in the CHOSEN column, and only for the leg kind the Side control allows:
  // asks → SELL (allowed when Both/Sell only); bids → BUY (allowed when Both/Buy only).
  const sellTappable = chosen && (orderSide === 'both' || orderSide === 'sell');
  const buyTappable  = chosen && (orderSide === 'both' || orderSide === 'buy');
  return (
    <div className={`flex-1 min-w-0 rounded-button border overflow-hidden transition-opacity
      ${chosen ? (isYes ? 'border-mint-deep/40' : 'border-coral-ink/40') : 'border-line opacity-50'}`}>
      <div className={`px-2.5 py-1.5 border-b
        ${chosen ? (isYes ? 'bg-mint-tint/60 border-mint-deep/20' : 'bg-coral-tint/60 border-coral-ink/20') : 'bg-bg-soft border-line'}`}>
        <div className="flex items-center justify-between">
          <span className={`font-body font-semibold text-[11px] ${isYes ? 'text-mint-deep' : 'text-coral-ink'}`}>
            {isYes ? 'YES' : 'NO'}{chosen ? ' · trading' : ''}
          </span>
          <span className="font-mono text-[11px] text-ink-2 tabular-nums">{mid != null ? fmtC(mid) : '—'}</span>
        </div>
        <div className="flex items-center gap-2 font-body text-[9px] text-muted mt-0.5">
          <span>spread {spread != null ? fmtC(spread) : '—'}</span>
          <span>depth {depth > 0 ? fmtUsd(depth) : '—'}</span>
        </div>
      </div>
      {!hasBook ? (
        <div className="px-2 py-6 text-center"><p className="font-body text-[11px] text-muted">book unavailable</p></div>
      ) : (
        <div className="px-1.5 py-1.5">
          <div className="flex flex-col-reverse">
            {askRows.map((r, i) => <MiniLadder key={`a${i}`} row={r} maxSize={maxSize} mid={mid} halfBand={halfBand} kind="ask"
              tappable={sellTappable} dimmed={chosen && !sellTappable} manual={sellManual} venueUrl={venueUrl}
              onTap={sellTappable ? (p) => onTap('sell', p) : undefined} />)}
          </div>
          <div className="flex items-center justify-center gap-2 px-1 py-1.5 my-1 bg-bg-soft border-y border-line text-center">
            <span className="font-mono text-[10px] font-semibold text-ink tabular-nums whitespace-nowrap">mid {mid != null ? fmtC(mid) : '—'}</span>
            {spread != null && <span className="font-body text-[9px] text-muted tabular-nums whitespace-nowrap">· spread {fmtC(spread)}</span>}
          </div>
          <div className="flex flex-col">
            {bidRows.map((r, i) => <MiniLadder key={`b${i}`} row={r} maxSize={maxSize} mid={mid} halfBand={halfBand} kind="bid"
              tappable={buyTappable} dimmed={chosen && !buyTappable} manual={buyManual} venueUrl={venueUrl}
              onTap={buyTappable ? (p) => onTap('buy', p) : undefined} />)}
          </div>
          {book?.asksComplement && (
            <p className="font-body text-[9px] text-muted px-1 pt-1.5 leading-tight">asks = 100¢ − opposite-side bid (complement-derived)</p>
          )}
        </div>
      )}
    </div>
  );
}

interface LadderRow extends BookRow { user?: 'buy' | 'sell' }
// Fold the user's placed/planned leg INTO the book. When the leg price coincides with a real
// executable level (the case every time you tap a level), annotate THAT row in place — no
// duplicate. Only when the price sits between real levels (a slider-planned quote) do we add a
// standalone marker; that marker is honest (size 0, clearly "your order", never a fake book level).
function mergeUserRow(levels: BookRow[], userPrice: number | null, kind: 'buy' | 'sell', order: 'asc' | 'desc'): LadderRow[] {
  const rows: LadderRow[] = levels.map(l => ({ ...l }));
  if (userPrice != null) {
    const existing = rows.find(r => r.price === userPrice);
    if (existing) {
      existing.user = kind;                                 // mark the real level, keep its real size
    } else {
      rows.push({ price: userPrice, size: 0, user: kind }); // planned quote between levels → own marker
      rows.sort((a, b) => order === 'asc' ? a.price - b.price : b.price - a.price);
    }
  }
  return rows;
}
function MiniLadder({ row, maxSize, mid, halfBand, kind, tappable, dimmed, manual, venueUrl, onTap }: {
  row: LadderRow; maxSize: number; mid: number | null; halfBand: number | null; kind: 'ask' | 'bid';
  tappable?: boolean; dimmed?: boolean; manual?: boolean; venueUrl?: string | null; onTap?: (price: number) => void;
}) {
  // A row may be a plain real level, OR the user's leg living ON a real level (annotated by
  // mergeUserRow — no duplicate), OR a between-levels planned marker (size 0). One code path.
  const isUser    = !!row.user;
  const inBand    = mid != null && halfBand != null ? Math.abs(row.price - mid) <= halfBand : false;
  const barPct    = maxSize > 0 ? (row.size / maxSize) * 100 : 0;
  const priceCls  = kind === 'ask' ? 'text-coral-ink' : 'text-mint-deep';
  // Depth bar is a real COLORED background fill (green for bids, red for asks), not a grey block —
  // rgba so it tints the row behind the text without ever hiding the price/size numbers.
  const barColor  = kind === 'ask' ? 'rgba(213,85,47,0.18)' : 'rgba(10,157,107,0.16)';
  const sideLabel = row.user === 'buy' ? 'BUY' : 'SELL';

  // Tap-to-place lives ON the real book rows (and on a between-levels planned marker):
  //   • any real level that isn't yet your leg → tap PLACES / MOVES the maker leg to that exact
  //     executable price (never mid). This is what lets a second tap relocate the marker instead
  //     of stacking a new row.
  //   • your placed leg (manual) → re-tap OPENS the real venue page — in-app execution is OFF,
  //     so the venue is the honest place to submit. Same behavior as commit 0b61d4e.
  const placeHere = tappable && onTap ? () => onTap(row.price) : undefined;
  const goVenue   = venueUrl ? () => window.open(venueUrl, '_blank', 'noopener,noreferrer') : undefined;
  const act       = isUser ? (manual ? goVenue : placeHere) : placeHere;
  const clickable = !!act;
  const title = isUser
    ? (manual ? (goVenue ? `Open the venue to place ${sideLabel} at ${fmtC(row.price)}` : undefined)
              : (placeHere ? `Place ${sideLabel} at ${fmtC(row.price)}` : undefined))
    : (clickable ? `Place ${kind === 'ask' ? 'SELL' : 'BUY'} at ${fmtC(row.price)}` : undefined);

  // A tappable ladder row is a full-width touch target (≥44px); static rows stay compact so the
  // book keeps its density. The tap/placed affordance NEVER shares a line with the numbers.
  const rowMinH   = clickable ? 'min-h-[44px]' : 'min-h-[26px]';
  const userTone  = row.user === 'buy' ? 'text-mint-deep' : 'text-coral-ink';
  const placedLbl = isUser ? (manual ? (goVenue ? 'placed ↗' : 'placed') : 'tap to place') : null;

  return (
    <div
      onClick={act}
      role={clickable ? 'button' : undefined}
      title={title}
      className={`relative flex flex-col justify-center ${rowMinH} px-2 my-[1px] rounded-sm overflow-hidden
        ${clickable ? 'cursor-pointer hover:bg-bg-soft active:bg-bg-soft/80' : ''}
        ${isUser
          ? `ring-1 ring-inset ${row.user === 'buy' ? 'ring-mint-deep bg-mint-tint' : 'ring-coral-ink bg-coral-tint'}`
          : (dimmed ? 'opacity-40 pointer-events-none' : '')}`}
    >
      {/* colored depth bar — sized to the level's real size, sitting BEHIND the text */}
      {row.size > 0 && (
        <span className="absolute inset-y-0 right-0 pointer-events-none"
          style={{ width: `${Math.max(2, barPct)}%`, background: barColor }} />
      )}

      {/* line 1 — price (left) · size (right). tabular-nums + nowrap ⇒ they can never collide. */}
      <div className="relative grid grid-cols-2 items-center gap-2 font-mono text-[11px] leading-none">
        <span className={`tabular-nums whitespace-nowrap ${isUser
          ? `font-bold ${userTone}`
          : `${priceCls} ${inBand ? 'font-semibold' : ''}`}`}>{fmtC(row.price)}</span>
        <span className="tabular-nums whitespace-nowrap text-right text-ink-2">{row.size > 0 ? fmtSh(row.size) : '—'}</span>
      </div>

      {/* line 2 — the placed / tap-to-place affordance on its OWN row (never over the numbers) */}
      {isUser && (
        <div className={`relative flex items-center justify-between gap-1 mt-1 leading-none ${userTone}`}>
          <span className="px-1 py-[1px] rounded-sm bg-surface border border-current/40 uppercase tracking-wide text-[7px] font-semibold whitespace-nowrap">{placedLbl}</span>
          <span className="font-body text-[8px] font-semibold whitespace-nowrap">your {sideLabel}</span>
        </div>
      )}
    </div>
  );
}

// ── shared bits ───────────────────────────────────────────────────────────────
// Colored YES/NO badge (YES green, NO red) used by the per-side fill-rule cards.
function SideBadge({ side }: { side: SideKey }) {
  const cls = side === 'yes'
    ? 'bg-mint-tint text-mint-deep border-mint-deep/25'
    : 'bg-coral-tint text-coral-ink border-coral-ink/25';
  return <span className={`inline-flex items-center px-1.5 py-[1px] rounded-md font-body font-semibold text-[10px] border ${cls}`}>{side.toUpperCase()}</span>;
}

// One-line composed summary of a side's chosen fill rule.
function fillSummary(side: SideKey, rule: OnFill): string {
  const other = side === 'yes' ? 'NO' : 'YES';
  return rule === 'requote'
    ? `${side.toUpperCase()} fill → re-quote the ${other} side`
    : `${side.toUpperCase()} fill → close at best price`;
}

// Per-side fill-rule picker: a badge-labelled header + the two rule choices, with
// the "re-quote" copy naming the actual opposite side.
function FillRuleCard({ side, value, onChange }: { side: SideKey; value: OnFill; onChange: (v: OnFill) => void }) {
  const other = side === 'yes' ? 'NO' : 'YES';
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <SideBadge side={side} />
        <p className="font-body font-medium text-[13px] text-ink-2">If your {side.toUpperCase()} order gets filled</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <ChoiceBtn active={value === 'requote'} onClick={() => onChange('requote')}
          title="↻ Re-quote other side" desc={`Immediately re-post the ${other} side to capture the spread on the exit. You stay directionally exposed until you're balanced again.`} />
        <ChoiceBtn active={value === 'close'} onClick={() => onChange('close')}
          title="✕ Close immediately" desc="Close at the best executable price on the book: no directional exposure, but you give up the spread." />
      </div>
    </div>
  );
}
function ChoiceBtn({ active, onClick, title, desc }: { active: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button onClick={onClick}
      className={`text-left rounded-button border px-2.5 py-1.5 min-h-[44px] transition-colors
        ${active ? 'border-mint-deep/45 bg-mint-tint' : 'border-line bg-surface hover:border-muted/50'}`}>
      <p className={`font-body font-medium text-[12px] ${active ? 'text-mint-deep' : 'text-ink-2'}`}>{title}</p>
      <p className="font-body text-[10px] text-muted leading-snug mt-0.5">{desc}</p>
    </button>
  );
}
function NewsRiskPill({ risk }: { risk: NewsRisk }) {
  const map: Record<NewsRisk, { label: string; cls: string }> = {
    high:    { label: 'news risk · HIGH', cls: 'bg-coral-tint text-coral-ink border-coral-ink/25' },
    medium:  { label: 'news risk · med',  cls: 'bg-gold-tint text-gold border-gold/25' },
    low:     { label: 'calm',             cls: 'bg-mint-tint text-mint-deep border-mint-deep/20' },
    unknown: { label: 'no signal',        cls: 'bg-bg-soft text-muted border-line' },
  };
  const s = map[risk] ?? map.unknown;
  return <span className={`inline-flex items-center px-2 py-[2px] rounded-md font-body font-medium text-[10px] border ${s.cls}`}>{s.label}</span>;
}

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
// HONEST-ENGINE: executable book prices only (never midpoint for fills), net $/day
// primary, annualized demoted+capped, no fabricated pools/PnL, no login wall on view,
// live execution OFF everywhere (advisory only). Book/pool numbers are server-redacted
// on the free tier — the page degrades to a calm "unlock" state, never a fake number.

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

// ── Page ──────────────────────────────────────────────────────────────────────
export default function MarketDetailPage() {
  const params = useParams();
  const marketId = decodeURIComponent(params.marketId as string);

  const [mkt, setMkt]           = useState<NormalizedMarket | null>(null);
  const [mktErr, setMktErr]     = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);

  // live book (both sides)
  const [books, setBooks]       = useState<DualBook | null>(null);
  const [bookAge, setBookAge]   = useState<Date | null>(null);
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
    } catch (e: any) { setBookErr(e?.message ?? 'book error'); }
  }, [mkt]);

  useEffect(() => {
    if (!mkt) return;
    fetchBook();
    pollRef.current = setInterval(fetchBook, mkt.venue === 'polymarket' ? 5_000 : 6_000);
    return () => clearInterval(pollRef.current);
  }, [mkt, fetchBook]);

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

  // free-tier detection (snapshot numbers redacted → estimate degrades to unlock)
  const isRedacted = !!mkt && mkt.midpoint == null && mkt.dailyPool == null;

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
      {/* ── A) Sticky header ── */}
      <div className="sticky top-0 z-20 backdrop-blur bg-surface/85 border-b border-line">
        <div className="max-w-3xl mx-auto px-4 py-2.5">
          <Link href="/dashboard/liquidity-rewards" className="inline-flex items-center gap-1 font-body text-[12px] text-muted hover:text-ink-2">
            <ChevronLeft size={15} /> Rewards
          </Link>
          {mkt ? (
            <>
              <div className="flex items-start gap-2 mt-1.5">
                <PlatformLogo platform={mkt.venue} size={18} className="mt-0.5" />
                <h1 className="font-display font-bold text-ink text-[15px] sm:text-lg leading-snug flex-1 min-w-0">{mkt.title}</h1>
                {(() => {
                  // Multi-outcome (negRisk) events → deep-link the exact outcome via the real
                  // two-segment …/event/<eventSlug>/<marketSlug>; fall back to the plain event
                  // link when that isn't constructible. Single-outcome markets are unchanged.
                  const u = mkt.venue === 'polymarket'
                    ? ((mkt.negRisk && mkt.marketSlug ? polymarketOutcomeUrl(mkt.slug, mkt.marketSlug) : null) ?? polymarketMarketUrl(mkt.slug))
                    : mkt.venue === 'kalshi' ? kalshiMarketUrl(mkt.marketId) : null;
                  return u ? <PlatformLink href={u} label={mkt.venue === 'polymarket' ? 'Polymarket' : 'Kalshi'} className="mt-0.5 shrink-0" /> : null;
                })()}
              </div>
              <p className="font-body text-[11px] text-muted mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                <span className="capitalize">{mkt.venue}</span>·<span>{mkt.category}</span>·
                <span>mid <Redacted value={mid}>{v => fmtC(v)}</Redacted></span>·
                <span>pool <Redacted value={mkt.dailyPool}>{v => `${fmtUsd(v)}/day`}</Redacted></span>·
                <span>resolves {fmtHours(mkt.hoursToResolution)}</span>
              </p>
            </>
          ) : (
            <div className="h-10 mt-2 bg-bg-soft/50 rounded animate-pulse w-2/3" />
          )}
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-5 space-y-5">
        {loading && !mkt && <p className="font-body text-sm text-muted">Loading market…</p>}

        {mkt && (
          <>
            {/* ── B) Earnings block (recomputes for chosen side) ── */}
            <EarningsBlock est={est} isRedacted={isRedacted} flags={mkt.flags} tradeSide={tradeSide} />

            {/* ── C) Order controls ── */}
            <div className="rounded-card shadow-card bg-surface px-4 py-4 space-y-4">
              <p className="font-body font-medium text-sm text-ink-2">Your order</p>

              {/* side */}
              <div>
                <span className="font-body text-[11px] uppercase tracking-wide text-muted">Side</span>
                <div className="grid grid-cols-3 gap-1.5 mt-1.5">
                  {([['both', 'Both sides'], ['buy', 'Buy only'], ['sell', 'Sell only']] as [SideMode, string][]).map(([v, label]) => (
                    <button key={v} onClick={() => changeSide(v)}
                      className={`font-body font-medium text-[12px] py-2 rounded-button border transition-colors
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

              {/* quantity per side */}
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-body text-[11px] uppercase tracking-wide text-muted">Size per side</span>
                  <span className="font-body text-[11px] text-muted tabular-nums">total {fmtUsd(capital)} on {sidesN} side{sidesN === 1 ? '' : 's'}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  {[100, 500, 1000, 5000].map(c => (
                    <button key={c} onClick={() => setQty(c)}
                      className={`font-body font-medium text-[12px] px-3 py-1.5 rounded-button border transition-colors
                        ${qty === c ? 'border-mint-deep/45 bg-mint-tint text-mint-deep' : 'border-line bg-surface text-muted hover:text-ink-2'}`}>
                      ${c >= 1000 ? `${c / 1000}k` : c}
                    </button>
                  ))}
                  <input type="number" min={1} value={qty} onChange={e => setQty(Math.max(1, Number(e.target.value) || 0))}
                    className="w-24 font-body text-[12px] text-ink-2 bg-bg-soft border border-line rounded-button px-2 py-1.5" />
                </div>
              </div>

              {/* distance */}
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-body text-[11px] uppercase tracking-wide text-muted">Distance from spread</span>
                  <span className="font-body text-[12px] text-ink-2 tabular-nums">{dist.toFixed(2)}¢{mkt.maxSpread != null ? ` / ${mkt.maxSpread}¢ band` : ''}</span>
                </div>
                <input type="range" min={tickSize ? tickSize * 100 : 0.1} max={distMax} step={tickSize ? tickSize * 100 : 0.1} value={dist}
                  onChange={e => setDist(Number(e.target.value))} className="w-full accent-mint-deep mt-1.5" />
                <div className="flex items-center justify-between font-body text-[10px] text-muted mt-0.5">
                  <span>closer = more reward, more fills</span>
                  <span>farther = safer</span>
                </div>
                {tickSize && (
                  <p className="font-body text-[10px] text-muted mt-1">
                    Min tick {fmtC(tickSize)} — {mkt.venue === 'polymarket' ? 'Polymarket' : 'Kalshi'} won&apos;t accept a finer price on this market; distances snap to the {fmtC(tickSize)} grid.
                  </p>
                )}
                {clampNote && <p className="font-body text-[10px] text-coral-ink mt-1">{clampNote}</p>}
                {mkt.maxSpread == null && (
                  <p className="font-body text-[10px] text-muted mt-1">Kalshi doesn&apos;t publish a reward band — distance here only affects fill risk.</p>
                )}
                {(legs.buy || legs.sell) && (
                  <p className="font-body text-[10px] text-gold mt-1.5">
                    Manual placement active for {[legs.buy && 'BUY', legs.sell && 'SELL'].filter(Boolean).join(' + ')} — {legs.buy && legs.sell ? 'those sides are' : 'that side is'} detached from this slider.
                    {' '}
                    <button onClick={() => { if (legs.buy) removeLeg('buy'); if (legs.sell) removeLeg('sell'); }}
                      className="underline underline-offset-2 hover:text-ink-2">reset to slider</button>
                  </p>
                )}
              </div>
            </div>

            {/* ── Side selector — sits in the band directly above the book (moved from top) ── */}
            <TradeSideToggle
              tradeSide={tradeSide} setTradeSide={setTradeSide}
              yesMid={yesMid} noMid={noMid} isRedacted={isRedacted}
              yesHasBook={yesBook?.hasBook ?? (mkt.sides?.yes?.hasBook !== false)}
              noHasBook={noBook?.hasBook ?? (mkt.sides?.no?.hasBook !== false)}
            />

            {/* ── D) Live DUAL order book (YES | NO), chosen side highlighted ── */}
            <DualOrderBook
              yesBook={yesBook} noBook={noBook} tradeSide={tradeSide}
              bookAge={bookAge} bookErr={bookErr} isRedacted={isRedacted}
              yesMid={yesMid} noMid={noMid} maxSpread={mkt.maxSpread}
              userBid={userBid} userAsk={userAsk} onRefresh={fetchBook} venue={mkt.venue}
              side={side} onTap={placeLeg}
              buyManual={legs.buy != null} sellManual={legs.sell != null}
            />

            {/* ── Order tickets: one per active leg (independent buy + sell) ── */}
            <LegTickets
              legs={legs} legQty={legQty} setLegQty={setLegQty} removeLeg={removeLeg}
              tradeSide={tradeSide} mid={mid} maxSpread={mkt.maxSpread}
              venue={mkt.venue} snapshot={toSnapshot(mkt)} isRedacted={isRedacted}
            />

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
              <p className="font-body text-[11px] text-muted leading-relaxed">
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
            <div className="rounded-card shadow-card bg-surface px-4 py-4 space-y-2">
              <button onClick={savePlacement} disabled={saveState === 'saving'}
                className="w-full font-body font-semibold text-[14px] py-3 rounded-button bg-mint-deep text-white hover:bg-mint-deep/90 disabled:opacity-60 transition-colors">
                {saveState === 'saving' ? 'Saving…' : 'Simulate placement · paper'}
              </button>
              <p className="font-body text-[11px] text-center text-muted">
                Advisory only · live execution <span className="font-semibold text-ink-2">OFF</span> · no real order is sent.
              </p>
              {saveMsg && (
                <p className={`font-body text-[11px] text-center ${saveState === 'error' ? 'text-coral-ink' : saveState === 'saved' ? 'text-mint-deep' : 'text-muted'}`}>
                  {saveMsg}
                </p>
              )}
            </div>

            {/* Footer */}
            <p className="font-body text-[11px] text-muted/60 leading-relaxed pt-2 border-t border-line">
              Order book from live {mkt.venue === 'polymarket' ? 'Polymarket CLOB' : 'Kalshi'} data (executable prices, never midpoint for fills).
              Estimates subtract expected adverse-fill cost; annualized is a demoted, capped run-rate, not a guarantee.
              Read-only, no orders placed, live execution OFF, no login required to view.
            </p>
          </>
        )}
      </div>
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
                Net = your estimated share of the daily reward pool − the expected adverse-fill cost (what you lose when a resting order fills right as the price moves against you). Built from the real book depth and pool, never a midpoint fill. Annualized is a capped run-rate, not a guarantee.
              </InfoTip>
            </p>
            <p className={`font-mono font-bold leading-none mt-1 ${netTone}`} style={{ fontSize: 34 }}>
              <Redacted value={net}>{v => `${fmtUsd(v)}/day`}</Redacted>
            </p>
          </div>
          <div className="text-right">
            <p className="font-body text-[12px] text-ink-2 tabular-nums"><Redacted value={est?.dayYieldPct ?? null}>{v => `${v.toFixed(3)}%/day`}</Redacted></p>
            <p className="font-body text-[11px] text-muted tabular-nums">
              <Redacted value={est?.annualizedPct ?? null}>{v => `${est?.annualizedCapped ? '>' : ''}${v.toFixed(0)}%/yr`}</Redacted>
            </p>
            <p className="font-body text-[9px] text-muted/70">{est?.annualizedLabel ?? 'run-rate, not guaranteed'}</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-4">
          <MiniBox label="Pool share" value={<Redacted value={est?.shareOfPool ?? null}>{v => `${(v * 100).toFixed(2)}%`}</Redacted>} />
          <MiniBox label="Fill prob." value={<Redacted value={est?.fillProbability ?? null}>{v => `${(v * 100).toFixed(0)}%`}</Redacted>} sub="how often you get picked off" />
          <MiniBox label="Adverse cost" value={<span className="text-coral-ink"><Redacted value={est?.adverseSelectionCost ?? null}>{v => `−${fmtUsd(v)}`}</Redacted></span>} sub="adverse selection" />
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
            {est.reasons.map((r, i) => <li key={i} className="font-body text-[10px] text-muted/80 leading-snug">· {r}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
function MiniBox({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-button bg-bg-soft border border-line px-3 py-2.5">
      <p className="font-body text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className="font-body text-[15px] font-semibold text-ink tabular-nums mt-0.5">{value}</p>
      {sub && <p className="font-body text-[9px] text-muted/70 mt-0.5 leading-tight">{sub}</p>}
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
        className={`flex-1 rounded-button border px-4 py-3 text-left transition-colors ${active ? activeCls : idleCls}`}>
        <span className="font-body font-semibold text-[13px] flex items-center gap-1.5">
          {active && <span className={`w-1.5 h-1.5 rounded-full ${isYes ? 'bg-mint-deep' : 'bg-coral-ink'}`} />}
          Trade {isYes ? 'YES' : 'NO'}
        </span>
        <span className="font-mono text-[16px] font-bold tabular-nums block mt-0.5">
          {isRedacted ? '••¢' : mid != null ? fmtC(mid) : (has ? '—' : 'no book')}
        </span>
      </button>
    );
  };
  return (
    <div className="rounded-card shadow-card bg-surface px-4 py-3">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <p className="font-body font-medium text-sm text-ink-2">Which side do you want to make?</p>
        <span className="font-body text-[10px] text-muted">YES + NO ≈ 100¢ · each has its own book</span>
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
  legs, legQty, setLegQty, removeLeg, tradeSide, mid, maxSpread, venue, snapshot, isRedacted,
}: {
  legs: { buy: LegState; sell: LegState }; legQty: { buy: number; sell: number };
  setLegQty: React.Dispatch<React.SetStateAction<{ buy: number; sell: number }>>;
  removeLeg: (kind: LegKind) => void; tradeSide: SideKey; mid: number | null; maxSpread: number | null;
  venue: Venue; snapshot: MarketSnapshot; isRedacted: boolean;
}) {
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
                <span className="px-1 rounded-sm bg-surface/70 border border-current/30 uppercase tracking-wide text-[7px] font-semibold">manuale</span>
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
          </div>
        );
      })}
    </div>
  );
}

// ── D) DUAL order book (YES | NO), chosen side highlighted, planned orders inline ─
function DualOrderBook({
  yesBook, noBook, tradeSide, bookAge, bookErr, isRedacted, yesMid, noMid, maxSpread, userBid, userAsk, onRefresh, venue,
  side, onTap, buyManual, sellManual,
}: {
  yesBook: NormBook | null; noBook: NormBook | null; tradeSide: SideKey;
  bookAge: Date | null; bookErr: string | null; isRedacted: boolean;
  yesMid: number | null; noMid: number | null; maxSpread: number | null;
  userBid: number | null; userAsk: number | null; onRefresh: () => void; venue: Venue;
  side: SideMode; onTap: (kind: LegKind, price: number) => void; buyManual: boolean; sellManual: boolean;
}) {
  const anyBook = (yesBook?.hasBook || noBook?.hasBook) ?? false;
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
          {bookErr && <p className="font-body text-[10px] text-muted/60 mt-1">{bookErr}</p>}
        </div>
      ) : (
        <div className="px-3 py-3">
          <div className="flex gap-2 items-start">
            <SideColumn side="yes" book={yesBook} mid={yesMid} maxSpread={maxSpread}
              chosen={tradeSide === 'yes'} userBid={userBid} userAsk={userAsk}
              orderSide={side} onTap={onTap} buyManual={buyManual} sellManual={sellManual} />
            <SideColumn side="no" book={noBook} mid={noMid} maxSpread={maxSpread}
              chosen={tradeSide === 'no'} userBid={userBid} userAsk={userAsk}
              orderSide={side} onTap={onTap} buyManual={buyManual} sellManual={sellManual} />
          </div>
          <p className="font-body text-[9px] text-muted/60 px-1 pt-2 leading-relaxed">
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
  side, book, mid, maxSpread, chosen, userBid, userAsk, orderSide, onTap, buyManual, sellManual,
}: {
  side: SideKey; book: NormBook | null; mid: number | null; maxSpread: number | null;
  chosen: boolean; userBid: number | null; userAsk: number | null;
  orderSide: SideMode; onTap: (kind: LegKind, price: number) => void; buyManual: boolean; sellManual: boolean;
}) {
  const isYes    = side === 'yes';
  const asks     = (book?.asks ?? []).slice(0, 8);
  const bids     = (book?.bids ?? []).slice(0, 8);
  const maxSize  = Math.max(1, ...asks.map(a => a.size), ...bids.map(b => b.size));
  const halfBand = maxSpread != null ? (maxSpread / 100) / 2 : null;
  const spread   = spreadOf(book);
  const depth    = depthOf(book);
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
              tappable={sellTappable} dimmed={chosen && !sellTappable} manual={sellManual}
              onTap={sellTappable ? (p) => onTap('sell', p) : undefined} />)}
          </div>
          <div className="px-1 py-1 my-0.5 bg-bg-soft/70 border-y border-line/60 text-center">
            <span className="font-mono text-[10px] font-semibold text-ink tabular-nums">mid {mid != null ? fmtC(mid) : '—'}</span>
          </div>
          <div className="flex flex-col">
            {bidRows.map((r, i) => <MiniLadder key={`b${i}`} row={r} maxSize={maxSize} mid={mid} halfBand={halfBand} kind="bid"
              tappable={buyTappable} dimmed={chosen && !buyTappable} manual={buyManual}
              onTap={buyTappable ? (p) => onTap('buy', p) : undefined} />)}
          </div>
          {book?.asksComplement && (
            <p className="font-body text-[8px] text-muted/70 px-1 pt-1 leading-tight">asks = 100¢ − opposite-side bid (complement-derived)</p>
          )}
        </div>
      )}
    </div>
  );
}

interface LadderRow extends BookRow { user?: 'buy' | 'sell' }
function mergeUserRow(levels: BookRow[], userPrice: number | null, kind: 'buy' | 'sell', order: 'asc' | 'desc'): LadderRow[] {
  const rows: LadderRow[] = levels.map(l => ({ ...l }));
  if (userPrice != null) {
    rows.push({ price: userPrice, size: 0, user: kind });
    rows.sort((a, b) => order === 'asc' ? a.price - b.price : b.price - a.price);
  }
  return rows;
}
function MiniLadder({ row, maxSize, mid, halfBand, kind, tappable, dimmed, manual, onTap }: {
  row: LadderRow; maxSize: number; mid: number | null; halfBand: number | null; kind: 'ask' | 'bid';
  tappable?: boolean; dimmed?: boolean; manual?: boolean; onTap?: (price: number) => void;
}) {
  const isUser = !!row.user;
  const inBand = mid != null && halfBand != null ? Math.abs(row.price - mid) <= halfBand : false;
  const barPct = maxSize > 0 ? (row.size / maxSize) * 100 : 0;
  const priceCls = kind === 'ask' ? 'text-coral-ink' : 'text-mint-deep';
  const barCls   = kind === 'ask' ? 'bg-coral-tint/60' : 'bg-mint-tint/60';
  if (isUser) {
    // The synthetic "your BUY/SELL" marker row — the slider-planned quote at a real, snapped
    // tick. It used to be a dead div: clicking it did nothing. Now it PLACES the maker order
    // at this exact (already tick-snapped, book-acceptable) price — never a silent no-op.
    const placeUser = onTap ? () => onTap(row.price) : undefined;
    return (
      <div
        onClick={placeUser}
        role={placeUser ? 'button' : undefined}
        title={placeUser ? `Place ${row.user === 'buy' ? 'BUY' : 'SELL'} at ${fmtC(row.price)}` : undefined}
        className={`relative grid grid-cols-2 items-center text-[10px] font-mono px-1.5 py-[3px] rounded-sm my-[1px]
        ${placeUser ? 'cursor-pointer hover:brightness-95 active:brightness-90' : ''}
        ${row.user === 'buy' ? 'bg-mint-tint ring-1 ring-mint-deep/50' : 'bg-coral-tint ring-1 ring-coral-ink/50'}`}>
        <span className={`tabular-nums font-bold ${row.user === 'buy' ? 'text-mint-deep' : 'text-coral-ink'}`}>{fmtC(row.price)}</span>
        <span className={`text-right font-bold text-[8px] flex items-center justify-end gap-1 ${row.user === 'buy' ? 'text-mint-deep' : 'text-coral-ink'}`}>
          {manual
            ? <span className="px-1 rounded-sm bg-surface/70 border border-current/30 uppercase tracking-wide text-[7px] font-semibold">manuale</span>
            : placeUser && <span className="px-1 rounded-sm bg-surface/70 border border-current/30 uppercase tracking-wide text-[7px] font-semibold">tap to place</span>}
          {row.user === 'buy' ? 'your BUY' : 'your SELL'}
        </span>
      </div>
    );
  }
  // Real book level. Tappable rows place a leg at this exact executable price (never mid).
  const clickable = tappable && !!onTap;
  return (
    <div
      onClick={clickable ? () => onTap!(row.price) : undefined}
      role={clickable ? 'button' : undefined}
      title={clickable ? `Place ${kind === 'ask' ? 'SELL' : 'BUY'} at ${fmtC(row.price)}` : undefined}
      className={`relative grid grid-cols-2 items-center text-[10px] font-mono px-1.5 py-[2px] rounded-sm
        ${clickable ? 'cursor-pointer hover:bg-bg-soft active:bg-bg-soft/80' : ''}
        ${dimmed ? 'opacity-30 pointer-events-none' : ''}`}
    >
      <span className={`absolute inset-y-0 right-0 ${barCls}`} style={{ width: `${barPct}%`, pointerEvents: 'none' }} />
      <span className={`relative tabular-nums ${priceCls} ${inBand ? 'font-semibold' : 'opacity-70'}`}>{fmtC(row.price)}</span>
      <span className="relative text-right text-muted tabular-nums">{fmtSh(row.size)}</span>
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
      className={`text-left rounded-button border px-3 py-2.5 transition-colors
        ${active ? 'border-mint-deep/45 bg-mint-tint' : 'border-line bg-surface hover:border-muted/50'}`}>
      <p className={`font-body font-medium text-[13px] ${active ? 'text-mint-deep' : 'text-ink-2'}`}>{title}</p>
      <p className="font-body text-[11px] text-muted leading-snug mt-0.5">{desc}</p>
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

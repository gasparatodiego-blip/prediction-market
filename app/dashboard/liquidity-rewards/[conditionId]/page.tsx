'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

// ── Types ──────────────────────────────────────────────────────────────────────

type VolRisk = 'LOW' | 'MEDIUM' | 'HIGH';
type Side    = 'BUY' | 'SELL' | 'BOTH';

interface Level {
  capital:        number;
  share:          number;     // typical placement headline
  grossRewardDay: number;
  dayYieldPct:    number;
  netRewardDay?:  number;
  netYieldPct?:   number;
  shareHigh?:     number;
  grossHigh?:     number;
  netHigh?:       number;
  shareLow?:      number;
  grossLow?:      number;
  netLow?:        number;
  flags:          string[];
}

interface MarketMeta {
  question:           string;
  conditionId:        string;
  rewardsDailyRate:   number;
  rewardsMaxSpread:   number;
  rewardsMinSize:     number;
  mid:                number;
  bookSpread:         number | null;
  existing_depth_usd: number;
  volatilityRisk:     VolRisk;
  volatilityStdev:    number | null;
  endDate:            string | null;
  negRisk:            boolean;
  levels:             Record<string, Level>;
  tokenId:            string;
  tokenIdNo:          string | null;
}

interface BookLevel {
  price: number;
  size:  number;
}

interface BookData {
  conditionId: string;
  yes:         { bids: {price:string;size:string}[]; asks: {price:string;size:string}[]; last_trade_price?: string };
  no:          { bids: {price:string;size:string}[]; asks: {price:string;size:string}[] } | null;
  fetchedAt:   string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtP(n: number) { return (n * 100).toFixed(1) + '¢'; }
function fmtS(n: number) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n.toFixed(0); }
function fmtUsd(n: number) {
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
  if (n >= 10)   return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
}
function ago(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)   return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

const VOL_CLS: Record<VolRisk, string> = {
  LOW:    'text-emerald-400 border-emerald-700/40 bg-emerald-950/20',
  MEDIUM: 'text-amber-400   border-amber-600/40   bg-amber-950/20',
  HIGH:   'text-red-400     border-red-700/40     bg-red-950/20',
};

// ── Reward math — Polymarket exact quadratic scoring ──────────────────────────
// S(v, s) = ((v - s) / v)^2   where v = maxSpread/2 (half-band, cents), s = dist from mid (cents)
// Q_competitors = Q_min(Q_bids, Q_asks) over live CLOB book
// Q_user        = S(s_user) * size,  then Q_min applied with c=3
// share = Q_user / (Q_user + Q_competitors)
// Adjusted mid: recomputed from orders ≥ minSize (per Polymarket spec).
// ESTIMATE: snapshot-in-time; competitors re-quote; not a guarantee.

function calcReward(params: {
  price:            number;
  size:             number;
  side:             Side;
  mid:              number;         // adjusted mid (from live book)
  rewardsMaxSpread: number;         // cents (total band width)
  rewardsMinSize:   number;         // shares
  bookBids:         BookLevel[];    // live YES bids, sorted desc
  bookAsks:         BookLevel[];    // live YES asks, sorted asc
  rewardsDailyRate: number;
}) {
  const { price, size, side, mid, rewardsMaxSpread, rewardsMinSize, bookBids, bookAsks, rewardsDailyRate } = params;
  const v = rewardsMaxSpread / 2;                     // half-band in cents
  const S = (p: number): number => {
    const s = Math.abs(p - mid) * 100;               // distance in cents
    if (s >= v || v <= 0) return 0;
    const r = (v - s) / v;
    return r * r;
  };
  const Qminf = (Qb: number, Qa: number): number => {
    if (mid < 0.10 || mid > 0.90) return Math.min(Qb, Qa);
    return Math.max(Math.min(Qb, Qa), Math.max(Qb / 3, Qa / 3));
  };

  // Competitor Q from live book (all orders ≥ minSize)
  const Qcomp_b = bookBids.filter(l => l.size >= rewardsMinSize).reduce((a, l) => a + S(l.price) * l.size, 0);
  const Qcomp_a = bookAsks.filter(l => l.size >= rewardsMinSize).reduce((a, l) => a + S(l.price) * l.size, 0);
  const Qcompetitors = Qminf(Qcomp_b, Qcomp_a);

  // User order
  const dist     = Math.abs(price - mid);
  const inBand   = dist * 100 < v;
  const aboveMin = size >= rewardsMinSize;
  const proximity = inBand ? (v - dist * 100) / v : 0;
  const quadW     = proximity * proximity;

  let Qu_b = 0, Qu_a = 0;
  if (inBand && aboveMin) {
    const Qu = quadW * size;
    if (side === 'BUY'  || side === 'BOTH') Qu_b = Qu;
    if (side === 'SELL' || side === 'BOTH') Qu_a = Qu;
  }
  const Quser = Qminf(Qu_b, Qu_a);

  const share          = Quser > 0 ? Quser / (Quser + Qcompetitors) : 0;
  const rewardDay      = share * rewardsDailyRate;
  const dollarsPerSide = size * price * quadW;  // display-only effective $ proxy
  const bothBoost      = side === 'BOTH';

  return { inBand, aboveMin, proximity, quadW, dollarsPerSide, share, rewardDay, bothBoost };
}

// ── Order book parsing ─────────────────────────────────────────────────────────

function parseLevels(raw: {price:string;size:string}[]): BookLevel[] {
  return raw
    .map(r => ({ price: parseFloat(r.price), size: parseFloat(r.size) }))
    .filter(r => r.price > 0 && r.size > 0);
}

// ── Depth ladder row — Polymarket 3-column style ──────────────────────────────

function BookRow({
  level,
  cumTotal,
  maxCumTotal,
  side,
  mid,
  halfBand,
  ticketPrice,
  onClickPrice,
}: {
  level:        BookLevel;
  cumTotal:     number;
  maxCumTotal:  number;
  side:         'bid' | 'ask';
  mid:          number;
  halfBand:     number;
  ticketPrice:  number | null;
  onClickPrice: (p: number) => void;
}) {
  const inBand   = Math.abs(level.price - mid) <= halfBand;
  const isTicket = ticketPrice !== null && Math.abs(level.price - ticketPrice) < 0.0005;
  const barPct   = maxCumTotal > 0 ? (cumTotal / maxCumTotal) * 100 : 0;

  const isAsk    = side === 'ask';
  const priceCls = isAsk
    ? (inBand ? 'text-red-300'     : 'text-red-800/60')
    : (inBand ? 'text-emerald-300' : 'text-emerald-800/60');
  const barCls   = isAsk ? 'bg-red-950/55' : 'bg-emerald-950/55';
  const bandCls  = inBand
    ? (isAsk ? 'border-l-2 border-red-500/35' : 'border-l-2 border-emerald-500/35')
    : '';

  return (
    <button
      onClick={() => onClickPrice(level.price)}
      className={`w-full relative grid grid-cols-3 items-center text-[11px] font-mono
        px-2 py-[3px] transition-colors hover:bg-zinc-700/25
        ${isTicket ? 'ring-1 ring-inset ring-amber-400/60' : ''} ${bandCls}`}
    >
      {/* Depth bar — cumulative, anchored from right edge */}
      <span
        className={`absolute inset-y-0 right-0 ${barCls}`}
        style={{ width: `${barPct}%`, pointerEvents: 'none' }}
      />
      {/* Col 1: PRICE */}
      <span className={`relative tabular-nums text-left ${priceCls}`}>
        {fmtP(level.price)}
      </span>
      {/* Col 2: SHARES */}
      <span className="relative text-zinc-400 tabular-nums text-right">
        {fmtS(level.size)}
      </span>
      {/* Col 3: TOTAL (cumulative outward from mid) */}
      <span className="relative text-zinc-600 tabular-nums text-right">
        {fmtS(cumTotal)}
      </span>
    </button>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function MarketDetailPage() {
  const params      = useParams();
  const conditionId = decodeURIComponent(params.conditionId as string);

  // Market metadata from list endpoint
  const [mkt,       setMkt]       = useState<MarketMeta | null>(null);
  const [mktError,  setMktError]  = useState<string | null>(null);

  // Live order book
  const [book,        setBook]        = useState<BookData | null>(null);
  const [bookError,   setBookError]   = useState<string | null>(null);
  const [bookAge,     setBookAge]     = useState<Date | null>(null);
  const [bookLoading, setBookLoading] = useState(true);
  const pollRef        = useRef<ReturnType<typeof setInterval>>();
  const askContainerRef = useRef<HTMLDivElement>(null);

  // Trade ticket state
  const [side,      setSide]      = useState<Side>('BOTH');
  const [ticketPrice, setTicketPrice] = useState<string>('');
  const [ticketSize,  setTicketSize]  = useState<string>('');
  const [showTooltip, setShowTooltip] = useState(false);

  // YES / NO book toggle
  const [bookSide, setBookSide] = useState<'yes' | 'no'>('yes');

  // Fetch market metadata
  useEffect(() => {
    async function loadMeta() {
      try {
        const r = await fetch('/api/liquidity-rewards', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const m = (d.markets as MarketMeta[]).find(x => x.conditionId === conditionId);
        if (!m) { setMktError('Market not found in current data'); return; }
        setMkt(m);
        if (!ticketPrice && m.mid) setTicketPrice((m.mid).toFixed(3));
        if (!ticketSize)           setTicketSize(String(m.rewardsMinSize));
      } catch (e: unknown) {
        setMktError(e instanceof Error ? e.message : String(e));
      }
    }
    loadMeta();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conditionId]);

  // Fetch order book
  const fetchBook = useCallback(async () => {
    try {
      const r = await fetch(`/api/liquidity-rewards/book?conditionId=${encodeURIComponent(conditionId)}`, { cache: 'no-store' });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error || `HTTP ${r.status}`); }
      const d = await r.json() as BookData;
      setBook(d);
      setBookError(null);
      setBookAge(new Date());
    } catch (e: unknown) {
      setBookError(e instanceof Error ? e.message : String(e));
    } finally {
      setBookLoading(false);
    }
  }, [conditionId]);

  useEffect(() => {
    fetchBook();
    pollRef.current = setInterval(fetchBook, 4_000);
    return () => clearInterval(pollRef.current);
  }, [fetchBook]);

  // Scroll ask section to bottom (best ask adjacent to mid) whenever book data changes.
  // The ask container renders worst asks at top and best ask at bottom; without scrolling
  // the viewport shows the wrong end.
  useEffect(() => {
    const el = askContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [book, bookSide]);

  // ── Derived order book data
  const yesBids = book ? parseLevels(book.yes.bids).sort((a, b) => b.price - a.price) : [];
  const yesAsks = book ? parseLevels(book.yes.asks).sort((a, b) => a.price - b.price) : [];

  // Derive mid and spread from the live book so header, band, and estimates
  // always match what the ladder displays — never stale stored metadata.
  const liveBestBid = yesBids[0]?.price ?? null;
  const liveBestAsk = yesAsks[0]?.price ?? null;
  const liveSpread  = liveBestBid !== null && liveBestAsk !== null
    ? liveBestAsk - liveBestBid
    : null;
  const mid = liveBestBid !== null && liveBestAsk !== null
    ? (liveBestBid + liveBestAsk) / 2
    : mkt?.mid ?? 0.5;

  const halfBand  = mkt ? (mkt.rewardsMaxSpread / 100) / 2 : 0;
  const bandLo    = mid - halfBand;
  const bandHi    = mid + halfBand;

  // Parse NO book
  const noBids = book?.no ? parseLevels(book.no.bids).sort((a, b) => b.price - a.price) : [];
  const noAsks = book?.no ? parseLevels(book.no.asks).sort((a, b) => a.price - b.price) : [];

  // Active side
  const activeBids = bookSide === 'yes' ? yesBids : noBids;
  const activeAsks = bookSide === 'yes' ? yesAsks : noAsks;

  // Take the 15 BEST asks (lowest prices, closest to mid), display highest-of-those at top
  // so the best ask sits at the bottom of the section, directly above the mid row.
  const displayAsks = activeAsks.slice(0, 15).sort((a, b) => b.price - a.price);

  // Cumulative totals computed outward from mid
  const askCumMap = new Map<number, number>();
  let askRunning = 0;
  for (const lvl of [...activeAsks].sort((a, b) => a.price - b.price)) {
    askRunning += lvl.size;
    askCumMap.set(lvl.price, askRunning);
  }

  const bidCumMap = new Map<number, number>();
  let bidRunning = 0;
  for (const lvl of activeBids) { // already sorted highest→lowest
    bidRunning += lvl.size;
    bidCumMap.set(lvl.price, bidRunning);
  }

  const maxCumTotal = Math.max(askRunning, bidRunning, 1);

  // ── Trade ticket
  const tpNum     = parseFloat(ticketPrice);
  const tsNum     = parseFloat(ticketSize);
  const validInputs = mkt && !isNaN(tpNum) && tpNum > 0 && tpNum < 1 && !isNaN(tsNum) && tsNum > 0;

  const est = validInputs && mkt ? calcReward({
    price:            tpNum,
    size:             tsNum,
    side,
    mid,
    rewardsMaxSpread: mkt.rewardsMaxSpread,
    rewardsMinSize:   mkt.rewardsMinSize,
    bookBids:         yesBids,
    bookAsks:         yesAsks,
    rewardsDailyRate: mkt.rewardsDailyRate,
  }) : null;

  function handleClickPrice(p: number) {
    setTicketPrice(p.toFixed(3));
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (mktError) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8 font-mono">
        <Link href="/dashboard/liquidity-rewards" className="text-zinc-500 hover:text-zinc-300 text-xs">
          ← back
        </Link>
        <p className="mt-6 text-red-400 text-sm">{mktError}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">

        {/* Breadcrumb */}
        <Link
          href="/dashboard/liquidity-rewards"
          className="font-mono text-[11px] text-zinc-600 hover:text-zinc-400 uppercase tracking-widest"
        >
          ← Liquidity Rewards
        </Link>

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <p className="font-mono text-[10px] text-zinc-600 uppercase tracking-widest">
            Polymarket CLOB · live · read-only · no orders placed
          </p>
          {mkt ? (
            <>
              <h1 className="font-mono text-lg font-bold text-zinc-100 leading-snug">
                {mkt.question}
              </h1>
              <div className="flex flex-wrap gap-2 items-center">
                <span className={`font-mono text-[10px] px-1.5 py-px border uppercase ${VOL_CLS[mkt.volatilityRisk]}`}>
                  {mkt.volatilityRisk} risk
                </span>
                {mkt.negRisk && (
                  <span className="font-mono text-[10px] px-1.5 py-px border border-zinc-700 bg-zinc-800 text-zinc-500 uppercase">
                    negRisk
                  </span>
                )}
                <span className="font-mono text-[10px] px-1.5 py-px border border-zinc-700 bg-zinc-800 text-zinc-500">
                  pool ${mkt.rewardsDailyRate}/day
                </span>
                <span className="font-mono text-[10px] px-1.5 py-px border border-zinc-700 bg-zinc-800 text-zinc-500">
                  ±{mkt.rewardsMaxSpread}¢ band
                </span>
                <span className="font-mono text-[10px] px-1.5 py-px border border-zinc-700 bg-zinc-800 text-zinc-500">
                  min {mkt.rewardsMinSize} size
                </span>
                <span className="font-mono text-[10px] px-1.5 py-px border border-zinc-700 bg-zinc-800 text-zinc-500">
                  mid {(mid * 100).toFixed(1)}¢
                </span>
              </div>
            </>
          ) : (
            <div className="h-8 bg-zinc-800/40 animate-pulse rounded w-2/3" />
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

          {/* ── Order Book — Polymarket-style ──────────────────── */}
          <div className="border border-zinc-800 bg-zinc-900/50 flex flex-col">

            {/* Header: YES/NO toggle + live indicator */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
              <div className="flex items-center gap-3">
                <div className="flex gap-0.5">
                  <button
                    onClick={() => setBookSide('yes')}
                    className={`font-mono text-[10px] px-2.5 py-1 border transition-colors ${
                      bookSide === 'yes'
                        ? 'border-zinc-500 bg-zinc-700 text-zinc-100'
                        : 'border-zinc-700 bg-zinc-800/60 text-zinc-500 hover:text-zinc-400'
                    }`}
                  >
                    YES
                  </button>
                  <button
                    onClick={() => book?.no ? setBookSide('no') : undefined}
                    disabled={!book?.no}
                    className={`font-mono text-[10px] px-2.5 py-1 border transition-colors ${
                      bookSide === 'no'
                        ? 'border-zinc-500 bg-zinc-700 text-zinc-100'
                        : book?.no
                        ? 'border-zinc-700 bg-zinc-800/60 text-zinc-500 hover:text-zinc-400'
                        : 'border-zinc-800 bg-zinc-900/30 text-zinc-700 cursor-not-allowed'
                    }`}
                  >
                    NO
                  </button>
                </div>
                <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest">Order Book</span>
                {bookAge && !bookError && (
                  <span className="flex items-center gap-1 font-mono text-[9px] text-emerald-500">
                    <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
                    {ago(bookAge.toISOString())}
                  </span>
                )}
              </div>
              <button
                onClick={fetchBook}
                className="font-mono text-[9px] text-zinc-600 hover:text-zinc-400 uppercase"
              >
                ↻ refresh
              </button>
            </div>

            {bookError && (
              <div className="px-3 py-2 font-mono text-[11px] text-zinc-500">
                {bookError.includes('temporarily unavailable')
                  ? 'Order book unavailable — data refreshing, check back shortly'
                  : bookError}
              </div>
            )}

            {/* Band legend */}
            {mkt && (
              <div className="flex items-center gap-3 px-3 py-1.5 border-b border-zinc-800/60 bg-zinc-900">
                <span className="font-mono text-[9px] text-zinc-600 uppercase tracking-wider">Reward band:</span>
                <span className="font-mono text-[9px] text-emerald-500">{fmtP(bandLo)} – {fmtP(bandHi)}</span>
                <span className="font-mono text-[9px] text-zinc-700">levels inside earn rewards</span>
              </div>
            )}

            {/* Column headers */}
            <div className="grid grid-cols-3 px-2 py-1 font-mono text-[9px] text-zinc-700 uppercase border-b border-zinc-800/40">
              <span>Price</span>
              <span className="text-right">Shares</span>
              <span className="text-right">Total</span>
            </div>

            {/* ASK rows — highest price at top, descending toward mid */}
            <div ref={askContainerRef} className="flex flex-col max-h-[160px] overflow-y-auto scrollbar-thin">
              {displayAsks.length === 0 && !bookError && (
                bookLoading
                  ? <SkeletonRows />
                  : <div className="px-3 py-2 font-mono text-[10px] text-zinc-700 text-center">no asks</div>
              )}
              {displayAsks.map((l, i) => (
                <BookRow
                  key={`ask-${i}`}
                  level={l}
                  cumTotal={askCumMap.get(l.price) ?? 0}
                  maxCumTotal={maxCumTotal}
                  side="ask"
                  mid={mid}
                  halfBand={halfBand}
                  ticketPrice={!isNaN(tpNum) ? tpNum : null}
                  onClickPrice={handleClickPrice}
                />
              ))}
            </div>

            {/* Center spread row */}
            <div className="flex items-center gap-3 px-3 py-1.5 bg-zinc-800/70 border-y border-zinc-700/60">
              <span className="font-mono text-[11px] text-zinc-200 tabular-nums font-semibold">
                Mid {fmtP(mid)}
              </span>
              {liveSpread !== null && (
                <span className="font-mono text-[10px] text-zinc-500">
                  Spread {fmtP(liveSpread)}
                </span>
              )}
              {book?.yes?.last_trade_price && (
                <span className="font-mono text-[10px] text-zinc-600 ml-auto">
                  Last {(parseFloat(book.yes.last_trade_price) * 100).toFixed(1)}¢
                </span>
              )}
            </div>

            {/* BID rows — highest bid just below mid, descending */}
            <div className="flex flex-col max-h-[160px] overflow-y-auto scrollbar-thin">
              {activeBids.length === 0 && !bookError && (
                bookLoading
                  ? <SkeletonRows />
                  : <div className="px-3 py-2 font-mono text-[10px] text-zinc-700 text-center">no bids</div>
              )}
              {activeBids.map((l, i) => (
                <BookRow
                  key={`bid-${i}`}
                  level={l}
                  cumTotal={bidCumMap.get(l.price) ?? 0}
                  maxCumTotal={maxCumTotal}
                  side="bid"
                  mid={mid}
                  halfBand={halfBand}
                  ticketPrice={!isNaN(tpNum) ? tpNum : null}
                  onClickPrice={handleClickPrice}
                />
              ))}
            </div>

            {/* Depth summary */}
            {mkt && (
              <div className="px-3 py-2 border-t border-zinc-800 font-mono text-[10px] text-zinc-600">
                Existing depth in band: {fmtUsd(mkt.existing_depth_usd)} · pool {fmtUsd(mkt.rewardsDailyRate)}/day
              </div>
            )}
          </div>

          {/* ── Trade Ticket ────────────────────────────────────────── */}
          <div className="border border-zinc-800 bg-zinc-900/50 flex flex-col">

            {/* Preview banner */}
            <div className="bg-amber-950/40 border-b border-amber-700/40 px-3 py-2 text-center">
              <span className="font-mono text-[11px] font-bold text-amber-400 uppercase tracking-widest">
                PREVIEW · NO ORDER PLACED
              </span>
            </div>

            <div className="p-4 space-y-4 flex-1">

              {/* Side selector */}
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest">Side</label>
                <div className="flex gap-1.5">
                  {(['BUY', 'SELL', 'BOTH'] as Side[]).map(s => (
                    <button
                      key={s}
                      onClick={() => setSide(s)}
                      className={`flex-1 font-mono text-xs py-1.5 border transition-colors
                        ${side === s
                          ? s === 'BUY'  ? 'border-emerald-600 bg-emerald-950/50 text-emerald-300'
                          : s === 'SELL' ? 'border-red-700    bg-red-950/40      text-red-300'
                          :               'border-accent      bg-accent/10       text-accent'
                          : 'border-zinc-700 bg-zinc-800 text-zinc-500 hover:border-zinc-500'}`}
                    >
                      {s === 'BOTH' ? 'BOTH SIDES' : s}
                    </button>
                  ))}
                </div>
                {side === 'BOTH' && (
                  <p className="font-mono text-[10px] text-zinc-600">
                    Two-sided boost: ~2× score weight (Polymarket program benefit).
                  </p>
                )}
              </div>

              {/* Price input */}
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest">
                  Price (0–1) · or click a row in the book
                </label>
                <input
                  type="number"
                  min="0.001"
                  max="0.999"
                  step="0.001"
                  value={ticketPrice}
                  onChange={e => setTicketPrice(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 font-mono text-sm
                    px-3 py-2 focus:outline-none focus:border-zinc-500"
                  placeholder="e.g. 0.210"
                />
                {mkt && !isNaN(tpNum) && tpNum > 0 && (
                  <p className="font-mono text-[10px] text-zinc-600">
                    Distance from mid: {((Math.abs(tpNum - mid)) * 100).toFixed(2)}¢
                    {' '}· halfBand: {(halfBand * 100).toFixed(2)}¢
                  </p>
                )}
              </div>

              {/* Size input */}
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest">
                  Size (shares per side)
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={ticketSize}
                  onChange={e => setTicketSize(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-200 font-mono text-sm
                    px-3 py-2 focus:outline-none focus:border-zinc-500"
                  placeholder={mkt ? `min ${mkt.rewardsMinSize}` : '50'}
                />
                {mkt && !isNaN(tsNum) && (
                  <p className="font-mono text-[10px] text-zinc-600">
                    Notional ≈ {fmtUsd(tsNum * (isNaN(tpNum) ? mid : tpNum))}
                  </p>
                )}
              </div>

              {/* Estimate output */}
              {est && mkt && (
                <div className={`border p-3 space-y-2.5 ${
                  !est.inBand || !est.aboveMin
                    ? 'border-zinc-700 bg-zinc-800/40'
                    : 'border-emerald-800/50 bg-emerald-950/20'
                }`}>

                  {/* Qualification warnings */}
                  {!est.inBand && (
                    <div className="font-mono text-[11px] text-red-400 border border-red-800/50 bg-red-950/20 px-2 py-1.5">
                      Price outside reward band ({fmtP(bandLo)} – {fmtP(bandHi)}) · earns no liquidity reward
                    </div>
                  )}
                  {!est.aboveMin && (
                    <div className="font-mono text-[11px] text-orange-400 border border-orange-700/50 bg-orange-950/20 px-2 py-1.5">
                      Size {tsNum} &lt; min {mkt.rewardsMinSize} · won't qualify for rewards
                    </div>
                  )}

                  {/* Metrics */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    <Metric label="Distance from mid" value={`${((Math.abs(tpNum - mid)) * 100).toFixed(2)}¢`} />
                    <Metric label="Quadratic weight" value={`${(est.quadW * 100).toFixed(1)}%`} dim={!est.inBand} />
                    <Metric label="Effective $" value={fmtUsd(side === 'BOTH' ? est.dollarsPerSide * 2 : est.dollarsPerSide)} dim={!est.inBand} />
                    <Metric label="Est. pool share" value={`${(est.share * 100).toFixed(3)}%`} dim={!est.inBand} />
                  </div>

                  <div className={`border-t pt-2.5 ${est.inBand && est.aboveMin ? 'border-emerald-800/30' : 'border-zinc-700/30'}`}>
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest">Est. net reward</span>
                      <span className={`font-mono text-xl font-bold tabular-nums ${
                        !est.inBand || !est.aboveMin ? 'text-zinc-600' : 'text-emerald-400'
                      }`}>
                        {est.inBand && est.aboveMin ? fmtUsd(est.rewardDay) : '$0.00'}
                      </span>
                    </div>
                    <p className="font-mono text-[10px] text-zinc-600 text-right">
                      per day · exact price · net of platform fees · inv. risk not sub.
                    </p>
                    {est.bothBoost && est.inBand && est.aboveMin && (
                      <p className="font-mono text-[10px] text-emerald-700 mt-0.5 text-right">
                        two-sided: Q_min(bid Q, ask Q) — highest combined score
                      </p>
                    )}
                  </div>

                  <p className="font-mono text-[9px] text-zinc-700 leading-relaxed">
                    EST · NET OF PLATFORM FEES (maker fee 0%; gas ≈ $0) · S(v,s)=((v-s)/v)² · live CLOB snapshot ·
                    share compresses as makers enter · inventory/adverse-fill risk NOT modelled.
                  </p>
                </div>
              )}

              {/* Auto-mirror toggle (ghost / placeholder) */}
              <div className="border border-zinc-800/50 bg-zinc-900/30 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-zinc-600 uppercase tracking-widest">
                    Auto-mirror on fill
                  </span>
                  <div
                    className="relative w-8 h-4 bg-zinc-800 border border-zinc-700 rounded-full opacity-40 cursor-not-allowed"
                    title="Coming with API keys"
                  >
                    <span className="absolute left-0.5 top-0.5 w-3 h-3 bg-zinc-600 rounded-full" />
                  </div>
                </div>
                <p className="font-mono text-[9px] text-zinc-700 leading-relaxed">
                  Live mode — coming when API keys are added.{' '}
                  <span
                    className="underline decoration-dotted cursor-help text-zinc-600"
                    onMouseEnter={() => setShowTooltip(true)}
                    onMouseLeave={() => setShowTooltip(false)}
                  >
                    Mirror ≠ free hedge
                  </span>
                  {showTooltip && (
                    <span className="absolute z-10 ml-2 w-56 bg-zinc-800 border border-zinc-700 p-2 text-[9px] text-zinc-400 leading-relaxed shadow-lg">
                      Adverse-fill risk: when your order fills, you bought/sold against informed flow.
                      Mirroring on the other side incurs a second round of adverse selection —
                      it is NOT a free hedge.
                    </span>
                  )}
                </p>
              </div>

            </div>
          </div>
        </div>

        {/* ── Market detail stats ──────────────────────────────────── */}
        {mkt && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatBox label="Pool $/day" value={`$${mkt.rewardsDailyRate}`} />
              <StatBox label="Max spread" value={`±${mkt.rewardsMaxSpread}¢`} />
              <StatBox label="Min size" value={String(mkt.rewardsMinSize)} />
              <StatBox label="Existing depth" value={fmtUsd(mkt.existing_depth_usd)} />
            </div>

            {/* Per-capital typical estimate + range */}
            <div className="border border-zinc-800 bg-zinc-900/30">
              <div className="px-3 py-2 border-b border-zinc-800">
                <span className="font-mono text-[10px] text-zinc-500 uppercase tracking-widest">
                  Est. reward · typical placement · range low–high
                </span>
              </div>
              <div className="grid grid-cols-3 divide-x divide-zinc-800">
                {(['500', '5000', '50000'] as const).map(key => {
                  const lv = mkt.levels?.[key];
                  if (!lv) return null;
                  const capLabel = key === '500' ? '$500' : key === '5000' ? '$5k' : '$50k';
                  return (
                    <div key={key} className="px-3 py-2.5 space-y-0.5">
                      <div className="font-mono text-[10px] text-zinc-600 uppercase">{capLabel}</div>
                      <div className="font-mono text-sm font-semibold text-emerald-400 tabular-nums">
                        {fmtUsd(lv.netRewardDay ?? lv.grossRewardDay)}/day
                      </div>
                      <div className="font-mono text-[10px] text-zinc-500 tabular-nums">
                        {(lv.share * 100).toFixed(2)}% share
                      </div>
                      {(lv.netLow ?? lv.grossLow) != null && (lv.netHigh ?? lv.grossHigh) != null && (
                        <div className="font-mono text-[9px] text-zinc-700 tabular-nums">
                          range {fmtUsd(lv.netLow ?? lv.grossLow!)}–{fmtUsd(lv.netHigh ?? lv.grossHigh!)}
                        </div>
                      )}
                      {lv.flags.length > 0 && (
                        <div className="font-mono text-[9px] text-orange-400">{lv.flags[0].split('—')[0].trim()}</div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="px-3 py-1.5 border-t border-zinc-800">
                <p className="font-mono text-[9px] text-zinc-700">
                  EST · NET OF PLATFORM FEES · S(v,s)=((v-s)/v)² · typical s=v/2 · range: outer-band s=0.8v → near-mid s=0.1¢ · inv. risk not sub.
                </p>
              </div>
            </div>
          </>
        )}

        {/* Disclaimer */}
        <div className="border-t border-zinc-800 pt-4">
          <p className="font-mono text-[10px] text-zinc-700 leading-relaxed">
            Polymarket CLOB data is public and read-only. No trades are placed, no keys are used.
            All reward figures are NET OF PLATFORM FEES estimates (maker fee 0%; gas ≈ $0) — inventory/adverse-fill risk is not subtracted.
            Not financial advice.
          </p>
        </div>

      </div>
    </div>
  );
}

// ── Small helper components ────────────────────────────────────────────────────

function SkeletonRows({ count = 7 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="grid grid-cols-3 px-2 py-[4px] gap-2 animate-pulse">
          <span className="h-2.5 bg-zinc-800 rounded w-10" />
          <span className="h-2.5 bg-zinc-800 rounded w-8 ml-auto" />
          <span className="h-2.5 bg-zinc-800 rounded w-8 ml-auto" />
        </div>
      ))}
    </>
  );
}

function Metric({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div>
      <div className="font-mono text-[9px] text-zinc-600 uppercase tracking-wider">{label}</div>
      <div className={`font-mono text-sm tabular-nums ${dim ? 'text-zinc-600' : 'text-zinc-300'}`}>{value}</div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-zinc-800 bg-zinc-900 p-3">
      <div className="font-mono text-sm font-semibold text-zinc-200 tabular-nums">{value}</div>
      <div className="font-mono text-[10px] text-zinc-600 uppercase mt-0.5">{label}</div>
    </div>
  );
}

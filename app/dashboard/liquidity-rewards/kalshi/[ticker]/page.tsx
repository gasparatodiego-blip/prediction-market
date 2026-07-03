'use client';

import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import PlatformLogo from '@/components/PlatformLogo';
import { Redacted, RedactedPanel } from '@/app/components/ui/Redacted';

// ── Types ──────────────────────────────────────────────────────────────────────
// Sensitive fields null on free tier (server-side redaction, lib/paid-gating.ts).
// The live orderbook (raw.orderbook_fp) is redacted as a WHOLE field — see
// REDACTION_MAP['kalshi-rewards-book'] — parseKalshiBook() already degrades to
// empty arrays gracefully (`raw.orderbook_fp ?? {}`), so no crash risk there,
// but pool_day is the reliable proxy for gating the CTA panel (below).

interface KLevelData {
  aboveMin:       boolean;
  share:          number | null;
  bidShare:       number | null;
  askShare:       number | null;
  grossRewardDay: number | null;
  dayYieldPct:    number | null;
  netRewardDay?:  number | null;
  netYieldPct?:   number | null;
}

interface KMarket {
  ticker:                     string;
  question:                   string;
  pool_day:                   number | null;
  total_period_usd:           number | null;
  period_days:                number;
  period_start:               string;
  period_end:                 string;
  min_size:                   number;
  fee_discount_pct:           number;
  last_price:                 number | null;
  book_mid:                   number | null;
  best_bid:                   number | null;
  best_ask:                   number | null;
  competitor_qualifying_bids: number | null;
  competitor_qualifying_asks: number | null;
  levels:                     Record<string, KLevelData>;
  flags: {
    TRAP:        boolean;
    SHORT_BURST: boolean;
    BELOW_FLOOR: boolean;
    THIN_CAP:    boolean;
    ONE_SIDED:   boolean;
  };
  trap_reason:   string | null;
  scoring_model: string;
}

// Kalshi book level — price in [0,1], size in USD
interface KLevel {
  price: number;
  usd:   number;
}

// Parsed from orderbook_fp.yes_dollars / no_dollars
// yes_dollars = YES bids; no_dollars = NO bids
// YES asks derived: yes_ask_price = 1 − no_bid_price
// NO asks derived:  no_ask_price  = 1 − yes_bid_price
interface KBook {
  yesBids: KLevel[];   // people buying YES — bid side of YES book
  noBids:  KLevel[];   // people buying NO  — bid side of NO book
  fetchedAt: string;
}

type BookSide = 'yes' | 'no';
type TicketSide = 'BOTH' | 'BUY' | 'SELL';

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtP(n: number) { return (n * 100).toFixed(0) + '¢'; }
function fmtPFull(n: number) { return (n * 100).toFixed(1) + '¢'; }

function fmtUsd(n: number) {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(1) + 'k';
  if (n >= 10)    return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
}

function ago(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)   return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

function isWarnPrice(p: number): boolean {
  return (p >= 0.80 && p <= 0.90) || (p >= 0.10 && p <= 0.20);
}

const OBSERVED_MODEL_FULL =
  "Kalshi hasn't published its LIP scoring formula. This is an inferred flat " +
  "pro-rata model, not official. Kalshi LIP competition is currently thin, so " +
  "yields read higher than Polymarket and will compress as makers enter. Estimate only.";

function ObservedModelChip() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center">
      <button
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-1 px-2 py-0.5 border border-gold/40
          bg-gold/5 text-gold font-body text-[9px] uppercase tracking-wide
          hover:bg-gold/5/50 transition-colors"
        aria-expanded={open}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-gold/70 shrink-0" />
        OBSERVED MODEL · estimate
        <span className="text-gold/70 ml-0.5">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <span
          className="absolute top-full left-0 z-20 mt-1.5 w-72 border border-gold/40
            bg-surface shadow-lg px-3 py-2.5"
        >
          <p className="font-mono text-[10px] text-gold/80 leading-relaxed">
            {OBSERVED_MODEL_FULL}
          </p>
          <button
            onClick={() => setOpen(false)}
            className="font-mono text-[9px] text-muted/70 hover:text-ink-2 mt-1.5"
          >
            close ✕
          </button>
        </span>
      )}
    </span>
  );
}

// Parse raw Kalshi book response
function parseKalshiBook(raw: Record<string, unknown>): KBook {
  const ob = (raw.orderbook_fp ?? {}) as Record<string, [string, string][]>;
  const yesRaw = ob.yes_dollars ?? [];
  const noRaw  = ob.no_dollars  ?? [];

  const yesBids: KLevel[] = yesRaw
    .map(([p, u]) => ({ price: parseFloat(p), usd: parseFloat(u) }))
    .filter(l => l.price > 0 && l.usd > 0)
    .sort((a, b) => b.price - a.price);

  const noBids: KLevel[] = noRaw
    .map(([p, u]) => ({ price: parseFloat(p), usd: parseFloat(u) }))
    .filter(l => l.price > 0 && l.usd > 0)
    .sort((a, b) => b.price - a.price);

  return { yesBids, noBids, fetchedAt: raw.fetchedAt as string ?? new Date().toISOString() };
}

// Derive ask levels from the opposite-side bids
// YES asks come from NO bids:  yes_ask_price = 1 − no_bid_price
// NO asks come from YES bids:  no_ask_price  = 1 − yes_bid_price
function deriveAsks(bids: KLevel[]): KLevel[] {
  return bids
    .map(l => ({ price: parseFloat((1 - l.price).toFixed(4)), usd: l.usd }))
    .filter(l => l.price > 0 && l.price < 1)
    .sort((a, b) => a.price - b.price);
}

// ── Reward calculator (flat pro-rata, OBSERVED MODEL) ─────────────────────────

interface RewardResult {
  userShares:          number;
  aboveMin:            boolean;
  competitorBidShares: number;
  competitorAskShares: number;
  bidShare:            number;
  askShare:            number;
  share:               number;
  rewardDay:           number;
}

function calcKalshiReward(params: {
  userShares: number;
  minSize:    number;
  yesBids:    KLevel[];
  noBids:     KLevel[];
  poolDay:    number;
  side:       TicketSide;
}): RewardResult {
  const { userShares, minSize, yesBids, noBids, poolDay, side } = params;

  // Convert USD book levels → shares for qualifying depth
  // YES bid shares: shares = usd / price
  let competitorBidShares = 0;
  for (const l of yesBids) {
    if (l.price <= 0) continue;
    const shares = l.usd / l.price;
    if (shares >= minSize) competitorBidShares += shares;
  }

  // YES ask shares come from NO bids: yes_ask_price = 1 - no_price, shares = usd / yes_ask_price
  let competitorAskShares = 0;
  for (const l of noBids) {
    const askPrice = 1 - l.price;
    if (askPrice <= 0 || askPrice >= 1) continue;
    const shares = l.usd / askPrice;
    if (shares >= minSize) competitorAskShares += shares;
  }

  const aboveMin = userShares >= minSize;

  if (!aboveMin || userShares <= 0) {
    return { userShares, aboveMin, competitorBidShares, competitorAskShares,
             bidShare: 0, askShare: 0, share: 0, rewardDay: 0 };
  }

  const bidShare = competitorBidShares > 0
    ? userShares / (userShares + competitorBidShares)
    : 1.0;

  const askShare = competitorAskShares > 0
    ? userShares / (userShares + competitorAskShares)
    : 1.0;

  // LIP requires both sides; share = min(bid, ask) for BOTH
  const share = side === 'BOTH' ? Math.min(bidShare, askShare)
              : side === 'BUY'  ? bidShare
              :                   askShare;

  return { userShares, aboveMin, competitorBidShares, competitorAskShares,
           bidShare, askShare, share, rewardDay: share * poolDay };
}

// ── Book row component ─────────────────────────────────────────────────────────

function KBookRow({
  level,
  cumUsd,
  maxCumUsd,
  side,
  onClickPrice,
}: {
  level:        KLevel;
  cumUsd:       number;
  maxCumUsd:    number;
  side:         'bid' | 'ask';
  onClickPrice: (p: number) => void;
}) {
  const barPct   = maxCumUsd > 0 ? Math.min((cumUsd / maxCumUsd) * 100, 100) : 0;
  const isAsk    = side === 'ask';
  const priceCls = isAsk ? 'text-coral-ink' : 'text-mint-deep';
  const barCls   = isAsk ? 'bg-coral-tint/60' : 'bg-mint-tint/60';

  return (
    <button
      onClick={() => onClickPrice(level.price)}
      className="w-full relative grid grid-cols-3 items-center text-[11px] font-mono
        px-2 py-[3px] transition-colors hover:bg-bg-soft/40"
    >
      <span
        className={`absolute inset-y-0 right-0 ${barCls}`}
        style={{ width: `${barPct}%`, pointerEvents: 'none' }}
      />
      <span className={`relative tabular-nums text-left ${priceCls}`}>
        {fmtP(level.price)}
      </span>
      <span className="relative text-muted tabular-nums text-right">
        {fmtUsd(level.usd)}
      </span>
      <span className="relative text-muted/70 tabular-nums text-right">
        {fmtUsd(cumUsd)}
      </span>
    </button>
  );
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function SkeletonRows({ count = 7 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="grid grid-cols-3 px-2 py-[4px] gap-2 animate-pulse">
          <span className="h-2.5 bg-bg-soft rounded w-10" />
          <span className="h-2.5 bg-bg-soft rounded w-8 ml-auto" />
          <span className="h-2.5 bg-bg-soft rounded w-8 ml-auto" />
        </div>
      ))}
    </>
  );
}

function Metric({ label, value, dim }: { label: string; value: ReactNode; dim?: boolean }) {
  return (
    <div>
      <div className="font-body text-[9px] text-muted/70 uppercase tracking-wider">{label}</div>
      <div className={`font-mono text-sm tabular-nums'}`}>{value}</div>
    </div>
  );
}

function StatBox({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="border border-line bg-surface rounded-card p-3">
      <div className="font-mono text-sm font-semibold text-ink tabular-nums">{value}</div>
      <div className="font-body text-[10px] text-muted/70 uppercase mt-0.5">{label}</div>
      {sub && <div className="font-body text-[9px] text-muted/50 mt-0.5">{sub}</div>}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function KalshiMarketDetailPage() {
  const params = useParams();
  const ticker = decodeURIComponent(params.ticker as string);

  // Market metadata
  const [mkt,      setMkt]      = useState<KMarket | null>(null);
  const [mktError, setMktError] = useState<string | null>(null);

  // Live order book
  const [book,        setBook]        = useState<KBook | null>(null);
  const [bookError,   setBookError]   = useState<string | null>(null);
  const [bookAge,     setBookAge]     = useState<Date | null>(null);
  const [bookLoading, setBookLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const askContainerRef = useRef<HTMLDivElement>(null);

  // UI state
  const [bookSide,    setBookSide]    = useState<BookSide>('yes');
  const [ticketSide,  setTicketSide]  = useState<TicketSide>('BOTH');
  const [ticketPrice, setTicketPrice] = useState<string>('');
  const [ticketSize,  setTicketSize]  = useState<string>('');
  const [howToOpen,   setHowToOpen]   = useState(false);

  // Load market metadata
  useEffect(() => {
    async function loadMeta() {
      try {
        const r = await fetch('/api/kalshi-rewards', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const m = (d.markets as KMarket[]).find(x => x.ticker === ticker);
        if (!m) { setMktError(`Market ${ticker} not found in current scan`); return; }
        setMkt(m);
        const defaultPrice = m.book_mid ?? m.last_price;
        if (!ticketPrice && defaultPrice != null) setTicketPrice(defaultPrice.toFixed(3));
        if (!ticketSize)  setTicketSize(String(m.min_size));
      } catch (e: unknown) {
        setMktError(e instanceof Error ? e.message : String(e));
      }
    }
    loadMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  // Fetch live book
  const fetchBook = useCallback(async () => {
    try {
      const r = await fetch(`/api/kalshi-rewards/book?ticker=${encodeURIComponent(ticker)}`, { cache: 'no-store' });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? `HTTP ${r.status}`); }
      const raw = await r.json() as Record<string, unknown>;
      setBook(parseKalshiBook(raw));
      setBookError(null);
      setBookAge(new Date());
    } catch (e: unknown) {
      setBookError(e instanceof Error ? e.message : String(e));
    } finally {
      setBookLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    fetchBook();
    pollRef.current = setInterval(fetchBook, 4_000);
    return () => clearInterval(pollRef.current);
  }, [fetchBook]);

  // Scroll ask section to bottom so best ask sits adjacent to mid row.
  // requestAnimationFrame defers until after browser layout is committed.
  useEffect(() => {
    const el = askContainerRef.current;
    if (!el) return;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [book, bookSide]);

  // ── Derived book data ─────────────────────────────────────────────────────────

  const yesBids  = book?.yesBids ?? [];
  const noBids   = book?.noBids  ?? [];

  // YES asks derived from NO bids: yes_ask_price = 1 - no_bid_price
  const yesAsks = deriveAsks(noBids); // sorted ascending (best ask first)

  // NO asks derived from YES bids: no_ask_price = 1 - yes_bid_price
  const noAsks  = deriveAsks(yesBids); // sorted ascending

  // Mid from live book (NOT from stored metadata)
  const liveBestYesBid = yesBids[0]?.price ?? null;
  const liveBestYesAsk = yesAsks[0]?.price ?? null;
  const liveMid        = liveBestYesBid !== null && liveBestYesAsk !== null
    ? (liveBestYesBid + liveBestYesAsk) / 2
    : (mkt?.book_mid ?? mkt?.last_price ?? 0.5);
  // Display-only — null (not the internal 0.5 layout fallback above) when
  // there's no real mid, so the header never shows a fabricated 50¢.
  const displayMid     = liveBestYesBid !== null && liveBestYesAsk !== null
    ? liveMid
    : mkt?.book_mid ?? mkt?.last_price ?? null;
  const liveSpread     = liveBestYesBid !== null && liveBestYesAsk !== null
    ? liveBestYesAsk - liveBestYesBid : null;

  // Active side for display
  const activeBids = bookSide === 'yes' ? yesBids : noBids;
  const activeAsks = bookSide === 'yes' ? yesAsks : noAsks;

  // For asks: show worst-to-best (worst at top, best at bottom near mid) — 15 levels max
  // Sorted ascending → reverse for display (so highest ask at top, scroll reveals best ask)
  const displayAsks = [...activeAsks].slice(0, 15).sort((a, b) => b.price - a.price);

  // Cumulative USD totals outward from mid
  const askCumMap = new Map<number, number>();
  let askRunning = 0;
  for (const lvl of [...activeAsks].sort((a, b) => a.price - b.price)) {
    askRunning += lvl.usd;
    askCumMap.set(lvl.price, askRunning);
  }
  const bidCumMap = new Map<number, number>();
  let bidRunning = 0;
  for (const lvl of activeBids) {
    bidRunning += lvl.usd;
    bidCumMap.set(lvl.price, bidRunning);
  }
  const maxCumUsd = Math.max(askRunning, bidRunning, 1);

  // ── Trade ticket ──────────────────────────────────────────────────────────────

  const tpNum = parseFloat(ticketPrice);
  const tsNum = parseFloat(ticketSize);
  const validInputs = mkt && !isNaN(tpNum) && tpNum > 0 && tpNum < 1 && !isNaN(tsNum) && tsNum > 0;

  // pool_day/total_period_usd/last_price/etc are redacted together as a set
  // for free tier — pool_day is a reliable single proxy (see REDACTION_MAP).
  const isRedacted = mkt != null && mkt.pool_day == null;

  const est = (validInputs && mkt && mkt.pool_day != null) ? calcKalshiReward({
    userShares: tsNum,
    minSize:    mkt.min_size,
    yesBids,
    noBids,
    poolDay:    mkt.pool_day,
    side:       ticketSide,
  }) : null;

  function handleClickPrice(p: number) { setTicketPrice(p.toFixed(3)); }

  // ── Flags ─────────────────────────────────────────────────────────────────────

  const isTrap  = mkt?.flags.TRAP ?? false;
  const isWarn  = mkt?.last_price != null ? isWarnPrice(mkt.last_price) : false;
  const isBurst = mkt?.flags.SHORT_BURST ?? false;

  // ── Error state ───────────────────────────────────────────────────────────────

  if (mktError) {
    return (
      <div className="min-h-screen bg-bg text-ink p-8 font-body">
        <Link href="/dashboard/liquidity-rewards" className="text-muted hover:text-ink-2 text-xs">
          ← Kalshi LIP Rewards
        </Link>
        <p className="mt-6 text-coral-ink text-sm">{mktError}</p>
        <p className="mt-2 text-muted/70 text-xs">Ticker: {ticker}</p>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-bg text-ink">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">

        {/* Breadcrumb */}
        <div className="flex items-center gap-3 flex-wrap">
          <Link
            href="/dashboard/liquidity-rewards"
            className="font-body text-[11px] text-muted hover:text-ink-2 uppercase tracking-widest"
          >
            ← Liquidity Rewards
          </Link>
          <span className="font-body text-[10px] text-muted/50">·</span>
          <span className="font-body text-[10px] text-muted uppercase tracking-widest inline-flex items-center gap-1">
            <PlatformLogo platform="kalshi" size={11} />
            Kalshi · live · read-only · no orders placed
          </span>
          <ObservedModelChip />
        </div>

        {/* Market header */}
        <div className="space-y-2">
          {mkt ? (
            <>
              <div className="font-body text-[10px] text-muted uppercase tracking-wider">
                {ticker}
              </div>
              <h1 className="font-display text-lg font-bold text-ink leading-snug">
                {mkt.question}
              </h1>
              <div className="flex flex-wrap gap-2 items-center">
                <span className="font-body text-[10px] px-1.5 py-px border border-line bg-bg-soft text-muted">
                  pool $<Redacted value={mkt.pool_day}>{v => v.toFixed(0)}</Redacted>/day
                </span>
                <span className="font-body text-[10px] px-1.5 py-px border border-line bg-bg-soft text-muted">
                  $<Redacted value={mkt.total_period_usd}>{v => v.toFixed(0)}</Redacted> period total
                </span>
                <span className="font-body text-[10px] px-1.5 py-px border border-line bg-bg-soft text-muted">
                  min {mkt.min_size.toLocaleString()} shares
                </span>
                <span className="font-body text-[10px] px-1.5 py-px border border-line bg-bg-soft text-muted">
                  {mkt.fee_discount_pct}% fee discount
                </span>
                <span className="font-body text-[10px] px-1.5 py-px border border-line bg-bg-soft text-muted">
                  last <Redacted value={mkt.last_price}>{v => (v * 100).toFixed(0)}</Redacted>¢
                </span>
                <span className="font-body text-[10px] px-1.5 py-px border border-line bg-bg-soft text-muted">
                  {mkt.period_days.toFixed(1)}d period
                </span>
                {isTrap && (
                  <span className="font-body text-[10px] px-1.5 py-px border border-coral-ink/50 bg-coral-tint/30 text-coral-ink uppercase rounded-sm">
                    TRAP
                  </span>
                )}
                {isWarn && !isTrap && (
                  <span className="font-mono text-[10px] px-1.5 py-px border border-gold/40 bg-gold/5/30 text-gold uppercase">
                    WARN · lopsided
                  </span>
                )}
                {isBurst && (
                  <span className="font-body text-[10px] px-1.5 py-px border border-gold/50 bg-gold/5 text-gold uppercase rounded-sm">
                    SHORT BURST
                  </span>
                )}
              </div>

              {/* TRAP warning */}
              {isTrap && mkt.trap_reason && (
                <div className="border border-coral-ink/40 bg-coral-tint/30 px-3 py-2 font-body text-[11px] text-coral-ink rounded-sm">
                  {mkt.trap_reason} — near-certain outcome, one side of the book is nearly empty.
                  Adverse fill risk is extreme. Do not promote this market.
                </div>
              )}
            </>
          ) : (
            <>
              <div className="h-4 bg-bg-soft/40 animate-pulse rounded w-32" />
              <div className="h-7 bg-bg-soft/40 animate-pulse rounded w-3/4" />
            </>
          )}
        </div>

        {/* ── Two-panel: book + ticket ─────────────────────────────────────────── */}
        {isRedacted ? (
          <RedactedPanel label="The live order book, trade ticket calculator, and per-capital reward estimates are available on Pro" />
        ) : (
        <>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

          {/* ORDER BOOK */}
          <div className="border border-line bg-surface/50 rounded-card flex flex-col">

            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-line">
              <div className="flex items-center gap-3">
                <div className="flex gap-0.5">
                  {(['yes', 'no'] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => setBookSide(s)}
                      className={`font-body text-[10px] px-2.5 py-1 border transition-colors ${
                        bookSide === s
                          ? 'border-ink-2/50 bg-bg-soft text-ink'
                          : 'border-line bg-surface/50 text-muted hover:text-ink-2'
                      }`}
                    >
                      {s.toUpperCase()}
                    </button>
                  ))}
                </div>
                <span className="font-body text-[10px] text-muted uppercase tracking-widest">
                  {bookSide === 'yes' ? 'YES book' : 'NO book'}
                </span>
                {bookAge && !bookError && (
                  <span className="flex items-center gap-1 font-body text-[9px] text-mint-deep">
                    <span className="w-1 h-1 rounded-full bg-mint-deep animate-pulse" />
                    {ago(bookAge.toISOString())}
                  </span>
                )}
              </div>
              <button
                onClick={fetchBook}
                className="font-body text-[9px] text-muted hover:text-ink-2 uppercase"
              >
                ↻
              </button>
            </div>

            {/* Note about structure */}
            <div className="px-3 py-1.5 bg-surface/80 border-b border-line/40">
              <p className="font-body text-[9px] text-muted/50 leading-relaxed">
                {bookSide === 'yes'
                  ? 'YES bids from API · YES asks derived from NO bids (1 − no_price)'
                  : 'NO bids from API · NO asks derived from YES bids (1 − yes_price)'}
              </p>
            </div>

            {bookError && (
              <div className="px-3 py-2 font-body text-[11px] text-muted">
                {bookError}
              </div>
            )}

            {/* Column headers */}
            <div className="grid grid-cols-3 px-2 py-1 font-body text-[9px] text-muted/50 uppercase border-b border-line/40">
              <span>Price</span>
              <span className="text-right">$USD</span>
              <span className="text-right">Σ$</span>
            </div>

            {/* ASK rows (worst price at top, best at bottom near mid) */}
            <div ref={askContainerRef} className="flex flex-col max-h-[160px] overflow-y-auto scrollbar-thin">
              {displayAsks.length === 0 && !bookError && (
                bookLoading
                  ? <SkeletonRows />
                  : <div className="px-3 py-2 font-body text-[10px] text-muted/50 text-center">
                      no asks · {bookSide === 'yes' ? 'NO bids empty' : 'YES bids empty'}
                    </div>
              )}
              {displayAsks.map((l, i) => (
                <KBookRow
                  key={`ask-${i}`}
                  level={l}
                  cumUsd={askCumMap.get(l.price) ?? 0}
                  maxCumUsd={maxCumUsd}
                  side="ask"
                  onClickPrice={handleClickPrice}
                />
              ))}
            </div>

            {/* Mid/spread row */}
            <div className="flex items-center gap-3 px-3 py-1.5 bg-bg-soft/70 border-y border-line/60">
              <span className="font-mono text-[11px] text-ink tabular-nums font-semibold">
                Mid {fmtPFull(liveMid)}
              </span>
              {liveSpread !== null && (
                <span className="font-body text-[10px] text-muted">
                  Spread {fmtPFull(liveSpread)}
                </span>
              )}
              <span className="font-body text-[9px] text-muted/50 ml-auto">from live book</span>
            </div>

            {/* BID rows */}
            <div className="flex flex-col max-h-[160px] overflow-y-auto scrollbar-thin">
              {activeBids.length === 0 && !bookError && (
                bookLoading
                  ? <SkeletonRows />
                  : <div className="px-3 py-2 font-body text-[10px] text-muted/50 text-center">no bids</div>
              )}
              {activeBids.map((l, i) => (
                <KBookRow
                  key={`bid-${i}`}
                  level={l}
                  cumUsd={bidCumMap.get(l.price) ?? 0}
                  maxCumUsd={maxCumUsd}
                  side="bid"
                  onClickPrice={handleClickPrice}
                />
              ))}
            </div>

            {/* Depth footer */}
            <div className="px-3 py-2 border-t border-line font-body text-[10px] text-muted/70">
              {mkt && <>pool $<Redacted value={mkt.pool_day}>{v => v.toFixed(0)}</Redacted>/day · min {mkt.min_size.toLocaleString()} shares</>}
              {' '}· Kalshi · read-only
            </div>
          </div>

          {/* TRADE TICKET */}
          <div className="border border-line bg-surface/50 rounded-card flex flex-col">

            {/* Preview banner */}
            <div className="bg-gold/5 border-b border-gold/40 px-3 py-2 text-center">
              <span className="font-body text-[11px] font-bold text-gold uppercase tracking-widest">
                PREVIEW · NO ORDER PLACED
              </span>
            </div>

            <div className="p-4 space-y-4 flex-1">

              {/* Posting side */}
              <div className="space-y-1.5">
                <label className="font-body text-[10px] text-muted uppercase tracking-widest">
                  Side
                </label>
                <div className="flex gap-1.5">
                  {(['BOTH', 'BUY', 'SELL'] as TicketSide[]).map(s => (
                    <button
                      key={s}
                      onClick={() => setTicketSide(s)}
                      className={`flex-1 font-body text-xs py-1.5 border transition-colors
                        ${ticketSide === s
                          ? s === 'BUY'  ? 'border-mint-deep/60 bg-mint-tint/50 text-mint-deep'
                          : s === 'SELL' ? 'border-coral-ink/50    bg-coral-tint/40      text-coral-ink'
                          :               'border-mint bg-mint/10 text-mint'
                          : 'border-line bg-bg-soft text-muted hover:border-muted'}`}
                    >
                      {s === 'BOTH' ? 'BOTH SIDES' : s === 'BUY' ? 'BUY YES' : 'SELL YES'}
                    </button>
                  ))}
                </div>
                <p className="font-body text-[10px] text-muted/70">
                  {ticketSide === 'BOTH'
                    ? 'Two-sided: LIP typically requires both sides. share = min(bid, ask).'
                    : ticketSide === 'BUY'
                    ? 'BUY YES: posting YES bids. Partial only — LIP may require two-sided posting.'
                    : 'SELL YES / BUY NO: posting on ask side. LIP may require two-sided posting.'}
                </p>
              </div>

              {/* Price */}
              <div className="space-y-1.5">
                <label className="font-body text-[10px] text-muted uppercase tracking-widest">
                  Price (0–1) · click a row in the book
                </label>
                <input
                  type="number" min="0.01" max="0.99" step="0.01"
                  value={ticketPrice}
                  onChange={e => setTicketPrice(e.target.value)}
                  className="w-full bg-bg-soft border border-line text-ink font-mono text-sm
                    px-3 py-2 focus:outline-none focus:border-ink-2/50"
                  placeholder="e.g. 0.30"
                />
                {!isNaN(tpNum) && tpNum > 0 && (
                  <p className="font-body text-[10px] text-muted/70">
                    {fmtPFull(tpNum)} · mid {fmtPFull(liveMid)} · spread {liveSpread !== null ? fmtPFull(liveSpread) : '—'}
                  </p>
                )}
              </div>

              {/* Size */}
              <div className="space-y-1.5">
                <label className="font-body text-[10px] text-muted uppercase tracking-widest">
                  Size (shares per side)
                </label>
                <input
                  type="number" min="1" step="1"
                  value={ticketSize}
                  onChange={e => setTicketSize(e.target.value)}
                  className="w-full bg-bg-soft border border-line text-ink font-mono text-sm
                    px-3 py-2 focus:outline-none focus:border-ink-2/50"
                  placeholder={mkt ? `min ${mkt.min_size.toLocaleString()}` : '1000'}
                />
                {mkt && !isNaN(tsNum) && !isNaN(tpNum) && tpNum > 0 && (
                  <p className="font-body text-[10px] text-muted/70">
                    Notional ≈ {fmtUsd(tsNum * tpNum)} at {fmtPFull(tpNum)}
                    {mkt.min_size > 0 && ` · min ${mkt.min_size.toLocaleString()} shares`}
                  </p>
                )}
              </div>

              {/* Estimate output */}
              {est && mkt && (
                <div className={`border p-3 space-y-2.5 ${
                  !est.aboveMin
                    ? 'border-line bg-bg-soft/40'
                    : isTrap
                    ? 'border-coral-ink/40/50 bg-coral-tint/10'
                    : 'border-mint/40/50 bg-mint-tint/20'
                }`}>

                  {/* Warnings */}
                  {!est.aboveMin && (
                    <div className="font-mono text-[11px] text-gold border border-gold/50/50 bg-gold/5/20 px-2 py-1.5">
                      Size {tsNum.toFixed(0)} &lt; min {mkt.min_size.toLocaleString()} shares · won't qualify for rewards
                    </div>
                  )}
                  {isTrap && (
                    <div className="font-mono text-[11px] text-coral-ink border border-coral-ink/40/50 bg-coral-tint/20 px-2 py-1.5">
                      TRAP market — near-certain outcome, one side nearly empty. Adverse fill risk is extreme.
                    </div>
                  )}
                  {isWarn && !isTrap && (
                    <div className="font-mono text-[11px] text-gold border border-gold/40/50 bg-gold/5/20 px-2 py-1.5">
                      WARN: lopsided price ({fmtPFull(mkt.last_price!)}) — adverse fill risk elevated on one side.
                    </div>
                  )}

                  {/* Metrics */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    <Metric label="Bid share (est.)"
                      value={`${(est.bidShare * 100).toFixed(2)}%`}
                      dim={!est.aboveMin} />
                    <Metric label="Ask share (est.)"
                      value={`${(est.askShare * 100).toFixed(2)}%`}
                      dim={!est.aboveMin} />
                    <Metric label="Combined share"
                      value={`${(est.share * 100).toFixed(2)}%`}
                      dim={!est.aboveMin} />
                    <Metric label="Comp. bid depth"
                      value={`${est.competitorBidShares >= 1000
                        ? (est.competitorBidShares / 1000).toFixed(1) + 'k'
                        : est.competitorBidShares.toFixed(0)} sh`}
                      dim={!est.aboveMin} />
                  </div>

                  {/* Reward headline */}
                  <div className="border-t pt-2.5 border-mint/40/30">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-body text-[10px] text-muted uppercase tracking-widest">
                        Est. net reward
                      </span>
                      <span className={`font-mono text-xl font-bold tabular-nums ${
                        !est.aboveMin || isTrap ? 'text-muted/70' : 'text-mint-deep'
                      }`}>
                        {est.aboveMin && !isTrap ? fmtUsd(est.rewardDay) : '$—'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-0.5">
                      <span className="font-body text-[9px] text-gold/70 uppercase tracking-wide">
                        OBSERVED MODEL · estimate
                      </span>
                      <span className="font-body text-[10px] text-muted/70">
                        per day · net of platform fees · inv. risk not sub.
                      </span>
                    </div>
                    {ticketSide === 'BOTH' && est.aboveMin && (
                      <p className="font-body text-[10px] text-muted/50 mt-0.5 text-right">
                        share = min(bid {(est.bidShare*100).toFixed(2)}%, ask {(est.askShare*100).toFixed(2)}%)
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Auto-mirror placeholder */}
              <div className="border border-line/50 bg-surface/30 p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-body text-[11px] text-muted/70 uppercase tracking-widest">
                    Auto-mirror (live mode)
                  </span>
                  <div
                    className="relative w-8 h-4 bg-bg-soft border border-line rounded-full opacity-40 cursor-not-allowed"
                    title="Coming with API keys"
                  >
                    <span className="absolute left-0.5 top-0.5 w-3 h-3 bg-muted/60 rounded-full" />
                  </div>
                </div>
                <p className="font-body text-[9px] text-muted/50">
                  Ghost — coming with API keys. Mirroring ≠ free hedge; adverse fills on both sides.
                </p>
              </div>

            </div>
          </div>
        </div>

        {/* ── Per-capital estimates from stored scan data ──────────────────────── */}
        {mkt && (
          <>
            <div className="border border-line bg-surface rounded-card/30">
              <div className="px-3 py-2 border-b border-line flex items-center gap-3">
                <span className="font-body text-[10px] text-muted uppercase tracking-widest">
                  Estimated reward at each capital level
                </span>
                <span className="font-mono text-[9px] text-muted/50">from last scan · observed model</span>
              </div>
              <div className="grid grid-cols-3 divide-x divide-zinc-800">
                {(['500', '5000', '50000'] as const).map(key => {
                  const lv = mkt.levels[key];
                  const capLabel = key === '500' ? '$500' : key === '5000' ? '$5k' : '$50k';
                  if (!lv) return <div key={key} className="px-3 py-3 text-muted/50 font-mono text-[10px]">—</div>;
                  return (
                    <div key={key} className="px-3 py-2.5 space-y-0.5">
                      <div className="font-body text-[10px] text-muted/70 uppercase">{capLabel}</div>
                      {lv.aboveMin ? (
                        <>
                          <div className="font-mono text-sm font-semibold text-mint-deep tabular-nums">
                            <Redacted value={lv.netRewardDay ?? lv.grossRewardDay}>{v => fmtUsd(v)}</Redacted>/day
                          </div>
                          <div className="font-body text-[10px] text-muted tabular-nums">
                            <Redacted value={lv.share}>{v => `${(v * 100).toFixed(2)}%`}</Redacted> share
                          </div>
                          <div className="font-body text-[10px] text-muted/70 tabular-nums">
                            <Redacted value={lv.netYieldPct ?? lv.dayYieldPct}>{v => `${v.toFixed(2)}%`}</Redacted>/day
                          </div>
                        </>
                      ) : (
                        <div className="font-body text-[10px] text-muted/50">below min size</div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="px-3 py-1.5 border-t border-line">
                <p className="font-mono text-[9px] text-muted/50">
                  EST · NET OF PLATFORM FEES (reward paid from pool, no fee deducted) · OBSERVED MODEL · flat pro-rata ·
                  not Kalshi's official formula · share compresses as makers enter · inv. risk not sub.
                </p>
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatBox label="Pool $/day" value={<Redacted value={mkt.pool_day}>{v => `$${v.toFixed(0)}`}</Redacted>} />
              <StatBox label="Period total" value={<Redacted value={mkt.total_period_usd}>{v => `$${v.toFixed(0)}`}</Redacted>}
                sub={`${mkt.period_days.toFixed(1)}d period`} />
              <StatBox label="Min size" value={`${mkt.min_size.toLocaleString()} shares`} />
              <StatBox label="Fee discount" value={`${mkt.fee_discount_pct}%`} />
            </div>
          </>
        )}
        </>
        )}

        {/* How to read */}
        <div className="border border-line/50 bg-surface/40">
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-left"
            onClick={() => setHowToOpen(v => !v)}
          >
            <span className="font-mono text-[10px] text-muted uppercase tracking-widest">
              How the book and estimate work (Kalshi)
            </span>
            <span className="font-body text-[10px] text-muted/70">{howToOpen ? '▲ close' : '▼ expand'}</span>
          </button>
          {howToOpen && (
            <div className="px-4 pb-4 border-t border-line">
              <ul className="mt-3 space-y-2">
                {([
                  ['YES/NO book toggle', 'Kalshi has a single order book where both YES-buyers and NO-buyers place bids. YES bids come directly from the API (yes_dollars). YES asks are derived from NO bids: yes_ask_price = 1 − no_bid_price. Switch to NO to see the mirror.'],
                  ['$USD column', 'Sizes from the Kalshi API are in USD notional (not shares). Shares = USD / price at each level.'],
                  ['Mid / spread', 'Computed from the live book: mid = (best YES bid + lowest YES ask) / 2. Never stale.'],
                  ['Flat pro-rata estimate', 'share = user_shares / (user_shares + sum_qualifying_competitor_shares), taken as min(bid_share, ask_share). OBSERVED MODEL — not Kalshi\'s official formula (not published).'],
                  ['Min size', 'Competitor levels below min_size are excluded from the qualifying depth sum. If your size < min_size, you won\'t qualify.'],
                  ['TRAP', 'last_price > 0.90 or < 0.10: near-certain outcome, one side of the book is nearly empty. Do not trade.'],
                ] as [string, string][]).map(([term, def]) => (
                  <li key={term} className="font-mono text-[11px] text-muted leading-relaxed pl-3 border-l border-line/40">
                    <span className="text-muted">{term}:</span> {def}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Disclaimer */}
        <div className="border-t border-line pt-4">
          <p className="font-body text-[10px] text-muted/50 leading-relaxed">
            Kalshi order book data fetched live from the public Kalshi Trade API v2. No login, no keys, no orders placed.
            All reward figures are NET OF PLATFORM FEES estimates (Kalshi LIP reward paid from incentive pool separately from trading fees) using an OBSERVED flat pro-rata model — Kalshi's official formula is not public.
            Inventory/adverse-fill risk not modelled. Not financial advice.
          </p>
        </div>

      </div>
    </div>
  );
}

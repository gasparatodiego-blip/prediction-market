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
import { ChevronLeft, RefreshCw } from 'lucide-react';
import PlatformLogo from '@/components/PlatformLogo';
import { Redacted } from '@/app/components/ui/Redacted';
import InfoTip from '@/app/components/ui/InfoTip';
import { estimateReward, type MarketSnapshot, type Venue } from '@/lib/rewards-estimate';

// ── Types ─────────────────────────────────────────────────────────────────────
type NewsRisk = 'low' | 'medium' | 'high' | 'unknown';
type SideMode = 'both' | 'buy' | 'sell';
type OnFill   = 'requote' | 'flatten';
type NewsMode = 'withdraw' | 'alert' | 'off';

interface NormalizedMarket {
  venue:               Venue;
  marketId:            string;
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
  newsRisk?:           NewsRisk;
  newsSignals?:        { source: string; note: string }[] | null;
  protect?:            { action: string; detail: string; liveExecution?: string } | null;
}

interface BookRow { price: number; size: number }   // price 0..1 fraction, size shares
interface NormBook { bids: BookRow[]; asks: BookRow[]; lastTrade: number | null; hasBook: boolean; note: string | null }

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
  };
}

// ── Book normalization (executable prices only, both venues) ──────────────────
// Polymarket: YES book comes as {bids,asks} in 0..1 already.
// Kalshi: /orderbook returns { orderbook: { yes:[[cents,size]], no:[[cents,size]] } }.
//   YES bids = orderbook.yes ; YES asks are the mirror of NO bids: a NO bid at q¢ is
//   an offer to SELL YES at (100−q)¢. We never invent a level — only transform real ones.
function normalizeBook(venue: Venue, raw: any): NormBook {
  if (!raw) return { bids: [], asks: [], lastTrade: null, hasBook: false, note: null };

  if (venue === 'polymarket') {
    const yes = raw.yes;
    if (!yes) return { bids: [], asks: [], lastTrade: null, hasBook: false, note: raw.error ?? null };
    const bids = (yes.bids ?? []).map((r: any) => ({ price: parseFloat(r.price), size: parseFloat(r.size) }))
      .filter((r: BookRow) => r.price > 0 && r.size > 0).sort((a: BookRow, b: BookRow) => b.price - a.price);
    const asks = (yes.asks ?? []).map((r: any) => ({ price: parseFloat(r.price), size: parseFloat(r.size) }))
      .filter((r: BookRow) => r.price > 0 && r.size > 0).sort((a: BookRow, b: BookRow) => a.price - b.price);
    const lastTrade = yes.last_trade_price != null ? parseFloat(yes.last_trade_price) : null;
    return { bids, asks, lastTrade, hasBook: bids.length > 0 || asks.length > 0, note: null };
  }

  // Kalshi. The live API returns `orderbook_fp` with { yes_dollars, no_dollars },
  // each [priceDollarsString, sizeString] where price is already a 0..1 dollar value.
  // (Older shape: `orderbook` with { yes, no } as [cents, size].) YES asks are the
  // mirror of NO bids: a NO bid at $p is an offer to SELL YES at $(1−p). We only
  // transform real levels — never synthesize one.
  const fp = raw.orderbook_fp;
  const ob = raw.orderbook;
  let yesRaw: any[], noRaw: any[], scale: number;
  if (fp && (Array.isArray(fp.yes_dollars) || Array.isArray(fp.no_dollars))) {
    yesRaw = fp.yes_dollars ?? []; noRaw = fp.no_dollars ?? []; scale = 1;      // already dollars 0..1
  } else if (ob && (Array.isArray(ob.yes) || Array.isArray(ob.no))) {
    yesRaw = ob.yes ?? []; noRaw = ob.no ?? []; scale = 1 / 100;                // cents → dollars
  } else {
    return { bids: [], asks: [], lastTrade: null, hasBook: false, note: raw.error ?? null };
  }
  const bids = yesRaw.map((r: any[]) => ({ price: Number(r[0]) * scale, size: Number(r[1]) }))
    .filter((r: BookRow) => r.price > 0 && r.price < 1 && r.size > 0).sort((a: BookRow, b: BookRow) => b.price - a.price);
  const asks = noRaw.map((r: any[]) => ({ price: 1 - Number(r[0]) * scale, size: Number(r[1]) }))
    .filter((r: BookRow) => r.price > 0 && r.price < 1 && r.size > 0).sort((a: BookRow, b: BookRow) => a.price - b.price);
  return { bids, asks, lastTrade: null, hasBook: bids.length > 0 || asks.length > 0, note: null };
}

// ── Persist placement config (auth to write; no login wall on view) ───────────
interface PlacementConfig {
  side: SideMode; qtyPerSide: number; distanceC: number; onFill: OnFill; newsMode: NewsMode;
}
const LS_KEY = (id: string) => `rewards-placement:${id}`;

// ── Page ──────────────────────────────────────────────────────────────────────
export default function MarketDetailPage() {
  const params = useParams();
  const marketId = decodeURIComponent(params.marketId as string);

  const [mkt, setMkt]           = useState<NormalizedMarket | null>(null);
  const [mktErr, setMktErr]     = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);

  // live book
  const [book, setBook]         = useState<NormBook | null>(null);
  const [bookAge, setBookAge]   = useState<Date | null>(null);
  const [bookErr, setBookErr]   = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  // controls
  const [side, setSide]         = useState<SideMode>('both');
  const [qty, setQty]           = useState<number>(1000);
  const [dist, setDist]         = useState<number>(1.75);
  const [onFill, setOnFill]     = useState<OnFill>('requote');
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
        setDist(Number((((m.maxSpread ?? 4) / 2)).toFixed(2)));
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

  function applyConfig(c: Partial<PlacementConfig>) {
    if (c.side) setSide(c.side);
    if (typeof c.qtyPerSide === 'number') setQty(c.qtyPerSide);
    if (typeof c.distanceC === 'number') setDist(c.distanceC);
    if (c.onFill) setOnFill(c.onFill);
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
      const nb = normalizeBook(mkt.venue, d);
      setBook(nb);
      setBookErr(nb.hasBook ? null : (d?.error ?? null));
      setBookAge(new Date());
    } catch (e: any) { setBookErr(e?.message ?? 'book error'); }
  }, [mkt]);

  useEffect(() => {
    if (!mkt) return;
    fetchBook();
    pollRef.current = setInterval(fetchBook, mkt.venue === 'polymarket' ? 5_000 : 6_000);
    return () => clearInterval(pollRef.current);
  }, [mkt, fetchBook]);

  // ── derived: live mid, estimate ──
  const liveBestBid = book?.bids[0]?.price ?? null;
  const liveBestAsk = book?.asks[0]?.price ?? null;
  const liveMid = liveBestBid != null && liveBestAsk != null ? (liveBestBid + liveBestAsk) / 2 : null;
  const mid = liveMid ?? mkt?.midpoint ?? null;

  const twoSided = side === 'both';
  const sides = twoSided ? 2 : 1;
  const capital = qty * sides;   // qty is per-side; estimator capital is total working USD
  const distMax = mkt?.maxSpread ?? 10;

  const est = useMemo(() => {
    if (!mkt) return null;
    return estimateReward({ venue: mkt.venue, capital, twoSided, distanceCents: dist, market: toSnapshot(mkt) });
  }, [mkt, capital, twoSided, dist]);

  // user's planned order prices (mid ± distance)
  const userBid = mid != null && (side === 'both' || side === 'buy') ? Math.max(0.001, mid - dist / 100) : null;
  const userAsk = mid != null && (side === 'both' || side === 'sell') ? Math.min(0.999, mid + dist / 100) : null;

  // free-tier detection (snapshot numbers redacted → estimate degrades to unlock)
  const isRedacted = !!mkt && mkt.midpoint == null && mkt.dailyPool == null;

  // ── save placement ──
  async function savePlacement() {
    if (!mkt) return;
    const cfg: PlacementConfig = { side, qtyPerSide: qty, distanceC: dist, onFill, newsMode };
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
                <h1 className="font-display font-bold text-ink text-[15px] sm:text-lg leading-snug">{mkt.title}</h1>
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
            {/* ── B) Earnings block ── */}
            <EarningsBlock est={est} isRedacted={isRedacted} />

            {/* ── C) Order controls ── */}
            <div className="rounded-card shadow-card bg-surface px-4 py-4 space-y-4">
              <p className="font-body font-medium text-sm text-ink-2">Your order</p>

              {/* side */}
              <div>
                <span className="font-body text-[11px] uppercase tracking-wide text-muted">Side</span>
                <div className="grid grid-cols-3 gap-1.5 mt-1.5">
                  {([['both', 'Both sides'], ['buy', 'Buy only'], ['sell', 'Sell only']] as [SideMode, string][]).map(([v, label]) => (
                    <button key={v} onClick={() => setSide(v)}
                      className={`font-body font-medium text-[12px] py-2 rounded-button border transition-colors
                        ${side === v ? 'border-mint-deep/45 bg-mint-tint text-mint-deep' : 'border-line bg-surface text-muted hover:text-ink-2'}`}>
                      {label}
                    </button>
                  ))}
                </div>
                {mkt.twoSidedRequired && side !== 'both' && (
                  <p className="font-body text-[11px] text-coral-ink mt-1">At this price Polymarket requires both sides — a single side earns no rewards.</p>
                )}
              </div>

              {/* quantity per side */}
              <div>
                <div className="flex items-center justify-between">
                  <span className="font-body text-[11px] uppercase tracking-wide text-muted">Size per side</span>
                  <span className="font-body text-[11px] text-muted tabular-nums">total {fmtUsd(capital)} on {sides} side{sides === 1 ? '' : 's'}</span>
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
                <input type="range" min={0.1} max={distMax} step={0.1} value={dist}
                  onChange={e => setDist(Number(e.target.value))} className="w-full accent-mint-deep mt-1.5" />
                <div className="flex items-center justify-between font-body text-[10px] text-muted mt-0.5">
                  <span>closer = more reward, more fills</span>
                  <span>farther = safer</span>
                </div>
                {mkt.maxSpread == null && (
                  <p className="font-body text-[10px] text-muted mt-1">Kalshi doesn&apos;t publish a reward band — distance here only affects fill risk.</p>
                )}
              </div>
            </div>

            {/* ── D) Live order book ── */}
            <OrderBook
              book={book} bookAge={bookAge} bookErr={bookErr} isRedacted={isRedacted}
              mid={mid} liveSpread={liveBestBid != null && liveBestAsk != null ? liveBestAsk - liveBestBid : null}
              maxSpread={mkt.maxSpread} userBid={userBid} userAsk={userAsk}
              onRefresh={fetchBook} venue={mkt.venue}
            />

            {/* ── E) Fill-handling choice ── */}
            <div className="rounded-card shadow-card bg-surface px-4 py-4 space-y-3">
              <p className="font-body font-medium text-sm text-ink-2">If one side gets filled</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <ChoiceBtn active={onFill === 'requote'} onClick={() => setOnFill('requote')}
                  title="↻ Re-quote other side" desc="Immediately re-post the missing side to capture the spread on the exit. You stay directionally exposed until you're balanced again." />
                <ChoiceBtn active={onFill === 'flatten'} onClick={() => setOnFill('flatten')}
                  title="✕ Close immediately" desc="Close at the best executable price on the book: no directional exposure, but you give up the spread." />
              </div>
              <p className="font-body text-[11px] text-muted leading-relaxed">
                {onFill === 'requote'
                  ? 'Chosen: re-quote the other side — you aim to capture the spread, staying exposed until you’re balanced again.'
                  : 'Chosen: close immediately at the best price on the book — no directional exposure, spread not captured.'}
                {' '}On adverse news the news-guard can still force a close (see below).
              </p>
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
function EarningsBlock({ est, isRedacted }: { est: ReturnType<typeof estimateReward> | null; isRedacted: boolean }) {
  const net = est?.netPerDay ?? null;
  const netTone = net == null ? 'text-muted' : net > 0 ? 'text-mint-deep' : 'text-coral-ink';
  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      <div className="px-4 py-4">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <p className="font-body text-[11px] uppercase tracking-wide text-muted flex items-center gap-1">
              Net earnings · per day
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

        {est?.belowMinPayout && (
          <p className="font-body text-[11px] text-muted mt-3">Below the $1/day minimum — this position likely pays nothing. Shown for completeness.</p>
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

// ── D) Order book with the user's planned orders inline ───────────────────────
function OrderBook({
  book, bookAge, bookErr, isRedacted, mid, liveSpread, maxSpread, userBid, userAsk, onRefresh, venue,
}: {
  book: NormBook | null; bookAge: Date | null; bookErr: string | null; isRedacted: boolean;
  mid: number | null; liveSpread: number | null; maxSpread: number | null;
  userBid: number | null; userAsk: number | null; onRefresh: () => void; venue: Venue;
}) {
  const halfBand = maxSpread != null ? (maxSpread / 100) / 2 : null;
  const asks = (book?.asks ?? []).slice(0, 12);
  const bids = (book?.bids ?? []).slice(0, 12);
  const maxSize = Math.max(1, ...asks.map(a => a.size), ...bids.map(b => b.size));

  // Merge the user's planned SELL into the ask ladder (top→best) and BUY into bids.
  const askRows = mergeUserRow(asks, userAsk, 'sell', 'asc');
  const bidRows = mergeUserRow(bids, userBid, 'buy', 'desc');

  const showBook = book?.hasBook;

  return (
    <div className="rounded-card shadow-card bg-surface overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-line">
        <div className="flex items-center gap-2">
          <span className="font-body font-medium text-sm text-ink-2">Live order book</span>
          {bookAge && showBook && (
            <span className="flex items-center gap-1 font-body text-[10px] text-mint-deep">
              <span className="w-1.5 h-1.5 rounded-full bg-mint-deep animate-pulse" /> updated {ago(bookAge.toISOString())} ago
            </span>
          )}
        </div>
        <button onClick={onRefresh} className="inline-flex items-center gap-1 font-body text-[11px] text-muted hover:text-ink-2">
          <RefreshCw size={12} /> refresh
        </button>
      </div>

      {!showBook ? (
        <div className="px-4 py-8 text-center">
          <p className="font-body text-sm text-muted">
            {isRedacted ? 'Live book available once the plan is unlocked.' : 'Book unavailable — data refreshing, try again shortly.'}
          </p>
          {bookErr && !isRedacted && <p className="font-body text-[10px] text-muted/60 mt-1">{bookErr}</p>}
        </div>
      ) : (
        <div className="px-2 py-2">
          {/* column headers */}
          <div className="grid grid-cols-3 px-2 py-1 font-body text-[9px] uppercase text-muted/60">
            <span>Price</span><span className="text-right">Size</span><span className="text-right">your order</span>
          </div>
          {/* asks (red, top) */}
          <div className="flex flex-col-reverse">
            {askRows.map((r, i) => <Ladder key={`a${i}`} row={r} maxSize={maxSize} mid={mid} halfBand={halfBand} kind="ask" />)}
          </div>
          {/* mid divider */}
          <div className="flex items-center gap-3 px-2 py-1.5 my-1 bg-bg-soft/70 border-y border-line/60">
            <span className="font-mono text-[12px] font-semibold text-ink tabular-nums">mid {mid != null ? fmtC(mid) : '—'}</span>
            {liveSpread != null && <span className="font-mono text-[10px] text-muted">spread {fmtC(liveSpread)}</span>}
            {book?.lastTrade != null && <span className="font-body text-[10px] text-muted/60 ml-auto">last {fmtC(book.lastTrade)}</span>}
          </div>
          {/* bids (green, bottom) */}
          <div className="flex flex-col">
            {bidRows.map((r, i) => <Ladder key={`b${i}`} row={r} maxSize={maxSize} mid={mid} halfBand={halfBand} kind="bid" />)}
          </div>
          <p className="font-body text-[9px] text-muted/60 px-2 pt-2">
            Real executable prices from the {venue === 'polymarket' ? 'CLOB' : 'Kalshi'} book. Highlighted rows are your <span className="font-semibold">planned orders</span> (mid ± distance), not liquidity already resting.
          </p>
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
function Ladder({ row, maxSize, mid, halfBand, kind }: { row: LadderRow; maxSize: number; mid: number | null; halfBand: number | null; kind: 'ask' | 'bid' }) {
  const isUser = !!row.user;
  const inBandFlag = mid != null && halfBand != null ? Math.abs(row.price - mid) <= halfBand : false;
  const barPct = maxSize > 0 ? (row.size / maxSize) * 100 : 0;
  const priceCls = kind === 'ask' ? 'text-coral-ink' : 'text-mint-deep';
  const barCls = kind === 'ask' ? 'bg-coral-tint/60' : 'bg-mint-tint/60';
  if (isUser) {
    return (
      <div className={`relative grid grid-cols-3 items-center text-[11px] font-mono px-2 py-[5px] rounded-sm my-[1px]
        ${row.user === 'buy' ? 'bg-mint-tint ring-1 ring-mint-deep/50' : 'bg-coral-tint ring-1 ring-coral-ink/50'}`}>
        <span className={`tabular-nums font-bold ${row.user === 'buy' ? 'text-mint-deep' : 'text-coral-ink'}`}>{fmtC(row.price)}</span>
        <span className="text-right" />
        <span className={`text-right font-bold text-[10px] ${row.user === 'buy' ? 'text-mint-deep' : 'text-coral-ink'}`}>
          {row.user === 'buy' ? 'your BUY' : 'your SELL'}
        </span>
      </div>
    );
  }
  return (
    <div className="relative grid grid-cols-3 items-center text-[11px] font-mono px-2 py-[3px]">
      <span className={`absolute inset-y-0 right-0 ${barCls}`} style={{ width: `${barPct}%`, pointerEvents: 'none' }} />
      <span className={`relative tabular-nums ${priceCls} ${inBandFlag ? 'font-semibold' : 'opacity-70'}`}>{fmtC(row.price)}</span>
      <span className="relative text-right text-muted tabular-nums">{fmtSh(row.size)}</span>
      <span className="relative text-right text-muted/40 tabular-nums text-[9px]">{inBandFlag ? 'in band' : ''}</span>
    </div>
  );
}

// ── shared bits ───────────────────────────────────────────────────────────────
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

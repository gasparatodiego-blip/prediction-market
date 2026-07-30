'use client';

// LiquidityRewardsConsole — the ONE page, ONE URL, SIX sections operator console for the Polymarket
// liquidity-rewards maker (/dashboard/liquidity-rewards).
//
// SIX SECTIONS, NO NAVIGATION. Riepilogo · Mercati · Posizioni · Ordini manuali · Alloca capitale ·
// Regole are tabs held in client state. Switching one does not touch the URL, does not remount the data
// and does not refetch: the board is fetched once per poll and every section is a projection of it.
// (The legacy /dashboard/liquidity-rewards/allocate route redirects here with ?tab=alloca, which is read
// ONCE at mount purely to pick the landing section — after that the URL never changes again.)
//
// EVERY NUMBER IS REAL, AND SAYS WHERE IT CAME FROM:
//   header · capitale totale       → GET /api/rewards/balance         (proxy pUSD, read on-chain)
//   header · capitale impegnato    → GET /api/maker/board  orders     (the VENUE's open-order list)
//   header · $/giorno lordo        → GET /api/maker/board  summary    (shared estimator, priced at the
//                                     capital actually resting IN BAND — out-of-band capital earns 0)
//   header · ordini fuori banda    → GET /api/maker/board  summary    (shared band guard's verdict)
//   Mercati / ladder / Regole      → GET /api/maker/board  markets    (agent24/25 scan + agent34 book)
//
// EVERY $/day IS PRICED AT THE REAL BALANCE. The feed scores each market for a $1,000 reference maker.
// That figure is never displayed here: it is re-priced, through the shared estimateAtCapital, at the
// proxy's actual on-chain pUSD — the same number the header shows. Showing the reference beside a $100
// balance would overstate the take by roughly an order of magnitude. An unreadable balance yields N/D
// with the reason, never a fallback to the reference. (The "Alloca capitale" planner is deliberately
// exempt: there the capital is a free input, because its job is simulating amounts you do not yet hold.)
//   Posizioni                      → GET /api/maker/positions         (Polymarket data-api, read-only)
//   Ordini manuali                 → <ManualOrdersPanel/>, unchanged  (its own real endpoints)
//   Alloca capitale                → <RewardsAllocatePanel/>, unchanged
//
// There is no mock, no placeholder and no hardcoded figure anywhere in this file. A value the server
// could not read renders as "N/D" WITH THE REASON next to it — never as a zero, never as a bare padlock.
//
// POLYMARKET ONLY. The aggregation drops Kalshi at the source (lib/maker/operator-board), so no venue
// filter is offered or needed here.
//
// OPERATOR-ONLY, SELF-HIDING. /api/maker/board is admin-gated by middleware (ADMIN_ACCESS_SECRET). The
// console probes it on mount; a non-admin visitor gets the unchanged PUBLIC rewards board instead, so
// this rebuild takes nothing away from the public page.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
// The SHARED estimator, priced at a real capital. Pure and browser-safe, and the identical function the
// server aggregation uses for the header's in-band figure — so no two numbers on this page can come from
// two different models.
import { estimateAtCapital } from '@/lib/reward-operator-estimate';
import PriceLadder from './PriceLadder';
import ManualOrdersPanel from './ManualOrdersPanel';
import RewardsAllocatePanel from './RewardsAllocatePanel';
import RewardsUnified from './RewardsUnified';

type TabKey = 'riepilogo' | 'mercati' | 'posizioni' | 'ordini' | 'alloca' | 'regole';

const TABS: Array<{ key: TabKey; label: string; short: string }> = [
  { key: 'riepilogo', label: 'Riepilogo', short: 'Riepilogo' },
  { key: 'mercati', label: 'Mercati', short: 'Mercati' },
  { key: 'posizioni', label: 'Posizioni', short: 'Posizioni' },
  { key: 'ordini', label: 'Ordini manuali', short: 'Ordini' },
  { key: 'alloca', label: 'Alloca capitale', short: 'Alloca' },
  { key: 'regole', label: 'Regole', short: 'Regole' },
];

interface JudgedOrder {
  orderId: string | null; marketId: string | null; tokenId: string | null; side: string | null;
  price: number | null; size: number | null; sizeMatched: number | null; sizeRemaining: number | null;
  status: string; ageSec: number | null; source: string;
  book: 'yes' | 'no' | null; scoringMid: number | null; bandRadiusCents: number | null;
  distanceCents: number | null; signedDistanceCents: number | null;
  inBand: boolean | null; outOfBand: boolean | null; valid: boolean | null;
  reasons: Array<{ code: string; detail: string }>;
  suggestedPrice: number | null; restingSize: number | null; restingNotionalUsd: number | null;
  marketTitle: string | null; rulesReadable: boolean;
}
interface SpreadClass { spreadCents: number | null; level: 'basso' | 'medio' | 'alto' | null; label: string | null; note: string }
interface StabilityBadge { known: boolean; label: string | null; score: number | null; reason: string | null; movedCents: number | null; consumedBandPct: number | null }
interface BoardMarket {
  marketId: string; title: string | null; groupItemTitle: string | null; slug: string | null;
  marketSlug: string | null; category: string | null; inBotUniverse: boolean | null;
  mid: number | null; midSource: string | null; midAgeSec: number | null;
  bestBid: number | null; bestAsk: number | null; tick: number | null; minSize: number | null;
  maxSpreadCents: number | null; bandRadiusCents: number | null; bandLo: number | null; bandHi: number | null;
  rulesReadable: boolean; rulesMissing: string[]; tokenId: string | null; tokenIdNo: string | null;
  dailyPoolUsd: number | null; bookDepthAtBandUsd: number | null;
  volume24hUsd: number | null; hoursToResolution: number | null;
  rewardScore: { poolDay?: number | null; refShare?: number | null; refCapital?: number | null } | null;
  spread: SpreadClass; stability: StabilityBadge;
}
/** A market with its $/day priced at the operator's REAL balance (see pricedMarkets below). */
interface PricedMarket extends BoardMarket {
  estUsdPerDay: number | null;
  estCapitalUsd: number | null;
  estDepthLimited: boolean;
  estUnknown: boolean;
  estReason: string | null;
  estYieldPctPerDay: number | null;
}
interface Summary {
  committedUsd: number | null; committedInBandUsd: number | null; unjudgeableCapitalUsd: number | null;
  estGrossUsdPerDay: number | null;
  estPerMarket: Array<{ marketId: string | null; title: string | null; inBandCapitalUsd: number | null; estUsdPerDay: number | null }>;
  outOfBandCount: number; inBandCount: number; unknownBandCount: number; unpricedOrders: number;
  marketsWithOrders: Array<{ marketId: string | null; title: string | null; committedUsd: number | null; outOfBandCount: number; unknownBandCount: number; orderCount: number }>;
}
interface OrderBoard {
  ok: boolean; error: string | null; simulated: boolean; at: string; count: number;
  orders: JudgedOrder[];
  byMarket: Array<{ marketId: string | null; title: string | null; orders: JudgedOrder[]; committedUsd: number | null; outOfBandCount: number; unknownBandCount: number }>;
  totals: { committedUsd: number | null; unpricedOrders: number; outOfBandCount: number; inBandCount: number; unknownBandCount: number };
}
interface Board {
  at: string; markets: BoardMarket[]; marketCount: number;
  feed: { generatedAt: string | null; polyGeneratedAt: string | null };
  selectionReadable: boolean; orders: OrderBoard | null; summary: Summary; error?: string;
}
interface Balance {
  proxy: string | null; pusdBalance: number | null; rpcReachable: boolean; readAt: string | null;
  ageSeconds: number | null; stale: boolean; note: string;
}
interface PositionLeg {
  asset: string; side: 'yes' | 'no' | null; outcome: string | null; size: number | null;
  avgPrice: number | null; curPrice: number | null; currentValueUsd: number | null;
  initialValueUsd: number | null; unrealizedPnlUsd: number | null; sideKnown: boolean;
}
interface PositionMarket {
  marketId: string | null; title: string | null; slug: string | null; legs: PositionLeg[];
  yesShares: number | null; noShares: number | null; netShares: number | null;
  netDirection: 'yes' | 'no' | 'flat'; currentValueUsd: number | null; initialValueUsd: number | null;
  unrealizedPnlUsd: number | null; valueUnknown: boolean;
}
interface Positions {
  ok: boolean; wallet: string | null; error: string | null; source: string; at: string;
  markets: PositionMarket[];
  totals: { marketCount: number; legCount: number; currentValueUsd: number | null; unrealizedPnlUsd: number | null; valueUnknown: boolean } | null;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const money = (v: number | null | undefined, nd = 2): string => (fin(v) ? `$${v.toFixed(nd)}` : 'N/D');
const cents = (p: number | null | undefined): string => (fin(p) ? `${(p * 100).toFixed(1)}¢` : 'N/D');
const num = (v: number | null | undefined, nd = 0): string => (fin(v) ? v.toFixed(nd) : 'N/D');
const ageTxt = (s: number | null | undefined): string =>
  (!fin(s) ? 'N/D' : s < 60 ? `${Math.round(s)}s fa` : s < 3600 ? `${Math.round(s / 60)} min fa` : `${(s / 3600).toFixed(1)} h fa`);
const hoursTxt = (h: number | null): string =>
  (!fin(h) ? 'N/D' : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} g`);

const BOARD_POLL_MS = 20_000;
const BALANCE_POLL_MS = 60_000;
const POSITIONS_POLL_MS = 60_000;
const PAGE = 20;

export default function LiquidityRewardsConsole({ initialTab }: { initialTab?: string }) {
  // null = still probing the admin gate; false = public visitor (gets the unchanged public board).
  const [operator, setOperator] = useState<boolean | null>(null);
  const [tab, setTab] = useState<TabKey>(
    (TABS.some((t) => t.key === initialTab) ? (initialTab as TabKey) : 'riepilogo'),
  );
  const [board, setBoard] = useState<Board | null>(null);
  const [boardErr, setBoardErr] = useState<string | null>(null);
  const [bal, setBal] = useState<Balance | null>(null);
  const [balErr, setBalErr] = useState<string | null>(null);
  const [pos, setPos] = useState<Positions | null>(null);
  const [posLoading, setPosLoading] = useState(false);

  // Mercati controls — purely local view state, never sent anywhere.
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'tutti' | 'bot' | 'miei'>('bot');
  const [limit, setLimit] = useState(PAGE);
  const [openLadder, setOpenLadder] = useState<string | null>(null);

  const loadBoard = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/board', { cache: 'no-store' });
      if (r.status === 401 || r.status === 404) { setOperator(false); return; }
      setOperator(true);
      const body = (await r.json()) as Board;
      if (body.error) { setBoardErr(body.error); return; }
      setBoardErr(null);
      setBoard(body);
    } catch (e) {
      setBoardErr((e as Error).message);
    }
  }, []);

  const loadBalance = useCallback(async () => {
    try {
      const r = await fetch('/api/rewards/balance', { cache: 'no-store' });
      const b = (await r.json()) as Balance;
      setBal(b); setBalErr(null);
    } catch (e) { setBalErr((e as Error).message); }
  }, []);

  const loadPositions = useCallback(async () => {
    setPosLoading(true);
    try {
      const r = await fetch('/api/maker/positions', { cache: 'no-store' });
      setPos((await r.json()) as Positions);
    } catch (e) {
      setPos({ ok: false, wallet: null, error: (e as Error).message, source: '—', at: new Date().toISOString(), markets: [], totals: null });
    } finally { setPosLoading(false); }
  }, []);

  useEffect(() => { loadBoard(); loadBalance(); }, [loadBoard, loadBalance]);
  useEffect(() => {
    if (operator !== true) return;
    const a = setInterval(loadBoard, BOARD_POLL_MS);
    const b = setInterval(loadBalance, BALANCE_POLL_MS);
    return () => { clearInterval(a); clearInterval(b); };
  }, [operator, loadBoard, loadBalance]);

  // Positions cost a venue round-trip, so they are fetched only while their section is open.
  useEffect(() => {
    if (operator !== true || tab !== 'posizioni') return;
    loadPositions();
    const t = setInterval(loadPositions, POSITIONS_POLL_MS);
    return () => clearInterval(t);
  }, [operator, tab, loadPositions]);

  const orders = board?.orders ?? null;
  const summary = board?.summary ?? null;
  const rawMarkets = useMemo(() => board?.markets ?? [], [board]);

  // ── THE CAPITAL EVERY $/day ON THIS PAGE IS PRICED AT ─────────────────────────────────────────────
  // The operator's REAL proxy balance, read on-chain — the same number the header shows as "capitale
  // totale" and the allocation planner offers as "usa saldo intero". Not the feed's $1,000 reference:
  // that figure describes a maker ten times this size, and showing it beside a $100 balance overstates
  // the take by about an order of magnitude.
  //
  // UNREADABLE BALANCE ⇒ NO ESTIMATE. The reference capital is deliberately NOT used as a fallback —
  // substituting it is precisely the overstatement being removed here. The sections render N/D and say
  // why, which is the honest answer to "how much would I make" when the capital is unknown.
  const capitalUsd = fin(bal?.pusdBalance) ? (bal!.pusdBalance as number) : null;

  const pricedMarkets: PricedMarket[] = useMemo(() => rawMarkets.map((m) => {
    const e = estimateAtCapital(m.rewardScore, capitalUsd, m.bookDepthAtBandUsd);
    return {
      ...m,
      estUsdPerDay: e.unknown ? null : e.estUsdPerDay,
      estCapitalUsd: e.capitalUsd,
      estDepthLimited: e.depthLimited,
      estUnknown: e.unknown,
      estReason: e.reason,
      // Daily yield on the capital the estimate is actually priced for — the ranking key for "miglior
      // mercato". Ranking by $/day alone would just rank by pot size.
      estYieldPctPerDay: (!e.unknown && fin(e.estUsdPerDay) && fin(e.capitalUsd) && (e.capitalUsd as number) > 0)
        ? ((e.estUsdPerDay as number) / (e.capitalUsd as number)) * 100
        : null,
    };
  }), [rawMarkets, capitalUsd]);

  // Best markets BY RETURN on the operator's real capital, over markets that are actually scorable.
  const bestMarkets = useMemo(
    () => pricedMarkets
      .filter((m) => m.rulesReadable && !m.estUnknown && fin(m.estYieldPctPerDay))
      .sort((a, b) => (b.estYieldPctPerDay as number) - (a.estYieldPctPerDay as number))
      .slice(0, 5),
    [pricedMarkets],
  );

  const ordersByMarket = useMemo(() => {
    const m = new Map<string, JudgedOrder[]>();
    for (const o of orders?.orders ?? []) {
      if (!o.marketId) continue;
      if (!m.has(o.marketId)) m.set(o.marketId, []);
      m.get(o.marketId)!.push(o);
    }
    return m;
  }, [orders]);

  // Free capital = the on-chain balance minus what is resting. Both sides must be real: if either is
  // unreadable the figure is N/D with the reason, never a subtraction against an assumed zero.
  const freeCapital = useMemo(() => {
    if (!fin(bal?.pusdBalance) || !fin(summary?.committedUsd)) return null;
    return (bal!.pusdBalance as number) - (summary!.committedUsd as number);
  }, [bal, summary]);

  const outOfBandOrders = useMemo(
    () => (orders?.orders ?? []).filter((o) => o.outOfBand === true),
    [orders],
  );

  const visibleMarkets = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let set = pricedMarkets;
    if (scope === 'bot') set = set.filter((m) => m.inBotUniverse === true || ordersByMarket.has(m.marketId));
    if (scope === 'miei') set = set.filter((m) => ordersByMarket.has(m.marketId));
    if (needle) set = set.filter((m) => (m.title ?? '').toLowerCase().includes(needle) || m.marketId.toLowerCase().includes(needle));
    // Markets you have capital in first, then the bot's set, then by estimated yield on the capital the
    // estimate is priced for — the same ranking the Riepilogo's "miglior mercato" uses.
    return [...set].sort((a, b) => {
      const oa = ordersByMarket.has(a.marketId) ? 1 : 0;
      const ob = ordersByMarket.has(b.marketId) ? 1 : 0;
      if (oa !== ob) return ob - oa;
      const ua = a.inBotUniverse === true ? 1 : 0;
      const ub = b.inBotUniverse === true ? 1 : 0;
      if (ua !== ub) return ub - ua;
      return (fin(b.estYieldPctPerDay) ? (b.estYieldPctPerDay as number) : -1)
        - (fin(a.estYieldPctPerDay) ? (a.estYieldPctPerDay as number) : -1);
    });
  }, [pricedMarkets, q, scope, ordersByMarket]);

  // ── PUBLIC VISITOR ── the unchanged public board. Nothing operator-only is even fetched for them.
  if (operator === false) return <RewardsUnified />;
  if (operator === null) {
    return (
      <div className="lrc-root">
        <style>{CSS}</style>
        <div className="lrc-note">Caricamento della console…</div>
      </div>
    );
  }

  const feedAgeSec = board?.feed.polyGeneratedAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(board.feed.polyGeneratedAt)) / 1000))
    : null;

  return (
    <div className="lrc-root" data-liquidity-console>
      <style>{CSS}</style>

      {/* ── HEADER: four live metrics ─────────────────────────────────────────────────────────────── */}
      <div className="lrc-head">
        <div className="lrc-title-row">
          <h1 className="lrc-h1">Liquidity rewards · console operatore</h1>
          <span className="lrc-venue">solo Polymarket</span>
        </div>

        <div className="lrc-metrics" data-lrc-metrics>
          <Metric
            k="Capitale totale"
            v={money(bal?.pusdBalance)}
            sub={bal?.pusdBalance == null
              ? (balErr ? `non letto: ${balErr}` : 'saldo non leggibile')
              : `pUSD del proxy, on-chain · letto ${ageTxt(bal?.ageSeconds)}${bal?.stale ? ' · STALE' : ''}`}
            warn={bal?.pusdBalance == null || bal?.stale === true}
          />
          <Metric
            k="Capitale impegnato ora"
            v={orders?.simulated ? 'N/D' : money(summary?.committedUsd)}
            sub={orders?.simulated
              ? 'venue non interrogato (nessuna credenziale) — non è «zero impegnato»'
              : orders?.ok === false
                ? `lettura fallita: ${orders.error ?? '—'}`
                : `${orders?.count ?? 0} ordini a riposo${summary && summary.unpricedOrders > 0 ? ` · ${summary.unpricedOrders} senza controvalore` : ''}`}
            warn={orders?.simulated === true || orders?.ok === false}
          />
          <Metric
            k="$/giorno lordo stimato"
            v={orders?.simulated ? 'N/D' : (summary?.estGrossUsdPerDay == null ? 'N/D' : `${money(summary.estGrossUsdPerDay)}/g`)}
            sub={orders?.simulated
              ? 'nessuna lettura del venue'
              : summary?.estGrossUsdPerDay == null
                ? 'un mercato con capitale in banda non è scorabile — nessun totale inventato'
                : `sul capitale in banda (${money(summary?.committedInBandUsd)}) · lordo, adverse selection non modellata`}
            warn={summary?.estGrossUsdPerDay == null || orders?.simulated === true}
          />
          <Metric
            k="Ordini fuori banda"
            v={orders?.simulated ? 'N/D' : String(summary?.outOfBandCount ?? 0)}
            sub={orders?.simulated
              ? 'nessuna lettura del venue'
              : (summary?.unknownBandCount ?? 0) > 0
                ? `${summary?.unknownBandCount} non giudicabili (regole di venue non leggibili)`
                : (summary?.outOfBandCount ?? 0) > 0 ? 'non stanno maturando nulla' : 'tutti gli ordini a riposo sono in banda'}
            warn={(summary?.outOfBandCount ?? 0) > 0 || (summary?.unknownBandCount ?? 0) > 0}
          />
        </div>

        {boardErr && <div className="lrc-banner lrc-banner-red">Board non leggibile: {boardErr}</div>}

        <div className="lrc-tabs" role="tablist" aria-label="Sezioni">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`lrc-tab ${tab === t.key ? 'is-on' : ''}`}
              onClick={() => setTab(t.key)}
              data-lrc-tab={t.key}
            >
              <span className="lrc-tab-long">{t.label}</span>
              <span className="lrc-tab-short">{t.short}</span>
              {t.key === 'riepilogo' && (summary?.outOfBandCount ?? 0) > 0 && <span className="lrc-tab-dot" aria-label="allarme" />}
            </button>
          ))}
        </div>
        <div className="lrc-feedage">
          Scan Polymarket {feedAgeSec == null ? 'N/D' : ageTxt(feedAgeSec)} · {board?.marketCount ?? 0} mercati premianti ·
          ordini letti dal venue {orders?.at ? new Date(orders.at).toLocaleTimeString() : 'N/D'}
        </div>
      </div>

      {/* ── 1 · RIEPILOGO ─────────────────────────────────────────────────────────────────────────── */}
      {tab === 'riepilogo' && (
        <section className="lrc-sec" data-lrc-section="riepilogo">
          {orders?.simulated && (
            <div className="lrc-banner lrc-banner-warn">
              Nessuna credenziale di lettura: il venue non è stato interrogato. Le sezioni che dipendono
              dai tuoi ordini mostrano N/D — «nessun ordine» sarebbe una deduzione, non un fatto.
            </div>
          )}

          {/* ALERT — named markets, named action. Never "some orders are out of band". */}
          {outOfBandOrders.length > 0 ? (
            <div className="lrc-alert" data-lrc-alert="out-of-band">
              <div className="lrc-alert-t">
                {outOfBandOrders.length} {outOfBandOrders.length === 1 ? 'ordine è fuori banda' : 'ordini sono fuori banda'} — non stanno maturando nulla
              </div>
              <ul className="lrc-alert-list">
                {outOfBandOrders.map((o) => (
                  <li key={o.orderId ?? Math.random()}>
                    <b>{o.marketTitle ?? o.marketId ?? 'mercato sconosciuto'}</b> — {(o.book ?? '?').toUpperCase()} a {cents(o.price)},
                    {' '}<span className="lrc-num">{num(o.distanceCents, 2)}¢</span> dal mid (banda ±{num(o.bandRadiusCents, 2)}¢).
                    {' '}Azione: <b>riprezza a {cents(o.suggestedPrice)}</b> oppure cancella.
                  </li>
                ))}
              </ul>
              <button className="lrc-btn" onClick={() => setTab('ordini')} data-lrc-goto-orders>
                Vai a Ordini manuali →
              </button>
            </div>
          ) : orders?.simulated ? null : (
            <div className="lrc-banner lrc-banner-ok" data-lrc-alert="none">
              Nessun ordine fuori banda. {orders?.count === 0
                ? 'Non hai ordini a riposo sul venue (letto, non dedotto).'
                : `Tutti i ${orders?.count} ordini a riposo sono dentro la banda premiante.`}
            </div>
          )}

          <div className="lrc-cards">
            {/* MIGLIOR MERCATO PER RENDIMENTO */}
            <div className="lrc-card">
              <div className="lrc-card-k">Miglior mercato per rendimento</div>
              {capitalUsd == null ? (
                <div className="lrc-nd" data-lrc-best="no-capital">
                  N/D — il saldo reale del proxy non è leggibile
                  {balErr ? `: ${balErr}` : bal?.note ? `: ${bal.note}` : ''}. Senza il capitale vero non
                  viene calcolata nessuna stima: mostrare la cifra di riferimento da $1.000 del feed
                  sovrastimerebbe di circa dieci volte.
                </div>
              ) : bestMarkets.length ? (
                <>
                  <div className="lrc-card-v">{bestMarkets[0].title ?? bestMarkets[0].marketId}</div>
                  <div className="lrc-card-big" data-lrc-best-yield>
                    {num(bestMarkets[0].estYieldPctPerDay, 2)}%<span className="lrc-card-unit">/giorno</span>
                  </div>
                  <div className="lrc-card-sub">
                    {money(bestMarkets[0].estUsdPerDay)}/g sul tuo capitale di {money(bestMarkets[0].estCapitalUsd, 0)}
                    {bestMarkets[0].estDepthLimited ? ' (limitato dalla profondità in banda)' : ''} ·
                    montepremi {money(bestMarkets[0].dailyPoolUsd, 0)}/g
                  </div>
                  <ol className="lrc-rank">
                    {bestMarkets.slice(1).map((m) => (
                      <li key={m.marketId}>
                        <span className="lrc-num">{num(m.estYieldPctPerDay, 2)}%/g</span>
                        <span className="lrc-rank-t">{m.title ?? m.marketId}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="lrc-fine">
                    Rendimento = stima $/giorno ÷ capitale su cui la stima è calcolata, e quel capitale è
                    il tuo saldo reale ({money(capitalUsd)}), non una cifra di riferimento. Dove il book
                    contiene meno di quel saldo la stima è calcolata sulla profondità disponibile, perché
                    oltre quella non c&apos;è libro in cui stare. Lordo, adverse selection non modellata.
                  </p>
                </>
              ) : (
                <div className="lrc-nd">N/D — nessun mercato risulta scorabile in questo scan.</div>
              )}
            </div>

            {/* CAPITALE LIBERO / ECCEDENTE */}
            <div className="lrc-card">
              <div className="lrc-card-k">Capitale libero</div>
              <div className="lrc-card-big">{freeCapital == null ? 'N/D' : money(freeCapital)}</div>
              <div className="lrc-card-sub">
                {freeCapital == null
                  ? (orders?.simulated
                    ? 'il venue non è stato interrogato: il capitale impegnato non è noto, quindi la differenza non è calcolabile'
                    : 'saldo o capitale impegnato non leggibili — nessuna sottrazione contro uno zero assunto')
                  : <>totale {money(bal?.pusdBalance)} − impegnato {money(summary?.committedUsd)}</>}
              </div>
              {freeCapital != null && fin(bal?.pusdBalance) && (bal!.pusdBalance as number) > 0 && (
                <div className="lrc-barwrap" aria-hidden="true">
                  <div
                    className="lrc-bar lrc-bar-used"
                    style={{ width: `${Math.max(0, Math.min(100, ((summary?.committedUsd ?? 0) / (bal!.pusdBalance as number)) * 100))}%` }}
                  />
                </div>
              )}
              <p className="lrc-fine">
                {freeCapital != null && freeCapital > 0
                  ? 'Capitale fermo: non matura premi finché non è a riposo dentro una banda. La sezione «Alloca capitale» propone un piano — è un piano, non un ordine.'
                  : 'Tutto il capitale disponibile risulta impegnato.'}
                {' '}Il saldo è quello del proxy funder, letto on-chain in sola lettura.
              </p>
            </div>
          </div>

          <p className="lrc-note">
            Le cifre di questa sezione sono le stesse dell&apos;intestazione e delle altre sezioni: un solo
            fetch, una sola lettura del venue, un solo giudizio di banda. Se due sezioni mostrassero numeri
            diversi sarebbe un bug, non una differenza di metodo.
          </p>
        </section>
      )}

      {/* ── 2 · MERCATI ───────────────────────────────────────────────────────────────────────────── */}
      {tab === 'mercati' && (
        <section className="lrc-sec" data-lrc-section="mercati">
          <div className="lrc-controls">
            <div className="lrc-scope" role="group" aria-label="Quali mercati">
              {([['bot', 'Set del bot + i miei'], ['miei', 'Solo con miei ordini'], ['tutti', `Tutti (${pricedMarkets.length})`]] as const).map(([k, l]) => (
                <button key={k} className={`lrc-chip ${scope === k ? 'is-on' : ''}`} onClick={() => { setScope(k); setLimit(PAGE); }}>{l}</button>
              ))}
            </div>
            <input
              className="lrc-search" type="search" placeholder="Cerca mercato o id…"
              value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} aria-label="Cerca mercato"
            />
          </div>

          {/* WHICH CAPITAL THE COLUMN "stima" IS PRICED AT — stated once, in the open, not only in a
              tooltip. It is the same balance the header shows. */}
          <div className={`lrc-banner ${capitalUsd == null ? 'lrc-banner-warn' : 'lrc-banner-ok'}`} data-lrc-capital-note>
            {capitalUsd == null ? (
              <>Stime non calcolate: il saldo reale del proxy non è leggibile{balErr ? ` (${balErr})` : ''}. Non viene
                sostituito con il capitale di riferimento da $1.000 del feed, che sovrastimerebbe di circa dieci volte.</>
            ) : (
              <>Le stime $/giorno di questa lista sono calcolate sul tuo <b>saldo reale</b> di{' '}
                <b className="lrc-num">{money(capitalUsd)}</b> (proxy funder, letto on-chain{bal?.stale ? ', valore non aggiornato' : ''}) —
                non su un capitale ipotetico. Dove il book contiene meno di così, la stima usa la profondità
                disponibile e la riga lo dichiara.</>
            )}
          </div>

          {visibleMarkets.length === 0 ? (
            <div className="lrc-nd">
              Nessun mercato corrisponde a questo filtro. {scope === 'bot' && 'Il set del bot è deciso dalla selezione salvata; prova «Tutti».'}
            </div>
          ) : (
            <div className="lrc-mkts">
              {visibleMarkets.slice(0, limit).map((m) => {
                const mine = ordersByMarket.get(m.marketId) ?? [];
                const open = openLadder === m.marketId;
                return (
                  <div key={m.marketId} className="lrc-mkt" data-lrc-market={m.marketId}>
                    {/* HEADER — title, then badges on their OWN wrapping row. The pot line can no longer be
                        overlapped by a badge on a narrow screen: they are separate grid rows, not floats. */}
                    <div className="lrc-mkt-top">
                      <div className="lrc-mkt-title">
                        {m.title ?? m.marketId}
                        {m.groupItemTitle && <span className="lrc-mkt-git"> · {m.groupItemTitle}</span>}
                      </div>
                      <div className="lrc-mkt-pot">
                        <span className="lrc-pot-k">montepremi</span>
                        <span className="lrc-pot-v">{money(m.dailyPoolUsd, 0)}<span className="lrc-pot-u">/giorno</span></span>
                      </div>
                    </div>

                    <div className="lrc-badges">
                      {m.spread.level ? (
                        <span className={`lrc-badge lrc-sp-${m.spread.level}`} title={m.spread.note}>{m.spread.label}</span>
                      ) : (
                        <span className="lrc-badge lrc-b-unk" title={m.spread.note}>spread N/D</span>
                      )}
                      {m.stability.known && m.stability.label ? (
                        <span
                          className={`lrc-badge lrc-st-${m.stability.label.replace(/\s/g, '-')}`}
                          title={`stabilità misurata: uno scarto tipo muove ${num(m.stability.movedCents, 2)}¢, cioè il ${num(m.stability.consumedBandPct, 0)}% della mezza banda`}
                        >
                          {m.stability.label}
                        </span>
                      ) : (
                        <span className="lrc-badge lrc-b-unk" title={`stabilità non misurabile: ${m.stability.reason ?? 'motivo non riportato'}`}>stabilità N/D</span>
                      )}
                      {m.inBotUniverse === true && <span className="lrc-badge lrc-b-bot" title="il bot quota questo mercato (set risolto dalla selezione salvata)">nel set del bot</span>}
                      {mine.length > 0 && (
                        <span className={`lrc-badge ${mine.some((o) => o.outOfBand === true) ? 'lrc-b-bad' : 'lrc-b-good'}`}>
                          {mine.length} {mine.length === 1 ? 'tuo ordine' : 'tuoi ordini'}
                          {mine.some((o) => o.outOfBand === true) ? ' · fuori banda' : ''}
                        </span>
                      )}
                      {!m.rulesReadable && (
                        <span className="lrc-badge lrc-b-bad" title={`mancano: ${m.rulesMissing.join(', ')}`}>regole non leggibili</span>
                      )}
                    </div>

                    <PriceLadder
                      mid={m.mid} bandLo={m.bandLo} bandHi={m.bandHi} bandRadiusCents={m.bandRadiusCents}
                      bestBid={m.bestBid} bestAsk={m.bestAsk}
                      orders={mine.map((o) => ({ orderId: o.orderId, book: o.book, price: o.price, size: o.restingSize, inBand: o.inBand, distanceCents: o.distanceCents }))}
                      compact
                    />

                    <div className="lrc-mkt-grid">
                      <KV
                        k="stima al tuo capitale"
                        v={m.estUsdPerDay == null ? 'N/D' : `${money(m.estUsdPerDay)}/g`}
                        title={m.estUnknown ? (m.estReason ?? 'non calcolabile') : `quota modellata su ${money(m.estCapitalUsd, 0)} — il tuo saldo reale, non una cifra di riferimento`}
                      />
                      <KV
                        k="su capitale"
                        v={m.estCapitalUsd == null ? 'N/D' : money(m.estCapitalUsd, 0)}
                        title={m.estDepthLimited
                          ? 'il tuo saldo supera la profondità premiante di questo book: la stima è calcolata sulla profondità disponibile'
                          : 'il saldo reale del proxy, letto on-chain'}
                      />
                      <KV k="profondità in banda" v={money(m.bookDepthAtBandUsd, 0)} />
                      <KV k="mid" v={cents(m.mid)} title={`fonte: ${m.midSource ?? 'N/D'} · ${ageTxt(m.midAgeSec)}`} />
                      <KV k="bid / ask" v={`${cents(m.bestBid)} / ${cents(m.bestAsk)}`} />
                      <KV k="size minima" v={num(m.minSize)} />
                      <KV k="scade fra" v={hoursTxt(m.hoursToResolution)} />
                    </div>

                    {m.estReason && <p className="lrc-fine lrc-warn">{m.estReason}</p>}
                    {m.midSource !== 'live-book' && (
                      <p className="lrc-fine lrc-warn">
                        Il mid non viene dal book live ma dalla riga di scan ({m.midSource ?? 'N/D'}, {ageTxt(m.midAgeSec)}):
                        la banda disegnata è giudicata contro quel numero.
                      </p>
                    )}

                    <div className="lrc-mkt-actions">
                      <button className="lrc-link" onClick={() => setOpenLadder(open ? null : m.marketId)}>
                        {open ? 'Nascondi dettaglio banda' : 'Dettaglio banda'}
                      </button>
                      <Link className="lrc-link" href={`/dashboard/liquidity-rewards/${encodeURIComponent(m.marketId)}`} prefetch={false}>Apri il book →</Link>
                      <Link className="lrc-link" href={`/dashboard/liquidity-rewards/${encodeURIComponent(m.marketId)}/event`} prefetch={false}>Scheda mercato →</Link>
                    </div>

                    {open && (
                      <div className="lrc-expand">
                        <PriceLadder
                          mid={m.mid} bandLo={m.bandLo} bandHi={m.bandHi} bandRadiusCents={m.bandRadiusCents}
                          bestBid={m.bestBid} bestAsk={m.bestAsk}
                          orders={mine.map((o) => ({ orderId: o.orderId, book: o.book, price: o.price, size: o.restingSize, inBand: o.inBand, distanceCents: o.distanceCents }))}
                          caption="banda premio · mid · tocco · i tuoi ordini"
                        />
                        <div className="lrc-mkt-grid">
                          <KV k="banda" v={`${cents(m.bandLo)} – ${cents(m.bandHi)}`} />
                          <KV k="raggio banda" v={`±${num(m.bandRadiusCents, 2)}¢`} />
                          <KV k="tick" v={m.tick == null ? 'N/D' : String(m.tick)} />
                          <KV k="volume 24h" v={money(m.volume24hUsd, 0)} />
                          <KV k="categoria" v={m.category ?? 'N/D'} />
                          <KV k="id" v={`${m.marketId.slice(0, 10)}…`} title={m.marketId} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {visibleMarkets.length > limit && (
                <button className="lrc-btn lrc-more" onClick={() => setLimit((l) => l + PAGE)}>
                  Mostra altri {Math.min(PAGE, visibleMarkets.length - limit)} (di {visibleMarkets.length})
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── 3 · POSIZIONI ─────────────────────────────────────────────────────────────────────────── */}
      {tab === 'posizioni' && (
        <section className="lrc-sec" data-lrc-section="posizioni">
          <div className="lrc-sechead">
            <span className="lrc-sectitle">Posizioni aperte · esposizione netta per mercato</span>
            <button className="lrc-btn" onClick={loadPositions} disabled={posLoading}>{posLoading ? 'Lettura…' : 'Aggiorna'}</button>
          </div>

          {pos && pos.ok === false && (
            <div className="lrc-banner lrc-banner-red">
              Posizioni NON lette: {pos.error ?? 'errore sconosciuto'}. Questa non è una lista vuota — non sappiamo cosa ci sia.
            </div>
          )}
          {pos?.ok && pos.markets.length === 0 && (
            <div className="lrc-banner lrc-banner-ok">
              Nessuna posizione aperta sul wallet <span className="lrc-num">{pos.wallet}</span> — letto dal venue, non dedotto.
            </div>
          )}
          {!pos && <div className="lrc-note">Lettura delle posizioni…</div>}

          {pos?.ok && pos.markets.length > 0 && (
            <>
              <div className="lrc-metrics lrc-metrics-sm">
                <Metric k="Mercati con posizione" v={String(pos.totals?.marketCount ?? 0)} sub={`${pos.totals?.legCount ?? 0} gambe YES/NO`} />
                <Metric k="Valore a mid" v={money(pos.totals?.currentValueUsd)} sub={pos.totals?.valueUnknown ? 'una gamba senza valore leggibile — totale non calcolato' : 'mark-to-mid, non realizzato'} warn={pos.totals?.valueUnknown} />
                <Metric k="P&L non realizzato" v={money(pos.totals?.unrealizedPnlUsd)} sub="mark-to-mid · non è un incasso" warn={pos.totals?.valueUnknown} />
              </div>

              <div className="lrc-poslist">
                {pos.markets.map((p) => (
                  <div key={p.marketId ?? Math.random()} className="lrc-pos" data-lrc-position={p.marketId ?? ''}>
                    <div className="lrc-mkt-top">
                      <div className="lrc-mkt-title">{p.title ?? p.marketId ?? 'mercato sconosciuto'}</div>
                      <div className="lrc-mkt-pot">
                        <span className="lrc-pot-k">netto</span>
                        <span className={`lrc-pot-v ${p.netDirection === 'yes' ? 'lrc-ok' : p.netDirection === 'no' ? 'lrc-bad' : ''}`}>
                          {p.netDirection === 'flat' ? 'piatto' : `${num(Math.abs(p.netShares ?? 0), 1)} ${p.netDirection.toUpperCase()}`}
                        </span>
                      </div>
                    </div>
                    <div className="lrc-mkt-grid">
                      <KV k="YES" v={`${num(p.yesShares, 1)} share`} />
                      <KV k="NO" v={`${num(p.noShares, 1)} share`} />
                      <KV k="netto YES−NO" v={num(p.netShares, 1)} title="una gamba YES e una NO sullo stesso mercato sono UNA esposizione: il netto è la differenza" />
                      <KV k="valore a mid" v={money(p.currentValueUsd)} />
                      <KV k="costo" v={money(p.initialValueUsd)} />
                      <KV k="P&L non realiz." v={money(p.unrealizedPnlUsd)} />
                    </div>
                    <div className="lrc-legs">
                      {p.legs.map((l) => (
                        <div key={l.asset} className="lrc-leg">
                          <span className={`lrc-badge ${l.side === 'yes' ? 'lrc-b-good' : l.side === 'no' ? 'lrc-b-bad' : 'lrc-b-unk'}`}>
                            {l.sideKnown ? (l.side as string).toUpperCase() : 'lato N/D'}
                          </span>
                          <span className="lrc-num">{num(l.size, 1)} share</span>
                          <span className="lrc-fine">medio {cents(l.avgPrice)} → mid {cents(l.curPrice)}</span>
                          <span className="lrc-fine">{money(l.currentValueUsd)}</span>
                          {!l.sideKnown && <span className="lrc-fine lrc-warn">lato non riportato dal venue: esclusa dal netto, non indovinata</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {pos && (
            <p className="lrc-note">
              Fonte: {pos.source}. Wallet <span className="lrc-num">{pos.wallet ?? 'N/D'}</span>, letto {new Date(pos.at).toLocaleTimeString()}.
              Sola lettura: nessuna chiave viene toccata e nulla viene firmato. Il P&L è <b>mark-to-mid</b>,
              cioè quanto varrebbero le posizioni al punto medio adesso — non un incasso.
            </p>
          )}
        </section>
      )}

      {/* ── 4 · ORDINI MANUALI ────────────────────────────────────────────────────────────────────── */}
      {tab === 'ordini' && (
        <section className="lrc-sec" data-lrc-section="ordini">
          {(() => {
            // The ladder for the market the manual panel is pinned to — same board data, so the ladder and
            // the panel below cannot show a different band or a different mid.
            const withOrders = Array.from(ordersByMarket.keys());
            const pinnedId = withOrders.length === 1 ? withOrders[0] : (pricedMarkets.find((m) => m.inBotUniverse === true)?.marketId ?? null);
            const pinned = pinnedId ? pricedMarkets.find((m) => m.marketId === pinnedId) ?? null : null;
            if (!pinned) return null;
            const po = ordersByMarket.get(pinned.marketId) ?? [];
            return (
              <div className="lrc-card lrc-card-wide">
                <div className="lrc-card-k">Scala prezzi · {pinned.title ?? pinned.marketId}</div>
                <PriceLadder
                  mid={pinned.mid} bandLo={pinned.bandLo} bandHi={pinned.bandHi} bandRadiusCents={pinned.bandRadiusCents}
                  bestBid={pinned.bestBid} bestAsk={pinned.bestAsk}
                  orders={po.map((o) => ({ orderId: o.orderId, book: o.book, price: o.price, size: o.restingSize, inBand: o.inBand, distanceCents: o.distanceCents }))}
                  caption="dove paga la banda, dove sta il tocco, dove stanno i tuoi ordini"
                />
                <p className="lrc-fine">
                  Il modulo qui sotto è la console ordini manuali completa: prende/restituisce il mercato al
                  motore, piazza, cancella e <b>riprezza</b> (cancella e ripiazza in una sola chiamata server).
                  Ogni bottone passa dagli stessi gate del motore — kill-switch, cap, venue-rules, validateOrder.
                </p>
              </div>
            );
          })()}
          <ManualOrdersPanel />
        </section>
      )}

      {/* ── 5 · ALLOCA CAPITALE ───────────────────────────────────────────────────────────────────── */}
      {tab === 'alloca' && (
        <section className="lrc-sec" data-lrc-section="alloca">
          <RewardsAllocatePanel />
        </section>
      )}

      {/* ── 6 · REGOLE ────────────────────────────────────────────────────────────────────────────── */}
      {tab === 'regole' && (
        <section className="lrc-sec" data-lrc-section="regole">
          <div className="lrc-card lrc-card-wide">
            <div className="lrc-card-k">Come si guadagna, in breve</div>
            <ul className="lrc-rules">
              <li>
                <b>Il premio si prende stando dentro la banda.</b> Ogni mercato premiante ha un
                <i> mid di scoring</i> e una banda larga <code>max_incentive_spread</code>: un ordine a riposo
                matura solo se il suo prezzo dista dal mid meno di metà banda. Un tick fuori e matura
                <b> zero</b> — non «un po&apos; meno».
              </li>
              <li>
                <b>Sotto la size minima non matura nulla.</b> Ogni mercato pubblica una
                <code> min_incentive_size</code>: un ordine più piccolo è valido sul CLOB ma invisibile al
                programma premi.
              </li>
              <li>
                <b>Il premio si divide con gli altri.</b> Il montepremi giornaliero è fisso e si spartisce fra
                tutti i maker in banda con la formula quadratica pubblicata S(v,s) = ((v−s)/v)²: più vicino al
                mid vale di più, e la tua quota si diluisce con la profondità già presente. Se il book è
                sottile la tua quota è alta ma il montepremi è quello che è.
              </li>
              <li>
                <b>Due lati valgono più di uno.</b> Il punteggio prende il minimo fra i due lati (Q_min): una
                quota solo bid vale una frazione di una quota a due lati.
              </li>
              <li>
                <b>Le cifre sono lorde.</b> Il costo di adverse selection quando i tuoi ordini vengono
                eseguiti non è modellato da nessuna parte in questa pagina. Il netto è sconosciuto e non
                viene stimato.
              </li>
              <li>
                <b>Il mid si muove.</b> Un ordine in banda adesso può uscirne senza che tu tocchi nulla:
                per questo l&apos;intestazione conta gli ordini fuori banda e il Riepilogo li nomina.
              </li>
            </ul>
          </div>

          <div className="lrc-sechead">
            <span className="lrc-sectitle">Tutti i tuoi ordini attivi · distanza dal mid e stato</span>
            <span className="lrc-fine">
              {orders?.at ? `letto dal venue ${new Date(orders.at).toLocaleTimeString()}` : 'N/D'}
            </span>
          </div>

          {orders?.ok === false && (
            <div className="lrc-banner lrc-banner-red">Lettura del venue FALLITA: {orders.error ?? '—'} — questa non è una lista vuota.</div>
          )}
          {orders?.simulated && orders.ok !== false && (
            <div className="lrc-banner lrc-banner-warn">
              Nessuna credenziale: il venue non è stato interrogato. «0 ordini» qui significa «non abbiamo letto».
            </div>
          )}

          {orders && orders.orders.length === 0 && orders.ok !== false && !orders.simulated ? (
            <div className="lrc-nd">Nessun ordine a riposo su nessun mercato (letto dal venue, non dedotto).</div>
          ) : (
            <div className="lrc-tblwrap">
              <table className="lrc-tbl" data-lrc-orders-table>
                <thead>
                  <tr>
                    <th>Mercato</th><th>Lato</th><th>Prezzo</th><th>Mid</th>
                    <th>Distanza</th><th>Banda</th><th>Stato</th><th>Size</th><th>Controvalore</th>
                  </tr>
                </thead>
                <tbody>
                  {(orders?.orders ?? []).map((o) => (
                    <tr key={o.orderId ?? Math.random()} className={o.outOfBand === true ? 'is-out' : ''}>
                      <td className="lrc-td-mkt">{o.marketTitle ?? o.marketId ?? 'N/D'}</td>
                      <td>{o.book ? o.book.toUpperCase() : 'N/D'}</td>
                      <td className="lrc-num">{cents(o.price)}</td>
                      <td className="lrc-num">{cents(o.scoringMid)}</td>
                      <td className="lrc-num">{o.distanceCents == null ? 'N/D' : `${o.distanceCents.toFixed(2)}¢`}</td>
                      <td className="lrc-num">{o.bandRadiusCents == null ? 'N/D' : `±${o.bandRadiusCents.toFixed(2)}¢`}</td>
                      <td>
                        {o.inBand === true ? <span className="lrc-badge lrc-b-good">in banda ✓</span>
                          : o.inBand === false ? <span className="lrc-badge lrc-b-bad">fuori banda ✗</span>
                            : <span className="lrc-badge lrc-b-unk" title={o.rulesReadable ? 'token non riconducibile ai due book del mercato' : 'regole di venue non leggibili'}>non giudicabile ?</span>}
                        {o.valid === false && o.inBand === true && (
                          <span className="lrc-badge lrc-b-unk" title={o.reasons.map((r) => `${r.code}: ${r.detail}`).join(' · ')}>
                            {o.reasons.map((r) => r.code).join(', ')}
                          </span>
                        )}
                      </td>
                      <td className="lrc-num">{num(o.restingSize, 1)}</td>
                      <td className="lrc-num">{money(o.restingNotionalUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="lrc-note">
            «In banda» è il verdetto della <b>stessa</b> funzione condivisa che il server riesegue prima di
            ogni piazzamento (lib/maker/venue-rules → lib/rewards-live-band): questa tabella non può dire
            «in banda» su un ordine che il server rifiuterebbe. «Non giudicabile» significa che una regola
            del venue non era leggibile — non viene contato né dentro né fuori.
          </p>
        </section>
      )}
    </div>
  );
}

function Metric({ k, v, sub, warn }: { k: string; v: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`lrc-metric ${warn ? 'is-warn' : ''}`}>
      <span className="lrc-metric-k">{k}</span>
      <span className="lrc-metric-v">{v}</span>
      {sub && <span className="lrc-metric-s">{sub}</span>}
    </div>
  );
}

function KV({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <div className="lrc-kv" title={title}>
      <span className="lrc-kv-k">{k}</span>
      <span className="lrc-kv-v">{v}</span>
    </div>
  );
}

const CSS = `
.lrc-root { max-width: 1080px; margin: 0 auto 20px; padding: 14px 16px 20px; color: #E6E9EF;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
.lrc-head { border: 1px solid #2A3040; border-radius: 12px; background: #10141C; padding: 14px 16px; }
.lrc-title-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.lrc-h1 { font-size: 15px; font-weight: 800; letter-spacing: .3px; margin: 0; color: #E6E9EF; }
.lrc-venue { font-size: 11px; font-weight: 700; color: #9AA4B2; border: 1px solid #2E3646; border-radius: 999px; padding: 2px 8px; }

.lrc-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-top: 12px; }
.lrc-metrics-sm { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-bottom: 12px; }
.lrc-metric { border: 1px solid #232937; border-radius: 10px; background: #0d1119; padding: 10px 12px; min-width: 0; }
.lrc-metric.is-warn { border-color: #4a3c12; }
.lrc-metric-k { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: #8B95A5; }
.lrc-metric-v { display: block; font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums;
  margin-top: 2px; line-height: 1.15; word-break: break-word; }
.lrc-metric-s { display: block; font-size: 11px; color: #8B95A5; margin-top: 4px; line-height: 1.45; }

.lrc-tabs { display: flex; gap: 6px; margin-top: 14px; overflow-x: auto; -webkit-overflow-scrolling: touch;
  scrollbar-width: none; padding-bottom: 2px; }
.lrc-tabs::-webkit-scrollbar { display: none; }
.lrc-tab { position: relative; min-height: 38px; padding: 0 14px; border: 1px solid #2E3646; border-radius: 8px;
  background: #141926; color: #9AA4B2; font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap;
  flex: 0 0 auto; touch-action: manipulation; }
.lrc-tab:hover { background: #1b2233; }
.lrc-tab.is-on { color: #DCE6FF; border-color: #2E5FBE; background: #16233E; }
.lrc-tab-short { display: none; }
.lrc-tab-dot { position: absolute; top: 5px; right: 6px; width: 7px; height: 7px; border-radius: 50%; background: #E5574E; }
.lrc-feedage { font-size: 11px; color: #6E7889; margin-top: 10px; line-height: 1.5; }

.lrc-sec { margin-top: 14px; }
.lrc-sechead { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin: 16px 0 8px; flex-wrap: wrap; }
.lrc-sectitle { font-size: 12px; font-weight: 800; letter-spacing: .4px; text-transform: uppercase; color: #9AA4B2; }

.lrc-banner { border-radius: 10px; padding: 11px 14px; margin-bottom: 12px; font-size: 13px; line-height: 1.5; }
.lrc-banner-red { color: #FFC9C4; border: 1px solid #5c1f1a; background: #1a0b0a; }
.lrc-banner-warn { color: #F0D08A; border: 1px solid #4a3c12; background: #1a1608; }
.lrc-banner-ok { color: #A9E3C4; border: 1px solid #205038; background: #0d1f16; }

.lrc-alert { border: 1px solid #5c1f1a; background: #1a0b0a; border-radius: 12px; padding: 13px 15px; margin-bottom: 14px; }
.lrc-alert-t { color: #FF9C93; font-weight: 800; font-size: 14px; margin-bottom: 8px; }
.lrc-alert-list { margin: 0 0 10px; padding-left: 18px; font-size: 13px; color: #FFC9C4; line-height: 1.6; }
.lrc-alert-list li { margin-bottom: 5px; }

.lrc-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
.lrc-card { border: 1px solid #232937; border-radius: 12px; background: #10141C; padding: 13px 15px; min-width: 0; }
.lrc-card-wide { grid-column: 1 / -1; margin-bottom: 12px; }
.lrc-card-k { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: #8B95A5; margin-bottom: 6px; }
.lrc-card-v { font-size: 14px; font-weight: 700; line-height: 1.35; }
.lrc-card-big { font-size: 26px; font-weight: 800; font-variant-numeric: tabular-nums; margin-top: 4px; }
.lrc-card-unit { font-size: 13px; font-weight: 600; color: #8B95A5; margin-left: 4px; }
.lrc-card-sub { font-size: 12px; color: #8B95A5; margin-top: 4px; line-height: 1.5; }
.lrc-rank { margin: 10px 0 0; padding-left: 18px; font-size: 12px; color: #B7C0CE; line-height: 1.7; }
.lrc-rank-t { margin-left: 8px; color: #8B95A5; }

.lrc-barwrap { height: 8px; border-radius: 999px; background: #1b2233; margin-top: 10px; overflow: hidden; }
.lrc-bar { height: 100%; border-radius: 999px; }
.lrc-bar-used { background: #2E5FBE; }

.lrc-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.lrc-scope { display: flex; gap: 6px; flex-wrap: wrap; }
.lrc-chip { min-height: 34px; padding: 0 12px; border: 1px solid #2E3646; border-radius: 8px; background: #141926;
  color: #9AA4B2; font-size: 12px; font-weight: 700; cursor: pointer; }
.lrc-chip.is-on { color: #DCE6FF; border-color: #2E5FBE; background: #16233E; }
.lrc-search { flex: 1 1 200px; min-width: 0; min-height: 34px; padding: 0 10px; border: 1px solid #2E3646;
  border-radius: 8px; background: #0d1420; color: #E6E9EF; font-size: 13px; }

.lrc-mkts { display: flex; flex-direction: column; gap: 12px; }
.lrc-mkt { border: 1px solid #232937; border-radius: 12px; background: #10141C; padding: 12px 14px; }
/* THE OLD OVERLAP BUG: the pot line and the badges used to share one flex row, so on a narrow screen a
   badge rode over the montepremi $X/giorno text. They are now separate block rows — the title/pot row
   collapses to one column under 620px and the badges wrap on their own line, so nothing can overlap.
   NOTE: keep this stylesheet free of the characters React escapes in text nodes — quotes, angle
   brackets, ampersands. As the child of a style element they are serialised escaped on the server and
   raw on the client, which is a hydration mismatch that takes the whole root down to client rendering. */
.lrc-mkt-top { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 14px; align-items: start; }
.lrc-mkt-title { font-size: 14px; font-weight: 700; line-height: 1.35; min-width: 0; overflow-wrap: anywhere; }
.lrc-mkt-git { color: #8B95A5; font-weight: 600; }
.lrc-mkt-pot { text-align: right; white-space: nowrap; min-width: 0; }
.lrc-pot-k { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: #8B95A5; }
.lrc-pot-v { display: block; font-size: 15px; font-weight: 800; font-variant-numeric: tabular-nums; }
.lrc-pot-u { font-size: 11px; font-weight: 600; color: #8B95A5; margin-left: 2px; }

.lrc-badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 9px 0 2px; }
.lrc-badge { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 999px; white-space: nowrap;
  border: 1px solid #2E3646; background: #141926; color: #9AA4B2; }
.lrc-sp-basso { color: #A9E3C4; border-color: #205038; background: #0d1f16; }
.lrc-sp-medio { color: #E8B23A; border-color: #4a3c12; background: #1a1608; }
.lrc-sp-alto { color: #FF9C93; border-color: #5c1f1a; background: #1a0b0a; }
.lrc-st-fermo { color: #A9E3C4; border-color: #205038; background: #0d1f16; }
.lrc-st-medio { color: #E8B23A; border-color: #4a3c12; background: #1a1608; }
.lrc-st-si-muove { color: #FF9C93; border-color: #5c1f1a; background: #1a0b0a; }
.lrc-b-good { color: #A9E3C4; border-color: #205038; background: #0d1f16; }
.lrc-b-bad { color: #FF9C93; border-color: #5c1f1a; background: #1a0b0a; }
.lrc-b-unk { color: #E8B23A; border-color: #4a3c12; background: #1a1608; }
.lrc-b-bot { color: #DCE6FF; border-color: #2E5FBE; background: #16233E; }

.lrc-mkt-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px 14px; margin-top: 10px; }
.lrc-kv { min-width: 0; }
.lrc-kv-k { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: #8B95A5; }
.lrc-kv-v { display: block; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }

.lrc-mkt-actions { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 11px; }
.lrc-link { background: none; border: none; padding: 0; font-size: 12px; font-weight: 700; color: #7FA6FF;
  cursor: pointer; text-decoration: none; }
.lrc-link:hover { text-decoration: underline; }
.lrc-expand { margin-top: 12px; border-top: 1px solid #1a2030; padding-top: 10px; }

.lrc-poslist { display: flex; flex-direction: column; gap: 12px; }
.lrc-pos { border: 1px solid #232937; border-radius: 12px; background: #10141C; padding: 12px 14px; }
.lrc-legs { margin-top: 10px; border-top: 1px solid #1a2030; padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.lrc-leg { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 12px; }

.lrc-tblwrap { overflow-x: auto; border: 1px solid #232937; border-radius: 10px; }
.lrc-tbl { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 720px; }
.lrc-tbl th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: #8B95A5;
  padding: 8px 10px; border-bottom: 1px solid #232937; white-space: nowrap; }
.lrc-tbl td { padding: 8px 10px; border-bottom: 1px solid #1a2030; vertical-align: top; }
.lrc-tbl tr.is-out td { background: rgba(229,87,78,.07); }
.lrc-td-mkt { max-width: 260px; overflow-wrap: anywhere; }

.lrc-rules { margin: 0; padding-left: 18px; font-size: 13px; color: #B7C0CE; line-height: 1.65; }
.lrc-rules li { margin-bottom: 9px; }
.lrc-rules code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #9AA4B2;
  background: #0d1119; border: 1px solid #232937; border-radius: 4px; padding: 1px 5px; }

.lrc-btn { min-height: 38px; padding: 0 16px; border: 1px solid #2E5FBE; border-radius: 8px; cursor: pointer;
  font-size: 13px; font-weight: 700; color: #DCE6FF; background: #16233E; touch-action: manipulation; }
.lrc-btn:hover { background: #1B2C4E; }
.lrc-btn:disabled { opacity: .55; cursor: not-allowed; }
.lrc-more { width: 100%; }

.lrc-note { font-size: 12px; color: #8B95A5; line-height: 1.55; margin: 14px 0 0; }
.lrc-fine { font-size: 11px; color: #8B95A5; line-height: 1.5; margin: 6px 0 0; }
.lrc-nd { font-size: 13px; color: #8B95A5; padding: 16px 2px; }
.lrc-num { font-variant-numeric: tabular-nums; }
.lrc-warn { color: #E8B23A; }
.lrc-ok { color: #57C98A; }
.lrc-bad { color: #E5574E; }

@media (max-width: 620px) {
  .lrc-root { padding: 10px 10px 18px; }
  .lrc-head { padding: 12px; }
  .lrc-metrics { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
  .lrc-metric-v { font-size: 19px; }
  .lrc-tab { padding: 0 11px; font-size: 12px; }
  .lrc-tab-long { display: none; }
  .lrc-tab-short { display: inline; }
  /* Title and pot stack: the pot gets its own full-width row, left aligned, so no badge or long title
     can ever ride over it. */
  .lrc-mkt-top { grid-template-columns: minmax(0, 1fr); }
  .lrc-mkt-pot { text-align: left; }
  .lrc-card-big { font-size: 22px; }
}
`;

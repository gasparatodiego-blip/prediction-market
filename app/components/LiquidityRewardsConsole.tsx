'use client';

// LiquidityRewardsConsole — the ONE page, ONE URL, SIX sections operator console for the Polymarket
// liquidity-rewards maker (/dashboard/liquidity-rewards).
//
// SIX SECTIONS, NO NAVIGATION. Riepilogo · Mercati · Posizioni · Ordini manuali · Ottimizza capitale ·
// Regole are tabs held in client state. Switching one does not touch the URL, does not remount the data
// and does not refetch: the board is fetched once per poll and every section is a projection of it.
// (The legacy /dashboard/liquidity-rewards/allocate route redirects here with ?tab=alloca, which is read
// ONCE at mount purely to pick the landing section — after that the URL never changes again.)
//
// EXCHANGE SURFACE, DENSE BY DESIGN (shared .exch language in globals.css). Every figure this console
// knows is ON SCREEN: balance, committed, $/day, out-of-band count sit on one strip at the top; each
// market row carries mid, spread and $/day right-aligned; nothing that matters is behind a tap. A value
// that is $0 or does not qualify still renders AS A FIGURE, with a small red note underneath saying why
// — hiding a zero is how an operator ends up believing a market is earning when it is not.
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
// with the reason, never a fallback to the reference. (The "Ottimizza capitale" planner is deliberately
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
// "Strategia sul fill" — sotto il pianificatore, perche' il tetto che quella strategia applica E' il
// capitale che il pianificatore assegna: una decisione sola, una schermata sola.
import FillStrategyPanel from './FillStrategyPanel';
import RewardsUnified from './RewardsUnified';

type TabKey = 'riepilogo' | 'mercati' | 'posizioni' | 'ordini' | 'alloca' | 'regole';

const TABS: Array<{ key: TabKey; label: string; short: string }> = [
  { key: 'riepilogo', label: 'Riepilogo', short: 'Riepilogo' },
  { key: 'mercati', label: 'Mercati', short: 'Mercati' },
  { key: 'posizioni', label: 'Posizioni', short: 'Posizioni' },
  { key: 'ordini', label: 'Ordini manuali', short: 'Ordini' },
  { key: 'alloca', label: 'Ottimizza capitale', short: 'Ottimizza' },
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
  // ── LA SOGLIA DEL VENUE ────────────────────────────────────────────────────────────────────────
  // Sotto min_incentive_size il venue non assegna punteggio: la stima e' ZERO, non una frazione. Prima
  // la riscalatura dal capitale di riferimento non lo sapeva e mostrava una cifra positiva su una
  // posizione che non avrebbe scorato nulla.
  estBelowMinSize: boolean;
  estCapitalToQualifyUsd: number | null;
  estMinSizeJudgeable: boolean;
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
/**
 * Un risultato della ricerca SENZA FILTRO REWARD — la stessa fonte che «Cerca un mercato» usa nella tab
 * Ottimizza (/api/maker/markets/search → lib/maker/market-search). Porta molti meno campi di una riga di
 * board: niente stabilità, niente stima, niente banda misurata, perché quei numeri li produce la
 * pipeline reward e un mercato fuori da quella pipeline non li ha. Vengono mostrati i campi che il venue
 * dà davvero, e nessun altro.
 */
interface VenueSearchRow {
  marketId: string; question: string | null; slug: string | null;
  tradable?: boolean; notTradableReason?: string | null;
  rewardsDailyRate: number | null; hasRewards: boolean; rewardLabel: string;
  spreadCents: number | null; tick: number | null; rewardsMaxSpreadCents: number | null;
  minutesToClose: number | null; tooCloseToClose: boolean;
  bestBid: number | null; bestAsk: number | null; mid: number | null;
  closed: boolean; acceptingOrders: boolean;
  enabled: boolean; optedIn: boolean; catalogued: boolean;
}
interface VenueSearchResp {
  ok: boolean; error: string | null; query: string; count: number;
  markets: VenueSearchRow[]; withRewards: number; withoutRewards: number;
  /** Quanti la ricerca ha tolto perché non operabili (risolti, ritirati, scaduti, senza ordini). */
  notTradableDropped?: number;
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
/** Tempo alla chiusura da minuti — stessa convenzione di closeText nel pannello Ottimizza. */
const closeTxt = (min: number | null): string => {
  if (min == null || !Number.isFinite(min)) return 'scadenza ignota';
  if (min < 0) return `chiuso da ${Math.abs(min) < 90 ? `${Math.round(Math.abs(min))} min` : `${(Math.abs(min) / 60).toFixed(1)} h`}`;
  // Sotto il minuto l arrotondamento darebbe «chiude fra 0 min», che si legge come «gia chiuso».
  if (min < 1) return 'chiude fra meno di 1 min';
  // Sotto i 10 minuti il decimo di minuto conta: su un ciclo da 5 minuti «4.2» e «4.8» sono cose diverse.
  if (min < 10) return `chiude fra ${min.toFixed(1)} min`;
  if (min < 90) return `chiude fra ${Math.round(min)} min`;
  if (min < 2880) return `chiude fra ${(min / 60).toFixed(1)} h`;
  return `chiude fra ${(min / 1440).toFixed(1)} g`;
};
const hoursTxt = (h: number | null): string =>
  (!fin(h) ? 'N/D' : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} g`);
/** Sign class for a P&L figure: green up, red down, neutral at exactly flat or unreadable. */
const pnlCls = (v: number | null | undefined): string => (!fin(v) ? '' : v > 0 ? 'ex-up' : v < 0 ? 'ex-dn' : '');

const BOARD_POLL_MS = 20_000;
const BALANCE_POLL_MS = 60_000;
const POSITIONS_POLL_MS = 60_000;
const PAGE = 20;
/** «In scadenza» horizon. Same hoursToResolution the card already prints as "scade fra". */
const SOON_HOURS = 24 * 7;

// ── MOVEMENT: THE MEASURE ALREADY IN THE FEED, NOT A NEW ONE ────────────────────────────────────
// lib/reward-stability computes it server-side: the stdev of the mid over a 7-day window sampled
// hourly, expressed as a fraction of the reward band's half-width, scored 0–100 (100 = still).
// The two chips read its published cut-points, they do not re-derive anything:
//   fermo    score ≥ 70   one stdev consumes under 30% of the half-band
//   si muove score < 35   one stdev consumes 65% or more of it
// A market whose stability is UNKNOWN matches NEITHER chip. That is deliberate and it is the whole
// reason this metric is worth using: it returns unknown when a price sat still because nobody
// traded, and "nobody traded" is not "calm". Counting those as fermi would fill the chip with
// exactly the markets a maker must avoid.
const isStill = (m: PricedMarket): boolean => m.stability.known === true && m.stability.label === 'fermo';
const isFast = (m: PricedMarket): boolean => m.stability.known === true && m.stability.label === 'si muove';

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
  const [limit, setLimit] = useState(PAGE);
  // ── CHIP FILTERS ───────────────────────────────────────────────────────────────────────────────
  // Combinable across dimensions, and each one filters the list for real. `sortByPool` is the one
  // exception: it REORDERS and removes nothing, which is why it wears a different chip style.
  //
  // «fermi» and «veloci» are the two ends of one dimension, so they are mutually exclusive — asking
  // for both at once is asking for the empty set, and a control that can only produce nothing is a
  // trap, not a filter.
  const [sortByPool, setSortByPool] = useState(false);
  const [fMove, setFMove] = useState<'fermi' | 'veloci' | null>(null);
  const [fSoon, setFSoon] = useState(false);
  const [fEnabled, setFEnabled] = useState(false);
  const [fMine, setFMine] = useState(false);
  // Everything technical about one market — ladder, band, tick, id, volume — behind one toggle.
  // One market open at a time: the list is already long.
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  // ── LA RICERCA SULL'INTERO UNIVERSO ────────────────────────────────────────────────────────────
  // La barra di ricerca interroga anche il venue, non solo il board reward. Un mercato senza montepremi
  // (una finestra «Bitcoin Up or Down», per dire) non è nel board per costruzione — agent24 filtra su
  // rewardsDailyRate > 0 — quindi filtrare soltanto la lista locale lo rendeva introvabile qui mentre la
  // tab Alloca lo trovava. Stessa barra, stessa fonte, stesso risultato: è quello che ci si aspetta.
  const [venue, setVenue] = useState<VenueSearchResp | null>(null);
  const [venueBusy, setVenueBusy] = useState(false);
  const [venueErr, setVenueErr] = useState<string | null>(null);
  // Il termine da passare al pannello Alloca quando si arriva li' da un risultato «fuori board».
  const [allocPrefill, setAllocPrefill] = useState<string | null>(null);

  // A slow clock, so every freshness readout AGES VISIBLY between polls instead of looking frozen-fresh
  // until the next fetch lands. 5s is finer than the fastest cadence on this page (20s) and costs one
  // re-render, never a refetch. Seeded in an effect, not in the initial state: Date.now() during the
  // first render differs between server and client and would desync hydration.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

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

  // La ricerca sul venue parte SOLO da 3 caratteri e con 400ms di quiete: la barra filtra dal vivo la
  // lista locale a ogni tasto, ma una GET verso Gamma a ogni tasto sarebbe una richiesta per lettera.
  // La lista locale resta istantanea; questa la affianca quando la digitazione si ferma.
  useEffect(() => {
    const needle = q.trim();
    if (operator !== true || needle.length < 3) { setVenue(null); setVenueErr(null); return; }
    let alive = true;
    setVenueBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/maker/markets/search?q=${encodeURIComponent(needle)}&limit=25`, { cache: 'no-store' });
        if (!alive) return;
        const b = (await r.json()) as VenueSearchResp;
        setVenue(b);
        setVenueErr(b.ok === false ? (b.error ?? 'ricerca fallita') : null);
      } catch (e) {
        if (alive) { setVenue(null); setVenueErr((e as Error).message); }
      } finally { if (alive) setVenueBusy(false); }
    }, 400);
    return () => { alive = false; clearTimeout(t); setVenueBusy(false); };
  }, [q, operator]);

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
      estBelowMinSize: e.belowVenueMinSize === true,
      estCapitalToQualifyUsd: e.capitalToQualifyUsd ?? null,
      estMinSizeJudgeable: e.minSizeJudgeable !== false,
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

  // ── THE ONE QUESTION THE TOP OF THE PAGE ANSWERS ──────────────────────────────────────────────────
  // "Il capitale sta maturando premi?" — derived ONLY from data this console already fetched.
  //
  // It deliberately does NOT answer "is the bot armed". That is a different fact with a different source
  // (/api/maker/status) and it belongs to MakerArmingPanel, rendered directly above this component.
  // Deriving the same claim twice, from two fetches, is exactly how two panels start disagreeing.
  //
  // FOUR states, not three. A traffic light with only green/amber/red would force "we could not read the
  // venue" to borrow a colour from "nothing is earning". Those are different claims — one is a fact about
  // the orders, the other is the absence of a fact — and this codebase never lets the second wear the
  // clothes of the first. Unknown is grey, and grey is never red.
  const earning = useMemo((): { state: 'ok' | 'warn' | 'bad' | 'unknown'; label: string; detail: string } => {
    if (!orders) return { state: 'unknown', label: 'IN LETTURA…', detail: 'Board non ancora ricevuto dal server.' };
    if (orders.simulated) return {
      state: 'unknown',
      label: 'NON LO SAPPIAMO',
      detail: 'Nessuna credenziale di lettura: il venue non è stato interrogato. Non significa «zero ordini».',
    };
    if (orders.ok === false) return {
      state: 'unknown',
      label: 'NON LO SAPPIAMO',
      detail: `Lettura del venue fallita: ${orders.error ?? 'errore non riportato'}. Questa non è una lista vuota.`,
    };
    const inBand = summary?.inBandCount ?? 0;
    const out = summary?.outOfBandCount ?? 0;
    const unk = summary?.unknownBandCount ?? 0;
    if (orders.count === 0) return {
      state: 'bad',
      label: 'FERMO',
      detail: 'Nessun ordine a riposo sul venue — letto, non dedotto. Il capitale non sta maturando nulla.',
    };
    if (inBand > 0 && out === 0 && unk === 0) return {
      state: 'ok',
      label: 'STA MATURANDO',
      detail: `Tutti i ${inBand} ordini a riposo sono dentro la banda premiante.`,
    };
    if (inBand === 0) return {
      state: 'bad',
      label: 'NON MATURA',
      detail: `${out} ${out === 1 ? 'ordine è fuori banda' : 'ordini sono fuori banda'}${unk > 0 ? `, ${unk} non giudicabili` : ''}: nessun ordine sta maturando.`,
    };
    return {
      state: 'warn',
      label: 'SOLO IN PARTE',
      detail: `${inBand} in banda, ${out} fuori${unk > 0 ? `, ${unk} non giudicabili` : ''}. Solo la parte in banda matura.`,
    };
  }, [orders, summary]);

  // How many markets each chip would show, computed on the SAME predicates the chips filter with —
  // so a chip can never advertise a count its own filter does not produce. A zero count is shown, not
  // hidden: "0 fermi" is the answer to "which ones are still?", and hiding the chip would leave the
  // question unanswered.
  const chipCounts = useMemo(() => ({
    fermi: pricedMarkets.filter(isStill).length,
    veloci: pricedMarkets.filter(isFast).length,
    soon: pricedMarkets.filter((m) => fin(m.hoursToResolution) && (m.hoursToResolution as number) <= SOON_HOURS).length,
    enabled: pricedMarkets.filter((m) => m.inBotUniverse === true).length,
    mine: pricedMarkets.filter((m) => ordersByMarket.has(m.marketId)).length,
    moveUnknown: pricedMarkets.filter((m) => m.stability.known !== true).length,
  }), [pricedMarkets, ordersByMarket]);

  const anyFilterOn = fMove != null || fSoon || fEnabled || fMine;

  // I risultati del venue che NON sono gia' nel board. Un mercato presente in entrambi si mostra UNA
  // volta sola, nel gruppo del board, dove ha tutti i suoi numeri.
  const venueOnly = useMemo(() => {
    if (!venue || venue.ok === false) return [];
    const inBoard = new Set(pricedMarkets.map((m) => m.marketId.toLowerCase()));
    return (venue.markets || []).filter((m) => m.marketId && !inBoard.has(m.marketId.toLowerCase()));
  }, [venue, pricedMarkets]);

  const visibleMarkets = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let set = pricedMarkets;
    // FILTERS — combinable, each one an AND.
    if (fMove === 'fermi') set = set.filter(isStill);
    if (fMove === 'veloci') set = set.filter(isFast);
    if (fSoon) set = set.filter((m) => fin(m.hoursToResolution) && (m.hoursToResolution as number) <= SOON_HOURS);
    if (fEnabled) set = set.filter((m) => m.inBotUniverse === true);
    if (fMine) set = set.filter((m) => ordersByMarket.has(m.marketId));
    if (needle) set = set.filter((m) => (m.title ?? '').toLowerCase().includes(needle) || m.marketId.toLowerCase().includes(needle));
    // SORT — «miglior reward» ranks by the market's daily pot, which is what that phrase means at the
    // venue. Without it: markets you have capital in first, then the bot's set, then by estimated
    // yield on the capital the estimate is priced for — the same ranking the Riepilogo uses.
    return [...set].sort((a, b) => {
      if (sortByPool) {
        return (fin(b.dailyPoolUsd) ? (b.dailyPoolUsd as number) : -1)
          - (fin(a.dailyPoolUsd) ? (a.dailyPoolUsd as number) : -1);
      }
      const oa = ordersByMarket.has(a.marketId) ? 1 : 0;
      const ob = ordersByMarket.has(b.marketId) ? 1 : 0;
      if (oa !== ob) return ob - oa;
      const ua = a.inBotUniverse === true ? 1 : 0;
      const ub = b.inBotUniverse === true ? 1 : 0;
      if (ua !== ub) return ub - ua;
      return (fin(b.estYieldPctPerDay) ? (b.estYieldPctPerDay as number) : -1)
        - (fin(a.estYieldPctPerDay) ? (a.estYieldPctPerDay as number) : -1);
    });
  }, [pricedMarkets, q, ordersByMarket, sortByPool, fMove, fSoon, fEnabled, fMine]);

  // ── PUBLIC VISITOR ── the unchanged public board. Nothing operator-only is even fetched for them.
  if (operator === false) return <RewardsUnified />;
  if (operator === null) {
    return (
      <div className="lrc-root exch">
        <style>{CSS}</style>
        <div className="lrc-nd">Caricamento della console…</div>
      </div>
    );
  }

  // Ages are measured against the slow clock, not Date.now() at render time: a value read during render
  // is impure and, on the first paint, differs between server and client.
  const ageFrom = (iso: string | null | undefined): number | null =>
    (iso && nowMs ? Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000)) : null);
  const feedAgeSec = ageFrom(board?.feed.polyGeneratedAt);
  const ordersAgeSec = ageFrom(orders?.at);

  const earnBadge = earning.state === 'ok' ? 'is-ok' : earning.state === 'bad' ? 'is-bad' : earning.state === 'warn' ? 'is-warn' : '';

  return (
    <div className="lrc-root exch" data-liquidity-console>
      <style>{CSS}</style>

      {/* ── HEADER ────────────────────────────────────────────────────────────────────────────────────
          Title, the state as a COMPACT BADGE beside it (the 46px ring is gone — it cost a third of the
          first screen to say one word), then the four live figures on ONE dense strip. */}
      <div className="lrc-head">
        <div className="lrc-title-row">
          <h1 className="lrc-h1">Liquidity rewards · console operatore</h1>
          <span className={`ex-badge ${earnBadge}`} data-lrc-earning={earning.state}>{earning.label}</span>
          <span className="lrc-venue">solo Polymarket</span>
        </div>
        <p className="lrc-earndetail">
          <span className="lrc-earnq">Il capitale sta maturando premi?</span> {earning.detail}
        </p>

        <div className="ex-stats" data-lrc-metrics>
          <div className="ex-stat">
            <span className="ex-stat-k">Saldo</span>
            <span className={`ex-stat-v ${bal?.pusdBalance == null ? 'ex-dim' : ''}`}>{money(bal?.pusdBalance)}</span>
            <span className="ex-stat-s">
              {bal?.pusdBalance == null ? 'proxy pUSD' : `pUSD proxy · ${ageTxt(bal?.ageSeconds)}`}
            </span>
            {bal?.pusdBalance == null && (
              <p className="ex-why">{balErr ? `non letto: ${balErr}` : 'saldo non leggibile — non è «zero»'}</p>
            )}
            {bal?.stale === true && <p className="ex-why ex-why-warn">valore non aggiornato (STALE)</p>}
          </div>

          <div className="ex-stat">
            <span className="ex-stat-k">Impegnato</span>
            <span className={`ex-stat-v ${orders?.simulated ? 'ex-dim' : ''}`}>
              {orders?.simulated ? 'N/D' : money(summary?.committedUsd)}
            </span>
            <span className="ex-stat-s">
              {orders?.simulated ? 'venue non interrogato' : `${orders?.count ?? 0} ordini a riposo`}
            </span>
            {orders?.simulated && <p className="ex-why">nessuna credenziale di lettura — non è «zero impegnato»</p>}
            {orders?.ok === false && <p className="ex-why">lettura fallita: {orders.error ?? '—'}</p>}
            {!orders?.simulated && summary && summary.unpricedOrders > 0 && (
              <p className="ex-why ex-why-warn">{summary.unpricedOrders} ordini senza controvalore leggibile</p>
            )}
          </div>

          <div className="ex-stat">
            <span className="ex-stat-k">$/giorno</span>
            <span className={`ex-stat-v ${orders?.simulated || summary?.estGrossUsdPerDay == null ? 'ex-dim' : 'ex-up'}`}>
              {orders?.simulated || summary?.estGrossUsdPerDay == null ? 'N/D' : money(summary.estGrossUsdPerDay)}
            </span>
            <span className="ex-stat-s">
              {orders?.simulated ? 'nessuna lettura' : `su ${money(summary?.committedInBandUsd)} in banda`}
            </span>
            {!orders?.simulated && summary?.estGrossUsdPerDay == null && (
              <p className="ex-why">un mercato con capitale in banda non è scorabile — nessun totale inventato</p>
            )}
          </div>

          <div className="ex-stat">
            <span className="ex-stat-k">Fuori banda</span>
            <span className={`ex-stat-v ${orders?.simulated ? 'ex-dim' : (summary?.outOfBandCount ?? 0) > 0 ? 'ex-dn' : 'ex-up'}`}>
              {orders?.simulated ? 'N/D' : String(summary?.outOfBandCount ?? 0)}
            </span>
            <span className="ex-stat-s">
              {orders?.simulated ? 'nessuna lettura' : (summary?.outOfBandCount ?? 0) > 0 ? 'non maturano nulla' : 'tutti in banda'}
            </span>
            {(summary?.unknownBandCount ?? 0) > 0 && !orders?.simulated && (
              <p className="ex-why ex-why-warn">{summary?.unknownBandCount} non giudicabili (regole di venue non leggibili)</p>
            )}
          </div>
        </div>

        {boardErr && <div className="ex-banner is-bad lrc-mt">Board non leggibile: {boardErr}</div>}

        <div className="ex-tabs lrc-mt" role="tablist" aria-label="Sezioni">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`ex-tab ${tab === t.key ? 'is-on' : ''}`}
              // Il prefill vale per LA navigazione che lo ha impostato, non per sempre. Senza questo
              // azzeramento, riaprire «Alloca» dalla barra delle tab — settimane dopo, o dopo aver
              // svuotato il campo a mano — reimponeva il vecchio termine e rilanciava quella ricerca,
              // sovrascrivendo quello che l'operatore stava facendo. Verificato: succedeva davvero.
              onClick={() => { setAllocPrefill(null); setTab(t.key); }}
              data-lrc-tab={t.key}
            >
              <span className="lrc-tab-long">{t.label}</span>
              <span className="lrc-tab-short">{t.short}</span>
              {t.key === 'riepilogo' && (summary?.outOfBandCount ?? 0) > 0 && <span className="ex-tab-dot" aria-label="allarme" />}
            </button>
          ))}
        </div>

        {/* FRESHNESS PER SOURCE, not one global "updated Xs ago". These three sources refresh at 20s,
            60s and whatever agent34 last wrote: presenting them with equal weight is what makes a stale
            balance look as current as a fresh book. Each is judged against ITS OWN cadence. */}
        <Freshness
          items={[
            { k: 'Ordini', ageSec: ordersAgeSec, everySec: BOARD_POLL_MS / 1000 },
            { k: 'Saldo', ageSec: bal?.ageSeconds ?? null, everySec: BALANCE_POLL_MS / 1000 },
            { k: 'Scan', ageSec: feedAgeSec, everySec: 60 },
            { k: 'Mercati', ageSec: null, everySec: 60, valueOverride: String(board?.marketCount ?? 0) },
          ]}
        />
      </div>

      {/* ── 1 · RIEPILOGO ─────────────────────────────────────────────────────────────────────────── */}
      {tab === 'riepilogo' && (
        <section className="lrc-sec" data-lrc-section="riepilogo">
          <Ask q="Cosa devo guardare adesso?" sub="Cosa non sta maturando, e quanto capitale è fermo." />
          {orders?.simulated && (
            <div className="ex-banner is-warn lrc-mb">
              Venue non interrogato (nessuna credenziale): dove dipende dai tuoi ordini leggi N/D.
              «Nessun ordine» sarebbe una deduzione, non un fatto.
            </div>
          )}

          {/* ALERT — named markets, named action, one dense row each. Never "some orders are out of band". */}
          {outOfBandOrders.length > 0 ? (
            <div className="lrc-alert" data-lrc-alert="out-of-band">
              <div className="lrc-alert-t">
                {outOfBandOrders.length} {outOfBandOrders.length === 1 ? 'ordine fuori banda' : 'ordini fuori banda'} — non stanno maturando nulla
              </div>
              <div className="ex-rows lrc-alert-rows">
                {outOfBandOrders.map((o) => (
                  <div key={o.orderId ?? Math.random()} className="ex-row">
                    <div className="ex-row-main">
                      <div className="ex-row-t">
                        <span className={`ex-side ${o.book === 'yes' ? 'is-yes' : o.book === 'no' ? 'is-no' : ''}`}>
                          {(o.book ?? '?').toUpperCase()}
                        </span>{' '}
                        {o.marketTitle ?? o.marketId ?? 'mercato sconosciuto'}
                      </div>
                      <div className="ex-row-s">
                        Azione: riprezza a <b className="ex-n ex-gold">{cents(o.suggestedPrice)}</b> oppure cancella.
                      </div>
                    </div>
                    <div className="ex-row-nums">
                      <span className="ex-num"><span className="ex-num-k">prezzo</span><span className="ex-num-v">{cents(o.price)}</span></span>
                      <span className="ex-num"><span className="ex-num-k">dal mid</span><span className="ex-num-v ex-dn">{num(o.distanceCents, 2)}¢</span></span>
                      <span className="ex-num"><span className="ex-num-k">banda</span><span className="ex-num-v">±{num(o.bandRadiusCents, 2)}¢</span></span>
                    </div>
                  </div>
                ))}
              </div>
              <button className="ex-btn is-gold lrc-mt" onClick={() => setTab('ordini')} data-lrc-goto-orders>
                Vai a Ordini manuali →
              </button>
            </div>
          ) : orders?.simulated ? null : (
            <div className="ex-banner is-ok lrc-mb" data-lrc-alert="none">
              Nessun ordine fuori banda. {orders?.count === 0
                ? 'Non hai ordini a riposo sul venue (letto, non dedotto).'
                : `Tutti i ${orders?.count} ordini a riposo sono dentro la banda premiante.`}
            </div>
          )}

          {/* ── CAPITALE: totale, impegnato, libero, e la quota impegnata. Tutte cifre, nessun tap. ── */}
          <div className="ex-sech"><span className="ex-sech-t">Capitale</span></div>
          <div className="ex-stats">
            <div className="ex-stat">
              <span className="ex-stat-k">Totale</span>
              <span className="ex-stat-v">{money(bal?.pusdBalance)}</span>
              <span className="ex-stat-s">proxy, on-chain</span>
            </div>
            <div className="ex-stat">
              <span className="ex-stat-k">Impegnato</span>
              <span className="ex-stat-v">{orders?.simulated ? 'N/D' : money(summary?.committedUsd)}</span>
              <span className="ex-stat-s">a riposo</span>
            </div>
            <div className="ex-stat">
              <span className="ex-stat-k">Libero</span>
              <span className={`ex-stat-v ${freeCapital != null && freeCapital > 0 ? 'ex-gold' : ''}`}>
                {freeCapital == null ? 'N/D' : money(freeCapital)}
              </span>
              <span className="ex-stat-s">
                {freeCapital == null ? 'differenza non calcolabile' : 'fermo: non matura nulla'}
              </span>
              {freeCapital == null && (
                <p className="ex-why">
                  {orders?.simulated
                    ? 'il venue non è stato interrogato: il capitale impegnato non è noto'
                    : 'saldo o impegnato non leggibili — nessuna sottrazione contro uno zero assunto'}
                </p>
              )}
            </div>
            <div className="ex-stat">
              <span className="ex-stat-k">Quota impegnata</span>
              <span className="ex-stat-v">
                {freeCapital != null && fin(bal?.pusdBalance) && (bal!.pusdBalance as number) > 0
                  ? `${(((summary?.committedUsd ?? 0) / (bal!.pusdBalance as number)) * 100).toFixed(1)}%`
                  : 'N/D'}
              </span>
              <span className="ex-stat-s">del saldo</span>
            </div>
          </div>
          {freeCapital != null && fin(bal?.pusdBalance) && (bal!.pusdBalance as number) > 0 && (
            <div className="lrc-barwrap" aria-hidden="true">
              <div
                className="lrc-bar"
                style={{ width: `${Math.max(0, Math.min(100, ((summary?.committedUsd ?? 0) / (bal!.pusdBalance as number)) * 100))}%` }}
              />
            </div>
          )}
          <p className="lrc-fine">
            {freeCapital != null && freeCapital > 0
              ? 'Il capitale libero non matura nulla. «Ottimizza» propone un piano, non un ordine.'
              : 'Tutto impegnato.'}
            {' '}Saldo del proxy funder, on-chain, sola lettura.
          </p>

          {/* ── MIGLIOR MERCATO PER RENDIMENTO — la classifica per intero, non solo il primo. ── */}
          <div className="ex-sech"><span className="ex-sech-t">Migliori mercati per rendimento sul tuo capitale</span></div>
          {capitalUsd == null ? (
            <div className="ex-banner is-warn" data-lrc-best="no-capital">
              N/D — saldo del proxy non leggibile{balErr ? `: ${balErr}` : bal?.note ? `: ${bal.note}` : ''}.
              Nessuna stima calcolata: il riferimento da $1.000 del feed sovrastimerebbe di ~10×.
            </div>
          ) : bestMarkets.length ? (
            <>
              <div className="ex-panel ex-rows" data-lrc-best-yield>
                {bestMarkets.map((m, i) => (
                  <div key={m.marketId} className="ex-row">
                    <div className="ex-row-main">
                      <div className="ex-row-t"><span className="lrc-rank-n ex-n">{i + 1}</span> {m.title ?? m.marketId}</div>
                      <div className="ex-row-s">
                        su capitale <span className="ex-n">{money(m.estCapitalUsd, 0)}</span>
                        {m.estDepthLimited ? ' (limitato dalla profondità in banda)' : ''} · montepremi{' '}
                        <span className="ex-n">{money(m.dailyPoolUsd, 0)}</span>/g
                      </div>
                    </div>
                    <div className="ex-row-nums">
                      <span className="ex-num"><span className="ex-num-k">rend./g</span><span className="ex-num-v ex-up">{num(m.estYieldPctPerDay, 2)}%</span></span>
                      <span className="ex-num"><span className="ex-num-k">stima</span><span className="ex-num-v">{money(m.estUsdPerDay)}</span></span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="lrc-fine">
                Rendimento = stima $/g ÷ capitale, sul tuo saldo reale{' '}
                <span className="ex-n">{money(capitalUsd)}</span>. Lordo: adverse selection non modellata.
              </p>
            </>
          ) : (
            <div className="ex-banner">N/D — nessun mercato risulta scorabile in questo scan.</div>
          )}

          <p className="lrc-note">
            Stesse cifre dell&apos;intestazione: un fetch, una lettura del venue, un giudizio di banda.
          </p>
        </section>
      )}

      {/* ── 2 · MERCATI ───────────────────────────────────────────────────────────────────────────── */}
      {tab === 'mercati' && (
        <section className="lrc-sec" data-lrc-section="mercati">
          <Ask q="Dove conviene mettere il capitale?" sub="Stime sul tuo saldo reale." />

          {/* ── CHIP ─ un ordinamento e quattro filtri, combinabili fra loro. ────────────────────── */}
          <div className="lrc-controls">
            <div className="ex-chips" role="group" aria-label="Filtri mercati">
              <button
                className={`ex-chip is-sort ${sortByPool ? 'is-on' : ''}`}
                aria-pressed={sortByPool}
                onClick={() => { setSortByPool((v) => !v); setLimit(PAGE); }}
                title="Ordina per montepremi giornaliero. Non nasconde nessun mercato."
                data-lrc-chip="reward"
              >
                🏆 Miglior reward
              </button>
              <button
                className={`ex-chip ${fMove === 'fermi' ? 'is-on' : ''}`}
                aria-pressed={fMove === 'fermi'}
                onClick={() => { setFMove((v) => (v === 'fermi' ? null : 'fermi')); setLimit(PAGE); }}
                title="Prezzo poco mosso rispetto alla banda: uno scarto tipo consuma meno del 30% della mezza banda, misurato su 7 giorni."
                data-lrc-chip="fermi"
              >
                ⏸ Fermi <span className="ex-n lrc-chip-n">{chipCounts.fermi}</span>
              </button>
              <button
                className={`ex-chip ${fMove === 'veloci' ? 'is-on' : ''}`}
                aria-pressed={fMove === 'veloci'}
                onClick={() => { setFMove((v) => (v === 'veloci' ? null : 'veloci')); setLimit(PAGE); }}
                title="Prezzo molto mosso rispetto alla banda: uno scarto tipo ne consuma il 65% o più, misurato su 7 giorni."
                data-lrc-chip="veloci"
              >
                ⚡ Veloci <span className="ex-n lrc-chip-n">{chipCounts.veloci}</span>
              </button>
              <button
                className={`ex-chip ${fSoon ? 'is-on' : ''}`}
                aria-pressed={fSoon}
                onClick={() => { setFSoon((v) => !v); setLimit(PAGE); }}
                title="Risoluzione entro 7 giorni."
                data-lrc-chip="scadenza"
              >
                ⏳ In scadenza <span className="ex-n lrc-chip-n">{chipCounts.soon}</span>
              </button>
              <button
                className={`ex-chip ${fEnabled ? 'is-on' : ''}`}
                aria-pressed={fEnabled}
                onClick={() => { setFEnabled((v) => !v); setLimit(PAGE); }}
                title="Solo i mercati nella lista abilitata del bot."
                data-lrc-chip="abilitati"
              >
                ✓ Abilitati <span className="ex-n lrc-chip-n">{chipCounts.enabled}</span>
              </button>
              <button
                className={`ex-chip ${fMine ? 'is-on' : ''}`}
                aria-pressed={fMine}
                onClick={() => { setFMine((v) => !v); setLimit(PAGE); }}
                title="Solo i mercati dove hai ordini a riposo."
                data-lrc-chip="miei"
              >
                ◆ Con miei ordini <span className="ex-n lrc-chip-n">{chipCounts.mine}</span>
              </button>
            </div>
            <input
              className="ex-input is-text lrc-search" type="search" placeholder="Cerca su tutto Polymarket…"
              value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }}
              aria-label="Cerca mercato su tutto Polymarket, anche senza reward"
              title="Filtra il board reward dal vivo e, da 3 caratteri, cerca anche fuori dal board: la stessa fonte di «Cerca un mercato» in Ottimizza."
            />
          </div>

          <p className="lrc-chiphint">
            <span className="ex-n">{visibleMarkets.length}</span> di <span className="ex-n">{pricedMarkets.length}</span>
            {' · '}🏆 ordina, non filtra
            {' · '}<span className="ex-dim">la ricerca copre tutto Polymarket, anche i mercati senza reward</span>
            {anyFilterOn && <> · <button className="ex-link lrc-clear" onClick={() => { setFMove(null); setFSoon(false); setFEnabled(false); setFMine(false); setLimit(PAGE); }}>azzera filtri</button></>}
          </p>

          {/* Il capitale su cui ogni stima è prezzata: una riga, non un paragrafo. */}
          <p className={`ex-flag ${capitalUsd == null ? 'is-bad' : 'is-dim'} lrc-mb`} data-lrc-capital-note>
            <span className="ex-flag-i" aria-hidden="true">{capitalUsd == null ? '⚠' : 'ⓘ'}</span>
            <span>
              {capitalUsd == null
                ? <>saldo non leggibile{balErr ? ` (${balErr})` : ''} — nessuna stima calcolata</>
                : <>stime sul saldo reale <b className="ex-n">{money(capitalUsd)}</b>{bal?.stale ? ' (non aggiornato)' : ''}</>}
            </span>
          </p>

          {visibleMarkets.length === 0 ? (
            <div className="lrc-nd">
              Nessun mercato del board reward con questi filtri.
              {fMove != null && chipCounts.moveUnknown > 0 && ` ${chipCounts.moveUnknown} mercati hanno movimento non misurabile: non contano né come fermi né come veloci.`}
              {venueOnly.length > 0 && ' I risultati fuori dal board sono qui sotto.'}
            </div>
          ) : (
            <div className="lrc-mkts">
              {visibleMarkets.slice(0, limit).map((m) => {
                const mine = ordersByMarket.get(m.marketId) ?? [];
                const detail = openDetail === m.marketId;
                const outOfBandHere = mine.some((o) => o.outOfBand === true);
                // ── UN SOLO AVVISO, IL PIÙ GRAVE ────────────────────────────────────────────────
                // Prima erano due paragrafi indipendenti, uno sotto l'altro, ciascuno di due frasi:
                // la stima limitata e il mid non-live. Adesso è una riga di sei parole; il testo
                // integrale del server e l'eventuale seconda causa restano nel title, non spariscono.
                const stale = m.midSource !== 'live-book';
                const flag: { cls: string; icon: string; text: string; title: string } | null =
                  m.estBelowMinSize
                    ? {
                      cls: 'is-bad', icon: '⚠',
                      text: m.estCapitalToQualifyUsd != null
                        ? `sotto la size minima — servono ${money(m.estCapitalToQualifyUsd)}`
                        : 'sotto la size minima del venue',
                      title: m.estReason ?? 'il venue non assegna punteggio sotto min_incentive_size: il reward e zero',
                    }
                    : !m.estMinSizeJudgeable
                      ? {
                        cls: 'is-dim', icon: 'ⓘ',
                        text: 'soglia del venue non giudicabile',
                        title: m.estReason ?? 'size minima o mid non leggibili: la stima passa invariata, ma la soglia non e stata verificata',
                      }
                    : m.estUnknown
                    ? {
                      cls: 'is-bad', icon: '⚠', text: 'stima non calcolabile',
                      title: m.estReason ?? 'nessun motivo riportato dal server',
                    }
                    : m.estDepthLimited
                      ? {
                        cls: '', icon: '⚠',
                        text: `solo ${money(m.bookDepthAtBandUsd, 0)} in banda — stima limitata`,
                        title: m.estReason ?? 'il tuo saldo supera la profondità premiante di questo book: la stima è calcolata sulla profondità disponibile',
                      }
                      : stale
                        ? {
                          cls: 'is-dim', icon: 'ⓘ',
                          text: `mid da scan · ${ageTxt(m.midAgeSec)}`,
                          title: `il mid non viene dal book live ma dalla riga di scan (${m.midSource ?? 'N/D'}): la banda è giudicata contro quel numero`,
                        }
                        : null;
                // Se l'avviso mostrato non è già quello del mid, il mid stantio finisce nel title.
                const flagTitle = flag && flag.cls !== 'is-dim' && stale
                  ? `${flag.title} · inoltre: mid da scan (${m.midSource ?? 'N/D'}, ${ageTxt(m.midAgeSec)}), non dal book live`
                  : flag?.title;

                return (
                  <div key={m.marketId} className="lrc-mkt ex-panel" data-lrc-market={m.marketId}>
                    {/* TITOLO, e sotto la sola riga che serve: scadenza e montepremi. */}
                    <div className="lrc-mkt-head">
                      <div className="lrc-mkt-t">
                        {m.title ?? m.marketId}
                        {m.groupItemTitle && <span className="ex-dim"> · {m.groupItemTitle}</span>}
                      </div>
                      <div className="lrc-mkt-sub">
                        <span className="ex-n">{hoursTxt(m.hoursToResolution)}</span>
                        {' · pool '}<span className="ex-n">{money(m.dailyPoolUsd, 0)}</span>/g
                        {/* Solo pillole che dicono qualcosa che i numeri non dicono già. Quella dello
                            spread è sparita: lo spread è qui sopra, colorato — ripeterlo a parole era
                            la stessa informazione due volte. */}
                        {m.stability.known && m.stability.label && (
                          <span
                            className={`ex-badge lrc-bdg ${m.stability.label === 'fermo' ? 'is-ok' : m.stability.label === 'medio' ? '' : 'is-warn'}`}
                            title={`uno scarto tipo muove ${num(m.stability.movedCents, 2)}¢, cioè il ${num(m.stability.consumedBandPct, 0)}% della mezza banda (7 giorni)`}
                          >
                            {m.stability.label}
                          </span>
                        )}
                        {m.inBotUniverse === true && <span className="ex-badge is-gold lrc-bdg" title="il bot quota questo mercato">abilitato</span>}
                        {mine.length > 0 && (
                          <span className={`ex-badge lrc-bdg ${outOfBandHere ? 'is-bad' : 'is-ok'}`}>
                            {mine.length} ordini{outOfBandHere ? ' · fuori' : ''}
                          </span>
                        )}
                        {!m.rulesReadable && (
                          <span className="ex-badge is-bad lrc-bdg" title={`mancano: ${m.rulesMissing.join(', ')}`}>regole N/D</span>
                        )}
                      </div>
                    </div>

                    {/* I TRE NUMERI. Monospazio, colore semantico, etichette di una parola. */}
                    <div className="ex-big" data-lrc-big>
                      <div className="ex-big-c">
                        <span className="ex-big-k">mid</span>
                        <span className={`ex-big-v ${m.mid == null ? 'ex-dim' : ''}`}>{cents(m.mid)}</span>
                      </div>
                      <div className="ex-big-c">
                        <span className="ex-big-k">spread</span>
                        <span className={`ex-big-v ${m.spread.level === 'basso' ? 'ex-up' : m.spread.level === 'alto' ? 'ex-dn' : m.spread.level === 'medio' ? 'ex-gold' : 'ex-dim'}`}
                          title={m.spread.note}>
                          {m.spread.spreadCents == null ? 'N/D' : `${m.spread.spreadCents.toFixed(1)}¢`}
                        </span>
                      </div>
                      <div className="ex-big-c">
                        <span className="ex-big-k">$/g stim.</span>
                        <span className={`ex-big-v ${m.estUsdPerDay == null ? 'ex-dim' : m.estUsdPerDay > 0 ? 'ex-up' : 'ex-dn'}`}>
                          {m.estUsdPerDay == null ? 'N/D' : money(m.estUsdPerDay)}
                        </span>
                      </div>
                    </div>

                    <div className="lrc-pad">
                      {flag && (
                        <p className={`ex-flag ${flag.cls}`} title={flagTitle} data-lrc-flag>
                          <span className="ex-flag-i" aria-hidden="true">{flag.icon}</span>
                          <span>{flag.text}</span>
                        </p>
                      )}

                      {/* LA BANDA, SOTTILE. Estremi ai lati una volta sola. */}
                      <BandBar
                        mid={m.mid} bandLo={m.bandLo} bandHi={m.bandHi}
                        bestBid={m.bestBid} bestAsk={m.bestAsk}
                      />

                      <div className="ex-cardacts">
                        <Link className="ex-link" href={`/dashboard/liquidity-rewards/${encodeURIComponent(m.marketId)}`} prefetch={false}>Book →</Link>
                        <button className="ex-link" onClick={() => setOpenDetail(detail ? null : m.marketId)} data-lrc-detail-toggle>
                          {detail ? 'Chiudi ↑' : 'Dettagli →'}
                        </button>
                      </div>

                      {/* DIETRO «Dettagli»: tutto quello che prima stava sempre a schermo — scala
                          prezzi, banda, stima e capitale, tick, id, volume. Niente è sparito. */}
                      {detail && (
                        <div className="lrc-expand" data-lrc-detail={m.marketId}>
                          <PriceLadder
                            mid={m.mid} bandLo={m.bandLo} bandHi={m.bandHi} bandRadiusCents={m.bandRadiusCents}
                            bestBid={m.bestBid} bestAsk={m.bestAsk}
                            orders={mine.map((o) => ({ orderId: o.orderId, book: o.book, price: o.price, size: o.restingSize, inBand: o.inBand, distanceCents: o.distanceCents }))}
                            caption="banda · mid · tocco · i tuoi ordini"
                          />
                          <div className="ex-kvs lrc-mt">
                            <div className="ex-kv" title={m.estUnknown ? (m.estReason ?? 'non calcolabile') : `quota modellata su ${money(m.estCapitalUsd, 0)}`}>
                              <span className="ex-kv-k">stima/g</span><span className="ex-kv-v">{m.estUsdPerDay == null ? 'N/D' : money(m.estUsdPerDay)}</span>
                            </div>
                            <div className="ex-kv"><span className="ex-kv-k">su capitale</span><span className="ex-kv-v">{m.estCapitalUsd == null ? 'N/D' : money(m.estCapitalUsd, 0)}</span></div>
                            <div className="ex-kv"><span className="ex-kv-k">rendim./g</span><span className="ex-kv-v">{m.estYieldPctPerDay == null ? 'N/D' : `${num(m.estYieldPctPerDay, 2)}%`}</span></div>
                            <div className="ex-kv"><span className="ex-kv-k">profondità</span><span className="ex-kv-v">{money(m.bookDepthAtBandUsd, 0)}</span></div>
                            <div className="ex-kv"><span className="ex-kv-k">banda</span><span className="ex-kv-v">{cents(m.bandLo)} – {cents(m.bandHi)}</span></div>
                            <div className="ex-kv"><span className="ex-kv-k">raggio</span><span className="ex-kv-v">±{num(m.bandRadiusCents, 2)}¢</span></div>
                            <div className="ex-kv"><span className="ex-kv-k">bid / ask</span><span className="ex-kv-v">{cents(m.bestBid)} / {cents(m.bestAsk)}</span></div>
                            <div className="ex-kv"><span className="ex-kv-k">spread max</span><span className="ex-kv-v">{num(m.maxSpreadCents, 2)}¢</span></div>
                            <div className="ex-kv" title="min_incentive_size: sotto questa soglia l ordine è valido sul CLOB ma invisibile ai premi">
                              <span className="ex-kv-k">size min</span><span className="ex-kv-v">{num(m.minSize)}</span>
                            </div>
                            <div className="ex-kv"><span className="ex-kv-k">tick</span><span className="ex-kv-v">{m.tick == null ? 'N/D' : String(m.tick)}</span></div>
                            <div className="ex-kv"><span className="ex-kv-k">volume 24h</span><span className="ex-kv-v">{money(m.volume24hUsd, 0)}</span></div>
                            <div className="ex-kv"><span className="ex-kv-k">categoria</span><span className="ex-kv-v">{m.category ?? 'N/D'}</span></div>
                            <div className="ex-kv"><span className="ex-kv-k">movimento</span>
                              <span className="ex-kv-v" title={m.stability.known ? `${num(m.stability.consumedBandPct, 0)}% della mezza banda` : (m.stability.reason ?? 'non riportato')}>
                                {m.stability.known ? `${num(m.stability.score, 0)}/100` : 'N/D'}
                              </span>
                            </div>
                            <div className="ex-kv" title={`fonte: ${m.midSource ?? 'N/D'}`}><span className="ex-kv-k">mid letto</span><span className="ex-kv-v">{ageTxt(m.midAgeSec)}</span></div>
                            <div className="ex-kv" title={m.marketId}><span className="ex-kv-k">id</span><span className="ex-kv-v">{m.marketId.slice(0, 10)}…</span></div>
                          </div>
                          <div className="lrc-actions">
                            <Link className="ex-link" href={`/dashboard/liquidity-rewards/${encodeURIComponent(m.marketId)}/event`} prefetch={false}>Scheda →</Link>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {visibleMarkets.length > limit && (
                <button className="ex-btn is-block" onClick={() => setLimit((l) => l + PAGE)}>
                  Mostra altri {Math.min(PAGE, visibleMarkets.length - limit)} (di {visibleMarkets.length})
                </button>
              )}
            </div>
          )}

          <VenueResults
            q={q} busy={venueBusy} err={venueErr} rows={venueOnly}
            dropped={venue?.notTradableDropped ?? 0}
            anyFilterOn={anyFilterOn} sortByPool={sortByPool}
            onOpenInAlloca={(term) => { setAllocPrefill(term); setTab('alloca'); }}
          />
        </section>
      )}

      {/* ── 3 · POSIZIONI ─────────────────────────────────────────────────────────────────────────── */}
      {tab === 'posizioni' && (
        <section className="lrc-sec" data-lrc-section="posizioni">
          <Ask q="Cosa ho in mano?" sub="Esposizione netta per mercato, letta dal venue." />
          <div className="ex-sech">
            <span className="ex-sech-t">Posizioni aperte · esposizione netta</span>
            <button className="ex-btn is-sm" onClick={loadPositions} disabled={posLoading}>{posLoading ? 'Lettura…' : 'Aggiorna'}</button>
          </div>

          {pos && pos.ok === false && (
            <div className="ex-banner is-bad">
              Posizioni NON lette: {pos.error ?? 'errore sconosciuto'} — non è una lista vuota.
            </div>
          )}
          {pos?.ok && pos.markets.length === 0 && (
            <div className="ex-banner is-ok">
              Nessuna posizione sul wallet <span className="ex-n">{pos.wallet}</span> — letto, non dedotto.
            </div>
          )}
          {!pos && <div className="lrc-nd">Lettura delle posizioni…</div>}

          {pos?.ok && pos.markets.length > 0 && (
            <>
              <div className="ex-stats lrc-mb">
                <div className="ex-stat">
                  <span className="ex-stat-k">Mercati</span>
                  <span className="ex-stat-v">{String(pos.totals?.marketCount ?? 0)}</span>
                  <span className="ex-stat-s">{pos.totals?.legCount ?? 0} gambe YES/NO</span>
                </div>
                <div className="ex-stat">
                  <span className="ex-stat-k">Valore a mid</span>
                  <span className="ex-stat-v">{money(pos.totals?.currentValueUsd)}</span>
                  <span className="ex-stat-s">a mid</span>
                  {pos.totals?.valueUnknown && <p className="ex-why">una gamba senza valore leggibile — totale non calcolato</p>}
                </div>
                <div className="ex-stat">
                  <span className="ex-stat-k">P&amp;L non realizz.</span>
                  <span className={`ex-stat-v ${pnlCls(pos.totals?.unrealizedPnlUsd)}`}>{money(pos.totals?.unrealizedPnlUsd)}</span>
                  <span className="ex-stat-s">non è un incasso</span>
                </div>
              </div>

              <div className="lrc-poslist">
                {pos.markets.map((p) => (
                  <div key={p.marketId ?? Math.random()} className="ex-panel lrc-pos" data-lrc-position={p.marketId ?? ''}>
                    {/* SCHEDA COMPATTA: netto, valore, P&L colorato sulla stessa riga del titolo. */}
                    <div className="ex-row">
                      <div className="ex-row-main">
                        <div className="ex-row-t">{p.title ?? p.marketId ?? 'mercato sconosciuto'}</div>
                        <div className="ex-row-s">
                          netto{' '}
                          <b className={`ex-n ${p.netDirection === 'yes' ? 'ex-up' : p.netDirection === 'no' ? 'ex-dn' : ''}`}>
                            {p.netDirection === 'flat' ? 'piatto' : `${num(Math.abs(p.netShares ?? 0), 1)} ${p.netDirection.toUpperCase()}`}
                          </b>
                          {' · '}YES <span className="ex-n">{num(p.yesShares, 1)}</span>
                          {' · '}NO <span className="ex-n">{num(p.noShares, 1)}</span>
                        </div>
                      </div>
                      <div className="ex-row-nums">
                        <span className="ex-num"><span className="ex-num-k">costo</span><span className="ex-num-v">{money(p.initialValueUsd)}</span></span>
                        <span className="ex-num"><span className="ex-num-k">a mid</span><span className="ex-num-v">{money(p.currentValueUsd)}</span></span>
                        <span className="ex-num"><span className="ex-num-k">P&amp;L</span><span className={`ex-num-v ${pnlCls(p.unrealizedPnlUsd)}`}>{money(p.unrealizedPnlUsd)}</span></span>
                      </div>
                    </div>
                    {p.valueUnknown && (
                      <p className="ex-why lrc-pad">Una gamba senza valore leggibile: il totale di questo mercato non è calcolato, non è zero.</p>
                    )}
                    <div className="ex-rows lrc-legs">
                      {p.legs.map((l) => (
                        <div key={l.asset} className="ex-row">
                          <div className="ex-row-main">
                            <div className="ex-row-t">
                              <span className={`ex-side ${l.side === 'yes' ? 'is-yes' : l.side === 'no' ? 'is-no' : ''}`}>
                                {l.sideKnown ? (l.side as string).toUpperCase() : 'N/D'}
                              </span>{' '}
                              <span className="ex-n">{num(l.size, 1)}</span> share
                            </div>
                            {!l.sideKnown && <p className="ex-why">lato non riportato dal venue: esclusa dal netto, non indovinata</p>}
                          </div>
                          <div className="ex-row-nums">
                            <span className="ex-num"><span className="ex-num-k">medio</span><span className="ex-num-v">{cents(l.avgPrice)}</span></span>
                            <span className="ex-num"><span className="ex-num-k">mid</span><span className="ex-num-v">{cents(l.curPrice)}</span></span>
                            <span className="ex-num"><span className="ex-num-k">valore</span><span className="ex-num-v">{money(l.currentValueUsd)}</span></span>
                            <span className="ex-num"><span className="ex-num-k">P&amp;L</span><span className={`ex-num-v ${pnlCls(l.unrealizedPnlUsd)}`}>{money(l.unrealizedPnlUsd)}</span></span>
                          </div>
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
              {pos.source} · wallet <span className="ex-n">{pos.wallet ?? 'N/D'}</span> · letto{' '}
              <span className="ex-n">{new Date(pos.at).toLocaleTimeString()}</span> · sola lettura.
              P&amp;L <b>mark-to-mid</b>, non un incasso.
            </p>
          )}
        </section>
      )}

      {/* ── 4 · ORDINI MANUALI ────────────────────────────────────────────────────────────────────── */}
      {tab === 'ordini' && (
        <section className="lrc-sec" data-lrc-section="ordini">
          <Ask q="Cosa ho sul book, e devo muoverlo?" sub="Piazza, cancella, riprezza — dagli stessi gate del motore." />
          {(() => {
            // The ladder for the market the manual panel is pinned to — same board data, so the ladder and
            // the panel below cannot show a different band or a different mid.
            const withOrders = Array.from(ordersByMarket.keys());
            const pinnedId = withOrders.length === 1 ? withOrders[0] : (pricedMarkets.find((m) => m.inBotUniverse === true)?.marketId ?? null);
            const pinned = pinnedId ? pricedMarkets.find((m) => m.marketId === pinnedId) ?? null : null;
            if (!pinned) return null;
            const po = ordersByMarket.get(pinned.marketId) ?? [];
            return (
              <div className="ex-panel lrc-ladderbox">
                <div className="ex-sech-t">Scala prezzi · {pinned.title ?? pinned.marketId}</div>
                <PriceLadder
                  mid={pinned.mid} bandLo={pinned.bandLo} bandHi={pinned.bandHi} bandRadiusCents={pinned.bandRadiusCents}
                  bestBid={pinned.bestBid} bestAsk={pinned.bestAsk}
                  orders={po.map((o) => ({ orderId: o.orderId, book: o.book, price: o.price, size: o.restingSize, inBand: o.inBand, distanceCents: o.distanceCents }))}
                  caption="dove paga la banda, dove sta il tocco, dove stanno i tuoi ordini"
                />
                <p className="lrc-fine">
                  Ogni bottone passa dagli stessi gate del motore: kill-switch, cap, venue-rules, validateOrder.
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
          <Ask q="Quanto capitale metto, e su quali mercati?" sub="Un piano, non un ordine: qui non si piazza nulla." />
          <RewardsAllocatePanel initialQuery={allocPrefill} />
          <FillStrategyPanel />
        </section>
      )}

      {/* ── 6 · REGOLE ────────────────────────────────────────────────────────────────────────────── */}
      {tab === 'regole' && (
        <section className="lrc-sec" data-lrc-section="regole">
          <Ask q="Come si guadagna, esattamente?" sub="Le regole del programma, e i tuoi ordini rispetto a quelle." />
          <div className="ex-panel lrc-rulesbox">
            <div className="ex-sech-t">Come si guadagna, in breve</div>
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

          <div className="ex-sech">
            <span className="ex-sech-t">Tutti i tuoi ordini attivi · distanza dal mid e stato</span>
            <span className="lrc-fine">
              {orders?.at ? <>letto dal venue <span className="ex-n">{new Date(orders.at).toLocaleTimeString()}</span></> : 'N/D'}
            </span>
          </div>

          {orders?.ok === false && (
            <div className="ex-banner is-bad lrc-mb">Lettura del venue FALLITA: {orders.error ?? '—'} — questa non è una lista vuota.</div>
          )}
          {orders?.simulated && orders.ok !== false && (
            <div className="ex-banner is-warn lrc-mb">
              Venue non interrogato: «0 ordini» qui significa «non abbiamo letto».
            </div>
          )}

          {orders && orders.orders.length === 0 && orders.ok !== false && !orders.simulated ? (
            <div className="lrc-nd">Nessun ordine a riposo su nessun mercato (letto dal venue, non dedotto).</div>
          ) : (
            <div className="ex-tblwrap">
              <table className="ex-tbl lrc-tbl" data-lrc-orders-table>
                <thead>
                  <tr>
                    <th>Mercato</th><th>Lato</th><th className="ex-n">Prezzo</th><th className="ex-n">Mid</th>
                    <th className="ex-n">Distanza</th><th className="ex-n">Banda</th><th>Stato</th>
                    <th className="ex-n">Size</th><th className="ex-n">Controvalore</th>
                  </tr>
                </thead>
                <tbody>
                  {(orders?.orders ?? []).map((o) => (
                    <tr key={o.orderId ?? Math.random()} className={o.outOfBand === true ? 'is-bad' : ''}>
                      <td className="lrc-td-mkt">{o.marketTitle ?? o.marketId ?? 'N/D'}</td>
                      <td>
                        <span className={`ex-side ${o.book === 'yes' ? 'is-yes' : o.book === 'no' ? 'is-no' : ''}`}>
                          {o.book ? o.book.toUpperCase() : 'N/D'}
                        </span>
                      </td>
                      <td className="ex-n">{cents(o.price)}</td>
                      <td className="ex-n">{cents(o.scoringMid)}</td>
                      <td className={`ex-n ${o.outOfBand === true ? 'ex-dn' : ''}`}>{o.distanceCents == null ? 'N/D' : `${o.distanceCents.toFixed(2)}¢`}</td>
                      <td className="ex-n">{o.bandRadiusCents == null ? 'N/D' : `±${o.bandRadiusCents.toFixed(2)}¢`}</td>
                      <td>
                        {o.inBand === true ? <span className="ex-badge is-ok">in banda</span>
                          : o.inBand === false ? <span className="ex-badge is-bad">fuori banda</span>
                            : <span className="ex-badge" title={o.rulesReadable ? 'token non riconducibile ai due book del mercato' : 'regole di venue non leggibili'}>non giudicabile</span>}
                        {o.valid === false && o.inBand === true && (
                          <span className="ex-badge is-warn" title={o.reasons.map((r) => `${r.code}: ${r.detail}`).join(' · ')}>
                            {o.reasons.map((r) => r.code).join(', ')}
                          </span>
                        )}
                      </td>
                      <td className="ex-n">{num(o.restingSize, 1)}</td>
                      <td className="ex-n">{money(o.restingNotionalUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="lrc-note">
            «In banda» è il verdetto della stessa funzione che il server riesegue prima di ogni piazzamento.
            «Non giudicabile» = regola di venue non leggibile: non conta né dentro né fuori.
          </p>
        </section>
      )}
    </div>
  );
}

/**
 * Per-source freshness. Each source is judged against ITS OWN cadence, because "45 seconds old" is
 * healthy for a 60s balance read and two polls missed for a 20s order board. A single global
 * "aggiornato Xs fa" cannot say that, and hides the one that actually went stale.
 */
function Freshness({ items }: { items: Array<{ k: string; ageSec: number | null; everySec: number; valueOverride?: string }> }) {
  return (
    <div className="lrc-fresh" data-lrc-freshness>
      {items.map((i) => {
        const st = i.valueOverride != null ? 'na'
          : i.ageSec == null ? 'unk'
            : i.ageSec > i.everySec * 3 ? 'bad'
              : i.ageSec > i.everySec * 1.5 ? 'warn' : 'ok';
        return (
          <span key={i.k} className={`lrc-fresh-i is-${st}`}>
            <span className="lrc-fresh-k">{i.k}</span>
            <span className="lrc-fresh-v ex-n">{i.valueOverride ?? (i.ageSec == null ? 'N/D' : ageTxt(i.ageSec))}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * I RISULTATI FUORI DAL BOARD REWARD.
 *
 * La barra di ricerca della tab Mercati interroga due fonti: la lista locale del board (istantanea, con
 * tutti i numeri) e il venue per intero (la STESSA di «Cerca un mercato» in Ottimizza). Questo gruppo mostra
 * ciò che esiste solo nella seconda — cioè i mercati che agent24 non raccoglie perché non pagano
 * montepremi, «Bitcoin Up or Down» in testa.
 *
 * PERCHÉ I CHIP NON SI APPLICANO QUI, ed è una scelta, non una dimenticanza.
 * I cinque chip filtrano su misure che produce la pipeline reward: il movimento viene dalla stdev del mid
 * su 7 giorni raccolta dal collector, il montepremi dal board, la banda dallo scan. Un mercato fuori da
 * quella pipeline non ha nessuna delle tre. Le alternative erano due, entrambe peggiori:
 *   • applicare i chip lo stesso ⇒ questi risultati sparirebbero appena un filtro è attivo, che è
 *     esattamente l'invisibilità che questa unificazione elimina;
 *   • inventare un valore neutro ⇒ un mercato non misurato si presenterebbe come misurato.
 * Quindi restano SEMPRE visibili, in un gruppo loro, e l'intestazione dice a voce alta che i chip qui
 * sopra non li toccano. Chi cerca un nome lo trova, filtri accesi o spenti.
 */
function VenueResults({ q, busy, err, rows, dropped, anyFilterOn, sortByPool, onOpenInAlloca }: {
  q: string; busy: boolean; err: string | null; rows: VenueSearchRow[]; dropped: number;
  anyFilterOn: boolean; sortByPool: boolean;
  onOpenInAlloca: (term: string) => void;
}) {
  const needle = q.trim();
  if (needle.length < 3) return null;
  return (
    <div className="lrc-venue" data-lrc-venue-results>
      <div className="ex-sech">
        <span className="ex-sech-t">Fuori dal board reward</span>
        <span className="lrc-fine">
          {busy ? 'ricerca sul venue…' : `${rows.length} risultat${rows.length === 1 ? 'o' : 'i'}`}
          {/* Una lista che si accorcia in silenzio e' indistinguibile da una ricerca che trova meno. */}
          {!busy && dropped > 0 && <> · <span className="ex-dim">{dropped} non operabili nascosti</span></>}
        </span>
      </div>

      {err && <div className="ex-banner is-bad">⚠ Ricerca sul venue fallita: {err}</div>}

      {!err && !busy && rows.length === 0 && (
        <div className="lrc-nd">Nessun altro mercato Polymarket per «{needle}».</div>
      )}

      {rows.length > 0 && (
        <>
          <p className="ex-flag is-dim" data-lrc-venue-note>
            <span className="ex-flag-i" aria-hidden="true">ⓘ</span>
            <span>
              Cercati su tutto Polymarket, come in «Ottimizza». {(anyFilterOn || sortByPool) && <>I chip qui sopra non si applicano a questi: </>}
              movimento, montepremi e banda non sono misurati fuori dal board reward.
            </span>
          </p>
          <div className="ex-panel ex-rows lrc-mt">
            {rows.map((m) => (
              <div key={m.marketId} className="ex-row" data-lrc-venue-market={m.marketId}>
                <div className="ex-row-main">
                  <div className="ex-row-t">{m.question ?? `${m.marketId.slice(0, 10)}…`}</div>
                  <div className="ex-row-s">
                    {closeTxt(m.minutesToClose)}
                    {m.tick != null && <> · tick <span className="ex-n">{m.tick}</span></>}
                    {m.rewardsMaxSpreadCents != null && <> · banda <span className="ex-n">{m.rewardsMaxSpreadCents.toFixed(2)}¢</span></>}
                  </div>
                  <div className="ex-badges lrc-mt">
                    {/* STESSA CONVENZIONE DI ALLOCA, parola per parola. */}
                    {!m.hasRewards && (
                      <span className="ex-badge is-warn" data-lrc-no-reward>NESSUN REWARD — solo trading direzionale</span>
                    )}
                    {m.enabled && <span className="ex-badge is-gold">abilitato</span>}
                    {!m.enabled && m.optedIn && <span className="ex-badge">opted-in</span>}
                    {m.closed && <span className="ex-badge is-bad">chiuso</span>}
                    {!m.acceptingOrders && <span className="ex-badge is-bad">non accetta ordini</span>}
                    {m.tooCloseToClose && <span className="ex-badge is-bad">sotto la soglia di chiusura</span>}
                    {/* POCO TEMPO E UN RISCHIO DA MOSTRARE, non un motivo per nascondere: il mercato
                        resta in lista e dice quanto gli manca. */}
                    {!m.tooCloseToClose && m.minutesToClose != null && m.minutesToClose <= 60 && (
                      <span className="ex-badge is-warn" data-lrc-expiring>
                        {/* Mai «0m»: sotto il minuto si dice, sotto i dieci si tiene il decimo. */}
                        scade fra {m.minutesToClose < 1 ? '<1' : m.minutesToClose < 10 ? m.minutesToClose.toFixed(1) : String(Math.round(m.minutesToClose))}m
                      </span>
                    )}
                  </div>
                </div>
                <div className="ex-row-nums">
                  <span className="ex-num">
                    <span className="ex-num-k">mid</span>
                    <span className={`ex-num-v ${m.mid == null ? 'ex-dim' : ''}`}>{cents(m.mid)}</span>
                  </span>
                  <span className="ex-num">
                    <span className="ex-num-k">spread</span>
                    <span className="ex-num-v">{m.spreadCents == null ? 'N/D' : `${m.spreadCents.toFixed(1)}¢`}</span>
                  </span>
                  <span className="ex-num">
                    <span className="ex-num-k">reward/g</span>
                    <span className={`ex-num-v ${m.rewardsDailyRate == null ? 'ex-dim' : 'ex-up'}`}>
                      {m.rewardsDailyRate == null ? 'nessuno' : money(m.rewardsDailyRate, 0)}
                    </span>
                  </span>
                </div>
                {/* NON abilita da qui: porta al flusso a due passi, che vive in Ottimizza e resta in un
                    posto solo. Un secondo percorso di scrittura verso una config auditata sarebbe due
                    copie da tenere allineate. Questo e' routing, non una nuova autorizzazione.

                    SI PASSA IL conditionId, NON IL TITOLO — e la differenza non e' cosmetica.
                    Con il titolo la destinazione riceveva una ricerca TESTUALE, quindi una LISTA: e da
                    quando i risultati sono ordinati per scadenza piu' vicina, il mercato da cui si
                    arrivava non era quasi mai il primo. Misurato: partendo dalla card «3:20PM-3:25PM»
                    la tabella mostrava «2:15PM-2:30PM» in riga 1 e quella giusta in riga 4 — e chi
                    premeva «1 · Anteprima» sulla prima riga, che e' la cosa naturale da fare,
                    abilitava un mercato che non aveva scelto. E' successo davvero, alle 18:09:37.
                    Un conditionId invece e' una chiave esatta: searchMarkets lo riconosce e restituisce
                    UNA riga, quella. Non c'e' piu' una prima riga sbagliata da premere. */}
                <div className="lrc-venue-act">
                  <button
                    className="ex-btn is-sm"
                    data-lrc-venue-open
                    data-lrc-venue-open-id={m.marketId}
                    onClick={() => onOpenInAlloca(m.marketId)}
                    title="Apre «Ottimizza capitale» su QUESTO mercato, cercato per conditionId: una riga sola, nessuna ambiguita. Non abilita nulla: i due passi restano da premere."
                  >
                    Aggiungi in Ottimizza →
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="lrc-fine">
            Questa lista trova; l&apos;aggiunta resta il flusso a due passi in «Ottimizza capitale», dove il
            pulsante qui sopra porta con il nome gia&apos; cercato.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * THE REWARD BAND AS A HAIRLINE.
 *
 * Replaces the always-open compact price ladder at the top of every card. The endpoints are printed
 * ONCE, at the two sides — the old layout repeated them above the bar and again in the grid below it.
 *
 * The track spans whatever the band, the touch and the mid actually cover together, so an order book
 * sitting outside its own reward band is visible as such instead of being clipped to the band's edge.
 * Nothing here is computed: every value is the board's, drawn to scale.
 */
function BandBar({ mid, bandLo, bandHi, bestBid, bestAsk }: {
  mid: number | null; bandLo: number | null; bandHi: number | null;
  bestBid: number | null; bestAsk: number | null;
}) {
  if (!fin(bandLo) || !fin(bandHi) || (bandHi as number) <= (bandLo as number)) {
    return (
      <p className="ex-flag is-dim" data-lrc-band="unknown">
        <span className="ex-flag-i" aria-hidden="true">ⓘ</span>
        <span>banda non leggibile</span>
      </p>
    );
  }
  const pts = [bandLo, bandHi, mid, bestBid, bestAsk].filter(fin) as number[];
  const rawLo = Math.min(...pts);
  const rawHi = Math.max(...pts);
  // A hair of padding so a tick sitting exactly on an endpoint is still drawn inside the track.
  const pad = Math.max((rawHi - rawLo) * 0.08, 0.002);
  const lo = rawLo - pad;
  const hi = rawHi + pad;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const tick = (v: number | null, cls: string, label: string) =>
    (fin(v) ? <span key={cls} className={`ex-bandbar-tick ${cls}`} style={{ left: `${clamp(pct(v as number))}%` }} title={`${label} ${cents(v)}`} /> : null);
  return (
    <div className="ex-bandbar" data-lrc-band="ok">
      <span className="ex-bandbar-e">{cents(bandLo)}</span>
      <span className="ex-bandbar-t">
        <span
          className="ex-bandbar-band"
          style={{ left: `${clamp(pct(bandLo as number))}%`, width: `${clamp(pct(bandHi as number)) - clamp(pct(bandLo as number))}%` }}
        />
        {tick(mid, 'is-mid', 'mid')}
        {tick(bestBid, 'is-bid', 'bid')}
        {tick(bestAsk, 'is-ask', 'ask')}
      </span>
      <span className="ex-bandbar-e">{cents(bandHi)}</span>
    </div>
  );
}

/** The question a section answers, stated before its numbers. */
function Ask({ q, sub }: { q: string; sub?: string }) {
  return (
    <div className="lrc-ask">
      <h2 className="lrc-ask-q">{q}</h2>
      {sub && <p className="lrc-ask-s">{sub}</p>}
    </div>
  );
}

// NOTE: keep this stylesheet free of the characters React escapes in text nodes — quotes, angle
// brackets, ampersands. As the child of a style element they are serialised escaped on the server and
// raw on the client, which is a hydration mismatch that takes the whole root down to client rendering.
const CSS = `
.lrc-root { max-width: 1080px; margin: 0 auto; padding: 4px 14px 24px; }
.lrc-head { border-bottom: 1px solid var(--ex-line); padding-bottom: 0; margin-bottom: 4px; }
.lrc-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.lrc-h1 { font-size: 14px; font-weight: 700; letter-spacing: .01em; margin: 0; color: var(--ex-txt); }
.lrc-venue { font-size: 10px; font-weight: 600; color: var(--ex-txt-3); border: 1px solid var(--ex-line);
  border-radius: 3px; padding: 1px 6px; }
.lrc-earndetail { font-size: 11.5px; color: var(--ex-txt-2); line-height: 1.5; margin: 0 0 10px;
  overflow-wrap: anywhere; }
.lrc-earnq { color: var(--ex-txt-3); }

.lrc-mt { margin-top: 10px; }
.lrc-mb { margin-bottom: 10px; }
.lrc-pad { padding: 0 12px; }

.lrc-tab-short { display: none; }

/* Freshness: one compact pill per source, coloured against ITS OWN cadence. */
.lrc-fresh { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0 0; }
.lrc-fresh-i { display: inline-flex; align-items: baseline; gap: 5px; font-size: 10px;
  border: 1px solid var(--ex-line); border-radius: 3px; padding: 2px 7px; background: var(--ex-panel); }
.lrc-fresh-k { color: var(--ex-txt-3); text-transform: uppercase; letter-spacing: .05em; }
.lrc-fresh-v { font-weight: 700; color: var(--ex-txt-2); }
.lrc-fresh-i.is-ok .lrc-fresh-v { color: var(--ex-green); }
.lrc-fresh-i.is-warn .lrc-fresh-v { color: var(--ex-gold); }
.lrc-fresh-i.is-bad .lrc-fresh-v { color: var(--ex-red); }

.lrc-sec { margin-top: 14px; }
.lrc-ask { margin: 0 0 12px; }
.lrc-ask-q { font-size: 16px; font-weight: 700; margin: 0; line-height: 1.25; letter-spacing: -.01em; }
.lrc-ask-s { font-size: 11.5px; color: var(--ex-txt-2); margin: 4px 0 0; line-height: 1.5; }

.lrc-alert { border: 1px solid var(--ex-red-bd); background: var(--ex-red-bg); border-radius: 8px;
  padding: 11px 12px; margin-bottom: 12px; }
.lrc-alert-t { color: var(--ex-red); font-weight: 700; font-size: 13px; margin-bottom: 8px; }
.lrc-alert-rows { border: 1px solid var(--ex-line); border-radius: 6px; background: var(--ex-panel); }

.lrc-barwrap { height: 4px; border-radius: 999px; background: var(--ex-line); margin-top: 8px; overflow: hidden; }
.lrc-bar { height: 100%; background: var(--ex-gold); }

.lrc-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.lrc-search { flex: 1 1 180px; min-width: 0; }

.lrc-venue { margin-top: 18px; border-top: 1px solid var(--ex-line); padding-top: 4px; }
.lrc-venue-act { grid-column: 1 / -1; margin-top: 8px; }
.lrc-chip-n { margin-left: 4px; opacity: .7; font-size: 10px; }
.lrc-chiphint { font-size: 10.5px; color: var(--ex-txt-3); margin: 6px 0 8px; line-height: 1.5; }
.lrc-clear { min-height: 0; font-size: 10.5px; }

.lrc-mkts { display: flex; flex-direction: column; gap: 8px; }
.lrc-mkt { padding-bottom: 10px; }
.lrc-mkt-head { padding: 10px 10px 9px; }
.lrc-mkt-t { font-size: 13.5px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.lrc-mkt-sub { margin-top: 4px; font-size: 11px; color: var(--ex-txt-3); line-height: 1.9;
  overflow-wrap: anywhere; }
.lrc-bdg { margin-left: 6px; vertical-align: 1px; }
.lrc-actions { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; }
.lrc-expand { margin-top: 10px; border-top: 1px solid var(--ex-line-soft); padding-top: 8px; }

.lrc-poslist { display: flex; flex-direction: column; gap: 8px; }
.lrc-pos { padding-bottom: 2px; }
.lrc-legs { border-top: 1px solid var(--ex-line-soft); background: rgba(0,0,0,.18); }

.lrc-ladderbox { padding: 12px; margin-bottom: 12px; }
.lrc-rulesbox { padding: 12px; margin-bottom: 4px; }
.lrc-rules { margin: 8px 0 0; padding-left: 16px; font-size: 12.5px; color: var(--ex-txt-2); line-height: 1.6; }
.lrc-rules li { margin-bottom: 8px; }
.lrc-rules code { font-family: var(--ex-mono); font-size: 11px; color: var(--ex-gold);
  background: var(--ex-panel-2); border: 1px solid var(--ex-line); border-radius: 3px; padding: 0 4px; }

.lrc-tbl { min-width: 760px; }
.lrc-td-mkt { max-width: 220px; overflow-wrap: anywhere; }
.lrc-rank-n { display: inline-block; min-width: 16px; color: var(--ex-gold); font-weight: 700; }

.lrc-note { font-size: 11px; color: var(--ex-txt-3); line-height: 1.55; margin: 12px 0 0; }
.lrc-fine { font-size: 10.5px; color: var(--ex-txt-3); line-height: 1.5; margin: 6px 0 0; }
.lrc-nd { font-size: 12.5px; color: var(--ex-txt-2); padding: 16px 2px; }

@media (max-width: 620px) {
  .lrc-root { padding: 4px 10px 24px; }
  .lrc-tab-long { display: none; }
  .lrc-tab-short { display: inline; }
  .lrc-ask-q { font-size: 15px; }
  .lrc-actions { gap: 4px 14px; }
  /* Under 420px the three headline figures would each get ~100px; two columns keeps them legible
     and lets the third wrap onto its own line rather than shrinking the font. */
  .exch .ex-big { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;

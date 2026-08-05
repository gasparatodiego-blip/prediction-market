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
import RewardsUnified from './RewardsUnified';
import OrderPanel, { type OrderTarget } from './OrderPanel';

// ── TRE SEZIONI, NON SEI ────────────────────────────────────────────────────────────────────────
// Sei tab volevano dire che rispondere a «i miei ordini stanno maturando?» costava tre passaggi:
// Riepilogo per il capitale, Posizioni per l'esposizione, Ordini per il book — tre viste sullo stesso
// istante, mai a schermo insieme. Adesso lo stato sta tutto in UNA sezione: capitale, ordini a riposo
// col loro countdown, posizioni aperte, kill e ripristino.
//
// «Mercati» e «Ottimizza» restano separate perché rispondono a domande diverse (quale mercato · quanto
// capitale), ma da entrambe si piazza dallo STESSO pannello, aperto sopra la lista.
//
// «Regole» non era una sezione: era un testo che non cambia mai. Sta dietro il «?» in intestazione.
type TabKey = 'riepilogo' | 'mercati' | 'alloca';

const TABS: Array<{ key: TabKey; label: string; short: string }> = [
  { key: 'riepilogo', label: 'Riepilogo', short: 'Riepilogo' },
  { key: 'mercati', label: 'Mercati', short: 'Mercati' },
  { key: 'alloca', label: 'Ottimizza capitale', short: 'Ottimizza' },
];
/** I vecchi ?tab= continuano a funzionare: puntano alla sezione che ora li contiene. */
const LEGACY_TAB: Record<string, TabKey> = {
  posizioni: 'riepilogo', ordini: 'riepilogo', regole: 'riepilogo',
};

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
  /** min_incentive_size — la soglia sotto cui il programma premi non vede l'ordine. */
  rewardsMinSize: number | null;
  endDate: string | null;
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

/**
 * Un ordine a riposo COL SUO TEMPO DI VITA, letto dal venue (/api/maker/manual/orders senza marketId ⇒
 * l'intera lista aperta del conto). `secondsToExpiry` è già corretto per i 60 secondi con cui l'exchange
 * ritira un GTD in anticipo: è la risposta onesta a «quanto sopravvive se il server si ferma adesso».
 * GTC ⇒ null su entrambi, e si scrive «nessuna scadenza», non un trattino che si legge «non lo so».
 */
interface RestingOrder {
  orderId: string | null; marketId: string | null; side: string | null;
  price: number | null; size: number | null; sizeMatched: number | null; sizeRemaining: number | null;
  status: string; source: string; notionalUsd: number | null;
  orderType: 'GTC' | 'GTD'; expiresAtMs: number | null;
  secondsToExpiry: number | null; secondsToRefresh: number | null;
}
/** Un mercato con il market making automatico acceso, piu' cio' che il motore sta facendo. */
interface TrkSide { orderId: string | null; price: number | null; filled: boolean; filledAt: number | null }
interface TrkPlanSide { priceCents: number | null; placeable: boolean; inBand: boolean | null; bandNote: string | null }
interface TrkMarket {
  marketId: string; gate: string | null; reason: string | null;
  offsetCents: number | null; minMoveCents: number | null; sizeShares: number | null;
  referenceMid: number | null; movedCents: number | null; repriceCount: number;
  mid: number | null; midAgeSec: number | null; midSource: string | null; midReadAt: number | null; paused: boolean;
  plan: { yes: TrkPlanSide | null; no: TrkPlanSide | null } | null;
  sides: { yes: TrkSide; no: TrkSide } | null;
  // Il bersaglio VERO calcolato a runtime. `offsetCents` qui sopra è quello configurato nel registro:
  // da quando il motore si mette un tick dietro il migliore altrui, quello è solo il ripiego.
  target: { yes: TrkTarget | null; no: TrkTarget | null } | null;
  dynamicGate: string | null;
}
interface TrkTarget {
  mode: 'behind-best' | 'band-clamped' | 'fallback-alone' | 'erosion-retreat' | string;
  onTop: boolean | null; alone: boolean | null;
  bestOther: number | null; offsetCents: number | null; priceCents: number | null;
}
interface TrkAction {
  at: string; action: string; marketId: string; book?: string; side?: string; type?: string;
  fromMid?: number | null; toMid?: number | null; movedCents?: number | null;
  priceCents?: number | null; size?: number | null; inBand?: boolean | null;
  ok?: boolean; sent?: boolean; gate?: string | null; reason?: string | null; trigger?: string;
  // La CAUSA del riposizionamento, e dove ci ha messo rispetto al book. Arrivavano già nel JSON:
  // mancava solo di dichiararli qui e di mostrarli.
  triggerKind?: 'mid' | 'erosione' | 'entrambi' | null;
  placement?: { mode?: string; onTop?: boolean | null; alone?: boolean | null; bestOther?: number | null; offsetCents?: number | null } | null;
  erosion?: { ratioPct?: number | null; baseline?: number | null; depth?: number | null; armed?: boolean } | null;
  sizeMatched?: number | null;
}
interface TrkResp {
  ok: boolean; readable: boolean; error: string | null; count: number;
  markets: Array<{ marketId: string; offsetCents: number; minMoveCents: number; sizeShares: number; atIso: string | null }>;
  engine: { at: string; ran: boolean; gate: string | null; reason: string | null; placement: string;
    markets: TrkMarket[]; recent: TrkAction[] } | null;
}

interface WalletTodo { who: 'operatore' | 'sistema'; what: string; how?: string }
interface WalletApproval { name: string; address: string; erc20: string | null; erc1155: boolean | null }
interface WalletResp {
  ok: boolean; at: string; error: string | null; address: string | null;
  chain: { readable: boolean; error: string | null; balanceUsd: number | null; minUsefulUsd: number; funded: boolean; approvals: WalletApproval[]; approvalsOk: boolean } | null;
  fundingApproved: boolean; placement: string; ready: boolean;
  // Lo snapshot delle posizioni al venue: il gate lo legge prima di ogni ordine e rifiuta se non è
  // leggibile. Opzionale nel tipo perché una risposta d'errore della rotta non lo porta.
  venuePositions?: {
    readable: boolean; ageMs: number | null; ageSec: number | null; maxAgeSec: number;
    count: number; reason: string | null; writer: string;
  } | null;
  // I RESIDUI CHE MUOIONO SOTTO LA SOGLIA MINIMA. Un fill parziale può lasciare una size che non arriva
  // più a `min_incentive_size`: quell'ordine non è rinnovabile e viene lasciato scadere, ma il capitale
  // che porta resta fermo fino ad allora e poi torna libero. Prima non lo diceva nessuno.
  residuiSottoSoglia?: {
    count: number; capitaleUsd: number | null;
    items: Array<{
      marketId: string; marketTitle: string | null; orderId: string;
      book: string; side: string; price: number;
      sizeRemaining: number; minSize: number; notionalUsd: number | null;
      expiresAt: string | null; scaduto: boolean | null;
    }>;
  } | null;
  // GLI ORDINI SPENTI DALLA SCADENZA GTD SENZA RINNOVO. Il 5 agosto due gambe su Eric Barlow sono
  // sparite dal venue alle 21:03 e l'unico segno era la loro assenza: nessuna cancellazione, nessun
  // fill, nessun evento. Il capitale è tornato libero senza che nessuno lo sapesse.
  scadenzeSenzaRinnovo?: {
    count: number; capitaleUsd: number | null;
    items: Array<{
      marketId: string; marketTitle: string | null; orderId: string;
      book: string; side: string; price: number; size: number; sizeMatched: number | null;
      notionalUsd: number | null; expiresAt: string | null; at: string;
      bloccoGate: string | null;
    }>;
  } | null;
  blockedBy: 'operatore' | 'sistema' | null; todo: WalletTodo[];
}

interface RestingResp { ok: boolean; error: string | null; simulated: boolean; count: number; orders: RestingOrder[]; at: string }

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
/**
 * Il tempo che resta a un ordine, in mm:ss. Sotto lo zero non si scrive «0:00» ma «scaduto»: un ordine
 * che il venue ha già ritirato non è un ordine con zero secondi davanti, ed è una differenza che conta
 * proprio nell'istante in cui si sta decidendo se rinnovarlo.
 */
const ttlTxt = (sec: number | null | undefined): string => {
  if (!fin(sec)) return 'N/D';
  if (sec <= 0) return 'scaduto';
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
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
    TABS.some((t) => t.key === initialTab)
      ? (initialTab as TabKey)
      : (initialTab && LEGACY_TAB[initialTab]) || 'riepilogo',
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
  // ── IL PANNELLO ORDINE ─────────────────────────────────────────────────────────────────────────
  // Tiene l'OGGETTO del mercato toccato, non il suo nome. È la differenza che chiude alla radice il
  // bug di identità: finché l'identità viaggiava come testo, chi la riceveva doveva RICERCARLA, e una
  // ricerca restituisce una lista in cui il mercato di partenza non è la prima riga. Qui non c'è
  // nessun passaggio in cui il conditionId possa diventare un altro.
  const [orderTarget, setOrderTarget] = useState<OrderTarget | null>(null);
  // L'ultimo piazzamento riuscito, con il suo istante: e' il segnale che la coda dell'allocatore
  // osserva per avanzare. `at` serve a distinguere due piazzamenti sullo stesso mercato.
  const [placedTick, setPlacedTick] = useState<
    { marketId: string; book: 'yes' | 'no'; price: number; size: number; sent: boolean; legIdx: number; legTotal: number; at: number } | null
  >(null);
  // Le regole del programma: un testo che non cambia mai, quindi non una sezione ma un pannello.
  const [showRules, setShowRules] = useState(false);
  // Ordini a riposo su TUTTI i mercati, con la scadenza letta dal venue. La board sa prezzo e banda ma
  // non sa quando un ordine muore; questa lettura sì, ed è l'unica che può muovere un countdown.
  const [resting, setResting] = useState<RestingResp | null>(null);
  const [trk, setTrk] = useState<TrkResp | null>(null);
  const [wal, setWal] = useState<WalletResp | null>(null);
  const [killBusy, setKillBusy] = useState<'kill' | 'reset' | null>(null);
  const [killMsg, setKillMsg] = useState<string | null>(null);

  // A slow clock, so every freshness readout AGES VISIBLY between polls instead of looking frozen-fresh
  // until the next fetch lands. 5s is finer than the fastest cadence on this page (20s) and costs one
  // re-render, never a refetch. Seeded in an effect, not in the initial state: Date.now() during the
  // first render differs between server and client and would desync hydration.
  //
  // Nel Riepilogo batte al secondo, non ogni cinque: lì c'è il countdown alla scadenza degli ordini, e
  // un conto alla rovescia che salta di cinque secondi alla volta si legge come rotto. Altrove cinque
  // secondi bastano — nessuna cifra di quella pagina cambia più in fretta.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), tab === 'riepilogo' ? 1_000 : 5_000);
    return () => clearInterval(t);
  }, [tab]);

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

  // Ordini a riposo su TUTTI i mercati: marketId omesso di proposito. Un ordine su un mercato che il
  // pannello ha smesso di seguire non deve poter sparire da questa lista.
  const loadResting = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/manual/orders', { cache: 'no-store' });
      setResting((await r.json()) as RestingResp);
    } catch (e) {
      setResting({ ok: false, error: (e as Error).message, simulated: false, count: 0, orders: [], at: new Date().toISOString() });
    }
  }, []);

  // I mercati con il market making automatico acceso, e cosa il motore sta facendo su ciascuno.
  const loadTracking = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/mm-tracking', { cache: 'no-store' });
      setTrk((await r.json()) as TrkResp);
    } catch { /* lo stato resta ignoto: la sezione lo dice invece di supporlo spento */ }
  }, []);

  // Lo stato del wallet e degli interruttori di piazzamento. Legge la catena, quindi non si interroga
  // di continuo: e' una risposta che cambia quando l'operatore fa qualcosa, non ogni secondo.
  const loadWallet = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/wallet-status', { cache: 'no-store' });
      setWal((await r.json()) as WalletResp);
    } catch { /* resta ignoto: il pannello lo dice invece di supporlo pronto */ }
  }, []);

  useEffect(() => { loadBoard(); loadBalance(); }, [loadBoard, loadBalance]);
  useEffect(() => {
    if (operator !== true) return;
    const a = setInterval(loadBoard, BOARD_POLL_MS);
    const b = setInterval(loadBalance, BALANCE_POLL_MS);
    return () => { clearInterval(a); clearInterval(b); };
  }, [operator, loadBoard, loadBalance]);

  // Posizioni e ordini a riposo costano un giro verso il venue: si leggono solo mentre il Riepilogo,
  // che è l'unico posto che li mostra, è aperto.
  useEffect(() => {
    if (operator !== true || tab !== 'riepilogo') return;
    loadPositions(); loadResting(); loadTracking(); loadWallet();
    // Il tracking si rilegge piu' spesso delle posizioni: e' un motore che agisce da solo, e la domanda
    // «cosa sta facendo adesso» non tollera un minuto di ritardo.
    const t = setInterval(() => { loadPositions(); loadResting(); }, POSITIONS_POLL_MS);
    const tk = setInterval(loadTracking, 5_000);
    return () => { clearInterval(t); clearInterval(tk); };
  }, [operator, tab, loadPositions, loadResting, loadTracking, loadWallet]);

  // KILL e RIPRISTINA. Due endpoint che possono solo FERMARE: /api/maker/kill importa il solo modulo
  // di kill (che raggiunge il percorso cancel-only) e /manual/reset non ha altra chiamata mutante che
  // una cancellazione. Nessuno dei due può piazzare, per costruzione, non per convenzione.
  const doKill = useCallback(async () => {
    setKillBusy('kill'); setKillMsg(null);
    try {
      const r = await fetch('/api/maker/kill', { method: 'POST' });
      const b = await r.json();
      setKillMsg(b.ok ? 'KILL eseguito: maker disarmato e ordini cancellati sul venue.' : `KILL parziale: ${b.error ?? b.cancelError ?? 'vedi audit'}`);
      loadBoard(); loadResting();
    } catch (e) { setKillMsg(`KILL fallito: ${(e as Error).message}`); }
    finally { setKillBusy(null); }
  }, [loadBoard, loadResting]);

  const doReset = useCallback(async () => {
    setKillBusy('reset'); setKillMsg(null);
    try {
      const r = await fetch('/api/maker/manual/reset', { method: 'POST' });
      const b = await r.json();
      setKillMsg(b.ok ? 'Ripristino completato: venue e cap gate confermano zero esposizione residua.' : `Ripristino NON confermato: ${b.error ?? b.reason ?? 'una delle due verifiche non dà zero'}`);
      loadBoard(); loadResting();
    } catch (e) { setKillMsg(`Ripristino fallito: ${(e as Error).message}`); }
    finally { setKillBusy(null); }
  }, [loadBoard, loadResting]);

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

  // ── DALLA CARD AL PANNELLO, SENZA PASSARE DAL TESTO ────────────────────────────────────────────
  // Due sorgenti, una sola forma. Ogni campo viene copiato dalla riga toccata; nessuno viene cercato,
  // dedotto o riletto altrove. Il `marketId` che arriva nella POST è, per costruzione, quello della
  // card: non esiste un punto in mezzo dove possa cambiare.
  const targetFromBoard = useCallback((m: PricedMarket): OrderTarget => ({
    marketId: m.marketId,
    title: m.title ?? m.marketId,
    // La board pubblica le ore alla risoluzione, non l'istante: si passa il minuto letto, non un
    // orario ricostruito che sembrerebbe più preciso di quanto sia.
    endDate: null,
    minutesToClose: fin(m.hoursToResolution) ? (m.hoursToResolution as number) * 60 : null,
    mid: m.mid, bestBid: m.bestBid, bestAsk: m.bestAsk,
    spreadCents: m.spread.spreadCents, tick: m.tick, minSize: m.minSize,
    maxSpreadCents: m.maxSpreadCents,
    rewardsDailyRate: m.dailyPoolUsd,
    hasRewards: fin(m.dailyPoolUsd) && (m.dailyPoolUsd as number) > 0,
    enabled: m.inBotUniverse === true,
  }), []);

  const targetFromVenue = useCallback((m: VenueSearchRow): OrderTarget => ({
    marketId: m.marketId,
    title: m.question ?? m.marketId,
    endDate: m.endDate ?? null,
    minutesToClose: m.minutesToClose,
    mid: m.mid, bestBid: m.bestBid, bestAsk: m.bestAsk,
    spreadCents: m.spreadCents, tick: m.tick, minSize: m.rewardsMinSize ?? null,
    maxSpreadCents: m.rewardsMaxSpreadCents,
    rewardsDailyRate: m.rewardsDailyRate,
    hasRewards: m.hasRewards === true,
    enabled: m.enabled === true,
  }), []);

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
          <button
            className="lrc-help" onClick={() => setShowRules(true)}
            aria-label="Regole del programma premi" title="Come si guadagna, esattamente"
            data-lrc-rules-open
          >?</button>
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
              onClick={() => setTab(t.key)}
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
              <p className="lrc-fine">I comandi per riprezzare o cancellare stanno qui sotto, sulla stessa schermata.</p>
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

          {/* ── STATO WALLET & PIAZZAMENTO ──────────────────────────────────────────────────────────
              La domanda «posso fare un ordine vero adesso?» aveva una risposta sola, e viveva nei log di
              un processo: «gate=funding-approval … on-chain signatures required». Con il telefono in mano
              non c'era modo di sapere se quel messaggio volesse dire «devi firmare qualcosa dal wallet»
              oppure «manca una riga di configurazione» — e sono due mondi diversi. Qui sono separati, e
              ciascuno dice di chi e' il prossimo passo. */}
          {wal && (
            <>
              <div className="ex-sech">
                <span className="ex-sech-t">Stato wallet e piazzamento</span>
                <span className="lrc-fine">
                  {wal.at ? <>letto <span className="ex-n">{new Date(wal.at).toLocaleTimeString()}</span> · on-chain</> : ''}
                  {' · '}<button className="ex-link lrc-clear" onClick={loadWallet}>rileggi</button>
                </span>
              </div>

              <div className={`ex-banner ${wal.ready ? 'is-ok' : wal.blockedBy === 'operatore' ? 'is-bad' : 'is-warn'} lrc-mb`} data-lrc-wallet-verdict={wal.ready ? 'ready' : (wal.blockedBy ?? 'unknown')}>
                {wal.ready
                  ? <><b>PRONTO.</b> Saldo, approvazioni e interruttori sono tutti a posto: un ordine da questo pannello raggiunge il venue.</>
                  : wal.blockedBy === 'operatore'
                    ? <><b>SERVE UN&apos;AZIONE TUA sul wallet.</b> Il sistema non puo&apos; farla al posto tuo: richiede una firma dal tuo wallet.</>
                    : <><b>NON PRONTO — manca un interruttore lato sistema.</b> Nessuna firma richiesta: e&apos; configurazione.</>}
              </div>

              <div className="ex-stats lrc-mb" data-lrc-wallet>
                <div className="ex-stat">
                  <span className="ex-stat-k">Saldo pUSD</span>
                  <span className={`ex-stat-v ${wal.chain?.funded ? 'ex-up' : 'ex-dn'}`} data-lrc-wallet-balance>
                    {wal.chain?.balanceUsd == null ? 'N/D' : money(wal.chain.balanceUsd)}
                  </span>
                  <span className="ex-stat-s">on-chain, non da cache</span>
                  {wal.chain?.readable === false && <p className="ex-why">non letto: {wal.chain.error} — non e&apos; «zero»</p>}
                </div>
                <div className="ex-stat">
                  <span className="ex-stat-k">Approvazioni</span>
                  <span className={`ex-stat-v ${wal.chain?.approvalsOk ? 'ex-up' : 'ex-dn'}`} data-lrc-wallet-approvals>
                    {wal.chain?.readable === false ? 'N/D' : wal.chain?.approvalsOk ? 'complete' : 'incomplete'}
                  </span>
                  <span className="ex-stat-s">{wal.chain?.approvals.length ?? 0} exchange</span>
                </div>
                <div className="ex-stat">
                  <span className="ex-stat-k">Finanziamento attestato</span>
                  <span className={`ex-stat-v ${wal.fundingApproved ? 'ex-up' : 'ex-dn'}`} data-lrc-wallet-funding={wal.fundingApproved ? '1' : '0'}>
                    {wal.fundingApproved ? 'sì' : 'no'}
                  </span>
                  <span className="ex-stat-s">MAKER_FUNDING_APPROVED</span>
                </div>
                <div className="ex-stat">
                  <span className="ex-stat-k">Invio ordini</span>
                  <span className={`ex-stat-v ${wal.placement === 'send' ? 'ex-dn' : 'ex-dim'}`} data-lrc-wallet-placement={wal.placement}>
                    {wal.placement === 'send' ? 'INVIA' : 'dry-run'}
                  </span>
                  <span className="ex-stat-s">MANUAL_ORDER_PLACEMENT</span>
                </div>
                {/* ── LE POSIZIONI APERTE AL VENUE ────────────────────────────────────────────────
                    Il gate `limit-venue-positions-unreadable` le pretende fresche prima di OGNI
                    ordine, e finora questo pannello non le nominava: si poteva leggere «PRONTO» qui
                    e vedersi rifiutare l'ordine un secondo dopo. L'unico modo di accorgersene era
                    provare a piazzare — che è il momento peggiore per scoprire una cosa del genere.
                    Chi scrive lo snapshot è dichiarato: senza quel nome, «non leggibile» non dice
                    dove andare a guardare. */}
                {wal.venuePositions && (
                  <div className="ex-stat">
                    <span className="ex-stat-k">Posizioni al venue</span>
                    <span className={`ex-stat-v ${wal.venuePositions.readable ? 'ex-up' : 'ex-dn'}`}
                      data-lrc-wallet-positions={wal.venuePositions.readable ? '1' : '0'}>
                      {wal.venuePositions.readable
                        ? `${wal.venuePositions.count} aperte`
                        : 'NON LEGGIBILI'}
                    </span>
                    <span className="ex-stat-s">
                      {wal.venuePositions.ageSec == null
                        ? `mai scritte · le scrive ${wal.venuePositions.writer}`
                        : `lette ${wal.venuePositions.ageSec}s fa · scadono a ${wal.venuePositions.maxAgeSec}s`}
                    </span>
                    {!wal.venuePositions.readable && (
                      <p className="ex-why">
                        {wal.venuePositions.reason} — il gate rifiuterà ogni ordine finché non torna
                        leggibile. Lo scrive <b>{wal.venuePositions.writer}</b>.
                      </p>
                    )}
                  </div>
                )}

                {/* ── RESIDUI SOTTO SOGLIA ────────────────────────────────────────────────────────
                    Compare SOLO quando ce n'è almeno uno: una casella permanente che dice «0» sarebbe
                    un'altra cosa da imparare a ignorare, e questo avviso esiste proprio perché un
                    silenzio si era mangiato un ordine intero (0x4c19a7, 5 agosto: 24 righe di skip
                    identiche e nessuno avvisato). Il dettaglio per ordine sta nell'elenco qui sotto,
                    dove stanno già tutte le altre cose da fare: qui c'è quanto capitale è coinvolto,
                    che è la cifra per cui vale la pena guardare. */}
                {wal.residuiSottoSoglia && wal.residuiSottoSoglia.count > 0 && (
                  <div className="ex-stat" data-lrc-wallet-residui={wal.residuiSottoSoglia.count}>
                    <span className="ex-stat-k">Residui sotto soglia</span>
                    <span className="ex-stat-v ex-dn">
                      {wal.residuiSottoSoglia.count === 1 ? '1 ordine' : `${wal.residuiSottoSoglia.count} ordini`}
                    </span>
                    <span className="ex-stat-s">
                      {money(wal.residuiSottoSoglia.capitaleUsd)} in attesa di riallocazione
                    </span>
                    <p className="ex-why ex-why-warn">
                      Residuo sotto soglia minima: non rinnovabile, capitale in attesa di riallocazione.
                      Dopo un acquisto parziale restano meno quote del minimo che il mercato richiede per
                      pagare, quindi l&apos;ordine non si può rinnovare e viene lasciato spegnere. La
                      posizione già comprata non c&apos;entra e segue la sua uscita per conto suo.
                    </p>
                  </div>
                )}

                {/* ── SPENTI DALLA SCADENZA, SENZA RINNOVO ────────────────────────────────────────
                    Accanto ai residui e con la stessa regola: compare solo quando ce n'è almeno uno.
                    La differenza è il tempo verbale — un residuo sta morendo, questo è già morto — e
                    quindi qui il numero che conta è il capitale TORNATO LIBERO, non quello in attesa.
                    Il 5 agosto questa casella sarebbe stata l'unico posto in cui la morte delle due
                    gambe di Barlow (39.00$ + 20.79$) si vedeva: al venue erano semplicemente spariti. */}
                {wal.scadenzeSenzaRinnovo && wal.scadenzeSenzaRinnovo.count > 0 && (
                  <div className="ex-stat" data-lrc-wallet-scadenze={wal.scadenzeSenzaRinnovo.count}>
                    <span className="ex-stat-k">Spenti dalla scadenza</span>
                    <span className="ex-stat-v ex-dn">
                      {wal.scadenzeSenzaRinnovo.count === 1 ? '1 ordine' : `${wal.scadenzeSenzaRinnovo.count} ordini`}
                    </span>
                    <span className="ex-stat-s">
                      {money(wal.scadenzeSenzaRinnovo.capitaleUsd)} tornati liberi
                    </span>
                    <p className="ex-why ex-why-warn">
                      Questi ordini non sono più sul libro: la scadenza del venue li ha spenti e nessun
                      rinnovo è partito prima. Non sono stati cancellati e non sono stati eseguiti — hanno
                      semplicemente smesso di esistere, quindi da quel momento non maturano premi. Il
                      motivo per cui il rinnovo non è avvenuto è nell&apos;elenco qui sotto, ordine per
                      ordine.
                    </p>
                  </div>
                )}
              </div>

              {/* IL DETTAGLIO PER CONTRATTO: quale exchange, quale tipo di autorizzazione. Serve per
                  sapere DOVE andare a concederla, non solo che manca. */}
              {wal.chain?.approvals.length ? (
                <div className="ex-panel ex-rows lrc-mb" data-lrc-wallet-detail>
                  {wal.chain.approvals.map((a) => (
                    <div key={a.address} className="ex-row">
                      <div className="ex-row-main">
                        <div className="ex-row-t">{a.name}</div>
                        <div className="ex-row-s"><span className="ex-n">{a.address}</span></div>
                      </div>
                      <div className="ex-row-nums">
                        <span className="ex-num"><span className="ex-num-k">collaterale</span><span className={`ex-num-v ${a.erc20 === 'illimitata' ? 'ex-up' : 'ex-dn'}`}>{a.erc20 ?? 'N/D'}</span></span>
                        <span className="ex-num"><span className="ex-num-k">token esito</span><span className={`ex-num-v ${a.erc1155 ? 'ex-up' : 'ex-dn'}`}>{a.erc1155 === null ? 'N/D' : a.erc1155 ? 'concessa' : 'MANCA'}</span></span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              {/* COSA MANCA, DIVISO PER CHI DEVE FARLO. E' la distinzione che decide se apri il wallet
                  o se chiedi una modifica di configurazione. */}
              {wal.todo.length > 0 && (
                <div className="lrc-mb" data-lrc-wallet-todo>
                  {wal.todo.map((t, i) => (
                    <p key={i} className={`ex-flag ${t.who === 'operatore' ? 'is-bad' : ''}`} data-lrc-wallet-todo-who={t.who}>
                      <span className="ex-flag-i" aria-hidden="true">{t.who === 'operatore' ? '👤' : '⚙'}</span>
                      <span>
                        <b>{t.who === 'operatore' ? 'Tu:' : 'Sistema:'}</b> {t.what}
                        {t.how && <><br /><span className="ex-dim">{t.how}</span></>}
                      </span>
                    </p>
                  ))}
                </div>
              )}
              <p className="lrc-fine">
                Proxy <span className="ex-n">{wal.address ?? 'N/D'}</span> — letto con `eth_call`, che non
                firma e non spende. Depositi e approvazioni restano azioni tue dal wallet: questo pannello
                dice se servono, non le esegue.
              </p>
            </>
          )}

          {/* ── MARKET MAKING AUTOMATICO ────────────────────────────────────────────────────────────
              Questa tabella e' l'unico posto da cui si vede, tutto insieme, cosa un automatismo sta
              facendo con capitale reale senza chiedere conferma ordine per ordine. Per questo sta in
              cima al Riepilogo e non dietro un tap: se un motore quota da solo, deve essere la prima
              cosa che si legge, non l'ultima che si scopre. */}
          {trk && (trk.count > 0 || trk.readable === false) && (
            <>
              <div className="ex-sech">
                <span className="ex-sech-t">Market making automatico</span>
                <span className="lrc-fine">
                  {trk.engine?.at ? <>motore <span className="ex-n">{new Date(trk.engine.at).toLocaleTimeString()}</span></> : 'motore non ancora visto'}
                  {trk.engine?.placement && <> · <b className={trk.engine.placement === 'send' ? 'ex-dn' : ''}>{trk.engine.placement === 'send' ? 'INVIA DAVVERO' : 'dry-run'}</b></>}
                </span>
              </div>
              {trk.readable === false && (
                <div className="ex-banner is-bad lrc-mb">
                  Configurazione del tracking NON leggibile ({trk.error}) — il motore non traccia nulla (fail closed).
                </div>
              )}
              {!trk.engine && trk.count > 0 && (
                <div className="ex-banner is-warn lrc-mb">
                  {trk.count} mercato/i configurati, ma il motore non ha ancora pubblicato uno stato.
                  Questo significa «non lo sappiamo», non «non sta facendo niente»: controlla che agent40 sia vivo.
                </div>
              )}
              <div className="ex-panel ex-rows" data-lrc-tracking>
                {trk.markets.map((cfg) => {
                  const live = trk.engine?.markets.find((m) => m.marketId.toLowerCase() === cfg.marketId.toLowerCase()) ?? null;
                  const title = pricedMarkets.find((m) => m.marketId.toLowerCase() === cfg.marketId.toLowerCase())?.title
                    ?? live?.marketId ?? cfg.marketId;
                  const yes = live?.sides?.yes; const no = live?.sides?.no;
                  const pausedSides = [yes?.filled ? 'YES' : null, no?.filled ? 'NO' : null].filter(Boolean);
                  // L'ETA' DEL MID, misurata sull'orologio locale a partire dalla lettura del motore:
                  // fra un ciclo e l'altro un valore fermo direbbe una cosa falsa proprio quando conta.
                  const midAge = live?.midReadAt != null && nowMs
                    ? (live.midAgeSec ?? 0) + Math.max(0, Math.round((nowMs - live.midReadAt) / 1000))
                    : live?.midAgeSec ?? null;
                  const stato = live?.paused
                    ? { txt: 'dati non freschi — in pausa', cls: 'is-bad' }
                    : live?.gate && live.gate !== 'below-threshold'
                    ? { txt: live.gate, cls: 'is-bad' }
                    : pausedSides.length
                      ? { txt: `in pausa · ${pausedSides.join(' e ')} eseguito`, cls: 'is-warn' }
                      : { txt: 'attivo', cls: 'is-ok' };
                  return (
                    <div key={cfg.marketId} className="ex-row" data-lrc-track-row={cfg.marketId}>
                      <div className="ex-row-main">
                        <div className="ex-row-t">{title}</div>
                        <div className="ex-row-s">
                          <span className={`ex-badge ${stato.cls} lrc-bdg`} data-lrc-track-state>{stato.txt}</span>
                          {live?.plan?.yes?.inBand === false && <span className="ex-badge is-warn lrc-bdg" data-lrc-track-outband>YES fuori banda — nessun reward</span>}
                          {live?.plan?.no?.inBand === false && <span className="ex-badge is-warn lrc-bdg">NO fuori banda — nessun reward</span>}
                          {/* ── LA DISTANZA DAL MID, QUELLA VERA ────────────────────────────────
                              Prima qui c'era `cfg.offsetCents`, cioè il valore CONFIGURATO nel
                              registro. Da quando il motore si posiziona un tick dietro il miglior
                              prezzo altrui, quel numero non descrive più dove sta l'ordine — è solo il
                              ripiego per quando siamo soli sul lato. Mostrarlo come «offset» era un
                              dato falso, non incompleto: statico mentre la distanza vera cambia a ogni
                              ciclo (misurato: 0,6¢ reali contro 1¢ configurato).
                              Adesso si legge il bersaglio calcolato a runtime, e si ripiega sul
                              configurato solo quando il motore non ne ha prodotto uno — dicendolo. */}
                          {(() => {
                            const ty = live?.target?.yes; const tn = live?.target?.no;
                            const reali = [ty?.offsetCents, tn?.offsetCents].filter((x): x is number => typeof x === 'number');
                            if (!reali.length) {
                              return (
                                <>
                                  {' · '}offset <span className="ex-n" data-lrc-track-offset>{cfg.offsetCents}¢</span>
                                  <span className="ex-badge lrc-bdg" data-lrc-track-offset-kind>configurato</span>
                                </>
                              );
                            }
                            const uguali = reali.length === 2 && Math.abs(reali[0] - reali[1]) < 0.001;
                            return (
                              <>
                                {' · '}dal mid{' '}
                                <span className="ex-n" data-lrc-track-offset>
                                  {uguali || reali.length === 1
                                    ? `${reali[0].toFixed(2)}¢`
                                    : `${reali[0].toFixed(2)}¢ / ${reali[1].toFixed(2)}¢`}
                                </span>
                                <span className="ex-badge is-ok lrc-bdg" data-lrc-track-offset-kind title={`offset configurato ${cfg.offsetCents}¢ — usato solo come ripiego quando siamo gli unici sul lato`}>
                                  dal book
                                </span>
                              </>
                            );
                          })()}
                          {/* ── SIAMO IN CIMA AL BOOK, O NO ─────────────────────────────────────
                              L'obiettivo dichiarato è non esserci mai: il caso in cui ci si finisce
                              comunque (bordo banda) è una scelta voluta, e va vista. */}
                          {(['yes', 'no'] as const).map((sd) => {
                            const t = live?.target?.[sd];
                            if (!t) return null;
                            const b = t.mode === 'fallback-alone'
                              ? { txt: `${sd.toUpperCase()} solo`, cls: '', ttl: 'nessun altro su questo lato: si usa l offset di ripiego, e si torna dietro al migliore appena ricompare qualcuno' }
                              : t.onTop === true
                                ? { txt: `${sd.toUpperCase()} in cima`, cls: 'is-warn', ttl: 'un tick dietro il migliore altrui cadrebbe fuori banda: ci si è fermati al bordo premiante, e questo ci mette in cima al book' }
                                : t.onTop === false
                                  ? { txt: `${sd.toUpperCase()} dietro`, cls: 'is-ok', ttl: `un tick dietro il miglior prezzo altrui${t.bestOther != null ? ` (${(t.bestOther * 100).toFixed(1)}¢)` : ''}` }
                                  : null;
                            if (!b) return null;
                            return (
                              <span key={sd} className={`ex-badge ${b.cls} lrc-bdg`} title={b.ttl} data-lrc-track-top={sd}>
                                {b.txt}{t.mode === 'erosion-retreat' ? ' · arretrato' : ''}
                              </span>
                            );
                          })}
                          {' · soglia '}<span className="ex-n">{cfg.minMoveCents}¢</span>
                          {' · size '}<span className="ex-n">{cfg.sizeShares}</span>
                          {' · mid '}
                          <span className={`ex-n ${live?.paused ? 'ex-dn' : ''}`} data-lrc-track-midage>
                            {midAge == null ? 'mai letto' : midAge < 2 ? 'aggiornato adesso' : `aggiornato ${midAge}s fa`}
                          </span>
                          {live?.reason && <div className="ex-why">{live.reason}</div>}
                        </div>
                      </div>
                      <div className="ex-row-nums">
                        <span className="ex-num"><span className="ex-num-k">mid rif.</span><span className="ex-num-v">{cents(live?.referenceMid ?? null)}</span></span>
                        <span className="ex-num">
                          <span className="ex-num-k">BUY YES</span>
                          <span className={`ex-num-v ${yes?.filled ? 'ex-dim' : 'ex-up'}`}>{yes?.price != null ? cents(yes.price) : 'N/D'}</span>
                        </span>
                        <span className="ex-num">
                          <span className="ex-num-k">BUY NO</span>
                          <span className={`ex-num-v ${no?.filled ? 'ex-dim' : 'ex-dn'}`}>{no?.price != null ? cents(no.price) : 'N/D'}</span>
                        </span>
                        <span className="ex-num"><span className="ex-num-k">reprice</span><span className="ex-num-v">{live?.repriceCount ?? 0}</span></span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* IL DIARIO DEL MOTORE. Un automatismo che piazza da solo deve poter rispondere «cosa hai
                  fatto e perche'» senza aprire i log di un processo. */}
              {trk.engine?.recent && trk.engine.recent.length > 0 && (
                <>
                  <p className="lrc-fine lrc-mt">Ultime azioni del motore</p>
                  <div className="ex-panel ex-rows" data-lrc-tracking-log>
                    {trk.engine.recent.slice(0, 12).map((a, i) => (
                      <div key={`${a.at}-${i}`} className="ex-row">
                        <div className="ex-row-main">
                          <div className="ex-row-t">
                            {a.action === 'event' ? (
                              <><span className={`ex-badge ${a.type === 'erosion-recovered' ? '' : 'is-warn'}`}>
                                {a.type === 'fill' ? 'FILL'
                                  : a.type === 'erosion-armed' ? 'EROSIONE'
                                    : a.type === 'erosion-recovered' ? 'erosione rientrata'
                                      : a.type === 'tracking-auto-off' ? 'tracking spento'
                                        : 'sparito'}
                              </span>{' '}
                                lato {String(a.side || '').toUpperCase()}
                                {a.sizeMatched != null && <> · {num(a.sizeMatched, 1)} share eseguite</>}</>
                            ) : (
                              <><span className={`ex-side ${a.book === 'yes' ? 'is-yes' : 'is-no'}`}>BUY {String(a.book || '').toUpperCase()}</span>{' '}
                                <span className="ex-n">{a.priceCents}¢</span>
                                {/* ── PERCHE' QUESTO ORDINE SI E' MOSSO ────────────────────────────
                                    `triggerKind` arrivava già nel JSON ma non compariva: un
                                    riposizionamento per erosione del book era indistinguibile da uno
                                    per movimento del mid, e sono due cose diverse — il primo è la rete
                                    di sicurezza che scatta, il secondo è amministrazione ordinaria. */}
                                {a.triggerKind === 'erosione' && (
                                  <span className="ex-badge is-warn lrc-bdg" data-lrc-log-trigger="erosione"
                                    title={a.erosion?.ratioPct != null ? `profondità al ${a.erosion.ratioPct}% della media recente (${a.erosion.baseline} share): ci si arretra al bordo premiante` : 'la coda davanti all ordine si è assottigliata'}>
                                    erosione{a.erosion?.ratioPct != null ? ` ${a.erosion.ratioPct}%` : ''}
                                  </span>
                                )}
                                {a.triggerKind === 'entrambi' && (
                                  <span className="ex-badge is-warn lrc-bdg" data-lrc-log-trigger="entrambi"
                                    title="mid uscito di banda ED erosione del book confermata nello stesso momento">
                                    mid + erosione
                                  </span>
                                )}
                                {a.triggerKind === 'mid' && a.trigger === 'follow-book' && (
                                  <span className="ex-badge lrc-bdg" data-lrc-log-trigger="mid"
                                    title={a.placement?.bestOther != null ? `il miglior prezzo altrui si è spostato a ${(a.placement.bestOther * 100).toFixed(1)}¢` : 'il book si è spostato'}>
                                    segue il book
                                  </span>
                                )}
                                {a.placement?.onTop === true && (
                                  <span className="ex-badge is-warn lrc-bdg" data-lrc-log-ontop
                                    title="un tick dietro il migliore altrui cadeva fuori banda: fermati al bordo premiante, quindi in cima al book">
                                    in cima
                                  </span>
                                )}
                                {a.placement?.mode === 'fallback-alone' && (
                                  <span className="ex-badge lrc-bdg" data-lrc-log-alone
                                    title="nessun altro su questo lato: offset di ripiego">soli</span>
                                )}
                                {a.inBand === false && <span className="ex-badge is-warn lrc-bdg">fuori banda</span>}
                                {a.ok === false && <span className="ex-badge is-bad lrc-bdg">{a.gate}</span>}
                                {a.sent === false && <span className="ex-badge lrc-bdg">dry-run</span>}</>
                            )}
                          </div>
                          <div className="ex-row-s">
                            {a.action !== 'event' && (
                              <>{a.trigger === 'initial' ? 'primo piazzamento' : <>mid <span className="ex-n">{a.fromMid}¢</span> → <span className="ex-n">{a.toMid}¢</span>{a.movedCents != null && <> (mosso <span className="ex-n">{a.movedCents}¢</span>)</>}</>}
                                {a.reason && <> · {a.reason}</>}</>
                            )}
                          </div>
                        </div>
                        <div className="ex-row-nums">
                          <span className="ex-num"><span className="ex-num-k">ora</span><span className="ex-num-v">{new Date(a.at).toLocaleTimeString()}</span></span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <p className="lrc-fine">
                Su questi mercati il motore piazza e riprezza <b>senza conferma ordine per ordine</b> — la
                delega e&apos; stata data dal toggle nel pannello del mercato, e si toglie da lì. Kill-switch,
                tetto per ordine, gestione manuale e il blocco a 3 minuti dalla chiusura restano tutti in vigore.
              </p>
            </>
          )}

          {/* ── ORDINI A RIPOSO · TUTTI I MERCATI, UNO PER RIGA ─────────────────────────────────────
              Il venue è la fonte: prezzo, size, quanto è già stato eseguito e — la cosa che solo questa
              lettura sa — quando l'ordine muore. Il countdown è quello vero, già corretto per i 60
              secondi con cui l'exchange ritira un GTD in anticipo. */}
          <div className="ex-sech">
            <span className="ex-sech-t">Ordini a riposo · tutti i mercati</span>
            <span className="lrc-fine">
              {resting?.at ? <>dal venue <span className="ex-n">{new Date(resting.at).toLocaleTimeString()}</span></> : 'in lettura…'}
            </span>
          </div>
          {resting?.ok === false && (
            <div className="ex-banner is-bad lrc-mb">Lettura FALLITA: {resting.error ?? '—'} — questa non è una lista vuota.</div>
          )}
          {resting?.simulated && (
            <div className="ex-banner is-warn lrc-mb">Venue non interrogato: «nessun ordine» qui vorrebbe dire «non abbiamo letto».</div>
          )}
          {!resting ? (
            <div className="lrc-nd">Lettura degli ordini…</div>
          ) : resting.ok && !resting.simulated && resting.orders.length === 0 ? (
            <div className="ex-banner is-ok lrc-mb" data-lrc-resting="empty">
              Nessun ordine a riposo sul venue — letto, non dedotto.
            </div>
          ) : resting.orders.length > 0 ? (
            <div className="ex-panel ex-rows" data-lrc-resting-list>
              {resting.orders.map((o) => {
                const judged = (orders?.orders ?? []).find((j) => j.orderId && j.orderId === o.orderId) ?? null;
                const title = judged?.marketTitle
                  ?? pricedMarkets.find((m) => m.marketId === o.marketId)?.title
                  ?? o.marketId ?? 'mercato sconosciuto';
                // Il tempo residuo scorre sull'orologio locale a partire dall'istante letto: se il
                // countdown si fermasse fra un poll e l'altro direbbe una cosa falsa proprio nei
                // secondi in cui conta di più.
                const left = o.expiresAtMs != null
                  ? Math.round((o.expiresAtMs - nowMs) / 1000)
                  : (fin(o.secondsToExpiry) ? (o.secondsToExpiry as number) - Math.round((nowMs - Date.parse(resting.at)) / 1000) : null);
                const filled = fin(o.sizeMatched) && (o.sizeMatched as number) > 0;
                return (
                  <div key={o.orderId ?? Math.random()} className="ex-row" data-lrc-resting-row={o.orderId ?? ''}>
                    <div className="ex-row-main">
                      <div className="ex-row-t">
                        <span className={`ex-side ${judged?.book === 'yes' ? 'is-yes' : judged?.book === 'no' ? 'is-no' : ''}`}>
                          {(o.side ?? 'BUY').toUpperCase()} {judged?.book ? judged.book.toUpperCase() : 'N/D'}
                        </span>{' '}
                        {title}
                      </div>
                      <div className="ex-row-s">
                        {judged?.inBand === true ? <span className="ex-badge is-ok lrc-bdg">in banda</span>
                          : judged?.inBand === false ? <span className="ex-badge is-bad lrc-bdg">fuori banda</span>
                            : <span className="ex-badge lrc-bdg" title="regole di venue non leggibili oppure token non riconducibile ai due book">non giudicabile</span>}
                        {' '}<span className="ex-badge lrc-bdg">{o.status}</span>
                        {filled && <span className="ex-badge is-warn lrc-bdg">eseguito {num(o.sizeMatched, 1)}</span>}
                        {' · '}<span className="ex-dim">{o.source}</span>
                      </div>
                    </div>
                    <div className="ex-row-nums">
                      <span className="ex-num"><span className="ex-num-k">prezzo</span><span className="ex-num-v">{cents(o.price)}</span></span>
                      <span className="ex-num"><span className="ex-num-k">size</span><span className="ex-num-v">{num(o.sizeRemaining ?? o.size, 1)}</span></span>
                      <span className="ex-num"><span className="ex-num-k">valore</span><span className="ex-num-v">{money(o.notionalUsd)}</span></span>
                      <span className="ex-num">
                        <span className="ex-num-k">{o.orderType === 'GTC' ? 'durata' : 'scade fra'}</span>
                        <span className={`ex-num-v ${o.orderType === 'GTC' ? 'ex-dim' : left != null && left <= 180 ? 'ex-dn' : 'ex-gold'}`}
                          data-lrc-resting-ttl={o.orderId ?? ''}>
                          {o.orderType === 'GTC' ? 'nessuna' : ttlTxt(left)}
                        </span>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
          <p className="lrc-fine">
            Il countdown è la scadenza dichiarata dal venue, già corretta per i 60 secondi con cui un GTD
            viene ritirato in anticipo: è quanto sopravvive l&apos;ordine se il server si ferma adesso.
            {resting?.orders.some((o) => fin(o.secondsToRefresh))
              ? ' Dove il rinnovo automatico è attivo, il riprezzo scatta prima di quel momento.'
              : ''}
          </p>

          {/* ── POSIZIONI APERTE ────────────────────────────────────────────────────────────────── */}
          <div className="ex-sech">
            <span className="ex-sech-t">Posizioni aperte · esposizione netta</span>
            <button className="ex-btn is-sm" onClick={loadPositions} disabled={posLoading}>{posLoading ? 'Lettura…' : 'Aggiorna'}</button>
          </div>
          {pos && pos.ok === false && (
            <div className="ex-banner is-bad">Posizioni NON lette: {pos.error ?? 'errore sconosciuto'} — non è una lista vuota.</div>
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
              <div className="ex-panel ex-rows" data-lrc-poslist>
                {pos.markets.map((p) => (
                  <div key={p.marketId ?? Math.random()} className="ex-row" data-lrc-position={p.marketId ?? ''}>
                    <div className="ex-row-main">
                      <div className="ex-row-t">{p.title ?? p.marketId ?? 'mercato sconosciuto'}</div>
                      <div className="ex-row-s">
                        netto{' '}
                        <b className={`ex-n ${p.netDirection === 'yes' ? 'ex-up' : p.netDirection === 'no' ? 'ex-dn' : ''}`}>
                          {p.netDirection === 'flat' ? 'piatto' : `${num(Math.abs(p.netShares ?? 0), 1)} ${p.netDirection.toUpperCase()}`}
                        </b>
                        {' · '}medio{' '}
                        <span className="ex-n">{cents(p.legs.find((l) => l.side === p.netDirection)?.avgPrice ?? p.legs[0]?.avgPrice ?? null)}</span>
                        {' · '}mid{' '}
                        <span className="ex-n">{cents(p.legs.find((l) => l.side === p.netDirection)?.curPrice ?? p.legs[0]?.curPrice ?? null)}</span>
                        {p.valueUnknown && <span className="ex-badge is-warn lrc-bdg" title="una gamba senza valore leggibile: il totale non è calcolato, non è zero">parziale</span>}
                      </div>
                    </div>
                    <div className="ex-row-nums">
                      <span className="ex-num"><span className="ex-num-k">costo</span><span className="ex-num-v">{money(p.initialValueUsd)}</span></span>
                      <span className="ex-num"><span className="ex-num-k">a mid</span><span className="ex-num-v">{money(p.currentValueUsd)}</span></span>
                      <span className="ex-num"><span className="ex-num-k">P&amp;L</span><span className={`ex-num-v ${pnlCls(p.unrealizedPnlUsd)}`}>{money(p.unrealizedPnlUsd)}</span></span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {pos && (
            <p className="lrc-fine">
              {pos.source} · wallet <span className="ex-n">{pos.wallet ?? 'N/D'}</span> · sola lettura.
              P&amp;L <b>mark-to-mid</b>, non un incasso.
            </p>
          )}

          {/* ── I COMANDI, sulla stessa schermata dello stato che descrivono ────────────────────── */}
          <div className="ex-sech"><span className="ex-sech-t">Comandi sugli ordini</span></div>
          <ManualOrdersPanel />

          <p className="lrc-note">
            Stesse cifre dell&apos;intestazione: un fetch, una lettura del venue, un giudizio di banda.
          </p>

          {/* KILL e RIPRISTINA, ancorati in fondo: sono i due comandi che devono restare raggiungibili
              qualunque cosa si stia guardando, senza cercarli. */}
          <div className="ex-actionbar" data-lrc-killbar>
            <button className="ex-btn is-danger" onClick={doKill} disabled={killBusy != null} data-lrc-kill>
              {killBusy === 'kill' ? 'KILL in corso…' : '⛔ KILL'}
            </button>
            <button className="ex-btn" onClick={doReset} disabled={killBusy != null} data-lrc-reset>
              {killBusy === 'reset' ? 'Ripristino…' : 'Ripristina'}
            </button>
            <span className="lrc-killnote">
              {killMsg ?? 'KILL disarma e cancella tutto sul venue. Ripristina verifica da due fonti che non resti esposizione.'}
            </span>
          </div>
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
                    {/* ── LA CARD INTERA APRE IL PANNELLO ──────────────────────────────────────
                        Non un pulsantino in un angolo: la superficie che si legge è la superficie
                        che si tocca, ed è quella che porta con sé il proprio conditionId. I comandi
                        secondari («Book», «Dettagli») stanno fuori da questo bottone, così un tocco
                        su di loro non apre nulla. */}
                    <button
                      className="lrc-mkt-open"
                      onClick={() => setOrderTarget(targetFromBoard(m))}
                      data-lrc-open-order={m.marketId}
                      title="Apre il pannello ordine su QUESTO mercato, senza cambiare tab e senza cercare nulla"
                    >
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
                    </button>

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
                        <span className="lrc-taphint">tocca la scheda per piazzare</span>
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
            onOpenOrder={(row) => setOrderTarget(targetFromVenue(row))}
          />
        </section>
      )}

      {/* ── 3 · OTTIMIZZA CAPITALE ────────────────────────────────────────────────────────────────
          Solo il pianificatore. La ricerca di un singolo mercato è sparita da qui: cercare un mercato
          è il mestiere della tab Mercati, e averne due copie con comportamenti diversi è esattamente
          come è nato il disallineamento fra la card toccata e il mercato raggiunto.
          Anche «Strategia sul fill» è via: il suo ciclo non ha nessun chiamante in agent o API, quindi
          quei comandi descrivevano una funzione che non gira. Un interruttore che non è collegato a
          niente è peggio di un interruttore assente. */}
      {tab === 'alloca' && (
        <section className="lrc-sec" data-lrc-section="alloca">
          <Ask q="Quanto capitale metto, e su quali mercati?" sub="Un piano, non un ordine: da qui si piazza solo aprendo il pannello su un mercato." />
          <RewardsAllocatePanel onPlaceOrder={(row) => setOrderTarget(row)} placed={placedTick} />
        </section>
      )}

      {/* Le regole del programma: sempre a un tocco dal «?», mai una sezione da attraversare. */}
      {showRules && (
        <div className="lrc-scrim" data-lrc-section="regole" onClick={(e) => { if (e.target === e.currentTarget) setShowRules(false); }}>
          <div className="lrc-modal" role="dialog" aria-modal="true" aria-label="Regole del programma premi">
            <div className="lrc-modal-head">
              <span className="ex-sech-t">Come si guadagna, esattamente</span>
              <button className="lrc-modal-x" onClick={() => setShowRules(false)} aria-label="Chiudi" data-lrc-rules-close>✕</button>
            </div>
            <div className="lrc-modal-body">
          <div className="lrc-rulesbox">
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
            </div>
          </div>
        </div>
      )}

      {/* ── IL PANNELLO ORDINE ────────────────────────────────────────────────────────────────────
          Montato QUI, in coda alla console e non dentro una sezione: si apre sopra la lista che lo ha
          chiamato senza smontarla, quindi alla chiusura la lista è ancora dov era — stessa posizione,
          stessi filtri, stessa ricerca. Nessuna tab cambia. */}
      {orderTarget && (
        <OrderPanel
          target={orderTarget}
          balanceUsd={capitalUsd}
          onClose={() => setOrderTarget(null)}
          onEnabled={() => { loadBoard(); }}
          // IL SEGNALE VERSO LA CODA DELL'ALLOCATORE. La console fa solo da filo: non decide niente,
          // riporta che un piazzamento e' andato a buon fine e su quale mercato. La coda avanza solo
          // sentendo questo, quindi non puo' avanzare su un ordine che non e' partito.
          onPlaced={(info) => setPlacedTick({ ...info, at: Date.now() })}
        />
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
function VenueResults({ q, busy, err, rows, dropped, anyFilterOn, sortByPool, onOpenOrder }: {
  q: string; busy: boolean; err: string | null; rows: VenueSearchRow[]; dropped: number;
  anyFilterOn: boolean; sortByPool: boolean;
  onOpenOrder: (row: VenueSearchRow) => void;
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
              <button
                key={m.marketId}
                className="ex-row lrc-venue-row"
                data-lrc-venue-market={m.marketId}
                data-lrc-open-order={m.marketId}
                onClick={() => onOpenOrder(m)}
                title="Apre il pannello ordine su QUESTO mercato. Nessun cambio di tab, nessuna ricerca: il conditionId e quello di questa riga."
              >
                <div className="ex-row-main">
                  <div className="ex-row-t">{m.question ?? `${m.marketId.slice(0, 10)}…`}</div>
                  <div className="ex-row-s">
                    {closeTxt(m.minutesToClose)}
                    {m.tick != null && <> · tick <span className="ex-n">{m.tick}</span></>}
                    {m.rewardsMaxSpreadCents != null && <> · banda <span className="ex-n">{m.rewardsMaxSpreadCents.toFixed(2)}¢</span></>}
                  </div>
                  <div className="ex-badges lrc-mt">
                    {/* L'ETICHETTA VIENE DALLA FUNZIONE, non da una copia della stringa. Qui c'era il
                        testo scritto a mano, e diceva «NESSUN REWARD» anche quando il montepremi non
                        era stato LETTO — due fatti diversi con la stessa frase. `rewardLabel` li
                        distingue già (lib/maker/market-search.rewardLabelFor). */}
                    {!m.hasRewards && (
                      <span className="ex-badge is-warn" data-lrc-no-reward>{m.rewardLabel}</span>
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
                {/* ── PERCHE QUI NON C'E PIU UN PULSANTE «vai a…» ─────────────────────────────
                    Prima questa riga portava altrove passando il mercato a una RICERCA, e una ricerca
                    restituisce una lista: da quando i risultati sono ordinati per scadenza piu vicina,
                    il mercato di partenza non era quasi mai la prima riga. Misurato: partendo dalla card
                    «3:20PM-3:25PM» la tabella mostrava «2:15PM-2:30PM» in riga 1 e quella giusta in riga
                    4 — e chi premeva la prima riga, che e la cosa naturale da fare, agiva su un mercato
                    che non aveva scelto. E successo davvero, alle 18:09:37 del 2026-08-01.
                    Il rimedio non e ordinare meglio quella lista: e non produrne nessuna. La riga
                    consegna l OGGETTO al pannello, e il conditionId che arriva nella POST e per
                    costruzione questo. Non esiste piu una prima riga sbagliata da premere. */}
              </button>
            ))}
          </div>
          <p className="lrc-fine">
            Tocca una riga per aprire il pannello ordine su quel mercato: si apre sopra questa lista,
            senza cambiare tab e senza perdere ricerca e filtri.
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

/* La scheda intera e il bersaglio del tocco: un bottone che non sembra un bottone, perche la
   superficie che si legge e la superficie che si preme. Nessun riquadro, nessuna ombra: solo il
   bordo che si accende, come su una riga di book. */
.lrc-mkt-open { display: block; width: 100%; text-align: left; cursor: pointer;
  background: none; border: 0; border-radius: 8px 8px 0 0; padding: 0; color: inherit; font: inherit; }
.lrc-mkt-open:hover { background: rgba(240,185,11,.05); }
.lrc-mkt-open:focus-visible { outline: 2px solid var(--ex-gold); outline-offset: -2px; }
.lrc-taphint { font-size: 10px; color: var(--ex-txt-3); margin-right: auto; }
.lrc-venue-row { width: 100%; text-align: left; cursor: pointer; font: inherit; color: inherit; }
.lrc-venue-row:hover { background: rgba(240,185,11,.05); }
.lrc-venue-row:focus-visible { outline: 2px solid var(--ex-gold); outline-offset: -2px; }

.lrc-help { margin-left: 6px; width: 22px; height: 22px; border-radius: 50%; cursor: pointer;
  border: 1px solid var(--ex-line); background: var(--ex-panel-2); color: var(--ex-txt-3);
  font-size: 12px; font-weight: 700; line-height: 1; flex: 0 0 auto; }
.lrc-help:hover { border-color: var(--ex-gold); color: var(--ex-gold); }

.lrc-scrim { position: fixed; inset: 0; z-index: 55; background: rgba(0,0,0,.6);
  display: flex; align-items: center; justify-content: center; padding: 16px; }
.lrc-modal { width: 100%; max-width: 560px; max-height: 84vh; display: flex; flex-direction: column;
  background: var(--ex-bg); border: 1px solid var(--ex-line); border-radius: 10px; }
.lrc-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 11px 13px; border-bottom: 1px solid var(--ex-line); }
.lrc-modal-x { width: 30px; height: 30px; border-radius: 6px; cursor: pointer; flex: 0 0 auto;
  border: 1px solid var(--ex-line); background: var(--ex-panel-2); color: var(--ex-txt); }
.lrc-modal-x:hover { border-color: var(--ex-gold); color: var(--ex-gold); }
.lrc-modal-body { overflow-y: auto; padding: 4px 13px 13px; }

.lrc-killnote { font-size: 10.5px; color: var(--ex-txt-3); line-height: 1.4; flex: 1 1 140px; min-width: 0; }

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

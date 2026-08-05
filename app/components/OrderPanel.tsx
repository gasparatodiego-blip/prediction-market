'use client';

// OrderPanel — il pannello di piazzamento, aperto SOPRA la lista che lo ha chiamato.
//
// PERCHÉ ESISTE, E PERCHÉ CHIUDE UN BUG DI CLASSE. Prima, per piazzare, si toccava un mercato in una tab
// e si finiva in un'altra con una RICERCA precompilata: l'identità del mercato viaggiava come TESTO, e una
// ricerca testuale restituisce una lista. Il mercato da cui si era partiti non era quasi mai la prima riga
// (i risultati sono ordinati per scadenza più vicina), e chi premeva la prima riga agiva su un mercato che
// non aveva scelto. È successo davvero: alle 18:09:37 del 2026-08-01 è stato abilitato un mercato che
// nessuno voleva.
//
// Qui quel percorso non esiste più. Il pannello riceve l'OGGETTO del mercato toccato e lo tiene: nessuna
// navigazione, nessuna ricerca, nessun testo da risolvere. Il conditionId che finisce nella richiesta è per
// costruzione lo stesso della card toccata — non c'è un passaggio in cui possa diventare un altro.
//
// LA CONFERMA RESTA IN DUE TOCCHI, e non è negoziabile. «Rivedi ordine» costruisce il riepilogo, «Conferma
// e piazza» è l'unico punto che scrive. Sono due tocchi sulla STESSA schermata: nessun ping-pong fra tab,
// ma nemmeno un ordine reale a un tocco solo.
//
// COSA DICE IL PULSANTE FINALE. Lo stato di invio lo decide MANUAL_ORDER_PLACEMENT sul server, che è una
// cosa DIVERSA da MAKER_MODE: il percorso manuale ha il suo interruttore e non legge quello del motore.
// Il pannello legge lo stato reale da /api/maker/manual/config e lo scrive sul pulsante. Non dice mai
// «dry-run» quando il server invierebbe davvero.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// La STESSA funzione che il motore usa per decidere dove quotare: l'anteprima non puo' mostrare un
// livello diverso da quello che verrebbe piazzato, perche' e' lo stesso codice.
// `planQuotes` e `offsetFromPrice` non servono piu' a questo componente: l'anteprima a due gambe viveva
// nel pannello lungo, e la distanza dal mid ora la tiene lo stepper del popup. Restano usate dal motore.
import { sizeScale, sizeAtPct } from '@/lib/maker/mm-quote-math';
// Le STESSE funzioni pure che la route usa per costruire la vista del book: distanza dal mid, righe
// bloccate dal filtro e verdetto sul prezzo. Sono in un modulo condiviso e coperto da test proprio perche'
// il pannello non possa dare una risposta diversa dal server sulla stessa domanda.
import { distanceCents, priceVerdict } from '@/lib/maker/book-view';
// «QUESTO PREZZO È LIVE?» SI CHIEDE UNA VOLTA SOLA. Prima questo file rispondeva due volte con due
// regole diverse — la testata guardava fonte+vitalità+età, l'etichetta di freschezza solo la fonte — e
// sullo stesso mercato mostrava «book non live» accanto a «book live · 2 min fa». Il verdetto e tutte
// le scritte che ne discendono vengono da qui, quindi non possono più divergere.
import { statoBook } from '@/lib/maker/stato-book';
// COSA SI LEGGE PRIMA DI CONFERMARE. Le righe del riepilogo e la risposta a «ci sono tutti i dati?»
// vivono in un modulo puro, esercitato da un test: dentro il JSX sarebbero verificabili solo con una
// regex sul sorgente, cioè non verificabili.
import { riepilogoOrdine } from '@/lib/maker/riepilogo-ordine';
// SE IL PULSANTE È SPENTO, C'È SCRITTO PERCHÉ. `puoInviare` è definito come «nessun motivo», quindi lo
// stato del pulsante e l'elenco dei motivi non sono due espressioni da tenere allineate: sono la stessa.
// Prima erano due, in due punti diversi del file, e sono divergute — vedi lib/maker/motivi-blocco.js.
import { motiviBlocco } from '@/lib/maker/motivi-blocco';
// Un campo vuoto NON vale zero: `Number('')` fa 0, e uno zero in un riepilogo d'ordine si legge come un
// prezzo. Stessa funzione già usata dal pannello manuale.
import { numeroDigitato } from '@/lib/campo-numerico';

// Il rinnovo del permesso, e la soglia di freschezza che il pannello PROMETTE al server quando conferma.
//
// PERCHE' 30 SECONDI E NON 5. L'eta' di un book e' il tempo dall'ultimo messaggio del websocket, non un
// segno di vita della connessione: un mercato tranquillo puo' stare fermo un minuto con la sottoscrizione
// perfettamente viva, semplicemente perche' nessuno ha mosso il book. Una soglia a 5 secondi rifiuterebbe
// ordini su libri sani, e un blocco che scatta quando va tutto bene e' un blocco che l'operatore impara a
// ignorare — cioe' peggio che non averlo. 30 secondi e' la stessa soglia con cui il feed stesso smette di
// chiamare «live» un book (STALE_MS in agent34): usare la sua definizione invece di inventarne una
// seconda significa che non possono dare due risposte diverse alla stessa domanda.
const LEASE_RENEW_MS = 5_000;
const FRESH_BOOK_MAX_MS = 30_000;
// Quanto si aspetta prima di smettere di chiamarlo «collegamento in corso». agent34 guarda il file dei
// permessi ogni 2s e poi deve risolvere i token e ricevere il primo snapshot: quindici secondi coprono
// quel percorso con abbondanza. Oltre, non è latenza — è che quel mercato non verrà coperto.
const LEASE_CONNECT_GRACE_MS = 15_000;

/** La forma normalizzata che il pannello accetta, da qualunque lista arrivi. */
export interface OrderTarget {
  marketId: string;
  title: string;
  /** Fine del mercato, ISO. null = non leggibile (mai dedotta). */
  endDate: string | null;
  minutesToClose: number | null;
  mid: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spreadCents: number | null;
  tick: number | null;
  minSize: number | null;
  maxSpreadCents: number | null;
  rewardsDailyRate: number | null;
  hasRewards: boolean;
  enabled: boolean;
  /** Size suggerita da un piano di allocazione; assente ⇒ si parte dalla size minima del venue. */
  presetSize?: number | null;
  // ── LE GAMBE DEL PIANO, GIÀ CALCOLATE ────────────────────────────────────────────────────────────
  // Fino al 4 agosto 2026 da un piano arrivava SOLO la size, e il prezzo veniva precompilato con il mid
  // agganciato al tick — cioè con la quotazione peggiore che esista: appoggiata esattamente sul mid,
  // in cima al libro, dove il replay ha misurato 14.642 fill contro i 395 di un tick più in là.
  // Il piano quel prezzo lo calcola già (`snappedBid`/`snappedAsk` all'offset scelto): non c'era
  // ragione di ricavarne un altro, tantomeno il più esposto.
  //
  // E ne calcola DUE, non uno: `gambeDiUnaRiga` produce BUY YES a mid−d e BUY NO a (1−mid)−d, perché
  // con la formula ufficiale a due lati un lato solo matura zero fuori da [0,10–0,90] e un terzo dentro.
  // Il pannello ne apriva una: metà del piano si perdeva per strada.
  //
  // `pairLegs` le porta entrambe, IN ORDINE. Il pannello ne rende attiva una alla volta e la seconda
  // richiede un tocco esplicito: mettere in coda non è mai autorizzare.
  pairLegs?: Array<{
    book: 'yes' | 'no';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    /** L'etichetta della gamba, per dire all'operatore a che punto è: «gamba 1 di 2 · YES». */
    label?: string;
  }> | null;
}

interface ManualCfg {
  kill: { readable: boolean; killed: boolean; reason: string | null };
  placement: { mode: string; sends: boolean; note: string };
  caps: { readable: boolean; effectiveOrderCapUsd: number | null; maxOrderNotionalUsd: number | null; liveMinCapUsd: number | null };
  autoReprice: { expiry: { orderType: string; ttlSeconds: number; refreshMarginSeconds: number | null } | null; globalEnabled: boolean; optedInMarketIds: string[] } | null;
}
/** Una riga del book: prezzo, size a QUEL livello, e il cumulato dal tocco fin qui. */
interface Level { price: number; size: number; total: number }
/**
 * LA VISTA COERENTE DI UN BOOK, come la costruisce lib/maker/book-view.js. Mid, tocco e scala escono
 * tutti dagli STESSI livelli letti nello STESSO istante — è questo che rende impossibile per costruzione
 * il difetto «MID 20.0¢ accanto a BID 21.0¢ e ASK 22.0¢».
 *
 * `mid` e `scoringMid` sono DUE COSE DIVERSE e restano separate apposta:
 *   · `mid`        = midpoint del tocco disegnato qui sotto. È quello che il pannello mostra.
 *   · `scoringMid` = il mid del VENUE (filtrato di min_incentive_size), contro cui si misura la banda
 *                    premiante e su cui il motore piazza. Non viene toccato da questo lavoro.
 * Quando divergono, `midNotes` lo dice a parole: una nota, non tre cifre mute.
 */
interface BookSide {
  bestBid: number | null; bestAsk: number | null; spreadCents: number | null;
  mid: number | null;
  midKind: 'midpoint' | 'one-sided-bid' | 'one-sided-ask' | 'unavailable';
  scoringMid: number | null;
  midDiffersFromScoring: boolean;
  scoringMidOutsideTouch: boolean;
  midNotes: string[];
  scoringMidNote: string | null;
  lastTradePrice: number | null;
  levels: {
    bids: Level[]; asks: Level[];
    bidCount: number; askCount: number; bidShown: number; askShown: number;
    truncated: boolean; maxSize: number | null; requested: number; sourceCap: number | null;
  };
  live: boolean; ageMs: number | null; source: string | null; tokenId: string | null;
}
/** Quello che /api/maker/quote restituisce: i prezzi PIU' la loro provenienza e la loro eta'. */
interface Quote {
  marketId: string; title: string | null;
  mid: number | null; bestBid: number | null; bestAsk: number | null; spreadCents: number | null;
  scoringMid: number | null; midKind: BookSide['midKind'];
  midDiffersFromScoring: boolean; scoringMidOutsideTouch: boolean; midNotes: string[];
  tick: number | null; minSize: number | null; maxSpreadCents: number | null;
  source: 'live-book' | 'gamma'; sourceNote: string; live: boolean; ageMs: number | null;
  /** Da dove viene la PROFONDITA'. Puo' differire da `source`: le regole da Gamma, il book dalla REST. */
  depthSource: 'live-book' | 'clob-rest' | null; depthSourceNote: string;
  books: { yes: BookSide; no: BookSide };
}
interface TrackSide { book: string; price: number | null; priceCents: number | null; placeable: boolean; reason: string | null; inBand: boolean | null; bandNote: string | null }
interface TrackPreview { ok: boolean; error?: string; plan?: { ok: boolean; reason: string | null; yes: TrackSide | null; no: TrackSide | null }; rules?: { mid: number | null; tick: number | null; bandRadiusCents: number | null }; restingOrders?: Array<{ orderId: string | null; price: number | null; size: number | null }>; ordersToRetire?: Array<{ orderId: string | null; book: 'yes' | 'no'; price: number | null; size: number | null }>; note?: string }
type TrkSides = 'both' | 'yes' | 'no';
interface TrackRecord {
  marketId: string; offsetCents: number; minMoveCents: number; sizeShares: number; atIso: string | null;
  /** Assente sui record scritti prima che il lato fosse selezionabile: vale 'both'. */
  sides?: TrkSides;
}

/**
 * Lo stato della CHIUSURA AUTOMATICA per QUESTO mercato.
 *
 * Due interruttori, entrambi necessari, come per il tracking e per l'auto-riprezzo: un generale e uno per
 * mercato. `enabled` e' gia' la loro AND, calcolata dal server — il pannello non la ricompone, cosi' non
 * puo' dare una risposta diversa da quella che il motore usera' davvero.
 *
 * `readable:false` significa «non lo so», e non viene mai mostrato come «spento».
 */
interface AutoCloseState {
  readable: boolean;
  error: string | null;
  globalEnabled: boolean;
  profitCents: number | null;
  market: {
    marketId: string;
    enabled: boolean;
    marketEnabled: boolean;
    globalEnabled: boolean;
    readable: boolean;
    reason: string | null;
    record: { atIso?: string | null; by?: string | null } | null;
  } | null;
}
interface PlaceResult {
  ok: boolean; sent: boolean; dryRun?: boolean; placement?: string;
  gate: string | null; reason: string | null; orderId?: string | null; notionalUsd?: number | null;
  /** Non un rifiuto: l'ordine è passato E non maturerà reward. Detto insieme all'esito, non al posto suo. */
  bandAdvisory?: string | null;
  /** Il prezzo che il server ha applicato, se diverso da quello scritto. La regola «mai primo sul
   *  libro» sposta la quotazione dietro al miglior altro ordine per non essere il bersaglio di un
   *  taker informato — ma un prezzo che cambia senza dirlo è peggio del male che cura. */
  priceAdjusted?: { inCoda?: { from: number; to: number; mode?: string; onTop?: boolean; bestOther?: number | null } } | null;
  inCoda?: { ok: boolean; mode?: string; onTop?: boolean; bestOther?: number | null; reason?: string | null } | null;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const money = (v: number | null | undefined, nd = 2): string => (fin(v) ? `$${v.toFixed(nd)}` : 'N/D');
const cents = (p: number | null | undefined): string => (fin(p) ? `${(p * 100).toFixed(1)}¢` : 'N/D');
/**
 * Le size del book. Migliaia separate da uno SPAZIO, mai da un punto.
 *
 * Il punto sarebbe il separatore italiano, ma in questa colonna convive con prezzi scritti alla maniera
 * dei mercati (0.746, tick 0.01): «36.982» accanto a «24.0¢» si legge trentasei-virgola-nove, non
 * trentaseimila. Lo spazio non ha quel doppio senso, ed e' la convenzione SI usata anche in finanza.
 * Sotto le mille si tengono al massimo due decimali, perche' le size del CLOB ce li hanno davvero.
 */
const fmtSize = (s: number | null | undefined): string => {
  if (!fin(s)) return 'N/D';
  const n = s >= 1000 ? Math.round(s) : Math.round(s * 100) / 100;
  const [i, d] = String(n).split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (d ? `.${d}` : '');
};

/** Countdown leggibile. Mai «0m»: sotto il minuto lo dice, sotto i dieci tiene il decimo. */
function closeTxt(min: number | null): string {
  if (!fin(min)) return 'scadenza ignota';
  if (min <= 0) return 'scaduto';
  if (min < 1) return 'meno di 1 min';
  if (min < 10) return `${min.toFixed(1)} min`;
  if (min < 90) return `${Math.round(min)} min`;
  if (min < 2880) return `${(min / 60).toFixed(1)} h`;
  return `${(min / 1440).toFixed(1)} g`;
}
/** Il prezzo agganciato alla griglia del tick. Arrotonda al più vicino: qui non c'è un lato da favorire. */
function snapToTick(price: number, tick: number): number {
  return +(Math.round(price / tick) * tick).toFixed(10);
}
function onTick(price: number, tick: number): boolean {
  if (!fin(price) || !fin(tick) || tick <= 0) return false;
  return Math.abs(price - snapToTick(price, tick)) < tick / 1000;
}

export default function OrderPanel({ target, balanceUsd, onClose, onEnabled, onPlaced }: {
  target: OrderTarget;
  balanceUsd: number | null;
  onClose: () => void;
  onEnabled?: (marketId: string) => void;
  /** Chiamato SOLO dopo un piazzamento andato a buon fine, con cio' che e' stato piazzato davvero.
   *  Serve alla coda dell'allocatore per avanzare: la coda non piazza nulla da se', osserva. Non viene
   *  mai chiamato per un rifiuto, ne' per una gamba che l'operatore non ha confermato. */
  onPlaced?: (info: { marketId: string; book: 'yes' | 'no'; price: number; size: number; sent: boolean; legIdx: number; legTotal: number }) => void;
}) {
  const [cfg, setCfg] = useState<ManualCfg | null>(null);
  const [book, setBook] = useState<'yes' | 'no'>('yes');
  // ── QUALE GAMBA DEL PIANO SI STA GUARDANDO ────────────────────────────────────────────────────────
  // Un piano a due lati arriva come `target.pairLegs` in ordine. Se ne rende attiva UNA alla volta: la
  // seconda si apre solo con un tocco esplicito dopo che la prima è stata piazzata. Mettere due gambe
  // in coda non è autorizzarne due — e questa è la riga che tiene quella promessa.
  const [legIdx, setLegIdx] = useState(0);
  const legs = target.pairLegs && target.pairLegs.length ? target.pairLegs : null;
  const active = legs ? (legs[legIdx] ?? legs[0]) : null;
  const legNext = legs && legIdx + 1 < legs.length ? legs[legIdx + 1] : null;
  const [sizeStr, setSizeStr] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [autoRenew, setAutoRenew] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlaceResult | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableMsg, setEnableMsg] = useState<string | null>(null);
  const [isEnabled, setIsEnabled] = useState(target.enabled);
  // LA QUOTAZIONE LIVE, e le due bandierine che la tengono al suo posto.
  // `priceTouched` esiste perche un aggiornamento del mid NON deve poter riscrivere un prezzo che
  // l'operatore ha scelto a mano. Stare lontani dal mid e una decisione, non una svista: sovrascriverla
  // ogni pochi secondi farebbe perdere una modifica intenzionale — e' gia' successo in un test reale.
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [priceTouched, setPriceTouched] = useState(false);
  // Lo stato della sottoscrizione temporanea al book. Tre valori, non due: «sto chiedendo» e «ho chiesto
  // e non ce l'ho fatta» sono cose diverse, e mostrarle uguali farebbe leggere una latenza normale come
  // un guasto — o, molto peggio, un guasto come una latenza normale.
  const [lease, setLease] = useState<'idle' | 'asking' | 'held' | 'failed'>('idle');
  // ── L'EVIDENZIAZIONE DOPO IL TOCCO ─────────────────────────────────────────────────────────────
  // Toccare una riga cambia DUE cose lontane fra loro sullo schermo — il prezzo del piazzamento manuale
  // e l'offset del motore — e una di queste sta sotto la piega. Senza un segnale, l'operatore vede
  // solo il libro reagire e deve fidarsi che il resto sia cambiato. Il lampeggio dura 800ms: abbastanza
  // per essere notato, troppo poco per diventare un'animazione che si aspetta.
  const [flashAt, setFlashAt] = useState<number | null>(null);
  const flashing = flashAt != null;
  useEffect(() => {
    if (flashAt == null) return;
    const t = setTimeout(() => setFlashAt(null), 800);
    return () => clearTimeout(t);
  }, [flashAt]);

  // ── IL FOGLIO RAPIDO AL TOCCO ──────────────────────────────────────────────────────────────────
  // La via veloce: si apre sopra il pannello e porta dal tocco alla conferma senza scorrere.
  //
  // NON HA UNO STATO SUO per le cose che contano. Lato, prezzo, size, soglia e chiusura automatica
  // sono LO STESSO stato dei pannelli sotto, e la conferma chiama LA STESSA `place()`. Due percorsi di
  // scrittura verso lo stesso venue sarebbero due insiemi di gate da tenere allineati per sempre, e la
  // prima volta che divergessero lo si scoprirebbe da un ordine sbagliato. Quello che il foglio ha di
  // suo e' soltanto: se e' aperto, a che passo e', e i due comandi (percentuale e distanza) che
  // TRADUCONO un gesto in quei valori condivisi.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetStep, setSheetStep] = useState<'form' | 'review'>('form');
  // Le impostazioni secondarie del riepilogo (motore, durata, chiusura) e il book completo della pagina
  // partono PIEGATI: restano a un tocco, ma non stanno più sul percorso obbligato verso la conferma.
  const [reviewDetails, setReviewDetails] = useState(false);
  const [bookAperto, setBookAperto] = useState(false);
  // Da che parte del mid stava la riga toccata. Serve a ricostruire il prezzo dalla distanza senza
  // ribaltare l'ordine sull'altro lato del libro quando si usa lo stepper.
  const [sheetBelow, setSheetBelow] = useState(true);
  // La distanza dal mid in centesimi, che e' il comando vero del foglio: il prezzo ne e' la conseguenza.
  const [sheetDistC, setSheetDistC] = useState<number | null>(null);
  // QUALE MOTORE governa l'ordine. E' la scelta che decide cosa fa il pulsante finale: un ordine solo
  // fermo dov'e', oppure una delega continuata a un motore che lo insegue. Sono due poteri diversi e
  // il foglio li fa scegliere per nome invece di dedurli da quali campi sono stati compilati.
  const [sheetEngine, setSheetEngine] = useState<'manual' | 'tracking'>('manual');

  // La riga toccata, tenuta per prezzo e non per indice: il book si riordina a ogni aggiornamento, e un
  // indice evidenzierebbe la riga sbagliata un secondo dopo.
  const [pickedPrice, setPickedPrice] = useState<number | null>(null);
  // ── IL TRACKING ATTIVO ─────────────────────────────────────────────────────────────────────────
  // L'unico punto di questo progetto in cui due tocchi comprano una DELEGA CONTINUATA invece di un
  // singolo ordine. Per questo ha un passo di revisione suo, separato da quello del piazzamento a mano:
  // le due conferme autorizzano cose diverse e non devono poter essere confuse l'una con l'altra.
  const [trkMinMove, setTrkMinMove] = useState('');
  const [trkBusy, setTrkBusy] = useState(false);
  const [trkMsg, setTrkMsg] = useState<string | null>(null);
  const [trkActive, setTrkActive] = useState<TrackRecord | null>(null);
  const [trkOffStep, setTrkOffStep] = useState<'idle' | 'choose'>('idle');
  // QUALI LATI QUOTA IL MOTORE. Parte da 'both', che e' quello che il tracking ha sempre fatto: la
  // scelta nuova non deve cambiare da sola il comportamento di chi non la tocca.
  const [trkSides, setTrkSides] = useState<TrkSides>('both');
  // ── LA CHIUSURA AUTOMATICA, PER QUESTO MERCATO ─────────────────────────────────────────────────
  // Il meccanismo sotto era gia' generico — `setAutoClose({scope:'market', marketId})` accetta qualunque
  // conditionId e lo scrive in una mappa durevole. Quello che mancava era un modo di raggiungerlo: l'unico
  // comando in interfaccia stava nel vecchio pannello e agiva sul mercato PINNATO (MAKER_LIVE_MIN_MARKET),
  // uno solo alla volta e cambiabile solo da variabile d'ambiente. Da qui agisce sul mercato che hai
  // aperto, chiunque esso sia.
  const [acBusy, setAcBusy] = useState(false);
  // L'ESITO DEL TOGGLE, che fino al 4 agosto 2026 veniva scritto e mai mostrato: `acCall` metteva qui
  // sia la nota di successo sia il «rifiutato: …», e nessuno leggeva la variabile. Un rifiuto
  // sull'interruttore della chiusura automatica — cioè sulla via d'uscita di una posizione — spariva
  // senza lasciare traccia sullo schermo.
  const [acMsg, setAcMsg] = useState<string | null>(null);
  const [acState, setAcState] = useState<AutoCloseState | null>(null);
  const [leaseErr, setLeaseErr] = useState<string | null>(null);
  const [sizeTouched, setSizeTouched] = useState(false);
  // Orologio a 1s: il countdown sotto i 5 minuti deve muoversi, non sembrare fermo.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const firstFocus = useRef<HTMLButtonElement | null>(null);
  // Quando la quotazione e' ARRIVATA. Senza questo l'etichetta direbbe sempre la stessa eta' fra un
  // poll e l'altro, cioe' esattamente il difetto che stiamo togliendo, solo spostato di un metro.
  const quoteAtMs = useRef<number>(Date.now());
  // Da quando il permesso e' preso. Serve a smettere di dire «mi sto collegando» quando e' evidente che
  // il collegamento non arrivera': un'attesa che non finisce mai e' una bugia lenta.
  const leaseHeldSince = useRef<number | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // PRECOMPILAZIONE. Size = quella del piano se c'è, altrimenti la minima del venue. Prezzo = il mid
  // agganciato al tick. Entrambi editabili; entrambi validati contro le regole del venue, non contro
  // una copia locale di quelle regole.
  // Mercato nuovo ⇒ si riparte SEMPRE dalla prima gamba. Senza questo, aprire un secondo mercato dopo
  // aver piazzato la gamba 1 di 2 lo aprirebbe direttamente sulla gamba 2 — cioè sul libro sbagliato.
  useEffect(() => { setLegIdx(0); }, [target]);

  useEffect(() => {
    // ── LA GAMBA DEL PIANO VINCE SUL MID ──────────────────────────────────────────────────────────
    // Se il piano ha calcolato le gambe, prezzo, size e libro vengono da LÌ: sono i numeri che
    // l'operatore ha appena letto sulla card, e ricavarne altri qui significherebbe piazzare qualcosa
    // di diverso da ciò che è stato approvato.
    //
    // Il ripiego resta il mid agganciato al tick, ed è il ripiego giusto SOLO perché è ciò che si può
    // dire senza un piano: è anche la quotazione più esposta che esista (in cima al libro), quindi si
    // usa quando non c'è di meglio, mai al posto di un prezzo calcolato.
    const leg = active;
    const s = leg ? leg.size
      : (fin(target.presetSize) && (target.presetSize as number) > 0 ? (target.presetSize as number) : target.minSize);
    setSizeStr(fin(s) ? String(+(s as number).toFixed(4)) : '');
    const p = leg ? leg.price
      : (fin(target.mid) && fin(target.tick) && (target.tick as number) > 0
        ? snapToTick(target.mid as number, target.tick as number) : target.mid);
    setPriceStr(fin(p) ? String(p) : '');
    if (leg) setBook(leg.book);
    setResult(null); setEnableMsg(null);
    setIsEnabled(target.enabled);
    // Mercato nuovo, pannello nuovo: le bandierine ripartono da zero, altrimenti un prezzo toccato su
    // un mercato bloccherebbe la precompilazione su quello dopo.
    setPriceTouched(false); setSizeTouched(false);
    setQuote(null); setQuoteErr(null);
    // `legIdx` fra le dipendenze: passare alla seconda gamba deve riempire i campi come farebbe
    // l'apertura di un mercato nuovo, non lasciare i numeri della prima.
  }, [target, legIdx, active]);

  // ── QUANDO IL PIANO HA GIÀ DECISO, SI VA DRITTI ALLA VERIFICA ──────────────────────────────────
  // Se il pannello si apre da una gamba del piano, prezzo, size e lato sono già calcolati e già letti
  // sulla card: far scorrere blocco dati, order book e note prima di poterli confermare non aggiunge
  // niente alla decisione. Si atterra sul riepilogo compatto, con «Modifica» a un tocco.
  //
  // L'EFFETTO STA DOPO LA PRECOMPILAZIONE, e non è un dettaglio: gli effetti girano nell'ordine in cui
  // sono dichiarati e i loro `set` finiscono nello stesso lotto, quindi il riepilogo non può essere
  // disegnato prima che i campi contengano i numeri della gamba. Aprirlo prima avrebbe mostrato un
  // istante di campi vuoti — cioè «N/D» al posto di un prezzo vero.
  //
  // Una volta per mercato: `autoAperto` impedisce che chiudere il popup lo faccia riaprire da solo.
  const autoAperto = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    if (autoAperto.current === target.marketId) return;
    autoAperto.current = target.marketId;
    setSheetEngine('manual');
    setSheetStep('review');
    setSheetOpen(true);
  }, [target.marketId, active]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/maker/manual/config', { cache: 'no-store' });
        if (!r.ok) return;
        const b = (await r.json()) as ManualCfg;
        if (alive) setCfg(b);
      } catch { /* i gate restano ignoti: il pannello lo dice invece di supporli aperti */ }
    })();
    return () => { alive = false; };
  }, []);

  // ── LA SOTTOSCRIZIONE TEMPORANEA AL BOOK ───────────────────────────────────────────────────────
  // agent34 segue il board reward piu' i mercati abilitati a mano. Per tutti gli altri il prezzo migliore
  // che sapevamo dare veniva dalla REST di Gamma, ferma per minuti su un ciclo da cinque. Aprire questo
  // pannello ora CHIEDE al feed di sottoscriversi a questo mercato, e la richiesta e' l'apertura stessa:
  // niente da premere, perche' chiedere un prezzo non e' un'azione che vada confermata.
  //
  // IL RINNOVO NON E' UNA RIDONDANZA, E' IL MECCANISMO. Il permesso scade da solo dopo 20 secondi e
  // questo ciclo lo rinnova ogni 5. Se il browser viene chiuso di colpo, la scheda uccisa dal sistema o
  // la pagina va in crash, nessun rilascio parte mai — e va bene cosi': il permesso muore da solo. Il
  // rilascio esplicito qui sotto libera lo slot subito, ma non e' quello su cui si conta.
  useEffect(() => {
    let alive = true;
    const id = target.marketId;
    const call = async (action: 'acquire' | 'release') => {
      const r = await fetch('/api/maker/live-lease', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId: id, action, by: 'pannello ordine' }),
      });
      return r.json();
    };
    setLease('asking'); setLeaseErr(null); leaseHeldSince.current = null;
    const renew = async () => {
      try {
        const b = await call('acquire');
        if (!alive) return;
        if (b.ok) { if (leaseHeldSince.current == null) leaseHeldSince.current = Date.now(); setLease('held'); setLeaseErr(null); }
        else { setLease('failed'); setLeaseErr(b.error ?? 'permesso rifiutato'); }
      } catch (e) {
        if (alive) { setLease('failed'); setLeaseErr((e as Error).message); }
      }
    };
    renew();
    const t = setInterval(renew, LEASE_RENEW_MS);
    // Chiusura della scheda: `sendBeacon` e' l'unica cosa che il browser garantisce di consegnare mentre
    // la pagina muore. Se non arriva nemmeno quella, ci pensa la scadenza.
    const onHide = () => {
      try {
        navigator.sendBeacon?.('/api/maker/live-lease',
          new Blob([JSON.stringify({ marketId: id, action: 'release' })], { type: 'application/json' }));
      } catch { /* la scadenza e' la rete di sicurezza */ }
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener('pagehide', onHide);
      call('release').catch(() => { /* scade da solo */ });
    };
  }, [target.marketId]);

  // ── LA QUOTAZIONE LIVE ─────────────────────────────────────────────────────────────────────────
  // Alla prima apertura e poi a ritmo, finche il pannello resta aperto. Prima questi numeri erano
  // ereditati dalla card che aveva aperto il pannello: per un mercato del board voleva dire fino a 20
  // secondi di ritardo, per un mercato trovato con la ricerca voleva dire il valore congelato
  // all'istante della ricerca — che non veniva mai ripetuta. Su un ciclo da cinque minuti e' una vita.
  //
  // IL RITMO SEGUE LA FONTE, NON UN NUMERO SCELTO A CASO:
  //   · book live di agent34, mercato che chiude entro 20 minuti → 3s. E' un file locale, il costo e'
  //     una lettura di disco, e su un ciclo breve il prezzo si muove davvero fra un secondo e l'altro.
  //   · book live, scadenza lontana                              → 8s.
  //   · Gamma                                                    → 12s. E' una REST di terzi: la si
  //     interroga con parsimonia, e su un mercato che agent34 non segue nemmeno 3s comprerebbero molto.
  const closeSoon = fin(target.minutesToClose) && (target.minutesToClose as number) < 20;
  // ── IL PREZZO E' LIVE, SI' O NO ────────────────────────────────────────────────────────────────
  // Tre condizioni, tutte necessarie. `source` da solo non basta: il feed scrive nel suo snapshot anche i
  // book fermi, e infatti un mercato scaduto compare come «live-book» con un'eta' di trentasei minuti.
  // Verificato il 2026-08-01 sulla finestra 2:15PM-2:30PM.
  const quoteAgeMs = quote ? (fin(quote.ageMs) ? (quote.ageMs as number) : 0) + Math.max(0, nowMs - quoteAtMs.current) : null;
  // «Mi sto collegando» vale finché il collegamento può ancora arrivare. Passata la finestra, il feed
  // quel mercato non lo copre — cap pieno, token non risolvibili, processo fermo — e continuare a dire
  // che ci si sta collegando sarebbe un'attesa che non finisce mai, cioè una bugia lenta.
  const connecting = lease === 'asking'
    || (lease === 'held' && leaseHeldSince.current != null && nowMs - leaseHeldSince.current < LEASE_CONNECT_GRACE_MS);
  // IL VERDETTO E TUTTE LE SCRITTE VENGONO DA QUI. Una domanda, una risposta: vedi lib/maker/stato-book.
  const stato = statoBook({
    source: quote?.source ?? null,
    live: quote?.live ?? null,
    ageMs: quoteAgeMs,
    freshMaxMs: FRESH_BOOK_MAX_MS,
    lease,
    connecting,
    letto: !!quote,
    erroreLettura: !!quoteErr,
  });
  const bookLive = stato.live;

  // MENTRE LA SOTTOSCRIZIONE SI STA STABILENDO SI GUARDA SPESSO. Il ritmo da 12 secondi e' giusto per
  // Gamma a regime — e' una REST di terzi e non la si martella — ma nei primi secondi dopo l'apertura
  // stiamo aspettando che il feed prenda il mercato, e a 12 secondi il passaggio a «book live» arrivava
  // fino a 15 secondi dopo il tocco. Misurato: 15,4s, quasi tutti spesi ad aspettare il prossimo giro,
  // non il feed. Dentro la finestra di attesa si interroga ogni 2 secondi; appena il book e' live si
  // torna al ritmo normale.
  const settling = !bookLive && connecting;
  const quoteEveryMs = settling ? 2_000 : (quote?.source === 'gamma' ? 12_000 : (closeSoon ? 3_000 : 8_000));

  // IL RITMO STA IN UN REF, NON FRA LE DIPENDENZE DELL'EFFETTO. Il ritmo dipende dalla FONTE, e la
  // fonte si conosce solo dopo la prima risposta: metterlo fra le dipendenze faceva smontare e
  // rimontare il ciclo appena arrivava quella risposta, con una seconda richiesta sparata subito
  // dietro la prima. Misurato: due chiamate a 0,1 secondi di distanza. Cosi' invece il valore nuovo
  // lo legge il prossimo `setTimeout`, e il ciclo non riparte mai da capo.
  const everyRef = useRef(quoteEveryMs);
  everyRef.current = quoteEveryMs;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const r = await fetch(`/api/maker/quote?marketId=${encodeURIComponent(target.marketId)}`, { cache: 'no-store' });
        const b = await r.json();
        if (!alive) return;
        if (b.ok && b.quote) { quoteAtMs.current = Date.now(); setQuote(b.quote as Quote); setQuoteErr(null); }
        else setQuoteErr(b.error ?? 'quotazione non leggibile');
      } catch (e) {
        // Una lettura fallita NON azzera l'ultima buona: si tiene quella e si dice che e' vecchia.
        // Cancellare i numeri a ogni singhiozzo di rete sarebbe peggio del ritardo che stiamo togliendo.
        if (alive) setQuoteErr((e as Error).message);
      } finally {
        if (alive) timer = setTimeout(tick, everyRef.current);
      }
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [target.marketId]);

  // ── I NUMERI CHE IL PANNELLO MOSTRA ────────────────────────────────────────────────────────────
  // La quotazione live vince sul valore della card quando la fonte quel campo lo pubblica davvero. Il
  // tick non lo pubblica il book live (e' una regola di venue, non un dato di mercato): li' resta
  // quello che la card conosce, che viene da una fonte che il tick lo pubblica. Un null della
  // quotazione significa «questa fonte non lo dice», mai «vale zero».
  const pick = <T,>(live: T | null | undefined, card: T | null): T | null =>
    (live === null || live === undefined ? card : live);
  const tick = pick(quote?.tick, target.tick);
  const minSize = pick(quote?.minSize, target.minSize);
  const maxSpreadCents = pick(quote?.maxSpreadCents, target.maxSpreadCents);

  // ── IL BOOK DEL LATO SCELTO ────────────────────────────────────────────────────────────────────
  // Su Polymarket YES e NO sono due CLOB indipendenti, ciascuno con la sua scala. Il pannello disegna
  // quello del lato selezionato, e da lì escono mid, tocco, righe e giudizio sul prezzo. Non c'e' nessuna
  // formula speculare da mantenere allineata: il lato NO e' corretto perche' guarda i propri dati, non
  // perche' qualcuno ha ricordato di invertire un segno. Prima il pannello scriveva «Mid (NO)» accanto al
  // bid/ask del book YES — un terzo modo di mettere in fila numeri che non si riferiscono alla stessa cosa.
  const view: BookSide | null = quote?.books ? quote.books[book] : null;
  // MID, TOCCO E SPREAD VENGONO DALLA STESSA VISTA, O DA NESSUNA. Prima erano tre `pick()` indipendenti:
  // bastava che la quotazione live pubblicasse il mid ma non l'ask perche' il mid fosse di adesso e l'ask
  // dello snapshot della card, cioe' due istanti diversi affiancati senza dirlo. Se la vista live manca si
  // ripiega sulla card in blocco — tutti e tre insieme, mai mescolati.
  const mid = view ? view.mid : (book === 'yes' ? target.mid : (fin(target.mid) ? +(1 - target.mid).toFixed(6) : null));
  const bestBid = view ? view.bestBid : (book === 'yes' ? target.bestBid : null);
  const bestAsk = view ? view.bestAsk : (book === 'yes' ? target.bestAsk : null);
  const spreadCents = view ? view.spreadCents : (book === 'yes' ? target.spreadCents : null);
  // Il mid del VENUE: quello contro cui si misura la banda premiante e su cui il motore piazza. Quando la
  // fonte non lo pubblica (percorso REST) si usa il midpoint mostrato e lo si DICHIARA, invece di far
  // passare una sostituzione per un dato del venue.
  const scoringMid = view && fin(view.scoringMid) ? view.scoringMid : mid;
  const scoringMidIsSubstitute = !!(view && !fin(view.scoringMid) && fin(mid));
  const bandRadiusCents = fin(maxSpreadCents) ? maxSpreadCents / 2 : null;
  // IL MID DEL MOTORE — sempre quello del book YES, qualunque lato si stia guardando. Il tracking quota
  // entrambi i lati a partire da li', e il motore giudica la banda contro il mid di SCORING: l'anteprima
  // deve parlare quella lingua, non quella della vista.
  const engineMid = quote?.books
    ? (fin(quote.books.yes.scoringMid) ? quote.books.yes.scoringMid : quote.books.yes.mid)
    : target.mid;

  // Il prezzo segue il mid SOLO finche l'operatore non lo ha toccato. Dal primo carattere digitato
  // il campo e suo e nessun aggiornamento lo tocca piu.
  useEffect(() => {
    if (priceTouched || !fin(mid)) return;
    const p = fin(tick) && (tick as number) > 0 ? snapToTick(mid as number, tick as number) : mid;
    setPriceStr(fin(p) ? String(p) : '');
  }, [mid, tick, priceTouched]);

  // Cambiando lato si cambia BOOK, non solo etichetta: la riga evidenziata apparteneva all'altra scala e
  // non significa piu' niente qui.
  useEffect(() => { setPickedPrice(null); }, [book]);

  // ── LE RIGHE DEL BOOK, gia' filtrate ───────────────────────────────────────────────────────────
  // Gli ask si disegnano dal piu' ALTO al piu' basso, cosi' il miglior ask sta in fondo alla sezione
  // rossa, appoggiato alla riga del mid; i bid scendono dal miglior bid in giu'. E' la disposizione di
  // un book da exchange: piu' ci si allontana dal centro, piu' si e' lontani dal prezzo.
  //
  // Il cumulato NON viene ricalcolato qui: arriva gia' dal server, contato dal tocco verso l'esterno. Se
  // lo si sommasse di nuovo nell'ordine di disegno, la colonna «totale» degli ask crescerebbe verso
  // l'alto partendo dalla riga piu' lontana — cioe' misurerebbe un'altra cosa da quella dei bid.
  const askRows = useMemo(() => (view ? [...view.levels.asks].reverse() : []), [view]);
  /**
   * IL TOCCO SU UNA RIGA DEL BOOK — l'unico ingresso al percorso operativo.
   *
   * La pagina sotto e' sola lettura: qui si passa dal libro alla configurazione, e tutto il resto
   * avviene nel popup. Le due righe (ask e bid) chiamano questa stessa funzione, quindi non possono
   * comportarsi in modo diverso.
   *
   * IL LATO NON VIENE CAMBIATO, ed e' deliberato: il book mostrato E' quello del lato selezionato
   * (`data-op-book-side`), quindi una riga di questo libro e' gia' un BUY su questo libro. Ribaltarlo
   * sotto il dito che lo sta toccando sarebbe la sorpresa piu' costosa di questa schermata — e il lato
   * resta comunque cambiabile dentro il popup, che e' dove si decide.
   */
  const tapLevel = useCallback((price: number) => {
    setPriceStr(String(price));
    setPriceTouched(true);
    setPickedPrice(price);
    setFlashAt(Date.now());
    if (fin(mid)) {
      setSheetBelow(price <= (mid as number));
      // La distanza si arrotonda al passo dello stepper, cosi' il primo + o − parte da un valore
      // allineato invece che da uno strano.
      setSheetDistC(+(Math.round((Math.abs(price - (mid as number)) * 100) / 0.25) * 0.25).toFixed(2));
    } else {
      setSheetBelow(true); setSheetDistC(null);
    }
    setSheetStep('form');
    setSheetEngine('manual');
    setSheetOpen(true);
  }, [mid]);

  /** Muove la distanza dal mid di un passo, e con essa il prezzo. Lo stepper e' l'unico modo di
   *  cambiarla: un campo libero inviterebbe a scrivere numeri che il tick non puo' esprimere. */
  const stepDist = useCallback((delta: number) => {
    setSheetDistC((cur) => {
      const base = fin(cur) ? (cur as number) : 0;
      const next = +Math.max(0, base + delta).toFixed(2);
      const px = fin(mid) ? +((sheetBelow ? (mid as number) - next / 100 : (mid as number) + next / 100)).toFixed(6) : null;
      if (px != null && px > 0 && px < 1) { setPriceStr(String(px)); setPriceTouched(true); }
      return next;
    });
  }, [mid, sheetBelow]);
  const bidRows = view ? view.levels.bids : [];
  const maxSize = view?.levels.maxSize ?? null;


  // Stessa regola per la size: se la soglia premiante arriva dalla quotazione e l'operatore non ha
  // scritto niente, il campo si allinea; se ha scritto, resta com'e.
  useEffect(() => {
    if (sizeTouched || fin(target.presetSize) || !fin(minSize)) return;
    setSizeStr(String(+(minSize as number).toFixed(4)));
  }, [minSize, sizeTouched, target.presetSize]);

  // Il tracking gia' attivo su questo mercato, se c'e'. Si rilegge a ogni apertura: lo stato vero e'
  // il file del motore, non quello che questa schermata ricorda.
  const loadTracking = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/mm-tracking', { cache: 'no-store' });
      const b = await r.json();
      const mine = (b.markets || []).find((m: TrackRecord) => m.marketId.toLowerCase() === target.marketId.toLowerCase());
      setTrkActive(mine ?? null);
      // Un record senza `sides` e' stato scritto prima che il lato esistesse: vale 'both', esattamente
      // come lo legge il motore. Il pannello non deve mostrarne una versione diversa.
      if (mine) { setTrkMinMove(String(mine.minMoveCents)); setTrkSides(mine.sides ?? 'both'); }
    } catch { /* lo stato resta ignoto: la sezione lo dice invece di supporlo spento */ }
  }, [target.marketId]);
  useEffect(() => {
    setTrkMsg(null); setTrkOffStep('idle');
    setTrkMinMove(''); setTrkActive(null); setTrkSides('both');
    loadTracking();
  }, [target.marketId, loadTracking]);

  // ── LO STATO DELLA CHIUSURA AUTOMATICA DI QUESTO MERCATO ───────────────────────────────────────
  // Si chiede al server PER QUESTO marketId, non si deduce da una configurazione globale: la route
  // risponde per il mercato che le si nomina, ed e' l'unico modo perche' il pannello dica la verita' su
  // un mercato qualsiasi invece che su quello pinnato.
  //
  // Una lettura fallita lascia `null`, che la sezione mostra come «non letto» — mai come «spento». Uno
  // stato che non abbiamo letto non e' uno stato sicuro, ed e' esattamente la confusione che farebbe
  // credere disattivato un automatismo acceso.
  const loadAutoClose = useCallback(async () => {
    try {
      const r = await fetch(`/api/maker/manual/auto-close?marketId=${encodeURIComponent(target.marketId)}`, { cache: 'no-store' });
      const b = (await r.json()) as AutoCloseState;
      setAcState(b && typeof b.readable === 'boolean' ? b : null);
    } catch { setAcState(null); }
  }, [target.marketId]);
  useEffect(() => {
    setAcMsg(null); setAcState(null);
    loadAutoClose();
  }, [target.marketId, loadAutoClose]);

  /** Accende o spegne un interruttore della chiusura automatica. Scrive: e' il secondo dei due passi. */
  const acCall = useCallback(async (scope: 'global' | 'market', enabled: boolean) => {
    setAcBusy(true); setAcMsg(null);
    try {
      const r = await fetch('/api/maker/manual/auto-close', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope, enabled,
          marketId: scope === 'market' ? target.marketId : undefined,
          reason: 'pannello ordine · scelta per mercato',
        }),
      });
      const b = await r.json();
      setAcMsg(b.ok ? String(b.note ?? 'fatto') : `rifiutato: ${b.error ?? 'errore'}`);
      await loadAutoClose();
      return b.ok === true;
    } catch (e) { setAcMsg((e as Error).message); return false; }
    finally { setAcBusy(false); }
  }, [target.marketId, loadAutoClose]);

  // Chiusura con Escape, oltre alla X — il pannello è modale e deve avere una via d'uscita da tastiera.
  // LO SFONDO NON SI MUOVE. Il pannello si apre SOPRA la lista, e alla chiusura la lista deve essere
  // dov era: stessa riga sotto il dito, stesso scorrimento. Bloccare il body non basta da solo, perche
  // `position: fixed` sul body riporta la pagina in cima — quindi lo scorrimento si registra, si
  // congela, e si rimette esattamente com era.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    const y = window.scrollY;
    const b = document.body.style;
    const prev = { position: b.position, top: b.top, width: b.width, overflow: b.overflow };
    b.position = 'fixed'; b.top = `-${y}px`; b.width = '100%'; b.overflow = 'hidden';
    // `preventScroll` perche dare il fuoco a un elemento dentro un contenitore fisso puo comunque
    // trascinare gli antenati: il fuoco serve per la tastiera, non per spostare la pagina.
    firstFocus.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', h);
      b.position = prev.position; b.top = prev.top; b.width = prev.width; b.overflow = prev.overflow;
      window.scrollTo(0, y);
    };
  }, [onClose]);

  // UN CAMPO VUOTO NON È UNO ZERO. `Number('')` fa 0: il gate lo fermava lo stesso (`size <= 0`), ma il
  // riepilogo avrebbe scritto «0 share» e «$0.00», che si leggono come valori. `NaN` non è un valore, e
  // ogni `fin(...)` a valle lo tratta già come assente — il comportamento dei gate non cambia.
  const size = numeroDigitato(sizeStr) ?? NaN;
  const price = numeroDigitato(priceStr) ?? NaN;
  const notional = fin(size) && fin(price) && size > 0 && price > 0 ? size * price : null;

  /**
   * IL VERDETTO SUL PREZZO, ricalcolato a ogni modifica — sia da tocco sul book sia da digitazione.
   *
   * ROSSO quando l'ordine non farebbe quello che sembra: a un prezzo che raggiunge il miglior ask
   * l'ordine si esegue subito contro chi vende, quindi e' taker e non resta a riposo. E' l'errore reale
   * gia' incontrato in produzione — «invalid post-only order: order crosses book» — ma detto PRIMA di
   * premere invece che dopo. Rosso anche fuori dalla banda premiante, dove l'ordine resta sul book ma
   * non matura nulla.
   *
   * VALE PER TUTTI E DUE I LATI SENZA CASI SPECIALI: `bestAsk` e' quello del book CHE SI STA GUARDANDO,
   * quindi «BUY NO a q incrocia l'ask del book NO» e' la stessa frase, applicata ai suoi dati.
   */
  const verdict = useMemo(() => {
    if (!fin(price) || price <= 0 || price >= 1) return null;
    return priceVerdict({
      price, bestBid, bestAsk, scoringMid, bandRadiusCents,
      // Questo percorso non vende mai: «BUY NO» e' un ACQUISTO sul book NO, non una vendita di YES.
      side: 'BUY',
    });
  }, [price, bestBid, bestAsk, scoringMid, bandRadiusCents]);

  // ── LA DISTANZA CHE CONTA È QUELLA DAL MID DI SCORING ──────────────────────────────────────────
  // È il numero contro cui il venue giudica la banda, quindi è l'unico che rende «distanza» e «in
  // banda» due letture dello stesso fatto invece che due numeri accostati.
  // E si calcola dal PREZZO, non dallo stepper: `sheetDistC` esiste solo se si è toccata una riga del
  // book, quindi su una gamba che arriva dal piano sarebbe rimasto null — e il riepilogo avrebbe
  // scritto «N/D» proprio nel percorso in cui il numero è noto con certezza.
  const distDaScoring = distanceCents(price, scoringMid);

  // ── IL RIEPILOGO COMPATTO ──────────────────────────────────────────────────────────────────────
  // Le righe non si costruiscono qui: le costruisce `riepilogoOrdine`, che un test esercita. Qui si
  // passano solo i valori veri — quelli che verrebbero inviati, non una loro copia.
  const riepilogo = useMemo(() => riepilogoOrdine({
    title: target.title, marketId: target.marketId, book,
    price, size, distanceCents: distDaScoring, bandRadiusCents, verdict,
    legIdx, legsTotal: legs ? legs.length : null,
    fonte: active ? 'piano' : 'digitato',
  }), [target.title, target.marketId, book, price, size, distDaScoring, bandRadiusCents, verdict, legIdx, legs, active]);

  // Minuti alla chiusura, ricalcolati sull'orologio locale: il valore arrivato con la card invecchia
  // mentre il pannello resta aperto, e un countdown fermo su un mercato da 5 minuti è peggio di nessun
  // countdown. Con l'orario di chiusura si conta da quello; senza, si conta dal minuto letto
  // all'apertura — stessa lettura, invecchiata onestamente, non una precisione inventata.
  const openedAt = useRef<number>(Date.now());
  useEffect(() => { openedAt.current = Date.now(); }, [target]);
  const minsLeft = useMemo(() => {
    if (target.endDate) {
      const t = Date.parse(target.endDate);
      if (Number.isFinite(t)) return (t - nowMs) / 60_000;
    }
    if (fin(target.minutesToClose)) return (target.minutesToClose as number) - (nowMs - openedAt.current) / 60_000;
    return null;
  }, [target.endDate, target.minutesToClose, nowMs]);

  const ttlSeconds = cfg?.autoReprice?.expiry?.ttlSeconds ?? 1380;
  const refreshMargin = cfg?.autoReprice?.expiry?.refreshMarginSeconds ?? 180;
  const repriceOn = !!(cfg?.autoReprice?.globalEnabled
    && (cfg?.autoReprice?.optedInMarketIds ?? []).map((x) => x.toLowerCase()).includes(target.marketId.toLowerCase()));

  // ── LE VALIDAZIONI, contro le regole del venue di QUESTO mercato ────────────────────────────────

  const problems = useMemo(() => {
    const out: Array<{ key: string; text: string; blocking: boolean }> = [];
    if (!fin(size) || size <= 0) out.push({ key: 'size', text: 'Inserisci una size.', blocking: true });
    else if (fin(minSize) && size < (minSize as number)) {
      // PRECISIONE SUL PERCHÉ. Questa soglia è min_incentive_size, non un minimo d'ordine: un ordine più
      // piccolo il CLOB lo accetta eccome. Semplicemente il programma premi non lo vede, quindi matura
      // zero. Dirlo come «viene rifiutato» sarebbe falso, e la conseguenza vera è peggiore: un ordine
      // che resta lì a occupare capitale senza produrre nulla.
      out.push({ key: 'minsize', text: `Sotto min_incentive_size (${minSize} share): il CLOB lo accetta, ma il programma premi non lo vede e matura ZERO.`, blocking: true });
    }
    if (!fin(price) || price <= 0 || price >= 1) out.push({ key: 'price', text: 'Il prezzo deve stare fra 0 e 1.', blocking: true });
    else if (fin(tick) && (tick as number) > 0 && !onTick(price, tick as number)) {
      out.push({ key: 'tick', text: `Fuori griglia: il tick è ${tick}. Il prezzo valido più vicino è ${snapToTick(price, tick as number)}.`, blocking: true });
    }
    const cap = cfg?.caps?.effectiveOrderCapUsd ?? null;
    if (fin(notional) && fin(cap) && (notional as number) > (cap as number) + 1e-9) {
      out.push({ key: 'cap', text: `Controvalore ${money(notional)} oltre il tetto per ordine ${money(cap)}.`, blocking: true });
    }
    if (fin(notional) && fin(balanceUsd) && (notional as number) > (balanceUsd as number) + 1e-9) {
      out.push({ key: 'balance', text: `Saldo insufficiente: servono ${money(notional)}, disponibili ${money(balanceUsd)}.`, blocking: true });
    }
    if (cfg && (cfg.kill.killed || cfg.kill.readable === false)) {
      out.push({ key: 'kill', text: cfg.kill.readable === false ? 'Kill-switch non leggibile — trattato come attivo.' : 'Kill-switch ATTIVO: nessun ordine può essere piazzato.', blocking: true });
    }
    if (!isEnabled) out.push({ key: 'enable', text: 'Mercato non abilitato: il gate live-min rifiuterebbe. Abilitalo qui sopra.', blocking: true });
    // ── IL PREZZO DEV'ESSERE VIVO PER POTER CONFERMARE ──────────────────────────────────────────
    // Questo pannello promette un prezzo live: chiede al feed una sottoscrizione temporanea al book e la
    // tiene finche' resta aperto. Se quella promessa non regge — la sottoscrizione non si e' stabilita, e'
    // caduta, il feed e' fermo, o il mercato e' fuori dal budget del feed — la schermata continuerebbe a
    // mostrare l'ultimo numero buono, e confermare vorrebbe dire piazzare su un prezzo vecchio credendolo
    // attuale. Quindi BLOCCA. Non e' un avviso: un avviso lo si legge dopo aver gia' premuto.
    //
    // Lo stesso controllo viene rifatto dal server prima di inviare (gate `stale-book`), perche' fra il
    // momento in cui questa schermata dice «si puo'» e il momento in cui l'ordine parte c'e' del tempo, e
    // la sottoscrizione puo' cadere proprio li' in mezzo.
    if (!bookLive) {
      const why = lease === 'asking'
        ? 'sottoscrizione al book live in corso — attendi qualche secondo.'
        : lease === 'failed'
          ? `sottoscrizione al book live NON riuscita${leaseErr ? ` (${leaseErr})` : ''}: il prezzo mostrato viene da Gamma e puo' essere vecchio di minuti.`
          : quote?.source === 'gamma'
            ? 'il prezzo viene da Gamma, non dal book live: il feed non e\' ancora sottoscritto a questo mercato.'
            : fin(quoteAgeMs) && (quoteAgeMs as number) > FRESH_BOOK_MAX_MS
              ? `il book live per questo mercato e' fermo da ${Math.round((quoteAgeMs as number) / 1000)}s: la sottoscrizione sembra caduta.`
              : 'il book live non e\' ancora arrivato.';
      out.push({
        key: 'not-live',
        text: `Non si conferma su un prezzo non live — ${why}`,
        blocking: true,
      });
    }
    if (fin(minsLeft) && (minsLeft as number) < 3) {
      out.push({ key: 'expiry', text: `Scade fra ${closeTxt(minsLeft)}: sotto i 3 minuti il venue non riesce a esprimere la durata di un ordine — potrebbe non arrivare a tempo.`, blocking: false });
    }
    return out;
  }, [size, price, notional, tick, minSize, cfg, balanceUsd, isEnabled, minsLeft, bookLive, lease, leaseErr, quote?.source, quoteAgeMs]);

  const blocking = problems.filter((p) => p.blocking);
  const canReview = blocking.length === 0;

  // ── TUTTI I MOTIVI PER CUI NON SI PUÒ INVIARE, IN UN ELENCO SOLO ────────────────────────────────
  // `canReview` copre i gate del pannello; `busy`, `trkBusy` e il riepilogo incompleto no, ed erano
  // condizioni che spegnevano il pulsante da fuori quella lista. Qui rientrano tutte, e la schermata
  // di conferma le mostra: nessuna può più spegnere in silenzio.
  const blocco = useMemo(() => motiviBlocco({
    problemiBloccanti: blocking,
    busy, trkBusy,
    riepilogoCompleto: riepilogo.completo,
    mancanti: riepilogo.mancanti,
  }), [blocking, busy, trkBusy, riepilogo.completo, riepilogo.mancanti]);

  const enableNow = useCallback(async () => {
    setEnabling(true); setEnableMsg(null);
    try {
      const r = await fetch('/api/maker/markets/enable', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId: target.marketId, preview: false, enabled: true, takeManual: true, reason: 'abilitato dal pannello ordine' }),
      });
      const b = await r.json();
      if (b.ok) { setIsEnabled(true); setEnableMsg('Abilitato e preso in gestione manuale.'); onEnabled?.(target.marketId); }
      else setEnableMsg(`Rifiutato: ${b.error ?? b.gate ?? 'errore'}`);
    } catch (e) { setEnableMsg((e as Error).message); }
    finally { setEnabling(false); }
  }, [target.marketId, onEnabled]);

  /** Chiama la route del tracking. `preview:true` non scrive niente — e' il primo dei due passi. */
  const trkCall = useCallback(async (payload: Record<string, unknown>) => {
    setTrkBusy(true); setTrkMsg(null);
    try {
      const r = await fetch('/api/maker/mm-tracking', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId: target.marketId, ...payload }),
      });
      return (await r.json()) as TrackPreview & { note?: string; record?: TrackRecord };
    } catch (e) { return { ok: false, error: (e as Error).message } as TrackPreview; }
    finally { setTrkBusy(false); }
  }, [target.marketId]);

  // ── L'UNICO PUNTO CHE SCRIVE ───────────────────────────────────────────────────────────────────
  const place = useCallback(async () => {
    setBusy(true); setResult(null);
    try {
      const r = await fetch('/api/maker/manual/order', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketId: target.marketId, book, price, size,
          // 0 ⇒ GTC. Con il rinnovo disattivato si chiede la finestra fissa; altrimenti si lascia
          // decidere al server dallo switch per-mercato, che è la fonte di verità.
          ...(autoRenew ? {} : { ttlSeconds }),
          // LA PROMESSA, DICHIARATA AL SERVER. Questa schermata ha mostrato un prezzo live; il gate
          // `stale-book` verifica che lo sia ancora nell'istante in cui l'ordine parte, e rifiuta invece
          // di piazzare su un dato stantio se nel frattempo la sottoscrizione e' caduta.
          requireFreshBookMs: FRESH_BOOK_MAX_MS,
          // ── «MAI PRIMO SUL LIBRO», ANCHE DI QUI ──────────────────────────────────────────────
          // Il piano la porta su ogni riga, l'uscita automatica e il rimpiazzo pure; il percorso a
          // mano era il quarto e non l'aveva — e fino al 4 agosto 2026 non avrebbe potuto averla
          // comunque, perché lo schema zod della route scartava il campo senza dirlo.
          // Essere primi sul libro significa essere il bersaglio di chi sa qualcosa che noi non
          // sappiamo: è la stessa adverse selection che il resto del sistema evita per costruzione.
          // Se il prezzo viene spostato, l'esito lo dice — vedi `priceAdjusted` nel banner.
          inCoda: true,
          // FUORI BANDA È UN COSTO DICHIARATO, NON UN DIVIETO. Questa schermata mostra l'avviso giallo
          // «non matura reward» sopra il campo del prezzo, e chi conferma l'ha letto: due tocchi separati
          // stanno fra quell'avviso e l'invio. Il server declassa quindi il solo codice OUT_OF_BAND da
          // rifiuto ad annotazione. Il tick NON è coperto da questa dichiarazione e resta un blocco: un
          // prezzo fuori griglia lo rifiuterebbe l'exchange, non noi.
          acknowledgeOutOfBand: true,
          // LA DISTANZA CON CUI L'ORDINE E' STATO COMPOSTO. Il server la usa per ricalcolare il prezzo
          // sul mid VIVO al momento dell'invio: un ordine composto qualche secondo fa non deve poter
          // diventare un taker solo perche' il mid si e' mosso mentre lo si guardava.
          ...(fin(sheetDistC) ? { distanceCents: sheetDistC as number, belowMid: sheetBelow } : {}),
          note: 'pannello ordine',
        }),
      });
      const esito = (await r.json()) as PlaceResult;
      setResult(esito);
      // Il segnale verso chi sta tenendo una coda. Solo su esito positivo, e con i numeri VERI di
      // cio' che e' partito — non con quelli che il modulo mostrava un attimo prima.
      if (esito.ok && typeof onPlaced === 'function') {
        onPlaced({
          marketId: target.marketId, book, price, size,
          sent: esito.sent === true,
          legIdx, legTotal: legs ? legs.length : 1,
        });
      }
    } catch (e) {
      setResult({ ok: false, sent: false, gate: 'request-failed', reason: (e as Error).message });
    } finally { setBusy(false); }
  }, [target.marketId, book, price, size, autoRenew, ttlSeconds, onPlaced, legIdx, legs]);

  const sends = cfg?.placement?.sends === true;

  // ── I DUE COMANDI DEL FOGLIO, e i numeri che ne derivano ───────────────────────────────────────

  /** Il prezzo che corrisponde a una distanza dal mid, sullo stesso lato della riga toccata. */
  const priceFromDist = useCallback((d: number | null): number | null => {
    if (!fin(d) || !fin(mid)) return null;
    return +((sheetBelow ? (mid as number) - (d as number) / 100 : (mid as number) + (d as number) / 100)).toFixed(6);
  }, [mid, sheetBelow]);

  /**
   * QUANTE SHARE VALE UNA PERCENTUALE.
   *   0%   = la size minima premiante del venue. Sotto quella il CLOB accetta l'ordine ma il programma
   *          premi non lo vede, quindi non e' un minimo tecnico: e' il minimo che ha senso.
   *   100% = quante se ne comprano col capitale disponibile a QUESTO prezzo.
   *
   * `null` quando manca un ingrediente, e il foglio lo dice invece di mostrare uno zero: una size
   * inventata su un saldo non letto e' esattamente il numero che non deve arrivare al venue.
   */
  const sizeRange = useMemo(
    () => sizeScale({ minSize, price, capitalUsd: balanceUsd, orderCapUsd: cfg?.caps?.effectiveOrderCapUsd ?? null }),
    [minSize, price, balanceUsd, cfg?.caps?.effectiveOrderCapUsd],
  );
  const sizeFromPct = useCallback((pct: number) => sizeAtPct(sizeRange, pct), [sizeRange]);

  /** La percentuale che corrisponde alla size attuale — cosi' il cursore parte da dove si e' gia'. */
  const sizePct = useMemo(() => {
    if (!sizeRange.readable || sizeRange.lo == null || sizeRange.hi == null || !fin(size)) return 0;
    if (sizeRange.hi <= sizeRange.lo) return 0;
    return Math.min(100, Math.max(0, Math.round((((size as number) - sizeRange.lo) / (sizeRange.hi - sizeRange.lo)) * 100)));
  }, [sizeRange, size]);

  const orderCapUsd = cfg?.caps?.effectiveOrderCapUsd ?? null;
  const overCap = fin(notional) && fin(orderCapUsd) && (notional as number) > (orderCapUsd as number) + 1e-9;


  // L'ETÀ DEL PREZZO, DALLA STESSA FONTE DEL VERDETTO. Questa riga era il difetto: costruiva l'etichetta
  // da `quote.source` e basta, cioè chiamava «live» la PROVENIENZA del numero. Ma «viene dal feed di
  // agent34» e «è fresco» sono due fatti diversi — il feed pubblica anche i book fermi — e con un dato
  // di due minuti la testata diceva «book non live» mentre qui compariva «book live · 2 min fa».
  // Adesso è la stessa `statoBook` che decide il badge: se il verdetto è no, questa scritta nomina la
  // fonte e dice da quanto è ferma, e la parola «live» non può comparire.
  const quoteAge = stato.freschezza;

  return (
    <div className="op-scrim exch" data-order-panel={target.marketId} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <style>{CSS}</style>
      <div className="op-sheet" role="dialog" aria-modal="true" aria-label={`Piazza ordine su ${target.title}`}>

        {/* ── 1 · INTESTAZIONE ─────────────────────────────────────────────────────────────────── */}
        <div className="op-head">
          <div className="op-head-txt">
            <div className="op-title" data-op-title>{target.title}</div>
            <div className="op-sub">
              <span className="ex-n" data-op-close-at>
                {target.endDate ? new Date(target.endDate).toLocaleTimeString() : 'orario ignoto'}
              </span>
              {' · '}
              <span className={`ex-badge ${fin(minsLeft) && (minsLeft as number) < 3 ? 'is-bad' : fin(minsLeft) && (minsLeft as number) < 60 ? 'is-warn' : ''}`} data-op-countdown>
                {closeTxt(minsLeft)}
              </span>
              {' '}
              <span className={`ex-badge ${isEnabled ? 'is-gold' : ''}`} data-op-enabled={isEnabled ? '1' : '0'}>
                {isEnabled ? 'abilitato' : 'non abilitato'}
              </span>
              {' '}
              <span className={`ex-badge is-${stato.tono}`}
                data-op-booklive={bookLive ? '1' : '0'} data-op-lease={lease}
                title={`${stato.motivo}${quote?.sourceNote ? ` — ${quote.sourceNote}` : ''}`}>
                {stato.badge}
              </span>
              {!target.hasRewards && <span className="ex-badge is-warn op-bdg">NESSUN REWARD — solo trading direzionale</span>}
            </div>
            <div className="op-id ex-n">{target.marketId}</div>
          </div>
          <button ref={firstFocus} className="op-x" onClick={onClose} aria-label="Chiudi" data-op-close>✕</button>
        </div>

        <div className="op-body">
          {/* abilitazione al volo, senza uscire dal pannello */}
          {!isEnabled && (
            <div className="ex-banner is-warn op-mb">
              Questo mercato non è nel catalogo abilitato: il gate live-min rifiuterebbe l&apos;ordine.
              <button className="ex-btn is-sm op-inline" onClick={enableNow} disabled={enabling} data-op-enable>
                {enabling ? 'Abilito…' : 'Abilita ora'}
              </button>
            </div>
          )}
          {enableMsg && <div className="ex-banner op-mb" data-op-enable-msg>{enableMsg}</div>}

          {/* ── 2 · DATI DI MERCATO ───────────────────────────────────────────────────────────────
              I sette numeri che descrivono il mercato adesso, in una griglia compatta. Sta PRIMA del
              book perche' e' il contesto che si legge una volta, mentre il book e' la superficie su cui
              si agisce; e sta in una griglia e non in card separate perche' sono lo stesso fatto letto
              da sette angoli, non sette fatti.

              I valori sono gli stessi che alimentano il book qui sotto — stessa `view`, stessa fonte,
              stesso istante. Non c'e' una seconda lettura che possa divergere. */}
          <div className="op-eyebrow" data-op-eyebrow="market">Dati di mercato</div>
          <div className="op-mkt op-mb" data-op-market-data>
            <div className="op-mkt-c">
              <span className="op-mkt-k">mid</span>
              <span className="op-mkt-v" data-op-mid-stat>{cents(mid)}</span>
              {/* QUANTO E VECCHIO QUESTO PREZZO fa parte del prezzo: un mid di 9 millisecondi e un mid
                  di due minuti non sono lo stesso fatto, e su un ciclo da cinque minuti la differenza
                  decide l ordine. Sta scritto qui invece di chiedere all operatore di fidarsi. */}
              <span className={`op-mkt-s is-${stato.tono}`} data-op-freshness
                title={quote?.depthSourceNote ?? quote?.sourceNote ?? 'in attesa della prima quotazione'}>
                {quoteAge}
              </span>
            </div>
            <div className="op-mkt-c"><span className="op-mkt-k">bid</span><span className="op-mkt-v ex-up" data-op-bid>{cents(bestBid)}</span></div>
            <div className="op-mkt-c"><span className="op-mkt-k">ask</span><span className="op-mkt-v ex-dn" data-op-ask>{cents(bestAsk)}</span></div>
            <div className="op-mkt-c"><span className="op-mkt-k">spread</span><span className="op-mkt-v" data-op-spread-stat>{fin(spreadCents) ? `${spreadCents.toFixed(1)}¢` : 'N/D'}</span></div>
            <div className="op-mkt-c"><span className="op-mkt-k">tick</span><span className="op-mkt-v" data-op-tick>{tick ?? 'N/D'}</span></div>
            <div className="op-mkt-c"><span className="op-mkt-k">size min</span><span className="op-mkt-v" data-op-minsize>{minSize ?? 'N/D'}</span></div>
            <div className="op-mkt-c">
              <span className="op-mkt-k">banda</span>
              <span className="op-mkt-v" data-op-band>{fin(maxSpreadCents) ? `±${(maxSpreadCents / 2).toFixed(2)}¢` : 'N/D'}</span>
              {fin(target.rewardsDailyRate) && <span className="op-mkt-s">{money(target.rewardsDailyRate, 0)}/g</span>}
            </div>
            {/* IL SALDO fra i dati di mercato, non altrove: e' il numero che decide quanto si puo'
                comprare, e leggerlo accanto al prezzo evita di aprire il popup per scoprire che non
                basta. `N/D` quando non e' stato letto — mai uno zero, che sarebbe un saldo vuoto. */}
            <div className="op-mkt-c">
              <span className="op-mkt-k">saldo</span>
              <span className="op-mkt-v" data-op-balance>{fin(balanceUsd) ? money(balanceUsd) : 'N/D'}</span>
              {fin(orderCapUsd) && <span className="op-mkt-s">tetto {money(orderCapUsd)}</span>}
            </div>
          </div>

          {/* ── 2b · LA STRADA CORTA VERSO LA CONFERMA ────────────────────────────────────────────
              PRIMA QUESTO PULSANTE NON ESISTEVA. L'unico modo di aprire il popup era toccare una riga
              dell'order book: per arrivarci bisognava scorrere il blocco dati, il book intero e due
              note, e con due gambe si ripeteva. Un percorso lungo non rende la decisione più
              consapevole — sposta solo l'attenzione altrove prima del punto in cui serve.

              Il tocco di conferma non si tocca: questo pulsante APRE la verifica, non invia niente.
              Da lì «Conferma e piazza» resta l'unico punto che scrive, con i suoi gate. */}
          <button className="ex-btn is-gold op-goreview" data-op-goreview
            onClick={() => { setSheetEngine('manual'); setSheetStep('review'); setSheetOpen(true); }}>
            Verifica e conferma →
          </button>

          {/* ── 3 · ORDER BOOK, PIEGATO ───────────────────────────────────────────────────────────
              Resta intero e resta toccabile: cambia solo che non sta più fra chi decide e la
              decisione. Chi vuole scegliere il prezzo dal libro lo apre; chi arriva dal piano con
              prezzo e size già calcolati non ha motivo di scorrerlo. */}
          <button className="op-more" onClick={() => setBookAperto((v) => !v)}
            data-op-book-toggle aria-expanded={bookAperto}>
            {bookAperto ? '▾ Nascondi order book' : '▸ Mostra order book completo'}
          </button>

          {bookAperto && (<>
          <div className="op-eyebrow" data-op-eyebrow="book">
            Order book
            <span className="op-eyebrow-r">{book.toUpperCase()}</span>
          </div>

          {/* ── IL BOOK, VERTICALE, STILE EXCHANGE ────────────────────────────────────────────────
              Ask in alto (rossi, dal piu' alto al piu' basso), la riga del mid al centro, bid sotto
              (verdi, dal piu' vicino al mid in giu'). Ogni riga porta prezzo, size a quel livello e
              cumulato; la barra di sfondo e' proporzionale alla size, cosi' dove c'e' liquidita' si vede
              senza leggere i numeri.

              TOCCARE UNA RIGA COMPILA IL PREZZO — QUALSIASI RIGA. Qui c'era un cursore «distanza minima
              dal mid» che rendeva inerti le righe piu' vicine al mid, per impedire un tocco distratto
              su un livello a forte rischio di fill. E' stato tolto: sceglieva al posto dell'operatore su
              una schermata che chiede comunque due tocchi espliciti prima di mandare qualcosa, e la
              conseguenza pratica era che i livelli attaccati al mid — quelli che maturano di piu' —
              erano gli unici non selezionabili. La distanza dal mid resta scritta sul title di ogni
              riga, che informa senza decidere. */}
          <div className={`op-book op-mb ${flashing ? 'is-flash' : ''}`} data-op-book data-op-book-side={book}
            data-op-flash={flashing ? '1' : '0'}>
            <div className="op-book-top">
              <span className="op-book-t">Order book · <b className="ex-n">{book.toUpperCase()}</b></span>
              {/* QUANTO E VECCHIO QUESTO PREZZO fa parte del prezzo: un mid di 9 millisecondi e un mid
                  di due minuti non sono lo stesso fatto, e su un ciclo da cinque minuti la differenza
                  decide l ordine. Sta scritto qui invece di chiedere all operatore di fidarsi. */}
              <span className={`ex-badge is-${stato.tono}`} data-op-freshness
                title={quote?.depthSourceNote ?? quote?.sourceNote ?? 'in attesa della prima quotazione'}>
                {quoteAge}
              </span>
            </div>

            <div className="op-book-hd" aria-hidden="true">
              <span>prezzo</span><span>size</span><span>totale</span>
            </div>

            {/* ── ASK ── il miglior ask e' l'ULTIMA riga di questo blocco, appoggiata al mid. */}
            <div className="op-book-side" data-op-asks>
              {askRows.length === 0 && <div className="op-book-empty" data-op-asks-empty>nessun ask sul book</div>}
              {askRows.map((l) => {
                const d = distanceCents(l.price, mid);
                return (
                  <button key={`a${l.price}`} type="button"
                    className={`op-row is-ask ${pickedPrice === l.price ? 'is-picked' : ''}`}
                    data-op-level="ask" data-op-level-price={l.price}
                    data-op-level-dist={d ?? ''}
                    title={`usa ${cents(l.price)} (${d?.toFixed(2)}¢ dal mid)`}
                    onClick={() => tapLevel(l.price)}>
                    <span className="op-row-bar is-ask" style={{ width: maxSize ? `${Math.max(2, (l.size / maxSize) * 100)}%` : '0%' }} aria-hidden="true" />
                    <span className="op-row-p ex-dn">{cents(l.price)}</span>
                    <span className="op-row-s">{fmtSize(l.size)}</span>
                    <span className="op-row-c">{fmtSize(l.total)}</span>
                  </button>
                );
              })}
            </div>

            {/* ── LA RIGA DEL MID ── il midpoint del tocco qui sopra e qui sotto. Stessa fonte, stesso
                istante, sempre fra i due: non e' un numero che arriva da un'altra parte. */}
            <div className="op-book-mid" data-op-book-mid>
              <span className="op-book-mid-v" data-op-mid>{cents(mid)}</span>
              <span className="op-book-mid-k">
                {view?.midKind === 'midpoint' ? 'mid · midpoint del book'
                  : view?.midKind === 'one-sided-bid' ? 'miglior bid — il book non ha ask'
                    : view?.midKind === 'one-sided-ask' ? 'miglior ask — il book non ha bid'
                      : 'mid non disponibile'}
              </span>
              <span className="op-book-mid-s" data-op-spread>
                spread {fin(spreadCents) ? `${spreadCents.toFixed(1)}¢` : 'N/D'}
              </span>
            </div>

            {/* ── BID ── il miglior bid e' la PRIMA riga, appoggiata al mid. */}
            <div className="op-book-side" data-op-bids>
              {bidRows.length === 0 && <div className="op-book-empty" data-op-bids-empty>nessun bid sul book</div>}
              {bidRows.map((l) => {
                const d = distanceCents(l.price, mid);
                return (
                  <button key={`b${l.price}`} type="button"
                    className={`op-row is-bid ${pickedPrice === l.price ? 'is-picked' : ''}`}
                    data-op-level="bid" data-op-level-price={l.price}
                    data-op-level-dist={d ?? ''}
                    title={`usa ${cents(l.price)} (${d?.toFixed(2)}¢ dal mid)`}
                    onClick={() => tapLevel(l.price)}>
                    <span className="op-row-bar is-bid" style={{ width: maxSize ? `${Math.max(2, (l.size / maxSize) * 100)}%` : '0%' }} aria-hidden="true" />
                    <span className="op-row-p ex-up">{cents(l.price)}</span>
                    <span className="op-row-s">{fmtSize(l.size)}</span>
                    <span className="op-row-c">{fmtSize(l.total)}</span>
                  </button>
                );
              })}
            </div>

            {/* ── SOTTO IL BOOK ── spread, tick, banda, e QUANTI LIVELLI ESISTONO DAVVERO. Un book di
                tre righe su un mercato che ne ha tre e' un book sottile; su uno che ne ha quaranta e'
                una vista troncata. Non sono la stessa cosa e qui si distinguono. */}
            <div className="op-book-foot" data-op-book-foot>
              <span>spread <b className="ex-n">{fin(spreadCents) ? `${spreadCents.toFixed(1)}¢` : 'N/D'}</b></span>
              <span>tick <b className="ex-n">{tick ?? 'N/D'}</b></span>
              <span>banda <b className="ex-n">{fin(maxSpreadCents) ? `±${(maxSpreadCents / 2).toFixed(2)}¢` : 'N/D'}</b></span>
              <span>size min <b className="ex-n">{minSize ?? 'N/D'}</b></span>
              {fin(target.rewardsDailyRate) && <span>reward/g <b className="ex-n ex-up">{money(target.rewardsDailyRate, 0)}</b></span>}
              {view && (
                <span data-op-book-levels
                  data-op-bid-count={view.levels.bidCount} data-op-ask-count={view.levels.askCount}>
                  livelli reali <b className="ex-n">{view.levels.bidCount} bid · {view.levels.askCount} ask</b>
                  {view.levels.truncated
                    ? ` (mostrati i primi ${view.levels.requested} per lato)`
                    : ''}
                </span>
              )}
              {quote?.depthSource && (
                <span data-op-depth-source={quote.depthSource} title={quote.depthSourceNote}>
                  profondità <b className="ex-n">{quote.depthSource === 'live-book' ? 'book live agent34' : 'REST CLOB'}</b>
                </span>
              )}
            </div>
          </div>

          {/* ── COME SI USA ── il book e' toccabile, e non e' ovvio da guardare: una riga sembra una
              riga di tabella finche' qualcuno non dice che e' un comando. */}
          <p className="op-booknote op-mb" data-op-book-note>
            Tocca una riga per portarne il prezzo nel campo <b>Prezzo</b> del piazzamento manuale, in
            fondo. Le righe oscurate sono escluse dal filtro qui sopra e non rispondono al tocco.
          </p>

          {/* ── LA NOTA SUL MID ── quando il mid del VENUE non coincide col midpoint del book, lo si
              dice. E' esattamente il caso che produceva «MID 20.0¢ · BID 21.0¢ · ASK 22.0¢»: adesso i
              tre numeri sono coerenti e la differenza col mid di scoring e' scritta, non nascosta. */}
          {view && view.midNotes.length > 0 && (
            <div className="op-midnote op-mb" data-op-mid-note
              data-op-mid-outside={view.scoringMidOutsideTouch ? '1' : '0'}>
              {view.midNotes.map((n, i) => (
                <p key={i} className="ex-flag is-dim op-midnote-p"><span className="ex-flag-i" aria-hidden="true">ⓘ</span><span>{n}</span></p>
              ))}
            </div>
          )}
          {view?.scoringMidNote && (
            <p className="ex-flag is-dim op-mb" data-op-scoringmid-note>
              <span className="ex-flag-i" aria-hidden="true">ⓘ</span><span>{view.scoringMidNote}</span>
            </p>
          )}
          {scoringMidIsSubstitute && fin(maxSpreadCents) && (
            <p className="ex-flag is-dim op-mb" data-op-band-substitute>
              <span className="ex-flag-i" aria-hidden="true">ⓘ</span>
              <span>La banda qui sotto è misurata contro il midpoint del book, non contro il mid di scoring del venue: questa fonte non lo pubblica.</span>
            </p>
          )}
          </>)}

          {quoteErr && (
            <p className="ex-flag is-dim op-mb" data-op-quote-error>
              <span className="ex-flag-i" aria-hidden="true">ⓘ</span>
              <span>ultimo aggiornamento non riuscito ({quoteErr}) — i numeri qui sopra restano l&apos;ultima lettura buona, non sono stati azzerati</span>
            </p>
          )}

        </div>


        {/* ══ IL POPUP — L'UNICO PERCORSO OPERATIVO ══════════════════════════════════════════════
            La pagina sotto e' diventata sola lettura: stato, dati di mercato, book. Ogni decisione —
            lato, size, prezzo, motore, chiusura automatica — si prende qui dentro.

            PERCHE' UNO SOLO. Prima gli stessi controlli esistevano due volte: nei pannelli lunghi e
            qui. Due copie della stessa scelta sono due posti dove leggere uno stato diverso, e la
            domanda «ma allora quale vale?» non ha una buona risposta. Ora la risposta e' una.

            NON HA UNO STATO SUO. Lato, prezzo, size, offset, soglia, lati quotati e chiusura
            automatica sono lo STESSO stato di prima, e la conferma chiama le STESSE funzioni —
            `place()` per l'ordine singolo, `trkCall()` per il motore. Nessun secondo percorso verso
            il venue: stessi gate, stesso audit.

            INTESTAZIONE E AZIONI FISSE, solo il centro scorre: su uno schermo piccolo il pulsante che
            invia non deve mai poter finire fuori vista. */}
        {sheetOpen && (
          <div className="op-qs-scrim" data-op-quicksheet-scrim
            onClick={() => { setSheetOpen(false); setSheetStep('form'); }}>
            <div className="op-qs" data-op-quicksheet data-op-qs-step={sheetStep}
              role="dialog" aria-modal="true" aria-label="Configura ordine"
              onClick={(e) => e.stopPropagation()}>
              <div className="op-qs-grab" aria-hidden="true" />

              {/* ── INTESTAZIONE (fissa) ─────────────────────────────────────────────────────── */}
              <div className="op-qs-head">
                <div className="op-qs-h-txt">
                  <div className="op-qs-t" data-op-qs-title>
                    BUY {book.toUpperCase()}
                    <span className="ex-dim"> · {sheetBelow ? 'sotto il mid' : 'sopra il mid'}</span>
                  </div>
                  {/* «RIGA TOCCATA» SOLO SE UNA RIGA È STATA TOCCATA. Arrivando dal piano non lo è mai:
                      `pickedPrice` resta null e questa riga scriveva «riga toccata N/D», cioè un campo
                      vuoto travestito da dato. Il titolo del mercato, invece, serve sempre — è ciò che
                      si sta per comprare, e nel popup non compariva da nessuna parte. */}
                  <div className="op-qs-s" data-op-qs-sub>
                    <span className="op-qs-mkt" data-op-qs-market>{target.title}</span>
                    {fin(pickedPrice) && <> · riga toccata <b className="ex-n">{cents(pickedPrice)}</b></>}
                    {' · '}mid <b className="ex-n">{cents(mid)}</b>
                  </div>
                </div>
                <button className="op-x" onClick={() => { setSheetOpen(false); setSheetStep('form'); }}
                  aria-label="Chiudi" data-op-qs-close>✕</button>
              </div>

              <div className="op-qs-body">
                {sheetStep === 'form' ? (
                  <>
                    {/* ── 1 · LATO ────────────────────────────────────────────────────────────── */}
                    <div className="op-field">
                      <div className="op-label">Lato</div>
                      <div className="op-qs-sides" role="group" aria-label="Lato">
                        <button className={`op-qs-side ${book === 'yes' ? 'is-yes' : ''}`}
                          onClick={() => setBook('yes')} data-op-qs-book="yes" aria-pressed={book === 'yes'}>
                          BUY YES
                        </button>
                        <button className={`op-qs-side ${book === 'no' ? 'is-no' : ''}`}
                          onClick={() => setBook('no')} data-op-qs-book="no" aria-pressed={book === 'no'}>
                          BUY NO
                        </button>
                      </div>
                    </div>

                    {/* ── 2 · SIZE ────────────────────────────────────────────────────────────── */}
                    <div className="op-field">
                      <div className="op-label">
                        Size
                        <span className="op-labelhint" data-op-qs-size-pct>{sizePct}%</span>
                      </div>
                      {sizeRange.readable ? (
                        <>
                          <input className="op-qs-slider" type="range" min={0} max={100} step={1}
                            value={sizePct} data-op-qs-size-slider
                            aria-label="Size, dalla minima premiante al massimo consentito"
                            onChange={(e) => {
                              const s = sizeFromPct(Number(e.target.value));
                              if (s != null) { setSizeStr(String(s)); setSizeTouched(true); }
                            }} />
                          <div className="op-qs-ends" data-op-qs-ends>
                            <span>0% · {sizeRange.lo} share</span>
                            <span>100% · {sizeRange.hi} share</span>
                          </div>
                          <div className="op-qs-out" data-op-qs-size-out>
                            <b className="ex-n">{fin(size) ? size : 'N/D'}</b> share
                            <span className="ex-dim"> · </span>
                            <b className="ex-n">{money(notional)}</b>
                            {fin(orderCapUsd) && <span className="ex-dim"> · tetto per ordine {money(orderCapUsd)}</span>}
                          </div>
                          {/* QUALE DEI DUE LIMITI HA FERMATO IL 100%: senza dirlo, un massimo basso
                              sembra un saldo basso anche quando e' il tetto che morde. */}
                          <p className="op-hint" data-op-qs-bound={sizeRange.boundBy ?? ''}>
                            Il 100% e&apos; fermato {sizeRange.boundBy === 'tetto-ordine'
                              ? <>dal <b>tetto per ordine</b> ({money(orderCapUsd)}), non dal saldo.</>
                              : <>dal <b>capitale disponibile</b> ({money(balanceUsd)}).</>}
                          </p>
                          {/* ── IL CURSORE SENZA CORSA ────────────────────────────────────────────
                              Quando gia' la size minima premiante costa piu' del tetto per ordine, i due
                              estremi coincidono e il cursore non puo' esprimere nulla: qualunque
                              posizione dia lo stesso numero, e quel numero e' comunque oltre il tetto.
                              Detto cosi' e' un fatto azionabile — alzare il tetto, o accettare che su
                              questo mercato a questo prezzo non si maturi — invece di un cursore muto
                              e un rifiuto generico piu' in basso. */}
                          {sizeRange.hi === sizeRange.lo && (
                            <p className="ex-flag is-bad" data-op-qs-size-degenere>
                              <span className="ex-flag-i" aria-hidden="true">⛔</span>
                              <span>
                                A {cents(price)} la size minima premiante ({sizeRange.lo} share) costa {money((sizeRange.lo ?? 0) * (price as number))},
                                {fin(orderCapUsd) && <> oltre il tetto per ordine di {money(orderCapUsd)}</>}: il cursore non ha corsa e
                                l&apos;ordine verrebbe rifiutato. Serve alzare il tetto, oppure un prezzo più basso.
                              </span>
                            </p>
                          )}
                        </>
                      ) : (
                        /* NON si disegna un cursore su una scala che non conosciamo: 0% senza una size
                           minima pubblicata, o 100% senza un saldo letto, sarebbero due estremi finti. */
                        <p className="ex-flag is-dim" data-op-qs-size-unknown>
                          <span className="ex-flag-i" aria-hidden="true">ⓘ</span>
                          <span>Cursore non disponibile: manca {!fin(minSize) ? 'la size minima premiante del venue' : 'il saldo disponibile'}.</span>
                        </p>
                      )}
                    </div>

                    {/* ── 3 · DISTANZA DAL MID ────────────────────────────────────────────────── */}
                    <div className="op-field">
                      <div className="op-label">
                        Distanza dal mid
                        <span className="op-labelhint">passo 0.25¢</span>
                      </div>
                      <div className="op-qs-step" data-op-qs-dist-row>
                        <button className="op-qs-btn" onClick={() => stepDist(-0.25)} data-op-qs-dist-minus aria-label="Riduci la distanza">−</button>
                        <div className="op-qs-val">
                          <b className="ex-n" data-op-qs-dist>{fin(sheetDistC) ? `${(sheetDistC as number).toFixed(2)}¢` : 'N/D'}</b>
                          <span className="ex-dim" data-op-qs-dist-price>→ {cents(priceFromDist(sheetDistC))}</span>
                        </div>
                        <button className="op-qs-btn" onClick={() => stepDist(0.25)} data-op-qs-dist-plus aria-label="Aumenta la distanza">+</button>
                      </div>

                      {/* ── IL BOX DI VALIDAZIONE, TRE STATI ─────────────────────────────────────
                          Rosso = l'ordine non farebbe quello che sembra, o il venue lo rifiuterebbe.
                          Giallo = costa i premi ma si piazza. Verde = riposa come maker, dentro banda.
                          La distinzione fra rosso e giallo e' la stessa di splitVerdict lato server:
                          fuori banda e' un COSTO dichiarato, fuori tick e' una regola del venue. */}
                      {(() => {
                        const offTick = problems.some((p) => p.key === 'tick');
                        const badPrice = problems.some((p) => p.key === 'price');
                        if (offTick || badPrice || verdict?.crosses) {
                          return (
                            <div className="op-verdict is-bad" data-op-qs-check="bad" role="status" aria-live="polite">
                              <span className="op-verdict-i" aria-hidden="true">⛔</span>
                              <span className="op-verdict-tx">
                                {verdict?.crosses && <span className="op-verdict-l">A {cents(price)} incroci il book: l&apos;ordine si eseguirebbe subito, non resterebbe come maker.</span>}
                                {offTick && <span className="op-verdict-l">Fuori dalla griglia del tick ({tick}): il venue lo rifiuterebbe. Bloccante.</span>}
                                {badPrice && <span className="op-verdict-l">Il prezzo deve stare fra 0 e 1.</span>}
                              </span>
                            </div>
                          );
                        }
                        if (verdict?.outOfBand === true) {
                          return (
                            <div className="op-verdict is-warn" data-op-qs-check="warn" role="status" aria-live="polite">
                              <span className="op-verdict-i" aria-hidden="true">⚠</span>
                              <span className="op-verdict-tx">
                                <span className="op-verdict-l">Fuori dalla banda reward: non matura reward, ma è piazzabile — avviso, non blocco.</span>
                              </span>
                            </div>
                          );
                        }
                        if (verdict?.outOfBand === false) {
                          return (
                            <div className="op-verdict is-ok" data-op-qs-check="ok" role="status" aria-live="polite">
                              <span className="op-verdict-i" aria-hidden="true">✓</span>
                              <span className="op-verdict-tx">
                                <span className="op-verdict-l">Dentro la banda reward, e resta sul book come maker.</span>
                              </span>
                            </div>
                          );
                        }
                        return (
                          <div className="op-verdict is-unk" data-op-qs-check="unknown" role="status" aria-live="polite">
                            <span className="op-verdict-i" aria-hidden="true">ⓘ</span>
                            <span className="op-verdict-tx">
                              <span className="op-verdict-l">Banda non verificabile: manca il mid di scoring o il raggio premiante.</span>
                            </span>
                          </div>
                        );
                      })()}
                    </div>

                    {/* ── 4 · MOTORE ──────────────────────────────────────────────────────────── */}
                    <div className="op-field">
                      <div className="op-label">Motore</div>
                      <div className="op-seg" role="group" aria-label="Motore">
                        <button className={`op-segb ${sheetEngine === 'manual' ? 'is-yes' : ''}`}
                          onClick={() => setSheetEngine('manual')} data-op-qs-engine="manual" aria-pressed={sheetEngine === 'manual'}>
                          Manuale
                        </button>
                        <button className={`op-segb ${sheetEngine === 'tracking' ? 'is-yes' : ''}`}
                          onClick={() => setSheetEngine('tracking')} data-op-qs-engine="tracking" aria-pressed={sheetEngine === 'tracking'}>
                          Tracking
                        </button>
                      </div>
                      <p className="op-hint" data-op-qs-engine-note>
                        {sheetEngine === 'manual'
                          ? <>Un ordine solo, fermo al prezzo scelto, GTD {Math.round(ttlSeconds / 60)} min. Nessun riposizionamento: se il mid si muove, l&apos;ordine resta dov&apos;è.</>
                          : <>L&apos;ordine insegue il mid: il motore lo riprezza da solo quando il mid si sposta oltre la soglia, <b>senza chiedere conferma ordine per ordine</b>, finché non lo spegni.</>}
                      </p>
                    </div>

                    {/* ── 5 · SOLO CON IL TRACKING ────────────────────────────────────────────── */}
                    {sheetEngine === 'tracking' && (
                      <>
                        <div className="op-field" data-op-qs-tracking-extra>
                          <div className="op-label">Lati quotati</div>
                          <div className="op-seg" role="group" aria-label="Lati quotati">
                            {([['both', 'Entrambi'], ['yes', 'Solo YES'], ['no', 'Solo NO']] as const).map(([v, label]) => (
                              <button key={v} type="button"
                                className={`op-segb ${trkSides === v ? (v === 'no' ? 'is-no' : 'is-yes') : ''}`}
                                onClick={() => setTrkSides(v)} data-op-qs-sides={v} aria-pressed={trkSides === v}>
                                {label}
                              </button>
                            ))}
                          </div>
                          {trkSides !== 'both' && (
                            <>
                              <p className="ex-flag is-bad" data-op-qs-sides-warn>
                                <span className="ex-flag-i" aria-hidden="true">⚠</span>
                                <span>
                                  Un lato solo <b>NON matura reward</b>: il punteggio prende il minimo fra i due lati
                                  (Q_min), e con una gamba sola quel minimo è zero.
                                </span>
                              </p>
                              {/* NON È SOLO «ZERO REWARD»: SUI DATI STORICI HA PERSO. Il backtest del 3 agosto
                                  2026 (216 fill, 61 mercati premianti, 10 giorni) ha separato i mercati dove il
                                  motore quotava una gamba sola da quelli a due lati. Senza reward resta solo il
                                  P&L di prezzo, e quello sul campione e' negativo. Detto qui perche' «non maturi
                                  nulla» si legge come «guadagni zero», mentre il numero misurato e' sotto zero. */}
                              <p className="ex-flag is-bad" data-op-qs-sides-loss>
                                <span className="ex-flag-i" aria-hidden="true">⛔</span>
                                <span>
                                  E sui dati storici <b>ha reso in PERDITA</b>, non zero: sul campione misurato
                                  (216 fill, 61 mercati, 10 giorni) i mercati a gamba singola hanno chiuso a
                                  <b> −$11,93</b> contro <b>+$15,15</b> di quelli a due lati. Senza reward resta solo
                                  il movimento del prezzo, e quello da solo perde.
                                  Questa è una <b>scommessa direzionale</b>, non market making.
                                </span>
                              </p>
                            </>
                          )}
                        </div>

                        <div className="op-field">
                          <div className="op-label">
                            Soglia reprice
                            <span className="op-labelhint">passo 0.25¢</span>
                          </div>
                          <div className="op-qs-step" data-op-qs-thr-row>
                            <button className="op-qs-btn" data-op-qs-thr-minus aria-label="Riduci la soglia"
                              onClick={() => setTrkMinMove((v) => String(+Math.max(0.25, (Number(v) || 0) - 0.25).toFixed(2)))}>−</button>
                            <div className="op-qs-val"><b className="ex-n" data-op-qs-thr>{trkMinMove === '' ? '—' : `${trkMinMove}¢`}</b></div>
                            <button className="op-qs-btn" data-op-qs-thr-plus aria-label="Aumenta la soglia"
                              onClick={() => setTrkMinMove((v) => String(+((Number(v) || 0) + 0.25).toFixed(2)))}>+</button>
                          </div>
                          <p className="op-hint">
                            Di quanto deve muoversi il mid prima che l&apos;ordine venga riposizionato.
                            Più bassa = insegue più da vicino, e riprezza più spesso.
                          </p>
                        </div>

                        {/* IL TRACKING GIA' ATTIVO su questo mercato, con il suo spegnimento: era
                            l'unico modo di fermarlo, e non puo' sparire insieme al pannello lungo. */}
                        {trkActive && (
                          <div className="op-field" data-op-qs-trk-active>
                            <p className="ex-flag is-dim">
                              <span className="ex-flag-i" aria-hidden="true">ⓘ</span>
                              <span>
                                Tracking già ATTIVO qui: {(trkActive.sides ?? 'both') === 'both' ? 'entrambi i lati' : `solo ${(trkActive.sides as string).toUpperCase()}`},
                                offset {trkActive.offsetCents}¢, soglia {trkActive.minMoveCents}¢.
                              </span>
                            </p>
                            {trkOffStep === 'idle' ? (
                              <button className="ex-btn is-danger op-qs-toggle" onClick={() => setTrkOffStep('choose')} data-op-qs-trk-off>
                                Disattiva il tracking
                              </button>
                            ) : (
                              <div className="op-trk-choice" data-op-qs-trk-choice>
                                <div className="op-trk-q">Gli ordini già a riposo su questo mercato:</div>
                                <button className="ex-btn is-danger op-qs-toggle" disabled={trkBusy}
                                  onClick={async () => { const r = await trkCall({ enabled: false, preview: false, cancelOrders: true }); setTrkMsg(r.note ?? r.error ?? null); if (r.ok) { setTrkActive(null); setTrkOffStep('idle'); } }}
                                  data-op-qs-trk-off-cancel>Spegni e CANCELLA gli ordini</button>
                                <button className="ex-btn op-qs-toggle" disabled={trkBusy}
                                  onClick={async () => { const r = await trkCall({ enabled: false, preview: false, cancelOrders: false }); setTrkMsg(r.note ?? r.error ?? null); if (r.ok) { setTrkActive(null); setTrkOffStep('idle'); } }}
                                  data-op-qs-trk-off-leave>Spegni e lasciali scadere per GTD</button>
                                <button className="ex-link op-qs-toggle" onClick={() => setTrkOffStep('idle')}>annulla</button>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}

                    {/* IL RINNOVO, quando questo mercato e' sotto auto-reprice. Era una casella del
                        pannello lungo, e senza di essa si perderebbe la scelta fra un ordine che si
                        rinnova e uno che scade e basta. */}
                    {sheetEngine === 'manual' && repriceOn && (
                      <div className="op-field">
                        <label className="op-check">
                          <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} data-op-qs-autorenew />
                          <span>lascia il rinnovo automatico su questo ordine</span>
                        </label>
                      </div>
                    )}

                    {/* ── 6 · CHIUSURA AUTOMATICA ─────────────────────────────────────────────
                        STESSA configurazione del motore, letta e scritta dallo stesso posto: non una
                        copia locale che potrebbe raccontare un altro stato. */}
                    <div className="op-field">
                      <div className="op-label">Chiusura automatica</div>
                      {acState == null ? (
                        <p className="ex-flag is-bad" data-op-qs-ac-unknown>
                          <span className="ex-flag-i" aria-hidden="true">⚠</span>
                          <span>Stato NON letto: non è la stessa cosa di «spenta».</span>
                        </p>
                      ) : (
                        <>
                          <button
                            className={`ex-btn op-qs-toggle ${acState.market?.enabled ? 'is-danger' : ''}`}
                            disabled={acBusy}
                            data-op-qs-ac={acState.market?.enabled ? 'on' : 'off'}
                            onClick={() => acCall('market', !(acState.market?.enabled === true))}>
                            {acBusy ? 'Attendi…' : acState.market?.enabled ? 'attiva — vende dopo un fill' : 'spenta — tocca per attivare'}
                          </button>
                          <p className="op-hint" data-op-qs-ac-latency>
                            Vende a carico +{acState.profitCents ?? 1}¢ dopo un fill. Il fill si rileva leggendo le
                            posizioni dal venue <b>ogni 60 secondi</b>: fra riempimento e uscita passa fino a un minuto.
                          </p>
                          <div className="op-ac-master" data-op-qs-ac-master>
                            <span className="op-ac-master-k">
                              Interruttore GENERALE — {acState.globalEnabled ? 'acceso' : <b className="ex-gold">SPENTO</b>}: senza di
                              esso la chiusura automatica non agisce su nessun mercato, nemmeno dove è accesa.
                            </span>
                            <button className="ex-link op-qs-toggle" disabled={acBusy}
                              data-op-qs-ac-master-btn={acState.globalEnabled ? 'on' : 'off'}
                              onClick={() => acCall('global', !acState.globalEnabled)}>
                              {acState.globalEnabled ? 'spegni il generale' : 'accendi il generale'}
                            </button>
                          </div>
                        </>
                      )}
                      {/* L'esito dell'ultimo toggle: la nota di conferma, o il rifiuto. Prima veniva
                          scritto in `acMsg` e non lo leggeva nessuno — premevi e non cambiava niente
                          sullo schermo, che è indistinguibile da un successo silenzioso. */}
                      {acMsg && <div className="ex-banner op-mb" data-op-qs-ac-msg>{acMsg}</div>}
                    </div>

                    {trkMsg && <div className="ex-banner op-mb" data-op-qs-trk-msg>{trkMsg}</div>}

                    {problems.filter((p) => p.blocking).length > 0 && (
                      <div className="op-probs" data-op-qs-problems>
                        {problems.filter((p) => p.blocking).map((p) => (
                          <p key={p.key} className="ex-flag is-bad" data-op-qs-problem={p.key}>
                            <span className="ex-flag-i" aria-hidden="true">⛔</span><span>{p.text}</span>
                          </p>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  /* ── 7 · IL RIEPILOGO COMPATTO ─────────────────────────────────────────────────
                      QUESTA È LA SCHERMATA CHE DECIDE, e deve stare in uno schermo di telefono senza
                      scorrere. Prima erano dodici righe più tre avvisi, e la parte che conta —
                      prezzo, size, incrocia?, in banda? — arrivava dopo sette righe di contorno.

                      Le righe le costruisce `riepilogoOrdine`, un modulo puro con il suo test: qui
                      non c'è nessun valore calcolato a mano, quindi non c'è nessun posto da cui
                      possa divergere da ciò che verrà inviato.

                      IL SECONDARIO NON SPARISCE, SI PIEGA. Motore, lati quotati, soglia, chiusura
                      automatica e durata restano a un tocco di distanza: sono cose che si scelgono
                      una volta e si rileggono di rado, non a ogni conferma. */
                  <div data-op-qs-review>
                    <div className="op-review">
                      <div className="op-review-h">Verifica e conferma</div>
                      <div className="ex-kvs op-rsum" data-op-review-rows={riepilogo.righe.length}>
                        {riepilogo.righe.map((r) => (
                          <div className="ex-kv" key={r.chiave} data-op-review-row={r.chiave} data-op-review-tone={r.tono}>
                            <span className="ex-kv-k">{r.k}</span>
                            <span className={`ex-kv-v op-rsum-v is-${r.tono}`} data-op-review-value={r.chiave}>
                              {r.v}{r.nota ? <span className="ex-kv-note"> · {r.nota}</span> : null}
                            </span>
                          </div>
                        ))}
                      </div>
                      {/* IL CONTROVALORE IN EVIDENZA: e' la cifra che lascia il conto, e in un elenco
                          di righe uguali sparirebbe fra le altre. */}
                      <div className="op-qs-total" data-op-qs-review-total>
                        <span className="op-qs-total-k">controvalore</span>
                        <span className="op-qs-total-v ex-n">{money(notional)}</span>
                      </div>
                    </div>

                    {/* ── IL RESTO, PIEGATO ─────────────────────────────────────────────────────── */}
                    <button className="op-more" onClick={() => setReviewDetails((v) => !v)}
                      data-op-review-more aria-expanded={reviewDetails}>
                      {reviewDetails ? '▾ Nascondi impostazioni' : '▸ Mostra impostazioni (motore, durata, chiusura)'}
                    </button>
                    {reviewDetails && (
                      <div className="ex-kvs op-mb" data-op-review-details>
                        <div className="ex-kv"><span className="ex-kv-k">mercato (id)</span><span className="ex-kv-v op-wrap ex-n">{target.marketId}</span></div>
                        <div className="ex-kv"><span className="ex-kv-k">motore</span><span className="ex-kv-v" data-op-qs-review-engine={sheetEngine}>{sheetEngine === 'manual' ? 'Manuale — un ordine fermo' : 'Tracking — insegue il mid'}</span></div>
                        {sheetEngine === 'tracking' && (
                          <>
                            <div className="ex-kv"><span className="ex-kv-k">lati quotati</span><span className="ex-kv-v" data-op-qs-review-sides={trkSides}>{trkSides === 'both' ? 'entrambi' : `SOLO ${trkSides.toUpperCase()}`}</span></div>
                            <div className="ex-kv"><span className="ex-kv-k">soglia reprice</span><span className="ex-kv-v">{trkMinMove === '' ? '—' : `${trkMinMove}¢`}</span></div>
                          </>
                        )}
                        <div className="ex-kv"><span className="ex-kv-k">chiusura auto</span><span className="ex-kv-v" data-op-qs-review-ac>{acState == null ? 'non letta' : acState.market?.enabled ? 'ATTIVA' : 'spenta'}</span></div>
                        <div className="ex-kv"><span className="ex-kv-k">durata</span><span className="ex-kv-v">GTD {Math.round(ttlSeconds / 60)} min</span></div>
                        <div className="ex-kv"><span className="ex-kv-k">prezzo del book</span><span className="ex-kv-v">{cents(bestBid)} / {cents(bestAsk)}</span></div>
                        <div className="ex-kv"><span className="ex-kv-k">mid di scoring</span><span className="ex-kv-v">{cents(scoringMid)}</span></div>
                      </div>
                    )}

                    {/* ── PERCHÉ IL PULSANTE È SPENTO ────────────────────────────────────────────────
                        QUESTO BLOCCO MANCAVA, ed è il difetto che questa sessione corregge. L'elenco
                        dei gate bloccanti era renderizzato SOLO nel ramo del modulo: finché per
                        confermare bisognava passarci, lo si vedeva per forza. Poi la coda ha iniziato
                        ad atterrare direttamente qui — il percorso si è accorciato, che era lo scopo —
                        e l'unico posto in cui i motivi erano scritti è rimasto fuori dal cammino.
                        Il pulsante continuava a leggere `canReview`; i motivi no.

                        Adesso pulsante ed elenco vengono dalla STESSA `motiviBlocco`, dove
                        `puoInviare` è definito come «nessun motivo». Non possono più divergere. */}
                    {blocco.motivi.length > 0 && (
                      <div className="op-probs" data-op-review-blocchi={blocco.motivi.length}>
                        {blocco.motivi.map((m) => (
                          <p key={m.chiave} className="ex-flag is-bad" data-op-review-blocco={m.chiave}>
                            <span className="ex-flag-i" aria-hidden="true">⛔</span>
                            <span>
                              {m.testo}
                              {m.azione ? <><br /><span className="op-azione">{m.azione}</span></> : null}
                            </span>
                          </p>
                        ))}
                      </div>
                    )}

                    {/* GLI AVVISI SI RIPETONO QUI. Chi conferma legge questa schermata, non quella
                        di prima, e un avviso visto due schermate fa non e' un avviso al momento
                        della decisione. */}
                    {verdict?.outOfBand === true && (
                      <p className="ex-flag is-bad" data-op-qs-review-band>
                        <span className="ex-flag-i" aria-hidden="true">⚠</span>
                        <span>Fuori dalla banda reward: quest&apos;ordine riposa ma <b>NON matura reward</b>.</span>
                      </p>
                    )}
                    {sheetEngine === 'tracking' && trkSides !== 'both' && (
                      <p className="ex-flag is-bad" data-op-qs-review-leg>
                        <span className="ex-flag-i" aria-hidden="true">⚠</span>
                        <span>Un lato solo: il punteggio prende il minimo fra i due lati, quindi <b>Q_min = 0</b> e questo mercato non maturerà reward.</span>
                      </p>
                    )}
                    {sheetEngine === 'tracking' && (
                      <p className="ex-flag is-bad" data-op-qs-review-delega>
                        <span className="ex-flag-i" aria-hidden="true">⚠</span>
                        <span>Confermando autorizzi il motore a piazzare e riprezzare <b>da solo</b> su questo mercato, senza conferma ordine per ordine, finché non lo spegni.</span>
                      </p>
                    )}
                  </div>
                )}

                {result && (
                  <div className={`ex-banner ${result.ok ? (result.sent ? 'is-ok' : 'is-warn') : 'is-bad'} op-mb`} data-op-qs-result>
                    {result.ok
                      ? (result.sent
                        ? <><b>ORDINE INVIATO AL VENUE.</b>{result.orderId ? <> orderId <span className="ex-n">{result.orderId}</span></> : null}</>
                        : <><b>DRY-RUN — nessun ordine reale piazzato.</b></>)
                      : <><b>Rifiutato al gate {result.gate ?? '—'}</b>: {result.reason ?? '—'}</>}
                    {result.ok && result.bandAdvisory && (
                      <span className="op-banner-sub" data-op-qs-band-advisory>
                        ⚠ Fuori dalla banda reward: riposa regolarmente ma NON matura reward.
                      </span>
                    )}
                    {/* IL PREZZO NON CAMBIA MAI DI NASCOSTO. La regola «mai primo sul libro» può
                        spostare la quotazione dietro al miglior altro ordine: se lo fa, si legge qui
                        col prezzo di partenza e quello applicato. */}
                    {result.ok && result.priceAdjusted?.inCoda && (
                      <span className="op-banner-sub" data-op-qs-in-coda>
                        Prezzo spostato per non essere primo sul libro:{' '}
                        <b>{cents(result.priceAdjusted.inCoda.from)}</b> → <b>{cents(result.priceAdjusted.inCoda.to)}</b>
                        {result.priceAdjusted.inCoda.bestOther != null
                          ? <> (dietro a {cents(result.priceAdjusted.inCoda.bestOther)})</> : null}
                      </span>
                    )}
                    {result.ok && !result.priceAdjusted?.inCoda && result.inCoda && result.inCoda.onTop === false && (
                      <span className="op-banner-sub" data-op-qs-in-coda>
                        Non era primo sul libro: prezzo lasciato com’era.
                      </span>
                    )}
                    {/* ── LA SECONDA GAMBA: IN CODA, MAI IN AUTOMATICO ────────────────────────────
                        Il piano ne prevede due, e con un lato solo la posizione non è mezza posizione:
                        è capitale esposto che matura zero fuori da [0,10–0,90] e un terzo dentro.
                        Ma «il piano ne prevede due» non è «l'operatore ne ha autorizzate due»: la
                        seconda si apre solo di qui, con i suoi numeri sotto gli occhi, e passa dallo
                        stesso riepilogo e dalla stessa conferma della prima. */}
                    {result.ok && legNext && (
                      <div className="op-banner-sub" data-op-qs-next-leg>
                        <div>
                          Manca la <b>{legNext.label ?? `gamba ${legIdx + 2}`}</b>:
                          {' '}BUY {legNext.book.toUpperCase()} <b>{legNext.size}</b> share @ <b>{legNext.price}</b>
                          {' '}(<span className="ex-n">{money(legNext.price * legNext.size)}</span>).
                        </div>
                        {/* I VALORI DELLA GAMBA NUOVA SI SCRIVONO QUI, NON SOLO NELL'EFFETTO.
                            L'effetto di precompilazione li scriverebbe comunque, ma DOPO il disegno:
                            ci sarebbe un fotogramma con il riepilogo della gamba 2 e i numeri della
                            gamba 1. Un istante, e nessuno tocca in un istante — ma «i dati veri
                            visibili prima del tocco» non ammette fotogrammi in cui non lo sono.
                            Scritti nello stesso lotto, quel fotogramma non esiste. */}
                        <button className="ex-btn is-gold" style={{ marginTop: 8 }}
                          data-op-qs-next-leg-btn
                          onClick={() => {
                            setLegIdx(legIdx + 1);
                            setBook(legNext.book);
                            setPriceStr(String(legNext.price));
                            setSizeStr(String(+legNext.size.toFixed(4)));
                            setResult(null);
                            setSheetStep('review');
                          }}>
                          Prepara la {legNext.label ?? 'seconda gamba'} →
                        </button>
                      </div>
                    )}
                    {result.ok && legs && !legNext && legIdx + 1 === legs.length && legs.length > 1 && (
                      <span className="op-banner-sub" data-op-qs-legs-done>
                        Entrambe le gambe del piano sono state trattate.
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* ── LE AZIONI (fisse, fuori dall'area che scorre) ──────────────────────────────── */}
              <div className="op-qs-actions">
                {sheetStep === 'form' ? (
                  <button className="ex-btn is-gold op-primary" disabled={!canReview}
                    onClick={() => setSheetStep('review')} data-op-qs-review-btn>
                    Rivedi ordine
                  </button>
                ) : (
                  <>
                    <button className="ex-btn op-back" onClick={() => setSheetStep('form')} data-op-qs-back>Modifica</button>
                    {/* UNA CONDIZIONE SOLA, ED È LA STESSA CHE PRODUCE I MOTIVI QUI SOPRA.
                        Prima era `busy || trkBusy || !canReview || !riepilogo.completo`: quattro
                        termini, di cui uno solo (`riepilogo.completo`) aveva un messaggio in questa
                        schermata. `blocco.puoInviare` copre tutti e quattro e per costruzione non può
                        essere falso con l'elenco vuoto. */}
                    <button className={`ex-btn op-primary ${sends ? 'is-danger' : 'is-gold'}`}
                      disabled={!blocco.puoInviare}
                      data-op-qs-confirm data-op-sends={sends ? '1' : '0'} data-op-qs-confirm-engine={sheetEngine}
                      onClick={async () => {
                        // UN SOLO PULSANTE, DUE POTERI, e ognuno passa dalla sua funzione di sempre.
                        if (sheetEngine === 'tracking') {
                          const r = await trkCall({
                            enabled: true, preview: false, sides: trkSides,
                            offsetCents: fin(sheetDistC) ? sheetDistC : undefined,
                            minMoveCents: Number(trkMinMove) || undefined,
                            sizeShares: size,
                          });
                          setTrkMsg(r.note ?? r.error ?? null);
                          if (r.ok) { setTrkActive((r as { record?: TrackRecord }).record ?? null); setSheetStep('form'); }
                        } else {
                          await place();
                        }
                      }}>
                      {busy || trkBusy ? 'Invio…'
                        : sheetEngine === 'tracking' ? 'Conferma e ATTIVA il motore'
                          : sends ? 'Conferma e piazza — INVIA DAVVERO' : 'Conferma e piazza (dry-run)'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// NOTE: niente virgolette, angolari o e-commerciali in questo foglio — React li serializza diversi fra
// server e client dentro un tag style, e la differenza costa l idratazione dell intera pagina.
const CSS = `
.op-scrim { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.6);
  display: flex; align-items: flex-end; justify-content: center; backdrop-filter: blur(2px); }
/* position:relative perche il foglio rapido si ancori a QUESTO pannello e non alla finestra: su schermo
   largo il pannello e centrato a 560px, e un foglio ancorato alla finestra ne uscirebbe dai bordi. */
.op-sheet { position: relative; width: 100%; max-width: 560px; max-height: 92vh; display: flex; flex-direction: column;
  background: var(--ex-bg); border: 1px solid var(--ex-line); border-radius: 12px 12px 0 0;
  box-shadow: 0 -8px 40px rgba(0,0,0,.6); }
/* ── COMPATTEZZA IN ALTO ─────────────────────────────────────────────────────────────────────────
   Intestazione e dati di mercato sono CONTESTO: si leggono una volta e poi si lavora piu in basso.
   Rimpicciolirli fa entrare piu book nella prima schermata, che e la superficie su cui si agisce.
   Quello che NON si rimpicciolisce sono i numeri di prezzo — restano il contenuto piu importante — e
   l altezza toccabile delle righe, che e accessibilita e non densita. */
.op-head { display: flex; align-items: flex-start; gap: 10px; padding: 9px 12px;
  border-bottom: 1px solid var(--ex-line); }
.op-head-txt { min-width: 0; flex: 1 1 auto; }
.op-title { font-size: 13.5px; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
.op-sub { margin-top: 4px; font-size: 10.5px; color: var(--ex-txt-3); line-height: 1.75; overflow-wrap: anywhere; }
.op-id { margin-top: 3px; font-size: 9px; color: var(--ex-txt-3); word-break: break-all; }
.op-bdg { margin-left: 4px; }
.op-x { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--ex-line); background: var(--ex-panel-2); color: var(--ex-txt); font-size: 14px; }
.op-x:hover { border-color: var(--ex-gold); color: var(--ex-gold); }

.op-body { overflow-y: auto; padding: 12px 14px; flex: 1 1 auto; }
.op-mb { margin-bottom: 10px; }
.op-inline { margin-left: 8px; vertical-align: middle; }

.op-field { margin-bottom: 12px; }
.op-label { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--ex-txt-3);
  display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.op-labelhint { text-transform: none; letter-spacing: 0; font-family: var(--ex-mono); }
.op-input { width: 100%; margin-top: 5px; }
.op-input.is-bad { border-color: var(--ex-red); background: rgba(246,70,93,.08); }
.op-fix { margin-top: 4px; font-size: 11px; }
.op-hint { font-size: 10.5px; color: var(--ex-txt-3); line-height: 1.5; margin-top: 5px; }
.op-check { display: flex; gap: 7px; align-items: center; margin-top: 7px; font-size: 11.5px; color: var(--ex-txt-2); }

/* ── EYEBROW ─────────────────────────────────────────────────────────────────────────────────────
   Il separatore di sezione e una riga di testo, non una card. Una card dentro una card produce due
   bordi concentrici e ruba larghezza su un telefono senza aggiungere informazione: qui la gerarchia
   la fa la tipografia (maiuscoletto grigio, filetto sottile), e il pannello resta un piano solo. */
.op-eyebrow { display: flex; align-items: center; gap: 8px;
  font-size: 9.5px; letter-spacing: .11em; text-transform: uppercase; font-weight: 700;
  color: var(--ex-txt-3); margin: 16px 0 7px; }
.op-eyebrow::after { content: ""; flex: 1 1 auto; height: 1px; background: var(--ex-line-soft); }
.op-eyebrow-r { order: 3; letter-spacing: .06em; font-weight: 600; color: var(--ex-txt-2); }
.op-eyebrow:first-child { margin-top: 2px; }

/* ── DATI DI MERCATO ── griglia auto-adattiva: tre colonne su un telefono stretto, quattro appena
   c e spazio. Nessun valore va a capo perche i numeri sono monospazio e la colonna e dimensionata
   sul piu largo che possa capitare. */
/* I filetti fra le celle sono ombre INTERNE alla cella, non un gap che lascia vedere lo sfondo.
   Con sette voci e una griglia a quattro colonne l ultima riga resta spaiata: col trucco del gap quel
   posto vuoto si vedeva come un riquadro piu chiaro, cioe una cella che non esiste. Cosi invece lo
   spazio avanzato e semplicemente sfondo, e la griglia finisce dove finiscono i dati. */
.op-mkt { display: grid; grid-template-columns: repeat(auto-fit, minmax(78px, 1fr));
  background: #12151A; border: 1px solid var(--ex-line); border-radius: 8px; overflow: hidden; }
.op-mkt-c { display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; min-width: 0;
  box-shadow: inset -1px -1px 0 var(--ex-line-soft); }
.op-mkt-k { font-size: 8.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--ex-txt-3); }
/* il VALORE non scende sotto i 13.5px: e il numero, non l etichetta */
.op-mkt-v { font-family: var(--ex-mono); font-size: 13.5px; font-weight: 700; line-height: 1.15; }
.op-mkt-s { font-family: var(--ex-mono); font-size: 9px; color: var(--ex-txt-3); overflow-wrap: anywhere; }
.op-mkt-s.is-ok { color: var(--ex-green); }
.op-mkt-s.is-warn { color: var(--ex-gold); }
.op-mkt-s.is-bad { color: var(--ex-red); }
/* La strada corta: il pulsante che porta alla verifica sta subito sotto i dati di mercato, a piena
   larghezza, dove prima c era l inizio dell order book. */
.op-goreview { display: block; width: 100%; min-height: 46px; margin: 0 0 10px; font-weight: 700; }
/* Le pieghe: un comando, non un titolo. Basso contrasto, perche il percorso principale e altrove. */
.op-more { display: block; width: 100%; text-align: left; background: none; border: 0; cursor: pointer;
  padding: 8px 2px; margin: 0 0 8px; font: inherit; font-size: 11px; color: var(--ex-txt-2); }
.op-more:hover { color: var(--ex-txt-1); }
/* Il rimedio sotto il motivo: si legge dopo, e va distinto dal motivo stesso. */
.op-azione { display: inline-block; margin-top: 3px; color: var(--ex-txt-2); font-size: 11.5px; }
/* Il riepilogo compatto: valori in evidenza, e il tono dice l esito senza doverlo leggere. */
.op-rsum-v.is-ok { color: var(--ex-green); }
.op-rsum-v.is-warn { color: var(--ex-gold); }
.op-rsum-v.is-bad { color: var(--ex-red); font-weight: 700; }
.op-rsum-v.is-forte { font-weight: 700; }
/* Il nome del mercato e lungo: va a capo dentro la sua riga invece di allargare il popup. */
.op-rsum-v { overflow-wrap: anywhere; min-width: 0; text-align: right; }
.op-qs-mkt { overflow-wrap: anywhere; }

.op-booknote { font-size: 10.5px; color: var(--ex-txt-3); line-height: 1.5; }

/* ── IL BOOK ─────────────────────────────────────────────────────────────────────────────────────
   Griglia a tre colonne: prezzo a sinistra, size e cumulato allineati a destra. Tutte le cifre in
   monospazio, cosi le colonne restano incolonnate mentre i numeri cambiano.
   NIENTE altezza bloccata e niente overflow:hidden sul contenitore: il book cresce e la scheda scorre.
   Un book tagliato a meta non e piu compatto, e semplicemente un book che mente. */
.op-book { border: 1px solid var(--ex-line); border-radius: 8px; background: var(--ex-panel); overflow: hidden; }
.op-book-top { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 10px; border-bottom: 1px solid var(--ex-line-soft); flex-wrap: wrap; }
.op-book-t { font-size: 11px; font-weight: 600; color: var(--ex-txt-2); }
.op-book-hd { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; padding: 4px 10px;
  font-size: 9px; letter-spacing: .06em; text-transform: uppercase; color: var(--ex-txt-3);
  border-bottom: 1px solid var(--ex-line-soft); }
.op-book-hd span:nth-child(2), .op-book-hd span:nth-child(3) { text-align: right; min-width: 62px; }
.op-book-side { display: flex; flex-direction: column; }
.op-book-empty { padding: 9px 10px; font-size: 10.5px; color: var(--ex-txt-3); }

/* La riga e un BOTTONE: tocco, tastiera e stato disabilitato arrivano gratis e sono quelli veri del
   browser, non un div che finge. */
/* ALTEZZA DELLA RIGA: 40px, 44px col dito.
   La riga E un comando — si tocca per compilare il prezzo — quindi vale la soglia dei bersagli
   toccabili, non la densita di una tabella da leggere. Dieci righe da 40px non entrano in uno schermo
   da 640 insieme al resto, e va bene cosi: il pannello scorre. Un bersaglio troppo piccolo invece non
   si aggiusta scorrendo, si sbaglia e basta. */
.op-row { position: relative; display: grid; grid-template-columns: 1fr auto auto; gap: 10px;
  align-items: center; width: 100%; padding: 0 10px; min-height: 36px; cursor: pointer;
  background: none; border: 0; border-left: 2px solid transparent; color: inherit;
  font-family: var(--ex-mono); font-size: 12px; text-align: left; }
.op-row-bar { position: absolute; top: 2px; bottom: 2px; right: 0; z-index: 0; border-radius: 2px 0 0 2px; }
.op-row-bar.is-ask { background: rgba(246,70,93,.16); }
.op-row-bar.is-bid { background: rgba(14,203,129,.16); }
.op-row-p, .op-row-s, .op-row-c { position: relative; z-index: 1; }
.op-row-p { font-weight: 700; }
.op-row-s { text-align: right; min-width: 62px; color: var(--ex-txt); }
.op-row-c { text-align: right; min-width: 62px; color: var(--ex-txt-2); }
.op-row:hover:not(:disabled) { background: rgba(240,185,11,.06); }
.op-row.is-picked { border-left-color: var(--ex-gold); background: rgba(240,185,11,.12); }

/* 44px COL DITO, e questa non e una densita da limare: e la soglia dei bersagli toccabili. La riga del
   book E un comando, quindi la compattezza si prende da padding e testi di contorno, non da qui. */
@media (pointer: coarse) {
  .op-row { min-height: 44px; }
}

/* ── IL LAMPEGGIO DOPO IL TOCCO ─────────────────────────────────────────────────────────────────
   800ms, una volta sola, su due elementi lontani fra loro: il libro che e stato toccato e il campo
   prezzo che si e compilato. Serve a rendere visibile un cambiamento che avviene sotto la piega.
   prefers-reduced-motion lo spegne: chi lo ha chiesto vede lo stato finale senza transizione.
   NB: niente backtick in questo foglio — e dentro un template literal, e lo terminerebbe. */
@keyframes op-flash {
  0%   { border-color: var(--ex-gold); box-shadow: 0 0 0 2px var(--ex-gold-bg); }
  70%  { border-color: var(--ex-gold); box-shadow: 0 0 0 2px var(--ex-gold-bg); }
  100% { border-color: var(--ex-line); box-shadow: none; }
}
.op-book.is-flash { animation: op-flash 800ms ease-out 1; }
.op-input.is-flash { animation: op-flash 800ms ease-out 1; }
@media (prefers-reduced-motion: reduce) {
  .op-book.is-flash, .op-input.is-flash { animation: none; border-color: var(--ex-gold); }
}

/* LA RIGA DEL MID sta gia dove deve, fra il miglior ask (ultima riga del blocco sopra) e il miglior
   bid (prima riga del blocco sotto). Qui cambia solo l allineamento: CENTRATA, perche e la linea di
   separazione fra i due lati e un contenuto allineato a sinistra la faceva leggere come un intestazione
   del blocco dei bid invece che come il confine fra i due. */
.op-book-mid { display: flex; align-items: baseline; justify-content: center; gap: 8px; flex-wrap: wrap;
  padding: 6px 10px; text-align: center; background: var(--ex-gold-bg);
  border-top: 1px solid var(--ex-gold-bd); border-bottom: 1px solid var(--ex-gold-bd); }
.op-book-mid-v { font-family: var(--ex-mono); font-size: 15.5px; font-weight: 700; color: var(--ex-gold); }
.op-book-mid-k { font-size: 9.5px; color: var(--ex-txt-2); }
.op-book-mid-s { font-family: var(--ex-mono); font-size: 10px; color: var(--ex-txt-2); }
.op-book-foot { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 8px 10px;
  border-top: 1px solid var(--ex-line-soft); font-size: 10px; color: var(--ex-txt-3); }
.op-midnote-p { margin-bottom: 4px; }

/* ── IL CURSORE DELLA DISTANZA ── area di tocco piena, non un filo di 4px. */

/* ── IL VERDETTO SUL PREZZO ── */
.op-verdict { display: flex; gap: 8px; align-items: flex-start; margin-top: 7px;
  padding: 8px 10px; border-radius: 6px; font-size: 11.5px; line-height: 1.45; border: 1px solid; }
.op-verdict-i { flex: 0 0 auto; }
.op-verdict-tx { display: flex; flex-direction: column; gap: 3px; }
.op-verdict.is-ok { color: var(--ex-green); border-color: var(--ex-green-bd); background: var(--ex-green-bg); }
.op-verdict.is-bad { color: var(--ex-red); border-color: var(--ex-red-bd); background: var(--ex-red-bg); }
/* GIALLO = fuori banda. Deliberatamente NON rosso: il rosso in questo pannello significa «questo
   ordine non e quello che credi», e un ordine fuori banda e' esattamente quello che l operatore ha
   chiesto — costa i premi, e lo dice. */
.op-verdict.is-warn { color: var(--ex-gold); border-color: var(--ex-gold-bd); background: var(--ex-gold-bg); }
.op-banner-sub { display: block; margin-top: 5px; font-size: 10.5px; color: var(--ex-gold); }
.op-verdict.is-unk { color: var(--ex-txt-2); border-color: var(--ex-unk-bd); background: var(--ex-unk-bg); }

.op-seg { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px; }
.op-segb { min-height: 46px; border-radius: 6px; cursor: pointer; font-family: var(--ex-mono);
  font-size: 13px; font-weight: 700; letter-spacing: .04em;
  border: 1px solid var(--ex-line); background: var(--ex-panel-2); color: var(--ex-txt-2); }
.op-segb.is-yes { background: var(--ex-green); border-color: var(--ex-green); color: #06251A; }
.op-segb.is-no { background: var(--ex-red); border-color: var(--ex-red); color: #fff; }

.op-notional { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  padding: 10px 12px; border: 1px solid var(--ex-line); border-radius: 8px;
  background: var(--ex-panel); margin: 12px 0; }
.op-notional-v { font-size: 20px; font-weight: 700; color: var(--ex-gold); }

.op-probs { margin: 10px 0; }
.op-review { border: 1px solid var(--ex-gold-bd); background: var(--ex-gold-bg);
  border-radius: 8px; padding: 11px 12px; margin: 10px 0; }
.op-review-h { font-size: 12px; font-weight: 700; color: var(--ex-gold); margin-bottom: 8px; }
.op-wrap { overflow-wrap: anywhere; }

/* ── MOTORE AUTOMATICO ── l unica sezione con il bordo oro, e non e decorazione: in questo pannello
   l oro vuol dire «da qui in poi qualcosa agisce senza chiedertelo ogni volta». Il filtro qui sopra
   e grigio proprio per non rivendicare lo stesso peso. */
  cursor: pointer; background: none; border: 0; color: inherit; font: inherit; text-align: left; }
  background: var(--ex-gold); color: #1A1300;
  font-family: var(--ex-mono); font-size: 8.5px; font-weight: 700; letter-spacing: .1em; }
.op-trk-choice { display: flex; flex-direction: column; gap: 2px; }

/* L INTERRUTTORE GENERALE della chiusura automatica. Separato da una riga e volutamente piu spento dei
   comandi sopra: e un comando che vale per TUTTI i mercati, quindi non deve sembrare l ovvio passo
   successivo di quello per il singolo mercato che ha appena sopra. */
.op-ac-master { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--ex-line-soft); }
.op-ac-master-k { display: block; font-size: 10px; color: var(--ex-txt-3); line-height: 1.5; }

/* ══ IL FOGLIO RAPIDO ═════════════════════════════════════════════════════════════════════════════
   Stesse variabili, stessi bordi, stesse pillole del resto del pannello: e la stessa schermata in una
   forma piu corta. Nessun colore nuovo — solo i token gia definiti in cima a questo foglio. */
.op-qs-scrim { position: absolute; inset: 0; z-index: 20; background: rgba(0,0,0,.62);
  display: flex; align-items: flex-end; justify-content: center; }
.op-qs { width: 100%; max-height: 94%; display: flex; flex-direction: column;
  background: var(--ex-bg); border: 1px solid var(--ex-line); border-top-color: var(--ex-gold-bd);
  border-radius: 14px 14px 0 0; box-shadow: 0 -10px 40px rgba(0,0,0,.55); }
/* La maniglia: dice «questo sale dal basso e si puo chiudere» senza scriverlo. */
.op-qs-grab { width: 38px; height: 4px; border-radius: 999px; background: var(--ex-line);
  margin: 8px auto 2px; flex: 0 0 auto; }
.op-qs-head { display: flex; align-items: flex-start; gap: 10px; padding: 6px 14px 10px;
  border-bottom: 1px solid var(--ex-line); flex: 0 0 auto; }
.op-qs-h-txt { min-width: 0; flex: 1 1 auto; }
.op-qs-t { font-size: 14px; font-weight: 700; line-height: 1.25; }
.op-qs-s { margin-top: 3px; font-size: 10.5px; color: var(--ex-txt-3); }
.op-qs-body { overflow-y: auto; padding: 12px 14px 4px; flex: 1 1 auto; }
.op-qs-actions { display: flex; gap: 8px; padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--ex-line); background: var(--ex-panel); flex: 0 0 auto; }
.op-qs-actions .op-primary { flex: 1 1 auto; min-height: 46px; }
.op-qs-actions .op-back { flex: 0 0 auto; min-height: 46px; }

.op-qs-slider { width: 100%; margin-top: 8px; accent-color: var(--ex-gold); height: 30px; }
.op-qs-ends { display: flex; justify-content: space-between; font-size: 9.5px; color: var(--ex-txt-3);
  font-family: var(--ex-mono); }
.op-qs-out { margin-top: 6px; font-family: var(--ex-mono); font-size: 13px; }

/* LO STEPPER: due bersagli da 44px e il valore al centro. Niente campo libero — un numero scritto a
   mano invita a valori che il tick non puo esprimere, e qui il tick e un blocco vero. */
.op-qs-step { display: flex; align-items: stretch; gap: 8px; margin-top: 6px; }
.op-qs-btn { flex: 0 0 auto; width: 52px; min-height: 44px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--ex-line); background: var(--ex-panel-2); color: var(--ex-txt);
  font-size: 20px; line-height: 1; }
.op-qs-btn:hover { border-color: var(--ex-gold); color: var(--ex-gold); }
.op-qs-val { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid var(--ex-line); border-radius: 8px; background: var(--ex-panel);
  font-family: var(--ex-mono); font-size: 15px; min-height: 44px; }
.op-qs-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
.op-qs-toggle { width: 100%; min-height: 44px; margin-top: 6px; }
.op-trk-q { font-size: 11.5px; color: var(--ex-txt-2); margin-top: 8px; }
/* Il callout spiega A PAROLE cosa misura il campo: «offset» da solo non dice da cosa, e soprattutto non
   dice che qui si parla di ordini VERI mentre il cursore qui sopra parla solo di righe guardate. */

/* ── COMPATTEZZA SENZA TAGLIARE NIENTE ───────────────────────────────────────────────────────────
   Il pannello sta in una schermata di telefono per DIMENSIONI (font e padding ridotti, griglia dei
   dati di mercato piu' fitta), non perche' qualcuno gli abbia bloccato l'altezza con overflow:hidden.
   Quel trucco fa entrare tutto su un viewport e TAGLIA VIA il fondo su un altro, e il contenuto
   tagliato non ha nemmeno lo scroll per essere raggiunto. Qui lo scroll resta sempre disponibile:
   se il contenuto non entra, scorre. */
@media (max-height: 720px) {
  .op-sheet { max-height: 96vh; }
  .op-head { padding: 9px 12px; }
  .op-title { font-size: 13px; }
  .op-body { padding: 9px 12px; }
  .op-field { margin-bottom: 9px; }
  .op-notional { padding: 8px 10px; margin: 9px 0; }
  .op-notional-v { font-size: 17px; }
  .op-segb { min-height: 40px; font-size: 12px; }
}

  border-top: 1px solid var(--ex-line); background: var(--ex-panel); }
.op-primary { flex: 1 1 auto; }
.op-back { flex: 0 0 auto; }

@media (min-width: 620px) {
  .op-scrim { align-items: center; }
  .op-sheet { border-radius: 12px; }
}
`;

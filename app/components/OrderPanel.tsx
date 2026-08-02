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
import { planQuotes } from '@/lib/maker/mm-quote-math';
// Le STESSE funzioni pure che la route usa per costruire la vista del book: distanza dal mid, righe
// bloccate dal filtro e verdetto sul prezzo. Sono in un modulo condiviso e coperto da test proprio perche'
// il pannello non possa dare una risposta diversa dal server sulla stessa domanda.
import { distanceCents, levelBlocked, priceVerdict } from '@/lib/maker/book-view';

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
interface TrackPreview { ok: boolean; error?: string; plan?: { ok: boolean; reason: string | null; yes: TrackSide | null; no: TrackSide | null }; rules?: { mid: number | null; tick: number | null; bandRadiusCents: number | null }; restingOrders?: Array<{ orderId: string | null; price: number | null; size: number | null }>; note?: string }
interface TrackRecord { marketId: string; offsetCents: number; minMoveCents: number; sizeShares: number; atIso: string | null }
interface PlaceResult {
  ok: boolean; sent: boolean; dryRun?: boolean; placement?: string;
  gate: string | null; reason: string | null; orderId?: string | null; notionalUsd?: number | null;
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

export default function OrderPanel({ target, balanceUsd, onClose, onEnabled }: {
  target: OrderTarget;
  balanceUsd: number | null;
  onClose: () => void;
  onEnabled?: (marketId: string) => void;
}) {
  const [cfg, setCfg] = useState<ManualCfg | null>(null);
  const [book, setBook] = useState<'yes' | 'no'>('yes');
  const [sizeStr, setSizeStr] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [autoRenew, setAutoRenew] = useState(true);
  const [step, setStep] = useState<'form' | 'review'>('form');
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
  // ── IL FILTRO «DISTANZA MINIMA DAL MID» ────────────────────────────────────────────────────────
  // Quotare attaccati al mid massimizza i premi e massimizza anche la probabilita' di essere presi
  // proprio quando il prezzo si sta muovendo contro. Questo cursore rende quella scelta esplicita:
  // sotto la soglia le righe restano VISIBILI — si deve poter vedere dove sta la liquidita' che si sta
  // rinunciando a toccare — ma diventano inerti, cosi' un tocco distratto non puo' compilarle.
  // Default 2¢: dentro la banda tipica da ±2.25¢ resta un margine operabile, e non e' zero.
  const [minDistC, setMinDistC] = useState(2);
  // La riga toccata, tenuta per prezzo e non per indice: il book si riordina a ogni aggiornamento, e un
  // indice evidenzierebbe la riga sbagliata un secondo dopo.
  const [pickedPrice, setPickedPrice] = useState<number | null>(null);
  // ── IL TRACKING ATTIVO ─────────────────────────────────────────────────────────────────────────
  // L'unico punto di questo progetto in cui due tocchi comprano una DELEGA CONTINUATA invece di un
  // singolo ordine. Per questo ha un passo di revisione suo, separato da quello del piazzamento a mano:
  // le due conferme autorizzano cose diverse e non devono poter essere confuse l'una con l'altra.
  const [trkOpen, setTrkOpen] = useState(false);
  const [trkOffset, setTrkOffset] = useState('');
  const [trkMinMove, setTrkMinMove] = useState('');
  const [trkStep, setTrkStep] = useState<'form' | 'review'>('form');
  const [trkBusy, setTrkBusy] = useState(false);
  const [trkPreview, setTrkPreview] = useState<TrackPreview | null>(null);
  const [trkMsg, setTrkMsg] = useState<string | null>(null);
  const [trkActive, setTrkActive] = useState<TrackRecord | null>(null);
  const [trkOffStep, setTrkOffStep] = useState<'idle' | 'choose'>('idle');
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
  useEffect(() => {
    const s = fin(target.presetSize) && (target.presetSize as number) > 0 ? (target.presetSize as number) : target.minSize;
    setSizeStr(fin(s) ? String(+(s as number).toFixed(4)) : '');
    const p = fin(target.mid) && fin(target.tick) && (target.tick as number) > 0
      ? snapToTick(target.mid as number, target.tick as number) : target.mid;
    setPriceStr(fin(p) ? String(p) : '');
    setStep('form'); setResult(null); setEnableMsg(null);
    setIsEnabled(target.enabled);
    // Mercato nuovo, pannello nuovo: le bandierine ripartono da zero, altrimenti un prezzo toccato su
    // un mercato bloccherebbe la precompilazione su quello dopo.
    setPriceTouched(false); setSizeTouched(false);
    setQuote(null); setQuoteErr(null);
  }, [target]);

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
  const bookLive = quote?.source === 'live-book' && quote.live === true
    && fin(quoteAgeMs) && (quoteAgeMs as number) <= FRESH_BOOK_MAX_MS;

  // MENTRE LA SOTTOSCRIZIONE SI STA STABILENDO SI GUARDA SPESSO. Il ritmo da 12 secondi e' giusto per
  // Gamma a regime — e' una REST di terzi e non la si martella — ma nei primi secondi dopo l'apertura
  // stiamo aspettando che il feed prenda il mercato, e a 12 secondi il passaggio a «book live» arrivava
  // fino a 15 secondi dopo il tocco. Misurato: 15,4s, quasi tutti spesi ad aspettare il prossimo giro,
  // non il feed. Dentro la finestra di attesa si interroga ogni 2 secondi; appena il book e' live si
  // torna al ritmo normale.
  const settling = !bookLive && (lease === 'asking'
    || (lease === 'held' && leaseHeldSince.current != null && nowMs - leaseHeldSince.current < LEASE_CONNECT_GRACE_MS));
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
      if (mine) { setTrkOffset(String(mine.offsetCents)); setTrkMinMove(String(mine.minMoveCents)); }
    } catch { /* lo stato resta ignoto: la sezione lo dice invece di supporlo spento */ }
  }, [target.marketId]);
  useEffect(() => {
    setTrkOpen(false); setTrkStep('form'); setTrkPreview(null); setTrkMsg(null); setTrkOffStep('idle');
    setTrkOffset(''); setTrkMinMove(''); setTrkActive(null);
    loadTracking();
  }, [target.marketId, loadTracking]);

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

  const size = Number(sizeStr);
  const price = Number(priceStr);
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
          note: 'pannello ordine',
        }),
      });
      setResult((await r.json()) as PlaceResult);
    } catch (e) {
      setResult({ ok: false, sent: false, gate: 'request-failed', reason: (e as Error).message });
    } finally { setBusy(false); }
  }, [target.marketId, book, price, size, autoRenew, ttlSeconds]);

  const sends = cfg?.placement?.sends === true;


  // L'eta del prezzo, misurata dal momento della lettura piu l'attesa da allora. Sotto il secondo si
  // dice «adesso»: scrivere «0s fa» su un book websocket sarebbe vero ma illeggibile.
  const quoteAge = (() => {
    if (!quote) return quoteErr ? 'non letto' : 'in lettura…';
    // Mentre il permesso e' in corso e il prezzo arriva ancora da Gamma, si dice che si sta
    // collegando invece di far sembrare definitivo un ripiego che sta per essere sostituito.
    // «Mi sto collegando» vale finché il collegamento può ancora arrivare. Passata la finestra, il feed
    // quel mercato non lo copre — cap pieno, token non risolvibili, processo fermo — e continuare a dire
    // che ci si sta collegando sarebbe un'attesa che non finisce mai, cioè una bugia lenta. Da lì si dice
    // com'è: il dato è di ripiego, e viene da Gamma.
    const connecting = lease === 'asking'
      || (lease === 'held' && leaseHeldSince.current != null && nowMs - leaseHeldSince.current < LEASE_CONNECT_GRACE_MS);
    if (quote.source === 'gamma' && connecting) return 'connessione al book…';
    const ms = fin(quoteAgeMs) ? (quoteAgeMs as number) : 0;
    const src = quote.source === 'live-book' ? 'book live' : 'Gamma';
    if (ms < 1500) return `${src} · adesso`;
    if (ms < 60_000) return `${src} · ${Math.round(ms / 1000)}s fa`;
    return `${src} · ${Math.round(ms / 60_000)} min fa`;
  })();

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
              <span className={`ex-badge ${bookLive ? 'is-ok' : lease === 'failed' ? 'is-bad' : 'is-warn'}`}
                data-op-booklive={bookLive ? '1' : '0'} data-op-lease={lease}
                title={quote?.sourceNote ?? 'in attesa della prima quotazione'}>
                {bookLive ? 'book live' : lease === 'asking' ? 'collegamento…' : lease === 'failed' ? 'book NON live' : 'book non live'}
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

          {/* ── 2 · IL BOOK, VERTICALE, STILE EXCHANGE ────────────────────────────────────────────
              Ask in alto (rossi, dal piu' alto al piu' basso), la riga del mid al centro, bid sotto
              (verdi, dal piu' vicino al mid in giu'). Ogni riga porta prezzo, size a quel livello e
              cumulato; la barra di sfondo e' proporzionale alla size, cosi' dove c'e' liquidita' si vede
              senza leggere i numeri.

              TOCCARE UNA RIGA COMPILA IL PREZZO. Le righe sotto la soglia del cursore restano visibili
              ma barrate e inerti: il filtro non nasconde la liquidita', impedisce solo di sceglierla
              per sbaglio. */}
          <div className="op-book op-mb" data-op-book data-op-book-side={book}>
            <div className="op-book-top">
              <span className="op-book-t">Order book · <b className="ex-n">{book.toUpperCase()}</b></span>
              {/* QUANTO E VECCHIO QUESTO PREZZO fa parte del prezzo: un mid di 9 millisecondi e un mid
                  di due minuti non sono lo stesso fatto, e su un ciclo da cinque minuti la differenza
                  decide l ordine. Sta scritto qui invece di chiedere all operatore di fidarsi. */}
              <span className={`ex-badge ${bookLive ? 'is-ok' : 'is-warn'}`} data-op-freshness
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
                const blocked = levelBlocked(l.price, mid, minDistC);
                const d = distanceCents(l.price, mid);
                return (
                  <button key={`a${l.price}`} type="button"
                    className={`op-row is-ask ${blocked ? 'is-blocked' : ''} ${pickedPrice === l.price ? 'is-picked' : ''}`}
                    data-op-level="ask" data-op-level-price={l.price}
                    data-op-level-blocked={blocked ? '1' : '0'}
                    data-op-level-dist={d ?? ''}
                    disabled={blocked}
                    aria-disabled={blocked}
                    title={blocked
                      ? `${d?.toFixed(2)}¢ dal mid — sotto la soglia di ${minDistC.toFixed(2)}¢, non selezionabile`
                      : `usa ${cents(l.price)} (${d?.toFixed(2)}¢ dal mid)`}
                    onClick={() => {
                      if (blocked) return;
                      setPriceStr(String(l.price)); setPriceTouched(true); setPickedPrice(l.price); setStep('form');
                    }}>
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
                const blocked = levelBlocked(l.price, mid, minDistC);
                const d = distanceCents(l.price, mid);
                return (
                  <button key={`b${l.price}`} type="button"
                    className={`op-row is-bid ${blocked ? 'is-blocked' : ''} ${pickedPrice === l.price ? 'is-picked' : ''}`}
                    data-op-level="bid" data-op-level-price={l.price}
                    data-op-level-blocked={blocked ? '1' : '0'}
                    data-op-level-dist={d ?? ''}
                    disabled={blocked}
                    aria-disabled={blocked}
                    title={blocked
                      ? `${d?.toFixed(2)}¢ dal mid — sotto la soglia di ${minDistC.toFixed(2)}¢, non selezionabile`
                      : `usa ${cents(l.price)} (${d?.toFixed(2)}¢ dal mid)`}
                    onClick={() => {
                      if (blocked) return;
                      setPriceStr(String(l.price)); setPriceTouched(true); setPickedPrice(l.price); setStep('form');
                    }}>
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

          {/* ── FILTRO DISTANZA MINIMA DAL MID ────────────────────────────────────────────────────
              Agisce sul book qui sopra IN TEMPO REALE. Il valore sta scritto in cifre accanto
              all'etichetta: un cursore senza il suo numero e' una preferenza, non un'impostazione. */}
          <div className="op-field" data-op-dist-field>
            <div className="op-label">
              <span>Distanza minima dal prezzo medio (mid)</span>
              <span className="op-labelhint"><b className="ex-gold" data-op-dist-value>{minDistC.toFixed(2)}¢</b></span>
            </div>
            <input className="op-slider" type="range" min={0} max={6} step={0.25}
              value={minDistC} data-op-dist-slider
              aria-label="Distanza minima dal prezzo medio (mid)"
              onChange={(e) => setMinDistC(Number(e.target.value))} />
            <div className="op-hint">
              Le righe a meno di <b className="ex-n">{minDistC.toFixed(2)}¢</b> dal mid restano visibili ma
              barrate e non selezionabili. Quotare attaccati al mid rende di più e riempie prima, anche
              quando il prezzo si sta muovendo contro.
            </div>
          </div>
          {quoteErr && (
            <p className="ex-flag is-dim op-mb" data-op-quote-error>
              <span className="ex-flag-i" aria-hidden="true">ⓘ</span>
              <span>ultimo aggiornamento non riuscito ({quoteErr}) — i numeri qui sopra restano l&apos;ultima lettura buona, non sono stati azzerati</span>
            </p>
          )}

          {/* ── TRACKING ATTIVO (market making a due lati) ────────────────────────────────────────
              SUBITO SOTTO I DATI DI MERCATO, e prima del piazzamento a mano. L'ordine conta: i due
              campi di questa sezione — offset e soglia — si leggono CONTRO mid, tick e banda che stanno
              appena sopra, e metterli in fondo obbligava a scorrere avanti e indietro per compilarli.
              Il piazzamento a un lato viene dopo perche' e' l'alternativa, non il passo successivo.

              Ha un doppio passo suo, separato da quello del piazzamento manuale, perche' autorizza una
              cosa diversa: non un ordine, ma una delega continuata a piazzarne finche' resta accesa. */}
          <div className="op-trk" data-op-tracking>
            <button className="op-trk-head" onClick={() => setTrkOpen((v) => !v)} data-op-trk-toggle aria-expanded={trkOpen}>
              <span className="op-trk-t">
                Tracking attivo <span className="ex-dim">· market making a due lati</span>
              </span>
              <span className={`ex-badge ${trkActive ? 'is-gold' : ''}`} data-op-trk-state={trkActive ? 'on' : 'off'}>
                {trkActive ? 'ATTIVO' : 'spento'}
              </span>
              <span className="op-trk-caret" aria-hidden="true">{trkOpen ? '▾' : '▸'}</span>
            </button>

            {trkOpen && (
              <div className="op-trk-body">
                {trkActive ? (
                  <>
                    <div className="ex-kvs op-mb" data-op-trk-active>
                      <div className="ex-kv"><span className="ex-kv-k">offset</span><span className="ex-kv-v">{trkActive.offsetCents}¢</span></div>
                      <div className="ex-kv"><span className="ex-kv-k">soglia</span><span className="ex-kv-v">{trkActive.minMoveCents}¢</span></div>
                      <div className="ex-kv"><span className="ex-kv-k">size</span><span className="ex-kv-v">{trkActive.sizeShares}</span></div>
                      <div className="ex-kv"><span className="ex-kv-k">dalle</span><span className="ex-kv-v">{trkActive.atIso ? new Date(trkActive.atIso).toLocaleTimeString() : 'N/D'}</span></div>
                    </div>
                    <p className="op-hint">
                      Su questo mercato il motore quota entrambi i lati e li insegue da solo, senza chiedere
                      conferma ordine per ordine. Il kill-switch, il tetto per ordine e la soglia dei 3 minuti
                      dalla chiusura restano tutti in vigore.
                    </p>
                    {trkOffStep === 'idle' ? (
                      <button className="ex-btn is-danger op-trk-btn" onClick={() => setTrkOffStep('choose')} data-op-trk-off>
                        Disattiva il tracking
                      </button>
                    ) : (
                      /* DUE OPZIONI, NESSUN DEFAULT NASCOSTO. Cosa succede agli ordini gia' a riposo e'
                         una decisione dell'operatore, non una conseguenza silenziosa dello spegnimento. */
                      <div className="op-trk-choice" data-op-trk-choice>
                        <div className="op-trk-q">Gli ordini gia&apos; a riposo su questo mercato:</div>
                        <button className="ex-btn is-danger op-trk-btn" disabled={trkBusy}
                          onClick={async () => { const r = await trkCall({ enabled: false, preview: false, cancelOrders: true }); setTrkMsg(r.note ?? r.error ?? null); if (r.ok) { setTrkActive(null); setTrkOffStep('idle'); } }}
                          data-op-trk-off-cancel>
                          Spegni e CANCELLA gli ordini
                        </button>
                        <button className="ex-btn op-trk-btn" disabled={trkBusy}
                          onClick={async () => { const r = await trkCall({ enabled: false, preview: false, cancelOrders: false }); setTrkMsg(r.note ?? r.error ?? null); if (r.ok) { setTrkActive(null); setTrkOffStep('idle'); } }}
                          data-op-trk-off-leave>
                          Spegni e lasciali scadere per GTD
                        </button>
                        <button className="ex-link op-trk-btn" onClick={() => setTrkOffStep('idle')}>annulla</button>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="op-trk-grid">
                      <label className="op-field">
                        <span className="op-label">Offset <span className="op-labelhint">¢</span></span>
                        <span className="op-trk-callout" data-op-trk-callout>↑ distanza dal prezzo medio (mid)</span>
                        <input className="ex-input op-input" type="number" inputMode="decimal" step="0.1"
                          value={trkOffset} placeholder={fin(maxSpreadCents) ? String(+(maxSpreadCents / 2).toFixed(2)) : '2'}
                          onChange={(e) => { setTrkOffset(e.target.value); setTrkStep('form'); setTrkPreview(null); }}
                          data-op-trk-offset />
                      </label>
                      <label className="op-field">
                        <span className="op-label">Soglia di movimento <span className="op-labelhint">¢</span></span>
                        <span className="op-trk-callout">↑ quanto deve muoversi il mid per riprezzare</span>
                        <input className="ex-input op-input" type="number" inputMode="decimal" step="0.1"
                          value={trkMinMove} placeholder={fin(tick) ? String(+(tick * 100).toFixed(2)) : '1'}
                          onChange={(e) => { setTrkMinMove(e.target.value); setTrkStep('form'); setTrkPreview(null); }}
                          data-op-trk-minmove />
                      </label>
                    </div>
                    <p className="op-hint">
                      Size: <b className="ex-n">{sizeStr || 'N/D'}</b> share per lato — la stessa del campo qui sopra.
                      {fin(maxSpreadCents) && <> Raggio premiante <b className="ex-n">{(maxSpreadCents / 2).toFixed(2)}¢</b>: un offset piu&apos; largo mette quel lato fuori banda.</>}
                    </p>

                    {/* ANTEPRIMA CALCOLATA IN LOCALE, prima ancora del primo passo: dove finirebbero i
                        due ordini col mid di adesso. Usa la stessa funzione del motore. */}
                    {(() => {
                      const off = Number(trkOffset);
                      // `engineMid`, NON il mid del lato che si sta guardando. Il tracking quota
                      // entrambi i lati a partire dal mid del book YES, ed e' il mid di SCORING quello
                      // che il motore usa davvero: l'anteprima deve mostrare i prezzi che verrebbero
                      // piazzati, non quelli che si otterrebbero da un mid diverso. Da quando il pannello
                      // disegna il book del lato selezionato, `mid` cambia col toggle YES/NO — e passarlo
                      // qui avrebbe fatto ribaltare l'anteprima insieme al toggle.
                      if (!fin(off) || off <= 0 || !fin(engineMid) || !fin(tick)) return null;
                      const p = planQuotes({ mid: engineMid, offsetCents: off, tick, bandRadiusCents: maxSpreadCents != null ? maxSpreadCents / 2 : null });
                      if (!p.ok) return <p className="ex-flag is-bad"><span className="ex-flag-i">⚠</span><span>{p.reason}</span></p>;
                      return (
                        <div className="op-trk-prev" data-op-trk-preview>
                          {(['yes', 'no'] as const).map((k) => {
                            const q = p[k];
                            if (!q) return null;
                            return (
                              <div key={k} className="op-trk-leg" data-op-trk-leg={k}>
                                <span className={`ex-side ${k === 'yes' ? 'is-yes' : 'is-no'}`}>BUY {k.toUpperCase()}</span>
                                <span className="ex-n op-trk-px">{q.placeable ? `${q.priceCents}¢` : 'N/D'}</span>
                                {k === 'no' && q.placeable && <span className="ex-dim">= vendi YES a {(100 - (q.priceCents as number)).toFixed(1)}¢</span>}
                                {q.inBand === false && <span className="ex-badge is-warn" data-op-trk-outband>fuori banda — nessun reward su questo lato</span>}
                                {q.inBand === true && <span className="ex-badge is-ok">in banda</span>}
                                {!q.placeable && <span className="ex-badge is-bad">{q.reason}</span>}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}

                    {trkStep === 'review' && trkPreview?.plan && (
                      <div className="op-review" data-op-trk-review>
                        <div className="op-review-h">Rivedi la configurazione prima di attivare</div>
                        <div className="ex-kvs">
                          <div className="ex-kv"><span className="ex-kv-k">mercato</span><span className="ex-kv-v op-wrap">{target.title}</span></div>
                          <div className="ex-kv"><span className="ex-kv-k">offset</span><span className="ex-kv-v">{trkOffset}¢</span></div>
                          <div className="ex-kv"><span className="ex-kv-k">soglia</span><span className="ex-kv-v">{trkMinMove}¢</span></div>
                          <div className="ex-kv"><span className="ex-kv-k">size/lato</span><span className="ex-kv-v">{sizeStr}</span></div>
                          <div className="ex-kv"><span className="ex-kv-k">BUY YES</span><span className="ex-kv-v">{trkPreview.plan.yes?.priceCents ?? 'N/D'}¢</span></div>
                          <div className="ex-kv"><span className="ex-kv-k">BUY NO</span><span className="ex-kv-v">{trkPreview.plan.no?.priceCents ?? 'N/D'}¢</span></div>
                        </div>
                        <p className="op-hint">
                          Attivando, il motore piazza e riprezza da solo su questo mercato finche&apos; non lo
                          spegni: <b>niente conferma ordine per ordine</b>. Restano in vigore kill-switch, tetto
                          per ordine, gestione manuale e il blocco a 3 minuti dalla chiusura.
                        </p>
                      </div>
                    )}

                    {trkStep === 'form' ? (
                      <button className="ex-btn is-gold op-trk-btn" // `Number('')` vale 0, che e' finito: controllare solo la finitezza rendeva il pulsante premibile a
                        // campi vuoti, e il rifiuto sarebbe arrivato dal server invece che dallo schermo.
                        disabled={trkBusy || !(Number(trkOffset) > 0) || !(Number(trkMinMove) > 0) || !(size > 0)}
                        onClick={async () => {
                          const r = await trkCall({ enabled: true, preview: true, offsetCents: Number(trkOffset), minMoveCents: Number(trkMinMove), sizeShares: size });
                          if (r.ok) { setTrkPreview(r); setTrkStep('review'); } else setTrkMsg(r.error ?? 'anteprima non riuscita');
                        }}
                        data-op-trk-review-btn>
                        {trkBusy ? 'Calcolo…' : 'Rivedi configurazione'}
                      </button>
                    ) : (
                      <div className="op-trk-choice">
                        <button className="ex-btn op-trk-btn" onClick={() => setTrkStep('form')} data-op-trk-back>Modifica</button>
                        <button className="ex-btn is-danger op-trk-btn" disabled={trkBusy}
                          onClick={async () => {
                            const r = await trkCall({ enabled: true, preview: false, offsetCents: Number(trkOffset), minMoveCents: Number(trkMinMove), sizeShares: size });
                            setTrkMsg(r.note ?? r.error ?? null);
                            if (r.ok) { setTrkActive((r as { record?: TrackRecord }).record ?? null); setTrkStep('form'); }
                          }}
                          data-op-trk-activate>
                          {trkBusy ? 'Attivo…' : 'Attiva tracking'}
                        </button>
                      </div>
                    )}
                  </>
                )}
                {trkMsg && <div className="ex-banner op-mb" data-op-trk-msg>{trkMsg}</div>}
              </div>
            )}
          </div>

          {/* ── PIAZZAMENTO MANUALE A UN LATO ─────────────────────────────────────────────────────
              L'alternativa al tracking: un ordine solo, su un lato solo, deciso adesso. */}
          <div className="op-sech" data-op-manual-section>Piazzamento manuale a un lato</div>

          {/* ── 3 · LATO ──────────────────────────────────────────────────────────────────────── */}
          <div className="op-field">
            <div className="op-label">Lato</div>
            <div className="op-seg" role="group" aria-label="Book">
              <button className={`op-segb ${book === 'yes' ? 'is-yes' : ''}`} onClick={() => setBook('yes')} data-op-book="yes">BUY YES</button>
              <button className={`op-segb ${book === 'no' ? 'is-no' : ''}`} onClick={() => setBook('no')} data-op-book="no">BUY NO</button>
            </div>
            {/* Onestà su cosa questo percorso può fare: una VENDITA consegna il token, quindi richiede di
                possederlo, e l'endpoint manuale non accetta il lato SELL. Comprare NO è il modo con cui
                un maker a collaterale offre l'altro lato. */}
            <div className="op-hint">
              Solo acquisti: una vendita consegna il token e richiede di possederlo. «BUY NO a q» è
              l&apos;equivalente di «vendi YES a 1−q».
            </div>
          </div>

          {/* ── 4 · SIZE ──────────────────────────────────────────────────────────────────────── */}
          <div className="op-field">
            <div className="op-label">
              Size (share)
              <span className="op-labelhint">
                min. premiante {minSize ?? 'N/D'}
                {fin(target.presetSize) ? ` · precompilata dal piano` : ''}
              </span>
            </div>
            <input className={`ex-input op-input ${problems.some((p) => p.key === 'minsize' || p.key === 'size') ? 'is-bad' : ''}`}
              type="number" inputMode="decimal" value={sizeStr} data-op-size
              onChange={(e) => { setSizeStr(e.target.value); setSizeTouched(true); setStep('form'); }} />
            {fin(minSize) && (
              <button className="ex-link op-fix" onClick={() => { setSizeStr(String(minSize)); setSizeTouched(true); }} data-op-use-min>usa il minimo</button>
            )}
          </div>

          {/* ── 5 · PREZZO ────────────────────────────────────────────────────────────────────── */}
          <div className="op-field">
            <div className="op-label">
              Prezzo
              <span className="op-labelhint">
                tick {tick ?? 'N/D'} · mid {cents(mid)}
                {priceTouched && <b className="ex-gold"> · prezzo tuo, non lo tocchiamo</b>}
              </span>
            </div>
            <input className={`ex-input op-input ${problems.some((p) => p.key === 'tick' || p.key === 'price') ? 'is-bad' : ''}`}
              type="number" inputMode="decimal" step={tick ?? 0.01} value={priceStr} data-op-price
              data-op-price-touched={priceTouched ? '1' : '0'}
              onChange={(e) => { setPriceStr(e.target.value); setPriceTouched(true); setStep('form'); }} />
            {fin(tick) && fin(price) && !onTick(price, tick as number) && (
              <button className="ex-link op-fix" onClick={() => { setPriceStr(String(snapToTick(price, tick as number))); setPriceTouched(true); }} data-op-use-tick>
                usa {snapToTick(price, tick as number)}
              </button>
            )}

            {/* ── L'AVVISO CHE SI AGGIORNA A OGNI MODIFICA ────────────────────────────────────────
                Sia che il prezzo arrivi da un tocco sul book sia che venga digitato: e' lo stesso
                stato, quindi e' lo stesso avviso. Rosso = l'ordine non farebbe quello che sembra
                (incrocia, quindi esegue subito) o non matura premi. Verde = resta sul book come
                maker, dentro la banda. */}
            {verdict && (
              <div className={`op-verdict ${verdict.level === 'ok' ? 'is-ok' : verdict.level === 'bad' ? 'is-bad' : 'is-unk'}`}
                data-op-price-verdict={verdict.level}
                data-op-verdict-crosses={verdict.crosses ? '1' : '0'}
                data-op-verdict-outofband={verdict.outOfBand === null ? '' : verdict.outOfBand ? '1' : '0'}
                role="status" aria-live="polite">
                <span className="op-verdict-i" aria-hidden="true">
                  {verdict.level === 'ok' ? '✓' : verdict.level === 'bad' ? '⛔' : 'ⓘ'}
                </span>
                <span className="op-verdict-tx">
                  {verdict.messages.map((m, i) => <span key={i} className="op-verdict-l">{m}</span>)}
                </span>
              </div>
            )}
          </div>

          {/* ── 6 · DURATA ────────────────────────────────────────────────────────────────────── */}
          <div className="op-field">
            <div className="op-label">Durata</div>
            <div className="op-hint" data-op-ttl>
              GTD <b className="ex-n">{Math.round(ttlSeconds / 60)} min</b>
              {repriceOn && autoRenew ? (
                <> · <b>rinnovo automatico attivo</b>: si rinnova {Math.round((refreshMargin ?? 180) / 60)} minuti prima della scadenza</>
              ) : (
                <> · one-shot: nessun rinnovo, l&apos;ordine scade e basta</>
              )}
            </div>
            {repriceOn && (
              <label className="op-check">
                <input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} data-op-autorenew />
                <span>lascia il rinnovo automatico su questo ordine</span>
              </label>
            )}
          </div>

          {/* ── 7 · CONTROVALORE ──────────────────────────────────────────────────────────────── */}
          <div className="op-notional" data-op-notional>
            <span className="op-label">Controvalore</span>
            <span className="op-notional-v ex-n">{money(notional)}</span>
            {fin(cfg?.caps?.effectiveOrderCapUsd) && <span className="op-hint">tetto per ordine {money(cfg!.caps.effectiveOrderCapUsd)}</span>}
          </div>

          {/* ── 8 · AVVISI ────────────────────────────────────────────────────────────────────── */}
          {problems.length > 0 && (
            <div className="op-probs" data-op-problems>
              {problems.map((p) => (
                <p key={p.key} className={`ex-flag ${p.blocking ? 'is-bad' : ''}`} data-op-problem={p.key}>
                  <span className="ex-flag-i" aria-hidden="true">{p.blocking ? '⛔' : '⚠'}</span>
                  <span>{p.text}</span>
                </p>
              ))}
            </div>
          )}

          {/* ── 9 · RIEPILOGO ─────────────────────────────────────────────────────────────────── */}
          {step === 'review' && (
            <div className="op-review" data-op-review>
              <div className="op-review-h">Rivedi prima di confermare</div>
              <div className="ex-kvs">
                <div className="ex-kv"><span className="ex-kv-k">mercato</span><span className="ex-kv-v op-wrap">{target.title}</span></div>
                <div className="ex-kv"><span className="ex-kv-k">lato</span><span className="ex-kv-v">BUY {book.toUpperCase()}</span></div>
                <div className="ex-kv"><span className="ex-kv-k">size</span><span className="ex-kv-v">{size}</span></div>
                <div className="ex-kv"><span className="ex-kv-k">prezzo</span><span className="ex-kv-v">{price}</span></div>
                <div className="ex-kv"><span className="ex-kv-k">controvalore</span><span className="ex-kv-v">{money(notional)}</span></div>
                <div className="ex-kv"><span className="ex-kv-k">durata</span><span className="ex-kv-v">GTD {Math.round(ttlSeconds / 60)}m</span></div>
              </div>
            </div>
          )}

          {/* ── ESITO ─────────────────────────────────────────────────────────────────────────── */}
          {result && (
            <div className={`ex-banner ${result.ok ? (result.sent ? 'is-ok' : 'is-warn') : 'is-bad'} op-mb`} data-op-result>
              {result.ok ? (
                result.sent
                  ? <><b>ORDINE INVIATO AL VENUE.</b>{result.orderId ? <> orderId <span className="ex-n">{result.orderId}</span></> : null}</>
                  : <><b data-op-dryrun>DRY-RUN — nessun ordine reale piazzato.</b> L&apos;ordine è stato costruito, firmato e validato dal venue, poi scartato (placement={result.placement ?? 'dry-run'}).</>
              ) : (
                <><b>Rifiutato al gate {result.gate ?? '—'}</b>: {result.reason ?? '—'}</>
              )}
            </div>
          )}
        </div>

        {/* ── 10 · LE DUE AZIONI, in fondo e sempre visibili ───────────────────────────────────── */}
        <div className="op-actions">
          {step === 'form' ? (
            <button className="ex-btn is-gold op-primary" disabled={!canReview} onClick={() => setStep('review')} data-op-review-btn>
              Rivedi ordine
            </button>
          ) : (
            <>
              <button className="ex-btn op-back" onClick={() => setStep('form')} data-op-back>Modifica</button>
              <button
                className={`ex-btn op-primary ${sends ? 'is-danger' : 'is-gold'}`}
                disabled={busy || !canReview}
                onClick={place}
                data-op-confirm
                data-op-sends={sends ? '1' : '0'}
              >
                {busy ? 'Invio…' : sends ? 'Conferma e piazza — INVIA DAVVERO' : 'Conferma e piazza (dry-run)'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// NOTE: niente virgolette, angolari o e-commerciali in questo foglio — React li serializza diversi fra
// server e client dentro un tag style, e la differenza costa l idratazione dell intera pagina.
const CSS = `
.op-scrim { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.6);
  display: flex; align-items: flex-end; justify-content: center; backdrop-filter: blur(2px); }
.op-sheet { width: 100%; max-width: 560px; max-height: 92vh; display: flex; flex-direction: column;
  background: var(--ex-bg); border: 1px solid var(--ex-line); border-radius: 12px 12px 0 0;
  box-shadow: 0 -8px 40px rgba(0,0,0,.6); }
.op-head { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px;
  border-bottom: 1px solid var(--ex-line); }
.op-head-txt { min-width: 0; flex: 1 1 auto; }
.op-title { font-size: 14px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
.op-sub { margin-top: 5px; font-size: 11px; color: var(--ex-txt-3); line-height: 1.9; overflow-wrap: anywhere; }
.op-id { margin-top: 4px; font-size: 9.5px; color: var(--ex-txt-3); word-break: break-all; }
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

/* ── IL BOOK ─────────────────────────────────────────────────────────────────────────────────────
   Griglia a tre colonne: prezzo a sinistra, size e cumulato allineati a destra. Tutte le cifre in
   monospazio, cosi le colonne restano incolonnate mentre i numeri cambiano.
   NIENTE altezza bloccata e niente overflow:hidden sul contenitore: il book cresce e la scheda scorre.
   Un book tagliato a meta non e piu compatto, e semplicemente un book che mente. */
.op-book { border: 1px solid var(--ex-line); border-radius: 8px; background: var(--ex-panel); overflow: hidden; }
.op-book-top { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid var(--ex-line-soft); flex-wrap: wrap; }
.op-book-t { font-size: 11.5px; font-weight: 600; color: var(--ex-txt-2); }
.op-book-hd { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; padding: 5px 10px;
  font-size: 9.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--ex-txt-3);
  border-bottom: 1px solid var(--ex-line-soft); }
.op-book-hd span:nth-child(2), .op-book-hd span:nth-child(3) { text-align: right; min-width: 62px; }
.op-book-side { display: flex; flex-direction: column; }
.op-book-empty { padding: 9px 10px; font-size: 10.5px; color: var(--ex-txt-3); }

/* La riga e un BOTTONE: tocco, tastiera e stato disabilitato arrivano gratis e sono quelli veri del
   browser, non un div che finge. */
/* ALTEZZA DELLA RIGA: 34px col mouse, 44px col dito.
   Una scala di book vive di densita: dieci righe da 44px sarebbero 440px e spingerebbero la riga del mid
   fuori da uno schermo da 640. Ma la riga E un comando — si tocca per compilare il prezzo — e su un dito
   32px sono sotto la soglia di errore. Quindi la densita resta dov e utile (puntatore fine) e il bersaglio
   cresce dove serve (puntatore grosso), invece di scegliere una taglia sola sbagliata per meta dei casi. */
.op-row { position: relative; display: grid; grid-template-columns: 1fr auto auto; gap: 10px;
  align-items: center; width: 100%; padding: 0 10px; min-height: 34px; cursor: pointer;
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

/* SOTTO SOGLIA: visibile, barrata, inerte. Si deve poter vedere la liquidita a cui si sta rinunciando;
   quello che non si deve poter fare e sceglierla per sbaglio. */
.op-row.is-blocked { opacity: .32; cursor: not-allowed; pointer-events: none; }
.op-row.is-blocked .op-row-p { text-decoration: line-through; }
@media (pointer: coarse) {
  .op-row { min-height: 44px; }
  .op-slider { height: 44px; }
}

.op-book-mid { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  padding: 7px 10px; background: var(--ex-gold-bg);
  border-top: 1px solid var(--ex-gold-bd); border-bottom: 1px solid var(--ex-gold-bd); }
.op-book-mid-v { font-family: var(--ex-mono); font-size: 16px; font-weight: 700; color: var(--ex-gold); }
.op-book-mid-k { font-size: 10px; color: var(--ex-txt-2); flex: 1 1 auto; }
.op-book-mid-s { font-family: var(--ex-mono); font-size: 10.5px; color: var(--ex-txt-2); }
.op-book-foot { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 8px 10px;
  border-top: 1px solid var(--ex-line-soft); font-size: 10px; color: var(--ex-txt-3); }
.op-midnote-p { margin-bottom: 4px; }

/* ── IL CURSORE DELLA DISTANZA ── area di tocco piena, non un filo di 4px. */
.op-slider { width: 100%; margin-top: 8px; accent-color: var(--ex-gold); height: 26px; }

/* ── IL VERDETTO SUL PREZZO ── */
.op-verdict { display: flex; gap: 8px; align-items: flex-start; margin-top: 7px;
  padding: 8px 10px; border-radius: 6px; font-size: 11.5px; line-height: 1.45; border: 1px solid; }
.op-verdict-i { flex: 0 0 auto; }
.op-verdict-tx { display: flex; flex-direction: column; gap: 3px; }
.op-verdict.is-ok { color: var(--ex-green); border-color: var(--ex-green-bd); background: var(--ex-green-bg); }
.op-verdict.is-bad { color: var(--ex-red); border-color: var(--ex-red-bd); background: var(--ex-red-bg); }
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

.op-trk { border: 1px solid var(--ex-line); border-radius: 8px; margin: 12px 0; background: var(--ex-panel); }
.op-trk-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; cursor: pointer;
  background: none; border: 0; color: inherit; font: inherit; text-align: left; }
.op-trk-head:hover { background: rgba(240,185,11,.05); }
.op-trk-t { flex: 1 1 auto; font-size: 12.5px; font-weight: 600; }
.op-trk-caret { color: var(--ex-txt-3); font-size: 11px; }
.op-trk-body { padding: 0 12px 12px; border-top: 1px solid var(--ex-line-soft); }
.op-trk-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
.op-trk-btn { width: 100%; min-height: 44px; margin-top: 8px; }
.op-trk-choice { display: flex; flex-direction: column; gap: 2px; }
.op-trk-q { font-size: 11.5px; color: var(--ex-txt-2); margin-top: 8px; }
.op-trk-prev { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.op-trk-leg { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 11.5px; }
.op-trk-px { font-size: 14px; font-weight: 700; color: var(--ex-gold); }
/* Il callout spiega A PAROLE cosa misura il campo: «offset» da solo non dice da cosa. */
.op-trk-callout { display: block; font-size: 10px; color: var(--ex-gold); line-height: 1.35; margin-top: 3px; }
.op-sech { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--ex-txt-3);
  border-top: 1px solid var(--ex-line); padding-top: 10px; margin: 14px 0 2px; }

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
  .op-trk-body { padding: 0 10px 10px; }
  .op-notional { padding: 8px 10px; margin: 9px 0; }
  .op-notional-v { font-size: 17px; }
  .op-segb { min-height: 40px; font-size: 12px; }
  .op-actions .ex-btn { min-height: 44px; }
}
@media (max-width: 430px) { .op-trk-grid { grid-template-columns: 1fr; } }

.op-actions { display: flex; gap: 8px; padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--ex-line); background: var(--ex-panel); }
.op-actions .ex-btn { min-height: 48px; font-size: 14px; }
.op-primary { flex: 1 1 auto; }
.op-back { flex: 0 0 auto; }

@media (min-width: 620px) {
  .op-scrim { align-items: center; }
  .op-sheet { border-radius: 12px; }
}
`;

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
/** Quello che /api/maker/quote restituisce: i prezzi PIU' la loro provenienza e la loro eta'. */
interface Quote {
  marketId: string; title: string | null;
  mid: number | null; bestBid: number | null; bestAsk: number | null; spreadCents: number | null;
  tick: number | null; minSize: number | null; maxSpreadCents: number | null;
  source: 'live-book' | 'gamma'; sourceNote: string; live: boolean; ageMs: number | null;
}
interface PlaceResult {
  ok: boolean; sent: boolean; dryRun?: boolean; placement?: string;
  gate: string | null; reason: string | null; orderId?: string | null; notionalUsd?: number | null;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const money = (v: number | null | undefined, nd = 2): string => (fin(v) ? `$${v.toFixed(nd)}` : 'N/D');
const cents = (p: number | null | undefined): string => (fin(p) ? `${(p * 100).toFixed(1)}¢` : 'N/D');

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
  const quoteEveryMs = quote?.source === 'gamma' ? 12_000 : (closeSoon ? 3_000 : 8_000);

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
  const mid = pick(quote?.mid, target.mid);
  const bestBid = pick(quote?.bestBid, target.bestBid);
  const bestAsk = pick(quote?.bestAsk, target.bestAsk);
  const spreadCents = pick(quote?.spreadCents, target.spreadCents);
  const tick = pick(quote?.tick, target.tick);
  const minSize = pick(quote?.minSize, target.minSize);
  const maxSpreadCents = pick(quote?.maxSpreadCents, target.maxSpreadCents);

  // Il prezzo segue il mid SOLO finche l'operatore non lo ha toccato. Dal primo carattere digitato
  // il campo e suo e nessun aggiornamento lo tocca piu.
  useEffect(() => {
    if (priceTouched || !fin(mid)) return;
    const p = fin(tick) && (tick as number) > 0 ? snapToTick(mid as number, tick as number) : mid;
    setPriceStr(fin(p) ? String(p) : '');
  }, [mid, tick, priceTouched]);

  // Stessa regola per la size: se la soglia premiante arriva dalla quotazione e l'operatore non ha
  // scritto niente, il campo si allinea; se ha scritto, resta com'e.
  useEffect(() => {
    if (sizeTouched || fin(target.presetSize) || !fin(minSize)) return;
    setSizeStr(String(+(minSize as number).toFixed(4)));
  }, [minSize, sizeTouched, target.presetSize]);

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

  // ── IL PREZZO E' LIVE, SI' O NO ────────────────────────────────────────────────────────────────
  // Tre condizioni, tutte necessarie. `source` da solo non basta: il feed scrive nel suo snapshot anche i
  // book fermi, e infatti un mercato scaduto compare come «live-book» con un'eta' di trentasei minuti.
  // Verificato il 2026-08-01 sulla finestra 2:15PM-2:30PM.
  const quoteAgeMs = quote ? (fin(quote.ageMs) ? (quote.ageMs as number) : 0) + Math.max(0, nowMs - quoteAtMs.current) : null;
  const bookLive = quote?.source === 'live-book' && quote.live === true
    && fin(quoteAgeMs) && (quoteAgeMs as number) <= FRESH_BOOK_MAX_MS;

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

          {/* ── 2 · DATI DI MERCATO LIVE ──────────────────────────────────────────────────────── */}
          <div className="ex-stats op-mb" data-op-market-data>
            <div className="ex-stat">
              <span className="ex-stat-k">mid</span>
              <span className="ex-stat-v" data-op-mid>{cents(mid)}</span>
              {/* QUANTO E VECCHIO QUESTO PREZZO fa parte del prezzo: un mid di 9 millisecondi e un mid
                  di due minuti non sono lo stesso fatto, e su un ciclo da cinque minuti la differenza
                  decide l ordine. Sta scritto qui invece di chiedere all operatore di fidarsi. */}
              <span className="ex-stat-s" data-op-freshness title={quote?.sourceNote ?? 'in attesa della prima quotazione'}>
                {quoteAge}
              </span>
            </div>
            <div className="ex-stat"><span className="ex-stat-k">bid</span><span className="ex-stat-v ex-up" data-op-bid>{cents(bestBid)}</span></div>
            <div className="ex-stat"><span className="ex-stat-k">ask</span><span className="ex-stat-v ex-dn" data-op-ask>{cents(bestAsk)}</span></div>
            <div className="ex-stat"><span className="ex-stat-k">spread</span><span className="ex-stat-v" data-op-spread>{fin(spreadCents) ? `${spreadCents.toFixed(1)}¢` : 'N/D'}</span></div>
            <div className="ex-stat"><span className="ex-stat-k">tick</span><span className="ex-stat-v">{tick ?? 'N/D'}</span></div>
            <div className="ex-stat"><span className="ex-stat-k">size min</span><span className="ex-stat-v">{minSize ?? 'N/D'}</span></div>
            {fin(maxSpreadCents) && (
              <div className="ex-stat"><span className="ex-stat-k">banda</span><span className="ex-stat-v">{maxSpreadCents.toFixed(2)}¢</span></div>
            )}
            {fin(target.rewardsDailyRate) && (
              <div className="ex-stat"><span className="ex-stat-k">reward/g</span><span className="ex-stat-v ex-up">{money(target.rewardsDailyRate, 0)}</span></div>
            )}
          </div>
          {quoteErr && (
            <p className="ex-flag is-dim op-mb" data-op-quote-error>
              <span className="ex-flag-i" aria-hidden="true">ⓘ</span>
              <span>ultimo aggiornamento non riuscito ({quoteErr}) — i numeri qui sopra restano l&apos;ultima lettura buona, non sono stati azzerati</span>
            </p>
          )}

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

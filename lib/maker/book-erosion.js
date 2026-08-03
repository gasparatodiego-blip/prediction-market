'use strict';
// lib/maker/book-erosion.js — IL SECONDO SEGNALE DI RIPOSIZIONAMENTO: l'erosione del book davanti
// all'ordine. Aritmetica e macchina a stati, e NIENT'ALTRO: nessun `fs`, nessuna rete, nessun venue.
//
// ═══ LA DOMANDA CHE QUESTO MODULO RISPONDE ═══════════════════════════════════════════════════════════
// Il tracking finora aveva UN segnale solo: «il mio ordine e' uscito dalla banda premiante?». E' un
// segnale che arriva DOPO — quando il mid si e' gia' mosso. Questo modulo ne aggiunge uno che arriva
// PRIMA: «i livelli fra il mio ordine e il mid si stanno svuotando?».
//
// Il book fra il mio prezzo e il mid e' la coda che mi separa dall'essere eseguito. Finche' quella coda
// e' spessa, un movimento del prezzo deve consumarla prima di arrivare a me. Quando si assottiglia in
// fretta, spesso e' perche' qualcuno sta togliendo liquidita' in vista di un movimento — e chi resta
// fermo viene eseguito un istante prima che il prezzo se ne vada dall'altra parte.
//
// ═══ PERCHE' E' DELIBERATAMENTE LENTO ════════════════════════════════════════════════════════════════
// Questo e' un motore che vive di REWARD DI LIQUIDITA', e i reward si maturano STANDO sul book. Un
// trigger nervoso farebbe scappare la liquidita' proprio nelle oscillazioni normali che generano il
// premio: si eviterebbero due fill sfortunati e si perderebbe l'intero montepremi. Quindi ogni scelta
// qui dentro e' tarata verso il NON agire, e vale la pena elencarle perche' sono cinque freni in serie:
//
//   1. BASELINE ADATTIVA, non soglia fissa. Un book da 150 share e uno da 11.000 non si confrontano con
//      lo stesso numero. Il metro e' la storia recente di QUEL mercato su QUEL lato.
//   2. RISCALDAMENTO OBBLIGATORIO. Finche' la baseline non poggia su abbastanza campioni distribuiti su
//      abbastanza tempo, non esiste: nessun trigger. «Non lo so» non diventa «va tutto bene» ne' il suo
//      contrario.
//   3. CONFERMA A DUE LETTURE. Una singola lettura sotto soglia non fa nulla. Sui book sottili — e molti
//      mercati Ottimizza hanno pochissima concorrenza — la size oscilla da sola.
//   4. ISTERESI 40/60. Si scatta sotto il 40% della baseline, si torna «normali» solo sopra il 60%. La
//      fascia 40-60 e' zona morta: serve a non rimbalzare avanti e indietro sullo stesso confine.
//   5. AZZERAMENTO DOPO OGNI RIPREZZO. Chi riprezza cambia prezzo, quindi cambia la zona misurata: la
//      serie precedente non descrive piu' niente. Si riparte dal riscaldamento, e questo da solo mette
//      un tetto duro a quanto spesso l'erosione possa far muovere lo stesso lato.
//
// ═══ COSA QUESTO MODULO NON FA ═══════════════════════════════════════════════════════════════════════
// Non decide di piazzare, non conosce la banda, non conosce il venue. Dice soltanto «questo lato e' in
// erosione confermata, si'/no» e con quali numeri lo afferma. Chi lo chiama (mm-tracking) resta l'unico
// a decidere se quel segnale si traduce in un ordine, e continua a passare per tutti i suoi gate.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const EPS = 1e-9;

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// I PARAMETRI — TUTTI QUI, NESSUNO SPARSO ALTROVE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Sono valori di taratura iniziale, non costanti di natura: nascono da come e' fatto questo motore
// (ciclo da 3s) e da quanto vale sbagliare in ciascuna direzione. Vanno rivisti con i dati veri, ed e'
// per questo che ogni riposizionamento registra nell'audit quale trigger l'ha causato e con che numeri.

/** Sotto questa percentuale della baseline la profondita' e' «erosa». */
const EROSION_TRIGGER_PCT = 40;
/** Sopra questa percentuale si torna a considerare la situazione normale. Fra le due c'e' la zona morta. */
const EROSION_RECOVERY_PCT = 60;
/** Finestra della media mobile. 10 minuti: l'estremo ALTO dell'intervallo richiesto (5-10), scelto
 *  apposta perche' una finestra piu' lunga produce una baseline piu' stabile e quindi un trigger MENO
 *  nervoso — che e' la direzione in cui questo meccanismo deve sbagliare. A 3s di ciclo sono ~200
 *  campioni per lato. */
const BASELINE_WINDOW_MS = 600_000;
/** Quante letture consecutive sotto soglia servono prima di agire. */
const EROSION_CONFIRM_READINGS = 2;
/** Il riscaldamento, in due condizioni che valgono ENTRAMBE. I campioni servono perche' una media su
 *  due punti non e' una media; lo span serve perche' 5 campioni presi in 15 secondi descrivono un
 *  istante, non la liquidita' normale del mercato. */
const BASELINE_MIN_SAMPLES = 5;
const BASELINE_MIN_SPAN_MS = 120_000;
/** ── IL CONFINE CON I MERCATI DIREZIONALI VELOCI ──────────────────────────────────────────────────
 *  I cicli «Bitcoin/Ethereum Up or Down» durano 5 o 15 minuti in tutto. Su una vita cosi' corta questo
 *  meccanismo non e' «troppo aggressivo»: e' PRIVO DI SIGNIFICATO, perche' la finestra della baseline
 *  (10 min) e' piu' lunga del mercato stesso e il riscaldamento consumerebbe meta' della sua vita.
 *  Il gate e' quindi un argomento di VALIDITA' DELLA MISURA, non una tassonomia di mercati: qualunque
 *  mercato con meno di questo tempo davanti non produce un segnale su cui valga la pena agire, incluso
 *  un mercato lungo arrivato in fondo — e nei suoi ultimi minuti muovere liquidita' e' comunque l'ultima
 *  cosa che si vuole fare. */
const EROSION_MIN_MARKET_MINUTES = 30;
/** ── IL FRENO FRA DUE RIPREZZI SULLO STESSO LATO ──────────────────────────────────────────────────
 *  Vale per ENTRAMBI i trigger, non solo per il nuovo: due segnali che scattano a pochi secondi l'uno
 *  dall'altro devono produrre UN riposizionamento, non due.
 *
 *  IL NUMERO, E COSA NON GARANTISCE. 30 secondi e' lo stesso valore che l'altro motore automatico usa
 *  gia' (`auto-reprice-config.minIntervalMs`), e usare due freni diversi per la stessa cosa in due
 *  motori affiancati sarebbe solo un modo per non capire piu' quale dei due ha rifiutato. Ma va detto
 *  con chiarezza: 10 mercati a due lati sono 20 gambe, e 20 gambe che riprezzano ogni 30s fanno 40
 *  ordini/60s, cioe' il DOPPIO del rail da 20/60s. Questo freno riduce il traffico, non lo garantisce:
 *  il rate limiter resta l'unica protezione dura, e continua a rifiutare l'eccesso con il suo backoff.
 *  Chi vuole che il freno da solo rispetti il rail deve portarlo a 60s. */
const REPRICE_MIN_INTERVAL_MS = 30_000;

/**
 * La configurazione risolta, in un oggetto solo. Ogni chiamante passa di qui: nessuno legge le costanti
 * direttamente, cosi' una taratura per env non puo' valere in un punto e non nell'altro.
 *
 * `tuning.minIntervalMs` viene da `auto-reprice-config` e agent40 lo passa gia' al ciclo di tracking da
 * prima di questo lavoro (era passato e non usato). Si riusa quello invece di aggiungere una seconda
 * manopola che direbbe la stessa cosa.
 */
function erosionConfig(tuning = {}) {
  const num = (v, dflt, min) => (fin(v) && v >= min ? v : dflt);
  return {
    triggerPct: num(tuning.erosionTriggerPct, EROSION_TRIGGER_PCT, 1),
    recoveryPct: num(tuning.erosionRecoveryPct, EROSION_RECOVERY_PCT, 1),
    windowMs: num(tuning.erosionWindowMs, BASELINE_WINDOW_MS, 1000),
    confirmReadings: num(tuning.erosionConfirmReadings, EROSION_CONFIRM_READINGS, 1),
    minSamples: num(tuning.erosionMinSamples, BASELINE_MIN_SAMPLES, 2),
    minSpanMs: num(tuning.erosionMinSpanMs, BASELINE_MIN_SPAN_MS, 1000),
    minMarketMinutes: num(tuning.erosionMinMarketMinutes, EROSION_MIN_MARKET_MINUTES, 0),
    minIntervalMs: num(tuning.minIntervalMs, REPRICE_MIN_INTERVAL_MS, 0),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// LA MISURA — quanta size c'e' fra il mio ordine e il mid
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * La profondita' nella zona fra il prezzo del mio ordine e il mid del suo book.
 *
 * I due motori quotano sempre in ACQUISTO su entrambi i book (il lato NO e' un CLOB indipendente, non
 * lo specchio del lato YES), quindi la coda che mi separa dall'esecuzione e' fatta di BID a prezzo
 * MIGLIORE del mio: sono gli ordini che verranno serviti prima di me.
 *
 * TRE ESTREMI, E PERCHE' SONO COSI':
 *   · il mio prezzo e' ESCLUSO. Al mio livello c'e' anche il mio ordine, e una misura che contiene la
 *     mia stessa size si muoverebbe quando mi muovo io — misurerebbe me, non il mercato.
 *   · il mid e' ESCLUSO. E' un prezzo di riferimento, non un livello del book.
 *   · i livelli OLTRE il mid non contano. Su un book sottile il mid di scoring puo' cadere sotto il
 *     miglior bid (il filtro anti-polvere del programma premi scarta i livelli sotto la size minima):
 *     in quel caso la zona risulta vuota e la misura si dichiara a zero invece di allargarsi a coprire
 *     un pezzo di book che non sta fra me e il mid.
 *
 * Una zona vuota su un book che esiste NON e' un errore: e' profondita' zero, cioe' la situazione in cui
 * davanti a me non c'e' piu' nessuno. Ma un ordine piazzato SUL tocco ha la zona vuota per costruzione e
 * per sempre: quel caso non produce mai un trigger, perche' una baseline di zero non e' divisibile e il
 * riscaldamento non si completa mai. E' voluto.
 *
 * @param {Array<{price:number|string,size:number|string}>} levels  i BID del book di questo lato
 * @param {number} orderPrice  il prezzo del mio ordine a riposo su questo lato
 * @param {number} sideMid     il mid di scoring di QUESTO book (per il NO: 1 − mid)
 * @returns {{readable:boolean, depth:number|null, levels:number, reason:string|null}}
 */
function zoneDepth({ levels, orderPrice, sideMid } = {}) {
  if (!Array.isArray(levels) || levels.length === 0) {
    return { readable: false, depth: null, levels: 0, reason: 'il feed non pubblica i livelli di questo book — nessuna misura di profondita' };
  }
  if (!fin(orderPrice)) {
    return { readable: false, depth: null, levels: 0, reason: 'nessun ordine a riposo su questo lato: non esiste una zona da misurare' };
  }
  if (!fin(sideMid)) {
    return { readable: false, depth: null, levels: 0, reason: 'mid di questo book non leggibile' };
  }
  let depth = 0;
  let counted = 0;
  for (const l of levels) {
    if (!l) continue;
    const price = typeof l.price === 'string' ? parseFloat(l.price) : l.price;
    const size = typeof l.size === 'string' ? parseFloat(l.size) : l.size;
    // size 0 = livello cancellato, non un livello con zero contratti: non esiste, non si conta.
    if (!fin(price) || !fin(size) || size <= 0) continue;
    if (price <= orderPrice + EPS) continue;   // dietro di me o al mio livello
    if (price >= sideMid - EPS) continue;      // oltre il mid: non e' fra me e il mid
    depth += size;
    counted += 1;
  }
  return { readable: true, depth: +depth.toFixed(6), levels: counted, reason: null };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// LO STATO E LA MACCHINA
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
/** Lo stato per UN lato di UN mercato. Un riavvio lo azzera, ed e' corretto: senza storia non c'e'
 *  baseline, senza baseline non c'e' trigger, quindi un processo che riparte non eredita nessun
 *  giudizio — ricomincia a guardare. */
function emptyErosionState() {
  return {
    samples: [],        // { t, depth } dentro la finestra
    armed: false,       // erosione confermata e ancora in corso
    belowStreak: 0,     // letture consecutive sotto soglia, prima della conferma
    frozenBaseline: null, // la baseline al momento dell'innesco: l'isteresi si misura su QUELLA
    armedAt: null,
  };
}

/**
 * Una lettura, e il verdetto che ne esce. MUTA `state` — e' un accumulatore di serie temporale, e
 * copiarlo a ogni ciclo per ogni lato di ogni mercato sarebbe copiare 200 campioni 40 volte ogni 3
 * secondi per non guadagnare nulla.
 *
 * L'ORDINE DELLE OPERAZIONI E' LA PARTE CHE CONTA:
 *   1. una lettura NON leggibile non e' una lettura bassa. Non entra nella serie, non fa avanzare la
 *      conferma, non azzera niente: il book e' semplicemente sparito per un giro e lo stato resta com'e'.
 *   2. la baseline si calcola sui campioni PRECEDENTI, non includendo quello corrente: la domanda e'
 *      «questa lettura come sta rispetto a com'era prima», e includerla nel proprio metro la ammorbidisce.
 *   3. il campione corrente entra nella serie DOPO. Anche quando si e' armati: se il book resta sottile
 *      per davvero, la baseline viva scende, e questo rende PIU' DIFFICILE armarsi di nuovo in futuro.
 *      E' la direzione giusta in cui sbagliare.
 *   4. l'isteresi si misura sulla baseline CONGELATA all'innesco, non su quella viva. Senza questo, la
 *      baseline scenderebbe insieme al book e il «recupero sopra il 60%» arriverebbe da solo senza che
 *      il book sia recuperato di un contratto.
 *
 * @returns {{readable:boolean, established:boolean, erosion:boolean, fired:boolean, recovered:boolean,
 *            depth:number|null, baseline:number|null, ratioPct:number|null, belowStreak:number,
 *            samples:number, reason:string}}
 */
function updateErosion(state, { depth, now, cfg } = {}) {
  const c = cfg || erosionConfig();
  const st = state && Array.isArray(state.samples) ? state : emptyErosionState();
  const out = (extra) => ({
    readable: true, established: false, erosion: st.armed === true, fired: false, recovered: false,
    depth: fin(depth) ? depth : null, baseline: null, ratioPct: null,
    belowStreak: st.belowStreak, samples: st.samples.length, ...extra,
  });

  if (!fin(depth) || depth < 0) {
    // Il book non si e' letto. Non si conclude nulla in nessuna delle due direzioni.
    return out({ readable: false, reason: 'profondita non leggibile in questo giro: la serie non avanza e nessun verdetto cambia' });
  }
  if (!fin(now)) return out({ readable: false, reason: 'orologio non leggibile' });

  // Fuori finestra ⇒ fuori dalla media. La potatura viene prima di tutto, cosi' `samples[0]` e' davvero
  // il piu' vecchio ancora valido e lo span misurato e' quello reale.
  st.samples = st.samples.filter((s) => s && fin(s.t) && now - s.t <= c.windowMs);

  const n = st.samples.length;
  const spanMs = n ? now - st.samples[0].t : 0;
  const established = n >= c.minSamples && spanMs >= c.minSpanMs;
  const liveBaseline = n ? st.samples.reduce((a, s) => a + s.depth, 0) / n : null;

  // Il campione entra SEMPRE nella serie, anche quando non si puo' ancora concludere niente: e' proprio
  // cosi' che il riscaldamento si completa.
  const push = () => { st.samples.push({ t: now, depth }); };

  if (!established || !fin(liveBaseline) || liveBaseline <= EPS) {
    push();
    return out({
      established: false, baseline: fin(liveBaseline) ? +liveBaseline.toFixed(4) : null,
      samples: st.samples.length,
      // DUE MOTIVI DIVERSI, E NON VANNO CONFUSI. «Non ho ancora abbastanza storia» e «la storia che ho
      // dice zero» sono due stati distinti: il primo passa da solo col tempo, il secondo no — e' un
      // ordine piazzato sul tocco, dove davanti non c'e' mai nessuno. Un solo messaggio per entrambi
      // farebbe leggere come transitorio uno stato che e' permanente.
      reason: !established
        ? `riscaldamento: ${st.samples.length}/${c.minSamples} campioni su ${Math.round(spanMs / 1000)}/${Math.round(c.minSpanMs / 1000)}s — senza una baseline non si afferma nulla`
        : 'la profondita media di riferimento e zero: fra l ordine e il mid non c e mai stato nessuno, quindi non c e nulla che possa erodersi',
    });
  }

  const baseline = st.armed && fin(st.frozenBaseline) && st.frozenBaseline > EPS ? st.frozenBaseline : liveBaseline;
  const ratioPct = +((depth / baseline) * 100).toFixed(2);

  // ── GIA' ARMATI: si guarda SOLO il recupero, sulla soglia alta ────────────────────────────────────
  if (st.armed) {
    if (ratioPct >= c.recoveryPct) {
      st.armed = false; st.belowStreak = 0; st.frozenBaseline = null; st.armedAt = null;
      push();
      return out({
        established: true, erosion: false, recovered: true, baseline: +baseline.toFixed(4), ratioPct,
        belowStreak: 0, samples: st.samples.length,
        reason: `profondita risalita al ${ratioPct}% della baseline (${baseline.toFixed(0)} share), sopra la soglia di rientro del ${c.recoveryPct}% — si torna a inseguire il solo mid`,
      });
    }
    push();
    return out({
      established: true, erosion: true, baseline: +baseline.toFixed(4), ratioPct, samples: st.samples.length,
      reason: `erosione ancora in corso: ${depth.toFixed(0)} share contro una baseline di ${baseline.toFixed(0)} (${ratioPct}%), sotto il rientro del ${c.recoveryPct}%`,
    });
  }

  // ── NON ARMATI: si guarda la soglia bassa, e serve la conferma ────────────────────────────────────
  if (ratioPct < c.triggerPct) {
    st.belowStreak += 1;
    if (st.belowStreak >= c.confirmReadings) {
      st.armed = true;
      st.frozenBaseline = liveBaseline;   // l'isteresi si misurera' su questa, non su una che scende
      st.armedAt = now;
      push();
      return out({
        established: true, erosion: true, fired: true, baseline: +liveBaseline.toFixed(4), ratioPct,
        belowStreak: st.belowStreak, samples: st.samples.length,
        reason: `EROSIONE CONFERMATA: ${depth.toFixed(0)} share fra l ordine e il mid contro una baseline di ${liveBaseline.toFixed(0)} (${ratioPct}%, soglia ${c.triggerPct}%), ${st.belowStreak} letture consecutive sotto`,
      });
    }
    push();
    return out({
      established: true, erosion: false, baseline: +liveBaseline.toFixed(4), ratioPct,
      belowStreak: st.belowStreak, samples: st.samples.length,
      reason: `sotto soglia (${ratioPct}% contro ${c.triggerPct}%) ma e la ${st.belowStreak}a lettura: ne servono ${c.confirmReadings} consecutive prima di agire`,
    });
  }

  st.belowStreak = 0;
  push();
  return out({
    established: true, erosion: false, baseline: +liveBaseline.toFixed(4), ratioPct,
    belowStreak: 0, samples: st.samples.length,
    reason: `profondita normale: ${depth.toFixed(0)} share contro una baseline di ${liveBaseline.toFixed(0)} (${ratioPct}%, soglia ${c.triggerPct}%)`,
  });
}

/**
 * QUESTO MERCATO E' UN CANDIDATO PER L'EROSIONE?
 *
 * Due condizioni, entrambe necessarie, entrambe fail-closed:
 *   · BANDA PUBBLICATA. E' la definizione operativa di «mercato reward-eligible»: senza banda non c'e'
 *     programma premi, e senza programma premi questo meccanismo non ha lo scopo per cui esiste.
 *     Serve comunque piu' avanti, perche' un riposizionamento per erosione deve restare dentro banda.
 *   · ABBASTANZA VITA DAVANTI. Vedi EROSION_MIN_MARKET_MINUTES: sotto quella soglia la misura non e'
 *     aggressiva, e' insensata. Una chiusura NON LEGGIBILE non passa il gate: e' la stessa regola che
 *     governa tutto il resto di questo motore — l'assenza di un fatto non ne prende il posto.
 */
function erosionEligible({ closeKnown, minutesToClose, bandRadiusCents, cfg } = {}) {
  const c = cfg || erosionConfig();
  if (!fin(bandRadiusCents) || bandRadiusCents <= 0) {
    return { eligible: false, gate: 'no-band', reason: 'il venue non pubblica una banda premiante per questo mercato: il trigger di erosione non si applica' };
  }
  if (closeKnown !== true || !fin(minutesToClose)) {
    return { eligible: false, gate: 'close-unknown', reason: 'orario di chiusura non leggibile: non si puo affermare che questo mercato viva abbastanza perche la misura abbia senso' };
  }
  if (minutesToClose < c.minMarketMinutes) {
    return {
      eligible: false,
      gate: 'market-too-short',
      reason: `mancano ${minutesToClose.toFixed(1)} min alla chiusura, sotto i ${c.minMarketMinutes} richiesti: la finestra della baseline (${Math.round(c.windowMs / 60000)} min) sarebbe piu lunga di cio che resta da misurare`,
    };
  }
  return { eligible: true, gate: null, reason: null };
}

/**
 * IL FRENO FRA DUE RIPREZZI SULLO STESSO LATO.
 *
 * DUE ESENZIONI, e sono l'unica ragione per cui questa funzione esiste invece di un `if` sul posto:
 *   · IL PRIMO PIAZZAMENTO non e' un riprezzo. Non c'e' un «precedente» da distanziare, e frenarlo
 *     vorrebbe dire tenere un lato vuoto fuori dal book senza motivo.
 *   · IL RINNOVO GTD non e' un riprezzo. E' il dead-man's switch: se lo si frena, l'ordine scade e
 *     sparisce dal libro davvero. Un freno che puo' far perdere un ordine non e' un freno, e' un guasto.
 */
function repriceAllowed({ trigger, lastRepriceAt, now, cfg } = {}) {
  const c = cfg || erosionConfig();
  if (trigger === 'missing' || trigger === 'initial' || trigger === 'expiry-renewal') {
    return { allowed: true, reason: null };
  }
  if (!fin(lastRepriceAt) || !(c.minIntervalMs > 0) || !fin(now)) return { allowed: true, reason: null };
  const elapsed = now - lastRepriceAt;
  if (elapsed >= c.minIntervalMs) return { allowed: true, reason: null };
  const waitS = Math.ceil((c.minIntervalMs - elapsed) / 1000);
  return {
    allowed: false,
    reason: `questo lato e stato riposizionato ${Math.round(elapsed / 1000)}s fa e il minimo fra due riprezzi e ${Math.round(c.minIntervalMs / 1000)}s — attendo altri ${waitS}s. Due trigger vicini nel tempo devono produrre UN movimento, non due.`,
  };
}

/**
 * L'AZZERAMENTO DOPO UN ARRETRAMENTO PER EROSIONE — che NON e' lo stesso di `emptyErosionState()`.
 *
 * Dopo un riposizionamento qualunque la serie va buttata: l'ordine ha un prezzo nuovo, quindi la zona
 * misurata e' un'altra zona e i campioni vecchi descrivono un posto diverso del libro. Fin qui vale per
 * tutti i riprezzi.
 *
 * MA SE A MUOVERE E' STATA L'EROSIONE, azzerare anche `armed` disfa la difesa nell'istante in cui la si
 * e' presa: al ciclo successivo il segnale risulterebbe spento, il bersaglio tornerebbe dietro al miglior
 * bid, e l'ordine rientrerebbe esattamente dove si era appena deciso di non stare. Misurato in test:
 * arretramento e ritorno nello stesso giro.
 *
 * Quindi `armed` SOPRAVVIVE, e a deciderne la fine resta l'isteresi — che e' il suo mestiere.
 *
 * `frozenBaseline` invece si butta, ed e' deliberato: era la media della zona VECCHIA, e la zona nuova —
 * piu' larga, perche' ci si e' allontanati dal mid — contiene piu' livelli e quindi size sistematicamente
 * maggiore. Confrontare la profondita' di adesso con quella media direbbe «recuperato» solo perche' si e'
 * cambiato metro. Si ricostruisce la baseline sulla zona nuova, e il rientro si giudica su quella.
 *
 * CONSEGUENZA DICHIARATA: la posizione difensiva dura almeno il riscaldamento (campioni + span), e poi
 * finche' la profondita' resta sotto il rientro rispetto alla normalita' della zona nuova. Se il book si
 * assesta su un livello piu' sottile ma STABILE, si rientra — ed e' corretto: questo segnale misura un
 * cambiamento improvviso, non la magrezza assoluta di un book.
 */
function retreatReset(state) {
  return { samples: [], armed: true, belowStreak: 0, frozenBaseline: null, armedAt: state && fin(state.armedAt) ? state.armedAt : null };
}

/**
 * DOVE SI VA, quando l'erosione scatta.
 *
 * QUESTA FUNZIONE ESISTE PERCHE' IL TRIGGER SENZA DI ESSA NON FAREBBE NULLA. Il trigger sul mid muove
 * l'ordine perche' il MID si e' spostato: il prezzo di destinazione e' nuovo per costruzione. L'erosione
 * invece scatta con il mid FERMO — e' proprio il suo caso d'uso — quindi «riprezzare all'offset di
 * sempre» significherebbe cancellare e ripiazzare allo stesso identico prezzo, buttando via il posto in
 * coda in cambio di niente. Il motore infatti salta i riprezzi a prezzo invariato, e senza questa
 * funzione l'intero meccanismo sarebbe un giro a vuoto.
 *
 * LA DESTINAZIONE E' IL BORDO PREMIANTE. Il segnale dice «potresti essere eseguito fra poco»; la
 * risposta e' allontanarsi dal mid, perche' la distanza dal mid E' la probabilita' di essere eseguiti.
 * Ma allontanarsi oltre il raggio della banda vorrebbe dire smettere di maturare, che e' il punto 7:
 * questo meccanismo riduce il rischio di fill, non rinuncia ai reward. Il punto piu' lontano dal mid in
 * cui l'ordine matura ancora e' esattamente il bordo — quindi ci si ritira LI', e non oltre.
 *
 * Non c'e' nessun numero scelto a tavolino: il bordo lo pubblica il venue e il tick lo aggancia.
 *
 * L'ARROTONDAMENTO E' VERSO L'INTERNO. Un offset agganciato per eccesso finirebbe di un tick FUORI
 * banda — cioe' esattamente il contrario di cio' che questa funzione deve garantire.
 *
 * @returns {{ok:boolean, offsetCents:number|null, reason:string|null}}
 */
function erosionRetreat({ offsetCents, bandRadiusCents, tick } = {}) {
  if (!fin(offsetCents) || !fin(bandRadiusCents) || !fin(tick) || tick <= 0) {
    return { ok: false, offsetCents: null, reason: 'offset, banda o tick non leggibili: nessun arretramento calcolabile' };
  }
  const tickC = tick * 100;
  const edge = +(Math.floor((bandRadiusCents + EPS) / tickC) * tickC).toFixed(6);
  if (!(edge > 0)) {
    return { ok: false, offsetCents: null, reason: `il raggio premiante (${bandRadiusCents}¢) e piu stretto di un tick (${tickC}¢): non esiste un prezzo dentro banda diverso dal mid` };
  }
  if (edge <= offsetCents + EPS) {
    return {
      ok: false, offsetCents: null,
      reason: `l ordine e gia al bordo premiante (offset ${offsetCents}¢, bordo ${edge}¢): non c e nessun posto piu lontano dal mid in cui maturerebbe ancora`,
    };
  }
  return {
    ok: true, offsetCents: edge,
    reason: `ci si ritira da ${offsetCents}¢ a ${edge}¢ dal mid — il punto piu lontano dal mid in cui l ordine matura ancora (raggio ${bandRadiusCents}¢, tick ${tickC}¢)`,
  };
}

/** L'etichetta che finisce nell'audit: quale segnale ha causato il movimento. Serve a poter dire, fra
 *  un mese e con i dati veri, quanto ciascuno dei due ha contribuito e se 40/60 e' la taratura giusta. */
function triggerKind({ mid, erosion }) {
  if (mid && erosion) return 'entrambi';
  if (erosion) return 'erosione';
  if (mid) return 'mid';
  return null;
}

module.exports = {
  EROSION_TRIGGER_PCT, EROSION_RECOVERY_PCT, BASELINE_WINDOW_MS, EROSION_CONFIRM_READINGS,
  BASELINE_MIN_SAMPLES, BASELINE_MIN_SPAN_MS, EROSION_MIN_MARKET_MINUTES, REPRICE_MIN_INTERVAL_MS,
  erosionConfig, zoneDepth, emptyErosionState, updateErosion, erosionEligible, repriceAllowed,
  erosionRetreat, retreatReset, triggerKind,
  // ── LO STESSO PREDICATO, CON IL NOME CHE HA PRESO DOPO ────────────────────────────────────────
  // `erosionEligible` e' nato per l'erosione, ma la domanda che risponde — «questo e' un mercato
  // reward-eligible della tab Ottimizza, con banda pubblicata e abbastanza vita perche' una misura sul
  // book abbia senso?» — e' esattamente la stessa che governa il posizionamento «mai in cima».
  // I due comportamenti dinamici devono avere UNO scopo, non due che possano divergere di un mercato.
  // Il nome vecchio resta esportato perche' i suoi test lo usano e sono ancora la sua specifica.
  ottimizzaScope: erosionEligible,
};

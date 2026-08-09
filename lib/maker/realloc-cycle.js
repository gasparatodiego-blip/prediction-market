'use strict';
// lib/maker/realloc-cycle.js — UN GIRO DEL RIALLOCATORE PERIODICO.
//
// ═══ COSA FA, IN UNA FRASE ═══════════════════════════════════════════════════════════════════════════
// Guarda i mercati che il bot sta gestendo davvero; se anche uno solo non è più quello su cui il piano
// era stato deciso, oppure se rifare il piano oggi varrebbe molto di più, rifà il piano da zero e lo
// mette in opera con il reset completo che già esiste. Altrimenti non fa niente — e «non fare niente» è
// un esito, non un fallimento.
//
// ═══ I DUE TRIGGER, E PERCHÉ NON BASTAVA IL PRIMO ═══════════════════════════════════════════════════
//   1 · VALIDITÀ  un mercato in gestione non è più quello di prima: risolto, non negoziabile, senza
//                 banda, in scadenza, o col montepremi crollato sotto metà (market-validity.js).
//   2 · VALORE    tutti i mercati sono ancora validi, ma il piano che si farebbe OGGI vale più del 20%
//                 in più di quello in produzione.
//
// Il secondo nasce da una misura, non da un'intuizione. Su 29 giorni di storico board (1005 fotografie,
// scripts/realloc-decay.js): a 6 ore di distanza, nei cicli in cui il controllo di validità NON sarebbe
// scattato, del piano restava comunque solo l'81% di quello che un piano fresco avrebbe reso. Quel 19%
// se ne andava su mercati ancora vivi, ancora premiati, ancora in banda, che avevano solo smesso di
// essere i migliori — invisibili al primo trigger per costruzione.
//
// I due sono INDIPENDENTI: si valutano sempre tutti e due, si registrano separatamente, e il referto
// dice quale dei due (o entrambi) ha causato il reset.
//
// ═══ COME SI MISURA «QUANTO VALE IL PIANO IN PRODUZIONE» ═══════════════════════════════════════════
// Non confrontando la stima di oggi con quella salvata mesi fa: fra le due ci sarebbe anche il
// raffreddamento dell'intero board, che non è colpa del piano fermo e non si cura riallocando. Si
// confrontano invece DUE PIANI CALCOLATI ADESSO, con la stessa stima, lo stesso capitale e lo stesso
// tetto: uno libero di scegliere in tutto l'universo, l'altro ristretto ai mercati già in gestione
// (planFromCollection con `onlyMarketIds`). La differenza è per costruzione solo la SCELTA dei mercati.
//
// Il piano ristretto è il MEGLIO che quei mercati potrebbero dare oggi, non quello che stanno dando: è
// un limite superiore, quindi il trigger sotto-scatta invece di sovra-scattare. È la direzione giusta in
// cui sbagliare per un processo che cancella ordini veri da solo.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════════
// Un'allocazione non è una decisione, è una scommessa su uno stato del mondo: questi mercati, con questi
// montepremi, per questo orizzonte. Il mondo si muove. Misurato il 3 agosto 2026: il mercato che valeva
// il 68% del reward atteso è passato da $124/g a $3/g in poche ore, restando aperto, negoziabile e con la
// sua banda pubblicata — cioè invisibile a qualunque controllo che si limiti a chiedere «è ancora vivo?».
// Nella stessa giornata la stima del piano è passata da $77,85/g a $33,72/g senza che nessuno toccasse
// niente. Un'allocazione lasciata ferma non è un'allocazione conservativa: è un'allocazione scaduta.
//
// ═══ TUTTO CIÒ CHE PUÒ ANDARE STORTO SI FERMA PRIMA DI TOCCARE IL CAPITALE ══════════════════════════
// Questo ciclo gira da solo, senza nessuno che guardi. Ogni ingresso che manca è un motivo per FERMARSI,
// mai per procedere con un valore di comodo:
//
//   · venue illeggibile su un mercato   → nessun verdetto, nessun reset (market-validity.js)
//   · saldo non leggibile               → non si sa quanto capitale allocare: fermo
//   · allocatore in errore              → fermo
//   · universo vuoto / senza copertura  → il piano vuoto sarebbe un piano ignorante, non un piano magro: fermo
//   · board più vecchio di un'ora       → il piano nascerebbe su montepremi e bande di un'altra ora: fermo
//   · mercato del piano illeggibile     → non si piazza capitale su una conferma mancata: fermo
//   · cancellazione fallita a metà      → è allocation-reset.js a fermarsi, prima di ogni scrittura
//
// ═══ E I MERCATI CHE ENTRANO NEL PIANO SI VERIFICANO AL VENUE, NON SOLO QUELLI CHE ESCONO ═══════════
// Il controllo di validità guarda i mercati GIÀ IN GESTIONE. Le righe del piano nuovo, invece, nascono da
// data/liquidity-rewards.json — una fotografia rinfrescata ogni 15 minuti — e fra due fotografie un
// mercato può risolversi, smettere di accettare ordini o vedersi rifare il montepremi. Prima di mettere
// in opera qualunque riga, il ciclo richiede al venue lo stato di OGNI mercato che piazzerebbe: chi non
// passa esce, e il piano si RIFÀ senza di lui, così quel capitale va altrove invece di restare fermo o di
// finire su un mercato morto. Il piano rifatto può portare mercati mai verificati, quindi si riverifica —
// fino a PLAN_VERIFY_MAX_PASSES giri, oltre i quali il dato di partenza è marcio e ci si ferma.
//
// E in nessuno di questi casi si riprova subito. Si riprova al giro dopo. Un riallocatore che ritenta in
// loop su un venue che non risponde è un modo elaborato di martellare un servizio già in difficoltà, e
// trasforma un guasto passeggero in una raffica di azioni sul capitale.
//
// ═══ IL TETTO PER MERCATO ═══════════════════════════════════════════════════════════════════════════
// Il piano nuovo si calcola con al massimo `MARKET_CAP_FIXED_USD` su un singolo mercato (YES+NO sommati)
// — lo STESSO tetto che il motore di piazzamento applica al quoting, perché è lo stesso modulo. Non è
// una preferenza estetica: nella misura del 3 agosto il knapsack senza tetto metteva il 68% del reward
// atteso su un mercato solo, ed è esattamente quel mercato che è poi collassato. Il tetto non avrebbe
// evitato il collasso — nessun tetto lo fa — ma avrebbe ridotto quanto del piano se ne andava con lui.
//
// Dal 9 agosto 2026 è un valore FISSO in dollari e non più una frazione del capitale: quando il capitale
// cresce si usano più mercati, non size più grandi.

const { marketValidity, decidiRiallocazione } = require('./market-validity');
const { planToOrders } = require('../rewards/plan-to-orders');
// Il tetto non è scritto qui: è in lib/rewards/concentration.js perché il pannello «Ottimizza», il
// motore di piazzamento e il punteggio di rischio leggono LO STESSO numero. Quattro strade che
// rispondono alla stessa domanda non possono avere quattro costanti.
const { capPerMarketUsd, MARKET_CAP_FIXED_USD } = require('../rewards/concentration');

const INTERVAL_MS = 6 * 3_600_000;     // ogni 6 ore — l'intervallo, non una costante di sicurezza
const VALUE_TRIGGER_FRAC = 0.20;       // il piano fresco deve valere almeno il 20% in più per giustificare il churn

// ── LA VERIFICA AL VENUE DEI MERCATI CHE ENTRANO NEL PIANO ─────────────────────────────────────────
// Quante volte al massimo si rifà il piano scartando i mercati che il venue ha bocciato. Ogni giro
// esclude e ricalcola, e il piano nuovo può portare mercati che non erano stati verificati — quindi si
// riverifica. Il tetto esiste perché una lista di mercati morti abbastanza lunga farebbe girare questo
// ciclo all'infinito contro il venue; a quel punto il dato di partenza è marcio e ci si ferma.
const PLAN_VERIFY_MAX_PASSES = 3;
// Oltre questa età la fotografia del board (data/liquidity-rewards.json, scritta da agent24 ogni 15 min)
// non è più una base su cui piazzare ordini veri: montepremi, banda e scadenza sarebbero di un'altra ora.
// 60 minuti = quattro scansioni mancate di fila, cioè agent24 fermo, non un ritardo.
const BOARD_MAX_AGE_MS = 60 * 60_000;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
/** Quanti mercati l'ottimizzatore ha VALUTATO davvero (non quanti ne ha elencati nel registro). */
const valutati = (p) => (p && p.universe && fin(p.universe.evaluated) ? p.universe.evaluated : ((p && p.candidates) || []).length);

/**
 * Un giro completo.
 *
 * @param {object} args   dryRunOnly: simula anche il reset (nessuna cancellazione, nessun ordine)
 * @param {object} deps   ogni effetto collaterale iniettabile — questo modulo non legge file né rete
 *   readEnabled()                        → [marketId]      allowlist live-min
 *   readTracking()                       → [marketId]      registro del motore mm-tracking
 *   readVenue({marketId})                → record del venue (vedi market-validity)
 *   readPlanPools()                      → { [marketId]: pot } montepremi con cui il piano fu deciso
 *   writePlanPools(mappa)                → persiste i montepremi del piano nuovo
 *   writeAllocatedCapital({rows,capital})→ il tetto di posizione derivato dal piano nuovo
 *   readBalance()                        → { readable, usd }
 *   makePlan({capital, maxPerMarketUsd, onlyMarketIds, excludeMarketIds}) → il corpo di
 *                                        planFromCollection; con onlyMarketIds l'universo è ristretto a
 *                                        quei mercati, con excludeMarketIds è l'universo intero MENO
 *                                        quelli (i mercati che il venue ha appena bocciato)
 *   runReset({rows, dryRunOnly})         → lib/maker/allocation-reset.runAllocationReset
 *   log(record)                          → registro persistente, una riga per passo
 *   now()
 * @returns {{ok, azione, motivo, ...}}  azione ∈ nessuna | reset | fermato
 */
// L'attesa di riscaldamento è una PROPOSTA pronta, non un comportamento acceso: senza la variabile
// d'ambiente il ciclo è identico a prima, riga per riga. Vedi lib/maker/attesa-riscaldamento.js.
const ATTESA_DIFETTO = {
  enabled: process.env.ATTESA_RISCALDAMENTO_ENABLED === '1',
  maxMs: Number(process.env.ATTESA_RISCALDAMENTO_MAX_MIN || 25) * 60_000,
  pollMs: Number(process.env.ATTESA_RISCALDAMENTO_POLL_MIN || 3) * 60_000,
};

async function runReallocCycle({ dryRunOnly = false, valueTriggerFrac = VALUE_TRIGGER_FRAC, attesa = ATTESA_DIFETTO } = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const t0 = now();
  const passi = [];
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const traccia = (fase, evento, dati = {}) => {
    const rec = { at: new Date(now()).toISOString(), fase, evento, ...dati };
    passi.push(rec);
    try { log(rec); } catch { /* il registro non blocca il ciclo */ }
    return rec;
  };
  const referto = (azione, motivo, extra = {}) => ({
    ok: azione !== 'fermato',
    at: new Date(t0).toISOString(), latencyMs: now() - t0,
    dryRun: dryRunOnly === true,
    azione, motivo, passi, ...extra,
  });

  // ── PASSO 1 · CHI STIAMO GESTENDO ───────────────────────────────────────────────────────────────
  // L'unione dei due registri, non uno solo: divergono, e ognuno dei due da solo racconta meno di metà.
  let abilitati = [], tracking = [];
  try {
    abilitati = (deps.readEnabled() || []).map(normId).filter(Boolean);
    tracking = (deps.readTracking() || []).map(normId).filter(Boolean);
  } catch (e) {
    traccia('inventario', 'lettura-fallita', { error: e.message });
    return referto('fermato', `i registri locali dei mercati gestiti non sono leggibili (${e.message}): non si tocca nulla`);
  }
  const gestiti = [...new Set([...abilitati, ...tracking])];
  traccia('inventario', 'letto', { abilitati: abilitati.length, tracking: tracking.length, gestiti: gestiti.length, gestitiIds: gestiti });

  if (!gestiti.length) {
    // Nessun mercato in gestione. Il riallocatore NON parte da fermo di sua iniziativa: la prima
    // allocazione resta una decisione dell'operatore, presa col flusso a due passi della dashboard.
    // Questo processo mantiene un'allocazione viva; non ne apre una.
    traccia('verifica', 'niente-da-verificare', {});
    return referto('nessuna', 'nessun mercato in gestione: il riallocatore mantiene un\'allocazione esistente, non ne apre una da zero');
  }

  // ── PASSO 2 · IL VERDETTO SU OGNUNO ─────────────────────────────────────────────────────────────
  let poolAlPiano = {};
  try { poolAlPiano = deps.readPlanPools ? (deps.readPlanPools() || {}) : {}; }
  catch { poolAlPiano = {}; }   // riferimento assente ⇒ il controllo sul crollo del montepremi non si applica, gli altri sì

  const verdetti = [];
  for (const marketId of gestiti) {
    let venue = null;
    try { venue = await deps.readVenue({ marketId }); }
    catch (e) { venue = { readable: false, error: e && e.message ? e.message : String(e) }; }
    const v = marketValidity({ marketId, venue, poolAlPiano: poolAlPiano[marketId] ?? null, nowMs: now() });
    verdetti.push(v);
    traccia('verifica', v.stato, { marketId, valido: v.valido, motivo: v.motivo, ...v.dettagli });
  }

  const decisione = decidiRiallocazione(verdetti);
  const triggerValidita = decisione.riallocare === true;
  traccia('trigger', 'validita', {
    scattato: triggerValidita, motivo: decisione.motivo,
    validi: decisione.validi.length, invalidi: decisione.invalidi.length, illeggibili: decisione.illeggibili.length,
  });

  // Da qui in poi il ciclo prosegue ANCHE se il primo trigger non è scattato: il secondo va misurato
  // comunque. Quando il primo non è scattato, però, un ingresso mancante non è un guasto da urlare — non
  // stava per succedere niente. Si registra che il confronto di valore non era misurabile e si chiude in
  // pace: `mancato(...)` è quella via d'uscita, `fermato` resta per quando c'era davvero un reset in ballo.
  const mancato = (fase, motivo, extra = {}) => {
    traccia('trigger', 'valore', { scattato: false, misurabile: false, fase, motivo });
    return referto('nessuna',
      `${decisione.motivo} — e il confronto di valore non è stato misurabile (${motivo})`,
      { verdetti, valore: { misurabile: false, motivo, fase }, ...extra });
  };

  // ── PASSO 3 · QUANTO CAPITALE ───────────────────────────────────────────────────────────────────
  // Il saldo reale, non una costante. Un piano calcolato su un capitale che non c'è produce righe che
  // verranno rifiutate una per una, cioè un reset che svuota il libro e non lo riempie.
  let saldo = null;
  try { saldo = await deps.readBalance(); } catch (e) { saldo = { readable: false, error: e.message }; }
  if (!saldo || saldo.readable !== true || !fin(saldo.usd) || saldo.usd <= 0) {
    traccia('capitale', 'non-leggibile', { saldo: saldo || null });
    if (!triggerValidita) return mancato('capitale', 'il saldo libero non è leggibile');
    return referto('fermato',
      'il saldo libero non è leggibile (o è zero): senza sapere quanto capitale c\'è non si può decidere un piano, e si sarebbe cancellato tutto per non piazzare niente',
      { verdetti });
  }
  // ── IL CAPITALE NON PUÒ SUPERARE IL TETTO DI ESPOSIZIONE APERTA ────────────────────────────────
  // Il piano alloca capitale che diventa nozionale a riposo uno a uno: la somma delle due gambe di un
  // mercato è esattamente il capitale di quella riga. Quindi un piano da $663 su un tetto di $600
  // (`maxOpenNotionalUsd` in lib/safety/risk-limits) non è un piano da $663: è un piano da $600 più
  // una sequenza che si ferma a metà sul cap cumulativo, cioè un'allocazione parziale decisa dal caso
  // invece che dall'ottimizzatore.
  //
  // Si taglia il CAPITALE, non si alza il tetto: il tetto di rischio è la cosa che non si tocca per
  // far entrare un piano. E si taglia PRIMA del knapsack, così l'ottimizzatore sceglie sapendo quanto
  // ha davvero — un piano calcolato su $663 e poi troncato a $600 non è il miglior piano da $600.
  //
  // Il tetto si legge; se non è leggibile NON si inventa un limite e non si procede senza: senza
  // sapere quanto si può esporre, un piano è una scommessa su un numero che nessuno ha letto.
  let tettoEsposizione = null;
  if (typeof deps.readExposureCap === 'function') {
    try { tettoEsposizione = deps.readExposureCap(); } catch (e) { tettoEsposizione = { readable: false, error: e.message }; }
    if (!tettoEsposizione || tettoEsposizione.readable !== true || !fin(tettoEsposizione.maxOpenNotionalUsd) || tettoEsposizione.maxOpenNotionalUsd <= 0) {
      traccia('capitale', 'tetto-esposizione-non-leggibile', { tetto: tettoEsposizione || null });
      const perche = `il tetto di esposizione aperta non è leggibile (${(tettoEsposizione && tettoEsposizione.error) || 'assente'}): un limite che non si è letto non è un limite alto`;
      if (!triggerValidita) return mancato('capitale', perche);
      return referto('fermato', `${perche} — nessun ordine viene toccato`, { verdetti });
    }
  }
  const limite = tettoEsposizione ? tettoEsposizione.maxOpenNotionalUsd : null;
  const capitale = limite != null ? Math.min(saldo.usd, limite) : saldo.usd;
  const tetto = capPerMarketUsd(capitale);
  traccia('capitale', 'letto', {
    capitaleUsd: capitale, saldoLiberoUsd: saldo.usd,
    tettoEsposizioneUsd: limite,
    limitatoDa: limite != null && limite < saldo.usd ? 'tetto-esposizione' : 'saldo',
    // `tettoDichiarato` è il numero fisso; `tettoPerMercatoUsd` è quello davvero applicato, che coincide
    // salvo quando il capitale è più basso del tetto e lo stringe. Due campi perché un tetto sceso per
    // mancanza di capitale e un tetto pieno non vanno letti allo stesso modo.
    tettoPerMercatoUsd: tetto, tettoDichiaratoUsd: MARKET_CAP_FIXED_USD,
    mercatiNecessari: Math.ceil(capitale / tetto),
  });

  // ── PASSO 4 · IL PIANO NUOVO ────────────────────────────────────────────────────────────────────
  let piano = null;
  try { piano = await deps.makePlan({ capital: capitale, maxPerMarketUsd: tetto }); }
  catch (e) {
    traccia('piano', 'fallito', { error: e.message });
    if (!triggerValidita) return mancato('piano', `il calcolo del piano è fallito (${e.message})`);
    return referto('fermato', `il calcolo del piano è fallito (${e.message}): nessun ordine viene toccato`, { verdetti });
  }
  if (!piano || piano.error) {
    traccia('piano', 'errore', { error: (piano && piano.error) || 'risposta vuota' });
    if (!triggerValidita) return mancato('piano', `l'allocatore ha risposto con un errore (${(piano && piano.error) || 'risposta vuota'})`);
    return referto('fermato', `l'allocatore ha risposto con un errore (${(piano && piano.error) || 'risposta vuota'}): nessun ordine viene toccato`, { verdetti });
  }

  // ── L'UNIVERSO ERA VUOTO O IL PIANO ERA MAGRO? NON SONO LA STESSA COSA ─────────────────────────
  // Un piano senza righe perché nessun mercato conviene è un risultato: la risposta giusta è andare
  // piatti. Un piano senza righe perché lo storico prezzi non è arrivato è ignoranza travestita da
  // risultato, e cancellare tutto sulla sua parola sarebbe un reset deciso al buio. Si distinguono
  // guardando se l'universo è stato davvero valutato.
  // `universe.evaluated` e NON `candidates.length`: il registro dei candidati contiene anche i mercati
  // scartati PRIMA del knapsack (quelli senza storico prezzi), quindi resta pieno anche quando
  // l'ottimizzatore non ha potuto valutare niente. È il numero dei valutati davvero che distingue un
  // piano magro da un piano cieco.
  const universoValutato = valutati(piano);
  const copertura = piano.coverage && fin(piano.coverage.coveredMarketCount) ? piano.coverage.coveredMarketCount : 0;
  if (universoValutato === 0 || copertura === 0) {
    traccia('piano', 'universo-vuoto', { candidati: universoValutato, mercatiConStorico: copertura });
    const perche = `l'allocatore ha valutato ${universoValutato} candidati su ${copertura} mercati con storico: un universo vuoto non è un piano vuoto, è un dato mancante`;
    if (!triggerValidita) return mancato('piano', perche);
    return referto('fermato', `${perche} — nessun ordine viene toccato`, { verdetti });
  }

  let esec = planToOrders(piano, { nowMs: now() });

  // ── LA RETE SOTTO L'UNIONE MOBILE (nasce SPENTA) ───────────────────────────────────────────────
  // L'unione mobile tiene caldi i mercati che il piano ha scelto o quasi-scelto nelle ultime ore, ma non
  // può coprire il mercato che entra nel piano senza esserci MAI stato: per quello la lista si scrive
  // troppo tardi. Se acceso, questo passo aspetta che il raccoglitore lo copra invece di piazzare su un
  // piano dimezzato. In live ritarda un reset che il trigger di validità ha già giudicato urgente — ed è
  // per questo che si accende da fuori, non da qui.
  if (attesa.enabled) {
    const { attendiRiscaldamento } = require('./attesa-riscaldamento');
    const r = await attendiRiscaldamento(
      { piano, esec, capitale, tetto, enabled: true, maxMs: attesa.maxMs, pollMs: attesa.pollMs },
      { makePlan: deps.makePlan, planToOrders, sleep: deps.sleep, now, traccia },
    );
    piano = r.piano; esec = r.esec;
  }

  // ── PASSO 4b · I MERCATI CHE ENTRANO NEL PIANO SONO ANCORA VIVI? ────────────────────────────────
  // Il passo 2 chiede al venue lo stato dei mercati GIÀ IN GESTIONE. Non basta: le righe del piano nuovo
  // nascono da data/liquidity-rewards.json, una fotografia che agent24 rinfresca ogni 15 minuti, e fra
  // una fotografia e l'altra un mercato può risolversi, smettere di accettare ordini o vedersi rifare il
  // montepremi. Senza questo passo il ciclo cancellava ordini buoni per piazzarne su un mercato che sul
  // venue non esisteva più — e lo faceva da solo, senza nessuno che guardasse.
  //
  // Si verifica solo ciò che si PIAZZEREBBE (esec.rows), non tutto il piano: le righe già scartate da
  // planToOrders non diventeranno ordini e interrogare il venue su di loro sarebbe rumore.
  //
  // Il montepremi di riferimento è quello del piano STESSO, non quello di un piano vecchio: se il board
  // dice $100/g e il venue ne dice $3/g, il mercato entra nel piano con un peso che non ha. È lo stesso
  // controllo del 3 agosto, applicato in entrata invece che in uscita.
  //
  // TRE ESITI, e ognuno ha la sua risposta:
  //   · tutto valido        → si prosegue
  //   · qualcuno bocciato   → si rifà il piano SENZA di lui (il capitale va altrove) e si riverifica
  //   · qualcuno illeggibile→ non si piazza al buio: ci si ferma e si riprova al ciclo successivo
  const boardAgeS = piano.board && fin(piano.board.ageS) ? piano.board.ageS : null;
  if (boardAgeS == null || boardAgeS * 1000 > BOARD_MAX_AGE_MS) {
    traccia('verifica-piano', 'board-stantio', { boardAgeS, limiteS: BOARD_MAX_AGE_MS / 1000 });
    const perche = boardAgeS == null
      ? 'l\'età della fotografia del board non è leggibile: non si sa su che dati il piano è nato'
      : `la fotografia del board ha ${Math.round(boardAgeS / 60)} minuti (limite ${BOARD_MAX_AGE_MS / 60_000}): montepremi, banda e scadenza sarebbero di un'altra ora`;
    if (!triggerValidita) return mancato('verifica-piano', perche);
    return referto('fermato', `${perche} — nessun ordine viene toccato`, { verdetti });
  }

  const esclusiDalVenue = [];
  for (let passata = 1; ; passata++) {
    if (!esec.rows.length) break;   // niente da piazzare ⇒ niente da verificare
    const potDelPiano = new Map();
    for (const c of piano.candidates || []) {
      if (c.status === 'scelto' && fin(c.pot)) potDelPiano.set(normId(c.marketId), c.pot);
    }
    const bocciati = [], illeggibili = [];
    // Un mercato, una domanda al venue. Da quando planToOrders emette due gambe per mercato le righe
    // eseguibili sono due per lo stesso conditionId: interrogarlo due volte darebbe la stessa risposta
    // al doppio del costo, e due verdetti identici nel registro.
    for (const marketId of [...new Set(esec.rows.map((r) => normId(r.marketId)))]) {
      let venue = null;
      try { venue = await deps.readVenue({ marketId }); }
      catch (e) { venue = { readable: false, error: e && e.message ? e.message : String(e) }; }
      const v = marketValidity({ marketId, venue, poolAlPiano: potDelPiano.get(marketId) ?? null, nowMs: now() });
      if (v.valido === false) bocciati.push(v);
      else if (v.valido === null) illeggibili.push(v);
      traccia('verifica-piano', v.stato, { passata, marketId, valido: v.valido, motivo: v.motivo, ...v.dettagli });
    }

    if (illeggibili.length) {
      // Per un mercato GIÀ IN GESTIONE «illeggibile» vuol dire «lascialo dov'è», e non fa scattare nulla.
      // Per un mercato che sta per RICEVERE ordini veri la parte non agente è l'opposto: non piazzare.
      // Non si conclude che sia morto — si conclude che non lo si è potuto confermare, e non si scommette
      // capitale su una conferma mancata.
      const perche = `${illeggibili.length} mercato/i del piano non è leggibile dal venue (${illeggibili.map((x) => x.marketId.slice(0, 10)).join(', ')}): non si piazzano ordini veri su un mercato che non si è potuto confermare`;
      traccia('verifica-piano', 'interrotto-illeggibile', { passata, illeggibili: illeggibili.map((x) => x.marketId) });
      if (!triggerValidita) return mancato('verifica-piano', perche);
      return referto('fermato', `${perche} — si riprova al ciclo successivo`, { verdetti, esclusiDalVenue });
    }

    if (!bocciati.length) {
      if (passata > 1) traccia('verifica-piano', 'ripulito', { passata, esclusi: esclusiDalVenue.length, righeEseguibili: esec.rows.length });
      break;
    }

    // Senza il filtro sui già noti un mercato che l'allocatore continua a riproporre comparirebbe una
    // volta per passata, e il referto direbbe «3 mercati esclusi» dove ce n'è uno solo, tre volte.
    const giaEsclusi = new Set(esclusiDalVenue.map((x) => x.marketId));
    esclusiDalVenue.push(...bocciati
      .filter((x) => !giaEsclusi.has(x.marketId))
      .map((x) => ({ marketId: x.marketId, stato: x.stato, motivo: x.motivo })));
    traccia('verifica-piano', 'esclusi', { passata, esclusi: bocciati.map((x) => `${x.marketId.slice(0, 10)}… ${x.stato}`) });

    if (passata >= PLAN_VERIFY_MAX_PASSES) {
      const perche = `dopo ${PLAN_VERIFY_MAX_PASSES} ricalcoli il piano contiene ancora mercati che il venue rifiuta (${bocciati.length} all'ultimo giro): la fotografia da cui nasce il piano non è affidabile`;
      if (!triggerValidita) return mancato('verifica-piano', perche);
      return referto('fermato', `${perche} — nessun ordine viene toccato`, { verdetti, esclusiDalVenue });
    }

    // ── SI RIFÀ IL PIANO SENZA DI LORO, così il capitale va altrove invece di restare fermo ─────────
    const escludi = esclusiDalVenue.map((x) => x.marketId);
    let rifatto = null;
    try { rifatto = await deps.makePlan({ capital: capitale, maxPerMarketUsd: tetto, excludeMarketIds: escludi }); }
    catch (e) { rifatto = null; traccia('verifica-piano', 'ricalcolo-fallito', { passata, error: e.message }); }
    if (!rifatto || rifatto.error || valutati(rifatto) === 0) {
      const perche = `il ricalcolo del piano senza i ${escludi.length} mercati bocciati dal venue non è riuscito (${(rifatto && rifatto.error) || 'universo vuoto o risposta assente'})`;
      if (!triggerValidita) return mancato('verifica-piano', perche);
      return referto('fermato', `${perche}: nessun ordine viene toccato`, { verdetti, esclusiDalVenue });
    }
    piano = rifatto;
    esec = planToOrders(piano, { nowMs: now() });
    traccia('verifica-piano', 'ricalcolato', {
      passata, esclusi: escludi.length,
      mercatiNelPiano: (piano.rows || []).length, righeEseguibili: esec.rows.length,
      capitaleImpegnatoUsd: esec.totals.capitaleUsd,
    });
  }

  traccia('piano', 'calcolato', {
    capitaleUsd: capitale, tettoPerMercatoUsd: tetto,
    boardEtaS: boardAgeS,
    esclusiDalVenue: esclusiDalVenue.map((x) => `${x.marketId.slice(0, 10)}… ${x.stato}`),
    mercatiNelPiano: (piano.rows || []).length,
    mercatiEseguibili: esec.totals.eseguibili, righeEseguibili: esec.rows.length,
    gambePerMercato: esec.totals.eseguibili > 0 ? +(esec.rows.length / esec.totals.eseguibili).toFixed(2) : null,
    righeScartate: esec.scartate.map((x) => `${x.marketId.slice(0, 10)}… ${x.motivo}`),
    capitaleImpegnatoUsd: esec.totals.capitaleUsd,
    lordoStimatoGiorno: piano.totals ? piano.totals.grossPerDay : null,
    correttoStimatoGiorno: piano.totals ? piano.totals.realisticPerDay : null,
    concentrazione: piano.concentration || null,
  });

  // ── PASSO 5 · IL SECONDO TRIGGER: IL PIANO FRESCO VALE ABBASTANZA DI PIÙ? ───────────────────────
  // Lo stesso allocatore, lo stesso istante, lo stesso capitale, lo stesso tetto — ristretto ai mercati
  // già in gestione. Quello che resta della differenza è la scelta dei mercati, e solo quella.
  const valore = await confrontoDiValore({
    piano, gestiti, capitale, tetto, makePlan: deps.makePlan, soglia: valueTriggerFrac,
  });
  traccia('trigger', 'valore', {
    scattato: valore.scattato, misurabile: valore.misurabile, motivo: valore.motivo,
    frescoCorrettoGiorno: valore.fresco, produzioneCorrettoGiorno: valore.produzione,
    guadagno: valore.guadagno, soglia: valueTriggerFrac,
    mercatiFreschi: valore.mercatiFreschi, mercatiInProduzione: valore.mercatiInProduzione,
  });
  const triggerValore = valore.scattato === true;

  // ── LA CAUSA ────────────────────────────────────────────────────────────────────────────────────
  // Registrata per nome: fra un mese, davanti a un ordine cancellato, «quale dei due controlli l'ha
  // deciso» è la prima domanda, e una risposta ricostruita a posteriori non vale niente.
  const causa = triggerValidita && triggerValore ? 'entrambi' : triggerValidita ? 'validita' : triggerValore ? 'valore' : null;
  traccia('decisione', causa ? 'riallocare' : 'nessuna-azione', { causa, triggerValidita, triggerValore });

  if (!causa) {
    return referto('nessuna',
      `${decisione.motivo}; e il piano fresco ${valore.misurabile ? `vale ${valore.guadagno == null ? '—' : (valore.guadagno * 100).toFixed(1) + '%'} in più della soglia del ${Math.round(valueTriggerFrac * 100)}% non raggiunta` : `non è confrontabile (${valore.motivo})`}: nessuna azione`,
      { verdetti, valore, esclusiDalVenue, piano: sintesiPiano(piano, esec) });
  }

  // ── PASSO 6 · IL RESET ──────────────────────────────────────────────────────────────────────────
  // Da qui in poi comanda allocation-reset.js, con i suoi fermi duri. Questo modulo non cancella e non
  // piazza: passa le righe e riporta il referto.
  const pianoVecchio = {
    mercati: gestiti,
    validi: decisione.validi.map((x) => x.marketId),
    invalidi: decisione.invalidi.map((x) => ({ marketId: x.marketId, stato: x.stato, motivo: x.motivo })),
    valoreOggiCorrettoGiorno: valore.produzione,
  };

  let reset = null;
  try { reset = await deps.runReset({ rows: esec.rows, dryRunOnly }); }
  catch (e) {
    traccia('reset', 'eccezione', { error: e.message });
    return referto('fermato', `il reset ha sollevato un'eccezione (${e.message})`, { verdetti, esclusiDalVenue, piano: sintesiPiano(piano, esec), pianoVecchio });
  }

  traccia('reset', reset.ok ? 'completato' : 'fermato', {
    stoppedBy: reset.stoppedBy || null, reason: reset.reason || null,
    cancellati: reset.cancellazione && Array.isArray(reset.cancellazione.cancellati) ? reset.cancellazione.cancellati.length : null,
    abilitati: reset.accensione ? (reset.accensione.markets || []).length : null,
    piazzati: reset.piazzamento ? reset.piazzamento.placed : null,
    rifiutati: reset.piazzamento ? reset.piazzamento.refused : null,
  });

  // ── PASSO 6 · IL RIFERIMENTO PER IL PROSSIMO GIRO ───────────────────────────────────────────────
  // I montepremi con cui QUESTO piano è stato deciso. Senza questa riga il controllo sul crollo del
  // montepremi non ha un metro, ed è il controllo che avrebbe visto il caso del 3 agosto.
  if (reset.ok && !dryRunOnly && typeof deps.writePlanPools === 'function') {
    const pools = {};
    for (const c of piano.candidates || []) {
      if (c.status === 'scelto' && fin(c.pot)) pools[normId(c.marketId)] = c.pot;
    }
    try { deps.writePlanPools(pools); traccia('riferimento', 'scritto', { mercati: Object.keys(pools).length }); }
    catch (e) { traccia('riferimento', 'scrittura-fallita', { error: e.message }); }
  }

  // ── E IL TETTO DI POSIZIONE ─────────────────────────────────────────────────────────────────────
  // Il soffitto per mercato della fill strategy è DERIVATO dal piano (lib/maker/allocated-capital.js) e
  // oggi lo scrive solo /api/rewards/allocate, cioè solo quando il piano nasce dal pannello. Un piano
  // nato qui deve scriverlo allo stesso modo, altrimenti il soffitto resta quello del piano PRECEDENTE:
  // mercati che non ci sono più con un tetto, mercati nuovi senza. Si scrive dopo il reset riuscito e
  // solo allora, così la fotografia del tetto descrive lo stato che c'è davvero. Se la scrittura fallisce
  // il piano resta valido: senza soffitto la strategia automatica fallisce CHIUSA (nessuna esposizione
  // nuova), non aperta.
  if (reset.ok && !dryRunOnly && typeof deps.writeAllocatedCapital === 'function') {
    try {
      deps.writeAllocatedCapital({
        rows: (piano.rows || []).map((r) => ({ marketId: r.marketId, capital: r.capital })),
        capital: piano.capital ?? null,
      });
      traccia('tetto-posizione', 'scritto', { mercati: (piano.rows || []).length, capitaleUsd: piano.capital ?? null });
    } catch (e) { traccia('tetto-posizione', 'scrittura-fallita', { error: e.message }); }
  }

  if (!reset.ok) {
    return referto('fermato',
      `il reset si è fermato (${reset.stoppedBy}): ${reset.reason} — si riprova al ciclo successivo, non subito`,
      { verdetti, valore, causa, esclusiDalVenue, piano: sintesiPiano(piano, esec), pianoVecchio, reset });
  }

  return referto('reset', motivoDellaCausa(causa, decisione, valore, valueTriggerFrac),
    { verdetti, valore, causa, esclusiDalVenue, piano: sintesiPiano(piano, esec), pianoVecchio, reset });
}

/**
 * IL CONFRONTO DI VALORE — quanto varrebbe, al meglio, restare dove si è.
 *
 * Ricalcola il piano restringendo l'universo ai soli mercati già in gestione e mette i due «corretto/g»
 * uno accanto all'altro. Non decide niente da solo: risponde `scattato` solo quando il confronto è stato
 * davvero MISURATO, e in tutti gli altri casi risponde `misurabile:false`, che non fa scattare nulla.
 *
 * Le astensioni, una per una, e perché nessuna è pigrizia:
 *   · l'allocatore ristretto fallisce o risponde vuoto  → non si sa quanto vale restare: non è «zero»
 *   · nessuno dei mercati in gestione è valutabile oggi → mancano i dati su di loro, non il loro valore
 *   · il corretto/g è ignoto da una delle due parti     → un confronto con un ignoto non è un confronto
 *   · righe con correzione ignota nel piano in produzione → lo sottostimerebbero, e sottostimare ciò che
 *     si ha significa scattare a favore del churn: si preferisce non scattare
 *
 * L'unico caso in cui un valore nullo fa scattare è quello MISURATO: i mercati in gestione sono stati
 * valutati e non valgono niente. Lì lo zero è un fatto, non un buco.
 */
async function confrontoDiValore({ piano, gestiti, capitale, tetto, makePlan, soglia }) {
  const vuoto = (motivo) => ({ scattato: false, misurabile: false, motivo, fresco: null, produzione: null, guadagno: null, mercatiFreschi: null, mercatiInProduzione: null, soglia });

  const fresco = piano.totals ? piano.totals.realisticPerDay : null;
  if (!fin(fresco)) return vuoto('il corretto/g del piano fresco non è calcolabile');

  let pianoInProduzione = null;
  try { pianoInProduzione = await makePlan({ capital: capitale, maxPerMarketUsd: tetto, onlyMarketIds: gestiti }); }
  catch (e) { return vuoto(`il piano ristretto ai mercati in gestione è fallito (${e.message})`); }
  if (!pianoInProduzione || pianoInProduzione.error) return vuoto(`il piano ristretto ha risposto con un errore (${(pianoInProduzione && pianoInProduzione.error) || 'risposta vuota'})`);

  // Misurato in produzione il 3 agosto 2026: con un universo ristretto a mercati senza storico prezzi,
  // `candidates` restava a 115 (i pre-scartati dell'intero board) mentre i valutati erano ZERO e il
  // corretto/g usciva 0,00. Senza questa riga il trigger avrebbe letto «i tuoi mercati non valgono
  // niente» e avrebbe cancellato ordini veri per ignoranza.
  if (valutati(pianoInProduzione) === 0) {
    return vuoto('nessuno dei mercati in gestione è valutabile oggi (zero valutati dall\'ottimizzatore): mancano i dati su di loro, non il loro valore');
  }
  const produzione = pianoInProduzione.totals ? pianoInProduzione.totals.realisticPerDay : null;
  if (!fin(produzione)) return vuoto('il corretto/g dei mercati in gestione non è calcolabile');
  const ignote = pianoInProduzione.totals ? pianoInProduzione.totals.realisticRowsUnknown : null;
  if (fin(ignote) && ignote > 0) {
    return vuoto(`${ignote} riga/he del piano in produzione ha la correzione ignota: lo sottostimerebbe, e sottostimare ciò che si ha vorrebbe dire scattare a favore del churn`);
  }

  const guadagno = produzione > 0 ? (fresco / produzione) - 1 : (fresco > 0 ? Infinity : 0);
  const scattato = guadagno > soglia;
  return {
    scattato, misurabile: true,
    motivo: produzione > 0
      ? `il piano fresco vale $${fresco.toFixed(2)}/g contro $${produzione.toFixed(2)}/g dei mercati in gestione (${guadagno === Infinity ? '∞' : (guadagno * 100).toFixed(1) + '%'} in più, soglia ${Math.round(soglia * 100)}%)`
      : `i mercati in gestione valgono $0,00/g mentre il piano fresco vale $${fresco.toFixed(2)}/g`,
    fresco: +fresco.toFixed(4), produzione: +produzione.toFixed(4),
    guadagno: guadagno === Infinity ? null : +guadagno.toFixed(4),
    guadagnoInfinito: guadagno === Infinity,
    mercatiFreschi: (piano.rows || []).length,
    mercatiInProduzione: (pianoInProduzione.rows || []).length,
    soglia,
  };
}

/** Il motivo del reset, detto da chi l'ha causato. */
function motivoDellaCausa(causa, decisione, valore, soglia) {
  if (causa === 'validita') return `[validità] ${decisione.motivo}`;
  if (causa === 'valore') return `[valore] tutti i mercati in gestione sono ancora validi, ma ${valore.motivo}`;
  return `[validità + valore] ${decisione.motivo}; e inoltre ${valore.motivo}`;
}

/** La sintesi del piano che finisce nel registro: i numeri che servono a rispondere «cos'è cambiato». */
function sintesiPiano(piano, esec) {
  return {
    capitale: piano.capital ?? null,
    concentrazione: piano.concentration || null,
    mercati: (piano.rows || []).map((r) => ({
      marketId: r.marketId, nome: r.name || r.shortId, capitale: r.capital,
      lordoGiorno: r.grossInBandPerDay ?? null,
    })),
    totali: piano.totals || null,
    mercatiEseguibili: esec.totals.eseguibili,
    righeEseguibili: esec.rows.length,
    coppie: esec.coppie || [],
    righeScartate: esec.scartate,
    capitaleImpegnatoUsd: esec.totals.capitaleUsd,
  };
}

module.exports = { runReallocCycle, MARKET_CAP_FIXED_USD, INTERVAL_MS, VALUE_TRIGGER_FRAC, PLAN_VERIFY_MAX_PASSES, BOARD_MAX_AGE_MS };

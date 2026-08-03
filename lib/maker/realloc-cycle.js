'use strict';
// lib/maker/realloc-cycle.js — UN GIRO DEL RIALLOCATORE PERIODICO.
//
// ═══ COSA FA, IN UNA FRASE ═══════════════════════════════════════════════════════════════════════════
// Guarda i mercati che il bot sta gestendo davvero; se anche uno solo non è più quello su cui il piano
// era stato deciso, rifà il piano da zero e lo mette in opera con il reset completo che già esiste.
// Se sono tutti ancora buoni, non fa niente — e «non fare niente» è un esito, non un fallimento.
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
//   · cancellazione fallita a metà      → è allocation-reset.js a fermarsi, prima di ogni scrittura
//
// E in nessuno di questi casi si riprova subito. Si riprova al giro dopo. Un riallocatore che ritenta in
// loop su un venue che non risponde è un modo elaborato di martellare un servizio già in difficoltà, e
// trasforma un guasto passeggero in una raffica di azioni sul capitale.
//
// ═══ IL TETTO DI CONCENTRAZIONE ═════════════════════════════════════════════════════════════════════
// Il piano nuovo si calcola con al massimo il 30% del capitale su un singolo mercato. Non è una
// preferenza estetica: nella misura del 3 agosto il knapsack senza tetto metteva il 68% del reward atteso
// su un mercato solo, ed è esattamente quel mercato che è poi collassato. Il tetto non avrebbe evitato il
// collasso — nessun tetto lo fa — ma avrebbe ridotto quanto del piano se ne andava con lui.

const { marketValidity, decidiRiallocazione } = require('./market-validity');
const { planToOrders } = require('../rewards/plan-to-orders');

const CONCENTRATION_CAP_FRAC = 0.30;   // max 30% del capitale su un singolo mercato
const INTERVAL_MS = 6 * 3_600_000;     // ogni 6 ore — l'intervallo, non una costante di sicurezza

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

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
 *   makePlan({capital, maxPerMarketUsd}) → il corpo di planFromCollection
 *   runReset({rows, dryRunOnly})         → lib/maker/allocation-reset.runAllocationReset
 *   log(record)                          → registro persistente, una riga per passo
 *   now()
 * @returns {{ok, azione, motivo, ...}}  azione ∈ nessuna | reset | fermato
 */
async function runReallocCycle({ dryRunOnly = false } = {}, deps = {}) {
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
  traccia('decisione', decisione.riallocare ? 'riallocare' : 'nessuna-azione', {
    motivo: decisione.motivo,
    validi: decisione.validi.length, invalidi: decisione.invalidi.length, illeggibili: decisione.illeggibili.length,
  });
  if (!decisione.riallocare) return referto('nessuna', decisione.motivo, { verdetti });

  // ── PASSO 3 · QUANTO CAPITALE ───────────────────────────────────────────────────────────────────
  // Il saldo reale, non una costante. Un piano calcolato su un capitale che non c'è produce righe che
  // verranno rifiutate una per una, cioè un reset che svuota il libro e non lo riempie.
  let saldo = null;
  try { saldo = await deps.readBalance(); } catch (e) { saldo = { readable: false, error: e.message }; }
  if (!saldo || saldo.readable !== true || !fin(saldo.usd) || saldo.usd <= 0) {
    traccia('capitale', 'non-leggibile', { saldo: saldo || null });
    return referto('fermato',
      'il saldo libero non è leggibile (o è zero): senza sapere quanto capitale c\'è non si può decidere un piano, e si sarebbe cancellato tutto per non piazzare niente',
      { verdetti });
  }
  const capitale = saldo.usd;
  const tetto = +(capitale * CONCENTRATION_CAP_FRAC).toFixed(2);
  traccia('capitale', 'letto', { capitaleUsd: capitale, tettoPerMercatoUsd: tetto, frazione: CONCENTRATION_CAP_FRAC });

  // ── PASSO 4 · IL PIANO NUOVO ────────────────────────────────────────────────────────────────────
  let piano = null;
  try { piano = await deps.makePlan({ capital: capitale, maxPerMarketUsd: tetto }); }
  catch (e) {
    traccia('piano', 'fallito', { error: e.message });
    return referto('fermato', `il calcolo del piano è fallito (${e.message}): nessun ordine viene toccato`, { verdetti });
  }
  if (!piano || piano.error) {
    traccia('piano', 'errore', { error: (piano && piano.error) || 'risposta vuota' });
    return referto('fermato', `l'allocatore ha risposto con un errore (${(piano && piano.error) || 'risposta vuota'}): nessun ordine viene toccato`, { verdetti });
  }

  // ── L'UNIVERSO ERA VUOTO O IL PIANO ERA MAGRO? NON SONO LA STESSA COSA ─────────────────────────
  // Un piano senza righe perché nessun mercato conviene è un risultato: la risposta giusta è andare
  // piatti. Un piano senza righe perché lo storico prezzi non è arrivato è ignoranza travestita da
  // risultato, e cancellare tutto sulla sua parola sarebbe un reset deciso al buio. Si distinguono
  // guardando se l'universo è stato davvero valutato.
  const universoValutato = (piano.candidates || []).length;
  const copertura = piano.coverage && fin(piano.coverage.coveredMarketCount) ? piano.coverage.coveredMarketCount : 0;
  if (universoValutato === 0 || copertura === 0) {
    traccia('piano', 'universo-vuoto', { candidati: universoValutato, mercatiConStorico: copertura });
    return referto('fermato',
      `l'allocatore ha valutato ${universoValutato} candidati su ${copertura} mercati con storico: un universo vuoto non è un piano vuoto, è un dato mancante — nessun ordine viene toccato`,
      { verdetti });
  }

  const esec = planToOrders(piano, { nowMs: now() });
  traccia('piano', 'calcolato', {
    capitaleUsd: capitale, tettoPerMercatoUsd: tetto,
    mercatiNelPiano: (piano.rows || []).length,
    righeEseguibili: esec.rows.length, righeScartate: esec.scartate.map((x) => `${x.marketId.slice(0, 10)}… ${x.motivo}`),
    capitaleImpegnatoUsd: esec.totals.capitaleUsd,
    lordoStimatoGiorno: piano.totals ? piano.totals.grossPerDay : null,
    correttoStimatoGiorno: piano.totals ? piano.totals.realisticPerDay : null,
    concentrazione: piano.concentration || null,
  });

  // ── PASSO 5 · IL RESET ──────────────────────────────────────────────────────────────────────────
  // Da qui in poi comanda allocation-reset.js, con i suoi fermi duri. Questo modulo non cancella e non
  // piazza: passa le righe e riporta il referto.
  const pianoVecchio = {
    mercati: gestiti,
    validi: decisione.validi.map((x) => x.marketId),
    invalidi: decisione.invalidi.map((x) => ({ marketId: x.marketId, stato: x.stato, motivo: x.motivo })),
  };

  let reset = null;
  try { reset = await deps.runReset({ rows: esec.rows, dryRunOnly }); }
  catch (e) {
    traccia('reset', 'eccezione', { error: e.message });
    return referto('fermato', `il reset ha sollevato un'eccezione (${e.message})`, { verdetti, piano: sintesiPiano(piano, esec), pianoVecchio });
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
      { verdetti, piano: sintesiPiano(piano, esec), pianoVecchio, reset });
  }

  return referto('reset', decisione.motivo, { verdetti, piano: sintesiPiano(piano, esec), pianoVecchio, reset });
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
    righeEseguibili: esec.rows.length,
    righeScartate: esec.scartate,
    capitaleImpegnatoUsd: esec.totals.capitaleUsd,
  };
}

module.exports = { runReallocCycle, CONCENTRATION_CAP_FRAC, INTERVAL_MS };

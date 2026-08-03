'use strict';
// lib/maker/market-validity.js — UN MERCATO IN GESTIONE È ANCORA UN MERCATO CHE VALE LA PENA GESTIRE?
//
// ═══ IL FATTO DA CUI NASCE ═══════════════════════════════════════════════════════════════════════════
// Il 3 agosto 2026 il mercato «Will Apvienotais Saraksts (AS) win the most seats…», che nel piano valeva
// il 68% del reward atteso, è passato in poche ore da $124/giorno di montepremi a $3/giorno. Non si era
// risolto (l'elezione è a ottobre), non era stato tolto dal programma reward, non era un errore di
// lettura: Polymarket aveva semplicemente rifatto i conti sull'intero evento. Il mercato era ancora lì,
// ancora negoziabile, ancora con la sua banda pubblicata — e ancora nel piano, a fare il 2,4% di quello
// che il piano credeva.
//
// Da qui il modulo, e da qui la sua forma: le tre domande ovvie («è risolto?», «è ancora premiato?»,
// «ha ancora una banda?») non bastavano a vedere quel guasto. Ce ne vuole una quarta, che è la sola che
// l'avrebbe visto: «il montepremi è ancora quello su cui il piano è stato deciso?».
//
// ═══ LA REGOLA CHE GOVERNA TUTTO IL MODULO ═══════════════════════════════════════════════════════════
// «Illeggibile» non è «invalido», e non è nemmeno «valido». È il suo verdetto, e non fa scattare niente.
//
// Il riallocatore reagisce a un verdetto invalido cancellando ordini VERI. Farlo perché una chiamata al
// venue è andata in timeout vorrebbe dire liquidare un'allocazione sana per ignoranza — un guasto di rete
// che si trasforma in un'azione sul capitale. Quindi un mercato che non si riesce a leggere resta dov'è,
// il ciclo lo dichiara a voce alta, e si riprova al giro dopo. È lo stesso principio che vale ovunque qui
// dentro: l'assenza di un fatto non indossa i panni del fatto.
//
// Il costo di questa scelta è dichiarato: se il venue diventa illeggibile a lungo, il bot resta con
// l'ultima allocazione buona invece di aggiornarla. Vale meno di un reset deciso al buio.

const HORIZON_MIN_HOURS = 24;      // meno di un giorno alla risoluzione ⇒ non vale un'allocazione nuova
const POOL_COLLAPSE_FRAC = 0.5;    // montepremi sceso sotto metà di quello del piano ⇒ il piano non regge più

/** Vero solo per un numero utilizzabile: null, NaN e stringhe restano fuori. */
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Il verdetto su UN mercato.
 *
 * @param {object} args
 *   marketId
 *   venue     il record letto dal venue, o null/{readable:false} se la lettura è fallita:
 *             { readable, closed, active, acceptingOrders, rewardsDailyRate, maxSpreadCents, minSizeShares, endDate }
 *   poolAlPiano  il montepremi giornaliero che il piano aveva usato per questo mercato (null se ignoto)
 *   nowMs
 * @returns {{marketId, stato, valido, motivo, dettagli}}
 *   stato ∈ valido | illeggibile | risolto | non-negoziabile | senza-premio | senza-banda |
 *           scaduto | in-scadenza | premio-crollato
 *   valido === true  ⇒ si può lasciare com'è
 *   valido === false ⇒ fa scattare il reset
 *   valido === null  ⇒ NON SI SA: non fa scattare niente e non conferma niente
 */
function marketValidity({ marketId, venue, poolAlPiano = null, nowMs = Date.now(), horizonMinHours = HORIZON_MIN_HOURS, poolCollapseFrac = POOL_COLLAPSE_FRAC } = {}) {
  const v = venue || null;
  const esito = (stato, valido, motivo, dettagli = {}) => ({ marketId, stato, valido, motivo, dettagli });

  if (!v || v.readable === false) {
    return esito('illeggibile', null,
      `stato del mercato non leggibile dal venue${v && v.error ? ` (${v.error})` : ''} — non si conclude né che è vivo né che è morto, si riprova al ciclo successivo`,
      { error: (v && v.error) || null });
  }

  // ── RISOLTO / CHIUSO ────────────────────────────────────────────────────────────────────────────
  // `closed` e `active` dicono due cose diverse (mercato risolto vs mercato sospeso dal venue) ma per il
  // bot hanno la stessa conseguenza: non ci si fa più mercato sopra.
  if (v.closed === true) return esito('risolto', false, 'il mercato è chiuso: l\'evento è concluso', { closed: true, active: v.active ?? null });
  if (v.active === false) return esito('risolto', false, 'il mercato non è più attivo sul venue', { closed: v.closed ?? null, active: false });

  // ── NON PIÙ NEGOZIABILE ─────────────────────────────────────────────────────────────────────────
  // Ancora aperto ma non accetta ordini: gli ordini a riposo possono esserci ancora, di nuovi non se ne
  // piazzano. Un piano che lo contiene è un piano che conta capitale che non lavora.
  if (v.acceptingOrders === false) {
    return esito('non-negoziabile', false, 'il venue non accetta più ordini su questo mercato', { acceptingOrders: false });
  }

  // ── SCADENZA ────────────────────────────────────────────────────────────────────────────────────
  // Una data di fine assente NON diventa «scade domani» né «non scade mai»: si prosegue con gli altri
  // controlli e la si riporta come ignota.
  const endMs = typeof v.endDate === 'string' && v.endDate.trim() ? Date.parse(v.endDate) : NaN;
  if (fin(endMs)) {
    const oreResidue = (endMs - nowMs) / 3_600_000;
    if (oreResidue <= 0) return esito('scaduto', false, 'la data di risoluzione è passata', { endDate: v.endDate, oreResidue: +oreResidue.toFixed(2) });
    if (oreResidue < horizonMinHours) {
      return esito('in-scadenza', false,
        `mancano ${oreResidue.toFixed(1)}h alla risoluzione (soglia ${horizonMinHours}h): non vale un'allocazione nuova`,
        { endDate: v.endDate, oreResidue: +oreResidue.toFixed(2) });
    }
  }

  // ── PREMIO ──────────────────────────────────────────────────────────────────────────────────────
  const pot = fin(v.rewardsDailyRate) ? v.rewardsDailyRate : null;
  if (pot == null) {
    // Il campo c'è ma non è un numero: è illeggibile, non è zero. Zero significa «tolto dal programma»,
    // ed è una conclusione che si può trarre solo da un numero davvero letto.
    return esito('illeggibile', null, 'il montepremi giornaliero non è leggibile: non lo si tratta come zero', { rewardsDailyRate: v.rewardsDailyRate ?? null });
  }
  if (pot <= 0) return esito('senza-premio', false, 'il mercato non paga più reward di liquidità', { rewardsDailyRate: pot });

  // ── BANDA ───────────────────────────────────────────────────────────────────────────────────────
  // Senza banda pubblicata il motore non sa dove può stare: è fuori dall'ambito «Ottimizza» per
  // definizione, non per scelta.
  if (!fin(v.maxSpreadCents) || v.maxSpreadCents <= 0) {
    return esito('senza-banda', false, 'nessuna banda reward pubblicata (max_spread assente o nullo)', { maxSpreadCents: v.maxSpreadCents ?? null });
  }

  // ── IL MONTEPREMI È ANCORA QUELLO SU CUI IL PIANO È STATO DECISO? ───────────────────────────────
  // Il controllo che il caso del 3 agosto rende obbligatorio. Si applica SOLO se si sa quale montepremi
  // il piano aveva usato: senza quel riferimento non c'è un crollo da misurare, e inventarne uno
  // significherebbe far scattare reset su mercati sani.
  if (fin(poolAlPiano) && poolAlPiano > 0) {
    const rapporto = pot / poolAlPiano;
    if (rapporto < poolCollapseFrac) {
      return esito('premio-crollato', false,
        `il montepremi è sceso da $${poolAlPiano}/g a $${pot}/g (${Math.round(rapporto * 100)}% di quello su cui il piano era stato deciso)`,
        { poolAlPiano, poolOra: pot, rapporto: +rapporto.toFixed(3) });
    }
  }

  return esito('valido', true, 'attivo, negoziabile, premiato e con banda pubblicata', {
    rewardsDailyRate: pot,
    maxSpreadCents: v.maxSpreadCents,
    minSizeShares: fin(v.minSizeShares) ? v.minSizeShares : null,
    endDate: v.endDate ?? null,
    poolAlPiano: fin(poolAlPiano) ? poolAlPiano : null,
  });
}

/**
 * Il verdetto sull'INSIEME dei mercati in gestione: si riallocca o no.
 *
 * @returns {{riallocare, motivo, validi, invalidi, illeggibili, verdetti}}
 *   riallocare === true  ⇒ almeno un mercato è misuratamente non più valido
 *   riallocare === false ⇒ nessuno lo è (o non ce n'era nessuno da controllare)
 */
function decidiRiallocazione(verdetti) {
  const invalidi = verdetti.filter((x) => x.valido === false);
  const illeggibili = verdetti.filter((x) => x.valido === null);
  const validi = verdetti.filter((x) => x.valido === true);

  if (invalidi.length) {
    return {
      riallocare: true,
      motivo: `${invalidi.length} mercato/i non è più valido: `
        + invalidi.map((x) => `${x.marketId.slice(0, 10)}… ${x.stato}`).join(', ')
        + (illeggibili.length ? ` (più ${illeggibili.length} illeggibile/i, che da soli non avrebbero fatto scattare nulla)` : ''),
      validi, invalidi, illeggibili, verdetti,
    };
  }
  if (illeggibili.length) {
    return {
      riallocare: false,
      motivo: `nessun mercato risulta invalido, ma ${illeggibili.length} non è stato leggibile: non si rialloca al buio, si riprova al ciclo successivo`,
      validi, invalidi, illeggibili, verdetti,
    };
  }
  if (!verdetti.length) {
    return { riallocare: false, motivo: 'nessun mercato in gestione: non c\'è niente da verificare e niente da rifare', validi, invalidi, illeggibili, verdetti };
  }
  return { riallocare: false, motivo: `tutti i ${validi.length} mercati in gestione sono ancora validi: nessuna azione`, validi, invalidi, illeggibili, verdetti };
}

module.exports = { marketValidity, decidiRiallocazione, HORIZON_MIN_HOURS, POOL_COLLAPSE_FRAC };

'use strict';
// lib/maker/allocation-reset.js — «ESEGUI ALLOCAZIONE» È UN RESET, NON UNA SOMMA.
//
// ═══ IL PROBLEMA CHE RISOLVE ═════════════════════════════════════════════════════════════════════════
// Fino a questa revisione premere «2 · Conferma ed esegui» faceva UNA cosa sola: un ciclo di
// piazzamenti (lib/maker/bulk-allocate.js). Non cancellava niente, non spegneva niente. E il registro
// dei mercati abilitati (lib/maker/auto-reprice-config.js) è additivo per costruzione — `setAutoReprice`
// scrive `st.markets[id] = record`, quindi aggiunge una chiave e non ne toglie mai.
//
// Le due cose insieme fanno accumulo. Misurato sul registro vero il 3 agosto 2026, con l'operatore
// convinto di avere «zero mercati abilitati»:
//
//     0x12dc2b61…  Will Harry Kane win the 2026 Ballon d'Or?          abilitato il 31 luglio
//     0xf33ee44b…  Bitcoin Up or Down - August 2, 6:00PM-6:05PM ET    finestra di 5 minuti, chiusa
//     0xad02c78e…  Bitcoin Up or Down - August 2, 6PM ET              chiusa
//     0x02de7a7d…  Bitcoin Up or Down - August 2, 6:35PM-6:40PM ET    chiusa
//     0x5b1e522d…  Bitcoin Up or Down - August 2, 7:25PM-7:30PM ET    chiusa
//     0x74bbe5cb…  Bitcoin Up or Down - August 2, 7:20PM-7:25PM ET    chiusa
//
// Sei mercati nella allowlist live-min, cinque dei quali finestre da cinque minuti chiuse da un giorno.
// Nessuno li aveva rimessi lì: nessuno li aveva mai tolti.
//
// ═══ COSA FA ADESSO ══════════════════════════════════════════════════════════════════════════════════
// Lo stato finale è ESATTAMENTE il piano proposto, e niente altro. In quattro fasi, in quest'ordine:
//
//   1. CANCELLA  ogni ordine a riposo sui mercati gestiti dal bot, comunque e quando fossero nati.
//   2. SPEGNE    ogni mercato in tracking, e ogni mercato abilitato che il piano nuovo non contiene —
//                uscita automatica compresa, MA solo dove non resta una posizione da chiudere.
//   3. ACCENDE   esattamente i mercati del piano, uscita automatica INCLUSA e PRIMA della fase 4.
//   4. PIAZZA    il piano, con lo stesso ciclo di sempre (nessun secondo percorso di piazzamento).
//
// ═══ OGNI MERCATO GESTITO HA L'USCITA AUTOMATICA, PER COSTRUZIONE ═══════════════════════════════════
// Fino al 4 agosto 2026 `setAutoClose` non veniva chiamato da nessuna parte in questo percorso.
// L'interruttore globale era acceso, ma l'opt-in per mercato no: tre mercati vecchi ce l'avevano,
// nessuno dei mercati che il piano sceglieva. Un fill su uno di quelli lasciava le share senza nessuna
// via d'uscita, e il capitale fermo fino alla risoluzione.
//
// Adesso l'accensione sta nella fase 3, cioe' PRIMA che la fase 4 crei un solo ordine: non esiste un
// istante in cui le gambe sono vive e l'uscita e' spenta. Se l'accensione fallisce, quel mercato non
// viene piazzato — meglio un mercato in meno che un mercato senza via d'uscita.
//
// Allo spegnimento vale la regola opposta e per lo stesso motivo: un mercato che esce dal piano perde
// l'uscita SOLO se non ha posizioni aperte. Se una gamba era stata eseguita, quelle share restano
// nostre e l'uscita e' l'unica cosa che possa liberarle: resta accesa finche' non e' chiusa. E se non
// si riesce a LEGGERE se c'e' una posizione, resta accesa lo stesso — accesa su un mercato vuoto non
// fa niente, spenta su un mercato pieno abbandona il capitale.
//
// ═══ PERCHÉ QUEST'ORDINE, E NON UN ALTRO ═════════════════════════════════════════════════════════════
// CANCELLA PER PRIMO perché è l'unica direzione che può solo RIDURRE l'esposizione, e perché — verificato
// in `cancelManualOrder` — la cancellazione non è soggetta né al kill switch né alla proprietà manuale
// né all'allowlist: «a cancel can only REDUCE exposure». Quindi può sempre avvenire, anche su un mercato
// che stiamo per togliere dalla lista. Se invece si spegnesse prima, si potrebbe restare con un ordine
// vero a riposo su un mercato che il sistema non governa più — cioè esattamente il difetto, al contrario.
//
// PIAZZA PER ULTIMO perché il piazzamento È soggetto all'allowlist e alla proprietà manuale: prima
// devono esistere. Le scritture delle fasi 2 e 3 sono su file locali e costano microsecondi, quindi la
// finestra scoperta fra l'ultima cancellazione e il primo piazzamento è fatta solo dei viaggi di rete,
// che è il minimo possibile per una sequenza cancella-poi-piazza.
//
// IL RATE LIMIT NON ENTRA NELLA FASE 1. Verificato in lib/safety/usage.js: `ordersInWindow` conta le
// righe `kind === 'intent'`, cioè le INTENZIONI DI PIAZZAMENTO. Le cancellazioni non ci finiscono, e il
// tetto 20/60s vincola quindi solo la fase 4 — dove continua a valere identico, perché la fase 4 è il
// ciclo di piazzamento di sempre e non è stato toccato.
//
// ═══ SE UNA CANCELLAZIONE FALLISCE SI FERMA TUTTO ════════════════════════════════════════════════════
// E non si scrive niente. Un ordine vecchio che resta sul libro mentre se ne piazzano di nuovi è
// esposizione oltre il piano — cioè la cosa che questo modulo esiste per impedire. È la stessa regola
// che mm-tracking applica da sempre a un riprezzo: «NON si piazza il nuovo se il vecchio non è stato
// tolto». Fermarsi PRIMA delle scritture rende il tentativo ripetibile: lo stato resta quello di
// partenza, e ripremere il bottone riparte da capo invece che da metà.
//
// ═══ L'ANTEPRIMA NON TOCCA NIENTE ════════════════════════════════════════════════════════════════════
// `dryRunOnly:true` legge l'inventario e dice cosa verrebbe cancellato, spento e acceso — senza
// cancellare, senza scrivere, senza inviare. È la stessa promessa che il bottone «1 · Anteprima» fa già
// oggi, estesa ai passi nuovi: chi guarda l'anteprima deve poter vedere ANCHE le cancellazioni, perché
// da adesso sono la parte più conseguente di ciò che il tap finale farà.

const { OPERATOR_USER } = require('./manual-order');

const RESET_SOURCE = 'manual-ui';   // è l'operatore che agisce, attraverso un bottone invece che molti

const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * @param {object} args
 *   rows        [{ marketId, book, side?, price, size, title? }] — le righe del piano nuovo
 *   userId
 *   dryRunOnly  true ⇒ nessuna cancellazione, nessuna scrittura, nessun ordine: solo il referto
 * @param {object} deps  ogni effetto collaterale iniettabile
 *   setAutoClose({marketId, enabled, reason}) → lib/maker/auto-close-config.setAutoClose
 *   posizioneAperta({marketId}) → {leggibile:boolean, aperta:boolean} — serve SOLO per decidere se
 *              spegnere l'uscita automatica di un mercato che esce dal piano. Assente o illeggibile
 *              ⇒ l'uscita resta ACCESA (vedi la nota in testa al file).
 */
async function runAllocationReset({ rows = [], userId = OPERATOR_USER, dryRunOnly = false } = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const t0 = now();
  const audit = deps.audit || (() => {});
  const log = [];
  const traccia = (fase, evento, dati) => {
    const rec = { at: new Date(now()).toISOString(), fase, evento, ...dati };
    log.push(rec);
    // OGNI passo finisce anche nell'audit persistente, non solo nel referto della risposta: il referto
    // vive quanto la schermata, l'audit deve poter rispondere fra un mese a «cosa è stato cancellato».
    try { audit({ venue: 'polymarket', source: RESET_SOURCE, op: 'allocation-reset', ...rec }); } catch { /* l'audit non blocca */ }
    return rec;
  };

  const referto = (stoppedBy, reason, extra = {}) => ({
    ok: stoppedBy == null,
    at: new Date(t0).toISOString(),
    latencyMs: now() - t0,
    preview: dryRunOnly === true,
    stoppedBy, reason,
    log,
    ...extra,
  });

  // ── FASE 0 · L'INVENTARIO ───────────────────────────────────────────────────────────────────────
  // «Mercati gestiti dal bot» = l'unione di tre insiemi, e nessuno dei tre da solo basta:
  //   · quelli ABILITATI (allowlist live-min) — è dove si accumulano i residui
  //   · quelli in TRACKING (motore mm-tracking) — registro separato, può divergere dal primo
  //   · quelli del PIANO NUOVO — potrebbero avere ordini a riposo da una sessione precedente
  const abilitatiPrima = (typeof deps.readEnabled === 'function' ? deps.readEnabled() : []).map(normId).filter(Boolean);
  const trackingPrima = (typeof deps.readTracking === 'function' ? deps.readTracking() : []).map(normId).filter(Boolean);
  const nelPiano = [...new Set(rows.map((r) => normId(r.marketId)).filter(Boolean))];
  const gestiti = [...new Set([...abilitatiPrima, ...trackingPrima, ...nelPiano])];

  traccia('inventario', 'letto', {
    abilitati: abilitatiPrima.length, tracking: trackingPrima.length,
    nelPiano: nelPiano.length, gestiti: gestiti.length,
    abilitatiIds: abilitatiPrima, trackingIds: trackingPrima, pianoIds: nelPiano,
  });

  // ── FASE 1 · CANCELLA TUTTO CIÒ CHE È A RIPOSO ──────────────────────────────────────────────────
  const daCancellare = [];
  const lettureFallite = [];
  for (const marketId of gestiti) {
    let listed;
    try { listed = await deps.listOrders({ marketId }); }
    catch (e) { listed = { ok: false, error: e && e.message ? e.message : String(e) }; }
    if (!listed || listed.ok === false) {
      // NON SAPERE cosa c'è a riposo non è «non c'è nulla a riposo». Si ferma: proseguire vorrebbe dire
      // piazzare sopra ordini che potrebbero esserci e che nessuno ha contato.
      lettureFallite.push({ marketId, error: (listed && listed.error) || 'ignoto' });
      continue;
    }
    for (const o of (listed.orders || [])) {
      if (o && o.orderId) daCancellare.push({ marketId, orderId: String(o.orderId), price: o.price ?? null, size: o.size ?? null, book: o.book ?? null });
    }
  }

  // ── GLI ORDINI MESSI A MANO NON SI CANCELLANO ──────────────────────────────────────────────────
  // Questo reset nasce come «l'operatore preme un bottone», e con quella premessa cancellare tutto ciò
  // che è a riposo è corretto: è lui che l'ha messo, è lui che chiede di rifare. Ma lo stesso codice lo
  // chiama agent41 ogni sei ore, e lì la premessa non regge più: fra gli ordini a riposo ci possono
  // essere quelli che una persona ha piazzato dieci minuti prima, e nessuno le ha chiesto niente.
  //
  // La divisione la fa il timbro `origine` scritto al piazzamento (lib/maker/origine-ordine.js), e la
  // direzione è deliberata: si cancella SOLO ciò che è provatamente automatico. Manuale e IGNOTO
  // restano sul libro. Fra i due errori possibili — cancellare l'ordine di una persona, o lasciare in
  // piedi un ordine dello scheduler — solo il primo distrugge lavoro fatto apposta; il secondo costa un
  // ciclo. Un registro assente o illeggibile rende tutto ignoto, quindi non cancella niente: è il verso
  // giusto per un fallimento.
  //
  // SENZA `leggiOrigini` INIETTATA IL COMPORTAMENTO È QUELLO DI PRIMA, byte per byte — il pannello non
  // la passa, e per il pannello la premessa originale è ancora vera.
  const risparmiati = [];
  if (typeof deps.leggiOrigini === 'function') {
    const { separaPerOrigine } = require('./origine-ordine');
    let mappa = null;
    try { mappa = deps.leggiOrigini(); } catch { mappa = null; }
    const sep = separaPerOrigine(daCancellare, mappa || new Map());
    risparmiati.push(...sep.daLasciare);
    daCancellare.length = 0;
    daCancellare.push(...sep.automatici);
    if (risparmiati.length) {
      traccia('cancellazione', 'risparmiati', {
        ordini: risparmiati.length,
        dettaglio: risparmiati.map((o) => ({ marketId: o.marketId, orderId: o.orderId, origine: o.origine, price: o.price, size: o.size })),
        // Il controvalore che resta impegnato: chi guarda il piano deve sapere che quel capitale NON è
        // libero, altrimenti il giro dopo lo conterebbe due volte.
        notionalUsd: +risparmiati.reduce((a, o) => a + ((Number(o.price) || 0) * (Number(o.size) || 0)), 0).toFixed(2),
      });
    }
  }

  if (lettureFallite.length) {
    traccia('cancellazione', 'lettura-fallita', { mercati: lettureFallite });
    return referto('list-failed',
      `lettura del venue fallita su ${lettureFallite.length} mercato/i (${lettureFallite.map((x) => x.marketId.slice(0, 12)).join(', ')})`
      + ' — non sapere cosa è a riposo non è la stessa cosa di non avere nulla a riposo: non si tocca nulla',
      { inventario: { abilitatiPrima, trackingPrima, nelPiano, gestiti }, daCancellare, lettureFallite });
  }

  traccia('cancellazione', 'inventario', { ordini: daCancellare.length, dettaglio: daCancellare });

  if (dryRunOnly) {
    // ── L'ANTEPRIMA SI FERMA QUI PER I PASSI CHE SCRIVONO, e prosegue solo con la simulazione del
    // piazzamento, che è già a vuoto per costruzione. Quello che verrebbe fatto è tutto nel referto.
    const spegnerebbe = abilitatiPrima.filter((id) => !nelPiano.includes(id));
    // In anteprima si dichiara anche cosa succederebbe all'uscita automatica: e' la protezione che
    // decide se un fill ha una via d'uscita, e chi guarda l'anteprima deve vederla prima del tap.
    let piazzamento = null;
    if (typeof deps.placeBulk === 'function') {
      piazzamento = await deps.placeBulk({ rows, userId, dryRunOnly: true });
    }
    traccia('anteprima', 'completata', {
      cancellerebbe: daCancellare.length,
      spegnerebbeTracking: trackingPrima.length,
      spegnerebbeAbilitati: spegnerebbe.length,
      accenderebbe: nelPiano.length,
      accenderebbeUscitaAutomatica: nelPiano.length,
      spegnerebbeUscitaAutomatica: spegnerebbe.length,
    });
    return referto(null, null, {
      inventario: { abilitatiPrima, trackingPrima, nelPiano, gestiti },
      cancellazione: { daCancellare, cancellati: 0, falliti: 0, risparmiati, simulata: true },
      spegnimento: { tracking: trackingPrima, abilitati: spegnerebbe, simulato: true },
      accensione: { markets: nelPiano, uscitaAutomatica: nelPiano, simulato: true },
      piazzamento,
    });
  }

  const cancellati = [];
  const falliti = [];
  for (const o of daCancellare) {
    let res;
    try { res = await deps.cancelOrder({ orderId: o.orderId, marketId: o.marketId }); }
    catch (e) { res = { ok: false, reason: e && e.message ? e.message : String(e) }; }
    const ok = !!(res && res.ok !== false);
    traccia('cancellazione', ok ? 'cancellato' : 'fallito', { marketId: o.marketId, orderId: o.orderId, price: o.price, size: o.size, reason: (res && res.reason) || null });
    (ok ? cancellati : falliti).push({ ...o, reason: (res && res.reason) || null });
  }

  if (falliti.length) {
    // FERMO DURO, e prima di qualunque scrittura: lo stato resta quello di partenza e il tentativo è
    // ripetibile da capo.
    traccia('cancellazione', 'interrotto', { cancellati: cancellati.length, falliti: falliti.length });
    return referto('cancel-failed',
      `${falliti.length} ordine/i non è stato possibile cancellarlo: non si piazza nulla sopra a ordini vecchi rimasti sul libro.`
      + ' Nessun registro è stato modificato — ripremere il bottone riparte da capo.',
      { inventario: { abilitatiPrima, trackingPrima, nelPiano, gestiti }, cancellazione: { daCancellare, cancellati, falliti, risparmiati } });
  }

  // ── FASE 2 · SPEGNE ────────────────────────────────────────────────────────────────────────────
  // Il tracking si spegne SEMPRE su tutto: il piano nuovo lo riaccenderà dove serve, e lasciarlo acceso
  // su un mercato che sta per cambiare size vorrebbe dire farlo riprezzare su parametri vecchi.
  const spentiTracking = [];
  for (const marketId of trackingPrima) {
    let r;
    try { r = await deps.setTrackingOff({ marketId, reason: 'reset dell allocazione: il piano nuovo riparte da zero' }); }
    catch (e) { r = { ok: false, error: e && e.message ? e.message : String(e) }; }
    traccia('spegnimento', (r && r.ok) ? 'tracking-spento' : 'tracking-spegnimento-fallito', { marketId, error: (r && r.error) || null });
    spentiTracking.push({ marketId, ok: !!(r && r.ok), error: (r && r.error) || null });
  }

  // I mercati abilitati che il piano NON contiene escono dall'allowlist. Quelli che il piano contiene
  // restano: toglierli e rimetterli sarebbe lo stesso stato con due scritture e una finestra in mezzo.
  const daSpegnere = abilitatiPrima.filter((id) => !nelPiano.includes(id));
  const spentiAbilitati = [];
  const uscitaTenutaAccesa = [];
  for (const marketId of daSpegnere) {
    let r;
    try { r = await deps.setEnabled({ marketId, enabled: false, reason: 'reset dell allocazione: non fa parte del piano nuovo' }); }
    catch (e) { r = { ok: false, error: e && e.message ? e.message : String(e) }; }
    traccia('spegnimento', (r && r.ok) ? 'disabilitato' : 'disabilitazione-fallita', { marketId, error: (r && r.error) || null });
    spentiAbilitati.push({ marketId, ok: !!(r && r.ok), error: (r && r.error) || null });

    // ── L'USCITA AUTOMATICA SI SPEGNE CON LE GAMBE — MA SOLO SE NON C'È NIENTE DA CHIUDERE ────────
    // Un mercato che esce dal piano ha appena perso i suoi ordini (fase 1). Se non ha posizioni, la
    // chiusura automatica non ha più un lavoro e lasciarla accesa sarebbe uno switch acceso su niente.
    //
    // Ma se una gamba era stata ESEGUITA, quelle share sono ancora nostre, e sono l'unica cosa che
    // l'uscita automatica esiste per chiudere. Spegnerla lì significherebbe abbandonare una posizione
    // proprio nel momento in cui il mercato smette di essere gestito: il capitale resterebbe fermo
    // fino alla risoluzione, senza nessuno che provi a uscirne.
    //
    // FAIL-CLOSED VERSO L'ACCESO: se non si riesce a sapere se c'è una posizione, l'uscita RESTA
    // accesa. Una chiusura automatica accesa su un mercato senza posizioni non fa niente (auto-close
    // salta quando non trova una posizione scoperta); una spenta su un mercato CON posizione la
    // abbandona. I due errori non costano uguale.
    let pos = { leggibile: false, aperta: null };
    if (typeof deps.posizioneAperta === 'function') {
      try { pos = await deps.posizioneAperta({ marketId }); }
      catch (e) { pos = { leggibile: false, aperta: null, error: e && e.message ? e.message : String(e) }; }
    }
    if (pos && pos.leggibile === true && pos.aperta === false && typeof deps.setAutoClose === 'function') {
      let a;
      try { a = await deps.setAutoClose({ marketId, enabled: false, reason: 'reset dell allocazione: fuori dal piano e nessuna posizione da chiudere' }); }
      catch (e) { a = { ok: false, error: e && e.message ? e.message : String(e) }; }
      traccia('uscita-automatica', (a && a.ok) ? 'spenta' : 'spegnimento-fallito', { marketId, error: (a && a.error) || null });
    } else {
      const perche = pos && pos.leggibile === true
        ? 'ha ancora una posizione aperta da chiudere'
        : `non è stato possibile leggere le posizioni (${(pos && pos.error) || 'lettore assente'})`;
      uscitaTenutaAccesa.push({ marketId, perche });
      traccia('uscita-automatica', 'tenuta-accesa', { marketId, perche, leggibile: !!(pos && pos.leggibile) });
    }
  }

  // ── FASE 3 · ACCENDE ESATTAMENTE IL PIANO ──────────────────────────────────────────────────────
  const accesi = [];
  for (const marketId of nelPiano) {
    let en;
    try { en = await deps.setEnabled({ marketId, enabled: true, reason: 'reset dell allocazione: mercato del piano nuovo' }); }
    catch (e) { en = { ok: false, error: e && e.message ? e.message : String(e) }; }
    // ── LA PROPRIETÀ MANUALE NON È UN ACCESSORIO DELL'ABILITAZIONE: È UNA CONDIZIONE ────────────────
    // Accompagnava l'abilitazione, ma il suo esito NON entrava in `ok`: se la scrittura falliva, la fase
    // 4 piazzava comunque e ogni ordine veniva rifiutato al gate `manual-mode-inactive` — dopo che il
    // libro era già stato liberato dalla fase 1. Adesso è un fermo duro come l'uscita automatica, e per
    // la stessa ragione: senza la proprietà manuale agent35 può scrivere sullo stesso libro su cui
    // stiamo per piazzare, e due scrittori su un mercato sono esattamente ciò che quel flag previene.
    //
    // E la dipendenza non è più facoltativa. Un `setManual` non cablato significava «nessuno prende il
    // mercato in gestione» e il piazzamento partiva lo stesso: la classe di difetto che
    // scripts/dipendenze-scollegate.js esiste per impedire.
    let mn = null;
    if (en && en.ok) {
      if (typeof deps.setManual !== 'function') {
        mn = { ok: false, error: 'nessuna funzione setManual iniettata: non si piazza su un mercato che agent35 puo ancora scrivere' };
      } else {
        try { mn = await deps.setManual({ marketId, manual: true, reason: 'reset dell allocazione: il motore automatico si tiene fuori' }); }
        catch (e) { mn = { ok: false, error: e && e.message ? e.message : String(e) }; }
      }
    }
    const mnOk = !!(mn && mn.ok);

    // ── L'USCITA AUTOMATICA SI ACCENDE QUI, PRIMA CHE GLI ORDINI ESISTANO ─────────────────────────
    // Non è un dettaglio di ordine delle righe: è LA regola. La fase 4 piazza; questa è la fase 3.
    // Fra le due non esiste un istante in cui le gambe sono vive e l'uscita è spenta — perché è
    // esattamente in quell'istante che un fill arriverebbe senza nessuno pronto a chiuderlo.
    //
    // Fino a questa revisione `setAutoClose` non veniva chiamato da nessuna parte in questo percorso:
    // l'interruttore globale era acceso, ma l'opt-in per mercato no, e i mercati che il piano sceglieva
    // nascevano tutti con l'uscita spenta. Tre mercati vecchi ce l'avevano; nessuno dei nuovi.
    //
    // E se l'accensione FALLISCE, il mercato non si piazza. È il fermo duro qui sotto (`nonAccesi`):
    // meglio un mercato in meno che un mercato con due gambe vive e nessuna via d'uscita.
    let ac = null;
    if (en && en.ok) {
      if (typeof deps.setAutoClose !== 'function') {
        // Non e' un'omissione tollerabile: senza questa dipendenza non si puo' garantire che il mercato
        // abbia una via d'uscita, e la regola non ammette eccezioni. Chi chiama la deve cablare.
        ac = { ok: false, error: 'nessuna funzione setAutoClose iniettata: non si piazza su un mercato di cui non si puo accendere l uscita automatica' };
      } else {
        try { ac = await deps.setAutoClose({ marketId, enabled: true, reason: 'reset dell allocazione: ogni mercato gestito ha l uscita automatica pronta PRIMA di avere ordini' }); }
        catch (e) { ac = { ok: false, error: e && e.message ? e.message : String(e) }; }
      }
    }
    const acOk = !!(ac && ac.ok);
    traccia('accensione', (en && en.ok && acOk && mnOk) ? 'abilitato' : 'abilitazione-fallita',
      { marketId, manual: mnOk, uscitaAutomatica: acOk, error: (en && en.error) || (ac && ac.error) || (mn && mn.error) || null });
    accesi.push({
      marketId, ok: !!(en && en.ok) && acOk && mnOk, manual: mnOk, uscitaAutomatica: acOk,
      error: (en && en.error) || (ac && ac.error) || (mn && mn.error) || null,
    });
  }

  const nonAccesi = accesi.filter((x) => !x.ok);
  if (nonAccesi.length) {
    // Il libro è già libero (fase 1 è riuscita) e i registri sono coerenti con «niente attivo»: fermarsi
    // qui lascia il sistema in uno stato pulito e vuoto, non a metà.
    traccia('accensione', 'interrotto', { nonAccesi: nonAccesi.length });
    return referto('enable-failed',
      `${nonAccesi.length} mercato/i del piano non è stato possibile abilitarlo (allowlist, uscita automatica o gestione manuale): nessun ordine viene piazzato.`
      + ' Un mercato con due gambe vive e nessuna via d\'uscita è peggio di un mercato in meno, e un mercato'
      + ' su cui agent35 può ancora scrivere non è un mercato gestito a mano: sono le due condizioni senza'
      + ' le quali non si piazza.'
      + ' Il libro è già stato liberato, quindi il sistema resta fermo e senza esposizione.'
      + (nonAccesi.some((x) => x.manual === false)
        ? ` Gestione manuale NON attiva su ${nonAccesi.filter((x) => x.manual === false).length} mercato/i: senza quel flag ogni ordine verrebbe rifiutato con manual-mode-inactive.`
        : ''),
      { inventario: { abilitatiPrima, trackingPrima, nelPiano, gestiti },
        cancellazione: { daCancellare, cancellati, falliti, risparmiati },
        spegnimento: { tracking: spentiTracking, abilitati: spentiAbilitati, uscitaTenutaAccesa },
        accensione: { markets: accesi } });
  }

  // ── FASE 4 · PIAZZA IL PIANO ───────────────────────────────────────────────────────────────────
  // Lo STESSO ciclo di sempre: cap cumulativo, rate limit, gate per riga. Non una seconda strada.
  let piazzamento = null;
  if (typeof deps.placeBulk === 'function') {
    piazzamento = await deps.placeBulk({ rows, userId, dryRunOnly: false });
  }
  traccia('piazzamento', 'completato', {
    piazzati: piazzamento ? piazzamento.placed : null,
    rifiutati: piazzamento ? piazzamento.refused : null,
    saltati: piazzamento ? piazzamento.skipped : null,
    stoppedBy: piazzamento ? piazzamento.stoppedBy : null,
  });

  return referto(null, null, {
    inventario: { abilitatiPrima, trackingPrima, nelPiano, gestiti },
    cancellazione: { daCancellare, cancellati, falliti, risparmiati },
    spegnimento: { tracking: spentiTracking, abilitati: spentiAbilitati, uscitaTenutaAccesa },
    accensione: { markets: accesi },
    piazzamento,
  });
}

module.exports = { runAllocationReset, RESET_SOURCE };

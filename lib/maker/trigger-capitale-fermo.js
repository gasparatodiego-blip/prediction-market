'use strict';
// lib/maker/trigger-capitale-fermo.js — IL CAPITALE FERMO NON ASPETTA SEI ORE.
//
// ═══ IL PROBLEMA ═════════════════════════════════════════════════════════════════════════════════════
// Il riallocatore gira ogni 6 ore. Quando un merge o una chiusura liberano collaterale — cosa che
// avviene quando capita, non ogni sei ore — quel denaro resta fermo fino al giro successivo. Nel caso
// peggiore sono sei ore di capitale che non matura niente, su un conto da qualche centinaio di dollari
// dove ogni ordine vale ~$34-37: sei ore di un intero ordine spento.
//
// ═══ COSA FA, E COSA DELIBERATAMENTE NON FA ═════════════════════════════════════════════════════════
// Sorveglia il saldo pUSD LIQUIDO. Quando supera la soglia, NON ricalcola il piano — quel calcolo costa
// ~52 secondi e porta il processo a 687 MB contro un tetto pm2 di 400, ed è la ragione per cui il piano
// vive in un processo figlio. Fa invece un MINI-CICLO: prende il mercato migliore che l'ULTIMO piano
// aveva già scelto e gli rimette sopra il capitale liberato.
//
//   · NON cancella NIENTE. Mai. È l'unica azione che questo percorso non conosce, ed è anche la
//     risposta strutturale alla domanda «e gli ordini messi a mano?»: non li tocca perché non tocca
//     nessun ordine esistente, di nessuna origine. Aggiunge e basta.
//   · NON sceglie mercati nuovi. Sceglie fra quelli che il piano pesante aveva già valutato e ammesso:
//     la reattività non è una scusa per saltare la selezione.
//   · NON forza un piazzamento. Se nessun mercato ha spazio, o se lo spazio è troppo piccolo per un
//     ordine sensato, il capitale resta liquido e si riprova al giro dopo. Un ordine piazzato per non
//     restare fermi è un ordine che nessuno ha deciso.
//
// ═══ PERCHÉ «SALDO pUSD» È LA MISURA GIUSTA ═════════════════════════════════════════════════════════
// Su questo venue un ordine BUY a riposo IMMOBILIZZA il collaterale: finché l'ordine è sul libro, quei
// dollari non sono nel saldo. Quindi il saldo pUSD libero È, per costruzione, il capitale non allocato —
// non serve dedurlo sottraendo gli ordini, e dedurlo sarebbe peggio, perché due letture separate
// possono divergere. Quando un merge o una chiusura liberano collaterale, il saldo sale: è esattamente
// il segnale che questo modulo aspetta.
//
// ═══ DOVE VA IL CAPITALE, E PERCHÉ PROPRIO LÌ ═══════════════════════════════════════════════════════
// Non «sul mercato col punteggio più alto» in astratto: sul mercato dove il piano aveva messo capitale
// e adesso ne ha meno del previsto. È la definizione operativa di «capitale liberato»: se una chiusura
// ha svuotato il mercato X, X torna ad avere spazio sotto il tetto che il piano gli aveva assegnato, e
// il mini-ciclo lo riempie. Così il trigger riporta il portafoglio verso il piano invece di inventarne
// uno nuovo — che è il mestiere del ciclo a sei ore, non suo.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * LA SOGLIA. Decisa dall'operatore l'8 agosto 2026: $50 di capitale liquido fermo.
 * Il perché è la size tipica di un ordine su questo conto — il consensus misurato sui 21 maker di
 * riferimento dà un nozionale mediano di ~$34 ($16-74, data/manuale-operativo-maker-v2.md). Con $50
 * liberi c'è spazio per un ordine intero e un margine; sotto, si starebbe piazzando un residuo.
 */
const SOGLIA_USD = Number(process.env.TRIGGER_CAPITALE_SOGLIA_USD || 50);

/**
 * LA CADENZA. 120 secondi, e non è un numero tondo scelto a caso:
 *   · la cache del saldo (lib/maker/saldo-cache) ha TTL 45s, quindi sotto i 45s si rileggerebbe lo
 *     stesso valore — polling che costa e non informa. 120s sono 2,7 TTL: ogni giro vede un valore
 *     che può essere cambiato davvero.
 *   · il costo è una chiamata HTTP al dashboard locale (che a sua volta usa la cache): 720 al giorno,
 *     invisibili accanto ai 22.602 polling di ordini che agent40 fa già.
 *   · la reattività: nel caso peggiore 2 minuti fra il merge e il reimpiego, contro le 6 ore di prima.
 * La lettura del VENUE (ordini a riposo) NON avviene a ogni giro: solo quando la soglia è già superata.
 */
const CADENZA_MS = Number(process.env.TRIGGER_CAPITALE_CADENZA_MS || 120_000);

/**
 * LA CADENZA OPERATIVA DEL TRIGGER — 10 MINUTI, e va tenuta distinta dalla RILEVAZIONE.
 *
 * ═══ DUE OROLOGI, E FANNO DUE LAVORI DIVERSI ═══════════════════════════════════════════════════════
 *   · `CADENZA_MS` (120 s) è ogni quanto si GUARDA il saldo. È solo una lettura in cache: costa una
 *     chiamata locale e non tocca il venue finché la soglia non è già superata.
 *   · `COOLDOWN_MS` (600 s = 10 min) è ogni quanto il trigger può AGIRE. È questa la cadenza del
 *     trigger nel senso che conta — quanto spesso può muovere capitale — ed è quella che deve restare
 *     più stretta della scoperta.
 *
 * ═══ L'INVARIANTE, DICHIARATO ══════════════════════════════════════════════════════════════════════
 * 10 minuti < 15 minuti di `agent24-liquidity-rewards` (SCAN_INTERVAL_MS). Il verso non è arbitrario:
 * la scoperta produce il board su cui il trigger sceglie, quindi un trigger più lento della scoperta
 * lascerebbe scadere board interi senza mai usarli, e un trigger molto più veloce ripeterebbe la stessa
 * decisione sullo stesso board. Un fattore 1,5 significa che ogni board viene guardato una volta o due,
 * che è quello che serve. Un test verifica la disuguaglianza contro il sorgente di agent24, così se un
 * domani qualcuno cambiasse una delle due cadenze la relazione non si romperebbe in silenzio.
 *
 * ═══ PERCHE' LA RILEVAZIONE RESTA A DUE MINUTI ═════════════════════════════════════════════════════
 * Portarla a 10 minuti renderebbe il trigger più lento ad ACCORGERSI del capitale libero, cioè
 * l'opposto di ciò per cui esiste (reagire in minuti, non in ore). Guardare non è agire: la lettura del
 * saldo passa dalla cache (TTL 45 s) e il venue non viene interrogato finché la soglia non è superata.
 * Il numero che il requisito chiede — «il trigger gira ogni 10 minuti» — è questo qui sotto.
 */
const CADENZA_OPERATIVA_MS = Number(process.env.TRIGGER_CAPITALE_COOLDOWN_MS || 600_000);
/** Alias storico: è lo stesso numero, ed è il tetto che impedisce di ripetere un giro fallito. */
const COOLDOWN_MS = CADENZA_OPERATIVA_MS;

/**
 * QUANTO SI ASPETTA DOPO UN CICLO COMPLETO. Subito dopo un reset il saldo è in movimento (gli ordini
 * appena mandati stanno immobilizzando collaterale) e leggerlo darebbe un «capitale fermo» che fra
 * trenta secondi non esiste più. Tre minuti sono il tempo perché il libro si assesti.
 */
const QUIETE_DOPO_CICLO_MS = Number(process.env.TRIGGER_CAPITALE_QUIETE_MS || 180_000);

/**
 * IL MINIMO CHE VALE LA PENA PIAZZARE. Sotto i $34 — il nozionale mediano dei 21 maker di riferimento —
 * non si sta rimettendo al lavoro un ordine, si sta spolverando. Il gate DURO resta comunque quello del
 * venue (`min_incentive_size`), che vive più a valle e che questo modulo non riscrive.
 */
const MIN_ALLOCAZIONE_USD = Number(process.env.TRIGGER_CAPITALE_MIN_USD || 34);

/**
 * QUANTO PUÒ ESSERE VECCHIA LA FOTOGRAFIA DEL BOARD su cui si quota. Oltre, il tocco vivo non è più
 * vivo e il mini-ciclo non piazza — la freschezza che si dichiara è quella del dato che si USA per il
 * prezzo.
 *
 * ═══ 20 → 25 MINUTI, IL 9 AGOSTO 2026, E IL NUMERO VIENE DA UNA MISURA ═══════════════════════════
 * Il commento diceva «agent24 la riscrive ogni 15 minuti: 20 sono quel ciclo più un margine». La prima
 * metà era falsa: agent24 dormiva 15 minuti DOPO la scansione, quindi il periodo vero era
 * `scansione + 15`. Con la scoperta allargata dell'8 agosto la scansione costa ~7,5 min ⇒ periodo
 * **22,5**, cioè strutturalmente sopra il limite. Le età che hanno bloccato un mini-ciclo, dal giornale:
 * **21,0 · 22,0 · 22,2 minuti** — tutte fra 20 e 22,5. Non erano ritardi: era la cadenza.
 *
 * La causa è stata corretta dove stava, in `agents/agent24-liquidity-rewards.js`: adesso si dorme il
 * RESTO del periodo, quindi il board torna a riscriversi ogni 15 minuti esatti.
 *
 * ═══ E ALLORA PERCHÉ ALZARLO LO STESSO, E PERCHÉ A 25 ═══════════════════════════════════════════
 * Perché la cadenza della scoperta è già cresciuta due volte (14s → 97s → 7,5 min) e crescerà ancora:
 * un limite che sta a cinque minuti dal periodo si romperà di nuovo al prossimo allargamento, e si
 * romperà in silenzio. 25 dà **dieci minuti** di margine sopra il periodo di 15, cioè assorbe una
 * scansione che sfora fino al doppio senza che il capitale smetta di lavorare.
 *
 * E non di più: il limite deve restare capace di accorgersi che agent24 è MORTO. A 25 minuti un board
 * fermo viene rifiutato entro un periodo e mezzo; a 30 si tollererebbe una scansione saltata per intero,
 * cioè proprio l'evento che questo controllo esiste per vedere. Il test `cadenza-board.test.js` verifica
 * l'invariante contro `SCAN_INTERVAL_MS` letto dal sorgente di agent24, non contro una copia.
 */
const ETA_BOARD_MAX_MS = Number(process.env.TRIGGER_CAPITALE_BOARD_MAX_MS || 25 * 60_000);

/**
 * SCATTA O NO. Pura: l'orologio, il saldo e lo stato arrivano da fuori, così ogni ramo si prova senza
 * aspettare due minuti e senza toccare un venue.
 *
 * L'ordine dei controlli non è casuale — si va dal più economico al più costoso, e dal più categorico
 * al più contingente: prima ciò che vieta (spento, bot fermo, un ciclo in corso), poi ciò che aspetta
 * (quiete, cooldown), poi il dato vero (saldo).
 *
 * @returns {{scatta:boolean, motivo:string, eccedenzaUsd:number|null, saldoUsd:number|null}}
 */
function decidiTrigger({
  abilitato = true, botAttivo = false, cicloInCorso = false, killAttivo = false,
  saldo = null, sogliaUsd = SOGLIA_USD,
  ultimoCicloAt = null, ultimoTriggerAt = null, now = Date.now(),
  quieteMs = QUIETE_DOPO_CICLO_MS, cooldownMs = COOLDOWN_MS,
  ignoraAttese = false, motivoForzatura = null,
} = {}) {
  const no = (motivo) => ({ scatta: false, motivo, eccedenzaUsd: null, saldoUsd: saldo && saldo.readable ? saldo.usd : null });

  if (!abilitato) return no('trigger spento');
  // Lo STESSO cancello del ciclo fisso, riletto adesso: FERMA vale dal controllo successivo, non dal
  // prossimo riavvio. Un trigger che piazzasse a bot fermo sarebbe un secondo interruttore.
  if (!botAttivo) return no('il bot è FERMO: nessun piazzamento, nemmeno da trigger');
  // ── IL KILL, LETTO QUI E NON SOLO A VALLE (8 agosto 2026) ──────────────────────────────────────
  // Il kill fermava già ogni ordine, ma molto più giù: il mini-ciclo arrivava a leggere il saldo, gli
  // ordini del venue e — da oggi — a calcolare un piano fresco, per poi vedersi rifiutare ogni gamba.
  // Con il ricalcolo quel lavoro sprecato costa ~13 secondi e centinaia di megabyte a ogni giro. Il
  // kill è un fatto locale che si legge in un microsecondo: va davanti, non dietro.
  if (killAttivo === true) return no('kill-switch ATTIVO: nessun piazzamento, e non si spreca un ricalcolo per scoprirlo a valle');
  // IL LUCCHETTO. Il ciclo a sei ore e il mini-ciclo lavorano sullo stesso capitale e sugli stessi
  // ordini: sovrapporli significherebbe che il secondo legge un saldo che il primo sta già spendendo.
  // Questo NON è saltabile nemmeno da una forzatura: è l'unica cosa che impedisce a due percorsi di
  // spendere lo stesso dollaro.
  if (cicloInCorso) return no('un ciclo è già in corso: il mini-ciclo non si sovrappone');
  // ── LE DUE ATTESE, E PERCHÉ UN AVVIA LE SCAVALCA ───────────────────────────────────────────────
  // Quiete e cooldown esistono contro il POLLING: evitano che un timer che scatta ogni due minuti
  // ripeta la stessa decisione su un saldo che si sta ancora assestando. Un AVVIA non è un timer che
  // scatta: è una persona che ha appena premuto un bottone, e farle aspettare fino a dieci minuti il
  // primo ordine è esattamente il difetto che il Requisito 5 descrive. La forzatura salta le attese e
  // NIENTE ALTRO — bot fermo, kill e lucchetto restano davanti, sopra.
  if (!ignoraAttese) {
    if (fin(ultimoCicloAt) && now - ultimoCicloAt < quieteMs) {
      return no(`quiete dopo un ciclo completo: mancano ${Math.ceil((quieteMs - (now - ultimoCicloAt)) / 1000)}s (il saldo si sta ancora assestando)`);
    }
    if (fin(ultimoTriggerAt) && now - ultimoTriggerAt < cooldownMs) {
      return no(`cooldown dal mini-ciclo precedente: mancano ${Math.ceil((cooldownMs - (now - ultimoTriggerAt)) / 1000)}s`);
    }
  }
  // Un saldo NON LEGGIBILE non è un saldo zero e non è un saldo basso: è un'incognita, e su
  // un'incognita non si piazza. Stessa regola che il resto del maker applica al kill state.
  if (!saldo || saldo.readable !== true || !fin(saldo.usd)) {
    return no(`saldo non leggibile (${(saldo && saldo.error) || 'nessuna lettura'}): non si piazza su un'incognita`);
  }
  if (saldo.usd < sogliaUsd) {
    return no(`capitale liquido $${saldo.usd.toFixed(2)} sotto la soglia di $${sogliaUsd.toFixed(2)}`);
  }
  return {
    scatta: true,
    motivo: (motivoForzatura ? `${motivoForzatura} · ` : '')
      + `capitale liquido fermo $${saldo.usd.toFixed(2)} ≥ soglia $${sogliaUsd.toFixed(2)}`,
    forzato: ignoraAttese === true,
    eccedenzaUsd: +saldo.usd.toFixed(2),
    saldoUsd: +saldo.usd.toFixed(2),
  };
}

/**
 * LE SHARE PER LATO A UN CAPITALE DIVERSO. Non è una formula nuova: sono le DUE identità che
 * lib/rewards/allocator.js usa per costruire la riga, riscritte qui sopra lo stesso ordine di
 * preferenza — col costo della coppia quando la riga ce l'ha, altrimenti `(capitale/2)/prezzo`.
 * Se divergessero, il mini-ciclo manderebbe una size diversa da quella con cui il piano ha scorato.
 */
function shareARiscalo(riga, nuovoCapitale) {
  if (!fin(nuovoCapitale) || nuovoCapitale <= 0) return null;
  if (fin(riga.pairCostUsd) && riga.pairCostUsd > 0) return nuovoCapitale / riga.pairCostUsd;
  const prezzo = fin(riga.mid) && riga.mid > 0 ? Math.max(0.01, Math.min(0.99, riga.mid)) : null;
  if (prezzo == null) return null;
  return (nuovoCapitale / 2) / prezzo;
}

/**
 * QUALE MERCATO, E QUANTO. Pura.
 *
 * Si scorre l'ultimo piano dal mercato che rende di più, e per ognuno si guarda quanto SPAZIO ha:
 * il capitale che il piano gli aveva assegnato, meno quello che ha già a riposo adesso. Un mercato
 * pieno non ha spazio; uno svuotato da una chiusura ce l'ha tutto. È così che il capitale liberato
 * torna dove il piano lo voleva, senza inventare un piano nuovo.
 *
 * @param righe            le righe dell'ULTIMO piano (già ridotte all'essenziale)
 * @param disponibileUsd   il capitale liquido da rimettere al lavoro
 * @param notionalePerMercato  {marketId → $ a riposo adesso}
 * @param capPerMercatoUsd il tetto di concentrazione per mercato, dal chiamante (mai riscritto qui)
 * @returns {{riga:object, allocatoUsd:number}|{riga:null, motivo:string, esaminate:object[]}}
 */
/**
 * `gambeCostruibili` — IL CANCELLO CHE MANCAVA, E PERCHÉ STA QUI DENTRO (8 agosto 2026).
 *
 * Fino a oggi questa funzione sceglieva UN mercato e lo consegnava; se poi le sue due gambe non si
 * riuscivano a costruire, il mini-ciclo si fermava lì e il capitale restava fermo — pur avendo nel
 * piano altre righe perfettamente utilizzabili. Non è ipotetico: la riga in testa al piano dell'8
 * agosto ha `tick: null`, quindi le gambe non esistono, e il trigger non ha mai passato quella riga.
 *
 * Il predicato è INIETTATO e non importato: questo modulo resta puro e senza dipendenze, e la
 * costruzione delle gambe continua a vivere in UN posto solo (`lib/rewards/plan-to-orders.js`). Chi
 * non lo passa ottiene esattamente il comportamento di prima.
 *
 * Firma: `(riga) => ({ ok: boolean, motivo?: string })`. La riga che riceve è già quella definitiva —
 * capitale e share riscalati — perché è quella che finirebbe al venue, non la sua approssimazione.
 */
function scegliMercato({
  righe = [], disponibileUsd = 0, notionalePerMercato = {}, capPerMercatoUsd = null,
  minAllocazioneUsd = MIN_ALLOCAZIONE_USD, gambeCostruibili = null,
} = {}) {
  const esaminate = [];
  const valore = (r) => (fin(r.realisticBestPerDay) ? r.realisticBestPerDay
    : (fin(r.netPerDay) ? r.netPerDay : (fin(r.grossPerDay) ? r.grossPerDay : -Infinity)));
  const ordinate = (righe || []).slice().sort((a, b) => valore(b) - valore(a));

  for (const r of ordinate) {
    const id = normId(r.marketId);
    if (!id) continue;
    const pianificato = fin(r.capital) ? r.capital : 0;
    const tetto = fin(capPerMercatoUsd) && capPerMercatoUsd > 0 ? Math.min(pianificato, capPerMercatoUsd) : pianificato;
    const vivo = fin(notionalePerMercato[id]) ? notionalePerMercato[id] : 0;
    const spazio = +(tetto - vivo).toFixed(2);
    const allocabile = +Math.min(disponibileUsd, Math.max(0, spazio)).toFixed(2);

    if (allocabile < minAllocazioneUsd) {
      esaminate.push({ marketId: r.marketId, pianificato, vivo, spazio, motivo: spazio <= 0 ? 'nessuno spazio: il mercato è già al capitale del piano' : `spazio $${spazio.toFixed(2)} sotto il minimo di $${minAllocazioneUsd}` });
      continue;
    }
    const share = shareARiscalo(r, allocabile);
    if (share == null) {
      esaminate.push({ marketId: r.marketId, pianificato, vivo, spazio, motivo: 'share per lato non ricalcolabili (né costo della coppia né mid)' });
      continue;
    }
    if (fin(r.minSizeShares) && r.minSizeShares > 0 && share < r.minSizeShares) {
      esaminate.push({ marketId: r.marketId, pianificato, vivo, spazio, motivo: `${share.toFixed(1)} share sotto il minimo del venue (${r.minSizeShares})` });
      continue;
    }
    // La riga che si consegna al costruttore delle gambe è la STESSA del piano, con due soli campi
    // riscritti: il capitale e le share che ne derivano. Tutto il resto — tick, banda, offset scelto,
    // tocco vivo — resta quello che il piano aveva calcolato, perché è quello che lo ha reso ammissibile.
    const riga = { ...r, capital: allocabile, sizePerSideShares: share };

    // L'ULTIMO CANCELLO, e l'unico che sa se un ordine è davvero costruibile. Una riga che non passa
    // NON ferma la ricerca: si annota il motivo e si prova la successiva, esattamente come per lo
    // spazio insufficiente o le share sotto il minimo. Il capitale fermo non deve restare fermo per
    // colpa della prima riga della graduatoria.
    if (typeof gambeCostruibili === 'function') {
      let v;
      // Un predicato che ESPLODE non deve poter fermare il ciclo: vale come «non costruibile», con il
      // motivo. È lo stesso principio del resto del maker — un'incognita non è mai un via libera.
      try { v = gambeCostruibili(riga); }
      catch (e) { v = { ok: false, motivo: `il controllo delle gambe è fallito: ${e && e.message}` }; }
      if (!v || v.ok !== true) {
        esaminate.push({ marketId: r.marketId, pianificato, vivo, spazio,
          motivo: `gambe non costruibili: ${(v && v.motivo) || 'motivo non dichiarato'}` });
        continue;
      }
    }

    return { riga, allocatoUsd: allocabile, esaminate };
  }
  return {
    riga: null,
    allocatoUsd: 0,
    motivo: esaminate.length
      ? 'nessun mercato del piano ha spazio sufficiente adesso'
      : 'l\'ultimo piano non ha righe utilizzabili',
    esaminate,
  };
}

/**
 * QUANTI MERCATI PUO' TOCCARE UN SOLO GIRO. Non è una regola di rischio — quelle stanno tutte a valle e
 * restano intatte — è un limite di RAGGIO D'AZIONE: un giro che potesse piazzare su venti mercati
 * sarebbe un ciclo completo travestito da trigger, senza la verifica al venue che il ciclo completo fa.
 * Sei sta appena sopra le sette righe del piano tipico su questo conto, quindi non è mai il vincolo che
 * morde per primo: a mordere sono lo spazio sotto il tetto del 20% e il minimo di un ordine sensato.
 */
const MAX_MERCATI_PER_GIRO = Number(process.env.TRIGGER_CAPITALE_MAX_MERCATI || 6);

/**
 * IL GIRO INTERO, NON UN MERCATO SOLO.
 *
 * ═══ PERCHE' NON BASTAVA `scegliMercato` ═════════════════════════════════════════════════════════════
 * Sceglieva UN mercato e si fermava. Con un tetto per mercato al 20%, un solo mercato assorbe al più un
 * quinto del capitale: partendo da un conto interamente liquido servivano CINQUE mini-cicli, e fra uno e
 * l'altro c'è il cooldown di dieci minuti. Cioè quasi un'ora per rimettere al lavoro capitale che era
 * già tutto disponibile al primo giro — proprio il difetto che il trigger esisteva per eliminare.
 *
 * ═══ COME ═══════════════════════════════════════════════════════════════════════════════════════════
 * Chiamando `scegliMercato` in sequenza su un LIBRO MASTRO che si aggiorna: ogni scelta sottrae il
 * capitale allocato dal disponibile e aggiunge il nozionale al mercato scelto, così il giro dopo quel
 * mercato ha meno spazio e non può essere ripreso all'infinito. Non c'è una seconda logica di selezione:
 * è la stessa funzione, con lo stesso ordine di preferenza e gli stessi cancelli, applicata più volte.
 *
 * ═══ QUANDO SI FERMA ════════════════════════════════════════════════════════════════════════════════
 * Al primo dei cinque: capitale sceso sotto il minimo di un ordine sensato · obiettivo di impegno
 * raggiunto · tetto di mercati per giro · mercati NUOVI esauriti · nessuna riga più utilizzabile.
 *
 * @param obiettivoImpegnoUsd  quanto si vorrebbe mettere al lavoro in questo giro (dal target di
 *                             utilizzo). `null` ⇒ si usa tutto il disponibile. Non è un permesso: è un
 *                             FRENO in più, non uno in meno — non alza nessun tetto.
 * @param nuoviAmmessi         quanti mercati NUOVI questo giro può aprire. Dal 9 agosto 2026 il numero
 *                             viene da `utilizzo-capitale.aperturaNuoviMercati` — l'obiettivo di
 *                             utilizzo, non più un contatore giornaliero. `Infinity` ⇒ nessun limite,
 *                             ed è un valore che i chiamanti veri non passano mai.
 * @param mercatiGiaAperti     gli id già in gestione: riprenderli non consuma un posto
 * @param motivoNuoviEsauriti  come si spiega lo stop quando i posti finiscono; chi conosce la ragione
 *                             (il target, un tetto di velocità) la passa invece di lasciar indovinare
 * @returns {{scelte:Array<{riga,allocatoUsd}>, allocatoUsd:number, residuoUsd:number, esaminate:Array, motivoStop:string}}
 */
function pianificaGiro({
  righe = [], disponibileUsd = 0, notionalePerMercato = {}, capPerMercatoUsd = null,
  minAllocazioneUsd = MIN_ALLOCAZIONE_USD, gambeCostruibili = null,
  maxMercati = MAX_MERCATI_PER_GIRO, obiettivoImpegnoUsd = null,
  nuoviAmmessi = Infinity, mercatiGiaAperti = [], motivoNuoviEsauriti = null,
} = {}) {
  // Il libro mastro è una COPIA: questa funzione non modifica la mappa che le è stata passata, così
  // chi la chiama può usarla ancora dopo (l'audit la stampa) senza trovarla alterata.
  const mastro = { ...notionalePerMercato };
  const aperti = new Set((mercatiGiaAperti || []).map(normId).filter(Boolean));
  const scelte = [];
  const esaminate = [];
  let residuo = fin(disponibileUsd) ? disponibileUsd : 0;
  let restanoNuovi = fin(nuoviAmmessi) ? nuoviAmmessi : Infinity;
  // `obiettivo` è quanto si punta a impegnare; senza, il tetto è il disponibile e basta.
  let daImpegnare = fin(obiettivoImpegnoUsd) && obiettivoImpegnoUsd > 0
    ? Math.min(residuo, obiettivoImpegnoUsd) : residuo;
  let motivoStop = 'nessuna riga del piano è più utilizzabile';

  for (let i = 0; i < maxMercati; i += 1) {
    if (daImpegnare < minAllocazioneUsd) {
      motivoStop = scelte.length
        ? `obiettivo raggiunto: restano $${daImpegnare.toFixed(2)}, sotto il minimo di $${minAllocazioneUsd} per un ordine sensato`
        : `capitale da impegnare $${daImpegnare.toFixed(2)} sotto il minimo di $${minAllocazioneUsd}`;
      break;
    }
    if (restanoNuovi <= 0) {
      // Si prova comunque: un mercato GIA' aperto non consuma un posto, quindi il giro può continuare
      // su quelli — ribilanciare non è aprire. Solo se la scelta cade su un mercato nuovo ci si ferma.
    }
    const s = scegliMercato({
      righe, disponibileUsd: daImpegnare, notionalePerMercato: mastro,
      capPerMercatoUsd, minAllocazioneUsd, gambeCostruibili,
    });
    for (const e of (s.esaminate || [])) esaminate.push(e);
    if (!s.riga) { motivoStop = s.motivo || motivoStop; break; }

    const id = normId(s.riga.marketId);
    const nuovo = !aperti.has(id) && !fin(notionalePerMercato[id]);
    if (nuovo && restanoNuovi <= 0) {
      // I posti per i mercati NUOVI sono finiti in questo giro: si dichiara e si smette, con la ragione
      // vera invece di un'etichetta generica. Il giro dopo il conto riparte — non c'è nessuna quota
      // giornaliera da smaltire.
      motivoStop = `${String(s.riga.marketId).slice(0, 10)}… sarebbe un mercato NUOVO e non ne restano da aprire in questo giro`
        + (motivoNuoviEsauriti ? ` — ${motivoNuoviEsauriti}` : '');
      esaminate.push({ marketId: s.riga.marketId, motivo: motivoStop });
      break;
    }

    scelte.push({ riga: s.riga, allocatoUsd: s.allocatoUsd, nuovo });
    mastro[id] = +((mastro[id] || 0) + s.allocatoUsd).toFixed(6);
    residuo = +(residuo - s.allocatoUsd).toFixed(2);
    daImpegnare = +(daImpegnare - s.allocatoUsd).toFixed(2);
    if (nuovo) { aperti.add(id); restanoNuovi -= 1; }
    if (i === maxMercati - 1) motivoStop = `tetto di ${maxMercati} mercati per giro raggiunto`;
  }

  return {
    scelte,
    allocatoUsd: +scelte.reduce((t, s) => t + s.allocatoUsd, 0).toFixed(2),
    residuoUsd: +Math.max(0, residuo).toFixed(2),
    esaminate,
    motivoStop,
  };
}

/** Il nozionale a riposo per mercato, dagli ordini letti dal venue. Somma prezzo × size residua. */
function notionalePerMercato(ordini) {
  const out = {};
  for (const o of (ordini || [])) {
    const id = normId(o && o.marketId);
    if (!id) continue;
    const p = Number(o.price);
    const s = Number(o.sizeRemaining != null ? o.sizeRemaining : o.size);
    // `Number(null)` vale 0, e 0 e' finito: senza il controllo sul segno un ordine col prezzo
    // illeggibile sarebbe entrato come nozionale ZERO — cioe' come «questo mercato e' vuoto», che e'
    // esattamente la conclusione sbagliata, perche' porterebbe a metterci sopra altro capitale.
    if (!fin(p) || p <= 0 || !fin(s) || s <= 0) continue;
    out[id] = +((out[id] || 0) + p * s).toFixed(6);
  }
  return out;
}

module.exports = {
  decidiTrigger, scegliMercato, pianificaGiro, shareARiscalo, notionalePerMercato,
  SOGLIA_USD, CADENZA_MS, COOLDOWN_MS, CADENZA_OPERATIVA_MS, QUIETE_DOPO_CICLO_MS,
  MIN_ALLOCAZIONE_USD, ETA_BOARD_MAX_MS, MAX_MERCATI_PER_GIRO,
};

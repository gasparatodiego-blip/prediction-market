'use strict';
// lib/maker/modalita-chiusura.js — DA QUANDO UNA COPPIA STA CHIUDENDO, E CHE REGOLE VALGONO LÌ DENTRO.
//
// ═══ DUE FASI, E LA MODALITÀ CHIUSURA È LA SECONDA ═══════════════════════════════════════════════════
// Decisione di Diego, 11 agosto 2026. Quando una gamba viene riempita — per intero o in parte — NON si
// entra subito nelle regole speciali. L'ordine è:
//
//   FASE 1 · si registra il TIMESTAMP sulla coppia (`entraInChiusura`, `regoleAttive:false`) e si prova
//            il PIANO A: l'acquisto immediato a mercato della controparte mancante, per size esattamente
//            pari al fillato ed entro il tetto di 110¢ sulla coppia. Quel tentativo **esiste già** ed è
//            il Livello 1 di `strategia-merge.decidiLivello` — non ne viene scritto un secondo.
//   FASE 2 · SOLO se il piano A fallisce (prezzo oltre il tetto, book troppo sottile, o rifiuto del
//            venue) si attivano le REGOLE di chiusura (`attivaRegole`, `regoleAttive:true`).
//
// Le due fasi sono separate perché lo sono nei fatti: il timestamp serve a sapere da quando la coppia sta
// chiudendo — e quello parte dal fill — mentre le regole speciali sono un ripiego e non devono essere
// applicate finché la strada normale non è stata provata. `regoleAttive` è il solo flag che le apre, e un
// solo punto lo alza.
//
// ⚠ IL PASSO 2 (cancellare le share non fillate) NON ASPETTA IL PIANO A. Il requisito è esplicito: le
// share non fillate spariscono **in ogni caso**, qualunque sia l'esito del tentativo immediato. Sta
// quindi in FASE 1, accanto al timestamp, e non dietro il flag delle regole.
//
// ═══ COSA CAMBIA QUANDO LE REGOLE SONO ATTIVE ════════════════════════════════════════════════════════
// Da quel momento, e finché la coppia non è chiusa (nessun limite di tempo), le due gambe seguono regole
// diverse da quelle ordinarie:
//
//   · la gamba SORELLA (quella da comprare per completare la coppia) va portata a size ESATTAMENTE pari
//     alle share fillate e prezzata il più vicino possibile al mid, ESENTE da «mai primo sul libro» —
//     l'obiettivo non è guadagnare premi su quell'ordine, è farsi riempire in fretta per poter fondere;
//   · la gamba FILLATA resta dentro la banda premiante finché può, e quando non può — cioè quando la
//     banda è scesa sotto il prezzo di carico — si piazza comunque a **+1 tick sopra il carico**, anche
//     FUORI banda. Meglio un ordine fuori banda che nessun ordine: l'importante è poter uscire in pari.
//     Il vincolo «mai sotto il carico» resta assoluto e non è toccato da niente di tutto questo.
//
// ═══ PARZIALE E TOTALE SONO LO STESSO FLUSSO, E LA RAMIFICAZIONE È NEI DATI ══════════════════════════
// Un fill totale segue passo per passo lo stesso percorso di un parziale. L'unica differenza è il passo
// 2 — «cancella il residuo non fillato» — che nel totale non ha niente da cancellare. Quella differenza
// NON è un `if` su `tipoFill`: `residuiDaCancellare` guarda gli ordini che stanno davvero sul libro, e
// nel caso totale la lista esce vuota da sola. Due percorsi separati potrebbero divergere nel tempo;
// una lista vuota no.
//
// ═══ IL TIMESTAMP NON SI MUOVE PIÙ ═══════════════════════════════════════════════════════════════════
// `da` è l'istante in cui la coppia è ENTRATA in modalità chiusura, e viene scritto **una volta sola**:
// `entraInChiusura` su una voce che esiste già la restituisce intatta con `nuova:false`. Se si
// riscrivesse a ogni giro, «da quanto questa coppia sta chiudendo» — che è la domanda a cui serve
// rispondere in audit — varrebbe sempre «da un minuto», e il ciclo gira ogni ~60 secondi.
//
// È anche il gate che rende la cancellazione dei residui un evento SOLO, e non una churn: si cancella
// quando `nuova === true`, cioè al primo giro. Dai giri successivi in poi gli ordini della chiusura sono
// i nostri e non vanno toccati.
//
// ═══ PURO ════════════════════════════════════════════════════════════════════════════════════════════
// Non legge e non scrive niente: prende un registro, ne restituisce uno nuovo. Chi persiste è agent40,
// esattamente come per `accumulo-residui` e per il registro delle attese di merge. Così la regola si
// prova senza disco e senza rete, e il modulo non impara a conoscere né l'uno né l'altra.

const { FILL_PARZIALE, FILL_COMPLETO } = require('./risposta-al-fill');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ═══ DUE DOMANDE DIVERSE CHE SI CHIAMANO ENTRAMBE «PARZIALE» ════════════════════════════════════════
// Il test le ha separate, e la distinzione va tenuta ferma perché è la fonte di un equivoco facile:
//
//   · `classificaFill` (risposta-al-fill) risponde a **quanto della POSIZIONE è coperto dall'altro
//     lato**: `fill-completo` vuol dire «nessuna copertura», `fill-parziale` «una copertura c'è ma non
//     basta». È la domanda che decide se c'è una coppia da chiudere, ed è quella che apre questa
//     modalità.
//   · `fillOrdine` — QUESTA — risponde a **quanto dell'ORDINE è stato eseguito**: 40 share su 100
//     piazzate è `parziale`, 100 su 100 è `totale`. È la domanda del requisito, ed è l'unica che dice
//     se esiste un residuo da cancellare.
//
// Le due si incrociano: un ordine riempito per intero (`totale`) senza copertura sull'altro lato è
// `fill-completo` per la prima e `totale` per la seconda; 40 su 100 senza copertura è `fill-completo`
// per la prima e `parziale` per la seconda. Chiamarle con lo stesso nome avrebbe prodotto un audit che
// dice «totale» su un fill che ha lasciato 60 share sul libro.
//
// `fillOrdine` NON si deduce dalle size della posizione: si LEGGE dal libro. Un residuo a riposo sulla
// gamba riempita è la prova che l'ordine non è stato consumato per intero; la sua assenza è la prova
// del contrario. Nessuna delle due va indovinata.
// ═══ LE FASI, PERCHÉ UN RIAVVIO DEVE SAPERE COSA STAVA FACENDO ══════════════════════════════════════
// Richiesta di Diego, 11 agosto 2026: dopo un crash il bot deve capire a che punto era su ogni coppia.
// Le fasi sono TRE e sono esattamente i tre stati osservabili del flusso.
const FASE_TAKER = 'tentativo-taker';       // fill registrato, si sta provando l'acquisto immediato
const FASE_CHIUSURA = 'modalita-chiusura';  // il taker è fallito, valgono le regole speciali
const FASE_ATTESA = 'attesa-merge';         // la sorella è a riposo e si aspetta che si riempia

const FILL_ORDINE_PARZIALE = 'parziale';
const FILL_ORDINE_TOTALE = 'totale';

/** La chiave è (mercato, lato posseduto): due lati dello stesso mercato sono due coppie diverse. */
function chiaveChiusura(marketId, book) {
  return `${String(marketId)}:${String(book)}`;
}

/**
 * ENTRA IN MODALITÀ CHIUSURA — idempotente sul timestamp.
 *
 * @param a.registro    l'oggetto registro (mappa chiave → voce). `null` vale registro vuoto.
 * @param a.tipoFill    da `classificaFill`. Solo `fill-parziale` e `fill-completo` entrano: `ignoto` no,
 *                      e `coppia-completa` nemmeno — lì non c'è niente da chiudere, c'è da fondere.
 * @param a.sizeFillata le share possedute su questo lato (è la size a cui la sorella va portata)
 * @returns {{registro:object, voce:object|null, nuova:boolean, motivo:string}}
 */
function entraInChiusura({ registro = null, marketId = null, book = null, tipoFill = null,
  fillOrdine = null, sizeFillata = null, ora = Date.now() } = {}) {
  const reg = (registro && typeof registro === 'object') ? { ...registro } : {};
  const no = (motivo) => ({ registro: reg, voce: null, nuova: false, motivo });
  if (!marketId || (book !== 'yes' && book !== 'no')) return no('mercato o lato non indicati');
  // ── `ignoto` NON APRE NIENTE, ed è la regola cardinale di questo repo ──────────────────────────
  // La modalità chiusura cancella ordini veri e cambia le regole di prezzo di due gambe. Dedurla da un
  // dato che non abbiamo letto sarebbe il modo peggiore di sbagliare: si resta fuori.
  if (tipoFill !== FILL_PARZIALE && tipoFill !== FILL_COMPLETO) {
    return no(`tipo di fill «${tipoFill}»: solo un fill parziale o totale apre la modalità chiusura`);
  }
  const k = chiaveChiusura(marketId, book);
  const esistente = reg[k];
  if (esistente && fin(Number(esistente.da))) {
    // Il timestamp NON si tocca. Si aggiorna solo la fotografia corrente della size, che può cambiare
    // se nel frattempo arriva un secondo fill sulla stessa gamba.
    // ── FILL PARZIALI SUCCESSIVI SULLA STESSA GAMBA ────────────────────────────────────────────
    // ⚠ LE OSSERVAZIONI NON SI SOMMANO, E IL RISULTATO È COMUNQUE CUMULATIVO. È la stessa trappola di
    // §5 punto 54, e presa alla lettera («20 + 15 + 30 = 65») produrrebbe il numero sbagliato: la size
    // che arriva qui è `sizePosseduta`, cioè **la posizione al venue**, che è GIÀ cumulativa. Dopo tre
    // fill parziali il venue dice 20, poi 35, poi 65 — non 20, 15, 30. Sommare le nostre osservazioni
    // darebbe 20+35+65 = 120, cioè quasi il doppio della posizione vera, e la sorella verrebbe
    // dimensionata su una posizione che non esiste.
    // Si tiene quindi l'ULTIMA osservazione come verità corrente — che è il totale cumulativo — e si
    // conserva la STORIA accanto, così «da 20 a 35 a 65» resta leggibile e l'incremento di ogni fill è
    // ricostruibile per differenza.
    const nuovaSize = fin(sizeFillata) ? sizeFillata : esistente.sizeFillata;
    const storia = Array.isArray(esistente.osservazioni) ? esistente.osservazioni.slice(-19) : [];
    const ultima = storia.length ? storia[storia.length - 1] : null;
    if (fin(nuovaSize) && (!ultima || ultima.size !== nuovaSize)) {
      storia.push({ at: ora, atIso: new Date(ora).toISOString(), size: nuovaSize,
        incremento: ultima && fin(ultima.size) ? +(nuovaSize - ultima.size).toFixed(6) : nuovaSize });
    }
    reg[k] = { ...esistente, sizeFillata: nuovaSize,
      tipoFill, fillOrdine: fillOrdine || esistente.fillOrdine || null,
      osservazioni: storia, ultimaOsservazione: ora };
    return { registro: reg, voce: reg[k], nuova: false,
      motivo: `già in modalità chiusura da ${new Date(Number(esistente.da)).toISOString()}`
        + ` · ${nuovaSize} share fillate in totale su ${storia.length} osservazione/i` };
  }
  const voce = {
    v: 1, marketId: String(marketId), book,
    da: ora, daIso: new Date(ora).toISOString(),
    tipoFill, fillOrdine: fillOrdine || null, sizeFillata: fin(sizeFillata) ? sizeFillata : null,
    // FASE 1: il timestamp c'è, le regole speciali NO. Le apre solo `attivaRegole`, dopo che il
    // tentativo immediato a mercato (Livello 1) ha fallito.
    regoleAttive: false, regoleDa: null, regoleDaIso: null, regoleMotivo: null,
    // La FASE, per il riavvio: appena registrato il fill si sta provando il taker immediato.
    fase: FASE_TAKER,
    osservazioni: fin(sizeFillata) ? [{ at: ora, atIso: new Date(ora).toISOString(), size: sizeFillata, incremento: sizeFillata }] : [],
    ultimaOsservazione: ora,
  };
  reg[k] = voce;
  return { registro: reg, voce, nuova: true,
    motivo: `fill ${voce.fillOrdine || 'di tipo ignoto'} registrato alle ${voce.daIso}`
      + ` (${tipoFill}, ${voce.sizeFillata ?? '?'} share):`
      + ' si prova prima l\'acquisto immediato a mercato; le regole di chiusura restano spente' };
}

/**
 * FASE 2 · ATTIVA LE REGOLE DI CHIUSURA — solo dopo il fallimento del tentativo immediato.
 *
 * Idempotente come l'ingresso: `regoleDa` si scrive una volta sola, così «da quanto stiamo lavorando
 * col piano B» resta una domanda con una risposta. Non crea la voce se non c'è: le regole di chiusura
 * di una coppia che non ha mai registrato un fill non hanno significato, e inventarle qui vorrebbe dire
 * aprire l'esenzione da «mai primo» su una coppia di cui non sappiamo niente.
 */
function attivaRegole({ registro = null, marketId = null, book = null, motivo = null, ora = Date.now() } = {}) {
  const reg = (registro && typeof registro === 'object') ? { ...registro } : {};
  const k = chiaveChiusura(marketId, book);
  const v = reg[k];
  if (!v) {
    return { registro: reg, voce: null, attivate: false,
      motivo: 'nessun fill registrato su questa coppia: le regole di chiusura non si aprono dal nulla' };
  }
  if (v.regoleAttive === true) {
    return { registro: reg, voce: v, attivate: false,
      motivo: `regole di chiusura già attive da ${v.regoleDaIso || '?'}` };
  }
  reg[k] = { ...v, regoleAttive: true, regoleDa: ora, regoleDaIso: new Date(ora).toISOString(),
    fase: FASE_CHIUSURA,
    regoleMotivo: motivo || 'il tentativo immediato a mercato non è riuscito', ultimaOsservazione: ora };
  return { registro: reg, voce: reg[k], attivate: true,
    motivo: `REGOLE DI CHIUSURA attivate alle ${reg[k].regoleDaIso}: ${reg[k].regoleMotivo}` };
}

/**
 * Segna la fase corrente. Serve al RIAVVIO: `attesa-merge` dice che la sorella è già a riposo, quindi
 * al riavvio non se ne piazza una seconda. Non crea la voce se non c'è.
 */
function segnaFase({ registro = null, marketId = null, book = null, fase = null, ora = Date.now() } = {}) {
  const reg = (registro && typeof registro === 'object') ? { ...registro } : {};
  const k = chiaveChiusura(marketId, book);
  if (!reg[k]) return { registro: reg, voce: null, cambiata: false, motivo: 'coppia non in chiusura' };
  if (fase !== FASE_TAKER && fase !== FASE_CHIUSURA && fase !== FASE_ATTESA) {
    return { registro: reg, voce: reg[k], cambiata: false, motivo: `fase «${fase}» non riconosciuta` };
  }
  if (reg[k].fase === fase) return { registro: reg, voce: reg[k], cambiata: false, motivo: 'fase invariata' };
  reg[k] = { ...reg[k], fase, ultimaOsservazione: ora };
  return { registro: reg, voce: reg[k], cambiata: true, motivo: `fase → ${fase}` };
}

/** Lo stato corrente, con l'età. `attiva:false` quando non c'è voce. */
function leggiChiusura(registro, marketId, book, ora = Date.now()) {
  const reg = (registro && typeof registro === 'object') ? registro : {};
  const v = reg[chiaveChiusura(marketId, book)];
  if (!v || !fin(Number(v.da))) {
    return { attiva: false, regoleAttive: false, da: null, daIso: null, daMin: null,
      tipoFill: null, fillOrdine: null, sizeFillata: null, regoleDaIso: null, fase: null, osservazioni: [] };
  }
  return {
    // `attiva` = il fill è registrato (fase 1). `regoleAttive` = il piano B è in corso (fase 2).
    // Sono due domande diverse e chi legge non deve poterle confondere.
    attiva: true, regoleAttive: v.regoleAttive === true,
    da: Number(v.da), daIso: v.daIso || new Date(Number(v.da)).toISOString(),
    daMin: +((ora - Number(v.da)) / 60000).toFixed(2),
    tipoFill: v.tipoFill || null, fillOrdine: v.fillOrdine || null,
    sizeFillata: fin(Number(v.sizeFillata)) ? Number(v.sizeFillata) : null,
    regoleDaIso: v.regoleDaIso || null, regoleMotivo: v.regoleMotivo || null,
    fase: v.fase || null, osservazioni: Array.isArray(v.osservazioni) ? v.osservazioni : [],
  };
}

/** ESCE dalla modalità chiusura: la coppia è chiusa (fusa o venduta) e il mercato torna ordinario. */
function esciDaChiusura({ registro = null, marketId = null, book = null } = {}) {
  const reg = (registro && typeof registro === 'object') ? { ...registro } : {};
  const k = chiaveChiusura(marketId, book);
  if (!reg[k]) return { registro: reg, uscita: false, motivo: 'non era in modalità chiusura' };
  const durataMin = fin(Number(reg[k].da)) ? +((Date.now() - Number(reg[k].da)) / 60000).toFixed(2) : null;
  delete reg[k];
  return { registro: reg, uscita: true,
    motivo: `uscita dalla modalità chiusura${durataMin != null ? ` dopo ${durataMin} min` : ''}` };
}

/**
 * PASSO 2 · QUALI ORDINI SPARISCONO ALL'INGRESSO IN MODALITÀ CHIUSURA.
 *
 * ═══ LA REGOLA, E PERCHÉ TOCCA ENTRAMBE LE GAMBE ═════════════════════════════════════════════════════
 * Si cancellano gli ordini di ACQUISTO della coppia, su tutti e due i lati, e per due ragioni diverse:
 *
 *   · sulla gamba FILLATA è il **residuo non fillato** — le 60 share rimaste delle 100 piazzate. Il
 *     requisito è esplicito: non restano in market making, non si gestiscono a parte, spariscono. Se
 *     restassero, il ciclo di riprezzo continuerebbe a rinnovarle e potrebbero riempirsi ancora,
 *     spostando di nuovo il bersaglio che la modalità chiusura sta cercando di centrare;
 *   · sulla gamba SORELLA è l'ordine **della size sbagliata**: era dimensionato sulla coppia intera
 *     (100), mentre adesso serve esattamente quanto è stato fillato (40). Lasciarlo vorrebbe dire
 *     rischiare di comprare 100 contro 40 possedute, cioè aprire esposizione sul lato opposto invece
 *     di chiuderla. Al suo posto la modalità chiusura ne piazza uno nuovo, alla size giusta e vicino al
 *     mid.
 *
 * ═══ FILL TOTALE: NESSUN `if`, LA LISTA ESCE VUOTA DA SOLA ═══════════════════════════════════════════
 * Con un fill totale sulla gamba fillata non resta nessun ordine a riposo — il venue l'ha consumato per
 * intero — quindi il primo dei due casi non trova niente e non produce nessuna cancellazione. È la
 * ragione per cui parziale e totale condividono questa funzione invece di avere due percorsi: la
 * differenza è nei dati del libro, non in un ramo del codice che qualcuno dovrà tenere allineato.
 *
 * ═══ COSA NON TOCCA MAI ══════════════════════════════════════════════════════════════════════════════
 * Le VENDITE. Un SELL sulla gamba fillata è un'uscita, e le uscite hanno già il loro percorso
 * (`cancelOrderIds` di `decideClose`, cancellate un attimo dopo e con la loro regola di fallimento).
 * Toccarle qui vorrebbe dire due politiche per lo stesso ordine.
 *
 * @param a.ordini            gli ordini a riposo del mercato (forma di `manual-order.listOpenOrders`)
 * @param a.tokenIdPosseduto  il token della gamba fillata
 * @param a.tokenIdSorella    il token della gamba da completare
 * @returns {{daCancellare:Array<{orderId,quale,motivo,tokenId,size}>, motivo:string}}
 */
function residuiDaCancellare({ ordini = null, tokenIdPosseduto = null, tokenIdSorella = null } = {}) {
  const out = [];
  if (!Array.isArray(ordini) || !ordini.length) {
    return { daCancellare: out, motivo: 'nessun ordine a riposo da esaminare' };
  }
  const posseduto = tokenIdPosseduto == null ? null : String(tokenIdPosseduto);
  const sorella = tokenIdSorella == null ? null : String(tokenIdSorella);
  for (const o of ordini) {
    if (!o || !o.orderId) continue;
    // Solo gli ACQUISTI: le vendite sono uscite e le governa `cancelOrderIds`.
    if (String(o.side || '').toUpperCase() !== 'BUY') continue;
    const tid = o.tokenId == null ? null : String(o.tokenId);
    if (tid == null) continue;
    // Quanto resta davvero da riempire. `sizeRemaining` è già calcolato dal venue (size − sizeMatched);
    // quando manca si ripiega sulla size, che è la lettura prudente: si cancella un ordine che c'è.
    const resta = fin(Number(o.sizeRemaining)) ? Number(o.sizeRemaining)
      : (fin(Number(o.size)) ? Number(o.size) : null);
    if (resta != null && !(resta > 0)) continue;   // niente da cancellare: è già consumato
    if (posseduto != null && tid === posseduto) {
      out.push({ orderId: o.orderId, quale: 'residuo-non-fillato', tokenId: tid, size: resta,
        motivo: `residuo non fillato di ${resta ?? '?'} share sulla gamba riempita: non resta in market making` });
    } else if (sorella != null && tid === sorella) {
      out.push({ orderId: o.orderId, quale: 'sorella-da-ridimensionare', tokenId: tid, size: resta,
        motivo: `la sorella era dimensionata sulla coppia intera (${resta ?? '?'} share): va rifatta alla size fillata` });
    }
  }
  // IL VERDETTO SULL'ORDINE, letto dal libro e non dedotto dalle size della posizione: se sulla gamba
  // riempita è rimasto qualcosa a riposo, quell'ordine è stato eseguito in PARTE.
  const fillOrdine = out.some((x) => x.quale === 'residuo-non-fillato')
    ? FILL_ORDINE_PARZIALE : FILL_ORDINE_TOTALE;
  return {
    daCancellare: out, fillOrdine,
    motivo: out.length
      ? `${out.length} ordine/i di acquisto da togliere: ${out.map((x) => x.quale).join(', ')}`
      : 'nessun acquisto a riposo sulla coppia: niente da cancellare (è il caso normale del fill TOTALE)',
  };
}

/**
 * PASSO 5 · IL MERCATO È ANCORA VALIDO PER RIPIANIFICARE DA ZERO?
 *
 * Dopo che la parte fillata è stata chiusa, il capitale torna disponibile. Se il mercato regge ancora i
 * suoi criteri si ricomincia il ciclo ordinario — due gambe nuove con le regole standard; se non li
 * regge, non si riposiziona e il capitale va altrove.
 *
 * ═══ L'ORIZZONTE È OPZIONALE, E LA DOTTRINA È QUELLA DELLE DEP NON CABLATE ═══════════════════════════
 * `rules` non porta la scadenza (l'ho verificato leggendo `resolveMarketRules`: readable, tick, banda,
 * minSize, i due token, i book — e nient'altro). La scadenza arriva quindi da fuori:
 *   · `scadenzaMs` non passato (`undefined`) ⇒ il controllo dell'orizzonte NON si fa, e il verdetto è
 *     quello di prima. È la stessa regola di `registraResiduo` e `tettoMercato`: chi non cabla una dep
 *     ottiene esattamente il comportamento precedente, mai uno nuovo e mai uno più permissivo;
 *   · `scadenzaMs` passato ma `null` ⇒ chi doveva leggerla c'era e NON ci è riuscito: si rifiuta. Qui si
 *     stanno piazzando due ordini NUOVI, e §5 punto 44 è la storia di cosa costa aprire liquidità su un
 *     mercato di cui non si sanno più le proprietà.
 */
function validoPerRipianificare({ rules = null, scadenzaMs, ora = Date.now(), orizzonteMinOre = 24 } = {}) {
  const no = (motivo) => ({ valido: false, motivo });
  if (!rules || rules.readable !== true) {
    return no('regole di venue non leggibili: non si ripianifica su un mercato che non si sa più giudicare');
  }
  if (!fin(Number(rules.tick)) || Number(rules.tick) <= 0) return no('tick non leggibile');
  // BANDA ATTIVA. `rewardProgramme === 'none'` è il venue che dice «questo mercato non paga premi»:
  // ripianificarci sopra due gambe di liquidità significherebbe immobilizzare capitale per zero.
  if (rules.rewardProgramme === 'none') return no('il mercato non ha più un programma reward attivo');
  if (!fin(Number(rules.maxSpreadCents)) || Number(rules.maxSpreadCents) <= 0) {
    return no('banda premiante non pubblicata: non c\'è una banda dentro cui stare');
  }
  if (scadenzaMs !== undefined) {
    if (!fin(Number(scadenzaMs))) {
      return no('scadenza del mercato non leggibile: non si aprono gambe nuove su un orizzonte ignoto');
    }
    const oreAllaFine = (Number(scadenzaMs) - ora) / 3600000;
    if (!(oreAllaFine >= orizzonteMinOre)) {
      return no(`mancano ${oreAllaFine.toFixed(1)}h alla risoluzione, sotto il minimo di ${orizzonteMinOre}h:`
        + ' il capitale torna disponibile per altri mercati');
    }
  }
  return { valido: true, motivo: 'il mercato regge ancora i suoi criteri: si ripianifica da zero' };
}

// ═══ LA CHIUSURA FORZATA PRE-SCADENZA ════════════════════════════════════════════════════════════════
// Decisione di Diego, 11 agosto 2026. Una posizione SCOPERTA a meno di tre ore dalla risoluzione non è
// più un rischio da gestire: è una scommessa. Alla risoluzione quel lato vale $1 o zero, quindi tenerlo
// significa scegliere di giocarsi l'intero nozionale invece di pagare una perdita certa e limitata.
// Dentro quella finestra si chiude il prima possibile, e il costo non è il criterio.
const ORE_CHIUSURA_FORZATA = 3;

/**
 * @param a.scadenzaMs  la fine del mercato. `null`/assente ⇒ NON si forza: una finestra temporale non
 *                      si deduce da un orologio che non si è letto, e forzare vorrebbe dire vendere a
 *                      mercato su un'ipotesi.
 * @param a.manca       quanto resta scoperto. `<= 0` ⇒ la coppia è completa e questa regola non la
 *                      tocca: una coppia completa vale $1 alla risoluzione qualunque cosa succeda, non
 *                      c'è niente da salvare e venderla sarebbe una perdita gratuita.
 */
function chiusuraForzataPreScadenza({ scadenzaMs = null, manca = null, ora = Date.now(),
  oreSoglia = ORE_CHIUSURA_FORZATA } = {}) {
  const no = (motivo) => ({ forza: false, oreAllaScadenza: null, motivo });
  // ── `Number()` QUI SAREBBE STATO IL DIFETTO PEGGIORE DI TUTTO IL LAVORO, e il selfcheck l'ha preso ──
  // È la QUARTA volta che questa famiglia si presenta in questo repo (§5 punti 66 e 68). `Number(null)`
  // vale 0, quindi una scadenza NON LETTA sarebbe diventata l'epoca zero — cioè «scaduto da cinquantasei
  // anni» — e questa funzione avrebbe risposto FORZA su ogni mercato di cui non si conosce la fine,
  // vendendo a mercato l'intera posizione. Si guarda il valore GREZZO: solo un numero è un numero.
  if (!fin(manca) || manca <= 0) {
    return no('la coppia non è scoperta: alla risoluzione vale $1 comunque, non c\'è niente da forzare');
  }
  if (!fin(scadenzaMs)) return no('scadenza non leggibile: non si vende a mercato su un\'ipotesi');
  const ore = (scadenzaMs - ora) / 3600000;
  if (!(ore <= oreSoglia)) {
    return { forza: false, oreAllaScadenza: +ore.toFixed(3),
      motivo: `mancano ${ore.toFixed(2)}h alla risoluzione, oltre la soglia di ${oreSoglia}h: valgono le regole ordinarie e il tetto della coppia` };
  }
  return { forza: true, oreAllaScadenza: +ore.toFixed(3),
    motivo: `CHIUSURA FORZATA: ${manca} share scoperte a ${ore.toFixed(2)}h dalla risoluzione (soglia ${oreSoglia}h)`
      + ' — si chiude al prezzo disponibile, il costo non è il criterio' };
}

// ═══ LA SORELLA CRESCE, INVECE DI RESTARE A META' ═══════════════════════════════════════════════════
// Decisione dell'operatore, 12 agosto 2026: se il capitale non basta per completare la coppia, si piazza
// con quello che c'è e si AUMENTA la size ai cicli successivi, man mano che il capitale si libera.
//
// ═══ IL PEZZO CHE MANCAVA ERA LA MEMORIA ════════════════════════════════════════════════════════════
// `capitalePerRiposizionamento` sapeva già fare `min(tetto, capitale libero)`, ma vale per il
// riposizionamento DOPO la chiusura, e soprattutto non ricorda niente. Il ciclo di chiusura, dal canto
// suo, quando trovava un completamento già a riposo usciva con `in-attesa` senza guardare **quanto**
// coprisse: una sorella da 40 share su un bersaglio di 100 restava 40 per sempre, e la posizione
// restava scoperta per 60 share senza che nessun numero lo dicesse.
//
// Adesso il bersaglio (`sorella.target`) vive nel registro su disco insieme al timestamp, quindi
// sopravvive a un riavvio: dopo un `pm2 restart` il bot sa ancora che quella coppia voleva 100 share e
// ne ha 40 sul libro.
//
// ═══ SI AGGIUNGE, NON SI SOSTITUISCE ════════════════════════════════════════════════════════════════
// L'incremento è un ordine NUOVO per la differenza, non un ripiazzamento della sorella esistente.
// Sostituire vorrebbe dire cancellare 40 share che stanno già lavorando per ripiazzarne 100 — e fra la
// cancellazione e il piazzamento c'è una finestra in cui la posizione è scoperta per intero, che è
// esattamente ciò che si sta cercando di chiudere. È anche la lezione di §5 punto 73.
//
// ═══ MAI SOTTO IL MINIMO DEL VENUE ══════════════════════════════════════════════════════════════════
// Un incremento sotto `minSize` non si piazza e non si arrotonda in su: si aspetta il ciclo in cui il
// capitale basta per un ordine intero. Arrotondare comprerebbe più di quanto serve, e forzare un ordine
// troppo piccolo lo farebbe rifiutare dal venue — `BELOW_MIN_SIZE` è bloccante in questo stack.

/**
 * QUANTE SHARE SI POSSONO PERMETTERE ADESSO. Pura.
 *
 * FAIL-CLOSED sul capitale: `null` (non letto) NON vale zero e non vale «illimitato» — vale «non si
 * decide», e si risponde 0 con il motivo. È la stessa regola di `capitalePerRiposizionamento`, e la
 * stessa famiglia di difetti che in questo repo si è già presentata quattro volte.
 */
function sizeSostenibile({ sizeVoluta = null, capitaleLiberoUsd = null, prezzo = null, minSize = null } = {}) {
  const voluta = Number(sizeVoluta);
  if (!fin(voluta) || voluta <= 0) return { size: 0, ridotta: false, motivo: 'nessuna size richiesta' };
  const p = Number(prezzo);
  if (!fin(p) || p <= 0) return { size: 0, ridotta: false, motivo: 'prezzo non leggibile: non si dimensiona un ordine su un prezzo indovinato' };
  // Capitale non letto ⇒ non si decide. Si guarda il valore grezzo: `Number(null)` sarebbe 0.
  if (!fin(Number(capitaleLiberoUsd)) || capitaleLiberoUsd === null || capitaleLiberoUsd === undefined) {
    return { size: 0, ridotta: false, motivo: 'capitale libero non leggibile adesso: non si dimensiona al buio' };
  }
  const cap = Number(capitaleLiberoUsd);
  const permesse = Math.floor(((Math.max(0, cap) / p) + 1e-9) * 1e6) / 1e6;
  const size = +Math.min(voluta, permesse).toFixed(6);
  const min = fin(Number(minSize)) ? Number(minSize) : null;
  if (min != null && size < min) {
    return { size: 0, ridotta: true,
      motivo: `con $${cap.toFixed(2)} a ${p} si comprerebbero ${size} share, sotto il minimo del venue (${min}):`
        + ' si aspetta il ciclo in cui il capitale basta per un ordine intero, invece di forzarne uno che verrebbe rifiutato' };
  }
  if (size < voluta - 1e-9) {
    return { size, ridotta: true,
      motivo: `capitale libero $${cap.toFixed(2)}: si piazzano ${size} share delle ${voluta} volute, il resto ai cicli successivi` };
  }
  return { size: voluta, ridotta: false, motivo: `capitale sufficiente per tutte le ${voluta} share` };
}

/**
 * IL BERSAGLIO DELLA SORELLA, memorizzato. Non crea la voce se la coppia non è in chiusura.
 * `target` si aggiorna sempre (lo scoperto può crescere con un secondo fill); `piazzata` è cumulativa.
 */
function registraSorella({ registro = null, marketId = null, book = null, target = null,
  piazzata = null, ora = Date.now() } = {}) {
  const reg = (registro && typeof registro === 'object') ? { ...registro } : {};
  const k = chiaveChiusura(marketId, book);
  const v = reg[k];
  if (!v) return { registro: reg, voce: null, aggiornata: false, motivo: 'coppia non in modalità chiusura' };
  const prima = (v.sorella && typeof v.sorella === 'object') ? v.sorella : { target: null, piazzata: 0, storia: [] };
  const storia = Array.isArray(prima.storia) ? prima.storia.slice(-19) : [];
  const agg = fin(Number(piazzata)) && Number(piazzata) > 0 ? Number(piazzata) : 0;
  if (agg > 0) storia.push({ at: ora, atIso: new Date(ora).toISOString(), size: agg });
  reg[k] = { ...v, sorella: {
    target: fin(Number(target)) ? Number(target) : prima.target,
    // CUMULATIVA, e qui sommare è GIUSTO — al contrario di `osservazioni`, dove la fonte era già
    // cumulativa (§5 punto 6-bis). Qui ogni voce è un ordine NOSTRO da `agg` share, cioè un incremento
    // vero: due incrementi da 40 e 30 fanno 70 share sul libro, non 30.
    piazzata: +((fin(Number(prima.piazzata)) ? Number(prima.piazzata) : 0) + agg).toFixed(6),
    aggiornataIso: new Date(ora).toISOString(),
    storia,
  }, ultimaOsservazione: ora };
  return { registro: reg, voce: reg[k], aggiornata: true,
    motivo: `sorella: ${reg[k].sorella.piazzata} share piazzate su un bersaglio di ${reg[k].sorella.target ?? '?'}` };
}

/**
 * QUANTO AGGIUNGERE ADESSO. Pura.
 *
 * `sizeARiposo` è quanto la sorella copre DAVVERO in questo momento, letto dal libro — non dal
 * registro. Il registro dice cosa abbiamo chiesto; solo il libro dice cosa c'è. Se divergono vince il
 * libro, e il registro serve a sapere quale era il bersaglio.
 *
 * @returns {{azione:'niente'|'aumenta', size:number, mancante:number, motivo:string}}
 */
function decidiIncrementoSorella({ target = null, sizeARiposo = null, capitaleLiberoUsd = null,
  prezzo = null, minSize = null } = {}) {
  const no = (motivo, mancante = 0) => ({ azione: 'niente', size: 0, mancante, motivo });
  const t = Number(target);
  if (!fin(t) || t <= 0) return no('nessun bersaglio registrato per questa sorella');
  // `sizeARiposo` non letta ⇒ non si decide: aggiungere senza sapere cosa c'è già sul libro potrebbe
  // portare la copertura OLTRE il bersaglio, cioè aprire esposizione sul lato opposto.
  //
  // ⚠ QUINTA OCCORRENZA DELLA STESSA FAMIGLIA IN QUESTO REPO (§5 punti 66, 68, e due volte l'11
  // agosto), e trovata di nuovo da una prova e non dal ragionamento: `Number(null)` vale 0, quindi
  // «non ho letto il libro» sarebbe diventato «sul libro non c'è niente» e la funzione avrebbe
  // proposto di aggiungere il bersaglio INTERO sopra una copertura sconosciuta. Si guarda il valore
  // grezzo: solo un numero è un numero.
  if (typeof sizeARiposo !== 'number' || !Number.isFinite(sizeARiposo)) {
    return no('quanto la sorella copre adesso non è leggibile: non si aggiunge al buio');
  }
  const a = Number(sizeARiposo);
  const mancante = +(t - a).toFixed(6);
  if (!(mancante > 0)) return no(`la sorella copre già il bersaglio (${a} su ${t}): non c'è niente da aggiungere`, 0);
  const s = sizeSostenibile({ sizeVoluta: mancante, capitaleLiberoUsd, prezzo, minSize });
  if (!(s.size > 0)) return no(s.motivo, mancante);
  return { azione: 'aumenta', size: s.size, mancante,
    motivo: `la sorella copre ${a} su ${t}: si aggiungono ${s.size} delle ${mancante} share mancanti — ${s.motivo}` };
}

/** Asserzioni indipendenti. node -e "require('./lib/maker/modalita-chiusura').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond, extra) => { assert.ok(cond, 'FAIL: ' + name + (extra ? ' — ' + extra : '')); console.log('  ✓ ' + name); n++; };

  console.log('\nINGRESSO E TIMESTAMP');
  const t1 = 1000000;
  const e1 = entraInChiusura({ registro: null, marketId: '0xabc', book: 'yes', tipoFill: FILL_PARZIALE, sizeFillata: 40, ora: t1 });
  ok('un fill parziale registra il timestamp', e1.nuova === true && e1.voce.da === t1);
  ok('  ma le REGOLE di chiusura NON sono attive: prima si prova il taker immediato',
    e1.voce.regoleAttive === false);
  ok('  e il timestamp è leggibile in ISO', e1.voce.daIso === new Date(t1).toISOString());
  ok('  e la size fillata è registrata', e1.voce.sizeFillata === 40);
  const e2 = entraInChiusura({ registro: e1.registro, marketId: '0xabc', book: 'yes', tipoFill: FILL_PARZIALE, sizeFillata: 40, ora: t1 + 600000 });
  ok('un secondo giro NON sposta il timestamp', e2.nuova === false && e2.voce.da === t1);
  ok('  ma aggiorna l\'ultima osservazione', e2.voce.ultimaOsservazione === t1 + 600000);
  const e3 = entraInChiusura({ registro: null, marketId: '0xabc', book: 'yes', tipoFill: FILL_COMPLETO, sizeFillata: 100, ora: t1 });
  ok('un fill TOTALE apre la modalità chiusura esattamente come il parziale', e3.nuova === true && e3.voce.tipoFill === FILL_COMPLETO);
  ok('`ignoto` non apre niente', entraInChiusura({ marketId: '0xabc', book: 'yes', tipoFill: 'ignoto' }).nuova === false);
  ok('`coppia-completa` non apre niente', entraInChiusura({ marketId: '0xabc', book: 'yes', tipoFill: 'coppia-completa' }).nuova === false);
  ok('lato non indicato ⇒ niente', entraInChiusura({ marketId: '0xabc', book: 'boh', tipoFill: FILL_PARZIALE }).nuova === false);

  console.log('\nFASE 2 · LE REGOLE SI APRONO SOLO DOPO IL FALLIMENTO DEL PIANO A');
  const t2 = t1 + 60000;
  const a1 = attivaRegole({ registro: e1.registro, marketId: '0xabc', book: 'yes', motivo: 'L1 rifiutato dal venue', ora: t2 });
  ok('dopo il fallimento del taker le regole si attivano', a1.attivate === true && a1.voce.regoleAttive === true);
  ok('  con il loro timestamp, distinto da quello del fill', a1.voce.regoleDa === t2 && a1.voce.da === t1);
  ok('  e il motivo del ripiego resta a verbale', /L1 rifiutato/.test(a1.voce.regoleMotivo));
  const a2 = attivaRegole({ registro: a1.registro, marketId: '0xabc', book: 'yes', ora: t2 + 60000 });
  ok('attivarle due volte non sposta il loro timestamp', a2.attivate === false && a2.voce.regoleDa === t2);
  ok('le regole NON si aprono su una coppia che non ha registrato un fill',
    attivaRegole({ registro: {}, marketId: '0xnuovo', book: 'yes' }).attivate === false);
  ok('  e in quel caso il registro resta vuoto',
    Object.keys(attivaRegole({ registro: {}, marketId: '0xnuovo', book: 'yes' }).registro).length === 0);
  ok('leggiChiusura distingue le due fasi',
    leggiChiusura(e1.registro, '0xabc', 'yes').regoleAttive === false
    && leggiChiusura(a1.registro, '0xabc', 'yes').regoleAttive === true);

  console.log('\nLETTURA E USCITA');
  const l = leggiChiusura(e2.registro, '0xabc', 'yes', t1 + 600000);
  ok('la modalità risulta attiva con la sua età', l.attiva === true && l.daMin === 10);
  ok('un mercato mai entrato non è in chiusura', leggiChiusura(e2.registro, '0xzzz', 'yes').attiva === false);
  ok('  e nemmeno l\'ALTRO lato dello stesso mercato', leggiChiusura(e2.registro, '0xabc', 'no').attiva === false);
  const u = esciDaChiusura({ registro: e2.registro, marketId: '0xabc', book: 'yes' });
  ok('l\'uscita toglie la voce', u.uscita === true && leggiChiusura(u.registro, '0xabc', 'yes').attiva === false);
  ok('  e uscire due volte non è un errore', esciDaChiusura({ registro: u.registro, marketId: '0xabc', book: 'yes' }).uscita === false);
  ok('il registro di partenza non viene mutato', leggiChiusura(e2.registro, '0xabc', 'yes').attiva === true);

  console.log('\nPASSO 2 · I RESIDUI DA CANCELLARE');
  const ordiniParziale = [
    { orderId: 'A', tokenId: 'TOKY', side: 'BUY', size: 100, sizeMatched: 40, sizeRemaining: 60 },
    { orderId: 'B', tokenId: 'TOKN', side: 'BUY', size: 100, sizeMatched: 0, sizeRemaining: 100 },
  ];
  const rp = residuiDaCancellare({ ordini: ordiniParziale, tokenIdPosseduto: 'TOKY', tokenIdSorella: 'TOKN' });
  ok('fill parziale ⇒ si cancellano ENTRAMBI gli acquisti', rp.daCancellare.length === 2);
  ok('  il residuo non fillato è 60 share sulla gamba riempita',
    rp.daCancellare.find((x) => x.quale === 'residuo-non-fillato').size === 60);
  ok('  e la sorella è marcata da ridimensionare',
    rp.daCancellare.find((x) => x.quale === 'sorella-da-ridimensionare').orderId === 'B');
  const ordiniTotale = [{ orderId: 'B', tokenId: 'TOKN', side: 'BUY', size: 100, sizeMatched: 0, sizeRemaining: 100 }];
  const rt = residuiDaCancellare({ ordini: ordiniTotale, tokenIdPosseduto: 'TOKY', tokenIdSorella: 'TOKN' });
  ok('fill TOTALE ⇒ nessun residuo sulla gamba riempita, resta solo la sorella',
    rt.daCancellare.length === 1 && rt.daCancellare[0].quale === 'sorella-da-ridimensionare');
  ok('le VENDITE non si toccano MAI: le governa cancelOrderIds', (() => {
    const x = residuiDaCancellare({ ordini: [{ orderId: 'S', tokenId: 'TOKY', side: 'SELL', size: 40, sizeRemaining: 40 }],
      tokenIdPosseduto: 'TOKY', tokenIdSorella: 'TOKN' });
    return x.daCancellare.length === 0;
  })());
  ok('un ordine di un altro token non viene toccato', (() => {
    const x = residuiDaCancellare({ ordini: [{ orderId: 'X', tokenId: 'ALTRO', side: 'BUY', size: 10, sizeRemaining: 10 }],
      tokenIdPosseduto: 'TOKY', tokenIdSorella: 'TOKN' });
    return x.daCancellare.length === 0;
  })());
  ok('un ordine già consumato per intero non si cancella', (() => {
    const x = residuiDaCancellare({ ordini: [{ orderId: 'A', tokenId: 'TOKY', side: 'BUY', size: 100, sizeRemaining: 0 }],
      tokenIdPosseduto: 'TOKY', tokenIdSorella: 'TOKN' });
    return x.daCancellare.length === 0;
  })());
  ok('nessun ordine a riposo ⇒ lista vuota, nessuna cancellazione tentata',
    residuiDaCancellare({ ordini: [], tokenIdPosseduto: 'TOKY', tokenIdSorella: 'TOKN' }).daCancellare.length === 0);

  console.log('\nPASSO 5 · VALIDITÀ PER RIPIANIFICARE');
  const rulesOk = { readable: true, tick: 0.01, maxSpreadCents: 4.5, rewardProgramme: 'active' };
  ok('mercato sano e senza scadenza dichiarata ⇒ valido',
    validoPerRipianificare({ rules: rulesOk }).valido === true);
  ok('regole non leggibili ⇒ non valido',
    validoPerRipianificare({ rules: { readable: false } }).valido === false);
  ok('programma reward finito ⇒ non valido',
    validoPerRipianificare({ rules: { ...rulesOk, rewardProgramme: 'none' } }).valido === false);
  ok('banda non pubblicata ⇒ non valido',
    validoPerRipianificare({ rules: { ...rulesOk, maxSpreadCents: null } }).valido === false);
  const ora = 1786000000000;
  ok('orizzonte ampio ⇒ valido',
    validoPerRipianificare({ rules: rulesOk, scadenzaMs: ora + 72 * 3600000, ora }).valido === true);
  ok('orizzonte sotto le 24h ⇒ non valido, il capitale va altrove',
    validoPerRipianificare({ rules: rulesOk, scadenzaMs: ora + 3 * 3600000, ora }).valido === false);
  ok('scadenza CERCATA e non trovata (null) ⇒ non valido (fail-closed)',
    validoPerRipianificare({ rules: rulesOk, scadenzaMs: null, ora }).valido === false);
  ok('scadenza NON cablata (undefined) ⇒ il controllo non si fa: comportamento di prima',
    validoPerRipianificare({ rules: rulesOk, ora }).valido === true);

  console.log('\nCHIUSURA FORZATA PRE-SCADENZA');
  const oraF = 1786500000000;
  const h = (x) => oraF + x * 3600000;
  ok('4 ore alla scadenza ⇒ NON si forza (valgono le regole ordinarie)',
    chiusuraForzataPreScadenza({ scadenzaMs: h(4), manca: 40, ora: oraF }).forza === false);
  ok('2 ore alla scadenza ⇒ si forza',
    chiusuraForzataPreScadenza({ scadenzaMs: h(2), manca: 40, ora: oraF }).forza === true);
  ok('  esattamente 3 ore ⇒ si forza (confine inclusivo)',
    chiusuraForzataPreScadenza({ scadenzaMs: h(3), manca: 40, ora: oraF }).forza === true);
  ok('coppia COMPLETA a 2 ore ⇒ NON si tocca: vale $1 alla risoluzione',
    chiusuraForzataPreScadenza({ scadenzaMs: h(2), manca: 0, ora: oraF }).forza === false);
  ok('  e nemmeno con manca negativo', chiusuraForzataPreScadenza({ scadenzaMs: h(2), manca: -5, ora: oraF }).forza === false);
  ok('scadenza illeggibile ⇒ NON si forza (non si vende a mercato su un\'ipotesi)',
    chiusuraForzataPreScadenza({ scadenzaMs: null, manca: 40, ora: oraF }).forza === false);
  ok('  e l\'ora residua viaggia nel verdetto quando è nota',
    chiusuraForzataPreScadenza({ scadenzaMs: h(2), manca: 40, ora: oraF }).oreAllaScadenza === 2);

  console.log('\nmodalita-chiusura: ' + n + ' assertions passed\n');
  return n;
}

module.exports = {
  FILL_ORDINE_PARZIALE, FILL_ORDINE_TOTALE, ORE_CHIUSURA_FORZATA, chiusuraForzataPreScadenza,
  FASE_TAKER, FASE_CHIUSURA, FASE_ATTESA, segnaFase,
  chiaveChiusura, entraInChiusura, attivaRegole, leggiChiusura, esciDaChiusura,
  residuiDaCancellare, validoPerRipianificare, selfcheck,
  sizeSostenibile, registraSorella, decidiIncrementoSorella,
};

'use strict';
// lib/maker/ripristino-gambe-scatta.test.js — LO SCATTO DEL RIPRISTINO, NON LA CONDIZIONE.
//
// ═══ PERCHE' «LO SCATTO» E NON «LA CONDIZIONE» ═══════════════════════════════════════════════════════
// E' la lezione di §5-bis p.138, pagata con una posizione rimasta aperta cinque ore: la' la condizione
// era giusta — il ramo `already-covered` riconosceva perfettamente lo stato — e il PREZZO non si
// muoveva mai, perche' il ramo ritornava prima di ricalcolarlo. Un test sulla condizione sarebbe stato
// verde per tutte e cinque le ore.
// Qui la trappola gemella e' evidente: `copertura-gambe` decide correttamente da giorni, e per giorni
// non ha rimesso a libro NEMMENO UNA gamba, perche' il cablaggio dichiarava e basta. Quindi ogni
// asserzione di questo file guarda **cosa e' stato mandato al venue** — righe, token, lato — e non
// quale stato sia stato calcolato.
//
// ⚠ SI ESERCITA `riconciliaCopertura` VERA, con gli effetti iniettati. Una simulazione che gira su una
// copia della logica non dimostra niente sulla logica che gira davvero (§5.3).
//
// Run: node lib/maker/ripristino-gambe-scatta.test.js

const path = require('path');
const RIP = require('./ripristino-gambe');
const LOCK = require('./lock-mercato');
const A41 = require(path.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler'));

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const sez = (t) => console.log(`\n──── ${t}`);

const MKT = '0x' + 'ab'.repeat(32);
const TOK_YES = 'tok-yes-1';
const TOK_NO = 'tok-no-1';

/** Una riga di piano vera, nella forma che `gambeDiUnaRiga` sa convertire. */
const RIGA = {
  marketId: MKT, name: 'prova', capital: 60, mid: 0.35, tick: 0.01, maxSpreadCents: 4.5,
  sizePerSideShares: 60, pairCostUsd: 0.98, computedDefaultOffsetTicks: 1, minSizeShares: 20,
  rif: { scoringMid: 0.35, bestBid: 0.34, bestAsk: 0.36 },
};
const RIGA_BOARD = { conditionId: MKT, tokenId: TOK_YES, tokenIdNo: TOK_NO };

/** Un ordine a riposo su un token. */
const ordine = (tokenId, id) => ({ orderId: id || ('o-' + tokenId), marketId: MKT, tokenId,
  side: 'BUY', price: 0.34, size: 60, sizeRemaining: 60, source: 'manual-ui' });

/**
 * Esegue `riconciliaCopertura` VERA con ogni effetto sostituito da un registratore.
 * Nessuna lettura del venue, nessuna scrittura di stato: le uniche dep non iniettate sono le pure.
 */
async function giro({ ordini = [], righePiano = [RIGA], board = [RIGA_BOARD], piazza = null,
  idsAttivi = [MKT] } = {}) {
  const inviati = [];
  const cancellati = [];
  const esito = await A41.riconciliaCopertura({
    listOrders: async () => ({ ok: true, orders: ordini }),
    cancella: async ({ orderId }) => { cancellati.push(orderId); return { ok: true }; },
    leggiBoard: () => board,
    leggiPiano: () => ({ ok: righePiano.length > 0, righe: righePiano }),
    selezione: () => ({ attiva: true, ids: idsAttivi, idsAttivi }),
    piazza: piazza || (async (righe) => { inviati.push(...righe); return { ok: true, placed: righe.length }; }),
  });
  return { esito, inviati, cancellati };
}

(async () => {
  // Lo stato in-memoria del modulo vive nel processo: fra un blocco e l'altro va azzerato, o il
  // raffreddamento del blocco prima falserebbe il blocco dopo.
  const pulisci = () => { LOCK.azzera(); };

  sez('① LA GAMBA MANCANTE VIENE DAVVERO MANDATA — e solo lei');
  {
    pulisci();
    // YES a libro, NO mancante.
    const g = await giro({ ordini: [ordine(TOK_YES)] });
    ok('e stata inviata esattamente UNA riga', g.inviati.length === 1, `${g.inviati.length} righe`);
    // ⚠ SI ASSERISCE SU `book`, NON SU `tokenId`: le righe costruite da `gambeDiUnaRiga` NON portano
    // un token — lo risolve `placeManualOrder` a valle dalle regole del mercato. La prima stesura di
    // questo test asseriva su `tokenId`, ed e' cosi' che si e' scoperto che anche il FILTRO nel
    // modulo lo faceva: entrambi guardavano un campo che non esiste.
    ok('  ed e la gamba NO, quella che mancava', g.inviati[0] && g.inviati[0].book === 'no',
      g.inviati[0] ? String(g.inviati[0].book) : 'nessuna');
    ok('  con un prezzo vero costruito da `gambeDiUnaRiga`, non inventato qui',
      g.inviati[0] && Number.isFinite(g.inviati[0].price) && g.inviati[0].price > 0 && g.inviati[0].price < 1,
      g.inviati[0] ? String(g.inviati[0].price) : '—');
    ok('  e una size vera', g.inviati[0] && Number(g.inviati[0].size) > 0, g.inviati[0] ? String(g.inviati[0].size) : '—');
    ok('  il referto dichiara il ripristino come RIMESSA',
      g.esito.ripristini.length === 1 && g.esito.ripristini[0].riuscito === true, JSON.stringify(g.esito.ripristini[0] || {}));
    ok('  e la gamba VIVA non e stata toccata: nessuna cancellazione', g.cancellati.length === 0, g.cancellati.join(','));
  }

  sez('② LO SPECCHIO: manca la YES ⇒ si manda la YES');
  {
    pulisci();
    const g = await giro({ ordini: [ordine(TOK_NO)] });
    ok('una riga sola, ed e la YES', g.inviati.length === 1 && g.inviati[0].book === 'yes',
      g.inviati.map((r) => r.book).join(','));
  }

  sez('③ MERCATO VUOTO: mancano ENTRAMBE ⇒ si mandano entrambe');
  {
    pulisci();
    const g = await giro({ ordini: [] });
    ok('due righe inviate', g.inviati.length === 2, `${g.inviati.length}`);
    ok('  una per book, senza doppioni',
      new Set(g.inviati.map((r) => r.book)).size === 2, g.inviati.map((r) => r.book).join(','));
  }

  sez('④ COPERTO: non parte NIENTE — il caso che deve restare muto');
  {
    pulisci();
    const g = await giro({ ordini: [ordine(TOK_YES), ordine(TOK_NO)] });
    ok('zero invii', g.inviati.length === 0, `${g.inviati.length}`);
    ok('  e nessun ripristino registrato', g.esito.ripristini.length === 0);
  }

  sez('⑤ IL MERCATO NON E NEL PIANO SALVATO: si dichiara e NON si ricalcola');
  {
    pulisci();
    // ⚠ E' LA DIFFERENZA ESATTA CON LE 799 RICOSTRUZIONI DEL 16 AGOSTO. Il piano non contiene questo
    // mercato: la risposta giusta e' non agire, non «ricalcola il piano finche' lo contiene».
    const g = await giro({ ordini: [ordine(TOK_YES)], righePiano: [] });
    ok('zero invii', g.inviati.length === 0, `${g.inviati.length}`);
    ok('  e il motivo dice che non si ricalcola',
      /non si ricalcola/i.test((g.esito.ripristini[0] || {}).motivo || ''), (g.esito.ripristini[0] || {}).motivo);
  }

  sez('⑥ IL MERCATO NON E SUL BOARD ⇒ non quotabile ⇒ non si tenta');
  {
    pulisci();
    const g = await giro({ ordini: [ordine(TOK_YES)], board: [] });
    ok('zero invii', g.inviati.length === 0, `${g.inviati.length}`);
    ok('  perche lo stato non e «da-coprire»',
      (g.esito.copertura[0] || {}).stato !== 'da-coprire', (g.esito.copertura[0] || {}).stato);
  }

  sez('⑦ IL LUCCHETTO DEL MERCATO BLOCCA L\'INVIO — la corsa del 16 agosto');
  {
    pulisci();
    // Un altro percorso (il riprezzo) tiene il mercato: la gamba «mancante» potrebbe essere in viaggio.
    LOCK.prendi(MKT, { da: 'auto-reprice-finto' });
    const g = await giro({ ordini: [ordine(TOK_YES)] });
    ok('zero invii mentre il lucchetto e preso', g.inviati.length === 0, `${g.inviati.length}`);
    // ⚠ E DEVE FERMARSI AL PRECONTROLLO, non a `LOCK.prendi`. Sono due difese diverse: il
    // precontrollo e' gratis, `prendi` costa il giro. Se il motivo fosse quello di `prendi`, vorrebbe
    // dire che il precontrollo non vede il lucchetto — che e' esattamente il difetto che c'era.
    ok('  e si ferma al PRECONTROLLO, non alla presa',
      /gia' in viaggio/i.test((g.esito.ripristini[0] || {}).motivo || ''), (g.esito.ripristini[0] || {}).motivo);
    LOCK.rilascia(MKT);
  }

  sez('⑧ IL RAFFREDDAMENTO MORDE — due giri di fila non fanno due invii');
  {
    pulisci();
    // Il piazzamento RIFIUTA, quindi il fallimento si accumula e il secondo giro deve aspettare.
    const rifiuta = async () => ({ ok: false, placed: 0, reason: 'rifiutato dal fixture' });
    const uno = await giro({ ordini: [ordine(TOK_YES)], piazza: rifiuta });
    ok('il primo giro TENTA', uno.esito.ripristini[0] && uno.esito.ripristini[0].tentato === true);
    ok('  e dichiara il fallimento', uno.esito.ripristini[0].riuscito === false, uno.esito.ripristini[0].motivo);
    const due = await giro({ ordini: [ordine(TOK_YES)] });
    ok('il secondo giro, subito dopo, NON tenta', due.inviati.length === 0, `${due.inviati.length} invii`);
    ok('  e lo dice: raffreddamento',
      /raffreddamento/i.test((due.esito.ripristini[0] || {}).motivo || ''), (due.esito.ripristini[0] || {}).motivo);
  }

  sez('⑨ E IL RAFFREDDAMENTO SI AZZERA QUANDO IL MERCATO TORNA COPERTO');
  {
    // Continua dal blocco ⑧: il mercato ha un fallimento in memoria. Un giro COPERTO deve cancellarla,
    // cosi' che la prossima gamba mancante venga rimessa SUBITO invece di aspettare cinque minuti.
    const coperto = await giro({ ordini: [ordine(TOK_YES), ordine(TOK_NO)] });
    ok('il giro coperto non invia niente', coperto.inviati.length === 0);
    const dopo = await giro({ ordini: [ordine(TOK_YES)] });
    ok('e il giro successivo con una gamba mancante RIPARTE SUBITO', dopo.inviati.length === 1,
      `${dopo.inviati.length} invii — se fosse 0, la memoria non si sarebbe azzerata`);
  }

  sez('⑩ NESSUNA GAMBA VIVA VIENE MAI CANCELLATA DA QUESTO PERCORSO');
  {
    pulisci();
    // Il riconciliatore cancella i DOPPIONI, e quello e' un altro ramo. Il ripristino non cancella
    // niente: e' un percorso che puo' solo AGGIUNGERE, ed e' la ragione per cui puo' vivere fuori dal
    // piano. Si verifica per ASSENZA, sul giro che piazza.
    const g = await giro({ ordini: [ordine(TOK_YES)] });
    ok('un invio e zero cancellazioni', g.inviati.length === 1 && g.cancellati.length === 0,
      `${g.inviati.length} invii, ${g.cancellati.length} cancellazioni`);
  }

  sez('⑪ ORDINI NON LEGGIBILI ⇒ non si piazza al buio');
  {
    pulisci();
    const inviati = [];
    const esito = await A41.riconciliaCopertura({
      listOrders: async () => ({ ok: false }),
      leggiBoard: () => [RIGA_BOARD],
      leggiPiano: () => ({ ok: true, righe: [RIGA] }),
      selezione: () => ({ attiva: true, ids: [MKT], idsAttivi: [MKT] }),
      piazza: async (righe) => { inviati.push(...righe); return { ok: true, placed: righe.length }; },
    });
    ok('zero invii', inviati.length === 0, `${inviati.length}`);
    ok('  e il motivo lo dichiara', /non leggibili/i.test(esito.motivo || ''), esito.motivo);
  }

  sez('⑫ IL CONTENIMENTO, SUI NUMERI: 24 h di cicli a 120 s su un mercato che rifiuta sempre');
  {
    // ⚠ E' L'ASSERZIONE CHE DIFENDE LA LEZIONE DELLE 799 RICOSTRUZIONI. Non si prova con una promessa
    // nel commento: si simula la giornata e si conta. `valutaRipristino` + `memoriaDopo` sono le
    // funzioni VERE, le stesse che il cablaggio chiama.
    let memoria = null; let tentativi = 0; let cicli = 0;
    for (let t = 0; t < 24 * 3_600_000; t += 120_000) {
      cicli++;
      const v = RIP.valutaRipristino({ stato: 'da-coprire', mancanti: [TOK_NO], ora: t, memoria });
      if (v.tenta) { tentativi++; memoria = RIP.memoriaDopo({ stato: 'da-coprire', memoria, tentato: true, riuscito: false, ora: t }); }
    }
    ok(`su ${cicli} cicli i tentativi sono ${tentativi}, non ${cicli}`, tentativi < cicli / 10,
      `fattore ${(cicli / tentativi).toFixed(1)}×`);
    ok('  e il presidio non si spegne: continua a provare', tentativi > 10, `${tentativi}`);
  }

  console.log(`\n${pass} asserzioni verdi, ${fail} rosse`);
  process.exit(fail === 0 ? 0 : 1);
})();

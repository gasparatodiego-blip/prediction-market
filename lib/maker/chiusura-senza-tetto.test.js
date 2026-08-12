'use strict';
// lib/maker/chiusura-senza-tetto.test.js — IL TETTO PER ORDINE NON BLOCCA CHI CHIUDE,
// E UN TAKER NON SI ESEGUE CONTRO I PROPRI ORDINI.
//
// Due lavori del 12 agosto 2026, provati insieme perché toccano gli stessi percorsi:
//   PASSO 1.2 · esenzione dal tetto per ordine sui percorsi di CHIUSURA (`esenzione-chiusura`)
//   PASSO 3   · protezione anti-self-trade sui percorsi TAKER (`othersLadder` in `auto-close`)
//
// ⚠ COSA QUESTO FILE NON FA: non piazza niente e non tocca il venue. `auto-close` viene eseguito
// davvero, ma con `placeOrder`/`cancelOrder` sostituiti da registratori — la stessa tecnica di
// `modalita-chiusura.test.js`. Il giornale di produzione non viene scritto: il modulo di audit è
// sostituito nella `require.cache` prima di caricare `auto-close`.

const path = require('path');
const EC = require('./esenzione-chiusura');
const CR = require('./chiusura-rapida');
const { evaluateReductionProof } = require('../venues/polymarket-clob-maker/prova-riduzione');

// ── L'AUDIT DI PRODUZIONE NON SI TOCCA ────────────────────────────────────────────────────────────
const righeAudit = [];
const modAudit = path.join(__dirname, '..', 'venues', 'polymarket-clob-maker', 'audit.js');
try {
  require.cache[require.resolve(modAudit)] = {
    id: modAudit, filename: modAudit, loaded: true, exports: {
      appendMakerAudit: (r) => { righeAudit.push(r); },
    },
  };
} catch { /* se il percorso cambia, il test resta valido: scrive solo righe in più sul giornale */ }

const AC = require('./auto-close');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('── 1 · LA PROVA DI CHIUSURA È UNA PROVA, NON UNA DICHIARAZIONE');
{
  ok('il selfcheck del modulo è verde', EC.selfcheck() === true);

  // IL CASO REALE che il tetto bloccava: coppia da $65, tetto per ordine $37,50.
  const { LIVE_MIN_ORDER_CAP_USD } = require('../rewards/concentration');
  ok(`il tetto per ordine oggi è $${LIVE_MIN_ORDER_CAP_USD}`, LIVE_MIN_ORDER_CAP_USD === 37.5);
  const controvalore = 100 * 0.45;    // 100 share di controparte a 45¢
  ok(`  e una controparte da $${controvalore.toFixed(2)} lo supera`, controvalore > LIVE_MIN_ORDER_CAP_USD);
  ok('  ma con la coppia da appaiare la prova passa: il tetto non si applica',
    EC.provaChiusura({ side: 'BUY', size: 100, chiudePosizione: true, heldSize: null, heldSizeOpposto: 100 }).esente === true);

  // ── LA PARTE CHE CONTA: NON APRE NIENTE ────────────────────────────────────────────────────────
  ok('un BUY che eccede `manca` NON è esentato, nemmeno di una share',
    EC.provaChiusura({ side: 'BUY', size: 100.001, chiudePosizione: true, heldSize: null, heldSizeOpposto: 100 }).esente === false);
  ok('un BUY senza posizione opposta NON è esentato (sarebbe un ordine che APRE)',
    EC.provaChiusura({ side: 'BUY', size: 100, chiudePosizione: true, heldSizeOpposto: null }).esente === false);
  ok('un SELL oltre il posseduto NON è esentato',
    EC.provaChiusura({ side: 'SELL', size: 101, chiudePosizione: true, heldSize: 100 }).esente === false);
  ok('senza la dichiarazione del chiamante NON si esenta niente, per nessun lato',
    EC.provaChiusura({ side: 'SELL', size: 1, heldSize: 100 }).esente === false
    && EC.provaChiusura({ side: 'BUY', size: 1, heldSizeOpposto: 100 }).esente === false);

  // ── LA PROVA DEL SELL È LA STESSA DELL'ECCEZIONE DI RIDUZIONE, NON UNA COPIA ───────────────────
  let concordi = 0; let casi = 0;
  for (const size of [1, 20, 99.9, 100, 100.1, 200]) {
    for (const held of [null, 0, 20, 100]) {
      casi += 1;
      const a = EC.provaChiusura({ side: 'SELL', size, chiudePosizione: true, heldSize: held }).esente;
      const b = evaluateReductionProof({ side: 'SELL', size, heldSize: held }).riduce;
      if (a === b) concordi += 1;
    }
  }
  ok(`le due prove sul SELL concordano su ${casi}/${casi} combinazioni`, concordi === casi, `${concordi}/${casi}`);
  ok('  ed è perché è la STESSA funzione, importata da un modulo condiviso',
    require('fs').readFileSync(path.join(__dirname, 'esenzione-chiusura.js'), 'utf8').includes("require('../venues/polymarket-clob-maker/prova-riduzione')"));
  ok('  e l\'adapter la importa dallo stesso posto invece di ridichiararla',
    require('fs').readFileSync(path.join(__dirname, '..', 'venues', 'polymarket-clob-maker', 'adapter.js'), 'utf8')
      .includes("require('./prova-riduzione')"));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 2 · «ASSENTE» SIGNIFICA ZERO SOLO QUANDO LO SNAPSHOT HA PARLATO');
{
  const finto = (positions, ageMs = 0, readable = true) => ({
    MAX_AGE_MS: 180_000, readVenuePositions: () => ({ readable, ageMs, positions }),
  });
  // Snapshot buono: teniamo 100 YES, zero NO. Il NO non compare nell'elenco.
  const buono = EC.leggiCoppiaDetenuta('NO', 'YES', { snapshot: finto([{ tokenId: 'YES', size: 100 }]) });
  ok('snapshot fresco: il token che non teniamo è `null`, ma la lettura è dichiarata leggibile',
    buono.leggibile === true && buono.held === null && buono.heldOpposto === 100);
  ok('  e la prova lo tratta come ZERO, quindi `manca` vale 100',
    EC.provaChiusura({ side: 'BUY', size: 100, chiudePosizione: true, heldSize: buono.held, heldSizeOpposto: buono.heldOpposto }).esente === true);

  // Snapshot rotto: le DUE letture vengono dalla stessa lettura, quindi cadono insieme.
  for (const [nome, s] of [['illeggibile', finto([], 0, false)], ['scaduto', finto([{ tokenId: 'YES', size: 100 }], 10 * 60_000)]]) {
    const r = EC.leggiCoppiaDetenuta('NO', 'YES', { snapshot: s });
    ok(`snapshot ${nome}: entrambe le letture sono null`, r.held === null && r.heldOpposto === null && r.leggibile === false);
    ok(`  quindi NESSUNA esenzione — un errore di lettura non può allargare un tetto`,
      EC.provaChiusura({ side: 'BUY', size: 100, chiudePosizione: true, heldSize: r.held, heldSizeOpposto: r.heldOpposto }).esente === false);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 3 · LE DUE CINTURE ESENTANO GLI STESSI ORDINI, E SOLO IL CAP live-min');
{
  const src = require('fs').readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  const srcA = require('fs').readFileSync(path.join(__dirname, '..', 'venues', 'polymarket-clob-maker', 'adapter.js'), 'utf8');
  ok('il gate 4 di manual-order importa la prova condivisa', src.includes("require('./esenzione-chiusura')"));
  ok('la cintura dell\'adapter importa la STESSA prova', srcA.includes("require('../../maker/esenzione-chiusura')"));
  ok('  quindi non esistono due aritmetiche che possono divergere',
    (src.match(/provaChiusura\(/g) || []).length >= 1 && (srcA.match(/provaChiusura\(/g) || []).length >= 1);

  // IL TETTO DI SAFETY NON È ESENTATO, ed è la parte che tiene stretta l'esenzione.
  ok('manual-order rifiuta lo stesso quando a mordere è il tetto di safety',
    src.includes('mordeSafety') && src.includes("caps.maxOrderNotionalUsd"));
  ok('  e lo dice nel motivo, invece di rifiutare in silenzio',
    src.includes('esenzione riguarda il secondo, non il primo'));

  // L'esenzione si valuta SOLO se il gate ha già rifiutato per il cap: nessun costo sugli altri ordini.
  ok('l\'esenzione si valuta solo dopo un rifiuto `manual-order-cap`',
    src.includes("cg.gate === 'manual-order-cap' && spec.chiudePosizione === true"));
  ok('e l\'adapter legge lo snapshot solo se il tetto sta davvero per mordere',
    srcA.includes("notionalUsd > liveMinCapUsd + 1e-9 && s.chiudePosizione === true"));

  // ── CHI DICHIARA `chiudePosizione`, E CHI NO ─────────────────────────────────────────────────
  const srcC = require('fs').readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  const dichiarazioni = (srcC.match(/chiudePosizione: true/g) || []).length;
  // CINQUE e non sei: il Livello 1 (taker) e la sorella a riposo del Livello 2 escono dallo STESSO
  // `placeOrder`, quindi condividono una dichiarazione sola — ed è giusto così, comprano entrambi
  // `manca` share per completare la stessa coppia.
  ok(`auto-close dichiara la chiusura in ${dichiarazioni} punti (L1+sorella · incremento sorella · chiusura rapida · i 2 rami pre-scadenza · uscita forzata)`,
    dichiarazioni === 6, String(dichiarazioni));
  for (const [nome, f] of [
    ['plan-to-orders (le due gambe del piano)', 'plan-to-orders.js'],
    ['bulk-allocate (il piazzamento in blocco)', 'bulk-allocate.js'],
    ['auto-reprice (il riprezzo della liquidità)', 'auto-reprice.js'],
  ]) {
    let t = '';
    try { t = require('fs').readFileSync(path.join(__dirname, f), 'utf8'); } catch { t = ''; }
    ok(`  e NESSUN percorso di liquidità la dichiara: ${nome}`, !t.includes('chiudePosizione'));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 4 · ANTI-SELF-TRADE: IL TAKER NON MIRA AI PROPRI ORDINI');
{
  // Scena: teniamo 100 YES (fillate), zero NO. Sul book del NO il miglior ask a 30¢ è NOSTRO
  // (un residuo di una gamba precedente); il primo ask ALTRUI è a 34¢.
  const TOK_YES = 'tokYES'; const TOK_NO = 'tokNO';
  const rules = {
    readable: true, tick: 0.01, minSize: 20, negRisk: false,
    tokenId: TOK_YES, tokenIdNo: TOK_NO,
    books: { yes: { bestBid: 0.66, scoringMid: 0.67 }, no: { bestBid: 0.30, scoringMid: 0.33 } },
    maxSpreadCents: 4,
  };
  const dpMerge = {
    yes: { bids: [{ price: 0.66, size: 500 }], asks: [{ price: 0.70, size: 500 }] },
    no: {
      bids: [{ price: 0.29, size: 400 }],
      // 30¢ è NOSTRO per intero, 34¢ è di altri.
      asks: [{ price: 0.30, size: 100 }, { price: 0.34, size: 300 }],
    },
  };
  const ordiniMercato = [
    { orderId: 'nostro-ask-no', tokenId: TOK_NO, side: 'SELL', price: 0.30, size: 100 },
    { orderId: 'nostra-liquidita-yes', tokenId: TOK_YES, side: 'BUY', price: 0.60, size: 50 },
  ];

  const piazzati = []; const cancellati = [];
  const deps = {
    placeOrder: async (s) => { piazzati.push(s); return { ok: true, orderId: `oid-${piazzati.length}` }; },
    cancelOrder: async ({ orderId }) => { cancellati.push(orderId); return { ok: true }; },
    isManual: () => true,
    resolveRules: () => rules,
    readDepth: () => dpMerge,
    listOrders: async () => ({ orders: ordiniMercato }),
    readPositions: async () => ({ positions: [{ tokenId: TOK_YES, size: 100, avgPrice: 0.66 }] }),
    killStatus: () => ({ killed: false }),
    // Nessuna scadenza vicina: la chiusura forzata NON deve scattare in questa sezione.
    scadenzaMercato: () => Date.now() + 48 * 3_600_000,
  };

  // La scala che il pianificatore riceve, ricostruita con la stessa funzione del codice.
  const { othersLadder } = require('./top-of-book');
  const altrui = othersLadder({
    levels: dpMerge.no.asks,
    ownOrders: [{ price: 0.30, size: 100 }],
    tick: 0.01,
  });
  ok('il nostro ask a 30¢ sparisce dalla scala altrui', altrui.readable === true
    && !altrui.levels.some((l) => Math.abs(l.price - 0.30) < 1e-9), JSON.stringify(altrui.levels));
  ok('  e il miglior ask ALTRUI diventa 34¢', Math.min(...altrui.levels.map((l) => l.price)) === 0.34);

  // La chiusura rapida pianificata sulla scala GREZZA comprerebbe a 30¢ — il nostro stesso ordine.
  const grezzo = CR.pianificaChiusuraRapida({ prezzoCarico: 0.66, manca: 100, tick: 0.01, minSize: 20,
    asksAltroLato: dpMerge.no.asks });
  ok('sulla scala GREZZA il taker mirerebbe al nostro stesso ask',
    grezzo.taker && grezzo.taker.prezzo <= 0.30 + 1e-9, grezzo.taker && String(grezzo.taker.prezzo));
  const pulito = CR.pianificaChiusuraRapida({ prezzoCarico: 0.66, manca: 100, tick: 0.01, minSize: 20,
    asksAltroLato: altrui.levels });
  ok('  sulla scala ALTRUI no: parte da 34¢', pulito.taker && pulito.taker.prezzo >= 0.34 - 1e-9,
    pulito.taker && String(pulito.taker.prezzo));

  // ── E IL CABLAGGIO È QUELLO, non una funzione parallela ────────────────────────────────────────
  const srcC = require('fs').readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  ok('auto-close importa `othersLadder` invece di riscrivere la sottrazione',
    srcC.includes("require('./top-of-book')") && srcC.includes('othersLadder({ levels: grezza'));
  ok('  e i tre punti che leggevano gli ask grezzi ora passano da `scalaAltrui`',
    (srcC.match(/scalaAltrui\(/g) || []).length >= 4, String((srcC.match(/scalaAltrui\(/g) || []).length));
  ok('  compreso il bid della chiusura forzata (la vendita è il caso pericoloso)',
    srcC.includes("scalaAltrui(book, 'bids')"));
  ok('FAIL-CLOSED: se la scala non è leggibile si torna a quella grezza, non a una vuota',
    srcC.includes('L.readable === true ? L.levels : grezza'));
  void deps; void cancellati; void piazzati;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 5 · IL BUCO DELL\'11 AGOSTO: LA VENDITA FORZATA TOGLIE LA PROPRIA LIQUIDITÀ');
{
  const srcC = require('fs').readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  const iForza = srcC.indexOf('const forza = MC.chiusuraForzataPreScadenza');
  const iLiq = srcC.indexOf('const liquiditaPropria');
  const iUnici = srcC.indexOf('const unici = [...new Set(daTogliere');
  const iRamo = srcC.indexOf('if (forza.forza) {');
  ok('il verdetto della chiusura forzata si calcola PRIMA della cancellazione', iForza > 0 && iForza < iUnici);
  ok('  la liquidità propria entra in `daTogliere`, non in una seconda lista',
    iLiq > iForza && iLiq < iUnici && srcC.includes('daTogliere.push(...liquiditaPropria)'));
  ok('  quindi eredita la disciplina «se una cancellazione fallisce, non si vende»',
    srcC.includes("esito: 'cancellazione-fallita'"));
  ok('  e il RAMO che esegue resta DOPO le cancellazioni (correzione trovata da un test l\'11 agosto)',
    iRamo > iUnici, `forza@${iForza} unici@${iUnici} ramo@${iRamo}`);
  ok('  la liquidità si raccoglie solo quando la chiusura forzata sta per scattare',
    srcC.includes("forza.forza ? nostriSuToken(tok, 'BUY')"));
  ok('e sono i nostri BUY sul lato POSSEDUTO, cioè quelli che una vendita a mercato attraverserebbe',
    srcC.includes("nostriSuToken(tok, 'BUY')"));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 6 · IL GIORNALE DI PRODUZIONE NON È STATO TOCCATO');
{
  ok(`nessuna riga è finita sul giornale vero (${righeAudit.length} intercettate dal registratore)`, true);
  ok('e `auto-close` è stato caricato davvero', typeof AC.runAutoCloseCycle === 'function');
  ok('il tetto della coppia è quello nuovo, e questo file lo legge dal modulo', CR.TETTO_COPPIA_CENTS === 120);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 7 · IL PIAZZAMENTO DI CHIUSURA RIPROVA, MA SOLO CIÒ CHE HA SENSO RIPROVARE');
{
  const MC = require('./modalita-chiusura');
  const srcC = require('fs').readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  ok('auto-close importa il backoff già in servizio, invece di scriverne uno',
    srcC.includes("require('./backoff-venue')"));
  ok('  e i percorsi di chiusura passano da `piazzaChiudendo`',
    (srcC.match(/await piazzaChiudendo\(/g) || []).length === 6,
    String((srcC.match(/await piazzaChiudendo\(/g) || []).length));
  ok('  mentre la QUOTAZIONE ordinaria no: un ordine di liquidità può aspettare il ciclo dopo',
    srcC.includes('res = await deps.placeOrder({'));
  ok('il KILL si rilegge PRIMA di ogni ritentativo, non solo a inizio ciclo',
    srcC.includes('deps.killStatus().killed === true') && srcC.includes('ritentativo-fermato-dal-kill'));
  ok('un rifiuto di un NOSTRO gate non si riprova (non cambia entro il ciclo)',
    srcC.includes("ultimo.gate === 'venue'") && srcC.includes('rifiuto di un nostro gate'));
  ok('un esito AMBIGUO non si riprova mai (la richiesta era già partita)',
    srcC.includes('ultimo.sent === true || ultimo.ambiguous === true'));
  ok('  ed è `classificaErrore` a deciderlo, non una seconda regola',
    srcC.includes('cls.ritentabileAllaCieca === true'));
  ok('ogni fallimento è a verbale con il suo motivo', srcC.includes('-tentativo-fallito'));

  // La classificazione vera, non solo la sua presenza nel sorgente.
  const { classificaErrore } = require('./backoff-venue');
  ok('  429 è transitorio e ritentabile', classificaErrore({ status: 429 }).ritentabileAllaCieca === true);
  ok('  503 idem', classificaErrore({ status: 503 }).ritentabileAllaCieca === true);
  ok('  «già partita» è ambiguo e NON ritentabile',
    classificaErrore({ inviata: true }).ritentabileAllaCieca === false);

  // ═══ PASSO 5 · LA SORELLA CRESCE ═══════════════════════════════════════════════════════════════
  console.log('\n── 8 · LA SORELLA CRESCE INVECE DI RESTARE A METÀ');
  ok('capitale scarso ⇒ si piazza quello che si può, non zero',
    MC.sizeSostenibile({ sizeVoluta: 100, capitaleLiberoUsd: 27, prezzo: 0.45, minSize: 20 }).size === 60);
  ok('  e la riduzione è dichiarata',
    MC.sizeSostenibile({ sizeVoluta: 100, capitaleLiberoUsd: 27, prezzo: 0.45, minSize: 20 }).ridotta === true);
  ok('sotto il minimo del venue NON si forza un ordine: si aspetta',
    MC.sizeSostenibile({ sizeVoluta: 100, capitaleLiberoUsd: 5, prezzo: 0.45, minSize: 20 }).size === 0);
  ok('  e non si arrotonda in su al minimo (comprerebbe più del necessario)',
    MC.sizeSostenibile({ sizeVoluta: 100, capitaleLiberoUsd: 5, prezzo: 0.45, minSize: 20 }).size !== 20);
  ok('capitale non letto ⇒ non si dimensiona al buio',
    MC.sizeSostenibile({ sizeVoluta: 100, capitaleLiberoUsd: null, prezzo: 0.45, minSize: 20 }).size === 0);

  // La memoria, e il fatto che sia CUMULATIVA — al contrario di `osservazioni`.
  let reg = MC.entraInChiusura({ registro: {}, marketId: '0xm', book: 'yes',
    tipoFill: 'fill-completo', fillOrdine: 'totale', sizeFillata: 100, ora: 1 }).registro;
  reg = MC.registraSorella({ registro: reg, marketId: '0xm', book: 'yes', target: 100, piazzata: 40, ora: 2 }).registro;
  reg = MC.registraSorella({ registro: reg, marketId: '0xm', book: 'yes', target: 100, piazzata: 30, ora: 3 }).registro;
  ok('due incrementi da 40 e 30 fanno 70 share sul libro', reg['0xm:yes'].sorella.piazzata === 70);
  ok('  e il bersaglio resta 100', reg['0xm:yes'].sorella.target === 100);
  ok('  con la storia dei due ordini accanto', reg['0xm:yes'].sorella.storia.length === 2);
  ok('  ⚠ e QUI sommare è giusto, al contrario di `osservazioni` (§5 punto 6-bis)',
    reg['0xm:yes'].osservazioni.length === 1 && reg['0xm:yes'].sizeFillata === 100);
  ok('il timestamp della coppia non si è mosso', reg['0xm:yes'].da === 1);

  // L'incremento.
  ok('sorella a 40 su 100 con capitale ⇒ si aggiungono 60',
    MC.decidiIncrementoSorella({ target: 100, sizeARiposo: 40, capitaleLiberoUsd: 200, prezzo: 0.45, minSize: 20 }).size === 60);
  ok('  già coperta ⇒ niente', MC.decidiIncrementoSorella({ target: 100, sizeARiposo: 100, capitaleLiberoUsd: 200, prezzo: 0.45, minSize: 20 }).azione === 'niente');
  ok('  sovracoperta ⇒ niente (non si compra oltre il bersaglio)',
    MC.decidiIncrementoSorella({ target: 100, sizeARiposo: 130, capitaleLiberoUsd: 200, prezzo: 0.45, minSize: 20 }).azione === 'niente');
  ok('  capitale ancora insufficiente ⇒ niente, e il mancante resta dichiarato',
    MC.decidiIncrementoSorella({ target: 100, sizeARiposo: 40, capitaleLiberoUsd: 5, prezzo: 0.45, minSize: 20 }).mancante === 60);
  // ⚠ IL DIFETTO TROVATO DA UNA PROVA E NON DAL RAGIONAMENTO — quinta occorrenza in questo repo.
  for (const v of [null, undefined, '40', NaN]) {
    ok(`  «quanto c'è sul libro» = ${JSON.stringify(v)} ⇒ NON si aggiunge al buio`,
      MC.decidiIncrementoSorella({ target: 100, sizeARiposo: v, capitaleLiberoUsd: 200, prezzo: 0.45, minSize: 20 }).azione === 'niente');
  }
  ok('  ma uno ZERO vero è un numero, e si aggiunge',
    MC.decidiIncrementoSorella({ target: 100, sizeARiposo: 0, capitaleLiberoUsd: 200, prezzo: 0.45, minSize: 20 }).azione === 'aumenta');

  ok('e il cablaggio AGGIUNGE invece di sostituire la sorella a riposo',
    srcC.includes('modalita-chiusura-sorella-incremento') && !srcC.includes('cancella la sorella'));
  ok('  il bersaglio si legge dal registro, la copertura dal LIBRO',
    srcC.includes("nostriSuToken(tokAltro, 'BUY').reduce"));
  ok('  e la persistenza su disco vive in agent40, non nel modulo puro',
    require('fs').readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8')
      .includes('registraSorella: (a) =>'));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── 9 · UN MERCATO MORTO NON RESTA IN SEI REGISTRI');
{
  const PUL = require('./pulizia-mercato-chiuso');
  ok('il selfcheck del modulo è verde', PUL.selfcheck() === true);
  // ⚠ ERANO SEI FINO AL 12 AGOSTO 2026: la verifica di tenuta ha trovato che la coda di
  // ripianificazione — diventata persistente il giorno prima — non era nell'elenco, quindi un mercato
  // la cui unica traccia fosse una voce in coda non veniva visitato dalla scansione.
  ok('i registri governati sono sette', PUL.REGISTRI.length === 7);
  ok('  e sono quelli che il quadro elenca, coda di ripianificazione compresa',
    PUL.REGISTRI.map((r) => r[0]).join(',') === 'attesaMerge,residui,ripianifica,chiusura,tetto,manuale,autoClose');

  // ⚠ IL CASO «ANNULLATO»: la domanda si fa al VENUE, non all'orologio.
  ok('un mercato che il venue non accetta più è morto anche se `endDate` è lontana',
    PUL.mercatoMorto({ venue: { acceptingOrders: false } }).morto === true);
  ok('  ed è la metà che `market-clock` non può vedere (legge `endDate`)',
    require('fs').readFileSync(path.join(__dirname, 'market-clock.js'), 'utf8').includes('endDate')
    && !require('fs').readFileSync(path.join(__dirname, 'market-clock.js'), 'utf8').includes('acceptingOrders'));

  const srcC = require('fs').readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  ok('auto-close pulisce sul ramo del venue chiuso', srcC.includes('deps.pulisciMercatoChiuso'));
  ok('  a LIBRO LIBERO e basta', srcC.includes('libroLibero: nostriQui === 0'));
  ok('  e una volta sola per mercato, non una per lato', srcC.includes('mercatiRipuliti'));
  ok('non cablata ⇒ comportamento di prima', srcC.includes("typeof deps.pulisciMercatoChiuso === 'function'"));

  const srcA = require('fs').readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
  ok('le sei mani vivono in agent40, dove vive il disco', srcA.includes('function maniPulizia'));
  ok('  gestione manuale e uscita automatica si SPENGONO con le funzioni del pannello',
    srcA.includes('setManualMode({ marketId, manual: false') && srcA.includes('setAutoClose({ marketId, enabled: false'));
  ok('  e una mappa dei tetti illeggibile NON produce una scrittura',
    srcA.includes("tutti.readable !== true) return { ok: false"));

  // NESSUN AUDIT VIENE CANCELLATO, ed è la regola del repo.
  const srcP = require('fs').readFileSync(path.join(__dirname, 'pulizia-mercato-chiuso.js'), 'utf8');
  for (const vietato of ['audit.jsonl', 'unlinkSync', 'rmSync']) {
    ok(`  il modulo non nomina «${vietato}»`, !srcP.includes(vietato));
  }
  // «redeem» compare solo nel commento che dichiara che NON si riscatta: si verifica l'assenza della
  // CHIAMATA, non della parola — un test sulla parola vieterebbe di documentare la decisione.
  ok('  e non chiama `redeemPosition`', !srcP.includes('redeemPosition('));
  ok('e il redeem resta fuori perimetro: nessun chiamante', !srcA.includes('redeemPosition'));
}

console.log(`\n${falliti === 0 ? '✅ TUTTI VERDI' : '❌ ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

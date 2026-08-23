'use strict';
// lib/maker/selezione-cablata.test.js — IL FILO fra la selezione e agent41.
//
// `selezione-mercati.test.js` prova che la DECISIONE e' giusta. Questo prova che il filo esiste, ed e'
// una distinzione che in questo repo e' gia' costata cara: §5-bis p.153 (il gradino 6 «non esisteva»
// perche' `impostaBot` non era importato) e le quattro occorrenze della classe «dep non cablata» di
// §5.3 sono tutte guasti in cui la funzione funzionava benissimo e nessuno la chiamava.
//
// Esegue con: node lib/maker/selezione-cablata.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
function ok(nome, cond, nota) {
  assert.ok(cond, nome + (nota ? ` — ${nota}` : ''));
  n += 1;
  console.log('  ok  ' + nome + (nota ? ' — ' + nota : ''));
}

const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
// I commenti si tolgono: un commento che RACCONTA la chiamata giusta ha gia' fatto passare un test
// che cercava la stringa nel sorgente (§5.3).
const codice = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n1 · il modulo e\' importato, e le funzioni sono chiamate');
{
  ok('agent41 importa la decisione pura', /require\('\.\.\/lib\/maker\/selezione-mercati'\)/.test(codice));
  ok('agent41 importa lo stato persistito', /require\('\.\.\/lib\/maker\/selezione-stato'\)/.test(codice));
  // La proprieta' vera: NESSUNA funzione della selezione viene usata senza essere importata. E' la
  // forma generale del guasto di §5-bis p.153, dove il `try` che avvolgeva il gradino catturava il
  // ReferenceError e lo restituiva come esito ordinario — quindi il bot dichiarava di essersi fermato
  // ed era ancora avviato.
  const usate = new Set((codice.match(/\bSELM\.(\w+)/g) || []).map((s) => s.slice(5)));
  const esportate = new Set(Object.keys(require('./selezione-mercati')));
  ok('ogni funzione di `selezione-mercati` usata da agent41 esiste davvero',
    [...usate].every((u) => esportate.has(u)), [...usate].join(', ') || 'nessuna');
  const usateS = new Set((codice.match(/\bSELS\.(\w+)/g) || []).map((s) => s.slice(5)));
  ok('ogni funzione di `selezione-stato` usata da agent41 esiste davvero',
    [...usateS].every((u) => Object.keys(require('./selezione-stato')).includes(u)), [...usateS].join(', ') || 'nessuna');
}

console.log('\n2 · la selezione gira PRIMA del piano, sui due percorsi');
{
  // Se girasse dopo, il piano di questo giro userebbe i mercati scelti al giro precedente: un mercato
  // scaduto verrebbe pianificato una volta di troppo, ogni volta.
  // ⚠ SI TAGLIA IL SORGENTE SENZA COMMENTI, e questa riga e' nata rossa per la ragione giusta: nel
  // corpo di `giro` c'e' un commento che NOMINA `runReallocCycle` sette righe PRIMA della chiamata
  // vera, quindi sul sorgente grezzo l'ordine risultava invertito. E' la trappola di §5.3 («i test
  // strutturali devono filtrare i commenti») presa in flagrante dal primo giro del test.
  const giro = codice.slice(codice.indexOf('async function giro('), codice.indexOf('function piazzaCoppia'));
  const iSel = giro.indexOf('await selezionaMercati()');
  const iCiclo = giro.indexOf('runReallocCycle');
  ok('nel ciclo da 6 h la selezione precede il ciclo di riallocazione', iSel > 0 && iCiclo > iSel);

  const ctrl = codice.slice(codice.indexOf('async function controlloCapitaleFermo'), codice.indexOf('function prossimoRitardo'));
  const jSel = ctrl.indexOf('await selezionaMercati()');
  const jMini = ctrl.indexOf('await miniCiclo(');
  ok('nel trigger a capitale fermo la selezione precede il mini-ciclo', jSel > 0 && jMini > jSel);
  // E deve girare anche quando il trigger NON scatta, o un mercato scaduto uscirebbe solo il giorno in
  // cui per caso avanza del capitale.
  ok('  e sta PRIMA di `decidiTrigger`, cosi\' gira anche nei giri in cui il trigger non scatta',
    jSel < ctrl.indexOf('TRIG.decidiTrigger'));
  // I due cancelli gratuiti restano davanti: a bot fermo o con il kill attivo non si tocca niente.
  ok('  ma DOPO i due cancelli gratuiti (bot avviato, kill spento)',
    ctrl.indexOf('!TRIGGER_ATTIVO || !botAttivo()') < jSel && ctrl.indexOf('if (killAttivo)') < jSel);
}

console.log('\n3 · la restrizione del piano puo\' solo STRINGERE');
{
  const A = require(path.join(ROOT, 'agents', 'agent41-realloc-scheduler.js'));
  const R = A.restringiAllaSelezione;
  ok('`restringiAllaSelezione` e\' esportata e chiamabile', typeof R === 'function');

  // Il punto di raccordo: `calcolaPianoFuoriProcesso` deve passare da lei, o le due strade che
  // calcolano un piano (ciclo 6h e mini-ciclo) non sarebbero ristrette entrambe.
  // ⚠ IL REGEX PRETENDEVA LA CHIAMATA NUDA, ED E' DIVENTATO ROSSO SU UN CAMBIO LEGITTIMO (23 agosto
  // 2026): `3ce2256` ha avvolto la restrizione in `conDistanzaDiPiano(restringiAllaSelezione(...))`
  // per dare al piano la distanza vera, e la proprieta' difesa — «il piano passa dalla restrizione» —
  // e' rimasta intatta mentre il test cadeva. E' la classe «test che fotografa il codice invece della
  // proprieta'» (§5.3, terza occorrenza). Adesso si ammette qualunque involucro attorno alla chiamata,
  // e cio' che si pretende resta che l'assegnazione di `opzioni` ci passi: togliere la restrizione lo
  // fa ancora fallire.
  ok('e `calcolaPianoFuoriProcesso` ci passa davvero',
    /function calcolaPianoFuoriProcesso\(opzioniGrezze\)\s*\{\s*const opzioni = [^;]*restringiAllaSelezione\(/.test(codice));

  const SELS = require('./selezione-stato');
  const stato = SELS.leggiStato();
  if (!stato.leggibile || stato.attiva !== true) {
    console.log('  --  selezione SPENTA su questa macchina: si verifica la proprieta\' che conta con lo switch spento');
    const opz = { capital: 100, onlyMarketIds: ['0xabc'] };
    ok('con la selezione spenta le opzioni passano INVARIATE',
      JSON.stringify(R(opz)) === JSON.stringify(opz),
      'una selezione spenta non deve poter cambiare nessun numero del piano');
  } else {
    // ⚠ SI CONTANO GLI ATTIVI, NON I SELEZIONATI — §5.2 p.61, chiusa il 23 agosto 2026.
    // `restringiAllaSelezione` usa `idsAttivi`, cioe' i selezionati NON `inGestione`, ed e' il
    // comportamento corretto e documentato (§4.13: «usa `idsAttivi` per il piano, ma la lista del
    // riprezzo tiene tutti gli id» — un mercato in gestione deve restare riprezzabile o la gamba
    // sorella muore per GTD in 23 min, prima dei 30 che la scala le concede). Contando TUTTI i
    // selezionati questo blocco era verde solo finche' nessun mercato era in gestione, e diventava
    // rosso al primo fill: il codice aveva ragione, il test no.
    const scelti = Object.entries(stato.stato.selezionati || {})
      .filter(([, v]) => !v || v.inGestione !== true).map(([k]) => k);
    const senzaVincolo = R({ capital: 100 });
    ok('con la selezione accesa il piano NON gira mai senza vincolo',
      Array.isArray(senzaVincolo.onlyMarketIds) && senzaVincolo.onlyMarketIds.length > 0);
    ok('  e il vincolo e\' esattamente l\'insieme scelto',
      senzaVincolo.onlyMarketIds.length === (scelti.length || 1));

    // LA PROPRIETA' CHE CONTA: intersezione, mai sostituzione. Un `onlyMarketIds` gia' presente ha un
    // significato suo (il piano ristretto ai mercati in gestione) e sovrascriverlo lo cancellerebbe.
    const estraneo = '0x' + '7'.repeat(64);
    const con = R({ capital: 100, onlyMarketIds: [estraneo] });
    ok('un mercato NON scelto non entra nel piano nemmeno se il chiamante lo chiede',
      !con.onlyMarketIds.includes(estraneo));
    if (scelti.length) {
      const uno = R({ capital: 100, onlyMarketIds: [scelti[0], estraneo] });
      ok('  e l\'intersezione tiene quello che sta in ENTRAMBI',
        uno.onlyMarketIds.length === 1 && uno.onlyMarketIds[0] === scelti[0]);
    }
    // ⚠ Il caso che conta di piu': intersezione VUOTA. La risposta giusta e' «nessuna riga», non
    // «nessun vincolo» — che sarebbe il modo in cui un filtro di sicurezza diventa il suo contrario.
    const vuota = R({ capital: 100, onlyMarketIds: [estraneo] });
    ok('intersezione vuota ⇒ vincolo IMPOSSIBILE, mai vincolo assente',
      Array.isArray(vuota.onlyMarketIds) && vuota.onlyMarketIds.length === 1
      && !scelti.includes(vuota.onlyMarketIds[0]),
      'un piano senza vincolo girerebbe su TUTTO il board');
  }
}

console.log('\n4 · il rilascio non puo\' togliere la via d\'uscita');
{
  // Anche qui SENZA commenti: il commento della funzione dichiara «non tocca `setAutoClose`», e un
  // test che leggesse il testo grezzo verrebbe ingannato dalla frase che descrive la garanzia.
  const rilascio = codice.slice(codice.indexOf('async function rilasciaDallaSelezione'), codice.indexOf('function selezioneAttiva'));
  ok('il rilascio esiste ed e\' una funzione a se\'', rilascio.length > 0);
  ok('  spegne il riprezzo…', /setAutoReprice\(/.test(rilascio) && /enabled: false/.test(rilascio));
  ok('  …e NIENTE altro: non l\'uscita automatica, non il tracking, non le cancellazioni',
    !/setAutoClose\(/.test(rilascio) && !/setTracking\(/.test(rilascio) && !/cancelManualOrder\(/.test(rilascio),
    'un mercato rilasciato deve restare chiudibile: §5-bis p.44');
}

console.log('\n5 · la selezione non puo\' piazzare');
{
  // Stessa forma della prova di perimetro dell'osservatore e di `stato.js`: si cammina l'albero dei
  // `require` del modulo puro e si verifica che nessuna superficie che sappia agire sul venue sia
  // raggiungibile. Qui e' facile — il modulo non importa NIENTE — ed e' proprio la proprieta' da
  // inchiodare, perche' il giorno in cui importasse qualcosa nessuno se ne accorgerebbe.
  const testo = fs.readFileSync(path.join(__dirname, 'selezione-mercati.js'), 'utf8');
  const req = (testo.replace(/^\s*\/\/.*$/gm, '').match(/require\(['"][^'"]+['"]\)/g) || []);
  ok('`selezione-mercati.js` non importa NIENTE: e\' puro per costruzione', req.length === 0, req.join(', ') || 'zero require');

  const st = fs.readFileSync(path.join(__dirname, 'selezione-stato.js'), 'utf8');
  const reqSt = (st.replace(/^\s*\/\/.*$/gm, '').match(/require\('([^']+)'\)/g) || []).map((s) => s.slice(9, -2));
  ok('`selezione-stato.js` importa solo fs, path, lo store e il modulo puro',
    reqSt.every((r) => ['fs', 'path', '../safety/store', './selezione-mercati'].includes(r)), reqSt.join(', '));
}

console.log('\nselezione-cablata: ' + n + ' passed, 0 failed');

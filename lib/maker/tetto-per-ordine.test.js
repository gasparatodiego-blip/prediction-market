#!/usr/bin/env node
'use strict';
// lib/maker/tetto-per-ordine.test.js — IL GATE `manual-order-cap` HA LA SOGLIA GIUSTA, E RESTA UN GATE.
//
// ═══ IL GUASTO CHE QUESTO FILE DIFENDE ═══════════════════════════════════════════════════════════════
// Il 9 agosto 2026, con il bot su AVVIA e $561,37 liberi, OGNI gamba veniva rifiutata:
//
//     gate: manual-order-cap — controvalore $99.14 oltre il tetto per ordine $25.00
//       (il più stretto fra safety-risk-limits $1000 e il cap live-min dell'adapter $25)
//
// Il tetto per MERCATO era stato portato a $130 fissi (~$65 per lato) ma il tetto per ORDINE era rimasto
// a $25, in DUE costanti indipendenti che nessuno aveva collegato. Utilizzo del capitale al 16,4%
// contro un obiettivo del 90%, e zero ordini piazzati in due mini-cicli di fila.
//
// ═══ COSA SI PROVA QUI ═══════════════════════════════════════════════════════════════════════════════
//   1 · il numero è UNO e derivato: un futuro cambio del tetto per mercato lo muove da sé;
//   2 · una gamba come quelle rifiutate quel giorno ($60-65) ora PASSA;
//   3 · una gamba davvero oltre il tetto ($71+) resta RIFIUTATA — non stiamo togliendo la cintura;
//   4 · il gate resta il PIÙ STRETTO fra sé e il limite di safety, che non è stato toccato.
//
// NESSUN ORDINE REALE: si esercita `resolveCaps`/`evaluateManualGate`, che sono pure e non toccano rete.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../rewards/concentration');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

console.log('\n══ 1 · IL NUMERO È UNO SOLO, E DERIVATO');
{
  // ⚠ LA DERIVAZIONE È CAMBIATA IL 15 AGOSTO 2026, e questo blocco la segue. Era «metà del tetto per
  // mercato più il margine» — che è la gamba giusta SOLO a mid 0,49, perché le due gambe costano
  // `Q·p_yes` e `Q·p_no` e si dividono a metà solo lì. Adesso è «la gamba più cara che una coppia già
  // limitata dal tetto PER MERCATO può produrre», cioè `tetto × p_max / costoCoppia + margine`.
  ok(`il tetto per ordine vale $${C.LIVE_MIN_ORDER_CAP_USD}, DERIVATO dal tetto per mercato`,
    Math.abs(C.LIVE_MIN_ORDER_CAP_USD
      - (C.MARKET_CAP_FIXED_USD * C.PREZZO_MASSIMO_QUOTABILE / C.COSTO_COPPIA + C.MARGINE_ORDINE_USD)) < 0.01);
  ok('  ed è la gamba più cara che il tetto per mercato consente, più il margine dichiarato',
    C.LIVE_MIN_ORDER_CAP_USD >= C.MARKET_CAP_FIXED_USD * C.PREZZO_MASSIMO_QUOTABILE / C.COSTO_COPPIA,
    `${C.MARKET_CAP_FIXED_USD} × ${C.PREZZO_MASSIMO_QUOTABILE} / ${C.COSTO_COPPIA} + ${C.MARGINE_ORDINE_USD}`);
  ok('  e il tetto per MERCATO non si è mosso: l\'esposizione massima su un mercato è quella di prima',
    C.MARKET_CAP_FIXED_USD === C.pavimentoPremiante(C.SCAGLIONE_FINANZIABILE), `$${C.MARKET_CAP_FIXED_USD}`);

  const ad = fs.readFileSync(path.join(__dirname, '..', 'venues', 'polymarket-clob-maker', 'adapter.js'), 'utf8');
  const mo = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  ok('l\'adapter NON dichiara più un 25 suo', !/LIVE_MIN_DEFAULT_CAP_USD\s*=\s*25/.test(ad));
  ok('manual-order NON dichiara più un 25 suo', !/FALLBACK_LIVE_MIN_CAP_USD\s*=\s*25/.test(mo));

  // ⚠ QUI C'ERANO DUE ASSERZIONI SULLA FORMA ESATTA DEL `require`, ED ERANO TRAPPOLE (§5.3).
  // Cercavano `LIVE_MIN_ORDER_CAP_USD }` con la graffa attaccata: il 16 agosto l'import di
  // `manual-order` ha guadagnato un secondo nome (`, MARKET_CAP_FIXED_USD }`) — stessa fonte, stesso
  // valore, nessun difetto — e il test e' diventato rosso. Si romperebbero a ogni refactor.
  //
  // La coincidenza dei valori la prova gia' l'asserzione qui sotto, ma da sola non basta: due numeri
  // uguali possono essere due copie. QUESTA prova la DIREZIONE — che il valore ARRIVI da
  // `concentration` — sostituendo il modulo in `require.cache` con uno che espone una sentinella e
  // ricaricando i due consumatori da zero. Se leggono la sentinella, l'import e' reale.
  const SENTINELLA = 4321.8765;
  const viaConc = require.resolve('../rewards/concentration');
  const viaAd = require.resolve('../venues/polymarket-clob-maker/adapter');
  const viaMo = require.resolve('./manual-order');
  const salva = [viaConc, viaAd, viaMo].map((v) => [v, require.cache[v]]);
  let letti = null;
  try {
    const vero = require('../rewards/concentration');
    delete require.cache[viaAd]; delete require.cache[viaMo];
    require.cache[viaConc] = { id: viaConc, filename: viaConc, loaded: true,
      exports: { ...vero, LIVE_MIN_ORDER_CAP_USD: SENTINELLA } };
    letti = {
      adapter: require('../venues/polymarket-clob-maker/adapter').LIVE_MIN_DEFAULT_CAP_USD,
      manualOrder: require('./manual-order').FALLBACK_LIVE_MIN_CAP_USD,
    };
  } finally {
    // Si ripristina la cache: un test che la lascia sporca avvelena tutti quelli che vengono dopo.
    for (const [v, m] of salva) { if (m) require.cache[v] = m; else delete require.cache[v]; }
  }
  ok('  e il tetto ARRIVA da concentration nell\'adapter (provato, non letto nel sorgente)',
    letti && letti.adapter === SENTINELLA, `letto ${letti && letti.adapter}`);
  ok('  e in manual-order, dalla stessa fonte',
    letti && letti.manualOrder === SENTINELLA, `letto ${letti && letti.manualOrder}`);
  ok('e i due valori a runtime COINCIDONO, per costruzione', (() => {
    const A = require('../venues/polymarket-clob-maker/adapter').LIVE_MIN_DEFAULT_CAP_USD;
    const M = require('./manual-order').FALLBACK_LIVE_MIN_CAP_USD;
    return A === M && A === C.LIVE_MIN_ORDER_CAP_USD;
  })());
}

console.log('\n══ 2 · LE GAMBE VERE DEL 9 AGOSTO: PRIMA RIFIUTATE, ORA AMMESSE');
{
  // Il gate: `notionalUsd > effectiveOrderCapUsd` ⇒ rifiuto. `effectiveOrderCapUsd` è il min fra il
  // limite di safety ($1000, invariato) e il tetto per ordine. Si riproduce QUELL'aritmetica, con i
  // controvalori esatti letti dal referto del mini-ciclo delle 20:37.
  const SAFETY = 1000;
  const effettivo = Math.min(SAFETY, C.LIVE_MIN_ORDER_CAP_USD);
  const passa = (n) => !(n > effettivo + 1e-9);

  ok(`il tetto effettivo è $${effettivo} (min fra safety $${SAFETY} e per-ordine $${C.LIVE_MIN_ORDER_CAP_USD})`,
    effettivo === C.LIVE_MIN_ORDER_CAP_USD);
  ok('  ed è il PIÙ STRETTO dei due: il limite di safety non è stato toccato', effettivo < SAFETY);

  // Le gambe che il piano propone davvero: metà del tetto per mercato, cioè ~$32,50 a mid 0,50. I
  // valori si DERIVANO dal tetto invece di essere scritti a mano — così il banco non va ritarato al
  // prossimo cambio e continua a dire la stessa cosa: la gamba normale passa, quella cara no.
  const gambaTipica = C.MARKET_CAP_FIXED_USD / 2;
  for (const n of [gambaTipica * 0.9, gambaTipica, gambaTipica * 1.05, effettivo - 0.01]) {
    ok(`  gamba da $${n.toFixed(2)} ⇒ AMMESSA`, passa(n));
  }
  ok(`  e $${effettivo.toFixed(2)} esatti passa: il confine è inclusivo`, passa(effettivo));

  // Le quattro davvero rifiutate il 9 agosto restano tali — erano il LATO CARO di una coppia
  // sbilanciata ($99-114), e col tetto dimezzato lo sono a maggior ragione.
  for (const n of [effettivo + 0.01, effettivo * 1.1, 99.14, 113.83]) {
    ok(`  gamba da $${n.toFixed(2)} ⇒ ancora RIFIUTATA`, !passa(n));
  }
}

console.log('\n══ 2-bis · ⚠ IL TETTO PER ORDINE NON BASTA SUI MERCATI SBILANCIATI, E VA DETTO');
{
  // ═══ IL FATTO, MISURATO SULLE GAMBE VERE DEL MINI-CICLO DELLE 20:37 ══════════════════════════════
  // Il modello di size e' `coppia-in-collaterale`: si comprano le STESSE share su entrambi i lati,
  // quindi il costo in DOLLARI di una gamba e' proporzionale al suo PREZZO. Su un mercato con mid 0,16
  // le due gambe costano $19,58 e $100,37 — non $65 e $65. La somma resta il tetto per mercato ($120
  // allocati), ma la ripartizione fra i due lati NON e' meta' e meta': lo e' solo quando il mid e' 0,50.
  //
  // Conseguenza: un tetto per ORDINE di $70 lascia passare entrambe le gambe solo quando entrambi i
  // prezzi stanno sotto ~0,57, cioe' quando il mid sta grosso modo in [0,43 · 0,57]. Fuori da li' la
  // gamba cara sfonda comunque, e siccome una coppia si piazza solo se passano ENTRAMBE, il mercato
  // resta bloccato per intero.
  // Il capitale per mercato si prende dal TETTO, non da una costante copiata: era 120 quando il tetto
  // era 130, e una copia diverge al primo cambio. La proprietà che il banco difende — «la finestra di
  // mid ammessa è stretta, e fuori da lì il mercato resta bloccato per intero» — non dipende dal numero.
  const CAPITALE_MERCATO = C.MARKET_CAP_FIXED_USD;
  const PAIR = 0.98;                  // costo della coppia tipico
  const share = CAPITALE_MERCATO / PAIR;
  const gambaCosta = (prezzo) => prezzo * share;
  const passaCoppia = (mid) => gambaCosta(mid) <= C.LIVE_MIN_ORDER_CAP_USD + 1e-9
    && gambaCosta(1 - mid) <= C.LIVE_MIN_ORDER_CAP_USD + 1e-9;

  // ⚠ QUESTO BLOCCO DOCUMENTAVA UN DIFETTO, E DAL 15 AGOSTO 2026 DOCUMENTA LA SUA CORREZIONE.
  // Diceva: «mid 0,16 ⇒ la gamba cara sfonda ANCORA», e ne prendeva atto. Sfondare voleva dire che il
  // precontrollo atomico di §5 p.115 abbandonava la COPPIA INTERA (`coppia-non-atomica`) — la prima
  // causa misurata di gambe perse, 84 gambe per $1.276,13 in 24 ore (§5 p.129-130). Il tetto per
  // ordine adesso copre la gamba più cara per costruzione, quindi la finestra di mid non è più un
  // cancello e queste asserzioni provano che NESSUN mid quotabile viene più bloccato dal tetto.
  ok('mid 0,50 (coppia simmetrica) ⇒ entrambe le gambe passano', passaCoppia(0.50),
    `$${gambaCosta(0.5).toFixed(2)} per lato`);
  ok('mid 0,48 (Ankara) ⇒ passa', passaCoppia(0.48));
  ok('mid 0,54 (Istanbul) ⇒ passa', passaCoppia(0.54));
  ok('mid 0,16 (Jay Schroeder) ⇒ ADESSO PASSA: la gamba cara non sfonda più', passaCoppia(0.16),
    `$${gambaCosta(0.84).toFixed(2)} sul lato NO contro un tetto di $${C.LIVE_MIN_ORDER_CAP_USD}`);
  ok('mid 0,05 (David Crowley) ⇒ idem', passaCoppia(0.05), `$${gambaCosta(0.95).toFixed(2)} sul lato NO`);

  // LA PROPRIETÀ, non i casi: nessun mid dentro i limiti di `end-of-scale` produce una gamba oltre il
  // tetto per ordine. È l'unica formulazione che non invecchia quando le costanti si muovono.
  let sfondano = 0; let provati = 0;
  for (let mid = 0.03; mid <= 0.97001; mid += 0.005) {
    provati += 1;
    if (!passaCoppia(+mid.toFixed(3))) sfondano += 1;
  }
  ok(`su ${provati} mid dentro [0,03 · 0,97]: ZERO coppie bloccate dal tetto per ordine`, sfondano === 0,
    `${sfondano} sfondano`);

  // E la finestra dichiarata dal modulo deve dire la stessa cosa: se divergesse, il piano continuerebbe
  // a scartare mercati che il gate accetta (o il contrario), che è la classe D1.
  const attesa = C.finestraMid(C.CAPITALE_RIFERIMENTO_USD);
  ok(`  la finestra di mid dichiarata è [${attesa.lo} · ${attesa.hi}], cioè non è più un cancello`,
    attesa.hi >= 0.97 && attesa.lo <= 0.03,
    `tetto ordine $${attesa.tettoOrdineUsd} su tetto mercato $${attesa.tettoUsd}`);
  ok('  e il tetto per ordine resta un LIMITE VERO: sotto il tetto di safety, che non è esentabile',
    C.LIVE_MIN_ORDER_CAP_USD < 1000);
}

console.log('\n══ 3 · IL GATE È ANCORA UN GATE, E LA PROTEZIONE NON È STATA TOLTA');
{
  const mo = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  ok('il gate `manual-order-cap` esiste ancora e rifiuta', /gate: 'manual-order-cap'/.test(mo));
  ok('  ed è ancora il MINIMO fra i due limiti, non il massimo',
    /Math\.min\(L\.maxOrderNotionalUsd, liveMinCapUsd\)/.test(mo));
  ok('  un cap non leggibile continua a rifiutare tutto (missing ≠ unlimited)',
    /caps null ⇒ every order refused downstream \(missing ≠ unlimited\)/.test(mo));

  const ad = fs.readFileSync(path.join(__dirname, '..', 'venues', 'polymarket-clob-maker', 'adapter.js'), 'utf8');
  ok('e l\'adapter conserva la SUA cintura indipendente in live-min',
    /mode === 'live-min' && notionalUsd > liveMinCapUsd/.test(ad));
  ok('  con il rifiuto a verbale', /outcome: 'reject-cap'/.test(ad));
}

console.log('\n══ 4 · IL RITIRO DELLA GAMBA ORFANA NON È STATO SFIORATO');
{
  // La protezione che ha funzionato il 9 agosto: se una gamba della coppia viene rifiutata, quella già
  // inviata viene RITIRATA invece di restare esposta a un lato solo. Vive in bulk-allocate, non qui, e
  // questo lavoro non l'ha toccata — ma va verificato, perché è ciò che ha impedito il danno.
  const ba = fs.readFileSync(path.join(__dirname, 'bulk-allocate.js'), 'utf8');
  ok('il rollback della gamba orfana esiste ancora', /rolled-back|rollback/i.test(ba));
  // ⚠ QUI C'ERA UN'ASSERZIONE SU `git diff --name-only HEAD`, ed è stata TOLTA il 12 agosto 2026.
  // Non difendeva una proprietà: fotografava il working tree. Verde durante la lavorazione, rossa un
  // minuto dopo il commit, e rossa di nuovo appena qualcuno tocca il file per una ragione LEGITTIMA —
  // che è esattamente quello che è successo, col precontrollo della coppia. È la stessa trappola già
  // registrata in §5 punto 71, ripetuta qui.
  // Al suo posto la proprietà che quell'asserzione voleva davvero: bulk-allocate non deve avere un
  // tetto per ordine SUO. Che il file cambi non è un difetto; che ne ridichiari uno lo è.
  ok('  e bulk-allocate non ridichiara un tetto per ordine proprio', (() => {
    const vive = ba.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
    return !/const\s+\w*ORDER_CAP\w*\s*=/.test(vive) && !/effectiveOrderCapUsd\s*=\s*\d/.test(vive);
  })());
  ok('  e quando lo valuta usa la funzione condivisa del gate', /evaluateManualCapGate/.test(ba));
  // ⚠ QUI C'ERA UN'ASSERZIONE SU `git diff --name-only HEAD`, cioè una fotografia del working tree:
  // verde durante la lavorazione e rossa un minuto dopo il commit, senza che nessun difetto esista.
  // È la classe di §5.3 «test che fotografa il codice invece della proprietà», e questa è la sesta
  // occorrenza — trovata perché la correzione della banda ha toccato plan-to-orders e il test è
  // diventato rosso pur essendo il codice corretto. Al suo posto la proprietà VERA: chi costruisce le
  // due gambe non deve avere un tetto per ordine proprio, deve usare quello condiviso.
  ok('  né la costruzione delle due gambe in plan-to-orders ridichiara un tetto', (() => {
    const pto = fs.readFileSync(path.join(__dirname, '..', 'rewards', 'plan-to-orders.js'), 'utf8');
    const vive = pto.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
    return !/const\s+\w*ORDER_CAP\w*\s*=/.test(vive) && !/(orderCapUsd|tettoOrdineUsd)\s*=\s*[\d.]/.test(vive);
  })());
}

console.log(`\ntetto per ordine: ${pass} passati, ${fail} falliti\n`);
assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);

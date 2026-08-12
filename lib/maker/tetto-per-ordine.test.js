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
  ok(`il tetto per ordine vale $${C.LIVE_MIN_ORDER_CAP_USD}, DERIVATO dal tetto per mercato`,
    Math.abs(C.LIVE_MIN_ORDER_CAP_USD - (C.MARKET_CAP_FIXED_USD / 2 + C.MARGINE_ORDINE_USD)) < 0.01);
  ok('  ed è metà del tetto per mercato più il margine dichiarato',
    C.LIVE_MIN_ORDER_CAP_USD === C.MARKET_CAP_FIXED_USD / 2 + C.MARGINE_ORDINE_USD,
    `${C.MARKET_CAP_FIXED_USD}/2 + ${C.MARGINE_ORDINE_USD}`);

  const ad = fs.readFileSync(path.join(__dirname, '..', 'venues', 'polymarket-clob-maker', 'adapter.js'), 'utf8');
  const mo = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  ok('l\'adapter NON dichiara più un 25 suo', !/LIVE_MIN_DEFAULT_CAP_USD\s*=\s*25/.test(ad));
  ok('  lo importa dal modulo condiviso', /LIVE_MIN_ORDER_CAP_USD\s*\}\s*=\s*require\(['"]\.\.\/\.\.\/rewards\/concentration['"]\)/.test(ad));
  ok('manual-order NON dichiara più un 25 suo', !/FALLBACK_LIVE_MIN_CAP_USD\s*=\s*25/.test(mo));
  ok('  lo importa dallo stesso modulo', /LIVE_MIN_ORDER_CAP_USD\s*\}\s*=\s*require\(['"]\.\.\/rewards\/concentration['"]\)/.test(mo));
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

  ok('mid 0,50 (coppia simmetrica) ⇒ entrambe le gambe passano', passaCoppia(0.50),
    `$${gambaCosta(0.5).toFixed(2)} per lato`);
  ok('mid 0,48 (Ankara, rifiutato oggi) ⇒ ora passa', passaCoppia(0.48));
  ok('mid 0,54 (Istanbul, rifiutato oggi) ⇒ ora passa', passaCoppia(0.54));
  ok('mid 0,16 (Jay Schroeder) ⇒ la gamba cara sfonda ANCORA', !passaCoppia(0.16),
    `$${gambaCosta(0.84).toFixed(2)} sul lato NO`);
  ok('mid 0,05 (David Crowley) ⇒ idem', !passaCoppia(0.05), `$${gambaCosta(0.95).toFixed(2)} sul lato NO`);

  // Il confine, calcolato e non stimato: fin dove arriva il tetto per ordine.
  const midMax = C.LIVE_MIN_ORDER_CAP_USD / share;
  // ⚠ LA FINESTRA SI E' ALLARGATA il 12 agosto 2026, ed e' un effetto VOLUTO del tetto derivato: il
  // tetto per ordine scende con quello per mercato, quindi la gamba cara sfonda piu' tardi. Era
  // [0,435 · 0,565] con $65 fissi. L'asserzione difende ora che la finestra sia COERENTE col tetto in
  // vigore — calcolata dal modulo, non ricopiata — invece di un intervallo che si muove per progetto.
  const attesa = C.finestraMid(C.CAPITALE_RIFERIMENTO_USD);
  ok(`  la finestra di mid ammessa e' [${(1 - midMax).toFixed(3)} · ${midMax.toFixed(3)}]`,
    Math.abs(midMax - attesa.hi) < 0.01 && midMax > 0.5,
    `mid max ${midMax.toFixed(4)} contro finestraMid ${attesa.hi}`);

  // E il valore che invece basterebbe SEMPRE: il tetto per MERCATO, perche' nel caso limite una gamba
  // sola porta quasi tutto. Non e' stato adottato — e' una decisione sul perimetro di rischio, non
  // implementata qui — ma il numero va scritto perche' chi decide lo abbia davanti.
  // «~=» e non «<=»: la gamba estrema vale `cap/pairCost x 0,99`, cioe' l'1% SOPRA il tetto per mercato,
  // perche' la coppia costa meno di $1. Il numero da tenere e' l'ordine di grandezza — servirebbe un
  // tetto per ordine grande quanto quello per mercato — non una disuguaglianza al centesimo.
  ok('  per ammettere QUALUNQUE mid servirebbe un tetto per ordine ~= al tetto per mercato',
    gambaCosta(0.99) <= C.MARKET_CAP_FIXED_USD * 1.05 && gambaCosta(0.99) > C.LIVE_MIN_ORDER_CAP_USD,
    `gamba estrema $${gambaCosta(0.99).toFixed(2)} contro tetto mercato $${C.MARKET_CAP_FIXED_USD}`);
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
  ok('  né la costruzione delle due gambe in plan-to-orders', (() => {
    const { execSync } = require('child_process');
    const out = execSync('git -C ' + path.join(__dirname, '..', '..') + ' diff --name-only HEAD', { encoding: 'utf8' });
    return !/plan-to-orders\.js/.test(out);
  })());
}

console.log(`\ntetto per ordine: ${pass} passati, ${fail} falliti\n`);
assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);

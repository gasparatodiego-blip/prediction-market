#!/usr/bin/env node
'use strict';
// MAI PRIMI SUL LIBRO — la regola collegata ai tre percorsi che piazzano davvero.

const { prezzoInCoda } = require('./prezzo-in-coda');
const fs = require('fs'); const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const rules = (over = {}) => ({ readable: true, tick: 0.01, maxSpreadCents: 4.5,
  books: { yes: { scoringMid: 0.50 }, no: { scoringMid: 0.50 } }, ...over });
const depth = (bids, asks) => ({ readable: true, yes: { bids, asks }, no: { bids, asks } });

console.log('\n══ ACQUISTO: UN TICK DIETRO IL MIGLIOR BID ALTRUI');
{
  const q = prezzoInCoda({ book: 'yes', side: 'BUY', rules: rules(), depth: depth([{ price: 0.49, size: 100 }], []) });
  ok('si posa un tick dietro', q.ok && q.price === 0.48, `${q.price} · ${q.mode}`);
  ok('  e non siamo in cima', q.onTop === false && q.bestOther === 0.49);
}

console.log('\n══ VENDITA: UN TICK DIETRO IL MIGLIOR ASK ALTRUI (piu in ALTO)');
{
  const q = prezzoInCoda({ book: 'yes', side: 'SELL', rules: rules(), depth: depth([], [{ price: 0.51, size: 100 }]) });
  ok('si posa un tick SOPRA il miglior ask', q.ok && q.price === 0.52, `${q.price} · ${q.mode}`);
  ok('  e non siamo in cima', q.onTop === false && q.bestOther === 0.51);
  ok('  usando la STESSA aritmetica del bid, specchiata (nessuna seconda funzione)',
    !/planBehindAsk|bestOtherAsk/.test(fs.readFileSync(path.join(__dirname, 'prezzo-in-coda.js'), 'utf8')));
}

console.log('\n══ I NOSTRI ORDINI NON CONTANO COME «ALTRUI»');
{
  const q = prezzoInCoda({ book: 'yes', side: 'BUY', rules: rules(),
    depth: depth([{ price: 0.49, size: 100 }, { price: 0.48, size: 50 }], []),
    ownOrders: [{ price: 0.49, size: 100 }] });
  ok('il livello interamente nostro sparisce', q.ok && q.bestOther === 0.48, `bestOther ${q.bestOther}`);
  // 0.48 − 1 tick = 0.47, ma il bordo premiante (mid 0.50, raggio 2.25¢) e' 0.4775: la banda aggancia.
  ok('  quindi ci si posa dietro al primo VERO altro, entro la banda', q.price === 0.48 && q.mode === 'band-clamped', `${q.price} · ${q.mode}`);
}

console.log('\n══ IL CONFLITTO CON LA BANDA: VINCE LA BANDA');
{
  // Banda 3¢ ⇒ raggio 1.5¢ ⇒ bordo basso 0.485. Un tick dietro a 0.49 sarebbe 0.48: fuori.
  const q = prezzoInCoda({ book: 'yes', side: 'BUY', rules: rules({ maxSpreadCents: 3 }),
    depth: depth([{ price: 0.49, size: 100 }], []) });
  ok('il prezzo viene agganciato al bordo premiante', q.ok && q.mode === 'band-clamped', `${q.price} · ${q.mode}`);
  ok('  restiamo dentro banda anche a costo di essere primi', q.onTop === true);
  ok('  e il conflitto e dichiarato', /fuori banda/.test(q.reason) && /IN CIMA al book/.test(q.reason));
}

console.log('\n══ SENZA DATI NON SI INVENTA UN PREZZO');
{
  ok('feed senza livelli ⇒ non risponde',
    prezzoInCoda({ book: 'yes', side: 'BUY', rules: rules(), depth: null }).ok === false);
  ok('banda non leggibile ⇒ non risponde',
    prezzoInCoda({ book: 'yes', side: 'BUY', rules: rules({ maxSpreadCents: null }), depth: depth([{ price: 0.49, size: 1 }], []) }).ok === false);
  ok('regole non leggibili ⇒ non risponde',
    prezzoInCoda({ book: 'yes', side: 'BUY', rules: { readable: false }, depth: depth([], []) }).ok === false);
  ok('soli sul lato ⇒ ripiego sull offset dichiarato, non un prezzo a caso',
    prezzoInCoda({ book: 'yes', side: 'BUY', rules: rules(), depth: depth([], []), offsetCents: 1 }).mode === 'fallback-alone');
}

console.log('\n══ I TRE PERCORSI LO DICHIARANO, LA CHIUSURA FORZATA NO');
{
  const pto = fs.readFileSync(path.join(__dirname, '..', 'rewards', 'plan-to-orders.js'), 'utf8');
  const bulk = fs.readFileSync(path.join(__dirname, 'bulk-allocate.js'), 'utf8');
  const rep = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8');
  const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  const mo = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  ok('1 · le due gambe lo dichiarano', /inCoda: true,/.test(pto));
  ok('  e bulk-allocate lo trasporta', /inCoda: r\.inCoda === true/.test(bulk));
  ok('2 · il riprezzo lo dichiara', /inCoda: trigger !== 'expiry-refresh'/.test(rep));
  ok('  ma NON il rinnovo proattivo (ri-piazza allo stesso prezzo per azzerare l orologio)', /expiry-refresh/.test(rep));
  ok('  ed esclude i nostri ordini per non inseguirci da soli', /ownOrders: owned\.filter/.test(rep));
  ok('3 · l uscita maker lo dichiara', /inCoda: true,/.test(ac));
  ok('  la chiusura FORZATA no: attraversa apposta', /attraversaApposta: true/.test(ac));
  ok('  e le due sono righe distinte', (ac.match(/inCoda: true/g) || []).length === 1 && (ac.match(/attraversaApposta: true/g) || []).length === 1);
  ok('placeManualOrder lo applica solo se dichiarato', /if \(spec\.inCoda === true\)/.test(mo));
  ok('  e lo spostamento viaggia in priceAdjusted, mai silenzioso', /priceAdjusted = \{ \.\.\.\(priceAdjusted \|\| \{\}\), inCoda:/.test(mo));
}

console.log(`\nprezzo in coda: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

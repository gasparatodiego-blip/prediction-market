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
  // Il livello a 0.49 e' INTERAMENTE nostro: tolto, il primo altro e' 0.48. Lo si verifica sul campo
  // `bestOther`, che viaggia anche quando il piano rifiuta — altrimenti non si potrebbe distinguere
  // «non ho visto nessuno» da «ho visto qualcuno e ho deciso di non quotare».
  ok('il livello interamente nostro sparisce', q.bestOther === 0.48, `bestOther ${q.bestOther}`);
  // 0.48 − 1 tick = 0.47, e il bordo premiante (mid 0.50, raggio 2.25¢) e' 0.4775: un tick dietro
  // cade FUORI. Con la priorita' invertita del 5 agosto 2026 non si aggancia piu al bordo: si rinuncia.
  ok('  e un tick dietro uscirebbe dalla banda ⇒ non si quota',
    q.ok === false && q.quotabile === false && q.mode === 'behind-best-fuori-banda', `${q.price} · ${q.mode}`);
}

console.log('\n══ IL CONFLITTO CON LA BANDA: VINCE «MAI PRIMI» (invertito il 5 agosto 2026)');
{
  // Questo blocco pretendeva l'opposto: aggancio al bordo, `onTop:true`, «restiamo dentro banda anche
  // a costo di essere primi». La decisione e' cambiata: si rinuncia al mercato invece di prendere la
  // posizione peggiore del libro.
  // Banda 3¢ ⇒ raggio 1.5¢ ⇒ bordo basso 0.485. Un tick dietro a 0.49 sarebbe 0.48: fuori.
  const q = prezzoInCoda({ book: 'yes', side: 'BUY', rules: rules({ maxSpreadCents: 3 }),
    depth: depth([{ price: 0.49, size: 100 }], []) });
  ok('NON si quota affatto', q.ok === false && q.price === null, `${q.price} · ${q.mode}`);
  ok('  ed e una decisione, non un dato mancante', q.quotabile === false);
  ok('  col suo nome', q.mode === 'behind-best-fuori-banda');
  ok('  e il motivo dichiarato', /fuori dalla banda premiante/.test(q.reason) && /non si quota/.test(q.reason));
  ok('  senza agganciarsi al bordo', !/IN CIMA al book/.test(q.reason));
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
  // Stessa ragione dell'asserzione gemella in mai-primo-sul-libro.test.js: l'insieme ora si chiama
  // `nostriSulLato` ed e' passato a entrambi i rami del ciclo.
  ok('  ed esclude i nostri ordini per non inseguirci da soli', /ownOrders: nostriSulLato/.test(rep));
  // E il pannello, che non li riceveva da nessuno, adesso se li legge da solo (Fase 7).
  ok('  e il pannello manuale li legge da se quando nessuno glieli passa', /resolveOwnOrders/.test(mo));
  ok('3 · l uscita maker lo dichiara', /inCoda: true,/.test(ac));
  ok('  la chiusura FORZATA no: attraversa apposta', /attraversaApposta: true/.test(ac));
  ok('  e le due sono righe distinte', (ac.match(/inCoda: true/g) || []).length === 1 && (ac.match(/attraversaApposta: true/g) || []).length === 1);
  ok('placeManualOrder lo applica solo se dichiarato', /if \(spec\.inCoda === true\)/.test(mo));
  ok('  e lo spostamento viaggia in priceAdjusted, mai silenzioso',
    /priceAdjusted = \{[\s\S]{0,120}\.\.\.\(priceAdjusted \|\| \{\}\),[\s\S]{0,40}inCoda:/.test(mo));
  // E da quando esiste la protezione di profondità, l'arretramento viaggia con i suoi numeri: il
  // minimo, il prezzo finale, quanto c'era davanti, la soglia, e chi ha fermato la camminata.
  ok('  con i numeri dell arretramento per profondità quando si applica',
    /depth: \{[\s\S]{0,400}minPrice[\s\S]{0,400}depthAhead[\s\S]{0,400}stoppedBy/.test(mo));
}

console.log(`\nprezzo in coda: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

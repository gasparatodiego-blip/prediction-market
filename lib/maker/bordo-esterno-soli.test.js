'use strict';
// lib/maker/bordo-esterno-soli.test.js — SOLI SUL LATO: AL BORDO ESTERNO DELLA BANDA.
//
// ═══ LA DECISIONE (12 agosto 2026), E IL MOTIVO CHE NON VA FRAINTESO ════════════════════════════════
// Senza concorrenti si è in cima al libro PER FORZA: non c'è nessuno dietro cui accodarsi, e «mai
// primo» lì non descrive niente. L'obiettivo NON è evitare la prima posizione — è inevitabile — ma
// stare al **prezzo peggiore che resta premiante**, così il fill è improbabile e il reward matura
// comunque. Su questo bot l'esecuzione è il costo, non il ricavo: un ordine che non viene eseguito e
// che intanto matura premi è un ordine che ha funzionato.
//
// Prima si ripiegava su un offset configurato dal mid, agganciato al bordo solo se cadeva fuori.

const fs = require('fs');
const path = require('path');
const { planBehindBest } = require('./top-of-book');
const { prezzoInCoda } = require('./prezzo-in-coda');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}
const c = (p) => +(p * 100).toFixed(2);

console.log('── 1 · LATO VUOTO ⇒ PREZZO AL BORDO ESTERNO');
{
  const p = planBehindBest({ bestOther: null, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 3, fallbackOffsetCents: 1 });
  ok('si quota', p.ok === true);
  ok('  al bordo INFERIORE della banda (spazio bid: il più lontano dal mid)', p.price === p.bandLo, `${c(p.price)}¢ su [${c(p.bandLo)}–${c(p.bandHi)}]¢`);
  ok('  che è più lontano dal mid di quanto fosse l\'offset configurato', Math.abs(0.50 - p.price) > 0.01);
  ok('  col modo riconoscibile negli audit', p.mode === 'fallback-alone-bordo-esterno');
  ok('  e «in cima» non è affermabile: non c\'è nessuno con cui confrontarsi', p.onTop === null);
  ok('il motivo spiega il PERCHÉ, non solo il cosa', /matura ancora reward/.test(p.reason) && /fill è improbabile/.test(p.reason));
  ok('  e dichiara che è reversibile', /si torna a un tick dietro/.test(p.reason));

  // L'offset configurato non entra più nel calcolo.
  for (const off of [null, 0.5, 1, 5, 99]) {
    const q = planBehindBest({ bestOther: null, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 3, fallbackOffsetCents: off });
    if (q.price !== p.price) { ok(`  offset ${off} NON cambia il prezzo`, false, `${c(q.price)}¢`); break; }
  }
  ok('nessun valore di offset cambia il prezzo del ramo «soli»', true);
}

console.log('\n── 2 · BANDA SENZA PREZZI VALIDI ⇒ NON SI QUOTA');
{
  // `bandBounds` pretende `lo < hi` STRETTO: una banda più stretta di un tick non contiene nessun
  // prezzo quotabile, e la risposta è «non si può rispondere» invece di un prezzo inventato.
  const stretta = planBehindBest({ bestOther: null, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 0.4 });
  ok('banda più stretta di un tick ⇒ non si quota', stretta.ok === false);
  ok('  e non si inventa un prezzo', stretta.price === null);
  ok('  dichiarando che il vincolo «dentro banda» non sarebbe garantibile', /dentro banda/.test(stretta.reason));

  const senzaBanda = planBehindBest({ bestOther: null, tick: 0.01, scoringMid: 0.50, bandRadiusCents: null });
  ok('banda non leggibile ⇒ non si quota', senzaBanda.ok === false && senzaBanda.price === null);
  const senzaTick = planBehindBest({ bestOther: null, tick: null, scoringMid: 0.50, bandRadiusCents: 3 });
  ok('tick non leggibile ⇒ non si quota', senzaTick.ok === false);

  // ⚠ E IL PREZZO RESTA SEMPRE DENTRO I LIMITI DEL LIBRO, anche su mid estremi.
  let fuori = 0; let prodotti = 0;
  for (const mid of [0.03, 0.1, 0.5, 0.9, 0.97]) {
    for (const raggio of [0.5, 1, 2.25, 4.5, 15]) {
      for (const tick of [0.001, 0.01, 0.1]) {
        const q = planBehindBest({ bestOther: null, tick, scoringMid: mid, bandRadiusCents: raggio });
        if (!q.ok) continue;
        prodotti += 1;
        if (q.price !== q.bandLo || !(q.price > 0 && q.price < 1)) fuori += 1;
      }
    }
  }
  ok(`sweep su ${prodotti} combinazioni: SEMPRE il bordo, MAI fuori dai limiti`, fuori === 0, `anomalie ${fuori}`);
}

console.log('\n── 3 · APPENA COMPARE UN CONCORRENTE SI TORNA A UN TICK DIETRO');
{
  const soli = planBehindBest({ bestOther: null, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 3 });
  const conLui = planBehindBest({ bestOther: 0.49, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 3 });
  ok('con un concorrente il modo torna a «behind-best»', conLui.mode === 'behind-best');
  ok('  a un tick dietro di lui', conLui.price === 0.48, `${c(conLui.price)}¢`);
  ok('  cioè PIÙ VICINO al mid del bordo esterno', conLui.price > soli.price, `${c(conLui.price)}¢ vs ${c(soli.price)}¢`);
  ok('  e «in cima» torna affermabile', conLui.onTop === false);
  // La regola «mai primo» resta intatta: se un tick dietro esce dalla banda, non si quota.
  const stretto = planBehindBest({ bestOther: 0.475, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 3 });
  ok('e se un tick dietro cade fuori banda, NON si quota (mai primo, invariato)',
    stretto.ok === false && stretto.quotabile === false, stretto.mode);
}

console.log('\n── 4 · LA PROPAGAZIONE A TUTTI I PERCORSI DI PIAZZAMENTO');
{
  // `prezzoInCoda` è il punto da cui passano il pannello, il piano, l'uscita e il rimpiazzo: se la
  // regola arriva lì, arriva a tutti.
  const rules = {
    readable: true,   // `prezzoInCoda` rifiuta subito una `rules` non dichiarata leggibile
    tick: 0.01, minSize: 20,
    books: {
      yes: { bids: [], asks: [], scoringMid: 0.50 },
      no: { bids: [], asks: [], scoringMid: 0.50 },
    },
    maxSpreadCents: 6,
  };
  const q = prezzoInCoda({ book: 'yes', side: 'BUY', rules, depth: rules.books, ownOrders: [], offsetCents: 1 });
  ok('`prezzoInCoda` propaga il modo nuovo', q.mode === 'fallback-alone-bordo-esterno', q.mode);

  // ── LA VENDITA: LO SPECCHIO RENDE «PIÙ LONTANO DAL MID» UN PREZZO PIÙ ALTO ─────────────────────
  // Una regola sola, due letture corrette: comprare più a buon mercato possibile, vendere più caro
  // possibile, restando entrambi premianti.
  const v = prezzoInCoda({ book: 'yes', side: 'SELL', rules, depth: rules.books, ownOrders: [], offsetCents: 1 });
  ok('anche in vendita', v.mode === 'fallback-alone-bordo-esterno', v.mode);
  ok('  e il prezzo di vendita sta SOPRA il mid, non sotto', v.ok && v.price > 0.50, `${c(v.price)}¢`);
  ok('  mentre in acquisto sta sotto', q.ok && q.price < 0.50, `${c(q.price)}¢`);

  // mm-tracking legge il modo per la sua riga di referto: deve riconoscere il nome nuovo.
  const srcMM = fs.readFileSync(path.join(__dirname, 'mm-tracking.js'), 'utf8');
  ok('mm-tracking riconosce il modo nuovo', srcMM.includes("startsWith('fallback-alone')"));
  ok('  con un prefisso e non un uguale, così un rinominarlo non lo perde di nuovo',
    !srcMM.includes("t.mode === 'fallback-alone'"));

  // Il pannello lo distingue nel suo tipo e nei due punti in cui lo mostra.
  const srcUI = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'components', 'LiquidityRewardsConsole.tsx'), 'utf8');
  ok('il pannello conosce il modo nuovo', srcUI.includes("'fallback-alone-bordo-esterno'"));
  ok('  e lo riconosce per prefisso in entrambi i punti',
    (srcUI.match(/startsWith\('fallback-alone'\)/g) || []).length === 2);
}

console.log('\n── 5 · IL MOTIVO È RICONOSCIBILE NEGLI AUDIT');
{
  const p = planBehindBest({ bestOther: null, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 3 });
  ok('il modo è una stringa distinta, non riusa quella vecchia', p.mode !== 'fallback-alone');
  ok('  e la contiene come prefisso, così le due serie storiche restano confrontabili',
    p.mode.startsWith('fallback-alone'));
  ok('il referto porta la banda usata, non solo il prezzo',
    Number.isFinite(p.bandLo) && Number.isFinite(p.bandHi));
  ok('  e l\'offset effettivo dal mid, per poterlo contare nel tempo', Number.isFinite(p.offsetCents));
}

console.log(`\n${falliti === 0 ? '✅ TUTTI VERDI' : '❌ ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

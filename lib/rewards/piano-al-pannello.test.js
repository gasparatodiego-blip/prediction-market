#!/usr/bin/env node
'use strict';
// DAL PIANO AL PANNELLO SENZA RIDIGITARE NIENTE — E SENZA PERDERE UNA GAMBA PER STRADA.
//
// ═══ COSA MANCAVA ════════════════════════════════════════════════════════════════════════════════════
// Il piano dell'allocatore calcola, per ogni mercato, DUE gambe con prezzo e size esatti:
//
//     BUY YES @ mid−d  ×  Q        BUY NO @ (1−mid)−d  ×  Q
//
// Il bottone «Piazza ordine →» della riga apriva il pannello ordine passando SOLO `presetSize`. Il
// prezzo veniva ricavato lì, come `snapToTick(mid)` — cioè il mid grezzo. Due conseguenze:
//
//   1. IL PREZZO ERA IL PEGGIORE POSSIBILE. Una quotazione appoggiata esattamente sul mid è in cima al
//      libro: il replay di questo repo ha misurato 14.642 fill all'offset 0 contro 395 a un tick di
//      distanza. Il piano un prezzo migliore ce l'aveva già calcolato, e veniva buttato.
//   2. LA SECONDA GAMBA NON ESISTEVA. Si apriva il libro YES e basta. Con la formula ufficiale a due
//      lati un lato solo matura ZERO fuori dal range [0,10–0,90] e un terzo dentro: metà del piano si
//      perdeva fra la card e il pannello.
//
// La size, invece, arrivava correttamente. Non era «il pannello non è collegato»: era collegato a metà.
//
// ═══ COSA PROVA QUESTO FILE ══════════════════════════════════════════════════════════════════════════
// Che i valori che raggiungono lo stato del pannello siano ESATTAMENTE quelli del piano — non il mid,
// non un segnaposto, non zero — e che il guard del venue li accetti senza falsi errori, visto che è lo
// stesso piano ad averli calcolati in banda.

const fs = require('fs');
const path = require('path');
const { planAllocation } = require('./allocator');
const { gambeDiUnaRiga } = require('./plan-to-orders');
const { validateQuote } = require('../maker/venue-rules');
const { numeroDigitato } = require('../campo-numerico');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const snapToTick = (p, t) => +(Math.round(p / t) * t).toFixed(10);

// ── UN PIANO VERO, DETERMINISTICO ───────────────────────────────────────────────────────────────────
// Mid 0.50, tick 0.01, banda 4.5¢, min size 20. Nessuna operazione sul nastro: 0 fill, come i mercati
// che il piano sceglie davvero.
const riga = (tsMs) => ({
  ts: new Date(tsMs).toISOString(), tsMs, marketId: 'Z', tokenIdYes: 'TKZ',
  adjMid: 0.50, plainMid: 0.50, bestBid: 0.49, bestAsk: 0.51,
  bidDepthInBand: 1000, askDepthInBand: 1000, bandLow: 0.45, bandHigh: 0.55, tick: 0.01, src: 'ws',
});
const plan = planAllocation({
  byMarket: new Map([['Z', [riga(0), riga(86_400_000)]]]),
  marketTokens: new Map([['Z', 'TKZ']]),
  tapeByToken: new Map(),
  potByCond: new Map([['Z', 100]]),
  minSizeByMarket: new Map([['Z', 20]]),
  maxSpreadByMarket: new Map([['Z', 4.5]]),
  budgetUsd: 200, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold',
  usePairCost: true,
});
const r = plan.rows[0];

// La riproduzione ESATTA di `targetFromPlanRow` (RewardsAllocatePanel:279). Se il pannello smettesse di
// usare `gambeDiUnaRiga`, le asserzioni sui sorgenti più sotto se ne accorgono.
function targetDaRiga(row, offsetTicks) {
  const g = gambeDiUnaRiga(row, offsetTicks ?? row.computedDefaultOffsetTicks);
  const legs = g.scarto || !g.rows ? null : g.rows.map((x, i) => ({
    book: x.book, side: x.side ?? 'BUY', price: x.price, size: x.size,
    label: `gamba ${i + 1} di ${g.rows.length} · ${String(x.book).toUpperCase()}`,
  }));
  return { marketId: row.marketId, mid: row.mid, tick: row.tick, minSize: row.minSizeShares,
    maxSpreadCents: row.maxSpreadCents, presetSize: legs ? legs[0].size : row.sizePerSideShares, pairLegs: legs };
}
// La precompilazione del pannello (OrderPanel, effetto su [target, legIdx]).
function campiDelPannello(target, legIdx = 0) {
  const leg = target.pairLegs ? (target.pairLegs[legIdx] ?? target.pairLegs[0]) : null;
  const s = leg ? leg.size : target.presetSize;
  const p = leg ? leg.price : snapToTick(target.mid, target.tick);
  return { book: leg ? leg.book : 'yes', priceStr: String(p), sizeStr: String(+Number(s).toFixed(4)) };
}

console.log('\n══ 1 · IL PIANO PRODUCE DUE GAMBE, NON UNA');
{
  const t = targetDaRiga(r);
  ok('la riga del piano è piazzabile', t.pairLegs != null, JSON.stringify(gambeDiUnaRiga(r, r.computedDefaultOffsetTicks).scarto));
  ok('DUE gambe', t.pairLegs.length === 2, String(t.pairLegs.length));
  ok('  la prima sul libro YES', t.pairLegs[0].book === 'yes');
  ok('  la seconda sul libro NO — era questa a sparire', t.pairLegs[1].book === 'no');
  ok('  entrambe sono acquisti', t.pairLegs.every((l) => l.side === 'BUY'));
  ok('  con la stessa size: è una coppia, non due ordini scollegati',
    t.pairLegs[0].size === t.pairLegs[1].size, String(t.pairLegs[0].size));
  ok('  ed etichettate per l operatore', /gamba 1 di 2 · YES/.test(t.pairLegs[0].label));
}

console.log('\n══ 2 · I CAMPI DEL PANNELLO SONO ESATTAMENTE QUELLI DEL PIANO (punto 11)');
{
  const t = targetDaRiga(r);
  const c = campiDelPannello(t, 0);
  ok('il libro attivo è quello della gamba', c.book === t.pairLegs[0].book);
  ok('PREZZO uguale a quello del piano', numeroDigitato(c.priceStr) === t.pairLegs[0].price,
    `${c.priceStr} vs piano ${t.pairLegs[0].price}`);
  ok('SIZE uguale a quella del piano', numeroDigitato(c.sizeStr) === t.pairLegs[0].size,
    `${c.sizeStr} vs piano ${t.pairLegs[0].size}`);
  ok('e il mercato è quello della card', t.marketId === r.marketId);

  // LA REGRESSIONE CHE CONTA: il prezzo NON è il mid agganciato al tick.
  const mid = snapToTick(r.mid, r.tick);
  ok('IL PREZZO NON È IL MID GREZZO — era il difetto',
    numeroDigitato(c.priceStr) !== mid, `piano ${c.priceStr}, mid agganciato ${mid}`);
  ok('  ed è più lontano dal mid, non più vicino: si quota dietro, non in cima',
    Math.abs(numeroDigitato(c.priceStr) - r.mid) > 0, `${Math.abs(numeroDigitato(c.priceStr) - r.mid).toFixed(4)} dal mid`);

  // E non è nessuna delle assenze che il pannello mostrava prima.
  ok('non è vuoto', c.priceStr !== '' && c.sizeStr !== '');
  ok('non è zero', numeroDigitato(c.priceStr) !== 0 && numeroDigitato(c.sizeStr) !== 0);
  ok('non è null (un segnaposto non è un valore)',
    numeroDigitato(c.priceStr) != null && numeroDigitato(c.sizeStr) != null);
}

console.log('\n══ 3 · LA SECONDA GAMBA SI PRECOMPILA DA SOLA, SUL LIBRO GIUSTO');
{
  const t = targetDaRiga(r);
  const c1 = campiDelPannello(t, 1);
  ok('passando alla gamba 2 il libro diventa NO', c1.book === 'no');
  ok('  col prezzo della gamba NO', numeroDigitato(c1.priceStr) === t.pairLegs[1].price);
  ok('  e la stessa size', numeroDigitato(c1.sizeStr) === t.pairLegs[1].size);
  // ATTENZIONE A COSA SI ASSERISCE QUI. A mid ESATTAMENTE 0,50 le due gambe coincidono per
  // costruzione: 0,50−d e (1−0,50)−d sono lo stesso numero. Non è un difetto, è aritmetica — e la
  // prima versione di questo test lo chiamava difetto, avendo scelto proprio quel mid.
  // Ciò che vale SEMPRE è la relazione: ogni gamba sta d sotto il mid del PROPRIO libro.
  const d = t.pairLegs[0].price + t.pairLegs[1].price;
  ok('ogni gamba sta sotto il mid del proprio libro',
    t.pairLegs[0].price < r.mid && t.pairLegs[1].price < (1 - r.mid) + 1e-9);
  ok('e insieme costano meno di 1 per coppia (è il margine del maker)',
    d < 1, `${+d.toFixed(4)} per coppia`);

  // A un mid asimmetrico i due prezzi divergono davvero — con i numeri veri di un mercato del piano.
  const asimm = { ...r, mid: 0.4585, snappedBid: 0.449, snappedAsk: 0.469 };
  const ga = gambeDiUnaRiga(asimm, asimm.computedDefaultOffsetTicks);
  if (ga.rows) {
    ok('a mid 0.4585 le due gambe hanno prezzi DIVERSI',
      ga.rows[0].price !== ga.rows[1].price, `${ga.rows[0].price} / ${ga.rows[1].price}`);
    ok('  e la somma resta sotto 1', ga.rows[0].price + ga.rows[1].price < 1,
      String(+(ga.rows[0].price + ga.rows[1].price).toFixed(4)));
  } else {
    ok('a mid 0.4585 le gambe restano calcolabili', false, JSON.stringify(ga.scarto));
  }
}

console.log('\n══ 4 · IL GUARD ACCETTA I VALORI DEL PIANO, SENZA FALSI ERRORI (punto 12)');
{
  const t = targetDaRiga(r);
  const regole = (book) => ({
    tick: r.tick,
    // Il pannello usa il mid del LIBRO che sta guardando: per il NO è 1 − mid.
    scoringMid: book === 'yes' ? r.mid : +(1 - r.mid).toFixed(6),
    maxSpreadCents: r.maxSpreadCents, minSize: r.minSizeShares,
  });
  for (const [i, leg] of t.pairLegs.entries()) {
    const c = campiDelPannello(t, i);
    const v = validateQuote(regole(leg.book), {
      side: 'BUY', price: numeroDigitato(c.priceStr), size: numeroDigitato(c.sizeStr),
    });
    const codici = v.reasons.map((x) => x.code);
    ok(`gamba ${i + 1} (${leg.book.toUpperCase()}): il guard passa`, v.valid === true, codici.join(',') || 'nessun motivo');
    ok('  nessun PRICE_OUT_OF_RANGE', !codici.includes('PRICE_OUT_OF_RANGE'));
    ok('  nessun OUT_OF_BAND: il piano l aveva già calcolata in banda', !codici.includes('OUT_OF_BAND'));
    ok('  nessun BELOW_MIN_SIZE', !codici.includes('BELOW_MIN_SIZE'));
    ok('  nessun OFF_TICK: i prezzi del piano sono già agganciati alla griglia', !codici.includes('OFF_TICK'));
  }
}

console.log('\n══ 5 · IL CABLAGGIO NEI SORGENTI');
{
  const ap = leggi('app', 'components', 'RewardsAllocatePanel.tsx');
  ok('targetFromPlanRow costruisce le gambe con la funzione CONDIVISA',
    /const g = gambeDiUnaRiga\(r, offsetTicks \?\? r\.computedDefaultOffsetTicks\)/.test(ap),
    'la stessa che usa il riallocatore automatico: due percorsi non possono divergere');
  ok('  e le passa al pannello', /pairLegs: legs/.test(ap));
  ok('  con l offset che l operatore ha scelto sulla riga',
    /targetFromPlanRow\(r, offsets\[r\.marketId\] \?\? r\.computedDefaultOffsetTicks\)/.test(ap));

  const op = leggi('app', 'components', 'OrderPanel.tsx');
  ok('OrderTarget dichiara le gambe', /pairLegs\?:/.test(op));
  ok('il pannello precompila DAL PIANO quando c è', /const p = leg \? leg\.price/.test(op)
    && /const s = leg \? leg\.size/.test(op));
  ok('  e imposta il libro della gamba', /if \(leg\) setBook\(leg\.book\)/.test(op));
  ok('  ripartendo dalla prima gamba quando cambia mercato', /useEffect\(\(\) => \{ setLegIdx\(0\); \}, \[target\]\)/.test(op));
  ok('il ripiego al mid resta SOLO in assenza di piano', /snapToTick\(target\.mid as number/.test(op));
}

console.log('\n══ 6 · LA SECONDA GAMBA RICHIEDE UN TOCCO ESPLICITO (regola fissa)');
{
  const op = leggi('app', 'components', 'OrderPanel.tsx');
  ok('esiste il bottone della gamba successiva', /data-op-qs-next-leg-btn/.test(op));
  ok('  e compare solo DOPO un esito positivo', /result\.ok && legNext/.test(op));
  ok('  riportando prezzo e size della gamba che manca',
    /legNext\.size/.test(op) && /legNext\.price/.test(op));
  ok('  e riapre il modulo, quindi si ripassa da riepilogo e conferma',
    /setLegIdx\(legIdx \+ 1\); setSheetStep\('form'\)/.test(op));
  // La regola che non deve poter cadere: nessun invio automatico della seconda gamba.
  ok('NESSUN INVIO AUTOMATICO della seconda gamba',
    !/legNext[\s\S]{0,200}await place\(\)/.test(op) && !/place\(\)[\s\S]{0,80}setLegIdx/.test(op));
}

console.log('\n══ 7 · IL RIEPILOGO MOSTRA I NUMERI DEL PIANO (Fase 3)');
{
  const op = leggi('app', 'components', 'OrderPanel.tsx');
  ok('la gamba corrente è nel riepilogo', /data-op-qs-review-leg-idx/.test(op));
  ok('la provenienza del prezzo è dichiarata', /data-op-qs-review-price-src/.test(op));
  ok('  e dice «dal piano» quando viene dal piano', /· dal piano/.test(op));
  ok('la banda reward è nel riepilogo accanto alla distanza dal mid', /data-op-qs-review-band-width/.test(op));
  ok('il controvalore c era già', /data-op-qs-review-total/.test(op));
}

console.log(`\npiano al pannello: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

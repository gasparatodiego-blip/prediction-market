#!/usr/bin/env node
'use strict';
// «MAI PRIMI SUL LIBRO» VINCE SULLA BANDA PREMIANTE.
//
// ═══ LA DECISIONE, 5 agosto 2026 ═════════════════════════════════════════════════════════════════════
// Se un tick dietro il miglior concorrente cade fuori dalla banda premiante, quel lato NON si quota. Non
// si accetta di stare in cima al libro nemmeno per restare premianti.
//
// Fino a quel giorno valeva il contrario: `planBehindBest` agganciava il prezzo al bordo premiante e
// dichiarava `mode:'band-clamped'`, `onTop:true` — «meglio primi e premiati che secondi e a zero».
// Il ragionamento che l'ha ribaltata: il reward di un mercato è un numero noto e limitato, il costo di
// essere il primo a essere eseguito da chi sa qualcosa che noi non sappiamo non lo è.
//
// ═══ LA PREMESSA CHE LIMITA LA REGOLA ════════════════════════════════════════════════════════════════
// La regola parla di «primi rispetto a un concorrente». Dove non c'è nessun altro su quel lato,
// «primi» non descrive niente: non esiste una coda in cui accodarsi. Lì il bordo resta ammesso,
// altrimenti non si quoterebbe mai su un libro vuoto — cioè dove la liquidità serve di più.
//
// ═══ E NON VALE IN VENDITA ═══════════════════════════════════════════════════════════════════════════
// La regola nasce da «l'esecuzione è il costo», vero per un ordine che APRE esposizione e falso per uno
// che la chiude. Per la vendita dell'uscita maker essere in testa alla coda è lo scopo: rifiutarla
// perché sarebbe prima trasformerebbe una politica di ingresso in un ostacolo all'uscita.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const { planBehindBest } = require('./top-of-book');
const { prezzoInCoda } = require('./prezzo-in-coda');
const { decideReprice } = require('./auto-reprice');
const c = (p) => (p == null ? '—' : `${(p * 100).toFixed(0)}¢`);

console.log('\n══ 1 · UN TICK DIETRO, DENTRO BANDA → SI QUOTA DIETRO');
{
  const p = planBehindBest({ bestOther: 0.77, tick: 0.01, scoringMid: 0.78, bandRadiusCents: 2.25 });
  ok('quota un tick dietro il concorrente', p.ok === true && p.price === 0.76, c(p.price));
  ok('  dichiarandosi NON in cima', p.onTop === false);
  ok('  col modo che lo dice', p.mode === 'behind-best');
  ok('  e quotabile', p.quotabile === true);
}

console.log('\n══ 2 · UN TICK DIETRO, FUORI BANDA → NON SI QUOTA (era il contrario)');
{
  // Il caso reale: concorrente a 77¢, mid di scoring 78,5¢, banda ±2,25¢ ⇒ [77¢, 80¢].
  // Un tick dietro darebbe 76¢, fuori. Prima si agganciava a 77¢ — in cima. Adesso si rinuncia.
  const p = planBehindBest({ bestOther: 0.77, tick: 0.01, scoringMid: 0.785, bandRadiusCents: 2.25 });
  ok('NON restituisce un prezzo', p.ok === false && p.price === null);
  ok('  e lo dice col suo nome', p.mode === 'behind-best-fuori-banda');
  ok('  dichiarando che NON è quotabile', p.quotabile === false,
    'diverso da «non so rispondere», che resta null');
  ok('  con un motivo leggibile, non un codice',
    /fuori dalla banda premiante/.test(p.reason) && /non si quota/.test(p.reason));
  ok('  e NON si aggancia al bordo', !/ci si ferma al bordo/.test(p.reason));

  // La prova che è cambiato: con la vecchia priorità questo caso dava un prezzo in cima.
  ok('IL VECCHIO COMPORTAMENTO NON C È PIÙ', p.price !== 0.77,
    'prima restituiva 77¢ con onTop:true');
}

console.log('\n══ 3 · SOLI SUL LATO → COMPORTAMENTO INVARIATO');
{
  const dentro = planBehindBest({ bestOther: null, tick: 0.01, scoringMid: 0.785, bandRadiusCents: 2.25, fallbackOffsetCents: 1 });
  ok('senza concorrenti si quota comunque', dentro.ok === true && dentro.quotabile === true, c(dentro.price));
  ok('  col modo «soli»', dentro.mode === 'fallback-alone-bordo-esterno');

  // ⚠ Dal 12 agosto 2026 il ramo «soli» NASCE al bordo esterno: non esiste piu' un offset che possa
  // uscire dalla banda e farsi agganciare. Cio' che va difeso e' che il lato resti QUOTABILE su un
  // libro vuoto — rinunciare li' vorrebbe dire non quotare mai dove la liquidita' serve di piu'.
  const alBordo = planBehindBest({ bestOther: null, tick: 0.01, scoringMid: 0.50, bandRadiusCents: 2.25, fallbackOffsetCents: 10 });
  ok('soli sul lato → si quota al bordo esterno, non si rinuncia',
    alBordo.ok === true && alBordo.mode === 'fallback-alone-bordo-esterno' && alBordo.price === alBordo.bandLo, c(alBordo.price));
  ok('  e resta quotabile', alBordo.quotabile === true,
    'rinunciare qui vorrebbe dire non quotare mai su un libro vuoto');
}

console.log('\n══ 4 · IL RIFIUTO ARRIVA AI CHIAMANTI, SUI DUE LATI');
{
  const rules = { readable: true, tick: 0.01, maxSpreadCents: 2.25, books: { yes: { scoringMid: 0.785 }, no: { scoringMid: 0.215 } } };
  const depth = { yes: { bids: [{ price: 0.77, size: 100 }], asks: [{ price: 0.80, size: 100 }] },
    no: { bids: [{ price: 0.20, size: 100 }], asks: [{ price: 0.23, size: 100 }] } };
  for (const book of ['yes', 'no']) {
    const q = prezzoInCoda({ book, side: 'BUY', rules, depth, ownOrders: [] });
    ok(`${book.toUpperCase()}: prezzoInCoda propaga il rifiuto`,
      q.ok === false && q.quotabile === false && q.mode === 'behind-best-fuori-banda');
  }
  // E quando si può, quota.
  const rulesOk = { ...rules, books: { yes: { scoringMid: 0.78 }, no: { scoringMid: 0.22 } } };
  const q2 = prezzoInCoda({ book: 'yes', side: 'BUY', rules: rulesOk, depth, ownOrders: [] });
  ok('quando il tick dietro sta in banda, quota', q2.ok === true && q2.quotabile === true && q2.price === 0.76);

  // I due `ok:false` restano distinguibili.
  const muto = prezzoInCoda({ book: 'yes', side: 'BUY', rules: rulesOk, depth: null, ownOrders: [] });
  ok('feed muto → ok:false ma quotabile NULL, non false', muto.ok === false && muto.quotabile === null,
    'un guasto di lettura non è una decisione di non quotare');
}

console.log('\n══ 5 · IL PIAZZAMENTO RIFIUTA — e la vendita NO');
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'maker', 'manual-order.js'), 'utf8');
  ok('`placeManualOrder` rifiuta col suo gate',
    /refuse\('mai-primo-sul-libro'/.test(src));
  ok('  solo quando la risposta è «non quotare», non quando manca',
    /q\.quotabile === false && spec\.side !== 'SELL'/.test(src));
  ok('  e la VENDITA è esclusa', /spec\.side !== 'SELL'/.test(src),
    'per un uscita essere primi è lo scopo');
  ok('la decisione della coda finisce nell audit', /inCoda: inCodaEsito,/.test(src));
  ok('  e nel valore di ritorno', (src.match(/inCoda: inCodaEsito,/g) || []).length >= 2);
  ok('  insieme allo spostamento del prezzo', (src.match(/^\s*priceAdjusted,$/gm) || []).length >= 2);
}

console.log('\n══ 6 · ORDINE GIÀ A RIPOSO CHE DIVENTA IL PRIMO');
{
  const cfg = { hysteresisTicks: 0, confirmSamples: 1, minIntervalMs: 0, maxPerHour: 99, strategy: 'band-edge',
    restingGtdSeconds: 1380, refreshMarginSeconds: 180, requireLiveBook: false, maxMidAgeSec: 60 };
  const mk = (mid) => ({ readable: true, marketId: `0x${'a'.repeat(64)}`, tick: 0.01, maxSpreadCents: 2.25, minSize: 20,
    midAgeSec: 5, books: { yes: { scoringMid: mid } }, scoringMid: mid, bandRadiusCents: 2.25 });
  const decidi = (mid, nostro, bids) => decideReprice(
    { order: { orderId: 'x', book: 'yes', side: 'BUY', price: nostro, size: 20.2 }, rules: mk(mid), config: cfg },
    { resolveDepth: () => ({ yes: { bids, asks: [{ price: 0.85, size: 99 }] }, no: { bids: [], asks: [] } }) });

  // banda su mid 78¢ = [76¢, 80¢]
  const muove = decidi(0.78, 0.79, [{ price: 0.79, size: 20.2 }, { price: 0.78, size: 60 }]);
  ok('diventato primo, spostarsi resta in banda → SI SPOSTA',
    muove.action === 'reprice' && muove.gate === 'top-of-book' && muove.targetPrice === 0.77, c(muove.targetPrice));
  ok('  di un tick dietro il concorrente, non altrove', muove.targetPrice === 0.77);

  const cancella = decidi(0.78, 0.77, [{ price: 0.77, size: 20.2 }, { price: 0.75, size: 60 }]);
  ok('diventato primo, spostarsi uscirebbe → CANCELLA senza rimpiazzo',
    cancella.action === 'cancel' && cancella.gate === 'sarebbe-primo-sul-libro');
  ok('  e non propone nessun prezzo di rimpiazzo', cancella.targetPrice === null);
  ok('  col motivo leggibile', /si cancella senza rimpiazzo/.test(cancella.reason));

  const nonPrimo = decidi(0.78, 0.77, [{ price: 0.78, size: 60 }, { price: 0.77, size: 20.2 }]);
  ok('NON primo → non si tocca niente', nonPrimo.action === 'hold');

  const cieco = decideReprice(
    { order: { orderId: 'x', book: 'yes', side: 'BUY', price: 0.77, size: 20.2 }, rules: mk(0.78), config: cfg }, {});
  ok('profondità non iniettata → non si tocca niente', cieco.action === 'hold',
    'una decisione che non si può prendere non diventa un azzardo');

  // ── SI ESCLUDONO TUTTI I NOSTRI ORDINI, NON SOLO QUELLO VALUTATO ────────────────────────────
  // Due nostri ordini sullo stesso lato (79¢ e 78¢) e un concorrente vero a 77¢. Escludendo solo
  // l'ordine valutato, il NOSTRO 78¢ passerebbe per il concorrente e ci si accoderebbe a noi stessi
  // — un tick per ciclo, fino al bordo della banda. Il ramo del piazzamento li escludeva già tutti:
  // erano due insiemi diversi nello stesso flusso, la decisione su uno e l'esecuzione sull'altro.
  const libroCon2 = { yes: { bids: [{ price: 0.79, size: 20 }, { price: 0.78, size: 20 }, { price: 0.77, size: 60 }],
    asks: [{ price: 0.85, size: 9 }] }, no: { bids: [], asks: [] } };
  const nostri = [{ orderId: 'A', book: 'yes', price: 0.79, size: 20 }, { orderId: 'B', book: 'yes', price: 0.78, size: 20 }];
  const tutti = decideReprice(
    { order: { orderId: 'A', book: 'yes', side: 'BUY', price: 0.79, size: 20 }, rules: mk(0.78), config: cfg, ownOrders: nostri },
    { resolveDepth: () => libroCon2 });
  ok('due nostri ordini sul lato → si sta dietro al CONCORRENTE, non a noi stessi',
    tutti.targetPrice === 0.76, `${c(tutti.targetPrice)} (il concorrente vero è a 77¢)`);
  ok('  e NON al nostro ordine più indietro', tutti.targetPrice !== 0.77,
    '77¢ sarebbe un tick dietro il nostro stesso 78¢');

  // E il ciclo li passa davvero: senza questa riga il ripiego varrebbe sempre.
  const ar = fs.readFileSync(path.join(ROOT, 'lib', 'maker', 'auto-reprice.js'), 'utf8');
  // L'insieme e' stato estratto in `nostriSulLato` — stesso calcolo, fatto una volta sola e passato a
  // decisione E piazzamento, che e' esattamente la proprieta' che serve. Si verifica quella, non la
  // grafia che aveva prima del refactor: un test che insegue la forma del codice invece del suo
  // significato diventa rosso a ogni riordino e non protegge da niente.
  // ⚠ AGGIORNATO IL 12 AGOSTO 2026, NON ALLENTATO. Il filtro scritto a mano e' diventato una chiamata
  // alla funzione CONDIVISA con il percorso di piazzamento (`nostri-ordini.nostriSulLato`), perche' due
  // filtri sullo stesso concetto producono due book altrui diversi fra chi decide e chi piazza. La
  // proprieta' difesa e' la stessa e vale di piu': un insieme solo, con un nome, usato da entrambi i
  // rami — e adesso anche identico a quello dell'altro percorso.
  ok('  il ciclo passa TUTTI i nostri ordini di quel lato',
    /const nostriSulLato = nostriOrdiniSulLato\(\{ orders: owned, book: order\.book \}\)\.ordini;/.test(ar)
    && (ar.match(/ownOrders: nostriSulLato/g) || []).length >= 2);
  ok('  e la selezione e\' la STESSA funzione del percorso di piazzamento',
    ar.includes("require('./nostri-ordini')"));
  ok('  e inietta la profondità nella decisione', /resolveDepth: deps\.resolveDepth,?\s*\},/.test(ar) || /offsetDeps: deps\.offsetDeps, resolveDepth: deps\.resolveDepth/.test(ar));
}

console.log('\n══ 7 · LE MANI SONO COLLEGATE (il difetto «scritto e mai raggiunto»)');
{
  const a40 = fs.readFileSync(path.join(ROOT, 'agents', 'agent40-manual-reprice.js'), 'utf8');
  ok('agent40 inietta la profondità', /resolveDepth: \(marketId\) => resolveMarketDepth\(marketId\)/.test(a40),
    'senza, il trigger non scatterebbe mai e in silenzio');
  ok('  e la mano che cancella', /cancelOrder: \(spec\) => cancelManualOrder\(spec, 'auto-reprice-band-exit'\)/.test(a40));

  const ar = fs.readFileSync(path.join(ROOT, 'lib', 'maker', 'auto-reprice.js'), 'utf8');
  ok('il ciclo sa eseguire la cancellazione', /if \(d\.action === 'cancel'\)/.test(ar));
  ok('  e se la mano non c è lo DICHIARA invece di tacere', /skip-cancel-non-collegato/.test(ar));
}

console.log('\n══ 8 · IL PIANO ESCLUDE A MONTE E DICHIARA IL CAPITALE NON IMPIEGATO');
{
  const pto = fs.readFileSync(path.join(ROOT, 'lib', 'rewards', 'plan-to-orders.js'), 'utf8');
  ok('`gambeDiUnaRiga` scarta la riga col suo motivo', /no\('sarebbe-primo-sul-libro'/.test(pto));
  ok('  spiegando che non si quota in cima', /posizione peggiore del libro/.test(pto));
  ok('il capitale della riga scartata viaggia con lo scarto', /capitalUsd: rif\.capitalUsd/.test(pto));
  ok('  e il totale non impiegato è dichiarato', /capitaleNonImpiegatoUsd:/.test(pto));
  ok('  accanto a quello pianificato, per poterli confrontare', /capitalePianificatoUsd:/.test(pto));

  // ── AGGIORNATO IL 6 AGOSTO 2026 ────────────────────────────────────────────────────────────────
  // La coda di conferme non esiste più: la garanzia era «un mercato che la regola ha scartato non
  // arriva a un bottone che lo piazza», e vale identica sul percorso nuovo. `gambeCard` restituisce
  // un elenco VUOTO quando `gambeDiUnaRiga` ha prodotto uno scarto, e con meno di due gambe
  // ConfermaEPiazza non mostra il bottone: mostra il rifiuto.
  const panel = fs.readFileSync(path.join(ROOT, 'app', 'components', 'RewardsAllocatePanel.tsx'), 'utf8');
  const conf = fs.readFileSync(path.join(ROOT, 'app', 'components', 'ConfermaEPiazza.tsx'), 'utf8');
  ok('un mercato scartato non produce gambe piazzabili',
    /const g = gambeDiUnaRiga\(riga, off\);[\s\S]{0,200}!g\.scarto/.test(panel));
  ok('  e senza due gambe il bottone non compare: compare il rifiuto',
    /if \(!dueGambe\) \{[\s\S]{0,400}data-conferma-no-gambe/.test(conf));
  ok('e l elenco degli esclusi mostra il dettaglio', /x\.dettaglio \? <> — \{x\.dettaglio\}<\/> : null/.test(panel));
}

console.log(`\nmai primo sul libro: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

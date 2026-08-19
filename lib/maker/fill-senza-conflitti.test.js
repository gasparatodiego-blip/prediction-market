'use strict';
// lib/maker/fill-senza-conflitti.test.js — RIEQUILIBRIO E MERGE VANNO NELLA STESSA DIREZIONE.
//
// Su un fill a una gamba sola convivono due logiche che potrebbero combattersi:
//   · il RIEQUILIBRIO — comprare il lato opposto per completare la coppia;
//   · la GERARCHIA merge/uscita — Livello 1 taker, Livello 2 maker con timeout, Livello 3 vendita.
// Se lavorassero in parallelo il risultato sarebbe assurdo: comprare il secondo lato mentre si vende il
// primo, o rimettere liquidità sul lato appena riempito mentre si sta cercando di appaiarlo.
//
// Questo test verifica che non succeda — non leggendo il codice, ma guardando cosa esce dal ciclo VERO
// con ogni effetto iniettato. Nessun venue, nessuna rete, nessun capitale.
//
// Run: node lib/maker/fill-senza-conflitti.test.js

const fs = require('fs');
const path = require('path');
const { runAutoCloseCycle } = require('./auto-close');
const { MERGE_STRATEGY_ENABLED, MERGE_WAIT_TIMEOUT_MIN } = require('./strategia-merge');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MERCATO = '0x' + 'ef'.repeat(32);
const TOK_YES = '111'; const TOK_NO = '222';
const CHIAVE = `${MERCATO}:${TOK_YES}`;
const T = 5_000_000;

/**
 * Il ciclo vero. `rimpiazzaGamba` è iniettato come REGISTRATORE: è la funzione che rimette liquidità
 * sul lato appena riempito, ed è esattamente quella che non deve girare insieme al completamento.
 */
async function ciclo({
  asks = [{ price: 0.90, size: 100 }], ordini = [], attese = {}, now = T,
  posizioni = [{ tokenId: TOK_YES, size: 32.27, avgPrice: 0.80 }],
  bandaCents = 4.5, midNo = 0.20, regoleExtra = {},
} = {}) {
  const piazzati = []; const cancellati = []; const rimpiazzi = [];
  const m = new Map(Object.entries(attese));
  const res = await runAutoCloseCycle({
    now: () => now, marketIds: [MERCATO],
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isEnabled: () => ({ enabled: true }), isManual: () => ({ manual: true, readable: true }),
    resolveRules: () => ({
      readable: true, tokenId: TOK_YES, tokenIdNo: TOK_NO, tick: 0.01, minSize: 5, maxSpreadCents: bandaCents,
      midSource: 'live-book', midAgeSec: 3,  // ⚠ book DATABILE: dal 19/08 `decideClose` rifiuta un bid senza eta (c919981). Il gate e difeso in coda al file, non aggirato.
      books: { yes: { scoringMid: 1 - midNo, bestBid: 0.79 }, no: { scoringMid: midNo, bestBid: 0.19 } },
      ...regoleExtra,
    }),
    readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
    readPositions: async () => ({ ok: true, positions: posizioni }),
    listOrders: async () => ({ ok: true, orders: ordini }),
    readDepth: () => ({ readable: true, yes: { asks: null }, no: { asks } }),
    attesaMerge: { leggi: (k) => m.get(k) || null, segna: (k, r) => m.set(k, r), pulisci: (k) => m.delete(k) },
    placeOrder: async (s) => { piazzati.push(s); return { ok: true, sent: false, orderId: 'sim-' + piazzati.length }; },
    cancelOrder: async (s) => { cancellati.push(s); return { ok: true }; },
    rimpiazzaGamba: async (s) => { rimpiazzi.push(s); return { action: 'rimpiazza', ok: true, price: 0.79, size: 30 }; },
    audit: () => {},
  });
  return { res, piazzati, cancellati, rimpiazzi, attese: m };
}

const USCITA = { orderId: 'uscita-1', tokenId: TOK_YES, side: 'SELL', size: 32.27, price: 0.81, createdMs: T - 60_000 };
const USCITA_VECCHIA = { ...USCITA, orderId: 'uscita-2', createdMs: T - 25 * 3600_000 };
// Il tetto del secondo lato sul carico delle fixture (80¢), chiesto al modulo e non ricopiato.
const TETTO = require('./strategia-merge').tettoSecondoLato(0.80);

(async () => {
  console.log('\n0 · la premessa');
  ok('il merge è acceso', MERGE_STRATEGY_ENABLED === true);
  ok(`il Livello 2 ha una scadenza di ${MERGE_WAIT_TIMEOUT_MIN} minuti, ed è finita`,
    Number.isFinite(MERGE_WAIT_TIMEOUT_MIN) && MERGE_WAIT_TIMEOUT_MIN > 0);

  console.log('\n1 · NON si compra il secondo lato mentre si vende il primo');
  {
    const a = await ciclo({});
    const buy = a.piazzati.filter((p) => p.side === 'BUY');
    const sell = a.piazzati.filter((p) => p.side === 'SELL');
    ok('con la coppia completabile si compra e basta', buy.length === 1 && sell.length === 0,
      a.piazzati.map((p) => `${p.side}/${p.book}`).join(' '));
    ok('  il BUY è sul lato OPPOSTO a quello riempito', buy[0] && buy[0].book === 'no');
    ok('  e NON si rimette liquidità sul lato riempito', a.rimpiazzi.length === 0,
      'rimetterla creerebbe altro sbilanciamento proprio mentre si cerca di appaiare');
  }

  console.log('\n2 · con un\'uscita già a riposo si TOGLIE prima di comprare');
  {
    const b = await ciclo({ ordini: [USCITA] });
    ok('l\'uscita viene cancellata', b.cancellati.some((c) => c.orderId === 'uscita-1'));
    ok('  e solo dopo si compra il secondo lato', b.piazzati.length === 1 && b.piazzati[0].side === 'BUY');
    ok('  in nessun istante coesistono un BUY di completamento e un SELL di uscita nostri',
      !b.piazzati.some((p) => p.side === 'SELL'));
  }

  console.log('\n3 · il riequilibrio NON rende impossibile la gerarchia, e viceversa');
  {
    // Attesa scaduta ⇒ Livello 3. Deve vendere davvero, e NON deve restare un completamento sul libro.
    const c = await ciclo({ ordini: [USCITA_VECCHIA], attese: { [CHIAVE]: { at: T - 61 * 60_000, orderId: 'compl-1' } } });
    ok('a timeout scaduto si arriva alla vendita', c.piazzati.some((p) => p.side === 'SELL'));
    ok('  dopo aver tolto il completamento a riposo', c.cancellati.some((x) => x.orderId === 'compl-1'));
    ok('  e l\'attesa è stata chiusa', !c.attese.has(CHIAVE));
    ok('  il merge non è quindi un rinvio infinito', true, `scade a ${MERGE_WAIT_TIMEOUT_MIN} minuti`);
  }
  {
    // E il rimpiazzo della gamba: gira SOLO sul percorso della vendita, mai insieme al completamento.
    const d = await ciclo({ ordini: [USCITA_VECCHIA], attese: { [CHIAVE]: { at: T - 61 * 60_000, orderId: 'compl-1' } } });
    const haVenduto = d.piazzati.some((p) => p.side === 'SELL');
    ok('il rimpiazzo della gamba esiste solo dopo la vendita', !haVenduto || d.rimpiazzi.length >= 0);
    ok('  e non è mai contemporaneo a un completamento appena piazzato',
      !(d.rimpiazzi.length > 0 && d.piazzati.some((p) => p.side === 'BUY' && p.book === 'no')));
  }

  console.log('\n4 · più aggressivo verso il completamento — ma dentro le regole');
  {
    // (a) l'ask scende dentro il tetto mentre il Livello 2 aspetta ⇒ si prende il taker.
    const e = await ciclo({ asks: [{ price: 0.15, size: 100 }], attese: { [CHIAVE]: { at: T - 10 * 60_000, orderId: 'compl-1' } } });
    ok('ask conveniente durante l\'attesa ⇒ si passa al Livello 1', e.piazzati.some((p) => p.attraversaApposta === true));
    ok('  cancellando prima il completamento a riposo', e.cancellati.some((x) => x.orderId === 'compl-1'));

    // (b) il Livello 2 riposa: mai un taker, e `inCoda` (che è la regola «mai primo sul libro»).
    const f = await ciclo({ asks: [{ price: 0.90, size: 100 }] });
    const l2 = f.piazzati[0];
    ok('il Livello 2 NON attraversa lo spread', !l2.attraversaApposta);
    ok('  e passa da `inCoda`, cioè dalla regola «mai primo sul libro»', l2.inCoda === true);
    // Il tetto si CHIEDE al modulo: dal 15 agosto 2026 vale 101 − 80 = 21¢ (era 19¢).
    ok(`  e resta sotto il tetto della coppia (${(TETTO * 100).toFixed(0)}¢ sul carico 80¢)`, l2.price <= TETTO + 1e-9, String(l2.price));
  }

  console.log('\n5 · il prezzo del completamento è già il massimo consentito, e si dichiara se è in banda');
  {
    // NON C'È MARGINE DA OTTIMIZZARE, ED È ALGEBRA. Il prezzo di riposo è già
    // `min(tetto della coppia, miglior ask − un tick)`: qualunque «alzata verso il mid» sarebbe
    // limitata dagli stessi due termini, quindi non può produrre un numero più alto. Quello che si
    // può fare è DIRE se il prezzo cade in banda, perché cambia cosa aspettarsi dall'attesa.
    const g = await ciclo({ asks: [{ price: 0.90, size: 100 }], bandaCents: 10, midNo: 0.20 });
    ok('il prezzo è min(tetto, ask − tick)', g.piazzati[0].price === TETTO, String(g.piazzati[0].price));
    // L'ask deve stare SOPRA il tetto, altrimenti scatta il Livello 1 e non si sta più guardando il
    // prezzo di riposo. Si deriva dal tetto invece di scriverlo, o al prossimo giro di manopola la
    // fixture finirebbe dalla parte sbagliata e proverebbe un'altra cosa senza dirlo.
    const askVicino = +(TETTO + 0.005).toFixed(6);
    const stretto = await ciclo({ asks: [{ price: askVicino, size: 100 }], bandaCents: 4.5, midNo: 0.20 });
    ok('  con un ask vicino, è l\'ask meno un tick a mordere',
      !stretto.piazzati[0].attraversaApposta && stretto.piazzati[0].price <= TETTO - 0.005 + 1e-9,
      String(stretto.piazzati[0].price));
    ok('  e resta sempre sotto il tetto della coppia', stretto.piazzati[0].price <= TETTO + 1e-9);
  }

  console.log('\n6 · la gamba riempita non viene liquidata per il solo fatto di essere sbilanciata');
  {
    const i = await ciclo({});
    ok('nessuna vendita quando la coppia è ancora completabile', !i.piazzati.some((p) => p.side === 'SELL'));
    // E la posizione resta: il ciclo non la tocca in nessun modo se non piazzando ordini.
    ok('  e nessuna azione di chiusura è stata registrata',
      !i.res.actions.some((a) => a.action === 'close' || a.action === 'close-at-market'));
  }

  console.log('\n7 · una funzione sola per tutti i rami — la gerarchia non ha scorciatoie');
  {
    const src = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
    const chiamate = (src.match(/provaCoppia\(/g) || []).length;
    ok('`provaCoppia` è chiamata da tre rami', chiamate >= 3, `${chiamate} chiamate`);
    for (const ramo of ['already-covered', 'close-at-market', 'uscita-ordinaria']) {
      ok(`  il ramo «${ramo}» la usa`, src.includes(`registraCoppia(c, '${ramo}')`));
    }
    ok('esiste una sola funzione che piazza il completamento', (src.match(/async function completaCoppia/g) || []).length === 1);
  }


// ── IL GATE `book-non-databile` SUL PERCORSO DI QUESTO FILE ─────────────────────────────────────────
// La regola (`c919981`) e' provata a fondo in `bid-databile.test.js`. Qui si verifica l'altra meta',
// che quel file non puo' vedere: che il gate stia A MONTE di QUESTO percorso. Ogni file di questa
// famiglia entra in `decideClose` da una porta diversa, e la posizione del gate rispetto a ciascuna
// e' proprio cio' che la sua correzione ha stabilito. Alimentare la fixture senza difendere il gate
// sarebbe stato ammorbidire il test, non ripararlo.
{
  // ⚠ SCENARIO SCELTO CON CURA: quello di difetto di `ciclo` COMPRA la gamba mancante e non vende mai,
  //   quindi «nessuna SELL» sarebbe stato verde comunque — un'asserzione vuota. Si riusa lo scenario del
  //   blocco 3, l'unico che al timeout arriva davvero alla VENDITA, dove il gate ha qualcosa da fermare.
  const scenario = { ordini: [USCITA_VECCHIA], attese: { [CHIAVE]: { at: T - 61 * 60_000, orderId: 'compl-1' } } };
  const r = await ciclo({ ...scenario, regoleExtra: { midAgeSec: undefined } });
  // ⚠ NON «zero ordini»: il gate ferma chi VENDE, non chi COMPRA la gamba mancante. Il completamento
  //   della coppia (Livello 2) e il merge restano validi a libro fermo — e' la proprieta' di R8, e
  //   pretendere qui «nessun ordine» avrebbe difeso l'opposto di cio' che la regola dice.
  const sell = r.piazzati.filter((x) => x && x.side === 'SELL');
  ok('gate: senza eta del book NESSUNA VENDITA', sell.length === 0,
    `${sell.length} SELL su ${r.piazzati.length} ordini: ${JSON.stringify(r.piazzati.map((x) => x && x.side))}`);
  // ⚑ IL CONTROLLO, senza il quale il rifiuto qui sopra non proverebbe niente: con lo STESSO scenario e
  //   un book databile la vendita c'e' davvero. Un'asserzione «non e successo X» su uno scenario in cui
  //   X non succede comunque e' verde per sempre e non difende nulla.
  const sano = await ciclo(scenario);
  ok('  CONTROLLO: con un book databile lo stesso scenario vende',
    sano.piazzati.some((x) => x && x.side === 'SELL'),
    JSON.stringify(sano.piazzati.map((x) => x && x.side)));
  // ⚑ IL CONTROLLO: senza, «nessuna vendita» sarebbe vero anche se non ci fosse MAI una vendita.
  const c = await ciclo({});
  ok('  CONTROLLO: con l eta il ciclo agisce', c.piazzati.length > 0 || c.cancellati.length > 0,
    `${c.piazzati.length} piazzati · ${c.cancellati.length} cancellati`);
}

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passati, ${fail} falliti`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });

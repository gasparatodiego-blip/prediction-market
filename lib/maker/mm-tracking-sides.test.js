#!/usr/bin/env node
'use strict';
// LA SELEZIONE PER LATO del motore di tracking: registro, motore, e i due casi limite decisi
// esplicitamente — un lato spento si cancella SUBITO, e un record senza campo lato vale «entrambi».
//
// Nessuna rete, nessun venue, nessun ordine: il ciclo gira con ogni dipendenza iniettata e «piazzare»
// significa chiamare una funzione finta che registra.

const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./mm-tracking-config');
const T = require('./mm-tracking');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const MKT = '0x' + 'cd'.repeat(32);
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sides-'));
  return { stateFile: path.join(d, 't.json'), auditFile: path.join(d, 'a.jsonl') };
};
const GOOD = { offsetCents: 2, minMoveCents: 1, sizeShares: 100 };

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · IL REGISTRO
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── il registro accetta i tre valori, e nient altro');
{
  const d = tmp();
  for (const s of ['both', 'yes', 'no']) {
    const r = C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: s }, d);
    ok(`  sides:'${s}' accettato`, r.ok === true, r.error);
    ok(`    e riletto identico`, C.trackingFor(MKT, d).sides === s);
  }
  for (const bad of ['YES', 'entrambi', 'both ', '', 0, true, ['yes']]) {
    const r = C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: bad }, d);
    ok(`  sides:${JSON.stringify(bad)} rifiutato`, r.ok === false, (r.error || '').slice(0, 50));
  }
}

console.log('\n── un record SENZA campo lato vale «entrambi» (retrocompatibilita)');
{
  const d = tmp();
  // Scritto a mano come lo scriveva il codice PRIMA di questa modifica: nessun campo `sides`.
  fs.writeFileSync(d.stateFile, JSON.stringify({ markets: { [MKT.toLowerCase()]: { enabled: true, ...GOOD } } }));
  const rec = C.trackingFor(MKT, d);
  ok('il record d epoca precedente resta valido', rec !== null);
  ok('  e viene letto come «both»', rec.sides === 'both');
  ok('  dichiarando che il valore e un default, non una scelta', rec.sidesDefaulted === true);
  ok('  quindi il motore quoterebbe entrambi i lati', JSON.stringify(C.activeSides(rec.sides)) === '["yes","no"]');

  // Un record che DICE un lato non e' un default e lo dichiara.
  C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: 'yes' }, d);
  ok('un lato scelto esplicitamente non risulta «defaulted»', C.trackingFor(MKT, d).sidesDefaulted === false);
}

console.log('\n── un lato DICHIARATO ma non riconosciuto ESCLUDE il record, non lo corregge');
{
  const d = tmp();
  fs.writeFileSync(d.stateFile, JSON.stringify({ markets: {
    [MKT.toLowerCase()]: { enabled: true, ...GOOD, sides: 'sinistra' },
    ['0x' + 'ee'.repeat(32)]: { enabled: true, ...GOOD, sides: 'no' },
  } }));
  const cfg = C.readTrackingConfig(d);
  ok('il record col lato incomprensibile sparisce', !cfg.marketIds.includes(MKT.toLowerCase()));
  ok('  e NON e stato ricondotto a «both»', cfg.markets[MKT.toLowerCase()] === undefined);
  ok('quello valido resta', cfg.marketIds.length === 1 && cfg.markets['0x' + 'ee'.repeat(32)].sides === 'no');
}

console.log('\n── activeSides: una sola traduzione per tutti');
{
  ok('both ⇒ due lati', JSON.stringify(C.activeSides('both')) === '["yes","no"]');
  ok('yes  ⇒ solo yes', JSON.stringify(C.activeSides('yes')) === '["yes"]');
  ok('no   ⇒ solo no', JSON.stringify(C.activeSides('no')) === '["no"]');
  ok('assente ⇒ due lati', JSON.stringify(C.activeSides(undefined)) === '["yes","no"]');
}

console.log('\n── l audit registra il lato e il suo CAMBIO');
{
  const d = tmp();
  C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: 'both', by: 'op' }, d);
  C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: 'yes', by: 'op' }, d);
  const lines = fs.readFileSync(d.auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('la prima accensione registra il lato', lines[0].sides === 'both');
  ok('  e non dichiara un cambio', lines[0].sidesChanged === false);
  ok('la seconda registra il lato nuovo', lines[1].sides === 'yes');
  ok('  con quello di prima', lines[1].prevSides === 'both');
  ok('  e dichiara che E cambiato', lines[1].sidesChanged === true, 'e la riga che spiega un ordine cancellato');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · IL MOTORE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

// Un banco di prova con il mid pilotabile e ogni effetto registrato.
function banco(d, { mid = 0.40 } = {}) {
  const placed = [], cancelled = [], audits = [];
  const state = new Map();
  let resting = [];
  let failCancel = false;
  const deps = () => ({
    now: () => 7_000_000,
    readConfig: () => C.readTrackingConfig(d),
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    marketWindow: () => ({ tooClose: false }),
    resolveRules: () => ({
      readable: true, missing: [], marketId: MKT, mid, tick: 0.01, minSize: 50,
      maxSpreadCents: 4.5, bandRadiusCents: 2.25, tokenId: 'ty', tokenIdNo: 'tn',
      midSource: 'live-book', midAgeSec: 1,
      books: { yes: { tokenId: 'ty', scoringMid: mid }, no: { tokenId: 'tn', scoringMid: +(1 - mid).toFixed(6) } },
    }),
    listOrders: async () => ({ ok: true, simulated: false, orders: resting }),
    placeOrder: async (s) => {
      placed.push({ book: s.book, priceCents: +(s.price * 100).toFixed(1) });
      const id = `o${placed.length}`;
      resting = resting.filter((o) => o.tokenId !== (s.book === 'yes' ? 'ty' : 'tn'))
        .concat([{ orderId: id, tokenId: s.book === 'yes' ? 'ty' : 'tn', sizeMatched: 0, secondsToExpiry: 1380 }]);
      return { ok: true, sent: false, orderId: id, gate: null, reason: null };
    },
    cancelOrder: async (s) => {
      if (failCancel) return { ok: false, reason: 'venue irraggiungibile (finto)' };
      cancelled.push(s.orderId);
      resting = resting.filter((o) => o.orderId !== s.orderId);
      return { ok: true };
    },
    audit: (a) => audits.push(a),
    tuning: { minIntervalMs: 0, maxMidAgeSec: 30, requireLiveBook: true, refreshMarginSeconds: 180 },
    state,
  });
  return {
    deps, placed, cancelled, audits, state,
    setMid: (v) => { mid = v; },
    setFailCancel: (v) => { failCancel = v; },
    run: () => T.runTrackingCycle(deps()),
  };
}

console.log('\n── il motore quota SOLO i lati scelti');
(async () => {
  for (const [sides, atteso] of [['both', ['yes', 'no']], ['yes', ['yes']], ['no', ['no']]]) {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides }, d);
    const b = banco(d);
    const r = await b.run();
    const libri = b.placed.map((p) => p.book).sort();
    ok(`  sides:'${sides}' ⇒ piazza [${atteso.join(',')}]`, JSON.stringify(libri) === JSON.stringify([...atteso].sort()),
      `piazzati: ${libri.join(',') || 'nessuno'}`);
    if (sides !== 'both') {
      const spento = sides === 'yes' ? 'no' : 'yes';
      const dec = r.markets[0].sideDecisions[spento];
      ok(`    il lato ${spento.toUpperCase()} risulta «side-disabled»`, dec.gate === 'side-disabled', dec.gate);
      ok('    con il motivo, non un silenzio', /non attivo/.test(dec.reason || ''));
    }
  }

  console.log('\n── il riepilogo del mercato parla dei lati ATTIVI, non di quello spento');
  {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: 'yes' }, d);
    const b = banco(d);
    await b.run();                       // primo giro: piazza YES
    const r = await b.run();             // secondo giro: YES e in banda, niente da fare
    const m = r.markets[0];
    // Senza la correzione qui uscirebbe «side-disabled», cioe' lo stato del lato che non lavora —
    // vero alla lettera e completamente fuorviante su cosa stia facendo il mercato.
    ok('il gate NON e «side-disabled»', m.gate !== 'side-disabled', String(m.gate));
    ok('  ma lo stato del lato che lavora', m.gate === 'in-band', String(m.gate));
    ok('  e il motivo nomina solo quel lato', /^YES:/.test(m.reason || '') && !/NO:/.test(m.reason || ''), (m.reason || '').slice(0, 50));
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  // 3 · IL CASO LIMITE DECISO: SPEGNERE UN LATO CANCELLA SUBITO
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── togliere un lato a tracking acceso: si CANCELLA subito, non si aspetta la GTD');
  {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: 'both' }, d);
    const b = banco(d);
    await b.run();
    ok('partenza: due lati a riposo', b.placed.length === 2, b.placed.map((p) => p.book).join(','));

    // L operatore passa a «solo YES». Il motore deve ritirare il NO da solo, senza aspettare nulla.
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: 'yes' }, d);
    const r = await b.run();
    ok('il NO e stato cancellato', b.cancelled.length === 1, `cancellati: ${b.cancelled.join(',') || 'nessuno'}`);
    const act = (r.actions || []).find((a) => a.action === 'retire-side');
    ok('  con un azione che si chiama per nome', !!act && act.book === 'no', act ? act.book : 'nessuna');
    ok('  e la traccia in audit', b.audits.some((a) => a.event === 'side-retired' && a.book === 'no'));
    ok('  il lato YES NON e stato toccato', !b.cancelled.includes('o1'), 'o1 = YES');
    ok('  e non e stato piazzato nulla di nuovo', b.placed.length === 2, `${b.placed.length}`);
    ok('  lo stato del lato NO e stato azzerato', b.state.get(MKT.toLowerCase()).sides.no.orderId === null);
  }

  console.log('\n── se la cancellazione FALLISCE, il lato non viene dimenticato');
  {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: 'both' }, d);
    const b = banco(d);
    await b.run();
    const noId = b.state.get(MKT.toLowerCase()).sides.no.orderId;
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: 'yes' }, d);
    b.setFailCancel(true);
    const r = await b.run();
    const act = (r.actions || []).find((a) => a.action === 'retire-side');
    ok('l azione risulta FALLITA, non riuscita', act && act.ok === false);
    ok('  e l audit lo dice', b.audits.some((a) => a.event === 'side-retire-failed'));
    ok('  l orderId NON viene dimenticato', b.state.get(MKT.toLowerCase()).sides.no.orderId === noId,
      'dimenticarlo significherebbe non riprovare mai piu a toglierlo');
    // Il venue torna: il giro dopo ci riprova da solo.
    b.setFailCancel(false);
    await b.run();
    ok('  al giro successivo ci riprova e ci riesce', b.cancelled.includes(noId), `cancellati: ${b.cancelled.join(',')}`);
    ok('  e solo ora lo stato si azzera', b.state.get(MKT.toLowerCase()).sides.no.orderId === null);
  }

  console.log('\n── un mercato d epoca precedente continua a quotare due lati');
  {
    const d = tmp();
    fs.writeFileSync(d.stateFile, JSON.stringify({ markets: { [MKT.toLowerCase()]: { enabled: true, ...GOOD } } }));
    const b = banco(d);
    await b.run();
    ok('nessun campo lato ⇒ due lati piazzati, come prima', b.placed.length === 2,
      b.placed.map((p) => `${p.book}@${p.priceCents}c`).join(' + '));
    ok('  e nessun lato e stato ritirato', b.cancelled.length === 0);
  }

  console.log(`\ntracking per lato: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
'use strict';
// LA FINE VITA DI UN MERCATO TRACCIATO: cosa succede agli ordini quando il motore non puo' piu'
// riprezzare. Prima venivano lasciati fermi; ora vengono tolti dal libro.
//
// L'episodio che ha prodotto questi test, il 2 agosto 2026: tracking attivato su una finestra Bitcoin
// da 5 minuti con 7.6 minuti di vita residua, tre ordini piazzati, e alle 22:00 il gate dell'orologio
// ha chiuso tutto. L'ordine e' rimasto a 53¢ mentre il mid saliva a 94¢, per venti minuti, con il
// motore che a ogni giro diceva «non riprezzo» — e non guardava nemmeno il libro.
//
// NESSUN ORDINE REALE: piazzamento, cancellazione, lettura e spegnimento sono iniettati.

const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./mm-tracking-config');
const T = require('./mm-tracking');
const mc = require('./market-clock');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const MKT = '0x' + 'fe'.repeat(32);
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eol-'));
  return { stateFile: path.join(d, 't.json'), auditFile: path.join(d, 'a.jsonl') };
};
const GOOD = { offsetCents: 2, minMoveCents: 1, sizeShares: 50 };

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// LA SOGLIA, IN UN PUNTO SOLO
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── la soglia di fine vita e il pavimento del venue');
{
  ok('la soglia effettiva e 3 minuti', mc.minMinutesToClose() === 3, String(mc.minMinutesToClose()));
  ok('  e coincide col pavimento derivato dal venue', mc.minMinutesToClose() === 3,
    'ceil(120s / 0.9) = 134s ⇒ 3 min: sotto, la GTD non e esprimibile');
  // Si puo ALZARE dall ambiente...
  ok('MAKER_MIN_MINUTES_TO_CLOSE puo alzarla', mc.minMinutesToClose({ MAKER_MIN_MINUTES_TO_CLOSE: '10' }) === 10);
  // ...ma non abbassarla sotto il pavimento: un refuso non deve poter aprire una finestra impossibile.
  ok('  ma NON abbassarla sotto il pavimento', mc.minMinutesToClose({ MAKER_MIN_MINUTES_TO_CLOSE: '1' }) === 3);
  ok('  ne con uno zero', mc.minMinutesToClose({ MAKER_MIN_MINUTES_TO_CLOSE: '0' }) === 3);
  ok('  ne con una stringa', mc.minMinutesToClose({ MAKER_MIN_MINUTES_TO_CLOSE: 'presto' }) === 3);
  // La conseguenza pratica: su una finestra da 5 minuti restano 2 minuti operativi invece di zero.
  ok('su una finestra da 5 minuti restano 2 minuti operativi', 5 - mc.minMinutesToClose() === 2,
    'con la vecchia soglia da 5 erano ZERO');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// IL BANCO
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
function banco(d, { tooClose = false, gate = 'market-too-close-to-close', minutesToClose = 1.2, restingIniziali = [] } = {}) {
  const placed = [], cancelled = [], audits = [], spenti = [];
  const state = new Map();
  let resting = [...restingIniziali];
  let failCancel = false;
  const deps = () => ({
    now: () => 9_000_000,
    readConfig: () => C.readTrackingConfig(d),
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    marketWindow: () => (tooClose
      ? { tooClose: true, gate, minutesToClose, reason: `mancano ${minutesToClose} min alla chiusura` }
      : { tooClose: false, minutesToClose: 60, minMinutes: 3 }),
    resolveRules: () => ({
      readable: true, missing: [], marketId: MKT, mid: 0.40, tick: 0.01, minSize: 50,
      maxSpreadCents: 4.5, bandRadiusCents: 2.25, tokenId: 'ty', tokenIdNo: 'tn',
      midSource: 'live-book', midAgeSec: 1,
      books: { yes: { tokenId: 'ty', scoringMid: 0.40 }, no: { tokenId: 'tn', scoringMid: 0.60 } },
    }),
    listOrders: async () => ({ ok: true, simulated: false, orders: resting }),
    placeOrder: async (s) => {
      placed.push({ book: s.book, price: s.price });
      const id = `o${placed.length}`;
      resting = resting.filter((o) => o.tokenId !== (s.book === 'yes' ? 'ty' : 'tn'))
        .concat([{ orderId: id, tokenId: s.book === 'yes' ? 'ty' : 'tn', sizeMatched: 0, secondsToExpiry: 1380 }]);
      return { ok: true, sent: false, orderId: id };
    },
    cancelOrder: async (s) => {
      if (failCancel) return { ok: false, reason: 'venue irraggiungibile (finto)' };
      cancelled.push(s.orderId);
      resting = resting.filter((o) => o.orderId !== s.orderId);
      return { ok: true };
    },
    disableTracking: ({ marketId, reason }) => { spenti.push({ marketId, reason }); return C.setTracking({ marketId, enabled: false }, d); },
    audit: (a) => audits.push(a),
    tuning: { minIntervalMs: 0, maxMidAgeSec: 30, requireLiveBook: true, refreshMarginSeconds: 180 },
    state,
  });
  return { deps, placed, cancelled, audits, spenti, state,
    setFailCancel: (v) => { failCancel = v; },
    resting: () => resting,
    run: () => T.runTrackingCycle(deps()) };
}

(async () => {
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  // FIX 1 · A FINE VITA SI CANCELLA, NON SI LASCIA FERMO
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── mercato a ridosso della chiusura: gli ordini vengono TOLTI dal libro');
  {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: 'yes' }, d);
    const b = banco(d, { tooClose: true, minutesToClose: 1.2, restingIniziali: [
      { orderId: 'vecchio-yes', tokenId: 'ty', sizeMatched: 0, secondsToExpiry: 900 },
    ] });
    const r = await b.run();
    const m = r.markets[0];
    ok('il gate resta quello dell orologio', m.gate === 'market-too-close-to-close', String(m.gate));
    ok('  ma l ordine a riposo e stato CANCELLATO', b.cancelled.includes('vecchio-yes'), b.cancelled.join() || 'nessuno');
    ok('  e non e stato piazzato nulla di nuovo', b.placed.length === 0);
    ok('  il motivo dice che sono stati cancellati', /CANCELLAT/.test(m.reason), m.reason.slice(0, 90));
    ok('  con la traccia in audit', b.audits.some((a) => a.event === 'end-of-life-cancelled'));
    const act = (r.actions || []).find((a) => a.action === 'end-of-life-cancel');
    ok('  e un azione che si chiama per nome', !!act && act.ok === true);
  }

  console.log('\n── un ordine di QUALCUN ALTRO non viene toccato');
  {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD }, d);
    // token che non appartiene a nessuno dei due libri di questo mercato
    const b = banco(d, { tooClose: true, restingIniziali: [
      { orderId: 'mio-yes', tokenId: 'ty', sizeMatched: 0, secondsToExpiry: 900 },
      { orderId: 'estraneo', tokenId: 'token-di-un-altro-mercato', sizeMatched: 0, secondsToExpiry: 900 },
    ] });
    await b.run();
    ok('il mio ordine viene cancellato', b.cancelled.includes('mio-yes'));
    ok('  quello non attribuibile NO', !b.cancelled.includes('estraneo'),
      'indovinare qui significherebbe cancellare l ordine di qualcun altro');
  }

  console.log('\n── se la cancellazione fallisce, non si finge che sia andata');
  {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD }, d);
    const b = banco(d, { tooClose: true, restingIniziali: [{ orderId: 'x1', tokenId: 'ty', sizeMatched: 0, secondsToExpiry: 900 }] });
    b.setFailCancel(true);
    const r = await b.run();
    const act = (r.actions || []).find((a) => a.action === 'end-of-life-cancel');
    ok('l azione risulta FALLITA', act && act.ok === false);
    ok('  e l audit lo dice', b.audits.some((a) => a.event === 'end-of-life-cancel-failed'));
    ok('  l ordine resta sul libro finto', b.resting().some((o) => o.orderId === 'x1'));
    // e al giro dopo ci riprova
    b.setFailCancel(false);
    await b.run();
    ok('  al giro successivo ci riprova e ci riesce', b.cancelled.includes('x1'));
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  // FIX 3 · IL REGISTRO NON RESTA ACCESO SU UN MERCATO MORTO
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── mercato CHIUSO: il tracking si spegne da solo, dopo aver liberato il libro');
  {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD }, d);
    const b = banco(d, { tooClose: true, gate: 'market-closed', minutesToClose: -13, restingIniziali: [
      { orderId: 'residuo', tokenId: 'ty', sizeMatched: 0, secondsToExpiry: 400 },
    ] });
    const r = await b.run();
    ok('l ordine residuo e stato cancellato', b.cancelled.includes('residuo'));
    ok('  e POI il tracking e stato spento', b.spenti.length === 1, `${b.spenti.length} spegnimenti`);
    ok('  il registro non lo elenca piu', C.trackedMarketIds(d).length === 0);
    ok('  con la traccia in audit', b.audits.some((a) => a.event === 'tracking-auto-off'));
    ok('  e il motivo lo dice sullo schermo', /SPENTO automaticamente/.test(r.markets[0].reason), r.markets[0].reason.slice(-60));
  }

  console.log('\n── ma NON si spegne se il libro non e stato liberato');
  {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD }, d);
    const b = banco(d, { tooClose: true, gate: 'market-closed', minutesToClose: -13, restingIniziali: [
      { orderId: 'ostinato', tokenId: 'ty', sizeMatched: 0, secondsToExpiry: 400 },
    ] });
    b.setFailCancel(true);
    await b.run();
    ok('cancellazione fallita ⇒ tracking NON spento', b.spenti.length === 0,
      'spegnerlo lascerebbe un ordine sul venue che nessuno prova piu a togliere');
    ok('  e il registro lo elenca ancora', C.trackedMarketIds(d).length === 1);
  }

  console.log('\n── e NON si spegne nei minuti finali di un mercato ancora aperto');
  {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD }, d);
    const b = banco(d, { tooClose: true, gate: 'market-too-close-to-close', minutesToClose: 1.2 });
    await b.run();
    ok('sotto soglia ma ancora aperto ⇒ tracking resta acceso', b.spenti.length === 0,
      'dentro la finestra il mercato e ancora dell operatore');
    ok('  e il registro lo elenca', C.trackedMarketIds(d).length === 1);
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  // LA CANCELLAZIONE ESTERNA, ORA VISIBILE
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── se cancelli tu dall app, il motore se ne accorge');
  {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: 'yes' }, d);
    const b = banco(d);                      // mercato APERTO
    await b.run();
    ok('il motore ha piazzato', b.placed.length === 1, `${b.placed.length}`);
    const id = b.state.get(MKT.toLowerCase()).sides.yes.orderId;
    ok('  e ne ricorda l orderId', !!id, String(id));

    // l operatore cancella dall app: sparisce dal venue
    b.resting().length = 0;
    const r = await b.run();
    ok('l ordine sparito viene notato', (r.events || []).some((e) => e.type === 'gone'),
      'evento «gone»: non si dichiara eseguito, si dice sparito');
    ok('  e il motore ne ripiazza uno nuovo', b.placed.length === 2,
      'il tracking e una delega continuata: finche e acceso, riquota');
  }

  console.log('\n── ma su un mercato a fine vita NON ne ripiazza');
  {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, ...GOOD, sides: 'yes' }, d);
    const b = banco(d, { tooClose: true, minutesToClose: 1.2 });
    await b.run();
    ok('nessun piazzamento su mercato a fine vita', b.placed.length === 0);
  }

  console.log(`\nfine vita: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

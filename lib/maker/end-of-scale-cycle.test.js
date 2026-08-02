#!/usr/bin/env node
'use strict';
// La soglia di fine scala DENTRO i due motori che la usano — non l'aritmetica (quella sta in
// end-of-scale.test.js), ma il comportamento: cosa viene cancellato, cosa NON viene riprezzato, e come
// convive con il dead-man's switch GTD.
//
// NESSUN ORDINE REALE. Piazzamento, cancellazione e lettura del venue sono funzioni iniettate che
// registrano e basta; il registro del tracking e' un file temporaneo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const AR = require('./auto-reprice');
const T = require('./mm-tracking');
const C = require('./mm-tracking-config');
const E = require('./end-of-scale');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const MKT = '0x' + 'ab'.repeat(32);
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eos-'));
  return { stateFile: path.join(d, 't.json'), auditFile: path.join(d, 'a.jsonl') };
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · IL WATCHER REATTIVO (auto-reprice)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

// LA CONFIGURAZIONE DEL WATCHER, IN UN FILE TEMPORANEO. Senza questo il ciclo leggerebbe il registro
// VERO di questa macchina: il mercato di prova non ci sarebbe, ogni asserzione verrebbe saltata in
// silenzio, e il test direbbe «verde» senza aver provato niente.
const AR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eos-ar-'));
const AR_DEPS = {
  configFile: path.join(AR_DIR, 'config.json'),
  autoStateFile: path.join(AR_DIR, 'state.json'),
  autoAuditFile: path.join(AR_DIR, 'audit.jsonl'),
};
fs.writeFileSync(AR_DEPS.configFile, JSON.stringify({
  global: { enabled: true },
  markets: { [MKT.toLowerCase()]: { enabled: true } },
}));

// Un mercato con UN ordine a riposo, il mid pilotabile, e ogni effetto registrato.
function repriceRun({ mid, secondsToExpiry = 1380 }) {
  const cancelled = [], replaced = [], audits = [];
  const order = { orderId: 'o1', tokenId: 'ty', side: 'BUY', price: 0.50, size: 100,
    sizeMatched: 0, sizeRemaining: 100, status: 'LIVE', source: 'manual-ui', secondsToExpiry };
  return AR.runAutoRepriceCycle({
    config: { restingGtdSeconds: 1380, refreshMarginSeconds: 180, minIntervalMs: 0, maxPerHour: 20,
      maxMidAgeSec: 30, requireLiveBook: true, confirmSamples: 1, hysteresisTicks: 1, pollMs: 5000,
      strategy: 'x', disconnectCancelSeconds: 120 },
    configDeps: AR_DEPS,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    trackedMarketIds: () => [],
    isManual: () => ({ manual: true, readable: true }),
    marketWindow: () => ({ tooClose: false }),
    resolveRules: () => ({
      readable: true, missing: [], marketId: MKT, mid, tick: 0.01, minSize: 50,
      maxSpreadCents: 4.5, bandRadiusCents: 2.25, tokenId: 'ty', tokenIdNo: 'tn',
      midSource: 'live-book', midAgeSec: 1,
      books: { yes: { tokenId: 'ty', scoringMid: mid }, no: { tokenId: 'tn', scoringMid: +(1 - mid).toFixed(6) } },
    }),
    listOrders: async () => ({ ok: true, simulated: false, orders: [order] }),
    replaceOrder: async (s) => { replaced.push(s); return { ok: true, place: { sent: false } }; },
    cancelOrder: async (s) => { cancelled.push(s.orderId); return { ok: true }; },
    audit: (a) => audits.push(a),
    breaches: new Map(),
    link: { downSince: null, consecutiveFailures: 0 },
  }).then((res) => ({ res, cancelled, replaced, audits,
    market: (res.markets || []).find((m) => String(m.marketId).toLowerCase() === MKT.toLowerCase()) }));
}

console.log('\n── auto-reprice · in mezzo alla scala il watcher lavora come sempre');
(async () => {
  const r = await repriceRun({ mid: 0.50 });
  if (!r.market) {
    console.log('     (mercato di prova non nella lista auto-reprice reale: salto questo blocco)');
  } else {
    ok('nessuna cancellazione di sicurezza', r.market.gate !== 'end-of-scale', String(r.market.gate));
    ok('  e nessun ordine cancellato', r.cancelled.length === 0);
  }

  console.log('\n── auto-reprice · mid a 2¢: si CANCELLA e non si riprezza');
  {
    const r2 = await repriceRun({ mid: 0.02 });
    if (!r2.market) { console.log('     (mercato non abilitato: blocco saltato)'); }
    else {
      ok('il gate e end-of-scale', r2.market.gate === 'end-of-scale', String(r2.market.gate));
      ok('  l ordine e stato cancellato', r2.cancelled.includes('o1'), r2.cancelled.join() || 'nessuno');
      ok('  e NON e stato riprezzato', r2.replaced.length === 0, `${r2.replaced.length} replace`);
      ok('  il motivo e quello concordato, parola per parola',
        /prezzo vicino a risoluzione — fine scala, cancellazione di sicurezza/.test(r2.market.reason || ''),
        (r2.market.reason || '').slice(0, 80));
      const trail = r2.audits.filter((a) => String(a.outcome || '').startsWith('end-of-scale'));
      ok('  ed e finito nell audit', trail.length >= 2, trail.map((a) => a.outcome).join(', '));
      ok('  con il mid osservato, non solo l esito',
        trail.some((a) => a.observed && a.observed.midCents === 2));
    }
  }

  console.log('\n── auto-reprice · mid a 98¢: stesso trattamento dall altro lato');
  {
    const r3 = await repriceRun({ mid: 0.98 });
    if (r3.market) {
      ok('gate end-of-scale anche in alto', r3.market.gate === 'end-of-scale', String(r3.market.gate));
      ok('  cancellato', r3.cancelled.includes('o1'));
    }
  }

  // ── LA CONVIVENZA COL DEAD-MAN'S SWITCH, che e' la domanda posta esplicitamente ────────────────
  console.log('\n── auto-reprice · fine scala CON la scadenza GTD alle porte');
  {
    // 120s alla scadenza, sotto il margine di rinnovo da 180s: senza la soglia di prezzo questo giro
    // avrebbe fatto un rinnovo proattivo. Con la soglia, cancella — e sono la stessa direzione, non due
    // ordini contrastanti: uno toglie l ordine dal book adesso, l altro lo avrebbe rimesso.
    const r4 = await repriceRun({ mid: 0.02, secondsToExpiry: 120 });
    if (r4.market) {
      ok('vince la cancellazione, non il rinnovo', r4.market.gate === 'end-of-scale', String(r4.market.gate));
      ok('  nessun rinnovo proattivo e partito', r4.replaced.length === 0,
        r4.replaced.length ? 'un replace sarebbe stato un ordine NUOVO a fine scala' : '');
      ok('  l ordine e stato tolto dal book', r4.cancelled.includes('o1'));
    }
    // E il verso opposto: in mezzo alla scala il rinnovo proattivo funziona ancora. Serve a dimostrare
    // che la soglia non ha spento il dead-man s switch, l ha solo preceduto dove doveva.
    const r5 = await repriceRun({ mid: 0.50, secondsToExpiry: 120 });
    if (r5.market) {
      ok('in mezzo alla scala il rinnovo proattivo vive ancora', r5.replaced.length === 1,
        `${r5.replaced.length} replace · gate ${r5.market.gate}`);
      ok('  e nessuno ha cancellato niente', r5.cancelled.length === 0);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  // 2 · IL MOTORE A DUE LATI (mm-tracking)
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── mm-tracking · il motore che INSEGUE il mid si ferma a fine scala');
  {
    const d = tmp();
    C.setTracking({ marketId: MKT, enabled: true, offsetCents: 2, minMoveCents: 1, sizeShares: 100, by: 'test' }, d);
    const placed = [], cancelled = [], audits = [];
    const state = new Map();
    let mid = 0.40;
    let resting = [];
    const deps = () => ({
      now: () => 5_000_000,
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
        placed.push({ book: s.book, price: s.price, mid });
        const id = `o${placed.length}`;
        resting = resting.filter((o) => o.tokenId !== (s.book === 'yes' ? 'ty' : 'tn'))
          .concat([{ orderId: id, tokenId: s.book === 'yes' ? 'ty' : 'tn', sizeMatched: 0, secondsToExpiry: 1380 }]);
        return { ok: true, sent: false, orderId: id, gate: null, reason: null };
      },
      cancelOrder: async (s) => { cancelled.push(s.orderId); resting = resting.filter((o) => o.orderId !== s.orderId); return { ok: true }; },
      audit: (a) => audits.push(a),
      tuning: { minIntervalMs: 0, maxMidAgeSec: 30, requireLiveBook: true, refreshMarginSeconds: 180 },
      state,
    });

    await T.runTrackingCycle(deps());
    ok('a mid 40¢ il motore ha quotato due lati', placed.length === 2, `${placed.length} ordini`);

    // Il mercato scivola verso la risoluzione.
    mid = 0.02;
    const before = placed.length;
    const r = await T.runTrackingCycle(deps());
    const m = (r.markets || [])[0];
    ok('a mid 2¢ il gate e end-of-scale', m && m.gate === 'end-of-scale', m ? String(m.gate) : 'nessun mercato');
    ok('  entrambi i lati cancellati', cancelled.length === 2, cancelled.join() || 'nessuno');
    ok('  e NESSUN nuovo ordine piazzato', placed.length === before, `${placed.length - before} nuovi`);
    ok('  il motivo e la stessa frase dell altro motore',
      /fine scala, cancellazione di sicurezza/.test((m && m.reason) || ''));
    ok('  con la traccia in audit', audits.some((a) => a.event === 'end-of-scale-cancelled'),
      audits.map((a) => a.event).join(', '));

    // ── IL TRACKING RESTA ACCESO ───────────────────────────────────────────────────────────────────
    // Spegnerlo di nascosto lascerebbe un interruttore che dice «attivo» e un motore che non lo e.
    ok('il toggle NON e stato spento alle spalle dell operatore', C.trackedMarketIds(d).length === 1);

    // ── E RIPARTE DA SOLO SE IL MID RIENTRA ────────────────────────────────────────────────────────
    mid = 0.40;
    const before2 = placed.length;
    await T.runTrackingCycle(deps());
    ok('rientrato il mid, il motore ripiazza senza intervento', placed.length > before2,
      `${placed.length - before2} nuovi ordini`);
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  // 3 · UNA SOGLIA SOLA PER DUE MOTORI
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n── la soglia non e duplicata: i due motori leggono lo stesso numero');
  {
    const src = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8')
      + fs.readFileSync(path.join(__dirname, 'mm-tracking.js'), 'utf8');
    ok('nessuno dei due motori scrive 3.0 o 97.0 per conto suo',
      !/\b(3\.0|97\.0)\b/.test(src.replace(/require\('\.\/end-of-scale'\)/g, '')));
    ok('entrambi importano end-of-scale',
      (src.match(/require\('\.\/end-of-scale'\)/g) || []).length === 2);
    ok('  e il modulo esporta un solo confine per lato',
      E.END_OF_SCALE_LOW_CENTS === 3.0 && E.END_OF_SCALE_HIGH_CENTS === 97.0);
  }

  console.log(`\nend-of-scale nei cicli: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
'use strict';
// UN RINNOVO RIUSCITO NON DEVE ESSERE ANNUNCIATO COME UNA MORTE PER SCADENZA.
//
// ═══ IL FALSO ALLARME, CON I SECONDI (5-6 agosto 2026) ═══════════════════════════════════════════════
// 23:56:11.617  TX-15 (cid_d1f23e2b): due gambe rinnovate. L'audit dice `expiry-refresh`, `sent`,
//               `oldCancelled:true`, `replaced:true`, successori 0xc22e6b7e e 0x747c9372. Perfetto.
// 23:56:16.616  cinque secondi dopo, cioè il ciclo successivo: DUE righe `scaduto-senza-rinnovo` sui
//               predecessori 0x8ba4ae88 e 0xbcef2547, con «l'ordine è morto per scadenza GTD senza
//               essere stato rinnovato». Gli stessi due ordini che erano appena stati rinnovati.
// Stessa coppia di righe su Ed Markey alle 23:17:33.
//
// ═══ PERCHÉ SUCCEDEVA ═══════════════════════════════════════════════════════════════════════════════
// Il rilevatore dichiara morto un id che (a) era a riposo, (b) non c'è più, (c) aveva la scadenza dentro
// una grazia di 60s. Un replace produce esattamente quella firma: il vecchio id viene cancellato e il
// successore ne riceve uno NUOVO, quindi il predecessore «sparisce» pur essendo vivo sotto altro nome.
//
// E succedeva proprio nelle notti storte: il rinnovo proattivo parte a 180s dalla scadenza — fuori dalla
// grazia — ma quando gli skip (mid-stale, tetto orario, rate-limit) lo rimandano, scivola dentro. Le due
// righe di TX-15 dicono «57s of venue-side life left» e «56s»: rinnovi in ritardo, non morti.
//
// ═══ COSA VERIFICA QUESTO FILE ══════════════════════════════════════════════════════════════════════
//   1 · rinnovo riuscito con successore  ⇒ NESSUN «scaduto-senza-rinnovo» sul predecessore
//   2 · l'ordine sparito SENZA successore ⇒ l'avviso c'è ancora (il rilevatore non è stato disattivato)
//   3 · il successore resta sorvegliato: il ciclo dopo lo conosce e lo giudica come qualunque altro
//
// NESSUN ORDINE REALE: dipendenze iniettate, file temporanei, nessuna rete.

const fs = require('fs');
const os = require('os');
const path = require('path');
const AR = require('./auto-reprice');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// TX-15 come era davvero quella notte: mid di scoring 0.63, banda ±2.25¢, tick 0.001, minimo 20 share.
const MKT = '0xd1f23e2bc9c61979e1c9f53bd0b76de8ef9cf5bcbc92ecfbccfbf67bfd3c8801';
const NOW = 1_700_000_000_000;
const TX15 = () => ({
  readable: true, missing: [], marketId: MKT, title: 'TX-15 House seat', mid: 0.63, tick: 0.001,
  minSize: 20, maxSpreadCents: 4.5, tokenId: 'ty', tokenIdNo: 'tn',
  midSource: 'live-book', midAgeSec: 3,
  feedVitality: { assetsWithEvents: 178, seededAssets: 200, windowMs: 30_000 },
  books: { yes: { tokenId: 'ty', scoringMid: 0.63 }, no: { tokenId: 'tn', scoringMid: 0.37 } },
});
const CFG = {
  restingGtdSeconds: 1380, refreshMarginSeconds: 180, minIntervalMs: 30_000, maxPerHour: 20,
  maxMidAgeSecLive: 60, maxMidAgeSecBlind: 10, feedAliveMinAssets: 5, requireLiveBook: true,
  confirmSamples: 2, hysteresisTicks: 1, pollMs: 5000, strategy: 'band-edge', disconnectCancelSeconds: 180,
};
const CHASE = { resolveOffset: () => ({ targetOffsetCents: 2.0, source: 'observed', minMoveCents: 0.1 }) };

// Il predecessore, con 57 secondi di vita davanti: ESATTAMENTE il numero dell'audit di TX-15, cioè
// dentro la grazia di 60s del rilevatore. È il caso che produceva il falso allarme.
const VITA_RESIDUA_SEC = 57;
const VECCHIO = {
  orderId: '0x8ba4ae88', source: 'manual-ui', side: 'BUY', price: 0.61, size: 61.2, sizeRemaining: 61.2,
  marketId: MKT, tokenId: 'ty', orderType: 'GTD',
  secondsToExpiry: VITA_RESIDUA_SEC, expiresAtMs: NOW + VITA_RESIDUA_SEC * 1000,
};
// Il successore che il replace conia: id DIVERSO, finestra piena. È la differenza che il rilevatore
// non sapeva leggere.
const NUOVO = {
  ...VECCHIO, orderId: '0xc22e6b7e',
  secondsToExpiry: 1380, expiresAtMs: NOW + 1380 * 1000,
};

function ambiente() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rinnovo-'));
  const deps = {
    configFile: path.join(dir, 'config.json'),
    autoStateFile: path.join(dir, 'state.json'),
    autoAuditFile: path.join(dir, 'audit.jsonl'),
  };
  fs.writeFileSync(deps.configFile, JSON.stringify({ global: { enabled: true }, markets: { [MKT.toLowerCase()]: { enabled: true } } }));
  fs.writeFileSync(deps.autoStateFile, JSON.stringify({ markets: {}, heartbeatAt: NOW, cycles: 1 }));
  return deps;
}

// Un giro del ciclo con l'elenco di ordini che il venue restituisce in quel momento. `ordiniVisti` è la
// mappa che il chiamante (agent40) porta FRA i cicli: è lì che vive la memoria del predecessore.
function giro({ configDeps, ordiniVisti, orders, righe, inviati, replaceRes }) {
  return AR.runAutoRepriceCycle({
    now: () => NOW,
    configDeps,
    config: CFG,
    ordiniVisti,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    trackedMarketIds: () => [],
    marketWindow: () => ({ tooClose: false }),
    resolveRules: () => TX15(),
    resolveOffset: CHASE.resolveOffset,
    rememberObserved: () => {},
    resolveDepth: () => ({ yes: { bids: [{ price: 0.61, size: 61.2 }], asks: [] }, no: { bids: [], asks: [] } }),
    listOrders: async () => ({ ok: true, simulated: false, orders }),
    replaceOrder: async (spec) => { inviati.push(spec); return replaceRes; },
    audit: (rec) => righe.push(rec),
  });
}

(async () => {
  console.log('\n══ 1 · RINNOVO RIUSCITO ⇒ IL PREDECESSORE NON VIENE DICHIARATO MORTO');
  {
    const configDeps = ambiente();
    const ordiniVisti = new Map();
    const righe = [], inviati = [];

    // Giro 1: il vecchio ordine è a riposo con 57s di vita → rinnovo proattivo, successore 0xc22e6b7e.
    const r1 = await giro({ configDeps, ordiniVisti, orders: [VECCHIO], righe, inviati,
      replaceRes: { ok: true, oldCancelled: true, replaced: true, place: { sent: true, orderId: NUOVO.orderId } } });
    ok('il rinnovo parte', (r1.actions || []).some((a) => a.action === 'reprice' && a.ok), JSON.stringify((r1.actions || []).map((a) => a.action)));
    ok('  ed è un rinnovo di scadenza', (r1.actions || []).some((a) => a.trigger === 'expiry-refresh'));
    ok('  con il successore dichiarato, id diverso', (r1.actions || []).some((a) => a.newOrderId === NUOVO.orderId));
    ok('  il predecessore è già stato dimenticato nello stesso giro',
      !ordiniVisti.has(VECCHIO.orderId), [...ordiniVisti.keys()].join(','));

    // Giro 2: il venue ora elenca SOLO il successore. Il vecchio id è sparito — ed è la sparizione che
    // prima veniva letta come una morte.
    const r2 = await giro({ configDeps, ordiniVisti, orders: [NUOVO], righe, inviati,
      replaceRes: { ok: true, oldCancelled: true, replaced: true, place: { sent: true, orderId: '0xTERZO' } } });
    const morti2 = (r2.events || []).filter((e) => e.type === 'scaduto-senza-rinnovo');
    ok('NESSUN avviso di morte sul predecessore', morti2.length === 0,
      morti2.map((e) => e.orderId).join(',') || 'zero eventi');
    ok('  e nessuna riga «scaduto-senza-rinnovo» nell audit',
      !righe.some((x) => x.outcome === 'scaduto-senza-rinnovo'),
      righe.filter((x) => x.outcome === 'scaduto-senza-rinnovo').map((x) => x.orderId).join(','));
    ok('  il successore, invece, è sorvegliato come qualunque altro ordine',
      ordiniVisti.has(NUOVO.orderId) || (r2.actions || []).some((a) => a.orderId === NUOVO.orderId),
      [...ordiniVisti.keys()].join(','));
  }

  console.log('\n══ 2 · IL RILEVATORE NON È STATO DISATTIVATO: SENZA SUCCESSORE L AVVISO RESTA');
  {
    // Stesso identico scenario, ma il replace cancella e poi NON riesce a piazzare: nessun successore,
    // il libro resta vuoto. Quello è capitale davvero fermo, ed è il caso per cui l'avviso esiste.
    const configDeps = ambiente();
    const ordiniVisti = new Map();
    const righe = [], inviati = [];

    await giro({ configDeps, ordiniVisti, orders: [VECCHIO], righe, inviati,
      replaceRes: { ok: false, oldCancelled: true, replaced: false, gate: 'venue-reject', reason: 'il venue ha rifiutato il piazzamento', place: null } });
    ok('senza successore il predecessore resta sorvegliato', ordiniVisti.has(VECCHIO.orderId));

    const r2 = await giro({ configDeps, ordiniVisti, orders: [], righe, inviati, replaceRes: null });
    const morti = (r2.events || []).filter((e) => e.type === 'scaduto-senza-rinnovo');
    ok('l avviso ESCE, come prima', morti.length === 1, `${morti.length} eventi`);
    ok('  sul predecessore giusto', morti[0] && morti[0].orderId === VECCHIO.orderId, morti[0] && morti[0].orderId);
    ok('  col capitale tornato libero', morti[0] && Math.abs(morti[0].notionalUsd - 0.61 * 61.2) < 0.01,
      morti[0] && String(morti[0].notionalUsd));
    ok('  e con una riga nell audit', righe.some((x) => x.outcome === 'scaduto-senza-rinnovo'));
  }

  console.log('\n══ 3 · LA REGOLA È NEL CODICE, E LA CONDIZIONE È IL SUCCESSORE');
  {
    const src = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8');
    ok('si dimentica solo con un successore vero',
      /if \(ok && successorOrderId\) dimenticaOrdineTolto\(order\.orderId\);/.test(src));
    ok('  e il successore arriva dalla risposta del venue, non da un flag del chiamante',
      /const successorOrderId = \(res && res\.place && res\.place\.orderId\) \|\| null;/.test(src));
  }

  console.log(`\nrinnovo non è una morte: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

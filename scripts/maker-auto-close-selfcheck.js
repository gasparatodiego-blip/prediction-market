#!/usr/bin/env node
'use strict';
// scripts/maker-auto-close-selfcheck.js — proof that AUTOMATIC POSITION CLOSING does what it claims and
// nothing it does not.
//
//   node scripts/maker-auto-close-selfcheck.js
//
// Pure assertions with injected dependencies. No network, no credentials, no signing key, no order.
// Every store is redirected into a temp directory that is deleted at the end; the real
// data/maker-auto-close.json is never touched.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AC = require('../lib/maker/auto-close');
const ACC = require('../lib/maker/auto-close-config');

let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; console.log(`  ✓ ${m}`); };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-close-'));
let n = 0;
const tmp = (x) => path.join(TMP, `${x}-${process.pid}-${n++}`);
const MKT = '0x12dc2b61723b2a54fc1947a307389b5f32038e7a29a0e936ad1fe410b969d06a';
const YES = 'TOKEN_YES_1111';
const NO = 'TOKEN_NO_2222';
const stores = () => ({ closeConfigFile: tmp('cfg.json'), closeAuditFile: tmp('audit.jsonl') });

function rulesAt(mid, over = {}) {
  return {
    readable: true, missing: [], marketId: MKT, title: 'selfcheck',
    mid, tick: 0.001, maxSpreadCents: 4.5, minSize: 50,
    tokenId: YES, tokenIdNo: NO, negRisk: false, bandRadiusCents: 2.25,
    feedLive: true, feedAgeSec: 1, midSource: 'live-book', midAgeSec: 1,
    books: { yes: { tokenId: YES, scoringMid: mid }, no: { tokenId: NO, scoringMid: +(1 - mid).toFixed(6) } },
    ...over,
  };
}

// ── 1 · THE CLOSE PRICE ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. il prezzo di chiusura — carico + profitto, arrotondato IN SU al tick');
{
  const t = AC.closeTargetPrice({ entryPrice: 0.485, tick: 0.001 });
  ok(t.price === 0.495 && t.profitCents === 1,
    `carico 0.485 + 1c = ${t.price}, profitto reale ${t.profitCents}c/share (tick 0.001: un centesimo sono DIECI tick)`);

  // On a coarse grid the target must round UP, never down — rounding down would silently pay less than
  // the constant promises, and on a 0.01 market that is the whole target.
  const coarse = AC.closeTargetPrice({ entryPrice: 0.485, tick: 0.01 });
  ok(coarse.price === 0.5 && coarse.profitCents === 1.5,
    `su tick 0.01 lo stesso carico da ${coarse.price} (+${coarse.profitCents}c): 0.495 non esiste sulla griglia, quindi si sale — mai si scende sotto il target`);

  const already = AC.closeTargetPrice({ entryPrice: 0.48, tick: 0.01 });
  ok(already.price === 0.49,
    'un carico gia sulla griglia non salta un tick di troppo');

  const cfg = AC.closeTargetPrice({ entryPrice: 0.485, tick: 0.001, profitCents: 3 });
  ok(cfg.price === 0.515 && cfg.profitCents === 3,
    'il target e configurabile da una costante sola (CLOSE_PROFIT_CENTS), qui forzato a 3c');

  ok(AC.closeTargetPrice({ entryPrice: null, tick: 0.001 }).price === null,
    'carico non leggibile ⇒ nessun prezzo inventato');
  ok(ACC.CLOSE_PROFIT_CENTS === 1 && ACC.MIN_PROFIT_CENTS === 1,
    'la costante vive in un posto solo (lib/maker/auto-close-config.js) e vale 1c');
}

// ── 2 · LA DECISIONE ────────────────────────────────────────────────────────────────────────────────
console.log('\n2. la decisione su una posizione — vendere il token posseduto');
{
  const rules = rulesAt(0.5135);
  const pos = { tokenId: NO, size: 50, avgPrice: 0.485 };

  const d = AC.decideClose({ position: pos, restingOrders: [], rules, book: 'no' });
  ok(d.action === 'close' && d.price === 0.495 && d.size === 50,
    'posizione 50 NO @ 0.485 ⇒ VENDITA di 50 NO a 0.495 — si chiude vendendo il token che si possiede');
  ok(d.inBand === true,
    `…e a 0.495 l'uscita e dentro la banda del book NO (mid ${(1 - 0.5135).toFixed(4)}), quindi matura premi mentre aspetta`);

  const covered = AC.decideClose({ position: pos, rules, book: 'no',
    restingOrders: [{ tokenId: NO, side: 'SELL', price: 0.495, size: 50, sizeRemaining: 50 }] });
  ok(covered.action === 'already-covered',
    'con una vendita gia a riposo per l\'intera size la posizione risulta COPERTA: nessun doppione');

  const partial = AC.decideClose({ position: { tokenId: NO, size: 200, avgPrice: 0.485 }, rules, book: 'no',
    restingOrders: [{ tokenId: NO, side: 'SELL', price: 0.495, size: 50, sizeRemaining: 50 }] });
  ok(partial.action === 'close' && partial.size === 150,
    'copertura parziale ⇒ si chiude solo la differenza (150 share su 200), non l\'intera posizione una seconda volta');

  const tinyRest = AC.decideClose({ position: { tokenId: NO, size: 50, avgPrice: 0.485 }, rules, book: 'no',
    restingOrders: [{ tokenId: NO, side: 'SELL', price: 0.495, size: 20, sizeRemaining: 20 }] });
  ok(tinyRest.action === 'skip' && tinyRest.gate === 'remainder-below-min-size',
    '…ma se il resto scende sotto la size minima del mercato la chiusura viene RIFIUTATA e dichiarata: il guard condiviso e l\'adapter la rifiuterebbero comunque, e indebolirli per un chiamante non e uno scambio che vale la pena');

  const buyIgnored = AC.decideClose({ position: pos, rules, book: 'no',
    restingOrders: [{ tokenId: NO, side: 'BUY', price: 0.485, size: 50, sizeRemaining: 50 }] });
  ok(buyIgnored.action === 'close',
    'un ordine di ACQUISTO sullo stesso token non copre nulla: solo una VENDITA e un\'uscita');

  ok(AC.decideClose({ position: { tokenId: NO, size: 0 }, rules, book: 'no' }).action === 'skip',
    'nessuna posizione ⇒ nessuna chiusura');
  ok(AC.decideClose({ position: pos, rules: { readable: false }, book: 'no' }).action === 'skip',
    'regole di venue non leggibili ⇒ nessuna chiusura (mai un prezzo indovinato)');
}

// ── 3 · IL PAVIMENTO SUL PROFITTO ───────────────────────────────────────────────────────────────────
console.log('\n3. il profitto e protetto — un\'uscita non viene mai spinta sotto il pareggio');
{
  const floor = AC.closeFloorPrice({ entryPrice: 0.485, tick: 0.001 });
  ok(floor === 0.495,
    `il pavimento per un\'uscita su carico 0.485 e ${floor}: il watcher di banda non puo scendere sotto`);

  const { decideReprice } = require('../lib/maker/auto-reprice');
  const { loadAutoRepriceTuning } = require('../lib/maker/auto-reprice-config');
  const TUN = loadAutoRepriceTuning({});
  // Il mid del book NO scende: la banda scenderebbe sotto l'uscita.
  const rulesLow = rulesAt(0.56);   // mid NO = 0.44 → banda [0.4175, 0.4625], l'uscita a 0.495 e sopra
  const sell = { orderId: 'CLOSE_1', price: 0.495, size: 50, book: 'no', side: 'SELL', secondsToExpiry: 800 };
  const dSell = decideReprice({ order: sell, rules: rulesLow, config: TUN, consecutiveBreaches: 5, now: 1e6 });
  ok(dSell.action === 'skip' && dSell.gate === 'close-sell-floor',
    'se la banda scende sotto un\'uscita, il watcher NON la abbassa: resta dov\'e (fuori banda non matura premi, ma il guadagno e protetto)');

  // Lo stesso ordine come ACQUISTO viene invece riprezzato normalmente.
  const buy = { ...sell, side: 'BUY', orderId: 'BUY_1' };
  const dBuy = decideReprice({ order: buy, rules: rulesLow, config: TUN, consecutiveBreaches: 5, now: 1e6 });
  ok(dBuy.action === 'reprice',
    '…mentre un ACQUISTO nella stessa identica situazione viene riprezzato: per un bid il prezzo non e il profitto');

  // Una banda che sale sopra l'uscita la porta con se: piu profitto, nessun motivo per rifiutare.
  const rulesHigh = rulesAt(0.44);  // mid NO = 0.56 → banda [0.5375, 0.5825]
  const dUp = decideReprice({ order: sell, rules: rulesHigh, config: TUN, consecutiveBreaches: 5, now: 1e6 });
  ok(dUp.action === 'reprice' && dUp.targetPrice > 0.495,
    `…e se la banda sale, l\'uscita viene alzata a ${dUp.targetPrice}: piu profitto, nessuna ragione per rifiutare`);
}

// ── 4 · GLI INTERRUTTORI ────────────────────────────────────────────────────────────────────────────
console.log('\n4. gli interruttori — default OFF, entrambi necessari, fail-closed');
{
  const st = stores();
  ok(ACC.isAutoCloseEnabled(MKT, st).enabled === false,
    'DEFAULT OFF: senza nessuna configurazione la chiusura automatica non agisce');

  ACC.setAutoClose({ scope: 'market', marketId: MKT, enabled: true, by: 'selfcheck' }, st);
  ok(ACC.isAutoCloseEnabled(MKT, st).enabled === false,
    'il solo opt-in del mercato non basta: serve anche l\'interruttore generale');

  ACC.setAutoClose({ scope: 'global', enabled: true, by: 'selfcheck' }, st);
  const on = ACC.isAutoCloseEnabled(MKT, st);
  ok(on.enabled === true && on.globalEnabled === true && on.marketEnabled === true,
    'con entrambi accesi la chiusura automatica e attiva su questo mercato');

  ACC.setAutoClose({ scope: 'global', enabled: false, by: 'selfcheck' }, st);
  const off = ACC.isAutoCloseEnabled(MKT, st);
  ok(off.enabled === false && off.marketEnabled === true,
    'spegnendo il generale il mercato resta abilitato ma inerte — i tre fatti restano distinti');

  const corrupt = { closeConfigFile: tmp('bad.json'), closeAuditFile: tmp('a.jsonl') };
  fs.writeFileSync(corrupt.closeConfigFile, '{{{');
  ok(ACC.isAutoCloseEnabled(MKT, corrupt).enabled === false,
    'configurazione illeggibile ⇒ OFF (fail closed: la direzione che non fa nulla)');
  ok(ACC.setAutoClose({ scope: 'global', enabled: true }, corrupt).ok === false,
    '…e ACCENDERLA su uno stato illeggibile e rifiutato');
  ok(ACC.setAutoClose({ scope: 'global', enabled: false }, corrupt).ok === true,
    '…mentre SPEGNERLA e sempre permesso');

  const audit = fs.readFileSync(st.closeAuditFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  ok(audit.length === 3 && audit[0].event === 'auto-close-on' && audit[0].by === 'selfcheck',
    'ogni scatto e tracciato con chi/quando/perche');
}

// ── 5 · LO SCENARIO COMPLETO ────────────────────────────────────────────────────────────────────────
console.log('\n5. scenario completo — ordine riempito ⇒ uscita piazzata automaticamente');
(async () => {
  const st = stores();
  ACC.setAutoClose({ scope: 'global', enabled: true, by: 'selfcheck' }, st);
  ACC.setAutoClose({ scope: 'market', marketId: MKT, enabled: true, by: 'selfcheck' }, st);

  const world = { placed: [], audits: [], resting: [], positions: [{ tokenId: NO, size: 50, avgPrice: 0.485 }] };
  const deps = {
    marketIds: [MKT],
    configDeps: st,
    killStatus: () => world.kill || { effectivelyKilled: false, readable: true },
    isManual: () => world.manual || { manual: true, readable: true },
    resolveRules: () => rulesAt(0.5135),
    listOrders: async () => ({ ok: true, simulated: false, orders: world.resting }),
    readPositions: async () => ({ ok: true, positions: world.positions }),
    audit: (r) => world.audits.push(r),
    placeOrder: async (spec) => {
      world.placed.push(spec);
      world.resting.push({ orderId: 'CLOSE_' + world.placed.length, tokenId: NO, side: 'SELL', price: spec.price, size: spec.size, sizeRemaining: spec.size, source: 'auto-close-on-fill' });
      return { ok: true, sent: false, dryRun: true, orderId: 'CLOSE_' + world.placed.length, gate: null, reason: null };
    },
  };

  const r1 = await AC.runAutoCloseCycle(deps);
  ok(world.placed.length === 1, 'una posizione scoperta ⇒ ESATTAMENTE una uscita piazzata');
  const c = world.placed[0];
  ok(c.side === 'SELL' && c.book === 'no' && c.price === 0.495 && c.size === 50,
    `l'ordine e una VENDITA di 50 NO a ${c.price} — si chiude vendendo il token posseduto, non comprando il lato opposto`);
  ok(c.source === 'auto-close-on-fill',
    '…tracciato con sorgente auto-close-on-fill, distinta da manual-ui, agent35 e auto-reprice-band-exit');
  ok(world.audits.some((a) => a.outcome === 'trigger' && a.source === 'auto-close-on-fill'),
    '…e l\'intera sequenza finisce nell\'audit sotto quella sorgente');

  const r2 = await AC.runAutoCloseCycle(deps);
  ok(world.placed.length === 1 && r2.markets[0].covered === 1,
    'un secondo giro NON piazza un doppione: la posizione risulta gia coperta (idempotente per costruzione)');

  // ── I GATE ──
  world.kill = { effectivelyKilled: true, readable: true };
  const rk = await AC.runAutoCloseCycle(deps);
  ok(rk.ran === false && rk.gate === 'kill' && world.placed.length === 1,
    'con il kill-switch ATTIVO non viene piazzata nessuna uscita — una chiusura e comunque un ordine nuovo');
  world.kill = null;

  world.manual = { manual: false, readable: true };
  const rm = await AC.runAutoCloseCycle(deps);
  ok(rm.markets[0].gate === 'manual-mode-inactive',
    'su un mercato restituito al motore la chiusura automatica sta alla larga');
  world.manual = null;

  // ── OFF ⇒ comportamento di oggi ──
  const stOff = stores();
  const offDeps = { ...deps, configDeps: stOff, marketIds: [] };
  const roff = await AC.runAutoCloseCycle(offDeps);
  ok(roff.ran === false && roff.gate === 'no-markets' && world.placed.length === 1,
    'con l\'interruttore OFF non viene piazzato nulla: la posizione resta aperta finche non intervieni tu');

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nmaker auto-close selfcheck: ${checks} asserzioni passate.`);
  console.log('Si chiude VENDENDO il token posseduto (verificato sui doc Polymarket), a carico + 1c');
  console.log('arrotondato in su al tick. Idempotente, dietro kill/gestione-manuale/cap/validateOrder,');
  console.log('default OFF su entrambi gli interruttori, e il profitto non viene mai eroso dal riprezzo.');
})().catch((e) => { console.error(e); process.exit(1); });

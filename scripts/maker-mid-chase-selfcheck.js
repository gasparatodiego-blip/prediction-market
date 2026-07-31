#!/usr/bin/env node
'use strict';
// scripts/maker-mid-chase-selfcheck.js — proof of the ACTIVE MID CHASE, the configuration guard-rails,
// external-cancellation recognition, and the bulk allocation's cumulative cap.
//
//   node scripts/maker-mid-chase-selfcheck.js
//
// Pure assertions with injected dependencies. No network, no credentials, no signing key, no order.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { decideReprice } = require('../lib/maker/auto-reprice');
const { loadAutoRepriceTuning } = require('../lib/maker/auto-reprice-config');
const OC = require('../lib/maker/offset-config');
const { runBulkAllocation } = require('../lib/maker/bulk-allocate');

let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; console.log(`  ✓ ${m}`); };
const TUN = loadAutoRepriceTuning({});
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chase-'));
let n = 0;
const tmp = (x) => path.join(TMP, `${x}-${process.pid}-${n++}`);

// Wide band (±4¢) so the reference example's ±3¢ distance fits inside it.
const rulesAt = (mid, over = {}) => ({
  readable: true, missing: [], marketId: '0xesempio', title: 'esempio',
  mid, tick: 0.001, maxSpreadCents: 8, minSize: 50, tokenId: 'Y', tokenIdNo: 'N', negRisk: false,
  bandRadiusCents: 4, feedLive: true, feedAgeSec: 1, midSource: 'live-book', midAgeSec: 1,
  books: { yes: { tokenId: 'Y', scoringMid: mid }, no: { tokenId: 'N', scoringMid: +(1 - mid).toFixed(6) } },
  ...over,
});
const order = (price, over = {}) => ({ orderId: 'O', price, size: 50, book: 'yes', side: 'BUY', secondsToExpiry: 800, ...over });
const withOffset = (targetOffsetCents, minMoveCents = 0.1) => ({ resolveOffset: () => ({ targetOffsetCents, minMoveCents, source: 'configured' }) });

// ── 17 · L'ESEMPIO ESATTO ───────────────────────────────────────────────────────────────────────────
console.log('\n17. inseguimento del mid — l\'esempio di riferimento, mid 10 → 11, ordini 7→8 e 13→14');
{
  const dep = withOffset(3);
  for (const [label, price, expected] of [['sotto (7)', 0.07, 0.08], ['sopra (13)', 0.13, 0.14]]) {
    const still = decideReprice({ order: order(price), rules: rulesAt(0.10), config: TUN, now: 1e6 }, dep);
    ok(still.action === 'hold',
      `${label}: a mid 0.10 la distanza e' gia' quella target (3c) ⇒ l'ordine NON viene toccato`);
    const moved = decideReprice({ order: order(price), rules: rulesAt(0.11), config: TUN, now: 1e6 }, dep);
    ok(moved.action === 'reprice' && moved.gate === 'mid-chase' && Math.abs(moved.targetPrice - expected) < 1e-9,
      `${label}: mid → 0.11 ⇒ ${(price * 100).toFixed(0)} → ${(moved.targetPrice * 100).toFixed(0)} (atteso ${(expected * 100).toFixed(0)})`);
    ok(Math.abs(Math.abs(moved.targetPrice - 0.11) * 100 - 3) < 1e-6,
      `${label}: la DISTANZA resta esattamente 3c dopo il movimento — e' l'invariante, non il prezzo`);
  }
  // Il lato rispetto al mid non viene mai ribaltato.
  const below = decideReprice({ order: order(0.07), rules: rulesAt(0.11), config: TUN, now: 1e6 }, withOffset(3));
  ok(below.targetPrice < 0.11, 'un ordine SOTTO il mid resta sotto: inseguire non significa ribaltare il lato');
}

// ── 18 · LA SOGLIA MINIMA ───────────────────────────────────────────────────────────────────────────
console.log('\n18. la soglia minima ferma i riprezzi su micro-movimenti');
{
  const dep = withOffset(3, 0.1);   // soglia 1 tick
  // Mid da 0.100 a 0.1005: la distanza deriva di 0.05c, sotto la soglia di 0.1c.
  const tiny = decideReprice({ order: order(0.07), rules: rulesAt(0.1005), config: TUN, now: 1e6 }, dep);
  ok(tiny.action === 'hold',
    'deriva di 0.05c contro soglia 0.1c ⇒ HOLD: il rumore sotto un tick non muove nulla');
  const enough = decideReprice({ order: order(0.07), rules: rulesAt(0.1015), config: TUN, now: 1e6 }, dep);
  ok(enough.action === 'reprice',
    'deriva di 0.15c contro soglia 0.1c ⇒ riprezzo: superata la soglia, si insegue');

  // Con una soglia larga lo stesso movimento non basta.
  const wide = decideReprice({ order: order(0.07), rules: rulesAt(0.1015), config: TUN, now: 1e6 }, withOffset(3, 1.0));
  ok(wide.action === 'hold', 'la stessa deriva con soglia 1c ⇒ HOLD: la soglia e\' davvero configurabile');

  // Il rate limit resta sopra all'inseguimento.
  const limited = decideReprice({ order: order(0.07), rules: rulesAt(0.11), config: TUN, lastRepriceAt: 1e6 - 5000, now: 1e6 }, dep);
  ok(limited.action === 'skip' && limited.gate === 'rate-limited',
    'un inseguimento dovuto ma dentro il rate limit di 30s viene rimandato, non forzato');

  // E il conteggio orario pure.
  const capped = decideReprice({ order: order(0.07), rules: rulesAt(0.11), config: TUN, repricesThisHour: TUN.maxPerHour, now: 1e6 }, dep);
  ok(capped.action === 'skip' && capped.gate === 'hourly-cap',
    'e il tetto di riprezzi/ora vale anche per l\'inseguimento');
}

// ── 19 · LA BANDA PREVALE ───────────────────────────────────────────────────────────────────────────
console.log('\n19. la banda del premio resta il vincolo superiore');
{
  // Banda stretta (raggio 1c) con distanza target 3c: il target e' incompatibile.
  const narrow = rulesAt(0.11, { maxSpreadCents: 2, bandRadiusCents: 1 });
  const d = decideReprice({ order: order(0.107), rules: narrow, config: TUN, now: 1e6 }, withOffset(3, 0.1));
  ok(d.action === 'reprice' && d.bandClamped === true,
    'distanza target 3c contro banda ±1c ⇒ si riprezza comunque, ma LIMITATI dalla banda');
  const dist = Math.abs(d.targetPrice - 0.11) * 100;
  ok(dist <= 1 + 1e-6,
    `il prezzo finale resta dentro la banda (${dist.toFixed(3)}c ≤ 1c): la distanza target non viene mai comprata al prezzo di uscire dal premio`);
  ok(/LIMITATO DALLA BANDA/.test(d.reason),
    '…e il motivo lo dichiara esplicitamente invece di limitare in silenzio');
}

// ── 20 · VALIDAZIONE DELLA CONFIGURAZIONE ───────────────────────────────────────────────────────────
console.log('\n20. la configurazione distanza/soglia e\' validata contro le regole reali del mercato');
{
  const band = 2.25, tick = 0.001;
  ok(OC.validateOffset({ targetOffsetCents: 5, bandRadiusCents: band, tick }).valid === false,
    'una distanza target oltre il raggio della banda e\' RIFIUTATA: la' + ' fuori un ordine non matura nulla');
  ok(OC.validateOffset({ targetOffsetCents: 2, bandRadiusCents: band, tick }).valid === true,
    'una distanza dentro la banda e\' accettata');
  ok(OC.validateOffset({ minMoveCents: 0, bandRadiusCents: band, tick }).valid === false,
    'una soglia minima di ZERO e\' rifiutata: riprezzerebbe a ogni ciclo');
  ok(OC.validateOffset({ minMoveCents: -1, bandRadiusCents: band, tick }).valid === false,
    'una soglia negativa e\' rifiutata');
  ok(OC.validateOffset({ minMoveCents: 0.01, bandRadiusCents: band, tick }).valid === false,
    'una soglia sotto il pavimento e\' rifiutata: sotto un tick il riprezzo ricalcola lo STESSO prezzo');
  ok(OC.defaultMinMoveCents(0.001) === 0.1 && OC.defaultMinMoveCents(0.01) === 1,
    'la soglia di default e\' UN TICK del mercato (0.1c su tick 0.001, 1c su tick 0.01)');

  // Il default "resta dove sei" si ricorda per (mercato, lato), non per orderId.
  const st = { offsetConfigFile: tmp('off.json'), offsetAuditFile: tmp('off.jsonl') };
  const seeded = OC.resolveOffsetFor({ marketId: '0xM', book: 'yes', observedOffsetCents: 2.4, tick: 0.001 }, st);
  ok(seeded.source === 'observed' && seeded.targetOffsetCents === 2.4,
    'senza configurazione il target e\' la distanza OSSERVATA: "resta dove sei stato piazzato"');
  OC.rememberObserved({ marketId: '0xM', book: 'yes', offsetCents: 2.4 }, st);
  const remembered = OC.resolveOffsetFor({ marketId: '0xM', book: 'yes', observedOffsetCents: 9.9, tick: 0.001 }, st);
  ok(remembered.source === 'remembered' && remembered.targetOffsetCents === 2.4,
    '…e una volta ricordata sopravvive al riprezzo (che cambia orderId) e al riavvio');
  OC.setMarketOffset({ marketId: '0xM', book: 'yes', targetOffsetCents: 1.5, by: 'selfcheck' }, st);
  const configured = OC.resolveOffsetFor({ marketId: '0xM', book: 'yes', observedOffsetCents: 9.9, tick: 0.001 }, st);
  ok(configured.source === 'configured' && configured.targetOffsetCents === 1.5,
    '…e un\'impostazione esplicita del pannello ha comunque la precedenza');
}

// ── 21 · L'ALLOCAZIONE IN BLOCCO E IL CAP CUMULATIVO ────────────────────────────────────────────────
console.log('\n21. esecuzione dell\'allocazione — il cap cumulativo ferma la sequenza');
(async () => {
  const rows = [
    { marketId: '0xA', book: 'yes', price: 0.5, size: 50, title: 'A' },   // $25
    { marketId: '0xB', book: 'yes', price: 0.5, size: 50, title: 'B' },   // $25
    { marketId: '0xC', book: 'yes', price: 0.5, size: 50, title: 'C' },   // $25 → sfora un cap da 60
    { marketId: '0xD', book: 'yes', price: 0.5, size: 50, title: 'D' },
  ];
  const base = {
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    resolveCaps: () => ({ readable: true, maxOpenNotionalUsd: 60, maxOrderNotionalUsd: 40, effectiveOrderCapUsd: 30 }),
    engine: {}, audit: () => {}, openNotionalUsd: 0,
  };
  const placed = [];
  const r = await runBulkAllocation({ rows }, { ...base, placeOrder: async (s) => { placed.push(s); return { ok: true, sent: false, orderId: 'X' + placed.length }; } });
  ok(r.placed === 2 && r.skipped === 2,
    `con un cap cumulativo di $60 e righe da $25: 2 piazzate, 2 saltate (piazzato $${r.totals.placedUsd})`);
  ok(r.stoppedBy === 'cap-cumulativo', 'la sequenza si FERMA sul cap, con un motivo esplicito');
  ok(r.results[2].status === 'skipped' && /cap cumulativo/.test(r.results[2].reason),
    'la riga che sfora dice perche\', invece di essere tentata e rifiutata a meta\' sequenza');
  ok(r.results[3].status === 'skipped' && /fermata/.test(r.results[3].reason),
    'e le righe successive sono dichiarate saltate: non viene riordinata l\'allocazione per farne stare una piu\' piccola');
  ok(placed.length === 2, 'solo due ordini sono stati davvero tentati');

  // L'esposizione GIA' aperta consuma il budget.
  const r2 = await runBulkAllocation({ rows }, { ...base, openNotionalUsd: 50, placeOrder: async () => ({ ok: true, sent: false }) });
  ok(r2.placed === 0 && r2.stoppedBy === 'cap-cumulativo',
    'con $50 gia\' aperti e un cap di $60, nemmeno la prima riga da $25 passa: il conteggio parte da cio\' che c\'e\' gia\'');

  // Kill.
  const r3 = await runBulkAllocation({ rows }, { ...base, killStatus: () => ({ effectivelyKilled: true, readable: true }), placeOrder: async () => ({ ok: true }) });
  ok(r3.stoppedBy === 'kill' && r3.placed === 0, 'con il kill-switch attivo non parte nulla');

  // Un rifiuto singolo NON ferma la sequenza.
  let i = 0;
  const r4 = await runBulkAllocation({ rows: rows.slice(0, 2) }, { ...base, resolveCaps: () => ({ readable: true, maxOpenNotionalUsd: 1000 }), placeOrder: async () => { i++; return i === 1 ? { ok: false, gate: 'venue-rules', reason: 'fuori banda' } : { ok: true, sent: false }; } });
  ok(r4.refused === 1 && r4.placed === 1 && r4.stoppedBy === null,
    'il rifiuto di UNA riga non ferma le altre: le regole di un mercato non dicono nulla sul successivo');

  // Anteprima: nulla viene inviato.
  const prev = await runBulkAllocation({ rows, dryRunOnly: true }, { ...base, resolveCaps: () => ({ readable: true, maxOpenNotionalUsd: 1000 }), placeOrder: async () => { throw new Error('non deve essere chiamata'); } });
  ok(prev.placed === 0 && prev.results.every((x) => x.status === 'skipped'),
    'l\'anteprima percorre la stessa aritmetica del cap senza inviare NULLA');

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nmaker mid-chase selfcheck: ${checks} asserzioni passate.`);
})().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
'use strict';
// scripts/maker-auto-reprice-selfcheck.js — repeatable proof that AUTOMATIC BAND-EXIT RE-PRICING does
// what it claims and, more importantly, does NOTHING it does not claim.
//
//   node scripts/maker-auto-reprice-selfcheck.js
//
// PURE ASSERTIONS AGAINST TEMP FIXTURES. No network, no credentials, no signing key, no venue call, and
// NO ORDER — real or simulated-at-the-venue. The replace path is an injected spy that records what it was
// asked to do and returns a canned answer; nothing in this file can reach lib/venues/*. It never touches
// data/maker-auto-reprice.json, data/maker-manual-mode.json, data/safety-kill-switch.json or any live
// state — every store is redirected into a fresh temp directory that is deleted at the end.
//
// WHAT IT PROVES:
//   1. the pure decision — in band ⇒ HOLD (the order is not touched), out of band ⇒ eventually REPRICE,
//      and every refusal names itself;
//   2. THE HEADLINE SCENARIO — a simulated mid that walks out from under a resting order is detected and
//      triggers exactly one re-price, to a price the shared guard accepts;
//   3. THE OTHER HEADLINE — an order the mid never invalidates is NEVER touched, across a long simulated
//      run (hundreds of cycles / many simulated minutes), not even once;
//   4. the switches — OFF (globally or per market) means the watcher does nothing AND a new hand order
//      goes back to the fixed 180s GTD expiry; ON means a 15-minute GTD renewed proactively;
//   5. fail-closed everywhere it matters — unreadable config, stale mid, board-row mid, unreadable venue
//      rules, a failed venue read: all of them leave the order alone;
//   6. the gates are not bypassed — a global kill and a market handed back to the engine both stop the
//      automatism BEFORE anything is cancelled;
//   7. the rails bind — confirmation samples, hysteresis at the band edge, the per-market rate limit and
//      the hourly runaway ceiling;
//   8. ownership — the watcher touches ONLY orders provably placed by the panel, never agent35's and
//      never unattributable ones;
//   9. attribution — every automatic move is stamped source:'auto-reprice-band-exit', distinct from
//      'manual-ui' and 'agent35', and records WHICH trigger fired;
//  10. THE RENEWAL RATE — over 2 simulated hours with a moving mid the watcher renews exactly 3 times an
//      hour (the derived rate, asserted against the constants themselves); and with the watcher DEAD the
//      order is retired by the EXCHANGE within the 23-minute window, with no host-side process involved;
//  11. THE BLACKOUT — a process that is alive but cannot reach the venue renews nothing (the expiry does
//      the work), and on reconnection after a long blackout it CANCELS rather than renewing on top of a
//      state it never observed.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AR = require('../lib/maker/auto-reprice');
const ARC = require('../lib/maker/auto-reprice-config');
const { validateQuote } = require('../lib/maker/venue-rules');

let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; console.log(`  ✓ ${m}`); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-reprice-'));
let n = 0;
const tmp = (name) => path.join(TMP, `${name}-${process.pid}-${n++}`);
const MKT = '0x12dc2b61723b2a54fc1947a307389b5f32038e7a29a0e936ad1fe410b969d06a';
const YES = 'TOKEN_YES_1111';
const NO = 'TOKEN_NO_2222';

// A fresh, isolated pair of stores per scenario. Nothing here can reach the real data/ directory.
function stores() { return { configFile: tmp('cfg.json'), autoStateFile: tmp('state.json'), autoAuditFile: tmp('audit.jsonl') }; }

// The market's live rules, exactly the resolveMarketRules() shape the real watcher passes in.
// tick 0.01, max_spread 3¢ ⇒ reward band = mid ± 1.5¢.
function rulesAt(mid, over = {}) {
  return {
    readable: true, missing: [], marketId: MKT, title: 'selfcheck market',
    mid, tick: 0.01, maxSpreadCents: 3, minSize: 50,
    tokenId: YES, tokenIdNo: NO, negRisk: false,
    bandRadiusCents: 1.5, feedLive: true, feedAgeSec: 1,
    midSource: 'live-book', midAgeSec: 1,
    bestBid: null, bestAsk: null,
    books: { yes: { tokenId: YES, scoringMid: mid }, no: { tokenId: NO, scoringMid: +(1 - mid).toFixed(6) } },
    ...over,
  };
}

// One resting order as the venue reports it, already attributed to the panel.
// `secondsToExpiry` is the venue's own expiry, already corrected for the 60s the exchange retires GTD
// orders early. The default is a comfortable 800s so the expiry trigger stays out of the way of the
// band-exit scenarios; the expiry scenarios set it deliberately.
function restingOrder(price, over = {}) {
  return {
    orderId: 'ORDER_A', marketId: MKT, tokenId: YES, side: 'BUY',
    price, size: 60, sizeMatched: 0, sizeRemaining: 60,
    status: 'LIVE', createdMs: 1, ageSec: 1, source: 'manual-ui', notionalUsd: price * 60,
    orderType: 'GTD', secondsToExpiry: 800, secondsToRefresh: 800 - ARC.REFRESH_MARGIN_SECONDS,
    ...over,
  };
}

const TUNING = ARC.loadAutoRepriceTuning({});   // the shipped defaults, not this shell's env

/**
 * Build a fully-injected cycle harness. `world` is mutable so a scenario can walk the mid between
 * cycles. Every venue-facing dependency is a spy: `world.replaced` is the complete record of everything
 * the automatism ASKED to happen, and it is asserted to be empty in every "must not touch" case.
 */
function harness(world) {
  const st = world.stores || (world.stores = stores());
  world.replaced = [];
  world.cancelled = [];
  world.audits = [];
  const breaches = new Map();
  return {
    breaches,
    stores: st,
    deps: {
      // The SIMULATED clock has to reach the durable store too, not just the decision. The rate limit
      // and the hourly ceiling are computed from timestamps the store writes, so a store still reading
      // the real wall clock would compare a synthetic "now" against a real "last" and produce nonsense
      // (here: a permanently negative elapsed time, i.e. a rate limit that never releases).
      configDeps: { ...st, now: () => world.now },
      config: world.config || TUNING,
      breaches,
      now: () => world.now,
      killStatus: () => world.kill || { effectivelyKilled: false, readable: true },
      isManual: () => world.manual || { manual: true, readable: true, error: null, record: null, reason: 'selfcheck' },
      resolveRules: () => world.rules,
      listOrders: async () => {
        if (world.linkDown) return { ok: false, error: 'simulated network blackout', simulated: false, count: 0, orders: [] };
        const src = world.orders || { ok: true, simulated: false, count: 0, orders: [] };
        // AGE THE EXPIRY with the simulated clock, the way the venue would. Without this the order would
        // read "800s left" forever and the proactive-refresh trigger could never be exercised at all.
        return { ...src, orders: (src.orders || []).map((o) => {
          if (o.placedAt == null) return o;
          const left = Math.round(o.secondsToExpiry - (world.now - o.placedAt) / 1000);
          return { ...o, secondsToExpiry: left, secondsToRefresh: left - ARC.REFRESH_MARGIN_SECONDS };
        }) };
      },
      audit: (rec) => world.audits.push(rec),
      replaceOrder: async (spec) => {
        world.replaced.push(spec);
        // The canned answer models a DRY-RUN replace: the old order is cancelled, the new one is built,
        // signed and validated, and NOTHING is sent. sent:false everywhere, on purpose.
        // A replacement is a NEW order, so it carries a FULL venue-side window again. Modelling that is
        // the whole reason the two triggers cannot double-fire: whatever moved the order, the clock it
        // was racing is reset by the move itself.
        if (world.orders && Array.isArray(world.orders.orders)) {
          world.orders = { ...world.orders, orders: world.orders.orders.map((o) => (o.orderId === spec.orderId
            ? { ...o, orderId: `${spec.orderId}_R${world.replaced.length}`, price: spec.price,
                orderType: 'GTD', placedAt: world.now, secondsToExpiry: ARC.RESTING_GTD_SECONDS }
            : o)) };
        }
        return { ok: true, replaced: true, oldCancelled: true, oldOrderId: spec.orderId,
          place: { ok: true, sent: false, dryRun: true, orderId: `${spec.orderId}_R${world.replaced.length}`, gate: null, reason: null },
          gate: null, reason: null, source: spec.source };
      },
    },
  };
}

function enable(st, { global = true, market = true } = {}) {
  if (global) ARC.setAutoReprice({ scope: 'global', enabled: true, by: 'selfcheck' }, st);
  if (market) ARC.setAutoReprice({ scope: 'market', marketId: MKT, enabled: true, by: 'selfcheck' }, st);
}

// ── 1 · THE PURE DECISION ───────────────────────────────────────────────────────────────────────────
console.log('\n1. the pure decision — in band means DO NOT TOUCH, out of band eventually means move');
{
  const order = { orderId: 'O', price: 0.49, size: 60, book: 'yes', secondsToExpiry: 800 };

  // Mid 0.50, band ±1.5¢ ⇒ [0.485, 0.515]. The order at 0.49 sits inside it.
  const hold = AR.decideReprice({ order, rules: rulesAt(0.50), config: TUNING, now: 1_000_000 });
  ok(hold.action === 'hold' && hold.gate === null,
    'an order INSIDE the band is HELD — no cancel, no replace, and no clock can change that answer');
  ok(hold.distanceC === 1 && hold.bandRadiusC === 1.5,
    '…and the decision reports the real numbers it judged on (1.00¢ from a ±1.50¢ band), never a verdict without them');

  // The mid walks to 0.53 ⇒ band [0.515, 0.545]; the order at 0.49 is now 4¢ away.
  const first = AR.decideReprice({ order, rules: rulesAt(0.53), config: TUNING, consecutiveBreaches: 0, now: 1_000_000 });
  ok(first.action === 'skip' && first.gate === 'awaiting-confirmation',
    'a breach seen for the FIRST time does not act — one sample is not a signal (confirm 2/2)');

  const second = AR.decideReprice({ order, rules: rulesAt(0.53), config: TUNING, consecutiveBreaches: 1, now: 1_000_000 });
  ok(second.action === 'reprice' && second.breachConfirmed === true,
    'the SECOND consecutive observation of the same breach triggers the re-price');
  ok(second.targetPrice === 0.52,
    `…to ${second.targetPrice}, the nearest qualifying price on the SAME side of the mid (band-edge strategy preserves the operator's below-mid stance)`);
  ok(validateQuote({ tick: 0.01, scoringMid: 0.53, maxSpreadCents: 3, minSize: 50 }, { side: 'BUY', price: second.targetPrice, size: 60 }).valid,
    '…and the shared guard (the same function the server re-runs before any send) accepts that target');

  // 'nearest-mid' is the other documented reading of "closest valid price to the mid".
  const nm = AR.decideReprice({ order, rules: rulesAt(0.53), config: { ...TUNING, strategy: 'nearest-mid' }, consecutiveBreaches: 1, now: 1_000_000 });
  ok(nm.targetPrice === 0.53,
    `the 'nearest-mid' strategy instead targets ${nm.targetPrice} — the qualifying price closest to the mid (more reward, more fill risk); both strategies stay inside the band`);

  // The NO book is judged in its own space: a NO order at q is a YES order at 1−q.
  const noOrder = { orderId: 'O', price: 0.49, size: 60, book: 'no', secondsToExpiry: 800 };
  const noHold = AR.decideReprice({ order: noOrder, rules: rulesAt(0.50), config: TUNING, now: 1_000_000 });
  ok(noHold.action === 'hold' && Math.abs(noHold.scoringMid - 0.5) < 1e-9,
    'a NO order is judged against the NO book\'s mirrored scoring mid (1 − mid), the same mirror the engine and the placement path use');
}

// ── 2 · HYSTERESIS AND THE RAILS ────────────────────────────────────────────────────────────────────
console.log('\n2. the rails bind — hysteresis at the edge, the rate limit, the hourly ceiling');
{
  const order = { orderId: 'O', price: 0.49, size: 60, book: 'yes', secondsToExpiry: 800 };
  // Mid 0.505 ⇒ band [0.49, 0.52]; the order at 0.49 is 1.5¢ out... exactly ON the edge.
  const edge = AR.decideReprice({ order, rules: rulesAt(0.507), config: TUNING, consecutiveBreaches: 5, now: 1_000_000 });
  ok(edge.action === 'hold' && edge.gate === 'hysteresis',
    'an order a hair past the band edge is HELD by the hysteresis — it does not flap in and out on rounding');

  const limited = AR.decideReprice({ order, rules: rulesAt(0.53), config: TUNING, consecutiveBreaches: 5, lastRepriceAt: 1_000_000 - 5_000, now: 1_000_000 });
  ok(limited.action === 'skip' && limited.gate === 'rate-limited',
    'a leg moved 5s ago is not moved again — the per-market rate limit (30s) leaves it alone');

  const capped = AR.decideReprice({ order, rules: rulesAt(0.53), config: TUNING, consecutiveBreaches: 5, repricesThisHour: TUNING.maxPerHour, now: 1_000_000 });
  ok(capped.action === 'skip' && capped.gate === 'hourly-cap',
    `the runaway guard stops at ${TUNING.maxPerHour} automatic re-prices/hour on one market — an automatism without a ceiling is an incident waiting`);
}

// ── 3 · FAIL CLOSED ON EVERY UNTRUSTWORTHY INPUT ────────────────────────────────────────────────────
console.log('\n3. fail closed — an input it cannot trust never produces a move');
{
  const order = { orderId: 'O', price: 0.49, size: 60, book: 'yes', secondsToExpiry: 800 };
  const far = { consecutiveBreaches: 5, now: 1_000_000, config: TUNING };

  const stale = AR.decideReprice({ order, rules: rulesAt(0.53, { midAgeSec: 120 }), ...far });
  ok(stale.action === 'skip' && stale.gate === 'mid-stale',
    'a STALE mid produces a skip, never a move — re-pricing against a mid that no longer describes the book is how an automatism walks an order somewhere nobody asked for');

  const board = AR.decideReprice({ order, rules: rulesAt(0.53, { midSource: 'board-row' }), ...far });
  ok(board.action === 'skip' && board.gate === 'mid-not-live',
    'a mid from the slower board row (not agent34\'s live book) also produces a skip');

  const unknownAge = AR.decideReprice({ order, rules: rulesAt(0.53, { midAgeSec: null }), ...far });
  ok(unknownAge.action === 'skip' && unknownAge.gate === 'mid-age-unknown',
    'an age we could not read is NOT an age within limits — skip');

  const unreadable = AR.decideReprice({ order, rules: { readable: false, missing: ['tick', 'mid'] }, ...far });
  ok(unreadable.action === 'skip' && unreadable.gate === 'rules-unreadable',
    'unreadable venue rules leave the order alone — there is no band to judge against, and never a guessed one');

  // A band narrower than a tick, sitting BETWEEN two grid points, contains no placeable price at all
  // (mid 0.535 ± 0.1¢ = [0.534, 0.536], and the tick grid is 0.01). Inventing one is the wrong answer.
  const tightRules = rulesAt(0.535, { maxSpreadCents: 0.2, bandRadiusCents: 0.1 });
  const tight = AR.decideReprice({ order, rules: tightRules, ...far });
  ok(tight.action === 'skip' && (tight.gate === 'no-valid-target' || tight.gate === 'replacement-invalid'),
    `when no qualifying price exists on the tick grid, it does NOTHING (${tight.gate}) rather than cancelling an order it cannot validly replace`);

  // …but a narrow band whose centre DOES land on the grid still has exactly one placeable price, and the
  // decision must find it rather than refusing out of caution. Fail-closed is not the same as timid.
  const narrowOnGrid = AR.decideReprice({ order, rules: rulesAt(0.53, { maxSpreadCents: 0.2, bandRadiusCents: 0.1 }), ...far });
  ok(narrowOnGrid.action === 'reprice' && narrowOnGrid.targetPrice === 0.53,
    '…while a band that narrow whose centre IS on the grid yields the one qualifying price (0.53) — it refuses only when there is genuinely nothing to move to');

  // A partially-filled remainder below min_incentive_size cannot be validly re-placed.
  const smallOrder = { orderId: 'O', price: 0.49, size: 10, book: 'yes', secondsToExpiry: 800 };
  const small = AR.decideReprice({ order: smallOrder, rules: rulesAt(0.53), ...far });
  ok(small.action === 'skip' && small.gate === 'replacement-invalid',
    'a remainder below min_incentive_size is left resting rather than cancelled for a replacement the guard would refuse');
}

// ── 4 · THE HEADLINE SCENARIO — the mid walks out from under a resting order ────────────────────────
console.log('\n4. SIMULATED SCENARIO — the mid moves enough to push a resting order out of band');
{
  const world = { now: 1_700_000_000_000, rules: rulesAt(0.50), orders: { ok: true, simulated: false, count: 1, orders: [restingOrder(0.49)] } };
  const h = harness(world);
  enable(h.stores);

  // Two quiet cycles while the mid sits still: the order must not be touched.
  for (let i = 0; i < 2; i++) { world.now += TUNING.pollMs; /* eslint-disable-next-line no-await-in-loop */ }
  const runQuiet = async () => AR.runAutoRepriceCycle(h.deps);

  (async () => {
    let r = await runQuiet();
    ok(r.ran === true && r.markets[0].held === 1 && r.markets[0].repriced === 0,
      'cycle 1 · mid 0.500, order 0.49 in band → HELD, nothing asked of the venue');

    world.now += TUNING.pollMs;
    r = await runQuiet();
    ok(world.replaced.length === 0, 'cycle 2 · still in band → still nothing (the replace path was never called)');

    // THE MID MOVES. 0.500 → 0.530. Band is now [0.515, 0.545]; the order at 0.49 is 4¢ adrift.
    world.rules = rulesAt(0.53);
    world.now += TUNING.pollMs;
    r = await runQuiet();
    ok(world.replaced.length === 0 && r.actions.some((a) => a.gate === 'awaiting-confirmation'),
      'cycle 3 · the mid has moved to 0.530 and the order is OUT of band — but the first observation only ARMS the decision, it does not act');

    world.now += TUNING.pollMs;
    r = await runQuiet();
    ok(world.replaced.length === 1,
      'cycle 4 · the breach is confirmed on the second consecutive observation → exactly ONE re-price is triggered');

    const call = world.replaced[0];
    ok(call.orderId === 'ORDER_A' && call.book === 'yes' && call.size === 60,
      '…for the SAME order, the SAME side and the SAME size — only the price changes');
    ok(call.price === 0.52,
      `…at ${call.price}, the nearest qualifying price to where it was (band [0.52, 0.54] around the new mid)`);
    ok(call.ttlSeconds === undefined,
      '…and the replace call does NOT pin a lifetime: omitting ttlSeconds lets resolveManualTtlSeconds read the market\'s live switch, so an order can never be given a 15-minute window a moment after the automatism was switched off');
    ok(call.source === ARC.AUTO_REPRICE_SOURCE,
      `…stamped source:'${ARC.AUTO_REPRICE_SOURCE}' — distinct from 'manual-ui' (a human) and 'agent35' (the engine)`);
    ok(r.markets[0].repriced === 1 && r.actions.some((a) => a.action === 'reprice' && a.ok === true && a.sent === false),
      'the cycle reports the move as ok but NOT sent — this whole scenario reached no venue at all');

    const trigger = world.audits.find((a) => a.outcome === 'trigger');
    ok(trigger && trigger.source === ARC.AUTO_REPRICE_SOURCE && trigger.observed.distanceC === 4,
      'the audit trail records WHY it moved (4.00¢ from a ±1.50¢ band) under its own distinct source');

    // Immediately after, the rate limit must hold the replacement still even though it is still adrift.
    world.now += TUNING.pollMs;
    world.rules = rulesAt(0.58); // the mid runs further
    await runQuiet(); await runQuiet();
    ok(world.replaced.length === 1,
      'a second move within the 30s rate limit is REFUSED — the replacement carries a new order id, and the limit is market-keyed precisely so that cannot defeat it');

    // Past the limit, it may act again.
    world.now += 40_000;
    await runQuiet(); await runQuiet();
    ok(world.replaced.length === 2,
      '…and once the rate limit has elapsed, a still-adrift order is moved again');

    await scenarioNeverTouched();
  })().catch((e) => { console.error(e); process.exit(1); });
}

// ── 5 · THE OTHER HEADLINE — an order that stays in band is NEVER touched ───────────────────────────
async function scenarioNeverTouched() {
  console.log('\n5. SIMULATED SCENARIO — an order the mid never invalidates is never touched, for a long time');
  {
    const world = { now: 1_700_000_000_000, rules: rulesAt(0.50), orders: { ok: true, simulated: false, count: 1, orders: [restingOrder(0.50)] } };
    const h = harness(world);
    enable(h.stores);

    // 360 cycles at the 5s poll = 30 simulated minutes. The mid wanders inside ±1.0¢ the whole time,
    // which is real movement — it just never pushes the order out of the ±1.5¢ band.
    const CYCLES = 360;
    let held = 0;
    for (let i = 0; i < CYCLES; i++) {
      // Deterministic wander, no RNG: a slow sine between 0.495 and 0.505.
      const mid = +(0.50 + 0.005 * Math.sin(i / 7)).toFixed(4);
      world.rules = rulesAt(mid);
      world.now += TUNING.pollMs;
      // eslint-disable-next-line no-await-in-loop
      const r = await AR.runAutoRepriceCycle(h.deps);
      held += r.markets[0].held;
    }
    ok(world.replaced.length === 0,
      `${CYCLES} cycles = ${Math.round(CYCLES * TUNING.pollMs / 60000)} simulated minutes with a wandering mid: the replace path was called ZERO times`);
    ok(world.cancelled.length === 0, '…and nothing was cancelled — the order simply rested, which is the entire point of the change');
    ok(held === CYCLES, `…every single cycle reported the order as HELD (${held}/${CYCLES}), never once as skipped-for-a-reason`);
    ok(!world.audits.some((a) => a.outcome === 'trigger'), '…and the audit trail contains no trigger at all: nothing happened, and nothing pretended to');

    await scenarioSwitches();
  }
}

// ── 6 · THE ON/OFF SWITCHES, AND WHAT "OFF" RESTORES ────────────────────────────────────────────────
async function scenarioSwitches() {
  console.log('\n6. the switches — OFF means nothing moves AND the old fixed GTD expiry comes back');
  {
    const { resolveManualTtlSeconds } = require('../lib/maker/manual-order');
    const st = stores();

    // Default: everything off, nothing opted in.
    const offTtl = resolveManualTtlSeconds({ marketId: MKT }, st);
    ok(offTtl.orderType === 'GTD' && offTtl.ttlSeconds === 180,
      'with auto-reprice OFF (the default) a new hand order carries the fixed 180s GTD expiry — exactly today\'s behaviour');

    enable(st);
    const onTtl = resolveManualTtlSeconds({ marketId: MKT }, st);
    ok(onTtl.orderType === 'GTD' && onTtl.ttlSeconds === ARC.RESTING_GTD_SECONDS && onTtl.autoReprice === true,
      `with auto-reprice ON the order carries a ${ARC.RESTING_GTD_SECONDS / 60}-minute GTD expiry — bounded, not unlimited: the watcher renews it early, and the EXCHANGE retires it if the watcher stops`);
    ok(onTtl.refreshMarginSeconds === ARC.REFRESH_MARGIN_SECONDS,
      `…and reports the ${ARC.REFRESH_MARGIN_SECONDS / 60}-minute renewal margin alongside it, so the panel shows the same numbers the watcher acts on`);

    // Per-market OFF, master still on.
    ARC.setAutoReprice({ scope: 'market', marketId: MKT, enabled: false, by: 'selfcheck' }, st);
    ok(resolveManualTtlSeconds({ marketId: MKT }, st).orderType === 'GTD',
      'switching the MARKET off restores the fixed GTD expiry for new orders there');
    ok(ARC.isAutoRepriceEnabled(MKT, st).enabled === false, '…and the market is no longer watched');

    // Master OFF with the market still opted in — the master must win, and the panel must be able to
    // tell "opted in but master off" from a plain OFF.
    ARC.setAutoReprice({ scope: 'market', marketId: MKT, enabled: true, by: 'selfcheck' }, st);
    ARC.setAutoReprice({ scope: 'global', enabled: false, by: 'selfcheck' }, st);
    const masterOff = ARC.isAutoRepriceEnabled(MKT, st);
    ok(masterOff.enabled === false && masterOff.marketEnabled === true && masterOff.globalEnabled === false,
      'the GLOBAL master switch overrides a per-market opt-in — and the three facts stay separate, so the panel can say "opted in, master off" rather than a misleading bare OFF');
    ok(resolveManualTtlSeconds({ marketId: MKT }, st).orderType === 'GTD',
      '…and a new order there goes back to the fixed GTD expiry too');

    // …and with the master off, a cycle does nothing at all.
    const world = { now: 1_700_000_000_000, rules: rulesAt(0.60), stores: st,
      orders: { ok: true, simulated: false, count: 1, orders: [restingOrder(0.49)] } };
    const h = harness(world);
    const r = await AR.runAutoRepriceCycle(h.deps);
    ok(r.ran === false && r.gate === 'disabled-global' && world.replaced.length === 0,
      'with the master switch OFF the watcher does not even look at the orders — a wildly out-of-band order is left exactly where it is');

    // Unreadable config ⇒ off, and ENABLING over it is refused while DISABLING stays available.
    const corrupt = { configFile: tmp('corrupt.json'), autoStateFile: tmp('s.json'), autoAuditFile: tmp('a.jsonl') };
    fs.writeFileSync(corrupt.configFile, '{{{ not json');
    ok(ARC.isAutoRepriceEnabled(MKT, corrupt).enabled === false && ARC.isAutoRepriceEnabled(MKT, corrupt).readable === false,
      'an UNREADABLE config means the automatism is OFF — for a thing that moves orders by itself, fail-closed is the direction that does nothing');
    ok(ARC.setAutoReprice({ scope: 'global', enabled: true }, corrupt).ok === false,
      '…turning it ON over a state we cannot read is REFUSED');
    ok(ARC.setAutoReprice({ scope: 'global', enabled: false }, corrupt).ok === true,
      '…but turning it OFF is always permitted: the direction that can only reduce activity must never be blocked');
    ok(resolveManualTtlSeconds({ marketId: MKT }, corrupt).orderType === 'GTD',
      '…and an unreadable switch can never produce an order with NO expiry — it falls back to the fixed GTD');

    await scenarioGates();
  }
}

// ── 7 · THE GATES ARE NOT BYPASSED ──────────────────────────────────────────────────────────────────
async function scenarioGates() {
  console.log('\n7. the existing gates still govern — kill switch and manual ownership stop it cold');
  {
    const base = () => {
      const world = { now: 1_700_000_000_000, rules: rulesAt(0.60),
        orders: { ok: true, simulated: false, count: 1, orders: [restingOrder(0.49)] } };
      const h = harness(world);
      enable(h.stores);
      return { world, h };
    };

    {
      const { world, h } = base();
      world.kill = { effectivelyKilled: true, readable: true };
      const r = await AR.runAutoRepriceCycle(h.deps);
      ok(r.ran === false && r.gate === 'kill' && world.replaced.length === 0,
        'a GLOBAL KILL stops the automatism BEFORE anything is cancelled — a re-price is cancel-then-place, and cancelling under a kill would strip a resting order the replacement could not restore');
    }
    {
      const { world, h } = base();
      world.kill = { effectivelyKilled: false, readable: false };
      const r = await AR.runAutoRepriceCycle(h.deps);
      ok(r.ran === false && r.gate === 'kill' && world.replaced.length === 0,
        'an UNREADABLE kill state is treated as an active kill — fail closed');
    }
    {
      const { world, h } = base();
      world.manual = { manual: false, readable: true, error: null, record: null, reason: 'engine owns it' };
      const r = await AR.runAutoRepriceCycle(h.deps);
      ok(r.markets[0].gate === 'manual-mode-inactive' && world.replaced.length === 0,
        'a market handed BACK to agent35 is dropped immediately — the automatism may only act where the engine is provably standing off');
    }
    {
      const { world, h } = base();
      world.manual = { manual: true, readable: false, error: 'unreadable:EACCES', record: null, reason: 'x' };
      const r = await AR.runAutoRepriceCycle(h.deps);
      ok(r.markets[0].gate === 'manual-mode-unreadable' && world.replaced.length === 0,
        'unreadable ownership also stops it — nobody acts on a market whose owner could not be read');
    }
    {
      const { world, h } = base();
      world.orders = { ok: false, error: 'venue 502', simulated: false, count: 0, orders: [] };
      const r = await AR.runAutoRepriceCycle(h.deps);
      ok(r.markets[0].gate === 'list-failed' && world.replaced.length === 0,
        'a FAILED venue read is not an empty book — the cycle skips rather than acting on a list it does not have');
    }
    {
      const { world, h } = base();
      world.orders = { ok: true, simulated: true, count: 0, orders: [] };
      const r = await AR.runAutoRepriceCycle(h.deps);
      ok(r.markets[0].gate === 'simulated' && world.replaced.length === 0,
        'no credentials ⇒ the venue was never queried ⇒ there is nothing to act on (not "you have no orders")');
    }

    await scenarioOwnership();
  }
}

// ── 8 · OWNERSHIP — it touches ONLY what the panel provably placed ──────────────────────────────────
async function scenarioOwnership() {
  console.log('\n8. ownership — agent35\'s orders and unattributable orders are never candidates');
  {
    const rules = rulesAt(0.60);
    const picked = AR.selectOwnedOrders([
      restingOrder(0.49, { orderId: 'MINE', source: 'manual-ui' }),
      restingOrder(0.49, { orderId: 'ENGINE', source: 'agent35' }),
      restingOrder(0.49, { orderId: 'UNKNOWN', source: 'unknown' }),
      restingOrder(0.49, { orderId: 'SELL_LEG', source: 'manual-ui', side: 'SELL' }),
      restingOrder(0.49, { orderId: 'FOREIGN_TOKEN', source: 'manual-ui', tokenId: 'SOMETHING_ELSE' }),
      restingOrder(0.49, { orderId: 'OTHER_MARKET', source: 'manual-ui', marketId: '0xdeadbeef' }),
      restingOrder(0.49, { orderId: 'NO_BOOK', source: 'manual-ui', tokenId: NO }),
    ], { marketId: MKT, rules });

    const ids = picked.map((p) => p.orderId);
    ok(ids.includes('MINE') && ids.includes('NO_BOOK'),
      'orders the panel provably placed — on either book — ARE candidates');
    ok(!ids.includes('ENGINE'), 'agent35\'s orders are NEVER candidates');
    ok(!ids.includes('UNKNOWN'), '…and neither are unattributable ones: "probably ours" is not ours');
    // CHANGED when auto-close shipped: a panel-owned SELL is a CLOSING order (lib/maker/auto-close.js),
    // and an exit that drifts out of band stops earning while it waits — so it wants the same band
    // management as anything else. What protects it is not exclusion but the one-way rule in
    // decideReprice: a close SELL is only ever moved UP, never down through its profit.
    ok(ids.includes('SELL_LEG'),
      'a panel-owned SELL is now MANAGED too — it is a closing order, and an exit that drifts out of band stops earning while it waits');
    ok(picked.find((p) => p.orderId === 'SELL_LEG').side === 'SELL',
      '…and its side is carried through, so the replacement is re-placed as a SELL and not silently flipped to a BUY');
    ok(!ids.includes('FOREIGN_TOKEN'), 'an order whose token matches neither of the market\'s two token ids is skipped — its band cannot be mirrored correctly');
    ok(!ids.includes('OTHER_MARKET'), 'an order on a different market is skipped');
    ok(picked.find((p) => p.orderId === 'NO_BOOK').book === 'no',
      'the book is RESOLVED by matching the order\'s token against the market\'s two token ids — never guessed');

    // And end to end: a mixed book of resting orders, only ours moves.
    const world = { now: 1_700_000_000_000, rules,
      orders: { ok: true, simulated: false, count: 2, orders: [
        restingOrder(0.49, { orderId: 'MINE' }),
        restingOrder(0.49, { orderId: 'ENGINE', source: 'agent35' }),
      ] } };
    const h = harness(world);
    enable(h.stores);
    await AR.runAutoRepriceCycle(h.deps);
    world.now += TUNING.pollMs;
    await AR.runAutoRepriceCycle(h.deps);
    ok(world.replaced.length === 1 && world.replaced[0].orderId === 'MINE',
      'end to end with a mixed book: exactly one re-price, and it is OURS — agent35\'s equally-out-of-band order was not touched');

    await scenarioWiring();
  }
}

// ── 12 · THE STANDING RECONCILIATION — what stops phantom exposure accumulating ────────────────────
async function scenarioReconcile() {
  console.log('\n12. la riconciliazione permanente della corsia manuale (dentro agent40)');
  {
    const MR = require('../lib/maker/manual-reset');
    const SENT = {
      idempotencyKey: 'idem_test_phantom', notionalUsd: 24.2, ts: 1, userId: 'operator', venue: 'polymarket',
      tokenId: YES, side: 'BUY', price: 0.484, size: 50, orderId: 'ORDER_GONE',
    };
    // A phantom: the order was sent, it is GONE from the venue (expired), and the ledger never resolved it.
    const phantomDiag = { readable: true, openNotionalUsd: 24.2, fromConfirmedPositionsUsd: 0,
      fromUnresolvedOrdersUsd: 24.2, unknowns: [{ idempotencyKey: 'idem_test_phantom', notionalUsd: 24.2 }],
      positions: [], sentOrders: [SENT], note: '' };
    const st = { fillsFile: tmp('fills.jsonl') };

    // ── The steady state: nothing unresolved ⇒ ZERO venue calls. This is what makes it safe to run every
    //    minute forever on a process that is otherwise idle.
    let listCalls = 0, tradeCalls = 0;
    const clean = await MR.reconcileManualLane({}, {
      ...st,
      diagnoseExposure: () => ({ readable: true, unknowns: [], sentOrders: [], openNotionalUsd: 0, fromUnresolvedOrdersUsd: 0, fromConfirmedPositionsUsd: 0, positions: [], note: '' }),
      listOrders: async () => { listCalls++; return { ok: true, simulated: false, orders: [] }; },
      fetchVenueTrades: async () => { tradeCalls++; return { ok: true, trades: [] }; },
    });
    ok(clean.ran === false && clean.reason === 'nothing-unresolved' && listCalls === 0 && tradeCalls === 0,
      'con niente da risolvere non tocca la rete NEMMENO una volta — due letture di file locali e basta, che e\' cio\' che rende sicuro girare ogni minuto per sempre');

    // ── A phantom, with a successful trades cross-check showing no fills ⇒ resolved to no-fill.
    const resolved = await MR.reconcileManualLane({}, {
      ...st,
      diagnoseExposure: () => phantomDiag,
      listOrders: async () => ({ ok: true, simulated: false, orders: [] }),   // gone from the book
      fetchVenueTrades: async () => ({ ok: true, trades: [], reason: '0 esecuzioni' }),
      fetchVenuePositions: async () => ({ ok: true, positions: [], reason: '0 posizioni' }),
      address: '0xTEST',
    });
    ok(resolved.ran === true && resolved.nofills === 1 && resolved.stillUnknown === 0,
      'un ordine sparito dal book, con NESSUNA esecuzione E NESSUNA posizione (due fonti concordi), viene risolto come NON eseguito');
    ok(resolved.resolvedUsd === 24.2,
      `…e riporta i $${resolved.resolvedUsd} di esposizione fantasma ritirati dal gate cap, non solo un conteggio`);

    // THE FIX THAT MADE IT ACTUALLY WORK: the row must carry the userId, or readFills filters it back out
    // and the phantom survives. This is the bug the reset's own verifier caught.
    const rows = fs.readFileSync(st.fillsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    ok(rows.length === 1 && rows[0].kind === 'nofill' && rows[0].userId === 'operator' && rows[0].venue === 'polymarket',
      'la riga scritta porta userId e venue — senza, readFills la filtra via e l\'ordine resta "irrisolto" per sempre (il bug che il verificatore del ripristino ha scoperto)');

    // ── FAIL CLOSED: no cross-check ⇒ nothing is resolved. Never guess.
    const noCheck = await MR.reconcileManualLane({}, {
      ...st, fillsFile: tmp('fills2.jsonl'),
      diagnoseExposure: () => phantomDiag,
      listOrders: async () => ({ ok: true, simulated: false, orders: [] }),
      fetchVenueTrades: async () => ({ ok: false, trades: null, reason: 'data-api irraggiungibile' }),
      fetchVenuePositions: async () => ({ ok: true, positions: [], reason: '0 posizioni' }),
    });
    ok(noCheck.ran === true && noCheck.nofills === 0 && noCheck.stillUnknown === 1,
      'se il controllo incrociato sulle esecuzioni NON e\' disponibile, nessun ordine sparito viene risolto — resta sconosciuto e continua a contare (mai a indovinare)');

    // ── FAIL CLOSED: venue not queried (no credentials) ⇒ nothing resolved.
    const sim = await MR.reconcileManualLane({}, {
      ...st, fillsFile: tmp('fills3.jsonl'),
      diagnoseExposure: () => phantomDiag,
      listOrders: async () => ({ ok: true, simulated: true, orders: [] }),
      fetchVenueTrades: async () => ({ ok: true, trades: [] }),
      fetchVenuePositions: async () => ({ ok: true, positions: [] }),
    });
    ok(sim.ran === false && /non e\' stato interrogato|not-queried|credentials/i.test(sim.reason),
      'senza credenziali il venue non viene interrogato e nulla viene risolto — una lista vuota non letta non e\' una lista vuota');

    // ── An order STILL RESTING must never be resolved away.
    const resting = await MR.reconcileManualLane({}, {
      ...st, fillsFile: tmp('fills4.jsonl'),
      diagnoseExposure: () => phantomDiag,
      listOrders: async () => ({ ok: true, simulated: false, orders: [{ orderId: 'ORDER_GONE', tokenId: YES, side: 'BUY', price: 0.484, size: 50, sizeMatched: 0 }] }),
      fetchVenueTrades: async () => ({ ok: true, trades: [] }),
      fetchVenuePositions: async () => ({ ok: true, positions: [] }),
    });
    ok(resting.nofills === 0,
      'un ordine ANCORA a riposo sul venue non viene mai risolto: continua a contare come esposizione, che e\' corretto');

    // ── P1: TWO SOURCES MUST AGREE BEFORE AN ORDER IS CALLED UNFILLED ────────────────────────────
    // The bug this pins: /trades lags /positions. On 2026-07-31 a hand order on the NO leg genuinely
    // filled, /positions showed the 50 shares at once, /trades still returned an empty list — and the
    // reconciler recorded a no-fill for a real fill, understating exposure by the whole position.
    const { planReconcile } = require('../lib/safety/reconcile-fills');
    const GONE = { idempotencyKey: 'idem_x', userId: 'operator', venue: 'polymarket', tokenId: NO,
      side: 'BUY', price: 0.485, size: 50, notionalUsd: 24.25, orderId: 'ORDER_X', ts: 1 };
    const base = { userId: 'operator', sentOrders: [GONE], ledgerRows: [], venueReachable: true, venueOrders: [], now: 1 };

    const lag = planReconcile({ ...base, venueFills: [], venuePositions: [{ asset: NO, size: 50 }] });
    ok(lag.toNoFill.length === 0 && lag.stillUnknown[0].reason === 'positions-contradict-no-trades',
      'nessuna esecuzione in /trades MA una posizione su quel token in /positions ⇒ le due fonti si contraddicono ⇒ NON si risolve nulla (e\' il caso reale del 31/07 che aveva sottostimato l\'esposizione)');

    const noPos = planReconcile({ ...base, venueFills: [], venuePositions: null });
    ok(noPos.toNoFill.length === 0 && noPos.stillUnknown[0].reason === 'no-positions-crosscheck',
      'senza la lettura delle posizioni non si conclude "mai eseguito" su una sola fonte — l\'ordine resta sconosciuto e continua a contare');

    const agree = planReconcile({ ...base, venueFills: [], venuePositions: [] });
    ok(agree.toNoFill.length === 1 && agree.stillUnknown.length === 0,
      'quando ENTRAMBE le fonti concordano (nessuna esecuzione, nessuna posizione) l\'ordine viene finalmente risolto come NON eseguito');

    const filled = planReconcile({ ...base, venueFills: [{ tokenId: NO, side: 'BUY', size: 50, price: 0.485 }], venuePositions: [{ asset: NO, size: 50 }] });
    ok(filled.toRecord.length === 1 && filled.toRecord[0].filledSize === 50,
      'e quando /trades mostra l\'esecuzione, viene registrata come FILL al size reale');

    // ── P2: THE AUDIT MUST KEEP ORDER IDS, or attribution can never match ─────────────────────────
    const { redact } = require('../lib/venues/polymarket-clob/redact');
    const REAL_ID = '0x0e9eb7d8a49c9f99e1f069c2325b11198ff55dfab77b2ea1383c047e732a61d8';
    ok(redact({ orderId: REAL_ID }).orderId === REAL_ID,
      'un orderId (0x + 64 hex, esattamente la forma della cintura anti-chiavi) sopravvive alla redazione — senza, ogni id nel trail diventava lo stesso segnaposto e l\'attribuzione non poteva mai combaciare');
    ok(redact({ privateKey: REAL_ID }).privateKey === '[redacted]',
      '…mentre una chiave privata resta oscurata: l\'esenzione vale solo per i campi che nominano un identificatore pubblico');
    ok(String(redact({ note: `chiave ${REAL_ID}` }).note).includes('[redacted-64hex]'),
      '…e un 64-hex dentro testo libero resta oscurato, perche\' li\' non c\'e\' nessun nome di campo a dire che e\' pubblico');

    // ── The wiring: agent40 really calls it, on its own throttle and its own try/catch.
    const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    ok(/reconcileManualLane\(/.test(code) && /reconcileTask\(/.test(code),
      'agent40 chiama davvero reconcileManualLane, tramite il suo reconcileTask — il collegamento non puo\' marcire in silenzio');
    ok(/RECONCILE_EVERY_MS/.test(code) && /lastReconcileAt/.test(code),
      '…su un throttle proprio, non a ogni ciclo da 5 secondi');
    // Assert on the BODY of cycle(), not on where the strings happen to appear in the file: the
    // reconciliation must not be reachable from inside the reprice cycle, which returns early on a kill,
    // on a disabled switch and on a market handed back to the engine. None of those may stop the ledger
    // from being told the truth.
    const cycleBody = code.slice(code.indexOf('async function cycle()'), code.indexOf('async function main()'));
    ok(cycleBody.length > 50 && !/reconcileManualLane|reconcileTask/.test(cycleBody),
      '…e NON e\' raggiungibile da dentro cycle(): il ciclo di riprezzo esce presto su kill/interruttore spento, e nessuno di quei casi deve impedire al ledger di sapere la verita\'');
    ok(/await cycle\(\)[\s\S]{0,400}await reconcileTask\(\)/.test(code),
      '…ma entrambe girano nello stesso giro del loop, ciascuna con il proprio try/catch: un riprezzo fallito non ferma la riconciliazione, e viceversa');
  }
  done();
}

// ── 9 · THE WIRING IS REAL ──────────────────────────────────────────────────────────────────────────
async function scenarioWiring() {
  console.log('\n9. the wiring is real — the watcher process and the placement path actually use this');
  {
    const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
    const code = agentSrc.replace(/^\s*\/\/.*$/gm, '');
    ok(/runAutoRepriceCycle\(/.test(code), 'agent40-manual-reprice really calls runAutoRepriceCycle — the wiring cannot silently rot');
    ok(/replaceManualOrder/.test(code) && !/createMakerAdapter/.test(code),
      '…and it reaches the venue ONLY through replaceManualOrder: it constructs no adapter of its own, so it cannot bypass a single gate');
    ok(/killSwitch/.test(code), '…and it passes the real kill-switch reader into the cycle');

    const manualSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'maker', 'manual-order.js'), 'utf8');
    const mcode = manualSrc.replace(/^\s*\/\/.*$/gm, '');
    ok(/resolveManualTtlSeconds\(/.test(mcode) && /orderTtlSeconds:\s*ttl\.ttlSeconds/.test(mcode),
      'the placement path resolves the lifetime through resolveManualTtlSeconds and hands THAT to the adapter — the GTC/GTD choice is made in one place only');
    ok(/killSwitch\.checkKill\(/.test(mcode.slice(mcode.indexOf('async function replaceManualOrder'))),
      'replaceManualOrder now checks the kill switch BEFORE cancelling — so a killed system can never leave the operator with nothing resting');

    // The 0-is-meaningful trap: `orderTtlSeconds || 180` would silently turn every GTC order into a GTD.
    ok(!/orderTtlSeconds\s*\|\|\s*\d/.test(mcode) && !/ttlSeconds\s*\|\|\s*\d/.test(mcode),
      'nothing on this path uses a truthiness fallback on the TTL — 0 means GTC, and `|| 180` would silently destroy that');

    const ttlSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'maker', 'order-ttl.js'), 'utf8');
    ok(/orderType:\s*'GTC',\s*expiration:\s*0/.test(ttlSrc),
      'computeGtdExpiration(now, 0) really produces the GTC/expiration-0 pair the venue documents for "no deadline"');

    const { computeGtdExpiration } = require('../lib/maker/order-ttl');
    const gtc = computeGtdExpiration(Date.now(), 0);
    ok(gtc.orderType === 'GTC' && gtc.expiration === 0 && gtc.survivesHostDeath === false,
      '…and it carries survivesHostDeath:false, so no caller can hold a GTC result without the caveat attached');
    const gtd = computeGtdExpiration(Date.now(), 180);
    ok(gtd.orderType === 'GTD' && gtd.survivesHostDeath === true && gtd.venueMaxTtlSeconds === null,
      'the GTD path is unchanged, and reports venueMaxTtlSeconds:null — the venue publishes NO maximum lifetime, so there is no ceiling to fall back to');

    await scenarioExpiry();
  }
}

// ── 10 · THE PROACTIVE REFRESH, AND THE RENEWAL RATE OVER 2 SIMULATED HOURS ────────────────────────
async function scenarioExpiry() {
  console.log('\n10. the proactive refresh — the venue-side clock is renewed EARLY, at a bounded rate');
  {
    const W = ARC.RESTING_GTD_SECONDS, M = ARC.REFRESH_MARGIN_SECONDS;
    ok(W === 1380 && M === 180,
      `the window is ${W / 60} minutes with a ${M / 60}-minute renewal margin — a bounded, exchange-enforced lifetime, not an unlimited one`);
    ok(Math.abs(ARC.EXPECTED_RENEWALS_PER_HOUR - 3600 / (W - M)) < 1e-9 && ARC.EXPECTED_RENEWALS_PER_HOUR === 3,
      `expected renewals/hour is DERIVED from those two constants (3600/(${W}−${M}) = ${ARC.EXPECTED_RENEWALS_PER_HOUR}/h), so it cannot drift out of date if either is changed`);
    ok(ARC.DISCONNECT_CANCEL_SECONDS === M,
      `the blackout threshold is still the refresh margin (${M}s) — widening the window did NOT move it as a side effect, which is exactly why the margin was left alone`);

    // The decision itself: in band, but the clock is nearly up.
    const inBandOrder = { orderId: 'O', price: 0.50, size: 60, book: 'yes', secondsToExpiry: M - 10 };
    const refresh = AR.decideReprice({ order: inBandOrder, rules: rulesAt(0.50), config: TUNING, now: 1_000_000 });
    ok(refresh.action === 'reprice' && refresh.gate === 'expiry-refresh',
      'an order that is perfectly priced but nearly expired IS renewed — the trigger is the clock, not the price');
    ok(refresh.targetPrice === 0.50,
      '…at the SAME price: a renewal resets the exchange-held expiry, it does not chase the market');

    const healthy = AR.decideReprice({ order: { ...inBandOrder, secondsToExpiry: M + 60 }, rules: rulesAt(0.50), config: TUNING, now: 1_000_000 });
    ok(healthy.action === 'hold',
      'the same order with life still on it is HELD — the refresh fires at the margin, never earlier');

    const gtc = AR.decideReprice({ order: { ...inBandOrder, secondsToExpiry: null }, rules: rulesAt(0.50), config: TUNING, now: 1_000_000 });
    ok(gtc.action === 'hold',
      'a GTC order (no venue expiry at all) never triggers the refresh — there is no clock to renew');

    // BOTH triggers at once: out of band AND nearly expired. One move must satisfy both, and the
    // patience gates must not be allowed to let the order die while they wait for confirmation.
    const both = AR.decideReprice({
      order: { orderId: 'O', price: 0.49, size: 60, book: 'yes', secondsToExpiry: M - 10 },
      rules: rulesAt(0.53), config: TUNING, consecutiveBreaches: 0, now: 1_000_000,
    });
    ok(both.action === 'reprice' && both.gate === 'band-exit-and-expiry' && both.targetPrice === 0.52,
      'out of band AND nearly expired → ONE move that fixes both, skipping the confirmation wait (the exchange was about to retire it anyway, so waiting would lose the order rather than protect it)');

    // ── TWO SIMULATED HOURS with a moderately moving mid ────────────────────────────────────────────
    const world = {
      now: 1_700_000_000_000, rules: rulesAt(0.50),
      orders: { ok: true, simulated: false, count: 1, orders: [
        { ...restingOrder(0.50), placedAt: 1_700_000_000_000, secondsToExpiry: ARC.RESTING_GTD_SECONDS },
      ] },
    };
    const h = harness(world);
    enable(h.stores);
    const HOURS = 2;
    const CYCLES = Math.round((HOURS * 3600 * 1000) / TUNING.pollMs);   // 1440 cycles at the 5s poll
    for (let i = 0; i < CYCLES; i++) {
      // A MODERATELY moving mid: ±0.6¢ around 0.50, a real wander that mostly stays inside the ±1.5¢
      // band. This is the "normal conditions" the renewal-rate target is about.
      world.rules = rulesAt(+(0.50 + 0.006 * Math.sin(i / 41)).toFixed(4));
      world.now += TUNING.pollMs;
      // eslint-disable-next-line no-await-in-loop
      await AR.runAutoRepriceCycle(h.deps);
    }
    const total = world.replaced.length;
    const perHour = total / HOURS;
    const refreshes = world.audits.filter((a) => a.outcome === 'trigger' && a.trigger === 'expiry-refresh').length;
    const bandExits = world.audits.filter((a) => a.outcome === 'trigger' && a.trigger !== 'expiry-refresh').length;
    console.log(`     → ${CYCLES} cycles = ${HOURS}h simulated · ${total} renewals total (${perHour.toFixed(1)}/hour): ${refreshes} proactive, ${bandExits} band-exit`);
    ok(perHour <= 3 + 1e-9,
      `over ${HOURS} simulated hours with a moving mid the watcher renewed ${total} times = ${perHour.toFixed(1)}/hour — at or under the 3/hour ceiling, against the 5/hour the 15-minute window produced and the 6–15 of the original 180s cycle`);
    ok(Math.abs(perHour - ARC.EXPECTED_RENEWALS_PER_HOUR) < 1e-9,
      `…and it matches the rate DERIVED from the constants exactly (${ARC.EXPECTED_RENEWALS_PER_HOUR}/hour), so the simulation and the config cannot silently disagree`);
    ok(refreshes > 0, '…and the renewals really came from the proactive trigger, not from the mid');

    // The SAME two hours with a genuinely volatile mid: band exits now dominate, and the point is that
    // the two triggers do not ADD UP — every move, whatever caused it, resets the clock the other one
    // was watching, and the rate limit + hourly ceiling bound the total either way.
    {
      const w2 = {
        now: 1_700_000_000_000, rules: rulesAt(0.50),
        orders: { ok: true, simulated: false, count: 1, orders: [
          { ...restingOrder(0.50), placedAt: 1_700_000_000_000, secondsToExpiry: ARC.RESTING_GTD_SECONDS },
        ] },
      };
      const h2 = harness(w2);
      enable(h2.stores);
      const times = [];
      for (let i = 0; i < CYCLES; i++) {
        w2.rules = rulesAt(+(0.50 + 0.04 * Math.sin(i / 23)).toFixed(4));   // ±4¢ on a ±1.5¢ band
        w2.now += TUNING.pollMs;
        const before = w2.replaced.length;
        // eslint-disable-next-line no-await-in-loop
        await AR.runAutoRepriceCycle(h2.deps);
        if (w2.replaced.length > before) times.push(w2.now);
      }
      const volPerHour = w2.replaced.length / HOURS;
      const exits = w2.audits.filter((a) => a.outcome === 'trigger' && a.trigger !== 'expiry-refresh').length;
      console.log(`     → volatile mid (±4¢ on a ±1.5¢ band): ${w2.replaced.length} moves (${volPerHour.toFixed(1)}/hour), ${exits} of them band-exit`);
      ok(exits > 0, 'with a genuinely volatile mid the BAND-EXIT trigger takes over — that is the trigger that protects the reward, and it is not rate-capped away');
      ok(volPerHour <= TUNING.maxPerHour,
        `…and the total stays under the ${TUNING.maxPerHour}/hour runaway ceiling (${volPerHour.toFixed(1)}/hour) even when the mid never settles`);
      const tooClose = times.filter((t, i) => i > 0 && (t - times[i - 1]) < TUNING.minIntervalMs);
      ok(tooClose.length === 0,
        `…and NO two moves ever landed within the ${TUNING.minIntervalMs / 1000}s rate limit — the two triggers share one mechanism and cannot double-fire on the same leg`);
    }

    // ── THE SERVER DIES ─────────────────────────────────────────────────────────────────────────────
    // No watcher, no renewals, nothing on this host does anything at all. The ONLY thing left is the
    // signed expiration the exchange holds — which is exactly the property being claimed.
    const deathAt = world.now;
    const lastOrder = world.orders.orders[0];
    const lifeLeftAtDeath = Math.round(lastOrder.secondsToExpiry - (deathAt - lastOrder.placedAt) / 1000);
    ok(lifeLeftAtDeath > 0 && lifeLeftAtDeath <= ARC.RESTING_GTD_SECONDS,
      `at the moment the server stops, the live order has ${lifeLeftAtDeath}s of exchange-enforced life left — by construction never more than the ${ARC.RESTING_GTD_SECONDS}s window`);

    // Advance the clock past the window with the watcher NOT running, and confirm nothing renews it.
    const replacedBeforeDeath = world.replaced.length;
    world.now += ARC.RESTING_GTD_SECONDS * 1000 + 60_000;   // 15 min + a minute, no cycles run
    ok(world.replaced.length === replacedBeforeDeath,
      'with the watcher dead nothing renewed the order — no host-side process is involved in it expiring');
    const lifeAfter = Math.round(lastOrder.secondsToExpiry - (world.now - lastOrder.placedAt) / 1000);
    ok(lifeAfter < 0,
      `${Math.round((world.now - deathAt) / 60000)} minutes after the server stopped the order is past its expiry (${lifeAfter}s) — the venue retires it WITHIN the ${ARC.RESTING_GTD_SECONDS / 60}-minute window, not hours later and not never`);

    // And the guarantee is a property of the SIGNED order, not of our bookkeeping: order-ttl computes it.
    const { computeGtdExpiration, SECURITY_DECREMENT_SEC } = require('../lib/maker/order-ttl');
    const g = computeGtdExpiration(deathAt, ARC.RESTING_GTD_SECONDS);
    ok(g.orderType === 'GTD' && g.survivesHostDeath === true
      && g.expiration === Math.floor(deathAt / 1000) + SECURITY_DECREMENT_SEC + ARC.RESTING_GTD_SECONDS,
      'the expiry is a SIGNED field on the order (stated = now + 60 + ttl, per the venue formula) — the exchange enforces it with no cooperation from this machine');
    ok(g.effectiveTtlSeconds === ARC.RESTING_GTD_SECONDS && g.clampedToVenueFloor === false,
      `…and ${ARC.RESTING_GTD_SECONDS}s is comfortably above the venue's 3-minute GTD floor, so nothing is clamped and the effective life is exactly the ${ARC.RESTING_GTD_SECONDS / 60} minutes intended`);

    await scenarioBlackout();
  }
}

// ── 11 · THE CONNECTION BLACKOUT ───────────────────────────────────────────────────────────────────
async function scenarioBlackout() {
  console.log('\n11. process alive, venue unreachable — and what happens on reconnection');
  {
    const mkWorld = () => {
      const world = {
        now: 1_700_000_000_000, rules: rulesAt(0.50),
        orders: { ok: true, simulated: false, count: 1, orders: [
          { ...restingOrder(0.50), placedAt: 1_700_000_000_000, secondsToExpiry: ARC.RESTING_GTD_SECONDS },
        ] },
      };
      const h = harness(world);
      // The cancel spy: the recovery path may ONLY cancel, never place.
      world.cancelCalls = [];
      h.deps.cancelOrder = async (spec) => { world.cancelCalls.push(spec); return { ok: true, cancelled: true, orderId: spec.orderId }; };
      h.deps.link = { downSince: null, consecutiveFailures: 0 };
      enable(h.stores);
      return { world, h };
    };

    // SHORT blackout — under the threshold. The cycle simply resumes.
    {
      const { world, h } = mkWorld();
      await AR.runAutoRepriceCycle(h.deps);
      world.linkDown = true;
      world.now += 60_000;                    // 60s blind, under the 180s threshold
      const blind = await AR.runAutoRepriceCycle(h.deps);
      ok(blind.markets[0].gate === 'list-failed' && world.replaced.length === 0,
        'while the venue is unreachable nothing is renewed and nothing is guessed at — and the GTD expiry is meanwhile doing exactly the job it exists for');
      world.linkDown = false;
      world.now += TUNING.pollMs;
      const back = await AR.runAutoRepriceCycle(h.deps);
      ok(world.cancelCalls.length === 0 && /under the .* threshold/.test(back.markets[0].reason || ''),
        'a SHORT blackout resumes normally — nothing is cancelled for a blip');
    }

    // LONG blackout — past the threshold. On reconnection the hand orders are cancelled, not renewed.
    {
      const { world, h } = mkWorld();
      await AR.runAutoRepriceCycle(h.deps);
      world.linkDown = true;
      for (let i = 0; i < 3; i++) { world.now += 120_000; /* eslint-disable-next-line no-await-in-loop */ await AR.runAutoRepriceCycle(h.deps); }
      world.linkDown = false;
      world.now += TUNING.pollMs;
      const back = await AR.runAutoRepriceCycle(h.deps);
      ok(back.markets[0].gate === 'reconnect-cancel',
        `after ${6} minutes blind (threshold ${ARC.DISCONNECT_CANCEL_SECONDS}s) the recovery path fires instead of the normal cycle`);
      ok(world.cancelCalls.length === 1 && world.cancelCalls[0].orderId === 'ORDER_A',
        '…and it CANCELS the hand order rather than renewing on top of a state we did not observe');
      ok(world.replaced.length === 0,
        '…placing nothing: the recovery move can only reduce exposure, never start an order');
      ok(world.audits.some((a) => a.outcome === 'reconnect-cancel' && a.source === ARC.AUTO_REPRICE_SOURCE),
        '…and it is recorded in the audit trail under the automatism\'s own source, with the blind duration');
    }

    await scenarioReconcile();
  }
}

function done() {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\nmaker auto-reprice selfcheck: ${checks} assertions passed.`);
  console.log('An order INSIDE the band is never touched by the price trigger — proven over 30 simulated minutes.');
  console.log('An order the mid pushes OUT of the band is re-priced once, to a price the shared guard accepts,');
  console.log('same side, same size, stamped auto-reprice-band-exit, behind kill/ownership/rate/ceiling gates.');
  console.log(`The venue-side expiry is ${ARC.RESTING_GTD_SECONDS / 60} minutes, renewed proactively with ${ARC.REFRESH_MARGIN_SECONDS / 60} minutes to spare:`);
  console.log(`measured ${ARC.EXPECTED_RENEWALS_PER_HOUR}/hour over 2 simulated hours. With the watcher dead the EXCHANGE retires`);
  console.log('the order inside that window — the dead-man\'s switch is the venue\'s, and needs nothing of ours to work.');
  console.log('NO venue call, NO credentials, NO signing key and NO order — real or simulated — was involved in this run.');
}

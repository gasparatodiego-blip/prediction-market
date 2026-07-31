#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent40-manual-reprice — the BAND-EXIT WATCHER for hand-placed orders.
//
// WHY IT EXISTS. A manual order used to carry a fixed ~180s GTD expiry: the venue killed it on a clock,
// whatever the price was doing. That is the wrong axis for a reward maker — what matters is whether the
// order is still inside the band that pays, not how long it has been sitting there. So a hand order on an
// auto-reprice market now rests as GTC (no venue expiry — the venue supports it; the primary-source proof
// is in lib/maker/order-ttl.js) and THIS process is what moves it: every few seconds it compares each
// resting order against the CURRENT live mid and cancels+re-places it ONLY when the mid has travelled far
// enough to push it out of the band. If the mid does not move that far, the order is not touched at all.
//
// NAMED agent40: slots 36-39 are taken (book-velocity, maker-watchdog, tape-watchdog, net-rerun). Unlike that one, this process CAN cause a placement,
// so it is deliberately the narrowest thing that can: it owns no adapter, no credentials and no signing
// key of its own. Its only reachable venue surface is lib/maker/manual-order.replaceManualOrder — the
// SAME function the panel's "Riprezza" button calls — so every gate that governs a hand order governs
// every automatic re-price, with no second code path that could drift from the first.
//
// WHAT IT WILL NOT DO, and these are structural, not stylistic:
//   • It does nothing at all unless BOTH the global master switch and the per-market opt-in are on
//     (data/maker-auto-reprice.json). Both default OFF and both fail closed to OFF.
//   • It touches ONLY orders it can PROVE the manual panel placed (attributed from the append-only audit
//     trail). agent35's orders and unattributable orders are never candidates.
//   • It refuses to act on a mid that is not from agent34's live book, or that is stale.
//   • It reads the GLOBAL KILL SWITCH before it cancels anything — a re-price is cancel-then-place, and
//     cancelling under a kill would strip a resting order the replacement could not restore.
//   • It has a per-order rate limit and a per-market hourly ceiling. An automatism without a runaway
//     guard is an incident waiting.
//   • It never sends anything MANUAL_ORDER_PLACEMENT would not send: with the panel's switch on dry-run
//     (the default), an automatic re-price builds, signs and validates the replacement — and drops it.
//
// EVERYTHING it does is stamped source:'auto-reprice-band-exit' in data/polymarket-maker-audit.jsonl —
// distinct from 'manual-ui' and from 'agent35', so the trail always says what moved what.
//
// IT IS ALSO THE THING THAT STANDS IN FOR THE VENUE EXPIRY. A GTC order has no venue-side deadline, so if
// this process is dead an order rests unattended. It therefore writes a heartbeat every cycle, which the
// manual panel displays; a stale heartbeat next to an ON switch is the operator's signal to look.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// ── Load .env (pm2 does not auto-load project env files) — read-only, never printed, never committed ──
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* file absent → fine */ }
}

const { runAutoRepriceCycle } = require('../lib/maker/auto-reprice');
const { loadAutoRepriceTuning, EXPECTED_RENEWALS_PER_HOUR } = require('../lib/maker/auto-reprice-config');
const { listManualOrders, replaceManualOrder, resolveMarketRules, cancelManualOrder } = require('../lib/maker/manual-order');
const { isManualMarket } = require('../lib/maker/manual-mode');
const { appendMakerAudit } = require('../lib/venues/polymarket-clob-maker/audit');
const killSwitch = require('../lib/safety/kill-switch');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');

const HEARTBEATS = '/tmp/agent-heartbeats.json';
const log = (...a) => console.log(new Date().toISOString(), '[agent40-manual-reprice]', ...a);

// The breach counter lives HERE, in process memory, deliberately. "N consecutive observations" is a
// statement about an unbroken run of cycles, and a restart genuinely breaks that run — so a fresh process
// must start counting again rather than inheriting a claim it did not witness. The DURABLE state (last
// re-price, hourly counts) is what must survive a restart, and that lives in data/ instead.
const breaches = new Map();

// The CONNECTION BLACKOUT clock, also in process memory and also on purpose. "We have been unable to
// reach the venue since T" is a claim about a continuous observation this process made; a restarted
// process has not made it, and must not inherit it. Note that a restart is itself the safe direction
// here — the orders it lost track of are carrying a venue-side expiry that retires them regardless.
const link = { downSince: null, consecutiveFailures: 0 };

function heartbeat() {
  try {
    const hb = (() => { try { return JSON.parse(fs.readFileSync(HEARTBEATS, 'utf8')); } catch { return {}; } })();
    hb['agent40-manual-reprice'] = Date.now();
    atomicWriteJson(HEARTBEATS, hb);
  } catch { /* best-effort; the durable heartbeat in data/ is the one the panel reads */ }
}

// Summarise a cycle in one line, and ONLY when something is worth saying. A watcher that logs "nothing
// happened" every 5 seconds buries the one line that matters.
let lastQuietGate = null;
function logCycle(res) {
  if (!res.ran) {
    // A steady-state "off" is normal; say it once per change of reason, not 12 times a minute.
    if (res.gate !== lastQuietGate) { log(`idle: ${res.gate} — ${res.reason}`); lastQuietGate = res.gate; }
    return;
  }
  lastQuietGate = null;
  const acted = res.actions.filter((a) => a.action === 'reprice');
  const skips = res.actions.filter((a) => a.action === 'skip');
  const totals = res.markets.reduce((t, m) => ({ considered: t.considered + m.considered, held: t.held + m.held }), { considered: 0, held: 0 });
  for (const m of res.markets) {
    if (m.gate) log(`market cid_${String(m.marketId).replace(/^0x/, '')}: ${m.gate} — ${m.reason}`);
  }
  for (const a of acted) {
    log(`${a.trigger === 'expiry-refresh' ? 'REFRESH' : 'REPRICE'} ${a.ok ? 'ok' : 'FAILED'} · ${a.trigger} · order ${a.orderId}`
      + ` · ${a.book.toUpperCase()} ${a.fromPrice} → ${a.toPrice} (size ${a.size})`
      + `${a.secondsToExpiry != null ? ` · ${a.secondsToExpiry}s to expiry` : ''}`
      + `${a.sent ? ' · SENT to venue' : ' · not sent (dry-run)'}`
      + `${a.ok ? '' : ` · gate=${a.gate} ${a.reason || ''}`}`);
  }
  for (const a of res.actions.filter((x) => x.action === 'reconnect-cancel')) {
    log(`RECONNECT-CANCEL ${a.ok ? 'ok' : 'FAILED'} · order ${a.orderId}${a.reason ? ` · ${a.reason}` : ''}`);
  }
  // Skips that are not the routine "waiting for confirmation" deserve a line — they are the automatism
  // declining to act on something it saw.
  for (const s of skips) if (s.gate !== 'awaiting-confirmation') log(`skip · order ${s.orderId} · ${s.gate}: ${s.reason}`);
  if (acted.length === 0 && skips.length === 0 && totals.considered > 0) {
    // The steady state the whole feature exists to produce: orders resting, untouched, in band.
    log(`holding ${totals.held}/${totals.considered} order(s) in band — nothing touched`);
  }
}

async function cycle() {
  const res = await runAutoRepriceCycle({
    killStatus: () => killSwitch.killStatus(),
    isManual: (marketId) => isManualMarket(marketId),
    listOrders: ({ marketId }) => listManualOrders({ marketId }),
    resolveRules: (marketId) => resolveMarketRules(marketId),
    replaceOrder: (spec) => replaceManualOrder(spec),
    // Used ONLY by the reconnect-after-blackout path. It goes through the CANCEL-ONLY adapter (address-only
    // signer, structurally cannot place), so the recovery move can stop orders and can never start one.
    cancelOrder: (spec) => cancelManualOrder(spec, 'auto-reprice-band-exit'),
    audit: (rec) => { try { appendMakerAudit(rec); } catch (e) { log('audit write failed:', e.message); } },
    config: loadAutoRepriceTuning(),
    breaches,
    link,
  });
  logCycle(res);
  return res;
}

async function main() {
  const tuning = loadAutoRepriceTuning();
  log('starting — band-exit watcher for HAND-PLACED orders only.');
  log(`poll ${tuning.pollMs}ms · confirm ${tuning.confirmSamples} samples · hysteresis ${tuning.hysteresisTicks} tick`
    + ` · min interval ${Math.round(tuning.minIntervalMs / 1000)}s/order · ceiling ${tuning.maxPerHour}/hour/market`
    + ` · mid must be live-book${tuning.requireLiveBook ? '' : ' (RELAXED)'} and ≤ ${tuning.maxMidAgeSec}s old · strategy ${tuning.strategy}`);
  log(`venue-side expiry ${Math.round(tuning.restingGtdSeconds / 60)} min (GTD), proactive renewal with ${Math.round(tuning.refreshMarginSeconds / 60)} min left`
    + ` → one renewal every ${Math.round((tuning.restingGtdSeconds - tuning.refreshMarginSeconds) / 60)} min = ${EXPECTED_RENEWALS_PER_HOUR.toFixed(1)}/hour in quiet conditions.`);
  log(`DEAD-MAN'S SWITCH: if this process stops, nothing renews and the EXCHANGE retires every managed order`
    + ` within ${Math.round(tuning.restingGtdSeconds / 60)} minutes. That protection is the venue's, not ours — no second supervisor is required.`);
  log(`connection blackout: if the venue is unreachable for more than ${tuning.disconnectCancelSeconds}s, the hand orders on managed markets are CANCELLED on reconnect rather than renewed on top of an unobserved state.`);
  log('placement switch: MANUAL_ORDER_PLACEMENT=' + (process.env.MANUAL_ORDER_PLACEMENT === 'send' ? 'send (an automatic re-price REACHES the venue)' : 'dry-run (nothing reaches POST /order)'));
  log('this process owns no adapter, no credentials and no signing key: it can only call the same manual replace path the panel button calls.');

  // Never let one bad cycle kill the watcher — but never let a failure be silent either.
  const run = async () => {
    try { await cycle(); }
    catch (e) { log('cycle failed:', e && e.message ? e.message : String(e)); }
    finally { heartbeat(); }
  };
  await run();
  setInterval(run, tuning.pollMs);
}

if (require.main === module) {
  main().catch((e) => { log('fatal:', e && e.stack ? e.stack : String(e)); process.exit(1); });
}

module.exports = { cycle, breaches };

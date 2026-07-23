#!/usr/bin/env node
'use strict';
/**
 * PHASE 5 VERIFICATION — proves the mute switch and the per-market cooldown behave,
 * by driving the AGENT'S OWN alert path (agent36's exported sendTelegram and
 * resolveDetection), not a re-implementation of it.
 *
 * The Telegram transport is stubbed so nothing leaves the box and no real message is
 * sent — but every gate the live agent runs is executed for real, in order.
 *
 * Usage: node scripts/book-velocity-verify.js
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const bv    = require('../lib/book-velocity');
const agent = require('../agents/agent36-book-velocity');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

const S = (t, bid, ask, bidSz, askSz) => ({ t, bid, ask, bidSz, askSz });
const MARKET = { venue: 'polymarket', id: '0xTEST', title: 'VERIFY — synthetic market', minSize: 200, thinBook: false };
const THIN   = { ...MARKET, id: '0xTHIN', title: 'VERIFY — synthetic THIN market', thinBook: true };

// A forced detection: 10c move on a $4.1k book against a $200 minimum, held in full.
const T0 = 1_700_000_000_000;
function forcedDetection(t0 = T0) {
  const pair = bv.velocityPair(
    S(t0, 0.40, 0.41, 10000, 10000),
    S(t0 + 60_000, 0.50, 0.51, 10000, 10000),
    { minSizeUsd: 200 },
  );
  const cls = bv.classifyHold(pair, S(t0 + 60_000 + 180_000, 0.50, 0.51, 10000, 10000));
  return { pair, cls, now: t0 + 60_000 + 180_000 };
}

function harness() {
  const rows = [];
  const sent = [];
  return {
    rows, sent,
    cooldown: {},
    stats: { cycles: 0, detections: 0, alerts: 0, suppressed: 0, reverting: 0, unknown: 0, errors: 0 },
    append: r => rows.push(r),
    // Stub transport: records the message instead of calling api.telegram.org.
    transport: async text => { sent.push(text); return { ok: true }; },
  };
}

(async () => {
  const d = forcedDetection();
  ok('forced detection is a real detection at the shipped threshold',
    bv.isDetection(d.pair) === true, `nv=${d.pair.nv.toFixed(2)}`);
  ok('forced detection classifies PERSISTENT', d.cls.state === 'PERSISTENT', d.cls.state);

  // ── 1. MUTE SWITCH OFF ─────────────────────────────────────────────────────
  console.log('\n── PROOF 1: global mute switch TELEGRAM_ALERTS_ENABLED=false ──');
  {
    const prev = process.env.TELEGRAM_ALERTS_ENABLED;
    process.env.TELEGRAM_ALERTS_ENABLED = 'false';
    const h = harness();
    const row = await agent.resolveDetection({
      market: MARKET, key: 'polymarket::0xTEST', pair: d.pair, cls: d.cls, now: d.now,
      deps: { cooldown: h.cooldown, append: h.append, stats: h.stats, send: t => agent.sendTelegram(t, h.transport) },
    });
    ok('detection WAS logged', h.rows.length === 1, `rows=${h.rows.length}`);
    ok('log row records the real detection (nv, prices, depth)',
      h.rows[0].nv === d.pair.nv && h.rows[0].bid0 === 0.40 && h.rows[0].bid1 === 0.50 && h.rows[0].depthUsd0 > 0);
    ok('ZERO messages handed to the transport', h.sent.length === 0, `sent=${h.sent.length}`);
    ok('row marked alerted=false', row.alerted === false);
    ok("row marked alertSuppressed='muted'", row.alertSuppressed === 'muted', String(row.alertSuppressed));
    ok('cooldown slot RELEASED (a muted send must not consume the window)',
      !h.cooldown['polymarket::0xTEST'], JSON.stringify(h.cooldown));
    if (prev === undefined) delete process.env.TELEGRAM_ALERTS_ENABLED; else process.env.TELEGRAM_ALERTS_ENABLED = prev;
  }

  // ── 2. PER-AGENT MUTE ──────────────────────────────────────────────────────
  console.log('\n── PROOF 2: per-agent mute BOOK_VELOCITY_TELEGRAM_MUTED=true ──');
  {
    const prevG = process.env.TELEGRAM_ALERTS_ENABLED, prevA = process.env.BOOK_VELOCITY_TELEGRAM_MUTED;
    process.env.TELEGRAM_ALERTS_ENABLED = 'true';
    process.env.BOOK_VELOCITY_TELEGRAM_MUTED = 'true';
    const h = harness();
    await agent.resolveDetection({
      market: MARKET, key: 'polymarket::0xTEST', pair: d.pair, cls: d.cls, now: d.now,
      deps: { cooldown: h.cooldown, append: h.append, stats: h.stats, send: t => agent.sendTelegram(t, h.transport) },
    });
    ok('detection WAS logged', h.rows.length === 1);
    ok('ZERO messages sent while per-agent muted', h.sent.length === 0, `sent=${h.sent.length}`);
    if (prevG === undefined) delete process.env.TELEGRAM_ALERTS_ENABLED; else process.env.TELEGRAM_ALERTS_ENABLED = prevG;
    if (prevA === undefined) delete process.env.BOOK_VELOCITY_TELEGRAM_MUTED; else process.env.BOOK_VELOCITY_TELEGRAM_MUTED = prevA;
  }

  // ── 3. COOLDOWN ────────────────────────────────────────────────────────────
  console.log('\n── PROOF 3: per-market cooldown (two detections inside the window) ──');
  {
    const prevG = process.env.TELEGRAM_ALERTS_ENABLED, prevA = process.env.BOOK_VELOCITY_TELEGRAM_MUTED;
    process.env.TELEGRAM_ALERTS_ENABLED = 'true';
    delete process.env.BOOK_VELOCITY_TELEGRAM_MUTED;
    const h = harness();
    const key = 'polymarket::0xTEST';
    const send = t => agent.sendTelegram(t, h.transport);

    const r1 = await agent.resolveDetection({ market: MARKET, key, pair: d.pair, cls: d.cls, now: d.now,
      deps: { cooldown: h.cooldown, append: h.append, stats: h.stats, send } });
    ok('first detection SENT', r1.alerted === true && h.sent.length === 1, `sent=${h.sent.length}`);

    // Second detection on the SAME market, 5 minutes later — inside the 15-min window.
    const d2 = forcedDetection(T0 + 5 * 60_000);
    const r2 = await agent.resolveDetection({ market: MARKET, key, pair: d2.pair, cls: d2.cls, now: d2.now,
      deps: { cooldown: h.cooldown, append: h.append, stats: h.stats, send } });
    ok('second detection inside the window was NOT sent', r2.alerted === false);
    ok("second row marked alertSuppressed='cooldown'", r2.alertSuppressed === 'cooldown', String(r2.alertSuppressed));
    ok('exactly ONE message total for the market', h.sent.length === 1, `sent=${h.sent.length}`);
    ok('BOTH detections were logged (cooldown silences the push, not the record)',
      h.rows.length === 2, `rows=${h.rows.length}`);

    // A DIFFERENT market inside the same window must still be able to alert.
    const r3 = await agent.resolveDetection({ market: THIN, key: 'polymarket::0xTHIN', pair: d2.pair, cls: d2.cls, now: d2.now,
      deps: { cooldown: h.cooldown, append: h.append, stats: h.stats, send } });
    ok('cooldown is PER MARKET — a different market still alerts', r3.alerted === true && h.sent.length === 2);

    // Past the window, the same market can alert again.
    const d4 = forcedDetection(T0 + 20 * 60_000);
    const r4 = await agent.resolveDetection({ market: MARKET, key, pair: d4.pair, cls: d4.cls, now: d4.now,
      deps: { cooldown: h.cooldown, append: h.append, stats: h.stats, send } });
    ok('same market alerts again once the window has passed', r4.alerted === true, String(r4.alertSuppressed));

    if (prevG === undefined) delete process.env.TELEGRAM_ALERTS_ENABLED; else process.env.TELEGRAM_ALERTS_ENABLED = prevG;
    if (prevA !== undefined) process.env.BOOK_VELOCITY_TELEGRAM_MUTED = prevA;
  }

  // ── 4. REVERTING NEVER ALERTS ──────────────────────────────────────────────
  console.log('\n── PROOF 4: a reverting move is logged but never pushed ──');
  {
    const prevG = process.env.TELEGRAM_ALERTS_ENABLED;
    process.env.TELEGRAM_ALERTS_ENABLED = 'true';
    delete process.env.BOOK_VELOCITY_TELEGRAM_MUTED;
    const h = harness();
    const pair = bv.velocityPair(S(T0, 0.40, 0.41, 10000, 10000), S(T0 + 60_000, 0.50, 0.51, 10000, 10000), { minSizeUsd: 200 });
    const cls = bv.classifyHold(pair, S(T0 + 240_000, 0.40, 0.41, 10000, 10000));  // snapped back
    const row = await agent.resolveDetection({ market: MARKET, key: 'polymarket::0xTEST', pair, cls, now: T0 + 240_000,
      deps: { cooldown: h.cooldown, append: h.append, stats: h.stats, send: t => agent.sendTelegram(t, h.transport) } });
    ok('classified REVERTING', cls.state === 'REVERTING', cls.state);
    ok('logged', h.rows.length === 1);
    ok('NOT sent', h.sent.length === 0 && row.alerted === false);
    ok("marked alertSuppressed='not-persistent'", row.alertSuppressed === 'not-persistent');
    if (prevG === undefined) delete process.env.TELEGRAM_ALERTS_ENABLED; else process.env.TELEGRAM_ALERTS_ENABLED = prevG;
  }

  // ── 5. MESSAGE HONESTY ─────────────────────────────────────────────────────
  console.log('\n── PROOF 5: message content is honest and terse ──');
  {
    const h = harness();
    const row = { ...forcedDetection().pair, venue: 'polymarket', title: 'Will X happen?', minSize: 200,
      thinBook: false, retention: 1, holdElapsedMs: 180_000 };
    const msg = agent.formatAlert(row);
    ok('names the venue', msg.includes('polymarket'));
    ok('shows executable prices BEFORE and AFTER', msg.includes('before') && msg.includes('after') && msg.includes('0.400') && msg.includes('0.500'));
    ok('shows the depth behind them', /depth run over \$/.test(msg));
    ok('shows the elapsed time', /in 60s/.test(msg));
    ok('states it is movement, not a cause', /movement, not a cause/.test(msg));
    ok('NEVER claims a cause', !/news|because|due to|caused|rumou?r|announce/i.test(msg), msg.slice(0, 200));
    const thinMsg = agent.formatAlert({ ...row, thinBook: true });
    ok('thin-book market is LABELLED in the message, not suppressed', /THIN BOOK/.test(thinMsg));
    ok('thin-book message still carries the full detail', thinMsg.includes('0.500') && /depth run over/.test(thinMsg));
  }

  // ── 6. SINGLE-WRITER ───────────────────────────────────────────────────────
  console.log('\n── PROOF 6: the agent writes only files it owns ──');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'agent36-book-velocity.js'), 'utf8');
    const writeTargets = [...src.matchAll(/(?:appendFileSync|writeFileSync|renameSync)\s*\(\s*([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
    const allowed = new Set(['OUT_FILE', 'STATE_FILE', 'HB_FILE', 'tmp', 'file']);
    const bad = writeTargets.filter(v => !allowed.has(v));
    ok('no write call targets an unexpected variable', bad.length === 0, bad.join(','));
    ok('agent24 output is read-only in source', !/writeFileSync\([^)]*POLY_REWARDS/.test(src) && /POLY_REWARDS[\s\S]{0,400}readJsonSafe|readJsonSafe\(POLY_REWARDS\)/.test(src));
    ok('agent25 output is read-only in source', !/writeFileSync\([^)]*KALSHI_REWARDS/.test(src));
    ok('OUT_FILE is data/book-velocity.jsonl', /OUT_FILE\s*=[^;]*book-velocity\.jsonl/.test(src));
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();

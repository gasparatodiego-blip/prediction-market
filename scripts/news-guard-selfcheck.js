#!/usr/bin/env node
'use strict';
// scripts/news-guard-selfcheck.js — repeatable proof that the news-guard action path is DISARMED.
//
// Pure assertions, NO side effects (does not write the shadow log). Run after any change to the
// news-guard pipeline: it fails loudly if the severity policy drifts or if any gate combination
// could execute a real order in this build.
//
//   node scripts/news-guard-selfcheck.js

const assert = require('assert');
const { detectBookMove } = require('../lib/news-guard/book-detector');
const { buildSignal } = require('../lib/news-guard/signal');
const { loadNewsGuardConfig } = require('../lib/news-guard/config');
const { decideAction } = require('../lib/news-guard/action');
const { resolveCancelAdapter } = require('../lib/news-guard/cancel-adapter');
const { _scrub } = require('../lib/news-guard/shadow-log');

const NOW = 1_753_000_000_000;
let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; };

// ── 1. Book detector: rolling baseline, caps at medium ──
const hist = Array.from({ length: 10 }, (_, i) => ({ t: NOW - (10 - i) * 600_000, mid: 0.50, spread: 0.002, depthMin: 5000, bandDepth: 20000 }));
const bookFire = detectBookMove({ mid: 0.62, spread: 0.03, depthMin: 400, bandDepth: 3000 }, hist);
ok(bookFire.fired && bookFire.severity === 'medium', 'book move fires and caps at medium');
const bookCalm = detectBookMove({ mid: 0.50, spread: 0.002, depthMin: 5000, bandDepth: 20000 }, hist);
ok(!bookCalm.fired && bookCalm.severity === 'low', 'calm book does not fire');
ok(detectBookMove({ mid: 0.62 }, hist.slice(0, 3)).reason === 'insufficient-history', 'too little history → no fire');

// ── 2. Severity policy: book→medium, book+news→high, news-alone→low ──
const S = (b, n) => buildSignal({ marketId: 'M', book: b, news: n, ts: NOW }).severity;
ok(S(bookFire, { level: 'low' }) === 'medium', 'book alone → medium');
ok(S(bookFire, { level: 'high' }) === 'high', 'book + news → high');
ok(S(bookFire, { level: 'medium' }) === 'high', 'book + medium news → high');
ok(S(bookCalm, { level: 'high' }) === 'low', 'news alone → low (advisory)');
ok(S(bookCalm, { level: 'low' }) === 'low', 'both calm → low');
ok(buildSignal({ marketId: 'M', book: detectBookMove({ mid: 0.5 }, []), news: null, ts: NOW }).severity === 'unknown', 'no data → unknown (—)');

// ── 3. Gate matrix: NOTHING executes in this build, under any env/mode/key combination ──
const sigHigh = buildSignal({ marketId: 'M', book: bookFire, news: { level: 'high' }, ts: NOW });
const market = { marketId: 'M', venue: 'polymarket', title: 't', rewardScore: { poolDay: 308, refShare: 0.019, refCapital: 1000 } };
const withdraw = { newsMode: 'withdraw', side: 'both', qtyPerSide: 500, onFillYes: 'requote', onFillNo: 'close' };
const rails = { cooldownActive: false, hourlyCapReached: false };
const decide = (env, pl, ks = { liveVerified: false }) =>
  decideAction({ signal: sigHigh, market, placement: pl, config: loadNewsGuardConfig(env), keyState: ks, rails, now: NOW }).record;

for (const [env, pl, ks] of [
  [{}, withdraw],
  [{ NEWS_GUARD_ARMED: 'true' }, withdraw],                                   // arm alone
  [{}, withdraw, { liveVerified: true }],                                     // verified key alone
  [{ NEWS_GUARD_ARMED: 'true' }, withdraw, { liveVerified: true }],           // arm + key + withdraw (all gates) — still no live adapter
  [{ NEWS_GUARD_ARMED: 'true', NEWS_GUARD_KILL: 'true' }, withdraw, { liveVerified: true }],
]) {
  const r = decide(env, pl, ks);
  ok(r.executed === false, `executed must be false (env=${JSON.stringify(env)})`);
  ok(r.mode === 'shadow', 'mode must be shadow');
}
ok(decide({ NEWS_GUARD_ARMED: 'true' }, withdraw).gates.wouldExecute === false, 'arm alone → wouldExecute false (no verified key)');
ok(decide({}, withdraw, { liveVerified: true }).gates.wouldExecute === false, 'key alone → wouldExecute false (not armed)');
ok(decide({ NEWS_GUARD_ARMED: 'true' }, withdraw, { liveVerified: true }).gates.wouldExecute === true, 'all gates → wouldExecute true…');
ok(resolveCancelAdapter('polymarket', { armed: true, liveVerified: true }).kind === 'shadow', '…but the only adapter is shadow → cannot execute');
ok(decide({}, { ...withdraw, newsMode: 'alert' }).decision === 'alert-only', 'alert mode never withdraws');
ok(decide({}, { ...withdraw, newsMode: 'off' }).decision === 'off', 'off mode never withdraws');
ok(decide({ NEWS_GUARD_KILL: 'true' }, withdraw).decision === 'suppressed', 'kill switch suppresses');

// ── 4. Idempotency rails ──
ok(decide({}, withdraw, { liveVerified: false }) && decideAction({ signal: sigHigh, market, placement: withdraw, config: loadNewsGuardConfig({}), keyState: { liveVerified: false }, rails: { cooldownActive: true, hourlyCapReached: false }, now: NOW }).record.decision === 'suppressed', 'cooldown suppresses');

// ── 5. Secret scrub ──
const scrubbed = _scrub({ apiSecret: 'x', a: { passphrase: 'y', token: 'z', ok: 1 } });
ok(scrubbed.apiSecret === '[redacted]' && scrubbed.a.passphrase === '[redacted]' && scrubbed.a.token === '[redacted]' && scrubbed.a.ok === 1, 'secrets scrubbed, non-secrets kept');

console.log(`news-guard selfcheck: ${checks} assertions passed — action path is disarmed (executed=false in every combination).`);

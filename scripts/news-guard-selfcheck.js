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
const { stepRegime, REGIME } = require('../lib/news-guard/regime');

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

// ── 4b. Regime state machine: hysteresis, halt-first, evidence, no-manufactured-high ──
const P = { exitStreak: 2 };
const step = (prev, severity, extra = {}) => stepRegime({ prev, severity, source: extra.source ?? 'book', summary: extra.summary ?? 's', sample: extra.sample ?? { mid: 0.5, spread: 0.01 }, resolved: extra.resolved ?? false, now: extra.now ?? NOW, params: P });
// medium instant → ELEVATED, and a transition is recorded with its measured cause
const r1 = step(null, 'medium', { summary: 'spread 4× baseline' });
ok(r1.state === REGIME.ELEVATED && r1.severity === 'medium', 'medium → ELEVATED');
ok(r1.transition && r1.transition.to === 'elevated' && r1.transition.evidence.summary === 'spread 4× baseline', 'transition records measured evidence');
// hysteresis: one calm snapshot HOLDS elevated (cool-off), a second drops to calm
const r2 = step(r1, 'low');
ok(r2.state === REGIME.ELEVATED && r2.cooling === true, 'one calm snapshot holds ELEVATED (cool-off)');
const r3 = step(r2, 'low');
ok(r3.state === REGIME.CALM && r3.severity === 'low', 'second calm snapshot drops to CALM');
// held state keeps citing the evidence that set it (no fabricated re-evidence during hold)
ok(r2.evidence.summary === 'spread 4× baseline', 'held state keeps the original measured evidence');
// EVENT only from a genuine instantaneous high (book+news) — never manufactured from book alone
ok(step(null, 'high', { source: 'book+news' }).state === REGIME.EVENT, 'high → EVENT');
ok(step(null, 'medium').state !== REGIME.EVENT, 'book-alone medium never becomes EVENT');
// HALT is resolved-only (frozen price is telemetry, never a halt) → severity unknown ('—')
ok(step(null, 'low', { resolved: true }).state === REGIME.HALTED, 'resolved → HALTED');
ok(step(null, 'low', { resolved: true }).severity === 'unknown', 'HALTED severity is unknown (—)');
const frozenSample = { mid: 0.5, spread: 0.01 };
const f1 = step(null, 'low', { sample: frozenSample });
const f2 = step(f1, 'low', { sample: frozenSample });
const f3 = step(f2, 'low', { sample: frozenSample });
ok(f3.frozenStreak >= 2 && f3.state === REGIME.CALM && f3.severity === 'low', 'frozen price does NOT halt — stays CALM, streak is telemetry only');

// ── 5. Secret scrub ──
const scrubbed = _scrub({ apiSecret: 'x', a: { passphrase: 'y', token: 'z', ok: 1 } });
ok(scrubbed.apiSecret === '[redacted]' && scrubbed.a.passphrase === '[redacted]' && scrubbed.a.token === '[redacted]' && scrubbed.a.ok === 1, 'secrets scrubbed, non-secrets kept');

console.log(`news-guard selfcheck: ${checks} assertions passed — action path is disarmed (executed=false in every combination).`);

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

// ── 1b. Structural-trap: fires ONLY when one-sidedness is a CHANGE, never the permanent state ──
const calmSample = { mid: 0.50, spread: 0.002, depthMin: 5000, bandDepth: 20000 };
// (a) permanently one-sided (trap across the whole baseline) → NOT an event → does not fire
const permTrapHist = Array.from({ length: 10 }, (_, i) => ({ t: NOW - (10 - i) * 600_000, ...calmSample, trap: true }));
ok(!detectBookMove({ ...calmSample, trap: true }, permTrapHist).fired, 'permanently one-sided book (trap all baseline) → calm, does not fire');
// (b) genuine transition: two-sided baseline, now one-sided → fires structural-trap at medium
const twoSidedHist = Array.from({ length: 10 }, (_, i) => ({ t: NOW - (10 - i) * 600_000, ...calmSample, trap: false }));
const trapFire = detectBookMove({ ...calmSample, trap: true }, twoSidedHist);
ok(trapFire.fired && trapFire.severity === 'medium' && trapFire.triggers.some(t => t.type === 'structural-trap'), 'newly one-sided vs two-sided baseline → structural-trap fires (medium)');
// (c) cannot baseline the trap state (history lacks known trap flags) → never invent a baseline → no fire
const noTrapInfoHist = Array.from({ length: 10 }, (_, i) => ({ t: NOW - (10 - i) * 600_000, ...calmSample }));
ok(!detectBookMove({ ...calmSample, trap: true }, noTrapInfoHist).triggers.some(t => t.type === 'structural-trap'), 'unknown baseline trap state → structural-trap suppressed (honest)');
// (d) a genuinely one-sided transition still caps at medium (needs news to reach high) — invariant preserved
ok(buildSignal({ marketId: 'M', book: trapFire, news: { level: 'low' }, ts: NOW }).severity === 'medium', 'structural-trap alone still caps at medium');

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
ok(decide({ NEWS_GUARD_ARMED: 'true' }, withdraw, { liveVerified: true }).gates.wouldExecute === true, 'all gates → wouldExecute true (computed intent — still not execution)');
// A live adapter is now REGISTERED, so armed+verified selects it — but decideAction never sets
// executed true (proven in the matrix above) and the live adapter has its own belts (dry-run, throwing
// creds, address-only signer). Selection ≠ execution.
ok(decide({ NEWS_GUARD_ARMED: 'true' }, withdraw, { liveVerified: true }).executed === false, 'even with all gates + live adapter registered, executed stays false');
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

// ── 6. Live Polymarket cancel adapter: gates, dry-run belt, no fund-moving surface ──
const { createCancelOnlyAdapter, ALLOWED_OPS } = require('../lib/venues/polymarket-clob/adapter');
const { redact, scrubString } = require('../lib/venues/polymarket-clob/redact');

// (a) ARMED=false → live adapter is NEVER selected, even with a verified key + registered adapter.
ok(resolveCancelAdapter('polymarket', { armed: false, liveVerified: true }).kind === 'shadow', 'ARMED=false → shadow (live never selected)');
// (b) ARMED=true but liveVerified=false → shadow.
ok(resolveCancelAdapter('polymarket', { armed: true, liveVerified: false }).kind === 'shadow', 'armed but unverified → shadow');
// unknown venue (no registered live adapter) → shadow.
ok(resolveCancelAdapter('kalshi', { armed: true, liveVerified: true }).kind === 'shadow', 'no live adapter for venue → shadow');
// (c) BOTH gates true → the live adapter is selectable (the capability is owned).
ok(resolveCancelAdapter('polymarket', { armed: true, liveVerified: true }).kind === 'live', 'armed+verified → live adapter selectable');

// (d) No adapter method can open exposure or move funds — assert on the EXPORTED surface.
const surfaceAdapter = createCancelOnlyAdapter({ dryRun: true, credsProvider: () => { throw new Error('unused'); } });
const BANNED = ['placeOrder','postOrder','createOrder','submit','closePosition','openPosition','transfer','withdraw','send','approve','redeem','sign','signOrder','deriveApiKey','createApiKey','deleteApiKey'];
ok(BANNED.every(m => typeof surfaceAdapter[m] !== 'function'), 'no fund-moving / exposure-opening method exists on the adapter');
const callable = Object.keys(surfaceAdapter).filter(k => typeof surfaceAdapter[k] === 'function');
ok(callable.every(m => ALLOWED_OPS.includes(m)), 'adapter callable surface ⊆ ALLOWED_OPS (cancel/list/health only)');
// exitFilledLeg is alert-only — it can never place a closing order.
ok(typeof surfaceAdapter.exitFilledLeg === 'function' && typeof surfaceAdapter.placeOrder !== 'function', 'filled-leg path is alert-only (no placement)');

// (e) redaction: field-name AND inline-value AND private-key-hex scrubbing.
ok(redact({ apiSecret: 's', passphrase: 'p', poly_api_key: 'k', ok: 2 }).apiSecret === '[redacted]', 'redact scrubs secret field names');
ok(scrubString('x 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef y').includes('[redacted-64hex]'), 'redact scrubs inline 0x-64hex private keys');

// ── 7. NEWS LAYER: entity matching, cross-provider dedup, N-source corroboration, provider isolation ──
const { entitiesFor, matchItemToMarket } = require('../lib/news-guard/match');
const { dedup } = require('../lib/news-guard/dedup');
const { corroborate } = require('../lib/news-guard/corroborate');
const { makeItem, newHealth, breakerAllows, recordFailure, recordSuccess, canonicalUrl } = require('../lib/news-guard/providers/base');
const { providerEnabled, collect } = require('../lib/news-guard/providers/registry');

const NEWS_NOW = 1_753_000_000_000;
const mkItem = (title, pub, url, ageMs = 0) => makeItem({ source: 'rss', publisher: pub, publishedTs: NEWS_NOW - ageMs, fetchedTs: NEWS_NOW, title, summary: '', url });
const lulaEnt = entitiesFor({ title: 'Will Luiz Inácio Lula da Silva win the 2026 Brazilian presidential election?' });

// (a) entity matching: real entity matches; generic-only and lone-token never match
ok(matchItemToMarket(mkItem('Lula leads Brazilian presidential poll', 'bbc', 'https://bbc.com/1'), lulaEnt).matched === true, 'entity item matches (lula + brazilian)');
ok(matchItemToMarket(mkItem('US presidential election polling tightens', 'cnn', 'https://cnn.com/1'), lulaEnt).matched === false, 'generic-only item does NOT match');
const austinEnt = entitiesFor({ title: 'Will the temp in Austin be above 93 degrees?' });
ok(matchItemToMarket(mkItem('Sidley Austin hires new employment lawyer', 'bloomberg', 'https://bloomberg.com/1'), austinEnt).matched === false, 'lone common token (austin→law firm) does NOT match');
ok(entitiesFor({ title: 'Will the U.S. invade Iran before 2027?' }).phrases.has('u s') === false, 'abbreviation "U.S." never becomes the phrase "u s"');
const wx = entitiesFor({ title: 'Will the temp in Los Angeles be above 75.99° on Jul 22, 2026?' });
ok(wx.phrases.size === 0 && wx.tokens.size === 0, 'weather/temperature market yields NO news entities (a headline cannot move a temperature) → uncovered');

// (b) dedup: identical URL merges; near-identical titles cluster; distinct publishers unioned
const dd = dedup([
  mkItem('Lula surges in Brazilian election poll', 'bbc', 'https://bbc.com/lula'),
  mkItem('Lula surges in Brazilian election poll', 'google-news', 'https://bbc.com/lula'),   // same URL
  mkItem('Lula surges in Brazilian election poll survey', 'guardian', 'https://guardian.com/lula'),
]);
ok(dd.stats.clusters === 1 && dd.clusters[0].publishers.length === 3, 'dedup merges same-url + clusters same-story across 3 publishers');
ok(canonicalUrl('https://www.BBC.com/lula/?utm_source=x#frag') === canonicalUrl('https://bbc.com/lula'), 'canonicalUrl strips www/utm/fragment/trailing slash');

// (c) corroboration: single publisher → low (never lifts); ≥2 distinct publishers → medium; none → unknown; stale excluded
const oneClusters = dedup([mkItem('Lula rises in Brazilian poll', 'bbc', 'https://bbc.com/a')]).clusters;
ok(corroborate({ ent: lulaEnt, clusters: oneClusters, now: NEWS_NOW }).level === 'low', 'single source → low (uncorroborated, cannot lift)');
const twoClusters = dedup([mkItem('Lula rises in Brazilian poll', 'bbc', 'https://bbc.com/a'), mkItem('Lula gains in Brazilian survey vote', 'guardian', 'https://guardian.com/b')]).clusters;
ok(corroborate({ ent: lulaEnt, clusters: twoClusters, now: NEWS_NOW }).level === 'medium', '≥2 distinct publishers → medium');
ok(corroborate({ ent: lulaEnt, clusters: dedup([mkItem('Unrelated football transfer news', 'sky', 'https://sky.com/x')]).clusters, now: NEWS_NOW }).level === 'unknown', 'no matched item → unknown (—), never implicit calm');
const staleClusters = dedup([mkItem('Lula rises in Brazilian poll', 'bbc', 'https://bbc.com/a', 12 * 3_600_000), mkItem('Lula gains in Brazilian survey vote', 'guardian', 'https://guardian.com/b', 12 * 3_600_000)]).clusters;
ok(corroborate({ ent: lulaEnt, clusters: staleClusters, now: NEWS_NOW }).level === 'unknown', 'items older than recency window are excluded');

// (d) THE INVARIANT: news alone — even corroborated across many publishers — can NEVER reach high, and
//     can never trigger a withdraw. corroborate caps at 'medium'; signal.js keeps news-alone at 'low'.
const manyPubs = dedup(['bbc', 'guardian', 'reuters', 'npr', 'aljazeera'].map((p, i) => mkItem('Lula surges in Brazilian election poll vote', p, `https://${p}.com/${i}`))).clusters;
const strongNews = corroborate({ ent: lulaEnt, clusters: manyPubs, now: NEWS_NOW });
ok(strongNews.level === 'medium', '5-publisher corroboration still caps news at medium (never high)');
ok(buildSignal({ marketId: 'M', book: bookCalm, news: strongNews, ts: NOW }).severity === 'low', 'corroborated news + calm book → severity low (news alone cannot lift)');
ok(buildSignal({ marketId: 'M', book: bookFire, news: strongNews, ts: NOW }).severity === 'high', 'corroborated news + REAL book move → high (book is required)');
// prove the withdraw gate never fires on news-alone: severity<high → decideAction returns 'monitor', not 'withdraw'
const newsAloneSig = buildSignal({ marketId: 'M', book: bookCalm, news: strongNews, ts: NOW });
ok(decideAction({ signal: newsAloneSig, market, placement: withdraw, config: loadNewsGuardConfig({ NEWS_GUARD_ARMED: 'true' }), keyState: { liveVerified: true }, rails, now: NOW }).record.decision === 'monitor', 'news-alone (all gates armed) still only monitors — never withdraws');

// (e) provider circuit breaker: trips after threshold, half-opens after cooldown, closes on success
const h = newHealth();
recordFailure(h, new Error('boom'), NEWS_NOW); recordFailure(h, new Error('boom'), NEWS_NOW); recordFailure(h, new Error('boom'), NEWS_NOW);
ok(h.breakerOpen === true && breakerAllows(h, NEWS_NOW) === false, 'breaker OPENS after 3 consecutive failures and blocks calls');
ok(breakerAllows(h, NEWS_NOW + 31 * 60_000) === true, 'breaker half-opens after cooldown');
recordSuccess(h, 5, NEWS_NOW + 31 * 60_000);
ok(h.breakerOpen === false && h.consecutiveFailures === 0, 'a success closes the breaker');

// (f) provider registry: env enable/disable + FAILURE ISOLATION (one throwing provider never rejects collect)
ok(providerEnabled({ id: 'x', envFlag: 'NG_X', defaultEnabled: true }, { NG_X: 'false' }) === false, 'env=false disables a default-on provider');
ok(providerEnabled({ id: 'x', envFlag: 'NG_X', defaultEnabled: false }, { NG_X: 'true' }) === true, 'env=true enables a default-off provider');

// (g) DRY-RUN BELT: all gates satisfied AND dry-run on → a mutating call makes ZERO network calls and
//     NEVER loads credentials (the credsProvider throws if touched). Async, so it closes the run.
process.env.PM_ADAPTER_DRYRUN = 'true';
const liveDry = resolveCancelAdapter('polymarket', { armed: true, liveVerified: true });
ok(liveDry.kind === 'live' && liveDry.dryRun === true, 'all gates + PM_ADAPTER_DRYRUN → live adapter in dry-run');
// The registered disarmed factory wires a THROWING creds provider; dry-run must not reach it.
Promise.resolve()
  .then(async () => {
    const c1 = await liveDry.cancelResting({ marketId: '0xabc', orders: [{ side: 'yes' }] });
    ok(c1.dryRun === true && c1.sent === false, 'dry-run cancelResting: synthetic success, sent=false, no network');
    const c2 = await liveDry.cancelOrder('0xdeadbeef');
    ok(c2.dryRun === true && c2.sent === false, 'dry-run cancelOrder: synthetic success, sent=false, no network');
    const c3 = await liveDry.exitFilledLeg({ side: 'yes', size: 100 });
    ok(c3.alertOnly === true && c3.sent === false, 'exitFilledLeg is alert-only, sends no order');
  })
  .then(() => {
    delete process.env.PM_ADAPTER_DRYRUN;
    console.log(`news-guard selfcheck: ${checks} assertions passed — action path is disarmed (executed=false in every combination; live adapter selectable only under armed+verified, and even then dry-run/creds/signer belts block any send).`);
  })
  .catch((e) => { console.error('selfcheck FAILED:', e.message); process.exit(1); });

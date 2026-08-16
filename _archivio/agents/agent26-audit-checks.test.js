'use strict';
/**
 * Tests for agent26's Phase-4 phantom-instrument checks. Run:
 *   node agents/agent26-audit-checks.test.js
 * Uses temp fixtures in the scratchpad; live files are never touched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { auditServedFeeds, auditSanityRejectSpike } = require('./agent26-landing-auditor');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a26test-'));
const w = (name, obj) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(obj)); return p; };

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  FAIL', name); } };

// ── (A) expired instrument in served basis feed ──
const expiredBasis = w('basis-expired.json', {
  opportunities: [{ asset: 'BTC', exchange: 'Deribit', contract: 'BTC-25JUN26', expiry: '2026-06-25', netAnnualizedExecutable: 0.05 }],
  backwardation: [],
});
const emptyEx  = w('ex-empty.json', { futures: {} });
const emptyRing= w('ring-empty.json', { data: {} });
const emptyUni = w('uni-empty.json', { opportunities: [] });
const emptyPs  = w('ps-empty.json', { rows: [] });

let v = auditServedFeeds({ basisFile: expiredBasis, exchangeFile: emptyEx, historyFile: emptyRing, uniFile: emptyUni, perpSpotFile: emptyPs });
ok('expired basis fires', v.some(x => x.includes('EXPIRED INSTRUMENT') && x.includes('BTC-25JUN26')));

// live-2027 basis must NOT fire
const liveBasis = w('basis-live.json', { opportunities: [{ asset: 'BTC', exchange: 'Deribit', contract: 'BTC-25JUN27', expiry: '2027-06-25', netAnnualizedExecutable: 0.037 }], backwardation: [] });
v = auditServedFeeds({ basisFile: liveBasis, exchangeFile: emptyEx, historyFile: emptyRing, uniFile: emptyUni, perpSpotFile: emptyPs });
ok('live 2027 basis clean', v.length === 0);

// ── (B) dead cap-pinned contract in served perp-spot feed ──
const deadEx = w('ex-dead.json', { futures: { edgex: { TRX: { fundingRate: -0.1875, fundingIntervalHours: 4, markPrice: 0.332, openInterestUsd: 6977429 } } } });
const deadRing = w('ring-dead.json', { data: { edgex: { TRX: [{ t: 2, rate: -0.1875 }, { t: 1, rate: -0.1875 }] } } });
const deadPs = w('ps-dead.json', { rows: [{ coin: 'TRX', shortVenue: 'edgex', fundingPct8h: 0.5 }] });
v = auditServedFeeds({ basisFile: liveBasis, exchangeFile: deadEx, historyFile: deadRing, uniFile: emptyUni, perpSpotFile: deadPs });
ok('dead perp-spot fires', v.some(x => x.includes('DEAD CONTRACT in served perp-spot feed') && x.includes('edgex:TRX')));

// dead contract in served funding feed
const deadUni = w('uni-dead.json', { opportunities: [{ type: 'FUNDING', id: 'funding-TRX-edgex-binance' }] });
v = auditServedFeeds({ basisFile: liveBasis, exchangeFile: deadEx, historyFile: deadRing, uniFile: deadUni, perpSpotFile: emptyPs });
ok('dead funding fires', v.some(x => x.includes('DEAD CONTRACT in served funding feed') && x.includes('funding-TRX-edgex-binance')));

// healthy funding feed clean (no dead set)
const healthyUni = w('uni-healthy.json', { opportunities: [{ type: 'FUNDING', id: 'funding-BTC-binance-okx' }] });
v = auditServedFeeds({ basisFile: liveBasis, exchangeFile: deadEx, historyFile: deadRing, uniFile: healthyUni, perpSpotFile: emptyPs });
ok('healthy funding clean', !v.some(x => x.includes('DEAD CONTRACT in served funding feed')));

// ── (C) sanity-reject spike ──
const logFile = path.join(dir, 'dash.log');
fs.writeFileSync(logFile, Array.from({ length: 40 }, (_, i) => `sanity-reject funding id${i}: bad`).join('\n') + '\n');
let s = auditSanityRejectSpike(0, logFile);           // 40 new since 0 > 25 ⇒ spike
ok('spike fires on +40', s.violations.some(x => x.includes('SANITY-REJECT SPIKE')) && s.total === 40);
s = auditSanityRejectSpike(40, logFile);              // no new ⇒ no spike
ok('no spike when flat', s.violations.length === 0 && s.total === 40);
s = auditSanityRejectSpike(undefined, logFile);       // first run ⇒ baseline, no alert
ok('first run no alert', s.violations.length === 0 && s.total === 40);
s = auditSanityRejectSpike(100, logFile);             // log rotated (total<prev) ⇒ reset, no alert
ok('rotation no false alert', s.violations.length === 0);

// ── live data: auditServedFeeds runs without throwing. Count is informational —
// pre-restart the served feed may still hold a leaked dead contract (that IS the
// signal); post-restart it should be 0 (verified separately in the deploy step). ──
try {
  const live = auditServedFeeds();
  ok('LIVE audit runs without throwing', Array.isArray(live));
  console.log(`  live phantom violations: ${live.length}${live.length ? ' (pre-restart leak — expected to clear after agent15/28 restart):' : ''}`);
  live.forEach(x => console.log('    -', x));
} catch (e) { fail++; console.log('  FAIL live audit threw', e.message); }

fs.rmSync(dir, { recursive: true, force: true });
console.log(`agent26 audit checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

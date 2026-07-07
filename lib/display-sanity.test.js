'use strict';
/**
 * Unit tests for lib/display-sanity validateRow. Run: node lib/display-sanity.test.js
 * Tiny inline harness (no test framework — matches lib/funding-math.check.js style).
 *
 * No ts-node/esbuild in the agent runtime, so we transpile display-sanity.ts on the fly
 * with the `typescript` compiler (present for Next), rewriting the two `@/lib/...` path
 * aliases to relative requires, then load the CJS output from an in-memory Module.
 */

const fs = require('fs');
const ts = require('typescript');

// Register a .ts require hook so display-sanity.ts and its `@/lib/...` deps (rewritten to
// relative) transpile on the fly. Rewrites the path aliases to relative before compiling.
const ALIASES = { '@/lib/honest-display': './honest-display', '@/lib/instrument-expiry': './instrument-expiry' };
require.extensions['.ts'] = function (mod, filename) {
  let src = fs.readFileSync(filename, 'utf8');
  for (const [from, to] of Object.entries(ALIASES)) src = src.split(`'${from}'`).join(`'${to}'`);
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  }).outputText;
  mod._compile(js, filename);
};

function loadTs(absPath) {
  return require(absPath);
}

const { validateRow } = loadTs(require('path').join(__dirname, 'display-sanity.ts'));

let pass = 0, fail = 0;
function check(name, section, row, expectOk, expectReasonIncludes) {
  const res = validateRow(section, row, Date.parse('2026-07-07T00:00:00Z'));
  const okMatch = res.ok === expectOk;
  const reasonMatch = expectOk || !expectReasonIncludes || (res.reason || '').includes(expectReasonIncludes);
  if (okMatch && reasonMatch) { pass++; }
  else { fail++; console.log(`  FAIL ${name}: got ${JSON.stringify(res)} expected ok=${expectOk}${expectReasonIncludes ? ` reason~"${expectReasonIncludes}"` : ''}`); }
}

// ── funding ──
check('funding healthy', 'funding',
  { coin: 'BTC', shortExchange: 'binance', longExchange: 'okx', frShort: 0.01, frLong: 0.005, grossApy: 40, netApy30d: 25 }, true);
check('funding NaN leg', 'funding',
  { coin: 'X', shortExchange: 'a', longExchange: 'b', frShort: NaN, frLong: 0.005 }, false, 'null/NaN');
check('funding absurd leg (cap-pin leak)', 'funding',
  { coin: 'TRX', shortExchange: 'edgex', longExchange: 'binance', frShort: -0.1875 * 40, frLong: 0.001 }, false, 'plausible cap');
check('funding over-cap apy', 'funding',
  { coin: 'X', shortExchange: 'a', longExchange: 'b', frShort: 0.01, frLong: 0.001, grossApy: 950 }, false, 'display cap');
check('funding net but missing leg', 'funding',
  { coin: 'X', shortExchange: 'a', longExchange: '', frShort: 0.01, frLong: 0.001, netApy30d: 20 }, false, 'leg venue is missing');

// ── perp-spot ──
check('perp-spot healthy', 'perp-spot',
  { coin: 'BTC', shortVenue: 'binance', fundingPct8h: 0.01, edge: { netPerDay1k: 0.1, grossPerDay1k: 0.2, annualizedRunRatePct: 40, annualizedCapped: false } }, true);
check('perp-spot over-cap no label', 'perp-spot',
  { coin: 'X', shortVenue: 'v', fundingPct8h: 0.02, edge: { netPerDay1k: 1, grossPerDay1k: 1, annualizedRunRatePct: 900, annualizedCapped: false } }, false, 'run-rate label');
check('perp-spot over-cap WITH label ok', 'perp-spot',
  { coin: 'X', shortVenue: 'v', fundingPct8h: 0.02, edge: { netPerDay1k: 1, grossPerDay1k: 1, annualizedRunRatePct: 900, annualizedCapped: true } }, true);
check('perp-spot net but funding<=0', 'perp-spot',
  { coin: 'X', shortVenue: 'v', fundingPct8h: 0, edge: { netPerDay1k: 0.5, grossPerDay1k: 0.5 } }, false, 'not positive');

// ── basis ──
check('basis healthy live', 'basis',
  { asset: 'BTC', exchange: 'Deribit', contract: 'BTC-25JUN27', expiry: '2027-06-25', netAnnualizedExecutable: 0.0367 }, true);
check('basis expired', 'basis',
  { asset: 'BTC', exchange: 'Deribit', contract: 'BTC-25JUN26', expiry: '2026-06-25', netAnnualizedExecutable: 0.05 }, false, 'expired');
check('basis over-cap (near-expiry phantom)', 'basis',
  { asset: 'BTC', exchange: 'Deribit', contract: 'BTC-25DEC26', expiry: '2026-12-25', netAnnualizedExecutable: 3.5 }, false, 'display cap');

// ── rewards ──
check('rewards healthy', 'rewards',
  { marketId: 'm1', dailyPool: 300, qualifyingLiquidity: 133892, midpoint: 0.615, lastPrice: 0.615 }, true);
check('rewards negative pool', 'rewards',
  { marketId: 'm2', dailyPool: -50, midpoint: 0.5 }, false, 'negative');
check('rewards price out of range', 'rewards',
  { marketId: 'm3', dailyPool: 100, midpoint: 1.4 }, false, 'outside [0,1]');

// ── prediction ──
check('prediction healthy', 'prediction', { platform: 'kalshi', id: 'e1', price: 0.42 }, true);
check('prediction price>1', 'prediction', { platform: 'kalshi', id: 'e2', price: 1.7 }, false, 'outside [0,1]');

// ── universal dead/expired ──
check('dead-flagged row', 'funding', { coin: 'X', shortExchange: 'a', longExchange: 'b', frShort: 0.01, frLong: 0.01, dead: true }, false, 'flagged dead');

console.log(`display-sanity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

'use strict';
// Unit tests for the shared honest-engine suppressor (lib/guardian-suppress.js).
// Proves the ABSOLUTE invariant (never rewrite/fabricate — only hide/downgrade/
// relabel/redact, with the source value recoverable), a representative rule per
// category A–E, and the >30% mass-suppression guardrail. Plain-node, no framework —
// run with `node lib/guardian-suppress.test.js` (mirrors display-sanity.test.js).

const assert = require('assert');
const G = require('./guardian-suppress');

const NOW = 1_800_000_000_000;
const ctx = { now: NOW, noDirectives: true };  // no directives file in tests
let passed = 0;
function ok(name) { passed++; console.log('  ok -', name); }

// ── Invariant: suppress-value blanks the DISPLAY but keeps the original recoverable ──
{
  const row = { coin: 'X', shortVenue: 'grvt', spotExecutable: true, spotBid: null, spotAsk: null,
    markPrice: 100, wholeTradeCapacityUsd: 500000, spotCapacityUsd: 500000, perpShortDepthUsd: 500000,
    perpDepthWalked: true, fundingPct8h: 5,
    edge: { netPerDay1k: 1479, grossPerDay1k: 1500, annualizedRunRatePct: 3000, netAnnualizedOnCapitalPct: 1, breakevenDays: 1 } };
  const before = JSON.parse(JSON.stringify(row));
  const { rows } = G.applyGuardian('perp-spot', [row], ctx);
  const r = rows[0];
  // The A2 impossible-APR would HIDE (3000%/yr), so this row should be gone —
  // rework: use a value over 200 but under 1000 so it is suppressed, not hidden.
  assert.strictEqual(rows.length, 0, 'A2: 3000%/yr row is hidden');
  ok('A2 hide: impossible APR row removed');
  // source object still carries its raw edge (we only removed it from the served list).
  assert.strictEqual(row.edge.netPerDay1k, 1479, 'source value untouched even when row hidden');
  ok('no-rewrite: hidden row source value intact');
  void before;
}

// ── A1: 200% < APR ≤ 1000% → suppress-value + "in verifica", original recoverable ──
{
  const row = { coin: 'Y', shortVenue: 'grvt', spotExecutable: true, spotBid: 1, spotAsk: 1.01,
    markPrice: 1, wholeTradeCapacityUsd: 500000, spotCapacityUsd: 500000, perpShortDepthUsd: 500000,
    perpDepthWalked: true, fundingPct8h: 5,
    edge: { netPerDay1k: 8, grossPerDay1k: 9, annualizedRunRatePct: 500, annualizedCapped: false,
            netAnnualizedOnCapitalPct: 1, breakevenDays: 1 } };
  const { rows } = G.applyGuardian('perp-spot', [row], ctx);
  const r = rows[0];
  assert.strictEqual(r.edge.annualizedRunRatePct, null, 'A1: over-cap APR blanked on display');
  assert.strictEqual(r.__guardian.original['edge.annualizedRunRatePct'], 500, 'A1: original 500 preserved');
  assert.strictEqual(r.__guardian.label, G.LABELS.IN_VERIFICA, 'A1: labelled in verifica');
  assert.ok(r.__guardian.actions.some(a => a.rule === 'A1'), 'A1: action logged');
  ok('A1 suppress-value: over-cap APR blanked, original recoverable, in verifica');
}

// ── A3: net $/day > real book depth → suppress ($1479 on $42) ──
{
  const row = { coin: 'Z', shortVenue: 'grvt', spotExecutable: true, spotBid: 1, spotAsk: 1.01, markPrice: 1,
    wholeTradeCapacityUsd: 42, spotCapacityUsd: 42, perpShortDepthUsd: 42, perpDepthWalked: true, fundingPct8h: 5,
    edge: { netPerDay1k: 1479, grossPerDay1k: 1500, annualizedRunRatePct: 50, netAnnualizedOnCapitalPct: 1, breakevenDays: 1 } };
  const { rows } = G.applyGuardian('perp-spot', [row], ctx);
  const r = rows[0];
  assert.strictEqual(r.edge.netPerDay1k, null, 'A3: net blanked when it exceeds depth');
  assert.strictEqual(r.__guardian.original['edge.netPerDay1k'], 1479, 'A3: original 1479 preserved');
  ok('A3 suppress-value: net exceeding book depth suppressed');
}

// ── C10: false "verifying" cleared to "confirmed" (relabel only, number stays) ──
{
  const row = { coin: 'BTC', shortExchange: 'a', longExchange: 'b', frShort: 1, frLong: 2,
    netApy30d: 30, grossApy: 35, oneLegUnverified: false, greenCapacityUsd: 200000, capacityUsd: 200000,
    __verify: { status: 'verifying' } };
  const { rows } = G.applyGuardian('funding', [row], ctx);
  const r = rows[0];
  assert.strictEqual(r.__verify.status, 'confirmed', 'C10: false verifying cleared to confirmed');
  assert.strictEqual(r.netApy30d, 30, 'C10: number untouched (relabel only)');
  ok('C10 relabel: false verifying badge cleared, value untouched');
}

// ── D15: OI/proxy capacity suppressed to "non disponibile" ──
{
  const row = { asset: 'BTC', exchange: 'x', contract: 'c', netAnnualized: 0.04, netAnnualizedExecutable: 0.04,
    capacityUsd: 900000, capacitySource: 'oi', __verify: { status: 'ok', ageMs: 1000 } };
  const { rows } = G.applyGuardian('basis', [row], ctx);
  const r = rows[0];
  assert.strictEqual(r.capacityUsd, null, 'D15: proxy capacity blanked');
  assert.strictEqual(r.__guardian.original['capacityUsd'], 900000, 'D15: original depth preserved');
  assert.strictEqual(r.__guardian.label, G.LABELS.NON_DISPONIBILE, 'D15: non disponibile');
  ok('D15 suppress-value: OI/proxy capacity → non disponibile, original recoverable');
}

// ── D16: whole-trade capacity clamped DOWN to the min leg (sanctioned correction) ──
{
  const row = { coin: 'ETH', shortVenue: 'grvt', spotExecutable: true, spotBid: 1, spotAsk: 1.01, markPrice: 1,
    wholeTradeCapacityUsd: 900000, spotCapacityUsd: 300000, perpShortDepthUsd: 800000, perpDepthWalked: true, fundingPct8h: 5,
    edge: { netPerDay1k: 5, grossPerDay1k: 6, annualizedRunRatePct: 40, netAnnualizedOnCapitalPct: 1, breakevenDays: 1 } };
  const { rows } = G.applyGuardian('perp-spot', [row], ctx);
  const r = rows[0];
  assert.strictEqual(r.wholeTradeCapacityUsd, 300000, 'D16: clamped to min(spot,perp)=300k');
  assert.strictEqual(r.__guardian.original['wholeTradeCapacityUsd'], 900000, 'D16: original 900k preserved');
  assert.ok(r.wholeTradeCapacityUsd < r.__guardian.original['wholeTradeCapacityUsd'], 'D16: clamp is DOWN only');
  ok('D16 correct-min: capacity clamped down to thinner leg, original recoverable');
}

// ── D19: depth < $100k → speculative, never cashable ──
{
  const row = { coin: 'DOGE', shortVenue: 'grvt', spotExecutable: true, spotBid: 1, spotAsk: 1.01, markPrice: 1,
    wholeTradeCapacityUsd: 42000, spotCapacityUsd: 42000, perpShortDepthUsd: 42000, perpDepthWalked: true, fundingPct8h: 5,
    edge: { netPerDay1k: 5, grossPerDay1k: 6, annualizedRunRatePct: 40, netAnnualizedOnCapitalPct: 1, breakevenDays: 1 } };
  const { rows } = G.applyGuardian('perp-spot', [row], ctx);
  const r = rows[0];
  assert.strictEqual(r.__guardian.label, G.LABELS.SPECULATIVE, 'D19: labelled speculative');
  assert.strictEqual(r.__guardian.downgradeCashable, true, 'D19: cashable claim downgraded');
  assert.strictEqual(r.wholeTradeCapacityUsd, 42000, 'D19: real depth still shown (thin, not fabricated)');
  ok('D19 relabel: thin book → speculative, number preserved');
}

// ── E21 + E20: executable with null bid/ask → non-executable + mid suppressed ──
{
  const row = { coin: 'SOL', shortVenue: 'grvt', spotExecutable: true, spotBid: null, spotAsk: null, markPrice: 150,
    wholeTradeCapacityUsd: 500000, spotCapacityUsd: 500000, perpShortDepthUsd: 500000, perpDepthWalked: true, fundingPct8h: 5,
    edge: { netPerDay1k: 5, grossPerDay1k: 6, annualizedRunRatePct: 40, netAnnualizedOnCapitalPct: 1, breakevenDays: 1 } };
  const { rows } = G.applyGuardian('perp-spot', [row], ctx);
  const r = rows[0];
  assert.strictEqual(r.spotExecutable, false, 'E21: downgraded to non-executable');
  assert.strictEqual(r.edge.netPerDay1k, null, 'E20: mid-only edge suppressed');
  ok('E20/E21: null bid/ask → non-executable + mid edge suppressed');
}

// ── E24: one funding leg 0 → monoleg, two-sided net suppressed ──
{
  const row = { coin: 'TIA', shortExchange: 'a', longExchange: 'b', frShort: 0, frLong: 2,
    netApy30d: 30, grossApy: 35, capacityUsd: 200000 };
  const { rows } = G.applyGuardian('funding', [row], ctx);
  const r = rows[0];
  assert.strictEqual(r.netApy30d, null, 'E24: two-sided net suppressed');
  assert.strictEqual(r.__guardian.label, G.LABELS.MONOLEG, 'E24: monoleg label');
  assert.strictEqual(r.__guardian.original['netApy30d'], 30, 'E24: original net recoverable');
  ok('E24 suppress-value: monoleg net suppressed, original recoverable');
}

// ── A4: net > 10× category median → downgrade (moved to bottom) ──
{
  const mk = (coin, net) => ({ coin, shortVenue: 'grvt', spotExecutable: true, spotBid: 1, spotAsk: 1.01, markPrice: 1,
    wholeTradeCapacityUsd: 500000, spotCapacityUsd: 500000, perpShortDepthUsd: 500000, perpDepthWalked: true, fundingPct8h: 5,
    edge: { netPerDay1k: net, grossPerDay1k: net + 1, annualizedRunRatePct: 40, netAnnualizedOnCapitalPct: 1, breakevenDays: 1 } });
  const rows = [mk('A', 5), mk('B', 5), mk('C', 5), mk('OUT', 500)];
  const res = G.applyGuardian('perp-spot', rows, ctx);
  const last = res.rows[res.rows.length - 1];
  assert.strictEqual(last.coin, 'OUT', 'A4: outlier demoted to bottom');
  assert.strictEqual(last.__guardian.downgraded, true, 'A4: marked downgraded');
  ok('A4 downgrade: 10×-median outlier sunk to bottom');
}

// ── >30% mass-suppression guardrail: refuse to empty a tab ──
{
  // 5 rows, 3 would be HIDDEN (impossible APR) = 60% > 30% → keep all, raise CRITICAL.
  const impossible = (coin) => ({ coin, shortVenue: 'grvt', spotExecutable: true, spotBid: 1, spotAsk: 1.01, markPrice: 1,
    wholeTradeCapacityUsd: 500000, spotCapacityUsd: 500000, perpShortDepthUsd: 500000, perpDepthWalked: true, fundingPct8h: 5,
    edge: { netPerDay1k: 5, grossPerDay1k: 6, annualizedRunRatePct: 5000, netAnnualizedOnCapitalPct: 1, breakevenDays: 1 } });
  const good = (coin) => ({ coin, shortVenue: 'grvt', spotExecutable: true, spotBid: 1, spotAsk: 1.01, markPrice: 1,
    wholeTradeCapacityUsd: 500000, spotCapacityUsd: 500000, perpShortDepthUsd: 500000, perpDepthWalked: true, fundingPct8h: 5,
    edge: { netPerDay1k: 5, grossPerDay1k: 6, annualizedRunRatePct: 40, netAnnualizedOnCapitalPct: 1, breakevenDays: 1 } });
  const rows = [impossible('A'), impossible('B'), impossible('C'), good('D'), good('E')];
  const res = G.applyGuardian('perp-spot', rows, ctx);
  assert.strictEqual(res.rows.length, 5, 'guardrail: no row hidden (tab not emptied)');
  assert.ok(res.critical && res.critical.type === 'mass-suppress', 'guardrail: CRITICAL raised');
  assert.strictEqual(res.critical.wouldHide, 3, 'guardrail: reports 3 would-hide');
  ok('guardrail: >30% would-hide → keep all + CRITICAL (tab not emptied)');
}

// ── Below the guardrail threshold, a single hide DOES apply ──
{
  const impossible = (coin) => ({ coin, shortVenue: 'grvt', spotExecutable: true, spotBid: 1, spotAsk: 1.01, markPrice: 1,
    wholeTradeCapacityUsd: 500000, spotCapacityUsd: 500000, perpShortDepthUsd: 500000, perpDepthWalked: true, fundingPct8h: 5,
    edge: { netPerDay1k: 5, grossPerDay1k: 6, annualizedRunRatePct: 5000, netAnnualizedOnCapitalPct: 1, breakevenDays: 1 } });
  const good = (coin) => ({ coin, shortVenue: 'grvt', spotExecutable: true, spotBid: 1, spotAsk: 1.01, markPrice: 1,
    wholeTradeCapacityUsd: 500000, spotCapacityUsd: 500000, perpShortDepthUsd: 500000, perpDepthWalked: true, fundingPct8h: 5,
    edge: { netPerDay1k: 5, grossPerDay1k: 6, annualizedRunRatePct: 40, netAnnualizedOnCapitalPct: 1, breakevenDays: 1 } });
  const rows = [impossible('A'), good('B'), good('C'), good('D'), good('E')];  // 1/5 = 20% ≤ 30%
  const res = G.applyGuardian('perp-spot', rows, ctx);
  assert.strictEqual(res.rows.length, 4, 'single hide applies below threshold');
  assert.strictEqual(res.critical, null, 'no CRITICAL below threshold');
  ok('single hide applies below the 30% threshold');
}

// ── Severity: soft relabels never trip the guardrail (sports C13 on 100% of rows) ──
{
  const rows = ['a', 'b', 'c', 'd', 'e'].map((eventId) => ({ eventId, netMargin: 3, grossMargin: 4 }));
  const res = G.applyGuardian('sports', rows, ctx);
  // Every row gets C13 'unreachable' (no verify adapter) — a soft relabel — but the
  // number stays and the guardrail must NOT fire (100% soft ≠ mass-suppression).
  assert.strictEqual(res.rows.length, 5, 'sports: all rows kept');
  assert.strictEqual(res.critical, null, 'sports: 100% soft relabel does NOT trip guardrail');
  assert.strictEqual(res.rows[0].__verify.status, 'unreachable', 'sports: honest unreachable badge');
  assert.strictEqual(res.rows[0].netMargin, 3, 'sports: number preserved (relabel only)');
  ok('C13 severity: 100% soft relabel keeps board, no false CRITICAL');
}

// ── Severity: secondary-field (capacity) suppression never trips the guardrail ──
{
  // 4/5 basis rows have OI/proxy capacity (D15 blanks the SECONDARY capacity field) —
  // the headline netAnnualized stays, so this must NOT read as mass-suppression.
  const mk = (asset, src) => ({ asset, exchange: 'x', contract: 'c' + asset, netAnnualized: 0.04,
    netAnnualizedExecutable: 0.04, capacityUsd: 500000, capacitySource: src, __verify: { status: 'ok', ageMs: 1000 } });
  const rows = [mk('A', 'oi'), mk('B', 'oi'), mk('C', 'oi'), mk('D', 'oi'), mk('E', 'book')];
  const res = G.applyGuardian('basis', rows, ctx);
  assert.strictEqual(res.critical, null, 'basis: 80% secondary-field suppression does NOT trip guardrail');
  assert.strictEqual(res.rows.length, 5, 'basis: all rows kept');
  assert.strictEqual(res.rows[0].capacityUsd, null, 'basis: proxy capacity blanked');
  assert.strictEqual(res.rows[0].netAnnualized, 0.04, 'basis: headline net preserved');
  ok('D15 severity: secondary-field suppression on 80% keeps board, no false CRITICAL');
}

console.log(`\nguardian-suppress: ${passed} assertions passed`);

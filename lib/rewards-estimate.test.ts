import { raggioBandaCents } from './banda-premiante';
// lib/rewards-estimate.test.ts — standalone assertion tests (no framework).
// Run: tsc lib/rewards-estimate.ts lib/rewards-estimate.test.ts --outDir <tmp> \
//        --module commonjs --target es2019 && node <tmp>/lib/rewards-estimate.test.js
// (see scripts/test-rewards-estimate.sh)

import {
  estimateReward,
  proximityFactor,
  sizeFactorFor,
  MarketSnapshot,
  ANNUALIZED_CAP_PCT,
} from './rewards-estimate';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else      { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function approx(a: number | null, b: number, eps = 1e-6): boolean {
  return a != null && Math.abs(a - b) < eps;
}

// Base snapshot: healthy two-sided-friendly market with a real pool + book.
const base: MarketSnapshot = {
  venue: 'polymarket',
  midpoint: 0.50,
  maxSpread: 6,               // cents (full band)
  minSize: 50,
  dailyPool: 1000,
  qualifyingLiquidity: 5000,  // USD existing makers
  bookDepthAtBand: 5000,      // USD near band
  volatilityStdev: 0.02,
  twoSidedRequired: false,
};

console.log('rewards-estimate unit tests\n');

// 1) QUADRATIC PROXIMITY -------------------------------------------------------
ok('proximity at mid (d=0) = 1', approx(proximityFactor(0, 6), 1));
ok('proximity at band edge (d=maxSpread) = 0', approx(proximityFactor(6, 6), 0));
// quadratic, not linear: at half the band, 1-(0.5)^2 = 0.75 (linear would give 0.5)
ok('proximity is QUADRATIC at d=raggioBandaCents(maxSpread) → 0.75', approx(proximityFactor(3, 6), 0.75));
ok('proximity at quarter band → 1-(0.25)^2 = 0.9375', approx(proximityFactor(1.5, 6), 0.9375));
ok('proximity clamps ≥0 beyond band', proximityFactor(99, 6) === 0);
ok('Kalshi (maxSpread null) proximity = 1 (flat model)', proximityFactor(3, null) === 1);

// 2) TWO-SIDED vs SINGLE-SIDED -------------------------------------------------
ok('sizeFactor two-sided = 1', sizeFactorFor(true, 0.5) === 1);
ok('sizeFactor single-sided = 0.5', sizeFactorFor(false, 0.5) === 0.5);
ok('sizeFactor single-sided = 0 when mid>0.90 (two-sided required)', sizeFactorFor(false, 0.95) === 0);
ok('sizeFactor single-sided = 0 when mid<0.10', sizeFactorFor(false, 0.05) === 0);
ok('sizeFactor two-sided still 1 at extreme mid', sizeFactorFor(true, 0.95) === 1);

const twoS = estimateReward({ venue: 'polymarket', capital: 1000, twoSided: true,  distanceCents: 3, market: base });
const oneS = estimateReward({ venue: 'polymarket', capital: 1000, twoSided: false, distanceCents: 3, market: base });
ok('two-sided score > single-sided score', (twoS.score) > (oneS.score));
ok('single-sided gross ≈ half of two-sided (sizeFactor 0.5)',
   oneS.grossReward != null && twoS.grossReward != null && oneS.grossReward < twoS.grossReward);

// single-sided at extreme mid scores exactly 0 → gross 0
const extremeSingle = estimateReward({
  venue: 'polymarket', capital: 1000, twoSided: false, distanceCents: 3,
  market: { ...base, midpoint: 0.95, twoSidedRequired: true },
});
ok('single-sided at mid 0.95 → score 0 and flagged', extremeSingle.score === 0 && extremeSingle.reasons.some(r => r.includes('two-sided is required')));

// 3) BELOW-MIN PAYOUT FLAG -----------------------------------------------------
// Tiny pool + huge competition → gross well under $1/day.
const tiny = estimateReward({
  venue: 'polymarket', capital: 200, twoSided: true, distanceCents: 3,
  market: { ...base, dailyPool: 5, qualifyingLiquidity: 500000, bookDepthAtBand: 500000 },
});
ok('below-min: gross < $1/day', tiny.grossReward != null && tiny.grossReward < 1);
ok('below-min: belowMinPayout flag true', tiny.belowMinPayout === true);
ok('below-min: reason present', tiny.reasons.some(r => r.includes('below the minimum daily payout')));
ok('healthy market NOT below-min', twoS.belowMinPayout === false);

// 4) POOL-UNKNOWN PATH ---------------------------------------------------------
const noPool = estimateReward({
  venue: 'kalshi', capital: 1000, twoSided: true, distanceCents: 2,
  market: { ...base, venue: 'kalshi', maxSpread: null, dailyPool: null },
});
ok('pool unknown → grossReward null', noPool.grossReward === null);
ok('pool unknown → netPerDay null', noPool.netPerDay === null);
ok('pool unknown → reason "pool unknown"', noPool.reasons.some(r => r.includes('pool unknown')));
ok('pool unknown → shareOfPool still computed (qualifying liq known)', noPool.shareOfPool != null);

// qualifying liquidity unknown → share null
const noLiq = estimateReward({
  venue: 'polymarket', capital: 1000, twoSided: true, distanceCents: 3,
  market: { ...base, qualifyingLiquidity: null },
});
ok('qualifying liq unknown → shareOfPool null', noLiq.shareOfPool === null);
ok('qualifying liq unknown → grossReward null', noLiq.grossReward === null);

// book depth unknown → fill/adverse/net null, gross still known
const noBook = estimateReward({
  venue: 'polymarket', capital: 1000, twoSided: true, distanceCents: 3,
  market: { ...base, bookDepthAtBand: null },
});
ok('book unknown → fillProbability null', noBook.fillProbability === null);
ok('book unknown → adverseSelectionCost null', noBook.adverseSelectionCost === null);
ok('book unknown → netPerDay withheld (null)', noBook.netPerDay === null);
ok('book unknown → gross still computed', noBook.grossReward != null);

// 5) ADVERSE COST REDUCES NET --------------------------------------------------
ok('adverse cost is positive on a live book', twoS.adverseSelectionCost != null && twoS.adverseSelectionCost > 0);
ok('net < gross (adverse subtracted)', twoS.netPerDay != null && twoS.grossReward != null && twoS.netPerDay < twoS.grossReward);
ok('net = gross - adverse (exact)',
   twoS.netPerDay != null && twoS.grossReward != null && twoS.adverseSelectionCost != null &&
   approx(twoS.netPerDay, twoS.grossReward - twoS.adverseSelectionCost, 1e-3));
ok('adverse source = market-vol when stdev present', twoS.adverseMoveSource === 'market-vol');

// higher volatility ⇒ larger adverse cost ⇒ lower net
const hiVol = estimateReward({ venue: 'polymarket', capital: 1000, twoSided: true, distanceCents: 3, market: { ...base, volatilityStdev: 0.09 } });
ok('higher vol → larger adverse cost', hiVol.adverseSelectionCost! > twoS.adverseSelectionCost!);
ok('higher vol → lower net', hiVol.netPerDay! < twoS.netPerDay!);

// no measured vol → conservative default source, move in [2%,5%]
const consv = estimateReward({ venue: 'kalshi', capital: 1000, twoSided: true, distanceCents: 2, market: { ...base, venue: 'kalshi', maxSpread: null, volatilityStdev: null } });
ok('no vol → conservative-default source', consv.adverseMoveSource === 'conservative-default');
ok('conservative move within 2–5%', consv.expectedAdverseMove != null && consv.expectedAdverseMove >= 0.02 - 1e-9 && consv.expectedAdverseMove <= 0.05 + 1e-9);

// 6) ANNUALIZED CAP ------------------------------------------------------------
const rich = estimateReward({
  venue: 'polymarket', capital: 100, twoSided: true, distanceCents: 1,
  market: { ...base, dailyPool: 100000, qualifyingLiquidity: 100, bookDepthAtBand: 100, volatilityStdev: 0.005 },
});
ok('rich market annualized capped at 200%', rich.annualizedPct != null && rich.annualizedPct <= ANNUALIZED_CAP_PCT);
ok('rich market annualizedCapped flag true', rich.annualizedCapped === true);
ok('annualized label says run-rate not guaranteed', rich.annualizedLabel.includes('run-rate, not guaranteed'));

// 7) PROXIMITY DRIVES SHARE (closer to mid earns more) -------------------------
const nearMid = estimateReward({ venue: 'polymarket', capital: 1000, twoSided: true, distanceCents: 0.5, market: base });
const outerBand = estimateReward({ venue: 'polymarket', capital: 1000, twoSided: true, distanceCents: 5, market: base });
ok('closer to mid → higher share', nearMid.shareOfPool! > outerBand.shareOfPool!);
ok('closer to mid → higher gross', nearMid.grossReward! > outerBand.grossReward!);

// 8) PER-SIDE (YES/NO) FROM DISTINCT BOOKS -------------------------------------
// Legacy call (no `side`) reports side null and did NOT use a per-side book.
ok('legacy call → side null, usedSideBook false', twoS.side === null && twoS.usedSideBook === false);

// Polymarket dual book: YES faces less competition than NO ⇒ higher share/net.
const dualSided: MarketSnapshot = {
  ...base,
  sides: {
    yes: { midpoint: 0.40, qualifyingLiquidity: 2000, bookDepthAtBand: 2000, volatilityStdev: 0.02, twoSidedRequired: false, hasBook: true },
    no:  { midpoint: 0.60, qualifyingLiquidity: 8000, bookDepthAtBand: 8000, volatilityStdev: 0.02, twoSidedRequired: false, hasBook: true },
  },
};
const yesEst = estimateReward({ venue: 'polymarket', capital: 1000, twoSided: true, distanceCents: 3, market: dualSided, side: 'yes' });
const noEst  = estimateReward({ venue: 'polymarket', capital: 1000, twoSided: true, distanceCents: 3, market: dualSided, side: 'no'  });
ok('YES uses its own book (usedSideBook, side=yes)', yesEst.usedSideBook === true && yesEst.side === 'yes' && yesEst.sideBookAvailable === true);
ok('NO uses its own book (usedSideBook, side=no)',   noEst.usedSideBook  === true && noEst.side  === 'no');
ok('YES vs NO produce DIFFERENT net/day (distinct books)', yesEst.netPerDay !== noEst.netPerDay);
ok('YES (thinner competition) → higher share than NO', yesEst.shareOfPool! > noEst.shareOfPool!);
ok('YES (thinner competition) → higher net than NO', yesEst.netPerDay! > noEst.netPerDay!);

// Kalshi dual book with complement-derived asks — still per-side distinct.
const kalshiDual: MarketSnapshot = {
  ...base, venue: 'kalshi', maxSpread: null,
  sides: {
    yes: { midpoint: 0.30, qualifyingLiquidity: 500, bookDepthAtBand: 1200, asksDerivedByComplement: true, hasBook: true },
    no:  { midpoint: 0.70, qualifyingLiquidity: 900, bookDepthAtBand: 1200, asksDerivedByComplement: true, hasBook: true },
  },
};
const kYes = estimateReward({ venue: 'kalshi', capital: 1000, twoSided: true, distanceCents: 2, market: kalshiDual, side: 'yes' });
const kNo  = estimateReward({ venue: 'kalshi', capital: 1000, twoSided: true, distanceCents: 2, market: kalshiDual, side: 'no'  });
ok('Kalshi YES vs NO net differ (complement-derived asks handled)', kYes.netPerDay !== kNo.netPerDay);
ok('Kalshi YES (thinner competition) → higher share', kYes.shareOfPool! > kNo.shareOfPool!);

// Side chosen but that side requires two-sided (extreme mid) → single-sided scores 0.
const extremeSides: MarketSnapshot = {
  ...base,
  sides: {
    yes: { midpoint: 0.95, qualifyingLiquidity: 2000, bookDepthAtBand: 2000, twoSidedRequired: true, hasBook: true },
    no:  { midpoint: 0.05, qualifyingLiquidity: 2000, bookDepthAtBand: 2000, twoSidedRequired: true, hasBook: true },
  },
};
const yesSingleExtreme = estimateReward({ venue: 'polymarket', capital: 1000, twoSided: false, distanceCents: 3, market: extremeSides, side: 'yes' });
ok('side YES single-sided at mid 0.95 → score 0 + two-sided required', yesSingleExtreme.score === 0 && yesSingleExtreme.twoSidedRequired === true);

// One side's book empty → sideBookAvailable false, numbers withheld (never fabricated).
const oneEmpty: MarketSnapshot = {
  ...base,
  sides: {
    yes: { midpoint: 0.5, qualifyingLiquidity: 2000, bookDepthAtBand: 2000, hasBook: true },
    no:  { midpoint: null, qualifyingLiquidity: null, bookDepthAtBand: null, hasBook: false },
  },
};
const noEmpty = estimateReward({ venue: 'polymarket', capital: 1000, twoSided: true, distanceCents: 3, market: oneEmpty, side: 'no' });
ok('empty NO side → sideBookAvailable false', noEmpty.sideBookAvailable === false);
ok('empty NO side → shareOfPool null (qualifying liq missing)', noEmpty.shareOfPool === null);
ok('empty NO side → netPerDay null (nothing fabricated)', noEmpty.netPerDay === null);
ok('empty NO side → reason names the missing side', noEmpty.reasons.some(r => r.toLowerCase().includes('no side')));

// Side requested but snapshot has no per-side books → graceful legacy fallback.
const noSidesData = estimateReward({ venue: 'polymarket', capital: 1000, twoSided: true, distanceCents: 3, market: base, side: 'yes' });
ok('side requested but no sides in snapshot → usedSideBook false, still computes', noSidesData.usedSideBook === false && noSidesData.netPerDay != null);

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

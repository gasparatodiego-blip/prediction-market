'use strict';
// lib/polymarket-fees.js — SINGLE SOURCE OF TRUTH for Polymarket taker fees (CLOB v2).
//
// WHY THIS EXISTS: the codebase carried three mutually inconsistent, all-wrong Polymarket fee figures
// (a guessed 1% taker in sport-arb, a fabricated 2% "winnings" fee in the arb-ROI paths, and a flat 0%
// in the prediction API that flattered displayed ROI on fee-bearing markets). This module replaces all
// three with the REAL, per-market, live value — read from the CLOB, never hardcoded.
//
// GROUND TRUTH (verified on-chain + docs + live API, treated as given):
//   • Polymarket migrated to CLOB v2 on 2026-04-28. Fees are TAKER-ONLY and PROTOCOL-DETERMINED at
//     match time. MAKERS PAY 0. v2 removed feeRateBps from the signed order struct.
//   • GET /fee-rate?token_id=<id> returns a per-market {base_fee} in bps. NEVER hardcode; read it live.
//   • The documented per-category rate tables are unreliable (py-clob-client#326: /fee-rate disagrees
//     with the docs and with the market's own gamma feeSchedule.rate).
//
// THE FEE FORMULA (docs.polymarket.com/trading/fees, worked example confirmed):
//   fee_usd = C · feeRate · p · (1 − p)          (C = shares, p = execution price)
//   Worked example: crypto, 100 sh @ $0.30, feeRate 0.07 → 100·0.07·0.30·0.70 = $1.47 ✓
//   As a fraction of the leg's NOTIONAL cost (C·p):  fee/notional = feeRate · (1 − p).
//   That fraction — feeRate·(1−p) — is what takerFeeFraction() returns; a consumer holding a leg of
//   notional N pays N · takerFeeFraction, and per $1 payout the cost becomes p·(1 + takerFeeFraction).
//
// THE base_fee → feeRate CONVERSION — NOT OFFICIALLY DOCUMENTED, so read this carefully:
//   /fee-rate returns base_fee = 1000 UNIFORMLY across our markets (measured 216/217 active). The docs
//   never state how base_fee (bps) maps to the decimal feeRate in the formula. We triangulated:
//     · base_fee 1000 / 20000 = 0.05, which equals the on-chain maxFeeRateBps cap (500 = 5%) AND the
//       sports gamma feeSchedule.rate (0.05).
//     · A naive "1000 bps = 10%" reading is impossible — it exceeds the 5% on-chain cap.
//   BUT the gamma feeSchedule.rate is 0.04 on some markets (e.g. Xi Jinping) while /fee-rate still
//   returns 1000 → 0.05. The two sources DISAGREE (the documented #326 unreliability). Per the ground-
//   truth rule we trust the LIVE /fee-rate value, and where the sources disagree we take the HIGHER
//   (0.05, not 0.04) reading — the CONSERVATIVE one that LOWERS net edge. We never pick the flattering
//   (lower-fee) interpretation. If the true divisor is ever officially published and differs, change it
//   HERE only. This is the one place the conversion lives.
//
// HARD RULES (honest-engine):
//   • NEVER return a default/fallback fee on fetch failure, timeout, or unknown token → return null.
//     A null means the consumer must render "—" and must NOT present the row as a confirmed edge.
//   • NEVER hardcode a per-category rate table.
//   • No fabricated values anywhere.

const fs = require('fs');
const path = require('path');
// La cartella `data/` si CHIEDE al risolutore condiviso, non si conta con i «..»: sotto `lib/` un
// modulo puo' essere importato da una rotta, e nel bundle di Next `__dirname` e' .next/server/… —
// dove i «..» portano in `.next/data/`, una cartella che non esiste. Vedi lib/safety/store.js.
const { DATA_DIR } = require('./safety/store');
const { httpGet } = require('./httpGet');

const CLOB_BASE = 'https://clob.polymarket.com';
// base_fee → feeRate divisor. 1000/20000 = 0.05 = on-chain 5% cap = sports feeSchedule.rate.
// The conservative (max-fee, min-edge) reading where sources disagree. NOT officially documented.
const BASE_FEE_TO_RATE_DIVISOR = 20000;
// Makers are never charged under v2 (taker-only). This is a fact, not a config knob.
const MAKER_FEE = 0;

// Cache: fees are protocol/per-market config that changes rarely (not per-tick market data), so a long
// TTL is safe and spares the CLOB. 6h balances "won't miss a fee-schedule change for long" against load.
// Cache file lives under data/ and is GITIGNORED (runtime state, not source).
const CACHE_FILE = path.join(DATA_DIR, 'polymarket-fee-cache.json');
const CACHE_TTL_MS = 6 * 3_600_000;
const FETCH_TIMEOUT_MS = 5_000;

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function writeCache(obj) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, CACHE_FILE);
  } catch { /* cache is best-effort; a write failure must never fabricate a fee */ }
}

/**
 * Live per-market base_fee in bps for one token, or null.
 * Reads GET /fee-rate?token_id= through the deadline-bounded httpGet, cached to data/ with a 6h TTL.
 * Returns null on ANY failure, timeout, non-200, malformed body, or unknown token — never a default.
 * @param {string} tokenId  CLOB asset id (a single YES or NO outcome token)
 * @returns {Promise<number|null>}
 */
async function getBaseFeeBps(tokenId) {
  if (!tokenId) return null;
  const key = String(tokenId);
  const cache = readCache();
  const hit = cache[key];
  if (hit && typeof hit.baseFee === 'number' && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.baseFee;
  try {
    const r = await httpGet(`${CLOB_BASE}/fee-rate?token_id=${encodeURIComponent(key)}`, { timeoutMs: FETCH_TIMEOUT_MS, headers: { Accept: 'application/json' } });
    if (!r || r.status !== 200 || !r.data || typeof r.data.base_fee !== 'number') return null; // unknown → null, never a default
    const baseFee = r.data.base_fee;
    cache[key] = { baseFee, ts: Date.now() };
    writeCache(cache);
    return baseFee;
  } catch {
    return null; // timeout / network → null (honest "—"), NEVER a fabricated fee
  }
}

/**
 * PURE, SYNC core: the taker fee as a fraction of the leg's NOTIONAL, from a KNOWN base_fee.
 *   fraction = (base_fee / 20000) · (1 − price)
 * Returns null when base_fee is null/unknown or the price is out of (0,1) — the consumer renders "—".
 * Split out from the async fetch so the math is unit-testable and so consumers that already hold a
 * base_fee (e.g. from a batch fetch) can compute without another round-trip.
 * @param {number|null} baseFeeBps
 * @param {number} price  execution price of THIS taker leg (0..1)
 * @returns {number|null}
 */
function takerFeeFractionFromBps(baseFeeBps, price) {
  if (baseFeeBps == null || !Number.isFinite(baseFeeBps) || baseFeeBps < 0) return null;
  const p = Number(price);
  if (!(p > 0 && p < 1)) return null;
  const feeRate = baseFeeBps / BASE_FEE_TO_RATE_DIVISOR;
  return feeRate * (1 - p); // fee / notional; per $1 payout the cost becomes p·(1 + this)
}

/**
 * Async convenience: the taker fee fraction for a token at a price, reading base_fee live.
 * Returns null when the fee is unknown (→ "—"); never a default.
 * @param {string} tokenId
 * @param {number} price
 * @returns {Promise<number|null>}
 */
async function takerFeeFraction(tokenId, price) {
  const bps = await getBaseFeeBps(tokenId);
  return takerFeeFractionFromBps(bps, price);
}

module.exports = {
  getBaseFeeBps,
  takerFeeFraction,
  takerFeeFractionFromBps,
  MAKER_FEE,
  BASE_FEE_TO_RATE_DIVISOR,
  _CACHE_FILE: CACHE_FILE,
};

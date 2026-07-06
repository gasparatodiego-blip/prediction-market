'use strict';
/**
 * Unified persistent HISTORY LOGGER (parallel data sink).
 *
 * PURPOSE
 *   Snapshot the REAL, already-computed current state of every site section to durable
 *   disk each cycle, so that in 7/14/30 days there is a complete real dataset to answer
 *   "what did section X look like N days ago / over the last N days".
 *
 * HONEST-ENGINE CONTRACT
 *   - Logs ONLY values the app already computed this cycle. No new fetches, no recompute,
 *     no interpolation, no fabrication. Missing field → null.
 *   - Does NOT touch any live number, UI, or existing /tmp output. Pure additive sink.
 *   - Every hook wraps this in try/catch so a logging error can never break an agent.
 *   - The ONE derived value (funding netUsdPerDayPer1k) is a transparent arithmetic
 *     transform of the real computed netROI (%/yr) → $/day on a $1000 leg. It is data-only,
 *     never displayed, and fully reproducible from the stored netRoiPctYr.
 *
 * LAYOUT (daily rotation keeps files small + queryable)
 *   data/history/<section>/<YYYY-MM-DD>.json         → array of { t, iso, n, meta?, rows[] }
 *   data/history/<section>/<YYYY-MM-DD>.<NN>.json     → continuation part if a day exceeds MAX_FILE_MB
 *   data/history/<section>/_last.json                → { t } pointer for O(1) cadence throttle
 *
 * appendSnapshot(section, timestampMs, rawRows, meta?) — synchronous, self-throttling,
 * atomic (tmp+rename), dedups snapshots by timestamp, prunes files older than retention.
 */

const fs   = require('fs');
const path = require('path');

// ── Tunables ────────────────────────────────────────────────────────────────
const HISTORY_RETENTION_DAYS = 30;                 // drop day-files older than this
const MAX_FILE_MB            = 20;                  // roll a day into .NN parts past this size
const HISTORY_DIR            = path.join(__dirname, '..', 'data', 'history');

// Per-section minimum spacing between snapshots (ms). Hooks fire every agent cycle; the
// logger self-throttles so a 60s agent still only records at the section's real cadence.
const DEFAULT_CADENCE_MS = 15 * 60_000;            // 15 min
const CADENCE_MS = {
  funding:         15 * 60_000,   // per-pair opportunity board, 4×/hour
  basis:           15 * 60_000,   // cash-and-carry board
  'rewards-poly':  30 * 60_000,   // Polymarket LP rewards (slow-moving pools)
  'rewards-kalshi':30 * 60_000,   // Kalshi LIP rewards
  predarb:         15 * 60_000,   // cashable/near prediction-market arbs (often 0)
  leaderboard:      6 * 60 * 60_000, // ranked wallets move slowly → every 6h
  sports:          30 * 60_000,   // sports arbs (only fires if agent12 runs)
};

// ── Section projectors: real object → compact row (null when a field is absent). ──
// Sections without a projector are stored verbatim (small pass-through arrays).
const PROJECTORS = {
  // Funding per-pair snapshot from /tmp/unified-opportunities.json (type === 'FUNDING').
  funding(o) {
    const parts = String(o.id || '').split('-');          // funding-<COIN>-<short>-<long>
    const coin  = parts[1] ?? null;
    const legs  = Array.isArray(o.legs) ? o.legs : [];
    const S = legs.find(l => l.side === 'SHORT') || {};
    const L = legs.find(l => l.side === 'LONG')  || {};
    const netRoi = num(o.netROI);
    return {
      coin,
      shortVenue: parts[2] ?? null,
      longVenue:  parts[3] ?? null,
      shortRate: num(S.price), shortIntervalH: num(S.intervalHours), shortConfirmed: bool(S.confirmed), shortHistAvail: bool(S.historyAvailable),
      longRate:  num(L.price), longIntervalH:  num(L.intervalHours), longConfirmed:  bool(L.confirmed), longHistAvail:  bool(L.historyAvailable),
      netRoiPctYr:   netRoi,
      grossRoiPctYr: num(o.grossROI),
      annualizedROI: num(o.annualizedROI),
      predictedGrossApy: num(o.predictedGrossApy),
      // derived (data-only): net $/day on a $1000 leg from the real netROI %/yr.
      netUsdPerDayPer1k: netRoi == null ? null : +(netRoi / 100 * 1000 / 365).toFixed(4),
      breakevenDays: num(o.breakevenDays),
      totalFeesPct:  num(o.totalFeesPct),
      tier:   o.status ?? null,          // HARVEST / CAUTION / MARGINAL (real computed status)
      verdict: o.verdict ?? null,
      oneLegUnverified: bool(o.oneLegUnverified),
      fullyConfirmed:   bool(o.fullyConfirmed),
      spikeFlag:        bool(o.spikeFlag),
      capacityUsd:      num(o.capacityUsd),
      greenCapacityUsd: num(o.greenCapacityUsd),
      liquidityTier:    o.liquidityTier ?? null,
      thinFlag:         bool(o.thinFlag),
      depthThin:        bool(o.depthThin),
    };
  },

  // Basis / cash-and-carry from /tmp/basis-opportunities.json (opportunities[]).
  basis(o) {
    return {
      coin: o.asset ?? null, venue: o.exchange ?? null, instrument: o.contract ?? null,
      dir: o.type ?? null,
      spot: num(o.spot), future: num(o.future),
      spotBid: num(o.spotBid), spotAsk: num(o.spotAsk), futureBid: num(o.futureBid), futureAsk: num(o.futureAsk),
      basisPct: num(o.basis), indicativeBasisPct: num(o.indicativeBasisPct), executableBasisPct: num(o.executableBasisPct),
      grossAnnualized: num(o.grossAnnualized), netAnnualizedExecutable: num(o.netAnnualizedExecutable), netAnnualized: num(o.netAnnualized),
      expiry: o.expiry ?? null, daysToExpiry: num(o.daysToExpiry), feePct: num(o.fee),
      tier: o.tier ?? null, thinFlag: bool(o.thinFlag), coinMargined: bool(o.coinMargined),
      capacityUsd: num(o.capacityUsd), verdict: o.verdict ?? null,
    };
  },

  // Polymarket LP rewards from data/liquidity-rewards.json (markets[]).
  'rewards-poly'(m) {
    return {
      venue: 'polymarket', id: m.conditionId ?? null, title: m.question ?? null,
      dailyPool: num(m.rewardsDailyRate), maxSpread: num(m.rewardsMaxSpread), minSize: num(m.rewardsMinSize),
      mid: num(m.mid), bookSpread: num(m.bookSpread), existingLiquidityUsd: num(m.existing_depth_usd),
      endDate: m.endDate ?? null, negRisk: bool(m.negRisk), volatilityRisk: m.volatilityRisk ?? null,
      levels: compressLevels(m.levels, ['netRewardDay', 'netYieldPct', 'thinBookFlag', 'belowFloorFlag']),
    };
  },

  // Kalshi LIP rewards from data/kalshi-rewards.json (markets[]).
  'rewards-kalshi'(m) {
    return {
      venue: 'kalshi', id: m.ticker ?? null, title: m.question ?? null, status: m.status ?? null,
      dailyPool: num(m.pool_day), totalPeriodUsd: num(m.total_period_usd), periodDays: num(m.period_days),
      minSize: num(m.min_size), mid: num(m.book_mid), lastPrice: num(m.last_price),
      bestBid: num(m.best_bid), bestAsk: num(m.best_ask),
      competitorBids: num(m.competitor_qualifying_bids), competitorAsks: num(m.competitor_qualifying_asks),
      levels: compressLevels(m.levels, ['netRewardDay', 'netYieldPct', 'aboveMin']),
      flags: m.flags ?? null, trapReason: m.trap_reason ?? null,
    };
  },

  // Leaderboard ranked wallets from /tmp/leaderboard.json (bots[]). Index → rank.
  leaderboard(w, i) {
    const at = w.actorType || {};
    return {
      rank: i + 1, wallet: w.wallet ?? null, name: w.name ?? null,
      pnlUsdc: num(w.pnlUsdc), winRate: num(w.winRate), wilsonScore: num(w.wilsonScore),
      lowSample: bool(w.lowSample), resolvedMarkets: num(w.resolvedMarkets), volumeUsdc: num(w.volumeUsdc),
      walletType: w.walletType ?? null,
      actorType: at.type ?? null, actorConfidence: num(at.confidence), hft: bool(at.hft),
      // per-wallet category distribution is not carried on the bots[] rows → null (never fabricated).
      categoryDistribution: w.categoryDistribution ?? null,
    };
  },
  // predarb, sports → verbatim pass-through (already-computed, bounded arrays).
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function num(v)  { return typeof v === 'number' && isFinite(v) ? v : null; }
function bool(v) { return typeof v === 'boolean' ? v : (v == null ? null : !!v); }

// Keep only the requested keys from each capital level, dropping the heavy _internal fields.
function compressLevels(levels, keep) {
  if (!levels || typeof levels !== 'object') return null;
  const out = {};
  for (const [cap, lv] of Object.entries(levels)) {
    if (!lv || typeof lv !== 'object') continue;
    const row = {};
    for (const k of keep) row[k] = (k in lv) ? (typeof lv[k] === 'number' && !isFinite(lv[k]) ? null : lv[k]) : null;
    out[cap] = row;
  }
  return out;
}

function ymd(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function readLastTs(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '_last.json'), 'utf8')).t ?? 0; }
  catch { return 0; }
}

// Pick the target day-file, rolling to the next .NN part once a part reaches MAX_FILE_MB.
function targetFile(dir, date) {
  const base = path.join(dir, `${date}.json`);
  const capBytes = MAX_FILE_MB * 1024 * 1024;
  // enumerate existing parts for this date, in order: base, then .01, .02, …
  const parts = [base];
  let n = 1;
  while (true) {
    const p = path.join(dir, `${date}.${String(n).padStart(2, '0')}.json`);
    if (fs.existsSync(p)) { parts.push(p); n++; } else break;
  }
  const last = parts[parts.length - 1];
  let size = 0;
  try { size = fs.statSync(last).size; } catch { /* not created yet */ }
  if (size >= capBytes) return path.join(dir, `${date}.${String(parts.length).padStart(2, '0')}.json`);
  return last;
}

function pruneOld(dir, nowMs) {
  const cutoff = nowMs - HISTORY_RETENTION_DAYS * 86400_000;
  let files;
  try { files = fs.readdirSync(dir); } catch { return; }
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})(?:\.\d{2})?\.json$/);
    if (!m) continue;
    const day = Date.parse(m[1] + 'T00:00:00Z');
    if (isFinite(day) && day < cutoff - 86400_000) {   // one extra day of grace
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    }
  }
}

/**
 * Append one real snapshot for a section.
 * @param {string} section  one of the CADENCE_MS keys
 * @param {number} timestampMs  snapshot time (ms epoch, UTC)
 * @param {Array}  rawRows   the array the agent JUST computed (not recomputed)
 * @param {object} [meta]    optional snapshot-level real metadata (e.g. windowDays)
 * @returns {{written:boolean, skipped?:string, file?:string, count?:number}}
 */
function appendSnapshot(section, timestampMs, rawRows, meta) {
  const ts = Number(timestampMs) || Date.now();
  const dir = path.join(HISTORY_DIR, section);

  // cadence throttle (first snapshot always allowed)
  fs.mkdirSync(dir, { recursive: true });
  const last = readLastTs(dir);
  const cadence = CADENCE_MS[section] ?? DEFAULT_CADENCE_MS;
  if (last && ts - last < cadence) return { written: false, skipped: 'throttled' };

  const rows = Array.isArray(rawRows) ? rawRows : [];
  const project = PROJECTORS[section];
  const projected = project ? rows.map((r, i) => { try { return project(r, i, meta); } catch { return null; } }).filter(r => r !== null)
                            : rows;   // verbatim pass-through for predarb / sports

  const snapshot = { t: ts, iso: new Date(ts).toISOString(), n: projected.length, rows: projected };
  if (meta && typeof meta === 'object') snapshot.meta = meta;

  const date = ymd(ts);
  const file = targetFile(dir, date);
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
  if (arr.some(s => s && s.t === ts)) return { written: false, skipped: 'dup-timestamp' };  // dedup by timestamp
  arr.push(snapshot);
  atomicWriteJson(file, arr);
  atomicWriteJson(path.join(dir, '_last.json'), { t: ts });
  pruneOld(dir, ts);
  return { written: true, file, count: projected.length };
}

module.exports = { appendSnapshot, HISTORY_RETENTION_DAYS, MAX_FILE_MB, HISTORY_DIR, CADENCE_MS };

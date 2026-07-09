#!/usr/bin/env node
'use strict';

/**
 * agent28-perp-spot
 *
 * The "Perp vs Spot" (Ethena-style carry) feed. Every 60 s it derives, per coin,
 * the single BEST venue to SHORT the perp while holding SPOT — capturing the FULL
 * ABSOLUTE funding rate (shorts collect when funding is positive), NOT the
 * perp-vs-perp spread between two venues.
 *
 * NO new venue API calls. It reuses data already fetched by other agents:
 *   1. /tmp/exchange-prices.json  (agent10/agent15) → futures[venue][coin] current
 *      funding + interval + mark price + 24h volume, and exchanges[venue][coin] spot.
 *   2. data/funding-history-14d.json (agent15's durable settled mirror) → real
 *      trailing "how many consecutive settlements stayed positive" count. Honest,
 *      no projection — a real count from settled points only.
 *
 * Writes /tmp/perp-spot.json = [{ coin, shortVenue, fundingRateNative, intervalH,
 *   fundingPct8h, trailingPositiveSettlements, spotVenueSuggested,
 *   spotVenueVerified, markPrice, vol24hUsd, sourceAt, updatedAt }] sorted by
 * fundingPct8h desc. Only coins whose current best rate is genuinely POSITIVE
 * qualify; zero qualifying → empty array (shown calmly downstream).
 *
 * ALL money math (fees, breakeven, net/day, annualized cap) lives in the shared
 * estimator lib/funding-math.js estimatePerpSpot() and is computed at request time
 * in lib/spread-compute.ts — this agent emits ONLY the honest raw inputs. That keeps
 * a single source of truth for the dollar math and lets paid-tier redaction gate it.
 *
 * Zero Claude calls. No trades. Read-only + math only.
 */

const fs   = require('fs');
const path = require('path');
const { isRwaKey } = require('../lib/rwa');
const { isDeadContract, buildPeerMarks } = require('../lib/contract-liveness');
// Real, SOURCED per-leg fee schedules + the single perp-spot money model. We reuse the
// estimator's exact fee functions so the venue we CROWN here nets out identically to what
// the request-time estimator (lib/spread-compute) later shows — one source of truth.
const { venueFeePct, spotVenueFeePct, USDC_M_FEE_PCT } = require('../lib/funding-math');
let appendSnapshot = null;
try { ({ appendSnapshot } = require('../lib/history-logger')); } catch { /* optional */ }

const EXCHANGE_FILE      = '/tmp/exchange-prices.json';
const OUT_FILE           = '/tmp/perp-spot.json';
const HB_FILE            = '/tmp/agent-heartbeats.json';
const PERSIST_HISTORY    = path.join(__dirname, '..', 'data', 'funding-history-14d.json');
const INTERVAL_MS        = 60_000;
const MAX_SOURCE_AGE_MS  = 10 * 60_000;   // treat exchange-prices as usable within 10 min

// Spot venue candidates. A coin's short leg can be on any perp venue, but the spot leg
// should sit on a deep, liquid major with a SOURCED taker fee. Every venue here is in the
// estimator's sourced SPOT_FEE_PCT table (binance/okx/bybit 0.10%, gateio 0.20%), so we
// never auto-pick a venue whose spot fee we'd have to assume. Among those that CONFIRM a
// listing (from the spot `exchanges` map agent10 already fetches) we pick the CHEAPEST
// taker (ties broken by this order = liquidity preference). If none confirm it, we still
// suggest Binance but flag spotVenueVerified=false ("verify listing").
const SPOT_VENUE_PRIORITY = ['binance', 'okx', 'bybit', 'gateio'];

// Perp venue NAMES with a REAL, SOURCED taker fee in lib/funding-math (venueFeePct's
// explicit branches + the individually-sourced cex trio + the USDC-M schedule). A venue
// NOT in this set falls through venueFeePct() to the generic cex ASSUMPTION (0.04%). The
// honest engine forbids crowning a "best venue" on a fee we didn't source, so such venues
// are excluded from the max-net auto-selection (they can still be shorted manually — we
// just won't claim they're optimal on an assumed fee).
const PERP_FEE_SOURCED = new Set([
  'binance', 'bybit', 'okx',                                   // cex trio (VENUE_FEE_PCT.cex, each sourced)
  'hyperliquid', 'dydx', 'aster', 'lighter', 'extended',       // explicit venueFeePct() branches
  'pacifica', 'apex', 'paradex', 'edgex', 'grvt', 'gateio', 'bitget',
  ...Object.keys(USDC_M_FEE_PCT),                              // USDC-margined perps (sourced schedule)
]);

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

// Normalize a native %/interval funding rate (already stored ×100, i.e. a PERCENT such
// as 0.0069 = 0.0069%) to a common %/8h basis so venues on 1h/4h/8h cadences rank fairly.
//   %/8h = ratePerInterval × (8 / intervalHours)
function toPct8h(ratePerInterval, intervalHours) {
  const h = intervalHours > 0 ? intervalHours : 8;
  return ratePerInterval * (8 / h);
}

// Count consecutive most-recent settled periods that stayed positive for (venue, coin),
// straight from the durable 14-day settled mirror. Newest-first array of { t, rate }.
// Real count only — stops at the first non-positive settlement; 0 if none/absent.
function trailingPositive(persist, venue, coin) {
  const series = ((persist && persist.data && persist.data[venue]) || {})[coin];
  if (!Array.isArray(series) || series.length === 0) return 0;
  // Defensive: ensure newest-first by timestamp (the mirror already stores it so, but
  // never trust order blindly for an honest streak count).
  const sorted = series
    .filter(p => p && typeof p.t === 'number' && typeof p.rate === 'number')
    .sort((a, b) => b.t - a.t);
  let n = 0;
  for (const p of sorted) {
    if (p.rate > 0) n++;
    else break;
  }
  return n;
}

// Which major spot venue to buy the long hedge on for `coin` — the "long spot on the
// CHEAPEST venue" leg of the cross-venue carry. Two tiers, honest-engine:
//
//   1. EXECUTABLE (preferred): among sourced-fee venues that expose a REAL spot order
//      book (agent10 writes spotBookSource:'book' with spotBid/spotAsk + 20bps book-walked
//      depth), buy where the EFFECTIVE ask (executable ask × (1 + taker fee)) is cheapest.
//      This is genuinely fillable, so spotExecutable=true and spotCapacityUsd is the real
//      book-walked buy-leg depth (never OI). The crowned venue keeps a sourced spot fee, so
//      the request-time estimator nets identically.
//   2. FALLBACK (no book — e.g. an alt we don't fetch spot books for): keep the prior
//      listing-based suggestion (cheapest sourced taker among price-listed venues), but
//      flag spotExecutable=false and leave the executable spot fields null — never claim a
//      verified fill or fabricate depth.
//
// spotVenueVerified retains its original meaning (a sourced-fee major lists the coin) so no
// existing consumer regresses; spotExecutable is the NEW, stronger "real book read" signal.
function suggestSpotVenue(spot, coin) {
  const NULL_EXEC = { spotExecutable: false, spotAsk: null, spotBid: null, spotCapacityUsd: null, spotBookAt: null };

  // Tier 1 — real executable books (cheapest fillable buy wins).
  const book = [];
  for (const v of SPOT_VENUE_PRIORITY) {
    const e = (spot && spot[v] && spot[v][coin]) || null;
    if (!e || e.spotBookSource !== 'book') continue;
    const ask = Number(e.spotAsk);
    if (!isFinite(ask) || ask <= 0) continue;
    const fee = spotVenueFeePct(v);
    book.push({
      v, fee,
      ask,
      bid:    isFinite(Number(e.spotBid)) ? Number(e.spotBid) : null,
      effBuy: ask * (1 + fee / 100),                                        // executable ask incl. taker
      capUsd: isFinite(Number(e.spotAskDepthUsd)) ? Number(e.spotAskDepthUsd) : null,  // buy-leg 20bps book depth
      at:     typeof e.spotBookAt === 'number' ? e.spotBookAt : null,
    });
  }
  if (book.length) {
    book.sort((a, b) =>
      (a.effBuy - b.effBuy) ||                                             // cheapest EXECUTABLE buy wins
      (SPOT_VENUE_PRIORITY.indexOf(a.v) - SPOT_VENUE_PRIORITY.indexOf(b.v)));
    const w = book[0];
    return {
      spotVenueSuggested: w.v, spotVenueVerified: true, spotFeePct: w.fee,
      spotExecutable: true, spotAsk: w.ask, spotBid: w.bid, spotCapacityUsd: w.capUsd, spotBookAt: w.at,
    };
  }

  // Tier 2 — listing-based fallback (unchanged behavior; not executable).
  const listed = SPOT_VENUE_PRIORITY.filter(v => {
    const listing = (spot && spot[v]) || {};
    return listing[coin] && typeof listing[coin].price === 'number';
  });
  if (listed.length) {
    listed.sort((a, b) => {
      const fa = spotVenueFeePct(a), fb = spotVenueFeePct(b);
      if (fa !== fb) return fa - fb;                                       // cheapest taker wins
      return SPOT_VENUE_PRIORITY.indexOf(a) - SPOT_VENUE_PRIORITY.indexOf(b);
    });
    const v = listed[0];
    return { spotVenueSuggested: v, spotVenueVerified: true, spotFeePct: spotVenueFeePct(v), ...NULL_EXEC };
  }
  return { spotVenueSuggested: 'binance', spotVenueVerified: false, spotFeePct: spotVenueFeePct('binance'), ...NULL_EXEC };
}

function computeRows(raw, persist) {
  const futures = (raw && raw.futures) || {};
  const spot    = (raw && raw.exchanges) || {};
  const sourceAt = typeof raw.fetchedAt === 'number' ? raw.fetchedAt : null;

  // coin → array of QUALIFIED short-perp candidates (positive funding, guards passed,
  // SOURCED fee). We collect all, then per coin pick the one that maximizes NET $/day after
  // real fees — not the one with the highest raw funding. A slightly lower-funding venue on
  // a zero/low taker fee can net more per day than a fee-heavy venue with a hair more funding.
  const candidates = {};
  const now       = Date.now();
  const peerMarks = buildPeerMarks(futures);   // coin → [markPrice, …] across venues (rule c)
  for (const [venue, coins] of Object.entries(futures)) {
    for (const [coin, d] of Object.entries(coins || {})) {
      if (isRwaKey(coin)) continue;                     // commodities handled elsewhere (observation-only)
      const fr = d && d.fundingRate;
      if (typeof fr !== 'number' || !isFinite(fr) || fr <= 0) continue;  // shorts only collect on POSITIVE funding
      // Honest-engine: only auto-select venues whose taker fee is genuinely SOURCED. A venue
      // absent from the sourced table would net out on an ASSUMED cex fee — never crown it.
      if (!PERP_FEE_SOURCED.has(String(venue).toLowerCase())) {
        log(`excluded ${venue}:${coin} fee-unknown (no sourced taker fee — not auto-selected)`);
        continue;
      }
      // Dead/illiquid/cap-pinned contract guard (shared with agent15). A positive cap-pin
      // would otherwise render as a phantom perp-spot HARVEST card. Ring buffer = durable
      // settled mirror. Excluded here, logged once per cycle — never silently dropped.
      const hist = ((persist && persist.data && persist.data[venue]) || {})[coin] || [];
      const dead = isDeadContract(venue, coin, d, hist, { now, peerMarks: peerMarks[coin] });
      if (dead.dead) {
        log(`excluded ${venue}:${coin} dead-contract: ${dead.reason}`);
        continue;
      }
      const intervalH  = typeof d.fundingIntervalHours === 'number' && d.fundingIntervalHours > 0 ? d.fundingIntervalHours : 8;
      const fundingPct8h = toPct8h(fr, intervalH);
      (candidates[coin] || (candidates[coin] = [])).push({
        shortVenue:        venue,
        fundingRateNative: fr,
        intervalH,
        fundingPct8h,
        perpFeePct:        venueFeePct(venue),                          // sourced short-leg taker %
        markPrice:         typeof d.markPrice === 'number' ? d.markPrice : null,
        vol24hUsd:         typeof d.vol24hUsd === 'number' ? d.vol24hUsd : null,
      });
    }
  }

  const updatedAt = Date.now();
  const rows = Object.entries(candidates).map(([coin, cands]) => {
    // Spot leg is chosen independently (cheapest sourced taker that lists the coin); its fee
    // is therefore the SAME across every perp candidate, so it never moves the perp argmax —
    // but we fold it in so the recorded net matches the downstream estimator exactly.
    const spotSug = suggestSpotVenue(spot, coin);
    const spotFeePct = spotSug.spotFeePct;

    // Net $/day per $1k per-leg, mirroring estimatePerpSpot() EXACTLY:
    //   grossPerDay − feesOneTime/30,  feesOneTime = (perpFee·2 + spotFee·2)% of capital.
    // 3 settlements/day; the ·2 is open+close; /30 is the same 30-day amortization the
    // estimator and the perp-vs-perp selection use. No new constant.
    const REF = 1000;   // reference per-leg capital ($1k) — matches lib/spread-compute PERP_SPOT_REF_CAPITAL
    const scored = cands.map(c => {
      const grossPerDay   = REF * (c.fundingPct8h / 100) * 3;
      const feesOneTime   = REF * (c.perpFeePct * 2 + spotFeePct * 2) / 100;
      const netPerDay1kUsd = grossPerDay - feesOneTime / 30;
      return { ...c, netPerDay1kUsd };
    });
    // MAX net/day wins; ties → higher raw funding, then venue name (deterministic).
    scored.sort((a, b) =>
      (b.netPerDay1kUsd - a.netPerDay1kUsd) ||
      (b.fundingPct8h   - a.fundingPct8h)   ||
      (a.shortVenue < b.shortVenue ? -1 : a.shortVenue > b.shortVenue ? 1 : 0)
    );
    const win    = scored[0];
    const runner = scored[1] || null;

    return {
      coin,
      shortVenue:                  win.shortVenue,
      fundingRateNative:           +win.fundingRateNative.toFixed(6),   // native %/interval
      intervalH:                   win.intervalH,
      fundingPct8h:                +win.fundingPct8h.toFixed(6),        // normalized %/8h
      trailingPositiveSettlements: trailingPositive(persist, win.shortVenue, coin),
      spotVenueSuggested:          spotSug.spotVenueSuggested,
      spotVenueVerified:           spotSug.spotVenueVerified,
      // Executable spot leg (cross-venue): real book bid/ask + book-walked buy capacity.
      // null when no book was read (alt without a fetched spot book) — never fabricated.
      spotExecutable:              spotSug.spotExecutable,
      spotAsk:                     spotSug.spotAsk,
      spotBid:                     spotSug.spotBid,
      spotCapacityUsd:             spotSug.spotCapacityUsd,
      spotBookAt:                  spotSug.spotBookAt,
      markPrice:                   win.markPrice,
      vol24hUsd:                   win.vol24hUsd,
      // ── fee-aware (max-net) selection provenance (transparency; downstream ignores these) ──
      selectionBasis:              'net-per-day',
      perpFeePct:                  +win.perpFeePct.toFixed(4),          // sourced short-leg taker %
      spotFeePct:                  +spotFeePct.toFixed(4),              // sourced spot-leg taker %
      netPerDay1kUsd:              +win.netPerDay1kUsd.toFixed(4),      // $/day per $1k/leg (est-consistent)
      runnerUp:                    runner ? {
        shortVenue:     runner.shortVenue,
        fundingPct8h:   +runner.fundingPct8h.toFixed(6),
        perpFeePct:     +runner.perpFeePct.toFixed(4),
        netPerDay1kUsd: +runner.netPerDay1kUsd.toFixed(4),
      } : null,
      sourceAt,
      updatedAt,
    };
  });

  // Net/day primary: serve highest-net first (ties → raw funding). The frontend re-sorts by
  // net/day anyway; this keeps the feed's own order honest and net-first too.
  rows.sort((a, b) => (b.netPerDay1kUsd - a.netPerDay1kUsd) || (b.fundingPct8h - a.fundingPct8h));
  return rows;
}

function tick() {
  const raw = readJsonSafe(EXCHANGE_FILE);
  if (!raw) {
    log('no /tmp/exchange-prices.json yet — skipping');
    return;
  }
  const sourceAt = typeof raw.fetchedAt === 'number' ? raw.fetchedAt : 0;
  const ageMs    = Date.now() - sourceAt;
  const stale    = ageMs > MAX_SOURCE_AGE_MS;

  const persist = readJsonSafe(PERSIST_HISTORY);   // may be null → trailing counts default 0 (honest)
  const rows = computeRows(raw, persist);

  atomicWrite(OUT_FILE, {
    updatedAt: Date.now(),
    sourceAt:  sourceAt || null,
    stale,
    rows,
  });

  // Durable history (verbatim pass-through — no projector for 'perp-spot'; default 15-min cadence).
  if (appendSnapshot && rows.length) {
    try { appendSnapshot('perp-spot', Date.now(), rows); } catch { /* non-fatal */ }
  }

  // heartbeat
  try {
    const hb = readJsonSafe(HB_FILE) || {};
    hb['agent28-perp-spot'] = { ts: Date.now(), coins: rows.length, stale };
    atomicWrite(HB_FILE, hb);
  } catch { /* non-fatal */ }

  log(`wrote ${rows.length} coin(s)${stale ? ' (source STALE)' : ''}${rows.length ? ` — top net ${rows[0].coin} $${rows[0].netPerDay1kUsd.toFixed(2)}/day/1k @ ${rows[0].shortVenue} (+${rows[0].fundingPct8h.toFixed(4)}%/8h)` : ''}`);
}

function log(msg) {
  console.log(`[agent28-perp-spot] ${new Date().toISOString()} ${msg}`);
}

// Exported for unit testing the pure derivation in isolation.
module.exports = { computeRows, toPct8h, trailingPositive, suggestSpotVenue };

if (require.main === module) {
  log('starting');
  tick();
  setInterval(tick, INTERVAL_MS);
}

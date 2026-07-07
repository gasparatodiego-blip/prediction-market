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
let appendSnapshot = null;
try { ({ appendSnapshot } = require('../lib/history-logger')); } catch { /* optional */ }

const EXCHANGE_FILE      = '/tmp/exchange-prices.json';
const OUT_FILE           = '/tmp/perp-spot.json';
const HB_FILE            = '/tmp/agent-heartbeats.json';
const PERSIST_HISTORY    = path.join(__dirname, '..', 'data', 'funding-history-14d.json');
const INTERVAL_MS        = 60_000;
const MAX_SOURCE_AGE_MS  = 10 * 60_000;   // treat exchange-prices as usable within 10 min

// Suggested spot venue priority. A coin's short leg can be on any perp venue, but the
// spot leg should sit on a deep, liquid major. We suggest the first of these that we can
// CONFIRM lists the coin (from the spot `exchanges` map agent10 already fetches); if none
// confirm it, we still suggest Binance but flag spotVenueVerified=false ("verify listing").
const SPOT_VENUE_PRIORITY = ['binance', 'okx', 'bybit', 'gateio'];

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

// Which major spot venue to suggest for `coin`. Prefer a CONFIRMED listing in the spot
// map; fall back to Binance (suggested, unverified) so the row still renders honestly.
function suggestSpotVenue(spot, coin) {
  for (const v of SPOT_VENUE_PRIORITY) {
    const listing = (spot && spot[v]) || {};
    if (listing[coin] && typeof listing[coin].price === 'number') {
      return { spotVenueSuggested: v, spotVenueVerified: true };
    }
  }
  return { spotVenueSuggested: 'binance', spotVenueVerified: false };
}

function computeRows(raw, persist) {
  const futures = (raw && raw.futures) || {};
  const spot    = (raw && raw.exchanges) || {};
  const sourceAt = typeof raw.fetchedAt === 'number' ? raw.fetchedAt : null;

  // coin → best positive short candidate across all perp venues
  const best = {};   // coin → { shortVenue, fundingRateNative, intervalH, fundingPct8h, markPrice, vol24hUsd }
  const now       = Date.now();
  const peerMarks = buildPeerMarks(futures);   // coin → [markPrice, …] across venues (rule c)
  for (const [venue, coins] of Object.entries(futures)) {
    for (const [coin, d] of Object.entries(coins || {})) {
      if (isRwaKey(coin)) continue;                     // commodities handled elsewhere (observation-only)
      const fr = d && d.fundingRate;
      if (typeof fr !== 'number' || !isFinite(fr) || fr <= 0) continue;  // shorts only collect on POSITIVE funding
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
      const prev = best[coin];
      if (!prev || fundingPct8h > prev.fundingPct8h) {
        best[coin] = {
          shortVenue:        venue,
          fundingRateNative: fr,
          intervalH,
          fundingPct8h,
          markPrice:         typeof d.markPrice === 'number' ? d.markPrice : null,
          vol24hUsd:         typeof d.vol24hUsd === 'number' ? d.vol24hUsd : null,
        };
      }
    }
  }

  const updatedAt = Date.now();
  const rows = Object.entries(best).map(([coin, b]) => {
    const spotSug = suggestSpotVenue(spot, coin);
    return {
      coin,
      shortVenue:                  b.shortVenue,
      fundingRateNative:           +b.fundingRateNative.toFixed(6),   // native %/interval
      intervalH:                   b.intervalH,
      fundingPct8h:                +b.fundingPct8h.toFixed(6),        // normalized %/8h
      trailingPositiveSettlements: trailingPositive(persist, b.shortVenue, coin),
      spotVenueSuggested:          spotSug.spotVenueSuggested,
      spotVenueVerified:           spotSug.spotVenueVerified,
      markPrice:                   b.markPrice,
      vol24hUsd:                   b.vol24hUsd,
      sourceAt,
      updatedAt,
    };
  });

  rows.sort((a, b) => b.fundingPct8h - a.fundingPct8h);
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

  log(`wrote ${rows.length} coin(s)${stale ? ' (source STALE)' : ''}${rows.length ? ` — top ${rows[0].coin} +${rows[0].fundingPct8h.toFixed(4)}%/8h @ ${rows[0].shortVenue}` : ''}`);
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

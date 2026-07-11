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
 * Reuses data already fetched by other agents for all funding/spot inputs. The ONE
 * network call it makes itself is the SHORT-leg perp book walk (per crowned row) so the
 * displayed capacity is the true whole-trade capacity = min(spot buy-depth, perp
 * sell-depth) — real book-walked 20bps depth, never OI. Inputs it reuses:
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
// Real per-(perp venue, asset) max leverage + maintenance margin (free public sources, or
// honest null). Refreshed on a throttled cadence; each crowned row is stamped from the cache.
const leverageCaps = require('../lib/leverage-caps');
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

// ── PERP short-leg book walk (whole-trade capacity = min of BOTH legs) ───────────
// The spot (long) leg's 20bps buy-depth is already walked by agent10 (spotCapacityUsd).
// To make the DISPLAYED capacity the true whole-trade capacity we must also walk the
// PERP (short) leg's book: shorting the perp SELLS into the bids, so the short-leg
// capacity is the USD resting depth within 20bps of best BID (real book, NEVER OI).
// whole-trade capacity = min(spot buy-depth, perp sell-depth) — the leg that binds first.
//
// Only venues with a PROVEN free public book whose size is quoted in BASE COIN (so
// price×size = USD with no contract multiplier) are walked here. Venues quoting size in
// CONTRACTS (okx/gateio/bitget) or behind a numeric id-map (lighter/edgex), and any venue
// whose book we can't cleanly read, are LEFT UNWALKED — their rows stay honestly
// spot-bound (or null), never fabricated. This mirrors agent10's spot-book walk exactly.
const PERP_BOOK_BAND_BPS = 20;
const PERP_BOOK_TIMEOUT_MS = 6_000;

// Walk the BID side (short = sell into bids): sum USD notional resting within BAND_BPS of
// best bid. `bids` is a normalized [[price, size], …] descending, size in BASE COIN.
function walkPerpBidDepthUsd(bids, bandBps = PERP_BOOK_BAND_BPS) {
  if (!Array.isArray(bids) || !bids.length) return null;
  const best = parseFloat(bids[0][0]);
  if (!isFinite(best) || best <= 0) return null;
  const lim = best * (1 - bandBps / 1e4);
  let usd = 0;
  for (const lvl of bids) {
    const pr = parseFloat(lvl[0]), sz = parseFloat(lvl[1]);
    if (!isFinite(pr) || !isFinite(sz)) continue;
    if (pr < lim) break;                    // sorted descending — past the 20bps band
    usd += pr * sz;
  }
  return usd > 0 ? Math.round(usd) : null;
}

// Per-venue perp-book fetch. Each entry returns a normalized descending BID array
// [[price, size], …] (size in BASE COIN) or null. All endpoints are public/no-key and
// were confirmed walkable + coin-denominated in Phase 0 (2026-07-09).
const PERP_BOOK_VENUES = {
  binance:     { url: c => `https://fapi.binance.com/fapi/v1/depth?symbol=${c}USDT&limit=50`,
                 bids: d => d?.bids },
  bybit:       { url: c => `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${c}USDT&limit=50`,
                 bids: d => d?.result?.b },
  apex:        { url: c => `https://omni.apex.exchange/api/v3/depth?symbol=${c}USDT&limit=50`,
                 bids: d => d?.data?.b },
  dydx:        { url: c => `https://indexer.dydx.trade/v4/orderbooks/perpetualMarket/${c}-USD`,
                 bids: d => (Array.isArray(d?.bids) ? d.bids.map(o => [o.price, o.size]) : null) },
  extended:    { url: c => `https://api.starknet.extended.exchange/api/v1/info/markets/${c}-USD/orderbook`,
                 bids: d => (Array.isArray(d?.data?.bid) ? d.data.bid.map(o => [o.price, o.qty]) : null) },
  hyperliquid: { method: 'POST', url: () => 'https://api.hyperliquid.xyz/info',
                 body: c => ({ type: 'l2Book', coin: c }),
                 bids: d => (Array.isArray(d?.levels?.[0]) ? d.levels[0].map(o => [o.px, o.sz]) : null) },
  grvt:        { method: 'POST', url: () => 'https://market-data.grvt.io/full/v1/book',
                 body: c => ({ instrument: `${c}_USDT_Perp`, depth: 50 }),
                 bids: d => (Array.isArray(d?.result?.bids) ? d.result.bids.map(o => [o.price, o.size]) : null) },
};

async function fetchJson(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PERP_BOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// Walk the crowned short venue's perp bid book → USD depth within 20bps (real book, never
// OI). Returns null when the venue has no walkable public book (honest: caller stays
// spot-bound) or the fetch/parse fails / book is empty. Never fabricates.
async function fetchPerpBidDepthUsd(venue, coin) {
  const spec = PERP_BOOK_VENUES[String(venue).toLowerCase()];
  if (!spec) return null;                                   // venue not walkable → honest null
  const url = spec.url(coin);
  const opts = spec.method === 'POST'
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec.body(coin)) }
    : undefined;
  const d = await fetchJson(url, opts);
  if (!d) return null;
  const bids = spec.bids(d);
  return walkPerpBidDepthUsd(bids);
}

// Enrich each computed row with the SHORT-leg perp book depth and the true whole-trade
// capacity = min(spot buy-depth, perp sell-depth). Mutates rows in place. One fetch per
// crowned row (~25/cycle), all public/no-key. Honest fallback when the perp isn't walkable.
async function enrichPerpDepth(rows) {
  await Promise.all(rows.map(async (row) => {
    const spotCap = row.spotExecutable && typeof row.spotCapacityUsd === 'number' && row.spotCapacityUsd > 0
      ? row.spotCapacityUsd : null;
    const perpCap = await fetchPerpBidDepthUsd(row.shortVenue, row.coin);

    row.perpShortDepthUsd = perpCap;                        // 20bps bid-side depth (short sells into bids)
    row.perpDepthWalked   = perpCap != null;
    row.perpBookAt        = perpCap != null ? Date.now() : null;

    // whole-trade capacity = min of BOTH real book-walked legs; honest fallbacks otherwise.
    if (spotCap != null && perpCap != null) {
      row.wholeTradeCapacityUsd = Math.min(spotCap, perpCap);
      row.capacityBind = spotCap <= perpCap ? 'spot' : 'perp';   // which leg binds first
    } else if (spotCap != null) {
      row.wholeTradeCapacityUsd = spotCap;                 // perp book unavailable → spot-bound (labeled)
      row.capacityBind = 'spot-only';
    } else if (perpCap != null) {
      row.wholeTradeCapacityUsd = perpCap;                 // spot leg not book-walked → perp-bound (labeled)
      row.capacityBind = 'perp-only';
    } else {
      row.wholeTradeCapacityUsd = null;                    // neither leg walked → not measured (never fabricated)
      row.capacityBind = 'none';
    }
  }));
  return rows;
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
      // Perp SHORT-leg book + whole-trade capacity. Filled by enrichPerpDepth() (async book
      // walk) after this pure derivation; initialized null so the row shape is stable and the
      // unit-tested pure path never depends on the network. wholeTradeCapacityUsd is the true
      // min(spot buy-depth, perp sell-depth); perpShortDepthUsd is the short leg's 20bps bid
      // depth (real book, never OI); both null when the perp venue has no walkable book.
      perpShortDepthUsd:           null,
      perpDepthWalked:             false,
      perpBookAt:                  null,
      wholeTradeCapacityUsd:       null,
      capacityBind:                'none',
      // Real short-perp leverage cap + maintenance margin (stamped by enrichLeverageCaps()
      // after the pure derivation). null when the venue exposes no free public cap (honest
      // "—", never a guessed max) → the row is non-leverageable downstream (effective 1×).
      maxLeverage:                 null,
      maintenanceMarginPct:        null,
      leverageSource:              null,
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

// Stamp each crowned row with its SHORT venue's real max leverage + maintenance margin from
// lib/leverage-caps (throttled bulk refresh, then per-row cache lookup). Mutates rows in
// place. Honest: a venue/coin with no free public cap stays null → "leverage —" downstream,
// never a fabricated number. Failures degrade to the prior cache (or nulls); never fatal.
async function enrichLeverageCaps(rows) {
  if (!rows.length) return rows;
  const venues = rows.map(r => r.shortVenue);
  let cache = leverageCaps.readCache();
  try {
    cache = await leverageCaps.refreshCaps(venues, { log });
  } catch (e) {
    log(`leverage-caps refresh error: ${e && e.message}`);   // keep prior cache
  }
  for (const row of rows) {
    const cap = leverageCaps.getCap(cache, row.shortVenue, row.coin);
    row.maxLeverage          = cap.maxLeverage;
    row.maintenanceMarginPct = cap.maintenanceMarginPct;
    row.leverageSource       = cap.source;
  }
  return rows;
}

async function tick() {
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
  // Walk the crowned short venue's perp bid book → whole-trade capacity = min(spot, perp).
  // Network I/O isolated here (computeRows stays pure/testable); failures degrade honestly.
  try { await enrichPerpDepth(rows); } catch (e) { log(`perp-depth enrich error: ${e.message}`); }
  // Stamp real max-leverage + maintenance margin per crowned row (throttled bulk refresh).
  try { await enrichLeverageCaps(rows); } catch (e) { log(`leverage-caps enrich error: ${e.message}`); }

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
module.exports = { computeRows, toPct8h, trailingPositive, suggestSpotVenue, walkPerpBidDepthUsd, enrichPerpDepth, fetchPerpBidDepthUsd, enrichLeverageCaps };

if (require.main === module) {
  log('starting');
  tick();
  setInterval(tick, INTERVAL_MS);
}

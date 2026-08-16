'use strict';
// scripts/crypto-5min/lib/discovery.js — PRIMARY-SOURCE discovery + data-availability audit for the
// short-dated (~5 minute) Polymarket crypto up/down markets. Offline-safe: public keyless REST only
// (Gamma + CLOB). Reads no key, signs nothing, places nothing. Imports ONLY from
// scripts/rewards-ceiling/lib (read-only). Does not touch scripts/rewards-replay or app/**.

const fs = require('fs');
const path = require('path');
const { getJson } = require('../../rewards-ceiling/lib/fetch');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const UPDOWN_RE = /updown-5m|up-or-down-5m/;

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function windowStartFromSlug(slug) { const m = typeof slug === 'string' && slug.match(/(\d{10})/); return m ? Number(m[1]) : null; }

// Find 5-minute crypto up/down markets from the ACTIVE set (primary source: Gamma). Returns the raw
// market objects (untouched) plus a light structural view. Never fabricates a market.
async function findFiveMinMarkets({ limit = 500 } = {}) {
  const r = await getJson(`${GAMMA}/markets?closed=false&active=true&limit=${limit}&order=endDate&ascending=true`);
  const arr = Array.isArray(r.data) ? r.data : [];
  const five = arr.filter((m) => typeof m.slug === 'string' && UPDOWN_RE.test(m.slug));
  return { scanned: arr.length, markets: five, status: r.status };
}

// Structural view of ONE market from its raw Gamma object. All fields are read straight from the source;
// a field the venue did not return stays null.
function structure(m) {
  let tokens = []; try { tokens = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []); } catch { tokens = []; }
  let outcomes = []; try { outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || []); } catch { outcomes = []; }
  const winStart = windowStartFromSlug(m.slug);
  return {
    question: m.question ?? null,
    slug: m.slug ?? null,
    conditionId: m.conditionId ?? null,
    tokenIdUp: tokens[0] ?? null,
    tokenIdDown: tokens[1] ?? null,
    outcomes,
    windowStartEpoch: winStart,
    windowStartIso: winStart ? new Date(winStart * 1000).toISOString() : null,
    windowEndEpoch: winStart ? winStart + 300 : null, // slug epoch + 5 minutes (the real trading window)
    durationSeconds: 300,
    tickSize: fin(m.orderPriceMinTickSize) ? m.orderPriceMinTickSize : (m.orderPriceMinTickSize != null ? Number(m.orderPriceMinTickSize) : null),
    orderMinSize: m.orderMinSize ?? null,
    resolutionSource: m.resolutionSource ?? null,
    acceptingOrders: m.acceptingOrders ?? null,
    enableOrderBook: m.enableOrderBook ?? null,
    closed: m.closed ?? null,
    bestBid: m.bestBid ?? null,
    bestAsk: m.bestAsk ?? null,
  };
}

// Is this conditionId present in agent34's collected mid-history / trade tape? (grep the data files)
function inCollection(conditionId) {
  if (!conditionId) return { found: false, files: [] };
  let files = [];
  try { files = fs.readdirSync(DATA_DIR).filter((f) => /^(mid-history|trade-tape)-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)); } catch { return { found: false, files: [] }; }
  const hits = [];
  for (const f of files) {
    try { if (fs.readFileSync(path.join(DATA_DIR, f), 'utf8').includes(conditionId)) hits.push(f); } catch { /* skip */ }
  }
  return { found: hits.length > 0, files: hits };
}

// What does the public CLOB prices-history retain for a token? Returns point count, cadence, and the fields
// present — used to show that even when non-empty it is MID/last at ≥1-minute fidelity, not ask+depth@47s.
async function pricesHistory(tokenId, { fidelity = 1 } = {}) {
  if (!tokenId) return { points: 0, cadenceSeconds: null, sample: null, note: 'no token' };
  const r = await getJson(`${CLOB}/prices-history?market=${tokenId}&interval=max&fidelity=${fidelity}`);
  const pts = (r.data && r.data.history) || [];
  const cadence = pts.length > 1 ? pts[1].t - pts[0].t : null;
  return { points: pts.length, cadenceSeconds: cadence, sample: pts[0] || null, fields: pts[0] ? Object.keys(pts[0]) : [], note: pts.length ? 'mid/last price series (no ask, no depth)' : 'no retained history' };
}

// Live order book for a token — exists ONLY for a currently-tradeable market; an expired market has none.
async function liveBook(tokenId) {
  if (!tokenId) return { asks: 0, bids: 0, status: null };
  const r = await getJson(`${CLOB}/book?token_id=${tokenId}`);
  return { asks: ((r.data && r.data.asks) || []).length, bids: ((r.data && r.data.bids) || []).length, status: r.status };
}

module.exports = { findFiveMinMarkets, structure, inCollection, pricesHistory, liveBook, windowStartFromSlug, UPDOWN_RE, GAMMA, CLOB };

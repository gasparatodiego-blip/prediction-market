'use strict';
// scripts/rewards-replay/lib/tape.js — read agent34's executed-trade tape (data/trade-tape-*.jsonl) and
// detect fills from REAL prints instead of inferred level crossings. OFFLINE, read-only.
//
// SCHEMA (confirmed from the writer agent34.appendTrade and the market-channel last_trade_price frame):
//   tsVenueMs, tsVenueIso, tsLocalIso, marketId, tokenId, price, size, side, feeRateBps, txHash, src
//
// FILL MODEL (per the task): a resting BUY at price p is filled when a trade PRINTS at or below p on that
// token; a resting SELL at p when a trade prints at or above p. SIZE IS RESPECTED — a print of S shares
// fills at most S of our resting order, so a small print only PARTIALLY fills a large order; the remainder
// stays until the next re-quote. Placement + the mid trajectory for markout come from the mid-history
// journal (the tape has no mid); the tape supplies only the real fills.

const fs = require('fs');
const path = require('path');
const { rowNear } = require('./journal');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const TAPE_KEYS = ['tsVenueMs', 'tsLocalIso', 'marketId', 'tokenId', 'price', 'size', 'side', 'src'];

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function clampPrice(p) { return Math.max(0.01, Math.min(0.99, p)); }
function snapToTick(price, tick) {
  if (!(tick > 0) || !fin(price)) return null;
  const dp = (String(tick).split('.')[1] || '').length;
  let s = Number((Math.round(price / tick) * tick).toFixed(dp));
  const lo = Number(tick.toFixed(dp)), hi = Number((1 - tick).toFixed(dp));
  if (s < lo) s = lo; if (s > hi) s = hi;
  return s;
}

function listTapeFiles() {
  let files = [];
  try { files = fs.readdirSync(DATA_DIR); } catch { return []; }
  return files.filter((f) => /^trade-tape-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));
}

// Load the tape grouped by tokenId, ascending by best available timestamp (venue if published, else local).
function loadTape({ fromMs = -Infinity, toMs = Infinity } = {}) {
  const files = listTapeFiles();
  const byToken = new Map();
  let rows = 0, malformed = 0, minTs = Infinity, maxTs = -Infinity;
  let schemaConfirmed = null, schemaMismatch = null;
  for (const file of files) {
    let content = ''; try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { malformed++; continue; }
      if (schemaConfirmed == null) { const miss = TAPE_KEYS.filter((k) => !(k in r)); schemaConfirmed = miss.length === 0; if (!schemaConfirmed) schemaMismatch = miss; }
      const tsMs = fin(r.tsVenueMs) ? r.tsVenueMs : Date.parse(r.tsLocalIso);
      if (!Number.isFinite(tsMs) || tsMs < fromMs || tsMs > toMs) continue;
      rows++;
      if (tsMs < minTs) minTs = tsMs; if (tsMs > maxTs) maxTs = tsMs;
      if (!byToken.has(r.tokenId)) byToken.set(r.tokenId, []);
      byToken.get(r.tokenId).push({ ...r, tsMs });
    }
  }
  for (const arr of byToken.values()) arr.sort((a, b) => a.tsMs - b.tsMs);
  return {
    files: files.map((f) => path.basename(f)), rows, malformed, byToken,
    window: { fromMs: Number.isFinite(minTs) ? minTs : null, toMs: Number.isFinite(maxTs) ? maxTs : null, hours: Number.isFinite(minTs) ? (maxTs - minTs) / 3_600_000 : 0 },
    schemaConfirmed: !!schemaConfirmed, schemaMismatch,
  };
}

/**
 * Tape-based fills for one market. Placement is a follow-the-mid maker (from the journal); fills come from
 * real prints in each 45s interval, size-respecting (partial). Returns fills in the SAME shape the markout
 * + net modules already consume, plus tradePrice/filledShares/partial/orderShares for the audit.
 */
function reconstructTapeFillsForMarket(marketRows, tokenTrades, cfg) {
  const { offsetCents, sizeUsd, maxInventoryUsd } = cfg;
  const fills = [];
  const reasons = {};
  let excluded = 0, capped = 0, placedIntervals = 0, partials = 0;
  let inventoryShares = 0;
  const excl = (why) => { excluded++; reasons[why] = (reasons[why] || 0) + 1; };
  let ptr = 0; // moving index into tokenTrades (intervals are time-ordered)

  for (let i = 0; i < marketRows.length - 1; i++) {
    const t = marketRows[i], n = marketRows[i + 1];
    if (!fin(t.adjMid) || !fin(t.tick)) { excl('placement null (adjMid/tick)'); continue; }
    placedIntervals++;
    const price = clampPrice(t.adjMid);
    const orderShares = sizeUsd > 0 ? sizeUsd / price : 0;
    const maxInvShares = maxInventoryUsd > 0 ? maxInventoryUsd / price : Infinity;
    const bidPrice = snapToTick(t.adjMid - offsetCents / 100, t.tick);
    const askPrice = snapToTick(t.adjMid + offsetCents / 100, t.tick);
    const inBandBid = fin(t.bandLow) && fin(t.bandHigh) ? (bidPrice >= t.bandLow - 1e-9 && bidPrice <= t.bandHigh + 1e-9) : null;
    const inBandAsk = fin(t.bandLow) && fin(t.bandHigh) ? (askPrice >= t.bandLow - 1e-9 && askPrice <= t.bandHigh + 1e-9) : null;
    let remBid = orderShares, remAsk = orderShares;
    while (ptr < tokenTrades.length && tokenTrades[ptr].tsMs < t.tsMs) ptr++; // skip trades before this interval
    let p = ptr;
    while (p < tokenTrades.length && tokenTrades[p].tsMs < n.tsMs) {
      const tr = tokenTrades[p]; p++;
      if (!fin(tr.price) || !fin(tr.size) || tr.size <= 0) { excl('trade null price/size'); continue; }
      // BUY fills when a print is at/below our bid; SELL when at/above our ask (price-based, per the task).
      if (bidPrice != null && tr.price <= bidPrice + 1e-12 && remBid > 1e-9) {
        const room = Math.max(0, maxInvShares - inventoryShares);
        const filled = Math.min(remBid, tr.size, room);
        if (filled <= 1e-9) { capped++; }
        else {
          const partial = filled < orderShares - 1e-9; if (partial) partials++;
          remBid -= filled; inventoryShares += filled;
          fills.push(mkFill('buy', bidPrice, tr, filled, orderShares, partial, inBandBid, marketRows));
        }
      }
      if (askPrice != null && tr.price >= askPrice - 1e-12 && remAsk > 1e-9) {
        const room = Math.max(0, maxInvShares + inventoryShares);
        const filled = Math.min(remAsk, tr.size, room);
        if (filled <= 1e-9) { capped++; }
        else {
          const partial = filled < orderShares - 1e-9; if (partial) partials++;
          remAsk -= filled; inventoryShares -= filled;
          fills.push(mkFill('sell', askPrice, tr, filled, orderShares, partial, inBandAsk, marketRows));
        }
      }
    }
  }
  return { fills, excluded: { count: excluded, reasons }, capped, placedIntervals, partials };
}

function mkFill(side, orderPrice, tr, filledShares, orderShares, partial, inBand, marketRows) {
  // markout is measured on adjMid at the fill time; the journal supplies the mid the tape lacks.
  const at = rowNear(marketRows, tr.tsMs, 40_000);
  return {
    marketId: tr.marketId, tokenId: tr.tokenId, side, tsMs: tr.tsMs, ts: tr.tsVenueIso || tr.tsLocalIso,
    price: orderPrice, tradePrice: tr.price, sizeShares: filledShares, orderShares, partial,
    adjMidFill: at && fin(at.adjMid) ? at.adjMid : null, src: tr.src || 'tape', inBand, takerSide: tr.side || null,
  };
}

function reconstructTapeFills(journalByMarket, tapeByToken, marketTokens, cfg) {
  const all = [];
  const reasons = {};
  let excluded = 0, capped = 0, placedIntervals = 0, partials = 0;
  for (const [marketId, rows] of journalByMarket.entries()) {
    const tokenId = marketTokens.get(marketId);
    const trades = (tokenId && tapeByToken.get(tokenId)) || [];
    const r = reconstructTapeFillsForMarket(rows, trades, cfg);
    all.push(...r.fills);
    excluded += r.excluded.count; capped += r.capped; placedIntervals += r.placedIntervals; partials += r.partials;
    for (const [k, v] of Object.entries(r.excluded.reasons)) reasons[k] = (reasons[k] || 0) + v;
  }
  return { fills: all, excluded: { count: excluded, reasons }, capped, placedIntervals, partials };
}

module.exports = { loadTape, reconstructTapeFills, reconstructTapeFillsForMarket, snapToTick, TAPE_KEYS };

'use strict';

/**
 * instrument-expiry — single source of truth for dated-future expiry.
 *
 * Honest-engine rule: a basis/carry number from a dated future that has already
 * expired is a FABRICATED number (the contract no longer trades; its "locked to
 * expiry" return is meaningless). Expired instruments must be excluded everywhere
 * — producer (agent19) and every render surface (landing app/page.tsx, dashboard
 * carry via /api/carry) — using ONE parser so they can never disagree.
 *
 * Handles the three dated-future naming schemes agent19 covers:
 *   Deribit      BTC-25SEP26      → 25 Sep 2026   (DD MMM YY)
 *   Binance      BTCUSD_260925 / BTCUSDT_260925 → 25 Sep 2026   (YYMMDD)
 *   OKX          BTC-USD-260925   → 25 Sep 2026   (YYMMDD)
 * Contracts settle at 08:00 UTC on the expiry date (matches agent19's parsers).
 *
 * Pure, dependency-free, CommonJS so both the Node agents and the Next.js
 * server/client bundles can consume it (see instrument-expiry.d.ts for types).
 */

const MONTH_IDX = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function ymdToMs(yy, mm, dd) {
  const yr = 2000 + yy, mo = mm - 1;
  // Reject impossible dates (e.g. month 13, day 32) rather than let Date roll them over.
  if (mo < 0 || mo > 11 || dd < 1 || dd > 31) return null;
  const t = Date.UTC(yr, mo, dd, 8, 0, 0);
  const d = new Date(t);
  if (d.getUTCFullYear() !== yr || d.getUTCMonth() !== mo || d.getUTCDate() !== dd) return null;  // rolled over ⇒ invalid
  return t;
}

/**
 * Parse a dated-future instrument name → expiry epoch ms, or null if the name is
 * not a recognized dated-future symbol (perps, spot, malformed → null).
 */
function parseInstrumentExpiryMs(name) {
  if (typeof name !== 'string' || !name) return null;

  // Deribit: BTC-25SEP26
  let m = name.match(/^[A-Z]+-(\d{2})([A-Z]{3})(\d{2})$/);
  if (m) {
    const mon = MONTH_IDX[m[2]];
    if (mon === undefined) return null;
    return ymdToMs(parseInt(m[3], 10), mon + 1, parseInt(m[1], 10));
  }

  // Binance COIN-M / USDT-M: BTCUSD_260925 or BTCUSDT_260925 (YYMMDD)
  m = name.match(/^[A-Z]+_(\d{6})$/);
  if (m) {
    const y = m[1];
    return ymdToMs(parseInt(y.slice(0, 2), 10), parseInt(y.slice(2, 4), 10), parseInt(y.slice(4, 6), 10));
  }

  // OKX: BTC-USD-260925 (YYMMDD)
  m = name.match(/^[A-Z]+-[A-Z]+-(\d{6})$/);
  if (m) {
    const y = m[1];
    return ymdToMs(parseInt(y.slice(0, 2), 10), parseInt(y.slice(2, 4), 10), parseInt(y.slice(4, 6), 10));
  }

  return null;
}

/**
 * Resolve a row's expiry (ms). Prefer the explicit ISO `expiry` the producer
 * emits; fall back to parsing the contract/instrument name. Returns null when
 * expiry cannot be determined (do NOT invent one).
 */
function rowExpiryMs(row) {
  if (row && typeof row.expiry === 'string') {
    const t = Date.parse(row.expiry);
    if (isFinite(t)) return t;
  }
  return parseInstrumentExpiryMs(row && (row.contract || row.instrument || row.name));
}

/** True iff the row's expiry is known AND already at/before `now`. Unknown ⇒ false. */
function isExpired(row, now) {
  const t = rowExpiryMs(row);
  if (t == null) return false;
  return t <= (typeof now === 'number' ? now : Date.now());
}

/** True iff the row has a determinable expiry strictly in the future. */
function isLive(row, now) {
  const t = rowExpiryMs(row);
  return t != null && t > (typeof now === 'number' ? now : Date.now());
}

module.exports = { parseInstrumentExpiryMs, rowExpiryMs, isExpired, isLive, MONTH_IDX };

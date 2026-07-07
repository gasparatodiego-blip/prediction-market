// lib/display-sanity.ts — render-time sanity validation for every displayed row.
//
// Defense in depth: the LAST gate before any opportunity row/card is serialized to a
// tab. Producers (agent15/19/28, rewards normalizers) already exclude bad data, but a
// producer regression, a stale file, or an unforeseen edge case can still emit a
// phantom number. validateRow() is the net that catches it at the door.
//
// Honest-engine: a row that references an expired/dead instrument, carries a
// null/NaN/absurd rate or price, claims an over-cap annualized figure without the
// run-rate label, or claims a computed net while missing the legs it was computed
// from, is a FABRICATED display. Reject it (with a logged reason) — the UI simply
// shows fewer rows, calmly. Rejections are NEVER silent: filterSane logs
// "sanity-reject <section> <id>: <reason>" so a regression is visible (and the
// auditor can detect a reject-rate spike).
//
// Thresholds are task-sanctioned (Phase-3 spec) and reuse the existing APY_CAP.

import { APY_CAP } from '@/lib/honest-display';
import { isExpired, rowExpiryMs } from '@/lib/instrument-expiry';

export type SanitySection = 'funding' | 'perp-spot' | 'basis' | 'rewards' | 'prediction';

export interface SanityResult {
  ok: boolean;
  reason?: string;
}

// A per-leg funding rate this large (%/interval) is not a real value at any venue — it
// is a data glitch or an exchange funding-cap artifact (the edgeX-TRX class). Generous
// enough that a genuine extreme (e.g. ~0.5%/h) is never rejected.
const FUNDING_PCT_PER_INTERVAL_MAX = 2.0;

function isNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

// Present-but-not-a-finite-number ⇒ corrupt. Absent (null/undefined) is handled
// separately per field (some fields are legitimately redacted to null for free tier).
function isBadNum(v: unknown): boolean {
  return v != null && (typeof v !== 'number' || !isFinite(v));
}

function r(reason: string): SanityResult { return { ok: false, reason }; }
const OK: SanityResult = { ok: true };

/**
 * Validate one row for a given section. Returns {ok:true} to display, or
 * {ok:false, reason} to drop. Pure — never throws, never mutates.
 */
export function validateRow(section: SanitySection, row: any, now: number = Date.now()): SanityResult {
  if (!row || typeof row !== 'object') return r('row is not an object');

  // Universal: an explicitly dead-flagged or expired instrument never renders.
  if (row.dead === true) return r('instrument flagged dead');
  if (rowExpiryMs(row) != null && isExpired(row, now)) return r('instrument expired');

  switch (section) {
    case 'funding': {
      // Core public rates must be finite (they are never redacted).
      if (!isNum(row.frShort) || !isNum(row.frLong)) return r('funding leg rate null/NaN');
      if (Math.abs(row.frShort) > FUNDING_PCT_PER_INTERVAL_MAX)
        return r(`frShort ${row.frShort}%/interval exceeds plausible cap ${FUNDING_PCT_PER_INTERVAL_MAX}`);
      if (Math.abs(row.frLong) > FUNDING_PCT_PER_INTERVAL_MAX)
        return r(`frLong ${row.frLong}%/interval exceeds plausible cap ${FUNDING_PCT_PER_INTERVAL_MAX}`);
      // Derived edge fields, when present (paid tier), must be finite and within cap.
      // The producer caps the spread at APY_CAP, so anything over ⇒ a regression, not a
      // legitimate-but-labeled figure (funding rows carry no run-rate label field).
      if (isBadNum(row.grossApy) || isBadNum(row.netApy30d)) return r('derived apy null/NaN');
      if (isNum(row.grossApy) && Math.abs(row.grossApy) > APY_CAP + 0.5)
        return r(`grossApy ${row.grossApy}%/yr exceeds display cap ${APY_CAP}`);
      // Claims a computed net but is missing a leg it was computed from.
      if (row.netApy30d != null && (!row.shortExchange || !row.longExchange))
        return r('claims net but a leg venue is missing');
      return OK;
    }

    case 'perp-spot': {
      if (!row.coin || !row.shortVenue) return r('missing coin/shortVenue');
      if (!isNum(row.fundingPct8h)) return r('fundingPct8h null/NaN');
      if (Math.abs(row.fundingPct8h) > FUNDING_PCT_PER_INTERVAL_MAX)
        return r(`fundingPct8h ${row.fundingPct8h} exceeds plausible cap ${FUNDING_PCT_PER_INTERVAL_MAX}`);
      const e = row.edge;
      if (e && typeof e === 'object') {
        if (isBadNum(e.netPerDay1k) || isBadNum(e.grossPerDay1k)) return r('edge $/day null/NaN');
        // Over-cap annualized is only honest if it carries the run-rate cap flag.
        if (isNum(e.annualizedRunRatePct) && Math.abs(e.annualizedRunRatePct) > APY_CAP && e.annualizedCapped !== true)
          return r(`annualizedRunRatePct ${e.annualizedRunRatePct}%/yr over cap without run-rate label`);
        // Claims a net $/day but funding (the only income source) is non-positive.
        if (isNum(e.netPerDay1k) && e.netPerDay1k > 0 && !(row.fundingPct8h > 0))
          return r('claims net $/day but funding is not positive');
      }
      return OK;
    }

    case 'basis': {
      // Expiry already checked universally above; here validate the money fields.
      const net = isNum(row.netAnnualizedExecutable) ? row.netAnnualizedExecutable
                : isNum(row.netAnnualized) ? row.netAnnualized : null;
      if (row.netAnnualizedExecutable != null && !isNum(row.netAnnualizedExecutable)) return r('netAnnualizedExecutable NaN');
      if (net != null && Math.abs(net * 100) > APY_CAP) return r(`net ${(net * 100).toFixed(0)}%/yr exceeds display cap ${APY_CAP}`);
      // A basis row that claims a locked return must reference a live dated contract.
      if (net != null && rowExpiryMs(row) == null) return r('claims basis return but expiry is unknown');
      return OK;
    }

    case 'rewards': {
      // Pool / liquidity / size must never be negative or non-finite where present
      // (a negative reward pool is a fabricated number).
      for (const f of ['dailyPool', 'qualifyingLiquidity', 'bookDepthAtBand', 'minSize', 'maxSpread']) {
        if (row[f] != null) {
          if (!isNum(row[f])) return r(`${f} null/NaN`);
          if (row[f] < 0) return r(`${f} is negative (${row[f]})`);
        }
      }
      // Prediction-market prices/levels are probabilities — must sit inside [0,1].
      for (const f of ['midpoint', 'lastPrice']) {
        if (row[f] != null) {
          if (!isNum(row[f])) return r(`${f} null/NaN`);
          if (row[f] < 0 || row[f] > 1) return r(`${f} ${row[f]} outside [0,1]`);
        }
      }
      return OK;
    }

    case 'prediction': {
      // Prediction-market prices/levels are probabilities — must sit inside [0,1].
      for (const f of ['price', 'yesPrice', 'noPrice', 'bid', 'ask', 'mid', 'level']) {
        if (row[f] != null) {
          if (!isNum(row[f])) return r(`${f} null/NaN`);
          if (row[f] < 0 || row[f] > 1) return r(`${f} ${row[f]} outside [0,1]`);
        }
      }
      return OK;
    }

    default:
      return OK;
  }
}

function rowId(section: SanitySection, row: any): string {
  switch (section) {
    case 'funding':   return `funding-${row?.coin}-${row?.shortExchange}-${row?.longExchange}`;
    case 'perp-spot': return `perp-spot-${row?.coin}-${row?.shortVenue}`;
    case 'basis':     return `basis-${row?.asset}-${row?.exchange}-${row?.contract}`;
    case 'rewards':   return `rewards-${row?.marketId ?? row?.market ?? row?.id ?? '?'}`;
    case 'prediction':return `prediction-${row?.platform ?? '?'}-${row?.id ?? row?.marketId ?? '?'}`;
    default:          return String(row?.id ?? '?');
  }
}

/**
 * Filter a row list through validateRow, dropping + logging every reject. Returns the
 * surviving rows. Logs "sanity-reject <section> <id>: <reason>" per drop — the signal
 * the auditor watches for a producer regression.
 */
export function filterSane<T>(section: SanitySection, rows: T[] | null | undefined, now: number = Date.now()): T[] {
  if (!Array.isArray(rows)) return [];
  const out: T[] = [];
  for (const row of rows) {
    const v = validateRow(section, row, now);
    if (v.ok) out.push(row);
    else console.log(`sanity-reject ${section} ${rowId(section, row)}: ${v.reason}`);
  }
  return out;
}

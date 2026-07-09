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

import { readFileSync } from 'fs';
import { APY_CAP } from '@/lib/honest-display';
import { isExpired, rowExpiryMs } from '@/lib/instrument-expiry';

export type SanitySection = 'funding' | 'perp-spot' | 'usdc' | 'basis' | 'rewards' | 'prediction';

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

    case 'usdc': {
      // USDC-margined divergence lane. Public teaser = both legs' real funding + the
      // annualized divergence; the $ edge is redactable. Reject fabricated displays.
      if (!row.coin || !row.shortVenue || !row.longVenue) return r('missing coin/leg venue');
      if (!isNum(row.frShortPct8h) || !isNum(row.frLongPct8h)) return r('funding leg rate null/NaN');
      for (const f of ['frShortPct8h', 'frLongPct8h'] as const) {
        if (Math.abs(row[f]) > FUNDING_PCT_PER_INTERVAL_MAX)
          return r(`${f} ${row[f]} exceeds plausible cap ${FUNDING_PCT_PER_INTERVAL_MAX}`);
      }
      if (isNum(row.grossApyPct) && Math.abs(row.grossApyPct) > APY_CAP + 0.5)
        return r(`grossApyPct ${row.grossApyPct}%/yr exceeds display cap ${APY_CAP}`);
      // Every row MUST have ≥1 USDC leg — a pure USDT↔USDT pair belongs to the main lane.
      if (row.shortMargin !== 'USDC' && row.longMargin !== 'USDC') return r('no USDC leg (belongs to main lane)');
      const e = row.edge;
      if (e && typeof e === 'object') {
        if (isBadNum(e.netPerDay1k) || isBadNum(e.grossPerDay1k)) return r('edge $/day null/NaN');
        // Over-cap annualized only honest with the run-rate cap flag.
        if (isNum(e.annualizedRunRatePct) && Math.abs(e.annualizedRunRatePct) > APY_CAP && e.annualizedCapped !== true)
          return r(`annualizedRunRatePct ${e.annualizedRunRatePct}%/yr over cap without run-rate label`);
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
    case 'usdc':      return `usdc-${row?.coin}-${row?.shortVenue}-${row?.longVenue}`;
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

// ── Serve-side source-of-truth ENFORCEMENT (Phase 2) ────────────────────────
// agent29-verifier re-reads each served row's key field straight from the venue
// and writes /tmp/verification-status.json. This layer applies that verdict at
// the door:
//   • 'mismatch'  → the row is DROPPED (logged) — a value the venue positively
//                   contradicts never renders.
//   • 'unreachable' (couldn't re-read at source) or a stale 'ok' → the row is
//                   KEPT but flagged stale and DEMOTED below verified rows (never
//                   silently trusted, never silently removed).
//   • 'ok' (fresh) → passes, tagged verified with the real verifiedAt.
//   • no status yet (new/rotating row, or verifier down) → passes, tagged
//                   'verifying' so nothing vanishes while awaiting its first check.
// The verdict travels on row.__verify for the UI badge (Phase 3).

const VERIFICATION_FILE = '/tmp/verification-status.json';
// Whole file older than this ⇒ verifier down/slow: fail OPEN to 'verifying' for
// every row (don't falsely claim 'ok', don't nuke the board to stale).
const STATUS_FILE_STALE_MS = 15 * 60_000;
// A per-row 'ok' older than this is no longer fresh enough to badge as verified.
const ROW_VERIFY_FRESH_MS  = 10 * 60_000;

// 'confirmed' = the number is backed by a real, slip-walked order-book depth
// (agent15) with both funding legs confirmed, but the budget-capped source-verifier
// (agent29) has not independently re-read it this cycle. We make NO verified claim
// for it — the UI simply renders no badge — but we must not paint a permanent
// "verifying…", which would misrepresent a stuck state as a transient one.
export type VerifyStatus = 'ok' | 'verifying' | 'stale' | 'mismatch' | 'confirmed' | 'unreachable';
export interface VerifyMeta { status: VerifyStatus; verifiedAt?: number; ageMs?: number; source?: any; }

let _vsCache: { at: number; data: { rows: Record<string, any>; fresh: boolean } | null } | null = null;
function readVerificationStatus(now: number): { rows: Record<string, any>; fresh: boolean } | null {
  if (_vsCache && now - _vsCache.at < 1000) return _vsCache.data;   // coalesce reads within a request
  let parsed: any = null;
  try { parsed = JSON.parse(readFileSync(VERIFICATION_FILE, 'utf8')); } catch { parsed = null; }
  const data = parsed && typeof parsed.updatedAt === 'number'
    ? { rows: parsed.rows || {}, fresh: (now - parsed.updatedAt) < STATUS_FILE_STALE_MS }
    : null;
  _vsCache = { at: now, data };
  return data;
}

// Verification key — MUST match lib/source-verify.js's key builders. Funding is
// canonicalized on SORTED venues (spread-compute may reorder short/long, so the
// key must be order-independent).
function verifyKey(section: SanitySection, row: any): string {
  switch (section) {
    case 'funding': {
      const venues = [row?.shortExchange, row?.longExchange].filter(Boolean).map(String).sort();
      return `funding-${row?.coin}-${venues.join('-')}`;
    }
    case 'perp-spot': return `perp-spot-${row?.coin}-${row?.shortVenue}`;
    case 'usdc': {
      // Order-independent on the (venue+margin) legs — computeUsdcArb fixes short=higher
      // funding, but keep the key stable if the two legs ever swap roles across cycles.
      const legs = [
        `${row?.shortVenue}:${row?.shortMargin}`,
        `${row?.longVenue}:${row?.longMargin}`,
      ].sort();
      return `usdc-${row?.coin}-${legs.join('-')}`;
    }
    case 'basis':     return `basis-${row?.asset}-${row?.exchange}-${row?.contract}`;
    case 'rewards':   return `rewards-${row?.marketId ?? row?.market ?? row?.id ?? '?'}`;
    default:          return rowId(section, row);
  }
}

/**
 * Apply the verifier's verdict to a (already sanity-filtered) row list: drop
 * mismatches, tag each survivor with row.__verify, and demote stale/unreachable
 * rows below verified ones (stable). Call AFTER filterSane in each route.
 */
export function enforceVerified<T>(section: SanitySection, rows: T[] | null | undefined, now: number = Date.now()): T[] {
  if (!Array.isArray(rows)) return [];
  const vs = readVerificationStatus(now);
  const kept: T[] = [];
  const demoted: T[] = [];
  for (const row of rows) {
    const key   = verifyKey(section, row as any);
    const entry = vs && vs.fresh ? vs.rows[key] : null;
    let meta: VerifyMeta;
    if (!entry) {
      // Fail-open. agent29 is budget-capped (free-tier rate limits) and re-reads only
      // a head + rotating sample each cycle, so most rows never get an entry. A row
      // whose capacity was slip-walked from a REAL order book and whose funding legs
      // are both confirmed is NOT "awaiting a first check" — a permanent "verifying…"
      // would falsely imply a pending re-read that will never come. Mark it 'confirmed'
      // (no badge, no claim) so the stuck state clears; keep the honest "verifying…"
      // only for genuinely unconfirmed rows that legitimately await confirmation.
      const r = row as any;
      // funding: real slip-walked green depth + both legs confirmed (dc35681).
      // basis (cash & carry): capacity slip-walked from a REAL order book
      // (capacitySource === 'book', e.g. Bybit) with a positive depth — the analog
      // of greenCapacityUsd. Proxy-capacity rows (vol/OI estimate) are NOT book-
      // confirmed and honestly keep "verifying…" until agent29 re-reads them.
      const depthConfirmed =
        (section === 'funding' && r.oneLegUnverified === false && r.greenCapacityUsd != null)
        || (section === 'basis' && r.capacitySource === 'book' && r.capacityUsd != null && r.capacityUsd > 0);
      if (depthConfirmed) {
        meta = { status: 'confirmed' };
      } else if (section === 'rewards') {
        // Rewards: agent29 re-reads only a head + rotating sample each cycle (free-tier
        // budget), so most rows never get a status entry — they must NOT sit forever on a
        // misleading "verifying…" that implies a pending re-read which will never arrive.
        // Polymarket pools ARE an independently re-readable source field (Gamma
        // clobRewards.rewardsDailyRate — the sampled rows reconcile EXACTLY, e.g.
        // servedPool 4789 == sourcePool 4789), and the row's book depth is a REAL price×size
        // measurement: an un-sampled Polymarket row makes no claim and renders NO badge
        // ('confirmed'), exactly like a book-confirmed funding/basis row. Kalshi pools are
        // DERIVED (totalUsd/periodDays) — no single-source re-read exists — so show the
        // honest "no source-verify adapter" (unreachable): never a fabricated ✓, never an
        // eternal "verifying…".
        meta = (r.venue === 'polymarket' && r.dailyPool != null && r.bookDepthAtBand != null)
          ? { status: 'confirmed' }
          : { status: 'unreachable' };
      } else {
        meta = { status: 'verifying' };
      }
    } else if (entry.status === 'mismatch') {
      console.log(`sanity-reject ${section} ${key}: source verification mismatch ${JSON.stringify(entry.source || {}).slice(0, 160)}`);
      continue;                                                        // DROP — never render a contradicted value
    } else if (entry.status === 'unreachable') {
      // A source we DO have an adapter for was momentarily unreachable ⇒ 'stale' (amber).
      // But a SAMPLED Kalshi rewards row reports 'unreachable' because its pool is DERIVED
      // and has no single-source adapter at all — a structural "no adapter", not a transient
      // outage — so show the honest "no source-verify adapter", matching the un-sampled
      // Kalshi rows above (consistent; never an amber "stale" for a non-adapter section).
      meta = (section === 'rewards' && (row as any).venue !== 'polymarket')
        ? { status: 'unreachable', verifiedAt: entry.verifiedAt }
        : { status: 'stale', verifiedAt: entry.verifiedAt, ageMs: now - (entry.verifiedAt || now) };
    } else if (entry.status === 'ok') {
      const age = now - (entry.verifiedAt || 0);
      meta = age < ROW_VERIFY_FRESH_MS
        ? { status: 'ok',    verifiedAt: entry.verifiedAt, ageMs: age }
        : { status: 'stale', verifiedAt: entry.verifiedAt, ageMs: age };
    } else {
      meta = { status: 'verifying' };
    }
    (row as any).__verify = meta;
    if (meta.status === 'stale') demoted.push(row); else kept.push(row);
  }
  return kept.concat(demoted);
}

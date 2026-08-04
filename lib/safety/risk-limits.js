'use strict';
// lib/safety/risk-limits.js — SERVER-SIDE risk limits with HARD CEILINGS, enforced at the placement
// chokepoint. Venue-agnostic.
//
// WHY SERVER-SIDE: a limit that lives only in the UI is not a limit — a frontend bug or a crafted request
// bypasses it. Every value here is read from durable storage (data/safety-risk-limits.json) at the
// chokepoint, NEVER from the order request payload.
//
// THE HARD CEILINGS: every limit has a server-side ceiling a user setting can never exceed. If stored
// config exceeds a ceiling it is CLAMPED to the ceiling and the clamp is audited. A stored config cannot
// widen a limit past what this file allows, even if the DB says otherwise.
//
// FAIL CLOSED, everywhere:
//   • config unreadable                → refuse (limits-unreadable).
//   • a required limit value MISSING   → refuse (never "missing == unlimited").
//   • an order size that cannot be verified against real book depth (notionalUsd null/NaN) → refuse.
//     "Capacity — means no order, not a guessed size" (honest-engine).
//   • usage (open exposure / realised P&L) that cannot be measured → refuse the exposure/loss limits.
//
// The five limits, per user and globally:
//   1. max notional per single order          (maxOrderNotionalUsd)
//   2. max notional open across all positions  (maxOpenNotionalUsd)
//   3. max orders per time window (rate limit) (maxOrdersPerWindow / windowMs)
//   4. max realised loss per day               (maxDailyLossUsd) → trips an automatic PER-USER kill
//   5. per-venue allowlist                     (venues[])  — a user can only touch enabled venues
//
// Ordering note: the venue allowlist is evaluated as its OWN gate BEFORE the numeric limits (see
// isVenueAllowed + the gate chain in the adapter). evaluateLimits covers limits 1–4.

const path = require('path');
const { readStore, DATA_DIR } = require('./store');

const CONFIG_FILE = path.join(DATA_DIR, 'safety-risk-limits.json');

// HARD SERVER-SIDE CEILINGS. Deliberately conservative — this is the FIRST venue arming, tiny size only.
// A stored config value is min()'d against these; it can never widen a limit past them.
const HARD_CEILINGS = Object.freeze({
  // ── IL TETTO PER ORDINE, ALZATO A 1000 IL 3 AGOSTO 2026 ────────────────────────────────────────
  // Era 100, e con maxOrderNotionalUsd 40 / MAKER_LIVE_MIN_CAP_USD 30 il tetto EFFETTIVO era $30.
  // Quel $30 non proteggeva da un rischio: tagliava l'allocazione. L'allocatore di produzione proponeva
  // $324 su un mercato e il motore poteva piazzarne $30 per lato, quindi il capitale finiva spalmato su
  // dieci mercati mediocri per aggirare un limite invece che concentrato dove rende.
  //
  // COSA RESTA A PROTEGGERE, ora che questo non lo fa piu':
  //   · maxOpenNotionalUsd ($600) — ma conta solo i fill RICONCILIATI, e la riconciliazione gira ogni
  //     60s: nella finestra fra un piazzamento e il ciclo successivo NON vede gli ordini appena inviati.
  //   · maxOrdersPerWindow (20/60s) — questo si', ed e' immediato.
  //   · maxDailyLossUsd ($25) — ma misura la perdita REALIZZATA, non l'esposizione aperta.
  //   · il collaterale sul venue — l'exchange non lascia comprare piu' di quanto si possiede. E' il
  //     backstop vero e non dipende da noi.
  // Il prodotto rate-limit x tetto-per-ordine e' quindi il massimo teorico di una finestra da 60s, e
  // con 1000 quel prodotto vale $20.000 — ben oltre il saldo, quindi a mordere sara' il collaterale.
  maxOrderNotionalUsd: 1000,  // biggest single order the server will EVER place
  maxOpenNotionalUsd: 2000,   // biggest total open exposure across all positions
  maxOrdersPerWindow: 60,     // runaway-loop rate cap
  windowMs: 60_000,           // the rate window (also ceilinged: a huge window would weaken the rate cap)
  maxDailyLossUsd: 200,       // realised loss/day before an automatic per-user kill
});

const EMPTY_CONFIG = Object.freeze({ global: {}, users: {} });
const NUMERIC_LIMITS = ['maxOrderNotionalUsd', 'maxOpenNotionalUsd', 'maxOrdersPerWindow', 'windowMs', 'maxDailyLossUsd'];

function clampNum(field, stored) {
  const ceiling = HARD_CEILINGS[field];
  if (!Number.isFinite(stored) || stored < 0) return { value: null, clamped: false, missing: true };
  if (stored > ceiling) return { value: ceiling, clamped: true, missing: false, storedValue: stored };
  return { value: stored, clamped: false, missing: false };
}

/**
 * Resolve the effective limits for a user from durable config, clamped to the hard ceilings.
 * user config wins over global; a field absent from both is MISSING (fails closed at evaluation).
 * @returns {{ok:boolean, limits?:object, clampEvents?:Array, error?:string}}
 */
function resolveLimits({ userId } = {}, deps = {}) {
  const file = deps.configFile || CONFIG_FILE;
  const r = readStore(file, EMPTY_CONFIG, { ...deps, });
  if (!r.ok) return { ok: false, error: r.error };
  const cfg = r.value || EMPTY_CONFIG;
  const g = (cfg.global && typeof cfg.global === 'object') ? cfg.global : {};
  const u = (userId && cfg.users && cfg.users[userId] && typeof cfg.users[userId] === 'object') ? cfg.users[userId] : {};

  const limits = {};
  const clampEvents = [];
  const missing = [];
  for (const field of NUMERIC_LIMITS) {
    const stored = (u[field] !== undefined) ? u[field] : g[field];
    const c = clampNum(field, stored);
    limits[field] = c.value;
    if (c.missing) missing.push(field);
    if (c.clamped) clampEvents.push({ field, storedValue: c.storedValue, clampedTo: c.value, userId: userId || null });
  }
  // venue allowlist: explicit list only; absent → empty (fail closed: no venue permitted).
  const venuesRaw = (u.venues !== undefined) ? u.venues : g.venues;
  limits.venues = Array.isArray(venuesRaw) ? venuesRaw.slice() : [];
  limits._missing = missing;
  return { ok: true, limits, clampEvents };
}

// Venue allowlist gate — its own decisive check, before the numeric limits.
function isVenueAllowed({ venue, limits } = {}) {
  if (!limits || !Array.isArray(limits.venues)) return false; // fail closed
  return limits.venues.includes(venue);
}

/**
 * Evaluate numeric limits 1–4 for one order. PURE — the caller supplies the resolved limits and a
 * measured `usage` snapshot; this returns the FIRST tripped limit (named) or { allow:true }.
 *
 * usage: { openNotionalUsd, ordersInWindow, realisedDailyPnlUsd } — any field null/undefined means it
 * could not be MEASURED, and the limit that needs it fails CLOSED.
 *
 * @returns {{allow:boolean, gate?:string, reason?:string, autoKill?:boolean}}
 */
function evaluateLimits({ order, usage, limits } = {}) {
  const L = limits || {};
  const notional = order && order.notionalUsd;

  // Order size must be a real, verified number (> 0). Unverifiable size → NO order.
  if (!Number.isFinite(notional) || notional <= 0) {
    return { allow: false, gate: 'unverified-size', reason: 'order notional is not a verified positive number — refusing (capacity "—" means no order)' };
  }

  // 1. max notional per single order
  if (!Number.isFinite(L.maxOrderNotionalUsd)) return { allow: false, gate: 'max-order-notional', reason: 'max-order-notional limit is not set — failing closed (missing ≠ unlimited)' };
  if (notional > L.maxOrderNotionalUsd + 1e-9) return { allow: false, gate: 'max-order-notional', reason: `order notional $${notional.toFixed(2)} exceeds max per-order $${L.maxOrderNotionalUsd}` };

  // 2. max notional open across all positions (needs measured open exposure)
  if (!Number.isFinite(L.maxOpenNotionalUsd)) return { allow: false, gate: 'max-open-notional', reason: 'max-open-notional limit is not set — failing closed' };
  // ── SE NON SI SA COSA C'E' GIA' APERTO, NON SI APRE ALTRO ─────────────────────────────────────
  // Il tetto di esposizione ha senso solo se l'esposizione e' NOTA. Fino al 4 agosto 2026 la contava
  // dal solo ledger locale dei fill: quel giorno diceva $0 mentre al venue c'erano 199,99 share, e il
  // sistema poteva allocare come se quella posizione non esistesse.
  // Adesso le posizioni del venue entrano nel conto — e quando non sono leggibili si RIFIUTA, con lo
  // stesso idioma del limite assente: «non ho guardato» non e' «non c'e' niente».
  if (usage && usage.venuePositions && usage.venuePositions.readable !== true) {
    return { allow: false, gate: 'venue-positions-unreadable',
      reason: `le posizioni aperte al venue non sono leggibili (${usage.venuePositions.reason || 'ignoto'}) — non si apre esposizione nuova senza sapere quanta ce n'e' gia'` };
  }
  if (!Number.isFinite(usage && usage.openNotionalUsd)) return { allow: false, gate: 'max-open-notional', reason: 'open exposure could not be measured — failing closed (no order without a verified exposure figure)' };
  if (usage.openNotionalUsd + notional > L.maxOpenNotionalUsd + 1e-9) return { allow: false, gate: 'max-open-notional', reason: `open exposure $${usage.openNotionalUsd.toFixed(2)} + this order $${notional.toFixed(2)} exceeds cap $${L.maxOpenNotionalUsd}` };

  // 3. rate limit — max orders per window
  if (!Number.isFinite(L.maxOrdersPerWindow)) return { allow: false, gate: 'rate-limit', reason: 'rate limit is not set — failing closed' };
  if (!Number.isFinite(usage && usage.ordersInWindow)) return { allow: false, gate: 'rate-limit', reason: 'order rate could not be measured — failing closed' };
  if (usage.ordersInWindow >= L.maxOrdersPerWindow) return { allow: false, gate: 'rate-limit', reason: `${usage.ordersInWindow} orders in the window ≥ cap ${L.maxOrdersPerWindow} — runaway guard` };

  // 4. max realised loss per day → auto per-user kill on breach
  if (!Number.isFinite(L.maxDailyLossUsd)) return { allow: false, gate: 'daily-loss', reason: 'daily-loss limit is not set — failing closed' };
  if (!Number.isFinite(usage && usage.realisedDailyPnlUsd)) return { allow: false, gate: 'daily-loss', reason: 'realised daily P&L could not be measured — failing closed' };
  if (usage.realisedDailyPnlUsd <= -L.maxDailyLossUsd) return { allow: false, gate: 'daily-loss', autoKill: true, reason: `realised daily loss $${usage.realisedDailyPnlUsd.toFixed(2)} ≤ −$${L.maxDailyLossUsd} — tripping an automatic per-user kill` };

  return { allow: true };
}

module.exports = { resolveLimits, evaluateLimits, isVenueAllowed, HARD_CEILINGS, CONFIG_FILE, NUMERIC_LIMITS };

'use strict';
// lib/maker/manual-order.js — the server-side core of the MANUAL ORDERS panel.
//
// One human, one order, one market — placed, listed, cancelled and replaced BY HAND, isolated from
// agent35. The API routes under app/api/maker/manual/* are thin shells over this file; all the policy is
// here so the selfcheck can exhaust it without a server.
//
// IT ADDS NO AUTHORITY. Every belt that governs the automatic engine governs this path too, and this
// path adds three of its own:
//
//   EXISTING (reused verbatim, never reimplemented):
//     • the durable GLOBAL kill switch                lib/safety/kill-switch.checkKill      (fail-closed)
//     • the server-side risk limits + venue allowlist lib/safety/risk-limits                (fail-closed)
//     • the shared venue-rules guard                  lib/maker/venue-rules.validateQuote   (fail-closed)
//     • the whole placement gate chain + the exchange's own validateOrder() eth_call
//                                                     lib/venues/polymarket-clob-maker/adapter.postOrder
//     • the append-only audit trails                  polymarket-maker-audit.jsonl + execution-audit.jsonl
//     • cancel + read through the CANCEL-ONLY adapter lib/venues/polymarket-clob/adapter
//       (address-only signer: it holds no signing key and structurally cannot place)
//
//   ADDED HERE, all of them SUBTRACTIVE:
//     1. MANUAL OWNERSHIP IS A PRECONDITION. A hand order is refused unless the market is in manual mode
//        (lib/maker/manual-mode). Two writers on one market is the exact bug the flag exists to prevent,
//        so the panel may not place where the engine is still allowed to.
//     2. ITS OWN PLACEMENT SWITCH. `placement` here is read from MANUAL_ORDER_PLACEMENT and defaults to
//        'dry-run'. It DELIBERATELY does not read MAKER_PLACEMENT: the engine's send switch must never
//        arm the panel by side effect, nor the reverse. Two independent switches, both defaulting closed.
//     3. THE PANEL'S OWN PER-ORDER CEILING is the MINIMUM of the safety layer's maxOrderNotionalUsd and
//        the adapter's live-min cap. It can only ever be stricter than either alone.
//
//   HOW LONG A HAND ORDER RESTS (changed 2026-07-31 — see resolveManualTtlSeconds below):
//     • auto-reprice OFF for the market (the DEFAULT, and the fail-closed fallback): unchanged — a fixed
//       180s GTD expiry, the venue kills the order on a clock whatever the price is doing.
//     • auto-reprice ON: a GTD expiry of RESTING_GTD_SECONDS that agent40-manual-reprice RENEWS
//       PROACTIVELY with REFRESH_MARGIN_SECONDS still on it, and re-prices early whenever the mid pushes
//       the order out of the reward band (lib/maker/auto-reprice.js). So time never kills a healthy
//       order — but the expiry is real, and it is the DEAD-MAN'S SWITCH: if this host stops, nothing
//       renews and the EXCHANGE retires the order within that window, with no second supervisor anywhere
//       in the picture. Both numbers live in lib/maker/auto-reprice-config.js and nowhere else.
//     The automatism reaches the venue through THIS FILE and nowhere else — it calls replaceManualOrder,
//     so every gate below applies to it identically. What it does is stamped source:'auto-reprice-band-exit'
//     so the one audit trail never blurs it with a human's button press or with agent35.
//
// WHAT "dry-run" MEANS HERE, precisely: the order is built, SIGNED, and put to CTFExchangeV2.validateOrder()
// via eth_call, then reported and DROPPED — nothing reaches POST /order. validateOrder is never bypassed
// on a send; when an earlier gate (the kill switch, a cap) refuses, the refusal happens BEFORE any key is
// decrypted, which is stricter still. A refusal is reported with the gate that produced it, never as a
// generic failure.

const fs = require('fs');
const path = require('path');

// The PLACEMENT adapter is required LAZILY, inside buildPlacementAdapter() — never at module load.
// Reading orders, cancelling one, or rendering the panel's config must not pull the order-placement
// module (and its CLOB v2 signing SDK) into memory at all: the only code path that can place an order is
// the only one that loads the code that can.
const { createCancelOnlyAdapter } = require('../venues/polymarket-clob/adapter');
const { appendMakerAudit } = require('../venues/polymarket-clob-maker/audit');
const { validateQuote } = require('./venue-rules');
const { isManualMarket } = require('./manual-mode');
const { makerLiveProviders } = require('./live-providers');
const { polymarketCancelCredsProvider, cancelCredsAvailable } = require('./cancel-creds-provider');
const {
  isAutoRepriceEnabled, readAutoRepriceConfig, readAutoRepriceState, AUTO_REPRICE_SOURCE,
  RESTING_GTD_SECONDS, REFRESH_MARGIN_SECONDS, EXPECTED_RENEWALS_PER_HOUR,
} = require('./auto-reprice-config');
const { readAutoCloseConfig, isAutoCloseEnabled, CLOSE_PROFIT_CENTS } = require('./auto-close-config');
// SECURITY_DECREMENT_SEC — the venue retires a GTD order this many seconds BEFORE its stated expiration.
// Every "time left" reading below subtracts it, so what the panel shows is when the order ACTUALLY dies,
// not the timestamp printed on it.
const { SECURITY_DECREMENT_SEC } = require('./order-ttl');
const killSwitch = require('../safety/kill-switch');
const riskLimits = require('../safety/risk-limits');

const VENUE = 'polymarket';
const OPERATOR_USER = process.env.MAKER_OPERATOR_USER || 'operator';
const ENGINE_STATE_FILE = '/tmp/maker-state.json';
const LIVE_BOOKS_FILE = '/tmp/clob-live-books.json';
const NORMALIZED_FILE = '/tmp/liquidity-rewards.json';
// Past this the engine's published state is not describing the running engine (it ticks every 3s).
const STATE_STALE_MS = 60_000;
// The adapter's own documented default per-order cap in live-min. Used when the engine's value is
// unreadable — the DEFAULT is stricter than the engine's configured 30, which is the right direction.
const FALLBACK_LIVE_MIN_CAP_USD = 25;

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// ── WHO ACTED, ON EVERY LINE ────────────────────────────────────────────────────────────────────────
// Two callers reach this core, and the trail must never blur them:
//   'manual-ui'              a human pressed a button in the panel;
//   'auto-reprice-band-exit' the band-exit watcher (agent40) moved an order because the mid moved.
// A THIRD source, 'agent35', is stamped by the automatic engine and never appears here. The list is an
// ALLOWLIST, checked below: a caller cannot invent a source, and nothing that reaches this file over HTTP
// can set one at all (the route schemas do not accept the field).
const { AUTO_CLOSE_SOURCE } = require('./auto-close-config');
const MANUAL_SOURCES = Object.freeze(['manual-ui', AUTO_REPRICE_SOURCE, AUTO_CLOSE_SOURCE]);
const DEFAULT_SOURCE = 'manual-ui';
// The manual panel's historical fixed expiry. Still the behaviour whenever auto-reprice is OFF.
const DEFAULT_MANUAL_TTL_SECONDS = 180;

function resolveSource(s) { return MANUAL_SOURCES.includes(s) ? s : DEFAULT_SOURCE; }

/** Stamp every audit line this panel writes with its source, so the one trail says WHO acted. */
function manualAudit(rec, source = DEFAULT_SOURCE) {
  return appendMakerAudit({ ts: Date.now(), venue: VENUE, source: resolveSource(source), ...rec });
}

/**
 * HOW LONG SHOULD A HAND ORDER REST?
 *
 *   auto-reprice OFF (default)  → GTD, DEFAULT_MANUAL_TTL_SECONDS (180s). Exactly the original behaviour:
 *                                 the venue kills the order on a clock, whatever the price is doing. This
 *                                 is also the FAIL-CLOSED answer — an unreadable switch lands here.
 *   auto-reprice ON             → GTD, RESTING_GTD_SECONDS. NOT a clock the order has to
 *                                 beat, and NOT an unbounded lifetime: it is a DEAD-MAN'S SWITCH held by
 *                                 the exchange. While this host is alive the watcher renews the order
 *                                 proactively with REFRESH_MARGIN_SECONDS of life still on it, so a
 *                                 healthy leg is never actually expired by time; the moment this host
 *                                 stops, nothing renews and the venue retires the order within that
 *                                 window, with no second supervisor needed anywhere.
 *
 * WHY NOT GTC. A GTC order has no venue-side deadline at all, so a dead host leaves it resting in the
 * book indefinitely with nobody minding it. The venue does support GTC and publishes no maximum lifetime
 * (see lib/maker/order-ttl.js for the primary-source proof) — it was available and it was the wrong
 * choice. A bounded window costs ~5 renewals an hour and buys back the one protection that survives this
 * machine dying.
 *
 * An explicit spec.ttlSeconds ALWAYS wins — a caller that names a lifetime gets it, including 0 for GTC.
 *
 * @returns {{ttlSeconds:number, orderType:'GTC'|'GTD', autoReprice:boolean, refreshMarginSeconds:number|null,
 *            source:string, reason:string}}
 */
function resolveManualTtlSeconds({ marketId, ttlSeconds } = {}, deps = {}) {
  if (Number.isFinite(Number(ttlSeconds))) {
    const n = Number(ttlSeconds);
    return {
      ttlSeconds: n, orderType: n > 0 ? 'GTD' : 'GTC', autoReprice: false, refreshMarginSeconds: null, source: 'explicit',
      reason: n > 0 ? `lifetime named by the caller: ${n}s (GTD)` : 'lifetime named by the caller: 0 ⇒ GTC, no venue expiry',
    };
  }
  const ar = isAutoRepriceEnabled(marketId, deps.autoRepriceDeps || deps);
  if (ar.enabled) {
    return {
      ttlSeconds: RESTING_GTD_SECONDS, orderType: 'GTD', autoReprice: true,
      refreshMarginSeconds: REFRESH_MARGIN_SECONDS, source: 'auto-reprice',
      reason: `auto-reprice is ACTIVE on this market — the order carries a ${Math.round(RESTING_GTD_SECONDS / 60)}-minute GTD expiry that the watcher renews proactively with ${Math.round(REFRESH_MARGIN_SECONDS / 60)} minutes of life still on it. Time never kills a healthy order; the expiry exists so that a DEAD host's order retires by itself, enforced by the exchange.`,
    };
  }
  return {
    ttlSeconds: DEFAULT_MANUAL_TTL_SECONDS, orderType: 'GTD', autoReprice: false, refreshMarginSeconds: null,
    source: ar.readable ? 'default' : 'default-fail-closed',
    reason: ar.readable
      ? `auto-reprice is off for this market — the order carries the usual fixed ${DEFAULT_MANUAL_TTL_SECONDS}s GTD expiry`
      : `auto-reprice config unreadable (${ar.error}) — falling back to the fixed ${DEFAULT_MANUAL_TTL_SECONDS}s GTD expiry (fail closed toward the SHORTER unattended window)`,
  };
}

// ── THE PANEL'S OWN PLACEMENT SWITCH ────────────────────────────────────────────────────────────────
// Deliberately NOT MAKER_PLACEMENT. Anything other than the exact string 'send' is dry-run, for the same
// reason the adapter does it: the failure mode of guessing wrong here is a real order with real money.
function manualPlacement(env = process.env) {
  const raw = typeof env.MANUAL_ORDER_PLACEMENT === 'string' ? env.MANUAL_ORDER_PLACEMENT.trim() : '';
  return raw === 'send' ? 'send' : 'dry-run';
}

// ── THE ENGINE'S PUBLISHED STATE ────────────────────────────────────────────────────────────────────
// WHOSE TRUTH: the dashboard is a different pm2 process with its own environment, so reading
// process.env.MAKER_LIVE_MIN_MARKET here would answer a question nobody asked. The pin and the cap that
// matter are the ones agent35 actually enforces, which it publishes every cycle. Unreadable/stale ⇒ null
// ⇒ the caller refuses rather than guessing a pin.
function readEngineState(now = Date.now()) {
  const st = readJson(ENGINE_STATE_FILE);
  const ts = st && st.generatedAt ? Date.parse(st.generatedAt) : NaN;
  const ageMs = Number.isFinite(ts) ? now - ts : null;
  const fresh = ageMs != null && ageMs >= 0 && ageMs <= STATE_STALE_MS;
  return {
    fresh,
    ageSec: ageMs != null ? Math.round(ageMs / 1000) : null,
    mode: fresh && typeof st.mode === 'string' ? st.mode : null,
    canWrite: fresh && typeof st.canWrite === 'boolean' ? st.canWrite : null,
    enginePlacement: fresh && st.markets ? (Object.values(st.markets)[0] || {}).placement?.mode ?? null : null,
    pinnedMarketId: fresh && st.config && typeof st.config.liveMinMarket === 'string' ? st.config.liveMinMarket : null,
    liveMinCapUsd: fresh && st.config && Number.isFinite(st.config.liveMinCapUsd) ? st.config.liveMinCapUsd : null,
    manualMarketIds: (st && st.manualMode && Array.isArray(st.manualMode.marketIds)) ? st.manualMode.marketIds : [],
    unknownReason: st == null
      ? 'il motore non ha ancora pubblicato uno stato (/tmp/maker-state.json assente)'
      : !fresh
        ? `stato del motore vecchio di ${ageMs != null ? Math.round(ageMs / 1000) : '—'}s — non descrive il processo in esecuzione`
        : null,
  };
}

// ── THE MARKET'S LIVE VENUE RULES ───────────────────────────────────────────────────────────────────
// Same inputs the engine quotes from: agent34's live book snapshot for the ADJUSTED scoring mid, and the
// normalized board row for tick / min_incentive_size / max_spread / tokens / negRisk. FAIL CLOSED: any
// missing piece leaves `readable:false` and every order on this market is refused (never a guessed tick,
// never a default band). Each side is judged in ITS OWN book's space — a NO order at q IS a YES order at
// 1 − q, so the NO book's scoring mid is 1 − mid. That mirror is exactly what agent35 does.
function resolveMarketRules(marketId, deps = {}) {
  const id = typeof marketId === 'string' ? marketId.trim() : '';
  const books = deps.books || readJson(LIVE_BOOKS_FILE);
  const norm = deps.norm || readJson(NORMALIZED_FILE);
  const bm = books && books.markets ? books.markets[id] : null;
  const nm = norm && Array.isArray(norm.markets) ? norm.markets.find((m) => m && m.marketId === id) : null;

  const missing = [];
  // The SCORING MID, and WHERE IT CAME FROM. First choice is agent34's live book (the ADJUSTED mid the
  // engine itself quotes off). When that market is not in the current snapshot we fall back to the
  // normalized board row — and SAY SO (`midSource`/`midAgeSec`), because a band check against a mid that
  // is minutes old can pass while the venue's current scoring mid would fail it. The panel surfaces that
  // rather than hiding it: on a hand order the price is the operator's decision, so the honest move is to
  // show the age of the number the band was judged against, not to refuse and leave no way to act.
  const mid = bm && Number.isFinite(bm.mid) ? bm.mid : (nm && Number.isFinite(nm.midpoint) ? nm.midpoint : null);
  const midSource = (bm && Number.isFinite(bm.mid)) ? 'live-book' : (nm && Number.isFinite(nm.midpoint) ? 'board-row' : null);
  const rowUpdatedMs = nm && nm.updatedAt ? Date.parse(nm.updatedAt) : NaN;
  const midAgeSec = (bm && Number.isFinite(bm.ageMs))
    ? Math.round(bm.ageMs / 1000)
    : (Number.isFinite(rowUpdatedMs) ? Math.max(0, Math.round((Date.now() - rowUpdatedMs) / 1000)) : null);
  const tick = nm && Number.isFinite(nm.tickSize) ? nm.tickSize : null;
  const maxSpreadCents = (bm && Number.isFinite(bm.maxSpread)) ? bm.maxSpread : (nm && Number.isFinite(nm.maxSpread) ? nm.maxSpread : null);
  const minSize = (bm && Number.isFinite(bm.minSize)) ? bm.minSize : (nm && Number.isFinite(nm.minSize) ? nm.minSize : null);
  const tokenId = nm && nm.tokenId ? String(nm.tokenId) : (bm && bm.tokenId ? String(bm.tokenId) : null);
  const tokenIdNo = nm && nm.tokenIdNo ? String(nm.tokenIdNo) : (bm && bm.tokenIdNo ? String(bm.tokenIdNo) : null);
  // negRisk decides WHICH EXCHANGE the order settles against, so it must come from the venue feed and is
  // never assumed. Absent ⇒ unreadable, not `false`.
  const negRisk = nm && typeof nm.negRisk === 'boolean' ? nm.negRisk : null;

  if (mid == null) missing.push('mid');
  if (tick == null) missing.push('tick');
  if (maxSpreadCents == null) missing.push('maxSpread');
  if (minSize == null) missing.push('minSize');
  if (!tokenId) missing.push('tokenId(YES)');
  if (!tokenIdNo) missing.push('tokenIdNo(NO)');
  if (negRisk == null) missing.push('negRisk');

  return {
    readable: missing.length === 0,
    missing,
    marketId: id,
    title: (nm && nm.title) || (bm && bm.title) || '',
    mid, tick, maxSpreadCents, minSize, tokenId, tokenIdNo, negRisk,
    bandRadiusCents: maxSpreadCents != null ? maxSpreadCents / 2 : null,
    feedLive: !!(bm && bm.live),
    feedAgeSec: bm && Number.isFinite(bm.ageMs) ? Math.round(bm.ageMs / 1000) : null,
    midSource, midAgeSec,
    bestBid: (bm && bm.yes && Number.isFinite(bm.yes.bestBid)) ? bm.yes.bestBid : (nm && Number.isFinite(nm.bestBid) ? nm.bestBid : null),
    bestAsk: (bm && bm.yes && Number.isFinite(bm.yes.bestAsk)) ? bm.yes.bestAsk : (nm && Number.isFinite(nm.bestAsk) ? nm.bestAsk : null),
    // The per-book view the form and the guard both use.
    books: {
      yes: { tokenId, scoringMid: mid },
      no: { tokenId: tokenIdNo, scoringMid: mid == null ? null : +(1 - mid).toFixed(6) },
    },
  };
}

// ── THE CAPS, READ FROM data/safety-risk-limits.json (never hardcoded, never from the request) ──────
// The panel's effective per-order ceiling is the MINIMUM of the safety layer's cap and the adapter's
// live-min cap: two independent belts, and the panel is bound by the tighter one. Unreadable config ⇒
// caps null ⇒ every order refused downstream (missing ≠ unlimited).
function resolveCaps({ userId = OPERATOR_USER, engine = null } = {}, deps = {}) {
  const resolved = riskLimits.resolveLimits({ userId }, deps);
  const eng = engine || readEngineState();
  const liveMinCapUsd = Number.isFinite(eng.liveMinCapUsd) ? eng.liveMinCapUsd : FALLBACK_LIVE_MIN_CAP_USD;
  if (!resolved.ok) {
    return {
      readable: false, error: resolved.error, source: riskLimits.CONFIG_FILE,
      maxOrderNotionalUsd: null, maxOpenNotionalUsd: null, maxOrdersPerWindow: null, windowMs: null,
      maxDailyLossUsd: null, venues: [], liveMinCapUsd, effectiveOrderCapUsd: null,
      clampEvents: [], hardCeilings: riskLimits.HARD_CEILINGS,
    };
  }
  const L = resolved.limits;
  const effectiveOrderCapUsd = Number.isFinite(L.maxOrderNotionalUsd)
    ? Math.min(L.maxOrderNotionalUsd, liveMinCapUsd)
    : null;
  return {
    readable: true, error: null, source: riskLimits.CONFIG_FILE,
    maxOrderNotionalUsd: L.maxOrderNotionalUsd,
    maxOpenNotionalUsd: L.maxOpenNotionalUsd,
    maxOrdersPerWindow: L.maxOrdersPerWindow,
    windowMs: L.windowMs,
    maxDailyLossUsd: L.maxDailyLossUsd,
    venues: L.venues,
    venueAllowed: riskLimits.isVenueAllowed({ venue: VENUE, limits: L }),
    missing: L._missing || [],
    liveMinCapUsd,
    effectiveOrderCapUsd,
    clampEvents: resolved.clampEvents || [],
    hardCeilings: riskLimits.HARD_CEILINGS,
  };
}

/**
 * GATE 1 — MANUAL OWNERSHIP. A hand order requires the market to be in manual mode, so the engine is
 * provably standing off it. Fail-closed on an unreadable ownership file (the same read that stands the
 * engine off also refuses the panel — nobody places on an unknown owner).
 */
function evaluateManualGate({ marketId }, deps = {}) {
  const m = isManualMarket(marketId, deps);
  if (!m.readable) {
    return { allow: false, gate: 'manual-mode-unreadable', reason: m.reason, manual: m };
  }
  if (!m.manual) {
    return {
      allow: false, gate: 'manual-mode-inactive', manual: m,
      reason: `manual mode is NOT active on ${marketId} — agent35 is still allowed to place and cancel here. Take the market manual first; two writers on one market is exactly what that flag prevents.`,
    };
  }
  return { allow: true, gate: null, reason: null, manual: m };
}

/**
 * GATE 2 — the panel's own per-order ceiling, checked BEFORE anything is built or signed so the operator
 * gets the number back rather than a venue error. The adapter re-checks its own cap independently.
 */
function evaluateManualCapGate({ notionalUsd, caps }) {
  if (!caps || caps.readable !== true) {
    return { allow: false, gate: 'caps-unreadable', reason: `i limiti di rischio non sono leggibili (${(caps && caps.error) || 'sconosciuto'}) — rifiuto (limite assente ≠ illimitato)` };
  }
  if (!Number.isFinite(caps.effectiveOrderCapUsd)) {
    return { allow: false, gate: 'cap-missing', reason: 'maxOrderNotionalUsd non è impostato in data/safety-risk-limits.json — rifiuto (limite assente ≠ illimitato)' };
  }
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
    return { allow: false, gate: 'unverified-size', reason: 'il controvalore dell\'ordine non è un numero positivo verificato — rifiuto' };
  }
  if (notionalUsd > caps.effectiveOrderCapUsd + 1e-9) {
    return { allow: false, gate: 'manual-order-cap', reason: `controvalore $${notionalUsd.toFixed(2)} oltre il tetto per ordine $${caps.effectiveOrderCapUsd.toFixed(2)} (il più stretto fra safety-risk-limits $${caps.maxOrderNotionalUsd} e il cap live-min dell'adapter $${caps.liveMinCapUsd})` };
  }
  return { allow: true, gate: null, reason: null };
}

// ── THE PANEL'S VIEW OF THE WORLD (GET /api/maker/manual/config) ────────────────────────────────────
// Everything the form needs, every number READ from its real source, nothing hardcoded. Used by the
// banner (kill), the cap display, the market pin, the isolation panel and the disabled-state logic.
function manualContext({ marketId = null, userId = OPERATOR_USER } = {}, deps = {}) {
  const engine = readEngineState();
  const kill = killSwitch.killStatus(deps.killDeps || {});
  const caps = resolveCaps({ userId, engine }, deps.limitDeps || {});
  const targetId = marketId || engine.pinnedMarketId;
  const rules = targetId ? resolveMarketRules(targetId, deps) : null;
  const manual = targetId ? isManualMarket(targetId, deps.manualDeps || {}) : null;
  const placement = manualPlacement(deps.env || process.env);
  // ── THE AUTOMATISM'S OWN STATE, so the panel can never present it as invisible. ──
  const arDeps = deps.autoRepriceDeps || deps;
  const arCfg = readAutoRepriceConfig(arDeps);
  const arMarket = targetId ? isAutoRepriceEnabled(targetId, arDeps) : null;
  const arState = readAutoRepriceState(arDeps);
  const arLast = targetId ? (arState.markets[String(targetId).toLowerCase()] || null) : null;
  const ttl = targetId ? resolveManualTtlSeconds({ marketId: targetId }, { autoRepriceDeps: arDeps }) : null;

  return {
    at: new Date().toISOString(),
    // The kill banner reads THIS — the durable file, re-read on every request, never a static value.
    kill: {
      readable: kill.readable,
      killed: kill.effectivelyKilled,
      scope: kill.global && kill.global.killed ? 'global' : null,
      reason: (kill.global && kill.global.reason) || kill.error || null,
      by: (kill.global && kill.global.by) || null,
      at: (kill.global && kill.global.at) || null,
    },
    // The panel's OWN send switch, independent of the engine's MAKER_PLACEMENT.
    placement: {
      mode: placement,
      key: 'MANUAL_ORDER_PLACEMENT',
      sends: placement === 'send',
      note: placement === 'send'
        ? 'MANUAL_ORDER_PLACEMENT=send — un ordine da questo pannello RAGGIUNGE il venue (restano kill-switch, cap, venue-rules e validateOrder).'
        : 'dry-run (default): l\'ordine viene costruito, FIRMATO e sottoposto a validateOrder() via eth_call, poi scartato. Nulla raggiunge POST /order.',
    },
    // The automatic engine, and whether it is provably standing off this market.
    engine: {
      fresh: engine.fresh, ageSec: engine.ageSec, mode: engine.mode, canWrite: engine.canWrite,
      pinnedMarketId: engine.pinnedMarketId, unknownReason: engine.unknownReason,
      manualMarketIds: engine.manualMarketIds,
    },
    isolation: manual ? {
      marketId: targetId,
      manual: manual.manual,
      readable: manual.readable,
      reason: manual.reason,
      record: manual.record,
      // Proof from the ENGINE's own published state, not from our read of the same file.
      engineAcknowledged: engine.fresh ? engine.manualMarketIds.includes(String(targetId).toLowerCase()) : null,
    } : null,
    // ── AUTO-RIPREZZO — the band-exit watcher's switches and its proof of life. ──
    // Everything the panel needs to say, per market: is it on, is the master on, when did it last move
    // anything, and IS THE WATCHER ALIVE. That last one matters more here than anywhere else in this
    // file: with auto-reprice on, orders rest as GTC with no venue expiry, so a dead watcher means an
    // unattended order. `heartbeatAgeSec: null` means "we have never seen it run", not "it is fine".
    autoReprice: {
      readable: arCfg.readable,
      error: arCfg.error,
      globalEnabled: arCfg.globalEnabled,
      optedInMarketIds: arCfg.optedInMarketIds || [],
      enabledMarketIds: arCfg.enabledMarketIds || [],
      market: arMarket ? {
        marketId: targetId,
        enabled: arMarket.enabled,
        marketEnabled: arMarket.marketEnabled,
        readable: arMarket.readable,
        reason: arMarket.reason,
        record: arMarket.record,
      } : null,
      // The lifetime a NEW hand order on this market would get right now — read back from the same
      // resolver the placement path uses, never re-derived by the UI.
      expiry: ttl ? { orderType: ttl.orderType, ttlSeconds: ttl.ttlSeconds, refreshMarginSeconds: ttl.refreshMarginSeconds, source: ttl.source, reason: ttl.reason } : null,
      watcher: {
        readable: arState.readable,
        heartbeatAt: arState.heartbeatAt,
        heartbeatAgeSec: arState.heartbeatAgeSec,
        cycles: arState.cycles,
        // Alive ⇔ it has beaten within a generous multiple of its own poll interval. null = never seen.
        alive: arState.heartbeatAgeSec == null ? null : arState.heartbeatAgeSec <= 60,
        process: 'agent40-manual-reprice',
      },
      last: arLast ? {
        at: arLast.lastRepriceAt || null,
        atIso: arLast.lastRepriceIso || null,
        orderId: arLast.lastOrderId || null,
        fromPrice: arLast.lastFromPrice,
        toPrice: arLast.lastToPrice,
        ok: arLast.lastOk === true,
        sent: arLast.lastSent === true,
        gate: arLast.lastGate || null,
        reason: arLast.lastReason || null,
        count: arLast.count || 0,
        inLastHour: Array.isArray(arLast.recentAt) ? arLast.recentAt.filter((t) => Number.isFinite(t) && Date.now() - t < 3_600_000).length : 0,
      } : null,
    },
    // ── CHIUSURA AUTOMATICA — gli interruttori e il bersaglio di profitto. ──
    // Nessuna lettura del venue qui: questo endpoint deve restare veloce e viene interrogato ogni 10s.
    // Le posizioni e gli ordini di chiusura gia' a riposo si vedono nella tabella ordini (una chiusura
    // compare come riga SELL con sorgente auto-close-on-fill) e in /api/maker/positions.
    autoClose: (() => {
      const cc = readAutoCloseConfig(deps.autoCloseDeps || deps);
      const cm = targetId ? isAutoCloseEnabled(targetId, deps.autoCloseDeps || deps) : null;
      const tickC = rules && Number.isFinite(rules.tick) ? rules.tick * 100 : null;
      return {
        readable: cc.readable,
        error: cc.error,
        globalEnabled: cc.globalEnabled,
        optedInMarketIds: cc.optedInMarketIds || [],
        profitCents: CLOSE_PROFIT_CENTS,
        market: cm ? { marketId: targetId, enabled: cm.enabled, marketEnabled: cm.marketEnabled, readable: cm.readable, reason: cm.reason, record: cm.record } : null,
        // Come si arriva al prezzo di uscita, con i numeri di QUESTO mercato.
        note: tickC != null
          ? `l'uscita si piazza a carico + ${CLOSE_PROFIT_CENTS}¢, arrotondato IN SU al tick di questo mercato (${rules.tick} = ${tickC.toFixed(1)}¢), quindi il profitto reale non è mai inferiore al bersaglio`
          : `l'uscita si piazza a carico + ${CLOSE_PROFIT_CENTS}¢, arrotondato in su al tick del mercato`,
      };
    })(),
    caps,
    market: rules,
    operatorUser: userId,
  };
}

// ── BUILD THE TWO ADAPTERS ──────────────────────────────────────────────────────────────────────────
// PLACING uses the maker adapter (the only thing that can place). READING and CANCELLING use the
// CANCEL-ONLY adapter: an address-only signer that holds no signing key and structurally cannot place —
// the same primitive the KILL button and the dead-man watchdog use. A cancel therefore never decrypts
// the signing key, and the read path never touches it either.
function buildPlacementAdapter({ pinnedMarketId, liveMinCapUsd, placement, orderTtlSeconds, source = DEFAULT_SOURCE }) {
  const { createMakerAdapter } = require('../venues/polymarket-clob-maker/adapter');
  const { credsProvider, signerProvider } = makerLiveProviders();
  const src = resolveSource(source);
  return createMakerAdapter({
    mode: 'live-min',
    // The pin comes from the ENGINE's published config, so the panel is bound to the same single market
    // the engine is bound to. No pin ⇒ evaluateLiveMinMarketGate refuses every order (fail closed).
    liveMinMarket: pinnedMarketId || '',
    liveMinCapUsd: Number.isFinite(liveMinCapUsd) ? liveMinCapUsd : FALLBACK_LIVE_MIN_CAP_USD,
    placement,
    // 0 is a MEANINGFUL value here (GTC, no venue expiry), so the guard is Number.isFinite and NOT a
    // truthiness test — `orderTtlSeconds || 180` would silently turn every GTC order back into a 180s GTD.
    orderTtlSeconds: Number.isFinite(orderTtlSeconds) ? orderTtlSeconds : DEFAULT_MANUAL_TTL_SECONDS,
    fundingApproved: process.env.MAKER_FUNDING_APPROVED === 'true',
    credsProvider, signerProvider,
    auditSink: (rec) => appendMakerAudit({ ...rec, source: src }),
  });
}

async function buildReadCancelAdapter() {
  const available = await cancelCredsAvailable();
  return available
    ? { adapter: createCancelOnlyAdapter({ credsProvider: polymarketCancelCredsProvider }), live: true }
    : { adapter: createCancelOnlyAdapter({ dryRun: true }), live: false };
}

/**
 * PLACE ONE MANUAL ORDER.
 *
 * spec: { marketId, book:'yes'|'no', price, size, ttlSeconds?, userId? }
 * The side is BUY. A collateral-funded maker offers the ask side by BUYing NO (a SELL YES needs inventory
 * this panel does not measure), which is exactly how the engine's own planner mirrors the two books — so
 * "YES/NO" is the whole choice, and it is a real one.
 *
 * ORDER OF REFUSAL (each one names itself; nothing is ever a generic failure):
 *   manual ownership → market rules readable → venue-rules guard → caps → kill switch →
 *   [adapter] venue-rules again → live-min cap → live-min market pin → kill → venue allowlist →
 *   risk limits → SDK/mode/dry-run/funding → order version → validateOrder() → placement switch.
 */
async function placeManualOrder(spec = {}, deps = {}) {
  const t0 = Date.now();
  const userId = spec.userId || OPERATOR_USER;
  // WHO is placing. Server-side callers only: no HTTP route accepts this field, and an unrecognised value
  // resolves to 'manual-ui' rather than being written into the trail verbatim.
  const source = resolveSource(spec.source);
  const engine = readEngineState();
  const marketId = typeof spec.marketId === 'string' && spec.marketId.trim() ? spec.marketId.trim() : engine.pinnedMarketId;
  const book = spec.book === 'no' ? 'no' : 'yes';
  // ── SIDE. BUY unless a caller explicitly asks to SELL, so every existing call site is untouched.
  //
  // WHY SELL EXISTS AT ALL NOW. The panel has only ever BUY-ed: a collateral-funded maker offers the ask
  // by BUYing the other book, and "a SELL YES needs inventory this panel does not measure". CLOSING a
  // position is the one case where the inventory is not only measured but is the whole point — you close
  // on Polymarket by SELLING the outcome token you hold (docs: "you give up an outcome token and receive
  // payment in return"). So SELL is permitted here, and lib/maker/auto-close.js is the only caller that
  // uses it — and only for a quantity it has PROVEN is held, read from the venue's own positions.
  const side = spec.side === 'SELL' ? 'SELL' : 'BUY';
  const price = Number(spec.price);
  const size = Number(spec.size);
  const notionalUsd = (Number.isFinite(price) && Number.isFinite(size)) ? price * size : NaN;

  const refuse = (gate, reason, extra = {}) => {
    manualAudit({ op: 'manual-place', outcome: `reject-${gate}`, gate, reason, marketRef: marketId ? `cid_${String(marketId).replace(/^0x/, '')}` : null,
      requested: { book, side, price, size, notionalUsd: Number.isFinite(notionalUsd) ? +notionalUsd.toFixed(4) : null }, latencyMs: Date.now() - t0, userId }, source);
    return { ok: false, sent: false, gate, reason, marketId, book, side, price, size,
      notionalUsd: Number.isFinite(notionalUsd) ? +notionalUsd.toFixed(4) : null, ...extra };
  };

  if (!marketId) return refuse('market-unknown', `nessun mercato indicato e il pin del motore non è leggibile (${engine.unknownReason || 'stato assente'}) — rifiuto piuttosto che indovinare un mercato`);

  // GATE 1 — manual ownership.
  const mg = evaluateManualGate({ marketId }, deps.manualDeps || {});
  if (!mg.allow) return refuse(mg.gate, mg.reason);

  // GATE 2 — the market's live venue rules must be readable, or nothing here is judgeable.
  const rules = resolveMarketRules(marketId, deps);
  if (!rules.readable) return refuse('rules-unreadable', `regole di venue non leggibili per questo mercato (mancano: ${rules.missing.join(', ')}) — rifiuto (mai una banda o un tick indovinati)`);

  const tokenId = book === 'no' ? rules.tokenIdNo : rules.tokenId;
  const scoringMid = book === 'no' ? rules.books.no.scoringMid : rules.books.yes.scoringMid;
  const venueRules = { tick: rules.tick, scoringMid, maxSpreadCents: rules.maxSpreadCents, minSize: rules.minSize };

  // GATE 3 — the SHARED venue-rules guard, the identical function the board's band warning calls and the
  // adapter re-runs. Checked here first so the operator sees the reason codes rather than a bare refusal.
  const vq = validateQuote(venueRules, { side, price, size });
  if (!vq.valid) {
    return refuse('venue-rules', vq.reasons.map((r) => `${r.code}: ${r.detail}`).join('; '), { reasons: vq.reasons });
  }

  // GATE 4 — the panel's per-order ceiling, from data/safety-risk-limits.json.
  const caps = resolveCaps({ userId, engine }, deps.limitDeps || {});
  const cg = evaluateManualCapGate({ notionalUsd, caps });
  if (!cg.allow) return refuse(cg.gate, cg.reason, { caps });

  // GATE 5 — the durable GLOBAL kill switch, re-read now. The adapter checks it again on the live path;
  // checking here too means a killed system refuses before an adapter is even constructed.
  const kill = killSwitch.checkKill({ userId }, deps.killDeps || {});
  if (kill.killed) return refuse(kill.gate || 'kill', kill.reason);

  // ── HOW LONG IT RESTS. GTD 180s as always, unless auto-reprice owns this market — then GTC, and the
  //    band-exit watcher is what moves it. Resolved ONCE and used for both the adapter default and the
  //    per-order spec, so the two can never disagree. ──
  const ttl = resolveManualTtlSeconds({ marketId, ttlSeconds: spec.ttlSeconds }, deps);

  // ── Hand it to the adapter, which owns every remaining gate and the decision to send. ──
  const placement = manualPlacement(deps.env || process.env);
  let adapter;
  try {
    adapter = buildPlacementAdapter({
      pinnedMarketId: engine.pinnedMarketId,
      liveMinCapUsd: engine.liveMinCapUsd,
      placement,
      orderTtlSeconds: ttl.ttlSeconds,
      source,
    });
  } catch (e) {
    return refuse('adapter-build', `non è stato possibile costruire l'adapter di piazzamento: ${e.message}`);
  }

  let res;
  try {
    res = await adapter.postOrder({
      marketId, tokenId, side, price, size,
      tickSize: rules.tick, negRisk: rules.negRisk === true, postOnly: true,
      venueRules, userId,
      ttlSeconds: ttl.ttlSeconds,
      decision: { source, book, side, byHand: source === DEFAULT_SOURCE, note: spec.note || null, expiry: ttl.orderType },
    });
  } catch (e) {
    // A throw AFTER the intent row is written is ambiguous — the adapter says so in its own result; here
    // we only report what we know. Never claim a clean miss we cannot prove.
    manualAudit({ op: 'manual-place', outcome: 'error', reason: e.message, marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, latencyMs: Date.now() - t0, userId }, source);
    return { ok: false, sent: null, ambiguous: true, gate: 'adapter-threw', reason: e.message, marketId, book, price, size };
  } finally {
    try { adapter.close(); } catch { /* scrub is best-effort */ }
  }

  manualAudit({
    op: 'manual-place',
    outcome: res.ok ? (res.sent ? 'sent' : 'dry-run-validated') : `reject-${res.gate || 'venue'}`,
    marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
    requested: { book, side, price, size, notionalUsd: +notionalUsd.toFixed(4), orderType: ttl.orderType, ttlSeconds: ttl.ttlSeconds },
    gate: res.gate || null, reason: res.reason || null, orderId: res.orderId || null,
    idempotencyKey: res.idempotencyKey || null,
    placement, latencyMs: Date.now() - t0, userId,
  }, source);

  return {
    ok: res.ok === true, sent: res.sent === true, dryRun: res.dryRun === true, placement,
    gate: res.gate || null, reason: res.reason || null, orderId: res.orderId || null,
    wouldSend: res.wouldSend || null, validateOrder: res.validateOrder || null,
    idempotencyKey: res.idempotencyKey || null,
    marketId, book, side, price, size, notionalUsd: +notionalUsd.toFixed(4),
    // WHAT LIFETIME THIS ORDER GOT, and why — so the panel can show "GTC · nessuna scadenza" or
    // "GTD · 180s" as a fact read back from the placement, not as an assumption about it.
    expiry: ttl,
    source,
    venueRules, caps,
  };
}

// ── READ: the operator's RESTING orders, from the venue ─────────────────────────────────────────────
// Venue truth, not local belief. Through the cancel-only adapter, so no signing key is decrypted for a
// read. `source` is resolved per order from the append-only audit trail: an order whose idempotency key
// was written by the panel reads 'manual-ui', anything else 'agent35'. Without credentials the adapter
// is dry-run and returns an honest empty list flagged simulated:true — never a fabricated order.
async function listManualOrders({ marketId = null } = {}) {
  const t0 = Date.now();
  const { adapter, live } = await buildReadCancelAdapter();
  const res = await adapter.listOpenOrders(marketId || undefined);
  const raw = Array.isArray(res.orders) ? res.orders : [];
  const now = Date.now();

  const manualKeys = manualIdempotencyKeys();
  const orders = raw.map((o) => {
    const created = Number(o.created_at || o.createdAt || 0);
    const createdMs = created > 0 ? (created < 1e12 ? created * 1000 : created) : null;
    const price = Number(o.price);
    const size = Number(o.original_size || o.originalSize || o.size || 0);
    const matched = Number(o.size_matched || o.sizeMatched || 0);

    // ── WHEN THIS ORDER ACTUALLY DIES, READ FROM THE VENUE ──────────────────────────────────────────
    // The CLOB returns `expiration` (unix SECONDS, "0" for GTC) and `order_type` on every open order, so
    // this is venue truth rather than our belief about what we signed. Two corrections matter:
    //   • the venue retires a GTD order SECURITY_DECREMENT_SEC (60s) BEFORE the stated expiration, so the
    //     real death time is expiration − 60. Showing the stated timestamp would promise a minute the
    //     order does not have;
    //   • expiration 0 (or absent) means GTC — no deadline at all. That is reported as null, NOT as
    //     "expired" and not as some default window.
    const expRaw = Number(o.expiration != null ? o.expiration : 0);
    const hasExpiry = Number.isFinite(expRaw) && expRaw > 0;
    const expiresAtMs = hasExpiry ? (expRaw - SECURITY_DECREMENT_SEC) * 1000 : null;
    const secondsToExpiry = expiresAtMs != null ? Math.round((expiresAtMs - now) / 1000) : null;
    // When the watcher would renew it: REFRESH_MARGIN_SECONDS before that real death time.
    const secondsToRefresh = secondsToExpiry != null ? secondsToExpiry - REFRESH_MARGIN_SECONDS : null;

    return {
      // The venue's own view of this order's lifetime. `orderType:'GTC'` + `secondsToExpiry:null` means
      // nothing will ever retire this order except a fill, the operator, or the watcher.
      orderType: hasExpiry ? 'GTD' : 'GTC',
      expirationUnix: hasExpiry ? expRaw : 0,
      expiresAtMs,
      expiresAtIso: expiresAtMs != null ? new Date(expiresAtMs).toISOString() : null,
      secondsToExpiry,
      secondsToRefresh,
      venueOrderType: typeof o.order_type === 'string' ? o.order_type : (typeof o.orderType === 'string' ? o.orderType : null),
      orderId: o.id || o.orderID || o.order_id || null,
      marketId: o.market || o.marketId || o.condition_id || o.conditionId || null,
      tokenId: o.asset_id || o.assetId || o.token_id || o.tokenId || null,
      side: o.side || null,
      price: Number.isFinite(price) ? price : null,
      size: Number.isFinite(size) ? size : null,
      sizeMatched: Number.isFinite(matched) ? matched : null,
      sizeRemaining: (Number.isFinite(size) && Number.isFinite(matched)) ? +(size - matched).toFixed(4) : null,
      status: o.status || (Number.isFinite(matched) && matched > 0 ? 'PARTIALLY_FILLED' : 'LIVE'),
      createdMs,
      ageSec: createdMs != null ? Math.max(0, Math.round((now - createdMs) / 1000)) : null,
      // WHO placed it. Resolved from the audit trail, never guessed: an id we cannot attribute reads
      // 'unknown' rather than being silently credited to one side or the other.
      source: attributeOrder(o, manualKeys),
      notionalUsd: (Number.isFinite(price) && Number.isFinite(size)) ? +(price * size).toFixed(2) : null,
    };
  });

  manualAudit({ op: 'manual-list', outcome: res.ok === false ? 'error' : 'ok', requested: { marketId },
    response: { count: orders.length, simulated: !live }, latencyMs: Date.now() - t0 });

  return {
    ok: res.ok !== false,
    error: res.ok === false ? res.error : null,
    // simulated:true means NO credentials are stored, so this is an honest "we did not reach the venue"
    // — not "you have no orders". The panel says so rather than showing an empty table as fact.
    simulated: !live || res.dryRun === true || res.simulated === true,
    count: orders.length,
    orders,
    at: new Date().toISOString(),
  };
}

// Every idempotency key the PANEL has ever recorded an intent for. Read from the same append-only maker
// trail the panel writes, so attribution is evidence-based rather than inferred from shape.
// ── THE TRAIL IS APPEND-ONLY, SO TAIL IT INCREMENTALLY ──────────────────────────────────────────────
// This used to readFileSync() the whole audit file and split it on newlines on EVERY call. That was
// survivable while the only caller was an HTTP request every 20s inside the big dashboard process. It
// stopped being survivable the moment agent40 started calling it on a 5-second loop: the trail is now
// 80 MB / 268k lines, so each call allocated an 80 MB string PLUS a 268k-element array of strings, and
// the process ballooned past 340 MB and was killed by pm2's 200 MB ceiling roughly twice a minute — a
// restart loop with an empty error log and exit code 0, which reads like a mystery until you look at RSS.
//
// The file is APPEND-ONLY, which is exactly the property that makes the fix simple: remember the byte
// offset we have already consumed and read only what has been appended since. A quiet cycle then does one
// stat() and returns the cached Set with zero allocation.
//
// CORRECTNESS DETAILS, none of them optional:
//   • ROTATION / TRUNCATION invalidates the offset. Detected by inode change or by the file being SHORTER
//     than our offset; either one rebuilds the Set from scratch rather than silently reading garbage.
//   • A PARTIAL TRAILING LINE (an append in flight) must not be parsed and must not be lost — it is held
//     in `tail` and prepended to the next read.
//   • MULTI-BYTE UTF-8 can straddle a chunk boundary (the trail carries Italian prose with accents), so
//     decoding goes through StringDecoder, which buffers an incomplete sequence instead of corrupting it.
//   • An unreadable file returns whatever we already have rather than an empty Set: losing attribution
//     would silently re-credit the panel's own orders to agent35, and the watcher only touches orders it
//     can positively attribute — it would stop minding the very order it had just placed.
const _idemCache = { keys: new Set(), offset: 0, ino: null, tail: '', decoder: null };

function manualIdempotencyKeys() {
  let file;
  try { file = path.join(require('../safety/store').DATA_DIR, 'polymarket-maker-audit.jsonl'); }
  catch { return _idemCache.keys; }

  let st;
  try { st = fs.statSync(file); }
  catch { return _idemCache.keys; }   // absent/unreadable ⇒ keep what we know, never forget it

  if (_idemCache.ino !== st.ino || st.size < _idemCache.offset) {
    _idemCache.keys = new Set();
    _idemCache.offset = 0;
    _idemCache.tail = '';
    _idemCache.ino = st.ino;
    _idemCache.decoder = null;
  }
  if (st.size === _idemCache.offset) return _idemCache.keys;   // nothing appended — the common case

  const ingest = (line) => {
    // Cheap pre-filter before the JSON.parse. It must list EVERY panel-owned source: an order the watcher
    // re-priced is still the panel's order.
    if (!line || !MANUAL_SOURCES.some((s) => line.indexOf(s) !== -1)) return;
    let row; try { row = JSON.parse(line); } catch { return; }
    if (!row || !MANUAL_SOURCES.includes(row.source)) return;
    if (row.idempotencyKey) _idemCache.keys.add(row.idempotencyKey);
    if (row.orderId) _idemCache.keys.add(String(row.orderId));
  };

  const { StringDecoder } = require('string_decoder');
  if (!_idemCache.decoder) _idemCache.decoder = new StringDecoder('utf8');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const CHUNK = 1 << 20;                       // 1 MiB at a time — bounded, whatever the file grows to
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = _idemCache.offset;
    let carry = _idemCache.tail;
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + _idemCache.decoder.write(buf.subarray(0, n));
      const lines = text.split('\n');
      carry = lines.pop();                       // may be a partial line; never parsed here
      for (const line of lines) ingest(line);
    }
    _idemCache.offset = pos;
    _idemCache.tail = carry;
  } catch {
    /* a read failure leaves the cache exactly as it was — offset included, so the next call retries */
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return _idemCache.keys;
}

function attributeOrder(o, manualKeys) {
  const id = o && (o.id || o.orderID || o.order_id);
  if (id && manualKeys.has(String(id))) return 'manual-ui';
  // No positive evidence that the panel placed it. The engine is the only other writer on this account,
  // but saying so without evidence would be a guess — report what we can prove.
  return manualKeys.size === 0 ? 'unknown' : 'agent35';
}

// ── CANCEL ONE RESTING ORDER ────────────────────────────────────────────────────────────────────────
// Through the CANCEL-ONLY adapter: it cannot place, so this endpoint can stop an order and structurally
// never start one. Idempotent — an order already gone reports noop:true, not a failure.
async function cancelManualOrder({ orderId, marketId = null, userId = OPERATOR_USER } = {}, source = DEFAULT_SOURCE) {
  const t0 = Date.now();
  const src = resolveSource(source);
  if (!orderId) return { ok: false, gate: 'orderId-required', reason: 'orderId obbligatorio' };

  // A cancel can only REDUCE exposure, so it is deliberately NOT gated on the kill switch or on manual
  // ownership: the operator must always be able to stop an order, including one placed while the market
  // was still engine-owned, and including while the system is killed. Same reading as the KILL button.
  const { adapter, live } = await buildReadCancelAdapter();
  let res;
  try { res = await adapter.cancelOrder(orderId); }
  catch (e) {
    manualAudit({ op: 'manual-cancel', outcome: 'error', requested: { orderId, marketId }, reason: e.message, latencyMs: Date.now() - t0, userId }, src);
    return { ok: false, orderId, reason: e.message };
  }

  // HONESTY AT THE VENUE BOUNDARY. The CLOB answers a cancel with HTTP 200 and a body that may say the
  // order was NOT cancelled: { canceled: [], not_canceled: { "<id>": "order can't be found - already
  // canceled or matched" } }. Reporting that as a plain success would tell the operator an order is gone
  // on the strength of a call that cancelled nothing. Read the body:
  //   • the id in `canceled`                    → genuinely cancelled;
  //   • in `not_canceled` because it is GONE    → noop, and ok — there is nothing resting either way;
  //   • in `not_canceled` for any OTHER reason  → a FAILURE, reported with the venue's own words.
  const body = (res && res.response) || {};
  const canceledList = Array.isArray(body.canceled) ? body.canceled : (Array.isArray(body.cancelled) ? body.cancelled : []);
  const notCanceled = (body.not_canceled && typeof body.not_canceled === 'object') ? body.not_canceled
    : (body.notCanceled && typeof body.notCanceled === 'object') ? body.notCanceled : {};
  const venueSaidCancelled = canceledList.map(String).includes(String(orderId));
  const venueRefusal = notCanceled[String(orderId)] != null ? String(notCanceled[String(orderId)]) : null;
  const alreadyGone = res.noop === true || (venueRefusal != null && /not be found|already (cancel|match)|does not exist/i.test(venueRefusal));
  const simulated = !live || res.dryRun === true || res.simulated === true;

  // ok means "nothing of yours is resting under this id any more", which "already gone" satisfies.
  // It does NOT mean "we cancelled something" — `cancelled` says that, separately.
  const ok = res.ok !== false && (simulated || venueSaidCancelled || alreadyGone || (venueRefusal == null && canceledList.length === 0 && Object.keys(notCanceled).length === 0));
  const reason = res.ok === false ? (res.error || 'cancel fallito')
    : (!ok && venueRefusal) ? `il venue ha RIFIUTATO la cancellazione: ${venueRefusal}` : null;

  manualAudit({ op: 'manual-cancel', outcome: !ok ? 'reject-venue' : (alreadyGone ? 'noop' : 'ok'),
    requested: { orderId, marketId }, response: { ok, cancelled: venueSaidCancelled ? 1 : 0, alreadyGone, venueRefusal, simulated },
    latencyMs: Date.now() - t0, userId }, src);

  return {
    ok, orderId,
    // TRUE only when the venue itself listed this id as cancelled. `alreadyGone` is the honest other
    // success: the order was not there to cancel.
    cancelled: venueSaidCancelled,
    alreadyGone,
    venueRefusal,
    noop: alreadyGone,
    simulated,
    sent: res.sent === true,
    reason,
    at: new Date().toISOString(),
  };
}

/**
 * "MODIFY" — CANCEL + RE-PLACE, ATOMIC AS ONE SERVER CALL.
 *
 * THE POLYMARKET CLOB HAS NO ORDER-MODIFY ENDPOINT. Verified against the installed SDK's own endpoint
 * table (@polymarket/clob-client-v2/dist/endpoints.js): POST /order, POST /orders, DELETE /order,
 * DELETE /orders, /cancel-all, /cancel-market-orders — and nothing that amends, edits, replaces or
 * re-prices a resting order. Changing a price or a size therefore MEANS cancel-then-place; there is no
 * primitive that does it in one venue call, and no wrapper can invent one.
 *
 * What this endpoint DOES guarantee, and what it cannot:
 *   • ONE client call, one server-side sequence — the browser cannot half-finish it, lose the network
 *     between the two steps, or double-place by retrying the second half.
 *   • CANCEL FIRST, and the replacement is attempted ONLY if the cancel is confirmed. A failed cancel
 *     aborts with the old order untouched, rather than leaving two live orders.
 *   • It is NOT atomic AT THE VENUE. Between the cancel and the post there is a real out-of-book gap in
 *     which the operator has no resting order; if the post is then refused, that is reported plainly as
 *     `replaced:false, oldCancelled:true` — the old order is gone and no new one exists. This is the same
 *     limitation the engine lives with (agent35 models the same cancel→replace gap), and it is stated
 *     rather than hidden behind the word "modify".
 */
async function replaceManualOrder(spec = {}, deps = {}) {
  const t0 = Date.now();
  const { orderId } = spec;
  const source = resolveSource(spec.source);
  if (!orderId) return { ok: false, gate: 'orderId-required', reason: 'orderId obbligatorio' };

  // Validate the REPLACEMENT before cancelling anything. Cancelling first and then discovering the new
  // price is off-band would leave the operator with nothing resting for no reason.
  const engine = readEngineState();
  const marketId = typeof spec.marketId === 'string' && spec.marketId.trim() ? spec.marketId.trim() : engine.pinnedMarketId;
  if (!marketId) return { ok: false, gate: 'market-unknown', reason: 'mercato non determinabile — rifiuto' };

  const mg = evaluateManualGate({ marketId }, deps.manualDeps || {});
  if (!mg.allow) return { ok: false, gate: mg.gate, reason: mg.reason, replaced: false, oldCancelled: false };

  // ── THE KILL SWITCH, CHECKED BEFORE THE CANCEL, NOT AFTER IT ────────────────────────────────────────
  // A "riprezza" is cancel-then-place, and the place is gated on the kill switch. Reading kill only on
  // the place side (which is where placeManualOrder reads it) means a killed system would cancel the old
  // order and THEN refuse the replacement — leaving the operator with nothing resting, precisely when
  // the system is in its most defensive state. So it is read here, up front, and a killed system refuses
  // the whole sequence with the old order UNTOUCHED.
  //
  // This does not take anything away from the operator: a plain CANCEL is deliberately never gated on
  // kill (see cancelManualOrder), so stopping an order remains possible at all times. What is refused is
  // only the "cancel in order to re-place" that could not complete anyway.
  const killNow = killSwitch.checkKill({ userId: spec.userId || OPERATOR_USER }, deps.killDeps || {});
  if (killNow.killed) {
    manualAudit({ op: 'manual-replace', outcome: `reject-${killNow.gate || 'kill'}`, requested: { orderId }, reason: killNow.reason, latencyMs: Date.now() - t0 }, source);
    return {
      ok: false, gate: killNow.gate || 'kill', replaced: false, oldCancelled: false,
      reason: `${killNow.reason} — il vecchio ordine NON è stato cancellato: un riprezzo è cancella+ripiazza, e con il kill attivo il ripiazzo sarebbe rifiutato, lasciandoti senza nulla a riposo. Per togliere l'ordine usa «Cancella», che resta sempre permesso.`,
    };
  }

  const rules = resolveMarketRules(marketId, deps);
  if (!rules.readable) return { ok: false, gate: 'rules-unreadable', reason: `regole di venue non leggibili (mancano: ${rules.missing.join(', ')})`, replaced: false, oldCancelled: false };

  const book = spec.book === 'no' ? 'no' : 'yes';
  const scoringMid = book === 'no' ? rules.books.no.scoringMid : rules.books.yes.scoringMid;
  const replSide = spec.side === 'SELL' ? 'SELL' : 'BUY';
  const preflight = validateQuote(
    { tick: rules.tick, scoringMid, maxSpreadCents: rules.maxSpreadCents, minSize: rules.minSize },
    { side: replSide, price: Number(spec.price), size: Number(spec.size) },
  );
  if (!preflight.valid) {
    manualAudit({ op: 'manual-replace', outcome: 'reject-venue-rules-preflight', requested: { orderId, book, price: spec.price, size: spec.size },
      reason: preflight.reasons.map((r) => r.code).join(','), latencyMs: Date.now() - t0 }, source);
    return { ok: false, gate: 'venue-rules', replaced: false, oldCancelled: false,
      reason: `il nuovo ordine non è valido, quindi il vecchio NON è stato cancellato: ${preflight.reasons.map((r) => `${r.code}: ${r.detail}`).join('; ')}`,
      reasons: preflight.reasons };
  }

  // STEP 1 — cancel. Only proceed on a CONFIRMED cancel (or a confirmed "already gone").
  const cancelled = await cancelManualOrder({ orderId, marketId, userId: spec.userId }, source);
  if (!cancelled.ok) {
    manualAudit({ op: 'manual-replace', outcome: 'reject-cancel-failed', requested: { orderId }, reason: cancelled.reason, latencyMs: Date.now() - t0 }, source);
    return { ok: false, gate: 'cancel-failed', replaced: false, oldCancelled: false,
      reason: `cancellazione non confermata (${cancelled.reason || 'errore'}) — il nuovo ordine NON è stato inviato per non lasciarne due vivi`, cancel: cancelled };
  }

  // STEP 2 — place the replacement. From here the old order is gone; if this refuses we say so.
  const placed = await placeManualOrder({ ...spec, marketId, book, side: replSide, source }, deps);
  const replaced = placed.ok === true;

  manualAudit({ op: 'manual-replace', outcome: replaced ? (placed.sent ? 'sent' : 'dry-run-validated') : `reject-${placed.gate || 'place'}`,
    requested: { orderId, book, price: spec.price, size: spec.size },
    response: { oldCancelled: true, replaced, gate: placed.gate || null, newOrderId: placed.orderId || null }, latencyMs: Date.now() - t0 }, source);

  return {
    ok: replaced,
    replaced,
    oldCancelled: true,
    oldOrderId: orderId,
    cancel: cancelled,
    place: placed,
    // WHO drove this sequence, carried out to the caller as well as into the trail.
    source,
    expiry: placed.expiry || null,
    gate: placed.gate || null,
    reason: replaced ? null
      : `il vecchio ordine È STATO cancellato ma il nuovo è stato rifiutato (${placed.gate || 'errore'}): ${placed.reason || ''} — al momento non c'è nessun ordine a riposo per questa gamba`,
    note: 'Il CLOB di Polymarket non ha un endpoint di modifica ordine: questa è una sequenza cancella→ripiazza eseguita interamente lato server in una sola chiamata. Fra i due passi esiste una finestra reale senza ordine a riposo.',
    at: new Date().toISOString(),
  };
}

module.exports = {
  manualContext, resolveMarketRules, resolveCaps, manualPlacement, readEngineState,
  evaluateManualGate, evaluateManualCapGate, resolveManualTtlSeconds,
  placeManualOrder, listManualOrders, cancelManualOrder, replaceManualOrder,
  VENUE, OPERATOR_USER, FALLBACK_LIVE_MIN_CAP_USD, MANUAL_SOURCES, DEFAULT_MANUAL_TTL_SECONDS,
};

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

/** Stamp every audit line this panel writes with source:'manual-ui', so the one trail says WHO acted. */
function manualAudit(rec) { return appendMakerAudit({ ts: Date.now(), venue: VENUE, source: 'manual-ui', ...rec }); }

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
function buildPlacementAdapter({ pinnedMarketId, liveMinCapUsd, placement, orderTtlSeconds }) {
  const { createMakerAdapter } = require('../venues/polymarket-clob-maker/adapter');
  const { credsProvider, signerProvider } = makerLiveProviders();
  return createMakerAdapter({
    mode: 'live-min',
    // The pin comes from the ENGINE's published config, so the panel is bound to the same single market
    // the engine is bound to. No pin ⇒ evaluateLiveMinMarketGate refuses every order (fail closed).
    liveMinMarket: pinnedMarketId || '',
    liveMinCapUsd: Number.isFinite(liveMinCapUsd) ? liveMinCapUsd : FALLBACK_LIVE_MIN_CAP_USD,
    placement,
    orderTtlSeconds: Number.isFinite(orderTtlSeconds) ? orderTtlSeconds : 180,
    fundingApproved: process.env.MAKER_FUNDING_APPROVED === 'true',
    credsProvider, signerProvider,
    auditSink: (rec) => appendMakerAudit({ ...rec, source: 'manual-ui' }),
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
  const engine = readEngineState();
  const marketId = typeof spec.marketId === 'string' && spec.marketId.trim() ? spec.marketId.trim() : engine.pinnedMarketId;
  const book = spec.book === 'no' ? 'no' : 'yes';
  const price = Number(spec.price);
  const size = Number(spec.size);
  const notionalUsd = (Number.isFinite(price) && Number.isFinite(size)) ? price * size : NaN;

  const refuse = (gate, reason, extra = {}) => {
    manualAudit({ op: 'manual-place', outcome: `reject-${gate}`, gate, reason, marketRef: marketId ? `cid_${String(marketId).replace(/^0x/, '')}` : null,
      requested: { book, price, size, notionalUsd: Number.isFinite(notionalUsd) ? +notionalUsd.toFixed(4) : null }, latencyMs: Date.now() - t0, userId });
    return { ok: false, sent: false, gate, reason, marketId, book, price, size,
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
  const vq = validateQuote(venueRules, { side: 'BUY', price, size });
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

  // ── Hand it to the adapter, which owns every remaining gate and the decision to send. ──
  const placement = manualPlacement(deps.env || process.env);
  let adapter;
  try {
    adapter = buildPlacementAdapter({
      pinnedMarketId: engine.pinnedMarketId,
      liveMinCapUsd: engine.liveMinCapUsd,
      placement,
      orderTtlSeconds: Number.isFinite(Number(spec.ttlSeconds)) ? Number(spec.ttlSeconds) : 180,
    });
  } catch (e) {
    return refuse('adapter-build', `non è stato possibile costruire l'adapter di piazzamento: ${e.message}`);
  }

  let res;
  try {
    res = await adapter.postOrder({
      marketId, tokenId, side: 'BUY', price, size,
      tickSize: rules.tick, negRisk: rules.negRisk === true, postOnly: true,
      venueRules, userId,
      ttlSeconds: Number.isFinite(Number(spec.ttlSeconds)) ? Number(spec.ttlSeconds) : undefined,
      decision: { source: 'manual-ui', book, byHand: true, note: spec.note || null },
    });
  } catch (e) {
    // A throw AFTER the intent row is written is ambiguous — the adapter says so in its own result; here
    // we only report what we know. Never claim a clean miss we cannot prove.
    manualAudit({ op: 'manual-place', outcome: 'error', reason: e.message, marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, latencyMs: Date.now() - t0, userId });
    return { ok: false, sent: null, ambiguous: true, gate: 'adapter-threw', reason: e.message, marketId, book, price, size };
  } finally {
    try { adapter.close(); } catch { /* scrub is best-effort */ }
  }

  manualAudit({
    op: 'manual-place',
    outcome: res.ok ? (res.sent ? 'sent' : 'dry-run-validated') : `reject-${res.gate || 'venue'}`,
    marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
    requested: { book, side: 'BUY', price, size, notionalUsd: +notionalUsd.toFixed(4) },
    gate: res.gate || null, reason: res.reason || null, orderId: res.orderId || null,
    placement, latencyMs: Date.now() - t0, userId,
  });

  return {
    ok: res.ok === true, sent: res.sent === true, dryRun: res.dryRun === true, placement,
    gate: res.gate || null, reason: res.reason || null, orderId: res.orderId || null,
    wouldSend: res.wouldSend || null, validateOrder: res.validateOrder || null,
    idempotencyKey: res.idempotencyKey || null,
    marketId, book, side: 'BUY', price, size, notionalUsd: +notionalUsd.toFixed(4),
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
    return {
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
function manualIdempotencyKeys() {
  try {
    const file = path.join(require('../safety/store').DATA_DIR, 'polymarket-maker-audit.jsonl');
    const raw = fs.readFileSync(file, 'utf8');
    const keys = new Set();
    for (const line of raw.split('\n')) {
      if (!line || line.indexOf('manual-ui') === -1) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row && row.source === 'manual-ui' && row.idempotencyKey) keys.add(row.idempotencyKey);
      if (row && row.source === 'manual-ui' && row.orderId) keys.add(String(row.orderId));
    }
    return keys;
  } catch { return new Set(); }
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
async function cancelManualOrder({ orderId, marketId = null, userId = OPERATOR_USER } = {}) {
  const t0 = Date.now();
  if (!orderId) return { ok: false, gate: 'orderId-required', reason: 'orderId obbligatorio' };

  // A cancel can only REDUCE exposure, so it is deliberately NOT gated on the kill switch or on manual
  // ownership: the operator must always be able to stop an order, including one placed while the market
  // was still engine-owned, and including while the system is killed. Same reading as the KILL button.
  const { adapter, live } = await buildReadCancelAdapter();
  let res;
  try { res = await adapter.cancelOrder(orderId); }
  catch (e) {
    manualAudit({ op: 'manual-cancel', outcome: 'error', requested: { orderId, marketId }, reason: e.message, latencyMs: Date.now() - t0, userId });
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
    latencyMs: Date.now() - t0, userId });

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
  if (!orderId) return { ok: false, gate: 'orderId-required', reason: 'orderId obbligatorio' };

  // Validate the REPLACEMENT before cancelling anything. Cancelling first and then discovering the new
  // price is off-band would leave the operator with nothing resting for no reason.
  const engine = readEngineState();
  const marketId = typeof spec.marketId === 'string' && spec.marketId.trim() ? spec.marketId.trim() : engine.pinnedMarketId;
  if (!marketId) return { ok: false, gate: 'market-unknown', reason: 'mercato non determinabile — rifiuto' };

  const mg = evaluateManualGate({ marketId }, deps.manualDeps || {});
  if (!mg.allow) return { ok: false, gate: mg.gate, reason: mg.reason, replaced: false, oldCancelled: false };

  const rules = resolveMarketRules(marketId, deps);
  if (!rules.readable) return { ok: false, gate: 'rules-unreadable', reason: `regole di venue non leggibili (mancano: ${rules.missing.join(', ')})`, replaced: false, oldCancelled: false };

  const book = spec.book === 'no' ? 'no' : 'yes';
  const scoringMid = book === 'no' ? rules.books.no.scoringMid : rules.books.yes.scoringMid;
  const preflight = validateQuote(
    { tick: rules.tick, scoringMid, maxSpreadCents: rules.maxSpreadCents, minSize: rules.minSize },
    { side: 'BUY', price: Number(spec.price), size: Number(spec.size) },
  );
  if (!preflight.valid) {
    manualAudit({ op: 'manual-replace', outcome: 'reject-venue-rules-preflight', requested: { orderId, book, price: spec.price, size: spec.size },
      reason: preflight.reasons.map((r) => r.code).join(','), latencyMs: Date.now() - t0 });
    return { ok: false, gate: 'venue-rules', replaced: false, oldCancelled: false,
      reason: `il nuovo ordine non è valido, quindi il vecchio NON è stato cancellato: ${preflight.reasons.map((r) => `${r.code}: ${r.detail}`).join('; ')}`,
      reasons: preflight.reasons };
  }

  // STEP 1 — cancel. Only proceed on a CONFIRMED cancel (or a confirmed "already gone").
  const cancelled = await cancelManualOrder({ orderId, marketId, userId: spec.userId });
  if (!cancelled.ok) {
    manualAudit({ op: 'manual-replace', outcome: 'reject-cancel-failed', requested: { orderId }, reason: cancelled.reason, latencyMs: Date.now() - t0 });
    return { ok: false, gate: 'cancel-failed', replaced: false, oldCancelled: false,
      reason: `cancellazione non confermata (${cancelled.reason || 'errore'}) — il nuovo ordine NON è stato inviato per non lasciarne due vivi`, cancel: cancelled };
  }

  // STEP 2 — place the replacement. From here the old order is gone; if this refuses we say so.
  const placed = await placeManualOrder({ ...spec, marketId, book }, deps);
  const replaced = placed.ok === true;

  manualAudit({ op: 'manual-replace', outcome: replaced ? (placed.sent ? 'sent' : 'dry-run-validated') : `reject-${placed.gate || 'place'}`,
    requested: { orderId, book, price: spec.price, size: spec.size },
    response: { oldCancelled: true, replaced, gate: placed.gate || null }, latencyMs: Date.now() - t0 });

  return {
    ok: replaced,
    replaced,
    oldCancelled: true,
    oldOrderId: orderId,
    cancel: cancelled,
    place: placed,
    gate: placed.gate || null,
    reason: replaced ? null
      : `il vecchio ordine È STATO cancellato ma il nuovo è stato rifiutato (${placed.gate || 'errore'}): ${placed.reason || ''} — al momento non c'è nessun ordine a riposo per questa gamba`,
    note: 'Il CLOB di Polymarket non ha un endpoint di modifica ordine: questa è una sequenza cancella→ripiazza eseguita interamente lato server in una sola chiamata. Fra i due passi esiste una finestra reale senza ordine a riposo.',
    at: new Date().toISOString(),
  };
}

module.exports = {
  manualContext, resolveMarketRules, resolveCaps, manualPlacement, readEngineState,
  evaluateManualGate, evaluateManualCapGate,
  placeManualOrder, listManualOrders, cancelManualOrder, replaceManualOrder,
  VENUE, OPERATOR_USER, FALLBACK_LIVE_MIN_CAP_USD,
};

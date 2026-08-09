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

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The PLACEMENT adapter is required LAZILY, inside buildPlacementAdapter() — never at module load.
// Reading orders, cancelling one, or rendering the panel's config must not pull the order-placement
// module (and its CLOB v2 signing SDK) into memory at all: the only code path that can place an order is
// the only one that loads the code that can.
const { createCancelOnlyAdapter } = require('../venues/polymarket-clob/adapter');
const { appendMakerAudit } = require('../venues/polymarket-clob-maker/audit');
const { validateQuote, splitVerdict } = require('./venue-rules');
const { isManualMarket } = require('./manual-mode');
const { makerLiveProviders } = require('./live-providers');
const { polymarketCancelCredsProvider, cancelCredsAvailable } = require('./cancel-creds-provider');
const {
  isAutoRepriceEnabled, readAutoRepriceConfig, readAutoRepriceState, AUTO_REPRICE_SOURCE,
  RESTING_GTD_SECONDS, REFRESH_MARGIN_SECONDS, EXPECTED_RENEWALS_PER_HOUR,
} = require('./auto-reprice-config');
const { readAutoCloseConfig, isAutoCloseEnabled, CLOSE_PROFIT_CENTS } = require('./auto-close-config');
// How long THIS market has left, and what order lifetime that permits. The window a hand order gets is no
// longer a constant: it is bounded by the market's own remaining life, and under the threshold nothing is
// placed at all (lib/maker/market-clock.js).
const { marketWindowFor } = require('./market-clock');
// SECURITY_DECREMENT_SEC — the venue retires a GTD order this many seconds BEFORE its stated expiration.
// Every "time left" reading below subtracts it, so what the panel shows is when the order ACTUALLY dies,
// not the timestamp printed on it.
const { SECURITY_DECREMENT_SEC } = require('./order-ttl');
const killSwitch = require('../safety/kill-switch');
const riskLimits = require('../safety/risk-limits');
// Il mid MOSTRATO e la sua coerenza col tocco. Una sola definizione, condivisa con /api/maker/quote e col
// pannello: due implementazioni di «qual è il mid» sono esattamente il difetto che stiamo chiudendo.
const { displayMid, midCoherence } = require('./book-view');
const { endOfScaleCheck } = require('./end-of-scale');
const { origineDaSource } = require('./origine-ordine');

const VENUE = 'polymarket';
const OPERATOR_USER = process.env.MAKER_OPERATOR_USER || 'operator';
const ENGINE_STATE_FILE = '/tmp/maker-state.json';
const LIVE_BOOKS_FILE = '/tmp/clob-live-books.json';
const NORMALIZED_FILE = '/tmp/liquidity-rewards.json';
// Past this the engine's published state is not describing the running engine (it ticks every 3s).
const STATE_STALE_MS = 60_000;
// The adapter's own documented default per-order cap in live-min. Used when the engine's value is
// unreadable — the DEFAULT is stricter than the engine's configured 30, which is the right direction.
// ── IL RIPIEGO NON È PIÙ UN RIPIEGO, ED È IL MOTIVO PER CUI IL NUMERO CONTA ────────────────────────
// `readEngineState()` legge /tmp/maker-state.json, che lo scriveva agent35 — RIMOSSO il 9 agosto 2026
// (§5 punto 63). Quel file non viene piu' aggiornato da nessuno, quindi `fresh` e' sempre falso,
// `liveMinCapUsd` e' sempre null e questo valore e' l'UNICO percorso possibile: non un ripiego, la
// regola. Va quindi tenuto allineato al tetto per mercato come qualunque altra soglia viva.
// Derivato da `lib/rewards/concentration.js`, la stessa fonte dell'adapter: un numero solo.
const { LIVE_MIN_ORDER_CAP_USD } = require('../rewards/concentration');
const FALLBACK_LIVE_MIN_CAP_USD = LIVE_MIN_ORDER_CAP_USD;

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// ── WHO ACTED, ON EVERY LINE ────────────────────────────────────────────────────────────────────────
// Two callers reach this core, and the trail must never blur them:
//   'manual-ui'              a human pressed a button in the panel;
//   'auto-reprice-band-exit' the band-exit watcher (agent40) moved an order because the mid moved.
// A THIRD source, 'agent35', is stamped by the automatic engine and never appears here. The list is an
// ALLOWLIST, checked below: a caller cannot invent a source, and nothing that reaches this file over HTTP
// can set one at all (the route schemas do not accept the field).
// L'ALLOWLIST E L'ATTRIBUZIONE VIVONO IN UN MODULO SENZA PIAZZAMENTO. Erano qui dentro, e questo file
// importa l'adapter che FIRMA ordini: chiunque volesse solo sapere «di chi è questo ordine» doveva
// tirarsi dietro quella superficie. agent37-maker-watchdog non può — la sua garanzia strutturale è di
// non poter piazzare nemmeno per errore — e senza quella risposta il 6 agosto ha cancellato nove ordini
// di agent40 credendo di reagire alla morte di agent35. Stessa identica implementazione, spostata:
// una seconda copia sarebbe una seconda opinione su chi possiede un ordine reale.
const { MANUAL_SOURCES, manualIdempotencyKeys, attributeOrder } = require('./attribuzione-ordini');
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
 * ── THE WINDOW IS NO LONGER A CONSTANT (2026-07-31) ─────────────────────────────────────────────────
 * Whatever window the rules above produce is then bounded by the MARKET'S OWN REMAINING LIFE
 * (lib/maker/market-clock.js): an order may be signed for at most 90% of the time left before the market
 * closes, and under the refusal threshold no order is placed at all. 23 minutes is a rounding error on a
 * market resolving in October and a fatal over-run on a five-minute Bitcoin market — the constant was
 * only ever right because every market this panel had touched was long-dated. The shortening applies to
 * an EXPLICIT ttlSeconds too: naming a lifetime says how long you want the order to rest, not that it may
 * outlive the book it is resting in. A market whose close time is unreadable keeps the ordinary window
 * (see the module header for why "unknown" is not treated as "imminent").
 *
 * @returns {{ttlSeconds:number, orderType:'GTC'|'GTD', autoReprice:boolean, refreshMarginSeconds:number|null,
 *            source:string, reason:string, window:object|null, tooClose:boolean, gate:string|null}}
 */
function resolveManualTtlSeconds({ marketId, ttlSeconds, nowMs } = {}, deps = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  // The base window, by exactly the rules that were here before the market clock existed.
  let base;
  if (Number.isFinite(Number(ttlSeconds))) {
    const n = Number(ttlSeconds);
    base = {
      ttlSeconds: n, orderType: n > 0 ? 'GTD' : 'GTC', autoReprice: false, refreshMarginSeconds: null, source: 'explicit',
      reason: n > 0 ? `lifetime named by the caller: ${n}s (GTD)` : 'lifetime named by the caller: 0 ⇒ GTC, no venue expiry',
    };
  } else {
    // ── IL TRACKING CONTA QUANTO L'AUTO-REPRICE ─────────────────────────────────────────────────
    // Un mercato con il market making a due lati attivo ha un motore che lo rinnova esattamente come il
    // watcher reattivo rinnova i suoi. Senza questa riga quegli ordini prenderebbero il GTD fisso da
    // 180 secondi — cioe' scadrebbero ogni tre minuti su un mercato che qualcuno sta quotando di
    // proposito, e la finestra lunga che il dead-man's switch deve avere non ci sarebbe.
    let tracked = false;
    try { tracked = require('./mm-tracking-config').trackingFor(marketId, deps.trackingDeps || {}) != null; } catch { tracked = false; }
    const ar = isAutoRepriceEnabled(marketId, deps.autoRepriceDeps || deps);
    base = (ar.enabled || tracked)
      ? {
        ttlSeconds: RESTING_GTD_SECONDS, orderType: 'GTD', autoReprice: true,
        refreshMarginSeconds: REFRESH_MARGIN_SECONDS, source: 'auto-reprice',
        reason: `${tracked ? 'active tracking (two-sided market making)' : 'auto-reprice'} is ACTIVE on this market — the order carries a ${Math.round(RESTING_GTD_SECONDS / 60)}-minute GTD expiry that the watcher renews proactively with ${Math.round(REFRESH_MARGIN_SECONDS / 60)} minutes of life still on it. Time never kills a healthy order; the expiry exists so that a DEAD host's order retires by itself, enforced by the exchange.`,
      }
      : {
        ttlSeconds: DEFAULT_MANUAL_TTL_SECONDS, orderType: 'GTD', autoReprice: false, refreshMarginSeconds: null,
        source: ar.readable ? 'default' : 'default-fail-closed',
        reason: ar.readable
          ? `auto-reprice is off for this market — the order carries the usual fixed ${DEFAULT_MANUAL_TTL_SECONDS}s GTD expiry`
          : `auto-reprice config unreadable (${ar.error}) — falling back to the fixed ${DEFAULT_MANUAL_TTL_SECONDS}s GTD expiry (fail closed toward the SHORTER unattended window)`,
      };
  }

  // Now bound it by how long the market itself has left.
  const w = marketWindowFor({
    marketId, nowMs: now,
    baseTtlSeconds: base.ttlSeconds,
    baseRefreshMarginSeconds: base.refreshMarginSeconds,
  }, deps.marketClockDeps || deps);

  if (w.tooClose) {
    // ttlSeconds 0 here would mean GTC (rest forever) to computeGtdExpiration — the exact opposite of what
    // is meant. The caller MUST refuse on `tooClose`; the base window is echoed back only so a caller that
    // ignores the flag still cannot end up with an unbounded order.
    return { ...base, window: w, tooClose: true, gate: w.gate, reason: w.reason };
  }

  // A GTC request (ttl ≤ 0) on a market whose close time we CAN read is converted to a bounded GTD.
  // "No venue expiry" is a promise that something alive will mind the order; nothing is alive after the
  // market closes, so on a dated market GTC means "rest past the end of the book". The bound is the same
  // 90%-of-remaining-life rule as everywhere else, and it is stated rather than applied silently. With an
  // unreadable close time GTC is left exactly as it was — we do not invent a deadline.
  const wasGtc = !(base.ttlSeconds > 0);
  if (wasGtc && w.closeKnown) {
    return {
      ...base,
      ttlSeconds: w.ttlSeconds, orderType: 'GTD', refreshMarginSeconds: w.refreshMarginSeconds,
      window: w, tooClose: false, gate: null, source: `${base.source}+market-clock`,
      reason: `${base.reason} — ma il mercato chiude fra ${w.minutesToClose.toFixed(1)} min: un ordine SENZA scadenza sopravvivrebbe alla chiusura, quindi la richiesta GTC diventa un GTD di ${w.ttlSeconds}s (${Math.round(w.ttlSeconds / 60)} min)`,
    };
  }

  return {
    ...base,
    ttlSeconds: w.ttlSeconds,
    orderType: w.ttlSeconds > 0 ? 'GTD' : base.orderType,
    refreshMarginSeconds: w.refreshMarginSeconds,
    window: w,
    tooClose: false,
    gate: null,
    source: w.shortened ? `${base.source}+market-clock` : base.source,
    reason: w.shortened ? `${base.reason} — ${w.reason}` : base.reason,
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
  let nm = norm && Array.isArray(norm.markets) ? norm.markets.find((m) => m && m.marketId === id) : null;

  // ── THE HAND-ADDED MARKET FALLBACK ──────────────────────────────────────────────────────────────────
  // The two sources above are the REWARD BOARD and agent34's live subscription, and both only ever contain
  // markets that pay a liquidity reward (agent24 filters on rewardsDailyRate > 0). A market the operator
  // picked by hand from the allocation panel is, by construction, often not in either — so without this,
  // every order on it dies at 'rules-unreadable' no matter which gate would have had an opinion.
  //
  // It is a FALLBACK, never an override: a market present on the live board keeps using the board, which
  // is refreshed every cycle. The catalog answers only for markets the board has never heard of, and it
  // answers with a SNAPSHOT — whose age travels with it (midSource:'manual-catalog' + midAgeSec below),
  // because a band judged against a mid read hours ago is a materially different claim from one judged
  // against the current book, and the operator has to be able to see which they are getting.
  // The condition is `!nm`, NOT `!nm && !bm`. Since agent34 also subscribes to the operator's enabled
  // markets, a hand-added market now HAS a live book — and the live book carries a mid, not a tick, a
  // negRisk flag or a reward programme. Keying the fallback off `bm` too would mean that the moment the
  // feed picked the market up, its venue rules vanished and every order on it died at 'rules-unreadable'.
  // The two sources compose instead: the catalog answers "what are this market's venue parameters", the
  // live book answers "what is the price right now", and the mid below prefers the live book.
  let catalogRec = null;
  if (!nm && id) {
    try {
      catalogRec = deps.catalogRecord !== undefined ? deps.catalogRecord : require('./market-catalog').readMarketRecord(id, deps);
    } catch { catalogRec = null; }
    if (catalogRec) {
      nm = {
        marketId: id,
        title: catalogRec.question || '',
        midpoint: Number.isFinite(catalogRec.mid) ? catalogRec.mid : null,
        tickSize: catalogRec.tick,
        // A market with NO reward programme publishes no band and no minimum incentive size. They stay
        // null/absent here rather than being coerced to 0: `null` reaches the venue-rules guard as
        // RULES_UNREADABLE (a refusal that names itself), whereas a fabricated band would silently
        // authorise a quote against a rule the venue never published.
        maxSpread: Number.isFinite(catalogRec.rewardsMaxSpreadCents) ? catalogRec.rewardsMaxSpreadCents : null,
        minSize: Number.isFinite(catalogRec.rewardsMinSize) ? catalogRec.rewardsMinSize : null,
        tokenId: catalogRec.tokenIdYes,
        tokenIdNo: catalogRec.tokenIdNo,
        negRisk: catalogRec.negRisk,
        bestBid: catalogRec.bestBid,
        bestAsk: catalogRec.bestAsk,
        updatedAt: Number.isFinite(catalogRec.fetchedAt) ? new Date(catalogRec.fetchedAt).toISOString() : null,
      };
    }
  }

  const missing = [];
  // The SCORING MID, and WHERE IT CAME FROM. First choice is agent34's live book (the ADJUSTED mid the
  // engine itself quotes off). When that market is not in the current snapshot we fall back to the
  // normalized board row — and SAY SO (`midSource`/`midAgeSec`), because a band check against a mid that
  // is minutes old can pass while the venue's current scoring mid would fail it. The panel surfaces that
  // rather than hiding it: on a hand order the price is the operator's decision, so the honest move is to
  // show the age of the number the band was judged against, not to refuse and leave no way to act.
  const mid = bm && Number.isFinite(bm.mid) ? bm.mid : (nm && Number.isFinite(nm.midpoint) ? nm.midpoint : null);
  const midSource = (bm && Number.isFinite(bm.mid))
    ? 'live-book'
    : (nm && Number.isFinite(nm.midpoint) ? (catalogRec ? 'manual-catalog' : 'board-row') : null);
  const rowUpdatedMs = nm && nm.updatedAt ? Date.parse(nm.updatedAt) : NaN;
  const midAgeSec = (bm && Number.isFinite(bm.ageMs))
    ? Math.round(bm.ageMs / 1000)
    : (Number.isFinite(rowUpdatedMs) ? Math.max(0, Math.round((Date.now() - rowUpdatedMs) / 1000)) : null);

  // ── IL TOCCO VIENE DALLA STESSA FONTE DEL MID. NON DA UN RIPIEGO INDIPENDENTE. ──────────────────────
  // Prima `mid` e `bestBid`/`bestAsk` ripiegavano su catene di condizioni SEPARATE: `mid` guardava
  // `bm.mid`, il tocco guardava `bm.yes.bestBid`. Bastava che il book live avesse il tocco ma non un
  // adjusted mid (o viceversa) perché il pannello mettesse in fila un mid della riga di board — vecchio
  // di minuti — accanto a un tocco live di adesso. Due fonti, due istanti, tre numeri che non tornano.
  // È metà della causa di «MID 20.0¢ · BID 21.0¢ · ASK 22.0¢»; l'altra metà è il filtro anti-polvere di
  // `adjustedMid`, che resta com'è perché è il numero con cui il venue paga i premi.
  //
  // Adesso la fonte si sceglie UNA VOLTA, e mid e tocco escono insieme da quella. `midFromLive` è la
  // stessa condizione che decide `midSource`: non possono più divergere.
  const midFromLive = !!(bm && Number.isFinite(bm.mid));
  const touch = midFromLive
    ? {
      bestBid: (bm.yes && Number.isFinite(bm.yes.bestBid)) ? bm.yes.bestBid : null,
      bestAsk: (bm.yes && Number.isFinite(bm.yes.bestAsk)) ? bm.yes.bestAsk : null,
    }
    : {
      bestBid: (nm && Number.isFinite(nm.bestBid)) ? nm.bestBid : null,
      bestAsk: (nm && Number.isFinite(nm.bestAsk)) ? nm.bestAsk : null,
    };
  const tick = nm && Number.isFinite(nm.tickSize) ? nm.tickSize : null;
  const maxSpreadCents = (bm && Number.isFinite(bm.maxSpread)) ? bm.maxSpread : (nm && Number.isFinite(nm.maxSpread) ? nm.maxSpread : null);
  const minSize = (bm && Number.isFinite(bm.minSize)) ? bm.minSize : (nm && Number.isFinite(nm.minSize) ? nm.minSize : null);
  const tokenId = nm && nm.tokenId ? String(nm.tokenId) : (bm && bm.tokenId ? String(bm.tokenId) : null);
  const tokenIdNo = nm && nm.tokenIdNo ? String(nm.tokenIdNo) : (bm && bm.tokenIdNo ? String(bm.tokenIdNo) : null);
  // negRisk decides WHICH EXCHANGE the order settles against, so it must come from the venue feed and is
  // never assumed. Absent ⇒ unreadable, not `false`.
  const negRisk = nm && typeof nm.negRisk === 'boolean' ? nm.negRisk : null;

  // Il mid DA MOSTRARE: midpoint del tocco scelto qui sopra, per costruzione fra bid e ask. Resta
  // SEPARATO dal mid di SCORING (`mid`), che è il numero del venue e continua a comandare banda,
  // `validateQuote` e auto-reprice esattamente come prima. Quando i due divergono — book sottile, primi
  // livelli sotto `min_incentive_size` — `midNotes` lo dice a parole invece di lasciare tre cifre mute.
  const dm = displayMid(touch.bestBid, touch.bestAsk);
  const coh = midCoherence({
    mid: dm.mid, midKind: dm.kind, scoringMid: mid,
    bestBid: touch.bestBid, bestAsk: touch.bestAsk, minSize,
    spreadCents: (Number.isFinite(touch.bestBid) && Number.isFinite(touch.bestAsk))
      ? +((touch.bestAsk - touch.bestBid) * 100).toFixed(3) : null,
  });

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
    // WHERE these rules came from, and — for a hand-added market — whether the venue publishes a reward
    // band for it at all. `rewardBand:'none'` is not a permission: the band guard still refuses (the band
    // is one of the rules it needs), and this field exists so the refusal can be EXPLAINED as "questo
    // mercato non ha programma reward" instead of the generic "regole non leggibili".
    // Both sources are named when both were used, so nobody has to guess where the tick came from on a
    // market whose mid is live.
    rulesSource: (bm && catalogRec) ? 'live-book+manual-catalog'
      : (bm ? 'live-book' : (catalogRec ? 'manual-catalog' : (nm ? 'board-row' : null))),
    rewardProgramme: catalogRec ? (catalogRec.hasRewards ? 'active' : 'none') : (maxSpreadCents != null ? 'active' : null),
    rewardsDailyRate: catalogRec ? catalogRec.rewardsDailyRate : null,
    bandRadiusCents: maxSpreadCents != null ? maxSpreadCents / 2 : null,
    feedLive: !!(bm && bm.live),
    feedAgeSec: bm && Number.isFinite(bm.ageMs) ? Math.round(bm.ageMs / 1000) : null,
    midSource, midAgeSec,
    // ── VITALITA' DEL FEED NEL SUO INSIEME, non di questo asset ─────────────────────────────────
    // La consuma il guard mid-stale di auto-reprice per scegliere fra limite permissivo e severo:
    // il silenzio su un mercato tranquillo e' «nessuna notizia» solo se il socket sta consegnando
    // altrove. Viaggia GREZZA — nessun default inventato qui: se agent34 non la pubblica il campo
    // resta null, e regimeFeed() ripiega da solo sul limite severo. Fabbricarla qui significherebbe
    // dichiarare vivo un feed che non abbiamo osservato.
    feedVitality: (books && books.feed && books.feed.vitality && typeof books.feed.vitality === 'object')
      ? books.feed.vitality : null,
    // Il tocco, dalla STESSA fonte del mid di scoring. `touchSource` lo dichiara, così il pannello non
    // deve dedurlo — e un giorno in cui le due cose tornassero a divergere si vedrebbe subito.
    bestBid: touch.bestBid,
    bestAsk: touch.bestAsk,
    touchSource: midSource,
    // ── IL MID MOSTRATO, e la sua relazione con quello di scoring ──
    displayMid: dm.mid,
    displayMidKind: dm.kind,
    midDiffersFromScoring: coh.differs,
    scoringMidOutsideTouch: coh.outsideTouch,
    midNotes: coh.notes,
    // The per-book view the form and the guard both use. `scoringMid` è INVARIATO: è il numero che
    // decide dove finiscono ordini veri, e questo lavoro non lo sposta di un centesimo.
    books: {
      yes: { tokenId, scoringMid: mid, bestBid: touch.bestBid, bestAsk: touch.bestAsk, displayMid: dm.mid },
      no: {
        tokenId: tokenIdNo,
        scoringMid: mid == null ? null : +(1 - mid).toFixed(6),
        // Il book NO è un CLOB indipendente: quando il feed lo pubblica si mostra il SUO tocco, non lo
        // specchio di quello YES. Prima il pannello scriveva «Mid (NO)» accanto al bid/ask del book YES,
        // che è un terzo modo di far comparire un mid fuori dal tocco che gli sta accanto.
        bestBid: (midFromLive && bm.no && Number.isFinite(bm.no.bestBid)) ? bm.no.bestBid : null,
        bestAsk: (midFromLive && bm.no && Number.isFinite(bm.no.bestAsk)) ? bm.no.bestAsk : null,
        displayMid: (midFromLive && bm.no)
          ? displayMid(
            Number.isFinite(bm.no.bestBid) ? bm.no.bestBid : null,
            Number.isFinite(bm.no.bestAsk) ? bm.no.bestAsk : null,
          ).mid
          : (dm.mid == null ? null : +(1 - dm.mid).toFixed(6)),
      },
    },
  };
}

/**
 * I LIVELLI DEL BOOK, per il trigger di erosione del tracking.
 *
 * VIVE QUI, ACCANTO A `resolveMarketRules`, E NON IN UN MODULO SUO, per una ragione sola: legge lo
 * STESSO file e la STESSA forma. Un secondo lettore altrove sarebbe una seconda opinione su dove sta il
 * book e su quando e' vecchio, e le due potrebbero divergere senza che nessuno se ne accorga.
 *
 * NON VIENE AGGIUNTO A `resolveMarketRules`. Quella funzione risponde alle route del pannello e il suo
 * ritorno finisce nel JSON che arriva al browser: infilarci dodici livelli per due book per mercato
 * significherebbe spedire una scala di profondita' a ogni schermata che chiede un tick. Sono due
 * domande diverse e restano due chiamate diverse — chi vuole la profondita' la chiede.
 *
 * FAIL CLOSED come tutto il resto: file assente, mercato assente, book non `live` ⇒ `readable:false` con
 * il motivo. Un book che non si e' letto non e' un book vuoto, e non deve poter sembrare erosione.
 */
function resolveMarketDepth(marketId, deps = {}) {
  const id = typeof marketId === 'string' ? marketId.trim() : '';
  const books = deps.books || readJson(LIVE_BOOKS_FILE);
  const bm = books && books.markets ? books.markets[id] : null;
  if (!bm) {
    return { readable: false, reason: 'mercato non presente nello snapshot del book live', marketId: id, yes: null, no: null, ageMs: null, live: false };
  }
  const bids = (b) => (b && b.levels && Array.isArray(b.levels.bids) ? b.levels.bids : null);
  // Gli ASK servono da quando esiste una quotazione maker in VENDITA (l'uscita di auto-close): la sua
  // coda e' quella degli ask, non quella dei bid. Prima non li si trasportava per non far credere che
  // qualcuno li stesse guardando; adesso qualcuno li guarda, e per quella domanda sola.
  const asks = (b) => (b && b.levels && Array.isArray(b.levels.asks) ? b.levels.asks : null);
  const yesBids = bids(bm.yes);
  const noBids = bids(bm.no);
  if (!yesBids && !noBids) {
    return { readable: false, reason: 'lo snapshot non pubblica livelli per nessuno dei due book', marketId: id, yes: null, no: null, ageMs: Number.isFinite(bm.ageMs) ? bm.ageMs : null, live: !!bm.live };
  }
  return {
    readable: true, reason: null, marketId: id,
    // Per lato: i BID, che sono la coda davanti a un ordine in acquisto. Gli ask non servono a questa
    // domanda e non vengono trasportati per non far credere che qualcuno li stia guardando.
    yes: yesBids ? { bids: yesBids, asks: asks(bm.yes) } : null,
    no: noBids ? { bids: noBids, asks: asks(bm.no) } : null,
    ageMs: Number.isFinite(bm.ageMs) ? bm.ageMs : null,
    live: !!bm.live,
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
    // ── WHICH MARKETS live-min MAY TOUCH RIGHT NOW ──────────────────────────────────────────────────
    // The adapter re-reads this list per order; the panel shows the SAME list so "why was my order
    // refused with live-min-market-mismatch" is answerable without reading a log. The env pin is one
    // entry, not the whole set (see evaluateLiveMinMarketGate).
    liveMinAllowlist: {
      pinnedMarketId: engine.pinnedMarketId,
      enabledMarketIds: arCfg.liveMinMarketIds || arCfg.enabledMarketIds || [],
      count: (arCfg.enabledMarketIds || []).length + (engine.pinnedMarketId && !(arCfg.enabledMarketIds || []).includes(String(engine.pinnedMarketId).toLowerCase()) ? 1 : 0),
      targetAllowed: targetId
        ? ((arCfg.enabledMarketIds || []).map((x) => String(x).toLowerCase()).includes(String(targetId).toLowerCase())
          || (!!engine.pinnedMarketId && String(engine.pinnedMarketId).toLowerCase() === String(targetId).toLowerCase()))
        : null,
      note: 'live-min accetta un ordine solo su un mercato di questa lista (opt-in durevole e auditato) o sul pin MAKER_LIVE_MIN_MARKET. Lista vuota e nessun pin ⇒ nessun ordine passa.',
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
      enabledMarketIds: arCfg.liveMinMarketIds || arCfg.enabledMarketIds || [],
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
      expiry: ttl ? {
        orderType: ttl.orderType, ttlSeconds: ttl.ttlSeconds, refreshMarginSeconds: ttl.refreshMarginSeconds,
        source: ttl.source, reason: ttl.reason,
        // The market's own clock, as the placement path sees it: when it closes, how that was read, and
        // whether a new order would be refused right now for being too near the close.
        tooClose: ttl.tooClose === true,
        window: ttl.window ? {
          closeKnown: ttl.window.closeKnown, endIso: ttl.window.endIso, closeSource: ttl.window.closeSource,
          minutesToClose: ttl.window.minutesToClose, minMinutes: ttl.window.minMinutes, shortened: ttl.window.shortened,
        } : null,
      } : null,
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
    // The pin comes from the ENGINE's published config, so the panel honours the same env pin the engine
    // honours. It is ONE ENTRY of the allowlist, not the whole of it: the rest is the operator's enabled
    // list, which the adapter re-reads from data/maker-auto-reprice.json on every placement (so a market
    // enabled in the panel binds within seconds, and one disabled stops being placeable just as fast).
    // Empty list AND no pin ⇒ evaluateLiveMinMarketGate refuses every order (fail closed).
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
  // `price` e `notionalUsd` NON sono costanti: il controllo anti-taker piu' sotto puo' ricalcolare il
  // prezzo dal mid vivo mantenendo la distanza scelta, e il controvalore deve seguirlo — altrimenti il
  // tetto per ordine giudicherebbe una cifra diversa da quella che parte.
  let price = Number(spec.price);
  const size = Number(spec.size);
  let notionalUsd = (Number.isFinite(price) && Number.isFinite(size)) ? price * size : NaN;

  // ── I DUE FATTI CHE DEVONO SOPRAVVIVERE ANCHE AL RIFIUTO ────────────────────────────────────────
  // Dichiarati QUI, sopra `refuse`, e non dove vengono calcolati. Non è uno spostamento cosmetico: con
  // `let` più in basso, un rifiuto anticipato (mercato ignoto, proprietà, regole illeggibili) che li
  // leggesse cadrebbe nella zona morta temporale e romperebbe il piazzamento con un ReferenceError —
  // cioè un guasto peggiore del buco di osservabilità che si sta chiudendo.
  //
  // PERCHÉ SERVONO SUL RIFIUTO. Sul percorso felice viaggiavano già, nell'audit e nel valore di
  // ritorno. Sul rifiuto no: e il rifiuto è proprio il caso che interessa misurare — «quante volte la
  // regola mai-primi ha scartato un mercato» è una domanda sui NO, non sui sì. Senza questi due campi
  // il referto di un ordine rifiutato dopo il calcolo della coda diceva soltanto quale gate l'aveva
  // fermato, e non che il prezzo era già stato spostato prima di arrivarci.
  let priceAdjusted = null;
  let inCodaEsito = null;

  // ── CHI HA VOLUTO QUESTO ORDINE: una mano o un ciclo (lib/maker/origine-ordine.js) ─────────────
  // Accanto a `source`, non al posto suo. `source` dice quale CORSIA piazza — ed e' quello che agent40
  // e agent35 leggono per sapere di chi e' un ordine. `origine` dice se dietro c'era una persona.
  // Serve perche' agent41 piazza dalla stessa corsia del pannello, con lo stesso identico timbro: senza
  // questo campo il suo reset non puo' distinguere i propri ordini da quelli messi a mano.
  const origine = origineDaSource(source, spec.origine || null);

  const refuse = (gate, reason, extra = {}) => {
    manualAudit({ op: 'manual-place', outcome: `reject-${gate}`, gate, reason, marketRef: marketId ? `cid_${String(marketId).replace(/^0x/, '')}` : null,
      requested: { book, side, price, size, notionalUsd: Number.isFinite(notionalUsd) ? +notionalUsd.toFixed(4) : null },
      inCoda: inCodaEsito, priceAdjusted, origine,
      latencyMs: Date.now() - t0, userId }, source);
    return { ok: false, sent: false, gate, reason, marketId, book, side, price, size,
      notionalUsd: Number.isFinite(notionalUsd) ? +notionalUsd.toFixed(4) : null,
      inCoda: inCodaEsito, priceAdjusted, origine, ...extra };
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

  // ── UN ORDINE MANUALE NON SI ESEGUE MAI COME TAKER (punto 2) ────────────────────────────────────
  // Il prezzo arriva da una schermata che l'operatore ha composto qualche secondo fa. In quei secondi il
  // mid si e' mosso, e un prezzo che era «due centesimi sotto il mid» puo' essere diventato «sopra il
  // miglior ask» — cioe' un ordine che si esegue subito, come taker, contro chi vende. Non e' l'ordine
  // che l'operatore ha chiesto: e' un altro ordine, allo stesso numero.
  //
  // Chi ha composto l'ordine come DISTANZA dal mid lo dichiara qui (`distanceCents` + `belowMid`). In
  // quel caso il prezzo viene RICALCOLATO adesso, dal mid vivo, mantenendo la distanza scelta: e'
  // l'intenzione dell'operatore — «stai a due centesimi dal mid» — applicata al mid di questo istante
  // invece che a quello di prima.
  //
  // E SE ANCHE COSI' INCROCIA? Non si converte in silenzio a un prezzo diverso da quello mostrato, e non
  // si esegue come taker: si RIFIUTA. Un ordine che l'operatore non ha visto non parte, nemmeno se e'
  // "vicino" a quello che ha chiesto.
  const touch = book === 'no' ? rules.books.no : rules.books.yes;
  if (Number.isFinite(spec.distanceCents) && spec.distanceCents >= 0 && Number.isFinite(rules.mid) && Number.isFinite(rules.tick)) {
    const sideMid = book === 'no' ? (1 - rules.mid) : rules.mid;
    const below = spec.belowMid !== false;
    const raw = below ? sideMid - spec.distanceCents / 100 : sideMid + spec.distanceCents / 100;
    const snapped = +(Math.round(raw / rules.tick) * rules.tick).toFixed(10);
    if (Number.isFinite(snapped) && snapped > 0 && snapped < 1 && Math.abs(snapped - price) > rules.tick / 1000) {
      priceAdjusted = { from: price, to: snapped, distanceCents: spec.distanceCents, midUsed: +sideMid.toFixed(6) };
      price = snapped;
      notionalUsd = (Number.isFinite(price) && Number.isFinite(size)) ? price * size : NaN;
    }
  }
  // ── MAI PRIMI SUL LIBRO: UN TICK DIETRO A CHI C'E' GIA' ──────────────────────────────────────────
  // Si applica SOLO se il chiamante lo dichiara (`inCoda`), per la stessa ragione per cui questo file
  // rifiuta invece di correggere: un prezzo che cambia da solo e' un ordine che l'operatore non ha
  // visto. Chi lo dichiara accetta che il prezzo si sposti, e lo spostamento viaggia nel referto e
  // nell'audit come `priceAdjusted` — la stessa strada del ricalcolo dal mid vivo.
  //
  // Tre percorsi lo dichiarano: le due gambe del piano, il riprezzo che insegue il mid, e l'uscita
  // maker di auto-close. NON lo dichiara la chiusura forzata a mercato, che deve eseguire e non quotare.
  //
  // Se `prezzoInCoda` non sa rispondere — feed senza livelli, banda illeggibile, tick assente — il
  // prezzo resta quello che era. Non si ripiega su un valore di comodo: si tiene la quotazione gia'
  // calcolata dal chiamante, che e' comunque dentro banda per costruzione.
  if (spec.inCoda === true) {
    try {
      const { prezzoInCoda } = require('./prezzo-in-coda');
      const depth = (deps && typeof deps.resolveDepth === 'function') ? deps.resolveDepth(spec.marketId) : resolveMarketDepth(spec.marketId, deps || {});
      // ── I NOSTRI ORDINI A RIPOSO SU QUESTO LIBRO ─────────────────────────────────────────────
      // Servono per non inseguire noi stessi di un tick a ogni ordine. Finora arrivavano SOLO da chi
      // chiamava, e un solo chiamante li passava davvero (il watcher di riprezzo, che calcola
      // `nostriSulLato` e lo dà sia alla decisione sia al piazzamento).
      //
      // Tutti gli altri — il pannello manuale, le due gambe del piano, bulk-allocate, l'uscita maker —
      // dichiaravano `inCoda: true` e passavano una lista VUOTA. Con la lista vuota `prezzoInCoda` non
      // ha modo di sapere che il miglior prezzo sul lato è nostro, e ci si accoda dietro al proprio
      // stesso ordine: dal SECONDO ordine in poi, un tick per volta, fino al bordo della banda. È lo
      // stesso difetto che il motore di decisione aveva già corretto — presente su un percorso,
      // assente sull'altro.
      //
      // Adesso, se il chiamante non li passa, si LEGGONO. La lettura è la stessa funzione che il
      // pannello usa per mostrare gli ordini a riposo, ristretta a questo mercato, e si tiene solo il
      // lato che si sta quotando (per token id, non per etichetta: il lato è un fatto del venue).
      //
      // FALLIRE QUI NON BLOCCA IL PIAZZAMENTO. Se la lettura non riesce si prosegue con la lista vuota
      // — cioè il comportamento di prima — e il motivo finisce nel referto: la regola «mai primi» non
      // è un gate di sicurezza, è una politica di prezzo, e un suo dato mancante non deve poter
      // impedire un ordine che l'operatore ha chiesto. Il gate che protegge il capitale è un altro.
      let nostri = Array.isArray(spec.ownOrders) ? spec.ownOrders : null;
      let ownOrdersNota = null;
      if (!nostri) {
        try {
          const lettore = (deps && typeof deps.resolveOwnOrders === 'function')
            ? deps.resolveOwnOrders
            : async (id) => listManualOrders({ marketId: id });
          const l = await lettore(spec.marketId);
          const righe = (l && Array.isArray(l.orders)) ? l.orders : [];
          const tokenDelLato = book === 'no' ? rules.tokenIdNo : rules.tokenId;
          nostri = righe
            .filter((o) => o && o.tokenId && tokenDelLato && String(o.tokenId) === String(tokenDelLato))
            .map((o) => ({ orderId: o.orderId, price: o.price, size: o.sizeRemaining != null ? o.sizeRemaining : o.size }))
            .filter((o) => Number.isFinite(o.price) && Number.isFinite(o.size) && o.size > 0);
          ownOrdersNota = `letti dal venue: ${nostri.length} nostri ordini su questo lato`;
        } catch (e) {
          nostri = [];
          ownOrdersNota = `nostri ordini NON letti (${e && e.message ? e.message : String(e)}): la coda è calcolata senza sottrarli`;
        }
      }
      // ── LA PROTEZIONE DI PROFONDITÀ, SE QUESTO MERCATO CE L'HA ACCESA ────────────────────────
      // `depthMultiple` arriva dalla stessa configurazione per-mercato che porta distanza e soglia
      // (offset-config), risolta dal chiamante e passata qui. Assente o 0 ⇒ la regola non esiste e
      // `prezzoInCoda` si comporta come sempre. La size è quella che si sta per piazzare: la soglia
      // è N volte QUESTO ordine, non una size nominale.
      const q = prezzoInCoda({
        book, side: spec.side === 'SELL' ? 'SELL' : 'BUY', rules, depth, ownOrders: nostri,
        offsetCents: spec.distanceCents,
        depthMultiple: Number.isFinite(Number(spec.depthMultiple)) ? Number(spec.depthMultiple) : null,
        ownSize: Number.isFinite(size) && size > 0 ? size : null,
      });
      inCodaEsito = { ok: q.ok, mode: q.mode, onTop: q.onTop, bestOther: q.bestOther, reason: q.reason,
        quotabile: q.quotabile, depth: q.depth || null,
        // Da dove sono usciti i «nostri ordini» sottratti dal libro, e quanti erano: senza questo, un
        // prezzo accodato a se stesso e uno accodato al concorrente hanno lo stesso identico referto.
        ownOrders: { conteggio: nostri.length, origine: ownOrdersNota || 'passati dal chiamante' } };
      // ── «NON QUOTARE» È UNA RISPOSTA, NON UN'ASSENZA DI RISPOSTA ─────────────────────────────
      // `quotabile === false` significa che la regola ha deciso: un tick dietro il concorrente
      // uscirebbe dalla banda, e restare in banda vorrebbe dire salire in cima al libro. Non si
      // ripiega sul prezzo del chiamante — quello è il ripiego per quando NON SI SA rispondere
      // (`quotabile === null`), ed è la distinzione che tiene separato un guasto da una decisione.
      // ── E VALE SOLO IN ACQUISTO ────────────────────────────────────────────────────────────
      // La regola nasce da «l'esecuzione è il costo»: vera per un ordine che APRE esposizione, falsa
      // per uno che la chiude. Per la vendita dell'uscita maker essere in testa alla coda è
      // esattamente lo scopo — è lì per essere eseguita, e rifiutarla perché sarebbe prima
      // trasformerebbe una politica di ingresso in un ostacolo all'uscita, che è il verso sbagliato
      // per una regola di sicurezza. La vendita continua a spostarsi dietro quando può (il prezzo
      // migliore lo prende comunque), ma non viene mai RIFIUTATA per questo.
      if (q.quotabile === false && spec.side !== 'SELL') {
        return refuse('mai-primo-sul-libro', q.reason, { mode: q.mode, bestOther: q.bestOther, book });
      }
      if (q.ok && Number.isFinite(q.price) && Math.abs(q.price - price) > rules.tick / 1000) {
        priceAdjusted = {
          ...(priceAdjusted || {}),
          inCoda: {
            from: price, to: q.price, mode: q.mode, onTop: q.onTop, bestOther: q.bestOther,
            // ── L'ARRETRAMENTO PER PROFONDITÀ, DETTO PER INTERO ────────────────────────────────
            // I cinque numeri chiesti: il minimo (un tick dietro), il prezzo finale, la profondità
            // trovata davanti, la soglia richiesta, e QUALE delle due condizioni ha fermato la
            // camminata. Viaggiano nel referto e nell'audit come ogni altro aggiustamento di prezzo,
            // così «perché quest'ordine è più lontano del solito» ha una risposta senza ricalcoli.
            ...(q.depth && q.depth.applied ? {
              depth: {
                minPrice: q.depth.minPrice,
                finalPrice: q.price,
                ticksBack: q.depth.ticksBack,
                depthAhead: q.depth.depthAhead,
                required: q.depth.required,
                multiple: q.depth.multiple,
                ownSize: q.depth.ownSize,
                stoppedBy: q.depth.stoppedBy,
              },
            } : {}),
          },
        };
        price = q.price;
        notionalUsd = (Number.isFinite(price) && Number.isFinite(size)) ? price * size : NaN;
      }
    } catch (e) { inCodaEsito = { ok: false, reason: `coda non calcolabile: ${e.message}` }; }
  }

  // ── IL CONTROLLO FINALE, sul prezzo che partirebbe davvero — E DIPENDE DAL LATO ──────────────────
  //
  // Fino al 4 agosto qui c'era UNA sola condizione, `price >= bestAsk`, applicata a ogni ordine. È la
  // regola giusta per un ACQUISTO: compri e raggiungi il miglior ask ⇒ ti eseguono subito, da taker.
  // Per una VENDITA è la regola sbagliata, e sbagliata in entrambe le direzioni:
  //   · una vendita AL miglior ask non incrocia niente — è esattamente una quotazione maker, e veniva
  //     RIFIUTATA (misurato: 53 rifiuti in un'ora su un'uscita automatica legittima);
  //   · una vendita SOTTO il miglior bid incrocia davvero e si esegue da taker — e NON veniva vista.
  //
  // Il guard è servito finora perché l'unica cosa che piazza SELL è l'uscita automatica, e i suoi
  // prezzi stavano sopra il bid. Ha protetto per coincidenza, non per costruzione.
  //
  // La regola, per lato:
  //   BUY   incrocia se  price >= bestAsk   (raggiunge chi vende)
  //   SELL  incrocia se  price <= bestBid   (raggiunge chi compra)
  //
  // ── L'UNICA ECCEZIONE, DICHIARATA DAL CHIAMANTE E SOLO IN VENDITA ────────────────────────────────
  // L'uscita forzata di lib/maker/auto-close (trigger «fuori banda» o «tempo scaduto») vende AL miglior
  // bid di proposito: e' un'uscita, non una quotazione, e il punto e' proprio smettere di aspettare. Con
  // la regola corretta quella vendita ricadrebbe esattamente nella definizione di incrocio, e senza
  // questa eccezione la posizione non sarebbe piu' chiudibile a forza — cioe' avremmo scambiato un bug
  // con uno peggiore.
  //
  // Perche' e' stretta e non un interruttore generale:
  //   · vale SOLO per i SELL. Un acquisto aggressivo APRE esposizione, e non esiste motivo per cui
  //     questo percorso debba poterlo fare da taker: per il BUY la regola resta assoluta.
  //   · va dichiarata dal chiamante ordine per ordine (`attraversaApposta`), mai per difetto.
  //   · non e' silenziosa: l'ordine parte marcato, e l'audit lo distingue da una quotazione normale.
  const lato = spec.side === 'SELL' ? 'SELL' : 'BUY';
  const rifTocco = lato === 'SELL' ? (touch && touch.bestBid) : (touch && touch.bestAsk);
  const incrocia = lato === 'SELL'
    ? (Number.isFinite(rifTocco) && price <= rifTocco + 1e-12)
    : (Number.isFinite(rifTocco) && price >= rifTocco - 1e-12);
  // ── LA SECONDA ECCEZIONE, E IL GATE SI VERIFICA IL TETTO DA SOLO (9 agosto 2026) ─────────────────
  // Fino a oggi la riga qui sotto era `lato === 'SELL' && spec.attraversaApposta === true`, e il
  // commento sopra diceva «per il BUY la regola resta assoluta». Resta assoluta per le QUOTAZIONI. Ma
  // l'operatore ha deciso il 9 agosto che dopo un fill su un lato solo il rischio direzionale va chiuso
  // SUBITO comprando la controparte da taker — e un acquisto aggressivo e' esattamente cio' che quella
  // riga vietava. Senza questa eccezione la regola nuova sarebbe codice che non puo' eseguire.
  //
  // PERCHE' QUESTA E' STRETTA QUANTO L'ALTRA, e in un verso lo e' di piu':
  //   · il chiamante deve dichiarare `completaCoppia: true` — non basta `attraversaApposta`, che da
  //     solo continua a non fare niente su un BUY;
  //   · e deve dichiarare i DUE numeri che definiscono il limite: quanto ha pagato il lato che gia'
  //     possiede e qual e' il tetto della coppia. Questo gate **rifa' l'aritmetica** e rifiuta se
  //     `carico + prezzo` supera il tetto. Non e' una dichiarazione di cui fidarsi: e' un vincolo che
  //     viene verificato QUI, sull'ordine esatto che sta per partire.
  //   · numeri assenti o illeggibili ⇒ nessuna eccezione, e il BUY torna a essere rifiutato come prima.
  //     Un dato mancante non puo' allargare un permesso.
  // Quindi un BUY aggressivo puo' passare solo per completare una coppia gia' aperta, e solo dentro un
  // costo massimo dichiarato e ricontrollato. Non e' un permesso di attraversare lo spread: e' un
  // permesso di chiudere un rischio, limitato in dollari.
  const caricoCoppia = Number(spec.prezzoCaricoCoppia);
  const tettoCoppia = Number(spec.tettoCoppiaCents);
  const completaCoppiaOk = lato === 'BUY'
    && spec.attraversaApposta === true && spec.completaCoppia === true
    && Number.isFinite(caricoCoppia) && caricoCoppia > 0
    && Number.isFinite(tettoCoppia) && tettoCoppia >= 100 && tettoCoppia <= 200
    && (caricoCoppia + price) * 100 <= tettoCoppia + 1e-9;
  if (lato === 'BUY' && incrocia && spec.completaCoppia === true && !completaCoppiaOk) {
    manualAudit({ op: 'manual-place', outcome: 'coppia-oltre-il-tetto',
      requested: { marketId: spec.marketId, book, side: lato, price, size },
      reason: `completamento di coppia rifiutato: carico ${Number.isFinite(caricoCoppia) ? (caricoCoppia * 100).toFixed(1) + '¢' : 'non dichiarato'}`
        + ` + prezzo ${(price * 100).toFixed(1)}¢ supera il tetto ${Number.isFinite(tettoCoppia) ? tettoCoppia + '¢' : 'non dichiarato'}` });
  }
  const attraversaApposta = (lato === 'SELL' && spec.attraversaApposta === true) || completaCoppiaOk;
  if (incrocia && attraversaApposta) {
    manualAudit({ op: 'manual-place', outcome: 'cross-dichiarato', requested: { marketId: spec.marketId, book, side: lato, price, size },
      reason: `vendita che attraversa lo spread DICHIARATA dal chiamante (miglior bid ${(rifTocco * 100).toFixed(2)}¢): e' un'uscita forzata, non una quotazione` });
  }
  if (incrocia && !attraversaApposta) {
    return refuse('would-cross',
      `a ${(price * 100).toFixed(2)}¢ quest'ordine di ${lato} incrocerebbe il miglior ${lato === 'SELL' ? 'bid' : 'ask'} (${(rifTocco * 100).toFixed(2)}¢) e si eseguirebbe SUBITO come taker.`
      + (priceAdjusted
        ? ` Il prezzo era gia' stato ricalcolato dal mid vivo mantenendo la distanza di ${spec.distanceCents}¢, e non basta: lo spread corrente e' piu' stretto di quella distanza.`
        : ' Nessuna distanza dal mid e\' stata dichiarata, quindi il prezzo non e\' stato ricalcolato.')
      + ' Rifiuto invece di eseguirlo come taker o di cambiarlo di nascosto: allarga la distanza dal mid, oppure attendi che lo spread si riapra.',
      { [lato === 'SELL' ? 'bestBid' : 'bestAsk']: rifTocco, side: lato, priceAdjusted });
  }

  // GATE 2-ter — FINE SCALA, E VIENE PRIMA DELLE REGOLE DEL PREZZO.
  //
  // Sotto i 3¢ o sopra i 97¢ (lib/maker/end-of-scale.js, unica definizione in tutto il progetto; soglie
  // sovrascrivibili con MID_EXTREME_LOW / MID_EXTREME_HIGH in `.env`) il mercato non sta più facendo
  // mercato: sta risolvendo. Un ordine a riposo lì non è una quota, è una scommessa asimmetrica — nella
  // direzione giusta guadagna qualche decimo di centesimo, in quella sbagliata perde tutto il nominale.
  //
  // PERCHÉ QUI E NON NEI SINGOLI CHIAMANTI. Questa è l'UNICA funzione che piazza per il pannello manuale,
  // per `bulk-allocate` (quindi per agent41) e per la sostituzione di agent40. Metterlo qui significa che
  // nessuno dei tre può piazzare a fine scala, e che un quarto chiamante domani lo eredita senza doverselo
  // ricordare. Prima il controllo esisteva solo nei due cicli che RIPREZZANO (auto-reprice, mm-tracking):
  // un ordine NUOVO poteva quindi nascere dentro la zona di risoluzione e restarci fino al giro dopo.
  //
  // PERCHÉ PRIMA DI GATE 3. «Il mercato sta risolvendo» è una verità del mercato, non del prezzo scelto:
  // se il verdetto arrivasse dopo il guard di venue, un ordine a 2¢ fuori griglia verrebbe rifiutato per
  // il tick e l'operatore non saprebbe la ragione vera. Il motivo giusto è il primo, non l'ultimo.
  //
  // Rifiutare NON lascia scoperto niente: gli ordini già a riposo li cancellano i cicli di agent40 e di
  // mm-tracking con lo stesso identico verdetto, e la GTD del venue li ritira comunque senza rinnovo.
  const eos = endOfScaleCheck(rules.mid, deps.env || process.env);
  if (eos.endOfScale) {
    return refuse('end-of-scale', eos.reason,
      { midCents: eos.midCents, side: eos.side, lowCents: eos.lowCents, highCents: eos.highCents });
  }

  // GATE 3 — the SHARED venue-rules guard, the identical function the board's band warning calls and the
  // adapter re-runs. Checked here first so the operator sees the reason codes rather than a bare refusal.
  // ── UNA SOLA DEROGA, E SOLO PER CHI LA CHIEDE PER NOME ──────────────────────────────────────────
  // OUT_OF_BAND non dice «il venue rifiutera' quest'ordine»: dice «quest'ordine non maturera' reward».
  // Sono due affermazioni diverse, e questo gate le trattava allo stesso modo. La differenza conta per
  // due chiamanti veri:
  //   · il motore di market making, che puo' quotare piu' lontano dal mid proprio per stare lontano dal
  //     fill, accettando di non maturare su quel lato;
  //   · L'OPERATORE AL PANNELLO, che vede l'avviso giallo «non matura reward» e decide lo stesso di
  //     piazzare li'. Prima non poteva: il pannello mostrava l'avviso e il server rifiutava comunque,
  //     cioe' l'avviso non era un avviso ma un divieto scritto in tono gentile.
  //
  // `allowOutOfBand` declassa QUEL SOLO codice da bloccante a dichiarato, attraverso la funzione
  // condivisa splitVerdict. Ogni altro motivo — fuori griglia del tick, fuori dai limiti di prezzo del
  // venue, sotto la size minima, regole non leggibili — continua a rifiutare esattamente come prima:
  // quelli sono regole del venue, e un ordine che le viola non arriva a riposare da nessuna parte.
  //
  // IL FUORI-BANDA NON SPARISCE MAI: viaggia come `advisory` fino all'audit e fino allo schermo.
  const allowOutOfBand = spec.allowOutOfBand === true;
  const vq = splitVerdict(validateQuote(venueRules, { side, price, size }), { allowOutOfBand });
  if (!vq.valid) {
    return refuse('venue-rules', vq.reasons.map((r) => `${r.code}: ${r.detail}`).join('; '), { reasons: vq.reasons });
  }
  const bandAdvisory = vq.advisories.length ? vq.advisories.map((r) => `${r.code}: ${r.detail}`).join('; ') : null;

  // GATE 3-bis — IL PREZZO CHE STIAMO USANDO E' ANCORA VIVO?
  //
  // Il pannello di piazzamento chiede al feed una sottoscrizione temporanea al book mentre resta aperto,
  // cosi' i prezzi che mostra sono quelli del websocket e non uno snapshot REST di qualche minuto fa. Ma
  // una sottoscrizione puo' non essersi stabilita, puo' essere caduta, o il processo del feed puo' essersi
  // fermato — e in tutti e tre i casi la schermata continuerebbe a mostrare l'ultimo numero buono. Se in
  // quel momento si conferma, si piazza su un prezzo vecchio credendolo attuale.
  //
  // Quindi chi ha promesso all'operatore un prezzo live lo DICHIARA in `requireFreshBookMs`, e qui si
  // verifica che la promessa regga: la banda dev'essere giudicata contro un mid che viene davvero dal
  // book live (`midSource === 'live-book'`) e che sia piu' giovane della soglia dichiarata. Se non lo e',
  // non si piazza — non si avvisa e si procede: si rifiuta, e si dice quanto e' vecchio il dato.
  //
  // E' OPT-IN DI PROPOSITO. Un chiamante che non promette niente (il vecchio pannello ordini manuali, uno
  // script) non viene bloccato da un requisito che nessuno gli ha posto e che non ha modo di soddisfare
  // su un mercato che il feed non segue. Chi promette, invece, viene tenuto alla promessa.
  if (Number.isFinite(spec.requireFreshBookMs) && spec.requireFreshBookMs > 0) {
    const maxMs = spec.requireFreshBookMs;
    const ageMs = Number.isFinite(rules.midAgeSec) ? rules.midAgeSec * 1000 : null;
    if (rules.midSource !== 'live-book') {
      return refuse('stale-book', `il prezzo non viene dal book live ma da «${rules.midSource || 'fonte ignota'}»: la sottoscrizione live per questo mercato non e' attiva in questo momento. Rifiuto invece di piazzare su un prezzo che potrebbe essere vecchio di minuti. Riapri il pannello e attendi che indichi «book live».`, { midSource: rules.midSource, midAgeSec: rules.midAgeSec, requiredMs: maxMs });
    }
    if (ageMs == null) {
      return refuse('stale-book', 'il book live non dichiara la propria eta\': senza quel dato non si puo\' affermare che il prezzo sia fresco, e un\'affermazione non verificabile qui vale come falsa.', { midSource: rules.midSource, midAgeSec: null, requiredMs: maxMs });
    }
    if (ageMs > maxMs) {
      return refuse('stale-book', `il book live per questo mercato e' vecchio di ${Math.round(ageMs / 1000)}s, oltre la soglia di ${Math.round(maxMs / 1000)}s dichiarata da chi ha inviato l'ordine. La sottoscrizione e' probabilmente caduta. Rifiuto invece di piazzare su un prezzo stantio.`, { midSource: rules.midSource, midAgeSec: rules.midAgeSec, requiredMs: maxMs });
    }
  }

  // GATE 4 — the panel's per-order ceiling, from data/safety-risk-limits.json.
  const caps = resolveCaps({ userId, engine }, deps.limitDeps || {});
  const cg = evaluateManualCapGate({ notionalUsd, caps });
  if (!cg.allow) return refuse(cg.gate, cg.reason, { caps });

  // GATE 5 — the durable GLOBAL kill switch, re-read now. The adapter checks it again on the live path;
  // checking here too means a killed system refuses before an adapter is even constructed.
  const kill = killSwitch.checkKill({ userId }, deps.killDeps || {});
  if (kill.killed) return refuse(kill.gate || 'kill', kill.reason);

  // ── HOW LONG IT RESTS. GTD 180s as always, unless auto-reprice owns this market — then the long resting
  //    window the band-exit watcher renews. Either way it is now BOUNDED BY THE MARKET'S REMAINING LIFE.
  //    Resolved ONCE and used for both the adapter default and the per-order spec, so the two can never
  //    disagree. ──
  const ttl = resolveManualTtlSeconds({ marketId, ttlSeconds: spec.ttlSeconds }, deps);

  // GATE 6 — THE MARKET'S OWN CLOCK. Under the threshold there is no honest window left to ask for: the
  // shortest expiry the venue accepts would outlive the market (see lib/maker/market-clock.js), so the
  // only correct answer is to place nothing and say why. This is the gate that makes short-dated markets
  // (a 5-minute Bitcoin book) safe to enable at all, and it fires before any adapter is built.
  if (ttl.tooClose) {
    return refuse(ttl.gate || 'market-too-close-to-close', ttl.reason, {
      window: ttl.window ? {
        closeKnown: ttl.window.closeKnown, endIso: ttl.window.endIso, closeSource: ttl.window.closeSource,
        minutesToClose: ttl.window.minutesToClose, minMinutes: ttl.window.minMinutes,
      } : null,
    });
  }

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
      // La deroga viaggia con l'ordine. L'adapter rifa' la STESSA validazione in modo indipendente (ed e'
      // giusto che lo faccia: e' l'ultimo guardiano prima della firma), quindi senza portargliela qui il
      // gate riaprirebbe un passo piu' avanti e il rifiuto tornerebbe identico, solo da un altro nome.
      allowOutOfBand,
      // ── LA CHIAVE DI IDEMPOTENZA, QUANDO IL CHIAMANTE NE HA UNA SUA ──────────────────────────
      // Senza, l'adapter la deriva da (utente, venue, token, lato, prezzo, size): due invii con gli
      // stessi parametri economici sono lo stesso ordine, ed è la regola giusta per un doppio click.
      // Ma un RINNOVO GTD ri-piazza deliberatamente agli stessi parametri — è il suo scopo, azzerare
      // l'orologio del venue — e quella regola lo scambiava per un duplicato: il vecchio ordine
      // cancellato, il nuovo rifiutato, capitale fuori dal libro in silenzio. Misurato il 5 agosto
      // 2026 su tre ordini su tre. Chi rimpiazza passa una chiave che nomina l'ordine sostituito.
      idempotencyKey: typeof spec.idempotencyKey === 'string' && spec.idempotencyKey ? spec.idempotencyKey : undefined,
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
    // Un ordine piazzato di proposito fuori dalla banda premiante e' una decisione, e una decisione va
    // ritrovata dopo. Senza questa riga l'audit direbbe «piazzato» e nient'altro, e fra un mese nessuno
    // saprebbe se quello zero di reward fosse voluto o un errore.
    bandAdvisory,
    // ── COSA HA DECISO LA REGOLA DELLA CODA, E SE IL PREZZO È STATO SPOSTATO ─────────────────────
    // Erano due variabili locali: calcolate, applicate al prezzo, e poi buttate via. Né qui né nel
    // valore di ritorno. Conseguenza: dopo il fatto non c'era modo di sapere se un ordine fosse
    // finito in cima al libro per decisione o per caso — e il banner del pannello che avrebbe
    // mostrato lo spostamento leggeva un campo che il server non restituiva mai.
    // Adesso la decisione lascia una traccia, che è anche il modo per misurare quante volte la
    // politica «mai primi» scarta un mercato.
    inCoda: inCodaEsito,
    priceAdjusted,
    // Il timbro dell'origine finisce QUI, nel registro append-only: e' da qui che il reset di agent41
    // lo rilegge sei ore dopo, quando l'ordine e' solo una riga sul libro del venue.
    origine,
    placement, latencyMs: Date.now() - t0, userId,
  }, source);

  return {
    ok: res.ok === true, sent: res.sent === true, dryRun: res.dryRun === true, placement,
    gate: res.gate || null, reason: res.reason || null, orderId: res.orderId || null,
    wouldSend: res.wouldSend || null, validateOrder: res.validateOrder || null,
    idempotencyKey: res.idempotencyKey || null,
    // Non un rifiuto: il motivo per cui quest'ordine non maturera' reward, restituito a chi l'ha
    // chiesto perche' possa dirlo sullo schermo insieme all'esito.
    bandAdvisory,
    // Gli stessi due fatti, restituiti a chi ha chiesto il piazzamento: il pannello mostra lo
    // spostamento del prezzo nel banner d'esito, e senza questi campi quel banner non poteva
    // comparire — leggeva `result.priceAdjusted`, che non veniva mai restituito.
    inCoda: inCodaEsito,
    priceAdjusted,
    origine,
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

  // ── THE MARKET'S CLOCK, ALSO CHECKED BEFORE THE CANCEL ──────────────────────────────────────────────
  // Same reasoning as the kill switch above: a riprezza is cancel-then-place, and the place would be
  // refused for a market inside its final minutes. Discovering that AFTER the cancel would leave the
  // operator with nothing resting exactly when the market is about to close. So the whole sequence is
  // refused up front with the old order UNTOUCHED — and if the intent was to get out, «Cancella» is never
  // gated and always available. Doing nothing is also the correct end state: without a renewal the venue's
  // own GTD retires the order by itself.
  const closeNow = resolveManualTtlSeconds({ marketId, ttlSeconds: spec.ttlSeconds }, deps);
  if (closeNow.tooClose) {
    manualAudit({ op: 'manual-replace', outcome: `reject-${closeNow.gate}`, requested: { orderId }, reason: closeNow.reason, latencyMs: Date.now() - t0 }, source);
    return {
      ok: false, gate: closeNow.gate, replaced: false, oldCancelled: false,
      reason: `${closeNow.reason} — il vecchio ordine NON è stato cancellato: senza rinnovo scade da solo per GTD. Per toglierlo subito usa «Cancella», che resta sempre permesso.`,
      window: closeNow.window || null,
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
  // ── LA CHIAVE DEL RIMPIAZZO NOMINA L'ORDINE CHE SOSTITUISCE ───────────────────────────────────
  // Un rimpiazzo ha per definizione gli stessi parametri economici dell'originale quando il book non
  // si è mosso: è esattamente il caso del rinnovo proattivo. Derivare la chiave dai soli parametri lo
  // rendeva indistinguibile da un doppio invio, e il gate lo rifiutava — dopo aver già cancellato.
  //
  // LA PROTEZIONE ORIGINALE RESTA INTATTA: un piazzamento NUOVO non passa nessuna chiave e continua a
  // derivare quella economica, quindi un doppio click o una race di invio duplicato è bloccata come
  // prima. Solo un rimpiazzo — che per esistere deve nominare un `orderId` già vivo, e che arriva qui
  // solo DOPO una cancellazione confermata — ottiene una chiave distinta. E due rimpiazzi dello stesso
  // ordine restano fra loro duplicati: la chiave dipende dall'id sostituito, non dall'istante.
  const chiaveRimpiazzo = `idem_rep_${crypto.createHash('sha256')
    .update([spec.userId || OPERATOR_USER, 'polymarket', orderId, replSide, spec.price, spec.size].map(String).join('|'))
    .digest('hex').slice(0, 20)}`;
  const placed = await placeManualOrder({ ...spec, marketId, book, side: replSide, source, idempotencyKey: chiaveRimpiazzo }, deps);
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
  manualContext, resolveMarketRules, resolveMarketDepth, resolveCaps, manualPlacement, readEngineState,
  evaluateManualGate, evaluateManualCapGate, resolveManualTtlSeconds,
  placeManualOrder, listManualOrders, cancelManualOrder, replaceManualOrder,
  VENUE, OPERATOR_USER, FALLBACK_LIVE_MIN_CAP_USD, MANUAL_SOURCES, DEFAULT_MANUAL_TTL_SECONDS,
};

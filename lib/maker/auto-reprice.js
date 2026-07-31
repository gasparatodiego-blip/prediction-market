'use strict';
// lib/maker/auto-reprice.js — AUTOMATIC BAND-EXIT RE-PRICING for hand-placed orders.
//
// THE CHANGE THIS IMPLEMENTS. A manual order used to carry a fixed ~180s GTD expiry: the venue killed it
// on a clock, whatever the price was doing. That is backwards for a reward maker — what matters is not
// how long the order has rested but whether it is still inside the band that pays. So, for a market whose
// auto-reprice switch is ON, a hand order now rests as GTC (no venue expiry at all — the venue supports
// it, see lib/maker/order-ttl.js for the primary-source proof) and THIS is what moves it: a periodic
// check that re-prices ONLY when the mid has travelled far enough to push the order out of the band.
// If the mid does not move enough, the order is NOT TOUCHED — no cancel, no replace, no churn.
//
// IT ADDS NO AUTHORITY. Every belt that governs a hand order governs this one, because it does not
// re-implement placement: it calls lib/maker/manual-order.replaceManualOrder, the SAME function the
// panel's "Riprezza" button calls, which runs manual-ownership → venue-rules → caps → kill →
// the adapter's own chain → the exchange's validateOrder(). What this module adds is SUBTRACTIVE:
//
//   1. IT ONLY ACTS WHERE IT IS SWITCHED ON. Global master switch AND per-market opt-in, both durable,
//      both default OFF, both fail-closed to OFF (lib/maker/auto-reprice-config.js).
//   2. IT ONLY TOUCHES THE PANEL'S OWN ORDERS. An order it cannot POSITIVELY attribute to the manual
//      panel (by idempotency key / order id in the append-only audit trail) is left alone. agent35's
//      orders and unattributable orders are never candidates — not "probably ours", PROVABLY ours.
//   3. IT REFUSES TO ACT ON A MID IT DOES NOT TRUST. The mid must come from agent34's LIVE book and be
//      fresh. A stale mid is how an automatism walks an order somewhere nobody asked for, so an unfresh
//      or board-row mid produces a SKIP, never a re-price.
//   4. IT CHECKS THE KILL SWITCH BEFORE IT CANCELS ANYTHING. A re-price is a cancel followed by a place;
//      if the place would be refused, cancelling first would leave the operator with nothing resting for
//      no reason. So kill is read up front and a killed system does nothing at all.
//   5. IT HAS ITS OWN RAILS: confirm-samples, hysteresis, a per-order rate limit and a per-market hourly
//      ceiling. An automatism without a runaway guard is not a feature, it is an incident waiting.
//   6. IT VALIDATES THE REPLACEMENT BEFORE PROPOSING IT. If the new price would not itself pass the
//      shared guard, it does nothing — it never cancels an order it cannot validly replace.
//
// EVERYTHING IT DOES IS STAMPED source:'auto-reprice-band-exit' in the one append-only maker trail —
// distinct from 'manual-ui' (a human pressed a button) and from 'agent35' (the automatic engine), so the
// trail always answers "what moved this order" without anyone having to infer it.
//
// The DECISION is pure (decideReprice) so the selfcheck can exhaust it with no venue, no files and no
// clock. The CYCLE (runAutoRepriceCycle) takes every side effect as an injected dependency for the same
// reason — the simulated tests drive a whole scenario without a single network call.

const { validateQuote, inBandPriceBounds } = require('./venue-rules');
const { inBand } = require('../rewards-live-band');
const {
  isAutoRepriceEnabled, readAutoRepriceConfig, readAutoRepriceState, recordAutoRepriceState,
  loadAutoRepriceTuning, AUTO_REPRICE_SOURCE,
} = require('./auto-reprice-config');

// ── THE PURE DECISION ────────────────────────────────────────────────────────────────────────────────

/**
 * Decide what to do with ONE resting order, given the market's CURRENT live rules.
 *
 * Returns one of three actions, and NAMES ITS REASON in every case (there is never a silent no-op):
 *   'hold'    — the order is still inside the band. DO NOT TOUCH IT. This is the answer the whole
 *               feature exists to produce: a resting order that the mid has not invalidated is left
 *               exactly where it is, for as long as that stays true. No clock can change this answer.
 *   'reprice' — the mid has moved enough that the order is out of the band by more than the hysteresis,
 *               the breach has been confirmed on consecutive samples, and the rails allow acting.
 *               `targetPrice` is the price to move to, already proven valid by the shared guard.
 *   'skip'    — something is not trustworthy or not permitted right now (stale mid, unreadable rules,
 *               rate limit, hourly ceiling, a replacement that would not itself qualify). SKIP LEAVES
 *               THE ORDER ALONE too — it differs from 'hold' only in WHY, and the why is reported.
 *
 * @param {object} args
 *   order   { orderId, price, size, book:'yes'|'no' }  — size is the size the replacement will carry
 *   rules   the resolveMarketRules() shape: { readable, mid, tick, maxSpreadCents, minSize, midSource,
 *           midAgeSec, feedLive, books:{ yes:{scoringMid}, no:{scoringMid} } }
 *   config  loadAutoRepriceTuning() shape
 *   lastRepriceAt      epoch ms of the last automatic re-price ON THIS MARKET, or null. Market-keyed,
 *                      not order-keyed: a re-price mints a new order id, so an id-keyed limit would
 *                      never bind on the replacement.
 *   consecutiveBreaches how many consecutive prior cycles have already seen this order out of band
 *   repricesThisHour   how many automatic re-prices this MARKET has had in the rolling hour
 *   now     epoch ms
 * @returns {{action:'hold'|'reprice'|'skip', gate:(string|null), reason:string,
 *            targetPrice:(number|null), distanceC:(number|null), bandRadiusC:(number|null),
 *            scoringMid:(number|null), breachConfirmed:boolean}}
 */
function decideReprice({ order, rules, config, lastRepriceAt = null, consecutiveBreaches = 0, repricesThisHour = 0, now = Date.now() } = {}) {
  const cfg = config || loadAutoRepriceTuning();
  const out = (action, gate, reason, extra = {}) => ({
    action, gate, reason,
    targetPrice: null, distanceC: null, bandRadiusC: null, scoringMid: null, breachConfirmed: false,
    ...extra,
  });

  const o = order || {};
  const price = Number(o.price);
  const size = Number(o.size);
  const book = o.book === 'no' ? 'no' : 'yes';

  if (!Number.isFinite(price) || !Number.isFinite(size) || !(price > 0) || !(size > 0)) {
    return out('skip', 'order-unreadable', 'the resting order has no usable price/size — refusing to judge it (a check that could not run is not a check that passed)');
  }

  // ── GATE: the market's rules must be readable at all. Fail closed, exactly as placement does. ──
  if (!rules || rules.readable !== true) {
    const missing = rules && Array.isArray(rules.missing) ? rules.missing.join(', ') : 'unknown';
    return out('skip', 'rules-unreadable', `venue rules not readable (missing: ${missing}) — no band to judge against, so nothing is touched`);
  }

  // ── GATE: THE MID MUST BE ONE WE TRUST. ──
  // This is the single most important refusal in the module. Re-pricing is driven ENTIRELY by the mid;
  // acting on a stale or second-hand mid means moving a real order on the strength of a number that no
  // longer describes the book. Both conditions fail CLOSED (skip), never "probably fine".
  if (cfg.requireLiveBook && rules.midSource !== 'live-book') {
    return out('skip', 'mid-not-live', `the mid comes from ${rules.midSource || 'an unknown source'}, not agent34's live book — refusing to move a real order on a second-hand mid`);
  }
  if (Number.isFinite(cfg.maxMidAgeSec) && Number.isFinite(rules.midAgeSec) && rules.midAgeSec > cfg.maxMidAgeSec) {
    return out('skip', 'mid-stale', `the mid is ${rules.midAgeSec}s old (limit ${cfg.maxMidAgeSec}s) — refusing to move a real order against a stale mid`);
  }
  if (!Number.isFinite(rules.midAgeSec) && cfg.requireLiveBook) {
    return out('skip', 'mid-age-unknown', 'the age of the mid could not be read — refusing (an age we cannot read is not an age within limits)');
  }

  // Each side is judged in ITS OWN book's space: a NO order at q IS a YES order at 1−q. Same mirror the
  // engine and the placement path use — never a second interpretation of it.
  const scoringMid = book === 'no' ? (rules.books && rules.books.no ? rules.books.no.scoringMid : null) : (rules.books && rules.books.yes ? rules.books.yes.scoringMid : null);
  const tick = rules.tick;
  const maxSpreadCents = rules.maxSpreadCents;
  if (!Number.isFinite(scoringMid) || !(tick > 0) || !(maxSpreadCents > 0)) {
    return out('skip', 'band-unreadable', 'scoring mid / tick / band could not be read for this side — nothing is touched (never a guessed band)');
  }

  const bandRadiusC = maxSpreadCents / 2;
  const distanceC = Math.abs(price - scoringMid) * 100;
  const base = { scoringMid, distanceC: +distanceC.toFixed(4), bandRadiusC: +bandRadiusC.toFixed(4) };

  // ── THE ACTUAL QUESTION: is the order still in the band? Uses the SSOT (rewards-live-band.inBand),
  //    the same predicate validateQuote's OUT_OF_BAND check calls. No parallel band math anywhere. ──
  if (inBand(price, scoringMid, maxSpreadCents)) {
    return out('hold', null,
      `in band: |${price} − ${scoringMid.toFixed(6)}| = ${distanceC.toFixed(2)}¢ ≤ ±${bandRadiusC.toFixed(2)}¢ — the order is NOT touched`,
      base);
  }

  // ── HYSTERESIS. Out of band, but only just? An order sitting a hair past the edge would otherwise flap
  //    in and out on rounding alone, and every flap is a cancel+place with a real out-of-book window. ──
  const hysteresisC = (Number.isFinite(cfg.hysteresisTicks) ? cfg.hysteresisTicks : 0) * tick * 100;
  if (distanceC <= bandRadiusC + hysteresisC + 1e-9) {
    return out('hold', 'hysteresis',
      `out of band by ${(distanceC - bandRadiusC).toFixed(3)}¢ but within the ${hysteresisC.toFixed(3)}¢ hysteresis (${cfg.hysteresisTicks} tick) — left alone rather than flapping at the edge`,
      base);
  }

  // ── CONFIRMATION. One sample is not a signal. The breach must survive consecutive observations. ──
  const needed = Number.isFinite(cfg.confirmSamples) ? cfg.confirmSamples : 1;
  const seen = consecutiveBreaches + 1; // this cycle's observation included
  if (seen < needed) {
    return out('skip', 'awaiting-confirmation',
      `out of band by ${distanceC.toFixed(2)}¢ (band ±${bandRadiusC.toFixed(2)}¢), observation ${seen}/${needed} — waiting for confirmation before moving a real order`,
      { ...base, breachConfirmed: false });
  }

  // ── RAILS. Both of these leave the order alone; they bound how often the automatism may act. ──
  if (lastRepriceAt != null && Number.isFinite(cfg.minIntervalMs) && (now - lastRepriceAt) < cfg.minIntervalMs) {
    return out('skip', 'rate-limited',
      `this leg was automatically re-priced ${Math.round((now - lastRepriceAt) / 1000)}s ago (minimum interval ${Math.round(cfg.minIntervalMs / 1000)}s) — not touched again yet`,
      { ...base, breachConfirmed: true });
  }
  if (Number.isFinite(cfg.maxPerHour) && repricesThisHour >= cfg.maxPerHour) {
    return out('skip', 'hourly-cap',
      `this market has already had ${repricesThisHour} automatic re-prices in the last hour (ceiling ${cfg.maxPerHour}) — the runaway guard stops here; re-price by hand if this is genuinely wanted`,
      { ...base, breachConfirmed: true });
  }

  // ── WHERE TO MOVE IT. The bounds come from lib/maker/venue-rules.inBandPriceBounds, which derives them
  //    by ASKING validateQuote — so a target can never be looser than the guard that will re-check it. ──
  const bounds = inBandPriceBounds({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize });
  if (!bounds.readable || bounds.lo == null || bounds.hi == null) {
    return out('skip', 'no-valid-target',
      'no qualifying price could be derived for the current band (band narrower than one tick, or unreadable) — nothing is touched rather than inventing a price',
      { ...base, breachConfirmed: true });
  }

  let targetPrice;
  if (cfg.strategy === 'nearest-mid') {
    // The qualifying price closest to the mid: snap the mid to the grid, then clamp into [lo, hi].
    const snapped = +(Math.round(scoringMid / tick) * tick).toFixed(10);
    targetPrice = Math.min(bounds.hi, Math.max(bounds.lo, snapped));
  } else {
    // 'band-edge' (default): the nearest qualifying price to where the order ALREADY sat — i.e. the band
    // edge on the same side of the mid. Minimum movement, original stance preserved.
    targetPrice = price > scoringMid ? bounds.hi : bounds.lo;
  }
  targetPrice = +Number(targetPrice).toFixed(10);

  // ── FINAL SELF-CHECK. Run the SHARED guard on the exact replacement we are about to propose. If it
  //    would not qualify, we do NOTHING: cancelling an order we cannot validly replace is strictly worse
  //    than leaving an out-of-band order resting, because it earns nothing either way but costs the size. ──
  const vq = validateQuote({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize }, { side: 'BUY', price: targetPrice, size });
  if (!vq.valid) {
    return out('skip', 'replacement-invalid',
      `the proposed replacement at ${targetPrice} would not pass the shared guard (${vq.reasons.map((r) => r.code).join(',')}) — the resting order is left untouched rather than cancelled for nothing`,
      { ...base, breachConfirmed: true, targetPrice });
  }

  if (Math.abs(targetPrice - price) < tick / 1000) {
    // Cannot happen for a genuine breach, but if the target equals the current price there is nothing to
    // do and a cancel+place would be pure loss (an out-of-book window for an identical order).
    return out('hold', 'target-unchanged',
      `the computed target ${targetPrice} equals the current price — nothing to move`,
      { ...base, targetPrice });
  }

  return out('reprice', null,
    `band exit: |${price} − ${scoringMid.toFixed(6)}| = ${distanceC.toFixed(2)}¢ > ±${bandRadiusC.toFixed(2)}¢ + ${hysteresisC.toFixed(3)}¢ hysteresis, confirmed on ${seen} consecutive observations → move to ${targetPrice} (${cfg.strategy})`,
    { ...base, breachConfirmed: true, targetPrice });
}

// ── THE CYCLE ────────────────────────────────────────────────────────────────────────────────────────
// One pass over every market the operator has opted in. Every side effect is an injected dependency, so
// the whole thing runs in a test with no venue, no files and a fake clock.

/**
 * Which of these resting orders may the automatism touch?
 *
 * ONLY the ones the manual panel PROVABLY placed. `attributeOrder`'s 'unknown' (the panel has never
 * placed anything, so there is no evidence either way) and 'agent35' are both excluded — an automatism
 * that moves an order it merely believes is ours is how the engine's quotes get trampled.
 */
function selectOwnedOrders(orders, { marketId, rules }) {
  const list = Array.isArray(orders) ? orders : [];
  const wantMarket = typeof marketId === 'string' ? marketId.trim().toLowerCase() : '';
  const yesToken = rules && rules.tokenId ? String(rules.tokenId) : null;
  const noToken = rules && rules.tokenIdNo ? String(rules.tokenIdNo) : null;
  const out = [];
  for (const o of list) {
    if (!o || !o.orderId) continue;
    // Positive attribution only. 'manual-ui' covers both the hand-placed original and every automatic
    // re-price of it (the audit trail records the panel core's idempotency keys under either source).
    if (o.source !== 'manual-ui') continue;
    // BUY only: the panel places BUYs on the chosen book, and a SELL would need inventory this path does
    // not measure. Anything else is left alone rather than re-priced under an assumption.
    if (o.side && String(o.side).toUpperCase() !== 'BUY') continue;
    if (wantMarket && o.marketId && String(o.marketId).trim().toLowerCase() !== wantMarket) continue;
    // WHICH BOOK. Resolved by matching the order's token against the market's two token ids — never
    // guessed. An order whose token matches neither is skipped: we cannot mirror its band correctly.
    const tok = o.tokenId ? String(o.tokenId) : null;
    const book = tok && yesToken && tok === yesToken ? 'yes' : (tok && noToken && tok === noToken ? 'no' : null);
    if (!book) continue;
    const size = Number.isFinite(o.sizeRemaining) && o.sizeRemaining > 0 ? o.sizeRemaining : Number(o.size);
    out.push({ orderId: o.orderId, price: Number(o.price), size, book, tokenId: tok, marketId: o.marketId, status: o.status });
  }
  return out;
}

/**
 * Run ONE watcher pass.
 *
 * @param {object} deps  every side effect, injected:
 *   killStatus()                      → { effectivelyKilled, readable, ... }   (lib/safety/kill-switch)
 *   isManual(marketId)                → { manual, readable }                    (lib/maker/manual-mode)
 *   listOrders({marketId})            → { ok, simulated, orders }               (manual-order.listManualOrders)
 *   resolveRules(marketId)            → resolveMarketRules() shape
 *   replaceOrder(spec)                → replaceManualOrder() shape
 *   audit(rec)                        → append one line to the maker trail
 *   config                            → loadAutoRepriceTuning() shape
 *   configDeps                        → deps forwarded to the auto-reprice config/state store (tests)
 *   breaches                          → Map<orderId, count> carried BETWEEN cycles by the caller
 *   now()                             → epoch ms
 * @returns {{at:string, ran:boolean, gate:(string|null), reason:(string|null), markets:Array, actions:Array}}
 */
async function runAutoRepriceCycle(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const t0 = now();
  const config = deps.config || loadAutoRepriceTuning();
  const configDeps = deps.configDeps || {};
  const breaches = deps.breaches instanceof Map ? deps.breaches : new Map();
  const audit = typeof deps.audit === 'function' ? deps.audit : () => {};
  const actions = [];
  const result = (gate, reason, extra = {}) => ({
    at: new Date(t0).toISOString(), ran: gate == null, gate, reason, markets: [], actions, ...extra,
  });

  // ── GATE 0 — the master switch. Off or unreadable ⇒ the automatism does nothing, and says which. ──
  const cfgState = readAutoRepriceConfig(configDeps);
  if (!cfgState.readable) {
    return result('config-unreadable', `auto-reprice config ${cfgState.error} — doing nothing (fail closed)`);
  }
  if (!cfgState.globalEnabled) {
    return result('disabled-global', 'auto-reprice is off globally — no market is watched');
  }
  if (cfgState.enabledMarketIds.length === 0) {
    return result('no-markets', 'auto-reprice is on globally but no market is opted in');
  }

  // ── GATE 1 — THE GLOBAL KILL SWITCH, read BEFORE anything is cancelled. ──
  // A re-price is cancel-then-place. Under a kill the place would be refused, so cancelling first would
  // strip the operator's resting order for nothing. Reading kill here means a killed system never starts
  // the sequence at all. (replaceManualOrder now refuses under kill for the same reason — this is the
  // belt in front of that brace.)
  const kill = typeof deps.killStatus === 'function' ? deps.killStatus() : { effectivelyKilled: false, readable: true };
  if (kill.effectivelyKilled === true || kill.readable === false) {
    return result('kill', kill.readable === false
      ? 'kill-switch state is UNREADABLE — treated as active (fail closed); the automatism does nothing'
      : 'the global kill switch is ACTIVE — the automatism does nothing (cancelling now would leave nothing resting, since a replacement could not be placed)');
  }

  const markets = [];
  for (const marketId of cfgState.enabledMarketIds) {
    const m = { marketId, gate: null, reason: null, considered: 0, held: 0, skipped: 0, repriced: 0 };

    // ── GATE 2 — MANUAL OWNERSHIP. Same precondition as a hand order: the automatism may only act where
    //    agent35 is provably standing off. A market handed back to the engine is dropped immediately. ──
    const mm = typeof deps.isManual === 'function' ? deps.isManual(marketId) : { manual: true, readable: true };
    if (!mm.readable) { m.gate = 'manual-mode-unreadable'; m.reason = 'market ownership is unreadable — skipping (fail closed)'; markets.push(m); continue; }
    if (!mm.manual) { m.gate = 'manual-mode-inactive'; m.reason = 'this market is no longer in manual mode — agent35 owns it again, so the automatism stands off'; markets.push(m); continue; }

    const rules = typeof deps.resolveRules === 'function' ? deps.resolveRules(marketId) : null;
    if (!rules || rules.readable !== true) {
      m.gate = 'rules-unreadable';
      m.reason = `venue rules not readable (missing: ${rules && Array.isArray(rules.missing) ? rules.missing.join(', ') : 'unknown'}) — skipping this market`;
      markets.push(m); continue;
    }

    // ── VENUE TRUTH, not local belief. The resting orders are read from the venue every cycle. ──
    let listed;
    try { listed = await deps.listOrders({ marketId }); }
    catch (e) { m.gate = 'list-failed'; m.reason = `could not read resting orders from the venue: ${e.message} — skipping (an unread book is not an empty book)`; markets.push(m); continue; }
    if (!listed || listed.ok === false) {
      m.gate = 'list-failed';
      m.reason = `venue read FAILED (${(listed && listed.error) || 'unknown'}) — skipping; we do not know what is resting, and that is not the same as nothing resting`;
      markets.push(m); continue;
    }
    if (listed.simulated === true) {
      m.gate = 'simulated';
      m.reason = 'no venue credentials — the venue was not queried, so there is nothing to act on (this is "we did not read", not "you have no orders")';
      markets.push(m); continue;
    }

    const owned = selectOwnedOrders(listed.orders, { marketId, rules });
    m.considered = owned.length;
    const state = readAutoRepriceState(configDeps);
    const marketState = state.markets[String(marketId).toLowerCase()] || {};
    const repricesThisHour = Array.isArray(marketState.recentAt)
      ? marketState.recentAt.filter((t) => Number.isFinite(t) && t0 - t < 3_600_000).length
      : 0;

    for (const order of owned) {
      const prevBreaches = breaches.get(order.orderId) || 0;
      // THE RATE LIMIT IS PER MARKET, NOT PER ORDER ID — and that is deliberate. A re-price produces a
      // NEW order id, so an id-keyed limit would never bind on the replacement: the automatism could
      // re-price the thing it had just placed, immediately, forever. Keying on the market means "this
      // leg was moved N seconds ago" survives the id change, which is what the limit is actually about.
      const lastAt = Number.isFinite(marketState.lastRepriceAt) ? marketState.lastRepriceAt : null;

      const d = decideReprice({ order, rules, config, lastRepriceAt: lastAt, consecutiveBreaches: prevBreaches, repricesThisHour, now: t0 });

      // Carry the breach counter between cycles: a breach that clears resets it, so "consecutive" really
      // means consecutive rather than cumulative.
      if (d.action === 'hold') breaches.delete(order.orderId);
      else breaches.set(order.orderId, prevBreaches + 1);

      if (d.action === 'hold') { m.held++; continue; }
      if (d.action === 'skip') {
        m.skipped++;
        actions.push({ marketId, orderId: order.orderId, action: 'skip', gate: d.gate, reason: d.reason, price: order.price, targetPrice: d.targetPrice, distanceC: d.distanceC, bandRadiusC: d.bandRadiusC });
        // Only the interesting skips reach the durable trail; 'awaiting-confirmation' fires every few
        // seconds by design and would drown the log without telling anyone anything new.
        if (d.gate !== 'awaiting-confirmation') {
          audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: `skip-${d.gate}`, marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId, gate: d.gate, reason: d.reason, observed: { price: order.price, scoringMid: d.scoringMid, distanceC: d.distanceC, bandRadiusC: d.bandRadiusC } });
        }
        continue;
      }

      // ── ACT. Through the SAME server-side sequence the panel's own button uses, with every gate. ──
      audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'trigger',
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId, reason: d.reason,
        observed: { price: order.price, scoringMid: d.scoringMid, distanceC: d.distanceC, bandRadiusC: d.bandRadiusC, strategy: config.strategy },
        requested: { book: order.book, fromPrice: order.price, toPrice: d.targetPrice, size: order.size } });

      let res;
      try {
        res = await deps.replaceOrder({
          orderId: order.orderId, marketId, book: order.book,
          price: d.targetPrice, size: order.size,
          // The replacement rests the same way the original did: no clock, only the band. Explicit rather
          // than inherited, so this call cannot silently pick up a GTD default from somewhere else.
          ttlSeconds: 0,
          source: AUTO_REPRICE_SOURCE,
          note: `auto: band exit ${d.distanceC}¢ > ±${d.bandRadiusC}¢`,
        });
      } catch (e) {
        m.skipped++;
        actions.push({ marketId, orderId: order.orderId, action: 'error', reason: e.message });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'error', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId, reason: e.message });
        continue;
      }

      const ok = res && res.ok === true;
      if (ok) m.repriced++; else m.skipped++;
      actions.push({
        marketId, orderId: order.orderId, action: 'reprice', ok,
        fromPrice: order.price, toPrice: d.targetPrice, size: order.size, book: order.book,
        sent: !!(res && res.place && res.place.sent), oldCancelled: !!(res && res.oldCancelled),
        gate: (res && res.gate) || null, reason: (res && res.reason) || null,
        newOrderId: (res && res.place && res.place.orderId) || null,
      });
      audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
        outcome: ok ? ((res.place && res.place.sent) ? 'sent' : 'dry-run-validated') : `reject-${(res && res.gate) || 'replace'}`,
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId,
        requested: { book: order.book, fromPrice: order.price, toPrice: d.targetPrice, size: order.size },
        response: { ok, oldCancelled: !!(res && res.oldCancelled), replaced: !!(res && res.replaced), newOrderId: (res && res.place && res.place.orderId) || null },
        gate: (res && res.gate) || null, reason: (res && res.reason) || null, latencyMs: now() - t0 });

      // The breach counter resets on ANY completed attempt: the next cycle re-observes the world rather
      // than acting on a stale count. And the rails are fed whether or not the venue accepted it —
      // a rejected attempt still consumed a cancel, so it must count against the hourly ceiling.
      breaches.delete(order.orderId);
      recordAutoRepriceState({
        marketId,
        reprice: { orderId: order.orderId, fromPrice: order.price, toPrice: d.targetPrice, ok, sent: !!(res && res.place && res.place.sent), gate: (res && res.gate) || null, reason: (res && res.reason) || null },
        heartbeat: false,
      }, configDeps);
    }
    markets.push(m);
  }

  // Heartbeat LAST, and only on a pass that actually ran: it is what the panel reads to answer "is the
  // thing that is supposed to be minding my GTC orders alive?"
  recordAutoRepriceState({ heartbeat: true }, configDeps);

  return { at: new Date(t0).toISOString(), ran: true, gate: null, reason: null, markets, actions, latencyMs: now() - t0 };
}

module.exports = { decideReprice, selectOwnedOrders, runAutoRepriceCycle, AUTO_REPRICE_SOURCE };

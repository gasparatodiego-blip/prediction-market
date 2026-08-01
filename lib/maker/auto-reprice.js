'use strict';
// lib/maker/auto-reprice.js — AUTOMATIC BAND-EXIT RE-PRICING for hand-placed orders.
//
// THE CHANGE THIS IMPLEMENTS. A manual order used to carry a fixed ~180s GTD expiry: the venue killed it
// on a clock, whatever the price was doing. That is backwards for a reward maker — what matters is not
// how long the order has rested but whether it is still inside the band that pays. So, for a market whose
// auto-reprice switch is ON, THIS is what moves the order, on TWO triggers that share one mechanism:
//   • BAND EXIT — the mid has travelled far enough to push the order out of the band that pays. If the
//     mid does not move that far, the order is NOT TOUCHED: no cancel, no replace, no churn.
//   • PROACTIVE RENEWAL — the order's venue-side GTD window is running out while its price is still fine,
//     so it is re-placed at the SAME price to reset the clock, with margin to spare.
// The window exists precisely so it can lapse: it is the DEAD-MAN'S SWITCH the exchange enforces if this
// host stops renewing. Both numbers live in lib/maker/auto-reprice-config.js and nowhere else.
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
//   7. IT CANCELS RATHER THAN GUESSES AFTER A BLACKOUT. Back from a long spell unable to reach the venue,
//      it retires the hand orders it can no longer vouch for instead of renewing on an unobserved state.
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
  RESTING_GTD_SECONDS, REFRESH_MARGIN_SECONDS, DISCONNECT_CANCEL_SECONDS,
} = require('./auto-reprice-config');
const { resolveOffsetFor, rememberObserved } = require('./offset-config');

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
function decideReprice({ order, rules, config, lastRepriceAt = null, consecutiveBreaches = 0, repricesThisHour = 0, now = Date.now() } = {}, deps = {}) {
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

  // ── HOW MUCH LIFE IS LEFT ON THE VENUE-SIDE EXPIRY ────────────────────────────────────────────────
  // `secondsToExpiry` comes from the venue's own `expiration` field, already corrected for the 60s the
  // exchange retires GTD orders early (see listManualOrders). null ⇒ GTC, no deadline, so the expiry
  // trigger simply never fires for that order.
  const ttlLeft = Number.isFinite(o.secondsToExpiry) ? o.secondsToExpiry : null;
  const margin = Number.isFinite(cfg.refreshMarginSeconds) ? cfg.refreshMarginSeconds : REFRESH_MARGIN_SECONDS;
  const expiring = ttlLeft != null && ttlLeft <= margin;
  const withTtl = { ...base, secondsToExpiry: ttlLeft, refreshMarginSeconds: margin, expiring };

  // ── TRIGGER 3: THE MID CHASE ────────────────────────────────────────────────────────────────────
  // The order holds a fixed DISTANCE from the mid, not a fixed price. mid 10 with orders at 7 and 13
  // (distance −3/+3) becomes 8 and 14 when the mid moves to 11. Computed BEFORE the band test because
  // it applies whether or not the order is still in band — a chase that also fixes a band exit is one
  // move, not two.
  //
  // WHICH SIDE OF THE MID the order sits on is preserved: the target is mid ± target, with the sign
  // taken from where the order already is. Flipping an order across the mid would not be "keeping its
  // distance", it would be a different order.
  const belowMid = price <= scoringMid;
  const observedOffsetC = distanceC;
  const off = (deps && typeof deps.resolveOffset === 'function')
    ? deps.resolveOffset({ marketId: rules.marketId, book, observedOffsetCents: observedOffsetC, tick })
    : resolveOffsetFor({ marketId: rules.marketId, book, observedOffsetCents: observedOffsetC, tick }, deps.offsetDeps || {});
  const targetOffC = off.targetOffsetCents;
  const minMoveC = off.minMoveCents;
  const chase = { targetOffsetCents: targetOffC, offsetSource: off.source, minMoveCents: minMoveC, currentOffsetCents: +observedOffsetC.toFixed(4) };

  let chaseTarget = null;
  let chaseDriftC = null;
  if (Number.isFinite(targetOffC) && targetOffC > 0) {
    chaseDriftC = +(observedOffsetC - targetOffC).toFixed(4);
    // The price that restores the target distance on the SAME side of the mid, snapped to the grid.
    const raw = belowMid ? scoringMid - targetOffC / 100 : scoringMid + targetOffC / 100;
    chaseTarget = +(Math.round(raw / tick) * tick).toFixed(10);
  }

  // ── THE ACTUAL QUESTION: is the order still in the band? Uses the SSOT (rewards-live-band.inBand),
  //    the same predicate validateQuote's OUT_OF_BAND check calls. No parallel band math anywhere. ──
  if (inBand(price, scoringMid, maxSpreadCents)) {
    // IN BAND, but has it drifted from its target distance by more than the minimum move?
    if (chaseTarget != null && Math.abs(chaseDriftC) > minMoveC + 1e-9) {
      if (lastRepriceAt != null && Number.isFinite(cfg.minIntervalMs) && (now - lastRepriceAt) < cfg.minIntervalMs) {
        return out('skip', 'rate-limited',
          `inseguimento dovuto (distanza ${observedOffsetC.toFixed(3)}¢ contro target ${targetOffC}¢) ma questa gamba e' stata mossa ${Math.round((now - lastRepriceAt) / 1000)}s fa — si attende il minimo di ${Math.round(cfg.minIntervalMs / 1000)}s`,
          { ...withTtl, ...chase });
      }
      if (Number.isFinite(cfg.maxPerHour) && repricesThisHour >= cfg.maxPerHour) {
        return out('skip', 'hourly-cap',
          `inseguimento dovuto ma questo mercato ha gia' avuto ${repricesThisHour} riprezzi nell'ultima ora (tetto ${cfg.maxPerHour})`,
          { ...withTtl, ...chase });
      }
      // THE BAND IS THE CEILING. If restoring the target distance would put the order outside the
      // reward band, we go as far as the band allows and no further: the chase never buys distance at
      // the cost of the reward it exists to earn.
      const bounds = inBandPriceBounds({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize });
      let want = chaseTarget;
      let clamped = false;
      if (bounds.readable && bounds.lo != null && bounds.hi != null) {
        if (want < bounds.lo) { want = bounds.lo; clamped = true; }
        if (want > bounds.hi) { want = bounds.hi; clamped = true; }
      }
      const vqChase = validateQuote({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize }, { side: o.side === 'SELL' ? 'SELL' : 'BUY', price: want, size });
      if (!vqChase.valid) {
        return out('skip', 'chase-target-invalid',
          `il prezzo di inseguimento ${want} non passa il guard condiviso (${vqChase.reasons.map((r) => r.code).join(',')}) — l'ordine non viene toccato`,
          { ...withTtl, ...chase, targetPrice: want });
      }
      if (o.side === 'SELL' && want < price - 1e-12) {
        return out('skip', 'close-sell-floor',
          `inseguimento verso il basso rifiutato su un ordine di CHIUSURA: il prezzo e' il profitto`,
          { ...withTtl, ...chase, targetPrice: want });
      }
      if (Math.abs(want - price) < tick / 1000) {
        return out('hold', 'chase-noop',
          `la distanza e' derivata di ${chaseDriftC.toFixed(3)}¢ ma il prezzo di inseguimento coincide con quello attuale dopo l'arrotondamento al tick — nessun movimento reale da fare`,
          { ...withTtl, ...chase, targetPrice: want });
      }
      return out('reprice', 'mid-chase',
        `inseguimento del mid: distanza ${observedOffsetC.toFixed(3)}¢ contro target ${targetOffC}¢ (deriva ${chaseDriftC.toFixed(3)}¢ > soglia ${minMoveC}¢) → da ${price} a ${want}`
        + (clamped ? ` · LIMITATO DALLA BANDA: il target avrebbe voluto ${chaseTarget}, ma il bordo premiante e' ${want}` : ''),
        { ...withTtl, ...chase, breachConfirmed: false, targetPrice: want, bandClamped: clamped });
    }
    // ── TRIGGER 2: THE PROACTIVE REFRESH ────────────────────────────────────────────────────────────
    // The order is priced correctly and nothing about the market says to move it — but its venue-side
    // expiry is running out. Renew it at the SAME price: a cancel→replace whose only purpose is to reset
    // the dead-man clock the exchange holds. We do this with margin still on the order rather than
    // waiting for expiry, because an order that actually expires leaves the book until the next poll
    // notices, whereas a renewal is a ~3-second gap we choose when to take.
    if (expiring) {
      if (lastRepriceAt != null && Number.isFinite(cfg.minIntervalMs) && (now - lastRepriceAt) < cfg.minIntervalMs) {
        return out('skip', 'rate-limited',
          `expiry refresh due (${ttlLeft}s left) but this leg was moved ${Math.round((now - lastRepriceAt) / 1000)}s ago — waiting out the ${Math.round(cfg.minIntervalMs / 1000)}s minimum interval. There is still margin: the refresh fires with ${margin}s of life to spare, so a short wait cannot cost the order.`,
          withTtl);
      }
      // The replacement must still be a valid quote in its own right. Re-priced at the SAME price, since
      // the mid has not invalidated it — this renews the clock, it does not chase the market.
      const vqSame = validateQuote({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize }, { side: 'BUY', price, size });
      if (!vqSame.valid) {
        return out('skip', 'refresh-invalid',
          `expiry refresh due (${ttlLeft}s left) but re-placing at the same price ${price} would not pass the shared guard (${vqSame.reasons.map((r) => r.code).join(',')}) — leaving the order to run out rather than cancelling it for a replacement the venue would refuse`,
          withTtl);
      }
      return out('reprice', 'expiry-refresh',
        `proactive renewal: ${ttlLeft}s of venue-side life left (margin ${margin}s), price still in band at ${distanceC.toFixed(2)}¢ of ±${bandRadiusC.toFixed(2)}¢ → re-place at the SAME price ${price} to reset the exchange-held expiry`,
        { ...withTtl, targetPrice: price, breachConfirmed: false });
    }
    return out('hold', null,
      `in band: |${price} − ${scoringMid.toFixed(6)}| = ${distanceC.toFixed(2)}¢ ≤ ±${bandRadiusC.toFixed(2)}¢`
      + (chaseTarget != null ? ` · distanza ${observedOffsetC.toFixed(3)}¢ contro target ${targetOffC}¢ (deriva ${chaseDriftC.toFixed(3)}¢ ≤ soglia ${minMoveC}¢)` : '')
      + (ttlLeft != null ? ` · ${ttlLeft}s of venue expiry left, refresh at ${margin}s` : ' · no venue expiry (GTC)')
      + ' — the order is NOT touched',
      { ...withTtl, ...chase });
  }

  // ── THE TWO TRIGGERS MEET HERE, AND THEY MUST NOT FIGHT ──────────────────────────────────────────
  // The order is OUT OF BAND. Normally that has to clear hysteresis, confirmation and the rate limit
  // before anything moves — those exist so a twitchy mid cannot cause churn.
  //
  // But if the venue-side expiry is ALSO nearly up, waiting is not the conservative choice any more: the
  // order is about to be retired by the exchange whatever we decide, so "wait and see" means "let it die
  // and leave the book empty until the next place". When both triggers are live, the band-exit move takes
  // priority and skips the patience gates — one action satisfies BOTH needs, because the replacement is
  // a fresh order with a fresh full RESTING_GTD_SECONDS window at a price back inside the band.
  //
  // This is also why the two triggers can never produce a double re-price: every re-price, from either
  // trigger, mints a NEW order with a full window, so the expiry trigger cannot fire again for
  // (window − margin) minutes; and the rate limit is market-keyed, so it binds across the id change.
  const forcedByExpiry = expiring;

  // ── HYSTERESIS. Out of band, but only just? An order sitting a hair past the edge would otherwise flap
  //    in and out on rounding alone, and every flap is a cancel+place with a real out-of-book window. ──
  const hysteresisC = (Number.isFinite(cfg.hysteresisTicks) ? cfg.hysteresisTicks : 0) * tick * 100;
  if (distanceC <= bandRadiusC + hysteresisC + 1e-9 && !forcedByExpiry) {
    return out('hold', 'hysteresis',
      `out of band by ${(distanceC - bandRadiusC).toFixed(3)}¢ but within the ${hysteresisC.toFixed(3)}¢ hysteresis (${cfg.hysteresisTicks} tick) — left alone rather than flapping at the edge`,
      withTtl);
  }

  // ── CONFIRMATION. One sample is not a signal. The breach must survive consecutive observations. ──
  const needed = Number.isFinite(cfg.confirmSamples) ? cfg.confirmSamples : 1;
  const seen = consecutiveBreaches + 1; // this cycle's observation included
  if (seen < needed && !forcedByExpiry) {
    return out('skip', 'awaiting-confirmation',
      `out of band by ${distanceC.toFixed(2)}¢ (band ±${bandRadiusC.toFixed(2)}¢), observation ${seen}/${needed} — waiting for confirmation before moving a real order`,
      { ...withTtl, breachConfirmed: false });
  }

  // ── RAILS. Both of these leave the order alone; they bound how often the automatism may act. ──
  // The rate limit binds even under expiry pressure: two re-prices inside 30 seconds is churn whatever
  // the reason, and the refresh margin is deliberately many multiples of the limit, so waiting it out
  // cannot cost the order. The hourly ceiling binds too — a market that has already had 20 automatic
  // moves in an hour is one to look at by hand, not one to keep feeding.
  if (lastRepriceAt != null && Number.isFinite(cfg.minIntervalMs) && (now - lastRepriceAt) < cfg.minIntervalMs) {
    return out('skip', 'rate-limited',
      `this leg was automatically re-priced ${Math.round((now - lastRepriceAt) / 1000)}s ago (minimum interval ${Math.round(cfg.minIntervalMs / 1000)}s) — not touched again yet`
      + (forcedByExpiry ? ` · ${ttlLeft}s of venue expiry left, still well inside the ${margin}s margin` : ''),
      { ...withTtl, breachConfirmed: true });
  }
  if (Number.isFinite(cfg.maxPerHour) && repricesThisHour >= cfg.maxPerHour) {
    return out('skip', 'hourly-cap',
      `this market has already had ${repricesThisHour} automatic re-prices in the last hour (ceiling ${cfg.maxPerHour}) — the runaway guard stops here; re-price by hand if this is genuinely wanted`,
      { ...withTtl, breachConfirmed: true });
  }

  // ── WHERE TO MOVE IT. The bounds come from lib/maker/venue-rules.inBandPriceBounds, which derives them
  //    by ASKING validateQuote — so a target can never be looser than the guard that will re-check it. ──
  const bounds = inBandPriceBounds({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize });
  if (!bounds.readable || bounds.lo == null || bounds.hi == null) {
    return out('skip', 'no-valid-target',
      'no qualifying price could be derived for the current band (band narrower than one tick, or unreadable) — nothing is touched rather than inventing a price',
      { ...withTtl, breachConfirmed: true });
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

  // ── A CLOSING SELL IS NEVER WALKED DOWN ─────────────────────────────────────────────────────────
  // For a BUY, moving with the band is neutral: the order is a bid and the operator's stance is an offset
  // from the mid. For the SELL that CLOSES a position, the price IS the profit: it was set to entry plus a
  // margin, so moving it down erodes exactly what the exit exists to capture, and far enough down it turns
  // a close into a realised loss. Moving it UP is always fine (more profit). So a SELL is re-priced only
  // upward; if the band has moved below it, the exit simply stops earning rewards while it waits, which is
  // the cheap half of the trade-off. lib/maker/auto-close.closeFloorPrice states the same floor at
  // placement time; this is the same rule enforced on every later move.
  if (o.side === 'SELL' && targetPrice < price - 1e-12) {
    return out('skip', 'close-sell-floor',
      `questo è un ordine di CHIUSURA: il target di banda ${targetPrice} è sotto il prezzo attuale ${price}, e abbassarlo eroderebbe il profitto per cui l'uscita esiste. Resta dov'è (fuori banda non matura premi, ma il guadagno è protetto).`,
      { ...withTtl, breachConfirmed: true, targetPrice });
  }

  // ── FINAL SELF-CHECK. Run the SHARED guard on the exact replacement we are about to propose. If it
  //    would not qualify, we do NOTHING: cancelling an order we cannot validly replace is strictly worse
  //    than leaving an out-of-band order resting, because it earns nothing either way but costs the size. ──
  const vq = validateQuote({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize }, { side: 'BUY', price: targetPrice, size });
  if (!vq.valid) {
    return out('skip', 'replacement-invalid',
      `the proposed replacement at ${targetPrice} would not pass the shared guard (${vq.reasons.map((r) => r.code).join(',')}) — the resting order is left untouched rather than cancelled for nothing`,
      { ...withTtl, breachConfirmed: true, targetPrice });
  }

  if (Math.abs(targetPrice - price) < tick / 1000 && !forcedByExpiry) {
    // Cannot happen for a genuine breach, but if the target equals the current price there is nothing to
    // do and a cancel+place would be pure loss (an out-of-book window for an identical order).
    // Under expiry pressure the same-price case is exactly the refresh, so it falls through instead.
    return out('hold', 'target-unchanged',
      `the computed target ${targetPrice} equals the current price — nothing to move`,
      { ...withTtl, targetPrice });
  }

  return out('reprice', forcedByExpiry ? 'band-exit-and-expiry' : null,
    forcedByExpiry
      ? `band exit AND expiry: out of band by ${distanceC.toFixed(2)}¢ (band ±${bandRadiusC.toFixed(2)}¢) with only ${ttlLeft}s of venue-side life left → one move handles both, to ${targetPrice} (${cfg.strategy}). The patience gates (hysteresis, ${needed}-sample confirmation) are deliberately skipped here: the exchange is about to retire this order anyway, so waiting would mean losing it rather than protecting it.`
      : `band exit: |${price} − ${scoringMid.toFixed(6)}| = ${distanceC.toFixed(2)}¢ > ±${bandRadiusC.toFixed(2)}¢ + ${hysteresisC.toFixed(3)}¢ hysteresis, confirmed on ${seen} consecutive observations → move to ${targetPrice} (${cfg.strategy})`,
    { ...withTtl, breachConfirmed: true, targetPrice });
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
    // BUY, or a SELL that is a CLOSING order. The panel's own orders are BUYs; the only SELLs it ever
    // places are exits produced by lib/maker/auto-close.js, and those want the same band management as
    // anything else — an exit that drifts out of band stops earning while it waits. A SELL from anywhere
    // else is still left alone: this path measures no inventory of its own.
    const sideU = o.side ? String(o.side).toUpperCase() : 'BUY';
    if (sideU !== 'BUY' && sideU !== 'SELL') continue;
    if (wantMarket && o.marketId && String(o.marketId).trim().toLowerCase() !== wantMarket) continue;
    // WHICH BOOK. Resolved by matching the order's token against the market's two token ids — never
    // guessed. An order whose token matches neither is skipped: we cannot mirror its band correctly.
    const tok = o.tokenId ? String(o.tokenId) : null;
    const book = tok && yesToken && tok === yesToken ? 'yes' : (tok && noToken && tok === noToken ? 'no' : null);
    if (!book) continue;
    const size = Number.isFinite(o.sizeRemaining) && o.sizeRemaining > 0 ? o.sizeRemaining : Number(o.size);
    out.push({
      orderId: o.orderId, price: Number(o.price), size, book, tokenId: tok, marketId: o.marketId, status: o.status,
      side: sideU,
      // Carried through from the VENUE's own `expiration` field (already corrected for the 60s the
      // exchange retires GTD orders early). This is what the proactive-refresh trigger reads; null means
      // GTC, so that trigger simply never fires for the order.
      secondsToExpiry: Number.isFinite(o.secondsToExpiry) ? o.secondsToExpiry : null,
      orderType: o.orderType || null,
    });
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
  // The connection-blackout clock, carried BETWEEN cycles by the caller exactly like `breaches`. A fresh
  // process starts with no blackout recorded, which is right: it did not witness one.
  const link = deps.link && typeof deps.link === 'object' ? deps.link : { downSince: null, consecutiveFailures: 0 };
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

  // ── UN MERCATO, UN SOLO MOTORE ──────────────────────────────────────────────────────────────────
  // I mercati con il tracking attivo (lib/maker/mm-tracking) appartengono a QUEL motore, che li quota su
  // due lati inseguendo il mid. Questo watcher e' reattivo e sposta un ordine solo quando rischia di
  // uscire dalla banda: due logiche diverse sullo stesso ordine si contenderebbero il posto, e il
  // risultato sarebbe un ordine che viene cancellato e ripiazzato da due processi con due idee diverse
  // di dove debba stare. Qui il tracking VINCE, perche' e' l'unico dei due che l'operatore ha acceso
  // esplicitamente per quel mercato.
  //
  // La lista si legge a ogni ciclo, non si memorizza: spegnere il tracking deve restituire il mercato a
  // questo watcher entro un ciclo, non entro un riavvio.
  let tracked = [];
  try {
    tracked = typeof deps.trackedMarketIds === 'function'
      ? deps.trackedMarketIds()
      : require('./mm-tracking-config').trackedMarketIds();
  } catch { tracked = []; }
  const trackedSet = new Set(tracked.map((x) => String(x).trim().toLowerCase()));

  const markets = [];
  for (const marketId of cfgState.enabledMarketIds) {
    if (trackedSet.has(String(marketId).trim().toLowerCase())) {
      markets.push({ marketId, gate: 'owned-by-tracking', considered: 0, held: 0, skipped: 0, repriced: 0,
        reason: 'questo mercato ha il tracking attivo (market making a due lati): lo gestisce quel motore, e questo watcher sta alla larga per non contendersi lo stesso ordine' });
      continue;
    }
    const m = { marketId, gate: null, reason: null, considered: 0, held: 0, skipped: 0, repriced: 0 };

    // ── GATE 2 — MANUAL OWNERSHIP. Same precondition as a hand order: the automatism may only act where
    //    agent35 is provably standing off. A market handed back to the engine is dropped immediately. ──
    const mm = typeof deps.isManual === 'function' ? deps.isManual(marketId) : { manual: true, readable: true };
    if (!mm.readable) { m.gate = 'manual-mode-unreadable'; m.reason = 'market ownership is unreadable — skipping (fail closed)'; markets.push(m); continue; }
    if (!mm.manual) { m.gate = 'manual-mode-inactive'; m.reason = 'this market is no longer in manual mode — agent35 owns it again, so the automatism stands off'; markets.push(m); continue; }

    // ── THE MARKET'S OWN CLOCK — checked BEFORE any venue I/O ───────────────────────────────────────
    // A renewal is a cancel→replace, and the replace is refused inside the market's final minutes
    // (lib/maker/market-clock.js). Discovering that per-order, every 5s, would mean a cancel attempt and a
    // refusal on every poll for the whole tail of a short market. Standing off here is both quieter and
    // more correct: with nothing renewing, the venue's own GTD retires the resting orders by itself, which
    // is exactly the behaviour wanted as a market closes. Skipped entirely when the close time is
    // unreadable — unknown is not "closing soon" (same rule as everywhere else).
    const win = typeof deps.marketWindow === 'function'
      ? deps.marketWindow(marketId)
      : (() => {
        try {
          return require('./market-clock').marketWindowFor({ marketId, baseTtlSeconds: config.restingGtdSeconds, baseRefreshMarginSeconds: config.refreshMarginSeconds });
        } catch { return null; }
      })();
    if (win && win.tooClose === true) {
      m.gate = win.gate || 'market-too-close-to-close';
      m.reason = `${win.reason} — il watcher NON rinnova più su questo mercato: senza rinnovo gli ordini a riposo scadono da soli per GTD, che è il comportamento voluto a ridosso della chiusura`;
      markets.push(m); continue;
    }

    const rules = typeof deps.resolveRules === 'function' ? deps.resolveRules(marketId) : null;
    if (!rules || rules.readable !== true) {
      m.gate = 'rules-unreadable';
      m.reason = `venue rules not readable (missing: ${rules && Array.isArray(rules.missing) ? rules.missing.join(', ') : 'unknown'}) — skipping this market`;
      markets.push(m); continue;
    }

    // ── VENUE TRUTH, not local belief. The resting orders are read from the venue every cycle. ──
    let listed;
    try { listed = await deps.listOrders({ marketId }); }
    catch (e) { listed = { ok: false, error: e.message }; }
    if (!listed || listed.ok === false) {
      // ── THE CONNECTION BLACKOUT CLOCK STARTS HERE ────────────────────────────────────────────────
      // The process is alive but cannot see the venue. Note the FIRST failure and carry on failing; the
      // recovery branch below decides what to do about it once the venue answers again.
      if (link.downSince == null) link.downSince = t0;
      link.consecutiveFailures = (link.consecutiveFailures || 0) + 1;
      m.gate = 'list-failed';
      m.reason = `venue read FAILED (${listed && listed.error ? listed.error : 'unknown'}) — skipping; we do not know what is resting, and that is not the same as nothing resting`
        + ` · blind for ${Math.round((t0 - link.downSince) / 1000)}s (${link.consecutiveFailures} consecutive failures). While blind nothing is renewed, so the venue-side GTD expiry is doing exactly the job it exists for.`;
      markets.push(m); continue;
    }
    if (listed.simulated === true) {
      m.gate = 'simulated';
      m.reason = 'no venue credentials — the venue was not queried, so there is nothing to act on (this is "we did not read", not "you have no orders")';
      markets.push(m); continue;
    }

    // ── THE VENUE ANSWERED. WAS THIS A RECOVERY FROM A LONG BLACKOUT? ────────────────────────────────
    // Being blind is survivable — the GTD expiry retires orders on its own. The RECOVERY is the dangerous
    // moment: after a blackout longer than the refresh margin we can no longer claim to know which of our
    // orders survived, which the exchange already retired, and which were filled while we could not see.
    // Renewing on top of that guesswork would be asserting a state we did not observe.
    //
    // So we cancel the panel's own resting orders on this market and stop. The operator re-places
    // deliberately. Cancelling is the direction that can only reduce exposure, it goes through the
    // CANCEL-ONLY adapter, and it leaves the book in a state we can describe honestly.
    const owned = selectOwnedOrders(listed.orders, { marketId, rules });
    if (link.downSince != null) {
      const blindSec = Math.round((t0 - link.downSince) / 1000);
      const threshold = Number.isFinite(config.disconnectCancelSeconds) ? config.disconnectCancelSeconds : DISCONNECT_CANCEL_SECONDS;
      link.downSince = null;
      link.consecutiveFailures = 0;
      if (blindSec > threshold) {
        m.gate = 'reconnect-cancel';
        m.reason = `venue reachable again after ${blindSec}s blind (threshold ${threshold}s) — cancelling this market's hand orders rather than renewing on top of a state we did not observe`;
        audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'reconnect-cancel',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: m.reason, observed: { blindSeconds: blindSec, thresholdSeconds: threshold, orders: owned.length } });
        for (const o of owned) {
          let c = null;
          try { c = typeof deps.cancelOrder === 'function' ? await deps.cancelOrder({ orderId: o.orderId, marketId }) : null; }
          catch (e) { c = { ok: false, reason: e.message }; }
          actions.push({ marketId, orderId: o.orderId, action: 'reconnect-cancel', ok: !!(c && c.ok), reason: (c && c.reason) || null });
          audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: (c && c.ok) ? 'reconnect-cancelled' : 'reconnect-cancel-failed',
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: o.orderId, reason: (c && c.reason) || null });
        }
        m.considered = owned.length;
        m.skipped = owned.length;
        markets.push(m);
        continue;
      }
      m.reason = `venue reachable again after ${blindSec}s blind — under the ${threshold}s threshold, so the normal cycle resumes without cancelling anything`;
    }
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

      const d = decideReprice(
        { order, rules, config, lastRepriceAt: lastAt, consecutiveBreaches: prevBreaches, repricesThisHour, now: t0 },
        { resolveOffset: deps.resolveOffset, offsetDeps: deps.offsetDeps },
      );
      // Seed "stay where you were placed": the FIRST distance seen for a (market, book) becomes the
      // target, so the default needs no configuration and survives both a re-price and a restart.
      if (d.offsetSource === 'observed' && Number.isFinite(d.currentOffsetCents)) {
        try { (deps.rememberObserved || rememberObserved)({ marketId, book: order.book, offsetCents: d.currentOffsetCents }, deps.offsetDeps || {}); }
        catch { /* best-effort: a failed memory only means the next cycle re-observes the same distance */ }
      }

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
      // WHICH TRIGGER fired is recorded on every line, because "the mid moved" and "the clock was running
      // out" are different events that happen to share a mechanism, and an audit trail that blurred them
      // would make the renewal rate impossible to reason about after the fact.
      const trigger = d.gate === 'expiry-refresh' ? 'expiry-refresh'
        : d.gate === 'band-exit-and-expiry' ? 'band-exit-and-expiry' : 'band-exit';
      audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'trigger', trigger,
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId, reason: d.reason,
        observed: { price: order.price, scoringMid: d.scoringMid, distanceC: d.distanceC, bandRadiusC: d.bandRadiusC, secondsToExpiry: d.secondsToExpiry, strategy: config.strategy },
        requested: { book: order.book, fromPrice: order.price, toPrice: d.targetPrice, size: order.size } });

      let res;
      try {
        res = await deps.replaceOrder({
          orderId: order.orderId, marketId, book: order.book,
          side: order.side,   // load-bearing: without it a re-priced CLOSE would be re-placed as a BUY
          price: d.targetPrice, size: order.size,
          // ttlSeconds is DELIBERATELY NOT passed. Omitting it lets resolveManualTtlSeconds decide from
          // the market's live auto-reprice switch — which is the single source for that choice. Pinning a
          // number here would mean an order placed with a full resting window a moment after the operator
          // switched the automatism OFF, i.e. a long-lived order nothing is watching.
          source: AUTO_REPRICE_SOURCE,
          note: trigger === 'expiry-refresh'
            ? `auto: rinnovo proattivo, ${d.secondsToExpiry}s alla scadenza`
            : `auto: band exit ${d.distanceC}¢ > ±${d.bandRadiusC}¢${trigger === 'band-exit-and-expiry' ? ` + scadenza fra ${d.secondsToExpiry}s` : ''}`,
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
        marketId, orderId: order.orderId, action: 'reprice', trigger, ok,
        fromPrice: order.price, toPrice: d.targetPrice, size: order.size, book: order.book,
        secondsToExpiry: d.secondsToExpiry,
        sent: !!(res && res.place && res.place.sent), oldCancelled: !!(res && res.oldCancelled),
        gate: (res && res.gate) || null, reason: (res && res.reason) || null,
        newOrderId: (res && res.place && res.place.orderId) || null,
        newExpiry: (res && res.expiry) || null,
      });
      audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', trigger,
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
        reprice: { orderId: order.orderId, fromPrice: order.price, toPrice: d.targetPrice, ok, sent: !!(res && res.place && res.place.sent), gate: (res && res.gate) || null, reason: (res && res.reason) || null, trigger },
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

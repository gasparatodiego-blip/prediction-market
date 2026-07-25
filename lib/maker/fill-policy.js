'use strict';
// lib/maker/fill-policy.js — what the maker DOES when one of its resting legs gets filled.
//
// Until now "if this level fills" was an advisory preference stored on RewardsLeg.onFill that no engine
// ever read. This module is the rule the engine actually consults, and it is the ONLY place the mapping
// from a stored rule to a follow-up order lives.
//
// THREE RULES, chosen PER SIDE (YES and NO independently) by the operator:
//   'close'    — flatten. You were filled, so you hold inventory; exit it. Reduces exposure.
//   'opposite' — re-quote the complementary side at the mirrored offset (the classic maker round-trip:
//                you bought at mid−off, now offer at mid+off). ADDS exposure, so it is the rule the
//                per-market collateral ceiling exists to bound.
//   'hold'     — do nothing. Keep the inventory, keep the remaining legs, no follow-up order.
//
// NO PARALLEL MATH:
//   • the mirrored price is the SAME band geometry every other surface uses (mid ∓ offset, tick-snapped
//     by lib/maker/quote-plan.snapToTick);
//   • the follow-up quote is validated by the SHARED guard (lib/maker/venue-rules.validateQuote) before
//     it can be emitted — the same validator the preflight probes and the UI band warning calls. A
//     follow-up that would be off-tick / out-of-band / under min_incentive_size is REFUSED here, not
//     discovered at the venue.
//
// FAIL CLOSED: an unknown rule normalizes to 'hold' (the action that places nothing). A follow-up that
// cannot be priced, cannot be validated, or does not fit the remaining collateral headroom is refused
// with a reason — never emitted "optimistically".
//
// The news-guard sits ABOVE this: a HIGH severity signal forces a close regardless of the stored rule
// (lib/maker/risk-rails 'news-high' halts the market and cancels), and this module states that when it
// is told a force-close is in effect.

const { validateQuote } = require('./venue-rules');
const { snapToTick } = require('./quote-plan');

const RULES = Object.freeze(['close', 'opposite', 'hold']);
const DEFAULT_RULE = 'opposite';   // the maker round-trip — what 'requote' meant before this module

/**
 * Normalize a stored/loaded rule to one of RULES.
 * Legacy values are mapped, never dropped:
 *   'requote' (the old default) ≡ 'opposite' — it always meant "re-quote the offsetting side"
 *   'flatten'                    ≡ 'close'
 * Anything unrecognised ⇒ 'hold' (fail closed: the action that places nothing).
 */
function normalizeFillRule(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'close' || s === 'flatten') return 'close';
  if (s === 'opposite' || s === 'requote') return 'opposite';
  if (s === 'hold') return 'hold';
  return 'hold';
}

/** The complementary order kind: a filled BUY leaves you long → the follow-up is a SELL, and vice-versa. */
function oppositeKind(kind) { return kind === 'buy' ? 'sell' : 'buy'; }

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Decide the follow-up for ONE filled leg.
 *
 * @param {object} args
 *   filledLeg   { book:'yes'|'no', kind:'buy'|'sell', price, offsetC, size } — the leg that filled
 *   rule        the stored per-side rule (normalized here; legacy values accepted)
 *   mid         the ADJUSTED (scoring) mid, 0..1, or null
 *   maxSpreadC  reward band width in cents (radius = /2), or null
 *   tick        the market's real tick, or null
 *   minSize     min_incentive_size in shares, or null
 *   capHeadroomUsd  collateral still available on THIS market (see lib/maker/market-cap). null ⇒ no
 *                   ceiling configured; a headroom below the follow-up's notional refuses 'opposite'.
 *   newsForceClose  true when the news-guard has a HIGH signal on this market — forces 'close'.
 * @returns {{action:'close'|'place-opposite'|'hold', rule:string, appliedRule:string,
 *            quote:(object|null), guard:(object|null), reason:string, forcedBy:(string|null)}}
 */
function planOnFill({
  filledLeg,
  rule,
  mid = null,
  maxSpreadC = null,
  tick = null,
  minSize = null,
  capHeadroomUsd = null,
  newsForceClose = false,
} = {}) {
  const stored = normalizeFillRule(rule);
  const applied = newsForceClose ? 'close' : stored;
  const forcedBy = newsForceClose ? 'news-guard' : null;
  const leg = filledLeg || {};

  if (applied === 'hold') {
    return { action: 'hold', rule: stored, appliedRule: applied, quote: null, guard: null, forcedBy,
      reason: 'regola "tieni" — nessun ordine di seguito, l\'inventario resta' };
  }

  const kind = oppositeKind(leg.kind);
  const side = kind === 'buy' ? 'BUY' : 'SELL';
  // The mirrored target: a leg placed at mid+off is answered at mid−off, and vice-versa. When the leg
  // carries no offset we mirror its literal price about the mid — the same reflection, stated in price.
  const off = fin(leg.offsetC) ? -leg.offsetC
    : (fin(leg.price) && fin(mid)) ? -((leg.price - mid) * 100)
      : null;
  const rawTarget = (fin(mid) && fin(off)) ? mid + off / 100 : null;
  const price = (rawTarget != null && fin(tick) && tick > 0) ? snapToTick(rawTarget, tick) : rawTarget;
  const size = fin(leg.size) && leg.size > 0 ? leg.size : null;

  if (price == null || size == null) {
    return { action: 'hold', rule: stored, appliedRule: applied, quote: null, guard: null, forcedBy,
      reason: 'prezzo o size del follow-up non calcolabili (mid/tick/size mancanti) — nessun ordine emesso (fail closed)' };
  }

  // THE SHARED GUARD. Every follow-up passes the same validateQuote the preflight probes — off-tick,
  // out-of-band and under-min are refused HERE, before anything could be signed.
  const guard = validateQuote(
    { tick, scoringMid: mid, maxSpreadCents: maxSpreadC, minSize },
    { side, price, size },
  );

  const quote = { book: leg.book, kind, side, price, size, offsetC: fin(off) ? +off.toFixed(3) : null,
    notionalUsd: +(price * size).toFixed(4), intent: applied === 'close' ? 'flatten' : 'round-trip' };

  if (applied === 'close') {
    // A close REDUCES exposure, so it is never blocked by the collateral ceiling. It is still guarded:
    // an out-of-band exit earns nothing, which the caller must state rather than silently posting it.
    return { action: 'close', rule: stored, appliedRule: applied, quote, guard, forcedBy,
      reason: guard.valid
        ? (forcedBy ? 'chiusura forzata dal news-guard — esce dall\'inventario' : 'regola "chiudi" — esce dall\'inventario al prezzo speculare')
        : `uscita fuori regola: ${guard.reasons.map((r) => r.code).join(', ')} — riposa ma non matura premio` };
  }

  // 'opposite' ADDS exposure ⇒ it must fit under the market's remaining collateral headroom.
  if (capHeadroomUsd != null) {
    if (!fin(capHeadroomUsd) || quote.notionalUsd > capHeadroomUsd + 1e-9) {
      return { action: 'hold', rule: stored, appliedRule: applied, quote: null, guard, forcedBy,
        reason: `lato opposto rifiutato: servono $${quote.notionalUsd.toFixed(2)} ma restano $${fin(capHeadroomUsd) ? capHeadroomUsd.toFixed(2) : '—'} sotto il tetto di collaterale del mercato` };
    }
  }
  if (!guard.valid) {
    return { action: 'hold', rule: stored, appliedRule: applied, quote: null, guard, forcedBy,
      reason: `lato opposto rifiutato dal guard venue-rules: ${guard.reasons.map((r) => `${r.code} (${r.detail})`).join(' · ')}` };
  }

  return { action: 'place-opposite', rule: stored, appliedRule: applied, quote, guard, forcedBy,
    reason: `regola "lato opposto" — ri-quota ${side} ${leg.book.toUpperCase()} a ${(price * 100).toFixed(2)}¢ (giro completo), dentro banda e sotto il tetto` };
}

module.exports = { planOnFill, normalizeFillRule, oppositeKind, RULES, DEFAULT_RULE };

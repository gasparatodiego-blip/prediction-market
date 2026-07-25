'use strict';
// lib/maker/inventory-manager.js — what the maker does AFTER a fill. PURE: no I/O, no venue, no adapter.
// It decides; the caller audits and (when armed, which it is not) acts.
//
// THE DEFAULT IS TO STOP. maxInventoryUsd defaults to 0, and 0 is not "unset" or "unlimited" — it is the
// literal instruction "do not accumulate a position here". At 0 a fill ends quoting on that side and the
// reason is recorded. Re-quoting the opposite side, which is how a market maker's inventory grows, has to
// be turned on by typing a dollar number, per market. It is never inferred from the order size, from the
// collateral ceiling, or from the on-fill rule.
//
// SIZE COMES FROM THE FILL, NOT FROM THE INTENT. The re-quote is sized off what the VENUE says actually
// filled (a reconciled fill record), never off what we meant to place. A partial fill re-quotes the
// partial. An unconfirmed fill re-quotes NOTHING — fail closed, with its own reason code.
//
// THE CAP IS A CEILING, NOT A TARGET. The re-quote is trimmed so the resulting inventory notional cannot
// exceed maxInventoryUsd, and when there is no room left the decision is "stop", stated.
//
// OPERATING RULE (which side to quote at all):
//   inventory == 0  → quote BUY on both complementary tokens. With collateral only, those are the two
//                     orders that can rest (a SELL would deliver a token we do not hold — see
//                     lib/maker/inventory-guard).
//   inventory  > 0  → on the side holding shares, a SELL is preferred: it reduces the position we already
//                     carry and needs no new collateral. The other side stays a BUY.

const CODES = Object.freeze({
  CAP_ZERO: 'INVENTORY_CAP_ZERO',             // maxInventoryUsd is 0 → stop quoting that side
  CAP_REACHED: 'INVENTORY_CAP_REACHED',       // already at/over the ceiling → stop
  CAP_TRIMMED: 'INVENTORY_CAP_TRIMMED',       // re-quote allowed but trimmed to fit under the ceiling
  REQUOTE_OPPOSITE: 'INVENTORY_REQUOTE_OPPOSITE', // full re-quote of the filled size fits
  FILL_UNCONFIRMED: 'INVENTORY_FILL_UNCONFIRMED', // no venue-confirmed fill size → do nothing
  CAP_UNREADABLE: 'INVENTORY_CAP_UNREADABLE',     // the ceiling could not be read → fail closed
});

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** The complementary book. */
function otherBook(book) { return book === 'yes' ? 'no' : 'yes'; }

/**
 * Which kinds this market should be quoting, given the inventory actually held.
 *
 * @param {{ yesShares:number|null, noShares:number|null }} inventory  measured; null = unreadable
 * @returns {{ yes:{kind:'buy'|'sell', why:string}, no:{kind:'buy'|'sell', why:string}, readable:boolean }}
 */
function preferredSides(inventory) {
  const inv = inventory || {};
  const readable = fin(inv.yesShares) && fin(inv.noShares);
  const side = (shares, book) => {
    if (!fin(shares)) {
      return { kind: 'buy', why: `saldo ${book.toUpperCase()} non leggibile: si resta sull'acquisto, che con i soli pUSD è sempre immettibile` };
    }
    if (shares > 0) {
      return { kind: 'sell', why: `possiedi ${shares} token ${book.toUpperCase()}: la vendita riduce la posizione che hai già e non impegna nuovo collaterale` };
    }
    return { kind: 'buy', why: `nessun token ${book.toUpperCase()} in portafoglio: si può solo comprare` };
  };
  return { yes: side(inv.yesShares, 'yes'), no: side(inv.noShares, 'no'), readable };
}

/**
 * Decide what happens after ONE leg fills.
 *
 * @param {object} args
 *   fill              { book, kind, price, filledShares, confirmed } — filledShares/confirmed come from
 *                     VENUE TRUTH (the reconciled fill ledger), never from the order we intended.
 *   maxInventoryUsd   the per-market ceiling in dollars. 0 ⇒ stop. null/NaN ⇒ unreadable ⇒ stop.
 *   inventoryUsd      dollars of outcome-token notional already held on this market (measured). null ⇒
 *                     treated as unreadable ⇒ fail closed.
 *   oppositePrice     the price the opposite-side re-quote would rest at (0..1), for sizing the notional.
 * @returns {{ action:'stop'|'requote', code, reason, book:string|null, kind:string|null,
 *             sizeShares:number|null, notionalUsd:number|null, headroomUsd:number|null }}
 */
function planPostFill({ fill, maxInventoryUsd, inventoryUsd, oppositePrice } = {}) {
  const f = fill || {};
  const stop = (code, reason) => ({ action: 'stop', code, reason, book: null, kind: null, sizeShares: null, notionalUsd: null, headroomUsd: null });

  // 1. THE DEFAULT. A ceiling of 0 means do not accumulate: stop quoting that side, say so.
  if (maxInventoryUsd === 0) {
    return stop(CODES.CAP_ZERO,
      `tetto di inventario a $0 su questo mercato: dopo un fill il bot NON ri-quota il lato opposto, smette di quotare quel lato e si ferma. Per accumulare posizione imposta un tetto in dollari.`);
  }
  // 2. An unreadable ceiling is not permission.
  if (!fin(maxInventoryUsd) || maxInventoryUsd < 0) {
    return stop(CODES.CAP_UNREADABLE,
      'tetto di inventario non leggibile: senza un limite verificato il bot non accumula posizione, quindi si ferma (fail closed).');
  }
  // 3. Size comes from the venue, or there is no size.
  if (f.confirmed !== true || !fin(f.filledShares) || f.filledShares <= 0) {
    return stop(CODES.FILL_UNCONFIRMED,
      'nessun fill confermato dal venue: la size di un ri-piazzamento si prende dal fill reale, mai dall\'ordine che si era inteso piazzare, quindi non viene emesso nulla.');
  }
  // 4. An unreadable current inventory cannot be checked against the ceiling.
  if (!fin(inventoryUsd) || inventoryUsd < 0) {
    return stop(CODES.CAP_UNREADABLE,
      'inventario corrente non leggibile: non si può verificare il tetto, quindi il bot non accumula (fail closed).');
  }

  const headroomUsd = +(maxInventoryUsd - inventoryUsd).toFixed(4);
  if (headroomUsd <= 0) {
    return { action: 'stop', code: CODES.CAP_REACHED,
      reason: `tetto di inventario raggiunto: hai $${inventoryUsd.toFixed(2)} di posizione contro un tetto di $${maxInventoryUsd.toFixed(2)}, quindi il lato opposto non viene ri-quotato.`,
      book: null, kind: null, sizeShares: null, notionalUsd: null, headroomUsd: 0 };
  }

  // 5. Re-quote the FILLED size on the opposite side, trimmed to fit under the ceiling.
  const book = otherBook(f.book);
  const price = fin(oppositePrice) && oppositePrice > 0 ? oppositePrice : null;
  if (price == null) {
    return stop(CODES.FILL_UNCONFIRMED,
      'prezzo del lato opposto non calcolabile: senza un prezzo valido non si dimensiona nulla, quindi il bot si ferma.');
  }

  const wantedShares = f.filledShares;
  const wantedNotional = +(wantedShares * price).toFixed(4);
  if (wantedNotional <= headroomUsd) {
    return { action: 'requote', code: CODES.REQUOTE_OPPOSITE,
      reason: `ri-quoto ${wantedShares} quote sul lato ${book.toUpperCase()} a ${(price * 100).toFixed(1)}¢ ($${wantedNotional.toFixed(2)}): resta sotto il tetto di $${maxInventoryUsd.toFixed(2)} (spazio $${headroomUsd.toFixed(2)}).`,
      book, kind: 'buy', sizeShares: wantedShares, notionalUsd: wantedNotional, headroomUsd };
  }

  const trimmedShares = +(headroomUsd / price).toFixed(4);
  const trimmedNotional = +(trimmedShares * price).toFixed(4);
  return { action: 'requote', code: CODES.CAP_TRIMMED,
    reason: `ri-piazzamento ridotto dal tetto: servivano $${wantedNotional.toFixed(2)} per l'intero fill ma lo spazio residuo è $${headroomUsd.toFixed(2)}, quindi vengono ri-quotate ${trimmedShares} quote e non di più.`,
    book, kind: 'buy', sizeShares: trimmedShares, notionalUsd: trimmedNotional, headroomUsd };
}

module.exports = { CODES, planPostFill, preferredSides, otherBook };

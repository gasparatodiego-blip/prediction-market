'use strict';
// lib/maker/canonical-position.js — the ONE canonical description of a resting order in a binary market.
//
// THE FACT THIS ENCODES. A binary Polymarket market has ONE book with two complementary tokens. Buying
// NO at q and selling YES at (1 − q) are not two positions that resemble each other: they are the same
// resting order, on the same side of the same book, and the CLOB will match either against the same
// incoming flow. The reward program scores that ONE book.
//
// So every user-facing form maps onto a canonical pair:
//
//     user-facing form         canonical side (YES book)     canonical price
//     ─────────────────────    ─────────────────────────     ───────────────
//     BUY  YES @ p             BID                           p
//     SELL YES @ p             ASK                           p
//     BUY  NO  @ q             ASK                           1 − q
//     SELL NO  @ q             BID                           1 − q
//
// WHY IT MATTERS FOR THE ESTIMATE. Two-sidedness — the difference between full score and a third of it
// (Q_min with c = 3), or zero in the tails — is a property of the CANONICAL set, not of the raw leg
// list. Judged on raw legs, "BUY YES + BUY NO" (a genuinely two-sided quote, a bid and an ask) reads as
// one-sided because neither leg is a YES sell; and "BUY NO + SELL YES" (one position written twice)
// reads as a leg count of two. Both readings are wrong, in opposite directions.
//
// WHAT THIS MODULE DOES NOT DO. It never drops a leg. Collapsing is reported — same canonical key,
// summed size, both source legs named — so the operator sees that two rows they configured are one
// order, and decides. Silently discarding configured state would be worse than the double count.

/** Canonical side names. BID = resting buy on the YES book, ASK = resting sell on the YES book. */
const SIDES = Object.freeze({ BID: 'BID', ASK: 'ASK' });

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Map one user-facing leg onto its canonical position on the YES book.
 *
 * @param {{ book:'yes'|'no', kind:'buy'|'sell', price:number }} leg
 * @returns {{ side:'BID'|'ASK', yesPrice:number, key:string, mirrored:boolean }|null}
 *          null when the leg is not describable (unknown book/kind, or no price) — the caller fails
 *          closed rather than guessing a side.
 */
function toCanonical(leg) {
  if (!leg) return null;
  const book = leg.book === 'yes' || leg.book === 'no' ? leg.book : null;
  const kind = leg.kind === 'buy' || leg.kind === 'sell' ? leg.kind : null;
  if (!book || !kind || !fin(leg.price)) return null;

  // On the NO token the price mirrors: a NO order at q is a YES order at 1 − q, and its side flips.
  const mirrored = book === 'no';
  const yesPrice = mirrored ? +(1 - leg.price).toFixed(6) : leg.price;
  const side = kind === 'buy'
    ? (mirrored ? SIDES.ASK : SIDES.BID)   // buy NO  ≡ sell YES ; buy YES ≡ bid
    : (mirrored ? SIDES.BID : SIDES.ASK);  // sell NO ≡ buy YES  ; sell YES ≡ ask

  return { side, yesPrice, key: `${side}@${yesPrice}`, mirrored };
}

/** Human, calm, Italian label for a canonical position — used inline when two legs collapse. */
function canonicalLabel(c) {
  if (!c) return '—';
  return c.side === SIDES.BID
    ? `acquisto YES a ${(c.yesPrice * 100).toFixed(1)}¢`
    : `vendita YES a ${(c.yesPrice * 100).toFixed(1)}¢`;
}

/**
 * Reduce a leg list to the canonical position set the book actually holds.
 *
 * @param {Array<{book,kind,price,size?,id?}>} legs
 * @returns {{
 *   positions: Array<{ side, yesPrice, key, sizeShares, legIds:Array, legCount:number, label:string }>,
 *   collapsed: Array<{ key, label, legCount, legIds:Array }>,   // groups where >1 leg is ONE position
 *   undescribable: number,                                      // legs that could not be mapped
 *   hasBid: boolean, hasAsk: boolean, twoSided: boolean
 * }}
 */
function canonicalize(legs) {
  const byKey = new Map();
  let undescribable = 0;

  for (const leg of legs || []) {
    const c = toCanonical(leg);
    if (!c) { undescribable++; continue; }
    const cur = byKey.get(c.key) || {
      side: c.side, yesPrice: c.yesPrice, key: c.key, sizeShares: 0, legIds: [], legCount: 0,
      label: canonicalLabel(c),
    };
    // Sizes ADD: two legs at one canonical level are two real orders resting at that level. Unknown
    // size contributes nothing rather than a stand-in — the caller shows "—" if it needs a total.
    if (fin(leg.size) && leg.size > 0) cur.sizeShares += leg.size;
    cur.legIds.push(leg.id ?? null);
    cur.legCount += 1;
    byKey.set(c.key, cur);
  }

  const positions = [...byKey.values()];
  const collapsed = positions
    .filter((p) => p.legCount > 1)
    .map((p) => ({ key: p.key, label: p.label, legCount: p.legCount, legIds: p.legIds }));
  const hasBid = positions.some((p) => p.side === SIDES.BID);
  const hasAsk = positions.some((p) => p.side === SIDES.ASK);

  return { positions, collapsed, undescribable, hasBid, hasAsk, twoSided: hasBid && hasAsk };
}

module.exports = { SIDES, toCanonical, canonicalize, canonicalLabel };

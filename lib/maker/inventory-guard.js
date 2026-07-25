'use strict';
// lib/maker/inventory-guard.js — the two position guards that stand between a plan and a venue reject
// (or a self-inflicted trade). PURE: no I/O, no chain call, no venue call. The caller supplies REAL
// measurements; this module only decides.
//
// ── GUARD 1 · A SELL NEEDS INVENTORY ────────────────────────────────────────────────────────────────
// Holding only collateral (pUSD), a SELL is not a naked short — it is an order to deliver an ERC-1155
// outcome token you must already own. With a zero balance the venue rejects it. There is a placeable
// order that expresses the same view: BUY the COMPLEMENTARY token at 1 − p (buying NO at 1 − p is
// selling YES at p — see lib/maker/canonical-position). So the block names that alternative instead of
// just refusing.
//
// FAIL CLOSED. A balance we could not read is NOT zero and is NOT "probably fine": an unreadable
// balance blocks the leg with its own reason code and renders "—". Never assume inventory, never
// default to a constant.
//
// ── GUARD 2 · YES + NO PRICED AT OR ABOVE $1 IS A SELF-MATCH ────────────────────────────────────────
// A YES and a NO share are together worth exactly $1 (the CTF pair can be split from, and merged back
// into, $1 of collateral). So resting a BUY YES at p and a BUY NO at q with p + q >= 1.00 is an offer
// to buy both halves of a $1 pair for $1 or more — the two orders are each other's counterparty and
// the operator pays the crossing for nothing.
//
// PROVENANCE OF THE RULE (honest labelling): the $1 pair identity is documented — Polymarket's CTF docs
// state "Split: Convert pUSD into a YES and NO token pair" and "Merge: Convert a YES and NO token pair
// back into pUSD" (docs.polymarket.com/developers/CTF/overview). What is NOT publicly documented is the
// matching engine's own behaviour: whether it mints a pair to cross the two orders, and whether any
// self-trade prevention exists. We checked the public CLOB API (no such field on /markets, no such
// endpoint) and three official doc pages (CLOB introduction, CLOB orders, CTF overview) and found
// nothing. So the guard stands on the pair identity, which IS documented, and the matching behaviour is
// carried in the report as DOCUMENTED-BUT-UNCONFIRMED. The guard refuses either way: an operator paying
// >= $1 for a $1 pair is a loss whether or not the venue is the one closing it.

const CODES = Object.freeze({
  NO_INVENTORY: 'NO_INVENTORY',                     // balance read, and it is zero
  INSUFFICIENT_INVENTORY: 'INSUFFICIENT_INVENTORY', // balance read, smaller than the order
  INVENTORY_UNREADABLE: 'INVENTORY_UNREADABLE',     // balance could not be read → fail closed
  SELF_MATCH_CROSS: 'SELF_MATCH_CROSS',             // BUY YES + BUY NO priced at or above $1
});

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** The complementary book, and the mirrored price that expresses the same position as a BUY. */
function complementary(book, price) {
  const other = book === 'yes' ? 'no' : 'yes';
  const mirrored = fin(price) ? +(1 - price).toFixed(6) : null;
  return { book: other, price: mirrored };
}

/**
 * GUARD 1 — decide one SELL leg against a measured balance.
 *
 * @param {{ book:'yes'|'no', price:number, size:number }} quote
 * @param {number|null} balanceShares  measured ERC-1155 balance for THAT book's token, in shares.
 *                                     null/undefined/non-finite ⇒ unreadable ⇒ blocked.
 * @returns {{ blocked:boolean, code:string|null, reason:string|null, alternative:object|null }}
 */
function checkSellInventory(quote, balanceShares) {
  const q = quote || {};
  const alt = complementary(q.book, q.price);
  const altText = alt.price != null
    ? `l'ordine equivalente che puoi immettere con i soli pUSD è comprare ${alt.book.toUpperCase()} a ${(alt.price * 100).toFixed(1)}¢`
    : 'l\'ordine equivalente è un acquisto sul token complementare';

  if (!fin(balanceShares)) {
    return {
      blocked: true,
      code: CODES.INVENTORY_UNREADABLE,
      reason: `saldo del token ${String(q.book).toUpperCase()} non leggibile: non si può vendere un token che non si è potuto contare, quindi la riga è bloccata (fail closed). ${altText}.`,
      alternative: alt,
    };
  }
  if (balanceShares <= 0) {
    return {
      blocked: true,
      code: CODES.NO_INVENTORY,
      reason: `non possiedi token ${String(q.book).toUpperCase()}: una vendita consegna il token, quindi il venue la rifiuta. ${altText}.`,
      alternative: alt,
    };
  }
  if (fin(q.size) && balanceShares < q.size) {
    return {
      blocked: true,
      code: CODES.INSUFFICIENT_INVENTORY,
      reason: `possiedi ${balanceShares} token ${String(q.book).toUpperCase()} contro i ${q.size} dell'ordine: il venue rifiuta la parte scoperta, quindi la riga è bloccata. ${altText}.`,
      alternative: alt,
    };
  }
  return { blocked: false, code: null, reason: null, alternative: null };
}

/**
 * GUARD 2 — find BUY YES / BUY NO pairs whose prices reach or cross $1.
 *
 * @param {Array<{book,kind,price,id?}>} quotes
 * @returns {Array<{ code, sum, yesPrice, noPrice, legIds:Array, reason:string }>}
 */
function findSelfMatches(quotes) {
  // Identity is POSITIONAL, not by leg id: legs may legitimately carry a null id (a plan built from
  // controls that were never saved), and matching on null would blame unrelated rows.
  const idx = (quotes || []).map((q, i) => ({ q, i }));
  const buysYes = idx.filter(({ q }) => q.book === 'yes' && q.kind === 'buy' && fin(q.price));
  const buysNo  = idx.filter(({ q }) => q.book === 'no'  && q.kind === 'buy' && fin(q.price));
  const out = [];
  for (const y of buysYes) {
    for (const n of buysNo) {
      const sum = +(y.q.price + n.q.price).toFixed(6);
      if (sum >= 1) {
        out.push({
          code: CODES.SELF_MATCH_CROSS,
          sum,
          yesPrice: y.q.price,
          noPrice: n.q.price,
          indices: [y.i, n.i],
          legIds: [y.q.id ?? null, n.q.id ?? null],
          reason: `comprare YES a ${(y.q.price * 100).toFixed(1)}¢ e NO a ${(n.q.price * 100).toFixed(1)}¢ significa pagare ${(sum * 100).toFixed(1)}¢ per una coppia che vale esattamente 100¢: i due ordini sono l'uno la controparte dell'altro e la coppia si incrocia con sé stessa. Allarga la distanza dal medio finché la somma resta sotto 100¢.`,
        });
      }
    }
  }
  return out;
}

/**
 * Apply both guards to a planned quote set. Returns the quotes with `postable` turned OFF where a guard
 * blocks, each carrying a machine-readable code and a plain-Italian reason. This is a REAL gate in the
 * construction chain — a blocked leg is not postable, whatever the planner thought.
 *
 * @param {object} args
 *   quotes    the planned quotes (mutated copies are returned, input is not modified)
 *   balances  { yes: number|null, no: number|null } measured ERC-1155 balances in SHARES.
 *             Omit entirely ⇒ every balance is unreadable ⇒ every SELL is blocked (fail closed).
 * @returns {{ quotes:Array, sellBlocks:Array, selfMatches:Array, blockedCount:number }}
 */
function applyPositionGuards({ quotes, balances } = {}) {
  const bal = balances || {};
  const selfMatches = findSelfMatches(quotes || []);

  const sellBlocks = [];
  const out = (quotes || []).map((q, i) => {
    const copy = { ...q };

    if (q.kind === 'sell') {
      const bookBal = q.book === 'no' ? bal.no : bal.yes;
      const v = checkSellInventory(q, bookBal);
      copy.inventoryGuard = v;
      if (v.blocked) {
        sellBlocks.push({ legId: q.id ?? null, book: q.book, price: q.price, size: q.size, code: v.code, reason: v.reason, alternative: v.alternative });
        copy.postable = false;
        copy.reason = v.reason;
      }
    }

    // A crossed pair is refused on BOTH legs — the pair is the problem, not one side of it.
    const sm = selfMatches.find((s) => s.indices.includes(i));
    if (sm) {
      copy.selfMatch = { code: sm.code, sum: sm.sum, reason: sm.reason };
      copy.postable = false;
      copy.reason = sm.reason;
    }

    return copy;
  });

  return {
    quotes: out,
    sellBlocks,
    selfMatches,
    blockedCount: out.filter((q, i) => (quotes[i] || {}).postable && !q.postable).length,
  };
}

module.exports = { CODES, checkSellInventory, findSelfMatches, applyPositionGuards, complementary };

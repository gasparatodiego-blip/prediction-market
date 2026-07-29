'use strict';
// lib/maker/order-validate.js — ask the EXCHANGE ITSELF whether a signed order is valid, before sending it.
//
// CTFExchangeV2.validateOrder(order) is a `view` function that REVERTS on any invalid order and returns
// nothing on a valid one. Calling it is an eth_call: it executes against current chain state, changes
// nothing, costs nothing, and submits no transaction. That makes it the one check that can tell us
// "the venue's own validator accepts this exact signed struct" WITHOUT placing anything.
//
// WHAT IT PROVES: the signature is valid for the declared (maker, signer, signatureType) triple, the
// order struct is well-formed, and the exchange's own rules accept it. This is how signatureType 3 was
// established for this account (types 1 and 2 reverted, 3 was accepted) — the venue decided, not us.
//
// WHAT IT DOES NOT PROVE: it is NOT a balance or allowance check in the way an operator might hope. An
// order can validate here and still fail to SETTLE if the maker's pUSD allowance to the exchange is
// zero. Treat a PASS as "correctly signed and well-formed", never as "will fill".
//
// Read-only: no key, no signing, no submission. The provider is created and destroyed per call so the
// adapter holds no long-lived socket.

const { EXCHANGES } = require('../poly-contracts');

// The v2 Order tuple, in the exact field order the exchange's ABI declares. Mirrored from the SDK's
// signed-order shape (@polymarket/clob-client-v2) — the SAME tuple scripts/maker-signing-proof.ts uses.
const VALIDATE_ABI = [
  'function validateOrder((uint256,address,address,uint256,uint256,uint256,uint8,uint8,uint256,bytes32,bytes32,bytes)) view',
];

/** The exchange a given order settles against. negRisk orders go to the neg-risk exchange, not the CTF one. */
function exchangeForOrder(negRisk) {
  const key = negRisk ? 'negRiskExchange' : 'ctfExchange';
  const found = EXCHANGES.find((e) => e.key === key);
  if (!found) throw new Error(`order-validate: no exchange address for key '${key}'`);
  return found;
}

/**
 * Build the ABI tuple from a signed v2 order. Pure — no network.
 * `side` arrives from the SDK as 'BUY'|'SELL' (or already 0|1); the ABI wants uint8 0=BUY, 1=SELL.
 */
function orderToTuple(order) {
  if (!order || typeof order !== 'object') throw new Error('order-validate: no order to validate');
  const side = order.side === 'BUY' || order.side === 0 ? 0 : 1;
  const required = ['salt', 'maker', 'signer', 'tokenId', 'makerAmount', 'takerAmount', 'signatureType', 'timestamp', 'metadata', 'builder', 'signature'];
  for (const f of required) {
    if (order[f] === undefined || order[f] === null) throw new Error(`order-validate: signed order is missing '${f}' — refusing to validate a partial struct`);
  }
  return [
    order.salt, order.maker, order.signer, order.tokenId, order.makerAmount, order.takerAmount,
    side, order.signatureType, order.timestamp, order.metadata, order.builder, order.signature,
  ];
}

/**
 * Ask the exchange to validate a signed order. NEVER throws on a rejection — a revert is an ANSWER
 * ("invalid"), not a failure of this function. It returns a verdict object so the caller can decide.
 *
 *   { valid, exchange, reason }
 *     valid   true  = the exchange accepted the struct
 *             false = the exchange REVERTED (reason carries the revert text)
 *             null  = we could not ask (RPC down / ethers missing) — NOT the same as invalid, and the
 *                     caller must fail closed on it rather than read it as a pass.
 *
 * @param {object} order      a SIGNED v2 order (the object client.createOrder returned)
 * @param {object} opts       { negRisk, rpcUrl, provider }
 */
async function validateSignedOrder(order, opts = {}) {
  const ex = exchangeForOrder(opts.negRisk === true);
  let tuple;
  try {
    tuple = orderToTuple(order);
  } catch (e) {
    return { valid: null, exchange: ex, reason: `could not build the validation tuple: ${e.message}` };
  }

  let ethers;
  try { ethers = require('ethers'); }
  catch { return { valid: null, exchange: ex, reason: 'ethers is not available in this runtime — cannot ask the exchange' }; }

  const { JsonRpcProvider, Contract } = ethers;
  const ownProvider = !opts.provider;
  const provider = opts.provider || new JsonRpcProvider(opts.rpcUrl || require('../poly-contracts').DEFAULT_RPC, 137);
  try {
    const c = new Contract(ex.addr, VALIDATE_ABI, provider);
    await c.validateOrder(tuple);
    return { valid: true, exchange: ex, reason: null };
  } catch (e) {
    const msg = String((e && (e.shortMessage || e.reason || e.message)) || e);
    // Distinguish "the exchange said no" from "we could not reach the exchange". Reading an RPC outage
    // as an invalid order would be wrong in the safe direction here, but reading it as VALID would be
    // wrong in the dangerous one — so an unreachable node returns null and the caller fails closed.
    const isRevert = /revert|execution reverted|CALL_EXCEPTION/i.test(msg);
    if (isRevert) return { valid: false, exchange: ex, reason: msg.slice(0, 200) };
    return { valid: null, exchange: ex, reason: `could not reach the exchange to validate: ${msg.slice(0, 160)}` };
  } finally {
    if (ownProvider) { try { provider.destroy(); } catch { /* already closed */ } }
  }
}

module.exports = { validateSignedOrder, orderToTuple, exchangeForOrder, VALIDATE_ABI };

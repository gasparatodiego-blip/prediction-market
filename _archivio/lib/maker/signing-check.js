'use strict';
// lib/maker/signing-check.js — re-prove OFFLINE, at arming time, that the maker can sign a VALID order
// for the funder. This is the exact recipe of scripts/maker-signing-proof.ts, factored so the preflight
// can run it live (never a cached flag) before it lets anyone arm. It SIGNS locally and SUBMITS NOTHING:
// createOrder() signs in-process; no order, no transaction, no fund movement.
//
// Requirable from PLAIN NODE (js): it loads the signing key straight from Prisma + the JS key-custody
// vault (no .ts import), pulls a live market over HTTP, dynamic-imports the ESM v2 SDK, and recovers the
// signature with ethers. The private key is decrypted, handed to the signing signer, scrubbed — never
// logged, never returned.
//
// TWO WAYS TO PROVE ONE SIGNATURE. A self-custody / proxy account signs with a plain 65-byte ECDSA
// signature, which ecrecover verifies locally. A smart-contract-wallet account (signatureType 3,
// POLY_1271) does not: the SDK emits an ERC-7739 wrapped signature that no local recover can unwrap. So
// the check accepts EITHER proof — ecrecover, or the exchange's own validateOrder() via eth_call — and
// reports which one carried it. It stays fail-closed: an explicit revert fails outright, and a signature
// that neither method could prove fails too.

const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' },
    { name: 'tokenId', type: 'uint256' }, { name: 'makerAmount', type: 'uint256' }, { name: 'takerAmount', type: 'uint256' },
    { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' }, { name: 'timestamp', type: 'uint256' },
    { name: 'metadata', type: 'bytes32' }, { name: 'builder', type: 'bytes32' },
  ],
};
const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

/**
 * @param {object} args prisma (required), env (defaults process.env), fetchImpl (defaults global fetch)
 * @returns {Promise<{pass:boolean, recovered:(string|null), maker:(string|null), signer:(string|null),
 *                     funder:(string|null), custodyAddress:(string|null), detail:string}>}
 */
async function proveSigningOffline({ prisma, env = process.env, fetchImpl } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return { pass: false, recovered: null, maker: null, signer: null, funder: null, custodyAddress: null, detail: 'no fetch available in this runtime' };
  if (!prisma) return { pass: false, recovered: null, maker: null, signer: null, funder: null, custodyAddress: null, detail: 'no prisma client supplied' };

  const { resolveFunder } = require('../venues/polymarket-clob-maker/funder');
  const { signingSignerFromKey } = require('../venues/polymarket-clob-maker/signer');
  const { verifyTypedData, getAddress } = require('ethers');
  const { unwrapDek, decryptField } = require('../key-custody');

  const funder = resolveFunder(env); // throws on a half-configured funder — the safe direction

  // Load the maker signing key (polymarket-maker row) directly — Prisma + the JS key-custody vault.
  const row = await prisma.exchangeKey.findFirst({ where: { venue: 'polymarket-maker', revokedAt: null }, orderBy: { createdAt: 'desc' } });
  if (!row || !row.apiSecretEnc || !row.accountAddress) return { pass: false, recovered: null, maker: null, signer: null, funder: funder.funderAddress || null, custodyAddress: null, detail: 'no active polymarket-maker signing key stored' };
  const dek = unwrapDek(row.dekEnc, row.kekVersion);
  let privateKey, custodyAddress;
  try { privateKey = decryptField(row.apiSecretEnc, dek); custodyAddress = row.accountAddress; } finally { dek.fill(0); }
  const handle = signingSignerFromKey(privateKey);

  try {
    // A live market currently accepting orders → a real order struct to sign.
    const r = await f(`${HOST}/sampling-simplified-markets`).then((x) => x.json());
    const m = (r.data || []).find((x) => x.active && !x.closed && x.accepting_orders && Array.isArray(x.tokens) && x.tokens[0] && x.tokens[0].token_id);
    if (!m) return { pass: false, recovered: null, maker: null, signer: null, funder: funder.funderAddress || null, custodyAddress, detail: 'no live market accepting orders to build a probe order' };
    const tokenId = m.tokens[0].token_id;
    const tickJson = await f(`${HOST}/tick-size?token_id=${tokenId}`).then((x) => x.json());
    const negJson = await f(`${HOST}/neg-risk?token_id=${tokenId}`).then((x) => x.json());
    const tickSize = String(tickJson.minimum_tick_size);
    const negRisk = negJson.neg_risk === true;
    // Far below mid, minimum size — even a catastrophic misuse could only rest harmlessly. Nothing is sent.
    const price = Math.max(Number(tickSize), Math.round((Number(m.tokens[0].price) / 4) / Number(tickSize)) * Number(tickSize));

    const { ClobClient, getContractConfig } = await import('@polymarket/clob-client-v2');
    const cfg = getContractConfig(CHAIN_ID);
    const exchange = getAddress(negRisk ? cfg.negRiskExchangeV2 : cfg.exchangeV2);
    const client = new ClobClient({ host: HOST, chain: CHAIN_ID, signer: handle.signer, creds: { key: 'unused-signing-only', secret: 'unused-signing-only', passphrase: 'unused-signing-only' }, signatureType: funder.signatureType, funderAddress: funder.funderAddress });
    const order = await client.createOrder({ tokenID: tokenId, price, size: 20, side: 'BUY' }, { tickSize, negRisk });

    const makerOk = order.maker.toLowerCase() === (funder.funderAddress || handle.address).toLowerCase();
    const signerShouldBe = funder.signatureType === 3 ? funder.funderAddress : handle.address;
    const signerOk = order.signer.toLowerCase() === String(signerShouldBe).toLowerCase();

    // ── PROOF 1: ecrecover, when the signature is a plain 65-byte ECDSA one ──────────────────────────
    const signatureBytes = typeof order.signature === 'string' ? (order.signature.length - 2) / 2 : null;
    const recoverable = signatureBytes === 65;
    let recovered = null, recoverOk = false;
    if (recoverable) {
      const value = { salt: order.salt, maker: order.maker, signer: order.signer, tokenId: order.tokenId, makerAmount: order.makerAmount, takerAmount: order.takerAmount, side: order.side === 'BUY' ? 0 : 1, signatureType: order.signatureType, timestamp: order.timestamp, metadata: order.metadata, builder: order.builder };
      recovered = verifyTypedData({ name: 'Polymarket CTF Exchange', version: '2', chainId: CHAIN_ID, verifyingContract: exchange }, ORDER_TYPES, value, order.signature);
      recoverOk = recovered.toLowerCase() === handle.address.toLowerCase();
    }

    // ── PROOF 2: ask the exchange itself ─────────────────────────────────────────────────────────────
    // A smart-contract-wallet account (signatureType 3, POLY_1271) does NOT produce an ECDSA signature:
    // the SDK takes a different branch for POLY_1271 and emits an ERC-7739 wrapped signature (~317 bytes)
    // that no local ecrecover can unwrap. Treating that as `recover BAD` was a FALSE NEGATIVE — it
    // reported "the key cannot sign" for an account whose signatures the venue accepts, and it held the
    // whole preflight red (and therefore arming blocked) for a defect that did not exist.
    //
    // "Cannot verify locally" is not "invalid". The verdict that IS available is the venue's own:
    // validateOrder() is a `view` function, so asking costs an eth_call and submits nothing. This calls
    // the SHARED validator (lib/maker/order-validate) — the same function the placement path runs before
    // every send, routed to the neg-risk exchange when the market is neg-risk. No second implementation.
    let onChain = { valid: null, exchange: null, reason: 'not asked' };
    try {
      const { validateSignedOrder } = require('./order-validate');
      onChain = await validateSignedOrder(order, { negRisk });
    } catch (e) {
      onChain = { valid: null, exchange: null, reason: `could not run the on-chain validation: ${(e && e.message) || String(e)}` };
    }

    // STILL FAIL-CLOSED, and never weaker than before:
    //   • an explicit REVERT from the venue's validator is a definitive no — it fails, whatever ecrecover said;
    //   • otherwise the signature must be PROVEN by one of the two methods. "Could not ask" (valid===null)
    //     proves nothing, so a wrapped signature with an unreachable RPC still fails.
    // The only behaviour that changed is the one that was wrong: a wrapped signature the exchange ACCEPTS
    // now passes, instead of being reported as a mismatch.
    const proven = recoverOk === true || onChain.valid === true;
    const pass = onChain.valid === false ? false : (makerOk && signerOk && proven);
    const provenBy = !pass ? null : (recoverOk ? 'ecrecover' : 'on-chain validateOrder');

    const exchangeName = (onChain.exchange && onChain.exchange.name) || 'the exchange';
    let detail;
    if (!makerOk || !signerOk) {
      detail = `MISMATCH (maker ${makerOk ? 'ok' : 'BAD'}, signer ${signerOk ? 'ok' : 'BAD'})`;
    } else if (onChain.valid === false) {
      detail = `${exchangeName}.validateOrder() REVERTED for this signed order: ${onChain.reason}`;
    } else if (recoverOk) {
      detail = 'recover == custody signer, maker == funder';
    } else if (onChain.valid === true) {
      detail = `ERC-7739 wrapped signature (${signatureBytes} bytes) — not recoverable by ecrecover, accepted on-chain by ${exchangeName}.validateOrder() (eth_call, nothing submitted)`;
    } else {
      detail = `signature not proven: ${recoverable ? 'ecrecover did not match the custody signer' : `wrapped (${signatureBytes} bytes), so not locally recoverable`}, and the on-chain check could not be run (${onChain.reason})`;
    }

    return {
      pass, recovered, maker: order.maker, signer: order.signer, funder: funder.funderAddress || null, custodyAddress,
      // Additive fields — the preflight reads `pass`/`recovered`/`detail` as before.
      signatureBytes, recoverable, provenBy,
      onChain: { valid: onChain.valid, exchange: (onChain.exchange && onChain.exchange.name) || null, reason: onChain.reason },
      detail,
    };
  } finally {
    handle.scrub();
  }
}

module.exports = { proveSigningOffline };

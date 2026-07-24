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
    let recovered = null, recoverOk = false;
    if (typeof order.signature === 'string' && order.signature.length === 132) {
      const value = { salt: order.salt, maker: order.maker, signer: order.signer, tokenId: order.tokenId, makerAmount: order.makerAmount, takerAmount: order.takerAmount, side: order.side === 'BUY' ? 0 : 1, signatureType: order.signatureType, timestamp: order.timestamp, metadata: order.metadata, builder: order.builder };
      recovered = verifyTypedData({ name: 'Polymarket CTF Exchange', version: '2', chainId: CHAIN_ID, verifyingContract: exchange }, ORDER_TYPES, value, order.signature);
      recoverOk = recovered.toLowerCase() === handle.address.toLowerCase();
    } else {
      // ERC-1271/7739 wrapped: not ECDSA, nothing to ecrecover locally. On-chain validateOrder is the real
      // verdict there — out of the preflight's read-only scope, so we do not claim a recover MATCH.
      recoverOk = false;
    }
    const pass = makerOk && signerOk && recoverOk;
    return {
      pass, recovered, maker: order.maker, signer: order.signer, funder: funder.funderAddress || null, custodyAddress,
      detail: pass ? 'recover == custody signer, maker == funder' : `MISMATCH (maker ${makerOk ? 'ok' : 'BAD'}, signer ${signerOk ? 'ok' : 'BAD'}, recover ${recoverOk ? 'ok' : 'BAD'})`,
    };
  } finally {
    handle.scrub();
  }
}

module.exports = { proveSigningOffline };

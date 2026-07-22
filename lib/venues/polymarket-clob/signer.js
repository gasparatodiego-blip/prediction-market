'use strict';
// lib/venues/polymarket-clob/signer.js — the ADDRESS-ONLY signer the cancel adapter runs with.
//
// Verified from the clob-client source: the L2 path (getOpenOrders / cancelOrder / cancelMarketOrders)
// builds its request signature as an HMAC over the API SECRET (buildPolyHmacSignature) and consults the
// signer ONLY for the POLY_ADDRESS header, via getSignerAddress(signer) → signer.getAddress(). It never
// asks the signer to SIGN anything. L1 ops (createApiKey / deriveApiKey / signing an order) call
// signer._signTypedData(...).
//
// So we hand the client a signer that can return its address and PHYSICALLY CANNOT sign: getAddress()
// returns the stored public address; _signTypedData throws. This is not a policy — it is a structural
// guarantee. With this signer the client can cancel and read, and it is INCAPABLE of deriving a key or
// signing an order (both of which are the fund/exposure-capable L1 operations). It also means the raw
// private key is never present at cancel time — there is nothing here that could hold one.
//
// clob-client detects an ethers-v5-style typed-data signer by the presence of `_signTypedData`, so we
// expose that name (as a throwing stub) to be routed down the ethers path, whose address read is a
// plain getAddress().

/**
 * @param {string} address  the wallet's public 0x address (from ExchangeKey.accountAddress, plaintext)
 * @returns a signer object usable ONLY for the L2 address header; every signing attempt throws.
 */
function addressOnlySigner(address) {
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error('addressOnlySigner: a 0x40-hex wallet address is required');
  }
  const addr = address;
  return {
    getAddress: async () => addr,
    // Present so the client routes to the ethers typed-data path (address read), but it can never sign.
    _signTypedData: () => {
      throw new Error('addressOnlySigner cannot sign — this adapter is cancel-only (no L1 signing, no order placement, no key derivation)');
    },
  };
}

module.exports = { addressOnlySigner };

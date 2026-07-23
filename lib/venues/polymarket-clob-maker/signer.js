'use strict';
// lib/venues/polymarket-clob-maker/signer.js — the SIGNING signer for the maker adapter.
//
// This is the ONE place in the whole project that constructs a signer CAPABLE of an L1 EIP-712
// signature (= placing an order). It is the deliberate opposite of the cancel adapter's
// addressOnlySigner (which throws on every signing attempt). It exists in its OWN module, under the
// isolated maker adapter, so the cancel adapter's structural "cannot place" guarantee is untouched.
//
// KEY HANDLING (verified against the clob-client source):
//   • Placement path: createOrder → canL1Auth → orderBuilder.buildOrder → signer._signTypedData(...).
//     So an order can only be signed by a signer that can _signTypedData — i.e. one holding the raw
//     wallet private key. ethers v6 exposes `signTypedData`; clob-client detects an ethers-v5 signer by
//     the presence of `_signTypedData`, so we shim it (exactly as scripts/polymarket-derive-creds.ts).
//     CLOB v2 keeps this contract: its ClobSigner = EthersSigner ({ _signTypedData, getAddress }) | viem
//     WalletClient, so this SAME signer object is accepted by the v2 client unchanged (no v2 edit needed).
//   • The raw private key lives ONLY inside the ethers Wallet instance, for the lifetime the engine is
//     armed. We never copy it into a plain string field, never log it, never put it in an error, never
//     write it to the audit trail. On disarm the engine drops the Signer reference and the Wallet is
//     GC-eligible. HONEST LIMITATION: a JS string is immutable — we cannot memset-zero the key bytes;
//     we minimise their lifetime and references and rely on GC. This is documented, not hidden.
//
// A signing signer is constructed ONLY on an armed (live-min/live) mutating path. In paper/off the
// adapter dry-runs and never calls the signerProvider, so no key is ever loaded (a second belt,
// independent of arming — mirrors the cancel adapter's throwing creds provider).

let _Wallet = null;
function getWallet() {
  if (_Wallet) return _Wallet;
  // ethers is already a dependency (used by scripts/polymarket-derive-creds.ts). Lazy so importing this
  // module costs nothing until a signer is actually built on an armed path.
  _Wallet = require('ethers').Wallet;
  return _Wallet;
}

/**
 * Build a signing signer from a raw private key. Returns { signer, address, scrub }.
 *   signer  — the object handed to ClobClient: getAddress() + _signTypedData() (shim → v6 signTypedData).
 *   address — the wallet's public 0x address (non-secret).
 *   scrub   — drop internal references so the Wallet/key becomes GC-eligible. Best-effort (JS strings
 *             cannot be zeroed); call on disarm.
 *
 * Throws on a malformed key. NEVER echoes the key in the error (ethers' own error could — we replace it).
 */
function signingSignerFromKey(privateKey) {
  if (typeof privateKey !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error('signingSignerFromKey: a 0x-prefixed 64-hex private key is required (env/custody only, never a literal)');
  }
  const Wallet = getWallet();
  let wallet;
  try {
    wallet = new Wallet(privateKey);
  } catch (e) {
    // Never surface ethers' raw message (it can include the offending key). Message-free.
    throw new Error('signingSignerFromKey: ethers rejected the private key (malformed) — no detail logged to avoid echoing key material');
  }
  const address = wallet.address;
  const signer = {
    getAddress: async () => address,
    // clob-client routes to the ethers path on the presence of _signTypedData; v6 uses signTypedData.
    _signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value),
  };
  const scrub = () => {
    // Drop our references so the Wallet (which holds the key) is GC-eligible. We cannot zero the bytes
    // of an immutable JS string — documented limitation.
    wallet = null;
    signer.getAddress = async () => { throw new Error('signer scrubbed (disarmed)'); };
    signer._signTypedData = () => { throw new Error('signer scrubbed (disarmed)'); };
  };
  return { signer, address, scrub };
}

module.exports = { signingSignerFromKey };

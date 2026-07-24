'use strict';
// lib/venues/polymarket-clob-maker/funder.js — resolve WHO the maker signs FOR.
//
// A Polymarket account is two addresses, not one:
//   SIGNER — the EOA whose private key sits in custody. It signs; it holds nothing.
//   FUNDER — the on-chain wallet that actually holds the pUSD and the CTF outcome tokens. This is the
//            `maker` field of every order and the address the venue settles against.
// When the two differ, an order signed as a bare EOA (signatureType 0, maker == signer) is rejected by
// the exchange, because the signer has no collateral. The order must declare maker = funder and carry a
// signatureType that tells the exchange HOW to prove the signer is entitled to spend the funder's money.
//
// VERIFIED ON-CHAIN (2026-07-24, Polygon mainnet — read-only eth_call, nothing submitted):
//   CTFExchangeV2 0xE111180000d2663C0091e4f400237545B87B996B .getProxyWalletAddress(SIGNER) → the FUNDER
//   and the same for NegRiskCtfExchangeV2. Both exchanges report proxyFactory 0xaB45c5A4B0c941a2F231C04C3f49182e1A254052
//   and proxyImplementation 0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f ("ProxyWallet") — which is exactly
//   the implementation the funder's EIP-1167 clone bytecode points at. The exchange's own `validateOrder`
//   (a `view` function that reverts on an invalid order) then PASSED for signatureType 1 and REVERTED for
//   both 0 and 3. So the signature type is not a guess: the venue's own validator decided it.
//
// The type is per-ACCOUNT, not per-project — a Polymarket account created through email/Magic before the
// 2026-06-29 deposit-wallet migration is a ProxyWallet (type 1, an EIP-1167 clone with NO isValidSignature,
// so ERC-1271 / type 3 CANNOT work on it); a newer deposit wallet is a Solady ERC1967 contract that
// verifies via ERC-1271 (type 3). That is why this is CONFIGURATION, read from the environment and
// verified against the chain by scripts/maker-wallet-preflight.ts — never a constant compiled into the code.
//
// Pure and side-effect free: no network, no key, no I/O. ethers is required lazily (only to checksum an
// address), so importing this module costs nothing.

// SignatureTypeV2, mirrored from @polymarket/clob-client-v2 (dist/order-utils/model/signatureTypeV2.d.ts).
// Mirrored rather than imported because that package is ESM-only and this module must stay require()-able
// from the CJS adapter; the values are consensus-critical and frozen on-chain, so they cannot drift.
const SIGNATURE_TYPES = Object.freeze({
  EOA: 0,              // signer IS the maker — self-custody wallet, no funder
  POLY_PROXY: 1,       // EOA owns a Polymarket ProxyWallet (pre-2026-06-29 email/Magic accounts)
  POLY_GNOSIS_SAFE: 2, // EOA owns a Polymarket Gnosis safe
  POLY_1271: 3,        // smart-contract wallet verifying via ERC-1271 (post-migration deposit wallets)
});
const VALID_TYPES = Object.freeze([0, 1, 2, 3]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Resolve the maker's funder + signature type from configuration.
 *
 * @param {object} env  process.env (injected so this stays pure and unit-testable)
 *   MAKER_FUNDER_ADDRESS   the funder/proxy wallet that holds the collateral
 *   MAKER_SIGNATURE_TYPE   0|1|2|3 — how the exchange proves signer→funder entitlement
 * @returns {{ signatureType:number, funderAddress:(string|undefined), source:string }}
 *
 * FAIL CLOSED. Every ambiguous combination THROWS rather than guessing, because each wrong guess is an
 * order the venue rejects at best, and at worst an order that settles against the wrong account:
 *   • a funder with no declared type       → throw (we will not assume 1 just because it is common)
 *   • a non-EOA type with no funder        → throw (nothing to name as maker)
 *   • type 0 together with a funder        → throw (contradiction: type 0 means maker == signer)
 *   • a malformed address / unknown type   → throw
 * The ONE non-throwing default is "neither configured" → self-custody EOA (type 0, no funder), which is
 * the SDK's own default and the behaviour this adapter had before funder support existed.
 */
function resolveFunder(env = {}) {
  const rawAddr = typeof env.MAKER_FUNDER_ADDRESS === 'string' ? env.MAKER_FUNDER_ADDRESS.trim() : '';
  const rawType = typeof env.MAKER_SIGNATURE_TYPE === 'string' ? env.MAKER_SIGNATURE_TYPE.trim() : '';

  if (!rawAddr && !rawType) return { signatureType: SIGNATURE_TYPES.EOA, funderAddress: undefined, source: 'unset (self-custody EOA)' };

  if (rawAddr && !ADDRESS_RE.test(rawAddr)) throw new Error('resolveFunder: MAKER_FUNDER_ADDRESS is not a 0x-prefixed 40-hex address — refusing to sign for an unparseable funder');
  if (rawAddr && !rawType) throw new Error('resolveFunder: MAKER_FUNDER_ADDRESS is set but MAKER_SIGNATURE_TYPE is not — the exchange proves signer→funder entitlement differently per account type (1 = ProxyWallet, 2 = Gnosis safe, 3 = ERC-1271 deposit wallet); verify yours with scripts/maker-wallet-preflight.ts and set it explicitly.');

  const signatureType = Number(rawType);
  if (!Number.isInteger(signatureType) || !VALID_TYPES.includes(signatureType)) throw new Error(`resolveFunder: MAKER_SIGNATURE_TYPE='${rawType}' is not one of ${VALID_TYPES.join('|')} (0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE, 3=POLY_1271)`);
  if (signatureType !== SIGNATURE_TYPES.EOA && !rawAddr) throw new Error(`resolveFunder: MAKER_SIGNATURE_TYPE=${signatureType} names a funder-backed account but MAKER_FUNDER_ADDRESS is unset — there is no address to place in the order's maker field`);
  if (signatureType === SIGNATURE_TYPES.EOA && rawAddr) throw new Error('resolveFunder: MAKER_SIGNATURE_TYPE=0 (EOA) means maker == signer, but MAKER_FUNDER_ADDRESS names a different maker — refusing this contradiction');

  if (signatureType === SIGNATURE_TYPES.EOA) return { signatureType, funderAddress: undefined, source: 'env (explicit EOA)' };

  // Checksum the address. ethers is required LAZILY so this module stays free to import.
  let funderAddress;
  try { funderAddress = require('ethers').getAddress(rawAddr); }
  catch { throw new Error('resolveFunder: MAKER_FUNDER_ADDRESS failed checksum validation — a mistyped funder is an order signed for someone else'); }

  return { signatureType, funderAddress, source: 'env' };
}

/**
 * The address the VENUE keys this account by — positions, balances and settlement all belong to the
 * funder when one is configured, and to the signer only in the self-custody case. Querying the public
 * data-api with the signer address on a proxy account is not an error; it silently returns [], which is
 * indistinguishable from "no positions" and is exactly how a maker ends up blind to its own inventory.
 */
function venueAccountAddress(funder, signerAddress) {
  return (funder && funder.funderAddress) || signerAddress;
}

module.exports = { resolveFunder, venueAccountAddress, SIGNATURE_TYPES, VALID_TYPES };

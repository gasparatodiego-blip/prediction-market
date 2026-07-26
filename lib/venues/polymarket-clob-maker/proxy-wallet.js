'use strict';
// lib/venues/polymarket-clob-maker/proxy-wallet.js — resolve the FUNDER/PROXY wallet for a SIGNER EOA.
//
// A Polymarket account opened with email/Magic is TWO addresses (see funder.js): the SIGNER EOA holds
// the private key and signs but holds no funds; the PROXY wallet is the on-chain contract that actually
// holds the pUSD collateral and CTF outcome tokens and is the `maker`/settlement address the exchange
// uses. This module answers "given a signer, what is its proxy?" — programmatically, from primary source.
//
// PRIMARY SOURCE — the exchange's own proxy-factory mapping, read on-chain (read-only eth_call, nothing
// submitted): CTFExchangeV2.getProxyWalletAddress(signer) → the funder. Verified 2026-07-26 on Polygon
// mainnet: for signer 0xd36b…a7A0 it returns 0x54C0…eAe0, which equals the address polymarket.com shows
// as "your Polymarket wallet address" and which holds the collateral. That EQUALITY is the proof the
// derivation is right — it is asserted by scripts/maker-store-proxy.ts before anything is persisted.
//
// DO NOT switch this to the deposit-wallet factory's predictWalletAddress(): that returns a DIFFERENT,
// undeployed address for pre-2026-06-29 email/Magic accounts (this account was created 2025-12-26), so
// it would name a wallet that holds nothing. The exchange's getProxyWalletAddress is the correct mapping
// for ProxyWallet (signatureType 1) accounts and is what this module uses.
//
// The profile API (GET https://polymarket.com/api/profile/userData?address=<signer> → proxyWallet) is a
// documented cross-check: unauthenticated, instant, and returns the same address. We resolve on-chain and
// CONFIRM against the profile API when reachable, rather than trusting either alone.
//
// Read-only. This module holds no key, signs nothing, submits nothing. ethers/provider are injected so it
// stays testable; require()-able from CJS (the adapter and the preflight both consume it).

const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// getProxyWalletAddress lives on BOTH exchanges and reports the same factory; the canonical CTF exchange
// (EXCHANGES[0]) is the one we read. Imported from the single contract-address list so it cannot drift.
const { EXCHANGES } = require('../../poly-contracts');
const PROXY_ABI = ['function getProxyWalletAddress(address) view returns (address)'];

function isNonZeroAddress(a) {
  return typeof a === 'string' && ADDRESS_RE.test(a) && a.toLowerCase() !== ZERO.toLowerCase();
}

/**
 * Read the proxy for a signer from the exchange's proxy-factory mapping. Returns a checksummed address,
 * or null when the exchange reports the zero address (this signer controls no proxy — a self-custody EOA).
 * Throws only on a genuine RPC/parse failure, never returns a fabricated address.
 * @param {string} signer  the signer EOA
 * @param {import('ethers').Provider} provider
 */
async function resolveProxyOnChain(signer, provider) {
  if (!ADDRESS_RE.test(String(signer || ''))) throw new Error('resolveProxyOnChain: signer is not a 0x-40-hex address');
  if (!provider) throw new Error('resolveProxyOnChain: a provider is required (read-only eth_call)');
  const { Contract, getAddress } = require('ethers');
  const exchange = EXCHANGES.find((e) => e.key === 'ctfExchange') || EXCHANGES[0];
  const c = new Contract(exchange.addr, PROXY_ABI, provider);
  const got = await c.getProxyWalletAddress(getAddress(signer));
  if (!isNonZeroAddress(got)) return null;
  return getAddress(got);
}

/**
 * Cross-check: what Polymarket's own profile API reports as this signer's proxyWallet. Returns a
 * checksummed address or null (no proxy / unreachable / unparseable) — a cross-check must never throw and
 * abort the on-chain answer. fetchImpl is injected for testability (defaults to global fetch).
 */
async function resolveProxyFromProfileApi(signer, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch || !ADDRESS_RE.test(String(signer || ''))) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await doFetch(`https://polymarket.com/api/profile/userData?address=${signer}`, {
      headers: { Accept: 'application/json' }, signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) return null;
    const j = await r.json();
    const pw = j && typeof j.proxyWallet === 'string' ? j.proxyWallet : null;
    if (!isNonZeroAddress(pw)) return null;
    return require('ethers').getAddress(pw);
  } catch {
    return null;
  }
}

/**
 * Resolve a signer's proxy from primary source (on-chain), confirmed against the profile API when it is
 * reachable. The returned object is honest about what agreed:
 *   { proxyAddress, source:'onchain', onChain, profile, agree }
 * agree is true only when the profile API returned an address AND it equals the on-chain one; it is null
 * when the profile API was unreachable (we do not downgrade a confirmed on-chain read to "disagree" just
 * because the web API was down). A genuine mismatch (agree === false) is a caller's cue to STOP.
 */
async function resolveProxyForSigner(signer, opts = {}) {
  const provider = opts.provider;
  const onChain = await resolveProxyOnChain(signer, provider);
  const profile = await resolveProxyFromProfileApi(signer, opts.profileFetch);
  const agree = profile == null ? null : (onChain != null && profile.toLowerCase() === onChain.toLowerCase());
  return { proxyAddress: onChain, source: 'onchain', onChain, profile, agree };
}

module.exports = { resolveProxyOnChain, resolveProxyFromProfileApi, resolveProxyForSigner, isNonZeroAddress };

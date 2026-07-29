'use strict';
// lib/venues/polymarket-clob-maker/proxy-wallet.js — resolve the FUNDER/PROXY wallet for a SIGNER EOA.
//
// A Polymarket account opened with email/Magic is TWO addresses (see funder.js): the SIGNER EOA holds
// the private key and signs but holds no funds; the PROXY wallet is the on-chain contract that actually
// holds the pUSD collateral and CTF outcome tokens and is the `maker`/settlement address the exchange
// uses. This module answers "given a signer, what is its proxy?" — programmatically, from primary source.
//
// getProxyWalletAddress IS NOT A UNIVERSAL ANSWER — it is the ProxyWallet-factory mapping, and it is
// only meaningful for signatureType 1 accounts. READ THIS BEFORE TRUSTING IT:
//
//   CTFExchangeV2.getProxyWalletAddress(signer) is a PURE COUNTERFACTUAL CREATE2 computation. It is the
//   address a ProxyWallet WOULD have if one were ever deployed for that signer. It does not read a
//   registry, it cannot fail, and it NEVER returns the zero address — so "it returned something" is not
//   evidence that the something exists, holds money, or is this account's funder.
//
// Verified 2026-07-26 on Polygon mainnet: for signer 0xd36b…a7A0 (a pre-2026-06-29 email/Magic account)
// it returns 0x54C0…eAe0, which equals what polymarket.com shows and which holds the collateral. That is
// the case the derivation is RIGHT for, and only that case.
//
// Verified 2026-07-29 on Polygon mainnet, the case it is WRONG for: for signer 0x7bD0…85d3 it returns
// 0x87a01e28…, an address with NO CODE (eth_getCode → '0x') and a zero balance, while the account's real
// funder is 0x4C81F1…bdee — a deployed Solady ERC-1967 deposit wallet whose owner() is that signer, and
// the address BOTH polymarket.com's profile API and CTFExchangeV2.validateOrder() agree on. Post-migration
// deposit wallets (signatureType 3, ERC-1271) come from a DIFFERENT factory, so the ProxyWallet mapping
// answers a question nobody asked and answers it confidently.
//
// THEREFORE: when MAKER_FUNDER_ADDRESS is configured, IT WINS — it is the address the signing path
// actually puts in the order's `maker` field, so any consumer that shows or checks a different one is
// describing a wallet the maker will never trade from. The derivation is retained ONLY as a cross-check,
// and assertProxyAgreesWithConfig() below turns a silent divergence into a loud stop.
//
// DO NOT switch this to the deposit-wallet factory's predictWalletAddress() either: that returns a
// DIFFERENT, undeployed address for pre-2026-06-29 accounts. There is no single derivation that is right
// for every account — which is precisely why the configured address is the source of truth.
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
 * The funder the OPERATOR configured (MAKER_FUNDER_ADDRESS) — the exact address the signing path puts in
 * every order's `maker` field. Checksummed, or null when unset/malformed (never a fabricated address).
 * env is injected so this stays pure and unit-testable.
 */
function configuredFunder(env = {}) {
  const raw = typeof env.MAKER_FUNDER_ADDRESS === 'string' ? env.MAKER_FUNDER_ADDRESS.trim() : '';
  if (!ADDRESS_RE.test(raw)) return null;
  try { return require('ethers').getAddress(raw); } catch { return null; }
}

/**
 * The ProxyWallet-factory derivation is only a valid answer for signatureType 1 accounts (see the header).
 * For 2 (Gnosis safe) and 3 (ERC-1271 deposit wallet) it computes an address from the WRONG factory, so a
 * disagreement there carries no information and must not be reported as one.
 */
function derivationApplies(signatureType) {
  return Number(signatureType) === 1;
}

/**
 * FAIL LOUDLY when the configured funder and the on-chain derivation name different wallets on an account
 * where the derivation is supposed to be authoritative (signatureType 1). Proceeding silently is the bug
 * this exists to prevent: the two addresses differ, the money is behind exactly one of them, and picking
 * the wrong one means orders that are rejected — or, worse, signed for an account that is not ours.
 *
 * Throws only in the case that is genuinely contradictory. It does NOT throw when:
 *   • nothing is configured (nothing to contradict), or
 *   • the derivation could not be read (an RPC outage is not evidence of a mismatch), or
 *   • signatureType != 1, where the derivation is simply the wrong factory — that case returns
 *     ok:true with applicable:false, so callers can print "not applicable" instead of a scary mismatch.
 *
 * @returns {{ ok:boolean, applicable:boolean, configured:(string|null), derived:(string|null), reason:string }}
 */
function assertProxyAgreesWithConfig({ configured, derived, signatureType } = {}) {
  const cfg = typeof configured === 'string' && ADDRESS_RE.test(configured) ? configured : null;
  const der = typeof derived === 'string' && ADDRESS_RE.test(derived) ? derived : null;
  const applicable = derivationApplies(signatureType);

  if (!cfg) return { ok: true, applicable, configured: null, derived: der, reason: 'no MAKER_FUNDER_ADDRESS configured — nothing to contradict' };
  if (!der) return { ok: true, applicable, configured: cfg, derived: null, reason: 'derivation unreadable — an RPC outage is not a mismatch' };
  if (cfg.toLowerCase() === der.toLowerCase()) return { ok: true, applicable, configured: cfg, derived: der, reason: 'configured funder equals the on-chain derivation' };

  if (!applicable) {
    return {
      ok: true, applicable: false, configured: cfg, derived: der,
      reason: `signatureType ${signatureType} does not use the ProxyWallet factory, so getProxyWalletAddress(${der}) is the wrong factory's answer and is ignored — the configured funder ${cfg} stands`,
    };
  }
  throw new Error(
    `proxy identity CONTRADICTION on a signatureType 1 account: MAKER_FUNDER_ADDRESS=${cfg} but ` +
    `CTFExchangeV2.getProxyWalletAddress(signer)=${der}. On this account type the derivation IS the ` +
    `authority, so exactly one of these is wrong and the collateral is behind only one of them. ` +
    `REFUSING to proceed. Resolve it with scripts/maker-wallet-preflight.ts + scripts/maker-signing-proof.ts ` +
    `(both read-only) before signing anything.`,
  );
}

/**
 * Resolve a signer's proxy. THE CONFIGURED FUNDER WINS when one is set — it is what the signing path
 * actually uses, so it is the only address a consumer may report as "the wallet". The on-chain derivation
 * and the profile API are retained as cross-checks and reported alongside, never substituted in.
 *
 *   { proxyAddress, source:'config'|'onchain', configured, onChain, profile, agree, agreeConfig, applicable }
 *
 * agree       — profile API vs on-chain derivation; true/false, or null when the profile API was
 *               unreachable (we do not downgrade a confirmed read to "disagree" because a web API was down).
 * agreeConfig — profile API vs the CONFIGURED funder. This is the cross-check that actually matters, since
 *               the configured funder is what gets signed for. null when the profile API was unreachable.
 * applicable  — whether the ProxyWallet derivation is even the right factory for opts.signatureType.
 *
 * Throws (via assertProxyAgreesWithConfig) on a genuine signatureType-1 contradiction. Pass
 * opts.signatureType so that check can be made; omitting it treats the derivation as applicable.
 */
async function resolveProxyForSigner(signer, opts = {}) {
  const provider = opts.provider;
  const env = opts.env || {};
  const signatureType = opts.signatureType !== undefined ? opts.signatureType : env.MAKER_SIGNATURE_TYPE;
  const configured = configuredFunder(env);

  const onChain = await resolveProxyOnChain(signer, provider);
  const profile = await resolveProxyFromProfileApi(signer, opts.profileFetch);

  // Throws on a real contradiction; returns a verdict otherwise.
  const verdict = assertProxyAgreesWithConfig({ configured, derived: onChain, signatureType });

  const agree = profile == null ? null : (onChain != null && profile.toLowerCase() === onChain.toLowerCase());
  const agreeConfig = profile == null || configured == null ? null : profile.toLowerCase() === configured.toLowerCase();

  return {
    proxyAddress: configured || onChain,
    source: configured ? 'config' : 'onchain',
    configured, onChain, profile, agree, agreeConfig,
    applicable: verdict.applicable,
    verdict: verdict.reason,
  };
}

module.exports = {
  resolveProxyOnChain, resolveProxyFromProfileApi, resolveProxyForSigner, isNonZeroAddress,
  configuredFunder, assertProxyAgreesWithConfig, derivationApplies,
};

'use strict';
// lib/maker/inventory-read.js — READ the operator's real outcome-token inventory from the chain.
//
// The SELL guard (lib/maker/inventory-guard) refuses to sell a token you do not hold. That guard is only
// as honest as the number it is handed, so this module reads the ACTUAL ERC-1155 balance of the market's
// YES and NO token ids on the Gnosis ConditionalTokens contract. It never assumes, never defaults to a
// constant, and never returns 0 for "I could not tell".
//
// READ-ONLY BY CONSTRUCTION: one `view` call per token id (balanceOf), against a public Polygon RPC. It
// holds no key, signs nothing, and cannot write. It cannot place, cancel or move anything.
//
// FAIL CLOSED: no funder address configured, RPC unreachable, call reverts, ethers missing — every one
// of those yields null, which the guard treats as "unreadable" and blocks the SELL. null is a first
// class answer here; 0 would be a lie with the same shape.
//
// Outcome tokens on the CTF are whole shares (the raw integer IS the share count — no 18-decimal
// scaling), matching lib/poly-chain-read.ts.

const CACHE_TTL_MS = Number(process.env.MAKER_INVENTORY_TTL_MS || 30_000);
const cache = new Map(); // `${wallet}:${tokenId}` -> { shares, ts }

const ERC1155_BALANCE_ABI = ['function balanceOf(address,uint256) view returns (uint256)'];

/** The wallet whose inventory matters: the funder that actually holds the positions. null if unset. */
function inventoryWallet(env = process.env) {
  try {
    const { resolveFunder } = require('../venues/polymarket-clob-maker/funder');
    return resolveFunder(env).funderAddress || null;
  } catch {
    return null;
  }
}

/**
 * Read the YES/NO outcome-token balances for one market.
 *
 * @param {{ tokenId?: string|null, tokenIdNo?: string|null, env?: object }} args
 * @returns {Promise<{ yes:number|null, no:number|null, wallet:string|null, source:string, error:string|null }>}
 *          A null balance means UNREADABLE, never zero.
 */
async function readMarketInventory({ tokenId, tokenIdNo, env = process.env } = {}) {
  const wallet = inventoryWallet(env);
  if (!wallet) {
    return { yes: null, no: null, wallet: null, source: 'no funder address configured', error: null };
  }

  const now = Date.now();
  const hit = (id) => {
    const c = cache.get(`${wallet}:${id}`);
    return c && now - c.ts < CACHE_TTL_MS ? c.shares : undefined;
  };

  const cachedYes = tokenId ? hit(tokenId) : null;
  const cachedNo = tokenIdNo ? hit(tokenIdNo) : null;
  if (cachedYes !== undefined && cachedNo !== undefined) {
    return { yes: cachedYes ?? null, no: cachedNo ?? null, wallet, source: 'cache', error: null };
  }

  let provider = null;
  try {
    const { JsonRpcProvider, Contract } = require('ethers');
    const { CTF, DEFAULT_RPC } = require('../poly-contracts');
    provider = new JsonRpcProvider(env.POLYGON_RPC_URL || process.env.POLYGON_RPC_URL || DEFAULT_RPC);
    const ctf = new Contract(CTF, ERC1155_BALANCE_ABI, provider);

    const one = async (id) => {
      if (!id) return null;                       // no token id for this book → unreadable, not zero
      const c = hit(id);
      if (c !== undefined) return c;
      const raw = await ctf.balanceOf(wallet, BigInt(id)).catch(() => null);
      if (raw == null) return null;
      const shares = Number(raw);                 // whole shares on the CTF — no decimal scaling
      if (!Number.isFinite(shares)) return null;
      cache.set(`${wallet}:${id}`, { shares, ts: Date.now() });
      return shares;
    };

    const [yes, no] = await Promise.all([one(tokenId), one(tokenIdNo)]);
    return { yes, no, wallet, source: 'chain', error: null };
  } catch (e) {
    // Unreadable for ANY reason → null balances → the guard blocks the SELL.
    return { yes: null, no: null, wallet, source: 'unreadable', error: (e && e.message) ? e.message : String(e) };
  } finally {
    try { if (provider) provider.destroy(); } catch { /* already closed */ }
  }
}

module.exports = { readMarketInventory, inventoryWallet, CACHE_TTL_MS };

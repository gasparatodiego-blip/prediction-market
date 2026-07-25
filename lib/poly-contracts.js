'use strict';
// lib/poly-contracts.js — the ONE list of Polymarket's Polygon-mainnet contract addresses.
//
// PRIMARY SOURCE: @polymarket/clob-client-v2 getContractConfig(137) (dist/config.js, the Polygon
// mainnet block) — the same source scripts/maker-wallet-preflight.ts already cited. This module was
// extracted from that script so the preflight and the event terminal read the SAME constants: a
// second hand-typed address list is how a UI ends up declaring an approval against a contract the
// maker never touches.
//
// Read-only data. Nothing here signs, approves or places anything.

// v2 settlement collateral (config.collateral). The maker path settles in pUSD, not USDC.e.
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
// Legacy collateral, still the `assetAddress` Polymarket stamps on a market's reward program.
const USDCE = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
// Gnosis ConditionalTokens (ERC-1155) — where a YES/NO outcome token balance actually lives.
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// The three spenders an operator must approve before any order can settle. Order is load-bearing:
// the preflight table and the terminal's approval row render them in this sequence.
const EXCHANGES = Object.freeze([
  Object.freeze({ key: 'ctfExchange',   name: 'CTF Exchange (v2)',          addr: '0xE111180000d2663C0091e4f400237545B87B996B' }),
  Object.freeze({ key: 'negRiskExchange', name: 'Neg-Risk CTF Exchange (v2)', addr: '0xe2222d279d744050d28e00520010520000310F59' }),
  Object.freeze({ key: 'negRiskAdapter', name: 'Neg Risk Adapter',           addr: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' }),
]);

// UMA CTF adapters — the addresses Gamma reports in `resolvedBy`. Used ONLY to put a human name next
// to an address we already read from the venue; an unrecognised address is shown raw, never relabelled.
const ORACLE_NAMES = Object.freeze({
  '0x2f5e3684cb1f318ec51b00edba38d79ac2c0aa9d': 'UMA CTF Adapter (neg-risk)',
  '0xce9f7dbebd7b0e9c33ff5a95a0b8ff02cdd4bc2c': 'UMA CTF Adapter v2',
  '0x157ce0fbb0ab5b8d81ff36c0cfaebc7f6e5e0e4d': 'UMA CTF Adapter',
});

/** Human label for an oracle/resolver address, or null when we do not recognise it (never guessed). */
function oracleName(addr) {
  if (typeof addr !== 'string' || !addr) return null;
  return ORACLE_NAMES[addr.toLowerCase()] || null;
}

// Default public Polygon RPC. Overridable with POLYGON_RPC_URL — same env var the preflight uses.
const DEFAULT_RPC = 'https://polygon-bor-rpc.publicnode.com';

module.exports = { PUSD, USDCE, CTF, EXCHANGES, ORACLE_NAMES, oracleName, DEFAULT_RPC };

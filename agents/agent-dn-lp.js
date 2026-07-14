#!/usr/bin/env node
'use strict';

// agent-dn-lp.js — Delta-neutral LP pool DATA COLLECTOR (Phase 1).
//
// Fetches REAL Uniswap v3 pool economics for a curated set of major Ethereum
// pools and writes them to data/dn-lp-pools.json. This phase is DATA ONLY:
// no UI, no hedge math, no impermanent-loss math, and NO net-yield computation.
// It stores the GROSS fee yield (feeAprGross) plus the real inputs a later phase
// will need (TVL, volume, fee tier, DefiLlama's IL-risk flags).
//
// DATA SOURCE — why DefiLlama and not the raw subgraph:
//   • The Graph's legacy hosted service (api.thegraph.com/subgraphs/name/...) was
//     sunset in 2024 → returns 301 (dead).
//   • The Graph decentralized gateway (gateway.thegraph.com) returns
//     {"errors":[{"message":"auth error: missing authorization header"}]} — it
//     REQUIRES an API key we don't have (and won't hardcode/fabricate).
//   • DefiLlama's free yields API (https://yields.llama.fi/pools, no key) returns
//     REAL Uniswap-v3 Ethereum pool economics: tvlUsd, apyBase (gross fee APR),
//     volumeUsd1d, poolMeta (fee tier), underlyingTokens (contract addresses),
//     ilRisk / il7d. Verified live: ~560 uniswap-v3 Ethereum pools.
//   A later phase can swap to the keyed subgraph for raw 24h feesUSD granularity.
//
// HONEST-ENGINE:
//   • Store ONLY real fetched values + transparently-derived ones. feeAprGross is
//     DefiLlama's apyBase = the GROSS fee APR BEFORE hedge cost and IL — named so
//     it can never be mistaken for a net yield. NO net-APY is computed here.
//   • impliedDailyFeesUsd is DERIVED (feeAprGross × TVL / 365) and labeled as such
//     in meta — it is algebra on real inputs, not a raw measured fee.
//   • Anything the source doesn't return → null (never fabricated).
//   • An implausibly high fee APR (> APR_SANITY_CAP) or a thin book is FLAGGED
//     (not altered, not hidden) — likely a low-TVL/thin pool, not sustainable yield.
//   • If the source is unreachable / returns nothing usable → WRITE NOTHING and
//     log the error (never overwrite good data with an empty/fabricated file).

const path = require('path');
const { rlGet } = require('../lib/rateLimitedFetch');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');
const fs = require('fs');

const OUT_FILE = path.join(__dirname, '..', 'data', 'dn-lp-pools.json');
const HB_FILE  = '/tmp/agent-heartbeats.json';
const HB_KEY   = 'agent-dn-lp';
const INTERVAL = 12 * 60_000;            // 12 min — pool economics move slowly

const SOURCE_URL   = 'https://yields.llama.fi/pools';
const CHAIN        = 'Ethereum';
const PROJECT      = 'uniswap-v3';
const APR_SANITY_CAP = 200;              // %/yr — over this ⇒ flag as thin-pool, never "real yield"
const LOW_TVL_USD    = 1_000_000;        // < $1M TVL ⇒ flag thin book

// Curated major pools (token symbols as DefiLlama reports them) × target fee tiers.
// Order-independent match; the highest-TVL record per (pair, tier) wins.
const TARGET_PAIRS = [
  ['USDC', 'WETH'],
  ['WBTC', 'USDC'],
  ['WETH', 'USDT'],
  ['WBTC', 'WETH'],
];
const TARGET_TIERS = ['0.01%', '0.05%', '0.3%'];

const log = (...a) => console.log('[agent-dn-lp]', ...a);

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch { /* first run */ }
  hb[HB_KEY] = Date.now();
  try { atomicWriteJson(HB_FILE, hb, { pretty: true }); } catch { /* non-fatal */ }
}

const pairKey = (a, b) => [a, b].map(s => (s || '').toUpperCase()).sort().join('|');
const num     = v => (typeof v === 'number' && isFinite(v) ? v : null);
const round   = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

// Build one honest pool record from a raw DefiLlama pool row. Real fields only;
// derived fields labeled; nothing fabricated.
function toRecord(p, base, quote, tier) {
  const tvlUsd       = num(p.tvlUsd);
  const feeAprGross  = num(p.apyBase);          // GROSS fee APR — before hedge cost + IL
  const volumeUsd24h = num(p.volumeUsd1d);

  // DERIVED (transparent algebra on real inputs) — implied daily fee revenue.
  const impliedDailyFeesUsd =
    feeAprGross != null && tvlUsd != null ? round((feeAprGross / 100) * tvlUsd / 365, 2) : null;

  const flags = [];
  if (feeAprGross != null && feeAprGross > APR_SANITY_CAP) flags.push('THIN_POOL_APR'); // implausible ⇒ likely thin/low-TVL
  if (tvlUsd != null && tvlUsd < LOW_TVL_USD)              flags.push('LOW_TVL');

  return {
    id:            `${base}-${quote}-${tier}`,
    pair:          `${base}/${quote}`,
    base,
    quote,
    feeTier:       tier,                                   // real (DefiLlama poolMeta)
    chain:         CHAIN,
    project:       PROJECT,
    tvlUsd:        round(tvlUsd, 0),                       // real capacity proxy
    volumeUsd24h:  round(volumeUsd24h, 0),                // real
    volumeUsd7d:   round(num(p.volumeUsd7d), 0),          // real
    feeAprGross:   round(feeAprGross, 4),                 // real — GROSS, not net
    feeAprGross7d: round(num(p.apyBase7d), 4),            // real 7d-avg (stability check)
    apyReward:     round(num(p.apyReward), 4),            // real reward-token APY (separate) or null
    impliedDailyFeesUsd,                                  // DERIVED (see meta.derivations)
    defiLlamaIlRisk: p.ilRisk ?? null,                    // DefiLlama's own IL-risk flag ("yes"/"no")
    defiLlamaIl7d:   round(num(p.il7d), 4),               // realized 7d IL if DefiLlama has it, else null
    underlyingTokens: Array.isArray(p.underlyingTokens) ? p.underlyingTokens : null, // real token addresses
    defiLlamaPoolId:  typeof p.pool === 'string' ? p.pool : null,                    // DefiLlama UUID (NOT the contract)
    flags,
    fetchedAt: new Date().toISOString(),
  };
}

async function collect() {
  beat();
  let resp;
  try {
    resp = await rlGet(SOURCE_URL, { timeoutMs: 25_000, headers: { 'User-Agent': 'prediction-arb-scanner/1.0', 'Accept': 'application/json' } });
  } catch (e) {
    log('SOURCE UNREACHABLE — writing nothing (never fabricate):', e && e.message ? e.message : e);
    return;
  }
  const rows = resp && resp.data && Array.isArray(resp.data.data) ? resp.data.data : null;
  if (!rows || rows.length === 0) {
    log('source returned no pools — writing nothing (never fabricate)');
    return;
  }

  // Real Uniswap-v3 Ethereum universe from the source.
  const universe = rows.filter(p => p && p.project === PROJECT && p.chain === CHAIN && typeof p.symbol === 'string');

  const wantPair = new Set(TARGET_PAIRS.map(([a, b]) => pairKey(a, b)));
  const pools = [];
  for (const [a, b] of TARGET_PAIRS) {
    for (const tier of TARGET_TIERS) {
      // candidate rows matching this pair (order-independent) + fee tier
      const cands = universe.filter(p => {
        const toks = p.symbol.split('-');
        if (toks.length !== 2) return false;
        if (pairKey(toks[0], toks[1]) !== pairKey(a, b)) return false;
        return (p.poolMeta || '').trim() === tier;
      });
      if (cands.length === 0) continue;                    // tier genuinely absent → omit (never fabricate)
      // highest-TVL wins (the canonical pool for that pair+tier)
      cands.sort((x, y) => (num(y.tvlUsd) ?? 0) - (num(x.tvlUsd) ?? 0));
      pools.push(toRecord(cands[0], a, b, tier));
    }
  }

  if (pools.length === 0) {
    log('no curated pools matched in the source this cycle — writing nothing (never fabricate)');
    return;
  }

  const flagged = pools.filter(p => p.flags.length).map(p => `${p.id}[${p.flags.join(',')}]`);
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      dataSource:  'defillama-yields',
      sourceUrl:   SOURCE_URL,
      sourceNote:  'The Graph gateway Uniswap-v3 subgraph requires an API key (unavailable); DefiLlama free yields API supplies real Uniswap-v3 Ethereum pool economics (TVL, base fee APR, 24h volume, fee tier, IL-risk).',
      chain:       CHAIN,
      project:     PROJECT,
      phase:       'data-collection-only',
      honestNote:  'feeAprGross = GROSS fee APR BEFORE hedge cost and impermanent loss. NO net yield is computed in this phase — that needs the IL + hedge math added later.',
      derivations: { impliedDailyFeesUsd: 'feeAprGross/100 * tvlUsd / 365 (algebra on real inputs)' },
      aprSanityCapPct: APR_SANITY_CAP,
      totalPools:  pools.length,
      flagged,
    },
    pools,
  };

  try {
    atomicWriteJson(OUT_FILE, out, { pretty: true });
    log(`wrote ${pools.length} pools → ${OUT_FILE}${flagged.length ? ` (flagged: ${flagged.join(', ')})` : ''}`);
  } catch (e) {
    log('atomic write failed — leaving prior file intact:', e && e.message ? e.message : e);
  }
}

async function tick() {
  try { await collect(); } catch (e) { log('tick error:', e && e.message ? e.message : e); }
}

log('starting — Phase 1 data collector (gross fee APR only, no net yield)');
tick();
setInterval(tick, INTERVAL);

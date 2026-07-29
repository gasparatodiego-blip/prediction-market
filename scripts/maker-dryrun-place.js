#!/usr/bin/env node
'use strict';
// scripts/maker-dryrun-place.js — exercise the FULL placement path for the pinned market's seeded legs,
// build and SIGN every order, put each one to the exchange's own validateOrder() via eth_call, print
// exactly what would have been sent — and send NOTHING.
//
//   npx tsx scripts/maker-dryrun-place.js        (or: node scripts/maker-dryrun-place.js)
//
// WHY THIS EXISTS SEPARATELY FROM agent35. agent35's pm2 process stays MAKER_MODE=off. This ephemeral
// process builds the SAME adapter, with the SAME providers, gates, caps and guards, so the path it
// proves is the path agent35 will run — but it exits after one pass and can place nothing.
//
// THREE INDEPENDENT REASONS NOTHING CAN REACH THE VENUE HERE:
//   1. placement is hard-coded to 'dry-run', and the adapter's dry-run branch returns BEFORE POST /order.
//   2. this script ASSERTS adapter.placement === 'dry-run' at startup and exits non-zero otherwise, so
//      an env var (MAKER_PLACEMENT=send) cannot silently arm it — opts beat env, and the assert re-proves it.
//   3. MAKER_PLACEMENT is explicitly deleted from this process's env before the adapter is built.
//
// fundingApproved is set TRUE here, and that is a test-only attestation: without it the gate chain
// refuses before the order is ever built, and there would be nothing to show. It grants no ability to
// send — the dry-run branch is downstream of every gate and returns without POSTing. agent35 itself
// still reads MAKER_FUNDING_APPROVED from the environment, which remains false.

const fs = require('fs');
const path = require('path');

(function loadEnv() {
  for (const f of ['.env', '.env.local']) {
    try {
      for (const line of fs.readFileSync(path.join(__dirname, '..', f), 'utf8').split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let v = m[2].replace(/\r$/, '');
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
    } catch { /* absent → fine */ }
  }
})();

// Belt 3: no env value may arm the venue path in this process.
delete process.env.MAKER_PLACEMENT;

const { createMakerAdapter } = require('../lib/venues/polymarket-clob-maker/adapter');
const { makerLiveProviders } = require('../lib/maker/live-providers');
const { planQuotes } = require('../lib/maker/quote-plan');
const { readMarketInventory } = require('../lib/maker/inventory-read');
const { httpGet } = require('../lib/httpGet');

const BOOKS = '/tmp/clob-live-books.json';
const REWARDS = '/tmp/liquidity-rewards.json';
const MARKET = process.env.MAKER_LIVE_MIN_MARKET;
const CAP_USD = Number(process.env.MAKER_LIVE_MIN_CAP_USD || 30);
const TTL = Number(process.env.MAKER_ORDER_TTL_SECONDS || 180);

const line = (...a) => console.log(...a);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

async function venueTick(tokenId) {
  try {
    const r = await httpGet(`https://clob.polymarket.com/tick-size?token_id=${tokenId}`, { timeoutMs: 8000, headers: { Accept: 'application/json' } });
    const t = r && r.status === 200 ? parseFloat(r.data.minimum_tick_size) : null;
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

async function main() {
  line('== MAKER DRY-RUN PLACEMENT — builds + signs + validates on-chain, sends NOTHING ==\n');
  if (!MARKET) throw new Error('MAKER_LIVE_MIN_MARKET is not set — nothing to dry-run');

  const books = readJson(BOOKS);
  const bm = books && books.markets ? books.markets[MARKET] : null;
  if (!bm) throw new Error(`market ${MARKET} is not in agent34's live book feed — no live mid, nothing to price`);
  const rewards = readJson(REWARDS);
  const rlist = rewards?.data?.markets || rewards?.markets || [];
  const rm = rlist.find((m) => String(m.marketId) === MARKET);
  const negRisk = rm ? rm.negRisk === true : false;

  const mid = Number(bm.mid), minSize = Number(bm.minSize), maxSpreadC = Number(bm.maxSpread);
  const tick = (await venueTick(bm.tokenId)) ?? bm.tickSize ?? null;
  if (!Number.isFinite(tick)) throw new Error('could not read the venue tick size — refusing to price an order against a guessed tick');

  line(`market   : ${MARKET}`);
  line(`title    : ${bm.title}`);
  line(`mid      : ${mid}   minSize ${minSize}   maxSpread ${maxSpreadC}c   tick ${tick}   negRisk ${negRisk}`);
  line(`exchange : ${negRisk ? 'NegRiskCtfExchangeV2' : 'CTFExchangeV2'} (decided by negRisk, read from the venue feed)\n`);

  // The operator's real legs.
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  let legs;
  try {
    legs = await prisma.rewardsLeg.findMany({ where: { venue: 'polymarket', marketId: MARKET, enabled: true } });
  } finally { await prisma.$disconnect(); }
  if (!legs.length) throw new Error('no enabled RewardsLeg rows for this market — nothing to quote');
  line(`legs     : ${legs.length} enabled`);

  // REAL inventory, so the position guards decide on measured balances (null ⇒ SELLs blocked).
  const inventory = await readMarketInventory({ tokenId: bm.tokenId, tokenIdNo: bm.tokenIdNo });
  line(`inventory: yes=${inventory.yes} no=${inventory.no} wallet=${inventory.wallet || '—'} (${inventory.source})\n`);

  const plan = planQuotes({ legs, mid, maxSpreadC, minSize, tick, tokenId: bm.tokenId, tokenIdNo: bm.tokenIdNo,
    defaultSizeShares: Number(process.env.MAKER_DEFAULT_SIZE || 200), balances: { yes: inventory.yes, no: inventory.no } });

  const { credsProvider, signerProvider } = makerLiveProviders();
  const adapter = createMakerAdapter({
    mode: 'live-min',
    placement: 'dry-run',            // belt 1
    liveMinMarket: MARKET,
    liveMinCapUsd: CAP_USD,
    orderTtlSeconds: TTL,
    fundingApproved: true,           // test-only; grants nothing beyond reaching the build
    credsProvider, signerProvider,
  });

  // Belt 2: refuse to continue if anything resolved placement to 'send'.
  if (adapter.placement !== 'dry-run') {
    console.error(`REFUSING: adapter.placement is '${adapter.placement}', not 'dry-run'. This script must never be able to send.`);
    process.exit(3);
  }
  line(`adapter  : mode=${adapter.mode} canWrite=${adapter.canWrite} placement=${adapter.placement} cap=$${adapter.liveMinCapUsd} pinned=${adapter.liveMinMarket.slice(0, 12)}…\n`);

  let accepted = 0, refused = 0, committed = 0;
  for (const q of plan.quotes) {
    const label = `${q.side} ${q.book.toUpperCase()} ${q.size} @ ${q.price}`;
    if (!q.postable) { line(`── ${label}\n   SKIPPED (not postable): ${q.reason}\n`); refused++; continue; }
    const legMid = q.book === 'no' ? +(1 - mid).toFixed(6) : mid;
    const res = await adapter.postOrder({
      marketId: MARKET, tokenId: q.token, side: q.side, price: q.price, size: q.size,
      tickSize: tick, negRisk, postOnly: true,
      venueRules: { tick, scoringMid: legMid, maxSpreadCents: maxSpreadC, minSize },
      ttlSeconds: TTL, userId: process.env.MAKER_OPERATOR_USER || 'operator',
    });
    line(`── ${label}`);
    if (res.dryRun && res.ok) {
      accepted++; committed += res.notionalUsd || 0;
      const w = res.wouldSend;
      line('   WOULD SEND (not sent):');
      for (const [k, v] of Object.entries(w)) line(`     ${k.padEnd(16)} ${v}`);
      line(`   validateOrder: ACCEPTED by ${res.validateOrder.exchange.name} — eth_call, nothing submitted`);
    } else {
      refused++;
      line(`   REFUSED  gate=${res.gate || '-'}`);
      line(`   reason : ${res.reason || '(none)'}`);
    }
    line('');
  }

  line('── SUMMARY ─────────────────────────────────────────────');
  line(`  orders built + signed + validated : ${accepted}`);
  line(`  refused                           : ${refused}`);
  line(`  collateral that WOULD be committed: $${committed.toFixed(2)}`);
  line(`  per-order live-min cap            : $${CAP_USD}`);
  line(`  ORDERS ACTUALLY SENT              : 0  (placement=dry-run)`);
  adapter.close();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('dry-run failed:', String(e && e.message ? e.message : e).slice(0, 300));
  process.exit(1);
});

'use strict';
// lib/maker/preflight.js — the ARMING GATE. Reads REAL state at the moment of arming, never a cached flag.
//
// Six checks, each returning its true value. ANY failure makes arming impossible; there is no override.
// FAIL CLOSED throughout: a value that cannot be read is a FAIL (never assumed pass) — "we could not read
// your balance" and "your balance is fine" are different facts and the gate must not conflate them.
//
//   signing   — build + sign an order offline; recover == custody signer, maker == funder. MATCH required.
//   balance   — funder pUSD balance > 0, read on-chain (the FUNDER 0x54C0…, never the empty signer EOA).
//   approvals — the funder's 3 ERC-20 pUSD allowances to the v2 exchanges are all present, read on-chain.
//   cancel    — the cancel path is LIVE-wired (L2 creds present so a real cancel is possible — not a
//               simulated dry-run). You must never arm a maker whose orders you could not then cancel.
//   guard     — the shared venue-rules guard is active in-process (it refuses an off-tick probe quote).
//   kill      — the durable kill switch is reachable (its state reads without error).
//
// Every default check does a real read; each is INJECTABLE so the selfcheck can prove the gate's logic
// (all-pass ⇒ go; any-fail ⇒ no-go) deterministically without a network or a key.

const CHECK_ORDER = ['signing', 'balance', 'approvals', 'cancel', 'guard', 'kill'];
const LABELS = Object.freeze({
  signing: 'Offline signing MATCH (recover == signer, maker == funder)',
  balance: 'Funder pUSD balance > 0 (on-chain)',
  approvals: 'Funder approvals present — 3 v2 exchanges (on-chain)',
  cancel: 'Cancel path live-wired (real creds, not simulated)',
  guard: 'Venue-rules guard active (refuses off-tick / out-of-band / under-min)',
  kill: 'Kill switch reachable',
});

// ── default check implementations — real reads, all lazy so requiring this module is cheap ──

async function defaultSigning({ prisma, env }) {
  try {
    const { proveSigningOffline } = require('./signing-check');
    const r = await proveSigningOffline({ prisma, env });
    return { pass: r.pass === true, value: r.pass ? `MATCH · recover ${short(r.recovered)}` : 'MISMATCH', detail: r.detail };
  } catch (e) { return { pass: false, value: 'error', detail: safeMsg(e) }; }
}

// One on-chain read serves BOTH balance and approvals; cache it per runPreflight call.
async function readFunderChain(env) {
  const { resolveFunder } = require('../venues/polymarket-clob-maker/funder');
  const { PUSD, EXCHANGES, DEFAULT_RPC } = require('../poly-contracts');
  const { JsonRpcProvider, Contract, formatUnits } = require('ethers');
  const funder = resolveFunder(env).funderAddress;
  if (!funder) return { funder: null, balance: null, allowances: EXCHANGES.map(() => null), names: EXCHANGES.map((e) => e.name) };
  const provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL || DEFAULT_RPC);
  try {
    const erc20 = new Contract(PUSD, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function decimals() view returns (uint8)'], provider);
    const decRaw = await erc20.decimals().catch(() => null);
    const dec = decRaw == null ? null : Number(decRaw);
    const balRaw = await erc20.balanceOf(funder).catch(() => null);
    const balance = (balRaw == null || dec == null) ? null : Number(formatUnits(balRaw, dec));
    const allowances = [];
    for (const e of EXCHANGES) {
      const a = await erc20.allowance(funder, e.addr).catch(() => null);
      allowances.push((a == null || dec == null) ? null : Number(formatUnits(a, dec)));
    }
    return { funder, balance, allowances, names: EXCHANGES.map((e) => e.name) };
  } finally { try { provider.destroy(); } catch { /* already closed */ } }
}

async function defaultBalance({ chain }) {
  const c = await chain;
  if (c.balance == null) return { pass: false, value: '— (unread)', detail: 'could not read funder pUSD balance on-chain — fail closed' };
  return { pass: c.balance > 0, value: `$${c.balance.toFixed(2)} pUSD`, detail: c.balance > 0 ? `funder ${short(c.funder)}` : 'funder pUSD balance is zero' };
}

async function defaultApprovals({ chain }) {
  const c = await chain;
  const present = c.allowances.filter((a) => a != null && a > 0).length;
  const unread = c.allowances.filter((a) => a == null).length;
  const pass = unread === 0 && present === c.allowances.length;
  return { pass, value: `${present}/${c.allowances.length} present${unread ? ` (${unread} unread)` : ''}`, detail: pass ? 'pUSD allowance to all 3 v2 exchanges' : 'a required approval is missing or unread — fail closed' };
}

async function defaultCancel() {
  try {
    const { cancelCredsAvailable } = require('./cancel-creds-provider');
    const available = await cancelCredsAvailable();
    return { pass: available === true, value: available ? 'live (L2 creds present)' : 'simulated only (no L2 creds stored)', detail: available ? 'a real cancel is possible' : 'no L2 cancel credential stored → the cancel/KILL sweep is dry-run only; a maker you cannot cancel must not be armed' };
  } catch (e) { return { pass: false, value: 'error', detail: safeMsg(e) }; }
}

function defaultGuard() {
  try {
    const { validateQuote, CODES } = require('./venue-rules');
    // A deliberately off-tick, in-range quote against readable rules — the guard MUST refuse it.
    const r = validateQuote({ tick: 0.01, scoringMid: 0.5, maxSpreadCents: 6, minSize: 5 }, { side: 'BUY', price: 0.525, size: 100 });
    const active = r.valid === false && r.reasons.some((x) => x.code === CODES.OFF_TICK);
    return { pass: active, value: active ? 'active (refused OFF_TICK probe)' : 'INACTIVE', detail: active ? 'shared validateQuote refuses a bad quote before signing' : 'guard did not refuse a known-bad probe' };
  } catch (e) { return { pass: false, value: 'error', detail: safeMsg(e) }; }
}

function defaultKill() {
  try {
    const { killStatus } = require('../safety/kill-switch');
    const st = killStatus();
    // Reachable = its durable state reads without error. (A currently-ACTIVE kill is reachable AND would
    // itself block placement — reported, but reachability is the check here.)
    return { pass: st.readable === true, value: st.readable ? (st.effectivelyKilled ? 'reachable · currently ACTIVE' : 'reachable · clear') : 'UNREADABLE', detail: st.readable ? 'setGlobalKill/clearGlobalKill available' : `kill state unreadable: ${st.error || '?'}` };
  } catch (e) { return { pass: false, value: 'error', detail: safeMsg(e) }; }
}

function short(a) { return a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '—'; }
function safeMsg(e) { return (e && e.message ? e.message : String(e)).slice(0, 160); }

/**
 * Run the preflight. Returns { at, checks:[{key,label,pass,value,detail}], go }.
 * @param {object} deps  prisma, env — passed to the real checks.
 * @param {object} overrides  key → async ()=>({pass,value,detail}); replaces individual checks (tests).
 */
async function runPreflight(deps = {}, overrides = {}) {
  const env = deps.env || process.env;
  const chain = (overrides.balance && overrides.approvals) ? null : readFunderChain(env).catch(() => ({ funder: null, balance: null, allowances: [null, null, null], names: [] }));
  const impls = {
    signing: overrides.signing || (() => defaultSigning({ prisma: deps.prisma, env })),
    balance: overrides.balance || (() => defaultBalance({ chain })),
    approvals: overrides.approvals || (() => defaultApprovals({ chain })),
    cancel: overrides.cancel || defaultCancel,
    guard: overrides.guard || defaultGuard,
    kill: overrides.kill || defaultKill,
  };
  const checks = [];
  for (const key of CHECK_ORDER) {
    let r;
    try { r = await impls[key](); } catch (e) { r = { pass: false, value: 'error', detail: safeMsg(e) }; }
    checks.push({ key, label: LABELS[key], pass: r.pass === true, value: r.value != null ? String(r.value) : '—', detail: r.detail || '' });
  }
  const go = checks.every((c) => c.pass === true);
  return { at: new Date((deps.now ? deps.now() : Date.now())).toISOString(), checks, go };
}

module.exports = { runPreflight, CHECK_ORDER, LABELS };

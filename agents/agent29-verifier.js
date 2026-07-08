#!/usr/bin/env node
'use strict';

// agent29-verifier.js — CONTINUOUS SOURCE-OF-TRUTH VERIFICATION of served rows.
//
// WHY A SEPARATE AGENT (not folded into agent26-landing-auditor):
//   agent26 runs a 30-min landing-page honest-engine audit that is strictly
//   read-only against localhost + /tmp with ZERO outbound venue calls (its own
//   header documents that minimal footprint). This verifier is a different
//   animal: it makes live, rate-limited, per-symbol OUTBOUND calls to ~10
//   venues on a TIGHT cadence (every few minutes) so phantom numbers are caught
//   BEFORE users act. Coupling a 30-min read-only auditor with a 3-min outbound
//   fetch loop would (a) force one cadence to lose, and (b) let a venue's
//   Cloudflare backoff stall the landing audit. Separation keeps each honest and
//   isolated. So: agent29, its own PM2 process.
//
// Each cycle it:
//   1. Reads the CURRENTLY-SERVED rows per section from the same feeds the pages
//      serve (/tmp/unified-opportunities.json FUNDING, /tmp/perp-spot.json,
//      /tmp/basis-opportunities.json, data/liquidity-rewards.json).
//   2. Selects the verification set = ALL above-the-fold rows + a ROTATING
//      sample of the rest (budget-aware), capped at CALL_BUDGET_PER_CYCLE.
//   3. Independently RE-READS each row's key field from the venue's own public
//      endpoint (lib/source-verify.js) and compares within tolerance.
//   4. Writes /tmp/verification-status.json  { rows: { id → {verifiedAt,status,
//      section, source?} }, updatedAt, cycleCalls, callBudget }.
//   5. On MISMATCH: logs loudly + sends ONE deduped auditor Telegram alert per
//      row per 6h (gated by TELEGRAM_ALERTS_ENABLED, same mute switch as the
//      other alerting agents). On UNREACHABLE: recorded as-is; the serve-side
//      sanity layer marks such rows stale past their freshness window.
//
// Read-only w.r.t. everything the dashboard reads — its only writes are its own
// status file, its heartbeat, and its dedupe state.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpPost: _sharedPost } = require('../lib/httpGet');
const SV = require('../lib/source-verify');
const { computeUsdcArb } = require('../lib/usdc-arb');   // reconstruct served USDC rows deterministically

// ── Load .env (pm2 doesn't auto-load project env files) — same pattern as a26 ─
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* try next */ }
}
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
// Telegram gating (two independent switches, BOTH must allow a send):
//   1. TELEGRAM_ALERTS_ENABLED — the project-wide mute. agent29 is NOT on the bypass
//      allowlist (only agent26 + agent-monitor are), so this alone can silence it.
//   2. VERIFY_TELEGRAM_ENABLED — per-agent OPT-IN, default FALSE. The verifier's
//      primary surface is the in-app VerifyBadge + /tmp/verification-status.json (which
//      drives serve-side enforceVerified drops) + the cycle log line — none of which
//      need Telegram. Mismatch pushes are noisy (frequent-settlement drift, transient
//      gamma pool toggles), so Telegram stays OFF unless a human explicitly opts in.
const VERIFY_TELEGRAM_ENABLED = process.env.VERIFY_TELEGRAM_ENABLED === 'true';

// ── Config ──────────────────────────────────────────────────────────────────
const CYCLE_MS               = 3 * 60_000;   // tight cadence: catch phantoms before users act
const STARTUP_DELAY_MS       = 8_000;
const ALERT_COOLDOWN_MS      = 6 * 3_600_000; // dedupe: same row-mismatch at most once / 6h

// Above-the-fold coverage per section (everything rendered above the fold every
// cycle) + a ROTATING window over the rest so the long tail is covered over time.
const FUNDING_ABOVE_FOLD     = 25;
const FUNDING_ROTATE         = 10;
const PERPSPOT_ABOVE_FOLD    = 25;   // the whole perp-spot feed is ~25 rows
const USDC_ABOVE_FOLD        = 8;    // USDC lane is majors-only (~4 rows) — verify all
const BASIS_ABOVE_FOLD       = 12;
const BASIS_ROTATE           = 6;
const REWARDS_ABOVE_FOLD     = 15;
const REWARDS_ROTATE         = 10;

// Hard cap on outbound calls per cycle so total API usage stays inside free-tier
// limits. Bulk-response venues (HL, dydx) cost ONE call for all their coins, so
// the real reach is much wider than this number of rows.
const CALL_BUDGET_PER_CYCLE  = 90;

const OUT_FILE   = '/tmp/verification-status.json';
const STATE_FILE = '/tmp/verifier-state.json';   // this agent's dedupe bookkeeping only
const HB_FILE    = '/tmp/agent-heartbeats.json';

const UNI_FILE       = '/tmp/unified-opportunities.json';
const EXCHANGE_FILE  = '/tmp/exchange-prices.json';
const PERP_SPOT_FILE = '/tmp/perp-spot.json';
const BASIS_FILE     = '/tmp/basis-opportunities.json';
const POLY_REWARDS   = '/tmp/liquidity-rewards.json';   // the file rewards-unified/route.ts serves from

function log(...a) { console.log('[A29]', new Date().toISOString(), ...a); }
function readJsonSafe(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function atomicWrite(file, obj) { const t = `${file}.tmp`; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, file); }

function httpPost(url, body) { return _sharedPost(url, body, { timeoutMs: 15_000 }).then(r => r.data); }
async function sendTelegram(text) {
  if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') { log('alerts muted (TELEGRAM_ALERTS_ENABLED=false) — logged only:', text.slice(0, 160)); return; }
  if (!VERIFY_TELEGRAM_ENABLED) { log('Telegram send skipped — verifier opt-in gate off (VERIFY_TELEGRAM_ENABLED not true); mismatch kept in verification-status.json + log only:', text.slice(0, 160)); return; }
  if (!BOT_TOKEN || !CHAT_ID) { log('Telegram not configured — logged only:', text.slice(0, 160)); return; }
  try { await httpPost(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: CHAT_ID, text, parse_mode: 'HTML' }); }
  catch (e) { log('sendTelegram error:', e.message); }
}

function loadState() { return readJsonSafe(STATE_FILE) || { alerts: {}, rotation: {} }; }
function saveState(s) { try { atomicWrite(STATE_FILE, s); } catch (e) { log('saveState error:', e.message); } }
function beat(extra) {
  try { const hb = readJsonSafe(HB_FILE) || {}; hb['agent29-verifier'] = { ts: Date.now(), ...extra }; atomicWrite(HB_FILE, hb); } catch {}
}

// Rotating selection: above-fold rows (sorted set) are ALWAYS included; the rest
// are covered in a moving window keyed per section in state.rotation.
function selectRotating(state, section, all, aboveFold, rotateN) {
  const head = all.slice(0, aboveFold);
  const tail = all.slice(aboveFold);
  if (!tail.length || rotateN <= 0) return { set: head, nextOffset: 0 };
  const off  = (state.rotation[section] || 0) % tail.length;
  const win  = [];
  for (let i = 0; i < Math.min(rotateN, tail.length); i++) win.push(tail[(off + i) % tail.length]);
  return { set: head.concat(win), nextOffset: (off + win.length) % tail.length };
}

// ── Section builders: read served feeds → normalized verification items ──────
function buildFundingItems() {
  const uni = readJsonSafe(UNI_FILE);
  const ex  = readJsonSafe(EXCHANGE_FILE);
  const exFresh = ex && typeof ex.fetchedAt === 'number' && (Date.now() - ex.fetchedAt) < SV.STORED_FRESH_MS;
  const futures = (ex && ex.futures) || {};
  const opps = ((uni && uni.opportunities) || []).filter(o => o && o.type === 'FUNDING');
  opps.sort((a, b) => (b.netROI ?? 0) - (a.netROI ?? 0));
  return { items: opps.map(o => {
    const p = String(o.id || '').split('-');   // funding-<coin>-<shortEx>-<longEx>
    if (p.length !== 4) return null;
    const [, coin, exA, exB] = p;
    return { id: SV.fundingKey(coin, exA, exB), section: 'funding', coin, legs: [exA, exB], futures, exFresh };
  }).filter(Boolean), exPresent: !!ex };
}

function buildPerpSpotItems() {
  const ps = readJsonSafe(PERP_SPOT_FILE);
  const rows = (ps && Array.isArray(ps.rows)) ? ps.rows : [];
  return rows.map(r => ({
    id: SV.perpSpotKey(r.coin, r.shortVenue), section: 'perp-spot',
    coin: r.coin, shortVenue: r.shortVenue,
    servedPct8h: r.fundingPct8h, intervalH: r.intervalH, servedMark: r.markPrice,
    fresh: typeof r.sourceAt === 'number' && (Date.now() - r.sourceAt) < SV.STORED_FRESH_MS,
  }));
}

// USDC-margined divergence lane: reconstruct the SERVED rows deterministically from
// the same exchange-prices.json snapshot the serve path uses (computeUsdcArb is pure),
// so the verification key matches what enforceVerified('usdc') looks up.
function buildUsdcItems() {
  const ex = readJsonSafe(EXCHANGE_FILE);
  const exFresh = ex && typeof ex.fetchedAt === 'number' && (Date.now() - ex.fetchedAt) < SV.STORED_FRESH_MS;
  const futures     = (ex && ex.futures)     || {};
  const futuresUsdc = (ex && ex.futuresUsdc) || {};
  // Match the serve path's history source (48h ring) so both derive the same row set.
  const hist = (readJsonSafe('/tmp/funding-history-cache.json') || {}).data || {};
  let rows = [];
  try { rows = computeUsdcArb(futures, futuresUsdc, hist, Date.now()).rows; } catch { rows = []; }
  return rows.map(r => ({
    id: SV.usdcArbKey(r.coin, r.shortVenue, r.shortMargin, r.longVenue, r.longMargin),
    section: 'usdc', coin: r.coin,
    legs: [{ venue: r.shortVenue, margin: r.shortMargin }, { venue: r.longVenue, margin: r.longMargin }],
    futures, futuresUsdc, exFresh,
  }));
}

function buildBasisItems() {
  const b = readJsonSafe(BASIS_FILE);
  // basis-opportunities.json stores updatedAt as an ISO string; agent19 refreshes
  // every 5 min. Allow a 20-min window (dated-futures basis moves slowly and the
  // producer cadence is 5 min, so <20 min is genuinely current).
  const updMs = b && b.updatedAt ? Date.parse(b.updatedAt) : NaN;
  const fresh = Number.isFinite(updMs) && (Date.now() - updMs) < 20 * 60_000;
  const opps = (b && Array.isArray(b.opportunities)) ? b.opportunities : [];
  const sorted = [...opps].sort((a, b2) => (b2.netAnnualizedExecutable ?? 0) - (a.netAnnualizedExecutable ?? 0));
  return sorted.map(o => ({
    id: SV.basisKey(o.asset, o.exchange, o.contract), section: 'basis',
    asset: o.asset, venueKey: o.venueKey, contract: o.contract,
    servedFuture: o.future, servedSpot: o.spot, fresh,
  }));
}

function buildRewardsItems() {
  const r = readJsonSafe(POLY_REWARDS);
  // meta.generatedAt is an ISO string; rewards scan cadence is slow (~15 min),
  // allow a 45-min window.
  const genMs = r && r.meta && r.meta.generatedAt ? Date.parse(r.meta.generatedAt) : NaN;
  const fresh = Number.isFinite(genMs) ? (Date.now() - genMs) < 45 * 60_000 : false;
  const markets = (r && Array.isArray(r.markets)) ? r.markets : [];
  // Only Polymarket pools are a single re-readable source field. Kalshi poolDay is
  // a DERIVED quantity (totalUsd/periodDays) — not verifiable as one source field
  // within budget, so those rows are reported 'unreachable' (honest).
  const withPool = markets.filter(m => m && m.dailyPool != null);
  withPool.sort((a, b) => (b.dailyPool ?? 0) - (a.dailyPool ?? 0));
  return withPool.map(m => ({
    id: SV.rewardsKey(m.marketId), section: 'rewards',
    venue: m.venue, marketId: m.marketId, servedPool: m.dailyPool, fresh,
  }));
}

// ── Per-item verification ────────────────────────────────────────────────────
async function verifyFunding(it, cache) {
  const results = [];
  for (const ex of it.legs) {
    if (!SV.FUNDING_VENUES.has(ex)) { results.push({ status: 'unreachable', note: `no source adapter for ${ex}` }); continue; }
    const stored = ((it.futures[ex] || {})[it.coin]) || null;
    if (!stored || typeof stored.fundingRate !== 'number') { results.push({ status: 'unreachable', note: `no stored rate for ${ex}:${it.coin}` }); continue; }
    if (!it.exFresh) { results.push({ status: 'unreachable', note: 'stored exchange-prices snapshot stale' }); continue; }
    let live;
    try { live = await SV.FUNDING_ADAPTERS[ex](it.coin, cache); }
    catch (e) { results.push({ status: 'unreachable', note: `${ex} fetch failed: ${String(e.message).slice(0, 60)}` }); continue; }
    if (!live) { results.push({ status: 'unreachable', note: `${ex} returned no rate` }); continue; }
    const intervalH = typeof stored.fundingIntervalHours === 'number' && stored.fundingIntervalHours > 0 ? stored.fundingIntervalHours : (live.intervalHours || 8);
    live.storedNextFundingTime = typeof stored.nextFundingTime === 'number' ? stored.nextFundingTime : null;
    const cmp = SV.compareFunding(stored.fundingRate, live, intervalH);
    results.push({ leg: ex, ...cmp });
  }
  // Row status = worst leg: any mismatch → mismatch; else any unreachable → unreachable; else ok.
  if (results.some(r => r.status === 'mismatch')) {
    const bad = results.filter(r => r.status === 'mismatch');
    return { status: 'mismatch', source: { legs: bad.map(b => ({ leg: b.leg, ...b.source })) } };
  }
  if (results.some(r => r.status === 'unreachable')) return { status: 'unreachable', source: { legs: results } };
  return { status: 'ok', source: { legs: results.map(r => ({ leg: r.leg, note: r.note })) } };
}

async function verifyPerpSpot(it, cache) {
  if (!SV.FUNDING_VENUES.has(it.shortVenue)) return { status: 'unreachable', note: `no adapter for ${it.shortVenue}` };
  if (!it.fresh) return { status: 'unreachable', note: 'stored perp-spot snapshot stale' };
  let live;
  try { live = await SV.FUNDING_ADAPTERS[it.shortVenue](it.coin, cache); }
  catch (e) { return { status: 'unreachable', note: `${it.shortVenue} fetch failed: ${String(e.message).slice(0, 60)}` }; }
  if (!live) return { status: 'unreachable', note: `${it.shortVenue} returned no rate` };
  const intervalH = it.intervalH > 0 ? it.intervalH : (live.intervalHours || 8);
  // Compare the SERVED %/8h directly against the venue's live %/8h.
  const livePct8h = SV.toPct8h(live.ratePct, live.intervalHours || intervalH);
  live.storedNextFundingTime = null; // perp-spot row carries no nextFundingTime; strict compare
  const fundingCmp = SV.compareFunding(it.servedPct8h, { ...live, ratePct: livePct8h }, 8);
  // Mark price (when both present) within 5%.
  let priceCmp = { status: 'ok' };
  if (it.servedMark != null && live.markPrice != null) priceCmp = SV.comparePrice(it.servedMark, live.markPrice);
  if (fundingCmp.status === 'mismatch') return { status: 'mismatch', source: { funding: fundingCmp.source } };
  if (priceCmp.status === 'mismatch')   return { status: 'mismatch', source: { mark: priceCmp.source } };
  return { status: 'ok', source: { funding: fundingCmp.source, mark: priceCmp.source } };
}

async function verifyUsdc(it, cache) {
  const results = [];
  for (const { venue, margin } of it.legs) {
    if (!SV.FUNDING_VENUES.has(venue)) { results.push({ status: 'unreachable', note: `no adapter for ${venue}` }); continue; }
    const map    = margin === 'USDC' ? it.futuresUsdc : it.futures;
    const stored = ((map[venue] || {})[it.coin]) || null;
    if (!stored || typeof stored.fundingRate !== 'number') { results.push({ status: 'unreachable', note: `no stored rate ${venue}:${it.coin}` }); continue; }
    if (!it.exFresh) { results.push({ status: 'unreachable', note: 'stored exchange-prices snapshot stale' }); continue; }
    let live;
    try { live = await SV.FUNDING_ADAPTERS[venue](it.coin, cache); }
    catch (e) { results.push({ status: 'unreachable', note: `${venue} fetch failed: ${String(e.message).slice(0, 60)}` }); continue; }
    if (!live) { results.push({ status: 'unreachable', note: `${venue} returned no rate` }); continue; }
    const intervalH = typeof stored.fundingIntervalHours === 'number' && stored.fundingIntervalHours > 0 ? stored.fundingIntervalHours : (live.intervalHours || 8);
    live.storedNextFundingTime = typeof stored.nextFundingTime === 'number' ? stored.nextFundingTime : null;
    const cmp = SV.compareFunding(stored.fundingRate, live, intervalH);
    results.push({ leg: `${venue}:${margin}`, ...cmp });
  }
  // Row status = worst leg (both funding legs must independently reconcile).
  if (results.some(r => r.status === 'mismatch')) {
    const bad = results.filter(r => r.status === 'mismatch');
    return { status: 'mismatch', source: { legs: bad.map(b => ({ leg: b.leg, ...b.source })) } };
  }
  if (results.some(r => r.status === 'unreachable')) return { status: 'unreachable', source: { legs: results } };
  return { status: 'ok', source: { legs: results.map(r => ({ leg: r.leg })) } };
}

async function verifyBasis(it) {
  if (!SV.BASIS_VENUES.has(it.venueKey)) return { status: 'unreachable', note: `no adapter for ${it.venueKey}` };
  if (!it.fresh) return { status: 'unreachable', note: 'stored basis snapshot stale' };
  let live;
  try { live = await SV.BASIS_ADAPTERS[it.venueKey](it.contract, it.asset); }
  catch (e) { return { status: 'unreachable', note: `${it.venueKey} fetch failed: ${String(e.message).slice(0, 60)}` }; }
  if (!live) return { status: 'unreachable', note: `${it.venueKey} ${it.contract} not found (delisted/expired?)` };
  const futureCmp = SV.comparePrice(it.servedFuture, live.mark);
  const spotCmp   = live.spot != null ? SV.comparePrice(it.servedSpot, live.spot) : { status: 'ok' };
  if (futureCmp.status === 'mismatch') return { status: 'mismatch', source: { future: futureCmp.source } };
  if (spotCmp.status === 'mismatch')   return { status: 'mismatch', source: { spot: spotCmp.source } };
  return { status: 'ok', source: { future: futureCmp.source, spot: spotCmp.source } };
}

async function verifyRewards(it) {
  if (it.venue !== 'polymarket') return { status: 'unreachable', note: `${it.venue} pool is derived, not a single source field` };
  if (!it.fresh) return { status: 'unreachable', note: 'stored rewards snapshot stale' };
  let live;
  try { live = await SV.fetchPolyPool(it.marketId); }
  catch (e) { return { status: 'unreachable', note: `gamma fetch failed: ${String(e.message).slice(0, 60)}` }; }
  if (!live) return { status: 'unreachable', note: 'market not found on gamma' };
  const cmp = SV.comparePool(it.servedPool, live.dailyPool);
  return cmp;
}

// ── One cycle ────────────────────────────────────────────────────────────────
async function runCycle(state, opts = {}) {
  SV.resetCallCount();
  const cache = {};            // per-cycle bulk-response memo (HL/dydx)
  const nowIso = Date.now();
  const rows = {};             // id → status entry
  const mismatches = [];

  const funding = buildFundingItems();
  const fundingSel = selectRotating(state, 'funding', funding.items, FUNDING_ABOVE_FOLD, FUNDING_ROTATE);
  const perpItems  = buildPerpSpotItems().slice(0, PERPSPOT_ABOVE_FOLD);
  const usdcItems  = buildUsdcItems().slice(0, USDC_ABOVE_FOLD);
  const basisSel   = selectRotating(state, 'basis', buildBasisItems(), BASIS_ABOVE_FOLD, BASIS_ROTATE);
  const rewardsSel = selectRotating(state, 'rewards', buildRewardsItems(), REWARDS_ABOVE_FOLD, REWARDS_ROTATE);

  state.rotation.funding = fundingSel.nextOffset;
  state.rotation.basis   = basisSel.nextOffset;
  state.rotation.rewards = rewardsSel.nextOffset;

  // Optional test hook: perturb one served value in-memory to prove the comparator
  // + serve-side enforcement flag+drop it (Phase 4). NEVER touches any file.
  if (opts.perturb) opts.perturb({ funding: fundingSel.set, perpItems, basisSel: basisSel.set });

  const budgetLeft = () => CALL_BUDGET_PER_CYCLE - SV.getCallCount();
  const record = (it, res) => {
    rows[it.id] = { verifiedAt: Date.now(), status: res.status, section: it.section,
                    ...(res.source ? { source: res.source } : {}), ...(res.note ? { note: res.note } : {}) };
    if (res.status === 'mismatch') mismatches.push({ id: it.id, section: it.section, source: res.source });
  };

  // Order: funding (highest phantom risk) → perp-spot → basis → rewards.
  for (const it of fundingSel.set) { if (budgetLeft() <= 2) break; record(it, await verifyFunding(it, cache)); }
  for (const it of perpItems)      { if (budgetLeft() <= 1) break; record(it, await verifyPerpSpot(it, cache)); }
  for (const it of usdcItems)      { if (budgetLeft() <= 2) break; record(it, await verifyUsdc(it, cache)); }
  for (const it of basisSel.set)   { if (budgetLeft() <= 2) break; record(it, await verifyBasis(it)); }
  for (const it of rewardsSel.set) { if (budgetLeft() <= 1) break; record(it, await verifyRewards(it)); }

  const cycleCalls = SV.getCallCount();
  const summary = { ok: 0, mismatch: 0, unreachable: 0 };
  for (const v of Object.values(rows)) summary[v.status] = (summary[v.status] || 0) + 1;

  atomicWrite(OUT_FILE, {
    updatedAt: nowIso, cycleMs: CYCLE_MS, cycleCalls, callBudget: CALL_BUDGET_PER_CYCLE,
    summary, rows,
  });

  log(`cycle: ${Object.keys(rows).length} rows verified — ok=${summary.ok} mismatch=${summary.mismatch} unreachable=${summary.unreachable} · ${cycleCalls}/${CALL_BUDGET_PER_CYCLE} calls`);
  return { mismatches, cycleCalls, summary, verified: Object.keys(rows).length };
}

// ── Mismatch alerting (deduped per row per 6h) ───────────────────────────────
// Pure dedupe selector (exported for tests): returns the mismatches that should
// alert NOW and mutates state.alerts with their fingerprint+timestamp. A row whose
// (id, source-fingerprint) already alerted within ALERT_COOLDOWN_MS is suppressed.
function selectFreshAlerts(mismatches, state, now) {
  if (!state.alerts) state.alerts = {};
  const fresh = [];
  for (const m of mismatches) {
    const key = crypto.createHash('sha256').update(m.id + JSON.stringify(m.source || {})).digest('hex').slice(0, 16);
    const last = state.alerts[m.id];
    if (last && last.key === key && now - last.at < ALERT_COOLDOWN_MS) continue;  // deduped
    state.alerts[m.id] = { key, at: now };
    fresh.push(m);
  }
  for (const [id, v] of Object.entries(state.alerts)) if (now - v.at > 2 * ALERT_COOLDOWN_MS) delete state.alerts[id]; // prune
  return fresh;
}

async function maybeAlert(mismatches, state) {
  const fresh = selectFreshAlerts(mismatches, state, Date.now());
  if (!fresh.length) return;
  const text = `⚠️ <b>Source-of-truth verification mismatch${fresh.length > 1 ? 'es' : ''}</b> (${fresh.length})\n\n` +
    fresh.map((m, i) => `${i + 1}. [${m.section}] <code>${m.id}</code>\n${JSON.stringify(m.source).slice(0, 240)}`).join('\n\n') +
    `\n\nServed rows are being DROPPED/flagged at the door until the source agrees.`;
  await sendTelegram(text);
}

async function main() {
  log('agent29-verifier starting — continuous source-of-truth verification');
  log(`  cadence: ${CYCLE_MS / 60_000} min · call budget: ${CALL_BUDGET_PER_CYCLE}/cycle · alert dedupe: ${ALERT_COOLDOWN_MS / 3_600_000}h`);
  log(`  funding venues re-readable: ${[...SV.FUNDING_VENUES].join(', ')}`);
  await new Promise(r => setTimeout(r, STARTUP_DELAY_MS));

  let state = loadState();
  while (true) {
    try {
      const { mismatches, cycleCalls, verified } = await runCycle(state);
      await maybeAlert(mismatches, state);
      saveState(state);
      beat({ verified, cycleCalls, mismatches: mismatches.length });
    } catch (e) {
      log('cycle error:', e.message);
      beat({ error: String(e.message).slice(0, 120) });
    }
    await new Promise(r => setTimeout(r, CYCLE_MS));
  }
}

// Exported for the Phase-4 test harness (inject a synthetic mismatch, run one cycle).
module.exports = {
  runCycle, buildFundingItems, buildPerpSpotItems, buildBasisItems, buildRewardsItems,
  verifyFunding, verifyPerpSpot, verifyBasis, verifyRewards, selectRotating, selectFreshAlerts,
};

if (require.main === module) {
  main().catch(e => { console.error('[A29] Fatal:', e); process.exit(1); });
}

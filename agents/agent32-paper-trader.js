#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// agent32-paper-trader — forward PAPER trading simulator.
//
// Freezes a $1000-per-opportunity entry at TODAY's real executable prices across
// every category the engine can price honestly, then marks-to-market from REAL
// live/settled data for SIM_DAYS days. This is a PAPER simulation: no API keys,
// no orders, no execution. It only READS the engine's existing JSON outputs.
//
// HONEST-ENGINE (absolute): every entry, mark and settlement comes from real
// source data. We NEVER fabricate a future price, funding rate, or outcome. When
// a forward value is not knowable from real data yet, it is left null and rendered
// "—". Categories whose forward $1000 P&L is not deterministically computable from
// real data (liquidity rewards) are EXCLUDED, not guessed.
//
// Categories:
//   • perp-spot funding  (IN)  — /tmp/perp-spot.json          → net $/day, real settled funding
//   • cross-venue funding(IN)  — /tmp/unified-opportunities   → net $/day, real settled funding
//   • basis / cash-carry (IN)  — /tmp/basis-opportunities     → net annualized % + expiry unlock
//   • prediction arb     (IN)  — /tmp/repriced-opportunities  → total ROI + unlock (0 today if no cashable)
//   • copy (mirror sleeve)(IN) — data/copy-events.json        → sleeve P&L from real fills
//   • liquidity rewards  (EXCLUDED) — forward reward is an estimate, not deterministic → "—"
//
// Writes data/paper-trades.json (atomic, gitignored). One compact daily Telegram
// summary. Does NOT touch any other agent, the dashboard, or reward/price math.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const { httpPost }        = require('../lib/httpGet');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');

// ── .env (pm2 doesn't auto-load project env files) ───────────────────────────
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

// ── paths & constants ────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const STORE_FILE = path.join(ROOT, 'data', 'paper-trades.json');

const SRC = {
  perpSpot:     '/tmp/perp-spot.json',
  unified:      '/tmp/unified-opportunities.json',
  basis:        '/tmp/basis-opportunities.json',
  repriced:     '/tmp/repriced-opportunities.json',
  arbDiscovery: '/tmp/arbitrage-opportunities.json',
  fundHist14d:  path.join(ROOT, 'data', 'funding-history-14d.json'),
  fundHistCache:'/tmp/funding-history-cache.json',
  copyEvents:   path.join(ROOT, 'data', 'copy-events.json'),
  paperPos:     path.join(ROOT, 'data', 'paper-positions.json'),
};

const HB_FILE = '/tmp/agent-heartbeats.json';
const HB_KEY  = 'agent32-paper-trader';

const NOTIONAL_USD     = 1000;            // $1000 per opportunity
const SIM_DAYS         = 7;               // mark-to-market horizon
const MARK_INTERVAL_MS = 6 * 60 * 60_000; // mark 4×/day; Telegram once/day
const DAY_MS           = 24 * 60 * 60_000;

const log   = (...a) => console.log('[agent32]', ...a);
const nowMs = () => Date.now();
const iso   = (ms) => new Date(ms).toISOString();
const round = (n, d = 2) => (n == null || !isFinite(n) ? null : Number(n.toFixed(d)));

// ── io helpers ───────────────────────────────────────────────────────────────
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[HB_KEY] = Date.now();
  try { atomicWriteJson(HB_FILE, hb, { pretty: true }); } catch {}
}
async function sendTelegram(text) {
  if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') return;   // fleet-wide mute
  if (!BOT_TOKEN || !CHAT_ID) { log('Telegram not configured — logged only:\n' + text); return; }
  try {
    await httpPost(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text, parse_mode: 'HTML' }, { timeoutMs: 10_000 });
  } catch (e) { log('sendTelegram error:', e.message); }
}

// ── settled-funding accrual (REAL only) ──────────────────────────────────────
// Sum the SETTLED funding rates (fractions) a venue/coin posted in (sinceT, untilT].
// Merges the durable 14d mirror and the 48h cache, dedups by settlement timestamp.
// Never touches predicted/current ticker rates. Returns { sumRate, points, lastT }.
function accrueSettled(venueKey, coin, sinceT, untilT) {
  const series = [];
  for (const f of [SRC.fundHist14d, SRC.fundHistCache]) {
    const j = readJsonSafe(f);
    const arr = j && j.data && j.data[venueKey] && j.data[venueKey][coin];
    if (Array.isArray(arr)) series.push(...arr);
  }
  const seen = new Set();
  let sumRate = 0, points = 0, lastT = sinceT;
  for (const p of series) {
    if (!p || typeof p.t !== 'number' || typeof p.rate !== 'number') continue;
    if (p.t <= sinceT || p.t > untilT) continue;
    if (seen.has(p.t)) continue;
    seen.add(p.t);
    sumRate += p.rate; points += 1;
    if (p.t > lastT) lastT = p.t;
  }
  return { sumRate, points, lastT };
}

// ── venue-name normalization for funding history keys ────────────────────────
// funding-history files key by lowercase venue id (lighter, extended, binance,
// okx, bybit, grvt, paradex, hyperliquid…). Cross-venue leg.platform is a label
// like "Lighter (DEX)"; the opp id "funding-<coin>-<short>-<long>" carries the ids.
function venueKeyFromLabel(label) {
  if (!label) return null;
  return String(label).toLowerCase().replace(/\s*\(dex\)\s*/g, '').replace(/[^a-z0-9]/g, '').trim() || null;
}
function parseFundingId(id) {
  // funding-<coin>-<short>-<long>
  const parts = String(id || '').split('-');
  if (parts[0] !== 'funding' || parts.length < 4) return null;
  return { coin: parts[1], shortVenue: parts[2], longVenue: parts.slice(3).join('-') };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — SNAPSHOT ENTRIES  (freeze $1000 tickets at real executable prices)
// ─────────────────────────────────────────────────────────────────────────────

function entryPerpSpot() {
  const j = readJsonSafe(SRC.perpSpot);
  if (!j || !Array.isArray(j.rows)) return { trades: [], dropped: [] };
  const trades = [], dropped = [];
  for (const r of j.rows) {
    if (!r || !r.spotExecutable || r.spotAsk == null || r.markPrice == null) {
      dropped.push({ id: `ps-${r && r.coin}`, why: 'spot not executable / missing price' }); continue;
    }
    const cap  = Number(r.wholeTradeCapacityUsd) || 0;
    const size = Math.min(NOTIONAL_USD, cap);
    if (size <= 0) { dropped.push({ id: `ps-${r.coin}`, why: 'zero capacity' }); continue; }
    const feesUsd = size * ((Number(r.perpFeePct) || 0) + (Number(r.spotFeePct) || 0)) / 100; // real taker %, round-trip est
    trades.push({
      id: `ps-${r.coin}-${r.shortVenue}`,
      category: 'perp-spot-funding',
      label: `${r.coin} short ${r.shortVenue} / long spot ${r.spotVenueSuggested}`,
      status: 'open',
      metricKind: 'net_per_day',
      entry: {
        asOf: iso(nowMs()), sourceAt: r.sourceAt || j.sourceAt || null,
        legs: [
          { venue: r.shortVenue, side: 'SHORT perp', price: round(r.markPrice, 6) },
          { venue: r.spotVenueSuggested, side: 'LONG spot', price: round(r.spotAsk, 6) },
        ],
        notionalUsd: round(size), sizedDownFrom: size < NOTIONAL_USD ? NOTIONAL_USD : null,
        capacityUsd: round(cap), feesUsd: round(feesUsd, 4),
        fundingVenue: String(r.shortVenue).toLowerCase(), coin: r.coin,
        estNetPerDayAtEntry: round(r.netPerDay1kUsd, 4),
        trailingPositiveSettlements: r.trailingPositiveSettlements ?? null,
      },
      // funding accrual bookkeeping — anchor at the ENTRY moment so we never count
      // funding that settled before this paper entry; only NEW settled points accrue.
      fundingCursorT: nowMs(),
      cumFundingUsd: 0,
      marks: [],
    });
  }
  return { trades, dropped };
}

function entryCrossVenue() {
  const j = readJsonSafe(SRC.unified);
  const opps = j && Array.isArray(j.opportunities) ? j.opportunities : [];
  const trades = [], dropped = [];
  for (const o of opps) {
    if (o.type !== 'FUNDING') continue;
    if (!o.fullyConfirmed) { dropped.push({ id: o.id, why: 'not fully confirmed (settled unverified)' }); continue; }
    const ids = parseFundingId(o.id);
    const shortLeg = o.legs && o.legs[0], longLeg = o.legs && o.legs[1];
    if (!ids || !shortLeg || !longLeg) { dropped.push({ id: o.id, why: 'unparseable legs' }); continue; }
    // Honest sign: entry funding rate uses SETTLED trailingRate, never predictedRate.
    if (shortLeg.trailingRate == null || longLeg.trailingRate == null) {
      dropped.push({ id: o.id, why: 'no settled trailing rate' }); continue;
    }
    const cap  = Number(o.capacityUsd) || 0;
    const size = Math.min(NOTIONAL_USD, cap);
    if (size <= 0) { dropped.push({ id: o.id, why: 'zero capacity' }); continue; }
    const feesUsd = size * (Number(o.totalFeesPct) || 0) / 100;
    trades.push({
      id: `xv-${o.id}`,
      category: 'cross-venue-funding',
      label: o.question || `${ids.coin} funding spread`,
      status: 'open',
      metricKind: 'net_per_day',
      entry: {
        asOf: iso(nowMs()), sourceAt: j.generatedAt || null,
        legs: [
          { venue: ids.shortVenue, side: 'SHORT', settledRate: round(shortLeg.trailingRate, 6), intervalH: shortLeg.intervalHours ?? null },
          { venue: ids.longVenue,  side: 'LONG',  settledRate: round(longLeg.trailingRate, 6),  intervalH: longLeg.intervalHours ?? null },
        ],
        coin: ids.coin, notionalUsd: round(size), sizedDownFrom: size < NOTIONAL_USD ? NOTIONAL_USD : null,
        capacityUsd: round(cap), feesUsd: round(feesUsd, 4),
        estNetRoiAtEntry: round(o.netROI, 3), estAnnualizedAtEntry: round(o.annualizedROI, 2),
        verdict: o.verdict || null,
      },
      fundingCursorT: nowMs(),   // anchor accrual at entry moment (settled points only, forward)
      cumFundingUsd: 0,
      marks: [],
    });
  }
  return { trades, dropped };
}

function entryBasis() {
  const j = readJsonSafe(SRC.basis);
  const opps = j && Array.isArray(j.opportunities) ? j.opportunities : [];
  const trades = [], dropped = [];
  for (const o of opps) {
    if (o.executableBasisPct == null || o.spotAsk == null || o.futureBid == null) {
      dropped.push({ id: o.contract, why: 'missing executable price' }); continue;
    }
    if (!(Number(o.netAnnualizedExecutable) > 0)) { dropped.push({ id: o.contract, why: 'net annualized ≤ 0' }); continue; }
    const cap  = Number(o.capacityUsd) || 0;
    const size = Math.min(NOTIONAL_USD, cap);
    if (size <= 0) { dropped.push({ id: o.contract, why: 'zero capacity' }); continue; }
    const feesUsd = size * (Number(o.fee) || 0); // fee is a round-trip decimal fraction
    trades.push({
      id: `basis-${o.venueKey}-${o.contract}`,
      category: 'basis',
      label: `${o.asset} cash&carry ${o.exchange} ${o.contract}`,
      status: 'open',
      metricKind: 'net_annualized_unlock',
      entry: {
        asOf: iso(nowMs()), sourceAt: j.updatedAt || null,
        legs: [
          { venue: 'spot', side: 'LONG spot', price: round(o.spotAsk, 4) },
          { venue: o.exchange, side: 'SHORT future', price: round(o.futureBid, 4) },
        ],
        entryBasisPct: round(o.executableBasisPct, 6),   // fraction
        notionalUsd: round(size), sizedDownFrom: size < NOTIONAL_USD ? NOTIONAL_USD : null,
        capacityUsd: round(cap), capacitySource: o.capacitySource || null, feesUsd: round(feesUsd, 4),
        netAnnualizedAtEntry: round(o.netAnnualizedExecutable * 100, 3),  // %/yr
        expiry: o.expiry || null, daysToExpiry: o.daysToExpiry ?? null,
      },
      contractKey: `${o.venueKey}|${o.contract}`,
      marks: [],
    });
  }
  return { trades, dropped };
}

function entryPrediction() {
  // Only honest, executable, cashable arbs with real depth to size $1000.
  const j = readJsonSafe(SRC.repriced);
  const opps = j && Array.isArray(j.opportunities) ? j.opportunities : [];
  const trades = [], dropped = [];
  for (const o of opps) {
    if (o.status !== 'cashable') { dropped.push({ id: o.question, why: `status=${o.status || 'n/a'} (not cashable)` }); continue; }
    const cap  = Number(o.capacityUsd) || 0;
    const size = Math.min(NOTIONAL_USD, cap);
    if (size <= 0) { dropped.push({ id: o.question, why: 'no real depth for $1000' }); continue; }
    const lm = o.lowMarket || {}, hm = o.highMarket || {};
    trades.push({
      id: `pred-${(o.question || '').slice(0, 40)}`,
      category: 'prediction-arb',
      label: o.question || 'prediction arb',
      status: 'open',
      metricKind: 'total_roi_unlock',
      entry: {
        asOf: iso(nowMs()), sourceAt: j.repriced_at || null,
        legs: [
          { venue: lm.platform, side: 'buy YES', yesAsk: round(lm.yesAsk, 4), url: lm.url || null },
          { venue: hm.platform, side: 'buy NO',  yesBid: round(hm.yesBid, 4), url: hm.url || null },
        ],
        bestDir: o.live_bestDir ?? null,
        notionalUsd: round(size), sizedDownFrom: size < NOTIONAL_USD ? NOTIONAL_USD : null,
        capacityUsd: round(cap),
        liveRoiAtEntry: round(o.live_roi, 3), unlockDate: o.resolutionDate || null,
      },
      marks: [],
    });
  }
  return { trades, dropped };
}

// Copy mirror sleeve: seed $1000 budget per tracked wallet; mirror ONLY real new
// fills observed from entry forward, at their real fill prices. No backfill.
function entryCopySleeves(entryTs) {
  const j = readJsonSafe(SRC.copyEvents);
  const events = j && Array.isArray(j.events) ? j.events : [];
  const wallets = new Map();
  for (const e of events) {
    if (!e || !e.wallet) continue;
    if (!wallets.has(e.wallet)) wallets.set(e.wallet, { wallet: e.wallet, name: e.name || e.wallet });
  }
  const sleeves = [];
  for (const w of wallets.values()) {
    sleeves.push({
      id: `copy-${w.wallet.slice(0, 10)}`,
      category: 'copy',
      label: `mirror ${w.name}`,
      status: 'open',
      metricKind: 'sleeve_pnl',
      wallet: w.wallet,
      budgetUsd: NOTIONAL_USD, deployedUsd: 0,
      realizedUsd: 0,
      copyCursorTs: Math.floor(entryTs / 1000),  // seconds; mirror only fills strictly after entry
      positions: {},   // "cid|outcome" -> { shares, entryAvg, market, category, openedAt }
      closed: [],
      marks: [],
    });
  }
  return sleeves;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — DAILY MARK LOOP  (real prices / settled funding / settlements only)
// ─────────────────────────────────────────────────────────────────────────────

function markPerpSpot(t, until) {
  const { sumRate, points, lastT } = accrueSettled(t.entry.fundingVenue, t.entry.coin, t.fundingCursorT, until);
  // SHORT perp collects funding when settled rate > 0.
  const add = sumRate * t.entry.notionalUsd;
  t.cumFundingUsd += add;
  t.fundingCursorT = lastT;
  const netUsd = t.cumFundingUsd - (t.entry.feesUsd || 0);
  return {
    asOf: iso(until), realFundingPointsAdded: points,
    cumFundingUsd: round(t.cumFundingUsd, 4), netUsd: round(netUsd, 4),
    note: points ? null : 'no new settled funding since last mark',
  };
}

function markCrossVenue(t, until) {
  const [s, l] = t.entry.legs;
  const shortAcc = accrueSettled(s.venue, t.entry.coin, t.fundingCursorT, until);
  const longAcc  = accrueSettled(l.venue, t.entry.coin, t.fundingCursorT, until);
  // net funding = collect on short leg (+) − pay on long leg (−), settled only.
  const add = (shortAcc.sumRate - longAcc.sumRate) * t.entry.notionalUsd;
  t.cumFundingUsd += add;
  t.fundingCursorT = Math.max(shortAcc.lastT, longAcc.lastT);
  const pts = shortAcc.points + longAcc.points;
  const netUsd = t.cumFundingUsd - (t.entry.feesUsd || 0);
  return {
    asOf: iso(until), realFundingPointsAdded: pts,
    cumFundingUsd: round(t.cumFundingUsd, 4), netUsd: round(netUsd, 4),
    note: pts ? null : 'no new settled funding since last mark',
  };
}

function markBasis(t, until) {
  const j = readJsonSafe(SRC.basis);
  const opps = j && Array.isArray(j.opportunities) ? j.opportunities : [];
  const cur = opps.find(o => `${o.venueKey}|${o.contract}` === t.contractKey);
  if (!cur || cur.executableBasisPct == null) {
    return { asOf: iso(until), unrealizedUsd: null, currentBasisPct: null, note: 'contract not in current book — mark "—"' };
  }
  // long spot / short future: you earn as basis converges from entry toward 0.
  const conv = (t.entry.entryBasisPct - cur.executableBasisPct);   // fraction
  const unrealizedUsd = conv * t.entry.notionalUsd - (t.entry.feesUsd || 0);
  return {
    asOf: iso(until), currentBasisPct: round(cur.executableBasisPct, 6),
    unrealizedUsd: round(unrealizedUsd, 4),
    spot: round(cur.spot, 4), future: round(cur.future, 4), note: null,
  };
}

function markPrediction(t, until) {
  const j = readJsonSafe(SRC.repriced);
  const opps = j && Array.isArray(j.opportunities) ? j.opportunities : [];
  const cur = opps.find(o => `pred-${(o.question || '').slice(0, 40)}` === t.id);
  if (!cur) {
    // Not currently cashable / evaporated — no real exit price to mark against.
    return { asOf: iso(until), liveRoi: null, unrealizedUsd: null, note: 'no live executable quote — mark "—" (no settled outcome source)' };
  }
  return {
    asOf: iso(until), liveRoi: round(cur.live_roi, 3),
    unrealizedUsd: round((Number(cur.live_roi) || 0) / 100 * t.entry.notionalUsd, 4),
    note: 'marked at real live executable prices; realizes only at real resolution',
  };
}

function markCopySleeve(sleeve, until) {
  const j = readJsonSafe(SRC.copyEvents);
  const events = (j && Array.isArray(j.events) ? j.events : [])
    .filter(e => e.wallet === sleeve.wallet && typeof e.timestamp === 'number')
    .sort((a, b) => a.timestamp - b.timestamp);
  const pp = readJsonSafe(SRC.paperPos);
  const lastPrice = (pp && pp.lastPrice) || {};

  let applied = 0;
  for (const e of events) {
    if (e.timestamp <= sleeve.copyCursorTs) continue;         // only fills after last cursor
    if (!(e.price > 0 && e.price < 1 && e.size > 0)) continue; // executable only
    const key = `${e.cid}|${e.outcome}`;
    const pos = sleeve.positions[key];
    const isOpen = e.action === 'OPEN' || e.action === 'ADD';
    if (isOpen) {
      const remaining = sleeve.budgetUsd - sleeve.deployedUsd;
      if (remaining <= 0) { sleeve.copyCursorTs = e.timestamp; continue; } // budget spent → skip new opens honestly
      const costWanted = e.size * e.price;
      const cost = Math.min(costWanted, remaining);
      const shares = cost / e.price;
      if (pos) {
        const totShares = pos.shares + shares;
        pos.entryAvg = (pos.entryAvg * pos.shares + e.price * shares) / totShares;
        pos.shares = totShares;
      } else {
        sleeve.positions[key] = { shares, entryAvg: e.price, market: e.market, category: e.category || 'other', openedAt: e.timestamp };
      }
      sleeve.deployedUsd += cost;
    } else if ((e.action === 'REDUCE' || e.action === 'CLOSE') && pos) {
      const sellShares = Math.min(pos.shares, e.size * (pos.shares / (e.prevSize || e.size || pos.shares)));
      const sold = Math.min(pos.shares, sellShares || pos.shares);
      const pnl = sold * (e.price - pos.entryAvg);   // real exit price
      sleeve.realizedUsd += pnl;
      sleeve.deployedUsd -= sold * pos.entryAvg;
      pos.shares -= sold;
      sleeve.closed.push({ market: pos.market, outcome: e.outcome, shares: round(sold, 2), entryAvg: round(pos.entryAvg, 4), exitPrice: round(e.price, 4), pnl: round(pnl, 4), closedAt: e.timestamp });
      if (pos.shares <= 1e-6) delete sleeve.positions[key];
    }
    sleeve.copyCursorTs = e.timestamp;
    applied++;
  }

  // unrealized: mark open positions ONLY at a real observed price; else "—" (null).
  let unrealizedUsd = 0, marked = 0, unmarked = 0;
  for (const [key, pos] of Object.entries(sleeve.positions)) {
    const mk = lastPrice[key];
    if (typeof mk === 'number' && mk > 0) { unrealizedUsd += pos.shares * (mk - pos.entryAvg); marked++; }
    else unmarked++;
  }
  const openCount = Object.keys(sleeve.positions).length;
  return {
    asOf: iso(until), newFillsApplied: applied, openPositions: openCount,
    deployedUsd: round(sleeve.deployedUsd), realizedUsd: round(sleeve.realizedUsd, 4),
    unrealizedUsd: marked ? round(unrealizedUsd, 4) : null,
    unmarkedOpen: unmarked,
    note: unmarked ? `${unmarked} open leg(s) have no real mark yet → "—"` : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// orchestration
// ─────────────────────────────────────────────────────────────────────────────

function buildSnapshot() {
  const entryTs = nowMs();
  const ps  = entryPerpSpot();
  const xv  = entryCrossVenue();
  const bs  = entryBasis();
  const pr  = entryPrediction();
  const copySleeves = entryCopySleeves(entryTs);
  const trades = [...ps.trades, ...xv.trades, ...bs.trades, ...pr.trades];
  return {
    version: 1,
    createdAt: iso(entryTs), updatedAt: iso(entryTs),
    entryAsOf: iso(entryTs), simDays: SIM_DAYS, simEndsAt: iso(entryTs + SIM_DAYS * DAY_MS),
    notionalUsd: NOTIONAL_USD,
    trades, copySleeves,
    excluded: [{
      category: 'liquidity-rewards',
      reason: 'Forward $1000 reward is not deterministically knowable: reward = pool × your-share, and share depends on assumed placement distance, future competitor depth, and fills/adverse-selection. The engine itself labels every $/day an ESTIMATE. Excluded per honest-engine (mark "—", do not guess).',
      value: '—',
    }],
    dropped: {
      'perp-spot-funding': ps.dropped,
      'cross-venue-funding': xv.dropped,
      'basis': bs.dropped,
      'prediction-arb': pr.dropped,
    },
    lastTelegramDay: null,
  };
}

function markAll(store) {
  const until = nowMs();
  const active = t => t.status === 'open';
  for (const t of store.trades.filter(active)) {
    let mark = null;
    try {
      if (t.category === 'perp-spot-funding')  mark = markPerpSpot(t, until);
      else if (t.category === 'cross-venue-funding') mark = markCrossVenue(t, until);
      else if (t.category === 'basis')         mark = markBasis(t, until);
      else if (t.category === 'prediction-arb') mark = markPrediction(t, until);
    } catch (e) { mark = { asOf: iso(until), error: e.message, note: 'mark error — value withheld' }; }
    if (mark) { t.marks.push(mark); t.lastMark = mark; }
    if (until >= new Date(store.simEndsAt).getTime()) t.status = 'matured';
  }
  for (const s of store.copySleeves.filter(active)) {
    let mark = null;
    try { mark = markCopySleeve(s, until); } catch (e) { mark = { asOf: iso(until), error: e.message }; }
    if (mark) { s.marks.push(mark); s.lastMark = mark; }
    if (until >= new Date(store.simEndsAt).getTime()) s.status = 'matured';
  }
  store.updatedAt = iso(until);
}

function fmtUsd(n) { return n == null ? '—' : `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`; }

function dailySummary(store) {
  const byCat = {};
  for (const t of store.trades) {
    const c = t.category;
    byCat[c] = byCat[c] || { open: 0, matured: 0, agg: 0, has: false };
    if (t.status === 'open') byCat[c].open++; else if (t.status === 'matured') byCat[c].matured++;
    const m = t.lastMark || {};
    const v = m.netUsd != null ? m.netUsd : (m.unrealizedUsd != null ? m.unrealizedUsd : null);
    if (v != null) { byCat[c].agg += v; byCat[c].has = true; }
  }
  let copyOpen = 0, copyAgg = 0, copyHas = false;
  for (const s of store.copySleeves) {
    copyOpen += (s.lastMark && s.lastMark.openPositions) || 0;
    const r = s.realizedUsd || 0; const u = (s.lastMark && s.lastMark.unrealizedUsd) || 0;
    copyAgg += r + u; if (s.realizedUsd != null) copyHas = true;
  }
  const lines = [];
  lines.push(`📄 <b>Paper book</b> · day ${Math.max(0, Math.floor((nowMs() - new Date(store.entryAsOf).getTime()) / DAY_MS))}/${store.simDays}`);
  const label = { 'perp-spot-funding': 'Perp-spot (net$/day)', 'cross-venue-funding': 'Cross-venue (net$/day)', 'basis': 'Basis (net ann.)', 'prediction-arb': 'Prediction (ROI+unlock)' };
  for (const [c, v] of Object.entries(byCat)) {
    lines.push(`• ${label[c] || c}: ${v.open} open — paper P&L ${v.has ? fmtUsd(v.agg) : '—'}`);
  }
  lines.push(`• Copy mirror: ${store.copySleeves.length} sleeve(s), ${copyOpen} open legs — paper P&L ${copyHas ? fmtUsd(copyAgg) : '—'}`);
  lines.push(`• Liquidity rewards: — (excluded, forward reward not deterministic)`);
  const settled = store.trades.filter(t => t.status === 'settled' || t.status === 'matured');
  if (settled.length) lines.push(`• Matured/settled: ${settled.length}`);
  lines.push(`<i>real marks only · as-of ${store.updatedAt}</i>`);
  return lines.join('\n');
}

async function runCycle() {
  beat();
  let store = readJsonSafe(STORE_FILE);
  if (!store || !Array.isArray(store.trades)) {
    store = buildSnapshot();
    log(`snapshot frozen: ${store.trades.length} trades + ${store.copySleeves.length} copy sleeves`);
    atomicWriteJson(STORE_FILE, store, { pretty: true });
  }
  markAll(store);

  // one compact Telegram summary per calendar day
  const today = iso(nowMs()).slice(0, 10);
  if (store.lastTelegramDay !== today) {
    await sendTelegram(dailySummary(store));
    store.lastTelegramDay = today;
  }
  atomicWriteJson(STORE_FILE, store, { pretty: true });
  log(`cycle done · trades=${store.trades.length} copySleeves=${store.copySleeves.length} updatedAt=${store.updatedAt}`);
}

async function main() {
  beat();
  setInterval(beat, 5_000);
  await runCycle();
  setInterval(() => runCycle().catch(e => log('cycle error:', e.message)), MARK_INTERVAL_MS);
}

if (require.main === module) {
  process.on('uncaughtException',  (e) => log('uncaughtException:', e && e.message));
  process.on('unhandledRejection', (e) => log('unhandledRejection:', e && (e.message || e)));
  process.on('SIGINT',  () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  main().catch((e) => { log('fatal:', e && e.message); process.exit(1); });
}

module.exports = { buildSnapshot, markAll, accrueSettled, entryPerpSpot, entryCrossVenue, entryBasis, entryPrediction };

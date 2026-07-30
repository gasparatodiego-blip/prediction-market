'use strict';
// lib/maker/operator-board.js — the READ-ONLY aggregation core behind the operator's single-page
// liquidity-rewards console (/dashboard/liquidity-rewards).
//
// WHAT IT IS. One place that answers the four questions the console's six sections ask, each from the
// SAME sources the engine and the manual panel already read — never a second copy of the math:
//
//   markets   → /tmp/liquidity-rewards.json (agent24/25 normalized scan) + /tmp/clob-live-books.json
//               (agent34 live CLOB), resolved through resolveMarketRules — the identical function the
//               manual-order form and the placement path use for tick / scoring mid / band / min size.
//   orders    → listManualOrders() → the VENUE's own open-order list, through the CANCEL-ONLY adapter.
//   band      → lib/rewards-live-band.inBand via lib/maker/venue-rules.validateQuote — the ONE shared
//               guard. This module NEVER re-derives a band radius or an in/out verdict of its own.
//   estimate  → lib/reward-operator-estimate.estimatedOperatorSharePerDay over the feed's own
//               rewardScore block. The $/day here is the same number the public board shows.
//
// WHAT IT IS NOT. It holds no key, signs nothing, constructs no order and writes no file. It cannot
// place, cancel, arm, disarm or touch the kill switch. Every function here is a read.
//
// POLYMARKET ONLY. The console is a Polymarket maker surface (the reward program, the CLOB adapter and
// the band math are all Polymarket's), so Kalshi rows in the shared feed are dropped here, at the source,
// rather than hidden in the browser.
//
// HONEST NULLS. A market whose rules are unreadable keeps readable:false and every derived verdict stays
// null — never a guessed band, never a fabricated zero. An order list that did not reach the venue is
// reported `simulated:true` with ok:true, which means "we did not read", NOT "you have no orders". The
// two are different facts and the console renders them differently.

const fs = require('fs');

const { validateQuote } = require('./venue-rules');
const { inBand } = require('../rewards-live-band');
const { resolveMarketRules, listManualOrders } = require('./manual-order');
// estimateAtCapital lives in the estimator module (pure, browser-safe) so the client console and this
// server aggregation price $/day with the SAME function — there is no second copy of the rescale.
const { estimateAtCapital } = require('../reward-operator-estimate');
const { dropResolvedRewards, resolveMakerUniverse } = require('./universe');
const { getMakerSelection } = require('./selection');
const { stabilityOf } = require('../reward-stability');
const { inventoryWallet } = require('./inventory-read');
const { fetchOpenPositions, normPosition } = require('../open-positions-fetch');

const VENUE = 'polymarket';
const LIVE_BOOKS_FILE = '/tmp/clob-live-books.json';
const NORMALIZED_FILE = '/tmp/liquidity-rewards.json';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function r2(x) { return fin(x) ? Math.round(x * 100) / 100 : null; }

// ── SPREAD, JUDGED AGAINST THE REWARD BAND (not against an invented cent threshold) ─────────────────
// For a maker the question is never "is 2¢ wide?" in the abstract — it is "can I rest inside the band
// and still be at or near the touch?". So the book spread is classified RELATIVE to the band the reward
// program actually pays on: at or inside the half-band is 'basso', up to the full band is 'medio', wider
// than the band is 'alto' (the touch itself sits outside the paying zone). Unknown band ⇒ null, never a
// default classification.
function classifySpread(bookSpread, maxSpreadCents) {
  const spreadCents = fin(bookSpread) ? bookSpread * 100 : null;
  if (spreadCents == null || !fin(maxSpreadCents) || maxSpreadCents <= 0) {
    return { spreadCents, level: null, label: null, note: 'banda o spread non leggibili' };
  }
  const half = maxSpreadCents / 2;
  if (spreadCents <= half + 1e-9) {
    return { spreadCents, level: 'basso', label: 'spread basso',
      note: `${spreadCents.toFixed(2)}¢ ≤ mezza banda (${half.toFixed(2)}¢) — si sta al tocco restando in banda` };
  }
  if (spreadCents <= maxSpreadCents + 1e-9) {
    return { spreadCents, level: 'medio', label: 'spread medio',
      note: `${spreadCents.toFixed(2)}¢ ≤ banda intera (${maxSpreadCents.toFixed(2)}¢) — in banda sì, ma non al tocco` };
  }
  return { spreadCents, level: 'alto', label: 'spread alto',
    note: `${spreadCents.toFixed(2)}¢ > banda (${maxSpreadCents.toFixed(2)}¢) — il tocco è fuori dalla zona premiata` };
}

// ── ONE RESTING ORDER, JUDGED ───────────────────────────────────────────────────────────────────────
// The book an order sits on is resolved from its TOKEN ID against the market's two token ids — never
// guessed from the side or the price. A NO order at q is a YES order at 1−q, so it is judged against the
// NO book's scoring mid (1−mid), exactly the mirror agent35 and the manual form use.
// Unknown token ⇒ book null ⇒ every verdict null. We do not judge what we cannot place.
function judgeOrder(order, rules) {
  const tokenId = order && order.tokenId != null ? String(order.tokenId) : null;
  let book = null;
  if (rules && tokenId) {
    if (rules.tokenId && tokenId === String(rules.tokenId)) book = 'yes';
    else if (rules.tokenIdNo && tokenId === String(rules.tokenIdNo)) book = 'no';
  }
  const scoringMid = !rules || !book ? null : (book === 'no' ? rules.books.no.scoringMid : rules.books.yes.scoringMid);
  const bandRadiusCents = rules && fin(rules.bandRadiusCents) ? rules.bandRadiusCents : null;
  const price = fin(order && order.price) ? order.price : null;

  const distanceCents = (price != null && fin(scoringMid)) ? Math.abs(price - scoringMid) * 100 : null;
  const signedDistanceCents = (price != null && fin(scoringMid)) ? (price - scoringMid) * 100 : null;
  // The SHARED band test — same predicate the guard and the board warning call.
  const isInBand = (price != null && fin(scoringMid) && fin(rules && rules.maxSpreadCents))
    ? inBand(price, scoringMid, rules.maxSpreadCents)
    : null;

  // The FULL shared guard, so an order that is in-band but off-tick or under the min size is not painted
  // as healthy. Size judged on what is still RESTING (remaining), which is what earns.
  const restingSize = fin(order && order.sizeRemaining) ? order.sizeRemaining : (fin(order && order.size) ? order.size : null);
  const verdict = (rules && rules.readable && price != null && restingSize != null && book)
    ? validateQuote(
      { tick: rules.tick, scoringMid, maxSpreadCents: rules.maxSpreadCents, minSize: rules.minSize },
      { side: 'BUY', price, size: restingSize },
    )
    : null;

  // The price that would put this order back at the scoring mid, snapped to the venue tick. It is a
  // SUGGESTION for the operator's Riprezza form, never an action — nothing here places anything.
  let suggestedPrice = null;
  if (fin(scoringMid) && fin(rules && rules.tick) && rules.tick > 0) {
    const snapped = Math.round(scoringMid / rules.tick) * rules.tick;
    suggestedPrice = +snapped.toFixed(6);
  }

  return {
    ...order,
    book,
    scoringMid: fin(scoringMid) ? scoringMid : null,
    bandRadiusCents,
    distanceCents: r2(distanceCents),
    signedDistanceCents: r2(signedDistanceCents),
    inBand: isInBand,
    // outOfBand is only TRUE when we could actually judge it. null ⇒ unknown, and the console counts it
    // as unknown rather than folding it into either bucket.
    outOfBand: isInBand === null ? null : !isInBand,
    valid: verdict ? verdict.valid : null,
    reasons: verdict ? verdict.reasons : [],
    suggestedPrice,
    restingSize,
    restingNotionalUsd: (price != null && restingSize != null) ? r2(price * restingSize) : null,
    marketTitle: rules ? (rules.title || null) : null,
    rulesReadable: rules ? rules.readable : false,
  };
}

/**
 * Every Polymarket reward market, with the geometry the price ladder draws and the estimate the board
 * shows. Read-only; no venue call — both inputs are files the agents already write.
 *
 * @param {{ books?:object, norm?:object }} deps  injected fixtures (tests); production reads the files
 */
async function buildMarketBoard(deps = {}) {
  const books = deps.books || readJson(LIVE_BOOKS_FILE);
  const norm = deps.norm || readJson(NORMALIZED_FILE);
  const rows = norm && Array.isArray(norm.markets) ? norm.markets : [];

  // Polymarket only, and never a market whose resolution time has passed (the SAME lifecycle drop the
  // public board and the bot's universe resolver apply — shared predicate, not a second rule).
  const poly = dropResolvedRewards(rows.filter((m) => m && m.venue === VENUE));

  // Which of them the bot is actually quoting, resolved by the SHARED universe resolver over the SAME
  // stored selection the bot reads. Unreadable selection ⇒ NO market is marked as the bot's, rather than
  // a guessed set: "we don't know which" must not render as "none of them are".
  // The stored selection lives in the DB, so the caller injects either the selection itself (tests) or
  // the prisma client to read it with — this module never reaches for a database connection of its own.
  let universeIds = new Set();
  let selection = null;
  let selectionReadable = true;
  try {
    if (deps.selection !== undefined) selection = deps.selection;
    else if (deps.prisma) selection = await getMakerSelection(deps.prisma);
    else throw new Error('né selection né prisma forniti');
    const u = resolveMakerUniverse(rows, selection);
    universeIds = new Set(u.resolvedMarketIds || []);
  } catch {
    selectionReadable = false;
    selection = null;
  }

  const markets = poly.map((m) => {
    const rules = resolveMarketRules(m.marketId, { books, norm });
    const stability = stabilityOf(m);
    const spread = classifySpread(m.bookSpread, rules.maxSpreadCents != null ? rules.maxSpreadCents : m.maxSpread);

    const mid = rules.mid != null ? rules.mid : (fin(m.midpoint) ? m.midpoint : null);
    const maxSpreadCents = rules.maxSpreadCents != null ? rules.maxSpreadCents : (fin(m.maxSpread) ? m.maxSpread : null);
    const bandRadiusCents = fin(maxSpreadCents) ? maxSpreadCents / 2 : null;

    return {
      marketId: m.marketId,
      title: m.title || rules.title || null,
      groupItemTitle: m.groupItemTitle || null,
      slug: m.slug || null,
      marketSlug: m.marketSlug || null,
      category: m.category || null,
      inBotUniverse: selectionReadable ? universeIds.has(m.marketId) : null,

      // ── ladder geometry (all real, all from the same instant as the mid above) ──
      mid,
      midSource: rules.midSource,
      midAgeSec: rules.midAgeSec,
      bestBid: rules.bestBid,
      bestAsk: rules.bestAsk,
      tick: rules.tick,
      minSize: rules.minSize,
      maxSpreadCents,
      bandRadiusCents,
      bandLo: (fin(mid) && fin(bandRadiusCents)) ? +(mid - bandRadiusCents / 100).toFixed(6) : null,
      bandHi: (fin(mid) && fin(bandRadiusCents)) ? +(mid + bandRadiusCents / 100).toFixed(6) : null,
      rulesReadable: rules.readable,
      rulesMissing: rules.missing,
      tokenId: rules.tokenId,
      tokenIdNo: rules.tokenIdNo,

      // ── economics ──
      // NO $/day IS PUBLISHED HERE. The estimate depends on the capital it is priced for, and the only
      // honest capital is the operator's real on-chain balance — which this process does not read (the
      // console does, once, and shows it in the header). Publishing a $1,000-reference figure alongside
      // it would guarantee that two numbers on the same page disagree by an order of magnitude, so the
      // inputs travel instead and the console prices them through the SHARED estimateAtCapital.
      dailyPoolUsd: fin(m.dailyPool) ? m.dailyPool : null,
      bookDepthAtBandUsd: fin(m.bookDepthAtBand) ? m.bookDepthAtBand : null,
      volume24hUsd: fin(m.volume24hUsd) ? m.volume24hUsd : null,
      hoursToResolution: fin(m.hoursToResolution) ? m.hoursToResolution : null,

      // ── badges ──
      // The feed's own scored block, passed through unchanged. The summary below re-prices it at the
      // operator's REAL resting capital through the shared estimator — it is not recomputed here.
      rewardScore: m.rewardScore || null,

      spread,
      stability: {
        known: stability.known,
        label: stability.label,
        score: stability.score,
        reason: stability.reason,
        movedCents: stability.movedCents,
        consumedBandPct: stability.consumedBandPct,
      },
    };
  });

  return {
    markets,
    selection,
    selectionReadable,
    generatedAt: norm && norm.meta ? (norm.meta.generatedAt || null) : null,
    polyGeneratedAt: norm && norm.meta ? (norm.meta.polyGeneratedAt || null) : null,
  };
}

/**
 * Every RESTING order on the account, across every market, each judged against its own market's live
 * band. This is the aggregate the console's header count, its out-of-band alert and its "Regole" table
 * all read — one venue read, one verdict, three surfaces that therefore cannot disagree.
 */
async function buildOrderBoard(deps = {}) {
  const books = deps.books || readJson(LIVE_BOOKS_FILE);
  const norm = deps.norm || readJson(NORMALIZED_FILE);

  const listed = await listManualOrders({ marketId: null });

  const rulesCache = new Map();
  const rulesFor = (marketId) => {
    if (!marketId) return null;
    if (!rulesCache.has(marketId)) rulesCache.set(marketId, resolveMarketRules(marketId, { books, norm }));
    return rulesCache.get(marketId);
  };

  const orders = (listed.orders || []).map((o) => judgeOrder(o, rulesFor(o.marketId)));

  // Per-market grouping — what the operator acts on is a market, not a row.
  const byMarketMap = new Map();
  for (const o of orders) {
    const key = o.marketId || 'sconosciuto';
    if (!byMarketMap.has(key)) {
      byMarketMap.set(key, {
        marketId: o.marketId || null,
        title: o.marketTitle,
        orders: [],
        committedUsd: 0,
        outOfBandCount: 0,
        unknownBandCount: 0,
      });
    }
    const g = byMarketMap.get(key);
    g.orders.push(o);
    if (fin(o.restingNotionalUsd)) g.committedUsd += o.restingNotionalUsd;
    if (o.outOfBand === true) g.outOfBandCount += 1;
    if (o.outOfBand === null) g.unknownBandCount += 1;
    if (!g.title && o.marketTitle) g.title = o.marketTitle;
  }
  const byMarket = [...byMarketMap.values()].map((g) => ({ ...g, committedUsd: r2(g.committedUsd) }));

  const committedUsd = orders.reduce((s, o) => s + (fin(o.restingNotionalUsd) ? o.restingNotionalUsd : 0), 0);
  // A notional we could not compute is NOT counted as zero — it is counted as unknown, and the console
  // says so next to the total rather than quietly understating the capital at work.
  const unpricedOrders = orders.filter((o) => !fin(o.restingNotionalUsd)).length;

  return {
    ok: listed.ok,
    error: listed.error,
    // simulated:true ⇒ the venue was NOT reached. An empty list here is not "no orders".
    simulated: listed.simulated,
    at: listed.at,
    count: orders.length,
    orders,
    byMarket,
    totals: {
      committedUsd: r2(committedUsd),
      unpricedOrders,
      outOfBandCount: orders.filter((o) => o.outOfBand === true).length,
      inBandCount: orders.filter((o) => o.inBand === true).length,
      unknownBandCount: orders.filter((o) => o.outOfBand === null).length,
    },
  };
}

/**
 * The operator's OPEN positions, grouped by market, with net YES−NO exposure.
 *
 * READ-ONLY FROM THE VENUE. Polymarket's own data-api is the source (the same shared helper the trader
 * feed uses, which walks `redeemable=false&sizeThreshold=0` so small and long-tail holdings are not
 * silently dropped). Nothing on-chain is written and no key is touched.
 *
 * A market with a YES leg and a NO leg is ONE exposure, not two: netShares = YES − NO. Both legs stay
 * visible so the operator sees what nets against what.
 *
 * FAIL HONEST: an unreachable data-api yields ok:false with the error — never an empty list presented as
 * "you hold nothing".
 */
async function buildPositions(deps = {}) {
  const wallet = deps.wallet || inventoryWallet();
  if (!wallet) {
    return { ok: false, wallet: null, error: 'nessun indirizzo funder configurato — impossibile leggere le posizioni',
      source: 'data-api.polymarket.com', at: new Date().toISOString(), markets: [], totals: null };
  }

  const getJson = deps.getJson || (async (url) => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 9_000);
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal, headers: { 'User-Agent': 'edgeradar/operator-board' } });
      if (!r.ok) throw new Error(`data-api ${r.status}`);
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    } finally { clearTimeout(to); }
  });

  let res;
  try {
    res = await fetchOpenPositions(getJson, wallet, { maxKeep: 200 });
  } catch (e) {
    return { ok: false, wallet, error: (e && e.message) ? e.message : String(e),
      source: 'data-api.polymarket.com', at: new Date().toISOString(), markets: [], totals: null };
  }
  if (!res.ok) {
    return { ok: false, wallet, error: 'la data-api di Polymarket non ha risposto — le posizioni non sono state lette',
      source: 'data-api.polymarket.com', at: new Date().toISOString(), markets: [], totals: null };
  }

  const norm = deps.norm || readJson(NORMALIZED_FILE);
  const rows = norm && Array.isArray(norm.markets) ? norm.markets : [];
  const titleById = new Map(rows.map((m) => [m.marketId, m.title]));

  const positions = (res.open || []).map(normPosition).filter(Boolean);

  const byMarket = new Map();
  for (const p of positions) {
    const key = p.conditionId || p.asset;
    if (!byMarket.has(key)) {
      byMarket.set(key, {
        marketId: p.conditionId || null,
        title: titleById.get(p.conditionId) || p.title || null,
        slug: p.slug || null,
        legs: [],
        yesShares: 0, noShares: 0,
        currentValueUsd: 0, initialValueUsd: 0, unrealizedPnlUsd: 0,
        valueUnknown: false,
      });
    }
    const g = byMarket.get(key);
    // outcomeIndex is Polymarket's own encoding: 0 = YES, 1 = NO. When it is absent we do NOT guess a
    // side — the leg is kept, flagged, and left out of the net (an invented side would flip the sign).
    const side = p.outcomeIndex === 0 ? 'yes' : p.outcomeIndex === 1 ? 'no' : null;
    const size = fin(p.size) ? p.size : null;
    if (side === 'yes' && size != null) g.yesShares += size;
    else if (side === 'no' && size != null) g.noShares += size;
    if (fin(p.currentValue)) g.currentValueUsd += p.currentValue; else g.valueUnknown = true;
    if (fin(p.initialValue)) g.initialValueUsd += p.initialValue; else g.valueUnknown = true;
    if (fin(p.cashPnl)) g.unrealizedPnlUsd += p.cashPnl; else g.valueUnknown = true;
    g.legs.push({
      asset: p.asset, side, outcome: p.outcome, size, avgPrice: p.avgPrice, curPrice: p.curPrice,
      currentValueUsd: p.currentValue, initialValueUsd: p.initialValue, unrealizedPnlUsd: p.cashPnl,
      sideKnown: side !== null,
    });
  }

  const markets = [...byMarket.values()].map((g) => ({
    ...g,
    netShares: r2(g.yesShares - g.noShares),
    // Which way the market has to move for this to be worth more. Zero net is FLAT, and says so.
    netDirection: Math.abs(g.yesShares - g.noShares) < 1e-9 ? 'flat' : (g.yesShares > g.noShares ? 'yes' : 'no'),
    yesShares: r2(g.yesShares),
    noShares: r2(g.noShares),
    currentValueUsd: g.valueUnknown ? null : r2(g.currentValueUsd),
    initialValueUsd: g.valueUnknown ? null : r2(g.initialValueUsd),
    unrealizedPnlUsd: g.valueUnknown ? null : r2(g.unrealizedPnlUsd),
  })).sort((a, b) => (b.currentValueUsd || 0) - (a.currentValueUsd || 0));

  const anyValueUnknown = markets.some((m) => m.currentValueUsd == null);
  return {
    ok: true,
    wallet,
    error: null,
    source: 'data-api.polymarket.com · redeemable=false, sizeThreshold=0 (posizioni realmente aperte)',
    at: new Date().toISOString(),
    markets,
    totals: {
      marketCount: markets.length,
      legCount: positions.length,
      currentValueUsd: anyValueUnknown ? null : r2(markets.reduce((s, m) => s + (m.currentValueUsd || 0), 0)),
      unrealizedPnlUsd: anyValueUnknown ? null : r2(markets.reduce((s, m) => s + (m.unrealizedPnlUsd || 0), 0)),
      valueUnknown: anyValueUnknown,
    },
    observed: res.openObserved ?? null,
    scanCapped: !!res.openScanCapped,
  };
}

/**
 * The header's committed/earning figures, derived ONCE from the market board and the judged order list
 * so every section quotes the same numbers.
 *
 * The $/day here is priced at the capital the operator has resting IN BAND right now, market by market —
 * never at a reference capital. Out-of-band capital contributes exactly zero: that is the whole point of
 * the out-of-band alert, and a headline that paid it anyway would contradict the alert beside it.
 *
 * The per-market "what would this market pay me" estimate is NOT computed here — it depends on the real
 * proxy balance, which only the console reads, so the console prices it through the shared
 * estimateAtCapital (same function, one implementation).
 */
function buildSummary(markets, orderBoard) {
  const byId = new Map((markets || []).map((m) => [m.marketId, m]));

  // In-band resting notional, per market. Only orders we could actually JUDGE count as in-band; an
  // unjudgeable order is tracked separately and never silently credited with earnings.
  const inBandByMarket = new Map();
  let unjudgeableUsd = 0;
  for (const o of (orderBoard && orderBoard.orders) || []) {
    const usd = fin(o.restingNotionalUsd) ? o.restingNotionalUsd : 0;
    if (o.inBand === true) inBandByMarket.set(o.marketId, (inBandByMarket.get(o.marketId) || 0) + usd);
    else if (o.inBand === null) unjudgeableUsd += usd;
  }

  let estGrossUsdPerDay = 0;
  let anyUnknown = false;
  const perMarket = [];
  for (const [marketId, capital] of inBandByMarket) {
    const m = byId.get(marketId);
    const est = estimateAtCapital(m ? m.rewardScore : null, capital, m ? m.bookDepthAtBandUsd : null);
    if (est.unknown) anyUnknown = true; else estGrossUsdPerDay += est.estUsdPerDay || 0;
    perMarket.push({ marketId, title: m ? m.title : null, inBandCapitalUsd: r2(capital), estUsdPerDay: est.estUsdPerDay });
  }

  const t = (orderBoard && orderBoard.totals) || { committedUsd: 0, outOfBandCount: 0, inBandCount: 0, unknownBandCount: 0, unpricedOrders: 0 };

  return {
    committedUsd: t.committedUsd,
    committedInBandUsd: r2([...inBandByMarket.values()].reduce((s, v) => s + v, 0)),
    unjudgeableCapitalUsd: r2(unjudgeableUsd),
    // null ⇒ at least one market with resting in-band capital could not be scored, so a total would be
    // an understatement presented as a fact. The console renders N/D with the reason.
    estGrossUsdPerDay: anyUnknown ? null : r2(estGrossUsdPerDay),
    estPerMarket: perMarket,
    outOfBandCount: t.outOfBandCount,
    inBandCount: t.inBandCount,
    unknownBandCount: t.unknownBandCount,
    unpricedOrders: t.unpricedOrders,
    // The markets the operator is actually resting capital in, with their out-of-band count — the
    // Riepilogo alert names these, never a generic "some orders are out of band".
    marketsWithOrders: ((orderBoard && orderBoard.byMarket) || []).map((g) => ({
      marketId: g.marketId,
      title: g.title || (byId.get(g.marketId) ? byId.get(g.marketId).title : null),
      committedUsd: g.committedUsd,
      outOfBandCount: g.outOfBandCount,
      unknownBandCount: g.unknownBandCount,
      orderCount: g.orders.length,
    })),
  };
}

module.exports = {
  buildMarketBoard,
  buildOrderBoard,
  buildPositions,
  buildSummary,
  estimateAtCapital,
  judgeOrder,
  classifySpread,
  VENUE,
};

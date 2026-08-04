'use strict';
// lib/rewards/allocator.js — the ONE capital allocator, imported by BOTH the backtest
// (scripts/rewards-replay/allocate-run.js) and the UI (/dashboard/liquidity-rewards/allocate).
//
// It re-exports the measured knapsack allocator from scripts/rewards-replay/lib/allocate — never a second
// implementation — and adds a UI-facing planAllocation() plus planFromCollection() (the orchestration the
// /api/rewards/allocate route runs out-of-process). It reads no key, signs nothing, and constructs no order.
//
// PER-MARKET OFFSET: the base allocation runs the knapsack ONCE at a fixed reference offset (offsetCents,
// default 1¢) — that is the backtest-equal baseline, unchanged. Each returned row carries everything the
// client needs to recompute its own offset LOCALLY (no refetch): mid, tick, maxSpread, the S=1-ceiling
// gross, the per-tick fill curve, the structural fill score. The offset override is a display recompute; it
// never re-runs the knapsack, so the allocation (markets/capital/gross) equals the backtest by construction.

const path = require('path');
const allocate = require('../../scripts/rewards-replay/lib/allocate');
const { snapToTick, reconstructTapeFillsForMarket } = require('../../scripts/rewards-replay/lib/tape');
const { markoutForFill } = require('../../scripts/rewards-replay/lib/markout');
const { median } = require('../../scripts/rewards-replay/lib/net');
const { frontierByCount } = require('../../scripts/rewards-replay/lib/allocate-sweep');
// The SECOND, corrected $/day figure. It never replaces `grossPerDay` — both travel to the client, and the
// client shows them side by side. Every correction it applies is named and reported with its own factor.
const { realisticEstimate, totalRealistic } = require('./realistic-estimate');
const { loadPoolHistory, poolTrendFor } = require('./pool-trend');
// Il test dell'orizzonte di risoluzione. Puro, dichiarato, e con la regola che «non misurabile» non e'
// mai un rifiuto — la stessa che reward-stability applica a un prezzo fermo per assenza di scambi.
const { horizonVerdict } = require('./horizon');

const { allocateBudget, knapsack } = allocate;

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function clampPrice(p) { return Math.max(0.01, Math.min(0.99, p)); }

function marketMeta(rows, wsOnly = false) {
  const src = wsOnly ? rows.filter((r) => r.src === 'ws') : rows;
  const depthShares = median(src.map((r) => (fin(r.bidDepthInBand) && fin(r.askDepthInBand)) ? Math.min(r.bidDepthInBand, r.askDepthInBand) : null));
  const mid = median(src.map((r) => r.adjMid));
  const tick = rows[0] && fin(rows[0].tick) ? rows[0].tick : null;
  const spanHours = src.length >= 2 ? (src[src.length - 1].tsMs - src[0].tsMs) / 3_600_000 : 0;
  // newest observed sample for THIS market — the client turns it into a live data age (now − newestTsMs).
  const tsList = src.map((r) => r.tsMs).filter(fin);
  const newestTsMs = tsList.length ? Math.max.apply(null, tsList) : null;
  return { mid, tick, depthShares, spanHours, newestTsMs };
}

// Snapped bid/ask at `offsetTicks` ticks from mid, on the market's OWN tick. Fails closed on unknown tick.
function snapBidAsk(mid, tick, offsetTicks) {
  if (!(fin(mid) && fin(tick) && tick > 0)) return { bid: null, ask: null };
  const d = offsetTicks * tick;
  return { bid: snapToTick(mid - d, tick), ask: snapToTick(mid + d, tick) };
}

/**
 * Per-tick fill curve for one market at its allocated size: for each offset in ticks 0..maxTick, the number
 * of observed fills and the amortised adverse cost/day. Lets the client show fill exposure at ANY chosen
 * offset without a server round-trip. Cost = Σ max(0,−markout) over the offset's fills, over the span.
 */
function fillsByTickCurve(rows, trades, sizeUsd, tick, mid, maxSpreadCents, spanHours, maxInventoryUsd) {
  const out = [];
  const radiusTicks = (fin(maxSpreadCents) && fin(tick) && tick > 0) ? Math.ceil((maxSpreadCents / 2) / (tick * 100)) : 5;
  const maxTick = fin(tick) && tick > 0 ? Math.min(40, Math.max(3, radiusTicks + 2)) : 3; // cover the band + a couple beyond
  const spanDays = fin(spanHours) && spanHours > 0 ? spanHours / 24 : null;
  for (let t = 0; t <= maxTick; t++) {
    const offsetCents = fin(tick) ? t * tick * 100 : null;
    const fills = fin(tick) ? reconstructTapeFillsForMarket(rows, trades, { offsetCents, sizeUsd, maxInventoryUsd }).fills : [];
    let adverse = 0, measured = 0;
    for (const f of fills) { const h5 = markoutForFill(f, rows).horizons['5m']; if (h5 && fin(h5.usd)) { adverse += Math.max(0, -h5.usd); measured++; } }
    const { bid, ask } = snapBidAsk(mid, tick, t); // snapped on the market's OWN tick (reuses snapToTick)
    out.push({ tick: t, offsetCents, fills: fills.length, costPerDay: (spanDays && measured) ? adverse / spanDays : (fills.length ? null : 0), bid, ask });
  }
  return out;
}

/**
 * The reward-MAXIMISING default offset per market, COMPUTED (not a fixed +1 tick). The replay's gross is the
 * offset-independent S=1 ceiling, so maximising GROSS returns offset 0 (at mid) for every market — the trap
 * (offset 0 took 14,642 fills in the window). We maximise MEASURED NET instead: net(t) = grossInBand − cost(t)
 * over the IN-BAND ticks, where cost(t) is the amortised measured markout at that offset (0 fills ⇒ cost 0).
 * Because gross is flat within band, net rises only as measured cost falls; we take the SMALLEST tick that
 * captures the maximum net within ε — the tightest offset that already avoids the adverse fills. Where NO fill
 * was ever observed (net not measurable), we fall back to the lowest bounded-exposure offset (1 tick off mid)
 * and MARK the row exposure-derived. Returns {ticks, reason, netDerived, grossMaxTicks} — grossMaxTicks is the
 * gross-maximising offset, kept so the caller can PROVE the default is net-derived (grossMaxTicks ≠ ticks).
 */
function computedDefaultOffset(fillsByTick, grossInBand, maxSpreadCents) {
  const radius = fin(maxSpreadCents) ? maxSpreadCents / 2 : null;
  const inBand = (fillsByTick || []).filter((x) => fin(x.offsetCents) && (radius == null || x.offsetCents <= radius + 1e-9));
  if (!inBand.length || !(fin(grossInBand) && grossInBand > 0)) return { ticks: 1, reason: 'fallback: dati insufficienti', netDerived: false, grossMaxTicks: 0 };
  const grossMaxTicks = inBand.reduce((a, b) => (b.tick < a.tick ? b : a)).tick; // gross flat within band ⇒ smallest offset
  const firstOffMid = inBand.find((x) => x.tick >= 1) || inBand[0];
  if (!inBand.some((x) => x.fills > 0)) return { ticks: firstOffMid.tick, reason: 'exposure-derived: 0 fill osservati, nessun costo misurato', netDerived: false, grossMaxTicks };
  // Never default to mid (tick 0): gross is flat within band, so stepping ONE tick off mid costs zero reward
  // and avoids ~97% of fills — there is never a net reason to quote at mid. Search off-mid ticks only.
  const candidates = inBand.filter((x) => x.tick >= 1 && x.costPerDay != null);
  if (!candidates.length) return { ticks: firstOffMid.tick, reason: 'exposure-derived: netto non misurabile in banda', netDerived: false, grossMaxTicks };
  const nets = candidates.map((x) => ({ tick: x.tick, net: grossInBand - x.costPerDay }));
  const maxNet = Math.max.apply(null, nets.map((n) => n.net));
  const eps = Math.max(0.02, 0.02 * grossInBand); // within 2% of the peak net = on the net plateau
  const chosen = nets.filter((n) => n.net >= maxNet - eps).reduce((a, b) => (b.tick < a.tick ? b : a));
  return { ticks: chosen.tick, reason: 'net-derived: gross − markout misurato', netDerived: true, grossMaxTicks };
}

/**
 * Plan an allocation of `budgetUsd`. The knapsack runs at `offsetCents` (default 1¢) — the backtest baseline.
 * Extra per-market inputs are additive and never change the allocation:
 *   maxSpreadByMarket   conditionId → reward band width (cents), for the out-of-band ZERO rule + fill curve
 *   fillScoreByMarket   conditionId → structural fill-likelihood score (0..1) | null
 */
function planAllocation(cfg) {
  const {
    byMarket, marketTokens, tapeByToken, potByCond, budgetUsd,
    offsetCents = 1, maxInventoryUsd = 5000, policy = 'hold', maxCount = 25,
    maxSpreadByMarket = null, fillScoreByMarket = null, endDateByMarket = null, minSizeByMarket = null,
    // ── THE HORIZON FILTER — OFF BY DEFAULT, AND THAT IS DELIBERATE ────────────────────────────────
    // With horizonFilter false this function is byte-for-byte the shipped allocator: same universe, same
    // knapsack, same allocation, so the backtest equality the whole module rests on is untouched and the
    // existing tests keep passing. The auto-optimise path turns it on explicitly.
    horizonFilter = false,
    // ── IL TETTO DI CONCENTRAZIONE — ASSENTE PER DIFETTO, E ANCHE QUESTO È DELIBERATO ─────────────────
    // Senza questa opzione il valore resta `budgetUsd`, cioè esattamente la costante che era scritta qui
    // prima: un solo mercato può prendersi tutto il budget e l'allocazione è byte-per-byte quella di
    // sempre. Chi lo passa (il riallocatore periodico) sceglie di stringere; il pannello no, e non ha
    // nessun controllo per farlo.
    //
    // Il meccanismo è quello del venue, non un filtro a valle: `allocateBudget` costruisce la griglia
    // delle size fino a `capPerMarket`, quindi il knapsack semplicemente non VEDE i livelli oltre il
    // tetto. Non c'è nessun punto in cui un'allocazione viene calcolata e poi tagliata.
    maxPerMarketUsd = null,
    nowMs = Date.now(),
  } = cfg;
  const unitUsd = cfg.unitUsd || Math.max(2, Math.round(budgetUsd / 50));
  const capPerMarketUsd = fin(maxPerMarketUsd) && maxPerMarketUsd > 0 ? Math.min(maxPerMarketUsd, budgetUsd) : budgetUsd;
  const allocFull = allocateBudget(byMarket, marketTokens, tapeByToken, potByCond, {
    offsetCents, maxInventoryUsd, budgetUsd, unitUsd, maxPerMarketUsd: capPerMarketUsd, policy, minSizeByMarket,
  });

  // ── HORIZON, MEASURED OFF THE CURVES THAT ARE ALREADY BUILT ───────────────────────────────────────
  // Building the per-market curves is what costs the ~25s; the knapsack itself is a millisecond DP over
  // ~25 markets. So the filter re-runs ONLY the DP over the surviving curves — never a second pass over
  // the tape. Each verdict is computed at the market's own best funded level, which is the size the
  // allocation would actually take, not a nominal one.
  const budgetUnits = Math.floor(budgetUsd / unitUsd);
  const horizonByMarket = new Map();
  for (const c of allocFull.curves) {
    const funded = c.levels.filter((l) => (l.units | 0) > 0);
    const best = funded.reduce((a, b) => (a == null || (fin(b.net5m) ? b.net5m : -Infinity) > (fin(a.net5m) ? a.net5m : -Infinity) ? b : a), null);
    horizonByMarket.set(c.marketId, horizonVerdict({
      endDate: endDateByMarket ? (endDateByMarket.get(c.marketId) ?? null) : null,
      nowMs,
      grossPerDay: best && fin(best.grossPerDay) ? best.grossPerDay : null,
      costPerDay: best && fin(best.costPerDay5m) ? best.costPerDay5m : null,
    }));
  }
  // Only a MEASURED rejection removes a market. `unknown` keeps its place — an unreadable end date is not
  // a short one, and this codebase never lets the absence of a fact wear the clothes of the fact.
  //
  // AND ONLY WHERE THE HORIZON IS THE CONSTRAINT THAT ACTUALLY BINDS. A market whose net is not positive
  // has payback Infinity, so it fails the horizon test at ANY end date — but the horizon is not what is
  // wrong with it, the economics are, and the knapsack already refuses it on its own. Labelling it
  // «scade troppo presto» would blame the calendar for a market that would be rejected in a century.
  const horizonRejects = new Set();
  if (horizonFilter) {
    for (const [mid, v] of horizonByMarket.entries()) {
      const bindsOnHorizon = v.state === 'resolved' || (v.state === 'short' && fin(v.payback));
      if (bindsOnHorizon) horizonRejects.add(mid);
    }
  }
  const keptCurves = horizonRejects.size
    ? allocFull.curves.filter((c) => !horizonRejects.has(c.marketId))
    : allocFull.curves;
  const alloc = horizonRejects.size
    ? (() => {
      const res = knapsack(keptCurves, budgetUnits);
      let grossPerDay = 0, costPerDay5m = 0;
      for (const a of res.allocation) { grossPerDay += fin(a.grossPerDay) ? a.grossPerDay : 0; costPerDay5m += fin(a.costPerDay5m) ? a.costPerDay5m : 0; }
      const belowMinSize = allocFull.belowMinSize.filter((b) => !horizonRejects.has(b.marketId));
      return { budgetUsd, unitUsd, curves: keptCurves, grossPerDay, costPerDay5m, belowMinSize, ...res };
    })()
    : allocFull;
  const F = frontierByCount(alloc.curves, Math.floor(budgetUsd / unitUsd), maxCount);

  // ── THE SECOND FIGURE'S SHARED INPUT ────────────────────────────────────────────────────────────────
  // The 48h pot archive is read ONCE per plan, not once per row: it is a handful of multi-megabyte day
  // files, and re-parsing them 25 times would dominate the whole allocation. Unreadable ⇒ every row's
  // pool-trend correction reports measurable:false and applies exactly 1.0, saying so.
  const poolHistory = cfg.poolHistory !== undefined ? cfg.poolHistory : (() => {
    try { return loadPoolHistory(Date.now()); } catch { return null; }
  })();
  // Proactive GTD refreshes per day for a leg the manual watcher holds (Part B). Additive: it only feeds
  // the coverage-gap correction, and 0 (or null) simply means "no scheduled refresh modelled".
  const refreshesPerDay = fin(cfg.refreshesPerDay) ? cfg.refreshesPerDay : 0;

  const rows = alloc.allocation.map((a) => {
    const rowsJ = byMarket.get(a.marketId) || [];
    const meta = marketMeta(rowsJ);
    const price = meta.mid != null ? clampPrice(meta.mid) : null;
    const sizePerSideShares = (price != null && price > 0) ? a.sizeUsd / price : null;
    const maxSpreadCents = maxSpreadByMarket ? (maxSpreadByMarket.get(a.marketId) ?? null) : null;
    // default offset (ticks) = the global offsetCents expressed in THIS market's ticks (backtest is 1¢ uniform)
    const defaultOffsetTicks = (fin(meta.tick) && meta.tick > 0) ? Math.max(1, Math.round(offsetCents / (meta.tick * 100))) : 1;
    const { bid, ask } = snapBidAsk(meta.mid, meta.tick, defaultOffsetTicks);
    const netPerDay = (a.fills > 0 && fin(a.netPerDay5m)) ? a.netPerDay5m : null;
    const trades = (marketTokens.get(a.marketId) && tapeByToken.get(marketTokens.get(a.marketId))) || [];
    const grossInBandPerDay = fin(a.grossPerDay) ? a.grossPerDay : null; // S=1 ceiling gross (offset-independent within band)
    const fillsByTick = fillsByTickCurve(rowsJ, trades, a.sizeUsd, meta.tick, meta.mid, maxSpreadCents, meta.spanHours, maxInventoryUsd);
    const cdef = computedDefaultOffset(fillsByTick, grossInBandPerDay, maxSpreadCents); // net-max default, not fixed +1

    // ── THE REALISTIC FIGURE, PER TICK ────────────────────────────────────────────────────────────────
    // The client changes the offset locally and must not have to refetch, so the corrected estimate is
    // precomputed for every offset the client can select — exactly the pattern fillsByTick already uses.
    // The correction most sensitive to the offset is the placement score, so a single server-side number
    // at the default offset would be wrong the moment the operator moved a row.
    //
    // The BREAKDOWN (the per-correction notes the tooltip prints) is carried only for IN-BAND ticks. An
    // out-of-band offset earns zero by the band-honest rule, so its breakdown would be five paragraphs
    // explaining corrections to $0.00 — the row already says "fuori banda · $0,00".
    const bandRadiusC = fin(maxSpreadCents) ? maxSpreadCents / 2 : null;
    const trend = poolTrendFor(poolHistory, a.marketId, potByCond.get(a.marketId));
    const realisticByTick = fillsByTick.map((ft) => {
      const inBand = bandRadiusC == null || (fin(ft.offsetCents) && ft.offsetCents <= bandRadiusC + 1e-9);
      const grossHere = grossInBandPerDay == null ? null : (inBand ? grossInBandPerDay : 0);
      const est = realisticEstimate({
        grossPerDay: grossHere,
        pot: potByCond.get(a.marketId) ?? null,
        competitorQ: meta.depthShares,
        mid: meta.mid,
        capitalUsd: a.capital,
        offsetCents: ft.offsetCents,
        maxSpreadCents,
        measuredCostPerDay: ft.costPerDay,
        observedFills: ft.fills,
        poolTrend: trend,
        midRows: rowsJ,
        refreshesPerDay,
      });
      return inBand
        ? { tick: ft.tick, realisticPerDay: est.realisticPerDay, totalFactor: est.totalFactor, unknown: est.unknown, reason: est.reason, corrections: est.corrections, flags: est.flags, summary: est.summary }
        : { tick: ft.tick, realisticPerDay: est.realisticPerDay, totalFactor: est.totalFactor, unknown: est.unknown, reason: est.reason, corrections: null, flags: est.flags, summary: est.summary };
    });

    // ── THE OFFSET THAT ACTUALLY MAXIMISES THE CORRECTED FIGURE ──────────────────────────────────────
    // computedDefaultOffsetTicks is chosen against the S=1 CEILING gross, which is flat inside the band —
    // so the optimiser can push the quote outward to dodge fills at zero modelled reward cost. Under the
    // real quadratic that is not free at all: at the band edge the score collapses to ~0. This exposes the
    // offset that is best once the score decay is priced in, so the operator can SEE the disagreement
    // instead of inheriting an offset chosen by a model that could not feel it.
    // Searched over IN-BAND, OFF-MID offsets only, and for a POSITIVE figure:
    //   • out-of-band ticks score zero by the band-honest rule, so "best" must not be allowed to land on a
    //     $0.00 offset just because every in-band one was withheld;
    //   • tick 0 (resting exactly AT the mid) is excluded for the same reason computedDefaultOffset excludes
    //     it — the replay measured 14,642 fills at mid against 395 one tick off. Maximising the corrected
    //     reward while ignoring that would hand the operator the single worst place to stand.
    const inBandTicks = new Set(fillsByTick.filter((ft) => bandRadiusC == null || (fin(ft.offsetCents) && ft.offsetCents <= bandRadiusC + 1e-9)).map((ft) => ft.tick));
    const realisticBest = realisticByTick
      .filter((x) => x.tick >= 1 && inBandTicks.has(x.tick) && fin(x.realisticPerDay) && x.realisticPerDay > 0)
      .reduce((best, x) => (best == null || x.realisticPerDay > best.realisticPerDay ? x : best), null);

    return {
      marketId: a.marketId, capital: a.capital, sizePerSideUsd: a.sizeUsd, sizePerSideShares,
      snappedBid: bid, snappedAsk: ask, tick: meta.tick, offsetCents, depthShares: meta.depthShares, mid: meta.mid,
      spanHours: meta.spanHours, newestTsMs: meta.newestTsMs, grossPerDay: fin(a.grossPerDay) ? a.grossPerDay : null,
      grossInBandPerDay,
      netPerDay, fills: a.fills, share: a.share, maxSpreadCents, defaultOffsetTicks,
      computedDefaultOffsetTicks: cdef.ticks, defaultReason: cdef.reason, defaultNetDerived: cdef.netDerived, grossMaxDefaultTicks: cdef.grossMaxTicks,
      endDate: endDateByMarket ? (endDateByMarket.get(a.marketId) ?? null) : null,
      // ── LA SIZE MINIMA DEL VENUE, SULLA RIGA ──────────────────────────────────────────────────────
      // Sotto min_incentive_size il venue non assegna punteggio: il lordo di questa riga e' 0, non una
      // frazione del montepremi. Il pannello lo mostra come $0/g con il capitale che servirebbe, perche'
      // un rifiuto su cui l'operatore non puo' agire e' mezzo rifiuto.
      minSizeShares: a.minSizeShares ?? (minSizeByMarket ? (minSizeByMarket.get(a.marketId) ?? null) : null),
      belowVenueMinSize: a.belowVenueMinSize === true,
      capitalToQualifyUsd: fin(a.capitalToQualifyUsd) ? a.capitalToQualifyUsd : null,
      fillScore: fillScoreByMarket ? (fillScoreByMarket.get(a.marketId) ?? null) : null,
      fillsByTick,
      realisticByTick,
      realisticBestTick: realisticBest ? realisticBest.tick : null,
      realisticBestPerDay: realisticBest ? realisticBest.realisticPerDay : null,
      poolTrend: trend,
    };
  });

  const totalCapital = rows.reduce((s, r) => s + r.capital, 0);
  const totalGrossPerDay = rows.reduce((s, r) => s + (fin(r.grossPerDay) ? r.grossPerDay : 0), 0);
  const totalNetPerDay = rows.length && rows.every((r) => r.netPerDay != null) ? rows.reduce((s, r) => s + r.netPerDay, 0) : null;
  // The realistic TOTAL at each row's own computed default offset. The client recomputes this locally when
  // an offset is overridden — this is the server's answer for the untouched plan.
  const totalRealisticPerDay = totalRealistic(rows.map((r) => {
    const hit = r.realisticByTick.find((x) => x.tick === r.computedDefaultOffsetTicks);
    return hit ? { grossPerDay: r.grossInBandPerDay, realisticPerDay: hit.realisticPerDay, unknown: hit.realisticPerDay == null } : { unknown: true };
  }));

  // ── IL REGISTRO DEI CANDIDATI ─────────────────────────────────────────────────────────────────────
  // Una riga per OGNI mercato che l'ottimizzatore ha esaminato, con il verdetto e il perche'. Prima
  // l'unico rifiuto raccontato era `belowMinSize`: tutti gli altri sparivano, e "perche' quel mercato non
  // c'e'" restava senza risposta. La domanda e' legittima e la risposta e' un dato che avevamo gia'.
  //
  // Puramente descrittivo: non decide niente, riporta decisioni gia' prese sopra.
  const chosenById = new Map(rows.map((r) => [r.marketId, r]));
  const belowIds = new Set((allocFull.belowMinSize || []).map((b) => b.marketId));
  const candidates = allocFull.curves.map((c) => {
    const funded = c.levels.filter((l) => (l.units | 0) > 0);
    const best = funded.reduce((a, b) => (a == null || (fin(b.net5m) ? b.net5m : -Infinity) > (fin(a.net5m) ? a.net5m : -Infinity) ? b : a), null);
    const bestNetPerDay = best && fin(best.net5m) ? best.net5m : null;
    const hz = horizonByMarket.get(c.marketId) || null;
    const chosen = chosenById.get(c.marketId) || null;
    const base = {
      marketId: c.marketId,
      bestNetPerDay,
      bestGrossPerDay: best && fin(best.grossPerDay) ? best.grossPerDay : null,
      competitorShares: (() => { const m = marketMeta(byMarket.get(c.marketId) || []); return m.depthShares; })(),
      pot: potByCond.get(c.marketId) ?? null,
      maxSpreadCents: maxSpreadByMarket ? (maxSpreadByMarket.get(c.marketId) ?? null) : null,
      horizon: hz ? { state: hz.state, days: hz.days, payback: hz.payback === Infinity ? null : hz.payback, paybackNever: hz.payback === Infinity } : null,
    };
    if (chosen) {
      // IL PERCHE' DELLA SCELTA, costruito dai numeri della riga stessa — non un'etichetta decorativa.
      const why = [];
      if (fin(base.pot) && base.pot > 0) why.push(`montepremi $${Math.round(base.pot)}/g`);
      if (fin(chosen.share)) why.push(`quota modellata ${(chosen.share * 100).toFixed(1)}%`);
      if (fin(base.competitorShares)) why.push(`concorrenza in banda ${Math.round(base.competitorShares)} share`);
      if (fin(base.maxSpreadCents)) why.push(`banda ${base.maxSpreadCents.toFixed(2)}¢`);
      if (hz && hz.state === 'ok' && fin(hz.days)) why.push(`scade fra ${Math.round(hz.days)} g`);
      return { ...base, status: 'scelto', capital: chosen.capital, reason: why.join(' · ') || 'scelto dal knapsack' };
    }
    if (horizonRejects.has(c.marketId)) {
      return { ...base, status: 'scartato', capital: 0, reasonCode: 'orizzonte', reason: hz ? hz.reason : 'orizzonte insufficiente' };
    }
    if (belowIds.has(c.marketId)) {
      const b = (allocFull.belowMinSize || []).find((x) => x.marketId === c.marketId);
      return {
        ...base, status: 'scartato', capital: 0, reasonCode: 'min-size',
        reason: b && fin(b.capitalToQualifyUsd)
          ? `sotto la size minima del venue — servono $${b.capitalToQualifyUsd.toFixed(2)}`
          : 'sotto la size minima del venue',
      };
    }
    if (c.excluded || !funded.length) {
      return { ...base, status: 'scartato', capital: 0, reasonCode: 'non-scorabile', reason: 'nessun montepremi o nessuna profondita scorabile misurata' };
    }
    if (bestNetPerDay == null) {
      return { ...base, status: 'scartato', capital: 0, reasonCode: 'netto-ignoto', reason: 'netto non misurabile a nessuna size — mai stimato a zero' };
    }
    if (bestNetPerDay <= 0) {
      return { ...base, status: 'scartato', capital: 0, reasonCode: 'netto-negativo', reason: `reward troppo basso rispetto al costo: netto $${bestNetPerDay.toFixed(2)}/g al meglio` };
    }
    return {
      ...base, status: 'scartato', capital: 0, reasonCode: 'battuto',
      reason: `battuto da mercati migliori — al meglio renderebbe $${bestNetPerDay.toFixed(2)}/g`,
    };
  });

  return {
    budgetUsd, unitUsd, offsetCents, marketsUsed: rows.length,
    // Il tetto EFFETTIVAMENTE applicato, non quello richiesto: chi legge il piano deve poter distinguere
    // «nessun tetto» da «tetto pari all'intero budget», che danno lo stesso numero ma non la stessa storia.
    maxPerMarketUsd: capPerMarketUsd, concentrationCapped: capPerMarketUsd < budgetUsd - 1e-9,
    totalCapital, unallocated: budgetUsd - totalCapital,
    totalGrossPerDay, totalNetPerDay, totalRealisticPerDay, frontier: F.frontier, rows,
    // Mercati che il minimo del venue ha escluso a QUESTO budget: ogni livello finanziabile scorerebbe zero
    // perche' la size comprabile sta sotto min_incentive_size. Elencati, non silenziosamente assenti.
    belowMinSize: alloc.belowMinSize || [],
    // Il registro completo: scelti e scartati, ognuno col suo motivo.
    candidates,
    horizonFilter,
    horizonRejected: Array.from(horizonRejects),
  };
}

// ── Orchestration the /api/rewards/allocate route runs out-of-process (plain node, no webpack). ──
const ROOT = path.join(__dirname, '..', '..');
const REWARDS_FILE = path.join(ROOT, 'data', 'liquidity-rewards.json');
const WINDOW_MS = 48 * 3_600_000;
const LIVE_UNIVERSE = 658;
const APY_CAP = 200;
// Measured offset frontier from the risk-first run ($1000/side, all markets) — fills and reward lost per tick.
const OFFSET_FRONTIER = [
  { offsetCents: 0, fills: 14642, grossInBand: 515.86, rewardLost: 0 },
  { offsetCents: 1, fills: 395, grossInBand: 515.86, rewardLost: 0 },
  { offsetCents: 2, fills: 51, grossInBand: 442.85, rewardLost: 73.01 },
  { offsetCents: 3, fills: 24, grossInBand: 11.65, rewardLost: 504.21 },
];

function loadBoard() {
  // ── QUANTO È VECCHIA LA FOTOGRAFIA DEL BOARD ────────────────────────────────────────────────────
  // Il file non porta un timestamp dentro di sé, quindi la data è quella di scrittura. Serve perché
  // ogni verdetto di questo modulo — montepremi, banda, scadenza, esistenza stessa del mercato — vale
  // quanto vale questa fotografia: se agent24 muore, il piano continuerebbe a nascere su un board di
  // ieri senza che nessuna riga lo dica. Qui non si decide niente: si RIPORTA, e chi mette in opera un
  // piano (il riallocatore periodico) decide se un board di quell'età è ancora buono.
  let boardAtMs = null;
  try { boardAtMs = require('fs').statSync(REWARDS_FILE).mtimeMs; } catch { /* ignota, mai inventata */ }
  const board = JSON.parse(require('fs').readFileSync(REWARDS_FILE, 'utf8'));
  const nameMap = new Map(), potByCond = new Map(), maxSpreadByMarket = new Map(), endDateByMarket = new Map();
  // min_incentive_size, letta dalla STESSA riga del board da cui arrivano pot e banda — non una seconda
  // fonte e non una seconda lettura: sotto questa size il venue non assegna punteggio, quindi il rendimento
  // di quella riga e' zero (lib/rewardScore.quadraticUserShare applica gia' la stessa regola).
  const minSizeByMarket = new Map();
  for (const m of board.markets || []) {
    if (!m.conditionId) continue;
    const pot = Number(m.rewardsDailyRate);
    if (fin(pot) && pot > 0) potByCond.set(m.conditionId, pot);
    nameMap.set(m.conditionId, { question: m.question ?? null, category: m.category ?? null });
    if (m.rewardsMaxSpread != null) maxSpreadByMarket.set(m.conditionId, Number(m.rewardsMaxSpread));
    const ms = Number(m.rewardsMinSize ?? m.minSize);
    if (fin(ms) && ms > 0) minSizeByMarket.set(m.conditionId, ms);
    if (typeof m.endDate === 'string' && m.endDate.trim()) endDateByMarket.set(m.conditionId, m.endDate); // resolution horizon; missing → "—", never inferred
  }
  return { nameMap, potByCond, maxSpreadByMarket, endDateByMarket, minSizeByMarket, boardAtMs };
}

function identify(nameMap, marketId) {
  const m = nameMap.get(marketId);
  const question = m && typeof m.question === 'string' && m.question.trim() ? m.question : null;
  return { name: question, category: m && typeof m.category === 'string' && m.category.trim() ? m.category : null, nameAvailable: question != null, shortId: marketId.slice(0, 10) + '…' + marketId.slice(-4) };
}

// Full API body: load the window, score the universe, run planAllocation, resolve identity + coverage.
function planFromCollection(opts = {}) {
  const fs = require('fs');
  const { loadJournal } = require('../../scripts/rewards-replay/lib/journal');
  const { loadTape } = require('../../scripts/rewards-replay/lib/tape');
  const { coverageHeader } = require('../mid-history-coverage');
  const { marketFeatures } = require('../../scripts/rewards-riskfirst/lib/features');
  const { computeFillScores, auc } = require('../../scripts/rewards-riskfirst/lib/fillscore');

  const capital = fin(opts.capital) && opts.capital > 0 ? opts.capital : 0;
  const { nameMap, potByCond: boardPots, maxSpreadByMarket, endDateByMarket, minSizeByMarket, boardAtMs } = loadBoard();
  let potByCond = boardPots;
  if (opts.pots) { const snap = JSON.parse(fs.readFileSync(opts.pots, 'utf8')); potByCond = new Map(Object.entries(snap.byCond).map(([c, o]) => [c, o.pot])); }

  const nowMs = Date.now();
  const rawTo = opts.to ? Date.parse(opts.to) : nowMs;
  const rawFrom = opts.from ? Date.parse(opts.from) : rawTo - WINDOW_MS;
  // Clamp to the tape's actual span (as the backtest allocate-run.js does) so the window — and therefore the
  // allocation — matches the backtest exactly when no override is set.
  const tapeFull = loadTape({ fromMs: rawFrom, toMs: rawTo });
  const fromMs = Math.max(rawFrom, tapeFull.window.fromMs ?? rawFrom);
  const toMs = Math.min(rawTo, tapeFull.window.toMs ?? rawTo);
  const J = loadJournal({ fromMs, toMs });
  const tape = loadTape({ fromMs, toMs });
  for (const rows of J.byMarket.values()) for (const r of rows) r.levels = undefined;
  const coveredMarketCount = J.byMarket.size;
  const marketTokens = new Map();
  for (const [mid, rows] of J.byMarket.entries()) if (rows[0] && rows[0].tokenIdYes) marketTokens.set(mid, rows[0].tokenIdYes);
  // ── L'UNIVERSO, EVENTUALMENTE RISTRETTO ─────────────────────────────────────────────────────────
  // `onlyMarketIds` esiste per UNA domanda sola: «quanto varrebbero oggi, al meglio, solo i mercati che
  // ho già in mano?». È il termine di paragone del trigger di valore del riallocatore periodico, che
  // confronta il piano libero con il piano ristretto ai mercati in produzione — stessa stima, stesso
  // istante, stesso capitale, stesso tetto: cambia solo l'insieme fra cui scegliere.
  //
  // ASSENTE PER DIFETTO. Senza l'opzione l'universo resta quello di sempre (tutti i mercati con
  // montepremi di cui esiste storico) e il pannello non ha nessun controllo per restringerlo: la
  // selezione manuale non è mai entrata in questo calcolo e continua a non entrarci.
  const soloQuesti = Array.isArray(opts.onlyMarketIds) && opts.onlyMarketIds.length
    ? new Set(opts.onlyMarketIds.map((x) => String(x).trim().toLowerCase()).filter(Boolean))
    : null;
  // ── E I MERCATI DA NON CONSIDERARE PIÙ ──────────────────────────────────────────────────────────
  // Il simmetrico di `onlyMarketIds`, e serve a una cosa sola: il riallocatore periodico verifica al
  // VENUE i mercati che il piano ha scelto e, se uno è risolto / non negoziabile / col montepremi
  // crollato, deve poter rifare il piano SENZA di lui — cioè riallocare quel capitale altrove invece di
  // lasciarlo fermo o di piazzare su un mercato morto. Senza questa opzione l'unico modo sarebbe
  // elencare tutti i sopravvissuti in `onlyMarketIds`, che però congelerebbe l'universo ai già valutati.
  //
  // ASSENTE PER DIFETTO: senza l'opzione il percorso è byte-per-byte quello di prima.
  const senzaQuesti = Array.isArray(opts.excludeMarketIds) && opts.excludeMarketIds.length
    ? new Set(opts.excludeMarketIds.map((x) => String(x).trim().toLowerCase()).filter(Boolean))
    : null;
  const fundable = new Map();
  for (const [mid, rows] of J.byMarket.entries()) {
    if (!potByCond.has(mid)) continue;
    if (soloQuesti && !soloQuesti.has(String(mid).trim().toLowerCase())) continue;
    if (senzaQuesti && senzaQuesti.has(String(mid).trim().toLowerCase())) continue;
    fundable.set(mid, rows);
  }

  // true OBSERVED fill/market counts across the tape (not the allocation's 11/4)
  let totalTapeFills = 0; const filledMarkets = new Set();
  for (const [mid, rows] of fundable.entries()) {
    const trades = (marketTokens.get(mid) && tape.byToken.get(marketTokens.get(mid))) || [];
    const nf = reconstructTapeFillsForMarket(rows, trades, { offsetCents: 1, sizeUsd: 250, maxInventoryUsd: 5000 }).fills.length;
    if (nf > 0) { totalTapeFills += nf; filledMarkets.add(mid); }
  }

  // structural fill scores across the fundable universe + the AUC/CI of the score (validated, not refit)
  const feats = [];
  for (const [mid, rows] of fundable.entries()) feats.push(marketFeatures(mid, rows, { ...(nameMap.get(mid) || {}), maxSpread: maxSpreadByMarket.get(mid), pot: potByCond.get(mid) }, nowMs));
  const scored = computeFillScores(feats);
  const fillScoreByMarket = new Map(scored.map((f) => [f.marketId, f.fillScore]));
  const V = auc(scored, filledMarkets);

  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'mid-history-coverage.json'), 'utf8')); } catch { /* unknown */ }
  const cov = coverageHeader({ coveredMarketCount, universeMarketCount: manifest ? manifest.universeMarketCount : null });
  const truePct = Math.round((coveredMarketCount / LIVE_UNIVERSE) * 1000) / 10;

  // ── L'UNIVERSO E' GIA' TUTTO ────────────────────────────────────────────────────────────────────
  // `fundable` NON e' la lista abilitata a mano: e' l'intersezione fra i mercati con montepremi sul
  // board reward e quelli di cui il collector ha storico prezzi. La selezione manuale
  // (cfg.enabledMarketIds) non compare da nessuna parte in questo percorso e non l'ha mai fatto — il
  // knapsack ha sempre cercato su tutto. Quello che mancava era DIRLO, e il registro qui sotto lo dice.
  const horizonFilter = opts.horizonFilter === true;
  const plan = capital > 0
    ? planAllocation({ byMarket: fundable, marketTokens, tapeByToken: tape.byToken, potByCond, budgetUsd: capital, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold', maxCount: 25, maxSpreadByMarket, fillScoreByMarket, endDateByMarket, minSizeByMarket, horizonFilter, maxPerMarketUsd: opts.maxPerMarketUsd ?? null, nowMs })
    : { budgetUsd: 0, unitUsd: 0, offsetCents: 1, marketsUsed: 0, totalCapital: 0, unallocated: 0, totalGrossPerDay: 0, totalNetPerDay: null, totalRealisticPerDay: { grossPerDay: 0, realisticPerDay: 0, ratio: null, rowsCounted: 0, rowsUnknown: 0 }, frontier: [], rows: [], candidates: [], horizonRejected: [] };
  const rows = plan.rows.map((r) => ({ ...r, ...identify(nameMap, r.marketId) }));

  // Il registro, esteso ai rifiuti che avvengono PRIMA del knapsack: un mercato che paga reward ma di cui
  // non abbiamo storico prezzi non e' scartato dall'ottimizzatore, e' invisibile — e va detto come tale.
  const consideredIds = new Set((plan.candidates || []).map((c) => c.marketId));
  const preRejected = [];
  for (const mid of potByCond.keys()) {
    if (consideredIds.has(mid)) continue;
    preRejected.push({
      marketId: mid, status: 'scartato', capital: 0, reasonCode: 'senza-storico',
      reason: 'nessuno storico prezzi raccolto per questo mercato — non valutabile, non scartato nel merito',
      bestNetPerDay: null, bestGrossPerDay: null, competitorShares: null,
      pot: potByCond.get(mid) ?? null,
      maxSpreadCents: maxSpreadByMarket.get(mid) ?? null, horizon: null,
    });
  }
  const candidates = [...(plan.candidates || []), ...preRejected]
    .map((c) => ({ ...c, ...identify(nameMap, c.marketId) }))
    .sort((a, b) => {
      if ((a.status === 'scelto') !== (b.status === 'scelto')) return a.status === 'scelto' ? -1 : 1;
      return (fin(b.bestNetPerDay) ? b.bestNetPerDay : -Infinity) - (fin(a.bestNetPerDay) ? a.bestNetPerDay : -Infinity);
    });
  const annPct = capital > 0 && plan.totalGrossPerDay >= 0 ? (plan.totalGrossPerDay * 365 / capital) * 100 : null;

  return {
    generatedAt: new Date(J.window.toMs || Date.now()).toISOString(),
    requested: opts.capital, capital, unit: plan.unitUsd, offsetCents: plan.offsetCents,
    // Il tetto di concentrazione applicato a QUESTO piano, riportato sempre — anche quando è assente —
    // perché un piano concentrato e un piano cappato che si somigliano vanno letti in modo diverso.
    concentration: { maxPerMarketUsd: plan.maxPerMarketUsd ?? null, capped: plan.concentrationCapped === true },
    window: J.window, staleFrac: J.staleFrac,
    // L'età della fotografia del board da cui nascono montepremi, banda, scadenza e l'esistenza stessa
    // dei mercati di questo piano. `ageS: null` significa ignota — mai zero.
    board: { atMs: boardAtMs, atIso: boardAtMs ? new Date(boardAtMs).toISOString() : null, ageS: boardAtMs ? Math.round((nowMs - boardAtMs) / 1000) : null },
    coverage: {
      coveredMarketCount: cov.coveredMarketCount, manifestUniverse: cov.universeMarketCount, truePct, partial: true,
      headerLines: cov.headerLines,
      trueNote: `COVERAGE VERA: ${cov.coveredMarketCount} di ${LIVE_UNIVERSE} mercati reward collezionabili (Gamma) ≈ ${truePct}% — copertura PARZIALE, non il 109-113% del manifest.`,
    },
    observed: { totalFills: totalTapeFills, filledMarkets: filledMarkets.size, windowHours: J.window.hours },
    fillScore: { auc: V.auc, ci95: V.ci95, nFilled: V.nFilled, nUnfilled: V.nUnfilled, note: 'discriminatore debole ma significativo (AUC), NON una probabilità' },
    offsetFrontier: OFFSET_FRONTIER,
    rows,
    totals: {
      capital: plan.totalCapital, unallocated: plan.unallocated,
      grossPerDay: plan.totalGrossPerDay, netPerDay: plan.totalNetPerDay, count: plan.marketsUsed,
      // The SECOND total, alongside the gross — never instead of it.
      realisticPerDay: plan.totalRealisticPerDay ? plan.totalRealisticPerDay.realisticPerDay : null,
      realisticRatio: plan.totalRealisticPerDay ? plan.totalRealisticPerDay.ratio : null,
      realisticRowsUnknown: plan.totalRealisticPerDay ? plan.totalRealisticPerDay.rowsUnknown : null,
    },
    annualisedGross: { pct: annPct, capped: annPct != null && annPct > APY_CAP, cap: APY_CAP, label: 'lordo (adverse selection misurata a parte), run-rate, non garantito' },
    // The same annualisation on the CORRECTED figure, so the two APY readings sit next to each other and
    // the difference between the theoretical and the honest number is impossible to miss.
    annualisedRealistic: (() => {
      const rp = plan.totalRealisticPerDay ? plan.totalRealisticPerDay.realisticPerDay : null;
      const pct = (capital > 0 && fin(rp)) ? (rp * 365 / capital) * 100 : null;
      return { pct, capped: pct != null && pct > APY_CAP, cap: APY_CAP, label: 'stima realistica dopo correzioni dichiarate — resta una stima, non una garanzia' };
    })(),
    frontier: plan.frontier,
    // Mercati che la size minima del venue esclude a questo capitale, con il capitale che li sbloccherebbe.
    belowMinSize: (plan.belowMinSize || []).map((b) => ({ ...b, ...identify(nameMap, b.marketId) })),
    // ── IL REGISTRO COMPLETO: ogni mercato dell'universo, scelto o scartato, col suo motivo. ──
    candidates,
    universe: {
      // Le due cifre che rispondono a "su cosa ha davvero cercato": i mercati con montepremi sul board, e
      // quanti di quelli hanno storico prezzi abbastanza da poter essere valutati.
      withPot: potByCond.size,
      evaluated: consideredIds.size,
      chosen: rows.length,
      // null = universo intero (il caso di sempre); un numero = quanti mercati erano ammessi a monte.
      restrictedTo: soloQuesti ? soloQuesti.size : null,
      // null = nessuna esclusione (il caso di sempre); un numero = quanti mercati sono stati tolti a
      // monte perché il venue li ha dichiarati non più negoziabili in questo ciclo.
      excluded: senzaQuesti ? senzaQuesti.size : null,
      horizonFilter,
      horizonRejected: (plan.horizonRejected || []).length,
      note: 'Universo = tutti i mercati con montepremi sul board reward, non la lista abilitata a mano: la selezione manuale non entra in questo calcolo.',
    },
  };
}

// ── Selfcheck for the per-market-offset behaviours (the existing allocator.test covers planAllocation;
// this extends it for the NEW logic). Each assertion is independent. Run: node -e "require('./lib/rewards/allocator').selfcheckOffset()".
function selfcheckOffset() {
  let n = 0; const ok = (name, cond) => { if (!cond) throw new Error('SELFCHECK FAIL: ' + name); console.log('  ✓ ' + name); n++; };
  const near = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
  // 1. per-tick snapping on the market's OWN tick
  ok('snapBidAsk(0.575, 0.01, 1) → bid 0.56 / ask 0.58', (() => { const s = snapBidAsk(0.575, 0.01, 1); return near(s.bid, 0.56) && near(s.ask, 0.58); })());
  ok('snapBidAsk(0.500, 0.001, 1) → bid 0.499 / ask 0.501 (fine tick)', (() => { const s = snapBidAsk(0.5, 0.001, 1); return near(s.bid, 0.499) && near(s.ask, 0.501); })());
  ok('snapBidAsk(0.575, 0.01, 2) → 2 ticks → bid 0.55 / ask 0.59', (() => { const s = snapBidAsk(0.575, 0.01, 2); return near(s.bid, 0.55) && near(s.ask, 0.59); })());
  // 2. unknown tick fails CLOSED → null (renders "—")
  ok('unknown tick → {bid:null, ask:null} (fail closed)', (() => { const s = snapBidAsk(0.5, null, 1); return s.bid === null && s.ask === null; })());
  // 3. dual unit: one tick is different cents on different ticks
  ok('1 tick = 1.0¢ on a 0.01 market, 0.1¢ on a 0.001 market', near(1 * 0.01 * 100, 1) && near(1 * 0.001 * 100, 0.1));
  // 4. default offset (ticks) is the 1¢ baseline expressed in the market's own ticks
  const defTicks = (tick) => Math.max(1, Math.round(1 / (tick * 100)));
  ok('defaultOffsetTicks: 0.01→1 tick, 0.001→10 ticks (both = 1¢ baseline)', defTicks(0.01) === 1 && defTicks(0.001) === 10);
  // 5. fill curve entries carry tick/offsetCents/fills/bid/ask (client looks up, never reimplements)
  const curve = fillsByTickCurve([{ adjMid: 0.5, tsMs: 0, tick: 0.01 }, { adjMid: 0.5, tsMs: 1000, tick: 0.01 }], [], 100, 0.01, 0.5, 4.5, 24, 5000);
  ok('fillsByTickCurve returns per-tick {tick,offsetCents,fills,bid,ask}', Array.isArray(curve) && curve[0].tick === 0 && 'offsetCents' in curve[0] && 'fills' in curve[0] && 'bid' in curve[0]);
  // 6. band-honest rule (the client applies it): offsetCents > maxSpread/2 ⇒ out of band ⇒ gross 0
  const outOfBand = (offsetCents, maxSpread) => offsetCents > maxSpread / 2 + 1e-9;
  ok('3¢ offset vs 4.5¢ band (radius 2.25¢) → OUT of band', outOfBand(3, 4.5) === true);
  ok('2¢ offset vs 4.5¢ band → IN band', outOfBand(2, 4.5) === false);
  // 7. computed default is NET-derived, not gross-derived: with fills concentrated at mid, gross-max = tick 0
  //    (flat gross) but net-max steps off mid to escape the measured cost → default ≠ grossMaxTicks.
  const curveFillsAtMid = [
    { tick: 0, offsetCents: 0, fills: 40, costPerDay: 5.0, bid: 0.5, ask: 0.5 },
    { tick: 1, offsetCents: 1, fills: 1, costPerDay: 0.0, bid: 0.49, ask: 0.51 },
    { tick: 2, offsetCents: 2, fills: 0, costPerDay: 0.0, bid: 0.48, ask: 0.52 },
  ];
  const dNet = computedDefaultOffset(curveFillsAtMid, 10, 6); // gross 10, band 6¢ radius 3¢ → all in band
  ok('computed default is net-derived (netDerived flag true)', dNet.netDerived === true);
  ok('gross-max offset (0, at mid) is NOT chosen — net-max steps off mid', dNet.grossMaxTicks === 0 && dNet.ticks === 1);
  // 7b. even when mid has ZERO measured cost (net flat at mid), the default still steps OFF mid — quoting at
  //     mid is never right when gross is flat (stepping off is free and avoids ~97% of fills).
  const curveFreeMid = [
    { tick: 0, offsetCents: 0, fills: 30, costPerDay: 0, bid: 0.5, ask: 0.5 },
    { tick: 1, offsetCents: 1, fills: 1, costPerDay: 0, bid: 0.49, ask: 0.51 },
  ];
  const dFree = computedDefaultOffset(curveFreeMid, 10, 6);
  ok('net flat at mid (cost 0) → still steps OFF mid to 1 tick, never defaults to mid', dFree.ticks === 1 && dFree.grossMaxTicks === 0 && dFree.netDerived === true);
  // 8. 0-fill market → net not measurable → exposure-derived fallback (1 tick off mid), MARKED
  const curveNoFills = [
    { tick: 0, offsetCents: 0, fills: 0, costPerDay: 0, bid: 0.5, ask: 0.5 },
    { tick: 1, offsetCents: 1, fills: 0, costPerDay: 0, bid: 0.49, ask: 0.51 },
  ];
  const dExp = computedDefaultOffset(curveNoFills, 10, 6);
  ok('0-fill market → exposure-derived (1 tick), not net-derived', dExp.netDerived === false && dExp.ticks === 1);
  // 9. out-of-band ticks are EXCLUDED from the default search (never chosen past the band radius)
  const curveTight = [
    { tick: 0, offsetCents: 0, fills: 20, costPerDay: 3, bid: 0.5, ask: 0.5 },
    { tick: 1, offsetCents: 1, fills: 5, costPerDay: 1, bid: 0.49, ask: 0.51 },
    { tick: 2, offsetCents: 2, fills: 0, costPerDay: 0, bid: 0.48, ask: 0.52 }, // out of a 2¢ band (radius 1¢)
  ];
  const dBand = computedDefaultOffset(curveTight, 10, 2); // radius 1¢ → only ticks 0 and 1 in band
  ok('out-of-band tick (2¢ vs 1¢ radius) excluded from default', dBand.ticks <= 1);
  console.log('selfcheckOffset: ' + n + ' assertions passed');
  return n;
}

module.exports = { ...allocate, planAllocation, planFromCollection, marketMeta, frontierByCount, snapBidAsk, fillsByTickCurve, computedDefaultOffset, identify, selfcheckOffset };

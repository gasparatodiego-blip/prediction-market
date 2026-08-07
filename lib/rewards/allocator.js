'use strict';
// lib/rewards/allocator.js — the ONE capital allocator, imported by BOTH the backtest
// (scripts/rewards-replay/allocate-run.js) and the UI (/dashboard/liquidity-rewards/allocate).
//
// It re-exports the measured knapsack allocator from scripts/rewards-replay/lib/allocate — never a second
// implementation — and adds a UI-facing planAllocation() plus planFromCollection() (the orchestration the
// /api/rewards/allocate route runs out-of-process). It reads no key, signs nothing, and constructs no order.
//
// PER-MARKET OFFSET: the base allocation runs the knapsack ONCE, valuing every market at its OWN real
// offset of `offsetTicks` ticks (default 1 tick). Each returned row carries everything the client needs to
// recompute its own offset LOCALLY (no refetch): mid, tick, maxSpread, the S=1-ceiling gross, the per-tick
// fill curve, the structural fill score. The offset override is a display recompute; it never re-runs the
// knapsack.
//
// ── L'EQUIVALENZA COL BACKTEST E' STATA ABBANDONATA DELIBERATAMENTE (5 agosto 2026) ────────────────
// Fino a questa data il knapsack valutava OGNI mercato a 1¢ fisso, e quella era la «backtest-equal
// baseline»: la stessa distanza in centesimi che usa `allocate-run.js`. Su tick 0,01 un centesimo e' un
// tick e coincide; su tick 0,001 sono dieci tick, cioe' il knapsack giudicava quei mercati da una
// posizione dieci livelli piu' indietro di quella che il motore prende davvero — quando piazza, si mette
// a UN tick dal concorrente.
//
// MOTIVO DELLA SCELTA: selezionare i mercati sulla base di dove il motore si mette davvero vale piu'
// della confrontabilita' con le stime storiche. Chi legge un numero diverso da uno del backtest NON sta
// guardando una regressione: sta guardando due domande diverse. Il backtest chiede «quanto avrebbe reso
// una regola uniforme a 1¢»; questo pianificatore chiede «quanto rende la regola che il motore applica».
//
// COSA NON E' CAMBIATO, e conviene saperlo prima di cercarci dentro un effetto grande: nel percorso del
// knapsack il LORDO e' `pot × s/(s+cQ)` (rewards-ceiling/lib/curve.shareForCapital) e non contiene
// nessun termine di offset — e' il ceiling a S=1. L'offset entra solo (a) nei fill ricostruiti dal tape,
// quindi nel costo avverso misurato, e (b) nel costo della coppia. Il quadratico pubblicato
// S=((v−s)/v)², quello che distingue davvero un tick fine da uno grosso, vive in realistic-estimate.js
// e NON alimenta l'obiettivo del knapsack. Vedi la nota su `offsetTicks` in planAllocation.

const path = require('path');
// La cartella `data/` si CHIEDE al risolutore condiviso, non si conta con i «..»: sotto `lib/` un
// modulo puo' essere importato da una rotta, e nel bundle di Next `__dirname` e' .next/server/… —
// dove i «..» portano in `.next/data/`, una cartella che non esiste. Vedi lib/safety/store.js.
const { DATA_DIR } = require('../safety/store');
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

// LA REGOLA DEL NETTO, IN UN PUNTO SOLO. Vedi net-per-day.js: un netto esiste solo se un fill è stato
// osservato, e il costo modellato a zero per l'ottimizzazione non è un costo misurato a zero.
const { calcNetPerDay, perchePerNettoAssente } = require('./net-per-day');

// `marketTick` — il tick del mercato dal primo campione che ne dichiari uno. Importato invece di
// riscritto: e' lo stesso che ha risolto l'offset e il costo della coppia dentro allocateBudget, e due
// copie potrebbero rispondere diversamente sulla stessa serie.
const { allocateBudget, knapsack, marketTick } = allocate;

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** Minuti alla chiusura di UN mercato, dalla stessa mappa endDate che alimenta horizonVerdict.
 *  null = non leggibile, e non viene indovinato. */
function minutiAllaChiusuraDelMercato(endDateByMarket, marketId, nowMs) {
  const ed = endDateByMarket ? (endDateByMarket.get(marketId) ?? null) : null;
  if (typeof ed !== 'string' || !ed.trim() || !fin(nowMs)) return null;
  const t = Date.parse(ed);
  return Number.isFinite(t) ? (t - nowMs) / 60000 : null;
}
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
 * Plan an allocation of `budgetUsd`. The knapsack runs at `offsetTicks` ticks of EACH market's own tick
 * (default 1 tick — where the engine actually posts). `offsetCents` survives only as the fallback for a
 * market whose tick is unreadable, and as the escape hatch for a caller that wants the pre-5-agosto-2026
 * uniform-cents behaviour back (`offsetTicks: null`).
 * Extra per-market inputs are additive and never change the allocation:
 *   maxSpreadByMarket   conditionId → reward band width (cents), for the out-of-band ZERO rule + fill curve
 *   fillScoreByMarket   conditionId → structural fill-likelihood score (0..1) | null
 */
function planAllocation(cfg) {
  const {
    byMarket, marketTokens, tapeByToken, potByCond, budgetUsd,
    offsetCents = 1, maxInventoryUsd = 5000, policy = 'hold', maxCount = 25,
    // ── L'OFFSET CON CUI IL KNAPSACK GIUDICA, IN TICK DEL MERCATO ──────────────────────────────────
    // Un tick: la distanza a cui il motore si mette quando piazza davvero (mai primo sul book, un tick
    // dal concorrente). Prima qui c'era un 1¢ fisso, che su tick 0,001 vale dieci tick — una posizione
    // che il motore non assume mai. `null` ripristina il comportamento in centesimi uniformi.
    //
    // ATTENZIONE A COSA QUESTO NON FA: non introduce il punteggio quadratico di posizione. Nel percorso
    // del knapsack il lordo e' offset-indipendente per costruzione (il ceiling a S=1), quindi cambiare
    // questo numero muove SOLO i fill ricostruiti — e con essi il costo avverso misurato — e il costo
    // della coppia qui sotto. Un tick fine prende PIU' fill di dieci tick, non meno.
    offsetTicks = 1,
    maxSpreadByMarket = null, fillScoreByMarket = null, endDateByMarket = null, minSizeByMarket = null,
    endDateSourceByMarket = null,
    touchByMarket = null,
    // ── THE HORIZON FILTER — OFF BY DEFAULT, AND THAT IS DELIBERATE ────────────────────────────────
    // With horizonFilter false this filter removes nothing: same universe, same knapsack, same
    // allocation, and the existing tests keep passing. The auto-optimise path turns it on explicitly.
    // (Questo commento diceva anche «so the backtest equality the whole module rests on is untouched».
    // Non lo dice più: dal 5 agosto 2026 il modulo NON riposa più su quell'equivalenza — vedi
    // l'intestazione. Il filtro orizzonte resta comunque neutro quando è spento, che è il punto qui.)
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
    // ── IL COSTO DELLA COPPIA — ACCESO PER DIFETTO SOLO DA CHI PIAZZA DAVVERO DUE GAMBE ────────────
    // Il backtest e la pipeline del ceiling modellano il lato ask come una VENDITA di inventario gia'
    // posseduto: li' il capitale va tutto sul bid e la formula storica e' quella giusta. Il piano che
    // finisce in ordini veri, invece, compra ENTRAMBI i lati in collaterale. Sono due mondi diversi e
    // devono poter dare due numeri diversi senza che nessuno dei due sia sbagliato.
    usePairCost = false,
    nowMs = Date.now(),
  } = cfg;
  const unitUsd = cfg.unitUsd || Math.max(2, Math.round(budgetUsd / 50));
  const capPerMarketUsd = fin(maxPerMarketUsd) && maxPerMarketUsd > 0 ? Math.min(maxPerMarketUsd, budgetUsd) : budgetUsd;
  // ── IL COSTO VERO DI UNA COPPIA DI SHARE ────────────────────────────────────────────────────────
  // Quotare due lati partendo da collaterale è comprare YES a (mid − d) e NO a (1 − mid − d): la coppia
  // costa `1 − 2d` dollari, e la cosa notevole è che NON dipende dal mid.
  //
  // NON È PIÙ UNO SCALARE DI PIANO (5 agosto 2026). Lo era perché lo era `d`. Adesso `d` è l'offset
  // reale del singolo mercato — un tick, che vale 1¢ su tick 0,01 e 0,1¢ su tick 0,001 — quindi il
  // costo della coppia si calcola dove l'offset si risolve, cioè per mercato dentro `allocateBudget`
  // (vedi `pairCostForMarket` in scripts/rewards-replay/lib/allocate.js, dove la derivazione è scritta
  // per esteso). Se fosse rimasto qui, resterebbe agganciato a un 1¢ che non esiste più da nessuna
  // parte, e il knapsack massimizzerebbe un netto costruito su una size che nessuna riga ha davvero.
  // Ogni livello di curva porta con sé il `pairCostUsd` con cui è stato classificato.
  //
  // Prima questa quantità non esisteva e il modello usava `(capitale/2)/mid` share per lato, cioè
  // assumeva che il lato ask costasse `mid` per share come il bid. Vero solo a mid ≈ 0,50; a mid 0,055
  // il lato ask costa 0,935 per share, diciassette volte tanto. Il rapporto fra le due formule è
  // 2·mid/(1−2d): 1,00 a 49¢, 0,11 a 5,5¢.
  //
  // E il difetto non era cosmetico: il knapsack MASSIMIZZA il netto, quindi un mercato economico che
  // sembra comprare nove volte le share che compra davvero sembra rendere nove volte tanto e viene
  // scelto al posto di uno onesto. Passare questo numero non cambia solo i totali mostrati: cambia
  // QUALI mercati entrano nel piano.
  //
  // `usePairCost` viaggia come opzione, SPENTA per difetto in tutta la catena a valle (come lo era
  // `pairCostUsd` prima di lei), così il backtest e la pipeline del ceiling — che modellano il lato ask
  // come vendita di inventario già posseduto — restano byte per byte quelli di prima. Quello che è
  // cambiato è dove il numero nasce: non più qui come scalare, ma per mercato dentro `allocateBudget`,
  // insieme all'offset da cui deriva.
  const allocFull = allocateBudget(byMarket, marketTokens, tapeByToken, potByCond, {
    offsetCents, offsetTicks, maxInventoryUsd, budgetUsd, unitUsd, maxPerMarketUsd: capPerMarketUsd, policy, minSizeByMarket, usePairCost,
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
    // L'UNICA REGOLA DI SCADENZA, dal 6 agosto 2026. Prima ce n'erano due, scelte dal profilo: il
    // rientro dal costo di adverse selection (Safe) e il pavimento di tradabilita' del venue (Risk).
    // I profili non esistono piu' — la formula del venue e' una curva continua e non conosce bucket —
    // quindi resta quella storica, che e' anche la piu' stretta: un mercato che non fa in tempo a
    // rientrare dal costo che gli costa non vale il capitale, e questo non dipendeva dal profilo.
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
    // Le share per lato con la STESSA regola che ha deciso il punteggio di questa riga: col costo della
    // coppia sono `capitale / (1 − 2d)`, senza restano `sizeUsd / mid`. Se questa riga divergesse da
    // shareForCapital, il piano mostrerebbe una size diversa da quella con cui e' stato classificato.
    // Il costo della coppia si legge DAL LIVELLO SCELTO, non da uno scalare di piano: con l'offset per
    // mercato è un numero per riga, e prenderlo altrove significherebbe mostrare una size che non è
    // quella che ha prodotto il punteggio.
    const rowPairCostUsd = fin(a.pairCostUsd) && a.pairCostUsd > 0 ? a.pairCostUsd : null;
    const sizePerSideShares = rowPairCostUsd != null
      ? a.capital / rowPairCostUsd
      : ((price != null && price > 0) ? a.sizeUsd / price : null);
    const maxSpreadCents = maxSpreadByMarket ? (maxSpreadByMarket.get(a.marketId) ?? null) : null;
    // ── L'OFFSET DI RIFERIMENTO DELLA RIGA, IN TICK ────────────────────────────────────────────────
    // Dal 5 agosto 2026 è `offsetTicks` e basta: il knapsack ha già giudicato questo mercato a quella
    // distanza in tick SUOI, quindi la riga dichiara lo stesso numero con cui è stata scelta. Prima qui
    // c'era `round(offsetCents / (tick·100))` con il commento «backtest is 1¢ uniform», che su tick
    // 0,001 restituiva 10 tick — ed era coerente col knapsack di allora, non con il motore. Il ritorno
    // ai centesimi resta possibile (`offsetTicks: null`) e allora questa riga torna alla vecchia
    // conversione: le due devono muoversi insieme, altrimenti la riga racconta un offset diverso da
    // quello con cui è stata classificata.
    // NON è l'offset con cui si piazza: quello è `computedDefaultOffsetTicks`, calcolato più sotto.
    const defaultOffsetTicks = fin(offsetTicks) && offsetTicks > 0
      ? Math.max(1, Math.round(offsetTicks))
      : ((fin(meta.tick) && meta.tick > 0) ? Math.max(1, Math.round(offsetCents / (meta.tick * 100))) : 1);
    const { bid, ask } = snapBidAsk(meta.mid, meta.tick, defaultOffsetTicks);
    // La regola vive in lib/rewards/net-per-day.js e NON viene riscritta qui: era scritta due volte
    // (qui e sulle card di proposta, cento righe più sotto) e la seconda copia era vecchia.
    const netPerDay = calcNetPerDay({ fills: a.fills, netPerDay: a.netPerDay5m });
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

    // ── L'OFFSET CON CUI QUESTA RIGA È STATA CLASSIFICATA, IN CENTESIMI ────────────────────────────
    // Non è più la costante di piano — su tick 0,001 vale 0,1¢ mentre il piano dichiara 1¢ — e
    // stamparne un'altra significherebbe mettere accanto alla riga una distanza che il knapsack non ha
    // mai usato per lei.
    //
    // Il tick da cui si ricava è `scoringTick`, cioè il PRIMO tick leggibile della serie — lo stesso
    // che ha prodotto il costo della coppia e gli stessi che tape.js usa riga per riga. NON è
    // `meta.tick`, che legge solo `rows[0]`: quando il primo campione non porta il tick i due
    // divergono, e la riga finirebbe per dichiarare 1¢ mentre è stata scorata a 0,1¢. `meta.tick`
    // resta intatto e continua ad alimentare `tick`, snapBidAsk e la curva per tick — questo campo
    // aggiunge, non sostituisce.
    const scoringTick = marketTick(rowsJ);
    const rowOffsetCents = (fin(scoringTick) && scoringTick > 0)
      ? +(defaultOffsetTicks * scoringTick * 100).toFixed(6)
      : offsetCents;
    return {
      marketId: a.marketId, capital: a.capital, sizePerSideUsd: a.sizeUsd, sizePerSideShares,
      pairCostUsd: rowPairCostUsd,
      // Il tick con cui la riga è stata CLASSIFICATA, accanto a quello con cui viene PREZZATA. Quasi
      // sempre lo stesso numero; quando divergono, è perché il primo campione non portava il tick, ed
      // è un'informazione che va letta invece che appianata.
      scoringTick,
      snappedBid: bid, snappedAsk: ask, tick: meta.tick, offsetCents: rowOffsetCents, depthShares: meta.depthShares, mid: meta.mid,
      spanHours: meta.spanHours, newestTsMs: meta.newestTsMs, grossPerDay: fin(a.grossPerDay) ? a.grossPerDay : null,
      grossInBandPerDay,
      netPerDay, fills: a.fills, share: a.share, maxSpreadCents, defaultOffsetTicks,
      computedDefaultOffsetTicks: cdef.ticks, defaultReason: cdef.reason, defaultNetDerived: cdef.netDerived, grossMaxDefaultTicks: cdef.grossMaxTicks,
      // IL RIFERIMENTO VIVO per chi deve piazzare: mid di scoring e tocco del libro, dal board.
      // Il `mid` qui sopra resta la mediana su cui la riga è stata SCORATA — sono due cose diverse e
      // confonderle è ciò che ha prodotto una quotazione sull'ask.
      rif: touchByMarket ? (touchByMarket.get(a.marketId) ?? null) : null,
      endDate: endDateByMarket ? (endDateByMarket.get(a.marketId) ?? null) : null,
      // 'market' | 'event' | null — la data è pubblicata sul mercato o ereditata dall'evento padre.
      endDateSource: endDateSourceByMarket ? (endDateSourceByMarket.get(a.marketId) ?? null) : null,
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
    // ── IL DIFETTO DEL 4 AGOSTO 2026, CORRETTO ALLA FONTE ─────────────────────────────────────────
    // Qui mancava la guardia sui fill che la riga del piano applicava già. Il motore modella «nessun
    // fill osservato» come costo 0 — giusto per SCEGLIERE, perché assumere un costo inventato
    // escluderebbe un mercato per un'ipotesi — ma quel valore arrivava sullo schermo come
    // `netto = lordo − 0 = lordo`. Sulle card si leggevano due colonne diverse con lo stesso numero,
    // mentre il banner della stessa pagina prometteva un trattino.
    // Ora la regola è una sola, importata, e vale per le righe e per le card.
    const bestNetPerDay = calcNetPerDay({ fills: best && best.fills, netPerDay: best && best.net5m });
    const bestNetAssente = perchePerNettoAssente({ fills: best && best.fills, netPerDay: best && best.net5m });
    const hz = horizonByMarket.get(c.marketId) || null;
    const chosen = chosenById.get(c.marketId) || null;
    const base = {
      marketId: c.marketId,
      bestNetPerDay,
      // PERCHÉ il netto manca: «nessun fill osservato» e «non calcolabile» sono due assenze diverse, e
      // un trattino solo le confonde. null quando il netto c'è.
      bestNetAssente,
      bestNetFills: best && fin(best.fills) ? best.fills : null,
      bestGrossPerDay: best && fin(best.grossPerDay) ? best.grossPerDay : null,
      competitorShares: (() => { const m = marketMeta(byMarket.get(c.marketId) || []); return m.depthShares; })(),
      pot: potByCond.get(c.marketId) ?? null,
      maxSpreadCents: maxSpreadByMarket ? (maxSpreadByMarket.get(c.marketId) ?? null) : null,
      horizon: hz ? {
        state: hz.state, days: hz.days, payback: hz.payback === Infinity ? null : hz.payback, paybackNever: hz.payback === Infinity,
        // Da dove viene la data su cui il verdetto è stato dato — o perché non c'è.
        source: endDateSourceByMarket ? (endDateSourceByMarket.get(c.marketId) ?? null) : null,
        endDateKnown: !!(endDateByMarket && endDateByMarket.get(c.marketId)),
      } : null,
    };
    // ── UNA SCADENZA IGNOTA NON È UN VERDETTO FAVOREVOLE ───────────────────────────────────────────
    // Il filtro orizzonte non rifiuta mai su `unknown`, ed è giusto così: l'assenza di una data non è
    // una data breve. Ma finora la conseguenza era che un mercato senza scadenza entrava nel piano
    // ESATTAMENTE come uno con orizzonte verificato — stesso stato, stesso motivo, nessuna differenza
    // leggibile. «Non lo so» e «l'ho controllato e va bene» finivano indistinguibili.
    // Qui non cambia niente di ciò che viene scelto: cambia che la mancanza venga DETTA.
    const orizzonteIgnoto = !!(hz && hz.state === 'unknown' && !base.horizon.endDateKnown);
    base.horizonUnknown = orizzonteIgnoto;   // viaggia su OGNI candidato, scelto o scartato
    if (chosen) {
      // IL PERCHE' DELLA SCELTA, costruito dai numeri della riga stessa — non un'etichetta decorativa.
      const why = [];
      if (fin(base.pot) && base.pot > 0) why.push(`montepremi $${Math.round(base.pot)}/g`);
      if (fin(chosen.share)) why.push(`quota modellata ${(chosen.share * 100).toFixed(1)}%`);
      if (fin(base.competitorShares)) why.push(`concorrenza in banda ${Math.round(base.competitorShares)} share`);
      if (fin(base.maxSpreadCents)) why.push(`banda ${base.maxSpreadCents.toFixed(2)}¢`);
      if (hz && hz.state === 'ok' && fin(hz.days)) {
        const via = base.horizon.source === 'event' ? ' (data dell\'evento padre)' : '';
        why.push(`scade fra ${Math.round(hz.days)} g${via}`);
      }
      // Detto a voce, dentro il motivo della scelta: questo mercato è entrato SENZA che l'orizzonte
      // potesse essere verificato. Non è un rifiuto — è la differenza fra un controllo passato e un
      // controllo non eseguito, e chi legge il piano ha diritto di vederla.
      if (orizzonteIgnoto) why.push('SCADENZA IGNOTA — filtro orizzonte non applicabile, entra senza quel controllo');
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

  // ── IL COSTO DELLA COPPIA, CHE ORA È UNA COLONNA E NON UN NUMERO ─────────────────────────────────
  // Con l'offset per mercato ogni riga ha il suo. Il campo di piano sopravvive perché ci sono lettori
  // (scripts/traccia-ottimizza.js, scripts/simula-storico.js, il pannello) che lo stampano, ma dice il
  // vero: il valore SOLO quando tutte le righe concordano, `null` quando divergono — e in quel caso la
  // gamma è dichiarata a parte invece di essere rappresentata da un campione arbitrario.
  const pairCosts = rows.map((r) => r.pairCostUsd).filter((x) => fin(x) && x > 0);
  const pairCostUniforme = pairCosts.length === rows.length && pairCosts.length > 0
    && pairCosts.every((x) => Math.abs(x - pairCosts[0]) < 1e-9);
  return {
    budgetUsd, unitUsd, offsetCents, offsetTicks, marketsUsed: rows.length,
    // Il costo della coppia con cui questo piano e' stato classificato. null = o modello storico
    // (lato ask come inventario), o righe con costi diversi — `pairCostModel` distingue i due casi.
    // Dichiarato perche' due piani con due modelli di size non sono confrontabili, e la differenza
    // non si vede dai totali.
    pairCostUsd: pairCostUniforme ? pairCosts[0] : null,
    pairCostModel: usePairCost ? 'coppia-in-collaterale' : 'ask-da-inventario',
    pairCostRange: pairCosts.length ? { min: Math.min.apply(null, pairCosts), max: Math.max.apply(null, pairCosts) } : null,
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
    // I mercati entrati nel piano SENZA scadenza leggibile. Non sono scarti e non sono un errore: sono
    // i casi in cui il filtro orizzonte non ha potuto pronunciarsi, ed è un elenco che deve esistere
    // perché «nessun rifiuto» non significhi «tutti verificati».
    horizonUnknown: candidates.filter((c) => c.horizonUnknown && c.status === 'scelto').map((c) => c.marketId),
    // La stessa cosa sull'intero universo valutato, scelti e scartati.
    horizonUnknownAll: candidates.filter((c) => c.horizonUnknown).map((c) => c.marketId),
  };
}

// ── Orchestration the /api/rewards/allocate route runs out-of-process (plain node, no webpack). ──
const REWARDS_FILE = path.join(DATA_DIR, 'liquidity-rewards.json');
const WINDOW_MS = 48 * 3_600_000;
const LIVE_UNIVERSE = 658;
const APY_CAP = 200;
// ── LUNGHEZZA DELLA CURVA `frontier`, E BASTA ───────────────────────────────────────────────────────
// ATTENZIONE A COSA QUESTO NUMERO NON FA: non limita i mercati del piano. `rows` nasce da
// `alloc.allocation` un centinaio di righe più sotto; `maxCount` entra solo in `frontierByCount`, il
// cui risultato finisce in `plan.frontier` — una curva «con N mercati il netto sarebbe X» che il
// pannello mostra e nessuno usa per selezionare. Prova: con questo a 10 un piano da $60.000
// restituisce 18 righe.
//
// Il 7 agosto 2026 l'ho portato da 25 a 10 credendo che fosse il tetto dei mercati contemporanei, sulla
// scorta del manuale v2. Non lo è, e l'unico effetto era accorciare il grafico: ripristinato a 25.
// Il numero di mercati lo governa `allocateBudget` (griglia delle size, unitUsd, tetto di
// concentrazione); un tetto vero andrebbe messo lì, ed è una decisione separata.
// Vedi data/indagine-offset.md §3.
const MAX_MERCATI_PIANO = 25;
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
  const endDateSourceByMarket = new Map();
  // ── IL LIBRO VERO, PER CHI DEVE PIAZZARCI SOPRA ──────────────────────────────────────────────────
  // Il piano SCORA su una mediana dello storico (marketMeta → median(adjMid)), ed è corretto: un
  // punteggio costruito sull'ultimo tick sarebbe rumore. Ma il PREZZO di un ordine non si decide su una
  // mediana di 48 ore — si decide contro il libro che c'è adesso, o si propone una quotazione che il
  // venue rifiuta. Misurato il 5 agosto 2026: mediana 0,835 contro mid di scoring vivo 0,795.
  // Il board porta entrambe le cose che servono, e sono le stesse che il pannello ordine mostra.
  const touchByMarket = new Map();
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
    // Provenienza della scadenza scritta da agent24: 'market' (pubblicata sul mercato) o 'event'
    // (ereditata dall'evento padre — su un negRisk la data e' una proprieta' dell'evento, non
    // dell'esito). Non cambia nessun calcolo: rende verificabile da dove viene il numero.
    if (typeof m.endDateSource === 'string' && m.endDateSource) endDateSourceByMarket.set(m.conditionId, m.endDateSource);
    // Il mid di SCORING (quello che il venue usa per giudicare la banda: il midpoint al netto dei
    // livelli sotto min_incentive_size) e il tocco. `sides.yes.mid` quando c'è, altrimenti `mid`.
    const smid = Number(m.sides && m.sides.yes && m.sides.yes.mid);
    const scoringMid = fin(smid) ? smid : (fin(Number(m.mid)) ? Number(m.mid) : null);
    const bb = Number(m.bestBid), ba = Number(m.bestAsk);
    if (scoringMid != null || fin(bb) || fin(ba)) {
      touchByMarket.set(m.conditionId, {
        scoringMid,
        bestBid: fin(bb) && bb > 0 ? bb : null,
        bestAsk: fin(ba) && ba > 0 ? ba : null,
      });
    }
  }
  return { nameMap, potByCond, maxSpreadByMarket, endDateByMarket, endDateSourceByMarket, minSizeByMarket, touchByMarket, boardAtMs };
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
  const { nameMap, potByCond: boardPots, maxSpreadByMarket, endDateByMarket, endDateSourceByMarket, minSizeByMarket, touchByMarket, boardAtMs } = loadBoard();
  let potByCond = boardPots;
  if (opts.pots) { const snap = JSON.parse(fs.readFileSync(opts.pots, 'utf8')); potByCond = new Map(Object.entries(snap.byCond).map(([c, o]) => [c, o.pot])); }

  const nowMs = Date.now();
  const rawTo = opts.to ? Date.parse(opts.to) : nowMs;
  const rawFrom = opts.from ? Date.parse(opts.from) : rawTo - WINDOW_MS;
  // Clamp to the tape's actual span, the same clamp the backtest allocate-run.js applies, so the two are
  // asked about the SAME window when no override is set.
  //
  // La FINESTRA resta identica a quella del backtest; l'ALLOCAZIONE no, e non deve più esserlo: dal
  // 5 agosto 2026 il knapsack valuta ogni mercato a un tick suo invece che a 1¢ uniforme (vedi
  // l'intestazione del modulo). Questo commento prometteva «matches the backtest exactly» — era vero
  // allora, sarebbe una bugia adesso, e chi confronta i due numeri deve sapere che divergono per
  // scelta e non per errore.
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
  // ── IL PAVIMENTO SUL MONTEPREMI ─────────────────────────────────────────────────────────────────
  // Fino al 7 agosto 2026 bastava `pot > 0`: un mercato da $5/g competeva con uno da $600/g. Il
  // pavimento vive in lib/rewards/montepremi-minimo.js con il perché e la misura; qui si applica PRIMA
  // del knapsack, così un mercato povero non compare fra i candidati valutati ma fra i rifiutati con il
  // suo codice. Un montepremi ILLEGGIBILE non scarta: `montepremiSufficiente` risponde ammesso:true.
  const { montepremiSufficiente, MIN_POT_USD_PER_DAY, PAVIMENTO_ATTIVO } = require('./montepremi-minimo');
  const sottoMontepremi = [];
  const fundable = new Map();
  for (const [mid, rows] of J.byMarket.entries()) {
    if (!potByCond.has(mid)) continue;
    if (soloQuesti && !soloQuesti.has(String(mid).trim().toLowerCase())) continue;
    if (senzaQuesti && senzaQuesti.has(String(mid).trim().toLowerCase())) continue;
    // `onlyMarketIds` è la domanda «quanto varrebbero i mercati che ho GIÀ in mano»: lì il pavimento
    // non si applica, altrimenti il termine di paragone del riallocatore cambierebbe insieme al filtro
    // e i due piani non sarebbero più confrontabili.
    if (PAVIMENTO_ATTIVO && !soloQuesti) {
      const g = montepremiSufficiente(potByCond.get(mid));
      if (!g.ammesso) { sottoMontepremi.push({ marketId: mid, pot: g.pot, motivo: g.motivo }); continue; }
    }
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
  try { manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'mid-history-coverage.json'), 'utf8')); } catch { /* unknown */ }
  const cov = coverageHeader({ coveredMarketCount, universeMarketCount: manifest ? manifest.universeMarketCount : null });
  const truePct = Math.round((coveredMarketCount / LIVE_UNIVERSE) * 1000) / 10;

  // ── L'UNIVERSO E' GIA' TUTTO ────────────────────────────────────────────────────────────────────
  // `fundable` NON e' la lista abilitata a mano: e' l'intersezione fra i mercati con montepremi sul
  // board reward e quelli di cui il collector ha storico prezzi. La selezione manuale
  // (cfg.enabledMarketIds) non compare da nessuna parte in questo percorso e non l'ha mai fatto — il
  // knapsack ha sempre cercato su tutto. Quello che mancava era DIRLO, e il registro qui sotto lo dice.
  const horizonFilter = opts.horizonFilter === true;
  const plan = capital > 0
    ? planAllocation({ byMarket: fundable, marketTokens, tapeByToken: tape.byToken, potByCond, budgetUsd: capital, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold', maxCount: MAX_MERCATI_PIANO, maxSpreadByMarket, fillScoreByMarket, endDateByMarket, endDateSourceByMarket, minSizeByMarket, touchByMarket, horizonFilter, maxPerMarketUsd: opts.maxPerMarketUsd ?? null, usePairCost: opts.usePairCost !== false, nowMs })
    : { budgetUsd: 0, unitUsd: 0, offsetCents: 1, marketsUsed: 0, totalCapital: 0, unallocated: 0, totalGrossPerDay: 0, totalNetPerDay: null, totalRealisticPerDay: { grossPerDay: 0, realisticPerDay: 0, ratio: null, rowsCounted: 0, rowsUnknown: 0 }, frontier: [], rows: [], candidates: [], horizonRejected: [] };
  const rows = plan.rows.map((r) => ({ ...r, ...identify(nameMap, r.marketId) }));

  // Il registro, esteso ai rifiuti che avvengono PRIMA del knapsack: un mercato che paga reward ma di cui
  // non abbiamo storico prezzi non e' scartato dall'ottimizzatore, e' invisibile — e va detto come tale.
  const consideredIds = new Set((plan.candidates || []).map((c) => c.marketId));
  const preRejected = [];
  // I mercati sotto il pavimento del montepremi hanno un codice loro: «non valutato» e «valutato e
  // troppo povero» sono due esiti diversi, e un registro che li confondesse manderebbe a cercare uno
  // storico prezzi che non era il problema.
  const sottoIds = new Set(sottoMontepremi.map((x) => x.marketId));
  for (const x of sottoMontepremi) {
    preRejected.push({
      marketId: x.marketId, status: 'scartato', capital: 0, reasonCode: 'montepremi-sotto-pavimento',
      reason: x.motivo,
      bestNetPerDay: null, bestGrossPerDay: null, competitorShares: null,
      pot: x.pot, maxSpreadCents: maxSpreadByMarket.get(x.marketId) ?? null, horizon: null,
    });
  }
  for (const mid of potByCond.keys()) {
    if (consideredIds.has(mid) || sottoIds.has(mid)) continue;
    preRejected.push({
      marketId: mid, status: 'scartato', capital: 0, reasonCode: 'senza-storico',
      reason: 'nessuno storico prezzi raccolto per questo mercato — non valutabile, non scartato nel merito',
      bestNetPerDay: null, bestGrossPerDay: null, competitorShares: null,
      pot: potByCond.get(mid) ?? null,
      maxSpreadCents: maxSpreadByMarket.get(mid) ?? null, horizon: null,
    });
  }
  // ── QUANTO SI MUOVE OGNI MERCATO — SOLO DA GUARDARE ─────────────────────────────────────────────
  // Si attacca QUI, sui candidati già formati, e non un riga più su: `planAllocation` è il knapsack, e
  // la velocità non deve poter entrare in una decisione. Nessun mercato viene scelto, scartato,
  // pesato o ordinato per questi numeri — arrivano al pannello e si fermano lì.
  //
  // PERCHÉ SERVE VEDERLA. La diagnosi del feed fermo del 6 agosto 2026 ha misurato che i mercati su cui
  // il capitale era allocato erano da 5 a 13 volte più silenziosi della media del board (TX-15 26% di
  // campioni senza eventi in 75s, contro il 2% del resto). Su un mercato così il guard sul mid vecchio
  // rifiuta di agire con un limite più stretto dell'intervallo naturale fra due eventi — e chi sceglieva
  // dove mettere il capitale non aveva modo di saperlo.
  //
  // Riusa il giornale che agent34 scrive già (data/mid-history-*.jsonl): nessuna raccolta nuova. Un
  // fallimento di lettura non deve poter far cadere un piano — la velocità è un di più, non un dato di
  // cui il piano abbia bisogno.
  let velocita = null;
  try {
    const { leggiVelocita } = require('./velocita-mercato');
    velocita = leggiVelocita({ windowHours: opts.velocityWindowHours });
  } catch { velocita = null; }

  const candidates = [...(plan.candidates || []), ...preRejected]
    .map((c) => ({
      ...c,
      ...identify(nameMap, c.marketId),
      // null quando il mercato non ha storico nella finestra: «non misurato» non è «immobile».
      velocita: (velocita && velocita.per.get(c.marketId)) || null,
    }))
    .sort((a, b) => {
      if ((a.status === 'scelto') !== (b.status === 'scelto')) return a.status === 'scelto' ? -1 : 1;
      return (fin(b.bestNetPerDay) ? b.bestNetPerDay : -Infinity) - (fin(a.bestNetPerDay) ? a.bestNetPerDay : -Infinity);
    });
  const annPct = capital > 0 && plan.totalGrossPerDay >= 0 ? (plan.totalGrossPerDay * 365 / capital) * 100 : null;

  return {
    generatedAt: new Date(J.window.toMs || Date.now()).toISOString(),
    requested: opts.capital, capital, unit: plan.unitUsd, offsetCents: plan.offsetCents,
    // I DUE FILTRI DI SELEZIONE, riportati sempre: chi legge un piano da 6 righe deve poter sapere
    // quanti mercati sono stati esclusi prima del knapsack e con quale soglia, senza aprire il codice.
    montepremiPavimentoUsd: (PAVIMENTO_ATTIVO && !soloQuesti) ? MIN_POT_USD_PER_DAY : null,
    montepremiSottoPavimento: (PAVIMENTO_ATTIVO && !soloQuesti) ? sottoMontepremi.length : null,
    maxMercatiPiano: MAX_MERCATI_PIANO,
    // SU QUANTO È MISURATA la velocità delle righe qui sotto: senza la finestra i numeri non si sanno
    // leggere, e senza il passo di campionamento non si sa cosa voglia dire «silenzio».
    velocitaMisura: velocita
      ? { finestraOre: velocita.finestraOre, mercatiMisurati: velocita.mercati, passoCampioneSec: velocita.passoCampioneSec }
      : null,
    // Il tetto di concentrazione applicato a QUESTO piano, riportato sempre — anche quando è assente —
    // perché un piano concentrato e un piano cappato che si somigliano vanno letti in modo diverso.
    concentration: { maxPerMarketUsd: plan.maxPerMarketUsd ?? null, capped: plan.concentrationCapped === true },
    // Il modello di size con cui QUESTO piano e' stato classificato. `pairCostUsd` presente = le share
    // per lato sono capitale/(1−2d), cioe' quelle che il capitale compra comprando ENTRAMBI i lati in
    // collaterale. null = modello storico (lato ask come vendita di inventario gia' posseduto). Due
    // piani con due modelli diversi non sono confrontabili, e dai totali non si vede.
    sizing: (() => {
      // Il modello si legge da `pairCostModel`, non dalla presenza del numero: con l'offset per mercato
      // `pairCostUsd` è null anche quando il modello della coppia È attivo, semplicemente perché le
      // righe hanno costi diversi. Dedurlo dal null direbbe «ask-da-inventario» su un piano che usa la
      // coppia — cioè la cosa sbagliata proprio nel campo che serve a non confondere due modelli.
      const model = plan.pairCostModel ?? (plan.pairCostUsd != null ? 'coppia-in-collaterale' : 'ask-da-inventario');
      const rg = plan.pairCostRange ?? null;
      const coppia = model === 'coppia-in-collaterale';
      const quanto = plan.pairCostUsd != null
        ? String(plan.pairCostUsd)
        : (rg ? `${rg.min}…${rg.max} secondo il mercato` : 'per mercato');
      return {
        pairCostUsd: plan.pairCostUsd ?? null,
        pairCostRange: rg,
        model,
        note: coppia
          ? `share per lato = capitale / ${quanto} (comprare YES a mid−d e NO a 1−mid−d costa 1−2d a coppia, indipendentemente dal mid; d è l'offset REALE del mercato — un tick — quindi il costo della coppia cambia col tick)`
          : 'share per lato = (capitale/2) / mid — regge solo se il lato ask non costa collaterale',
      };
    })(),
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
      // Quanti mercati sono entrati nel piano senza che l'orizzonte potesse essere verificato. Zero
      // rifiuti non vuol dire zero incognite, e questa riga è ciò che impedisce di confonderle.
      horizonUnknown: (plan.horizonUnknown || []).length,
      horizonUnknownAll: (plan.horizonUnknownAll || []).length,
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
  // 4. ── L'OFFSET DI RIFERIMENTO NON È PIÙ IL CENTESIMO UNIFORME (5 agosto 2026) ──────────────────
  //    Prima questa asserzione fissava la «backtest-equal baseline»: 1¢ convertito nei tick del
  //    mercato, cioè 10 tick su tick 0,001. Quella equivalenza è stata abbandonata DELIBERATAMENTE —
  //    il knapsack valuta ogni mercato a UN tick suo, che è dove il motore si mette davvero. Chi trova
  //    numeri diversi da quelli del backtest non ha davanti una regressione: vedi l'intestazione.
  const defTicks = (offsetTicks) => Math.max(1, Math.round(offsetTicks));
  ok('defaultOffsetTicks: 1 tick su OGNI mercato, qualunque sia il tick', defTicks(1) === 1);
  //    E un tick è una distanza in centesimi DIVERSA secondo il mercato: è tutta qui la differenza.
  ok('1 tick = 1¢ su tick 0,01 ma 0,1¢ su tick 0,001 — la vecchia regola dava 10 tick sul secondo',
    near(1 * 0.01 * 100, 1) && near(1 * 0.001 * 100, 0.1) && Math.round(1 / (0.001 * 100)) === 10);
  //    La conversione in centesimi resta disponibile per chi rimette `offsetTicks: null`.
  const defTicksDaCent = (tick) => Math.max(1, Math.round(1 / (tick * 100)));
  ok('con offsetTicks null si torna ai centesimi uniformi: 0.01→1, 0.001→10',
    defTicksDaCent(0.01) === 1 && defTicksDaCent(0.001) === 10);
  // 4b. il costo della coppia segue l'offset REALE del mercato, non un 1¢ globale
  const pc = (d) => +(1 - 2 * d).toFixed(6);
  ok('pairCost: 0,98 su tick 0,01 (d=1¢) e 0,998 su tick 0,001 (d=0,1¢)',
    near(pc(1 * 0.01), 0.98) && near(pc(1 * 0.001), 0.998));
  ok('  e il capitale copre esattamente le due gambe a qualunque mid (share × (1−2d) = capitale)', (() => {
    for (const [tick, mid] of [[0.01, 0.055], [0.01, 0.5], [0.001, 0.2], [0.001, 0.93]]) {
      const d = 1 * tick, cap = 180, sh = cap / pc(d);
      if (!near(sh * ((mid - d) + ((1 - mid) - d)), cap)) return false;
    }
    return true;
  })());
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

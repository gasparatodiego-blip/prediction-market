'use strict';
// scripts/rewards-replay/lib/allocate.js — TOTAL-CAPITAL constraint allocated ACROSS markets.
//
// The base replay (run.js / net.js) scores EACH market independently at a fixed $size/side and then
// annualises against a capital denominator of (markets × 2 × size) — i.e. it silently assumes the operator
// can fund every market at once. With 125 markets at $1000/side that denominator is $250,000; the operator
// actually holds ~$52 in the proxy and the budget under discussion is $5,000. This module answers the real
// question: with ONE shared budget B that must be split across markets (capital resting in market A is not
// available in market B), how much net can it earn, and where should it go.
//
// NO PARALLEL MATH: the per-market gross/cost/net is produced by calling the shipped computeNet() on a
// one-market map, over fills produced by the shipped reconstructTapeFillsForMarket(). This module adds only
// (a) evaluating that same math across a grid of per-side sizes, and (b) a multiple-choice knapsack that
// picks one size per market under the shared budget. Because the reward share s/(s+cQ) is CONCAVE in size,
// the result is NOT the big-denominator result scaled down — that is the whole point, and it is proven
// numerically by the driver.
//
// Capital accounting: "capital committed" in a market = 2 × perSideSize (both sides must rest to score),
// matching net.js's capitalTotal. The budget constrains Σ(2 × perSideSize) over funded markets.
//
// ── DUE MODI DI MISURARE LA DISTANZA DAL MID, E CHI USA QUALE (5 agosto 2026) ──────────────────────
// `offsetCents` valuta ogni mercato a una distanza in centesimi uguale per tutti. `offsetTicks` lo
// valuta al suo offset reale di N tick, risolto sul tick del mercato. I due coincidono su tick 0,01 e
// divergono di un fattore dieci su tick 0,001.
//
// Questo modulo NON sceglie: espone entrambi e lascia `offsetTicks` assente per difetto. Tutti i
// driver di backtest (allocate-run, sweep-run, policy-run, rewards-riskfirst, rewards-worstcase) non
// lo passano e restano numero per numero quelli di sempre. Chi lo accende e' `planAllocation` in
// lib/rewards/allocator.js — il pianificatore che alimenta il piazzamento vero — e la' la scelta e'
// dichiarata per esteso, con la data e il motivo.
//
// ── E UNA TERZA COSA: QUANTO IL VENUE PAGA QUELLA DISTANZA (8 agosto 2026) ─────────────────────────
// `offsetTicks` corregge DOVE si sta; non correggeva QUANTO VALE starci. Il lordo dell'obiettivo e' il
// ceiling a S=1 — un ordine appoggiato sul mid — e non contiene nessun termine di offset, quindi in
// selezione ogni mercato veniva pesato uguale: l'equivalente esatto di una distanza fissa per tutti.
// `usePlacementScore` fa sentire all'obiettivo il quadratico pubblicato alla distanza REALE del
// mercato. Assente per difetto, come gli altri due: i driver di backtest non lo passano.
// Vedi `placementWeightForMarket` per la misura e per l'unico caso in cui non e' applicabile.
//
// ── E UNA QUARTA: QUANTA DI QUELLA QUOTA E' CREDIBILE (8 agosto 2026, sera) ────────────────────────
// `share = size/(size + cQ)` tende a 1 quando la concorrenza in banda tende a 0, e il knapsack
// MASSIMIZZA: un book vuoto gli sembrava l'occasione migliore che esista. La stima realistica lo
// tagliava gia' a `maxCredibleShare` (correzione «thin-book»), ma solo DOPO che la scelta era fatta —
// misurato sul piano vero: obiettivo +1,2%/g contro stima realistica −1,6%/g sullo stesso capitale.
// `useCredibleShareCap` porta quel tetto DENTRO l'obiettivo, per LIVELLO della curva: aggiungere
// capitale a un mercato sottile smette di aiutare oltre il tetto, ed e' la concavita' che la selezione
// doveva sentire. Stessa funzione e stessa costante della stima realistica — importate, non riscritte.
//
// LE QUATTRO NON SI SOVRAPPONGONO, e vale la pena dirlo una volta sola: `offsetCents`/`offsetTicks`
// decidono DOVE si sta, `usePlacementScore` quanto vale starci (agisce sul NUMERATORE della quota),
// `useCredibleShareCap` quanto di quella quota e' credibile (agisce sul suo VALORE MASSIMO).

const { reconstructTapeFillsForMarket } = require('./tape');
const { markoutAll } = require('./markout');
const { computeNet } = require('./net');
const { closeNowPolicy } = require('./close-now');
// IL QUADRATICO DEL VENUE, IMPORTATO E NON RISCRITTO. `placementScore` è la stessa funzione che pesa
// l'offset in lib/rewards/realistic-estimate.js e che computedDefaultOffset usa per scegliere il tick:
// due implementazioni della stessa formula sono due opinioni su quanto vale una posizione, e possono
// divergere senza che nessuno se ne accorga. Il modulo è puro (nessun I/O, nessun orologio), quindi
// importarlo da qui non porta dentro niente che un backtest non possa eseguire.
const {
  placementScore,
  // Le DUE correzioni di quota, riusate e non riscritte. Vivono in realistic-estimate.js perche' e' li'
  // che sono nate e li' che la stima realistica continua a chiamarle: una fonte sola, altrimenti
  // l'obiettivo e la stima finale possono divergere senza che nessuno se ne accorga — che e' esattamente
  // il difetto chiuso l'8 agosto 2026.
  placementShareFactor, credibleShareFactor, DEFAULTS: RE_DEFAULTS,
} = require('../../../lib/rewards/realistic-estimate');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Net for ONE market at ONE per-side size, reusing the shipped gross+cost+net math verbatim. Now that
 * computeNet uses each market's OWN observed window, the allocation objective is the observed-window NET
 * PER DAY (netPerDay5m) — the honest go-forward rate — not a window total scaled to a global window.
 * `excluded` is true when the market has no pot or no scoreable depth (computeNet dropped it).
 * The `windowHours` param is accepted for call-site compatibility but ignored (computeNet uses the span).
 */
function perMarketNetAtSize(marketId, marketRows, tokenTrades, potByCond, cfg) {
  // `offsetTicks` — la distanza dal mid in TICK DI QUESTO MERCATO invece che in centesimi uguali per
  // tutti. Assente ⇒ si usa `offsetCents` e i fill sono quelli di sempre. Vedi tape.reconstructTapeFillsForMarket.
  // `punteggioPosizione` — il peso S del venue per la posizione REALE di questo mercato (vedi
  // `placementWeightForMarket`). null ⇒ nessun peso, e il netto oggettivo resta quello di sempre.
  const {
    offsetCents, offsetTicks = null, sizeUsd, maxInventoryUsd, policy, minSizeByMarket = null, pairCostUsd = null,
    punteggioPosizione = null,
    // `maxCredibleShare` — il tetto di credibilita' della quota, LO STESSO NOME e lo stesso numero della
    // correzione «thin-book» in lib/rewards/realistic-estimate.js. null ⇒ nessun tetto, e l'obiettivo
    // resta quello di prima.
    maxCredibleShare = null,
  } = cfg; // policy: 'hold' (default) | 'close-now'
  const fillsRes = reconstructTapeFillsForMarket(marketRows, tokenTrades, { offsetCents, offsetTicks, sizeUsd, maxInventoryUsd });
  const one = new Map([[marketId, marketRows]]);
  const MO = markoutAll(fillsRes.fills, one);
  // minSizeByMarket travels down to computeNet so the venue's min_incentive_size applies at EVERY size on
  // the grid: below the minimum a level scores 0, so the knapsack stops "buying" a market with capital the
  // venue would not score at all.
  const net = computeNet(one, MO, potByCond, { sizeUsd, wsOnly: false, minSizeByMarket, pairCostUsd }); // gross + HOLD cost, observed-window
  const row = net.rows[0] || null;
  if (!row) {
    return { marketId, sizeUsd, capital: 2 * sizeUsd, excluded: true, spanHours: null, grossPerDay: null, grossWindow: null, cost5m: null, costPerDay5m: null, netWindow5m: null, netPerDay5m: null, fills: fillsRes.fills.length, share: null, closed: null, stuck: null, nakedRefused: null };
  }
  // HOLD figures come straight from computeNet (+5m markout, floored, observed-window).
  let cost5m = row.costWindow['5m'], costPerDay5m = row.costPerDay['5m'], netWindow5m = row.netWindow['5m'], netPerDay5m = row.netPerDay['5m'];
  let closed = null, stuck = null, nakedRefused = null, noBook = null;
  if (policy === 'close-now') {
    // CLOSE-NOW: cost is the REALISED spread paid crossing the real book at each fill instant (buy fills; sell
    // fills are naked-refused). Certain and ≥0, so net ≤ gross by construction. Amortised over the span.
    const cn = closeNowPolicy(fillsRes.fills, one);
    // Floor the realised spread at ≥0: a fill whose nearest exit-book sample sits above entry books a
    // spurious windfall (sample is up to 40s off the fill instant); a favorable exit is not reward income,
    // so it is not booked — net ≤ gross holds for CLOSE-NOW too (same rule Phase 1 applied to HOLD markout).
    const spread = Math.max(0, cn.aggregate.spreadPaid);
    const spanDays = row.spanHours / 24;
    cost5m = spread;
    costPerDay5m = spanDays > 0 ? spread / spanDays : null;
    netWindow5m = row.grossWindow - spread;
    netPerDay5m = costPerDay5m == null ? null : row.grossPerDay - costPerDay5m;
    closed = cn.aggregate.closed; stuck = cn.aggregate.stuck; nakedRefused = cn.aggregate.nakedRefused; noBook = cn.aggregate.noBook;
  }
  // ── IL LORDO PESATO DALLA POSIZIONE REALE ────────────────────────────────────────────────────────
  // `grossPerDay` è il ceiling a S=1: quanto renderebbe un ordine appoggiato ESATTAMENTE sul mid. Non
  // dipende dall'offset, quindi da solo non distingue un mercato a tick 0,01 (dove un tick vale 1¢ e
  // vale S≈0,31 di una banda da 4,5¢) da uno a tick 0,001 (dove lo stesso tick vale 0,1¢ e S≈0,91).
  // `grossScoredPerDay` è lo stesso lordo visto da dove il motore si mette DAVVERO. Resta ACCANTO al
  // ceiling, mai al posto suo: il ceiling continua ad alimentare la scelta dell'offset e la stima
  // realistica, che lo pesano già per conto loro e lo peserebbero due volte.
  //
  // ── E IL TETTO DI CREDIBILITÀ, DENTRO L'OBIETTIVO E NON DOPO (8 agosto 2026) ─────────────────────
  // `share → 1` quando la concorrenza in banda → 0. Il knapsack MASSIMIZZA, quindi un book vuoto gli
  // sembrava l'occasione migliore che ci sia: «il 100% del montepremi». La stima realistica lo tagliava
  // a `maxCredibleShare`, ma DOPO che la scelta era già stata fatta — misurato il piano vero, obiettivo
  // +1,2%/g e stima realistica −1,6%/g sullo stesso capitale. Adesso il taglio si applica PER LIVELLO
  // della curva: aggiungere capitale a un mercato sottile smette di aiutare oltre il tetto, ed è
  // esattamente la concavità che la selezione doveva sentire.
  //
  // LE DUE CORREZIONI NON SI SOVRAPPONGONO, e la ragione è algebrica: la posizione agisce sul NUMERATORE
  // della quota (S·size invece di size), il tetto sul suo VALORE massimo. Sono la stessa composizione,
  // nello stesso ordine, che `realisticEstimate` applica da sempre — riusata, non ricostruita.
  const S = fin(punteggioPosizione) && punteggioPosizione >= 0 ? punteggioPosizione : null;
  const qShare = row.sizePerSideShares, qComp = row.limDepthShares;
  // ATTENZIONE: il fattore di posizione NON è `S`. Vedi `placementShareFactor`: moltiplicare per S
  // darebbe `pot·shareCeiling·S`, mentre la quota vera è `pot·S·size/(S·size+cQ)`, sempre più grande.
  // Fino al 7 agosto qui c'era `× S`, e penalizzava di più proprio i tick grossi (S piccolo).
  const fPosizione = S != null ? placementShareFactor(qShare, qComp, S) : null;
  const tetto = fin(maxCredibleShare) && maxCredibleShare > 0
    ? credibleShareFactor(qShare, qComp, maxCredibleShare) : null;
  // Ripiego dichiarato: se la quota non è leggibile ma il punteggio sì, resta il vecchio `× S` — è
  // meno esatto, non è inventato, e viene marcato per essere visto.
  const fPosizioneUsato = fPosizione != null ? fPosizione : S;
  const posizioneEsatta = fPosizione != null;
  const fTetto = tetto ? tetto.factor : null;
  const pesato = fPosizioneUsato != null || fTetto != null;
  const grossScoredPerDay = pesato && fin(row.grossPerDay)
    ? row.grossPerDay * (fPosizioneUsato != null ? fPosizioneUsato : 1) * (fTetto != null ? fTetto : 1)
    : null;
  const netScoredPerDay = grossScoredPerDay != null && fin(costPerDay5m) ? grossScoredPerDay - costPerDay5m : null;
  return {
    marketId, sizeUsd, capital: 2 * sizeUsd, excluded: false,
    spanHours: row.spanHours, grossPerDay: row.grossPerDay, grossWindow: row.grossWindow,
    cost5m, costPerDay5m, netWindow5m, netPerDay5m,                         // ← netPerDay5m is the objective
    punteggioPosizione: S, grossScoredPerDay, netScoredPerDay,
    // I due fattori, separati e leggibili: chi guarda una riga deve poter dire QUALE delle due
    // correzioni l'ha spostata, non solo che è stata spostata.
    fattorePosizione: fPosizioneUsato, posizioneEsatta,
    fattoreCredibilita: fTetto, quotaCeiling: tetto ? tetto.shareCeiling : null, quotaCapata: tetto ? tetto.capped : false,
    fills: fillsRes.fills.length, closed, stuck, nakedRefused, noBook, share: row.share,
    minSizeShares: row.minSizeShares, sizePerSideShares: row.sizePerSideShares,
    belowVenueMinSize: row.belowVenueMinSize, capitalToQualifyUsd: row.capitalToQualifyUsd,
  };
}

/**
 * Net curve for one market across a per-side size grid. Always includes the zero level (do not fund →
 * capital 0, net 0). The knapsack maximises `net5m`, which HERE carries the observed-window NET PER DAY
 * ($/day) — the go-forward rate. A level whose net-per-day is UNKNOWN (fills but no +5m sample → null) is
 * dropped, never defaulted to 0, so an unfundable-on-unknown-cost size is never chosen.
 * @returns { marketId, excluded, levels:[{ sizeUsd, capital, units, grossPerDay, cost5m, costPerDay5m,
 *            netWindow5m, netPerDay5m, net5m, fills, share, spanHours }] }
 */
function perMarketNetCurve(marketId, marketRows, tokenTrades, potByCond, opts) {
  const { offsetCents, offsetTicks = null, maxInventoryUsd, sizeGrid, unitUsd, policy, minSizeByMarket = null, pairCostUsd = null, punteggioPosizione = null, maxCredibleShare = null } = opts;
  const levels = [{ sizeUsd: 0, capital: 0, units: 0, grossPerDay: 0, cost5m: 0, costPerDay5m: 0, netWindow5m: 0, netPerDay5m: 0, net5m: 0, fills: 0, closed: 0, stuck: 0, nakedRefused: 0, share: 0, spanHours: null, punteggioPosizione: null, grossScoredPerDay: 0, netScoredPerDay: 0, fattorePosizione: null, posizioneEsatta: false, fattoreCredibilita: null, quotaCeiling: null, quotaCapata: false }];
  let excluded = false;
  for (const s of sizeGrid) {
    const r = perMarketNetAtSize(marketId, marketRows, tokenTrades, potByCond, { offsetCents, offsetTicks, sizeUsd: s, maxInventoryUsd, policy, minSizeByMarket, pairCostUsd, punteggioPosizione, maxCredibleShare });
    if (r.excluded) { excluded = true; continue; }         // pot/depth missing → unfundable; keep only zero level
    if (r.netPerDay5m == null) continue;                   // cost UNKNOWN at this size → skip (never default to 0)
    levels.push({
      sizeUsd: s, capital: r.capital, units: Math.round(r.capital / unitUsd), spanHours: r.spanHours,
      grossPerDay: r.grossPerDay, cost5m: r.cost5m, costPerDay5m: r.costPerDay5m,
      punteggioPosizione: r.punteggioPosizione, grossScoredPerDay: r.grossScoredPerDay, netScoredPerDay: r.netScoredPerDay,
      // Il tetto di credibilita' morde PER LIVELLO, non per mercato: e' cio' che rende l'obiettivo
      // concavo dove il book e' sottile, invece di premiare il capitale in piu' come se il book reggesse.
      fattorePosizione: r.fattorePosizione, posizioneEsatta: r.posizioneEsatta,
      fattoreCredibilita: r.fattoreCredibilita, quotaCeiling: r.quotaCeiling, quotaCapata: r.quotaCapata,
      // L'OBIETTIVO DEL KNAPSACK. Col punteggio di posizione è il netto visto da dove il motore si
      // mette davvero; senza, è esattamente `netPerDay5m` come è sempre stato. `netPerDay5m` non viene
      // toccato in nessuno dei due casi: chi legge il netto misurato continua a leggere quello.
      netWindow5m: r.netWindow5m, netPerDay5m: r.netPerDay5m,
      net5m: r.netScoredPerDay != null ? r.netScoredPerDay : r.netPerDay5m, // net5m := objective (net/day)
      fills: r.fills, closed: r.closed, stuck: r.stuck, nakedRefused: r.nakedRefused, noBook: r.noBook, share: r.share,
      minSizeShares: r.minSizeShares, sizePerSideShares: r.sizePerSideShares,
      belowVenueMinSize: r.belowVenueMinSize, capitalToQualifyUsd: r.capitalToQualifyUsd,
      // Il costo della coppia con cui QUESTO livello e' stato classificato. Viaggia sul livello, non a
      // fianco, perche' con l'offset per mercato non e' piu' una costante del piano: chi legge la riga
      // scelta deve poter ricostruire le share con lo stesso numero che ha deciso il punteggio.
      pairCostUsd: pairCostUsd,
    });
  }
  return { marketId, excluded, levels };
}

/**
 * MULTIPLE-CHOICE KNAPSACK — pick exactly one level per market to maximise Σ net5m under a shared budget.
 * Pure and deterministic. `curves` is [{ marketId, levels:[{units, net5m, ...}] }] with a units-0/net-0
 * level present. `budgetUnits` is the budget in the same integer unit as levels[].units.
 *
 * Correctness note: capital spent in one market is subtracted from the budget available to all others —
 * that is exactly what the shared dp[b] table enforces (dp_new[b] = max_L dp_prev[b − L.units] + L.net5m).
 * dp is non-decreasing in b, so dp[budgetUnits] is the global optimum (idle capital is always allowed).
 *
 * @returns { totalNet5m, budgetUnits, usedUnits, marketsHeld, allocation:[{ level..., marketId }] }
 */
function knapsack(curves, budgetUnits) {
  const B = Math.max(0, Math.floor(budgetUnits));
  const M = curves.length;
  let dp = new Float64Array(B + 1);          // dp[b] after processing markets so far
  const choice = Array.from({ length: M }, () => new Int32Array(B + 1)); // chosen level index per (market, budget)
  for (let m = 0; m < M; m++) {
    const levels = curves[m].levels;
    const ndp = new Float64Array(B + 1);
    for (let b = 0; b <= B; b++) {
      let best = -Infinity, bestIdx = 0;
      for (let li = 0; li < levels.length; li++) {
        const L = levels[li];
        const u = L.units | 0;
        if (u > b) continue;
        const val = dp[b - u] + (fin(L.net5m) ? L.net5m : 0);
        if (val > best) { best = val; bestIdx = li; }
      }
      ndp[b] = best === -Infinity ? dp[b] : best;
      choice[m][b] = bestIdx;
    }
    dp = ndp;
  }
  // reconstruct
  const allocation = [];
  let b = B;
  for (let m = M - 1; m >= 0; m--) {
    const li = choice[m][b];
    const L = curves[m].levels[li];
    if (L && (L.units | 0) > 0) {
      allocation.push({ marketId: curves[m].marketId, ...L });
      b -= L.units | 0;
    }
  }
  allocation.reverse();
  const usedUnits = allocation.reduce((s, a) => s + (a.units | 0), 0);
  const totalNet5m = allocation.reduce((s, a) => s + (fin(a.net5m) ? a.net5m : 0), 0);
  return { totalNet5m, budgetUnits: B, usedUnits, marketsHeld: allocation.length, allocation };
}

/** Il tick DI QUESTO MERCATO, dalla prima riga che ne dichiara uno. null se nessuna lo dichiara — e
 * allora l'offset in tick non e' risolvibile e si ricade sui centesimi, mai su un tick inventato. */
function marketTick(marketRows) {
  for (const r of marketRows) if (fin(r.tick) && r.tick > 0) return r.tick;
  return null;
}

/**
 * ── IL COSTO DI UNA COPPIA DI SHARE, PER QUESTO MERCATO ────────────────────────────────────────────
 *
 * Quotare due lati partendo da collaterale e' comprare YES a (mid − d) e NO a ((1 − mid) − d). La
 * coppia costa:
 *
 *     (mid − d) + (1 − mid − d)  =  1 − 2d
 *
 * Il `mid` si cancella: il costo della coppia non dipende dal prezzo del mercato, solo da `d`.
 *
 * PERCHE' LA FORMULA RESTA VALIDA CON UN OFFSET VARIABILE. La derivazione qui sopra non ha mai usato
 * il fatto che `d` fosse lo stesso su tutti i mercati — e' un'identita' contabile INTERNA a un
 * mercato, fra le due gambe di quel mercato. `1 − 2d` era uno scalare di piano solo perche' lo era
 * `d`, non perche' ci fosse qualcosa di globale nell'economia della coppia. Rendendo `d` per mercato,
 * la stessa identita' si valuta al `d` di ciascuno: la formula non cambia, cambia dove la si applica.
 * Il capitale di una riga continua a coprire esattamente le sue due gambe (share × p_yes + share ×
 * p_no = share × (1 − 2d) = capitale), che e' l'invariante su cui poggia il tetto per mercato.
 *
 * `d` in dollari: `offsetTicks × tick` in modo tick, `offsetCents / 100` altrimenti. Tick ignoto ⇒ si
 * ricade sui centesimi: un tick non si inventa, e il numero deve restare quello con cui i fill di
 * QUESTO mercato sono stati ricostruiti.
 */
/**
 * ── IL PESO DELLA POSIZIONE REALE DI QUESTO MERCATO ────────────────────────────────────────────────
 *
 * Il difetto che chiude (misurato l'8 agosto 2026). L'obiettivo del knapsack è il netto per giorno, e
 * il suo LORDO è il ceiling a S=1 di `computeNet`: quanto renderebbe un ordine appoggiato esattamente
 * sul mid. Quel numero non contiene nessun termine di offset, quindi in fase di SELEZIONE tutti i
 * mercati venivano giudicati come se stessero alla stessa distanza dal mid — l'equivalente esatto di
 * un centesimo fisso uguale per tutti. Il motore invece si mette sempre a UN TICK dal concorrente, e
 * un tick è una distanza diversa secondo il mercato:
 *
 *     tick 0,01  → 1,0¢ dal mid → su banda 4,5¢  S = ((2,25−1,0)/2,25)² = 0,309
 *     tick 0,001 → 0,1¢ dal mid → su banda 4,5¢  S = ((2,25−0,1)/2,25)² = 0,913
 *
 * cioè 2,96 volte tanto. Misurato sull'universo dell'8 agosto 2026: 48 mercati su 113 hanno tick
 * 0,001, e la selezione li valutava come i 65 a tick grosso. Non è una differenza cosmetica: il
 * knapsack MASSIMIZZA, quindi un mercato a tick fine che rende tre volte quello che gli si attribuiva
 * perdeva il posto contro uno a tick grosso che rendeva quello che sembrava.
 *
 * Il tick è LO STESSO che risolve l'offset e il costo della coppia (`marketTick`), che è lo stesso che
 * il motore usa quando piazza: una fonte sola, mai una seconda lettura.
 *
 * FALLISCE VERSO IL NEUTRO, E LO DICE. Banda o tick illeggibili ⇒ `null`: quel mercato resta pesato
 * come prima (S implicito 1) e finisce nell'elenco dei non pesati. È l'unica asimmetria di questa
 * modifica — un mercato senza banda leggibile viene giudicato più generosamente di uno con la banda
 * nota — e resta dichiarata invece che nascosta. Sull'universo reale dell'8 agosto 2026 quell'elenco
 * era vuoto: tutti i 115 mercati con montepremi pubblicano `rewardsMaxSpread`.
 *
 * @returns {{S:number, tick:number|null, offsetCents:number, maxSpreadCents:number}|null}
 */
function placementWeightForMarket(marketRows, { offsetCents, offsetTicks, maxSpreadCents }) {
  if (!fin(maxSpreadCents) || !(maxSpreadCents > 0)) return null;
  const tick = fin(offsetTicks) && offsetTicks > 0 ? marketTick(marketRows) : null;
  // In modo tick la distanza è `offsetTicks × tick` convertita in centesimi; senza tick leggibile non
  // si inventa un tick — si ricade sui centesimi, esattamente come fa il costo della coppia.
  const offC = tick != null ? offsetTicks * tick * 100 : offsetCents;
  const S = placementScore(offC, maxSpreadCents);
  if (S == null) return null;
  return { S, tick, offsetCents: +offC.toFixed(6), maxSpreadCents };
}

function pairCostForMarket(marketRows, { offsetCents, offsetTicks, usePairCost, pairCostUsd }) {
  if (!usePairCost) return pairCostUsd;      // niente costo della coppia ⇒ l'aritmetica storica, invariata
  const tick = fin(offsetTicks) && offsetTicks > 0 ? marketTick(marketRows) : null;
  const d = tick != null ? offsetTicks * tick : offsetCents / 100;
  if (!fin(d) || d < 0 || d >= 0.5) return pairCostUsd;   // un offset che azzera o inverte la coppia non e' un offset
  return +(1 - 2 * d).toFixed(6);
}

/**
 * End-to-end: build curves for every market, then knapsack under a dollar budget. `unitUsd` is the capital
 * granularity (dollars of both-sides capital per knapsack unit); the per-side size step is unitUsd/2.
 *
 * `offsetTicks` (opzionale) valuta OGNI mercato al suo offset reale di N tick invece che a una
 * distanza in centesimi uguale per tutti; `usePairCost` deriva il costo della coppia dallo stesso
 * offset, per mercato. Assenti entrambi — che e' il caso di ogni driver di backtest — questa
 * funzione produce numero per numero quelli di prima.
 * @returns { budgetUsd, unitUsd, ...knapsack result, grossWindow, cost5mWindow }
 */
function allocateBudget(byMarket, marketTokens, tapeByToken, potByCond, opts) {
  const {
    offsetCents, offsetTicks = null, maxInventoryUsd, budgetUsd, unitUsd, maxPerMarketUsd, policy,
    minSizeByMarket = null, pairCostUsd = null, usePairCost = false, usePlacementScore = false, maxSpreadByMarket = null,
    // ── IL TETTO DI CREDIBILITA' NELL'OBIETTIVO — SPENTO PER DIFETTO, come gli altri tre ────────────
    // Acceso da `planAllocation` e da nessun driver di backtest. `maxCredibleShare` prende per difetto
    // LA STESSA costante della correzione «thin-book» (realistic-estimate DEFAULTS): un secondo numero
    // per la stessa soglia significherebbe che l'obiettivo e la stima finale giudicano diversamente.
    useCredibleShareCap = false, maxCredibleShare = RE_DEFAULTS.maxCredibleShare,
  } = opts;
  const inTick = fin(offsetTicks) && offsetTicks > 0;
  // Mercati per cui il peso non è stato applicabile (banda o punteggio illeggibili). Elencati, non
  // silenziosamente assenti: sono gli unici che restano giudicati al ceiling mentre gli altri no.
  const pesoNonApplicato = [];
  const perSideStep = unitUsd / 2;
  const capPerMarket = Math.min(maxPerMarketUsd || budgetUsd, budgetUsd); // a single market may take up to the whole budget
  const maxLevels = Math.max(1, Math.floor(capPerMarket / unitUsd));
  const sizeGrid = [];
  for (let k = 1; k <= maxLevels; k++) sizeGrid.push(k * perSideStep);
  const curves = [];
  for (const [marketId, rows] of byMarket.entries()) {
    const tokenId = marketTokens.get(marketId);
    const trades = (tokenId && tapeByToken.get(tokenId)) || [];
    // ── L'UNICO PUNTO IN CUI «L'OFFSET DI QUESTO MERCATO» ESISTE ─────────────────────────────────
    // Qui si sa insieme il mercato e il suo tick, quindi qui — e solo qui — la distanza dal mid
    // diventa un numero. Il costo della coppia si deriva NELLA STESSA RIGA, perche' e' la stessa
    // distanza vista da un'altra angolazione: se i due venissero da posti diversi potrebbero
    // scollarsi, ed e' esattamente lo scollamento che questa modifica esiste per chiudere.
    const pc = pairCostForMarket(rows, { offsetCents, offsetTicks: inTick ? offsetTicks : null, usePairCost, pairCostUsd });
    // Il peso della posizione nasce nella STESSA riga, e per la stessa ragione: è la stessa distanza
    // dal mid vista da una terza angolazione (quanto la paga il venue). Se venisse da un altro posto
    // potrebbe scollarsi dall'offset con cui i fill sono stati ricostruiti.
    const pw = usePlacementScore
      ? placementWeightForMarket(rows, {
        offsetCents, offsetTicks: inTick ? offsetTicks : null,
        maxSpreadCents: maxSpreadByMarket ? (maxSpreadByMarket.get(marketId) ?? null) : null,
      })
      : null;
    if (usePlacementScore && pw == null) pesoNonApplicato.push(marketId);
    const c = perMarketNetCurve(marketId, rows, trades, potByCond, { offsetCents, offsetTicks, maxInventoryUsd, sizeGrid, unitUsd, policy, minSizeByMarket, pairCostUsd: pc, punteggioPosizione: pw ? pw.S : null, maxCredibleShare: useCredibleShareCap ? maxCredibleShare : null });
    c.punteggioPosizione = pw ? pw.S : null;
    c.punteggioOffsetCents = pw ? pw.offsetCents : null;
    c.punteggioTick = pw ? pw.tick : null;
    curves.push(c);
  }
  const budgetUnits = Math.floor(budgetUsd / unitUsd);
  const res = knapsack(curves, budgetUnits); // res.totalNet5m carries Σ net/day (the objective)
  // attach per-day gross/cost aggregates over the chosen allocation (for reporting)
  let grossPerDay = 0, costPerDay5m = 0;
  for (const a of res.allocation) { grossPerDay += fin(a.grossPerDay) ? a.grossPerDay : 0; costPerDay5m += fin(a.costPerDay5m) ? a.costPerDay5m : 0; }
  // Markets the venue minimum priced out of THIS budget: every funded level scored zero because the size
  // the budget can buy is under min_incentive_size. Reported rather than silently absent — the operator's
  // question is "why is that market not here", and the answer is a dollar figure.
  const belowMinSize = [];
  for (const c of curves) {
    const funded = c.levels.filter((l) => l.units > 0);
    if (!funded.length || !funded.every((l) => l.belowVenueMinSize)) continue;
    const need = funded.map((l) => l.capitalToQualifyUsd).filter((x) => fin(x));
    belowMinSize.push({ marketId: c.marketId, minSizeShares: funded[0].minSizeShares, capitalToQualifyUsd: need.length ? Math.min.apply(null, need) : null });
  }
  return { budgetUsd, unitUsd, curves, grossPerDay, costPerDay5m, belowMinSize, usePlacementScore, pesoNonApplicato, useCredibleShareCap, maxCredibleShare: useCredibleShareCap ? maxCredibleShare : null, ...res };
}

module.exports = { perMarketNetAtSize, perMarketNetCurve, knapsack, allocateBudget, marketTick, pairCostForMarket, placementWeightForMarket };

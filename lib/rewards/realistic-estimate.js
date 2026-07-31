'use strict';
// lib/rewards/realistic-estimate.js — the SECOND $/day figure: what the gross estimate looks like once the
// things it silently assumes are priced in.
//
// ─── WHAT THE EXISTING GROSS FIGURE ACTUALLY IS ──────────────────────────────────────────────────────
// The allocator's `grossInBandPerDay` comes out of scripts/rewards-replay/lib/net.js:
//
//     sizePerSide (shares) = (capital / 2) / price          price = clamp(adjusted mid, 0.01, 0.99)
//     share                = size / (size + competitorQ)     competitorQ = median in-band Qmin (shares)
//     grossPerDay          = pot × share                     pot = published rewardsDailyRate ($/day)
//
// Worked, on the real allocation at $100 of capital (2026-07-31):
//   Michigan / Perry Johnson — capital $72, mid 0.065, competitorQ 4316 shares, pot $400/day
//     size  = 36 / 0.065 = 553.8 shares
//     share = 553.8 / (553.8 + 4316) = 0.1137
//     gross = 400 × 0.1137 = $45.49/day
//   Vermont / Republicans — capital $2, mid 0.855, competitorQ 0 shares, pot $67/day
//     size  = 1 / 0.855 = 1.17 shares
//     share = 1.17 / (1.17 + 0) = 1.0000        ← 100% of the pot for one dollar
//     gross = 67 × 1.0 = $67.00/day
// Totalling $129.61/day on $100 of capital: a 47,000% annualised run rate. Arithmetically faithful to the
// published formula and operationally nonsense — which is the point of this module.
//
// ─── WHAT THAT FORMULA INCLUDES, AND WHAT IT DOES NOT ────────────────────────────────────────────────
//   INCLUDED
//     • the real published pot for the market (never a default);
//     • the competitors ALREADY resting in band — competitorQ is genuinely in the denominator, so the
//       "how much liquidity is already there" question is not ignored, it is just not INTERPRETED;
//     • a depth cap on the assumed capital (in lib/reward-operator-estimate.js, on the board's own figure).
//   NOT INCLUDED — every one of these makes the number too high, never too low:
//     (a) THE POOL'S RECENT TREND. `pot` is the instantaneous published rate. A pot cut yesterday is still
//         quoted at its old value as a per-DAY figure.
//     (b) THE PLACEMENT SCORE. The replay prices the S=1 CEILING — an order resting exactly AT the mid.
//         The published quadratic is S(v,s) = ((v−s)/v)², so a real order one tick off a 4.5¢ band scores
//         S = ((2.25−1)/2.25)² = 0.309. The ceiling overstates a realistic placement by ~3×, and it does
//         so ASYMMETRICALLY: our size is counted at S=1 while competitorQ is already S-weighted.
//     (c) ADVERSE SELECTION. Gross is gross. The replay measures markout separately, but ONLY where the
//         tape actually produced fills — three of the four allocated markets had zero observed fills, so
//         their net is `null` and the operator is left reading the gross.
//     (d) SNAPSHOT CAPTURE. Rewards are scored from a random sample once per minute (1,440/day — see
//         SAMPLES_PER_DAY). The formula assumes the order is resting in every one of them; every cancel,
//         replace, refresh or outage is a sample that scored zero.
//     (e) TIME ACTUALLY SPENT IN BAND. The formula assumes the quote is in band all day. In a market whose
//         mid moves, the order leaves the band and must be re-priced — and each re-price is an out-of-book
//         window plus, briefly, no score at all.
//   And one that is not on that list but dominates the worst rows:
//     (f) A SHARE THAT DESCRIBES A BOOK THAT DOES NOT EXIST. share → 1 as competitorQ → 0. "You would own
//         100% of the pot" in an empty book is not an opportunity; it is the market telling you why nobody
//         else is quoting it.
//
// ─── WHAT THIS MODULE DOES ───────────────────────────────────────────────────────────────────────────
// It NEVER replaces the gross figure — the caller shows both, side by side. It returns the gross multiplied
// by a list of NAMED, INDIVIDUALLY REPORTED corrections, each of which can answer "not measurable" and then
// apply exactly 1.0 while SAYING SO. There is no hidden fudge factor: every correction carries its factor,
// its inputs and a plain-language note, and the UI prints them.
//
// Two of the corrections are DERIVED (real algebra on the published formula or on measured data) and two are
// ASSUMPTIONS with a configurable constant. They are labelled as such in `kind`, because an operator deciding
// how much to trust a number needs to know which parts are arithmetic and which are a guess.
//
// Pure: no I/O, no clock, browser-safe. The server computes it once per row and the client renders it.

const SAMPLES_PER_DAY = 1440;   // Polymarket scores maker liquidity from ONE random sample per minute.

const DEFAULTS = Object.freeze({
  // (c) The adverse-selection haircut applied when the replay measured NO fills for this market, so there is
  // no observed markout to use instead. A DECLARED GUESS, not a measurement: a resting two-sided quote is
  // filled preferentially when the mid is about to move against it, and 25% of gross is a middle-of-the-road
  // figure for that drag. It is labelled 'assunzione' everywhere it appears and is configurable.
  adverseSelectionPct: 25,
  // (f) The largest modelled pool share this module is willing to treat as real. Above it, the estimate has
  // stopped describing a market you would compete in and started describing an empty book. 0.60 is where
  // "you are the dominant maker" turns into "you ARE the book".
  maxCredibleShare: 0.60,
  // (d)+(e) Seconds with no resting order per cancel→replace round trip. The panel's own replace path is
  // documented as a real out-of-book window between the cancel and the post; ~3s is a conservative reading
  // of a two-call server-side sequence against the CLOB.
  outOfBookSecondsPerReprice: 3,
  // (e) When the mid's behaviour could not be measured, assume this many band exits per day rather than
  // zero. Assuming zero would mean "your quote never needs moving", which is the optimistic error again.
  assumedBandExitsPerDay: 12,
});

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function clampPrice(p) { return Math.max(0.01, Math.min(0.99, p)); }

/**
 * The published quadratic score for an order resting `offsetCents` away from the mid inside a band of
 * half-width v = maxSpreadCents/2:  S(v,s) = ((v − s)/v)², zero outside the band.
 * This is the SAME formula lib/rewardScore.js scores books with — imported as arithmetic, not re-derived
 * as a model: there is one quadratic in this project and this is it, written in terms of cents.
 */
function placementScore(offsetCents, maxSpreadCents) {
  if (!fin(offsetCents) || !fin(maxSpreadCents) || !(maxSpreadCents > 0)) return null;
  const v = maxSpreadCents / 2;
  const s = Math.abs(offsetCents);
  if (s >= v) return 0;                 // at or beyond the band edge the order scores nothing
  const r = (v - s) / v;
  return r * r;
}

/**
 * (e) HOW OFTEN WOULD THIS QUOTE ACTUALLY LEAVE THE BAND? Measured, from the mid samples the allocator
 * already loaded for this market — not from a volatility parameter.
 *
 * The walk models what a real resting order does: it is anchored at the mid when placed, and it must be
 * re-priced the moment the mid has travelled far enough that the order falls outside the band. With the
 * order sitting `offsetCents` off the mid inside a band of half-width v, that happens when the mid moves
 * more than (v − offset) in the direction that pushes the order out — so the tolerance is (v − offset)
 * cents, and after each exit the anchor resets to the new mid.
 *
 * FAIL HONEST: fewer than 2 usable samples, or an unknown band, ⇒ measurable:false and the caller applies
 * its declared assumption instead of a measured zero.
 *
 * @param {Array<{tsMs:number, adjMid:number}>} rows  the market's mid samples, any order
 * @returns {{measurable:boolean, exitsPerDay:number|null, exits:number, spanHours:number|null, toleranceCents:number|null}}
 */
function bandExitRate(rows, maxSpreadCents, offsetCents) {
  const pts = (rows || [])
    .filter((r) => r && fin(r.tsMs) && fin(r.adjMid))
    .map((r) => ({ t: r.tsMs, m: r.adjMid }))
    .sort((a, b) => a.t - b.t);
  const v = fin(maxSpreadCents) ? maxSpreadCents / 2 : null;
  const off = fin(offsetCents) ? Math.abs(offsetCents) : 0;
  if (pts.length < 2 || v == null || !(v > 0)) {
    return { measurable: false, exitsPerDay: null, exits: 0, spanHours: null, toleranceCents: null };
  }
  // An order already at/outside the band edge has no tolerance at all — it is out the instant the mid
  // twitches. Report that honestly rather than dividing by a zero tolerance.
  const tolC = v - off;
  if (!(tolC > 0)) {
    return { measurable: false, exitsPerDay: null, exits: 0, spanHours: null, toleranceCents: +tolC.toFixed(4) };
  }
  const spanHours = (pts[pts.length - 1].t - pts[0].t) / 3_600_000;
  if (!(spanHours > 0)) return { measurable: false, exitsPerDay: null, exits: 0, spanHours: null, toleranceCents: tolC };

  let anchor = pts[0].m;
  let exits = 0;
  for (const p of pts) {
    if (Math.abs(p.m - anchor) * 100 > tolC + 1e-9) { exits++; anchor = p.m; }
  }
  return {
    measurable: true,
    exitsPerDay: +((exits / spanHours) * 24).toFixed(3),
    exits,
    spanHours: +spanHours.toFixed(2),
    toleranceCents: +tolC.toFixed(4),
  };
}

/**
 * THE SECOND FIGURE.
 *
 * @param {object} input
 *   grossPerDay        the existing gross $/day (pot × ceiling share). Required; null ⇒ unknown out.
 *   pot                published daily pool ($/day)
 *   competitorQ        in-band competitor depth, SHARES (the quadratic's denominator)
 *   mid                adjusted mid
 *   capitalUsd         the capital allocated to this market (both sides)
 *   offsetCents        the placement offset actually configured for this row
 *   maxSpreadCents     the market's reward band width
 *   measuredCostPerDay observed adverse-selection cost ($/day) where the tape produced fills, else null
 *   observedFills      how many fills the tape produced (0 ⇒ the cost above is not measured, it is absent)
 *   poolTrend          lib/rewards/pool-trend.poolTrendFor() result, or null
 *   midRows            the market's mid samples, for the band-exit measurement
 *   refreshesPerDay    scheduled proactive GTD refreshes/day for this leg (Part B), or null
 *   config             overrides for DEFAULTS
 * @returns {{realisticPerDay:number|null, grossPerDay:number|null, totalFactor:number|null,
 *            corrections:Array, flags:Array, unknown:boolean, reason:string|null, summary:string}}
 */
function realisticEstimate(input = {}) {
  const cfg = { ...DEFAULTS, ...(input.config || {}) };
  const gross = fin(input.grossPerDay) ? input.grossPerDay : null;
  const corrections = [];
  const flags = [];

  if (gross == null) {
    return { realisticPerDay: null, grossPerDay: null, totalFactor: null, corrections, flags,
      unknown: true, reason: 'la cifra lorda non è calcolabile per questo mercato — nessuna stima realistica viene inventata', summary: '' };
  }

  // ── THE DEGENERATE CASE, HANDLED BEFORE ANY CORRECTION: NOBODY ELSE IS IN THE BOOK ────────────────
  // share = size/(size + competitorQ) → 1 as competitorQ → 0, so a $2 order in an empty book is modelled
  // as taking 100% of the pot. That is not an optimistic estimate that needs shading down; it is a
  // formula being evaluated outside its domain. There is no competitor set to take a share OF, the pot may
  // not even pay out (two-sided Qmin and min_incentive_size still have to be met by somebody), and the
  // reason the book is empty is usually that the market is untradeable or about to resolve.
  //
  // So this WITHHOLDS rather than shades: the realistic figure is null and the row says why. That is the
  // same rule the rest of this project already follows — an unscoreable book gets "—", never a number.
  // The GROSS figure is untouched and still displayed beside it, exactly as before.
  const cQ0 = fin(input.competitorQ) ? input.competitorQ : null;
  if (gross > 0 && cQ0 != null && cQ0 <= 0) {
    flags.push({
      key: 'empty-book', severity: 'danger',
      text: 'nessuna liquidità concorrente misurata in banda: la formula ti attribuirebbe il 100% del montepremi, ma è una divisione per un book che non esiste',
    });
    return {
      grossPerDay: +gross.toFixed(4), realisticPerDay: null, totalFactor: null,
      corrections, flags, unknown: true, bandExit: null,
      reason: 'non stimabile: in banda non è stata misurata NESSUNA liquidità di altri maker, quindi la quota modellata è il 100% del montepremi. Non è un\'opportunità da scontare, è una formula usata fuori dal suo dominio — un book vuoto di solito significa mercato illiquido o vicino alla risoluzione. La cifra lorda resta visibile qui accanto, ma non va letta come un rendimento.',
      summary: 'non stimabile — book senza concorrenza misurata',
    };
  }

  const push = (c) => { corrections.push(c); return c.factor; };

  // ── (b) PLACEMENT SCORE — exact algebra on the published quadratic, NOT a fudge ────────────────────
  // The gross prices an order AT the mid (S=1). A real order sits offsetCents away and scores S<1. Since
  // share = Qu/(Qu+Qc) with Qu = S·size, the corrected share is exact, and the factor is the ratio of the
  // two shares. This is the single largest correction on most rows and it is pure arithmetic.
  let f = 1;
  const S = placementScore(input.offsetCents, input.maxSpreadCents);
  const price = fin(input.mid) ? clampPrice(input.mid) : null;
  const sizeShares = (fin(input.capitalUsd) && price) ? (input.capitalUsd / 2) / price : null;
  const cQ = fin(input.competitorQ) && input.competitorQ >= 0 ? input.competitorQ : null;
  if (S != null && sizeShares != null && cQ != null) {
    const shareCeiling = sizeShares / (sizeShares + cQ);
    const qu = S * sizeShares;
    const shareReal = (qu + cQ) > 0 ? qu / (qu + cQ) : 0;
    const factor = shareCeiling > 0 ? shareReal / shareCeiling : 1;
    f *= push({
      key: 'placement-score', kind: 'derivata',
      label: 'punteggio reale della posizione invece del massimo teorico',
      factor: +factor.toFixed(4), applied: true, measurable: true,
      note: `la cifra lorda prezza un ordine appoggiato ESATTAMENTE sul mid (punteggio 1, il massimo). A ${Math.abs(input.offsetCents).toFixed(2)}¢ dal mid, con una banda di ±${(input.maxSpreadCents / 2).toFixed(2)}¢, la formula pubblicata S=((v−s)/v)² dà ${S.toFixed(3)} — cioè ${(S * 100).toFixed(0)}% del punteggio massimo per share. Quota corretta ${(shareReal * 100).toFixed(2)}% invece di ${(shareCeiling * 100).toFixed(2)}%.`,
    });
  } else {
    push({ key: 'placement-score', kind: 'derivata', label: 'punteggio reale della posizione', factor: 1,
      applied: false, measurable: false,
      note: 'offset, banda o profondità concorrente non leggibili — nessuna correzione di punteggio applicata (la cifra resta il massimo teorico)' });
  }

  // ── (a) POOL TREND ────────────────────────────────────────────────────────────────────────────────
  const pt = input.poolTrend || null;
  if (pt && pt.measurable) {
    f *= push({ key: 'pool-trend', kind: 'misurata', label: 'andamento recente del montepremi',
      factor: pt.discountFactor, applied: pt.discountFactor < 1, measurable: true, note: pt.note });
    if (pt.direction === 'down') flags.push({ key: 'pool-falling', severity: 'warn', text: `montepremi in calo (${Math.round((1 - pt.ratio) * 100)}% sotto la media 48h)` });
  } else {
    push({ key: 'pool-trend', kind: 'misurata', label: 'andamento recente del montepremi', factor: 1,
      applied: false, measurable: false, note: (pt && pt.note) || 'storico del montepremi non disponibile — nessuna correzione di trend applicata' });
  }

  // ── (f) THIN BOOK — a share that describes a book that does not exist ─────────────────────────────
  // Deliberately checked on the CEILING share, because that is the number the gross figure was built on.
  const shareCeilingForThin = (sizeShares != null && cQ != null && (sizeShares + cQ) > 0) ? sizeShares / (sizeShares + cQ) : null;
  if (shareCeilingForThin != null && shareCeilingForThin > cfg.maxCredibleShare) {
    const factor = cfg.maxCredibleShare / shareCeilingForThin;
    f *= push({
      key: 'thin-book', kind: 'assunzione',
      label: 'mercato sottile: la tua quota sarebbe sproporzionata',
      factor: +factor.toFixed(4), applied: true, measurable: true,
      note: `con ${cQ.toFixed(0)} share di liquidità concorrente in banda, il modello ti attribuisce il ${(shareCeilingForThin * 100).toFixed(1)}% del montepremi. Una quota così alta non è un'opportunità: è un book in cui non c'è nessun altro, e il motivo di solito è che il mercato è illiquido o sta per risolversi. La stima è tagliata a una quota massima credibile del ${(cfg.maxCredibleShare * 100).toFixed(0)}%.`,
    });
    flags.push({
      key: 'thin-book', severity: cQ === 0 ? 'danger' : 'warn',
      text: cQ === 0
        ? 'NESSUNA liquidità concorrente misurata in banda: qui saresti tu il book, e la stima lorda è priva di significato operativo'
        : `quota modellata ${(shareCeilingForThin * 100).toFixed(0)}% — mercato molto sottile`,
    });
  } else {
    push({ key: 'thin-book', kind: 'assunzione', label: 'mercato sottile', factor: 1, applied: false,
      measurable: shareCeilingForThin != null,
      note: shareCeilingForThin == null
        ? 'profondità concorrente non leggibile — nessun controllo di sottigliezza possibile'
        : `quota modellata ${(shareCeilingForThin * 100).toFixed(1)}%, sotto la soglia del ${(cfg.maxCredibleShare * 100).toFixed(0)}% — nessuna penalità` });
  }

  // ── (e)+(d) COVERAGE — samples lost to re-pricing and to proactive refreshes ───────────────────────
  // Rewards are scored from ONE random sample per minute, so a coverage gap costs whole samples, and the
  // arithmetic is honest and small: three seconds out of the book, twelve times a day, is 36s of 86,400 —
  // 0.04%. Stating that plainly is more useful than implying re-pricing is expensive when it is not.
  const exit = bandExitRate(input.midRows, input.maxSpreadCents, input.offsetCents);
  const exitsPerDay = exit.measurable ? exit.exitsPerDay : cfg.assumedBandExitsPerDay;
  const refreshes = fin(input.refreshesPerDay) && input.refreshesPerDay >= 0 ? input.refreshesPerDay : 0;
  const events = exitsPerDay + refreshes;
  const lostSeconds = events * cfg.outOfBookSecondsPerReprice;
  const lostSamples = (lostSeconds / 86_400) * SAMPLES_PER_DAY;
  const coverageFactor = Math.max(0, 1 - lostSamples / SAMPLES_PER_DAY);
  f *= push({
    key: 'coverage-gap', kind: exit.measurable ? 'misurata' : 'assunzione',
    label: 'buchi di copertura fra cancella e ripiazza',
    factor: +coverageFactor.toFixed(5), applied: coverageFactor < 1, measurable: exit.measurable,
    note: `i premi vengono campionati UNA volta al minuto (${SAMPLES_PER_DAY} campioni al giorno). `
      + (exit.measurable
        ? `Su ${exit.spanHours}h di dati reali questo mercato avrebbe fatto uscire il tuo ordine dalla banda ${exit.exits} volte (${exitsPerDay.toFixed(1)}/giorno, tolleranza ${exit.toleranceCents}¢)`
        : `Movimento del mid non misurabile su questo mercato: si assumono ${exitsPerDay}/giorno invece di zero`)
      + `${refreshes > 0 ? `, più ${refreshes.toFixed(1)} rinnovi proattivi/giorno` : ''}`
      + `. A ~${cfg.outOfBookSecondsPerReprice}s senza ordine a riposo per ciclo fanno ${Math.round(lostSeconds)}s al giorno ≈ ${lostSamples.toFixed(1)} campioni persi su ${SAMPLES_PER_DAY} (${((1 - coverageFactor) * 100).toFixed(2)}%).`,
  });
  if (exit.measurable && exitsPerDay > 48) {
    flags.push({ key: 'high-churn', severity: 'warn', text: `mid molto mobile: ~${exitsPerDay.toFixed(0)} uscite dalla banda al giorno (${(exitsPerDay / 24).toFixed(1)}/ora)` });
  }

  // ── (c) ADVERSE SELECTION — subtracted LAST, in dollars, on the already-corrected figure ──────────
  // A measured markout beats a guessed percentage every time, so where the tape produced fills we use the
  // measured number and label it 'misurata'. Where it did not, we apply the declared percentage and label
  // it 'assunzione' — and the UI prints that label. Subtraction, not multiplication: adverse selection is
  // a dollar cost of being filled, not a haircut on the reward rate.
  const beforeAdverse = gross * f;
  let adverseUsd;
  let adverseKind;
  let adverseNote;
  if (fin(input.measuredCostPerDay) && fin(input.observedFills) && input.observedFills > 0) {
    adverseUsd = Math.max(0, input.measuredCostPerDay);
    adverseKind = 'misurata';
    adverseNote = `costo di selezione avversa MISURATO sul nastro reale delle esecuzioni: $${adverseUsd.toFixed(2)}/giorno su ${input.observedFills} fill osservati (markout a 5 minuti). Questo è un dato, non una stima.`;
  } else {
    adverseUsd = beforeAdverse * (cfg.adverseSelectionPct / 100);
    adverseKind = 'assunzione';
    adverseNote = `nessun fill osservato su questo mercato nella finestra, quindi il costo di selezione avversa NON è misurato: si sottrae una stima grezza del ${cfg.adverseSelectionPct}% (configurabile). Un ordine a riposo viene eseguito preferibilmente quando il prezzo sta per muoversi contro di te; questa percentuale è un ordine di grandezza, NON un valore preciso.`;
  }
  corrections.push({
    key: 'adverse-selection', kind: adverseKind, label: 'selezione avversa',
    factor: beforeAdverse > 0 ? +(1 - adverseUsd / beforeAdverse).toFixed(4) : 1,
    usd: +adverseUsd.toFixed(2), applied: adverseUsd > 0, measurable: adverseKind === 'misurata', note: adverseNote,
  });

  const realistic = Math.max(0, beforeAdverse - adverseUsd);
  const totalFactor = gross > 0 ? realistic / gross : null;

  return {
    grossPerDay: +gross.toFixed(4),
    realisticPerDay: +realistic.toFixed(4),
    totalFactor: totalFactor == null ? null : +totalFactor.toFixed(4),
    corrections,
    flags,
    unknown: false,
    reason: null,
    bandExit: exit,
    summary: `stima realistica $${realistic.toFixed(2)}/g contro $${gross.toFixed(2)}/g lordi (${totalFactor == null ? '—' : Math.round(totalFactor * 100)}% del lordo), dopo ${corrections.filter((c) => c.applied).length} correzioni dichiarate`,
  };
}

/** Aggregate the per-row figures into the allocation total. Rows with an unknown estimate are EXCLUDED and
 *  COUNTED — a total that silently treats "unknown" as zero is the same dishonesty in a different place. */
function totalRealistic(perRow) {
  const rows = Array.isArray(perRow) ? perRow : [];
  let gross = 0, realistic = 0, known = 0, unknown = 0;
  for (const r of rows) {
    if (!r || r.unknown || !fin(r.realisticPerDay) || !fin(r.grossPerDay)) { unknown++; continue; }
    gross += r.grossPerDay; realistic += r.realisticPerDay; known++;
  }
  return {
    grossPerDay: +gross.toFixed(4),
    realisticPerDay: +realistic.toFixed(4),
    ratio: gross > 0 ? +(realistic / gross).toFixed(4) : null,
    rowsCounted: known,
    rowsUnknown: unknown,
  };
}

module.exports = {
  realisticEstimate, totalRealistic, placementScore, bandExitRate,
  DEFAULTS, SAMPLES_PER_DAY,
};

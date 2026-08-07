'use strict';
// lib/rewards/horizon.js — THE RESOLUTION-HORIZON TEST for the capital allocator.
//
// WHAT IT ANSWERS
//   "Does this market live long enough to be worth entering?" — i.e. is the time left before it resolves
//   longer than the time the maker needs to earn back what adverse selection costs him here.
//
// WHY IT EXISTS
//   Until now `endDate` travelled all the way to the client and was DISPLAYED (the "Scad. (gg)" column)
//   but never entered any score. A market resolving in two days was ranked exactly like one resolving in
//   two years: same pot, same depth, same net/day, same rank. That is wrong in one direction only — the
//   short market cannot deliver the run-rate the plan quotes, because the run-rate assumes the position
//   keeps accruing, and it stops accruing when the market resolves.
//
// THE TEST, STATED
//   paybackDays = adverse cost per day ÷ net per day
//     = "for every day of adverse selection you eat here, how many days of net accrual pay it back".
//   A market passes when it has MORE life left than that, plus a declared floor:
//     daysToResolution > paybackDays  AND  daysToResolution >= MIN_HORIZON_DAYS
//
// FOUR OUTCOMES, NOT TWO. `unknown` is a first-class answer and it never rejects:
//   ok        measured, and the horizon clears the payback
//   short     measured, and it does not — with both numbers, so the verdict is checkable
//   resolved  already past its end date (or resolving inside the floor)
//   unknown   endDate absent/unparseable, or net not measurable — ABSENCE OF EVIDENCE.
//             An unknown horizon must never be read as a short one: the market keeps its place and the
//             caller is told the test could not run. This is the same rule lib/reward-stability applies
//             to a price that never moved because nobody traded.
//
// NOTHING HERE IS IMPUTED. No default end date, no assumed cost, no substituted net.

/** Il pavimento sotto cui non si entra affatto.
 *
 *  ERA 2 GIORNI, ED ERA UN'ASSUNZIONE SBAGLIATA. La motivazione scritta qui fino al 7 agosto 2026 era:
 *  «una posizione che va aperta, seguita e chiusa dentro due giorni passa tutta la vita in allestimento,
 *  qualunque cosa dica il montepremi». Il presupposto è che la posizione vada CHIUSA. Non è quello che
 *  fanno i maker che guadagnano: su 21 wallet misurati (data/manuale-operativo-maker-v2.md) la chiusura
 *  è a REDEEM nel 94% dei casi — si lascia risolvere, non si smonta niente, e l'allestimento è l'unico
 *  costo che c'è.
 *
 *  Gli stessi 21 entrano su mercati con vita mediana di 0,44 giorni dal primo fill (Q1 0,18 · Q3 0,80).
 *  Verificato contro il `closedTime` vero e non contro il campo `endDate` di Gamma, che su molti mercati
 *  è una data nominale stantia: su 25 mercati campionati, 23 chiudono davvero entro un giorno dal primo
 *  fill e 25 su 25 entro due. Il pavimento a 2 giorni escludeva per costruzione l'intero archetipo.
 *
 *  0,25 giorni = 6 ore. Sotto le sei ore l'allestimento è davvero tutto quello che c'è: sono i mercati
 *  crypto a 5 minuti, dove il fill utile arriva negli ultimi istanti e il rischio è di tutt'altra natura.
 *  Resta dichiarato, non derivato — è un'assunzione, e chi chiama la espone come tale. */
const MIN_HORIZON_DAYS = 0.25;

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** Days from `nowMs` to `endDate`. Null (never inferred) when missing or unparseable. */
function daysToResolution(endDate, nowMs) {
  if (typeof endDate !== 'string' || !endDate.trim()) return null;
  const t = Date.parse(endDate);
  if (!Number.isFinite(t) || !fin(nowMs)) return null;
  return (t - nowMs) / 86_400_000;
}

/**
 * Days of net accrual needed to pay back one day of adverse selection.
 *   null  → not measurable (no cost measured, or net not measurable)
 *   0     → nothing to pay back (no adverse cost measured at this offset)
 *   +Inf  → net is zero or negative: it never pays back
 */
function paybackDays(grossPerDay, costPerDay) {
  if (!fin(costPerDay)) return null;
  if (costPerDay <= 0) return 0;
  if (!fin(grossPerDay)) return null;
  const net = grossPerDay - costPerDay;
  if (net <= 0) return Infinity;
  return costPerDay / net;
}

/**
 * The verdict for one market.
 * @param {object} a
 * @param {string|null} a.endDate       ISO end date from the board row (REAL, never inferred)
 * @param {number} a.nowMs              clock
 * @param {number|null} a.grossPerDay   modelled gross at the chosen size (REAL)
 * @param {number|null} a.costPerDay    measured amortised adverse cost at the chosen offset (REAL)
 * @returns {{state:'ok'|'short'|'resolved'|'unknown', days:number|null, payback:number|null, reason:string}}
 */
function horizonVerdict(a) {
  const { endDate, nowMs, grossPerDay, costPerDay } = a || {};
  const days = daysToResolution(endDate, nowMs);
  if (days == null) {
    return { state: 'unknown', days: null, payback: null, reason: 'scadenza non leggibile — non viene indovinata' };
  }
  if (days <= 0) {
    return { state: 'resolved', days, payback: null, reason: `gia risolto o in risoluzione (${days.toFixed(1)} g)` };
  }
  if (days < MIN_HORIZON_DAYS) {
    return { state: 'resolved', days, payback: null, reason: `scade fra ${days.toFixed(1)} g — sotto il minimo di ${MIN_HORIZON_DAYS} g` };
  }
  const payback = paybackDays(grossPerDay, costPerDay);
  if (payback == null) {
    return { state: 'unknown', days, payback: null, reason: 'costo di adverse selection non misurato — nessun rientro calcolabile' };
  }
  if (payback === Infinity) {
    return { state: 'short', days, payback, reason: 'il netto non e positivo: il costo non rientra mai' };
  }
  if (days <= payback) {
    return { state: 'short', days, payback, reason: `scade fra ${days.toFixed(1)} g ma il rientro ne chiede ${payback.toFixed(1)}` };
  }
  return { state: 'ok', days, payback, reason: `scade fra ${days.toFixed(0)} g, rientro in ${payback.toFixed(1)}` };
}

/** Independent assertions, repo style. Run: node -e "require('./lib/rewards/horizon').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
  const NOW = 1_700_000_000_000;
  const iso = (d) => new Date(NOW + d * 86_400_000).toISOString();

  // ── daysToResolution: measured, or null. Never inferred.
  ok('endDate assente → null (mai dedotto)', daysToResolution(null, NOW) === null);
  ok('endDate vuoto → null', daysToResolution('   ', NOW) === null);
  ok('endDate non parsabile → null', daysToResolution('domani', NOW) === null);
  ok('endDate fra 10 g → 10', Math.abs(daysToResolution(iso(10), NOW) - 10) < 1e-6);
  ok('endDate passato → negativo', daysToResolution(iso(-3), NOW) < 0);

  // ── paybackDays
  ok('nessun costo misurato → null', paybackDays(10, null) === null);
  ok('costo 0 → payback 0 (niente da rientrare)', paybackDays(10, 0) === 0);
  ok('gross 10, costo 2 → netto 8 → payback 0.25 g', Math.abs(paybackDays(10, 2) - 0.25) < 1e-9);
  ok('gross 10, costo 9 → netto 1 → payback 9 g', Math.abs(paybackDays(10, 9) - 9) < 1e-9);
  ok('netto nullo o negativo → Infinity (non rientra mai)', paybackDays(5, 5) === Infinity && paybackDays(3, 8) === Infinity);
  ok('gross non misurato con costo positivo → null', paybackDays(null, 2) === null);

  // ── verdetti
  const vUnknown = horizonVerdict({ endDate: null, nowMs: NOW, grossPerDay: 10, costPerDay: 1 });
  ok('scadenza assente → unknown, MAI short', vUnknown.state === 'unknown');
  const vNoCost = horizonVerdict({ endDate: iso(100), nowMs: NOW, grossPerDay: 10, costPerDay: null });
  ok('costo non misurato → unknown, MAI short', vNoCost.state === 'unknown' && vNoCost.days != null);
  const vResolved = horizonVerdict({ endDate: iso(-1), nowMs: NOW, grossPerDay: 10, costPerDay: 1 });
  ok('gia risolto → resolved', vResolved.state === 'resolved');
  const vFloor = horizonVerdict({ endDate: iso(0.1), nowMs: NOW, grossPerDay: 10, costPerDay: 0 });
  ok('sotto il minimo dichiarato di 0,25 g → resolved', vFloor.state === 'resolved');
  // IL CASO CHE IL PAVIMENTO A 2 GIORNI RIFIUTAVA, ed è l'archetipo che guadagna: mezza giornata di
  // vita, nessun costo di adverse selection misurato, quindi niente da rientrare. Deve passare.
  const vBreve = horizonVerdict({ endDate: iso(0.5), nowMs: NOW, grossPerDay: 10, costPerDay: 0 });
  ok('mezza giornata con costo nullo → ok (era resolved col pavimento a 2 g)', vBreve.state === 'ok');
  // Ma il test di rientro resta, e su un orizzonte corto morde più forte, che è il punto.
  const vBreveCara = horizonVerdict({ endDate: iso(0.5), nowMs: NOW, grossPerDay: 10, costPerDay: 4 });
  ok('mezza giornata con rientro a 0,67 g → short (il payback non è stato allentato)', vBreveCara.state === 'short');
  const vShort = horizonVerdict({ endDate: iso(5), nowMs: NOW, grossPerDay: 10, costPerDay: 9 }); // payback 9 g
  ok('orizzonte 5 g contro rientro 9 g → short', vShort.state === 'short' && Math.abs(vShort.payback - 9) < 1e-9);
  const vNeg = horizonVerdict({ endDate: iso(400), nowMs: NOW, grossPerDay: 3, costPerDay: 8 });
  ok('netto negativo → short anche con orizzonte lunghissimo', vNeg.state === 'short' && vNeg.payback === Infinity);
  const vOk = horizonVerdict({ endDate: iso(200), nowMs: NOW, grossPerDay: 10, costPerDay: 2 }); // payback 0.25 g
  ok('orizzonte 200 g contro rientro 0.25 g → ok', vOk.state === 'ok');
  const vOkFree = horizonVerdict({ endDate: iso(30), nowMs: NOW, grossPerDay: 10, costPerDay: 0 });
  ok('nessun costo misurato al suo offset → payback 0 → ok', vOkFree.state === 'ok' && vOkFree.payback === 0);

  // ── la regola che conta: unknown non e' mai un rifiuto
  const rejects = (v) => v.state === 'short' || v.state === 'resolved';
  ok('unknown non e MAI un rifiuto', !rejects(vUnknown) && !rejects(vNoCost));

  console.log('horizon: ' + n + ' assertions passed');
  return n;
}

module.exports = { MIN_HORIZON_DAYS, daysToResolution, paybackDays, horizonVerdict, selfcheck };

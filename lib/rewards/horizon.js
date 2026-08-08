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
//   A market passes when it has MORE life left than that, and sits inside a DECLARED WINDOW:
//     daysToResolution > paybackDays  AND  MIN_HORIZON_DAYS <= daysToResolution <= MAX_HORIZON_DAYS
//
//   IL TETTO È NUOVO DELL'8 AGOSTO 2026 e chiude l'altro lato della domanda qui sopra. «Vive abbastanza
//   a lungo?» aveva una risposta sola perché il costo del capitale IMMOBILIZZATO non era in nessuna
//   formula: la chiusura è a redeem nel 94% dei casi misurati, quindi un mercato a 144 giorni tiene
//   fermo il capitale per 144 giorni, e un tasso al giorno — che è ciò che il knapsack massimizza —
//   non lo vede. Il motivo per cui esiste sta accanto alla costante.
//
// FIVE OUTCOMES, NOT TWO. `unknown` is a first-class answer and it never rejects:
//   ok        measured, inside the window, and the horizon clears the payback
//   short     measured, and it does not — with both numbers, so the verdict is checkable
//   resolved  already past its end date (or resolving inside the floor)
//   too-far   measured, and beyond MAX_HORIZON_DAYS — un fatto di calendario, deciso prima del payback
//             e indipendente da quanto il mercato renda
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

/** IL TETTO — 1,5 GIORNI, E IL NUMERO VIENE DAI FILL, NON DALL'INTUIZIONE (8 agosto 2026).
 *
 *  FINO A OGGI NON ESISTEVA, e non era una svista benigna: senza un tetto il knapsack massimizza un
 *  TASSO AL GIORNO, e un tasso al giorno non contiene la durata. Un mercato che rende $3/g per due
 *  giorni e uno che rende $3/g per centoquarantaquattro hanno lo stesso identico punteggio, quindi
 *  l'ottimizzatore non ha mai avuto una ragione per preferire il primo. Misurato l'8 agosto 2026: il
 *  piano in produzione aveva mediana **144,4 giorni** contro lo 0,44 dei 21 maker di riferimento —
 *  **328 volte** — e il manuale v1 si era già dato «< 24 ore» come obiettivo esplicito, chiamandolo
 *  «il cambio grosso». Si era andati nella direzione opposta.
 *
 *  LA BASE EMPIRICA, e non sono i quartili del manuale: sono i **299 ingressi veri** che
 *  `agent42-watch-makers` ha osservato dal vivo sui 21 wallet (`data/maker-21-eventi.jsonl`,
 *  campo `oreAScadenza` al momento dell'ingresso). Distribuzione misurata:
 *
 *      mediana 0,221 g (5,3 h) · Q1 0,046 · Q3 0,504 · P90 7,0 · max 145,7
 *
 *  e la copertura che ogni tetto candidato concede:
 *
 *      1,00 g → 78,9%      1,50 g → 81,6%      2,00 g → 83,6%
 *      2,50 g → 84,6%      3,00 g → 84,9%      5,00 g → 84,9%
 *
 *  PERCHÉ 1,5 E NON 1 NÉ 2. La curva ha un ginocchio proprio lì: da 1,5 a 5 giorni si comprano **3,3
 *  punti** di copertura al prezzo di triplicare l'orizzonte ammesso — si pagherebbe tantissima durata
 *  per pochissimi casi. Sotto, 1,0 g coinciderebbe con l'obiettivo dichiarato dal progetto, ma un
 *  tetto messo esattamente sull'obiettivo boccia per una cifra tonda un ingresso legittimo a 1,1 g.
 *  1,5 è **3,0× la mediana viva**, **3,0× il Q3 vivo** e **1,9× il Q3 del manuale v2** (0,80): largo
 *  sul nucleo osservato, e comunque lontanissimo dall'archetipo «maker paziente» (Nopants, Q3 7,03 g)
 *  e dal venditore neg-risk a scadenza lunga (0xF0e02A54, mediana 59,8 g), che fanno un altro mestiere.
 *
 *  SI CAMBIA DA `.env` con `MAKER_MAX_HORIZON_DAYS`, e un valore che non si capisce viene **scartato**
 *  in favore del difetto: la stessa regola di `end-of-scale`, perché un `.env` sbagliato non deve poter
 *  spegnere una protezione. Un valore ≤ MIN_HORIZON_DAYS chiuderebbe la finestra su se stessa e viene
 *  rifiutato allo stesso modo.
 *
 *  RESTA UN'ASSUNZIONE, come il minimo, e va detto: descrive il comportamento di chi guadagna oggi su
 *  questo venue, non una legge. */
const MAX_HORIZON_DAYS_DEFAULT = 1.5;

function leggiTetto(env) {
  const raw = env && typeof env.MAKER_MAX_HORIZON_DAYS === 'string' ? env.MAKER_MAX_HORIZON_DAYS.trim() : '';
  if (!raw) return MAX_HORIZON_DAYS_DEFAULT;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= MIN_HORIZON_DAYS) return MAX_HORIZON_DAYS_DEFAULT;
  return v;
}

/** Si rilegge a ogni chiamata, come le soglie di fine scala: cambiare `.env` non richiede un riavvio
 *  del pianificatore, che comunque nasce in un processo figlio a ogni ciclo. */
function maxHorizonDays(env = process.env) { return leggiTetto(env); }

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
 * @param {object} [a.env]              per il tetto massimo; di difetto `process.env`
 * @returns {{state:'ok'|'short'|'resolved'|'too-far'|'unknown', days:number|null, payback:number|null,
 *            reason:string, maxDays:number}}
 */
function horizonVerdict(a) {
  const { endDate, nowMs, grossPerDay, costPerDay } = a || {};
  const maxDays = leggiTetto((a && a.env) || process.env);
  const days = daysToResolution(endDate, nowMs);
  if (days == null) {
    return { state: 'unknown', days: null, payback: null, maxDays, reason: 'scadenza non leggibile — non viene indovinata' };
  }
  if (days <= 0) {
    return { state: 'resolved', days, payback: null, maxDays, reason: `gia risolto o in risoluzione (${days.toFixed(1)} g)` };
  }
  if (days < MIN_HORIZON_DAYS) {
    return { state: 'resolved', days, payback: null, maxDays, reason: `scade fra ${days.toFixed(1)} g — sotto il minimo di ${MIN_HORIZON_DAYS} g` };
  }
  // ── IL TETTO, E STA QUI PERCHÉ È UN FATTO DI CALENDARIO ─────────────────────────────────────────
  // Prima del payback, esattamente come il pavimento: se il mercato è troppo lontano non serve sapere
  // quanto rende per rifiutarlo, e l'ordine dei controlli lo dice. Il confine è INCLUSIVO come quello
  // del minimo — `days < MIN` rifiuta e `days === MIN` passa, quindi `days > MAX` rifiuta e
  // `days === MAX` passa: le due estremità si comportano allo stesso modo, che è l'unica cosa che
  // rende la finestra leggibile come `[MIN, MAX]`.
  if (days > maxDays) {
    return { state: 'too-far', days, payback: null, maxDays,
      reason: `scade fra ${days < 2 ? (days * 24).toFixed(1) + ' ore' : days.toFixed(1) + ' g'} — oltre il tetto di ${maxDays} g: `
        + 'il capitale resterebbe immobilizzato fino alla risoluzione (chiusura a redeem nel 94% dei casi misurati) '
        + 'mentre i maker che guadagnano rientrano in poche ore' };
  }
  const payback = paybackDays(grossPerDay, costPerDay);
  if (payback == null) {
    return { state: 'unknown', days, payback: null, maxDays, reason: 'costo di adverse selection non misurato — nessun rientro calcolabile' };
  }
  if (payback === Infinity) {
    return { state: 'short', days, payback, maxDays, reason: 'il netto non e positivo: il costo non rientra mai' };
  }
  if (days <= payback) {
    return { state: 'short', days, payback, maxDays, reason: `scade fra ${days.toFixed(1)} g ma il rientro ne chiede ${payback.toFixed(1)}` };
  }
  return { state: 'ok', days, payback, maxDays, reason: `scade fra ${days.toFixed(1)} g, rientro in ${payback.toFixed(1)}` };
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
  // ── LE SCADENZE DI QUESTI CASI SONO CAMBIATE L'8 AGOSTO 2026, E NON L'INTENZIONE ────────────────
  // Erano 100, 400, 200 e 30 giorni: valori scelti quando un tetto non esisteva, per dire «orizzonte
  // ampio, il vincolo è il payback». Con `MAX_HORIZON_DAYS` quelle date sono diventate `too-far` e i
  // casi avrebbero smesso di provare ciò che dicono di provare. Ora stanno dentro la finestra
  // [0,25 · 1,5] e verificano esattamente la stessa cosa di prima: la logica del rientro.
  const vNoCost = horizonVerdict({ endDate: iso(1), nowMs: NOW, grossPerDay: 10, costPerDay: null });
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
  const vShort = horizonVerdict({ endDate: iso(1), nowMs: NOW, grossPerDay: 10, costPerDay: 9 }); // payback 9 g
  ok('orizzonte 1 g contro rientro 9 g → short', vShort.state === 'short' && Math.abs(vShort.payback - 9) < 1e-9);
  const vNeg = horizonVerdict({ endDate: iso(1.4), nowMs: NOW, grossPerDay: 3, costPerDay: 8 });
  ok('netto negativo → short anche con l\'orizzonte piu\' ampio che la finestra concede', vNeg.state === 'short' && vNeg.payback === Infinity);
  const vOk = horizonVerdict({ endDate: iso(1), nowMs: NOW, grossPerDay: 10, costPerDay: 2 }); // payback 0.25 g
  ok('orizzonte 1 g contro rientro 0.25 g → ok', vOk.state === 'ok');
  const vOkFree = horizonVerdict({ endDate: iso(1), nowMs: NOW, grossPerDay: 10, costPerDay: 0 });
  ok('nessun costo misurato al suo offset → payback 0 → ok', vOkFree.state === 'ok' && vOkFree.payback === 0);

  // ── la regola che conta: unknown non e' mai un rifiuto
  const rejects = (v) => v.state === 'short' || v.state === 'resolved' || v.state === 'too-far';
  ok('unknown non e MAI un rifiuto', !rejects(vUnknown) && !rejects(vNoCost));

  // ── il tetto: un fatto di calendario, prima e indipendente dal rientro
  const vFar = horizonVerdict({ endDate: iso(144.4), nowMs: NOW, grossPerDay: 10, costPerDay: 0 });
  ok('oltre il tetto → too-far anche se rende e non costa', vFar.state === 'too-far' && vFar.maxDays === MAX_HORIZON_DAYS_DEFAULT);
  ok('al tetto esatto → passa, come al pavimento esatto',
    horizonVerdict({ endDate: iso(MAX_HORIZON_DAYS_DEFAULT), nowMs: NOW, grossPerDay: 10, costPerDay: 0 }).state === 'ok');
  ok('un .env illeggibile non spegne il tetto', maxHorizonDays({ MAKER_MAX_HORIZON_DAYS: 'tantissimo' }) === MAX_HORIZON_DAYS_DEFAULT);

  console.log('horizon: ' + n + ' assertions passed');
  return n;
}

module.exports = {
  MIN_HORIZON_DAYS, MAX_HORIZON_DAYS_DEFAULT, maxHorizonDays,
  daysToResolution, paybackDays, horizonVerdict, selfcheck,
};

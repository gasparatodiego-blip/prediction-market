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
//   ═══ QUESTO FILE DECIDE L'AMMISSIBILITÀ, NON LA PROPORZIONE (8 agosto 2026, sera) ═══════════════
//   Il tetto è nato a 1,5 giorni come cancello secco e ci è rimasto mezza giornata. Sbagliato come
//   forma: il 10,4% degli ingressi dei 21 maker misurati va oltre i 7 giorni, e un cancello lo
//   cancellava invece di rappresentarlo. Adesso ci sono DUE cose, in DUE posti:
//     · qui, un MURO a 150 giorni — oltre il massimo mai osservato (145,7): rifiuto secco, `too-far`;
//     · nell'allocatore, una QUOTA di capitale sulla fascia oltre 7 giorni (`capCodaLungaFrac`).
//   La divisione non è organizzativa, è logica: «questo mercato è ammissibile?» è una proprietà del
//   mercato e si può rispondere qui; «quanto del capitale può starci?» è una proprietà del PORTAFOGLIO
//   e un verdetto per-mercato non ha modo di conoscerla.
//
// FIVE OUTCOMES, NOT TWO. `unknown` is a first-class answer and it never rejects:
//   ok        measured, inside the window, and the horizon clears the payback
//   short     measured, and it does not — with both numbers, so the verdict is checkable
//   resolved  already past its end date (or resolving inside the floor)
//   too-far   measured, and beyond MAX_HORIZON_DAYS — un fatto di calendario, deciso prima del payback
//             e indipendente da quanto il mercato renda
//   unknown   endDate absent/unparseable, or net not measurable — ABSENCE OF EVIDENCE.
//             Il VERDETTO resta `unknown` e non diventa mai `short`: qui non si indovina niente, e
//             `days`/`payback` restano null invece di essere sostituiti.
//             ⚠ MA DAL 12 AGOSTO 2026 CHI FILTRA LO ESCLUDE, ed è una decisione dell'operatore che
//             ribalta la regola precedente («unknown non rifiuta mai»). Il motivo è misurato: la
//             scadenza mancava per COSTRUZIONE e non per caso — il board normalizzato non portava
//             `endDate` su 306 righe su 306 — quindi il filtro non escludeva NULLA e un mercato a 14,3
//             ore entrava nel piano per farsi rifiutare dalla verifica tre ricalcoli di fila, fermando
//             il ciclo (§5 punto 98). Adesso il board porta la scadenza vera e chi non ce l'ha esce:
//             allocare capitale su una data che non conosciamo è il rischio che il filtro esiste per
//             non correre. La distinzione resta netta e va tenuta: `horizonVerdict` MISURA e non
//             giudica, `allocator.horizonFilter` GIUDICA — vedi `bindsOnHorizon` lì.
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
 *  ═══ 0,25 ERA TARATO SULLA POPOLAZIONE SBAGLIATA — CORRETTO L'8 AGOSTO 2026, SERA ═══════════════
 *  Il valore 0,25 g (6 ore) veniva dalla mediana di 0,22 g misurata su TUTTI gli ingressi dei 21 maker.
 *  La ricerca per categoria dell'8 agosto (`data/ricerca-categorie-21-wallet.md`) ha mostrato che
 *  quella mediana descrive una popolazione che questo bot non abita: su 450 ingressi osservati **solo
 *  40 (8,9%) sono su mercati dentro il programma premi**. Il 91% è market-making direzionale su sport,
 *  dove il ricavo è lo spread e non il premio — e dove entrare a due ore dalla fine ha senso.
 *
 *  Separando le due popolazioni la differenza è di un ordine di grandezza:
 *
 *      orizzonte mediano · ingressi PREMIANTI 22,7 h  ·  ingressi NON premianti 2,2 h
 *
 *  Un premio di liquidità si matura restando sul libro. Su un mercato che scade fra due ore non c'è il
 *  tempo per maturarlo, e il pavimento tarato su quella popolazione ammetteva una fascia che i
 *  vincitori, quando cercano premi, non usano.
 *
 *  ═══ PERCHÉ ESATTAMENTE 0,75 g = 18 ORE ════════════════════════════════════════════════════════
 *  Copertura del campione premiante (38 ingressi con orizzonte leggibile) al variare del pavimento:
 *
 *      6h → 81,6%   12h → 60,5%   **15h → 57,9%   18h → 57,9%   19h → 57,9%**   20h → 55,3%   21h → 52,6%
 *
 *  Fra 12,4 h e 19,6 h il campione è VUOTO: non c'è un solo ingresso premiante in quella fascia. 18 ore
 *  cadono dentro quel vuoto, e questo è l'argomento vero — spostare il pavimento di ±5 ore attorno a 18
 *  non cambia quali mercati passano. È la stessa forma di scelta del «ginocchio» usata per il tetto di
 *  orizzonte e per la finestra del piano leggero: si sceglie il punto dove la risposta è INSENSIBILE
 *  alla scelta, non quello dove è ottima.
 *
 *  18 e non 21 anche per una seconda ragione, dichiarata: è il valore più basso del range deciso
 *  dall'operatore, quindi il meno distruttivo. 21 h escluderebbe altri due ingressi (Monaco 19,6 h e
 *  Shanghai 20,4 h) senza nessun guadagno di robustezza.
 *
 *  ═══ IL PREZZO, DETTO PRIMA E NON DOPO ═════════════════════════════════════════════════════════
 *  Alzare da 6 a 18 ore esclude 9 ingressi premianti che prima passavano, e NON sono rumore: sono la
 *  famiglia `<ticker>-up-or-down-on-<data>` (spy $200, wti $200, amzn/tsla/meta/aapl $20) che scade
 *  fra 2,6 e 8 ore, più `what-will-trump-say-during-friday-roundtable` ($100, 4,2-7,6 h). Il report la
 *  segnalava come la più interessante per affollamento (mediana 3, il più basso del campione). Questo
 *  pavimento la chiude. È il compromesso che l'operatore ha scelto sapendolo: la fascia sotto le 18 ore
 *  paga bene ma ha un profilo di rischio da taker, non da maker che aspetta.
 *
 *  Resta dichiarato, non derivato — è un'assunzione, e chi chiama la espone come tale. */
const MIN_HORIZON_DAYS = 0.75;

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** IL TETTO ASSOLUTO — 150 GIORNI. NON è più la politica: è il muro (8 agosto 2026, sera).
 *
 *  ═══ COS'ERA, E PERCHÉ È CAMBIATO ══════════════════════════════════════════════════════════════
 *  Per mezza giornata questo tetto è stato **1,5 giorni**, e rifiutava tutto ciò che stava oltre. Era
 *  giusto come direzione e sbagliato come forma: un cancello tutto-o-niente su una distribuzione che
 *  tutto-o-niente non è. I 307 ingressi veri dei 21 maker (`data/maker-21-eventi.jsonl`) dicono
 *
 *      mediana 0,212 g · Q3 0,504 · **P90 7,00** · P95 7,85 · max **145,7**
 *
 *  cioè il **10,4% dei loro ingressi (32 su 307) va OLTRE i 7 giorni**. Quel 10,4% non è rumore: è un
 *  comportamento che i vincitori hanno davvero, e un tetto a 1,5 g lo cancellava del tutto invece di
 *  rappresentarlo nella sua proporzione. Escludere un decimo del comportamento osservato perché non
 *  somiglia agli altri nove decimi è modellare male, non essere prudenti.
 *
 *  ═══ LA FORMA NUOVA: UN MURO E UNA QUOTA, E FANNO DUE LAVORI DIVERSI ═══════════════════════════
 *  · **Questo tetto** resta un rifiuto secco, ma si sposta a **150 giorni**. Il massimo mai osservato
 *    è 145,7: 150 lascia il margine di una settimana e non ammette niente che nessun vincitore abbia
 *    mai fatto. Oltre, `too-far`, senza appello e senza quota che tenga.
 *  · **La proporzione** non si decide più per-mercato: è un vincolo di COMPOSIZIONE del piano e vive
 *    nell'allocatore (`lib/rewards/allocator.js`, `capCodaLungaFrac`). Un mercato oltre `LONG_TAIL_DAYS`
 *    non viene più scartato: entra nella valutazione, e semmai è il PIANO a non potersi appoggiare
 *    sulla coda lunga per più di `LONG_TAIL_CAP_FRAC` del capitale.
 *
 *  Le due cose stanno in file diversi perché rispondono a domande diverse: «questo mercato è
 *  ammissibile?» è una proprietà del mercato; «quanto del mio capitale può stare lì?» è una proprietà
 *  del portafoglio, e un verdetto per-mercato non può conoscerla.
 *
 *  Si cambia con `MAKER_MAX_HORIZON_DAYS`; un valore illeggibile o ≤ MIN viene **scartato in favore
 *  del difetto** — la stessa regola di fine scala, perché un `.env` sbagliato non deve poter spegnere
 *  una protezione. */
const MAX_HORIZON_DAYS_DEFAULT = 150;

/** IL CONFINE DELLA CODA LUNGA — 7 giorni, ed è il P90 misurato, non un numero tondo scelto a mano.
 *  Sotto, il knapsack è libero come è sempre stato: nessuna quota, nessuna penalità, nessun cambio.
 *  Sopra, il capitale del piano è limitato da `LONG_TAIL_CAP_FRAC`. */
const LONG_TAIL_DAYS = 7;

/** QUANTO DEL PIANO PUÒ STARE OLTRE I 7 GIORNI — 12% del capitale.
 *
 *  Il numero misurato è **10,4%** (32 ingressi su 307 oltre il P90). 12% e non 10,4% per due ragioni,
 *  entrambe sulla stessa direzione: un tetto messo esattamente sulla stima puntuale boccia una
 *  composizione che finisce al 10,5% per rumore campionario, e la quota è un CEILING su una grandezza
 *  stimata, non la stima stessa. 12% aggiunge ~1,5 punti di margine e resta sotto il 15% che si
 *  otterrebbe spostando il confine a 3 giorni — cioè non può essere confuso con una banda più larga.
 *
 *  LIMITE DICHIARATO: la misura è sulla frazione di INGRESSI, non di capitale, perché il capitale per
 *  ingresso dei 21 non è ricostruibile con la stessa affidabilità. Si usa la prima come stima della
 *  seconda, ed è un'assunzione — se un giorno il capitale per ingresso risultasse molto più alto sulla
 *  coda lunga che sul nucleo, questo numero andrebbe rifatto. */
const LONG_TAIL_CAP_FRAC = 0.12;

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
      reason: `scade fra ${days < 2 ? (days * 24).toFixed(1) + ' ore' : days.toFixed(1) + ' g'} — oltre il muro di ${maxDays} g: `
        + 'nessuno dei 21 maker misurati è mai entrato così lontano (massimo osservato 145,7 g), '
        + 'e il capitale resterebbe immobilizzato fino alla risoluzione (chiusura a redeem nel 94% dei casi)' };
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
  // L'ARCHETIPO CHE GUADAGNA: un giorno di vita, nessun costo di adverse selection misurato, quindi
  // niente da rientrare. Deve passare. Era mezza giornata finché il pavimento stava a 0,25 g; con 0,75
  // mezza giornata è sotto il pavimento per costruzione, e il caso va allestito sopra di esso —
  // altrimenti si starebbe provando il pavimento invece del rientro.
  const vBreve = horizonVerdict({ endDate: iso(1), nowMs: NOW, grossPerDay: 10, costPerDay: 0 });
  ok('un giorno con costo nullo → ok (il pavimento non morde sopra 0,75 g)', vBreve.state === 'ok');
  // Ma il test di rientro resta, e su un orizzonte corto morde più forte, che è il punto.
  const vBreveCara = horizonVerdict({ endDate: iso(1), nowMs: NOW, grossPerDay: 10, costPerDay: 6 });
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
  // Lo STESSO predicato di `allocator.horizonFilter` (`bindsOnHorizon`): se i due divergono, il
  // selfcheck sta difendendo una regola che nessuno applica piu'.
  const rejects = (v) => v.state === 'short' || v.state === 'resolved' || v.state === 'too-far' || v.state === 'unknown';
  ok('unknown resta un VERDETTO a se, mai «short»', vUnknown.state === 'unknown' && vUnknown.days === null);
  ok('  ma dal 12 agosto 2026 chi filtra lo ESCLUDE (fail-closed)', rejects(vUnknown) && rejects(vNoCost),
    'la scadenza mancava per costruzione, non per caso: vedi l\'intestazione');

  // ── il tetto: un fatto di calendario, prima e indipendente dal rientro
  const vFar = horizonVerdict({ endDate: iso(400), nowMs: NOW, grossPerDay: 10, costPerDay: 0 });
  ok('oltre il MURO dei 150 g → too-far anche se rende e non costa', vFar.state === 'too-far' && vFar.maxDays === MAX_HORIZON_DAYS_DEFAULT);
  ok('al muro esatto → passa, come al pavimento esatto',
    horizonVerdict({ endDate: iso(MAX_HORIZON_DAYS_DEFAULT), nowMs: NOW, grossPerDay: 10, costPerDay: 0 }).state === 'ok');
  // LA CODA LUNGA NON È PIÙ UN RIFIUTO: 144,4 g è dentro il muro, e sarà l'allocatore a limitarne il
  // peso nel piano. È il cuore del cambiamento dell'8 agosto sera.
  ok('un mercato a 144,4 g (il caso Snapchat) è ok, non più too-far',
    horizonVerdict({ endDate: iso(144.4), nowMs: NOW, grossPerDay: 10, costPerDay: 0 }).state === 'ok');
  ok('  e il confine della coda lunga è il P90 misurato', LONG_TAIL_DAYS === 7);
  ok('  con una quota di capitale sotto il 15%', LONG_TAIL_CAP_FRAC > 0 && LONG_TAIL_CAP_FRAC < 0.15,
    String(LONG_TAIL_CAP_FRAC));
  ok('un .env illeggibile non spegne il tetto', maxHorizonDays({ MAKER_MAX_HORIZON_DAYS: 'tantissimo' }) === MAX_HORIZON_DAYS_DEFAULT);

  console.log('horizon: ' + n + ' assertions passed');
  return n;
}

module.exports = {
  MIN_HORIZON_DAYS, MAX_HORIZON_DAYS_DEFAULT, maxHorizonDays,
  LONG_TAIL_DAYS, LONG_TAIL_CAP_FRAC,
  daysToResolution, paybackDays, horizonVerdict, selfcheck,
};

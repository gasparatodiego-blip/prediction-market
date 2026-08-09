'use strict';
// lib/rewards/concentration.js — IL TETTO PER MERCATO, IN UN POSTO SOLO.
//
// ═══ PERCHÉ UN MODULO PER UN NUMERO ══════════════════════════════════════════════════════════════════
// Il tetto viveva in lib/maker/realloc-cycle.js e valeva solo per il riallocatore periodico. Il pannello
// «Ottimizza» non ne passava nessuno, quindi il suo tetto effettivo era il capitale intero: sullo stesso
// saldo e nello stesso istante le due strade producevano piani diversi — 4 mercati col 76,5% su uno solo
// contro 7 mercati col 29,4% al massimo — e nessuna delle due schermate diceva perché.
//
// Due strade che rispondono alla stessa domanda devono usare lo stesso numero, e l'unico modo perché
// resti lo stesso è che sia scritto una volta. Da qui lo leggono TUTTI E QUATTRO i percorsi che lo
// consumano — pianificatore, motore di piazzamento, rimpiazzo di una gamba, punteggio di rischio.
//
// ═══ ERA UNA PERCENTUALE, DAL 9 AGOSTO 2026 È UN VALORE FISSO ════════════════════════════════════════
// Fino a oggi il tetto era `20% del capitale`: cresceva in dollari insieme al saldo, quindi a capitale
// doppio il sistema metteva il doppio su OGNI mercato invece di usare più mercati. Su $670 valeva $134,
// su $2.000 sarebbe valso $400 — cioè quattro volte il nozionale mediano dei 21 maker misurati (~$34).
//
// La decisione dell'operatore (9 agosto 2026) è l'opposto: **quando il capitale cresce si spalma su PIÙ
// MERCATI, non si ingrossa la size su ciascuno**. È la stessa filosofia che il resto del sistema segue
// già — briciole su molte righe invece di poche righe grosse — e con un tetto fisso il numero di mercati
// diventa una CONSEGUENZA (`capitale ÷ tetto`) invece di un parametro separato da tenere allineato.
//
// ═══ IL NUMERO: $130, E COSA COPRE ═══════════════════════════════════════════════════════════════════
// $130 è il tetto sul MERCATO INTERO, cioè YES+NO sommati — la stessa semantica di prima, misurata e non
// assunta: `allocate.perMarketNetAtSize` restituisce `capital: 2 * sizeUsd`, e la griglia delle size è
// costruita a passi per lato fino a `capPerMarket`. Quindi $130 di tetto valgono **$65 per lato**.
// Verificato sul piano vero del 9 agosto: ogni riga ha `sizePerSideUsd = capital / 2` esatto.
//
// Il valore viene dal tetto che era in vigore ($133,99 = 20% di $669,93): $130 è quello, arrotondato in
// giù a un numero tondo, così il passaggio da percentuale a fisso NON cambia il piano di oggi — e
// infatti non lo cambia, misurato: stessa copertura, stesso capitale allocato.
//
// ═══ COSA QUESTO TETTO NON È ═════════════════════════════════════════════════════════════════════════
// Non è il tetto TOTALE. Quello resta dinamico e segue il capitale reale (`utilizzo-capitale`), ed è
// giusto che sia così: «quanto capitale impegnare in tutto» e «quanto su un singolo mercato» sono due
// domande diverse. Il tetto totale è una frazione del saldo; questo è un valore assoluto per riga.
//
// Non è nemmeno un limite al NUMERO di mercati. Quel limite non esiste più (era `MAX_POSIZIONI = 10` in
// agent41, rimosso il 9 agosto 2026): quanti mercati si usano è `capitale ÷ 130`, limitato solo da
// quanti mercati qualificati il board offre davvero.
//
// ═══ IL MECCANISMO ═══════════════════════════════════════════════════════════════════════════════════
// NON è un filtro a valle: `allocateBudget` costruisce la griglia delle size fino al tetto, quindi il
// knapsack non vede nemmeno i livelli oltre. Non c'è nessun punto in cui un'allocazione viene calcolata
// e poi tagliata.

/** IL TETTO PER MERCATO, IN DOLLARI, SU YES+NO SOMMATI. Si cambia QUI e in nessun altro posto. */
const MARKET_CAP_FIXED_USD = 130;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Il tetto in dollari per un dato capitale.
 *
 * ═══ DUE DIFFERENZE RISPETTO ALLA VERSIONE A PERCENTUALE, ENTRAMBE PIÙ SICURE ══════════════════════
 *
 * 1. NON RESTITUISCE PIÙ `null` SU UN CAPITALE ILLEGGIBILE. Prima doveva: il tetto era `capitale × 0,20`
 *    e senza il capitale non era calcolabile. Ma `null` a valle vale «nessun tetto» (l'allocatore
 *    ripiega su `budgetUsd`), quindi un capitale illeggibile ALLARGAVA il tetto invece di stringerlo —
 *    fail-OPEN su un vincolo di rischio. Con un tetto fisso il numero è sempre noto e quel ramo sparisce.
 *
 * 2. SI CLAMPA AL CAPITALE quando il capitale è leggibile. Con $50 in cassa non ha senso concedere $130
 *    su un mercato: il tetto può solo STRINGERE, mai concedere più di quanto ci sia. È la stessa cosa
 *    che `allocateBudget` fa già con `Math.min(maxPerMarketUsd, budgetUsd)`, portata a monte perché
 *    valga anche per i due percorsi che non passano dall'allocatore.
 *
 * @param {number|null|undefined} capitalUsd  il capitale disponibile; assente ⇒ si usa il tetto pieno
 * @returns {number} sempre un numero utilizzabile
 */
function capPerMarketUsd(capitalUsd) {
  if (!fin(capitalUsd) || capitalUsd <= 0) return MARKET_CAP_FIXED_USD;
  return +Math.min(MARKET_CAP_FIXED_USD, capitalUsd).toFixed(2);
}

/** Quanti mercati servono per impegnare `capitalUsd` a questo tetto. È il numero che PRIMA veniva
 *  deciso a mano da `MAX_POSIZIONI`; adesso è una conseguenza, e chi legge un piano deve poterlo
 *  confrontare con quanti mercati qualificati il board offre davvero. `null` se il capitale non si legge. */
function mercatiNecessari(capitalUsd) {
  if (!fin(capitalUsd) || capitalUsd <= 0) return null;
  return Math.ceil(capitalUsd / MARKET_CAP_FIXED_USD);
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/rewards/concentration').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond, extra) => { assert.ok(cond, 'FAIL: ' + name + (extra ? ' — ' + extra : '')); console.log('  ✓ ' + name); n++; };

  ok('il tetto è FISSO e vale $130', MARKET_CAP_FIXED_USD === 130);
  ok('non dipende dal capitale: $670 e $2.000 danno lo stesso tetto',
    capPerMarketUsd(670) === 130 && capPerMarketUsd(2000) === 130);
  ok('  ed è esattamente il valore dichiarato, non un arrotondamento', capPerMarketUsd(1e9) === MARKET_CAP_FIXED_USD);

  // ── il clamp: può solo stringere
  ok('capitale sotto il tetto ⇒ il tetto scende al capitale', capPerMarketUsd(50) === 50);
  ok('  e non concede mai più del capitale disponibile', capPerMarketUsd(129.5) === 129.5);
  ok('capitale esattamente al tetto ⇒ il tetto', capPerMarketUsd(130) === 130);

  // ── il ramo che PRIMA falliva aperto
  ok('capitale illeggibile ⇒ tetto PIENO, mai «nessun tetto»',
    capPerMarketUsd(null) === 130 && capPerMarketUsd(undefined) === 130
    && capPerMarketUsd(NaN) === 130 && capPerMarketUsd('130') === 130);
  ok('  capitale zero o negativo ⇒ tetto pieno, non zero e non null',
    capPerMarketUsd(0) === 130 && capPerMarketUsd(-5) === 130);
  ok('  NON restituisce mai null: a valle null varrebbe «nessun tetto»',
    [null, undefined, NaN, 0, -1, 50, 130, 5000].every((v) => typeof capPerMarketUsd(v) === 'number'));

  // ── il numero di mercati è una CONSEGUENZA
  ok('$594 liberi ⇒ 5 mercati necessari', mercatiNecessari(594.10) === 5);
  ok('$1.000 ⇒ 8 mercati', mercatiNecessari(1000) === 8);
  ok('$2.000 ⇒ 16 mercati', mercatiNecessari(2000) === 16);
  ok('  capitale illeggibile ⇒ null, non un numero inventato',
    mercatiNecessari(null) === null && mercatiNecessari(0) === null);

  console.log('concentration: ' + n + ' assertions passed');
  return n;
}

module.exports = { MARKET_CAP_FIXED_USD, capPerMarketUsd, mercatiNecessari, selfcheck };

'use strict';
// lib/rewards/net-per-day.js — QUANDO UN NETTO È UN NETTO, E QUANDO È SOLO UN LORDO TRAVESTITO.
//
// ═══ LA REGOLA, IN UNA RIGA ══════════════════════════════════════════════════════════════════════════
// Un netto esiste solo se un fill è stato OSSERVATO. Senza fill non c'è markout, senza markout non c'è
// costo misurato, e un «netto» calcolato su un costo mai misurato è il lordo con un'altra etichetta.
//
// ═══ PERCHÉ IL NUMERO SBAGLIATO È COSÌ CONVINCENTE ═══════════════════════════════════════════════════
// Il motore di allocazione, per costruire le curve, tratta «nessun fill osservato» come costo 0:
//
//     scripts/rewards-replay/lib/net.js →  costPerDay = (spanDays && measured) ? adverse/spanDays
//                                                     : (fills.length ? null : 0)
//
// Ed è la convenzione GIUSTA per ottimizzare: il knapsack deve poter confrontare un mercato senza fill
// con uno che ne ha, e assumere un costo inventato lo escluderebbe per un'ipotesi. Ma «costo 0 per
// scegliere» non è «costo 0 nella realtà», e quando quel valore arriva sullo schermo diventa
// `netto = lordo − 0 = lordo`: due colonne diverse con lo stesso numero, e nessuna che dica perché.
//
// La distinzione è fra un COSTO MODELLATO come zero e un COSTO MISURATO come zero. Il secondo si può
// mostrare. Il primo no.
//
// ═══ IL DIFETTO CHE HA PRODOTTO QUESTO MODULO ════════════════════════════════════════════════════════
// 4 agosto 2026. La regola esisteva già, applicata correttamente sulle righe del piano:
//
//     lib/rewards/allocator.js:233   const netPerDay = (a.fills > 0 && fin(a.netPerDay5m)) ? a.netPerDay5m : null;
//
// e mancava, cento righe più sotto, sulle CARD DI PROPOSTA dello stesso file:
//
//     lib/rewards/allocator.js:336   const bestNetPerDay = best && fin(best.net5m) ? best.net5m : null;
//                                                          ^^^ nessuna guardia sui fill
//
// Stesso file, stesso dato, due esiti diversi: `netPerDay: null` sulle righe e `bestNetPerDay` uguale al
// lordo sulle card — mentre il banner della stessa pagina prometteva «il netto è "—" dove non c'è un
// fill osservato». Misurato sul piano vero da $200: 4 mercati su 4 con `fills: 0`, netto delle righe
// `null`, netto delle card identico al lordo fino all'ultima cifra decimale.
//
// La regola non era sbagliata: era SCRITTA DUE VOLTE, e la seconda copia era vecchia. Per questo adesso
// vive qui e nessuno la riscrive.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Ci sono fill osservati su cui basare un costo?
 * Il conteggio dev'essere un numero VERO e positivo: `undefined`, `null` e `NaN` significano «non lo so»,
 * e «non lo so» non è «ce ne sono».
 */
function haFillOsservati(fills) {
  return fin(fills) && fills > 0;
}

/**
 * IL NETTO CANONICO. L'unica funzione autorizzata a produrre un netto per giorno.
 *
 * @param {object} a
 *   fills       numero di fill OSSERVATI a questa size/offset (non stimati, non modellati)
 *   netPerDay   il netto calcolato dal motore (lordo − costo ammortizzato), qualunque sia il campo
 *               di provenienza: `netPerDay5m` sulle righe, `net5m` sui livelli delle curve
 * @returns {number|null}  il netto, oppure null quando non è misurabile — MAI il lordo di ripiego
 */
function calcNetPerDay({ fills, netPerDay } = {}) {
  if (!haFillOsservati(fills)) return null;
  return fin(netPerDay) ? netPerDay : null;
}

/**
 * IL LORDO CANONICO. Non ha bisogno di fill: è il montepremi per la quota modellata, e la quota si
 * calcola dal book, non dalle esecuzioni. Resta null se non è un numero — un lordo non misurabile è
 * null, non zero.
 */
function calcGrossPerDay({ grossPerDay } = {}) {
  return fin(grossPerDay) ? grossPerDay : null;
}

/**
 * Perché quel netto è null. Serve alla UI e ai referti per dire QUALE assenza si sta guardando: «non
 * ci sono fill» e «il calcolo non è riuscito» sono due cose diverse, e un trattino solo le confonde.
 * @returns {null|'nessun-fill-osservato'|'non-calcolabile'}
 */
function perchePerNettoAssente({ fills, netPerDay } = {}) {
  if (!haFillOsservati(fills)) return 'nessun-fill-osservato';
  if (!fin(netPerDay)) return 'non-calcolabile';
  return null;
}

/** Il testo che la UI mostra al posto di un netto assente. Uno solo, per non averne due diversi. */
const NETTO_ASSENTE = '—';

/**
 * La spiegazione in chiaro, da mostrare accanto al trattino (title/tooltip). Non inventa numeri.
 */
function notaNettoAssente(motivo) {
  if (motivo === 'nessun-fill-osservato') {
    return 'Nessun fill osservato su questo mercato: senza esecuzioni non c\'è markout, quindi non c\'è un costo di adverse selection misurato e il netto non esiste. Il lordo qui accanto NON è il netto.';
  }
  if (motivo === 'non-calcolabile') {
    return 'Il netto non è calcolabile a questa size: il costo risulta non misurabile e non viene sostituito con zero.';
  }
  return null;
}

/** Asserzioni indipendenti. Esegui: node -e "require('./lib/rewards/net-per-day').selfcheck()" */
function selfcheck() {
  const assert = require('assert');
  let n = 0;
  const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };

  // ── LA REGOLA
  ok('zero fill → null, MAI il lordo', calcNetPerDay({ fills: 0, netPerDay: 12.34 }) === null);
  ok('  anche se il netto è un numero perfettamente valido', calcNetPerDay({ fills: 0, netPerDay: 0 }) === null);
  ok('fill assenti (undefined) → null: «non lo so» non è «ce ne sono»', calcNetPerDay({ netPerDay: 5 }) === null);
  ok('  fill null → null', calcNetPerDay({ fills: null, netPerDay: 5 }) === null);
  ok('  fill NaN → null', calcNetPerDay({ fills: NaN, netPerDay: 5 }) === null);
  ok('  fill negativi → null (non è un conteggio)', calcNetPerDay({ fills: -3, netPerDay: 5 }) === null);
  ok('un fill osservato e un netto valido → il netto', calcNetPerDay({ fills: 1, netPerDay: 7.5 }) === 7.5);
  ok('  netto negativo passa: è un risultato, non un errore', calcNetPerDay({ fills: 4, netPerDay: -2.25 }) === -2.25);
  ok('  netto zero con fill osservati passa: è misurato', calcNetPerDay({ fills: 4, netPerDay: 0 }) === 0);
  ok('fill osservati ma netto non calcolabile → null', calcNetPerDay({ fills: 4, netPerDay: null }) === null);
  ok('  e non diventa zero', calcNetPerDay({ fills: 4, netPerDay: undefined }) !== 0);

  // ── IL CASO CHE HA PRODOTTO IL MODULO: netto === lordo con zero fill
  ok('IL DIFETTO: con 0 fill il netto non può uscire uguale al lordo', (() => {
    const lordo = 10.951008645533141;      // il numero vero misurato il 4 agosto 2026
    const netto = calcNetPerDay({ fills: 0, netPerDay: lordo });
    return netto !== lordo && netto === null;
  })());

  // ── IL LORDO
  ok('il lordo non ha bisogno di fill', calcGrossPerDay({ grossPerDay: 3.2 }) === 3.2);
  ok('  un lordo non misurabile è null, non zero', calcGrossPerDay({ grossPerDay: null }) === null);
  ok('  zero resta zero', calcGrossPerDay({ grossPerDay: 0 }) === 0);

  // ── I MOTIVI
  ok('senza fill il motivo è «nessun-fill-osservato»',
    perchePerNettoAssente({ fills: 0, netPerDay: 9 }) === 'nessun-fill-osservato');
  ok('con fill ma senza netto il motivo è «non-calcolabile»',
    perchePerNettoAssente({ fills: 3, netPerDay: null }) === 'non-calcolabile');
  ok('con entrambi non c è motivo: il netto c è', perchePerNettoAssente({ fills: 3, netPerDay: 1 }) === null);
  ok('ogni motivo ha una nota in chiaro',
    !!notaNettoAssente('nessun-fill-osservato') && !!notaNettoAssente('non-calcolabile') && notaNettoAssente(null) === null);

  console.log('net-per-day: ' + n + ' assertions passed');
  return n;
}

module.exports = {
  calcNetPerDay, calcGrossPerDay, haFillOsservati,
  perchePerNettoAssente, notaNettoAssente, NETTO_ASSENTE,
  selfcheck,
};

'use strict';
// lib/maker/kill-perdita-giornaliera.js — LA PERDITA GIORNALIERA DEVE CANCELLARE, NON SOLO RIFIUTARE.
//
// ═══ IL DIFETTO CHE QUESTO MODULO CHIUDE (trovato il 17 agosto 2026, deciso dall'operatore) ═══════════
// `maxDailyLossUsd` esisteva, era letto e produceva persino un kill per utente:
//     risk-limits.js:175   usage.realisedDailyPnlUsd <= -L.maxDailyLossUsd  →  { gate:'daily-loss', autoKill:true }
//     adapter.js:793       if (limits.autoKill === true) safety.setUserKill(...)
// Ma quel percorso e' dentro `evaluateLimits`, che gira **quando si valuta un ordine**. Quindi a
// −$100 con zero ordini in arrivo non succedeva NIENTE: gli ordini a riposo restavano a libro, e il
// «kill» era un gate di piazzamento con un nome piu' grande di se'.
//
// A cancellare c'era solo `agent43-guardian`, che misura un'ALTRA cosa: il drawdown dal massimo mobile
// (−5% / −$30 derivato). Le due misure non si sostituiscono — una posizione aperta che perde valore muove
// il drawdown e NON la perdita realizzata; una serie di uscite in perdita muove la realizzata e puo'
// lasciare il drawdown dentro soglia se il mercato nel frattempo e' risalito.
//
// ═══ LE SCELTE, E LE RAGIONI ════════════════════════════════════════════════════════════════════════
// ⚠ LA SOGLIA E IL NUMERO VENGONO IMPORTATI, MAI RIDERIVATI. `maxDailyLossUsd` da
// `risk-limits.resolveLimits` e `realisedDailyPnlUsd` da `usage.readUsage` — le STESSE due grandezze che
// il gate di piazzamento confronta. Due idee di «perdita giornaliera» che divergono sarebbero il reperto
// D1 su una decisione di rischio, e qui la divergenza avrebbe la forma peggiore: il gate rifiuta e il
// guardiano non cancella, o viceversa.
//
// ⚠ FAIL-CLOSED AL CONTRARIO, E VA DETTO. Il gate di piazzamento, su una perdita NON LEGGIBILE, RIFIUTA
// (`risk-limits.js:174`): non piazzare su un dato che manca e' gratis. Qui la risposta e' l'opposta —
// perdita non leggibile ⇒ NON si cancella — perche' l'azione non e' gratis: cancellare tutti gli ordini
// a riposo su un errore di lettura del registro distruggerebbe reward veri per un'ignoranza nostra. Le
// due direzioni sono coerenti con lo stesso principio («non agire al buio»), non in contraddizione:
// rifiutare e' non-agire, cancellare e' agire.
//
// ⚠ NESSUNA CONFERMA k=2, e non e' una dimenticanza. Il guardiano del drawdown chiede due letture
// consecutive perche' misura un PREZZO, che oscilla (§5-bis p.141). La perdita realizzata e' un numero di
// REGISTRO: dentro la giornata puo' solo peggiorare, e una seconda lettura trenta secondi dopo non
// aggiunge informazione — aggiunge solo trenta secondi di esposizione. Se un domani il registro
// producesse letture rumorose, quella sara' una misura da fare, non un'ipotesi da difendere adesso.
//
// ⚠ E' UN CONFRONTO, NON UN'AZIONE: questo modulo non cancella e non ferma niente. Restituisce un
// verdetto, e chi lo cabla (agent43) riusa la spazzata che ha gia' — cioe' non nasce una seconda strada
// verso la cancellazione.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * @param {{perditaRealizzataUsd:(number|null), sogliaUsd:(number|null)}} a
 * @returns {{scatta:boolean, leggibile:boolean, perditaUsd:(number|null), sogliaUsd:(number|null), motivo:string}}
 */
function valutaPerditaGiornaliera({ perditaRealizzataUsd, sogliaUsd } = {}) {
  if (!fin(sogliaUsd) || sogliaUsd <= 0) {
    return { scatta: false, leggibile: false, perditaUsd: fin(perditaRealizzataUsd) ? perditaRealizzataUsd : null,
      sogliaUsd: null,
      motivo: 'il tetto di perdita giornaliera non e\' leggibile da data/safety-risk-limits.json: non si cancella su una soglia che non c\'e\'' };
  }
  if (!fin(perditaRealizzataUsd)) {
    return { scatta: false, leggibile: false, perditaUsd: null, sogliaUsd,
      motivo: `perdita realizzata di oggi NON leggibile dal registro dei fill: non si cancella al buio (il tetto di piazzamento rifiuta invece, e le due direzioni sono volute). Soglia $${sogliaUsd.toFixed(2)}` };
  }
  // Il confronto e' `<= -soglia`, alla lettera come `risk-limits.js:175`: la perdita e' un P&L NEGATIVO.
  if (perditaRealizzataUsd <= -sogliaUsd) {
    return { scatta: true, leggibile: true, perditaUsd: perditaRealizzataUsd, sogliaUsd,
      motivo: `perdita REALIZZATA di oggi $${perditaRealizzataUsd.toFixed(2)} ≤ −$${sogliaUsd.toFixed(2)}: si cancellano tutti gli ordini a riposo e il bot va su FERMA. Le posizioni aperte NON si toccano` };
  }
  return { scatta: false, leggibile: true, perditaUsd: perditaRealizzataUsd, sogliaUsd,
    motivo: `perdita realizzata di oggi $${perditaRealizzataUsd.toFixed(2)}, entro il tetto di −$${sogliaUsd.toFixed(2)}` };
}

module.exports = { valutaPerditaGiornaliera };

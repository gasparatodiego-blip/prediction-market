'use strict';
// lib/rewards/rischio-beneficio.js — QUANTO RENDE, DIVISO QUANTO PUÒ ANDARE STORTO.
//
// ═══ PERCHE' ESISTE ══════════════════════════════════════════════════════════════════════════════════
// Il bot ha molti cancelli binari — banda, orizzonte, profondità, concentrazione — e ognuno risponde
// sì/no. Un mercato che passa tutti i cancelli è indistinguibile da un altro che li passa tutti, anche
// quando uno dei due li passa per un soffio su tre di essi e l'altro con margine su tutti. La
// graduatoria vede solo il beneficio, e il rischio compare soltanto come esclusione.
//
// Questo modulo mette il rischio su un asse ORDINABILE accanto al beneficio, senza toccare nessun
// cancello: nessuna soglia cambia, nessun mercato viene ammesso o escluso da qui.
//
// ═══ LA FORMULA, PER ESTESO E SENZA SCATOLE NERE ════════════════════════════════════════════════════
//
//     punteggio = beneficioUsdGiorno / (fVolatilità · fProfondità · fOrizzonte · fConcentrazione)
//
// Ogni fattore vale **1 quando quel rischio è assente** e cresce quando è presente: il prodotto è quindi
// «di quanto va scontato il beneficio», e il punteggio resta in DOLLARI AL GIORNO — la stessa unità del
// beneficio, così due mercati si confrontano senza dover interpretare un indice adimensionale.
//
// I quattro fattori, con la fonte di ogni soglia. Nessuna costante è riscritta qui: sono tutte importate
// dal posto in cui il motore le usa già, perché una seconda copia è il modo in cui due parti dello
// stesso sistema cominciano a dire numeri diversi.
//
//   1 · VOLATILITÀ DEL MID — `1 + tickOra / VELOCE_TICK_ORA`
//       `tickOra` è l'escursione del mid in tick all'ora su 15 minuti: la STESSA misura del filtro
//       «⚡ Veloci» e della cadenza adattiva (lib/maker/cadenza-adattiva). Al confine in cui quel
//       modulo dichiara «veloce» il fattore vale esattamente 2. Un mercato fermo vale 1.
//       Perché è un rischio: il mid che si muove è il mid che esce dalla banda mentre il nostro ordine
//       riposa — cioè premio che smette di maturare, e fill avversi.
//
//   2 · PROFONDITÀ DEL BOOK — `1 + max(0, (RIF − profondità) / RIF)`, con RIF = $25
//       Il riferimento NON è scelto a mano: `maxCredibleShare = 0,60` (realistic-estimate) dice che la
//       stima non è credibile quando la nostra quota supera il 60%, cioè quando la liquidità altrui
//       scende sotto `(0,4/0,6) · nostra size`. Con il nozionale mediano dei 21 maker (~$34) quel
//       confine cade a $22,7, arrotondato a **$25**. Un book vuoto vale 2, un book con almeno $25 di
//       liquidità altrui in banda vale 1.
//       Perché è un rischio: è lo stesso motivo per cui esiste il tetto di credibilità — un book in cui
//       non c'è nessun altro di solito ti sta spiegando perché nessuno quota lì.
//
//   3 · DISTANZA DALLA RISOLUZIONE — **a due code**, `max(fCorto, fLungo)`
//       · corto:  `1 + max(0, (2·MIN_HORIZON_DAYS − giorni) / (2·MIN_HORIZON_DAYS))`
//                 Al pavimento esatto vale 1,5; da 1,5 g in su vale 1. Poco tempo per rientrare dal
//                 costo di allestimento.
//       · lungo:  `1 + min(1, (giorni − LONG_TAIL_DAYS) / LONG_TAIL_DAYS)`
//                 A 7 giorni (il P90 misurato) vale 1, a 14 o più vale 2. Capitale immobilizzato a
//                 lungo su un esito che non si può più cambiare.
//       È il punto che il requisito chiedeva esplicitamente: la distanza dalla risoluzione entra come
//       PESO, non solo come cancello. Il cancello (`horizonVerdict`) resta dov'era e non cambia.
//
//   4 · CONCENTRAZIONE — `1 + capitaleSulMercato / MARKET_CAP_FIXED_USD`
//       Al tetto per mercato (lib/rewards/concentration, $130 su YES+NO) il fattore vale esattamente 2:
//       cioè l'ultimo dollaro che il tetto concede e' scontato il doppio del primo. Sopra il tetto non si
//       arriva, perche' il tetto e' un cancello vero e vive altrove.
//       Era ancorato alla FRAZIONE del capitale (20%) finche' il tetto era una percentuale; dal 9 agosto
//       2026 il tetto e' un valore fisso e l'ancora lo segue — stessa forma, stesso «al tetto vale 2».
//
// Il prodotto sta quindi fra 1 (nessun rischio misurato su nessun asse) e 16 (tutti e quattro al
// massimo). Non c'è normalizzazione e non c'è taratura: ogni fattore è ancorato a una soglia che il
// motore già applica, quindi «2» significa sempre «sei esattamente sul confine che quel modulo chiama
// rischioso».
//
// ═══ COSA QUESTO MODULO NON FA ══════════════════════════════════════════════════════════════════════
// Non decide niente. Non è importato da nessun cancello, non entra nell'obiettivo del knapsack, non
// cambia un offset, non esclude una riga. È una LENTE per ordinare, e il fatto che sia solo una lente è
// verificato da un test che cammina i sorgenti.
//
// ═══ UN INGRESSO NON MISURATO NON VALE ZERO ═════════════════════════════════════════════════════════
// Un fattore che non si può calcolare vale **1** — cioè non sconta — e il suo nome finisce in
// `nonMisurati`, con `certezza: 'parziale'`. È una scelta dichiarata e ha un verso: un rischio non
// misurato NON deve poter far sembrare un mercato peggiore di quanto si sappia, perché il punteggio
// serve a ordinare e non a escludere. Chi legge vede quali assi sono ciechi e decide se fidarsi.
// Se il BENEFICIO non è leggibile non c'è punteggio affatto: `leggibile: false`.

const { VELOCE_TICK_ORA } = require('../maker/cadenza-adattiva');
const { MIN_HORIZON_DAYS, LONG_TAIL_DAYS } = require('./horizon');
const { MARKET_CAP_FIXED_USD } = require('./concentration');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** La liquidità altrui in banda sotto la quale il book è «sottile». Derivata, non scelta: vedi §2. */
const PROFONDITA_RIFERIMENTO_USD = 25;
/** Il tetto di ogni singolo fattore. Nessun asse da solo può scontare più che dimezzare. */
const FATTORE_MAX = 2;

const limita = (x) => Math.min(FATTORE_MAX, Math.max(1, x));

/**
 * IL PUNTEGGIO. Puro: nessuna lettura, nessuna rete, nessuno stato.
 *
 * @param {object} a
 *   beneficioUsdGiorno   il reward realisticamente catturabile (di norma `realisticBestPerDay`, che
 *                        include già la correzione thin-book e il tetto di credibilità)
 *   tickOra              escursione del mid in tick/ora (cadenza-adattiva). null ⇒ asse cieco
 *   profonditaUsd        liquidità ALTRUI in banda, in dollari. null ⇒ asse cieco
 *   giorniAllaRisoluzione null ⇒ asse cieco
 *   capitaleSulMercatoUsd / capitaleTotaleUsd  per la concentrazione. Mancanti ⇒ asse cieco
 * @returns {{leggibile:boolean, punteggio:number|null, beneficio:number|null, rischio:number|null,
 *            componenti:object, nonMisurati:string[], certezza:'piena'|'parziale'|'nessuna', motivo:string}}
 */
function rischioBeneficio({
  beneficioUsdGiorno = null, tickOra = null, profonditaUsd = null,
  giorniAllaRisoluzione = null, capitaleSulMercatoUsd = null, capitaleTotaleUsd = null,
} = {}) {
  const nonMisurati = [];
  const componenti = {};

  // 1 · VOLATILITÀ
  if (fin(tickOra) && tickOra >= 0 && fin(VELOCE_TICK_ORA) && VELOCE_TICK_ORA > 0) {
    componenti.volatilita = { fattore: +limita(1 + tickOra / VELOCE_TICK_ORA).toFixed(4), misura: +tickOra.toFixed(3),
      soglia: VELOCE_TICK_ORA, nota: `tick/ora su 15 min; al confine «veloce» (${VELOCE_TICK_ORA}) il fattore vale 2` };
  } else { componenti.volatilita = { fattore: 1, misura: null, soglia: VELOCE_TICK_ORA, nota: 'escursione del mid non misurata' }; nonMisurati.push('volatilita'); }

  // 2 · PROFONDITÀ
  if (fin(profonditaUsd) && profonditaUsd >= 0) {
    componenti.profondita = { fattore: +limita(1 + Math.max(0, (PROFONDITA_RIFERIMENTO_USD - profonditaUsd) / PROFONDITA_RIFERIMENTO_USD)).toFixed(4),
      misura: +profonditaUsd.toFixed(2), soglia: PROFONDITA_RIFERIMENTO_USD,
      nota: `liquidità altrui in banda; sotto $${PROFONDITA_RIFERIMENTO_USD} il book è sottile (deriva da maxCredibleShare 0,60)` };
  } else { componenti.profondita = { fattore: 1, misura: null, soglia: PROFONDITA_RIFERIMENTO_USD, nota: 'profondità in banda non misurata' }; nonMisurati.push('profondita'); }

  // 3 · ORIZZONTE, a due code
  if (fin(giorniAllaRisoluzione) && giorniAllaRisoluzione > 0) {
    const rifCorto = 2 * MIN_HORIZON_DAYS;
    const fCorto = 1 + Math.max(0, (rifCorto - giorniAllaRisoluzione) / rifCorto);
    const fLungo = 1 + Math.min(1, Math.max(0, (giorniAllaRisoluzione - LONG_TAIL_DAYS) / LONG_TAIL_DAYS));
    const f = limita(Math.max(fCorto, fLungo));
    componenti.orizzonte = { fattore: +f.toFixed(4), misura: +giorniAllaRisoluzione.toFixed(3),
      coda: fCorto >= fLungo ? 'corto' : 'lungo',
      nota: `comfort fra ${rifCorto} g e ${LONG_TAIL_DAYS} g; fuori da lì il fattore cresce verso 2` };
  } else { componenti.orizzonte = { fattore: 1, misura: null, coda: null, nota: 'giorni alla risoluzione non leggibili' }; nonMisurati.push('orizzonte'); }

  // 4 · CONCENTRAZIONE — ancorata al TETTO FISSO, non più a una frazione del capitale (9 agosto 2026)
  //
  // Era `1 + quota / CONCENTRATION_CAP_FRAC` con `quota = capitaleSulMercato / capitaleTotale`: al tetto
  // del 20% il fattore valeva 2. Il tetto adesso è $130 fissi, quindi quella normalizzazione leggeva una
  // percentuale che non governa più niente — e con un capitale grande avrebbe dato «rischio 1,05» a una
  // riga che occupa il tetto INTERO, cioè avrebbe smesso di misurare proprio ciò per cui esiste.
  //
  // La forma è identica e l'ancora è la stessa: **al tetto il fattore vale esattamente 2**. Cambia solo
  // il denominatore, che ora è il tetto in dollari invece della frazione.
  //
  // EFFETTO COLLATERALE BUONO: l'asse diventa misurabile con UN ingresso invece di due. Prima serviva
  // anche `capitaleTotaleUsd`, e senza quello l'asse era cieco; adesso il capitale totale serve solo a
  // dire la percentuale nel referto, e la sua assenza non spegne più la misura.
  if (fin(capitaleSulMercatoUsd) && capitaleSulMercatoUsd >= 0
      && fin(MARKET_CAP_FIXED_USD) && MARKET_CAP_FIXED_USD > 0) {
    const quotaDelTetto = capitaleSulMercatoUsd / MARKET_CAP_FIXED_USD;
    const pctDelTotale = (fin(capitaleTotaleUsd) && capitaleTotaleUsd > 0)
      ? +((capitaleSulMercatoUsd / capitaleTotaleUsd) * 100).toFixed(2) : null;
    componenti.concentrazione = {
      fattore: +limita(1 + quotaDelTetto).toFixed(4),
      misura: +capitaleSulMercatoUsd.toFixed(2),
      soglia: MARKET_CAP_FIXED_USD,
      pctDelTotale,
      nota: `$ sul mercato (YES+NO); al tetto di $${MARKET_CAP_FIXED_USD} il fattore vale 2`
        + (pctDelTotale != null ? ` — qui è il ${pctDelTotale}% del capitale totale` : ''),
    };
  } else {
    componenti.concentrazione = { fattore: 1, misura: null, soglia: MARKET_CAP_FIXED_USD, pctDelTotale: null,
      nota: 'capitale sul mercato non noto' };
    nonMisurati.push('concentrazione');
  }

  const rischio = +(componenti.volatilita.fattore * componenti.profondita.fattore
    * componenti.orizzonte.fattore * componenti.concentrazione.fattore).toFixed(4);

  // `certezza` descrive la misura del RISCHIO, non la presenza del beneficio: sono due fatti diversi e
  // confonderli renderebbe illeggibile il caso del board, dove il rischio è misurato per intero e il
  // beneficio manca per scelta (dipende dal capitale, che quella rotta non legge).
  const certezza = nonMisurati.length === 0 ? 'piena' : 'parziale';
  if (!fin(beneficioUsdGiorno)) {
    return { leggibile: false, punteggio: null, beneficio: null, rischio, componenti, nonMisurati, certezza,
      motivo: `rischio ×${rischio.toFixed(2)} misurato, ma il beneficio non è stimabile qui: senza il numeratore non c'è un punteggio`
        + (nonMisurati.length ? ` · assi ciechi: ${nonMisurati.join(', ')}` : '') };
  }
  const punteggio = +(beneficioUsdGiorno / rischio).toFixed(4);
  return {
    leggibile: true, punteggio, beneficio: +beneficioUsdGiorno.toFixed(4), rischio, componenti, nonMisurati, certezza,
    motivo: `$${beneficioUsdGiorno.toFixed(2)}/g scontati ×${rischio.toFixed(2)} ⇒ $${punteggio.toFixed(2)}/g aggiustati per il rischio`
      + (nonMisurati.length ? ` · assi ciechi: ${nonMisurati.join(', ')} (non scontano, e sono dichiarati)` : ''),
  };
}

/** Una riga sola per il log e per l'audit. */
function formattaRischioBeneficio(r) {
  if (!r) return 'rischio/beneficio: non calcolato';
  if (!r.leggibile) return `rischio/beneficio: NON ORDINABILE (${r.motivo})`;
  const c = r.componenti;
  return `$${r.punteggio.toFixed(2)}/g agg. = $${r.beneficio.toFixed(2)} / ${r.rischio.toFixed(2)}`
    + ` [vol ${c.volatilita.fattore.toFixed(2)} · prof ${c.profondita.fattore.toFixed(2)}`
    + ` · oriz ${c.orizzonte.fattore.toFixed(2)} · conc ${c.concentrazione.fattore.toFixed(2)}]`
    + (r.certezza === 'parziale' ? ` · parziale (${r.nonMisurati.join(',')})` : '');
}

module.exports = {
  rischioBeneficio, formattaRischioBeneficio,
  PROFONDITA_RIFERIMENTO_USD, FATTORE_MAX,
};

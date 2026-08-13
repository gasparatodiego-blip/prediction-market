'use strict';
// lib/banda-premiante.js — L'UNICA DEFINIZIONE DI `v`, LA SEMIAMPIEZZA DELLA BANDA PREMIANTE.
//
// ═══ IL DIFETTO CHE QUESTO MODULO CHIUDE ═════════════════════════════════════════════════════════════
// Fino al 13 agosto 2026 il repo portava DUE letture di `v` e sessanta punti che se la ricalcolavano
// da soli: `lib/rewardScore.js`, `lib/rewards-live-band.js` e altri 58 siti usavano
// `bandRadius = maxSpread / 2`, mentre `lib/reward-score.ts` usava `v = maxSpread`. Due numeri per lo
// stesso concetto, cioè il reperto D1 dell'audit, sul parametro che decide se un ordine matura o no.
//
// ═══ LA LETTURA GIUSTA, CON LA PROVA ════════════════════════════════════════════════════════════════
// La documentazione ufficiale viva (docs.polymarket.com/market-makers/liquidity-rewards) definisce
// `v` come «Max spread from midpoint (in cents)»: è la distanza massima DAL MID, cioè la semiampiezza,
// non la larghezza totale. E l'esempio ufficiale lo dimostra da solo senza bisogno di interpretare la
// frase: con `max spread = 3` centesimi e mid `0.50`, un bid a `0.48` — cioè a **2 centesimi** dal mid —
// vale `((3−2)/3)² · 200 ≈ 22,22`, un punteggio POSITIVO. Con la lettura `v = maxSpread/2 = 1,5` quello
// stesso ordine varrebbe ZERO. L'esempio del venue è incompatibile con la lettura dimezzata.
//
// Contro-prova sul libro vivo (`scripts/ricerca/banda-competitivita.js`, 104 mercati): su 11 mercati il
// venue pubblica `market_competitiveness > 0` mentre la lettura dimezzata vede il libro premiante
// VUOTO; zero mercati mostrano la contraddizione opposta. Il 64,3% del punteggio premiante di un
// mercato sta nell'anello `maxSpread/2 < s ≤ maxSpread` che la lettura dimezzata dichiarava nullo.
//
// ═══ COSA NON CAMBIA, E VA SAPUTO ═══════════════════════════════════════════════════════════════════
// `v` NON è una manopola nostra: il venue ha SEMPRE pagato con `v = maxSpread`, anche mentre il nostro
// codice credeva il contrario. Correggere qui non cambia di un centesimo quanto matura un ordine già a
// libro — cambia le nostre DECISIONI: quali mercati si giudicano quotabili, quando un ordine si
// dichiara fuori banda, e quanto vale la stima. Chi legge questi numeri non deve aspettarsi che il
// consuntivo si muova per effetto di questa correzione.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * IL RAGGIO DELLA BANDA PREMIANTE, in centesimi. È `v`.
 *
 * Un ordine matura iff `|prezzo − mid| · 100 < v`; a `s = v` il punteggio è già zero.
 *
 * ⚠ Restituisce `null` — mai 0, mai un ripiego — quando la banda non è leggibile. Zero significherebbe
 * «banda inesistente, niente matura», che è una AFFERMAZIONE; `null` significa «non l'ho letta», e i
 * chiamanti di questo repo sanno già distinguere le due cose. È la regola di §5.3 su `Number(null)`.
 */
function raggioBandaCents(maxSpreadCents) {
  if (!fin(maxSpreadCents) || maxSpreadCents <= 0) return null;
  return maxSpreadCents;
}

/** Lo stesso raggio in unità di PREZZO (0..1) invece che in centesimi. */
function raggioBandaPrezzo(maxSpreadCents) {
  const v = raggioBandaCents(maxSpreadCents);
  return v == null ? null : v / 100;
}

/**
 * Il test «dentro banda» su una distanza già in centesimi.
 * ⚠ Banda non leggibile ⇒ `false`, non `null`: chi chiede «matura?» riceve un no, e i chiamanti che
 * devono distinguere «non so» usano `raggioBandaCents` e decidono da sé.
 */
function dentroBanda(distanzaCents, maxSpreadCents) {
  const v = raggioBandaCents(maxSpreadCents);
  if (v == null || !fin(distanzaCents)) return false;
  return Math.abs(distanzaCents) <= v;
}

/**
 * Il punteggio pubblicato del venue per UN ordine: `S(v, s) = ((v − s) / v)²`.
 * `b = 1` per gli ordini standard, quindi non compare.
 */
function punteggio(distanzaCents, maxSpreadCents) {
  const v = raggioBandaCents(maxSpreadCents);
  if (v == null || !fin(distanzaCents)) return 0;
  const s = Math.abs(distanzaCents);
  if (s >= v) return 0;
  const r = (v - s) / v;
  return r * r;
}

module.exports = { raggioBandaCents, raggioBandaPrezzo, dentroBanda, punteggio };

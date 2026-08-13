'use strict';
// lib/maker/distanza-obiettivo.js — LA MANOPOLA DELLA POSIZIONE NELLA BANDA, IN UN PUNTO SOLO.
//
// ═══ COSA FA, E COSA NON FA ══════════════════════════════════════════════════════════════════════
// Permette all'operatore di chiedere che gli ordini stiano ALMENO a una certa distanza dal mid,
// espressa come FRAZIONE DI `v` (la semiampiezza della banda premiante, `lib/banda-premiante`) e non
// in centesimi assoluti — così lo stesso numero vale su un mercato con banda 3,5¢ e su uno con 5,5¢.
//
// ⚠ È UN PAVIMENTO, NON UN BERSAGLIO. Il prezzo può solo ALLONTANARSI dal mid, mai avvicinarsi. La
// conseguenza che conta: nello spazio bid «più lontano dal mid» vuol dire «più in basso», cioè più
// indietro nella coda. Quindi **«mai primo sul libro» è preservato per COSTRUZIONE** — questa manopola
// non può mettere un ordine davanti a nessuno, qualunque valore le si dia.
//
// ⚠ IL PALETTO: DENTRO LA BANDA, SEMPRE. Se la distanza richiesta cadesse oltre il bordo premiante,
// l'ordine si ferma AL BORDO e non lo supera mai. Un valore assurdo (10× la banda) non produce un
// ordine fuori banda: produce un ordine al bordo, e lo dichiara. Fallisce chiuso.
//
// ═══ IL PREZZO DI GIRARLA, MISURATO E SCRITTO QUI ════════════════════════════════════════════════
// `S(v,s) = ((v−s)/v)²` è QUADRATICA: allontanarsi costa il quadrato. Sulla banda modale (v = 4,5¢) e
// dalla posizione mediana reale di oggi (1,0¢ ⇒ frazione 0,222):
//
//     frazione   distanza   S        vs oggi
//     0,222      1,0¢       0,6049   —          ← default, il comportamento di adesso
//     0,333      1,5¢       0,4444   −27%
//     0,444      2,0¢       0,3086   −49%
//     0,556      2,5¢       0,1975   −67%
//
// Il guadagno atteso non è nel reward — è nel TASSO DI FILL, che scende perché il prezzo è più lontano
// dal mid. Per un maker l'esecuzione è il costo, non il ricavo.
//
// ═══ IL DEFAULT È IL COMPORTAMENTO DI OGGI, ED È `null` ══════════════════════════════════════════
// Non impostata, la manopola NON esiste: `planBehindBest` decide come ha sempre deciso (un tick dietro
// il migliore, arretrando solo per la protezione di profondità). Non si cambia la posizione adesso —
// si aggiunge la possibilità di cambiarla, e la gira l'operatore.

const { raggioBandaCents } = require('../banda-premiante');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Il nome della manopola. Vive QUI e in nessun altro posto. */
const ENV_FRAZIONE = 'MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V';

/** Nessun obiettivo: il comportamento di sempre. */
const FRAZIONE_DEFAULT = null;

/** Oltre questo non si accetta: una frazione ≥ 1 chiederebbe il bordo o oltre, dove S vale 0. */
const FRAZIONE_MASSIMA = 0.95;

/**
 * Legge la frazione richiesta. `null` ⇒ manopola spenta, e ogni valore che non si capisce vale `null`:
 * un env sbagliato non deve spostare gli ordini, deve non fare niente (la stessa regola di
 * `end-of-scale`, dove un valore illeggibile viene scartato in favore del difetto).
 */
function leggiFrazione(env = process.env) {
  const raw = env && env[ENV_FRAZIONE];
  if (raw === undefined || raw === null || String(raw).trim() === '') return FRAZIONE_DEFAULT;
  const v = Number(raw);
  if (!fin(v) || v <= 0) return FRAZIONE_DEFAULT;
  // Si CLAMPA invece di rifiutare: chi scrive 2 sta chiedendo «il più lontano possibile», e la
  // risposta giusta è il bordo, non «ignoro e resto dov'ero».
  return Math.min(v, FRAZIONE_MASSIMA);
}

/**
 * La distanza-obiettivo in centesimi, per un mercato con questa banda.
 *
 * @returns `{distanzaC:number|null, frazione:number|null, clampata:boolean, motivo:string}`
 *          `distanzaC: null` ⇒ nessun obiettivo: il chiamante non cambia niente.
 */
function distanzaObiettivoCents({ maxSpreadCents = null, frazione = undefined, env = process.env } = {}) {
  const fr = frazione === undefined ? leggiFrazione(env) : (fin(frazione) && frazione > 0 ? Math.min(frazione, FRAZIONE_MASSIMA) : null);
  if (fr == null) return { distanzaC: null, frazione: null, clampata: false, motivo: 'manopola spenta: la posizione la decide la regola di sempre' };
  const v = raggioBandaCents(maxSpreadCents);
  if (v == null) {
    // ⚠ Banda non leggibile ⇒ nessun obiettivo. Applicarne uno senza sapere dov'è il bordo vorrebbe
    // dire poter uscire dalla banda, che è la cosa che il paletto vieta.
    return { distanzaC: null, frazione: fr, clampata: false, motivo: 'banda non leggibile: nessun obiettivo, si resta al comportamento di sempre' };
  }
  const clampata = frazione !== undefined && fin(frazione) && frazione > FRAZIONE_MASSIMA;
  return {
    distanzaC: +(fr * v).toFixed(4), frazione: fr, clampata,
    motivo: `obiettivo ${fr} × v(${v}¢) = ${(fr * v).toFixed(2)}¢ dal mid`,
  };
}

/**
 * Applica l'obiettivo a un prezzo già deciso dalle altre regole, NELLO SPAZIO BID.
 *
 * @param a.prezzo      il prezzo che le regole di sempre hanno prodotto
 * @param a.scoringMid  il mid su cui il venue giudica
 * @param a.bandLo      il bordo della banda più LONTANO dal mid (spazio bid: il più basso)
 * @param a.distanzaC   la distanza-obiettivo in centesimi, da `distanzaObiettivoCents`
 * @param a.tick        il tick del venue
 * @returns `{prezzo, spostato:boolean, alBordo:boolean, distanzaEffettivaC:number|null, motivo}`
 */
function applicaObiettivo({ prezzo = null, scoringMid = null, bandLo = null, distanzaC = null, tick = null } = {}) {
  const dist = (p) => (fin(p) && fin(scoringMid) ? +Math.abs((scoringMid - p) * 100).toFixed(3) : null);
  if (!fin(prezzo) || !fin(scoringMid) || !fin(distanzaC) || distanzaC <= 0) {
    return { prezzo, spostato: false, alBordo: false, distanzaEffettivaC: dist(prezzo), motivo: 'nessun obiettivo da applicare' };
  }
  const obiettivo = scoringMid - distanzaC / 100;
  // ⚠ SOLO PIÙ LONTANO: `Math.min` nello spazio bid. Se le regole di sempre hanno già messo il prezzo
  // più lontano dell'obiettivo, l'obiettivo non lo riavvicina — sarebbe risalire nella coda, cioè
  // esattamente ciò che «mai primo sul libro» vieta.
  let p = Math.min(prezzo, obiettivo);
  let alBordo = false;
  // ⚠ IL PALETTO: mai oltre il bordo premiante. Si ferma lì e lo dichiara.
  if (fin(bandLo) && p < bandLo) { p = bandLo; alBordo = true; }
  if (fin(tick) && tick > 0) {
    // Si arrotonda ALLONTANANDOSI dal mid (floor nello spazio bid), mai avvicinandosi: arrotondare
    // verso il mid rimetterebbe l'ordine davanti a qualcuno per un errore di griglia.
    const g = Math.floor(+(p / tick).toFixed(9)) * tick;
    const gs = +g.toFixed(9);
    if (fin(bandLo) && gs < bandLo) { p = bandLo; alBordo = true; } else if (fin(gs)) { p = gs; }
  }
  const spostato = +p.toFixed(9) !== +prezzo.toFixed(9);
  return {
    prezzo: +p.toFixed(9), spostato, alBordo, distanzaEffettivaC: dist(p),
    motivo: !spostato ? 'le regole di sempre erano già oltre l\'obiettivo: niente da spostare'
      : alBordo ? `obiettivo ${distanzaC.toFixed(2)}¢ oltre il bordo premiante: fermato AL BORDO (${dist(p)}¢ dal mid), mai fuori`
        : `spostato all'obiettivo: ${dist(p)}¢ dal mid`,
  };
}

module.exports = {
  ENV_FRAZIONE, FRAZIONE_DEFAULT, FRAZIONE_MASSIMA,
  leggiFrazione, distanzaObiettivoCents, applicaObiettivo,
};

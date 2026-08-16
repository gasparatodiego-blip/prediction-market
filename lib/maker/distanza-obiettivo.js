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

// ═══ IL MARGINE DAL BORDO PREMIANTE — 15 agosto 2026 ══════════════════════════════════════════════
//
// ⚠ IL PROBLEMA CHE RISOLVE, POSTO DALL'OPERATORE: «stando al bordo esterno il margine verso l'esterno
// è ZERO, quindi l'ordine rischia di oscillare dentro/fuori consumando invii». È esatto, ed è
// aritmetico. Un ordine posato sull'ULTIMO prezzo di griglia ancora premiante dista dal bordo meno di
// un tick (su banda 4,5¢ con tick 1¢: il prezzo più esterno è a 4¢ dal mid, il bordo è a 4,5¢, quindi
// **mezzo tick**). Basta che il mid si muova di un tick perché l'ordine esca dalla banda; l'isteresi di
// `auto-reprice` (1 tick) copre quel primo tick, ma il rientro riporta l'ordine di nuovo a mezzo tick
// dal bordo — cioè lo stato dopo il rientro è identico allo stato prima dell'uscita. È un trigger senza
// asimmetria, e un trigger senza asimmetria oscilla: il mid respira di due tick e ogni respiro costa un
// cancel+place.
//
// ═══ LA CURA: UN TRIGGER DI SCHMITT, cioè due soglie DIVERSE ═══════════════════════════════════════
// Si esce dalla banda a `v + isteresi`; si RIENTRA a `v − margine`. Fra le due c'è una banda morta di
// `isteresi + margine` tick, e dopo ogni rientro l'ordine ha di nuovo tutto il margine davanti a sé.
// Con isteresi 1 tick e margine 1 tick il mid deve percorrere **3 tick** invece di 2 per produrre un
// secondo movimento, e — la parte che conta — non esiste più nessuno stato in cui un movimento di UN
// tick riporta l'ordine fuori.
//
// ⚠ NON TOCCA `hysteresisTicks` NÉ `confirmSamples`: l'operatore ha chiesto di tenerli, e restano
// esattamente dov'erano. Questo agisce sull'altro lato del ciclo — DOVE si rientra, non QUANDO si esce.
//
// ═══ E COSTA MENO DI ZERO, MISURATO SULLA FORMULA DEL VENUE ═══════════════════════════════════════
// `S(v,s) = ((v−s)/v)²`. Sulla banda modale (v = 4,5¢, tick 1¢):
//     al bordo esterno   s = 4¢ ⇒ S = ((4,5−4)/4,5)² = **0,0123**
//     un tick più dentro s = 3¢ ⇒ S = ((4,5−3)/4,5)² = **0,1111**
// cioè il margine che spegne l'oscillazione fa anche **×9 il punteggio per ordine**. È la stessa cosa
// che §5-bis p.152 aveva già misurato dall'altra parte: al bordo estremo non matura quasi niente **per
// costruzione**, perché la curva è quadratica e lì vale zero. Il bordo esterno resta l'INTENZIONE — è
// il posto più lontano dal mid, quindi quello con meno rischio di fill — ma «più lontano possibile»
// non può voler dire «sul punto in cui il premio è zero e l'ordine sbatte».
//
// DIFETTO 1 TICK. Zero è ammesso e ripristina esattamente il comportamento precedente (bordo nudo);
// un valore illeggibile vale il DIFETTO, non zero — la stessa regola di `end-of-scale`: un env
// sbagliato non può spegnere una protezione.
const ENV_MARGINE_BORDO = 'MAKER_DISTANZA_MARGINE_BORDO_TICK';
const MARGINE_BORDO_TICK_DEFAULT = 1;

/**
 * ⚠ UN TICK NON BASTA, E LO HA DETTO L'ANTEPRIMA DEL PIANO (15 agosto 2026).
 *
 * Il margine misurato in TICK non è adattivo al mercato: è adattivo alla GRIGLIA, che è un'altra cosa.
 * Sui tre mercati di questa configurazione i tick sono due:
 *     «1 Fed rate cut»  tick 1,0¢  ⇒ 1 tick = **22%** della banda (v = 4,5¢)
 *     «Ballon d'Or»     tick 0,1¢  ⇒ 1 tick = **2,2%** della banda
 * cioè sul secondo l'ordine finiva a 4,4¢ dal mid con un punteggio di **0,0011** — praticamente il
 * bordo nudo, cioè esattamente il problema che il margine esiste per risolvere. Un margine di un tick
 * su una griglia fine non è un margine: è un arrotondamento.
 *
 * Il margine vero si esprime quindi come FRAZIONE DI `v`, che è la sola grandezza confrontabile fra
 * mercati — la stessa ragione per cui la manopola della distanza è una frazione e non dei centesimi.
 *
 * ⚠ E IL VALORE NON È UN NUMERO NUOVO: **0,22 è quanto vale UN TICK sulla banda modale** (1,0¢ su
 * v = 4,5¢), cioè la regola «un tick di margine» generalizzata a qualunque griglia invece di
 * abbandonata. Sui mercati a tick grosso il comportamento non cambia di un centesimo; su quelli a
 * tick fine il margine diventa dieci tick e l'ordine si posa dove si posa sugli altri.
 *
 * IL PIÙ LARGO DEI DUE VINCE (`max`), e il risultato si arrotonda SEMPRE a un numero intero di tick
 * verso l'alto: un margine non esprimibile sulla griglia verrebbe mangiato dall'arrotondamento.
 */
const ENV_MARGINE_FRAZIONE = 'MAKER_DISTANZA_MARGINE_BORDO_FRAZIONE_V';
const MARGINE_BORDO_FRAZIONE_DEFAULT = 0.22;

/**
 * IL TETTO DEL MARGINE: metà del raggio di banda. Non è una manopola e non ha un env — è il confine
 * fra «margine» e «un altro prezzo». Oltre `v/2` l'ordine sta nella metà INTERNA della banda, cioè
 * più vicino al mid che al bordo, e chi ha chiesto il bordo esterno ha ottenuto il contrario.
 * Non si legge da `.env` di proposito: un margine che può diventare il mid è un rischio di fill, e
 * i rischi non si aprono con una variabile d'ambiente.
 */
const FRAZIONE_MASSIMA_DEL_RAGGIO = 0.5;

/** Quanti tick di margine si tengono dal bordo premiante. Mai negativo, mai illeggibile ⇒ difetto. */
function leggiMargineBordoTick(env = process.env) {
  const raw = env && env[ENV_MARGINE_BORDO];
  if (raw === undefined || raw === null || String(raw).trim() === '') return MARGINE_BORDO_TICK_DEFAULT;
  const v = Number(raw);
  if (!fin(v) || v < 0) return MARGINE_BORDO_TICK_DEFAULT;
  return Math.floor(v);
}

/** La frazione di `v` sotto la quale il margine non scende. Illeggibile ⇒ difetto, mai zero. */
function leggiMargineBordoFrazione(env = process.env) {
  const raw = env && env[ENV_MARGINE_FRAZIONE];
  if (raw === undefined || raw === null || String(raw).trim() === '') return MARGINE_BORDO_FRAZIONE_DEFAULT;
  const v = Number(raw);
  if (!fin(v) || v < 0 || v >= 1) return MARGINE_BORDO_FRAZIONE_DEFAULT;
  return v;
}

/**
 * IL MARGINE EFFETTIVO IN TICK per un mercato, dato il suo tick e la sua banda.
 * `max(margine in tick, frazione di v)`, arrotondato in su a un intero di tick, **poi limitato a
 * metà banda**.
 *
 * ⚠ IL TETTO A `v/2` NON È UN DETTAGLIO: senza, su una banda stretta il margine mangia la banda e
 * l'ordine finisce **sul mid**, cioè esattamente l'opposto del bordo esterno che si voleva. Misurato
 * sul selfcheck del riprezzo: banda ±1,5¢ con tick 1,0¢ ⇒ un tick di margine porta il bersaglio da
 * 0,52 a 0,53, che È il mid. Il margine difende il bordo, non lo sostituisce col centro.
 * **Il tetto può portare il margine a ZERO**, e allora il bordo torna nudo: su una banda più stretta
 * di due tick non c'è spazio per un margine, e dirlo è più onesto che inventarlo.
 *
 * Banda non leggibile ⇒ resta il solo margine in tick: non si inventa una frazione di un numero assente.
 */
function margineEffettivoTick({ tick = null, maxSpreadCents = null, margineTick = undefined, frazione = undefined, env = process.env } = {}) {
  const base = margineTick === undefined ? leggiMargineBordoTick(env)
    : (fin(margineTick) && margineTick >= 0 ? Math.floor(margineTick) : MARGINE_BORDO_TICK_DEFAULT);
  const v = raggioBandaCents(maxSpreadCents);
  if (v == null || !fin(tick) || tick <= 0) return base;
  const fr = frazione === undefined ? leggiMargineBordoFrazione(env)
    : (fin(frazione) && frazione >= 0 && frazione < 1 ? frazione : MARGINE_BORDO_FRAZIONE_DEFAULT);
  const tickC = tick * 100;
  const tettoTick = Math.floor(+((v * FRAZIONE_MASSIMA_DEL_RAGGIO) / tickC).toFixed(9));
  if (fr <= 0) return Math.min(base, tettoTick);
  const daFrazione = Math.ceil(+((fr * v) / tickC).toFixed(9));
  return Math.min(Math.max(base, daFrazione), tettoTick);
}

/**
 * I BORDI DELLA BANDA RISTRETTI DEL MARGINE — l'unica aritmetica del margine, in un punto solo.
 *
 * `lo` sale e `hi` scende, cioè la zona ammessa si stringe verso il mid da entrambi i lati. È la
 * direzione sicura: non può mai produrre un prezzo FUORI banda, solo uno più dentro.
 *
 * ⚠ SE IL MARGINE NON CI STA, NON SI APPLICA. Su una banda stretta (o con un tick grosso) `lo + m`
 * potrebbe superare `hi − m`, cioè la zona ammessa sarebbe vuota: allora si restituiscono i bordi
 * ORIGINALI e lo si dichiara. Un margine che non ci sta è un margine assente, mai una banda invalida.
 *
 * @returns {{lo:number|null, hi:number|null, margineTick:number, applicato:boolean, motivo:string}}
 */
function bordiConMargine({ bandLo = null, bandHi = null, tick = null, maxSpreadCents = null,
  margineTick = undefined, frazione = undefined, env = process.env } = {}) {
  const m = margineEffettivoTick({ tick, maxSpreadCents, margineTick, frazione, env });
  const grezzi = (motivo) => ({ lo: fin(bandLo) ? bandLo : null, hi: fin(bandHi) ? bandHi : null, margineTick: m, applicato: false, motivo });
  if (m <= 0) return grezzi('margine 0 tick: il bordo premiante resta nudo, comportamento di prima');
  if (!fin(tick) || tick <= 0) return grezzi('tick non leggibile: nessun margine (non si converte un tick che non si conosce)');
  if (!fin(bandLo) || !fin(bandHi)) return grezzi('bordi di banda non leggibili: nessun margine');
  const d = m * tick;
  const lo = +(bandLo + d).toFixed(10);
  const hi = +(bandHi - d).toFixed(10);
  if (!(lo <= hi + 1e-12)) {
    return grezzi(`margine di ${m} tick (${(d * 200).toFixed(2)}¢ sui due lati) piu' largo della banda [${bandLo}, ${bandHi}]: NON applicato, si torna ai bordi nudi`);
  }
  return { lo, hi, margineTick: m, applicato: true,
    motivo: `bordi stretti di ${m} tick per lato: [${lo}, ${hi}] invece di [${bandLo}, ${bandHi}]` };
}

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
function applicaObiettivo({ prezzo = null, scoringMid = null, bandLo = null, bandHi = null,
  distanzaC = null, tick = null, maxSpreadCents = null, margineTick = undefined, env = process.env } = {}) {
  const dist = (p) => (fin(p) && fin(scoringMid) ? +Math.abs((scoringMid - p) * 100).toFixed(3) : null);
  if (!fin(prezzo) || !fin(scoringMid) || !fin(distanzaC) || distanzaC <= 0) {
    return { prezzo, spostato: false, alBordo: false, distanzaEffettivaC: dist(prezzo), margine: null, motivo: 'nessun obiettivo da applicare' };
  }
  const obiettivo = scoringMid - distanzaC / 100;
  // ⚠ SOLO PIÙ LONTANO: `Math.min` nello spazio bid. Se le regole di sempre hanno già messo il prezzo
  // più lontano dell'obiettivo, l'obiettivo non lo riavvicina — sarebbe risalire nella coda, cioè
  // esattamente ciò che «mai primo sul libro» vieta.
  let p = Math.min(prezzo, obiettivo);
  let alBordo = false;

  // ── IL PALETTO, ORA CON MARGINE ────────────────────────────────────────────────────────────────
  // Il pavimento non è più il bordo nudo `bandLo` ma `bandLo + margine·tick` (vedi `bordiConMargine`).
  //
  // ⚠⚠ E IL PAVIMENTO NON PUÒ MAI SUPERARE IL PREZZO CHE LE REGOLE DI SEMPRE HANNO SCELTO. Questa
  // riga è la sola cosa che tiene in piedi «mai primo sul libro» dentro questa modifica: alzare il
  // pavimento significa spingere il prezzo VERSO il mid, cioè verso la cima del libro, e se il prezzo
  // di partenza (un tick dietro il miglior bid altrui) stesse già sotto il pavimento, applicarlo ci
  // metterebbe al livello del concorrente. Il `Math.min` lo rende impossibile per costruzione: da qui
  // esce sempre un prezzo ≤ `prezzo`. Quando il margine non ci sta si perde il margine, mai la regola.
  const bordi = bordiConMargine({ bandLo, bandHi, tick, maxSpreadCents, margineTick, env });
  const pavimentoGrezzo = fin(bordi.lo) ? bordi.lo : (fin(bandLo) ? bandLo : null);
  const pavimento = fin(pavimentoGrezzo) ? Math.min(pavimentoGrezzo, prezzo) : null;
  const margineCeduto = fin(pavimentoGrezzo) && fin(pavimento) && pavimento < pavimentoGrezzo - 1e-12;

  if (fin(pavimento) && p < pavimento) { p = pavimento; alBordo = true; }
  if (fin(tick) && tick > 0) {
    // Si arrotonda ALLONTANANDOSI dal mid (floor nello spazio bid), mai avvicinandosi: arrotondare
    // verso il mid rimetterebbe l'ordine davanti a qualcuno per un errore di griglia.
    const g = Math.floor(+(p / tick).toFixed(9)) * tick;
    const gs = +g.toFixed(9);
    if (fin(pavimento) && gs < pavimento) { p = pavimento; alBordo = true; } else if (fin(gs)) { p = gs; }
  }
  const spostato = +p.toFixed(9) !== +prezzo.toFixed(9);
  const margine = { tick: bordi.margineTick, applicato: bordi.applicato && !margineCeduto,
    ceduto: margineCeduto, motivo: margineCeduto
      ? 'il margine dal bordo avrebbe alzato il prezzo sopra quello di «un tick dietro il migliore»: CEDUTO, la regola della coda viene prima'
      : bordi.motivo };
  return {
    prezzo: +p.toFixed(9), spostato, alBordo, distanzaEffettivaC: dist(p), margine,
    motivo: !spostato ? 'le regole di sempre erano già oltre l\'obiettivo: niente da spostare'
      : alBordo ? `obiettivo ${distanzaC.toFixed(2)}¢ oltre il bordo ammesso: fermato a ${dist(p)}¢ dal mid`
        + (margine.applicato ? ` (bordo premiante meno ${margine.tick} tick di margine)` : ' (bordo premiante nudo)')
        : `spostato all'obiettivo: ${dist(p)}¢ dal mid`,
  };
}

module.exports = {
  ENV_FRAZIONE, FRAZIONE_DEFAULT, FRAZIONE_MASSIMA,
  ENV_MARGINE_BORDO, MARGINE_BORDO_TICK_DEFAULT,
  ENV_MARGINE_FRAZIONE, MARGINE_BORDO_FRAZIONE_DEFAULT, FRAZIONE_MASSIMA_DEL_RAGGIO,
  leggiFrazione, leggiMargineBordoTick, leggiMargineBordoFrazione, margineEffettivoTick, bordiConMargine,
  distanzaObiettivoCents, applicaObiettivo,
};

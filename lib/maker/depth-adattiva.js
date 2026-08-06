'use strict';
// lib/maker/depth-adattiva.js — A QUALE LIVELLO SI PIAZZA, CERCANDOLO INVECE DI IMPORLO.
//
// ═══ COSA SOSTITUISCE ════════════════════════════════════════════════════════════════════════════════
// `lib/maker/depth-guard.js` (rimosso con questo lavoro) faceva UNA domanda binaria, con UNA soglia
// ($50 davanti, ≤40% del livello) uguale per ogni mercato: «questo livello va bene, sì o no?».
//
// Due difetti, ed entrambi contano:
//   · UNA SOGLIA PER TUTTI. Un mercato Safe e uno Risk non corrono lo stesso rischio, e chiedere loro
//     la stessa profondità significa o essere troppo larghi sul primo o troppo stretti sul secondo.
//   · UNA DOMANDA BINARIA. «No» non diceva dove andare. Il livello successivo dentro banda poteva
//     essere perfetto e nessuno lo guardava: si rinunciava al mercato invece di spostarsi di un tick.
//
// Qui la domanda è un'altra: «QUALE livello dentro la banda soddisfa il pavimento?». Si cerca, e ci si
// ferma al PRIMO che basta — il pavimento è un minimo da superare, non un bersaglio da massimizzare.
// Andare oltre vorrebbe dire allontanarsi dal mid senza motivo, cioè maturare meno.
//
// ═══ DUE PERCORSI, MAI MESCOLATI ═════════════════════════════════════════════════════════════════════
// `findAdaptiveDepthLevelSafe` e `findAdaptiveDepthLevelRisk` non si chiamano fra loro, non condividono
// nessuno stato, e nessuna delle due legge una costante dell'altra. Un mercato Safe non attraversa mai
// la seconda e viceversa. Entrambe sono PURE: nessun `fs`, nessuna rete, nessun orologio, nessuna cache
// — quindi possono essere chiamate a ogni giro del ciclo da 5s senza che il giro precedente le sporchi.
//
// ═══ I NOSTRI ORDINI NON SONO «GLI ALTRI» ════════════════════════════════════════════════════════════
// La sottrazione la fa `othersLadder` di top-of-book.js, che è già la funzione usata dal motore: toglie
// i nostri livello per livello e somma due nostri ordini sullo stesso prezzo. Non se ne scrive una
// seconda — è la regola che questo repo applica da quando il motore si è inseguito da solo.
//
// ═══ IL PRIMO LIVELLO NON SI CONSIDERA ═══════════════════════════════════════════════════════════════
// Entrambe le ricerche partono dal SECONDO livello dentro banda. Il primo è il top-of-book, ed è già
// governato dalla regola tick/banda (top-of-book.js): riconsiderarlo qui vorrebbe dire dare due
// risposte alla stessa domanda.

const { othersLadder } = require('./top-of-book');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ── COSTANTI SAFE ─────────────────────────────────────────────────────────────────────────────────
/** Pavimento di profondità altrui, cumulata dal 2° livello. MINIMO da superare, non bersaglio. */
const SAFE_DEPTH_FLOOR_USD = 15;
/** La nostra size non può superare questa quota del livello scelto (nostra + altrui). */
const SAFE_MAX_SELF_SHARE = 0.65;

// ── COSTANTI RISK ─────────────────────────────────────────────────────────────────────────────────
/** Pavimento di profondità altrui, valutato SUL SINGOLO livello (non cumulato). */
const RISK_DEPTH_FLOOR_USD = 20;
/** Quanti livelli si provano, oltre il primo: il 2° e il 3° (o 3° e 4° se il mercato è nervoso). */
const RISK_MAX_TENTATIVI = 2;

/**
 * I livelli DENTRO la banda, ordinati dal tocco verso il bordo, coi nostri già sottratti.
 * Restituisce `null` quando la scala non è leggibile: un'incognita, non una lista vuota.
 */
function livelliInBanda({ bookLevels, bandBounds, ownOrders, tick, side }) {
  const altrui = othersLadder({ levels: bookLevels, ownOrders: ownOrders || [], tick });
  if (altrui.readable !== true) return { ok: false, reason: `profondità non leggibile: ${altrui.reason}`, livelli: null };
  if (!bandBounds || !fin(bandBounds.lo) || !fin(bandBounds.hi)) {
    return { ok: false, reason: 'banda premiante non calcolabile', livelli: null };
  }
  const dentro = altrui.levels
    .filter((l) => l && fin(l.price) && fin(l.size) && l.size > 0)
    .filter((l) => l.price >= bandBounds.lo - 1e-9 && l.price <= bandBounds.hi + 1e-9)
    // Dal MIGLIORE verso il bordo: per un BID «migliore» è più alto, per un ASK più basso.
    .sort((a, b) => (side === 'SELL' ? a.price - b.price : b.price - a.price));
  return { ok: true, reason: null, livelli: dentro };
}

/** La quota che la nostra size occuperebbe su un livello con `altruiSize` di altri. */
function quotaNostra(proposedSize, altruiSize) {
  const tot = altruiSize + proposedSize;
  return tot > 0 ? proposedSize / tot : 1;
}

/**
 * PERCORSO SAFE — profondità CUMULATA, con tetto di quota sul livello scelto.
 *
 * Si parte dal 2° livello in banda e si somma la size altrui livello per livello andando verso il
 * bordo. Appena la cumulata raggiunge SAFE_DEPTH_FLOOR_USD ci si ferma su QUEL livello — a patto che
 * la nostra size non ne occupi più di SAFE_MAX_SELF_SHARE. Se la occupa, quel livello si scarta e si
 * continua col successivo (la cumulata NON si azzera: la profondità già contata resta davanti).
 *
 * Banda finita senza raggiungere il pavimento ⇒ nessun livello valido, skip.
 *
 * @param {object} a
 *   marketId, side, bookLevels, bandBounds {lo,hi}, ownOrders, ownOrderIds, proposedSize, tick
 * @returns {{ok:boolean, price:number|null, level:number|null, reason:string,
 *            depthAheadUsd:number|null, selfShare:number|null, scartati:Array}}
 */
function findAdaptiveDepthLevelSafe({
  marketId = null, side = 'BUY', bookLevels = null, bandBounds = null,
  ownOrders = [], ownOrderIds = null, proposedSize = null, tick = null,
} = {}) {
  const no = (reason, extra = {}) => ({
    ok: false, price: null, level: null, reason, marketId,
    depthAheadUsd: null, selfShare: null, scartati: [], ...extra,
  });

  if (!fin(proposedSize) || proposedSize <= 0) return no(`size proposta non valutabile (${proposedSize})`);
  const scala = livelliInBanda({ bookLevels, bandBounds, ownOrders, tick, side });
  if (!scala.ok) return no(`${scala.reason} — un dato mancante non è un via libera`);
  if (scala.livelli.length < 2) {
    return no(`dentro la banda c'è ${scala.livelli.length} livello: la ricerca parte dal secondo e non c'è`);
  }

  let cum = 0;
  const scartati = [];
  // i = 1 → il SECONDO livello. Il primo è del controllo tick/banda.
  for (let i = 1; i < scala.livelli.length; i++) {
    const l = scala.livelli[i];
    cum += l.price * l.size;
    if (cum + 1e-9 < SAFE_DEPTH_FLOOR_USD) continue;

    const q = quotaNostra(proposedSize, l.size);
    if (q > SAFE_MAX_SELF_SHARE + 1e-9) {
      // IL PAVIMENTO È RAGGIUNTO MA IL LIVELLO È TROPPO NOSTRO: si prova il successivo, non si rinuncia.
      scartati.push({ level: i + 1, price: l.price, selfShare: +q.toFixed(4), motivo: 'quota nostra oltre il tetto' });
      continue;
    }
    return {
      ok: true, price: l.price, level: i + 1, marketId,
      reason: `profondità altrui cumulata $${cum.toFixed(2)} ≥ pavimento $${SAFE_DEPTH_FLOOR_USD} al livello ${i + 1}`
        + ` (${(q * 100).toFixed(1)}% nostro, tetto ${(SAFE_MAX_SELF_SHARE * 100).toFixed(0)}%)`,
      depthAheadUsd: +cum.toFixed(4), selfShare: +q.toFixed(4), scartati,
    };
  }
  return no(
    `la banda finisce prima del pavimento: $${cum.toFixed(2)} cumulati su ${scala.livelli.length - 1} livelli`
    + ` contro un minimo di $${SAFE_DEPTH_FLOOR_USD}`
    + (scartati.length ? ` · ${scartati.length} livello/i scartato/i per quota nostra troppo alta` : ''),
    { depthAheadUsd: +cum.toFixed(4), scartati },
  );
}

/**
 * PERCORSO RISK — profondità SUL SINGOLO livello, due tentativi, spostati di uno se il mercato è nervoso.
 *
 * Base: si prova il 2° livello in banda; se la size altrui LÌ non raggiunge RISK_DEPTH_FLOOR_USD si
 * prova il 3°. Se nemmeno il 3° basta, skip: non c'è un quarto tentativo.
 *
 * `nervousMarket: true` sposta la ricerca di UN tick più lontano dal mid — quindi 3° e 4° invece di 2° e
 * 3°. Se il livello spostato cade FUORI dalla banda premiante, skip: allontanarsi oltre il punto in cui
 * si smette di maturare non protegge da niente, toglie solo il ricavo.
 *
 * DIFFERENZA DELIBERATA DA SAFE: qui la soglia è sul SINGOLO livello, non cumulata. Su un mercato Risk
 * la domanda non è «quanta roba ho davanti in tutto» ma «il gradino su cui mi appoggio regge da solo».
 *
 * @returns {{ok:boolean, price:number|null, level:number|null, reason:string,
 *            depthAtLevelUsd:number|null, nervous:boolean, tentativi:Array}}
 */
function findAdaptiveDepthLevelRisk({
  marketId = null, side = 'BUY', bookLevels = null, bandBounds = null,
  ownOrders = [], ownOrderIds = null, tick = null, nervousMarket = false,
} = {}) {
  const nervous = nervousMarket === true;
  const no = (reason, extra = {}) => ({
    ok: false, price: null, level: null, reason, marketId, nervous,
    depthAtLevelUsd: null, tentativi: [], ...extra,
  });

  const scala = livelliInBanda({ bookLevels, bandBounds, ownOrders, tick, side });
  if (!scala.ok) return no(`${scala.reason} — un dato mancante non è un via libera`);

  // Indici da provare. Base: 1 e 2 (2° e 3° livello). Nervoso: 2 e 3 (3° e 4°).
  const partenza = nervous ? 2 : 1;
  const indici = [];
  for (let k = 0; k < RISK_MAX_TENTATIVI; k++) indici.push(partenza + k);

  const tentativi = [];
  for (const i of indici) {
    if (i >= scala.livelli.length) {
      // Il livello richiesto NON esiste dentro la banda: uscirebbe dal perimetro premiante.
      tentativi.push({ level: i + 1, esito: 'fuori banda', depthUsd: null });
      continue;
    }
    const l = scala.livelli[i];
    const usd = l.price * l.size;
    if (usd + 1e-9 >= RISK_DEPTH_FLOOR_USD) {
      return {
        ok: true, price: l.price, level: i + 1, marketId, nervous,
        reason: `livello ${i + 1}${nervous ? ' (spostato di un tick: mercato nervoso)' : ''}:`
          + ` $${usd.toFixed(2)} di altri ≥ pavimento $${RISK_DEPTH_FLOOR_USD}`,
        depthAtLevelUsd: +usd.toFixed(4), tentativi,
      };
    }
    tentativi.push({ level: i + 1, esito: 'sotto il pavimento', depthUsd: +usd.toFixed(4) });
  }

  const fuoriBanda = tentativi.every((t) => t.esito === 'fuori banda');
  return no(
    fuoriBanda
      ? `${nervous ? 'spostandosi di un tick per il mercato nervoso, ' : ''}i livelli da provare cadono fuori dalla banda premiante:`
        + ' allontanarsi oltre la banda non protegge, toglie solo il reward'
      : `nessuno dei ${tentativi.length} livelli provati raggiunge il pavimento di $${RISK_DEPTH_FLOOR_USD}`
        + ` (${tentativi.map((t) => `liv.${t.level}: ${t.depthUsd == null ? 'fuori banda' : `$${t.depthUsd.toFixed(2)}`}`).join(', ')})`,
    { tentativi },
  );
}

module.exports = {
  findAdaptiveDepthLevelSafe,
  findAdaptiveDepthLevelRisk,
  livelliInBanda,
  SAFE_DEPTH_FLOOR_USD,
  SAFE_MAX_SELF_SHARE,
  RISK_DEPTH_FLOOR_USD,
  RISK_MAX_TENTATIVI,
};

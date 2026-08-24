'use strict';
// lib/maker/venue-rules.js — the ONE shared venue-rules validator (Part B1–B3).
//
// Pure, node + browser importable. Input: the market's LIVE venue rules + a quote (side, price, size).
// Output: { valid, reasons:[{ code, detail }] } with MACHINE-READABLE reason codes. This is the SINGLE
// source of truth for "is this quote placeable under the reward program's rules" — the UI band warning
// CALLS this function (it must never reimplement the check). Wiring it into the maker placement path is a
// separate, out-of-scope step; this build uses it for the UI warning only.
//
// FAIL CLOSED. If any rule needed to judge a market cannot be read (tick, scoring mid, max spread, min
// size), every quote for that market is INVALID with reason RULES_UNREADABLE. Never fall back to a default
// band, never guess a tick.
//
// NO PARALLEL BAND MATH. The band test reuses the SSOT (lib/rewards-live-band.inBand): a quote is in-band
// iff |price − scoringMid|·100 ≤ maxSpread cents (rewardScore's v = maxSpread). An order at exactly the
// band radius scores 0, so the warning fires precisely when the reward score collapses to 0 — never on a
// looser or a fabricated band.

const { inBand } = require('../rewards-live-band');
const { raggioBandaCents, raggioBandaPrezzo } = require('../banda-premiante');

// Machine-readable reason codes. One per distinct rule, plus the fail-closed unreadable code.
const CODES = Object.freeze({
  OFF_TICK: 'OFF_TICK',                     // price is not a multiple of the market tick
  OUT_OF_BAND: 'OUT_OF_BAND',               // |price − scoringMid| > raggioBandaCents(maxSpread) → scores 0 reward
  BELOW_MIN_SIZE: 'BELOW_MIN_SIZE',         // size < min_incentive_size (or ≤ 0)
  // ── I DUE CODICI DEL PERCORSO D'USCITA — 24 agosto 2026 ───────────────────────────────────────
  // Un'USCITA non fa la domanda del premio, fa quella del venue: «questo ordine verra' accettato?».
  // La risposta e' `minimum_order_size` (5), non `rewards.min_size` (20/50). Vedi la nota estesa su
  // `validateQuote` e `lib/maker/minimi-del-venue.js`.
  BELOW_MIN_ORDER_SIZE: 'BELOW_MIN_ORDER_SIZE',       // size < minimum_order_size ⇒ il venue RIFIUTA
  MIN_ORDER_SIZE_UNREADABLE: 'MIN_ORDER_SIZE_UNREADABLE', // non pubblicato: non si indovina, ci si ferma
  PRICE_OUT_OF_RANGE: 'PRICE_OUT_OF_RANGE', // price outside the venue's [tick, 1−tick] range
  RULES_UNREADABLE: 'RULES_UNREADABLE',     // a rule could not be read → fail closed
});

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

// On-tick test: price is a multiple of tick within FP tolerance. Mirrors the venue's priceValid.
function isOnTick(price, tick) {
  if (!fin(price) || !(tick > 0)) return false;
  const snapped = Math.round(price / tick) * tick;
  return Math.abs(price - snapped) < tick / 1000;
}

// Are ALL rules needed to judge this market present and sane? (tick>0, mid∈(0,1), band>0, minSize≥0.)
function rulesReadable(rules) {
  return !!rules
    && fin(rules.tick) && rules.tick > 0
    && fin(rules.scoringMid) && rules.scoringMid > 0 && rules.scoringMid < 1
    && fin(rules.maxSpreadCents) && rules.maxSpreadCents > 0
    && fin(rules.minSize) && rules.minSize >= 0;
}

/**
 * Validate ONE quote leg against a market's live venue rules.
 * @param {{ tick:number, scoringMid:number, maxSpreadCents:number, minSize:number, priceMin?:number, priceMax?:number }} rules
 * @param {{ side?:'BUY'|'SELL', price:number, size:number }} quote   size in SHARES
 * @returns {{ valid:boolean, reasons: Array<{code:string, detail:string}> }}
 */
function validateQuote(rules, quote) {
  if (!rulesReadable(rules)) {
    return { valid: false, avvisi: [], reasons: [{
      code: CODES.RULES_UNREADABLE,
      detail: 'venue rules (tick / scoring mid / max spread / min size) could not be read for this market — refusing (fail closed)',
    }] };
  }
  const q = quote || {};
  const reasons = [];
  // ⚠ GLI AVVISI NON SONO MOTIVI. Un ordine di uscita sotto il pavimento premiante e' VALIDO e non
  // matura premio: e' un costo dichiarato, non un divieto. Sta in una lista separata perche' chi
  // conta i motivi bloccanti non deve trovarcelo dentro (e' l'errore che questo file gia' evita per
  // `OUT_OF_BAND`, con `splitVerdict`).
  const avvisi = [];
  const tick = rules.tick;
  // Venue price range: [tick, 1−tick] unless the market overrides it. STRICTLY inside is enforced below.
  const priceMin = fin(rules.priceMin) ? rules.priceMin : tick;
  const priceMax = fin(rules.priceMax) ? rules.priceMax : (1 - tick);

  if (!fin(q.price)) {
    reasons.push({ code: CODES.PRICE_OUT_OF_RANGE, detail: 'price is missing' });
  } else {
    if (q.price < priceMin - 1e-12 || q.price > priceMax + 1e-12) {
      reasons.push({ code: CODES.PRICE_OUT_OF_RANGE, detail: `price ${q.price} is outside the venue range [${priceMin}, ${priceMax}]` });
    }
    if (!isOnTick(q.price, tick)) {
      reasons.push({ code: CODES.OFF_TICK, detail: `price ${q.price} is not a multiple of tick ${tick}` });
    }
    if (!inBand(q.price, rules.scoringMid, rules.maxSpreadCents)) {
      const distC = Math.abs(q.price - rules.scoringMid) * 100;
      reasons.push({ code: CODES.OUT_OF_BAND, detail: `|price − scoring mid| ${distC.toFixed(2)}¢ exceeds the reward band ±${(raggioBandaCents(rules.maxSpreadCents)).toFixed(2)}¢ — earns no reward` });
    }
  }

  if (!fin(q.size) || q.size <= 0) {
    reasons.push({ code: CODES.BELOW_MIN_SIZE, detail: 'size is missing or ≤ 0' });
  } else if (q.uscita === true) {
    // ══ UN'USCITA SI MISURA SUL MINIMO D'ORDINE, MAI SUL PAVIMENTO PREMIANTE ═══════════════════════
    //
    // ⚠ IL FATTO, misurato sulle 24 ore del 24 agosto 2026: **22.206** rifiuti `BELOW_MIN_SIZE` sul
    // percorso d'uscita, su quattro mercati. Tre erano residui da 2,01 · 2,8461 · 4,85 share, sotto
    // entrambi i minimi, e il bot aveva ragione **per caso**. Il quarto — `0x65109969…` — era una
    // VENDITA da **15,4 share a 25¢ con carico 21¢**, cioe' un'uscita in profitto di 4¢: rifiutata
    // **282 volte** perche' 15,4 < 20, dove il numero che decide davvero e' 5. Un'uscita in guadagno
    // bloccata da un numero letto per un'altra domanda.
    //
    // ⚠ E' LA STESSA CLASSE «regola nata per limitare l'APERTURA applicata a un'azione che non apre»
    // (quinta occorrenza). `min_incentive_size` dice «questo ordine non maturera' premio»: su
    // un'uscita il premio non e' lo scopo, e il capitale si LIBERA invece di immobilizzarsi.
    //
    // ⚠ SI FERMA RUMOROSAMENTE INVECE DI RIPIEGARE. Minimo d'ordine non pubblicato per questo mercato
    // ⇒ **non si indovina e non si torna al pavimento premiante**: si rifiuta nominando il
    // `conditionId`, cosi' chi legge sa QUALE mercato e' senza dedurlo. Un ripiego sul pavimento
    // sarebbe il difetto di oggi promosso a regola; un valore di difetto sarebbe peggio ancora,
    // perche' `Number(null) === 0` manderebbe al venue una size che nessuno ha giudicato (§5.3).
    // ⚠ E IL PAVIMENTO PREMIANTE NON SPARISCE, si DECLASSA: viaggia come avviso, perche' «questa
    // uscita non matura premio» resta vero e va detto — semplicemente non e' piu' un divieto.
    const cid = typeof rules.marketId === 'string' && rules.marketId.trim() ? rules.marketId.trim() : null;
    if (!fin(rules.minOrderSize) || rules.minOrderSize <= 0) {
      reasons.push({ code: CODES.MIN_ORDER_SIZE_UNREADABLE,
        detail: `minimum_order_size non leggibile per ${cid || 'conditionId NON DICHIARATO dal chiamante'}`
          + ' — il percorso d\'uscita NON indovina e NON ripiega sul pavimento premiante'
          + `${fin(rules.minSize) ? ` (che qui vale ${rules.minSize} e risponde a un'altra domanda)` : ''}`
          + ': ordine rifiutato finche\' il venue non pubblica il minimo d\'ordine di questo mercato' });
    } else if (q.size < rules.minOrderSize) {
      reasons.push({ code: CODES.BELOW_MIN_ORDER_SIZE,
        detail: `size ${q.size} is below minimum_order_size ${rules.minOrderSize} on ${cid || 'questo mercato'}`
          + ' — il venue rifiuterebbe l\'ordine' });
    } else if (fin(rules.minSize) && q.size < rules.minSize) {
      // Sopra il minimo d'ordine e sotto il pavimento premiante: l'ordine e' VALIDO e non matura
      // premio. Su un'uscita e' esattamente cio' che si vuole, e resta scritto.
      avvisi.push({ code: CODES.BELOW_MIN_SIZE,
        detail: `size ${q.size} is below min_incentive_size ${rules.minSize} — earns nothing`
          + ' (ordine di USCITA: il premio non e\' lo scopo, e il venue lo accetta perche\' supera'
          + ` minimum_order_size ${rules.minOrderSize})` });
    }
  } else if (q.size < rules.minSize) {
    reasons.push({ code: CODES.BELOW_MIN_SIZE, detail: `size ${q.size} is below min_incentive_size ${rules.minSize} — earns nothing` });
  }

  return { valid: reasons.length === 0, reasons, avvisi };
}

/**
 * DUE DOMANDE DIVERSE, TENUTE SEPARATE IN UN PUNTO SOLO.
 *
 * `validateQuote` risponde a «questa quota rispetta le regole del programma premi?». Chi piazza un
 * ordine però ne fa un'altra: «il venue accetterà quest'ordine?». Per quattro codici su cinque le due
 * risposte coincidono — un prezzo fuori griglia del tick, fuori dai limiti di prezzo, una size sotto il
 * minimo, regole illeggibili: sono tutti motivi per cui l'ordine non si può mandare, o non si può
 * giudicare affatto.
 *
 * OUT_OF_BAND è l'eccezione, ed è l'unica. Non dice «il venue rifiuterà quest'ordine»: dice «quest'ordine
 * non maturerà reward». Il venue lo accetta eccome, e resta a riposo esattamente come chiesto. È un
 * COSTO, e un costo lo si dichiara a chi decide — non lo si trasforma in un divieto.
 *
 * Questa funzione fa quella separazione, e la fa QUI perché sia una sola: la corsia manuale, il motore di
 * market making e l'adapter la chiamano tutti, invece di ripetere ciascuno un `filter(r.code !== ...)`
 * che potrebbe divergere. Con `allowOutOfBand:false` (il default) il verdetto esce identico a com'è
 * entrato: nessun chiamante eredita la deroga senza chiederla.
 *
 * @param {{valid:boolean, reasons:Array<{code:string,detail:string}>}} verdict   uscita di validateQuote
 * @param {{allowOutOfBand?:boolean}} opts
 * @returns {{valid:boolean, reasons:Array<{code,detail}>, advisories:Array<{code,detail}>, outOfBand:boolean}}
 *          `reasons` contiene SOLO i motivi bloccanti; `advisories` quelli declassati (mai persi).
 */
// ══ `BELOW_MIN_SIZE` SU UN ORDINE CHE CHIUDE — 17 agosto 2026 ═══════════════════════════════════════
//
// ⚠ QUARTA OCCORRENZA DELLA CLASSE «regola nata per limitare l'APERTURA applicata a un'azione che non
// apre» (§5-bis p.133, p.147, p.168, §5.2 p.38). La ragione scritta accanto a questo codice e' che «un
// ordine sotto il minimo immobilizza capitale per un premio che vale zero»: e' esatta per una QUOTA e
// falsa per una CHIUSURA, dove il premio non e' lo scopo e il capitale si LIBERA invece di
// immobilizzarsi. `min_incentive_size` e' il minimo del programma PREMI, non il minimo di scambio.
//
// IL DANNO MISURATO (16 agosto, FL-27): un fill parziale di **1,82 share** ha chiuso TUTTE le vie in
// una volta — `merge-saltato-rinuncia` («il completamento sarebbe di 1,82 share, sotto il minimo»),
// `rimasuglio-rimanenza-reject-venue-rules`, `rimasuglio-controparte-aggressiva-reject-venue-rules`,
// `skip-remainder-below-min-size`. Ne' la scala ne' il merge potevano agire, e la sola ragione per cui
// non e' rimasto incagliato e' che il resto dell'ordine si e' riempito 65 secondi dopo. E' un caso.
// E' anche la forma esatta di §5.2 p.1: $26,30 in cinque residui che nessun percorso puo' chiudere.
//
// ⚠ QUELLO CHE NON SO, E VA DETTO: **non ho evidenza che il venue accetti un ordine sotto
// `min_incentive_size`** — e non posso averla, perche' oggi quell'ordine non viene MAI inviato. La
// deroga non afferma che passera': fa in modo che venga spedito e che sia il VENUE a rispondere. Se
// rifiuta, si ottiene un `reject-venue` pulito e si e' esattamente dove si e' adesso; se accetta, un
// residuo incagliato ha finalmente una via d'uscita. In nessuno dei due casi l'esposizione cresce:
// l'unica direzione possibile e' la riduzione.
//
// ⚠ E LA DEROGA E' OPT-IN E PROVATA, non una tolleranza generale: la concede solo chi passa
// `allowBelowMinSize`, e i chiamanti la accendono unicamente dietro la stessa prova di chiusura che
// gia' esenta il tetto per ordine e quello di esposizione. Con il difetto (false) il verdetto esce
// identico a com'e' entrato.
function splitVerdict(verdict, { allowOutOfBand = false, allowBelowMinSize = false } = {}) {
  // FAIL CLOSED PRIMA DI TUTTO. Senza questa riga un verdetto assente o malformato uscirebbe da qui
  // `valid:true` quando la deroga e' accesa — perche' «nessun motivo bloccante» e «nessun motivo letto»
  // avrebbero la stessa forma: una lista vuota. Sono l'opposto l'uno dell'altro, e il secondo deve
  // rifiutare. Un verdetto vero ha sempre `reasons` array, quindi questo non toglie nulla ai chiamanti
  // legittimi: costa solo al caso in cui qualcosa a monte si e' rotto in silenzio.
  if (!verdict || !Array.isArray(verdict.reasons)) {
    return { valid: false, reasons: [{ code: CODES.RULES_UNREADABLE, detail: 'verdetto di validazione assente o malformato — rifiuto (fail closed)' }], advisories: [], outOfBand: false };
  }
  const all = verdict.reasons;
  // ⚠ GLI AVVISI DI `validateQuote` ARRIVANO FIN QUI, o l'unica cosa che dice «questa uscita non
  // matura premio» sparirebbe fra il validatore e il giornale. Non sono derogabili: non erano
  // bloccanti nemmeno prima.
  const avvisiValidatore = Array.isArray(verdict.avvisi) ? verdict.avvisi : [];
  const outOfBand = all.some((r) => r.code === CODES.OUT_OF_BAND);
  // ⚠ SOLO IL «SOTTO IL MINIMO PREMIANTE», MAI IL «size assente o ≤ 0». Condividono il codice
  // `BELOW_MIN_SIZE` ma sono due fatti diversi: il primo dice «non maturera' premi», il secondo dice
  // «questo non e' un ordine». Si distinguono sul `detail`, che e' l'unico posto in cui il modulo li
  // separa gia' — e derogare al secondo vorrebbe dire spedire una size che non esiste.
  // ⚠⚠ E DAL 24 AGOSTO 2026 ANCHE `MIN_ORDER_SIZE_UNREADABLE` E' DEROGABILE DA UNA CHIUSURA PROVATA,
  // per la STESSA ragione scritta qui sopra e per una in piu'. La ragione uguale: la deroga non
  // afferma che il venue accettera' — fa in modo che l'ordine venga SPEDITO e che sia il venue a
  // rispondere, e l'unica direzione possibile resta la riduzione. La ragione in piu' e' operativa e
  // pesa: finche' `minimum_order_size` non e' popolato su un mercato — ed e' lo stato di OGNI mercato
  // finche' agent24 non riscrive il board col codice nuovo — senza questa riga il percorso d'uscita
  // rifiuterebbe TUTTE le chiusure, comprese le **5.313** che nelle 24 ore misurate passavano gia'
  // dalla deroga del pavimento premiante. Sarebbe curare 282 rifiuti con qualche migliaio di rifiuti
  // nuovi, cioe' un peggioramento travestito da correzione.
  // ⚠ `BELOW_MIN_ORDER_SIZE` INVECE NON SI DEROGA MAI, ed e' la differenza che conta: li' il minimo e'
  // stato LETTO e il venue rifiutera' con certezza. Non derogarlo e' STRETTAMENTE meglio di ieri —
  // toglie dalla rete i 21.889 invii che nelle stesse 24 ore erano rifiuti garantiti.
  const eSottoMinimo = (r) => (r.code === CODES.BELOW_MIN_SIZE && /below min_incentive_size/.test(String(r.detail || '')))
    || r.code === CODES.MIN_ORDER_SIZE_UNREADABLE;
  const sottoMinimo = all.some(eSottoMinimo);
  const deroga = (r) => (allowOutOfBand && r.code === CODES.OUT_OF_BAND) || (allowBelowMinSize && eSottoMinimo(r));
  if (!allowOutOfBand && !allowBelowMinSize) {
    return { valid: verdict.valid === true, reasons: all, advisories: [...avvisiValidatore], outOfBand, sottoMinimo };
  }
  const advisories = [...avvisiValidatore, ...all.filter(deroga)];
  const reasons = all.filter((r) => !deroga(r));
  return { valid: reasons.length === 0, reasons, advisories, outOfBand, sottoMinimo };
}

/**
 * B3 — qMin COUPLING. The published quadratic takes the MINIMUM across the two sides (Q_min), so a
 * two-sided quote is only as good as its WEAKER leg. Validate the PAIR, not each leg alone: if either leg
 * is out of band / off tick / under min, the whole two-sided quote is DEGRADED — the score collapses to
 * the weaker side. The caller shows the expected $/day for the DEGRADED case (which the shared quadratic
 * already produces, because it scores at the actual offset/size).
 *
 * @param {object} rules            same rules object as validateQuote
 * @param {{ side?, price, size }} bid   the buy leg (e.g. buy YES at mid − offset)
 * @param {{ side?, price, size }} ask   the sell leg (e.g. sell YES at mid + offset)
 * @returns {{ valid, degraded, both, bid, ask, weakerSide, reasons, note }}
 */
function validateQuotePair(rules, bid, ask) {
  if (!rulesReadable(rules)) {
    const un = { valid: false, reasons: [{ code: CODES.RULES_UNREADABLE, detail: 'venue rules could not be read — refusing (fail closed)' }] };
    return { valid: false, degraded: true, both: false, bid: un, ask: un, weakerSide: null,
      reasons: un.reasons, note: 'venue rules unreadable — cannot judge the two-sided quote (fail closed)' };
  }
  const bidV = validateQuote(rules, bid);
  const askV = validateQuote(rules, ask);
  const both = bidV.valid && askV.valid;
  const degraded = !both;
  // The weaker (score-limiting) side is the invalid one; if both invalid, neither leg earns.
  let weakerSide = null;
  if (!bidV.valid && askV.valid) weakerSide = 'bid';
  else if (bidV.valid && !askV.valid) weakerSide = 'ask';
  else if (!bidV.valid && !askV.valid) weakerSide = 'both';
  const reasons = [
    ...bidV.reasons.map((r) => ({ ...r, leg: 'bid' })),
    ...askV.reasons.map((r) => ({ ...r, leg: 'ask' })),
  ];
  const note = both
    ? 'both legs qualify'
    : weakerSide === 'both'
      ? 'neither leg qualifies — the two-sided score is 0'
      : `the ${weakerSide} leg does not qualify — the two-sided score (Q_min) collapses to the weaker side; the $/day shown is the degraded case`;
  return { valid: both, degraded, both, bid: bidV, ask: askV, weakerSide, reasons, note };
}

/**
 * The HIGHEST and LOWEST prices that a quote can rest at and still qualify: on the venue tick, inside the
 * reward band, inside the venue price range. This is what a form shows BEFORE the operator commits — "the
 * furthest you can go is 0.5205" — instead of refusing afterwards with a reason code.
 *
 * NO PARALLEL BAND MATH. The bounds are not derived from a formula of their own: a candidate is snapped to
 * the tick grid and then ASKED, through validateQuote, whether it qualifies — the same function the server
 * re-runs before any send. A candidate that fails is walked one tick inward and asked again. So the bounds
 * can never be looser than the guard (they are literally prices the guard accepted), and the float
 * behaviour at exactly the band radius is the guard's own, not a second interpretation of it.
 *
 * FAIL CLOSED: unreadable rules ⇒ { lo:null, hi:null, readable:false }. A form must not draw a boundary
 * around a band it could not read.
 *
 * `size` is only used to satisfy the validator's size check while probing the PRICE, so it defaults to the
 * market's own minimum — the bounds returned are about price alone.
 *
 * @param {{ tick:number, scoringMid:number, maxSpreadCents:number, minSize:number, priceMin?:number, priceMax?:number }} rules
 * @returns {{ readable:boolean, lo:number|null, hi:number|null, tick:number|null }}
 */
function inBandPriceBounds(rules) {
  if (!rulesReadable(rules)) return { readable: false, lo: null, hi: null, tick: null };
  const tick = rules.tick;
  const size = rules.minSize > 0 ? rules.minSize : 1;
  const radius = raggioBandaPrezzo(rules.maxSpreadCents);                 // half the band, in price units
  const priceMin = fin(rules.priceMin) ? rules.priceMin : tick;
  const priceMax = fin(rules.priceMax) ? rules.priceMax : (1 - tick);
  const ok = (p) => validateQuote(rules, { side: 'BUY', price: p, size }).valid;

  // Walk INWARD from the band edge, at most a handful of ticks: the first accepted price IS the bound.
  // (More than a couple of steps means the band is narrower than one tick, which the loop reports as null
  // rather than inventing a price the guard would refuse.)
  const MAX_STEPS = 4;
  const snap = (p) => +(Math.round(p / tick) * tick).toFixed(10);

  let hi = null;
  for (let i = 0; i <= MAX_STEPS; i++) {
    const cand = snap(rules.scoringMid + radius) - i * tick;
    const p = +cand.toFixed(10);
    if (p < priceMin - 1e-12) break;
    if (ok(p)) { hi = p; break; }
  }
  let lo = null;
  for (let i = 0; i <= MAX_STEPS; i++) {
    const cand = snap(rules.scoringMid - radius) + i * tick;
    const p = +cand.toFixed(10);
    if (p > priceMax + 1e-12) break;
    if (ok(p)) { lo = p; break; }
  }
  return { readable: true, lo, hi, tick };
}

module.exports = { validateQuote, validateQuotePair, splitVerdict, isOnTick, rulesReadable, inBandPriceBounds, CODES };

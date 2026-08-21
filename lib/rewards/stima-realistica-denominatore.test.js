'use strict';
// lib/rewards/stima-realistica-denominatore.test.js — LA STIMA REALISTICA USA IL COSTO DELLA COPPIA.
//
// ═══ IL DIFETTO CHE QUESTO TEST DIFENDE ═════════════════════════════════════════════════════════
// `lib/rewards/realistic-estimate.js:269` convertiva capitale→share con `(C/2)/mid`, cioe' la forma
// che l'intestazione di `lib/rewards/size-da-capitale.js` dichiara **sbagliata**: assume che ENTRAMBI
// i lati costino `mid`, vero solo a mid = 0,50. E' l'ultima copia della famiglia D1, dopo quelle gia'
// chiuse in `minSizeVerdict`, in `net.js`, in `curve.capitalToQualify` e in `rewardScore` (`ef6be4d`).
//
// ═══ IL DENOMINATORE GIUSTO, DAL VENUE ══════════════════════════════════════════════════════════
// Il venue scora SHARE. Una posa bilaterale simmetrica a `d` centesimi costa
//     (mid − d/100) + (1 − mid − d/100) = 1 − 2d/100      ⇐ IL MID SI CANCELLA
// quindi `size = C / (1 − 2d/100)`, e non dipende dal mid.
//
// ⚠ IL `/2` NON ERA UNA CONVENZIONE DEL CHIAMANTE. In `reward-price-row` (turno precedente) era il
// chiamante a dimezzare, e la correzione andava fatta LI'. Qui `capitalUsd` e' gia' il TOTALE
// (`allocate.js:167` costruisce i livelli con `capital: 2 * sizeUsd`), e il `/2` e' interno alla
// formula sbagliata: sparisce insieme a lei. Il blocco ④ lo verifica invece di darlo per buono.
//
// ⚠ MORDE SUL CALCOLO: si confronta il FATTORE di correzione prodotto — che dipende da `sizeShares` —
// con quello che `placementShareFactor` (funzione esportata, NON toccata) restituisce sulla size
// giusta. Nessuna stringa cercata nel sorgente, nessun conteggio di occorrenze.

const assert = require('assert');
const RE = require('./realistic-estimate');
const SDC = require('./size-da-capitale');
const { shareForCapital } = require('../../scripts/rewards-ceiling/lib/curve');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const vicino = (a, b, eps, m) => { assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps,
  `${m} — atteso ${b}, ottenuto ${a} (tolleranza ${eps})`); n++; };
// ⚠ LA TOLLERANZA SUI FATTORI RIPORTATI E' 5·10⁻⁵, E IL MOTIVO STA NEL CODICE: `corrections[].factor`
// esce da `+factor.toFixed(4)`, quindi non puo' essere confrontato piu' stretto di mezzo ultimo
// decimale. Per non ammorbidire nulla, OGNI blocco che usa questa tolleranza asserisce anche che il
// divario fra la size giusta e quella sbagliata sia almeno **100×** la tolleranza: la scelta di `Q`
// nei casi qui sotto serve esattamente a questo, e `separa()` lo verifica invece di prometterlo.
const TOLL_FATTORE = 5e-5;
const separa = (a, b, m) => { assert.ok(Math.abs(a - b) >= 100 * TOLL_FATTORE,
  `${m} — il caso non separa abbastanza: divario ${Math.abs(a - b).toExponential(2)} < ${(100 * TOLL_FATTORE).toExponential(2)}`); n++; };

// ⚠ `Q = 200` NON e' un numero comodo: `placementShareFactor` e' un RAPPORTO fra quote, quindi con un
// concorrente enorme e' quasi insensibile alla size e un test costruito li' non distinguerebbe i due
// rami. Con una concorrenza dell'ordine della nostra size il rapporto torna sensibile — ed e' anche il
// regime che conta, perche' e' dove il knapsack sceglie davvero (§5-bis p.167: 168 share di
// concorrenza contro 29.853).
const V = 4.5, D = 2.05, POOL = 100, CAP = 61.25, Q = 200;
/** Il costo della coppia, scritto a mano: importarlo dalla produzione nasconderebbe un errore condiviso. */
const coppia = 1 - 2 * (D / 100);
const base = (mid) => ({
  grossPerDay: 10, pot: POOL, competitorQ: Q, mid, capitalUsd: CAP,
  offsetCents: D, maxSpreadCents: V, measuredCostPerDay: 0, observedFills: 3,
  poolTrend: null, midRows: null, refreshesPerDay: 0,
});
/** Il fattore della correzione «punteggio della posizione»: dipende da `sizeShares` e da null'altro. */
const fattorePosizione = (r) => {
  const c = (r.corrections || []).find((x) => x.key === 'placement-score');
  return c ? c.factor : null;
};

// ── ① A PARITÀ DI TUTTO IL RESTO, IL MID NON CAMBIA LA STIMA ───────────────────────────────────
// `input.mid` serviva SOLO a costruire la size della riga 269: tolta quella, la stima non dipende
// piu' dal mid. Sul sorgente non corretto le due size stanno in rapporto 10:1 e questo cade.
{
  const a = RE.realisticEstimate(base(0.05));
  const b = RE.realisticEstimate(base(0.50));
  vicino(a.realisticPerDay, b.realisticPerDay, 1e-12,
    '① la stima realistica deve essere identica a mid 0,05 e a mid 0,50');
  vicino(fattorePosizione(a), fattorePosizione(b), 1e-12,
    '① e il fattore del punteggio di posizione con lei');
}

// ── ② IL FATTORE PRODOTTO COINCIDE CON QUELLO CALCOLATO SULLA SIZE DELLA COPPIA ────────────────
{
  const atteso = SDC.sharePerLato({ capitaleUsd: CAP, pairCostUsd: coppia }).shares;
  const S = RE.placementScore(D, V);
  const fAtteso = RE.placementShareFactor(atteso, Q, S);
  const r = RE.realisticEstimate(base(0.11));
  vicino(fattorePosizione(r), fAtteso, TOLL_FATTORE,
    '② il fattore prodotto deve venire da size = capitale / costoCoppia');
  separa(fAtteso, RE.placementShareFactor((CAP / 2) / 0.11, Q, S), '②');
}

// ── ③ DIVERGENZA ESTREMA: mid 0,035 contro un costo coppia di 0,959 ───────────────────────────
// A mid basso la vecchia formula gonfia di ~14×. È il caso che separa i due rami; a mid ≈ 0,5
// sbagliava di poco piu' del 3% e un test lasco lo perdonerebbe.
{
  const mid = 0.035;
  const atteso = SDC.sharePerLato({ capitaleUsd: CAP, pairCostUsd: coppia }).shares;
  const S = RE.placementScore(D, V);
  const r = RE.realisticEstimate(base(mid));
  vicino(fattorePosizione(r), RE.placementShareFactor(atteso, Q, S), TOLL_FATTORE,
    '③ divergenza estrema: la size deve restare quella della coppia');
  separa(RE.placementShareFactor(atteso, Q, S), RE.placementShareFactor((CAP / 2) / mid, Q, S), '③');
  const rapporto = ((CAP / 2) / mid) / atteso;
  ok(rapporto > 12, `③ il caso deve davvero divergere (rapporto ${rapporto.toFixed(1)}× > 12)`);
}

// ── ④ IL FATTORE 2 NON DEVE RIMANERE: `capitalUsd` È IL TOTALE ────────────────────────────────
// `allocate.js:167` costruisce i livelli con `capital: 2 * sizeUsd`, quindi la size giusta è
// `C / costoCoppia` e NON `(C/2) / costoCoppia`. Se qualcuno «conservasse il /2» per prudenza, la
// stima sottostimerebbe di esattamente 2× e questo blocco lo prende.
{
  const S = RE.placementScore(D, V);
  const intero = SDC.sharePerLato({ capitaleUsd: CAP, pairCostUsd: coppia }).shares;
  const meta = intero / 2;
  const r = RE.realisticEstimate(base(0.42));
  const f = fattorePosizione(r);
  vicino(f, RE.placementShareFactor(intero, Q, S), TOLL_FATTORE, '④ la size è il capitale INTERO / costoCoppia');
  separa(RE.placementShareFactor(intero, Q, S), RE.placementShareFactor(meta, Q, S), '④ intero contro metà');
}

// ── ⑤ LE DUE METÀ DELLA CATENA CONCORDANO ESATTAMENTE, NON APPROSSIMATIVAMENTE ────────────────
// L'obiettivo del knapsack passa da `curve.shareForCapital(..., pairCostUsd)`; la stima passa da qui.
// Le due size devono coincidere al bit, o il piano mostrerebbe una size diversa da quella con cui è
// stato classificato — che è il difetto che il costo della coppia esiste per chiudere.
{
  const minSize = 50;
  const qShares = Q;
  const sizeObiettivo = SDC.sharePerLato({ capitaleUsd: CAP, pairCostUsd: coppia }).shares;
  // `shareForCapital` calcola la stessa size internamente: la si riottiene invertendo la quota.
  const quota = shareForCapital(qShares, 0.11, CAP, minSize, coppia);
  const sizeDaObiettivo = (quota * qShares) / (1 - quota);
  vicino(sizeDaObiettivo, sizeObiettivo, 1e-9,
    '⑤ la size dell\'obiettivo e quella della stima devono coincidere ESATTAMENTE');
  const S = RE.placementScore(D, V);
  vicino(fattorePosizione(RE.realisticEstimate(base(0.11))),
    RE.placementShareFactor(sizeObiettivo, Q, S), TOLL_FATTORE,
    '⑤ e la stima deve usare quella stessa size');
}

// ── ⑥ LE FUNZIONI CHE L'OBIETTIVO RIUSA NON SI MUOVONO ────────────────────────────────────────
// `allocate.js:68` importa placementScore, placementShareFactor, credibleShareFactor, DEFAULTS;
// `profondita-minima.js:61` importa ceilingShare, DEFAULTS. Se una sola si spostasse, si sposterebbe
// l'OBIETTIVO, cioè la classifica e gli spodestamenti. Sono PURE nei loro argomenti: la riga 269 non
// le tocca, e questo blocco lo fissa contro una correzione futura fatta un livello troppo in alto.
{
  vicino(RE.placementScore(2.05, 4.5), Math.pow((4.5 - 2.05) / 4.5, 2), 1e-12, '⑥ placementScore invariata');
  vicino(RE.ceilingShare(63.9, 8000), 63.9 / (63.9 + 8000), 1e-12, '⑥ ceilingShare invariata');
  const S = 0.25;
  const c = RE.ceilingShare(524, 10000);
  vicino(RE.placementShareFactor(524, 10000, S), ((S * 524) / (S * 524 + 10000)) / c, 1e-12,
    '⑥ placementShareFactor invariata');
  // `credibleShareFactor` restituisce un OGGETTO {factor, shareCeiling, capped}: si verifica il
  // contratto, non la truthiness — e i due rami, quello che non capa e quello che capa.
  const csfLibero = RE.credibleShareFactor(63.9, 200);
  ok(csfLibero && csfLibero.capped === false && csfLibero.factor === 1,
    '⑥ credibleShareFactor: sotto il tetto non capa e vale 1');
  const csfCapato = RE.credibleShareFactor(5000, 200);
  ok(csfCapato && csfCapato.capped === true, '⑥ credibleShareFactor: sopra il tetto capa');
  vicino(csfCapato.factor, RE.DEFAULTS.maxCredibleShare / csfCapato.shareCeiling, 1e-12,
    '⑥ e il fattore è esattamente tetto/quota');
  vicino(RE.DEFAULTS.maxCredibleShare, 0.60, 1e-12, '⑥ DEFAULTS.maxCredibleShare invariata');
}

// ── ⑦ FALLISCE CHIUSO: SENZA DISTANZA NON SI INVENTA UNA SIZE ─────────────────────────────────
// Senza `offsetCents` il costo della coppia non è calcolabile. La risposta onesta è «correzione non
// misurabile», non una size dedotta dal mid. Il fattore resta 1,0 e la stima non viene gonfiata.
{
  const senza = { ...base(0.30), offsetCents: null };
  const r = RE.realisticEstimate(senza);
  const c = (r.corrections || []).find((x) => x.key === 'placement-score');
  ok(c == null || c.measurable === false || c.factor === 1,
    '⑦ senza distanza la correzione di posizione non si applica e non si inventa');
  ok(r.realisticPerDay == null || Number.isFinite(r.realisticPerDay),
    '⑦ e la stima resta un numero onesto o un null dichiarato');
}

console.log(`stima-realistica-denominatore: ${n}/${n} verdi, 0 rossi`);

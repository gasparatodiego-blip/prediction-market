'use strict';
// lib/maker/capitale-al-lavoro.js — UN SOLO NUMERO CHE DICE QUANTO CAPITALE STA LAVORANDO.
//
// ═══ PERCHÉ UN MODULO, VISTO CHE `misuraUtilizzo` ESISTE GIÀ ═════════════════════════════════════
// `utilizzo-capitale.misuraUtilizzo` calcola già la frazione, e resta LA FONTE: questo file non
// ricalcola niente e non legge niente per conto suo. Fa le due cose che a quella misura mancavano:
//
//   1. dichiara l'OBIETTIVO come una grandezza sola (0,95 dal 12 agosto 2026, era 0,90), così
//      «quanto lavora» e «quanto dovrebbe lavorare» non vivono in due posti che possono divergere;
//   2. quando il capitale è fermo, dice PERCHÉ **in dollari**, con una somma che chiude.
//
// ═══ LA REGOLA CHE RENDE IL NUMERO ONESTO, E IL GUASTO CHE L'HA MOTIVATA ═════════════════════════
// Gli ordini a riposo NON sono capitale in più: su questo venue un BUY firmato tiene il collaterale
// nel wallet fino al match, quindi sono un SOTTOINSIEME del saldo. Sommarli al totale è l'errore che
// il 9 agosto 2026 ha dichiarato **$776,65 su $669,09 reali** — +16,1% — e ha allargato di altrettanto
// un tetto di rischio calcolato come frazione del totale (§5 punto 58).
//
//     totale    = saldo + posizioni          ← e NIENTE altro
//     libero    = max(0, saldo − ordiniARiposo)
//     alLavoro  = totale − libero            ← DERIVATO, mai sommato a parte
//
// `alLavoro` si ricava per differenza proprio perché due addizioni indipendenti possono divergere e
// una sottrazione no. È la stessa disciplina di `misuraUtilizzo`, e questo file la eredita invece di
// riscriverla: legge il suo esito e non i suoi ingredienti.
//
// ═══ LA RIPARTIZIONE DEVE CHIUDERE, ALTRIMENTI NON È UNA MISURA ══════════════════════════════════
// «Il capitale è fermo perché mancano mercati» è un'opinione. «Sono fermi $312,40, di cui $186,20
// perché il piano non ha righe utilizzabili e $126,20 perché i mercati del piano hanno già il tetto
// pieno» è una misura, e si può verificare: la somma delle cause deve fare il capitale fermo, al
// centesimo. Quello che non si riesce ad attribuire finisce in `nonAttribuito` — che è una voce, non
// un arrotondamento nascosto: se cresce, vuol dire che una causa non la stiamo osservando.

const { misuraUtilizzo, leggiTarget } = require('./utilizzo-capitale');

/** L'obiettivo, in frazione. 0,95 dal 12 agosto 2026 (era 0,90), decisione dell'operatore.
 *  Si cambia con `MAKER_TARGET_UTILIZZO`, la stessa manopola di sempre: qui si dichiara solo il
 *  difetto nuovo, non una seconda variabile. */
const OBIETTIVO_DEFAULT = 0.95;

/** Sotto questa soglia, e per questo tempo, la ripartizione diventa obbligatoria invece che
 *  facoltativa: è la definizione operativa di «il capitale è fermo e non è un transitorio».
 *  30 minuti = tre giri del mini-ciclo (cadenza operativa 10 min): due possono essere sfortuna,
 *  tre sono uno stato. */
const SOGLIA_DIAGNOSI = 0.80;
const DURATA_DIAGNOSI_MS = 30 * 60_000;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const usd = (x) => +(Math.round(x * 100) / 100);

/**
 * L'indicatore. Non legge niente: riceve l'esito di `misuraUtilizzo` (o gli ingredienti, e allora lo
 * calcola con LA STESSA funzione, mai con una seconda aritmetica).
 *
 * @param {object} a
 *   utilizzo      l'esito di `misuraUtilizzo`; se assente si usa `ingredienti`
 *   ingredienti   { saldoUsd, ordiniARiposoUsd, posizioniUsd } — passati a `misuraUtilizzo`
 *   obiettivo     frazione; assente ⇒ `leggiTarget()`, che a sua volta difetta a OBIETTIVO_DEFAULT
 * @returns {{leggibile:boolean, alLavoroUsd:number|null, totaleUsd:number|null, fermoUsd:number|null,
 *            frazione:number|null, pct:number|null, obiettivo:number, obiettivoPct:number,
 *            raggiunto:boolean|null, mancanoUsd:number|null, motivo:string}}
 */
function capitaleAlLavoro({ utilizzo = null, ingredienti = null, obiettivo = null } = {}) {
  const u = utilizzo || (ingredienti ? misuraUtilizzo(ingredienti) : null);
  const obj = fin(obiettivo) && obiettivo > 0 && obiettivo <= 1
    ? obiettivo
    : (fin(leggiTarget && leggiTarget()) ? leggiTarget() : OBIETTIVO_DEFAULT);
  const objPct = +(obj * 100).toFixed(1);

  if (!u || u.leggibile !== true) {
    // NON misurabile non è ZERO, e non è nemmeno «va bene». Un ingrediente mancante trattato come 0
    // direbbe «utilizzo 100%» proprio quando il capitale è fermo: è il difetto peggiore possibile qui.
    return {
      leggibile: false, alLavoroUsd: null, totaleUsd: null, fermoUsd: null,
      frazione: null, pct: null, obiettivo: obj, obiettivoPct: objPct,
      raggiunto: null, mancanoUsd: null,
      motivo: `capitale al lavoro NON misurabile: ${(u && u.motivo) || 'nessuna misura di utilizzo disponibile'}`,
    };
  }

  const totale = u.capitaleTotaleUsd;
  const alLavoro = u.impegnatoUsd;      // già DERIVATO come totale − libero: non si risomma qui
  const fermo = usd(Math.max(0, totale - alLavoro));
  const frazione = totale > 0 ? alLavoro / totale : 0;
  const raggiunto = frazione >= obj - 1e-9;
  const mancano = raggiunto ? 0 : usd(Math.max(0, totale * obj - alLavoro));

  return {
    leggibile: true,
    alLavoroUsd: usd(alLavoro),
    totaleUsd: usd(totale),
    fermoUsd: fermo,
    frazione: +frazione.toFixed(6),
    pct: +(frazione * 100).toFixed(1),
    obiettivo: obj, obiettivoPct: objPct,
    raggiunto,
    mancanoUsd: mancano,
    motivo: raggiunto
      ? `capitale al lavoro ${(frazione * 100).toFixed(1)}% — obiettivo ${objPct}% RAGGIUNTO`
      : `capitale al lavoro ${(frazione * 100).toFixed(1)}% sotto l'obiettivo ${objPct}%: mancano $${mancano.toFixed(2)} da mettere al lavoro`,
  };
}

/**
 * PERCHÉ IL CAPITALE È FERMO, IN DOLLARI, CON LA SOMMA CHE CHIUDE.
 *
 * Ogni causa arriva come una cifra già attribuita da chi la conosce — il mini-ciclo sa quanto ha
 * lasciato sul tavolo per mancanza di righe, il piazzamento sa quanto il venue ha rifiutato — e questo
 * modulo fa una cosa sola: le mette in fila, verifica che non superino il fermo, e chiama `nonAttribuito`
 * quello che avanza. NON indovina: una causa che nessuno ha misurato resta fuori e si vede.
 *
 * ⚠ LE CAUSE SONO ESCLUSIVE PER COSTRUZIONE, e l'ordine conta. Lo stesso dollaro può essere fermo
 * «perché il piano non ha righe» E «perché il tetto è pieno»: si attribuisce alla PRIMA causa che lo
 * ferma andando dalla più a monte alla più a valle, altrimenti la somma supererebbe il fermo e la
 * ripartizione direbbe che manca più capitale di quanto ce ne sia.
 *
 * @param {object} a
 *   fermoUsd            quanto capitale è fermo (da `capitaleAlLavoro`)
 *   pianoSenzaRigheUsd  fermo perché il piano non offre righe utilizzabili
 *   tettoMercatoPienoUsd fermo perché i mercati del piano hanno già il tetto pieno
 *   rifiutatiDalVenueUsd fermo perché il venue ha rifiutato gli ordini
 *   nonQuotabiliUsd     fermo perché i mercati sono stati scartati come non quotabili
 *   rateLimitUsd        fermo perché la quota di finestra era esaurita
 * @returns {{chiude:boolean, fermoUsd:number, voci:Array<{causa:string,usd:number,pct:number}>,
 *            nonAttribuitoUsd:number, riga:string}}
 */
function ripartizioneFermo({
  fermoUsd = 0,
  pianoSenzaRigheUsd = 0,
  tettoMercatoPienoUsd = 0,
  rifiutatiDalVenueUsd = 0,
  nonQuotabiliUsd = 0,
  rateLimitUsd = 0,
} = {}) {
  const fermo = fin(fermoUsd) && fermoUsd > 0 ? usd(fermoUsd) : 0;
  // Dalla più a monte alla più a valle: un dollaro fermo perché il piano non lo prevede non è anche
  // fermo per il tetto di un mercato che non è stato nemmeno scelto.
  const ordine = [
    ['piano senza righe utilizzabili', pianoSenzaRigheUsd],
    ['mercati non quotabili', nonQuotabiliUsd],
    ['tetto per mercato già pieno', tettoMercatoPienoUsd],
    ['quota di finestra esaurita', rateLimitUsd],
    ['ordini rifiutati dal venue', rifiutatiDalVenueUsd],
  ];
  const voci = [];
  let residuo = fermo;
  for (const [causa, raw] of ordine) {
    const v = fin(raw) && raw > 0 ? usd(Math.min(raw, residuo)) : 0;
    if (v > 0) {
      voci.push({ causa, usd: v, pct: fermo > 0 ? +(100 * v / fermo).toFixed(1) : 0 });
      residuo = usd(residuo - v);
    }
  }
  const nonAttribuito = usd(Math.max(0, residuo));
  if (nonAttribuito > 0) {
    voci.push({
      causa: 'non attribuito',
      usd: nonAttribuito,
      pct: fermo > 0 ? +(100 * nonAttribuito / fermo).toFixed(1) : 0,
    });
  }
  const somma = usd(voci.reduce((s, v) => s + v.usd, 0));
  return {
    // La somma chiude sempre PER COSTRUZIONE (il residuo diventa una voce): `chiude` esiste per
    // catturare un errore di virgola mobile, non per tollerare una ripartizione incompleta.
    chiude: Math.abs(somma - fermo) < 0.011,
    fermoUsd: fermo,
    voci,
    nonAttribuitoUsd: nonAttribuito,
    riga: fermo <= 0
      ? 'capitale fermo $0,00 — niente da ripartire'
      : `fermi $${fermo.toFixed(2)}: ` + voci.map((v) => `$${v.usd.toFixed(2)} ${v.causa} (${v.pct}%)`).join(' · '),
  };
}

/**
 * LA LATCH DEI 30 MINUTI. Puro: riceve lo stato precedente e l'istante, restituisce quello nuovo.
 * La diagnosi si scrive quando il capitale sta sotto soglia da abbastanza tempo da non essere un
 * transitorio — e si scrive UNA volta per episodio, non a ogni giro, altrimenti diventa rumore e
 * nessuno la legge.
 */
function valutaDiagnosi({ frazione = null, ora = 0, stato = null, soglia = SOGLIA_DIAGNOSI, durataMs = DURATA_DIAGNOSI_MS } = {}) {
  const s = stato && typeof stato === 'object' ? stato : { sottoDa: null, giaScritta: false };
  // Non misurabile ⇒ NON si arma e NON si disarma: «non lo so» non è «sta bene», e non è nemmeno
  // una conferma che sta male. Si tiene lo stato com'era.
  if (!fin(frazione)) return { ...s, scrivi: false, motivo: 'frazione non misurabile: stato invariato' };
  if (frazione >= soglia) {
    return { sottoDa: null, giaScritta: false, scrivi: false,
      motivo: `capitale al lavoro ${(frazione * 100).toFixed(1)}% ≥ soglia di diagnosi ${(soglia * 100).toFixed(0)}%` };
  }
  const sottoDa = s.sottoDa != null ? s.sottoDa : ora;
  const da = ora - sottoDa;
  if (da < durataMs) {
    return { sottoDa, giaScritta: false, scrivi: false,
      motivo: `sotto soglia da ${Math.round(da / 60000)} min, la diagnosi scatta a ${Math.round(durataMs / 60000)}` };
  }
  if (s.giaScritta) {
    return { sottoDa, giaScritta: true, scrivi: false, motivo: 'diagnosi già scritta per questo episodio' };
  }
  return { sottoDa, giaScritta: true, scrivi: true,
    motivo: `capitale al lavoro sotto ${(soglia * 100).toFixed(0)}% da ${Math.round(da / 60000)} minuti consecutivi` };
}

module.exports = {
  capitaleAlLavoro, ripartizioneFermo, valutaDiagnosi,
  OBIETTIVO_DEFAULT, SOGLIA_DIAGNOSI, DURATA_DIAGNOSI_MS,
};

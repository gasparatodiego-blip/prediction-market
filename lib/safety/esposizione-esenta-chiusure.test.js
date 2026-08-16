'use strict';
// lib/safety/esposizione-esenta-chiusure.test.js — IL TETTO DI ESPOSIZIONE NON PUO' MURARE UNA GAMBA NUDA.
//
// ═══ IL DIFETTO CHE QUESTO TEST INCHIODA ═════════════════════════════════════════════════════════════
// `evaluateLimits` limite 2 confronta `openNotionalUsd + notional > maxOpenNotionalUsd`. E' l'aritmetica
// di un ordine che APRE. Su un ordine che CHIUDE e' sbagliata di SEGNO, e al tetto produce una trappola
// nei due versi: la gamba riempita e' gia' dentro `openNotionalUsd`, quindi
//   · il BUY che completa la coppia viene rifiutato — resta una gamba nuda;
//   · e la SELL che liquiderebbe quella gamba nuda viene rifiutata anche lei, perche' anche la sua size
//     viene SOMMATA all'esposizione invece che sottratta.
// La posizione resta in gabbia in entrambe le direzioni. Terza occorrenza della classe «regola nata per
// limitare l'APERTURA, applicata a un'azione che non apre» (§5-bis p.133, p.147).
//
// ═══ COSA SI DIFENDE, E COME ═════════════════════════════════════════════════════════════════════════
// Si difende la PROPRIETA', non il valore del tetto: «un ordine la cui riduzione e' PROVATA non puo'
// essere rifiutato da max-open-notional, e nessun altro gate viene toccato». Il tetto vive in un file
// gitignored e cambia; la proprieta' no.

const assert = require('assert');
const { evaluateLimits } = require('./risk-limits');
const { provaChiusura } = require('../maker/esenzione-chiusura');

let p = 0;
const ok = (nome, cond) => { assert.ok(cond, nome); p += 1; console.log(`  ✓ ${nome}`); };

const LIMITI = { maxOrderNotionalUsd: 80, maxOpenNotionalUsd: 150, maxOrdersPerWindow: 40, windowMs: 60_000, maxDailyLossUsd: 100 };
// Esposizione gia' al tetto: e' esattamente lo stato in cui nasce la gamba nuda.
const AL_TETTO = { openNotionalUsd: 145, ordersInWindow: 2, realisedDailyPnlUsd: 0, venuePositions: { readable: true } };
const val = (notional, esenzione) => evaluateLimits({ order: { notionalUsd: notional }, usage: AL_TETTO, limits: LIMITI, esenzioneEsposizione: esenzione });

console.log('\n════ il tetto di esposizione esenta le chiusure PROVATE ════');

// ── 1 · IL DIFETTO, RIPRODOTTO ────────────────────────────────────────────────────────────────────
ok('senza esenzione un ordine oltre il tetto e\' rifiutato — il comportamento di sempre',
  val(20, null).allow === false && val(20, null).gate === 'max-open-notional');
ok('  e lo era ANCHE per la SELL che liquida la gamba nuda: la trappola nei due versi',
  val(20, undefined).allow === false);

// ── 2 · LA PROVA SBLOCCA, E SOLO LA PROVA ─────────────────────────────────────────────────────────
// BUY entro `manca`: 100 share sul lato opposto, zero su questo ⇒ al piu' appaia, esposizione zero.
const buyOk = provaChiusura({ side: 'BUY', size: 100, chiudePosizione: true, heldSize: null, heldSizeOpposto: 100 });
ok('la prova del BUY che completa la coppia e\' positiva', buyOk.esente === true);
ok('  e con quella prova il tetto NON rifiuta piu\'', val(20, buyOk).allow === true);
ok('  e l\'esenzione viene DICHIARATA nel risultato, non applicata in silenzio',
  typeof val(20, buyOk).esenzione === 'string' && /max-open-notional esentato/.test(val(20, buyOk).esenzione));

const sellOk = provaChiusura({ side: 'SELL', size: 100, chiudePosizione: true, heldSize: 100 });
ok('la SELL entro il posseduto e\' provata, e passa il tetto', sellOk.esente === true && val(20, sellOk).allow === true);

// ── 3 · CIO' CHE NON DEVE PASSARE ─────────────────────────────────────────────────────────────────
const buyTroppo = provaChiusura({ side: 'BUY', size: 101, chiudePosizione: true, heldSize: null, heldSizeOpposto: 100 });
ok('un BUY oltre `manca` NON e\' provato e NON passa il tetto',
  buyTroppo.esente === false && val(20, buyTroppo).allow === false);
const sellTroppo = provaChiusura({ side: 'SELL', size: 101, chiudePosizione: true, heldSize: 100 });
ok('una SELL oltre il posseduto NON e\' provata e NON passa il tetto',
  sellTroppo.esente === false && val(20, sellTroppo).allow === false);
const senzaSnapshot = provaChiusura({ side: 'BUY', size: 10, chiudePosizione: true, heldSize: null, heldSizeOpposto: null });
ok('snapshot illeggibile ⇒ nessuna prova ⇒ tetto applicato (fail-closed)',
  senzaSnapshot.esente === false && val(20, senzaSnapshot).allow === false);
ok('una DICHIARAZIONE senza prova non esenta: `{esente:"si"}` non e\' `true`',
  val(20, { esente: 'si', motivo: 'bugia' }).allow === false);
ok('  e nemmeno un oggetto truthy qualunque', val(20, { motivo: 'niente' }).allow === false);

// ── 4 · L'ESENZIONE E' STRETTA: GLI ALTRI QUATTRO LIMITI RESTANO ──────────────────────────────────
// Questa e' la meta' che conta: un'uscita provata non e' un lasciapassare.
ok('il TETTO PER ORDINE resta applicato anche su una chiusura provata',
  val(81, buyOk).allow === false && val(81, buyOk).gate === 'max-order-notional');
ok('il RATE LIMIT resta applicato anche su una chiusura provata',
  evaluateLimits({ order: { notionalUsd: 20 }, usage: { ...AL_TETTO, ordersInWindow: 40 }, limits: LIMITI, esenzioneEsposizione: buyOk }).gate === 'rate-limit');
ok('la PERDITA GIORNALIERA resta applicata, e continua a far scattare il kill',
  evaluateLimits({ order: { notionalUsd: 20 }, usage: { ...AL_TETTO, realisedDailyPnlUsd: -100 }, limits: LIMITI, esenzioneEsposizione: buyOk }).autoKill === true);
ok('le POSIZIONI DEL VENUE ILLEGGIBILI rifiutano PRIMA, esenzione o no',
  evaluateLimits({ order: { notionalUsd: 20 }, usage: { ...AL_TETTO, venuePositions: { readable: false, reason: 'x' } }, limits: LIMITI, esenzioneEsposizione: buyOk }).gate === 'venue-positions-unreadable');
ok('un\'esposizione NON MISURABILE rifiuta, esenzione o no',
  evaluateLimits({ order: { notionalUsd: 20 }, usage: { ...AL_TETTO, openNotionalUsd: null }, limits: LIMITI, esenzioneEsposizione: buyOk }).gate === 'max-open-notional');
ok('un tetto ASSENTE fallisce chiuso, esenzione o no',
  evaluateLimits({ order: { notionalUsd: 20 }, usage: AL_TETTO, limits: { ...LIMITI, maxOpenNotionalUsd: null }, esenzioneEsposizione: buyOk }).gate === 'max-open-notional');

// ── 5 · SOTTO IL TETTO L'ESENZIONE NON SI DICHIARA ────────────────────────────────────────────────
// Se il tetto non stava mordendo, non c'e' niente da esentare: dichiararlo sporcherebbe il conteggio
// di domani con righe in cui l'esenzione non ha cambiato nessun esito.
ok('un ordine che passava comunque NON porta la riga di esenzione',
  evaluateLimits({ order: { notionalUsd: 1 }, usage: { ...AL_TETTO, openNotionalUsd: 10 }, limits: LIMITI, esenzioneEsposizione: buyOk }).esenzione === undefined);

// ── 6 · LA PROPRIETA' GENERALE, SU UNA SPAZZATA ───────────────────────────────────────────────────
// Non un caso scelto: per ogni esposizione e ogni size, una riduzione provata non e' MAI rifiutata da
// max-open-notional, e una non provata lo e' sempre quando sfonda.
let violazioni = 0;
for (let aperto = 0; aperto <= 300; aperto += 10) {
  for (let n = 1; n <= 80; n += 7) {
    const u = { openNotionalUsd: aperto, ordersInWindow: 0, realisedDailyPnlUsd: 0, venuePositions: { readable: true } };
    const conProva = evaluateLimits({ order: { notionalUsd: n }, usage: u, limits: LIMITI, esenzioneEsposizione: buyOk });
    const senza = evaluateLimits({ order: { notionalUsd: n }, usage: u, limits: LIMITI });
    if (conProva.gate === 'max-open-notional') violazioni += 1;
    if (aperto + n > 150 && senza.gate !== 'max-open-notional') violazioni += 1;
  }
}
ok(`proprieta\' su 341 combinazioni (esposizione 0-300 × size 1-80): zero violazioni`, violazioni === 0);

console.log(`\nesposizione-esenta-chiusure: ${p} passati, 0 falliti`);

#!/usr/bin/env node
'use strict';
// scripts/ricerca/orizzonte-maturazione.js — IL REWARD SI MATURA IN TEMPO?
//
// SOLA LETTURA. Nessuna soglia toccata.
//
// IL FATTO DEL VENUE, MISURATO E NON ASSUNTO: il punteggio della liquidità maker si calcola da UN
// CAMPIONE CASUALE AL MINUTO — 1.440 campioni al giorno, 10.080 in un'epoca settimanale. È scritto in
// lib/maker/auto-reprice-config.js con la citazione della documentazione ufficiale
// (docs.polymarket.com/market-makers/liquidity-rewards: «Q_ne is calculated every minute using random
// sampling»), e da lì è LETTO qui invece di essere ridichiarato.
//
// CONSEGUENZA ARITMETICA: `montepremiGiorno` è un TASSO, non un importo. Un mercato che vive H ore
// offre 60·H campioni su 1.440, quindi il massimo maturabile in tutta la sua vita è
//     totale = montepremi × quota × H/24
// mentre il «lordo/giorno» del piano è il tasso `montepremi × quota` — corretto come tasso, e da non
// confondere con quanto quel mercato pagherà davvero prima di morire.
//
// LA SOGLIA CHE SI CERCA: sotto quante ore il maturato non copre il costo del giro (entrata + uscita)?

const fs = require('fs');
const path = require('path');
const RADICE = path.join(__dirname, '..', '..');
const { EXPECTED_RENEWALS_PER_HOUR } = require(path.join(RADICE, 'lib', 'maker', 'auto-reprice-config'));
const CAMPIONI_AL_GIORNO = 1440;   // il fatto del venue, citato sopra

const TETTO = 32.67;               // il tetto per mercato in vigore (concentration.capPerMarketUsd a $650)
const COSTO_COPPIA = 0.98;

// ── IL COSTO DEL GIRO, DA MISURE DI QUESTO REPO ────────────────────────────────────────────────────
// 1 · lo spread attraversato per uscire a mercato su ENTRAMBE le gambe: Q × bookSpread.
//     bookSpread mediano del board, letto adesso.
// 2 · il rischio di residuo bloccato: f_min = minSize × costoCoppia / capitale (concentration.js).
const board = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'liquidity-rewards.json'), 'utf8'));
const spread = board.markets.map((m) => Number(m.bookSpread)).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
const spreadMediano = spread[spread.length >> 1];
const pots = board.markets.map((m) => Number(m.rewardsDailyRate)).filter(Number.isFinite).sort((a, b) => a - b);
const potMediano = pots[pots.length >> 1];

const Q = TETTO / COSTO_COPPIA;                 // share per lato al tetto
const costoUscita = Q * spreadMediano;          // due gambe, mezzo spread ciascuna

console.log('\n═══ IL CAMPIONAMENTO DEL VENUE');
console.log(`  ${CAMPIONI_AL_GIORNO} campioni al giorno (uno al minuto, casuale) — fonte: lib/maker/auto-reprice-config.js`);
console.log(`  rinnovi GTD attesi: ${EXPECTED_RENEWALS_PER_HOUR}/ora · un buco di 3 s costa 0,05 campioni su 1.440 = 0,003% di una giornata`);
console.log('\n  ore di vita │ campioni offerti │ frazione di una giornata');
for (const h of [0.25, 1, 2, 3, 4, 6, 9, 12, 15.5, 18, 24, 48]) {
  console.log(`  ${String(h).padStart(11)} │ ${String(Math.round(h * 60)).padStart(16)} │ ${(100 * h / 24).toFixed(1).padStart(6)}%`);
}

console.log('\n═══ IL COSTO DEL GIRO, AL TETTO DI OGGI');
console.log(`  capitale per mercato $${TETTO} ⇒ ${Q.toFixed(1)} share per lato`);
console.log(`  bookSpread mediano del board: ${spreadMediano} ⇒ uscita a mercato su due gambe = $${costoUscita.toFixed(3)}`);
console.log(`  f_min = ${(20 * COSTO_COPPIA / TETTO * 100).toFixed(0)}% (minSize 20): sotto questa frazione di fill il residuo non si ripiazza`);

console.log('\n═══ LA SOGLIA: ORE MINIME PERCHÉ IL MATURATO COPRA IL COSTO DEL GIRO');
console.log(`  maturato(H) = montepremi × quota × H/24 ;  pareggio quando = $${costoUscita.toFixed(3)}`);
console.log(`  montepremi mediano del board: $${potMediano}/g\n`);
console.log('  quota │ $/g al tasso │ ore per pareggiare l\'uscita │ ore per 10× il costo');
for (const q of [0.02, 0.05, 0.10, 0.15, 0.25, 0.40]) {
  const tasso = potMediano * q;
  const h = costoUscita / tasso * 24;
  console.log(`  ${(q * 100).toFixed(0).padStart(4)}% │ ${('$' + tasso.toFixed(2)).padStart(12)} │ ${h.toFixed(2).padStart(26)} │ ${(h * 10).toFixed(1).padStart(20)}`);
}

console.log('\n  ⚠ QUESTO CONTO COPRE SOLO LO SPREAD. Non copre il rischio vero dei mercati brevi —');
console.log('    una gamba nuda che va a risoluzione — che non è un costo di transazione ma la varianza');
console.log('    dell\'intero nozionale della gamba. Quello è misurato in orizzonte-brevi-rischio.js.');

const out = {
  generatoIso: new Date().toISOString(),
  campioniAlGiorno: CAMPIONI_AL_GIORNO,
  rinnoviAttesiOra: EXPECTED_RENEWALS_PER_HOUR,
  tettoUsato: TETTO, sharePerLato: +Q.toFixed(2),
  bookSpreadMediano: spreadMediano, potMedianoBoard: potMediano,
  costoUscitaUsd: +costoUscita.toFixed(4),
  fMinAlTetto: +(20 * COSTO_COPPIA / TETTO).toFixed(3),
  campioniPerOre: Object.fromEntries([0.25, 1, 2, 3, 4, 6, 9, 12, 15.5, 18, 24, 48].map((h) => [h, { campioni: Math.round(h * 60), frazioneGiornata: +(h / 24).toFixed(4) }])),
  orePerPareggiare: Object.fromEntries([0.02, 0.05, 0.10, 0.15, 0.25, 0.40].map((q) => [q, +(costoUscita / (potMediano * q) * 24).toFixed(3)])),
};
fs.writeFileSync(path.join(RADICE, 'data', 'ricerca', 'orizzonte-maturazione.json'), JSON.stringify(out, null, 1));
console.log('\nscritto in data/ricerca/orizzonte-maturazione.json\n');

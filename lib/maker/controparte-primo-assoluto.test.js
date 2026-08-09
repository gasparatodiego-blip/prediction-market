'use strict';
// lib/maker/controparte-primo-assoluto.test.js — QUANDO IL LATO POSSEDUTO TACE, LA CONTROPARTE CHIUDE.
//
// ═══ LA DECISIONE (operatore, 9 agosto 2026) ════════════════════════════════════════════════════════
// Quando la banda premiante scende sotto il prezzo di carico, il lato posseduto non si può quotare —
// «mai sotto il carico» è un vincolo duro — e la posizione resta direzionale, senza premi, a tempo
// indeterminato. Era lo stato di Houston (banda 50¢ / carico 55¢), London 18°C (63¢ / 65¢) e London
// 19°C (48¢ / 59¢) il 9 agosto.
//
// In quel caso — e SOLO in quel caso — la controparte smette di essere una quota che aspetta e diventa
// lo strumento che CHIUDE la coppia. Quindi va messa **prima assoluta** sul libro dentro la banda,
// invece che un tick dietro a chi c'è già.
//
// COMPROMESSO ACCETTATO ESPLICITAMENTE: qualche centesimo per azione per stare in cima alla coda, in
// cambio di una chiusura rapida invece di un blocco indefinito.
//
// ═══ COSA NON CAMBIA ════════════════════════════════════════════════════════════════════════════════
//   · il lato POSSEDUTO resta protetto dal «mai sotto il carico», identico a prima;
//   · il tetto della coppia (110¢) resta un limite DURO: si prende il più BASSO fra bordo banda e tetto;
//   · «mai primi sul libro» resta valido OVUNQUE ALTRO — è `inCoda`, ed è opt-in per chiamante.

const fs = require('fs');
const path = require('path');
const CR = require('./chiusura-rapida');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

// Houston, i numeri veri del 9 agosto: NO 66,3 @ 55¢, banda del lato posseduto fino a 50¢.
const HOUSTON = { prezzoCarico: 0.55, sizePosseduta: 66.3, manca: 66.3, bandaHi: 0.50, tick: 0.01, minSize: 20 };

console.log('── 1 · BANDA SOTTO IL CARICO: LA CONTROPARTE VA PRIMA ASSOLUTA');
{
  const r = CR.pianificaRiposizionamentoScoperto({ ...HOUSTON, bandaHiControparte: 0.47 });
  ok('il piano è utilizzabile', r.ok === true, r.motivo.slice(0, 80));
  ok('il lato posseduto resta MUTO, come deve', r.latoPosseduto === null, r.latoPossedutoMotivo.slice(0, 70));
  ok('  e il motivo è la banda sotto il carico', /sotto il prezzo di carico/.test(r.latoPossedutoMotivo));
  ok('la controparte è proposta', !!r.controparte);
  ok('  ed è marcata PRIMO ASSOLUTO', r.controparte.primoAssoluto === true);
  ok('  al bordo della banda della controparte, non un tick dietro', r.controparte.prezzo === 0.47, `${r.controparte.prezzo}`);
  ok('  di size esattamente uguale e contraria al lato posseduto',
    r.controparte.size === HOUSTON.sizePosseduta, `${r.controparte.size} contro ${HOUSTON.sizePosseduta}`);

  // IL TETTO DELLA COPPIA RESTA DURO: si prende il più BASSO fra bordo banda e tetto.
  const caro = CR.pianificaRiposizionamentoScoperto({ ...HOUSTON, prezzoCarico: 0.80, bandaHi: 0.70, bandaHiControparte: 0.90 });
  ok('il tetto della coppia vince sul bordo della banda', caro.controparte.prezzo <= 0.30 + 1e-9,
    `${caro.controparte.prezzo} (tetto 110¢ − carico 80¢ = 30¢)`);
  ok('  e la coppia resta entro il tetto', +((0.80 + caro.controparte.prezzo) * 100).toFixed(1) <= CR.TETTO_COPPIA_CENTS);
}

console.log('\n── 2 · L\'ECCEZIONE NON SI APRE IN NESSUN ALTRO CASO');
{
  // Banda SOPRA il carico: il lato posseduto si quota, quindi non c'è nessuna emergenza da chiudere.
  const normale = CR.pianificaRiposizionamentoScoperto({
    prezzoCarico: 0.40, sizePosseduta: 66.3, manca: 66.3, bandaHi: 0.50, tick: 0.01, minSize: 20,
    bandaHiControparte: 0.62,
  });
  ok('con la banda SOPRA il carico il lato posseduto si quota', !!normale.latoPosseduto,
    normale.latoPosseduto && `a ${normale.latoPosseduto.prezzo}`);
  ok('  e la controparte NON è primo assoluto', normale.controparte.primoAssoluto === false);
  ok('  resta al prezzo da tetto, come prima', normale.controparte.prezzo === 0.70, `${normale.controparte.prezzo}`);

  // Senza la banda della controparte l'eccezione non si apre: non si indovina un prezzo aggressivo.
  const senzaBanda = CR.pianificaRiposizionamentoScoperto({ ...HOUSTON, bandaHiControparte: null });
  ok('senza la banda della controparte non si apre l\'eccezione', senzaBanda.controparte.primoAssoluto === false);
  ok('  e si torna esattamente al comportamento di prima', senzaBanda.controparte.prezzo === 0.55, `${senzaBanda.controparte.prezzo}`);

  // Il lato posseduto muto per un ALTRO motivo (size sotto il minimo) non apre l'eccezione.
  const piccolo = CR.pianificaRiposizionamentoScoperto({
    prezzoCarico: 0.40, sizePosseduta: 5, manca: 66.3, bandaHi: 0.50, tick: 0.01, minSize: 20,
    bandaHiControparte: 0.62,
  });
  ok('il silenzio per size sotto il minimo NON apre l\'eccezione', piccolo.controparte.primoAssoluto === false,
    piccolo.latoPossedutoMotivo);
}

console.log('\n── 3 · IL LATO POSSEDUTO RESTA PROTETTO ESATTAMENTE COME PRIMA');
{
  // Nessun prezzo proposto sotto il carico, in nessuna combinazione.
  let violazioni = 0; let proposti = 0;
  for (const carico of [0.20, 0.35, 0.50, 0.65, 0.80]) {
    for (const hi of [0.15, 0.30, 0.45, 0.60, 0.75, 0.90]) {
      for (const tick of [0.001, 0.01]) {
        const r = CR.pianificaRiposizionamentoScoperto({
          prezzoCarico: carico, sizePosseduta: 60, manca: 60, bandaHi: hi, tick, minSize: 20,
          bandaHiControparte: hi,
        });
        if (!r.latoPosseduto) continue;
        proposti += 1;
        if (r.latoPosseduto.prezzo <= carico + 1e-9 || r.latoPosseduto.prezzo > hi + 1e-9) violazioni += 1;
      }
    }
  }
  ok('nessun prezzo del lato posseduto sotto il carico o fuori banda', violazioni === 0,
    `${proposti} prezzi proposti, ${violazioni} violazioni`);
  ok('  e il vincolo è ancora dichiarato nel sorgente',
    /Non si vende in perdita per restare premiati/.test(fs.readFileSync(path.join(__dirname, 'chiusura-rapida.js'), 'utf8')));
}

console.log('\n── 4 · IL CABLAGGIO: UNA GAMBA SOLA PERDE «MAI PRIMI», E SI AGGANCIA AL MERGE');
{
  const ac = fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8');
  const mo = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');

  ok('«mai primi sul libro» è opt-in per chiamante', /if \(spec\.inCoda === true\)/.test(mo));
  ok('  e il rifiuto vive dentro quel ramo', /refuse\('mai-primo-sul-libro'/.test(mo));
  ok('la deroga è legata a primoAssoluto, non generica',
    /const primoAssoluto = !vende && g\.primoAssoluto === true;/.test(ac));
  ok('  e toglie inCoda SOLO a quella gamba',
    /\.\.\.\(primoAssoluto \? \{\} : \{ inCoda: true \}\)/.test(ac));
  ok('  il lato posseduto non può mai ottenerla (`!vende`)', /!vende && g\.primoAssoluto/.test(ac));

  // Ogni ALTRA gamba di auto-close continua a dichiarare inCoda.
  const altre = (ac.match(/inCoda: true/g) || []).length;
  ok(`le altre gambe dichiarano ancora inCoda (${altre} punti)`, altre >= 3, `${altre}`);
  ok('nessun altro file ha imparato la deroga',
    !/primoAssoluto/.test(fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8')));

  // L'AGGANCIO AL MERGE: se la controparte viene fillata la coppia è completa, e il giro dopo
  // `decidiLivello` risponde `azione:'merge'` — che è il percorso già collegato al relayer.
  const SM = require('./strategia-merge');
  const dopoIlFill = SM.decidiLivello({ book: 'no', sizePosseduta: 66.3, prezzoCarico: 0.55, sizeAltroLato: 66.3 });
  ok('coppia completata ⇒ il giro dopo è «merge»', dopoIlFill.azione === 'merge', dopoIlFill.motivo.slice(0, 60));
  ok('  e la size da fondere è quella intera', dopoIlFill.size === 66.3, String(dopoIlFill.size));
  ok('  e quel ramo chiama davvero il relayer', /if \(liv\.azione === 'merge'\)/.test(ac) && /fondiCoppia\(/.test(ac));
}

console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

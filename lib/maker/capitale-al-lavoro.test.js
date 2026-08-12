#!/usr/bin/env node
'use strict';
// lib/maker/capitale-al-lavoro.test.js — L'INDICATORE NON PUÒ MENTIRE IN ECCESSO.
//
// Il guasto che questo file esiste per impedire è già successo: il 9 agosto 2026 il capitale
// dichiarato era $776,65 contro $669,09 reali (+16,1%) perché gli ordini a riposo venivano SOMMATI al
// saldo invece di essere riconosciuti come un suo sottoinsieme. Su questo venue un BUY firmato tiene
// il collaterale nel wallet fino al match: sommarlo è contare due volte lo stesso dollaro, e il numero
// gonfiato allargava anche un tetto di rischio calcolato come frazione del totale.
//
// E la ripartizione del capitale fermo deve CHIUDERE: una somma di cause che non fa il fermo non è una
// misura, è un elenco.

const assert = require('assert');
const CL = require('./capitale-al-lavoro');
const { misuraUtilizzo } = require('./utilizzo-capitale');

let n = 0;
const ok = (name, cond, extra) => { assert.ok(cond, 'FAIL: ' + name + (extra ? ' — ' + extra : '')); console.log('  ✓ ' + name); n += 1; };

console.log('\n① NIENTE DOPPIO CONTEGGIO — i numeri veri del 9 agosto');
{
  // Saldo $633,90 · posizioni $35,19 · ordini a riposo $107,46 (un SOTTOINSIEME del saldo).
  // Il totale vero è $669,09, non $776,55.
  const u = misuraUtilizzo({ saldoUsd: 633.90, posizioniUsd: 35.19, ordiniARiposoUsd: 107.46 });
  const c = CL.capitaleAlLavoro({ utilizzo: u, obiettivo: 0.95 });
  ok('il totale è saldo + posizioni, e NIENTE altro', c.totaleUsd === 669.09, `$${c.totaleUsd}`);
  ok('  non è la somma dei tre (che darebbe $776,55)', c.totaleUsd !== 776.55);
  ok('il capitale al lavoro è il nozionale a riposo + le posizioni',
    Math.abs(c.alLavoroUsd - (107.46 + 35.19)) < 0.02, `$${c.alLavoroUsd}`);
  ok('  e il fermo chiude sul totale', Math.abs(c.alLavoroUsd + c.fermoUsd - c.totaleUsd) < 0.02,
    `${c.alLavoroUsd} + ${c.fermoUsd} vs ${c.totaleUsd}`);
  ok('la frazione è al lavoro / totale', Math.abs(c.pct - 21.3) < 0.2, `${c.pct}%`);
}

console.log('\n② L\'OBIETTIVO È 95% E VIAGGIA COL NUMERO');
{
  const c = CL.capitaleAlLavoro({ ingredienti: { saldoUsd: 600, posizioniUsd: 0, ordiniARiposoUsd: 100 }, obiettivo: 0.95 });
  ok('l obiettivo è dichiarato accanto alla misura', c.obiettivoPct === 95);
  ok('  e dice quanto manca IN DOLLARI', c.mancanoUsd === +(600 * 0.95 - 100).toFixed(2), `$${c.mancanoUsd}`);
  ok('  raggiunto è falso sotto obiettivo', c.raggiunto === false);
  const pieno = CL.capitaleAlLavoro({ ingredienti: { saldoUsd: 600, posizioniUsd: 0, ordiniARiposoUsd: 580 }, obiettivo: 0.95 });
  ok('  e vero sopra', pieno.raggiunto === true && pieno.mancanoUsd === 0, `${pieno.pct}%`);
  ok('il difetto del modulo è 0,95', CL.OBIETTIVO_DEFAULT === 0.95);
}

console.log('\n③ NON MISURABILE NON È ZERO, E NON È «VA BENE»');
{
  for (const [lbl, ing] of [
    ['saldo assente', { saldoUsd: null, posizioniUsd: 0, ordiniARiposoUsd: 0 }],
    ['ordini assenti', { saldoUsd: 600, posizioniUsd: 0, ordiniARiposoUsd: null }],
    ['posizioni assenti', { saldoUsd: 600, posizioniUsd: null, ordiniARiposoUsd: 0 }],
  ]) {
    const c = CL.capitaleAlLavoro({ ingredienti: ing });
    ok(`${lbl} ⇒ non leggibile, nessuna percentuale inventata`,
      c.leggibile === false && c.pct === null && c.raggiunto === null);
  }
  ok('e senza nessun ingresso non esplode', CL.capitaleAlLavoro({}).leggibile === false);
}

console.log('\n④ LA RIPARTIZIONE CHIUDE SUL CAPITALE FERMO');
{
  const r = CL.ripartizioneFermo({
    fermoUsd: 495.46,
    pianoSenzaRigheUsd: 300,
    tettoMercatoPienoUsd: 120,
    nonQuotabiliUsd: 40,
    rateLimitUsd: 10,
    rifiutatiDalVenueUsd: 5,
  });
  const somma = r.voci.reduce((s, v) => s + v.usd, 0);
  ok('la somma delle voci fa il capitale fermo', Math.abs(somma - 495.46) < 0.02, `$${somma.toFixed(2)}`);
  ok('  e `chiude` lo dichiara', r.chiude === true);
  ok('  il residuo non attribuito è una VOCE, non un arrotondamento nascosto',
    r.voci.some((v) => v.causa === 'non attribuito') && r.nonAttribuitoUsd > 0, JSON.stringify(r.voci.map((v) => v.causa)));
  ok('  la riga è leggibile e porta i dollari', /fermi \$495\.46/.test(r.riga) && /piano senza righe/.test(r.riga), r.riga.slice(0, 80));
}
{
  // LE CAUSE NON POSSONO SOMMARE PIÙ DEL FERMO. Lo stesso dollaro può essere fermo per due ragioni:
  // si attribuisce alla PRIMA andando da monte a valle, altrimenti la ripartizione direbbe che manca
  // più capitale di quanto ce ne sia.
  const r = CL.ripartizioneFermo({ fermoUsd: 100, pianoSenzaRigheUsd: 90, tettoMercatoPienoUsd: 90, nonQuotabiliUsd: 90 });
  const somma = r.voci.reduce((s, v) => s + v.usd, 0);
  ok('cause che si sovrappongono non sfondano il fermo', Math.abs(somma - 100) < 0.02, `$${somma.toFixed(2)}`);
  ok('  la causa più a MONTE prende per prima', r.voci[0].causa === 'piano senza righe utilizzabili' && r.voci[0].usd === 90);
  ok('  e nessuna voce è negativa', r.voci.every((v) => v.usd >= 0));
}
{
  const r = CL.ripartizioneFermo({ fermoUsd: 0 });
  ok('fermo zero ⇒ niente da ripartire', r.voci.length === 0 && r.chiude === true, r.riga);
}
{
  // Nessuna causa dichiarata ⇒ TUTTO non attribuito. È il caso che deve far rumore: significa che il
  // capitale è fermo e non sappiamo perché.
  const r = CL.ripartizioneFermo({ fermoUsd: 250 });
  ok('nessuna causa nota ⇒ tutto in `non attribuito`',
    r.voci.length === 1 && r.voci[0].causa === 'non attribuito' && r.voci[0].usd === 250);
}

console.log('\n⑤ LA DIAGNOSI SCATTA A 30 MINUTI, UNA VOLTA PER EPISODIO');
{
  const T = 1_700_000_000_000;
  let s = CL.valutaDiagnosi({ frazione: 0.42, ora: T, stato: null });
  ok('primo giro sotto soglia: arma, non scrive', s.scrivi === false && s.sottoDa === T);
  s = CL.valutaDiagnosi({ frazione: 0.42, ora: T + 29 * 60_000, stato: s });
  ok('  a 29 minuti non scrive ancora', s.scrivi === false);
  s = CL.valutaDiagnosi({ frazione: 0.42, ora: T + 31 * 60_000, stato: s });
  ok('  a 31 minuti SCRIVE', s.scrivi === true, s.motivo);
  s = CL.valutaDiagnosi({ frazione: 0.42, ora: T + 40 * 60_000, stato: s });
  ok('  e non si ripete nello stesso episodio', s.scrivi === false && s.giaScritta === true);
  s = CL.valutaDiagnosi({ frazione: 0.90, ora: T + 45 * 60_000, stato: s });
  ok('  risalire sopra soglia disarma', s.sottoDa === null && s.giaScritta === false);
  s = CL.valutaDiagnosi({ frazione: 0.42, ora: T + 50 * 60_000, stato: s });
  ok('  e un nuovo episodio riparte da capo', s.scrivi === false && s.sottoDa === T + 50 * 60_000);
}
{
  const T = 1_700_000_000_000;
  const armato = { sottoDa: T, giaScritta: false };
  const s = CL.valutaDiagnosi({ frazione: null, ora: T + 60 * 60_000, stato: armato });
  ok('frazione non misurabile: NON scrive e NON disarma',
    s.scrivi === false && s.sottoDa === T, s.motivo);
}

console.log(`\n${n}/${n} verdi\n`);

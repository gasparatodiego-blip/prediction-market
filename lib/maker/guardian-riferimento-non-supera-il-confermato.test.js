'use strict';
// lib/maker/guardian-riferimento-non-supera-il-confermato.test.js — D-D, 21 agosto 2026.
//
// LA PROPRIETA' DIFESA, in una riga: **il riferimento del guardiano non puo' mai valere piu' di quanto
// due letture distinte abbiano sostenuto**. Non «non deve valere 1550,18» — quello sarebbe difendere
// una costante, e la costante cambia domani. Il test morde sul COMPORTAMENTO: gli si da' una serie di
// letture e si pretende che il riferimento resti sotto il massimo CONFERMATO di quella serie, qualunque
// serie sia.
//
// ⚠ IL CASO CHE HA APERTO L'INDAGINE, coi numeri veri dell'osservatore del 16 agosto 2026:
//     19:27:17  saldo $1.439,94 + posizioni $57,103  = $1.497,05
//     19:28:00  saldo $1.493,07 + posizioni $57,103  = $1.550,18   ← saldo NUOVO, posizioni VECCHIE
//     19:28:18  saldo $1.493,07 + posizioni  $0,003  = $1.493,08
// Gli stessi $57,10 contati due volte. Il cricchetto li ha latchati per sempre, e cinque giorni dopo
// il margine del guardiano era $22,12 contro escursioni giornaliere misurate di $38.

const assert = require('assert');
const R = require('./guardian-riferimento');
const { calcolaPnl, decidiScatto } = require('./guardian-perdite');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}${x ? ' — ' + x : ''}`); } };
const cap = (tot, pos) => ({ leggibile: true, totaleUsd: +tot.toFixed(6), saldoUsd: +(tot - pos).toFixed(6), valorePosizioniUsd: +pos.toFixed(6) });
const T0 = 1_700_000_000_000;

/** Fa girare una serie di letture attraverso `aggiornaRiferimento` VERA, un giro ogni 30 s. */
function corri(serie, { partenza = null, passoMs = 30_000 } = {}) {
  let stato = partenza; let now = T0;
  for (const [tot, pos] of serie) {
    const r = R.aggiornaRiferimento({ stato, capitale: cap(tot, pos), now,
      osservazione: { saldoLetturaAt: now - 5_000 } });
    stato = r.stato; now += passoMs;
  }
  return stato;
}
/** Il massimo che DUE letture consecutive sostengono: max di min(t[i], t[i+1]). */
const massimoConfermato = (serie) => serie.slice(0, -1)
  .reduce((m, _, i) => Math.max(m, Math.min(serie[i][0], serie[i + 1][0])), -Infinity);

console.log('\n════ ① il caso vero del 16 agosto: il picco a UNA lettura non diventa il riferimento ════');
{
  // La serie e' quella misurata, con qualche lettura di contorno perche' il riferimento nasca prima.
  // ⚠ La prima lettura in assoluto CREA il riferimento senza conferma — non c'è niente contro cui
  // confermarla, ed è l'unica eccezione, dichiarata. In produzione il riferimento esisteva da giorni,
  // quindi la serie parte da due letture piatte che lo stabiliscono davvero.
  const serie = [[1497.0505, 57.106], [1497.0505, 57.106], [1497.0475, 57.103],
    [1550.17633, 57.103], [1493.0763, 0.003], [1493.0763, 0.003]];
  const s = corri(serie);
  ok('il riferimento NON arriva al picco fantasma di $1.550,18', Number(s.riferimentoUsd) < 1550, String(s.riferimentoUsd));
  ok('  e non supera nemmeno il massimo CONFERMATO della serie',
    Number(s.riferimentoUsd) <= massimoConfermato(serie) + 0.001,
    `${s.riferimentoUsd} > ${massimoConfermato(serie)}`);
  ok('  il picco viene dichiarato come candidato e poi SCARTATO, non taciuto',
    s.candidato === null || s.candidato === undefined);
  // Il costo di allora, in una riga: col riferimento fantasma il PnL «a riposo» era gia' −$55.
  const pnlFantasma = calcolaPnl({ baselineUsd: 1550.17633, totaleUsd: 1494.78 });
  const pnlVero = calcolaPnl({ baselineUsd: Number(s.riferimentoUsd), totaleUsd: 1494.78 });
  ok('  col fantasma il drawdown a riposo era ≥ $50; col riferimento vero è meno di $10',
    pnlFantasma.pnlUsd <= -50 && pnlVero.pnlUsd > -10, `${pnlFantasma.pnlUsd} / ${pnlVero.pnlUsd}`);
}

console.log('\n════ ② la proprietà generale: mai sopra il massimo confermato, su QUALUNQUE serie ════');
{
  // Serie deterministiche costruite a mano: piatta, in salita, con picchi isolati, con picchi doppi.
  const serie = {
    piatta: Array.from({ length: 20 }, (_, i) => [1000 + (i % 2) * 0.5, 100]),
    salita: Array.from({ length: 20 }, (_, i) => [1000 + i * 3, 100]),
    piccoIsolato: [[1000, 100], [1000.5, 100], [1400, 100], [1001, 100], [1000.7, 100], [1002, 100]],
    picchiRipetuti: [[1000, 100], [1300, 100], [1000, 100], [1305, 100], [1000, 100], [1310, 100], [1000, 100]],
    aSega: Array.from({ length: 40 }, (_, i) => [1000 + (i % 3 === 0 ? 90 : 0), 100]),
  };
  for (const [nome, s] of Object.entries(serie)) {
    const fine = corri(s);
    const conf = massimoConfermato(s);
    ok(`«${nome}»: riferimento $${Number(fine.riferimentoUsd).toFixed(2)} ≤ massimo confermato $${conf.toFixed(2)}`,
      Number(fine.riferimentoUsd) <= conf + 0.001, String(fine.riferimentoUsd));
  }
}

console.log('\n════ ③ il rumore normale non fa scattare, la perdita vera sì ════');
{
  // Riferimento costruito su una serie sana, poi si misura contro le escursioni VERE misurate:
  // 19/08 $1,92 · 20/08 $32,05 · 21/08 $38,12 (ripulite dai picchi a un campione).
  const s = corri(Array.from({ length: 10 }, () => [1501.63, 57]));
  const rif = Number(s.riferimentoUsd);
  const soglia = R.sogliaAssoluta({ riferimentoUsd: rif, pavimentoUsd: 30, frazione: 0.05 });
  for (const esc of [1.92, 32.05, 38.12, 41.83]) {
    const pnl = calcolaPnl({ baselineUsd: rif, totaleUsd: rif - esc });
    ok(`  un'escursione di $${esc.toFixed(2)} (misurata) NON fa scattare`,
      decidiScatto({ pnl, sogliaPct: 5, sogliaAbs: soglia.sogliaUsd }).scatta === false);
  }
  for (const perdita of [75.09, 120, 300]) {
    const pnl = calcolaPnl({ baselineUsd: rif, totaleUsd: rif - perdita });
    ok(`  una perdita di $${perdita.toFixed(2)} FA scattare: la rete c'è ancora`,
      decidiScatto({ pnl, sogliaPct: 5, sogliaAbs: soglia.sogliaUsd }).scatta === true);
  }
  ok('  e il punto di scatto resta il 5% del riferimento, non un numero nuovo',
    Math.abs(soglia.sogliaUsd - 0.05 * rif) < 0.01, String(soglia.sogliaUsd));
}

console.log('\n════ ④ la correzione può solo ABBASSARE il riferimento, mai alzarlo ════');
{
  // Modello del comportamento VECCHIO (k=1), scritto qui e non importato: serve a confrontare, non a
  // girare in produzione. Il massimo mobile saliva su una lettura sola.
  const vecchio = (serie) => serie.reduce((m, [t]) => Math.max(m, t), -Infinity);
  const serie = [
    [[1000, 100], [1400, 100], [1001, 100], [1002, 100]],
    [[1000, 100], [1010, 100], [1020, 100], [1030, 100]],
    Array.from({ length: 30 }, (_, i) => [1000 + Math.abs(((i * 37) % 23) - 11) * 9, 100]),
  ];
  let tutte = true;
  for (const s of serie) {
    const nuovo = Number(corri(s).riferimentoUsd);
    if (!(nuovo <= vecchio(s) + 0.001)) tutte = false;
  }
  ok('su ogni serie il riferimento nuovo è ≤ di quello vecchio', tutte);
  ok('  quindi il punto di scatto (0,95·rif) non sale MAI: la correzione toglie scatti, non ne aggiunge', tutte);
}

console.log('\n════ ⑤ fail-closed: una copia non è una conferma ════');
{
  const a = R.aggiornaRiferimento({ stato: null, capitale: cap(1000, 100), now: T0 }).stato;
  // Stesso totale E stesso istante di lettura del saldo = stessa voce di cache, non una seconda osservazione.
  const b = R.aggiornaRiferimento({ stato: a, capitale: cap(1200, 100), now: T0 + 30_000, osservazione: { saldoLetturaAt: T0 + 20_000 } });
  const c = R.aggiornaRiferimento({ stato: b.stato, capitale: cap(1200, 100), now: T0 + 60_000, osservazione: { saldoLetturaAt: T0 + 20_000 } });
  ok('due letture identiche dalla stessa voce di cache NON confermano', Math.abs(c.riferimentoUsd - 1000) < 0.01, String(c.riferimentoUsd));
  const d = R.aggiornaRiferimento({ stato: b.stato, capitale: cap(1200, 100), now: T0 + 60_000, osservazione: { saldoLetturaAt: null } });
  ok('  istante non leggibile ⇒ non si conferma (non si sale al buio)', Math.abs(d.riferimentoUsd - 1000) < 0.01, String(d.riferimentoUsd));
  const e = R.aggiornaRiferimento({ stato: b.stato, capitale: cap(1201, 101), now: T0 + 60_000, osservazione: { saldoLetturaAt: T0 + 50_000 } });
  ok('  due letture DISTINTE invece confermano, alla minore', Math.abs(e.riferimentoUsd - 1200) < 0.01, String(e.riferimentoUsd));
  const lontano = R.aggiornaRiferimento({ stato: b.stato, capitale: cap(1201, 101), now: T0 + 30_000 + 130_000, osservazione: { saldoLetturaAt: T0 + 155_000 } });
  ok('  e due letture NON contigue (oltre 120 s) non confermano: riparte il conteggio',
    Math.abs(lontano.riferimentoUsd - 1000) < 0.01, String(lontano.riferimentoUsd));
}

console.log('\n════ ⑥ la difesa verso il BASSO non è toccata ════');
{
  // La correzione riguarda solo la salita del riferimento. Una discesa vera continua a scattare, e la
  // conferma a due letture dello SCATTO resta quella di `guardian-perdite`, non duplicata qui.
  const s = corri([[1500, 100], [1501, 100], [1501, 100]]);
  const rif = Number(s.riferimentoUsd);
  // ⚠ La discesa deve venire dalle POSIZIONI, o il rilevatore di cassa esterna la legge — a ragione —
  // come un prelievo: a posizioni ferme un totale che cala di $200 È cassa uscita, non una perdita.
  const giu = R.aggiornaRiferimento({ stato: s, capitale: cap(1300, 0), now: T0 + 300_000, osservazione: { saldoLetturaAt: T0 + 295_000 } });
  ok('una discesa non abbassa il riferimento: il drawdown si misura dal picco',
    Math.abs(giu.riferimentoUsd - rif) < 0.01, String(giu.riferimentoUsd));
  const pnl = calcolaPnl({ baselineUsd: giu.riferimentoUsd, totaleUsd: 1300 });
  ok('  e su quella discesa il guardiano scatta',
    decidiScatto({ pnl, sogliaPct: 5, sogliaAbs: 0.05 * rif }).scatta === true);
}

console.log('\n════ ⑦ il modulo non ha superfici: non piazza e non cancella ════');
{
  // Cammina l'albero dei `require` raggiungibile da questo modulo: deve restare puro. Il difetto che
  // si previene e' che una correzione al riferimento diventi, un giorno, un percorso verso il venue.
  const path = require('path');
  const visti = new Set();
  const vietati = /adapter|cancel-all|manual-order|place|signer|relayer|credential/i;
  const cammina = (f) => {
    const abs = require.resolve(f);
    if (visti.has(abs) || abs.includes('node_modules')) return;
    visti.add(abs);
    const src = require('fs').readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/(?<!\/\/[^\n]{0,200})require\('(\.[^']+)'\)/g)) {
      try { cammina(path.resolve(path.dirname(abs), m[1])); } catch { /* non risolvibile: non e' un file nostro */ }
    }
  };
  cammina('./guardian-riferimento');
  const sospetti = [...visti].filter((f) => vietati.test(path.basename(f)));
  ok(`l'albero dei require è di ${visti.size} file e nessuno è una superficie di piazzamento/cancellazione`,
    sospetti.length === 0, sospetti.join(', '));
}

console.log(`\nguardian-riferimento-non-supera-il-confermato: ${pass} passati, ${fail} falliti`);
assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);

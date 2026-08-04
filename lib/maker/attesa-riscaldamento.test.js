#!/usr/bin/env node
'use strict';
// LA RETE SOTTO L'UNIONE MOBILE — e le sue regole di ingaggio.
//
// L'unione mobile copre il mercato che entra ed esce dalla graduatoria. Non copre quello che entra nel
// piano senza essere MAI stato né riga né quasi-vincitore: per quello la lista si scrive troppo tardi.
// Questa attesa è la rete sotto quel caso. Qui si prova che aspetta SOLO quando serve, che non abbassa
// mai il guard di freschezza, e che dall'attesa non si esce mai con un piano peggiore di quello iniziale.

const { attendiRiscaldamento, righeStantie } = require('./attesa-riscaldamento');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ID = (n) => '0x' + String(n).padStart(2, '0').repeat(32);
const esito = (capitale, scartate = []) => ({ rows: [], totals: { capitaleUsd: capitale }, scartate });
const stantia = (n) => ({ marketId: ID(n), motivo: 'stantio', dettaglio: 'dato vecchio di 3866s (limite 300s)' });
const fuoriBanda = (n) => ({ marketId: ID(n), motivo: 'fuori-banda', dettaglio: 'offset 9¢' });

/** Orologio finto: sleep() non dorme, fa avanzare il tempo. I test non aspettano davvero. */
function mondo(sequenza) {
  let t = 0, i = 0;
  const passi = [];
  return {
    passi,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    makePlan: async () => ({ rows: [], marker: i }),
    planToOrders: () => sequenza[Math.min(i++, sequenza.length - 1)],
    traccia: (fase, evento, dati) => passi.push({ fase, evento, ...dati }),
  };
}

console.log('\n══ QUANDO NON DEVE ASPETTARE');
(async () => {
  {
    const d = mondo([esito(600)]);
    const r = await attendiRiscaldamento({ piano: {}, esec: esito(300), capitale: 665, tetto: 199 }, d);
    ok('spenta di default: non aspetta e non ricalcola', r.esito === 'disattivata' && r.atteso === false && d.passi.length === 0);
    ok('  e restituisce il piano di partenza intatto', r.esec.totals.capitaleUsd === 300);
  }
  {
    const d = mondo([esito(600)]);
    const r = await attendiRiscaldamento({ piano: {}, esec: esito(320), capitale: 665, tetto: 199, enabled: true }, d);
    ok('accesa ma senza righe stantie: non aspetta un secondo', r.esito === 'niente-da-attendere' && r.attesaMs === 0);
  }
  {
    const d = mondo([esito(600)]);
    const r = await attendiRiscaldamento({ piano: {}, esec: esito(200, [fuoriBanda(1), fuoriBanda(2)]), capitale: 665, tetto: 199, enabled: true }, d);
    ok('righe scartate per motivi che il TEMPO NON GUARISCE: non aspetta', r.esito === 'niente-da-attendere' && r.tentativi === 0, 'fuori-banda non e stantio');
  }

  console.log('\n══ QUANDO ASPETTA');
  {
    // Lo scenario che la giustifica: due righe stantie, il raccoglitore le copre, il ricalcolo le trova fresche.
    const d = mondo([esito(188, [stantia(1), stantia(2)]), esito(310)]);
    const r = await attendiRiscaldamento({ piano: {}, esec: esito(188, [stantia(1), stantia(2)]), capitale: 665, tetto: 199, enabled: true }, d);
    ok('con righe stantie aspetta e ricalcola', r.atteso === true && r.tentativi >= 1);
    ok('  e quando il dato arriva chiude subito, senza consumare tutta l attesa', r.esito === 'risolto' && r.attesaMs < 25 * 60_000);
    ok('  restituendo il piano NUOVO, quello intero', r.esec.totals.capitaleUsd === 310 && r.stantieFinali === 0);
    ok('  il guadagno e dichiarato nel registro', d.passi.some((p) => p.evento === 'atteso') && d.passi.some((p) => p.evento === 'ricalcolato'));
  }
  {
    // Il dato non arriva mai: si esce allo scadere, con il meglio visto, e lo si dice.
    const perenne = esito(188, [stantia(1)]);
    const d = mondo([perenne, perenne, perenne, perenne, perenne, perenne, perenne, perenne, perenne, perenne]);
    const r = await attendiRiscaldamento({ piano: {}, esec: perenne, capitale: 665, tetto: 199, enabled: true, maxMs: 25 * 60_000, pollMs: 3 * 60_000 }, d);
    ok('se il dato non arriva l attesa SCADE, non gira all infinito', r.esito === 'scaduto');
    ok('  entro il tetto dichiarato', r.attesaMs <= 25 * 60_000, `${Math.round(r.attesaMs / 60_000)} min`);
    ok('  e la riga stantia resta scartata: il guard di freschezza non si abbassa mai', r.stantieFinali === 1);
    ok('  lo scadere e dichiarato, non silenzioso', d.passi.some((p) => p.evento === 'scaduto' && p.stantieResidue === 1));
  }
  {
    // Un ricalcolo può capitare in un momento PEGGIORE: da un'attesa non si esce mai in perdita.
    const partenza = esito(300, [stantia(1)]);
    const d = mondo([esito(90, [stantia(1), stantia(2)]), esito(120, [stantia(1)]), esito(80, [stantia(3)])]);
    const r = await attendiRiscaldamento({ piano: {}, esec: partenza, capitale: 665, tetto: 199, enabled: true, maxMs: 10 * 60_000, pollMs: 3 * 60_000 }, d);
    ok('se i ricalcoli sono peggiori si torna al piano di partenza', r.esec.totals.capitaleUsd === 300, `\$${r.esec.totals.capitaleUsd}`);
  }
  {
    const d = mondo([esito(400)]);
    d.makePlan = async () => { throw new Error('allocatore muto'); };
    const partenza = esito(188, [stantia(1)]);
    const r = await attendiRiscaldamento({ piano: {}, esec: partenza, capitale: 665, tetto: 199, enabled: true }, d);
    ok('se il ricalcolo fallisce non si perde il piano che c era', r.esito === 'ricalcolo-fallito' && r.esec.totals.capitaleUsd === 188);
    ok('  e il fallimento e a registro', d.passi.some((p) => p.evento === 'ricalcolo-fallito'));
  }

  console.log('\n══ IL CONTATORE');
  {
    ok('conta solo lo stantio, non tutti gli scarti', righeStantie(esito(0, [stantia(1), fuoriBanda(2), stantia(3)])).length === 2);
    ok('un esito senza scartate vale zero, non «chissà»', righeStantie(esito(0)).length === 0);
    ok('un esito nullo vale zero e non esplode', righeStantie(null).length === 0);
  }

  console.log(`\nattesa di riscaldamento: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

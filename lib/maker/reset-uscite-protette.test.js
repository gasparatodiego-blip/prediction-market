'use strict';
// lib/maker/reset-uscite-protette.test.js — IL RESET SPAZZA IL PIANO, NON CHI STA CHIUDENDO.
//
// ═══ IL DIFETTO CHE CHIUDE, E PERCHÉ NON BASTAVA CORREGGERE LA STRINGA ═════════════════════════════
// `SORGENTI_AUTOMATICHE` conteneva `'auto-close'`; il valore realmente scritto è `'auto-close-on-fill'`
// (`AUTO_CLOSE_SOURCE`). Misurato sul giornale vivo il 12 agosto 2026: **4.686 righe**
// `auto-close-on-fill → manual-ui`, zero `→ auto`. Le due stringhe non si incontravano dal commit che
// ha introdotto il meccanismo, quindi ogni uscita protettiva veniva registrata come «messa da una
// persona» e il reset non la toccava.
//
// L'effetto era quello desiderabile — le uscite sopravvivevano — ma per ACCIDENTE. Correggere la
// stringa e basta avrebbe fatto cominciare il reset a cancellarle, lasciando la posizione scoperta fino
// al giro successivo di agent40 (~60 s), senza che nessuno avesse deciso che va bene.
//
// Quindi la stringa è corretta E la regola è esplicita: esiste una terza origine, `auto-chiusura`, che
// il reset NON tocca per decisione. Questo test difende entrambe le metà — se qualcuno un giorno
// «semplificasse» facendo tornare la chiusura dentro `SORGENTI_AUTOMATICHE`, qui diventa rosso.
//
// Run: node lib/maker/reset-uscite-protette.test.js

const O = require('./origine-ordine');
const { AUTO_CLOSE_SOURCE } = require('./auto-close-config');
const { AUTO_REPRICE_SOURCE } = require('./auto-reprice-config');
const { TRACKING_SOURCE } = require('./mm-tracking');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1 · le costanti coincidono col valore REALMENTE scritto');
{
  ok('la sorgente di chiusura è quella vera', O.SORGENTI_DI_CHIUSURA.includes(AUTO_CLOSE_SOURCE),
    `AUTO_CLOSE_SOURCE = '${AUTO_CLOSE_SOURCE}'`);
  ok('  e NON è più la stringa sbagliata', !O.SORGENTI_DI_CHIUSURA.includes('auto-close')
    && !O.SORGENTI_AUTOMATICHE.includes('auto-close'),
    'era `auto-close`, che non compare come `source` da nessuna parte');
  ok('la sorgente del riprezzo è IMPORTATA, non ricopiata', O.SORGENTI_AUTOMATICHE.includes(AUTO_REPRICE_SOURCE),
    `AUTO_REPRICE_SOURCE = '${AUTO_REPRICE_SOURCE}'`);
  ok('la stringa del tracking coincide con la costante del motore', O.SORGENTI_AUTOMATICHE.includes(TRACKING_SOURCE),
    `TRACKING_SOURCE = '${TRACKING_SOURCE}'`);
  ok('la chiusura NON è fra le automatiche di piano', !O.SORGENTI_AUTOMATICHE.includes(AUTO_CLOSE_SOURCE),
    'è l\'intera ragione per cui esiste la terza origine');
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2 · il timbro alla nascita');
{
  ok(`'${AUTO_CLOSE_SOURCE}' → auto-chiusura`, O.origineDaSource(AUTO_CLOSE_SOURCE) === O.ORIGINE_AUTO_CHIUSURA);
  ok(`'${AUTO_REPRICE_SOURCE}' → auto`, O.origineDaSource(AUTO_REPRICE_SOURCE) === O.ORIGINE_AUTO);
  ok(`'${TRACKING_SOURCE}' → auto`, O.origineDaSource(TRACKING_SOURCE) === O.ORIGINE_AUTO);
  ok("'manual-ui' → manual-ui (il pannello)", O.origineDaSource('manual-ui') === O.ORIGINE_MANUALE);
  ok("agent41 che dichiara 'auto' vince sul difetto", O.origineDaSource('manual-ui', 'auto') === O.ORIGINE_AUTO);
  ok('una sorgente sconosciuta resta MANUALE (il verso sicuro)', O.origineDaSource('corsia-che-non-esiste') === O.ORIGINE_MANUALE);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3 · LA PROPRIETÀ: un ordine di chiusura sopravvive al reset, uno di piano no');
{
  // La mappa è quella che `mappaOrigini` costruirebbe dal giornale.
  const mappa = new Map([
    ['ORD-CHIUSURA', O.ORIGINE_AUTO_CHIUSURA],
    ['ORD-PIANO', O.ORIGINE_AUTO],
    ['ORD-MANO', O.ORIGINE_MANUALE],
  ]);
  const ordini = [
    { orderId: 'ORD-CHIUSURA', marketId: '0xaa', price: 0.81, size: 32 },
    { orderId: 'ORD-PIANO', marketId: '0xaa', price: 0.34, size: 61 },
    { orderId: 'ORD-MANO', marketId: '0xbb', price: 0.50, size: 10 },
    { orderId: 'ORD-SENZA-TIMBRO', marketId: '0xcc', price: 0.20, size: 5 },
  ];
  const sep = O.separaPerOrigine(ordini, mappa);
  const ids = (a) => a.map((x) => x.orderId).sort();

  ok('SOLO l\'ordine di piano finisce fra i cancellabili', JSON.stringify(ids(sep.automatici)) === JSON.stringify(['ORD-PIANO']),
    ids(sep.automatici).join(', '));
  ok('l\'ordine di CHIUSURA sopravvive', ids(sep.daLasciare).includes('ORD-CHIUSURA'));
  ok('  ed è contato a parte, come protetto', ids(sep.protetti).join() === 'ORD-CHIUSURA',
    'il referto deve poter dire QUANTE uscite ha risparmiato, non solo quante righe ha lasciato');
  ok('l\'ordine dell\'operatore sopravvive', ids(sep.daLasciare).includes('ORD-MANO'));
  ok('l\'ordine di origine IGNOTA sopravvive', ids(sep.daLasciare).includes('ORD-SENZA-TIMBRO'),
    'fra cancellare l\'ordine di una persona e lasciare in piedi quello di uno scheduler, solo il primo distrugge lavoro');
  ok('  e la sua origine è dichiarata `ignota`, non indovinata',
    sep.daLasciare.find((x) => x.orderId === 'ORD-SENZA-TIMBRO').origine === O.ORIGINE_IGNOTA);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4 · il percorso completo: timbro → registro → reset');
{
  // Come nascerebbe davvero: `origineDaSource` al piazzamento, la riga nel giornale, poi il reset.
  const timbro = O.origineDaSource(AUTO_CLOSE_SOURCE);
  const mappa = new Map([['ORD-1', timbro]]);
  const sep = O.separaPerOrigine([{ orderId: 'ORD-1', marketId: '0xaa' }], mappa);
  ok('un\'uscita di auto-close, dal timbro al reset, NON viene cancellata',
    sep.automatici.length === 0 && sep.protetti.length === 1);

  // E la controprova sul difetto storico: con la stringa vecchia il timbro sarebbe stato `manual-ui`,
  // cioè l'uscita sarebbe sopravvissuta lo stesso — ma come «ordine di una persona».
  ok('CONTROPROVA: prima l\'uscita risultava messa da una PERSONA',
    O.ORIGINE_AUTO_CHIUSURA !== O.ORIGINE_MANUALE,
    'stesso esito pratico, ma adesso il registro dice la verità su chi l\'ha voluta');
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n5 · la mappa dal giornale riconosce la terza origine');
{
  const os = require('os'); const fsx = require('fs'); const px = require('path');
  const d = fsx.mkdtempSync(px.join(os.tmpdir(), 'orig-'));
  const f = px.join(d, 'g.jsonl');
  fsx.writeFileSync(f, [
    JSON.stringify({ orderId: 'A', origine: O.ORIGINE_AUTO_CHIUSURA }),
    JSON.stringify({ orderId: 'B', origine: O.ORIGINE_AUTO }),
    JSON.stringify({ orderId: 'C', origine: O.ORIGINE_MANUALE }),
    JSON.stringify({ orderId: 'D', origine: 'qualcosa-che-non-esiste' }),
    '',
  ].join('\n'));
  const m = O.mappaOrigini({ auditFile: f });
  ok('`auto-chiusura` viene letta dal giornale', m.get('A') === O.ORIGINE_AUTO_CHIUSURA,
    'senza questo le righe nuove sarebbero invisibili e ricadrebbero in `ignota`');
  ok('  e le altre due restano', m.get('B') === O.ORIGINE_AUTO && m.get('C') === O.ORIGINE_MANUALE);
  ok('  un valore inventato viene ignorato', m.get('D') === undefined);
  fsx.rmSync(d, { recursive: true, force: true });
}

console.log(`\n===== reset-uscite-protette: ${pass} passati, ${fail} falliti =====\n`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
'use strict';
// IL PANNELLO CHE GUARDA E BASTA — e che dice «non lo so» invece di disegnare uno zero.
//
// ═══ I DUE MODI IN CUI UNA VISTA LIVE MENTE ══════════════════════════════════════════════════════════
//   1. MOSTRANDO UN NUMERO CHE NON HA. Un mid non leggibile disegnato come 0¢, o una distanza calcolata
//      contro un mid assente, sono peggio di una cella vuota: un operatore prende decisioni su quello.
//   2. TACENDO UNO STATO DI PAUSA. Se il motore ha messo un mercato in pausa perché il mid è vecchio e il
//      pannello continua a mostrare l'ultimo numero buono, la schermata dice «tutto normale» proprio nel
//      momento in cui non lo è. È il difetto del feed fermo del 6 agosto, in versione grafica.
//
// E il terzo, che riguarda la sicurezza e non la verità: un pannello di sola lettura che col tempo
// impara a piazzare. Qui si verifica sul SORGENTE che la rotta non importi niente che possa farlo.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const { componiMidVivo } = require('./mid-vivo');
const { MID_STALE_PAUSE_SEC } = require('./mm-tracking');
const ROOT = path.resolve(__dirname, '..', '..');

const MKT = '0x' + 'ee'.repeat(32);
const ALTRO = '0x' + 'ff'.repeat(32);

console.log('\n══ 1 · LA DISTANZA DAL MID, COL SEGNO GIUSTO');
{
  const books = { markets: { [MKT]: { mid: 0.50, ageMs: 2_000, live: true, title: 'Mercato A' } } };
  const ordini = [
    { orderId: 'a', marketId: MKT, side: 'BUY', price: 0.48, size: 50, sizeRemaining: 50 },
    { orderId: 'b', marketId: MKT, side: 'SELL', price: 0.52, size: 50, sizeRemaining: 30 },
    { orderId: 'c', marketId: MKT, side: 'BUY', price: 0.50, size: 10, sizeRemaining: 10 },
  ];
  const s = componiMidVivo(books, ordini, MID_STALE_PAUSE_SEC);
  const m = s.mercati[0];
  ok('un mercato, tre ordini', s.mercati.length === 1 && m.ordini.length === 3);
  ok('ordine sotto il mid ⇒ distanza negativa', m.ordini[0].distanzaCents === -2 && m.ordini[0].latoDelMid === 'sotto', String(m.ordini[0].distanzaCents));
  ok('ordine sopra il mid ⇒ distanza positiva', m.ordini[1].distanzaCents === 2 && m.ordini[1].latoDelMid === 'sopra', String(m.ordini[1].distanzaCents));
  ok('ordine sul mid ⇒ zero, e lo dice', m.ordini[2].distanzaCents === 0 && m.ordini[2].latoDelMid === 'sul');
  ok('il titolo viene dal feed', m.title === 'Mercato A');
  ok('la size residua è quella che resta', m.ordini[1].sizeRemaining === 30);
}

console.log('\n══ 2 · QUELLO CHE NON SI SA NON DIVENTA UN NUMERO');
{
  // Mercato assente dallo snapshot: non è «mid zero», è «mid sconosciuto».
  const s = componiMidVivo({ markets: {} }, [{ orderId: 'a', marketId: MKT, side: 'BUY', price: 0.48 }], MID_STALE_PAUSE_SEC);
  const m = s.mercati[0];
  ok('mercato non nel feed ⇒ mid null, non 0', m.mid === null);
  ok('  e la distanza è null, non calcolata contro il nulla', m.ordini[0].distanzaCents === null && m.ordini[0].latoDelMid === null);
  ok('  e il mercato risulta STANTIO, non fresco', m.midStantio === true, 'nel dubbio, in pausa');
  ok('  e non è dichiarato live', m.live === false);

  const senzaFeed = componiMidVivo(null, [{ orderId: 'a', marketId: MKT, price: 0.48 }], MID_STALE_PAUSE_SEC);
  ok('snapshot del feed illeggibile ⇒ feedLetto false', senzaFeed.feedLetto === false, 'il pannello lo dichiara in rosso');

  const prezzoRotto = componiMidVivo(
    { markets: { [MKT]: { mid: 0.5, ageMs: 1_000, live: true } } },
    [{ orderId: 'a', marketId: MKT, price: null }], MID_STALE_PAUSE_SEC);
  ok('ordine senza prezzo ⇒ distanza null', prezzoRotto.mercati[0].ordini[0].distanzaCents === null);
}

console.log('\n══ 3 · LO STATO «MID STANTIO» È QUELLO DEL MOTORE, NON UNO SUO');
{
  const soglia = MID_STALE_PAUSE_SEC;
  const con = (ageMs) => componiMidVivo(
    { markets: { [MKT]: { mid: 0.5, ageMs, live: true } } },
    [{ orderId: 'a', marketId: MKT, price: 0.5 }], soglia).mercati[0];

  ok(`sotto la soglia (${soglia}s) ⇒ non stantio`, con((soglia - 1) * 1000).midStantio === false);
  ok('  esattamente sulla soglia ⇒ non stantio', con(soglia * 1000).midStantio === false);
  ok('  sopra la soglia ⇒ STANTIO', con((soglia + 1) * 1000).midStantio === true);
  ok('  età assente ⇒ STANTIO', con(undefined).midStantio === true);
  ok('la soglia viaggia nel dato, così il pannello può dirla', con(1000).sogliaStantioSec === soglia, `${soglia}s`);

  // La copia della soglia è il difetto da impedire: il pannello deve leggerla dal motore.
  const src = fs.readFileSync(path.join(ROOT, 'lib/maker/mid-vivo.js'), 'utf8');
  ok('il modulo non tiene una copia della soglia',
    !/MID_STALE_PAUSE_SEC\s*=/.test(src) && /sogliaStantioSec/.test(src),
    'la riceve da chi chiama, che la legge da mm-tracking');
}

console.log('\n══ 4 · PIÙ MERCATI: raggruppati, ordinati, nessuno perso');
{
  const books = { markets: {
    [MKT]: { mid: 0.5, ageMs: 1_000, live: true, title: 'Zebra' },
    [ALTRO]: { mid: 0.2, ageMs: 1_000, live: true, title: 'Alfa' },
  } };
  const s = componiMidVivo(books, [
    { orderId: '1', marketId: MKT, price: 0.49 },
    { orderId: '2', marketId: ALTRO, price: 0.19 },
    { orderId: '3', marketId: MKT, price: 0.51 },
    { orderId: '4', marketId: null, price: 0.4 },     // senza mercato: non inventiamo dove metterlo
  ], MID_STALE_PAUSE_SEC);
  ok('due mercati', s.mercati.length === 2);
  ok('  ordinati per titolo', s.mercati[0].title === 'Alfa' && s.mercati[1].title === 'Zebra');
  ok('  gli ordini finiscono sotto il proprio mercato', s.mercati[1].ordini.length === 2 && s.mercati[0].ordini.length === 1);
  ok('  un ordine senza marketId viene scartato, non attribuito a caso',
    s.mercati.reduce((a, m) => a + m.ordini.length, 0) === 3);
  ok('nessun ordine a riposo ⇒ nessun mercato',
    componiMidVivo(books, [], MID_STALE_PAUSE_SEC).mercati.length === 0);
}

console.log('\n══ 5 · SOLA LETTURA, PROVATO SUL SORGENTE');
{
  // Sul CODICE, non sui commenti: l'intestazione della rotta nomina apposta le funzioni che NON usa, e
  // un controllo che non sa distinguere le due cose fallirebbe proprio sulla frase che spiega la regola.
  // È lo stesso helper con cui percorsi-dati.test.js fa la stessa distinzione.
  const { soloCodice } = require(path.join(ROOT, 'scripts', 'percorsi-dati.js'));
  const rottaGrezza = fs.readFileSync(path.join(ROOT, 'app/api/maker/live-mid/route.ts'), 'utf8');
  const rotta = soloCodice(rottaGrezza);
  ok('la rotta espone solo GET', /export async function GET/.test(rotta)
    && !/export async function (POST|PUT|PATCH|DELETE)/.test(rotta));
  for (const vietato of ['placeManualOrder', 'cancelManualOrder', 'replaceManualOrder', 'createMakerAdapter',
    'buildReadCancelAdapter', 'signTypedData', 'postOrder', 'createOrder']) {
    ok(`  non nomina ${vietato}`, !new RegExp(vietato).test(rotta));
  }
  ok('  e l\'unica cosa che importa dalla corsia manuale è la lettura',
    /listManualOrders/.test(rotta), 'listManualOrders e nient\'altro');

  const pannello = fs.readFileSync(path.join(ROOT, 'app/components/MidVivoPanel.tsx'), 'utf8');
  ok('il pannello non fa nessuna scrittura HTTP',
    !/method:\s*['"]POST|fetch\([^)]*POST/.test(pannello) && !/<form/.test(pannello));
  ok('  e non ha bottoni che agiscono', !/<button/.test(pannello));
  ok('  e ascolta in PUSH, senza polling',
    /new EventSource\(/.test(pannello) && !/setInterval\(/.test(pannello),
    'nessun setInterval nel componente');
  ok('il freno sta sul server, non nel browser',
    /THROTTLE_MS/.test(rotta) && /sogliaFrenoMs/.test(rotta),
    'gli eventi scartati non pagano nemmeno la serializzazione');
  ok('  e il server guarda la CARTELLA, non il file (rename atomico)',
    /fs\.watch\(LIVE_BOOKS_DIR/.test(rotta) && /name !== LIVE_BOOKS_NAME/.test(rotta));
}

console.log(`\nmid vivo: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

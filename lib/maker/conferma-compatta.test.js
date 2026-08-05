#!/usr/bin/env node
'use strict';
// LA CONFERMA COMPATTA — E LO STATO DEL BOOK, CHE NON PUÒ PIÙ CONTRADDIRSI.
//
// ═══ I DUE DIFETTI ═══════════════════════════════════════════════════════════════════════════════════
//
// 1 · «BOOK NON LIVE» ACCANTO A «BOOK LIVE · 2 MIN FA». Stesso pannello, stesso oggetto `quote`, DUE
//     regole: la testata guardava fonte + vitalità + età, l'etichetta di freschezza solo la fonte.
//     Chiamare «live» la PROVENIENZA di un numero è l'errore: il feed pubblica anche i book fermi.
//     La parte peggiore non è la contraddizione visibile — è che quando le due regole concordano per
//     caso, cioè quasi sempre, l'etichetta sbagliata sembra confermare quella giusta.
//
// 2 · IL PERCORSO OBBLIGATO VERSO L'INVIO. Per piazzare bisognava scorrere blocco dati, order book
//     intero e due note, toccare una riga del libro per aprire il popup, compilare, rivedere dodici
//     righe e confermare — due volte, con due gambe. La parte che decide (prezzo, size, incrocia?, in
//     banda?) arrivava dopo tutto il resto.
//
// ═══ COSA QUESTO TEST PRETENDE ═══════════════════════════════════════════════════════════════════════
// Che i valori mostrati siano quelli VERI e mai un ripiego; che il pulsante che invia resti spento se
// manca un dato o se un gate non passa; e che i gate esistenti non siano stati toccati — la conferma
// compatta è presentazione, e una presentazione non deve poter allentare una regola.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const OP = leggi('app', 'components', 'OrderPanel.tsx');
const MAN = leggi('app', 'components', 'ManualOrdersPanel.tsx');

const S = require('./stato-book');
const R = require('./riepilogo-ordine');

console.log('\n══ 1 · LO STATO DEL BOOK, ESERCITATO DAVVERO');
pass += S.selfcheck();

console.log('\n══ 2 · IL RIEPILOGO, ESERCITATO DAVVERO');
pass += R.selfcheck();

console.log('\n══ 3 · LA CONTRADDIZIONE NON PUÒ TORNARE: UNA REGOLA SOLA NEL PANNELLO');
{
  ok('il pannello importa il verdetto condiviso', /from '@\/lib\/maker\/stato-book'/.test(OP));
  ok('  e il badge della testata viene da lì', /\{stato\.badge\}/.test(OP));
  ok('  e l etichetta di freschezza pure', /const quoteAge = stato\.freschezza/.test(OP));
  ok('  e anche il colore, dallo stesso tono', /is-\$\{stato\.tono\}/.test(OP));

  // LA REGRESSIONE, NOMINATA: nessuna SECONDA regola che decida «live» da sola. `bookLive` resta, ma
  // ora è un alias del verdetto — non un calcolo parallelo.
  ok('NESSUNA seconda regola che deduca «live» dalla sola fonte',
    !/source === 'live-book' \? 'book live'/.test(OP),
    'era esattamente la riga che scriveva «book live · 2 min fa»');
  ok('  e `bookLive` è il verdetto, non un secondo calcolo',
    /const bookLive = stato\.live;/.test(OP));

  // Lo stesso difetto stava sull'altro pannello, in un'altra forma: l'avviso scattava sulla
  // provenienza e taceva su un mid fermo che veniva dal feed.
  ok('anche il pannello manuale giudica la freschezza, non la provenienza',
    /from '@\/lib\/maker\/stato-book'/.test(MAN) && /!statoPrezzo\.live &&/.test(MAN));
  ok('  e non guarda più solo `midSource`',
    !/rules\.midSource !== 'live-book' && \(/.test(MAN));
}

console.log('\n══ 4 · IL RIEPILOGO MOSTRA I VALORI VERI (punto 5 del mandato)');
{
  // Il caso del piano: prezzo e size arrivano dalla gamba calcolata, e si vedono quelli.
  const dalPiano = R.riepilogoOrdine({
    title: 'Republican Senate exactly 7', book: 'yes', price: 0.78, size: 24.7,
    distanceCents: 1.5, bandRadiusCents: 2.25, fonte: 'piano',
    verdict: { level: 'ok', crosses: false, outOfBand: false, messages: [] },
  });
  const v = (r, k) => (r.righe.find((x) => x.chiave === k) || {}).v;
  ok('dal piano: prezzo e size sono quelli della gamba',
    v(dalPiano, 'prezzo') === '0.78' && v(dalPiano, 'size') === '24.7 share');
  ok('  e il lato è quello della gamba', v(dalPiano, 'lato') === 'BUY YES');
  ok('  con i due controlli in chiaro',
    v(dalPiano, 'incrocia') === 'no' && v(dalPiano, 'in-banda') === 'SÌ');
  ok('  e si può confermare', dalPiano.completo === true);

  // Il caso dei campi digitati vuoti: `Number('')` fa 0, e uno zero in un riepilogo si legge come un
  // prezzo. È lo stesso difetto già corretto nel pannello manuale, qui su un'altra schermata.
  const vuoto = R.riepilogoOrdine({ title: 'M', book: 'yes', price: NaN, size: NaN });
  ok('campi vuoti: MAI uno zero al posto di un prezzo',
    v(vuoto, 'prezzo') === 'N/D' && v(vuoto, 'size') === 'N/D' && v(vuoto, 'controvalore') === 'N/D');
  ok('  nessun valore mostrato è «0» in nessuna riga',
    vuoto.righe.every((r) => !/^0(\.0+)?( share)?$/.test(String(r.v)) && !/^\$0\.00$/.test(String(r.v))));
  ok('  E IL RIEPILOGO SI DICHIARA INCOMPLETO', vuoto.completo === false);

  // Nessun placeholder: un mercato senza titolo non prende il titolo di un altro né un nome inventato.
  ok('senza titolo si scrive N/D, non un nome di ripiego',
    v(R.riepilogoOrdine({ book: 'yes', price: 0.5, size: 20 }), 'mercato') === 'N/D');

  // E il pannello alimenta il modulo con i valori che verrebbero INVIATI, non con una copia.
  ok('il pannello ordine passa al riepilogo prezzo e size reali',
    /riepilogoOrdine\(\{[\s\S]{0,200}price, size,/.test(OP));
  ok('  e li deriva da `numeroDigitato`, che non trasforma il vuoto in zero',
    /const size = numeroDigitato\(sizeStr\) \?\? NaN/.test(OP)
    && /const price = numeroDigitato\(priceStr\) \?\? NaN/.test(OP));
  ok('il pannello manuale passa gli stessi campi allo stesso modulo',
    /riepilogoOrdine\(\{[\s\S]{0,240}price: priceNum, size: sizeNum,/.test(MAN));
}

console.log('\n══ 5 · IL PULSANTE CHE INVIA RESTA SPENTO (punto 5 del mandato)');
{
  // La condizione nuova si SOMMA, non sostituisce: `canReview` e `canPlace` devono restare dov'erano.
  ok('pannello ordine: il gate di sempre è ancora nella condizione',
    /disabled=\{busy \|\| trkBusy \|\| !canReview \|\| !riepilogo\.completo\}/.test(OP),
    'canReview c è ancora, e la nuova condizione può solo spegnere');
  ok('  e `canReview` continua a nascere dai gate bloccanti',
    /const canReview = blocking\.length === 0;/.test(OP));
  ok('pannello manuale: idem, `canPlace` più il riepilogo',
    /disabled=\{!canPlace \|\| !riepilogo\.completo\}/.test(MAN));
  ok('  e `canPlace` non è stato allentato',
    /!placing && !killed && manualOn && !overCap &&[\s\S]{0,120}verdict\?\.valid === true && notional != null/.test(MAN));

  // La prova che conta: con un dato mancante il riepilogo è incompleto, quindi il bottone è spento
  // QUALUNQUE cosa dicano gli altri gate.
  const casi = [
    ['senza prezzo', { book: 'yes', price: NaN, size: 20 }],
    ['senza size', { book: 'yes', price: 0.5, size: NaN }],
    ['senza lato', { book: null, price: 0.5, size: 20 }],
    ['prezzo a zero', { book: 'yes', price: 0, size: 20 }],
    ['size a zero', { book: 'yes', price: 0.5, size: 0 }],
    ['prezzo fuori da (0,1)', { book: 'yes', price: 1, size: 20 }],
  ];
  for (const [nome, a] of casi) {
    ok(`  ${nome} → incompleto, bottone spento`, R.riepilogoOrdine(a).completo === false);
  }
  ok('con tutto a posto, il riepilogo non blocca',
    R.riepilogoOrdine({ book: 'no', price: 0.19, size: 24.7 }).completo === true,
    'un blocco che scatta sempre è un blocco che si impara a ignorare');
}

console.log('\n══ 6 · IL CONTROLLO DI SICUREZZA È IN CHIARO, E IL TERZO ESITO ESISTE');
{
  const v = (r, k) => (r.righe.find((x) => x.chiave === k) || {}).v;
  const t = (r, k) => (r.righe.find((x) => x.chiave === k) || {}).tono;
  const base = { book: 'yes', price: 0.82, size: 20 };

  const incrocia = R.riepilogoOrdine({ ...base, verdict: { level: 'bad', crosses: true, outOfBand: false, messages: [] } });
  ok('un prezzo che incrocia lo dice PRIMA della conferma',
    v(incrocia, 'incrocia') === 'SÌ' && t(incrocia, 'incrocia') === 'bad');
  const fuori = R.riepilogoOrdine({ ...base, verdict: { level: 'warn', crosses: false, outOfBand: true, messages: [] } });
  ok('fuori banda lo dice, in giallo', v(fuori, 'in-banda') === 'no' && t(fuori, 'in-banda') === 'warn');
  const ignoto = R.riepilogoOrdine({ ...base, verdict: { level: 'unknown', crosses: false, outOfBand: null, messages: [] } });
  ok('BOOK ILLEGGIBILE ≠ BOOK SICURO: «non verificabile», e non è verde',
    v(ignoto, 'in-banda') === 'non verificabile' && t(ignoto, 'in-banda') !== 'ok');

  // Il verdetto NON viene riscritto nei pannelli: è `priceVerdict`, la funzione condivisa.
  ok('il pannello ordine usa il verdetto condiviso', /priceVerdict\(\{/.test(OP));
  ok('  e ora anche il pannello manuale, che prima non controllava l incrocio',
    /priceVerdict\(\{/.test(MAN) && /from '@\/lib\/maker\/book-view'/.test(MAN));
}

console.log('\n══ 7 · IL PERCORSO OBBLIGATO SI È ACCORCIATO');
{
  ok('esiste una strada diretta alla verifica, senza passare dal book',
    /data-op-goreview/.test(OP) && /setSheetStep\('review'\); setSheetOpen\(true\)/.test(OP));
  ok('  e non invia niente: apre soltanto', !/data-op-goreview[\s\S]{0,300}place\(\)/.test(OP));
  ok('l order book completo è dietro un tocco opzionale',
    /data-op-book-toggle/.test(OP) && /\{bookAperto && \(<>/.test(OP));
  ok('  e parte chiuso', /useState\(false\);\n  const \[bookAperto/.test(OP) || /const \[bookAperto, setBookAperto\] = useState\(false\)/.test(OP));
  ok('le impostazioni secondarie sono piegate nel riepilogo',
    /data-op-review-more/.test(OP) && /const \[reviewDetails, setReviewDetails\] = useState\(false\)/.test(OP));
  ok('arrivando dal piano si atterra sulla verifica, non sul modulo',
    /autoAperto\.current = target\.marketId;[\s\S]{0,120}setSheetStep\('review'\)/.test(OP));
  ok('  una volta sola per mercato, così chiudere non lo fa riaprire',
    /if \(autoAperto\.current === target\.marketId\) return;/.test(OP));
  ok('il pannello manuale ha lo stesso passo di verifica',
    /data-manual-goreview/.test(MAN) && /setPasso\('verifica'\)/.test(MAN));
  ok('  e cambiare un valore riporta al modulo',
    /useEffect\(\(\) => \{ setPasso\('form'\); \}, \[price, size, book/.test(MAN),
    'un riepilogo costruito su numeri cambiati nel frattempo non è un riepilogo');
}

console.log('\n══ 8 · NESSUN TEST PIAZZA NIENTE, E I MODULI NON POSSONO');
{
  const sb = leggi('lib', 'maker', 'stato-book.js');
  const ro = leggi('lib', 'maker', 'riepilogo-ordine.js');
  for (const [nome, src] of [['stato-book', sb], ['riepilogo-ordine', ro]]) {
    ok(`${nome} non conosce la rete`, !/fetch\(/.test(src) && !/\/api\//.test(src) && !/require\('http/.test(src));
  }
  ok('e nessuno dei due decide se un ordine è valido',
    !/valid/.test(sb) && !/crossesBook|validateQuote/.test(ro),
    'la presentazione non deve poter allentare una regola');
}

console.log(`\nconferma compatta: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

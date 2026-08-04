#!/usr/bin/env node
'use strict';
// UN MODULO VUOTO NON È UN MODULO SBAGLIATO.
//
// ═══ IL DIFETTO ══════════════════════════════════════════════════════════════════════════════════════
// 4 agosto 2026, pannello «Nuovo ordine a mano». Bottone PIAZZA ORDINE disattivato e tre errori sotto:
//
//     PRICE_OUT_OF_RANGE   price 0 is outside the venue range [0.001, 0.999]
//     OUT_OF_BAND          |price − scoring mid| 53.55¢ exceeds the reward band ±2.25¢
//     BELOW_MIN_SIZE       size is missing or ≤ 0
//
// mentre nei campi si leggeva 0.536 e 50. Sembrava un guard che validava un input diverso da quello
// mostrato. Non lo era: quei due numeri erano i PLACEHOLDER — il mid del mercato (`scoringMid.toFixed(3)`,
// riga 852) e la size minima del venue (riga 900) — il form era vuoto, e `Number('')` vale 0.
//
// La prova aritmetica: il mid vero di Harry Kane è 0.5355, e |0 − 0.5355| = 53.55¢. Esattamente la cifra
// dell'errore. Il guard leggeva zero perché zero è ciò che il parsing gli consegnava.
//
// ═══ COSA ERA DAVVERO ROTTO ══════════════════════════════════════════════════════════════════════════
// Non l'aritmetica: l'epistemica. L'assenza di un dato trattata come il valore zero — la stessa cosa che
// questo repo rifiuta ovunque (un montepremi illeggibile non è zero, una scadenza assente non è «scade
// domani») applicata al posto più banale e per questo dimenticato.
//
// E il ramo giusto ESISTEVA: «Inserisci prezzo e size» era già scritto sotto il bottone, ed era
// irraggiungibile perché `verdict && !verdict.valid` scattava prima, su un verdetto emesso per 0/0.

const fs = require('fs');
const path = require('path');
const { validateQuote } = require('./venue-rules');
const { numeroDigitato } = require('../campo-numerico');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// Le regole VERE di Harry Kane, lette dal venue il 4 agosto 2026 (non inventate):
//   tick 0.001 · banda reward 4.5¢ (±2.25¢) · min_incentive_size 50 share · scoring mid YES 0.5355
const KANE = { tick: 0.001, scoringMid: 0.5355, maxSpreadCents: 4.5, minSize: 50 };

// La riproduzione ESATTA della catena del pannello: stringa del campo → parsing → verdetto.
// Se un domani il pannello smettesse di usare `numeroDigitato`, il test sotto ai sorgenti se ne accorge.
function pannello(priceStr, sizeStr, rules = KANE) {
  const priceNum = numeroDigitato(priceStr);
  const sizeNum = numeroDigitato(sizeStr);
  const verdict = (priceNum == null || sizeNum == null)
    ? null
    : validateQuote(rules, { side: 'BUY', price: priceNum, size: sizeNum });
  const notional = priceNum != null && sizeNum != null && priceNum > 0 && sizeNum > 0 ? priceNum * sizeNum : null;
  // Lo stesso messaggio che il pannello mostra sotto il bottone, nello stesso ordine di priorità.
  const nota = verdict && !verdict.valid ? 'La quota non passa il guard condiviso.' : 'Inserisci prezzo e size.';
  return { priceNum, sizeNum, verdict, notional, nota, canPlace: verdict?.valid === true && notional != null };
}
const codici = (v) => (v ? v.reasons.map((r) => r.code).sort() : []);

console.log('\n══ 1 · IL MODULO VUOTO: nessun verdetto, e il messaggio giusto');
{
  const p = pannello('', '');
  ok('prezzo non digitato → null, NON zero', p.priceNum === null);
  ok('size non digitata → null, NON zero', p.sizeNum === null);
  ok('NESSUN VERDETTO su un modulo vuoto', p.verdict === null,
    'prima era un verdetto invalido con tre errori');
  ok('  quindi nessun PRICE_OUT_OF_RANGE inventato', !codici(p.verdict).includes('PRICE_OUT_OF_RANGE'));
  ok('  nessun OUT_OF_BAND da 53.55¢', !codici(p.verdict).includes('OUT_OF_BAND'));
  ok('  nessun BELOW_MIN_SIZE', !codici(p.verdict).includes('BELOW_MIN_SIZE'));
  ok('IL MESSAGGIO È QUELLO UTILE', p.nota === 'Inserisci prezzo e size.',
    'il ramo esisteva già ed era irraggiungibile');
  ok('  e il bottone resta giustamente disattivato', p.canPlace === false);
}

console.log('\n══ 2 · LA PROVA ARITMETICA DEL SINTOMO RIPORTATO');
{
  // Cosa faceva il codice di prima: Number('') → 0, e il guard rispondeva su quello.
  const comePrima = validateQuote(KANE, { side: 'BUY', price: Number(''), size: Number('') });
  ok('Number(\'\') è 0, non NaN', Number('') === 0);
  ok('  e su 0/0 il guard rifiuta — CORRETTAMENTE, per quei valori', comePrima.valid === false);
  ok('  con esattamente i tre codici riportati dall operatore',
    codici(comePrima).join(',') === 'BELOW_MIN_SIZE,OUT_OF_BAND,PRICE_OUT_OF_RANGE', codici(comePrima).join(','));
  const banda = comePrima.reasons.find((r) => r.code === 'OUT_OF_BAND');
  ok('  e con i 53.55¢ della segnalazione: |0 − 0.5355|', /53\.55/.test(banda.detail), banda.detail);
  ok('IL GUARD NON ERA ROTTO: era il parsing a consegnargli uno zero', comePrima.valid === false);
}

console.log('\n══ 3 · PREZZO IN BANDA E SIZE SOPRA IL MINIMO → IL GUARD PASSA (punto 7)');
{
  const p = pannello('0.536', '50');
  ok('prezzo digitato letto come 0.536', p.priceNum === 0.536);
  ok('size digitata letta come 50', p.sizeNum === 50);
  ok('IL VERDETTO È VALIDO', p.verdict && p.verdict.valid === true, JSON.stringify(codici(p.verdict)));
  ok('  nessun motivo di rifiuto', codici(p.verdict).length === 0);
  ok('  controvalore calcolato', Math.abs(p.notional - 26.8) < 1e-9, String(p.notional));
  ok('  e il bottone si sblocca', p.canPlace === true);
}

console.log('\n══ 4 · UNO ZERO DIGITATO A MANO DEVE ANCORA BLOCCARE (punto 7, secondo caso)');
{
  const p = pannello('0', '50');
  ok('«0» digitato è un numero, non un campo vuoto', p.priceNum === 0);
  ok('  quindi il verdetto viene EMESSO', p.verdict !== null,
    'non l abbiamo reso silenzioso: «non l ho scritto» e «ho scritto zero» sono cose diverse');
  ok('  e rifiuta', p.verdict.valid === false);
  ok('  con PRICE_OUT_OF_RANGE', codici(p.verdict).includes('PRICE_OUT_OF_RANGE'));
  ok('  e OUT_OF_BAND a 53.55¢', codici(p.verdict).includes('OUT_OF_BAND'));
  ok('  il bottone resta bloccato', p.canPlace === false);
}

console.log('\n══ 5 · GLI ALTRI CASI CHE NON DEVONO ESSERE CONFUSI COL VUOTO');
{
  ok('prezzo fuori banda VERO (0.60) → blocca con OUT_OF_BAND',
    codici(pannello('0.60', '50').verdict).includes('OUT_OF_BAND'));
  ok('  e non con PRICE_OUT_OF_RANGE: 0.60 è un prezzo legittimo',
    !codici(pannello('0.60', '50').verdict).includes('PRICE_OUT_OF_RANGE'));
  ok('size sotto il minimo (30) → BELOW_MIN_SIZE',
    codici(pannello('0.536', '30').verdict).includes('BELOW_MIN_SIZE'));
  ok('prezzo fuori griglia (0.5365 su tick 0.001) → OFF_TICK',
    codici(pannello('0.5365', '50').verdict).includes('OFF_TICK'));
  ok('solo il prezzo digitato, size ancora vuota → nessun verdetto',
    pannello('0.536', '').verdict === null);
  ok('  e viceversa', pannello('', '50').verdict === null);
  ok('testo non numerico → nessun verdetto, mai NaN al guard',
    pannello('abc', '50').verdict === null);
}

console.log('\n══ 6 · IL PANNELLO USA DAVVERO QUESTA REGOLA (il cablaggio, non la logica)');
{
  const src = leggi('app', 'components', 'ManualOrdersPanel.tsx');
  ok('importa numeroDigitato dal modulo condiviso',
    /import \{ numeroDigitato \} from '@\/lib\/campo-numerico'/.test(src));
  ok('  e lo usa per il prezzo', /const priceNum = numeroDigitato\(price\)/.test(src));
  ok('  e per la size', /const sizeNum = numeroDigitato\(size\)/.test(src));
  ok('LA VECCHIA FORMA NON C È PIÙ — era questa il difetto',
    !/const priceNum = Number\(price\)/.test(src) && !/const sizeNum = Number\(size\)/.test(src));
  ok('il verdetto non viene emesso su campi non digitati',
    /priceNum == null \|\| sizeNum == null\) return null/.test(src));
  ok('e l invio ha un fermo strutturale suo', /if \(priceNum == null \|\| sizeNum == null\) return;/.test(src));

  // Gli altri due pannelli che avevano già l'idioma giusto: la simmetria si prova elencandoli.
  const ru = leggi('app', 'components', 'RewardsUnified.tsx');
  const mt = leggi('app', 'components', 'MarketTerminal.tsx');
  ok('RewardsUnified trattava già il vuoto come assenza', /sizeInput\.trim\(\) !== ''/.test(ru));
  ok('MarketTerminal pure', /sizeInput\.trim\(\) !== ''/.test(mt));

  // E il pannello ordine dell'allocatore, che NON aveva il difetto: il vuoto lo dice, non lo accusa.
  const op = leggi('app', 'components', 'OrderPanel.tsx');
  ok('OrderPanel gestiva già il campo vuoto con un messaggio utile',
    /Inserisci una size\./.test(op) && /!fin\(size\) \|\| size <= 0/.test(op));
}

console.log('\n══ 7 · NESSUN PERCORSO AUTOMATICO LEGGE UN FORM');
{
  // La preoccupazione legittima: agent41 piazza con valori diversi da quelli calcolati?
  const plan = leggi('lib', 'rewards', 'plan-to-orders.js');
  ok('il piano calcola i prezzi dalle quotazioni, non da un campo',
    /planQuotes/.test(plan) && !/Number\(price\)/.test(plan));
  const ag41 = leggi('agents', 'agent41-realloc-scheduler.js');
  ok('agent41 non importa nessun componente di UI', !/components\//.test(ag41));
  // E la rete di sicurezza vera: lo schema del server rifiuta uno zero comunque.
  const route = leggi('app', 'api', 'maker', 'manual', 'order', 'route.ts');
  ok('la route rifiuta price ≤ 0 nello schema', /price: z\.number\(\)\.finite\(\)\.gt\(0\)/.test(route),
    'anche se il pannello avesse inviato 0, non sarebbe mai arrivato al venue');
  ok('  e size ≤ 0 pure', /size: z\.number\(\)\.finite\(\)\.gt\(0\)/.test(route));
}

console.log(`\ncampo vuoto non è zero: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

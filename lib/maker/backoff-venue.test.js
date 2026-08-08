'use strict';
// lib/maker/backoff-venue.test.js — RALLENTARE QUANDO IL VENUE LO CHIEDE, E GUARDARE PRIMA DI RITENTARE.
//
// Due proprietà, e la seconda protegge da un guasto che costa il doppio del capitale:
//   · un 429 non si tratta come un 5xx, e `Retry-After` vince su qualunque progressione inventata;
//   · dopo un esito AMBIGUO (la POST era partita) non si ritenta mai alla cieca — si guarda al venue, e
//     una verifica che non riesce vale «non ritentare», non «ritenta».
//
// Run: node lib/maker/backoff-venue.test.js

const fs = require('fs');
const path = require('path');
const {
  attesaBackoff, leggiRetryAfter, classificaErrore, verificaDopoAmbiguo,
  BASE_TRANSITORIO_MS, BASE_RATE_LIMIT_MS, ATTESA_MAX_MS,
} = require('./backoff-venue');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

console.log('\n1 · un 429 non è un 5xx');
{
  ok('5xx parte da 250 ms (invariato)', attesaBackoff({ tentativo: 1, status: 503 }).attesaMs === BASE_TRANSITORIO_MS);
  ok('  e raddoppia', attesaBackoff({ tentativo: 2, status: 503 }).attesaMs === 500
    && attesaBackoff({ tentativo: 3, status: 503 }).attesaMs === 1000);
  ok('429 parte da un secondo', attesaBackoff({ tentativo: 1, status: 429 }).attesaMs === BASE_RATE_LIMIT_MS);
  ok('  e raddoppia: 1 s → 2 s → 4 s', attesaBackoff({ tentativo: 2, status: 429 }).attesaMs === 2000
    && attesaBackoff({ tentativo: 3, status: 429 }).attesaMs === 4000);
  ok('  quindi un rate limit aspetta 4× un errore transitorio',
    attesaBackoff({ tentativo: 1, status: 429 }).attesaMs === 4 * attesaBackoff({ tentativo: 1, status: 503 }).attesaMs);
  ok('la fonte dell\'attesa è dichiarata', attesaBackoff({ tentativo: 1, status: 429 }).fonte === 'rate-limit'
    && attesaBackoff({ tentativo: 1, status: 503 }).fonte === 'transitorio');
}

console.log('\n2 · `Retry-After` VINCE: è il venue che sa, non la nostra formula');
{
  const r = attesaBackoff({ tentativo: 1, status: 429, retryAfter: '7' });
  ok('in secondi', r.attesaMs === 7000 && r.fonte === 'retry-after', `${r.attesaMs}ms`);
  ok('  anche al terzo tentativo la progressione non lo scavalca',
    attesaBackoff({ tentativo: 3, status: 429, retryAfter: '2' }).attesaMs === 2000);
  const NOW = Date.parse('2026-08-08T20:00:00Z');
  const d = attesaBackoff({ tentativo: 1, status: 429, retryAfter: 'Sat, 08 Aug 2026 20:00:05 GMT', now: NOW });
  ok('come data HTTP', d.attesaMs === 5000, `${d.attesaMs}ms`);
  ok('  una data già passata vale zero, non un numero negativo',
    attesaBackoff({ tentativo: 1, status: 429, retryAfter: 'Sat, 08 Aug 2026 19:59:00 GMT', now: NOW }).attesaMs === 0);
  ok('un Retry-After enorme è limitato', attesaBackoff({ tentativo: 1, status: 429, retryAfter: '3600' }).attesaMs === ATTESA_MAX_MS,
    'un ciclo che sorveglia capitale non può congelarsi un\'ora');
  ok('un header illeggibile non azzera l\'attesa: si ripiega sulla progressione',
    leggiRetryAfter('boh') === null && attesaBackoff({ tentativo: 1, status: 429, retryAfter: 'boh' }).attesaMs === BASE_RATE_LIMIT_MS);
  ok('  e un header assente idem', leggiRetryAfter(null) === null && leggiRetryAfter('') === null);
}

console.log('\n3 · la classificazione: solo l\'invio rende un errore ambiguo');
{
  const amb = classificaErrore({ inviata: true, messaggio: 'socket hang up' });
  ok('POST partita + errore ⇒ AMBIGUO', amb.tipo === 'ambiguo' && amb.ritentabileAllaCieca === false);
  ok('  e vale anche con un 4xx: quel che conta è che la richiesta era partita',
    classificaErrore({ inviata: true, status: 400 }).tipo === 'ambiguo');
  ok('rete caduta PRIMA dell\'invio ⇒ transitorio, ritentabile',
    classificaErrore({ inviata: false, messaggio: 'ETIMEDOUT' }).tipo === 'transitorio');
  ok('429 su una lettura ⇒ transitorio', classificaErrore({ inviata: false, status: 429 }).tipo === 'transitorio');
  ok('5xx senza invio ⇒ transitorio', classificaErrore({ inviata: false, status: 502 }).tipo === 'transitorio');
  ok('400 di validazione ⇒ netto, ritentabile senza rischio',
    classificaErrore({ inviata: false, status: 400, messaggio: 'invalid price' }).tipo === 'netto');
}

console.log('\n4 · dopo l\'ambiguo si GUARDA — e il verso del fallimento è quello sicuro');
{
  const nostro = { orderId: 'x1', tokenId: '111', side: 'BUY', price: 0.19, size: 32.27 };
  const trovato = verificaDopoAmbiguo({ ordini: [nostro], tokenId: '111', side: 'BUY', price: 0.19, size: 32.27 });
  ok('l\'ordine c\'è ⇒ NON si ritenta', trovato.trovato === true && trovato.ritentare === false);
  ok('  e si recupera il suo id', trovato.orderId === 'x1');

  const assente = verificaDopoAmbiguo({ ordini: [], tokenId: '111', side: 'BUY', price: 0.19, size: 32.27 });
  ok('il venue risponde e non c\'è niente ⇒ si può ritentare', assente.trovato === false && assente.ritentare === true);

  // IL CASO CHE CONTA: la verifica non riesce. `null` non è «non c'è».
  const cieco = verificaDopoAmbiguo({ ordini: null, tokenId: '111' });
  ok('verifica FALLITA ⇒ trovato null e NON si ritenta', cieco.trovato === null && cieco.ritentare === false,
    'fra due ordini e zero ordini, il secondo errore costa meno');

  // Non si confonde l\'ordine di qualcun altro (o un altro nostro) con questo.
  ok('un ordine su un altro token non conta',
    verificaDopoAmbiguo({ ordini: [{ ...nostro, tokenId: '222' }], tokenId: '111', side: 'BUY', price: 0.19, size: 32.27 }).trovato === false);
  ok('un ordine sull\'altro lato non conta',
    verificaDopoAmbiguo({ ordini: [{ ...nostro, side: 'SELL' }], tokenId: '111', side: 'BUY', price: 0.19, size: 32.27 }).trovato === false);
  ok('un ordine a un altro prezzo non conta',
    verificaDopoAmbiguo({ ordini: [{ ...nostro, price: 0.18 }], tokenId: '111', side: 'BUY', price: 0.19, size: 32.27 }).trovato === false);
  ok('un ordine PIÙ GRANDE di quello chiesto non è il nostro',
    verificaDopoAmbiguo({ ordini: [{ ...nostro, size: 100 }], tokenId: '111', side: 'BUY', price: 0.19, size: 32.27 }).trovato === false);
  ok('  ma un residuo più piccolo sì: è un fill parziale del nostro',
    verificaDopoAmbiguo({ ordini: [{ ...nostro, sizeRemaining: 10 }], tokenId: '111', side: 'BUY', price: 0.19, size: 32.27 }).trovato === true);
}

console.log('\n5 · il cablaggio nell\'adapter');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'venues', 'polymarket-clob-maker', 'adapter.js'), 'utf8');
  ok('il backoff è quello di questo modulo', /attesaBackoff\(\{ tentativo: attempt, status, retryAfter: hdr/.test(src));
  ok('  e legge l\'header Retry-After dalla risposta', /headers\['retry-after'\]/.test(src));
  ok('la verifica dopo l\'ambiguo interroga il venue', /verificaDopoAmbiguo\(\{ ordini: letti/.test(src));
  ok('  e un ordine trovato viene dichiarato RIUSCITO, non fallito', /verificatoDopoAmbiguo: true/.test(src));
  // LA PROPRIETÀ CHE NON DEVE CAMBIARE: la POST non si ritenta da sola, mai.
  ok('la POST resta NON avvolta in withRetry', /DELIBERATELY NOT WRAPPED IN withRetry/.test(src),
    'ritentare una POST è il modo classico di ritrovarsi due ordini da un\'intenzione sola');
  const iPost = src.indexOf('async function postOrder');
  const iCatch = src.indexOf('} catch (e) {', iPost);
  const corpo = src.slice(iPost, iCatch);
  ok('  e nel corpo dell\'invio non compare withRetry', !/withRetry/.test(corpo));
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);

'use strict';
// scripts/osserva/registro-24h.test.js — L'OSSERVATORE DELLA FINESTRA NON PUO' TOCCARE CAPITALE.
//
// Non e' una promessa scritta in un commento: si cammina l'albero dei `require` e si pretende che
// **non esca dai builtin di node**. E' la stessa prova che difende `agent45` e `agent42`, e la ragione
// e' la stessa: un processo che osserva capitale vero deve essere incapace di muoverlo per STRUTTURA,
// perche' fra un anno nessuno rileggera' il commento.
//
// Piu' due proprieta' della ricostruzione, che sono il motivo per cui questo file esiste:
//   ② la scadenza GTD si applica anche senza un record che la dichiari — e' l'errore del 18 agosto;
//   ③ «non ho letto» non diventa mai «non c'e'».

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passati = 0;
const ok = (c, n, x) => { assert.ok(c, n + (x ? ` — ${x}` : '')); passati += 1; };

const FILE = path.join(__dirname, 'registro-24h.js');

// ══ ① ZERO REQUIRE OLTRE AI BUILTIN ═════════════════════════════════════════════════════════════
{
  const src = fs.readFileSync(FILE, 'utf8');
  // ⚠ Si filtrano i commenti PRIMA di cercare: un commento che *racconta* un require ha gia' fatto
  //   passare un test che cercava la stringa nel sorgente (§5.3).
  const codice = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const trovati = [...codice.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  ok(trovati.length > 0, '① il walker trova davvero dei require', trovati.join(', '));
  const fuori = trovati.filter((r) => r.startsWith('.') || r.startsWith('/'));
  ok(fuori.length === 0,
    '① ⚑ nessun require RELATIVO: l osservatore non puo raggiungere ne adapter ne credenziali',
    fuori.join(', ') || '(nessuno)');
  const consentiti = new Set(['fs', 'path']);
  const estranei = trovati.filter((r) => !consentiti.has(r));
  ok(estranei.length === 0, '① e nemmeno un builtin fuori da fs/path', estranei.join(', ') || '(nessuno)');

  // Il rovescio: le superfici che NON devono comparire nemmeno come stringa eseguibile.
  for (const vietato of ['adapter', 'placeManualOrder', 'runBulkAllocation', 'cancelOrder', 'createOrder', 'signer']) {
    ok(!new RegExp(`require\\([^)]*${vietato}`, 'i').test(codice),
      `① nessun require che nomini «${vietato}»`);
  }
  // ⚠ NON TOCCA NESSUN FILE ALTRUI. Scrive due cose, entrambe sue: il proprio giornale (in APPEND,
  //   mai riscritto) e il proprio pidfile. Cancellare o rinominare non compare affatto — un
  //   osservatore che potesse rimuovere un file potrebbe rimuovere una prova.
  ok(!/unlinkSync|rmSync|renameSync|rmdirSync|truncateSync/.test(codice),
    '① ⚑ non cancella, non rinomina, non tronca: un osservatore non rimuove prove');
  const scritture = [...codice.matchAll(/(appendFileSync|writeFileSync)\(\s*([A-Za-z_]+)/g)].map((m) => `${m[1]}→${m[2]}`);
  ok(scritture.every((x) => x === 'appendFileSync→USCITA' || x === 'writeFileSync→PIDFILE'),
    '① ⚑ le uniche scritture sono il proprio giornale (append) e il proprio pidfile',
    scritture.join(', '));
}

const R = require('./registro-24h');

// ══ ② LA SCADENZA GTD VALE ANCHE SENZA UN RECORD — l'errore del 18 agosto ═══════════════════════
{
  R.vivi.clear();
  const T = 1_787_000_000_000;
  R.applica({ ts: T, op: 'manual-place', outcome: 'sent', orderId: 'a', marketRef: 'cid_0xAAA',
    requested: { book: 'yes', side: 'BUY', price: 0.5, size: 10, notionalUsd: 5, ttlSeconds: 1380 } });
  R.applica({ ts: T, op: 'manual-place', outcome: 'sent', orderId: 'b', marketRef: 'cid_0xBBB',
    requested: { book: 'no', side: 'BUY', price: 0.4, size: 10, notionalUsd: 4, ttlSeconds: 1380 } });
  ok(R.riepilogoLibro(T + 1000).ordini === 2, '② due ordini appena nati sono vivi');

  // Nessun `order-vanished`, nessun `scaduto-senza-rinnovo`: solo il tempo che passa.
  const potati = R.potaScaduti(T + 1381 * 1000);
  ok(potati === 2, '② ⚑ oltre la GTD sono morti ANCHE SE nessuno l ha scritto', `potati ${potati}`);
  ok(R.riepilogoLibro(T + 1381 * 1000).ordini === 0,
    '② ⚑ sommare gli invii e togliere le sole scadenze REGISTRATE e cio che il 18 agosto dichiaro il doppio del vero');

  // Un ttl ignoto non si indovina: si tiene, e il conteggio lo dira'.
  R.vivi.clear();
  R.applica({ ts: T, op: 'manual-place', outcome: 'sent', orderId: 'c', marketRef: 'cid_0xCCC',
    requested: { book: 'yes', side: 'BUY', price: 0.5, size: 10, notionalUsd: 5 } });
  ok(R.potaScaduti(T + 10 * 3600 * 1000) === 0, '② ttl ignoto ⇒ non si pota a indovinare');
}

// ══ ③ NASCITA E MORTE PASSANO TUTTE DALLA STESSA CHIAVE ════════════════════════════════════════
{
  const T = 1_787_000_000_000;
  for (const morte of [
    { ts: T + 1, op: 'manual-cancel', outcome: 'ok', requested: { orderId: 'x' } },
    { ts: T + 1, op: 'order-vanished', outcome: 'expired', orderId: 'x' },
    { ts: T + 1, op: 'auto-reprice', outcome: 'scaduto-senza-rinnovo', orderId: 'x' },
    { ts: T + 1, op: 'manual-replace', outcome: 'sent', requested: { orderId: 'x' } },
  ]) {
    R.vivi.clear();
    R.applica({ ts: T, op: 'manual-place', outcome: 'sent', orderId: 'x', marketRef: 'cid_0xAAA',
      requested: { book: 'yes', side: 'BUY', price: 0.5, size: 10, notionalUsd: 5, ttlSeconds: 1380 } });
    R.applica(morte);
    ok(R.riepilogoLibro(T + 2).ordini === 0, `③ «${morte.op}/${morte.outcome}» toglie l ordine dal libro`);
  }
}

// ══ ④ UN ORDINE SENZA NOZIONALE NON VALE ZERO ══════════════════════════════════════════════════
{
  R.vivi.clear();
  const T = 1_787_000_000_000;
  R.applica({ ts: T, op: 'manual-place', outcome: 'sent', orderId: 'z', marketRef: 'cid_0xZZZ',
    requested: { book: 'yes', side: 'BUY', price: 0.5, size: 10, ttlSeconds: 1380 } });
  const r = R.riepilogoLibro(T + 1);
  ok(r.ordini === 1 && r.nozionaleUsd === 0 && r.ordiniSenzaNozionale === 1,
    '④ ⚑ il totale in dollari e dichiarato incompleto invece di mentire in difetto in silenzio',
    JSON.stringify(r));
}

// ══ ⑤ IL CAMPIONE SI SCRIVE ANCHE QUANDO UNA FONTE TACE ════════════════════════════════════════
{
  const c = R.campione(Date.now());
  for (const k of ['libro', 'libroAutorevole', 'divergenza', 'piano', 'selezione', 'selezioneStato',
    'posizioni', 'premio', 'interruttori']) {
    ok(Object.prototype.hasOwnProperty.call(c, k), `⑤ il campione porta «${k}»`);
  }
  ok(c.divergenza && typeof c.divergenza.calcolabile === 'boolean',
    '⑤ ⚑ la divergenza fra lettura e ricostruzione e SEMPRE dichiarata, mai omessa');
}

console.log(`registro-24h: ${passati}/${passati} verdi, 0 rossi`);

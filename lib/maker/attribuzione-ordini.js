'use strict';
// lib/maker/attribuzione-ordini.js — CHI HA PIAZZATO QUESTO ORDINE. Una risposta sola, per tutti.
//
// ═══ PERCHÉ ESISTE COME MODULO SUO ══════════════════════════════════════════════════════════════════
// Queste due funzioni vivevano dentro lib/maker/manual-order.js, che è il modulo del PIAZZAMENTO: chi
// lo importa si tira dietro l'adapter che firma ordini. Va benissimo per il pannello, che deve poterlo
// fare; è inaccettabile per agent37-maker-watchdog, la cui garanzia strutturale è di NON poter piazzare
// nemmeno per errore (non importa lib/venues/polymarket-clob-maker/* in nessun punto del suo albero).
//
// E il guardiano ha bisogno proprio di questa risposta. Il 6 agosto 2026 ha cancellato nove ordini
// perché il battito di agent35 era fermo — ma quei nove ordini erano della corsia MANUALE, cioè di
// agent40, che in quel momento stava girando benissimo. agent35 non li aveva piazzati e non li avrebbe
// mai toccati: per tutta la notte ha scritto «manual mode active, skip — the operator holds this market
// by hand». Il guardiano non poteva saperlo perché non aveva modo di chiedere chi fosse il proprietario.
//
// Estrarre invece di ricopiare: una SECONDA implementazione dell'attribuzione sarebbe una seconda
// opinione su chi possiede un ordine reale, e le due potrebbero divergere senza che nessuno se ne
// accorga — proprio nel momento in cui si decide cosa cancellare.
//
// ═══ COME SI ATTRIBUISCE, E PERCHÉ NON SI INDOVINA ══════════════════════════════════════════════════
// Dal registro append-only (data/polymarket-maker-audit.jsonl): ogni riga scritta dal pannello o dai
// suoi automatismi porta la sua `source` e il suo `orderId`. Un ordine il cui id compare lì è della
// corsia manuale; ogni altro è di agent35 — ma SOLO se abbiamo letto almeno una chiave, altrimenti la
// risposta è 'unknown'. Un registro vuoto significa «non lo so», non «è di agent35»: attribuire senza
// prove è esattamente il modo in cui si cancella l'ordine di qualcun altro.
//
// ═══ IL REGISTRO È APPEND-ONLY, QUINDI SI LEGGE PER CODA ════════════════════════════════════════════
// (Questo blocco viene da manual-order.js insieme al codice, perché descrive proprio questo codice.)
//
// Prima si faceva readFileSync() dell'intero registro e si splittava sui newline a OGNI chiamata. Era
// sopravvivibile finché l'unico chiamante era una richiesta HTTP ogni 20s dentro il processone della
// dashboard. Ha smesso di esserlo nell'istante in cui agent40 ha cominciato a chiamarla su un ciclo da
// 5 secondi: il registro era già a 80 MB / 268k righe, quindi ogni chiamata allocava una stringa da
// 80 MB PIÙ un array di 268k stringhe, il processo sfondava i 340 MB e pm2 lo uccideva al tetto di
// 200 MB circa due volte al minuto — un loop di riavvii con log degli errori vuoto ed exit code 0, che
// sembra un mistero finché non si guarda l'RSS.
//
// Il file è APPEND-ONLY, ed è esattamente la proprietà che rende semplice la correzione: si ricorda
// l'offset già consumato e si legge solo ciò che è stato appeso. Un ciclo tranquillo fa una stat() e
// restituisce il Set in cache, senza allocare niente. Oggi il registro supera i 500 MB, e il costo a
// regime è lo stesso di quando ne pesava 80.
//
// DETTAGLI DI CORRETTEZZA, nessuno facoltativo:
//   • ROTAZIONE / TRONCAMENTO invalidano l'offset. Si rilevano dal cambio di inode o dal file più CORTO
//     del nostro offset; in entrambi i casi il Set si ricostruisce da zero invece di leggere spazzatura.
//   • UNA RIGA FINALE PARZIALE (un append in volo) non va parsata e non va persa — resta in `tail` e
//     viene anteposta alla lettura successiva.
//   • UTF-8 MULTI-BYTE può stare a cavallo di due chunk (il registro porta prosa italiana con accenti),
//     quindi si decodifica con StringDecoder, che bufferizza una sequenza incompleta invece di corromperla.
//   • UN FILE ILLEGGIBILE restituisce ciò che già sappiamo, non un Set vuoto: perdere l'attribuzione
//     ri-accrediterebbe in silenzio ad agent35 gli ordini del pannello, e chi tocca solo ciò che sa
//     attribuire smetterebbe di sorvegliare proprio l'ordine che aveva appena piazzato. Oggi la posta è
//     più alta: lo stesso errore, letto dal guardiano, gli farebbe cancellare l'ordine di un altro.

const fs = require('fs');
const path = require('path');
const { AUTO_REPRICE_SOURCE } = require('./auto-reprice-config');
const { AUTO_CLOSE_SOURCE } = require('./auto-close-config');

// ── WHO ACTED, ON EVERY LINE ────────────────────────────────────────────────────────────────────────
// Le sorgenti della CORSIA MANUALE — cioè tutto ciò che nasce dal pannello o da un automatismo che
// muove ordini del pannello:
//   'manual-ui'               un umano ha premuto un pulsante;
//   'auto-reprice-band-exit'  il watcher di banda (agent40) ha spostato un ordine perché il mid si è mosso;
//   AUTO_CLOSE_SOURCE         l'uscita automatica, e il rimpiazzo della gamba eseguita;
//   'mm-tracking'             il motore di market making a due lati, anch'esso in agent40.
// La sorgente 'agent35' è timbrata dal motore automatico e non compare MAI qui. L'elenco è
// un'ALLOWLIST: un chiamante non può inventarsi una sorgente, e niente che arrivi via HTTP può
// impostarne una (gli schemi delle rotte non accettano il campo).
const MANUAL_SOURCES = Object.freeze(['manual-ui', AUTO_REPRICE_SOURCE, AUTO_CLOSE_SOURCE, 'mm-tracking']);

const _idemCache = { keys: new Set(), offset: 0, ino: null, tail: '', decoder: null };

/**
 * Le chiavi (idempotencyKey e orderId) che la corsia manuale ha scritto nel registro.
 *
 * Incrementale e bounded: legge solo ciò che è stato appeso dall'ultima chiamata, un MiB per volta. Un
 * file assente o illeggibile lascia la cache com'era — non la svuota, perché «non ho potuto leggere» non
 * è «non c'è niente», e la seconda lettura farebbe attribuire ad agent35 ordini del pannello.
 */
function manualIdempotencyKeys(deps = {}) {
  let file = deps.auditFile;
  if (!file) {
    try { file = path.join(require('../safety/store').DATA_DIR, 'polymarket-maker-audit.jsonl'); }
    catch { return _idemCache.keys; }
  }

  let st;
  try { st = fs.statSync(file); }
  catch { return _idemCache.keys; }   // absent/unreadable ⇒ keep what we know, never forget it

  if (_idemCache.ino !== st.ino || st.size < _idemCache.offset) {
    _idemCache.keys = new Set();
    _idemCache.offset = 0;
    _idemCache.tail = '';
    _idemCache.ino = st.ino;
    _idemCache.decoder = null;
  }
  if (st.size === _idemCache.offset) return _idemCache.keys;   // nothing appended — the common case

  const ingest = (line) => {
    // Cheap pre-filter before the JSON.parse. It must list EVERY panel-owned source: an order the watcher
    // re-priced is still the panel's order.
    if (!line || !MANUAL_SOURCES.some((s) => line.indexOf(s) !== -1)) return;
    let row; try { row = JSON.parse(line); } catch { return; }
    if (!row || !MANUAL_SOURCES.includes(row.source)) return;
    if (row.idempotencyKey) _idemCache.keys.add(row.idempotencyKey);
    if (row.orderId) _idemCache.keys.add(String(row.orderId));
  };

  const { StringDecoder } = require('string_decoder');
  if (!_idemCache.decoder) _idemCache.decoder = new StringDecoder('utf8');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const CHUNK = 1 << 20;                       // 1 MiB at a time — bounded, whatever the file grows to
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = _idemCache.offset;
    let carry = _idemCache.tail;
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, st.size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + _idemCache.decoder.write(buf.subarray(0, n));
      const lines = text.split('\n');
      carry = lines.pop();                       // may be a partial line; never parsed here
      for (const line of lines) ingest(line);
    }
    _idemCache.offset = pos;
    _idemCache.tail = carry;
  } catch {
    /* a read failure leaves the cache exactly as it was — offset included, so the next call retries */
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return _idemCache.keys;
}

/**
 * Chi ha piazzato questo ordine del venue: 'manual-ui' | 'agent35' | 'unknown'.
 *
 * 'unknown' non è un dettaglio: significa che il registro non ci ha ancora detto niente, e chi decide
 * di cancellare deve trattarlo come «non è mio», non come «è dell'altro».
 */
function attributeOrder(o, manualKeys) {
  const id = o && (o.id || o.orderID || o.order_id || o.orderId);
  if (id && manualKeys.has(String(id))) return 'manual-ui';
  // No positive evidence that the panel placed it. The engine is the only other writer on this account,
  // but saying so without evidence would be a guess — report what we can prove.
  return manualKeys.size === 0 ? 'unknown' : 'agent35';
}

module.exports = { MANUAL_SOURCES, manualIdempotencyKeys, attributeOrder };

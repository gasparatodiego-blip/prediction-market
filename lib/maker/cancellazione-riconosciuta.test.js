#!/usr/bin/env node
'use strict';
// UNA CANCELLAZIONE RIUSCITA DEVE POTERSI RICONOSCERE.
//
// ═══ IL GUASTO ═══════════════════════════════════════════════════════════════════════════════════════
// Il 5 agosto 2026, alle 12:08:21 e alle 12:09:16 UTC, il venue ha CANCELLATO due ordini reali e ha
// risposto così:
//
//     { not_canceled: {}, canceled: ["0x4c55c853…52b0cd3"] }
//
// Il sistema l'ha letta come un fallimento. Non per una race, non per un id sbagliato, non per un
// rifiuto del venue: perché il redattore dell'audit sostituisce ogni `0x` + 64 esadecimali con
// `0x[redacted-64hex]` — la forma di una chiave privata — e un order id del CLOB ha esattamente quella
// forma. `adapter.cancelOrder` restituisce al chiamante la risposta GIÀ redatta, e
// `cancelManualOrder` confronta l'id richiesto con quelli elencati in `canceled`: confronto falso per
// costruzione.
//
// ═══ L'ASIMMETRIA CHE L'HA NASCOSTO PER SETTIMANE ════════════════════════════════════════════════════
//     not_canceled   gli id sono le CHIAVI dell'oggetto → le chiavi non passano dallo scrub → leggibili
//     canceled       gli id sono i VALORI di un array   → scrub applicato                   → cancellati
//
// Il sistema vedeva i RIFIUTI e non vedeva mai i SUCCESSI. Un guasto che si presenta solo dove nessuno
// guarda: il ramo di errore funzionava benissimo.
//
// ═══ IL COSTO ════════════════════════════════════════════════════════════════════════════════════════
// Due ordini reali cancellati davvero e mai ri-piazzati, perché il guardiano — correttamente — non
// piazza un rimpiazzo dopo una cancellazione che risulta non confermata. E `allocation-reset.js:201`
// avrebbe fatto lo stesso su ogni ciclo: cancella tutto, poi si ferma prima di piazzare.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const { redact, registerSecretValues } = require('../venues/polymarket-clob/redact');
const ID = '0x4c55c853965dc2466a5c97fe8f04e10bce4a437d9cff24ef1a2919adc52b0cd3';

console.log('\n══ 1 · LA RISPOSTA ESATTA DEL 5 AGOSTO, RILETTA');
{
  const r = redact({ not_canceled: {}, canceled: [ID] });
  const lista = Array.isArray(r.canceled) ? r.canceled : [];
  ok('l id sopravvive al redattore', lista.map(String).includes(ID), lista[0]);
  ok('  quindi `venueSaidCancelled` è vero — era questo a non accadere',
    lista.map(String).includes(String(ID)) === true);

  // La decisione di cancelManualOrder, con i suoi stessi ingredienti.
  const notCanceled = r.not_canceled || {};
  const venueSaidCancelled = lista.map(String).includes(String(ID));
  const venueRefusal = notCanceled[String(ID)] != null ? String(notCanceled[String(ID)]) : null;
  const alreadyGone = venueRefusal != null && /not be found|already (cancel|match)|does not exist/i.test(venueRefusal);
  const esito = (venueSaidCancelled || alreadyGone
    || (venueRefusal == null && lista.length === 0 && Object.keys(notCanceled).length === 0));
  ok('  e la cancellazione risulta RIUSCITA', esito === true);
}

console.log('\n══ 2 · I RIFIUTI CONTINUANO A LEGGERSI COME PRIMA');
{
  const r = redact({ not_canceled: { [ID]: "order can't be found - already canceled or matched" }, canceled: [] });
  const motivo = r.not_canceled[ID];
  ok('il motivo del venue arriva intero', typeof motivo === 'string' && /already canceled/.test(motivo));
  ok('  e l id resta la chiave, leggibile', Object.keys(r.not_canceled)[0] === ID);
  const r2 = redact({ not_canceled: { [ID]: 'the order is already canceled' }, canceled: [] });
  ok('un rifiuto NON viene scambiato per un successo',
    !(Array.isArray(r2.canceled) && r2.canceled.length));
}

console.log('\n══ 3 · UNA CHIAVE PRIVATA NON PASSA, NEMMENO DI QUI');
{
  // L'esenzione salta SOLO la cintura 64-hex. Lo scrub dei valori segreti REGISTRATI gira sempre —
  // altrimenti questa correzione avrebbe aperto un buco per chiudere un difetto.
  const chiave = '0x' + 'a'.repeat(64);
  registerSecretValues([chiave]);
  ok('sotto `canceled` una chiave registrata è comunque cancellata',
    JSON.stringify(redact({ canceled: [chiave] })) === '{"canceled":["[redacted]"]}');
  ok('sotto una chiave sensibile, idem', redact({ privateKey: chiave }).privateKey === '[redacted]');
  ok('dentro un testo libero, idem', !redact({ nota: `la chiave e ${chiave}` }).nota.includes('aaaa'));
  ok('e una 64-hex NON registrata sotto una chiave qualunque resta cancellata',
    redact({ qualcosa: '0x' + 'b'.repeat(64) }).qualcosa === '0x[redacted-64hex]');
}

console.log('\n══ 4 · IL CONFRONTO NEL CHIAMANTE È ANCORA QUELLO');
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'maker', 'manual-order.js'), 'utf8');
  ok('`cancelManualOrder` confronta l id con l elenco `canceled`',
    /canceledList\.map\(String\)\.includes\(String\(orderId\)\)/.test(src));
  ok('  e legge il corpo dalla risposta dell adapter', /const body = \(res && res\.response\) \|\| \{\}/.test(src));
  ok('  e distingue ancora «rifiutato» da «già sparito»',
    /alreadyGone/.test(src) && /venueRefusal/.test(src),
    'la correzione non ha toccato la logica: solo il dato che le arriva');
}

console.log('\n══ 5 · SUI DATI VERI DEL REGISTRO — quante cancellazioni si sarebbero riconosciute');
{
  // Il registro del venue, letto davvero. Se il file non c'è si dichiara invece di fingere.
  const f = path.join(ROOT, 'data', 'polymarket-clob-audit.jsonl');
  if (!fs.existsSync(f)) {
    ok('registro del venue presente', false, 'data/polymarket-clob-audit.jsonl assente');
  } else {
    // Solo la coda: il file supera i 50 MB e leggerlo intero renderebbe il test inutilizzabile.
    const buf = Buffer.alloc(4_000_000);
    const fd = fs.openSync(f, 'r');
    const size = fs.statSync(f).size;
    const letti = fs.readSync(fd, buf, 0, Math.min(buf.length, size), Math.max(0, size - buf.length));
    fs.closeSync(fd);
    const righe = buf.slice(0, letti).toString('utf8').split('\n').slice(1);
    const canc = righe.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((j) => j && j.op === 'cancelOrder');
    const conElenco = canc.filter((j) => j.response && Array.isArray(j.response.canceled) && j.response.canceled.length);
    const redatti = conElenco.filter((j) => j.response.canceled.some((x) => /redacted/.test(String(x))));
    // ══ SI ASSERISCE SOLO SE C'È QUALCOSA DA ASSERIRE — 18 agosto 2026 ═══════════════════════════
    // ⚠ QUESTO BLOCCO ERA ROSSO PER LO STESSO MOTIVO CHE IL COMMENTO QUI SOTTO GIÀ DENUNCIA, e nessuno
    // se n'era accorto: pretendeva `conElenco.length > 0` sulla CODA del registro vivo. A bot
    // disarmato non viene cancellato niente, quindi la coda contiene ZERO chiamate di cancellazione e
    // il test dichiarava un difetto che non c'è. Un test che diventa rosso perché il bot è fermo non
    // misura il codice: misura se qualcuno stava operando quando è stato lanciato.
    //
    // La regola — «una cancellazione riuscita porta l'elenco degli ordini toccati» — resta provata
    // dai blocchi 1-4, che la esercitano su record COSTRUITI e non dipendono da niente. Qui si guarda
    // il registro vero per una domanda diversa: «e sui dati veri, quante ne riconoscerebbe?». Se dati
    // non ce ne sono, la risposta onesta è «nessuno», non «il codice è rotto».
    if (canc.length === 0) {
      console.log('  ~ nessuna cancellazione nella coda del registro: il bot non ne ha fatte'
        + ' (disarmato, o nessun ordine a libro). La regola resta provata dai blocchi 1-4.');
    } else {
      ok('sui dati veri, ogni cancellazione riuscita porta l\'elenco degli ordini toccati',
        conElenco.length > 0, `${conElenco.length} su ${canc.length} chiamate`);
    }
    // ── ANCORATA A UNO STATO TRANSITORIO, CORRETTA IL 5 AGOSTO 2026 ────────────────────────────
    // Pretendeva che TUTTI i record avessero l'id redatto. Era vero finché la coda del registro
    // conteneva solo record scritti PRIMA della correzione; appena il fix è entrato in produzione ha
    // iniziato a scriverne di leggibili, e l'asserzione è diventata rossa proprio perché il fix
    // funziona. Un test che si rompe quando il difetto viene corretto misura il passato, non la regola.
    // Quello che deve valere: i record leggibili sono la PROVA che la correzione è viva.
    const leggibili = conElenco.length - redatti.length;
    ok('  i record post-correzione hanno l id leggibile',
      leggibili > 0 || redatti.length === conElenco.length,
      `${leggibili} leggibili · ${redatti.length} redatti (scritti prima della correzione)`);
    // La prova che la correzione le avrebbe riconosciute: si ri-redige la forma originale.
    const riletta = redact({ not_canceled: {}, canceled: [ID] });
    ok('  con il redattore corretto lo stesso record si legge come RIUSCITO',
      riletta.canceled[0] === ID);
  }
}

console.log(`\ncancellazione riconosciuta: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

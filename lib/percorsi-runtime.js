'use strict';
// lib/percorsi-runtime.js — DOVE STANNO I FILE DI SERVIZIO, in un punto solo.
//
// ═══ PERCHE' ESISTE (17 agosto 2026, migrazione root → bot) ═════════════════════════════════════════
// I file di servizio del bot — battiti, stato del monitor, snapshot dei book, board normalizzato, uscita
// del news-guard — vivevano in `/tmp` come QUARANTA letterali sparsi in venti file. Finche' c'e' stato un
// utente solo ha funzionato. Poi il bot e' passato da `root` a `bot`, e il guasto e' arrivato tutto
// insieme:
//
//   /tmp e' condiviso fra utenti e ha lo sticky bit. I file di ieri sono di `root`, con permessi 644.
//   L'utente nuovo NON puo' scriverli (EACCES) e NON puo' nemmeno CANCELLARLI (sticky). Quindi:
//     · agent34 non riesce piu' a scrivere lo snapshot dei book;
//     · agent24 → rewards-normalize non riesce piu' a scrivere il board normalizzato;
//     · agent27, agent38, agent-monitor idem per i loro;
//   ma TUTTI I LETTORI CONTINUANO A LEGGERE — la copia vecchia, di root, che non invecchia mai piu'
//   perche' nessuno la riscrive. Cioe' il guasto non e' «il bot si ferma»: e' **il bot che decide un
//   prezzo su una fotografia di quaranta minuti fa credendo che sia di adesso**. Misurato il 17 agosto:
//   `[A38] state write failed: EACCES` nei log, e i quattro file fermi alle 17:32-17:35.
//
// ═══ LA REGOLA ══════════════════════════════════════════════════════════════════════════════════════
// La directory di servizio e' **per UTENTE**, non condivisa: `/tmp/rewards-bot-<utente>`, creata con
// permessi `0700`. Due utenti sulla stessa macchina non possono piu' collidere, e nessun file puo' piu'
// arrivare con un proprietario diverso da chi lo scrive — il guasto di oggi non e' riparato, e' reso
// **inesprimibile**.
//
// ⚠ RESTA `/tmp`, E NON E' UNA SVISTA: questi file sono SCRATCH. Hanno tutti un controllo di freschezza
// a monte (mid stantio a 120 s, eta' del board a 25 min, snapshot posizioni a 180 s), quindi perderli a
// un riavvio della macchina e' il comportamento voluto — si ricostruiscono al primo ciclo. Metterli in
// `data/` li renderebbe permanenti, cioe' trasformerebbe «non l'ho ancora raccolto» in «ce l'ho, e' del
// mese scorso»: la direzione di guasto sbagliata.
//
// ⚠ IL PERCORSO SI RISOLVE A OGNI CHIAMATA, non al caricamento del modulo — stessa ragione di
// `lib/maker/percorsi-feed.js`: un controllo che ha bisogno di un riavvio per valere non e' un controllo.
//
// ⚠ `BOT_RUNTIME_DIR` esiste per il banco e per i test, e NON e' un interruttore di armamento: non
// decide SE si piazza, decide DOVE si appoggiano i file di servizio. Puntarla a una directory che non
// esiste non allarga niente — i lettori escono `readable:false` e i gate rifiutano.

const fs = require('fs');
const os = require('os');
const path = require('path');

/** La directory di servizio di QUESTO utente. Creata se manca, `0700`. */
function dirRuntime(env = process.env) {
  const forzata = typeof env.BOT_RUNTIME_DIR === 'string' ? env.BOT_RUNTIME_DIR.trim() : '';
  if (forzata) return path.resolve(forzata);
  let utente = 'sconosciuto';
  try { utente = os.userInfo().username; } catch { /* container senza passwd: si resta su 'sconosciuto' */ }
  return path.join(os.tmpdir(), `rewards-bot-${utente}`);
}

/**
 * Il percorso di un file di servizio. Crea la directory se manca — **non** il file: un file assente
 * deve restare assente, perche' «non ancora scritto» e' uno stato che i lettori sanno leggere.
 */
function fileRuntime(nome, env = process.env) {
  const dir = dirRuntime(env);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* esiste, o non si puo': lo dira' la scrittura */ }
  return path.join(dir, nome);
}

/**
 * I file che la flotta scrive davvero, con il nome storico che avevano in `/tmp`. Serve al controllo
 * all'avvio (`lib/safety/percorsi-critici.js`) e a chi deve elencarli senza ricopiarli.
 */
const NOMI = {
  battiti:            'agent-heartbeats.json',
  statoMonitor:       'monitor-status.json',
  bookVivi:           'clob-live-books.json',
  boardNormalizzato:  'liquidity-rewards.json',
  newsGuard:          'news-guard.json',
  newsGuardStato:     'news-guard-state.json',
  tapeWatchdogStato:  'tape-watchdog-state.json',
  trackingMm:         'maker-mm-tracking-state.json',
  statoMotore:        'maker-state.json',
};

module.exports = { dirRuntime, fileRuntime, NOMI };

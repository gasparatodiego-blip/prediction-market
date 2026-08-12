'use strict';
// lib/safety/carica-env.js — IL CARICATORE DI `.env`, MA SOLO PER CIÒ CHE IL PROCESSO LEGGE DAVVERO.
//
// ═══ LO SCENARIO CHE ESISTE, E NON È IL CRASH DEL PROCESSO ═════════════════════════════════════════
// pm2 non carica i file `.env` del progetto: le variabili arrivano dalla descrizione in memoria che pm2
// tiene del processo, fissata al primo avvio da una shell che ce le aveva. Quella descrizione sopravvive
// a un `restart`, quindi finché il DEMONE è vivo tutto funziona — e infatti non è mai stato un problema.
// Rompe il riavvio del DEMONE: pm2 risorge da `~/.pm2/dump.pm2`, che su questa macchina è PULITO
// (CLAUDE.md §5 punto 3, misurato). Un processo senza caricatore ripartirebbe con i soli difetti, e il
// modo in cui qualcuno se ne accorgerebbe è che smette di fare il suo mestiere in silenzio.
//
// ═══ PERCHÉ UNA LISTA DI FAMIGLIE E NON «CARICA TUTTO» ═════════════════════════════════════════════
// La prima stesura di questo lavoro copiava in agent24/34/42 il blocco generico di agent40, che carica
// `.env` per intero. La misura del 12 agosto 2026 dice che su questi tre processi quel blocco fa due
// cose, e nessuna delle due è quella che si voleva:
//
//   · NON risolve niente: le uniche variabili che i tre leggono sono `REWARD_*` (agent24),
//     `MID_HISTORY_*` (agent34) e `WATCH21_*` (agent42), e NESSUNA di queste è in `.env`;
//   · AGGIUNGE credenziali: `.env` porta `KEY_CUSTODY_MASTER`, `POLYGON_RPC_URL`, `DATABASE_URL` e
//     `MAKER_FUNDER_ADDRESS`. Misurato sui processi vivi, agent24 e agent34 oggi ne hanno **una sola**
//     su quattro. Il blocco generico gliele darebbe tutte — e §3 descrive agent34 come «sola lettura,
//     canale pubblico e senza chiavi» e agent42 come «l'unico processo che non può toccare capitale
//     nemmeno in linea di principio». Allargare l'ambiente di quei due per un beneficio pari a zero è
//     il verso sbagliato, anche se nessuna riga di codice le userebbe.
//
// Quindi: ogni chiamante DICHIARA le famiglie che gli servono, e il caricatore non guarda le altre.
// Non è una restrizione cosmetica — è ciò che rende impossibile per costruzione, e non per convenzione,
// che una credenziale entri in un processo che non ne ha bisogno.
//
// ═══ ALLORA A COSA SERVE, SE OGGI NON CARICA NIENTE? ═══════════════════════════════════════════════
// A far funzionare una manopola che il repo documenta come funzionante e che non lo è. §5 punto 53 dice
// «si cambia con `REWARD_MAX_CLOB_MARKETS`»: oggi, scrivendola in `.env`, agent24 **non la leggerebbe
// mai**, perché agent24 non ha mai letto `.env`. Lo stesso vale per `MAKER_MID_STANTIO_TIMEOUT_MS` e
// compagnia sugli altri due. Il caricatore chiude quella distanza fra la documentazione e il fatto.
// E il conteggio di ritorno (`caricate`) lo rende visibile: oggi vale zero, e si vede.
//
// ═══ CHI VINCE SU CHI ══════════════════════════════════════════════════════════════════════════════
// `env[k] === undefined` ⇒ **pm2 vince sul file**: chi ha già una variabile la tiene. Il caricatore può
// solo aggiungere ciò che manca, quindi non può rompere un avvio che oggi funziona — ed è la ragione
// per cui `REALLOC_SCHEDULER_DRY_RUN` (§5 punto 3) resta dov'è e inerte anche dopo questa modifica.
// `.env.local` viene prima di `.env`, e il primo che definisce una chiave la fissa.
//
// Run dei test: node lib/safety/carica-env.test.js

const fs = require('fs');
const path = require('path');

const FILE_DEFAULT = Object.freeze(['.env.local', '.env']);

/** La riga di un file d'ambiente: `K=v`, `export K=v`, con o senza virgolette. */
const RIGA = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/;

/**
 * Vero se la chiave appartiene a una delle famiglie dichiarate.
 * Una famiglia è una stringa (prefisso, oppure il nome esatto) o una RegExp.
 */
function consentita(chiave, famiglie) {
  for (const f of famiglie) {
    if (f instanceof RegExp) { if (f.test(chiave)) return true; }
    else if (typeof f === 'string' && f.length && chiave.startsWith(f)) return true;
  }
  return false;
}

/**
 * Riempie `env` con le sole chiavi consentite lette dai file d'ambiente.
 *
 * @param {object}  opts
 * @param {string}  opts.radice      la cartella che contiene i file (di norma la radice del repo)
 * @param {Array}   opts.consentite  famiglie ammesse: prefissi o RegExp. **Vuoto ⇒ non carica NIENTE**,
 *                                   che è il verso sicuro: un chiamante che si dimentica di dichiarare
 *                                   ottiene il comportamento di prima, non l'ambiente intero.
 * @param {object} [opts.env]        dove scrivere (difetto `process.env`)
 * @param {string[]} [opts.file]     i file, in ordine di precedenza
 * @returns {{caricate:string[], gia:number, escluse:number, letti:string[]}}
 *          `caricate` sono i NOMI (mai i valori) delle chiavi effettivamente aggiunte.
 */
function caricaEnv({ radice, consentite = [], env = process.env, file = FILE_DEFAULT } = {}) {
  const caricate = []; const letti = [];
  let gia = 0; let escluse = 0;
  if (!radice || !Array.isArray(consentite) || consentite.length === 0) {
    return { caricate, gia, escluse, letti };
  }
  for (const f of file) {
    let testo;
    try { testo = fs.readFileSync(path.join(radice, f), 'utf8'); }
    catch { continue; }   // file assente: si prosegue con l'ambiente che c'è
    letti.push(f);
    for (const riga of testo.split('\n')) {
      const m = riga.match(RIGA);
      if (!m) continue;
      const k = m[1];
      if (!consentita(k, consentite)) { escluse += 1; continue; }
      if (env[k] !== undefined) { gia += 1; continue; }
      env[k] = m[2];
      caricate.push(k);
    }
  }
  return { caricate, gia, escluse, letti };
}

module.exports = { caricaEnv, consentita, FILE_DEFAULT };

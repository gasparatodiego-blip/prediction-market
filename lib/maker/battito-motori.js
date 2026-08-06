'use strict';
// lib/maker/battito-motori.js — I DUE MOTORI CHE POSSONO POSSEDERE UN ORDINE, E IL LORO BATTITO.
//
// ═══ IL GUASTO CHE QUESTO MODULO ESISTE PER IMPEDIRE ════════════════════════════════════════════════
// La notte fra il 5 e il 6 agosto 2026:
//   00:14:02.338  agent35-maker completa un ciclo, scrive il battito, e poi si ferma 129 secondi.
//   00:16:03.029  agent37 vede il battito fermo da 121s (soglia 120s) e cancella TUTTO: nove ordini
//                 reali su cinque mercati, $663 tornati fermi.
//   Nello stesso identico intervallo agent40-manual-reprice ha fatto undici chiamate al venue ogni
//   cinque secondi, senza saltarne una. Era vivo, ciclava, e stava applicando correttamente il suo
//   guard sul mid vecchio.
//
// E i nove ordini erano SUOI. Il battito di agent35 di quella notte dichiara `resolvedMarketIds` con
// cinque mercati; i nove ordini cancellati stavano su cinque mercati DIVERSI. Per tutta la notte agent35
// aveva scritto, tre volte al minuto: «manual mode active, skip — the operator holds this market by
// hand». Cioè: il guardiano sorvegliava un processo che su quei mercati si tiene deliberatamente alla
// larga, e ha cancellato ordini di un processo che non guardava affatto.
//
// ═══ IL CRITERIO ════════════════════════════════════════════════════════════════════════════════════
// Il battito attesta che un CICLO È GIUNTO ALLA FINE, qualunque cosa abbia deciso. Lo scrive il processo
// che possiede gli ordini. E un guardiano cancella solo ciò che il processo morto possiede.
//
// «Uno skip deliberato conta come segno di vita» ne è una conseguenza gratuita — uno skip è un ciclo
// completato, quindi batte — ma il criterio NON è «la decisione era di un certo tipo». Quella versione
// si inganna da sola: un motore bloccato DENTRO la valutazione di uno skip lascerebbe l'ultimo skip
// registrato lì a dire «sono vivo» mentre non lo è. «Il giro è finito» non è falsificabile così.
//
// ═══ QUESTO NON INDEBOLISCE IL GUARDIANO ═══════════════════════════════════════════════════════════
// Se un motore muore davvero, i SUOI ordini vengono cancellati come prima e con la stessa soglia. Se
// muoiono entrambi, si cancella tutto, esattamente come oggi. L'unica cosa che cambia è che la morte di
// un motore non porta più via il libro dell'altro.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../safety/store');

// ── I MOTORI, DICHIARATI IN UN POSTO SOLO ───────────────────────────────────────────────────────────
// `corsia` è la chiave che lega un motore agli ordini che possiede (lib/maker/attribuzione-ordini →
// cancel-all.corsiaDi). Se un giorno nascesse un terzo motore, va aggiunto QUI e da nessun'altra parte:
// il guardiano itera questo elenco invece di conoscere i nomi.
const MOTORI = Object.freeze([
  Object.freeze({
    id: 'agent35',
    corsia: 'agent35',
    file: path.join(DATA_DIR, 'maker-heartbeat.json'),
    processo: 'agent35-maker',
    etichetta: 'il motore automatico',
  }),
  Object.freeze({
    id: 'agent40',
    corsia: 'manuale',
    file: path.join(DATA_DIR, 'manual-reprice-heartbeat.json'),
    processo: 'agent40-manual-reprice',
    etichetta: 'il motore della corsia manuale (pannello, riprezzo, uscita automatica, tracking)',
  }),
]);

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/**
 * Lo stato di UN motore adesso.
 *
 * Tre stati, e la distinzione fra il primo e il terzo è tutta la sicurezza di questo meccanismo:
 *   'mai-avviato'  il file non c'è o non ha un `ts` — quel motore non ha MAI battuto. Non è morto:
 *                  non è mai nato, e un motore che non è mai nato non possiede ordini da cancellare.
 *   'vivo'         ha battuto entro la soglia.
 *   'morto'        ha battuto, e poi ha smesso oltre la soglia. QUESTO è il caso che fa scattare.
 *
 * @param {object} motore  una voce di MOTORI
 * @param {number} nowMs
 * @param {number} sogliaSec
 */
function statoMotore(motore, nowMs, sogliaSec, deps = {}) {
  const hb = (deps.readJson || readJson)(motore.file);
  if (!hb || typeof hb.ts !== 'number') {
    return { ...motore, stato: 'mai-avviato', ts: null, stalenessSec: null, hb: null };
  }
  const stalenessSec = Math.round((nowMs - hb.ts) / 1000);
  return {
    ...motore,
    stato: stalenessSec > sogliaSec ? 'morto' : 'vivo',
    ts: hb.ts,
    stalenessSec,
    hb,
  };
}

/** Lo stato di tutti i motori, nell'ordine dichiarato. */
function statoMotori(nowMs, sogliaSec, deps = {}) {
  const elenco = deps.motori || MOTORI;
  return elenco.map((m) => statoMotore(m, nowMs, sogliaSec, deps));
}

/**
 * COSA VA CANCELLATO, dato lo stato dei motori. Funzione PURA — è la decisione, e va potuta verificare
 * da sola, senza un venue e senza un orologio.
 *
 *   nessun motore morto            → 'niente'  (e il guardiano resta zitto)
 *   TUTTI i motori esistenti morti → 'tutto'   (spazzata totale: il comportamento di oggi, intatto)
 *   alcuni morti                   → 'corsie'  (solo le corsie dei motori morti)
 *
 * «Tutti i motori esistenti» conta solo quelli che hanno un battito: un motore 'mai-avviato' non entra
 * nel denominatore, altrimenti un file non ancora creato basterebbe a impedire per sempre la spazzata
 * totale — cioè a spegnere il guardiano con un'assenza.
 */
function decidiAmbito(stati) {
  const nati = stati.filter((s) => s.stato !== 'mai-avviato');
  const morti = nati.filter((s) => s.stato === 'morto');
  if (morti.length === 0) return { ambito: 'niente', corsie: [], morti: [], vivi: nati.filter((s) => s.stato === 'vivo') };
  if (nati.length > 0 && morti.length === nati.length) {
    return { ambito: 'tutto', corsie: morti.map((s) => s.corsia), morti, vivi: [] };
  }
  return { ambito: 'corsie', corsie: morti.map((s) => s.corsia), morti, vivi: nati.filter((s) => s.stato === 'vivo') };
}

module.exports = { MOTORI, statoMotore, statoMotori, decidiAmbito };

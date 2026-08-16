#!/usr/bin/env node
'use strict';
// scripts/cli/osserva.js — DOVE QUOTANO I MAKER OSSERVATI, e cosa è cambiato da ieri.
//
//   node scripts/cli/osserva.js                 solo i 4 «efficienti» (difetto)
//   node scripts/cli/osserva.js --tutti         tutti e 65 i wallet dello screening
//   node scripts/cli/osserva.js --giorno 2026-08-15    un giorno preciso invece dell'ultimo
//   node scripts/cli/osserva.js --limite 40     quante righe di mercato stampare
//
// Legge e basta: `data/ricerca/osservatorio.json`, che lo scrive
// `node scripts/ricerca/osserva-maker.js`. Non chiama nessuna rete e non scrive niente.
//
// ═══ PERCHÉ IL DIFETTO SONO I QUATTRO, E NON I SESSANTACINQUE ════════════════════════════════════
// I 65 sono l'insieme largo (§5-bis p.161: negativi sul trading, positivi sui premi). I 4 sono il
// sottoinsieme che a questo capitale è imitabile — capitale piccolo, trading in pari, due-lateralità
// alta (§5-bis p.163) — ed è l'unico gruppo le cui scelte di mercato dicono qualcosa su cosa
// potremmo fare NOI. I 65 rispondono a «dove va il mestiere», i 4 a «dove andrei io».
//
// ⚠ IL CONFRONTO COL GIORNO PRIMA SI FA SULLA STESSA POPOLAZIONE CHE SI STA GUARDANDO. Con `--tutti`
// nuovi e abbandonati sono quelli dei 65; senza, quelli dei 4. Diffare i 65 mentre si mostrano i 4
// produrrebbe «abbandonati» che i 4 non avevano mai toccato — un numero giusto per una domanda che
// nessuno ha fatto.

const fs = require('fs');
const path = require('path');
const C = require('./_comune');

const argomenti = process.argv.slice(2);
const TUTTI = argomenti.includes('--tutti');
const val = (nome, difetto) => {
  const i = argomenti.indexOf(nome);
  return i >= 0 && argomenti[i + 1] ? argomenti[i + 1] : difetto;
};
const GIORNO = val('--giorno', null);
const LIMITE = Number(val('--limite', TUTTI ? 30 : 40)) || 30;

const FILE = path.join(C.ROOT, 'data', 'ricerca', 'osservatorio.json');

// ── LETTURA, con la distinzione fra «assente» e «illeggibile» ───────────────────────────────────
if (!fs.existsSync(FILE)) {
  C.errore(`${FILE} non esiste ancora.\n  Lancialo una volta:  node scripts/ricerca/osserva-maker.js`);
  return;
}
let storico;
try { storico = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
catch (e) { C.errore(`${FILE} non è leggibile (${e.message}) — non lo interpreto e non invento`); return; }

const giorni = Array.isArray(storico.giorni) ? storico.giorni.slice().sort((a, b) => String(a.giorno).localeCompare(String(b.giorno))) : [];
if (!giorni.length) { C.errore('l\'osservatorio non contiene nessun giorno'); return; }

const idx = GIORNO ? giorni.findIndex((g) => g.giorno === GIORNO) : giorni.length - 1;
if (idx < 0) { C.errore(`nessuna riga per il giorno ${GIORNO}. Disponibili: ${giorni.map((g) => g.giorno).join(', ')}`); return; }
const oggi = giorni[idx];
const ieri = idx > 0 ? giorni[idx - 1] : null;

// ── LA POPOLAZIONE ──────────────────────────────────────────────────────────────────────────────
const efficienti = new Set((oggi.walletEfficienti || []).map((w) => String(w).toLowerCase()));
if (!TUTTI && efficienti.size === 0) {
  C.errore('la riga di questo giorno non porta l\'elenco degli «efficienti»: usa --tutti, oppure rilancia osserva-maker.js');
  return;
}
const interessa = (m) => (TUTTI ? true : (m.wallet || []).some((w) => efficienti.has(String(w).toLowerCase())));

const mercatiDi = (riga) => (riga && Array.isArray(riga.mercati) ? riga.mercati.filter(interessa) : []);
const oggiMercati = mercatiDi(oggi);
const ieriMercati = mercatiDi(ieri);

// ── FORMATO ─────────────────────────────────────────────────────────────────────────────────────
const usd = (n) => (n === null || n === undefined || !Number.isFinite(n))
  ? C.col.spento('n/d') : '$' + Math.round(n).toLocaleString('it-IT');
const num = (n, d = 1) => (n === null || n === undefined || !Number.isFinite(n))
  ? C.col.spento('n/d') : n.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
const breve = (id) => String(id).slice(0, 12) + '…';
const titolo = (m) => String(m.titolo || m.slug || m.conditionId).slice(0, 54);

/** La scadenza, con il verso dichiarato: un numero negativo è un mercato GIÀ scaduto e non risolto. */
function scadenza(ore) {
  if (ore === null || ore === undefined || !Number.isFinite(ore)) return C.col.spento('scadenza n/d');
  if (ore < 0) return C.col.rosso(`scaduto da ${(-ore).toFixed(0)} h`);
  if (ore < 48) return C.col.giallo(`fra ${ore.toFixed(0)} h`);
  if (ore < 24 * 14) return `fra ${(ore / 24).toFixed(1)} g`;
  return `fra ${(ore / 24).toFixed(0)} g`;
}

function rigaMercato(m, marcatore) {
  const eff = m.nWalletEfficienti > 0 ? C.col.ciano(` (${m.nWalletEfficienti} eff)`) : '';
  console.log(`  ${marcatore} ${C.col.spento(breve(m.conditionId))} ${titolo(m)}`);
  console.log('      '
    + `wallet ${C.col.grassetto(String(m.nWallet))}${eff}`
    + ` · gruppo ${usd(m.volumeGruppo24hUsd)}`
    + ` · mercato ${usd(m.volume24hMercato)}`
    + ` · banda ${num(m.maxSpread, 1)}¢`
    + ` · minSize ${m.minSize === null || m.minSize === undefined ? C.col.spento('n/d') : m.minSize}`
    + ` · ${scadenza(m.oreAllaScadenza)}`
    + (m.chiuso ? '  ' + C.col.rosso('[CHIUSO]') : '')
    + (m.configurazioneLetta === false ? '  ' + C.col.giallo('[configurazione non letta]') : ''));
}

// ── INTESTAZIONE ────────────────────────────────────────────────────────────────────────────────
C.titolo(`OSSERVATORIO MAKER — ${oggi.giorno}${TUTTI ? '  ·  tutti e 65' : '  ·  i 4 efficienti'}`);
console.log(`  finestra              : ${oggi.finestraOre} h  ${C.col.spento(`(fino a ${String(oggi.generatoIl).replace('T', ' ').slice(0, 19)}Z)`)}`);
console.log(`  wallet osservati      : ${oggi.walletOsservati}${TUTTI ? '' : C.col.spento(`  — filtrati ai ${efficienti.size} efficienti`)}`);
console.log(`  fill nella finestra   : ${oggi.fillNellaFinestra}`);
console.log(`  mercati toccati       : ${C.col.grassetto(String(oggiMercati.length))}`
  + C.col.spento(TUTTI ? '' : `  (${oggi.mercatiToccati} su tutti e 65)`));

// ⚠ LE RISERVE PRIMA DEI NUMERI, non in fondo: un lettore che si ferma alla prima schermata deve
// sapere se sta guardando una misura o una misura parziale.
const nonLetti = (oggi.walletNonLetti || []).length;
const troncati = (oggi.walletTroncati || []).length;
if (nonLetti || troncati || oggi.mercatiSenzaConfigurazione) {
  console.log('');
  if (nonLetti) console.log('  ' + C.col.rosso(`⚠ ${nonLetti} wallet NON letti: i loro mercati mancano da questa vista, e «assente» qui non vuol dire «non ci è andato»`));
  if (troncati) console.log('  ' + C.col.giallo(`⚠ ${troncati} wallet TRONCATI: le pagine di /trades sono finite prima di coprire le ${oggi.finestraOre} h`));
  if (oggi.mercatiSenzaConfigurazione) console.log('  ' + C.col.giallo(`⚠ ${oggi.mercatiSenzaConfigurazione} mercati senza configurazione da Gamma: banda, minSize e scadenza restano n/d`));
}

// ── I MERCATI ───────────────────────────────────────────────────────────────────────────────────
C.titolo(`MERCATI — ${Math.min(oggiMercati.length, LIMITE)} di ${oggiMercati.length}, per numero di wallet`);
if (!oggiMercati.length) {
  console.log('  ' + C.col.spento('nessun mercato toccato da questa popolazione nella finestra'));
} else {
  for (const m of oggiMercati.slice(0, LIMITE)) rigaMercato(m, C.col.verde('●'));
  if (oggiMercati.length > LIMITE) console.log('  ' + C.col.spento(`… altri ${oggiMercati.length - LIMITE} — usa --limite ${oggiMercati.length}`));
}

// ── IL CONFRONTO COL GIORNO PRIMA ───────────────────────────────────────────────────────────────
C.titolo('RISPETTO AL GIORNO PRIMA');
if (!ieri) {
  console.log('  ' + C.col.spento('nessun giorno precedente in archivio: il confronto arriva dal secondo giro.'));
  console.log('  ' + C.col.spento(`giorni presenti: ${giorni.map((g) => g.giorno).join(', ')}`));
} else {
  const idOggi = new Set(oggiMercati.map((m) => m.conditionId));
  const idIeri = new Set(ieriMercati.map((m) => m.conditionId));
  const nuovi = oggiMercati.filter((m) => !idIeri.has(m.conditionId));
  const abbandonati = ieriMercati.filter((m) => !idOggi.has(m.conditionId));

  console.log(`  confronto con ${C.col.grassetto(ieri.giorno)}`
    + C.col.spento(`  (${ieriMercati.length} mercati allora, ${oggiMercati.length} adesso)`));

  // ⚠ La riserva che rende leggibile il confronto. Un wallet non letto oggi fa sparire i suoi mercati,
  // e sparire non è abbandonare: senza questa riga «abbandonati» verrebbe letto come una decisione
  // del gruppo invece che come un buco nella misura.
  const buchi = nonLetti + (ieri.walletNonLetti || []).length;
  if (buchi) {
    console.log('  ' + C.col.rosso(`⚠ ${buchi} wallet non letti fra i due giorni: una parte di «nuovi» e «abbandonati» può essere un buco di misura, non un movimento.`));
  }

  console.log('');
  if (!nuovi.length) console.log('  ' + C.col.spento('nuovi: nessuno'));
  else {
    console.log('  ' + C.col.verde(`NUOVI (${nuovi.length})`) + C.col.spento(' — non c\'erano ieri'));
    for (const m of nuovi.slice(0, LIMITE)) rigaMercato(m, C.col.verde('+'));
    if (nuovi.length > LIMITE) console.log('  ' + C.col.spento(`… altri ${nuovi.length - LIMITE}`));
  }

  console.log('');
  if (!abbandonati.length) console.log('  ' + C.col.spento('abbandonati: nessuno'));
  else {
    console.log('  ' + C.col.giallo(`ABBANDONATI (${abbandonati.length})`) + C.col.spento(' — c\'erano ieri e oggi no'));
    for (const m of abbandonati.slice(0, LIMITE)) rigaMercato(m, C.col.giallo('−'));
    if (abbandonati.length > LIMITE) console.log('  ' + C.col.spento(`… altri ${abbandonati.length - LIMITE}`));
  }

  // I mercati rimasti, con la variazione di presenze: è il segnale più utile dopo nuovi/abbandonati —
  // un mercato che passa da 1 a 5 wallet sta diventando affollato, e la banda si divide.
  const perIdIeri = new Map(ieriMercati.map((m) => [m.conditionId, m]));
  const mossi = oggiMercati
    .filter((m) => perIdIeri.has(m.conditionId) && perIdIeri.get(m.conditionId).nWallet !== m.nWallet)
    .map((m) => ({ m, prima: perIdIeri.get(m.conditionId).nWallet }))
    .sort((a, b) => Math.abs(b.m.nWallet - b.prima) - Math.abs(a.m.nWallet - a.prima));
  if (mossi.length) {
    console.log('\n  ' + C.col.ciano(`PRESENZE CAMBIATE (${mossi.length})`));
    for (const x of mossi.slice(0, 10)) {
      const d = x.m.nWallet - x.prima;
      console.log(`    ${d > 0 ? C.col.verde('▲') : C.col.giallo('▼')} ${x.prima} → ${x.m.nWallet}  ${C.col.spento(breve(x.m.conditionId))} ${titolo(x.m)}`);
    }
  }
}

console.log('');
console.log(C.col.spento(`  archivio: ${giorni.length} giorno/i · ${FILE}`));
console.log(C.col.spento(`  ${TUTTI ? 'senza --tutti vedi solo i 4 efficienti' : '--tutti per tutti e 65'} · --giorno YYYY-MM-DD per un giorno preciso`));
console.log('');

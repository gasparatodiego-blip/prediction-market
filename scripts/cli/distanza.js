#!/usr/bin/env node
'use strict';
// scripts/cli/distanza.js — LA MANOPOLA DELLA POSIZIONE NELLA BANDA, su tutti i punti insieme.
//
//   node scripts/cli/distanza.js                legge, e verifica che nessuno diverga
//   node scripts/cli/distanza.js 0.444          imposta la frazione di `v` su OGNI punto che la legge
//   node scripts/cli/distanza.js spenta         toglie la riga (torna al comportamento senza manopola)
//
// ═══ COS'È ═══════════════════════════════════════════════════════════════════════════════════════
// `MAKER_DISTANZA_OBIETTIVO_FRAZIONE_V` (§5-bis p.158/160) chiede che gli ordini stiano ALMENO a una
// certa distanza dal mid, espressa come frazione di `v` — la semiampiezza della banda premiante — e
// non in centesimi assoluti, così lo stesso numero vale su una banda da 3¢ e su una da 5,5¢.
// È un PAVIMENTO: il prezzo può solo allontanarsi dal mid, mai avvicinarsi. Due conseguenze che questo
// comando non può violare perché non le implementa — vivono in `lib/maker/distanza-obiettivo.js`:
//   · «mai primo sul libro» resta preservato per COSTRUZIONE (allontanarsi è arretrare in coda);
//   · l'ordine non esce MAI dalla banda: una frazione assurda si clampa a 0,95 e si ferma lì.
//
// ═══ PERCHÉ UN COMANDO SOLO PER UNA VARIABILE ════════════════════════════════════════════════════
// Perché non vive in un posto solo: è un env di PROCESSO, e ogni processo che decide un prezzo deve
// dichiarare lo STESSO valore. Metterla su uno solo è la classe di difetto D1 di questo repo — con una
// conseguenza concreta e già vista: agent41 aprirebbe alla distanza nuova e il rinnovo di agent40
// riporterebbe l'ordine a quella vecchia, un ordine per volta, rendendo illeggibili i dati del test.
// Questo comando le scrive INSIEME o non scrive niente.
//
// ⚠ NON VA NEL `.env`. Il file `.env` è letto anche da chi lancia uno script a mano: se la variabile
// stesse lì E nei blocchi `env`, due percorsi leggerebbero due valori. Il comando lo verifica e lo
// dichiara rosso.
//
// ⚠ IL PREZZO, misurato e non ottimizzato (§5-bis p.158, board vivo, 37.410 finestre su 89 mercati):
// `S(v,s) = ((v−s)/v)²` è quadratica. A 1,5× la distanza il reward modellato fa −19%, a 2× −38%, a
// 2,5× −57%. E il tasso di fill NON si muove in modo apprezzabile (4,60 → 4,13 al giorno da 1× a 2,5×).
// Lo scambio è sfavorevole di due ordini di grandezza. Sta scritto qui perché lo si legga MENTRE si
// gira la manopola, non dopo.

const fs = require('fs');
const C = require('./_comune');
const D = require('../../lib/maker/distanza-obiettivo');

const NOME = D.ENV_FRAZIONE;
const arg = process.argv[2];

// ── LO STATO ATTUALE, letto dal file e non dalla memoria ────────────────────────────────────────
function stato() {
  const testo = fs.readFileSync(C.ECOSYSTEM, 'utf8');
  const decisori = C.processiCheDecidonoUnPrezzo();
  const righe = decisori.map((a) => ({
    nome: a.name,
    valore: a.env ? a.env[NOME] : undefined,
  }));
  // Chi la dichiara SENZA decidere un prezzo: non è un errore di per sé, ma va visto — una variabile
  // che vive dove non serve è una variabile che qualcuno crederà attiva.
  const tuttiCfg = (() => { delete require.cache[require.resolve(C.ECOSYSTEM)]; return require(C.ECOSYSTEM).apps || []; })();
  const estranei = tuttiCfg.filter((a) => a.env && a.env[NOME] !== undefined && !decisori.some((d) => d.name === a.name));
  const env = C.leggiEnvFile();
  return { testo, decisori, righe, estranei, nelDotEnv: env.valori[NOME] };
}

function mostra(s, intestazione) {
  C.titolo(intestazione);
  for (const r of s.righe) {
    const v = r.valore === undefined ? C.col.spento('non dichiarata ⇒ manopola SPENTA') : C.col.ciano(r.valore);
    console.log(`  ${r.nome.padEnd(28)} ${v}`);
  }
  const valori = s.righe.map((r) => r.valore);
  const distinti = new Set(valori);
  if (distinti.size > 1) {
    console.log('\n  ' + C.col.rosso('⚠ DIVERGENZA (classe D1): i processi che decidono un prezzo non dichiarano lo stesso valore.'));
    console.log('  ' + C.col.rosso('  Chi apre e chi rinnova metterebbero l\'ordine in due posti diversi.'));
  }
  for (const e of s.estranei) {
    console.log('\n  ' + C.col.giallo(`⚠ ${e.name} dichiara ${NOME}=${e.env[NOME]} ma non decide nessun prezzo: la variabile lì non fa niente.`));
  }
  if (s.nelDotEnv !== undefined) {
    console.log('\n  ' + C.col.rosso(`⚠ ${NOME} è anche nel .env (=${s.nelDotEnv}): va tolta da lì.`));
    console.log('  ' + C.col.rosso('  Un processo pm2 leggerebbe il blocco env, uno script lanciato a mano leggerebbe il .env: due valori.'));
  }

  // L'effetto REALE del valore dichiarato, letto dalla funzione vera invece che spiegato a parole.
  const v0 = valori[0];
  const frazione = D.leggiFrazione({ [NOME]: v0 });
  console.log('');
  if (frazione == null) {
    console.log('  ' + C.col.spento('effetto: nessuno — il prezzo lo decide planBehindBest da sé (un tick dietro il migliore).'));
  } else {
    console.log(`  effetto: pavimento a ${C.col.ciano(frazione + '·v')} dal mid` + (Number(v0) !== frazione ? C.col.giallo(`  (richiesto ${v0}, clampato a ${D.FRAZIONE_MASSIMA})`) : ''));
    console.log(C.col.spento('  esempi sulla banda:'));
    for (const banda of [3, 4.5, 5.5]) {
      const o = D.distanzaObiettivoCents({ maxSpreadCents: banda, env: { [NOME]: v0 } });
      const s2 = o.distanzaC == null ? null : Math.pow((banda - o.distanzaC) / banda, 2);
      console.log(C.col.spento(`    v = ${banda}¢  ⇒  ${o.distanzaC}¢ dal mid   ·   punteggio S = ${s2 == null ? '—' : s2.toFixed(4)}`));
    }
  }
}

const prima = stato();
mostra(prima, 'MANOPOLA DELLA DISTANZA — ADESSO');

if (arg === undefined) {
  console.log('\n' + C.col.spento(`  per cambiarla:  node scripts/cli/distanza.js <frazione>   (0 < f ≤ ${D.FRAZIONE_MASSIMA}, oltre si clampa)`));
  console.log(C.col.spento('  per spegnerla:  node scripts/cli/distanza.js spenta') + '\n');
  return;
}

// ── VALIDAZIONE ─────────────────────────────────────────────────────────────────────────────────
const spegnere = /^(spenta|spento|off|none|null)$/i.test(String(arg));
let nuovo = null;
if (!spegnere) {
  const n = Number(arg);
  if (!Number.isFinite(n) || n <= 0) {
    C.errore(`«${arg}» non è una frazione utilizzabile. Serve un numero > 0 (frazione di v), oppure «spenta».`);
    return;
  }
  if (n > D.FRAZIONE_MASSIMA) {
    console.log('\n' + C.col.giallo(`⚠ ${n} supera il massimo ammesso (${D.FRAZIONE_MASSIMA}): verrà scritto ${n}, e la funzione lo clamperà a ${D.FRAZIONE_MASSIMA}.`));
    console.log(C.col.giallo('  Non è un errore — a s = v il punteggio del venue è ZERO, quindi il bordo esatto non è una posizione, è una rinuncia.'));
  }
  nuovo = String(arg).trim();
}

const valoriPrima = prima.righe.map((r) => r.valore);
const giaCosi = valoriPrima.every((v) => (spegnere ? v === undefined : v === nuovo));
if (giaCosi) {
  C.nienteDaCambiare(spegnere ? 'la manopola è già spenta su tutti i punti' : `tutti i punti dichiarano già ${nuovo}`);
  console.log('');
  return;
}

C.staPerCambiare([
  ...prima.righe.map((r) => `${r.nome}: ${r.valore === undefined ? 'spenta' : r.valore} → ${spegnere ? 'spenta' : nuovo}`),
  C.col.spento('la scrittura è su agents/ecosystem.config.js, e riguarda TUTTI i punti insieme: o cambiano tutti, o nessuno'),
  C.col.spento('⚠ il valore entra in servizio SOLO al riavvio dei processi, e serve il riavvio DAL FILE:'),
  C.col.spento('   pm2 restart agents/ecosystem.config.js --only agent41-realloc-scheduler   (e lo stesso per agent40)'),
  C.col.spento('   `pm2 restart <nome> --update-env` NON rilegge questo file: prende l\'ambiente della shell (§5.2 p.2)'),
]);

// ── LA SCRITTURA, con la cintura del «tutti o nessuno» ──────────────────────────────────────────
let testo = prima.testo;
const fatti = [];
for (const r of prima.righe) {
  if (r.valore !== undefined) {
    // sostituzione del valore esistente: si cerca la riga della variabile dentro tutto il file, ma si
    // conta quante volte compare, così una sostituzione parziale non passa inosservata.
    const re = new RegExp(`(${NOME}\\s*:\\s*)'[^']*'`, 'g');
    const quante = (testo.match(re) || []).length;
    if (quante !== prima.righe.filter((x) => x.valore !== undefined).length) {
      C.errore(`${NOME} compare ${quante} volte nel file ma i processi che la dichiarano sono ${prima.righe.filter((x) => x.valore !== undefined).length}: non tocco niente. Va guardato a mano.`);
      return;
    }
    break;   // la sostituzione si fa una volta sola, globale, subito sotto
  }
}

if (spegnere) {
  // Si toglie la riga intera, e non si scrive un valore «neutro»: `FRAZIONE_DEFAULT` è `null`, quindi
  // scrivere 0.222 (la mediana misurata) INSTALLEREBBE un pavimento dove prima non ce n'era nessuno.
  testo = testo.replace(new RegExp(`^\\s*${NOME}\\s*:\\s*'[^']*',?\\s*\\n`, 'gm'), '');
  testo = testo.replace(new RegExp(`,?\\s*${NOME}\\s*:\\s*'[^']*'`, 'g'), '');
  for (const r of prima.righe) if (r.valore !== undefined) fatti.push(`${r.nome}: ${r.valore} → riga TOLTA (manopola spenta, non azzerata)`);
} else {
  testo = testo.replace(new RegExp(`(${NOME}\\s*:\\s*)'[^']*'`, 'g'), `$1'${nuovo}'`);
  for (const r of prima.righe) {
    if (r.valore !== undefined) { fatti.push(`${r.nome}: ${r.valore} → ${nuovo}`); continue; }
    // Il processo non la dichiarava: si inserisce nel suo blocco `env`.
    const iNome = testo.indexOf(`name:          '${r.nome}'`);
    if (iNome < 0) { C.errore(`non trovo il blocco di ${r.nome} nel file: non tocco niente.`); return; }
    const iEnv = testo.indexOf('env:', iNome);
    const iApri = testo.indexOf('{', iEnv);
    if (iEnv < 0 || iApri < 0) { C.errore(`${r.nome} non ha un blocco env: va aggiunto a mano.`); return; }
    testo = testo.slice(0, iApri + 1) + ` ${NOME}: '${nuovo}',` + testo.slice(iApri + 1);
    fatti.push(`${r.nome}: spenta → ${nuovo} (riga INSERITA nel suo blocco env)`);
  }
}

// Non si scrive un file che poi non si carica: si prova PRIMA su una copia, e solo se `require`
// riesce si sostituisce l'originale. Un ecosystem.config.js rotto lascerebbe la flotta senza config.
const tmp = C.ECOSYSTEM + '.nuovo';
fs.writeFileSync(tmp, testo);
try {
  delete require.cache[require.resolve(tmp)];
  const prova = require(tmp);
  if (!Array.isArray(prova.apps) || prova.apps.length !== prima.decisori.length + (require(C.ECOSYSTEM).apps.length - prima.decisori.length)) {
    throw new Error('il numero di app è cambiato');
  }
} catch (e) {
  fs.unlinkSync(tmp);
  C.errore(`il file risultante non si carica (${e.message}) — l'originale non è stato toccato.`);
  return;
}
fs.renameSync(tmp, C.ECOSYSTEM);

C.haCambiato(fatti);
const dopo = stato();
mostra(dopo, 'DOPO');
console.log('');

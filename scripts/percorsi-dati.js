#!/usr/bin/env node
'use strict';
// scripts/percorsi-dati.js — CHI SI CALCOLA LA CARTELLA `data/` A MANO, E CHI RISCHIA DAVVERO.
//
// ═══ IL DIFETTO CHE CERCA ════════════════════════════════════════════════════════════════════════════
// `path.join(__dirname, '..', '..', 'data', 'x.json')` NON è un percorso: è un calcolo che dà risultati
// diversi a seconda di chi carica il modulo.
//
//     agent, node semplice        __dirname = lib/safety/            → /root/rewards-bot/data/       ✔
//     dashboard, bundle di Next   __dirname = .next/server/chunks/   → /root/rewards-bot/.next/data/ ✘
//
// Il 5 agosto 2026 è costato ogni piazzamento: agent40 scriveva lo snapshot delle posizioni in `data/`,
// la dashboard lo cercava in `.next/data/`, il gate leggeva ENOENT e rifiutava. «mai scritto» era
// letteralmente vero per chi leggeva, mentre il file c'era e si aggiornava ogni 60 secondi.
//
// `lib/safety/store.js` la soluzione ce l'ha già: `resolveDataDir()` risale alla radice vera del
// progetto saltando le cartelle di build (e `.next/package.json`, che altrimenti ferma la risalita un
// livello troppo presto). Chi se la ricalcola non sta risolvendo un problema: ne sta creando uno.
//
// ═══ DUE DOMANDE DIVERSE, DUE MISURE DIVERSE ═════════════════════════════════════════════════════════
//
//   1. CHI CALCOLA A MANO?  Si legge nel sorgente. Include il caso su due righe
//      (`const ROOT = join(__dirname,'..','..')` e poi `join(ROOT,'data','x.json')`), che una regex per
//      riga non vede — ed è la forma in cui il difetto si è presentato davvero.
//
//   2. CHI NE VIENE DANNEGGIATO?  NON si deduce dal sorgente: si guarda se quel calcolo finisce nel
//      BUNDLE SERVER costruito. Un agent pm2 gira da node semplice e lì `__dirname` è quello vero — il
//      calcolo a mano funziona, resta fragile, non è rotto. Il bundle è l'unica prova che non dipende
//      da un'ipotesi su chi importa cosa.
//
// La prima versione di questo scanner cercava entrambe le cose con una regex per riga, e dichiarava
// «1 affetto» mentre ce n'erano tre — perdendo esattamente le forme in cui il difetto si era
// manifestato. Uno scanner che non trova il caso da cui è nato non è uno scanner.
//
// Esegui:  node scripts/percorsi-dati.js
// Uscita:  0 se nessun modulo AFFETTO, 1 altrimenti (così vale anche come guardia in un test).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, '.next', 'server');

/** I sorgenti del progetto, esclusi build, dipendenze, test e utilità da riga di comando. */
function sorgenti(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'scripts') sorgenti(p, out); }
    else if (/\.(js|ts|tsx)$/.test(e.name) && !/\.test\.[jt]s$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Toglie i commenti: un difetto NOMINATO in un commento non è un difetto presente. */
function soloCodice(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');
}

/** I file di dati che il bundle server costruisce partendo da `__dirname`. La prova, non l'indizio. */
function affettiNelBundle() {
  const trovati = new Map();   // nome file dati → Set di file del bundle in cui compare
  if (!fs.existsSync(BUILD)) return trovati;
  const cammina = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { cammina(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const t = fs.readFileSync(p, 'utf8');
      const re = /join\(__dirname[^)]{0,80}\)/g;
      let m;
      while ((m = re.exec(t))) {
        // Dopo il join su __dirname, entro poche centinaia di caratteri, il segmento "data" e un nome file.
        const ctx = t.slice(m.index, m.index + 400);
        const dm = ctx.match(/["']data["'],\s*["']([a-zA-Z0-9_.-]+)["']/);
        if (!dm) continue;
        if (!trovati.has(dm[1])) trovati.set(dm[1], new Set());
        trovati.get(dm[1]).add(path.relative(ROOT, p));
      }
    }
  };
  cammina(BUILD);
  return trovati;
}

/**
 * IL MODULO È DAVVERO DENTRO QUEL PEZZO DI BUNDLE?
 *
 * Attribuire per NOME DEL FILE DATI non basta: tre moduli diversi nominano `liquidity-rewards.json`, e
 * la prima versione di questo scanner ha accusato `lib/rewards/allocator.js` — che è innocente, perché
 * la sua rotta lo carica con `require("/root/prediction-market/lib/rewards/allocator")`, un percorso
 * assoluto risolto a runtime: lì `__dirname` è quello vero e il calcolo a mano funziona.
 *
 * Si cercano allora alcuni LETTERALI DI STRINGA distintivi del sorgente dentro lo stesso file di bundle.
 * I nomi di identificatore la minificazione li riscrive; le stringhe no. Se nessun letterale del modulo
 * compare lì dentro, quel pezzo di bundle non è quel modulo.
 */
function letteraliDistintivi(codice) {
  const out = [];
  for (const m of codice.matchAll(/['"]([^'"\n]{14,60})['"]/g)) {
    const s = m[1];
    if (/^[./]/.test(s) || /\s{2,}/.test(s)) continue;      // percorsi relativi e prosa formattata: poco distintivi
    if (!/[a-zA-Z]/.test(s)) continue;
    out.push(s);
    if (out.length >= 40) break;
  }
  return out;
}

function moduloNelBundle(codice, fileBundle) {
  const lett = letteraliDistintivi(codice);
  if (!lett.length) return false;
  for (const fb of fileBundle) {
    let t;
    try { t = fs.readFileSync(path.join(ROOT, fb), 'utf8'); } catch { continue; }
    if (lett.some((s) => t.includes(s))) return true;
  }
  return false;
}

/** Chi, nel SORGENTE, costruisce un percorso dentro data/ partendo da __dirname. */
function calcoliAMano() {
  const out = [];
  for (const f of sorgenti(ROOT)) {
    const rel = path.relative(ROOT, f);
    const testo = fs.readFileSync(f, 'utf8');
    const codice = soloCodice(testo);
    if (!/join\(\s*__dirname/.test(codice)) continue;
    // Usa già il risolutore condiviso? Allora questo file è a posto.
    const risolve = /\bDATA_DIR\b/.test(codice) && /require\(['"][^'"]*safety\/store['"]\)/.test(codice);

    // Le costanti radice del file: `const X = path.join(__dirname, ...)`.
    const radici = new Set();
    for (const m of codice.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path|p)\.join\(\s*__dirname[^;]*;/g)) radici.add(m[1]);

    const linee = codice.split('\n');
    for (let i = 0; i < linee.length; i++) {
      const r = linee[i];
      const partePerDirname = /join\(\s*__dirname/.test(r);
      const partePerRadice = [...radici].some((v) => new RegExp(`join\\(\\s*${v}\\s*,`).test(r));
      if (!partePerDirname && !partePerRadice) continue;
      if (!/['"]data['"]/.test(r) && !/\/data\//.test(r) && !/\.(json|jsonl|ndjson|csv|txt)['"]/.test(r)) continue;
      const nome = (r.match(/['"]([a-zA-Z0-9_.-]+\.(?:json|jsonl|ndjson|csv|txt))['"]/) || [])[1] || '(cartella data/)';
      out.push({ file: rel, riga: i + 1, dato: nome, risolve, codice });
    }
  }
  return out;
}

/**
 * CHI SI È SCRITTO UN RISOLUTORE PROPRIO invece di usare quello condiviso.
 * `lib/carry-optimize.js` ne ha uno (`resolveRepoFile`, che prova `__dirname/..` e poi `process.cwd()`):
 * FUNZIONA — il cwd salva il caso del bundle — ma è la terza implementazione della stessa cosa in questo
 * repo, e ogni implementazione in più è un posto in più da cui divergere. Non è un guasto: è il modo in
 * cui il guasto è nato.
 */
function risolutoriDuplicati() {
  const out = [];
  for (const f of sorgenti(ROOT)) {
    const rel = path.relative(ROOT, f);
    const codice = soloCodice(fs.readFileSync(f, 'utf8'));
    if (/require\(['"][^'"]*safety\/store['"]\)/.test(codice)) continue;
    // Una funzione che prova più candidati per trovare la radice: la firma di un risolutore fatto in casa.
    // MA SOLO SE RIGUARDA `data/`. `lib/venues/polymarket-clob-maker/adapter.js` fa la stessa cosa per
    // trovare `node_modules` e leggere la versione di un pacchetto: e' lo stesso idioma applicato a un
    // problema diverso, non questo difetto. Chiamarlo difetto insegnerebbe a ignorare l'elenco.
    const perDati = /['"]data['"]/.test(codice) || /\/data\//.test(codice);
    if (perDati && /process\.cwd\(\)/.test(codice) && /join\(\s*__dirname/.test(codice) && /existsSync/.test(codice)) {
      out.push(rel);
    }
  }
  return out;
}

function main() {
  const nelBundle = affettiNelBundle();
  const punti = calcoliAMano();

  // ── CHI PUÒ FINIRE IN UN BUNDLE, E CHI NO ──────────────────────────────────────────────────────
  // Attribuire per NOME DEL FILE DATI non basta: tre moduli nominano `liquidity-rewards.json`, e per
  // omonimia lo scanner accusava `lib/rewards/allocator.js` — innocente, perché la sua rotta lo carica
  // con `require("/root/prediction-market/lib/rewards/allocator")`, assoluto e risolto a runtime.
  // Anche l'attribuzione per letterali condivisi si è rivelata fragile: due moduli che parlano dello
  // stesso dominio condividono stringhe.
  //
  // Il criterio giusto è più semplice ed è VERIFICABILE: un file sotto `agents/` è un punto di ingresso
  // che node esegue direttamente — `__dirname` è sempre quello vero, e nessuna rotta importa un agent
  // (verificato: nessun `import`/`require` di `agents/` sotto `app/`, e nessun nome di agent nel bundle
  // costruito). Un file sotto `lib/` invece può essere importato da una rotta, e allora il calcolo a
  // mano diventa un guasto.
  //
  // Quindi la regola che questo scanner impone: SOTTO `lib/` LA CARTELLA `data/` SI CHIEDE. Sotto
  // `agents/` calcolarla è ammesso — resta fragile se un domani quel modulo venisse importato, e per
  // questo compaiono comunque nell'elenco.
  // IL FILE IMPORTA `DATA_DIR`? NON BASTA. Un file può importarlo per un percorso e continuare a
  // contare i «..» per un altro: la prima versione esentava l'INTERO file appena vedeva l'import, e con
  // il difetto reintrodotto a mano in `market-clock.js` — che ormai importa il risolutore — lo scanner
  // è rimasto verde. Uno scanner che si fida di una dichiarazione invece di guardare la riga non
  // protegge: assolve. Quello che conta è la RIGA, e la riga qui è già stata selezionata perché
  // costruisce un percorso dentro `data/` partendo da `__dirname`.
  const nelBundlePerNome = (p) => nelBundle.has(p.dato);
  for (const p of punti) {
    const importabile = p.file.startsWith('lib/') || p.file.startsWith('app/');
    p.affetto = importabile;
    p.provaNelBundle = nelBundlePerNome(p);
  }

  const affetti = punti.filter((p) => p.affetto);
  const innocui = punti.filter((p) => !p.affetto);

  console.log(`\n══ AFFETTI — sotto lib/ o app/, quindi importabili da una rotta (${affetti.length})`);
  if (!affetti.length) console.log('  nessuno');
  for (const r of affetti) {
    console.log(`  ⚠ ${r.file}:${r.riga}  →  data/${r.dato}`
      + (r.provaNelBundle ? `   [confermato nel bundle: ${[...nelBundle.get(r.dato)][0]}]` : '   [non ancora nel bundle costruito]'));
  }

  console.log(`\n══ INNOCUI — punti di ingresso sotto agents/: __dirname e sempre quello vero (${innocui.length})`);
  for (const r of innocui) console.log(`    ${r.file}:${r.riga}  →  ${r.dato}${r.risolve ? '  [usa il risolutore]' : ''}`);

  // Quello che il bundle contiene e il sorgente non spiega: un percorso costruito da __dirname che non
  // si riesce ad attribuire a un file. Non si tace: si dichiara come non attribuito.
  const attribuiti = new Set(punti.map((p) => p.dato));
  const orfani = [...nelBundle.keys()].filter((k) => !attribuiti.has(k));
  if (orfani.length) {
    console.log(`\n══ NEL BUNDLE MA NON ATTRIBUITI a un sorgente (${orfani.length})`);
    for (const o of orfani) console.log(`  ? data/${o}  →  ${[...nelBundle.get(o)].slice(0, 2).join(', ')}`);
  }

  const dup = risolutoriDuplicati();
  if (dup.length) {
    console.log(`\n══ RISOLUTORI FATTI IN CASA — funzionano, ma sono una copia in piu (${dup.length})`);
    for (const d of dup) console.log(`    ${d}`);
  }

  const problemi = affetti.length + orfani.length;
  console.log(`\n${problemi ? '✗' : '✓'} ${punti.length} calcoli a mano · ${affetti.length} affetti · ${innocui.length} innocui · ${orfani.length} non attribuiti`);
  if (!fs.existsSync(BUILD)) console.log('  NOTA: nessun build in .next/server — «affetto» non e verificabile senza. Esegui npm run build.');
  return problemi ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { calcoliAMano, affettiNelBundle, soloCodice };

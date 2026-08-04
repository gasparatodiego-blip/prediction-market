#!/usr/bin/env node
'use strict';
// scripts/dipendenze-scollegate.js — OGNI `deps.X` HA QUALCUNO CHE GLIELO PASSA?
//
// ═══ LA CLASSE DI DIFETTO CHE CERCA ═════════════════════════════════════════════════════════════════
// Questo repo inietta ogni effetto collaterale: i moduli di lib/ non leggono file e non toccano la rete,
// prendono `deps` e chiamano quello. È la scelta che li rende testabili senza un venue — ed è anche il
// posto dove un modulo può vivere per giorni senza essere mai eseguito.
//
// Il caso peggiore ha una forma precisa:
//
//     if (typeof deps.faiLaCosa === 'function') { ...la cosa... }
//
// Se nessuno inietta `faiLaCosa`, quel blocco non entra MAI. Niente eccezioni, niente log, niente di
// rosso: la funzionalità semplicemente non avviene. E i test passano tutti, perché iniettano la
// dipendenza per provare la logica — provano la DECISIONE e mai il CABLAGGIO.
//
// Misurato su questo repo il 5 agosto 2026: `decideRimpiazzo` era scritto, documentato e coperto da
// cinque scenari, e non lo chiamava nessuno. Non era il primo caso della settimana: `setAutoClose` non
// veniva chiamato dal percorso che piazza, la regola «mai primi sul libro» era collegata solo a un
// motore con zero mercati, e `coppia`/`gamba` venivano scartati da uno schema zod prima di arrivare a
// valle. Quattro difetti, una sola forma.
//
// ═══ COME CLASSIFICA ════════════════════════════════════════════════════════════════════════════════
//   CON DIFETTO      `deps.X || fallback`, `deps.X ?? f`, `typeof deps.X === 'function' ? deps.X : f`
//                    → se manca, c'è un comportamento di riserva. Non è un buco.
//   OBBLIGATORIA     `deps.X(...)` chiamata senza guardia
//                    → se manca, esplode. Rumoroso, quindi non silenzioso: si scopre subito.
//   FACOLTATIVA      `if (typeof deps.X === 'function')` senza ramo alternativo
//                    → SE MANCA, LA FUNZIONALITÀ NON AVVIENE E NESSUNO LO DICE. È questa che conta.
//
// Una FACOLTATIVA senza nessun iniettore in produzione è codice morto. Il resto è informazione.
//
// ═══ COSA CONTA COME INIETTORE ══════════════════════════════════════════════════════════════════════
// Il nome usato come chiave di oggetto (`X:` o `X,` in forma abbreviata) in un file di agents/, app/ o
// in un ALTRO file di lib/ — cioè qualcuno che costruisce il `deps` da passare. I file di test non
// contano: iniettare in un test è esattamente ciò che nasconde il problema.
//
// Uso:  node scripts/dipendenze-scollegate.js [--tutte]

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TUTTE = process.argv.includes('--tutte');

/** Tutti i .js sotto una cartella, esclusi test, node_modules e build. */
function file(dir, out = []) {
  let voci;
  try { voci = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const v of voci) {
    const p = path.join(dir, v.name);
    if (v.isDirectory()) {
      if (['node_modules', '.next', '.next-verifica', '.git'].includes(v.name)) continue;
      file(p, out);
    } else if (/\.(js|ts|tsx)$/.test(v.name) && !/\.test\.js$/.test(v.name) && !/\.d\.ts$/.test(v.name)) {
      out.push(p);
    }
  }
  return out;
}

// ── 1 · TROVA OGNI `deps.X` IN lib/, E COME È USATO ────────────────────────────────────────────────
const usi = new Map();   // nome → { file, classi:Set, righe:[] }
const RISERVATE = new Set(['hasOwnProperty', 'constructor', 'toString', 'length', 'name']);

for (const f of file(path.join(ROOT, 'lib'))) {
  const src = fs.readFileSync(f, 'utf8');
  const righe = src.split('\n');
  for (let i = 0; i < righe.length; i++) {
    const r = righe[i];
    if (r.trim().startsWith('//') || r.trim().startsWith('*')) continue;   // commenti: non sono uso
    for (const m of r.matchAll(/\bdeps\.([A-Za-z_$][\w$]*)/g)) {
      const nome = m[1];
      if (RISERVATE.has(nome)) continue;
      if (!usi.has(nome)) usi.set(nome, { file: new Set(), classi: new Set(), righe: [] });
      const u = usi.get(nome);
      u.file.add(path.relative(ROOT, f));
      u.righe.push({ f: path.relative(ROOT, f), n: i + 1, testo: r.trim().slice(0, 110) });

      // UN RIPIEGO C'E' quando la riga offre un'alternativa: `||`, `??`, oppure un TERNARIO.
      // Il ternario va riconosciuto anche nella forma parentesizzata
      // `(deps && typeof deps.X === 'function') ? ... : ...`, che una regex ancorata al `'function' ?`
      // non vede — ed e' esattamente il falso positivo che questo scanner ha prodotto su se stesso
      // al primo giro.
      const guardiaTipo = new RegExp(`typeof deps\\.${nome}\\s*===\\s*'function'`).test(r);
      const ternario = guardiaTipo && /\?[^?]/.test(r.slice(r.indexOf('typeof deps.' + nome)));
      const conDifetto = new RegExp(`deps\\.${nome}\\s*(\\|\\||\\?\\?)`).test(r) || ternario;
      const guardata = guardiaTipo;
      const chiamata = new RegExp(`deps\\.${nome}\\s*\\(`).test(r);

      if (conDifetto) u.classi.add('con-difetto');
      else if (guardata) u.classi.add('facoltativa');
      else if (chiamata) u.classi.add('obbligatoria');
      else u.classi.add('riferita');
    }
  }
}

// ── 2 · CHI INIETTA? ───────────────────────────────────────────────────────────────────────────────
// I file che COSTRUISCONO un deps: agents/, app/, scripts/ e gli altri file di lib/.
const sorgentiIniezione = [
  ...file(path.join(ROOT, 'agents')),
  ...file(path.join(ROOT, 'app')),
  ...file(path.join(ROOT, 'scripts')),
  ...file(path.join(ROOT, 'lib')),
];
const testoPerFile = new Map();
for (const f of sorgentiIniezione) {
  try { testoPerFile.set(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')); } catch { /* illeggibile */ }
}

function iniettori(nome, fileCheUsano) {
  // `X:` come chiave di oggetto, oppure `X,` / `X }` in forma abbreviata.
  const chiave = new RegExp(`(^|[{,\\s])${nome}\\s*:`, 'm');
  const breve = new RegExp(`(^|[{,\\s])${nome}\\s*[,}]`, 'm');
  const trovati = [];
  for (const [rel, src] of testoPerFile.entries()) {
    if (fileCheUsano.has(rel)) continue;             // il file che la USA non è chi la inietta
    if (rel.startsWith('lib/') && fileCheUsano.has(rel)) continue;
    if (chiave.test(src) || breve.test(src)) trovati.push(rel);
  }
  return trovati;
}

// ── 2b · IL MODULO E' VIVO? ────────────────────────────────────────────────────────────────────────
// Una dipendenza non iniettata in un modulo che NESSUNO importa non e' un buco nel cablaggio: e' un
// modulo dormiente, e sono due diagnosi diverse. La prima si corregge collegando, la seconda si
// decide (serve ancora? va tolto?). Confonderle riempirebbe il referto di rumore.
const importatoDaProduzione = new Map();
function moduloVivo(rel) {
  if (importatoDaProduzione.has(rel)) return importatoDaProduzione.get(rel);
  const base = path.basename(rel).replace(/\.js$/, '');
  const dir = path.dirname(rel).replace(/^lib\//, '');
  const re = new RegExp(`(require\\(|from )['\"][^'\"]*(${dir}/)?${base}['\"]`);
  let vivo = false;
  for (const [altro, src] of testoPerFile.entries()) {
    if (altro === rel) continue;
    if (!altro.startsWith('agents/') && !altro.startsWith('app/') && !altro.startsWith('lib/')) continue;
    if (re.test(src)) { vivo = true; break; }
  }
  importatoDaProduzione.set(rel, vivo);
  return vivo;
}

// ── 3 · IL REFERTO ────────────────────────────────────────────────────────────────────────────────
const morte = [];      // facoltative senza iniettori: la classe che conta
const orfane = [];     // obbligatorie senza iniettori: esploderebbero
const dormienti = [];  // in moduli che nessuno importa: da decidere, non da collegare
const altre = [];

for (const [nome, u] of [...usi.entries()].sort()) {
  const inj = iniettori(nome, u.file);
  const cl = u.classi.has('con-difetto') ? 'con-difetto'
    : u.classi.has('facoltativa') ? 'facoltativa'
      : u.classi.has('obbligatoria') ? 'obbligatoria' : 'riferita';
  const rec = { nome, classe: cl, usataIn: [...u.file], iniettataIn: inj, righe: u.righe };
  rec.moduloVivo = [...u.file].some((f) => moduloVivo(f));
  if (inj.length === 0 && cl === 'facoltativa' && rec.moduloVivo) morte.push(rec);
  else if (inj.length === 0 && cl === 'obbligatoria' && rec.moduloVivo) orfane.push(rec);
  else if (inj.length === 0 && !rec.moduloVivo) dormienti.push(rec);
  else altre.push(rec);
}

const riga = (s) => console.log(s);
riga('');
riga('═'.repeat(96));
riga('DIPENDENZE INIETTATE — chi le usa, chi gliele passa');
riga('═'.repeat(96));
riga(`analizzate ${usi.size} dipendenze distinte in lib/`);
riga('');

riga('── CODICE MORTO: facoltative che nessuno inietta ────────────────────────────────────────────');
if (!morte.length) riga('  nessuna. Ogni comportamento facoltativo ha almeno un iniettore in produzione.');
for (const m of morte) {
  riga(`  ✗ deps.${m.nome}`);
  riga(`      usata in: ${m.usataIn.join(', ')}`);
  for (const r of m.righe.slice(0, 2)) riga(`      ${r.f}:${r.n}  ${r.testo}`);
  riga('      → se nessuno la inietta, quel blocco non entra MAI e nessuno lo dice.');
}

riga('');
riga('── SENZA RISERVA: obbligatorie che nessuno inietta (esploderebbero) ──────────────────────────');
if (!orfane.length) riga('  nessuna.');
for (const o of orfane) {
  riga(`  ! deps.${o.nome}  — usata in ${o.usataIn.join(', ')}`);
  for (const r of o.righe.slice(0, 1)) riga(`      ${r.f}:${r.n}  ${r.testo}`);
}

if (TUTTE) {
  riga('');
  riga('── TUTTE LE ALTRE ───────────────────────────────────────────────────────────────────────────');
  for (const a of altre) {
    riga(`  · deps.${a.nome}  [${a.classe}]  iniettata in ${a.iniettataIn.length} file`);
  }
}

riga('');
riga('── MODULI DORMIENTI: dipendenze non iniettate, ma nessuno importa quel modulo ────────────────');
if (!dormienti.length) riga('  nessuno.');
for (const d of dormienti) riga(`  ~ deps.${d.nome}  [${d.classe}]  in ${d.usataIn.join(', ')} — modulo mai importato dalla produzione`);

riga('');
riga('═'.repeat(96));
riga(`ESITO: ${morte.length} facoltative MAI iniettate in moduli VIVI · ${orfane.length} obbligatorie mai iniettate · ${dormienti.length} in moduli dormienti`);
riga('═'.repeat(96));

module.exports = { morte, orfane, dormienti, altre };
if (require.main === module) process.exit(morte.length ? 1 : 0);

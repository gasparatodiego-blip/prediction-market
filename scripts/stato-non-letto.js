#!/usr/bin/env node
'use strict';
// scripts/stato-non-letto.js — UNO STATO CHE SI SCRIVE E NON SI LEGGE È UNA FUNZIONALITÀ INVISIBILE.
//
// ═══ LA CLASSE DI DIFETTO ════════════════════════════════════════════════════════════════════════════
// Gemello di scripts/dipendenze-scollegate.js, sull'altro lato dell'applicazione. Là il buco era un
// `deps.X` che nessuno iniettava; qui è uno stato React che qualcuno SCRIVE e nessuno LEGGE:
//
//     const [addPreview, setAddPreview] = useState(null);
//     ...
//     setAddPreview(risposta);        // ← la risposta arriva
//     // e in tutto il JSX `addPreview` non compare mai   ← e non la vede nessuno
//
// Il comportamento che ne risulta è il peggiore possibile da diagnosticare, perché somiglia a un
// successo: il bottone entra in caricamento, la richiesta parte, la risposta torna, il bottone si
// riprende — e non succede niente. Nessun errore, nessun pannello, nessuna traccia. Anche il ramo di
// errore è muto, perché di solito `setErr` è scrivi-e-basta esattamente come gli altri.
//
// Misurato su questo repo il 4 agosto 2026: il bottone «1 · Anteprima» della tab Ottimizza non mostrava
// nulla da quattro giorni. Il pannello ESISTEVA ed era stato scritto bene; il refactor «sei tab
// diventano tre» (b7b80b4) aveva rimosso le venti righe che lo rendevano e lasciato in piedi lo stato,
// il bottone e la chiamata. Tre stati diventati scrivi-e-basta in un colpo: addPreview, addResult, addErr.
//
// ═══ COSA CONTA COME LETTURA ════════════════════════════════════════════════════════════════════════
// Qualunque occorrenza del nome che NON sia la riga di destrutturazione e non sia una chiamata al suo
// stesso setter. Un `useEffect` che lo legge conta, un `useMemo` conta, il JSX conta. È volutamente
// generoso: questo controllo deve trovare gli stati MAI letti, non discutere di come vengono letti.
//
// Uso:  node scripts/stato-non-letto.js [--tutti]

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TUTTI = process.argv.includes('--tutti');

function file(dir, out = []) {
  let voci;
  try { voci = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const v of voci) {
    const p = path.join(dir, v.name);
    if (v.isDirectory()) {
      if (['node_modules', '.next', '.next-verifica', '.git'].includes(v.name)) continue;
      file(p, out);
    } else if (/\.(tsx|jsx)$/.test(v.name) && !/\.test\./.test(v.name)) {
      out.push(p);
    }
  }
  return out;
}

// `const [nome, setNome] = useState...`  ·  regge useState<T>(...) e gli spazi di prettier
const DICHIARAZIONE = /const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*useState/g;

/**
 * L'analisi di UN sorgente. Estratta perché sia provabile su codice sintetico: un controllo che non si
 * può mettere alla prova su un difetto costruito apposta è un controllo di cui nessuno sa se funziona.
 * @returns {Array<{nome,setter,riga,letture,scritture,doveScritto,classe}>}
 */
function analizzaSorgente(srcOriginale, rel = '(memoria)') {
  // I COMMENTI NON SONO LETTURE, E NON BASTA SALTARE LE RIGHE CHE COMINCIANO CON `//`.
  // Un blocco `/* … */` le cui righe di continuazione non cominciano con `*` passava per codice: è il
  // falso negativo che questo scanner ha prodotto su se stesso, quando il commento che SPIEGA il difetto
  // ha tenuto in vita i nomi che il difetto aveva ucciso. Qui i commenti si svuotano prima di guardare,
  // conservando le righe perché i numeri restino quelli del file vero.
  const src = srcOriginale
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (c, p) => p + ' '.repeat(c.length - p.length));
  const righe = src.split('\n');
  const out = [];
  for (const m of src.matchAll(DICHIARAZIONE)) {
    const [, nome, setter] = m;
    const rigaDich = src.slice(0, m.index).split('\n').length;

    let letture = 0, scritture = 0;
    const doveScritto = [];
    const parola = new RegExp(`\\b${nome}\\b`);
    const parolaSetter = new RegExp(`\\b${setter}\\s*\\(`);

    for (let i = 0; i < righe.length; i++) {
      const r = righe[i];
      if (i + 1 === rigaDich) continue;                        // la destrutturazione non è una lettura
      if (r.trim().startsWith('//') || r.trim().startsWith('*')) continue;
      if (parolaSetter.test(r)) { scritture++; doveScritto.push({ n: i + 1, testo: r.trim().slice(0, 100) }); }
      // Una riga che chiama SOLO il setter non conta come lettura del nome: `setAddPreview(b)` contiene
      // «AddPreview» ma non legge `addPreview`. Il confine sta nel \b davanti al nome minuscolo.
      if (parola.test(r)) letture++;
    }

    const classe = scritture > 0 && letture === 0 ? 'morto'
      : scritture === 0 && letture === 0 ? 'inerte' : 'vivo';
    out.push({ file: rel, nome, setter, riga: rigaDich, letture, scritture, doveScritto, classe });
  }
  return out;
}

const morti = [];   // scritti e MAI letti: il difetto
const inerti = [];  // né scritti né letti: rumore, non un buco
const vivi = [];

for (const f of file(path.join(ROOT, 'app'))) {
  const rel = path.relative(ROOT, f);
  for (const rec of analizzaSorgente(fs.readFileSync(f, 'utf8'), rel)) {
    (rec.classe === 'morto' ? morti : rec.classe === 'inerte' ? inerti : vivi).push(rec);
  }
}

const riga = (s) => console.log(s);
riga('');
riga('═'.repeat(96));
riga('STATO REACT — chi lo scrive, chi lo legge');
riga('═'.repeat(96));
riga(`analizzati ${morti.length + inerti.length + vivi.length} useState in app/`);
riga('');

riga('── SCRITTI E MAI LETTI: la risposta arriva e non la vede nessuno ────────────────────────────');
if (!morti.length) riga('  nessuno. Ogni stato che viene scritto viene anche letto da qualche parte.');
for (const d of morti) {
  riga(`  ✗ ${d.nome}  (${d.file}:${d.riga})`);
  for (const s of d.doveScritto.slice(0, 3)) riga(`      scritto a riga ${s.n}:  ${s.testo}`);
  riga(`      → ${d.scritture} scritture, 0 letture: l'utente preme, la chiamata parte, e non succede niente.`);
}

riga('');
riga('── NÉ SCRITTI NÉ LETTI: inerti, non un buco ────────────────────────────────────────────────');
if (!inerti.length) riga('  nessuno.');
for (const d of inerti) riga(`  ~ ${d.nome}  (${d.file}:${d.riga})`);

if (TUTTI) {
  riga('');
  riga('── TUTTI GLI ALTRI ─────────────────────────────────────────────────────────────────────────');
  for (const v of vivi) riga(`  · ${v.nome}  ${v.scritture}w/${v.letture}r  ${v.file}`);
}

riga('');
riga('═'.repeat(96));
riga(`ESITO: ${morti.length} stati scritti e mai letti · ${inerti.length} inerti · ${vivi.length} vivi`);
riga('═'.repeat(96));

module.exports = { morti, inerti, vivi, analizzaSorgente };
if (require.main === module) process.exit(morti.length ? 1 : 0);

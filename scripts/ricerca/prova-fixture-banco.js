#!/usr/bin/env node
'use strict';
/**
 * LE SEI FIXTURE DEL BANCO, PROVATE PER SOTTRAZIONE — sola misura.
 *
 * ═══ LA DOMANDA ═════════════════════════════════════════════════════════════════════════════════════
 * «Quali regole erano rosse SOLO per la fixture?» Non si risponde rileggendo la correzione — un
 * commento che dice «corretto» e' esattamente cio' che non si puo' credere qui dentro (reperto D7).
 * Si risponde RIMETTENDO il difetto e contando cosa torna rosso: la differenza fra i due insiemi di
 * regole scattate E' l'elenco cercato.
 *
 * Serve anche come cintura permanente: se un domani qualcuno «semplifica» una di queste sei righe, il
 * banco continuerebbe a girare e a stampare un numero — piu' basso, e senza dire perche'. Questo
 * script fa fallire quella semplificazione con un nome e un conto.
 *
 * ═══ PERCHE' LAVORA SU COPIE, E NON IN PLACE ════════════════════════════════════════════════════════
 * Rimettere un difetto in `scripts/ricerca/banco-*.js` e poi ripristinarlo funziona finche' non
 * arriva un `kill -9` a metta' corsa: allora il repo resta con un difetto dentro e nessuno lo dice.
 * Quindi i due file si COPIANO in `scripts/ricerca/_prova-fixture/`, si patchano le copie, e i file
 * tracciati non vengono aperti in scrittura nemmeno una volta. La copia risolve `ROOT` con un livello
 * in piu' di `..` e scrive il proprio referto, cosi' non sovrascrive quello della corsa vera.
 *
 * Uso:  node scripts/ricerca/prova-fixture-banco.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(__dirname, '_prova-fixture');
const BASE = 'banco-ciclo-completo.js';
const SCEN = 'banco-scenari.js';
const REFERTO = path.join(ROOT, 'data', 'ricerca', 'banco-fixture-prova.json');

// ── I SEI DIFETTI, NELLA FORMA ESATTA IN CUI SONO STATI TROVATI ────────────────────────────────────
// ⚠ Il 5 e' contato una volta in APERTI.md ma ha DUE meta' indipendenti, e la prova le distingue:
// l'estrattore ancorato al solo letterale (perde i ternari, cioe' regole vere che non si vedono) e
// l'estrattore senza sanificazione (prende confronti e ripieghi, cioe' regole che non esistono).
const DIFETTI = [
  { n: '1 · maxSpread scritto col nome sbagliato', file: BASE, patch: [
    ['mid: m.book.yes.scoringMid, updatedMs: VENUE.ora, maxSpread: m.bandaCents,',
     'mid: m.book.yes.scoringMid, updatedMs: VENUE.ora, rewardsMaxSpread: m.bandaCents,'],
    ['      maxSpread: m.bandaCents,\n      rewardsMinSize: m.minSize,', '      rewardsMinSize: m.minSize,'],
  ] },
  { n: '2 · isManual torna un booleano invece di {manual,readable}', file: SCEN, patch: [
    ['isManual: () => ({ manual: true, readable: true }),', 'isManual: () => true,'],
  ] },
  { n: '3 · require.cache su un percorso inesistente', file: BASE, patch: [
    ['const g = ADAPTER_VERO.evaluateLiveMinMarketGate({',
     "const g = require(path.join(ROOT, 'lib/venues/polymarket-clob-maker/adapter_vero.js')).evaluateLiveMinMarketGate({"],
  ] },
  { n: '4 · global.enabled invece di globalEnabled', file: BASE, patch: [
    ['readable: true, globalEnabled: true, global: { enabled: true },', 'readable: true, global: { enabled: true },'],
  ] },
  { n: '5a · estrattore ancorato al solo letterale (perde i ternari)', file: SCEN, patch: [
    ['for (const m of codice.matchAll(/outcome:\\s*([^,\\n]+)/g)) {',
     "for (const m of codice.matchAll(/outcome:\\s*('[a-z0-9-]+')/g)) {"],
  ] },
  { n: '5b · estrattore senza sanificazione (prende confronti e ripieghi)', file: SCEN, patch: [
    ["      const senzaConfronti = espr.replace(/[!=]==?\\s*'[^']*'/g, ' ');\n"
     + "      const senzaRipieghi = senzaConfronti.replace(/\\$\\{[^}]*\\}/g, ' ');\n"
     + '      for (const q of senzaRipieghi.matchAll(', '      for (const q of espr.matchAll('],
  ] },
  { n: '6 · expiresAtMs non esposto dagli ordini simulati', file: BASE, patch: [
    ['        expiresAtMs: o.scadeA || null,\n', ''],
  ] },
];

const sorgente = {
  [BASE]: fs.readFileSync(path.join(__dirname, BASE), 'utf8')
    // La copia sta un livello piu' in basso: `ROOT` va corretto, o il banco leggerebbe `scripts/`.
    .replace("path.resolve(__dirname, '..', '..')", "path.resolve(__dirname, '..', '..', '..')")
    .replace("'banco-ciclo-completo.json'", "'banco-fixture-prova.json'"),
  [SCEN]: fs.readFileSync(path.join(__dirname, SCEN), 'utf8'),
};
for (const k of Object.keys(sorgente)) {
  if (k === BASE && !/'\.\.', '\.\.', '\.\.'/.test(sorgente[k])) throw new Error('ROOT della copia non riscritto: il banco leggerebbe la directory sbagliata');
}

function corri() {
  try { execFileSync('node', [path.join(DIR, SCEN)], { cwd: ROOT, stdio: 'pipe', timeout: 900_000 }); }
  catch (e) { return { errore: String(e.stderr || e.message).slice(-300) }; }
  const r = JSON.parse(fs.readFileSync(REFERTO, 'utf8'));
  return { inventariate: r.regoleInventariate, rosse: r.regoleMaiScattate,
    scattate: r.scattate.map((x) => x.regola).sort(), dinamiche: (r.dinamicheScattate || []).slice().sort() };
}

function scrivi(patch = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of [BASE, SCEN]) {
    let src = sorgente[f];
    for (const [da, a] of (patch[f] || [])) {
      if (!src.includes(da)) throw new Error(`patch non applicabile su ${f}: «${da.slice(0, 70)}» — la correzione e' stata riscritta, va aggiornata anche qui`);
      src = src.replace(da, a);
    }
    fs.writeFileSync(path.join(DIR, f), src);
  }
}

const out = [];
try {
  scrivi();
  const base = corri();
  if (base.errore) throw new Error(`la BASELINE non gira: ${base.errore}`);
  out.push({ difetto: '(baseline)', ...base });
  console.log('\n════ LE SEI FIXTURE DEL BANCO, PROVATE PER SOTTRAZIONE ════\n');
  console.log(`BASELINE  inventariate ${base.inventariate}  ·  scattate ${base.scattate.length} statiche + ${base.dinamiche.length} dinamiche  ·  rosse ${base.rosse}`);

  const vittime = new Set(); const vittimeDin = new Set();
  for (const d of DIFETTI) {
    scrivi({ [d.file]: d.patch });
    const r = corri();
    console.log(`\n▪ ${d.n}`);
    if (r.errore) { console.log(`   IL BANCO MUORE: ${r.errore.split('\n').filter(Boolean).slice(-2).join(' | ')}`); out.push({ difetto: d.n, ...r }); continue; }
    const perse = base.scattate.filter((x) => !r.scattate.includes(x));
    const perseDin = base.dinamiche.filter((x) => !r.dinamiche.includes(x));
    const comparse = r.scattate.filter((x) => !base.scattate.includes(x));
    perse.forEach((x) => vittime.add(x)); perseDin.forEach((x) => vittimeDin.add(x));
    console.log(`   inventariate ${r.inventariate} (base ${base.inventariate})  ·  statiche ${r.scattate.length} (base ${base.scattate.length})  ·  dinamiche ${r.dinamiche.length} (base ${base.dinamiche.length})`);
    if (perse.length) console.log(`   ROSSE SOLO PER LA FIXTURE — statiche (${perse.length}): ${perse.join(', ')}`);
    if (perseDin.length) console.log(`   ROSSE SOLO PER LA FIXTURE — dinamiche (${perseDin.length}): ${perseDin.join(', ')}`);
    // ⚠ Una regola che compare SOLO col difetto dentro non e' un guadagno: e' il banco che si rompe e
    // dichiara il proprio errore. Va mostrata, o si leggerebbe come copertura in piu'.
    if (comparse.length) console.log(`   comparse col difetto dentro (il banco si rompe e lo dichiara): ${comparse.join(', ')}`);
    if (!perse.length && !perseDin.length && !comparse.length && r.inventariate === base.inventariate) {
      console.log('   ⚠ NESSUNA DIFFERENZA: questa correzione non porta peso, o la prova non la esercita');
    }
    out.push({ difetto: d.n, ...r, perse, perseDin, comparse });
  }

  const nonToccate = base.scattate.filter((x) => !vittime.has(x));
  console.log(`\n── il conto ──`);
  console.log(`  regole che scattano oggi e che UNA delle sei fixture bastava a spegnere: ${vittime.size} statiche + ${vittimeDin.size} dinamiche`);
  console.log(`  statiche che nessuna delle sei tocca (${nonToccate.length}): ${nonToccate.join(', ') || '(nessuna)'}`);
  fs.writeFileSync(path.join(ROOT, 'data', 'ricerca', 'prova-fixture-banco.json'),
    JSON.stringify({ generatoIl: new Date().toISOString(), baseline: out[0],
      vittime: [...vittime].sort(), vittimeDinamiche: [...vittimeDin].sort(), nonToccate, per_difetto: out.slice(1) }, null, 1));
  console.log(`\nreferto → data/ricerca/prova-fixture-banco.json`);
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
  // ⚠ Si DICHIARA che i file tracciati sono intatti: e' l'unica affermazione che rende usabile uno
  // script che patcha del codice. Non basta averlo progettato per non toccarli.
  const sporco = execFileSync('git', ['status', '--short', 'scripts/ricerca/'], { cwd: ROOT }).toString().trim();
  console.log(`\ngit status scripts/ricerca/ → ${sporco || '(pulito: i file tracciati non sono stati aperti in scrittura)'}`);
}

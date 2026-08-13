#!/usr/bin/env node
'use strict';
/**
 * LA SUITE, ROSSI E VERDI — sola lettura, nessuno stato toccato.
 *
 * Replica esattamente il modo in cui `agent44-audit-scoperta` esegue i test ogni notte: stesso
 * `execFile('node', [file])`, stessa sanificazione d'ambiente (`MAKER_MODE=off` e via le tre variabili
 * che aprono la porta al venue), stessa distinzione a tre esiti — verde · rosso · NON PARTITO (un test
 * il cui modulo non si risolve non e' mai stato eseguibile, e chiamarlo «rosso» e' un falso allarme).
 *
 * Serve a una cosa sola: avere la lista dei rossi PRIMA di una modifica e RIRUNNARLA dopo, cosi'
 * «la suite resta verde a meno dei rossi di baseline» e' un confronto fra due elenchi invece che
 * un'affermazione. Scrive in data/ricerca/ e niente altro.
 *
 * Uso:  node scripts/ricerca/suite-rossi.js [nome-istantanea]
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'data', 'ricerca');
const nome = (process.argv[2] || 'baseline').replace(/[^\w.-]/g, '-');
const OUT = path.join(OUT_DIR, `suite-rossi-${nome}.json`);
const TIMEOUT_MS = 60_000;

/** Tutti i `*.test.js` del repo, esclusi node_modules e .next. */
function trovaTest(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) trovaTest(p, acc);
    else if (/\.test\.js$/.test(e.name)) acc.push(path.relative(ROOT, p));
  }
  return acc;
}

const esegui = (file, env) => new Promise((res) => {
  execFile('node', [file], { cwd: ROOT, timeout: TIMEOUT_MS, env, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (!err) return res({ esito: 'verde' });
      const s = String(stderr || '');
      if (/MODULE_NOT_FOUND|Cannot find module/.test(s)) return res({ esito: 'non-parte', coda: s.trim().slice(-200) });
      return res({ esito: 'rosso', coda: (s || String(stdout || '')).trim().slice(-300) });
    });
});

// Le impronte dello stato che NESSUN test deve poter cambiare. Se una si muove, il referto lo dice:
// e' la stessa cintura che agent44 tiene, e la lezione di §5 punto 1 si paga una volta sola.
const STATO_SENSIBILE = [
  'data/maker-bot-enabled.json', 'data/safety-kill-switch.json', 'data/guardian-state.json',
  'data/guardian-baseline.json', 'data/maker-auto-reprice.json', 'data/maker-manual-mode.json',
  'data/maker-allocated-capital.json', 'data/realloc-ultimo-piano.json',
];
const impronte = () => new Map(STATO_SENSIBILE.map((k) => {
  const p = path.join(ROOT, k);
  try { const st = fs.statSync(p); return [k, `${st.size}:${st.mtimeMs}`]; } catch { return [k, 'assente']; }
}));

(async () => {
  const files = trovaTest(ROOT).sort();
  const env = { ...process.env, MAKER_MODE: 'off' };
  for (const k of ['MANUAL_ORDER_PLACEMENT', 'MAKER_PLACEMENT', 'MAKER_FUNDING_APPROVED']) delete env[k];
  const prima = impronte();
  const rossi = [], nonParte = [];
  let verdi = 0;
  for (const f of files) {
    // eslint-disable-next-line no-await-in-loop
    const r = await esegui(f, env);
    if (r.esito === 'verde') verdi += 1;
    else if (r.esito === 'rosso') { rossi.push({ file: f, coda: r.coda }); process.stdout.write(`  ✗ ${f}\n`); }
    else { nonParte.push(f); process.stdout.write(`  · ${f} (non parte)\n`); }
  }
  const dopo = impronte();
  const toccati = STATO_SENSIBILE.filter((k) => prima.get(k) !== dopo.get(k));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const corpo = {
    at: new Date().toISOString(), istantanea: nome,
    totali: { eseguiti: files.length, verdi, rossi: rossi.length, nonParte: nonParte.length },
    rossi: rossi.map((r) => r.file), rossiDettaglio: rossi, nonParte, statoToccato: toccati,
  };
  fs.writeFileSync(OUT, JSON.stringify(corpo, null, 2));
  console.log(`\n${files.length} test · ${verdi} verdi · ${rossi.length} ROSSI · ${nonParte.length} non partiti`);
  console.log(toccati.length ? `⚠ STATO TOCCATO: ${toccati.join(', ')}` : '✓ nessuno stato sensibile toccato');
  console.log(`→ ${path.relative(ROOT, OUT)}`);
})();

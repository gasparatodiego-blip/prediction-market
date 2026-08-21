'use strict';
// scripts/ricerca/d-a-simulazione-a-secco.js — SOLA LETTURA.
// SIMULAZIONE A SECCO della correzione D-A: la selezione ordina con `bestObiettivoPerDay` invece di
// `bestNetPerDay`. Chiama il RUNNER del piano ESATTAMENTE come `agent41.nettiDeiCandidati` (stesso
// runner, stesso payload, stesso tetto derivato dal capitale) e confronta le due grandezze.
// Nessuna scrittura fuori da data/ricerca/. Non tocca nessun ordine, nessuno stato, nessun processo.
const { execFile } = require('child_process');
const fs = require('fs'); const path = require('path');
const RADICE = path.join(__dirname, '..', '..');
for (const l of fs.readFileSync(path.join(RADICE, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const SELM = require(path.join(RADICE, 'lib/maker/selezione-mercati'));
const { capPerMarketUsd } = require(path.join(RADICE, 'lib/rewards/concentration'));
const PERCORSO_ALLOCATOR = path.join(RADICE, 'lib/rewards/allocator');
const RUNNER_PIANO = 'let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{b+=d});process.stdin.on("end",()=>{try{const o=JSON.parse(b);process.stdout.write(JSON.stringify(require('
  + JSON.stringify(PERCORSO_ALLOCATOR)
  + ').planFromCollection(o)))}catch(e){process.stderr.write(String(e&&e.stack||e));process.exit(3)}});';

const board = JSON.parse(fs.readFileSync(path.join(RADICE, 'data/liquidity-rewards.json'), 'utf8')).markets;
const stato = JSON.parse(fs.readFileSync(path.join(RADICE, 'data/selezione-mercati.json'), 'utf8'));
const OCCUPANTI = new Set(Object.keys(stato.selezionati || {}).map(x => x.toLowerCase()));

(async () => {
  const ora = Date.now();
  const ammissibili = board
    .filter((r) => SELM.valutaAmmissibilita(r, { ora, orizzonteMassimoOre: undefined }).ammissibile)
    .map((r) => String(r.conditionId || '').trim().toLowerCase()).filter(Boolean);
  console.log('ammissibili (stessa funzione di agent41):', ammissibili.length, 'su', board.length);

  // il capitale, come lo legge agent41
  const { leggiSaldoUsd } = require(path.join(RADICE, 'lib/maker/saldo-cache'));
  const s = await leggiSaldoUsd();
  const capitale = s && s.affidabile === true ? s.usd : null;
  if (!Number.isFinite(capitale)) { console.log('capitale non leggibile — mi fermo'); process.exit(1); }
  console.log('capitale', capitale.toFixed(2), '· tetto derivato', capPerMarketUsd(capitale));

  const piano = await new Promise((ris, rif) => {
    const f = execFile('node', ['-e', RUNNER_PIANO], { timeout: 120000, maxBuffer: 48 * 1024 * 1024 },
      (err, out) => { if (err) return rif(new Error(err.killed ? 'timeout' : err.message));
        try { ris(JSON.parse(out)); } catch (e) { rif(new Error('JSON non valido: ' + e.message)); } });
    f.on('error', rif);
    f.stdin.end(JSON.stringify({ capital: capitale, maxPerMarketUsd: capPerMarketUsd(capitale),
      from: new Date(ora - 24 * 3600e3).toISOString(), to: new Date(ora).toISOString(),
      horizonFilter: true, onlyMarketIds: ammissibili }));
  });

  const cand = piano.candidates || [];
  const nome = new Map(board.map(m => [String(m.conditionId).toLowerCase(),
    (m.groupItemTitle ? m.groupItemTitle + ' — ' : '') + m.question]));
  const righe = cand.map(c => {
    const id = String(c.marketId || '').toLowerCase();
    return { id, q: nome.get(id) || '?', occupante: OCCUPANTI.has(id),
      vecchio: Number.isFinite(c.bestNetPerDay) ? c.bestNetPerDay : null,
      nuovo: Number.isFinite(c.bestObiettivoPerDay) ? c.bestObiettivoPerDay : null,
      assente: c.bestNetAssente || null, fills: c.fills ?? null };
  });
  const conVecchio = righe.filter(r => r.vecchio != null).length;
  const conNuovo = righe.filter(r => r.nuovo != null).length;
  console.log('');
  console.log(`candidati nel piano: ${righe.length}`);
  console.log(`  con \`bestNetPerDay\`      (la grandezza VECCHIA): ${conVecchio}`);
  console.log(`  con \`bestObiettivoPerDay\` (la grandezza NUOVA):  ${conNuovo}`);
  console.log('');
  const ord = (k) => righe.filter(r => r[k] != null).sort((a, b) => b[k] - a[k]);
  const vec = ord('vecchio'), nuo = ord('nuovo');
  console.log('CLASSIFICA — PRIMA (bestNetPerDay)            |  DOPO (bestObiettivoPerDay)');
  const n = Math.max(vec.length, nuo.length);
  for (let i = 0; i < n; i++) {
    const a = vec[i], b = nuo[i];
    const f = (r) => r ? ((r.occupante ? '●' : '·') + ' $' + r[r === a ? 'vecchio' : 'nuovo'].toFixed(4).padStart(9) + ' ' + r.q.slice(0, 26).padEnd(26)) : ' '.repeat(39);
    const fa = a ? ('● '.replace('●', a.occupante ? '●' : '·') + '$' + a.vecchio.toFixed(4).padStart(9) + ' ' + a.q.slice(0, 26).padEnd(26)) : ' '.repeat(38);
    const fb = b ? ((b.occupante ? '●' : '·') + ' $' + b.nuovo.toFixed(4).padStart(9) + ' ' + b.q.slice(0, 30)) : '';
    console.log(String(i + 1).padStart(3), fa, '|', fb);
  }
  console.log('  ● = occupante di uno dei 5 slot');
  fs.writeFileSync(path.join(RADICE, 'data/ricerca/d-a-simulazione-a-secco.json'),
    JSON.stringify({ lettoAl: new Date(ora).toISOString(), capitale, ammissibili: ammissibili.length,
      candidati: righe.length, conVecchio, conNuovo, righe }, null, 1));
  console.log('\nscritto data/ricerca/d-a-simulazione-a-secco.json');
})().catch(e => { console.error('FALLITO:', e.message); process.exit(1); });

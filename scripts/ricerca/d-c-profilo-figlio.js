'use strict';
// scripts/ricerca/d-c-profilo-figlio.js — SOLA LETTURA.
// Profila il PROCESSO FIGLIO del piano: picco di memoria REALE (VmHWM da /proc, non una stima) e
// durata, al variare del numero di candidati. Serve a rispondere: dove va la memoria, e quanti MB
// costa un candidato. Non scrive niente fuori da data/ricerca/, non tocca ordini ne` processi.
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
const RADICE = path.join(__dirname, '..', '..');
for (const l of fs.readFileSync(path.join(RADICE, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const PERCORSO_ALLOCATOR = path.join(RADICE, 'lib/rewards/allocator');
const RUNNER = 'let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{b+=d});process.stdin.on("end",()=>{try{const o=JSON.parse(b);process.stdout.write(JSON.stringify(require('
  + JSON.stringify(PERCORSO_ALLOCATOR)
  + ').planFromCollection(o)))}catch(e){process.stderr.write(String(e&&e.stack||e));process.exit(3)}});';

const board = JSON.parse(fs.readFileSync(path.join(RADICE, 'data/liquidity-rewards.json'), 'utf8')).markets;

/** Il picco REALE del figlio: VmHWM da /proc, campionato finche' il processo vive. */
function corri(opzioni, etichetta) {
  return new Promise((res) => {
    const t0 = Date.now();
    const f = spawn('node', ['-e', RUNNER], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', picco = 0, campioni = 0;
    const orologio = setInterval(() => {
      try {
        const st = fs.readFileSync(`/proc/${f.pid}/status`, 'utf8');
        const m = st.match(/VmHWM:\s+(\d+) kB/);
        if (m) { picco = Math.max(picco, Number(m[1]) / 1024); campioni++; }
      } catch (_) { /* il figlio e' morto: il picco resta l'ultimo letto */ }
    }, 60);
    f.stdout.on('data', (d) => { out += d; });
    f.stderr.on('data', (d) => { err += d; });
    f.on('close', (code) => {
      clearInterval(orologio);
      let piano = null; try { piano = JSON.parse(out); } catch (_) {}
      res({ etichetta, code, piccoMb: +picco.toFixed(1), campioni, ms: Date.now() - t0,
        oom: /heap out of memory|Allocation failed/i.test(err),
        candidati: piano && piano.candidates ? piano.candidates.length : null,
        righe: piano && piano.rows ? piano.rows.length : null,
        bytesUscita: out.length,
        err: err ? err.trim().slice(-160) : null });
    });
    f.stdin.end(JSON.stringify(opzioni));
  });
}

(async () => {
  const capitale = 1494.78, tetto = 61.25;
  const ids = board.map(m => String(m.conditionId).trim().toLowerCase());
  const base = { capital: capitale, maxPerMarketUsd: tetto, horizonFilter: true };
  const prove = [
    { n: 5,   opts: { ...base, onlyMarketIds: ids.slice(0, 5) } },
    { n: 20,  opts: { ...base, onlyMarketIds: ids.slice(0, 20) } },
    { n: 40,  opts: { ...base, onlyMarketIds: ids.slice(0, 40) } },
    { n: 70,  opts: { ...base, onlyMarketIds: ids.slice(0, 70) } },
    { n: board.length, opts: { ...base } },            // l'universo INTERO: e' quello che va in OOM
  ];
  console.log('capitale $' + capitale + ' · tetto $' + tetto + ' · board ' + board.length + ' mercati');
  console.log('');
  console.log('universo  picco_MB   durata   esito        candidati  righe  uscita_MB');
  const out = [];
  for (const p of prove) {
    const r = await corri(p.opts, String(p.n));
    out.push({ universo: p.n, ...r });
    console.log(String(p.n).padEnd(9), String(r.piccoMb).padStart(8), String((r.ms / 1000).toFixed(1) + 's').padStart(8),
      '  ' + (r.oom ? 'OOM' : r.code === 0 ? 'ok' : 'exit ' + r.code).padEnd(12),
      String(r.candidati ?? '—').padStart(9), String(r.righe ?? '—').padStart(6),
      String((r.bytesUscita / 1048576).toFixed(1)).padStart(10));
    if (r.err && r.code !== 0) console.log('      err:', r.err.slice(0, 150));
  }
  // MB per candidato, dalla regressione sui punti riusciti
  const ok = out.filter(x => x.code === 0 && x.candidati != null);
  if (ok.length >= 2) {
    const a = ok[0], b = ok[ok.length - 1];
    const perCand = (b.piccoMb - a.piccoMb) / (b.candidati - a.candidati);
    console.log('');
    console.log(`MB per candidato (fra ${a.candidati} e ${b.candidati}): ${perCand.toFixed(2)} MB`);
    console.log(`base (intercetta a 0 candidati): ${(a.piccoMb - perCand * a.candidati).toFixed(0)} MB`);
  }
  fs.writeFileSync(path.join(RADICE, 'data/ricerca/d-c-profilo-figlio.json'),
    JSON.stringify({ lettoAl: new Date().toISOString(), capitale, tetto, board: board.length, prove: out }, null, 1));
  console.log('\nscritto data/ricerca/d-c-profilo-figlio.json');
})();

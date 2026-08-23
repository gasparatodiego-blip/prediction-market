'use strict';
// SOLA LETTURA — perché il piano non finanzia gli slot selezionati. 23 agosto 2026.
//
// ⚠⚠ QUESTO SCRIPT NON HA UN OUTPUT, E L'ASSENZA E' IL SUO RISULTATO: su questa macchina il figlio
// del piano muore con SIGABRT (OOM) — provato 3 volte su 3, con e senza `--max-old-space-size`.
// 1.855 MB totali, ~400 MB disponibili, 1,5 GB di swap gia' usato, contro ~1 GB richiesto dal figlio.
// E' la prova di §5.2 p.71, e resta nel repo per quello. Le cause per mercato del referto del 23/08
// vengono percio' dal giornale di agent41 (`riconciliazione-fermo-1535.js`), cioe' dal piano CHE HA
// GIRATO DAVVERO in produzione — fonte migliore, ma limitata ai mercati visitati da `ripristino-gambe`.
// ⚠ NON RILANCIARLO a flotta accesa senza guardare `free -m`: un figlio da 1 GB su 400 MB liberi puo'
// far intervenire l'OOM killer su un processo di produzione.
// Replica ESATTAMENTE `pianoLeggero` del mini-ciclo di agent41: stessa finestra (6h), stesso
// horizonFilter, stessa restrizione alla selezione, stessa distanza di piano, e — punto che conta,
// §5.2 p.65 — girato con l'AMBIENTE DEL PROCESSO VIVO, non con quello della shell.
// Non piazza, non cancella, scrive solo in data/ricerca/.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '../..');
const OUT = path.join(ROOT, 'data/ricerca/fermo-per-causa-1520.json');
const PERCORSO_ALLOCATOR = path.join(ROOT, 'lib', 'rewards', 'allocator');
const BANDA_MODALE_CENTS = 4.5;

function envDiAgent41() {
  const jl = require('child_process').execSync('pm2 jlist', { maxBuffer: 64 * 1024 * 1024 }).toString();
  const proc = JSON.parse(jl).find((p) => p.name === 'agent41-realloc-scheduler');
  if (!proc || !proc.pid) throw new Error('agent41 non vivo');
  const raw = fs.readFileSync(`/proc/${proc.pid}/environ`, 'utf8');
  const env = {};
  for (const kv of raw.split('\0')) { const i = kv.indexOf('='); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1); }
  return { env, pid: proc.pid };
}

const RUNNER = 'let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{b+=d});process.stdin.on("end",()=>{try{const o=JSON.parse(b);const p=require('
  + JSON.stringify(PERCORSO_ALLOCATOR)
  + ').planFromCollection(o);'
  // si tiene SOLO ciò che serve: le curve dei fill sono megabyte e farebbero esplodere il buffer
  + 'const snellito={capital:p.capital,maxPerMarketUsd:p.maxPerMarketUsd,totalCapital:p.totalCapital,unallocated:p.unallocated,'
  + 'totalGrossPerDay:p.totalGrossPerDay,totalNetPerDay:p.totalNetPerDay,'
  + 'rows:(p.rows||[]).map(r=>({marketId:r.marketId,name:r.name,capital:r.capital,netPerDay:r.netPerDay,grossPerDay:r.grossPerDay,minSizeShares:r.minSizeShares})),'
  + 'candidates:(p.candidates||[]).map(c=>({marketId:c.marketId,name:c.name,status:c.status,reasonCode:c.reasonCode,reason:c.reason,capital:c.capital,netPerDay:c.netPerDay,grossPerDay:c.grossPerDay,minSizeShares:c.minSizeShares})),'
  + 'selezione:p.selezione,belowMinSize:p.belowMinSize,profonditaNonVerificata:p.profonditaNonVerificata};'
  + 'process.stdout.write(JSON.stringify(snellito))}catch(e){process.stderr.write(String(e&&e.stack||e));process.exit(3)}});';

(async () => {
  const { env, pid } = envDiAgent41();
  // la selezione ATTIVA, letta dallo stato su disco che agent41 ha appena scritto
  const sel = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/selezione-mercati.json'), 'utf8'));
  const voci = sel.selezionati || {};
  const tutti = Object.entries(voci).map(([id, v]) => ({ ...v, id: String(id).toLowerCase() }));
  const attivi = tutti.filter((v) => v.inGestione !== true).map((v) => v.id);
  const inGestione = tutti.filter((v) => v.inGestione === true).map((v) => v.id);

  // la distanza di piano, con lo stesso modulo di agent41
  let offsetCents = null;
  try {
    const d = require(path.join(ROOT, 'lib/maker/distanza-obiettivo')).distanzaObiettivoCents({ maxSpreadCents: BANDA_MODALE_CENTS });
    offsetCents = (d && Number.isFinite(d.distanzaC) && d.distanzaC > 0) ? d.distanzaC : null;
  } catch (_) { /* difetto */ }

  // il capitale che il mini-ciclo passa: min(saldo, cap) — si prende l'ultimo osservato
  const oss = fs.readFileSync(path.join(ROOT, 'data/osservatore/campioni-2026-08-23.jsonl'), 'utf8').trim().split('\n');
  const ultimo = JSON.parse(oss[oss.length - 1]);
  const limiti = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/safety-risk-limits.json'), 'utf8'));
  const capOpen = limiti.global.maxOpenNotionalUsd;
  const capitale = Math.min(ultimo.totalePortafoglioUsd, capOpen);
  const { capPerMarketUsd, MARKET_CAP_FIXED_USD } = require(path.join(ROOT, 'lib/rewards/concentration'));
  const maxPerMarketUsd = capPerMarketUsd(capitale);

  const to = new Date().toISOString();
  const from = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const opzioni = {
    capital: capitale, maxPerMarketUsd, from, to, horizonFilter: true, excludeMarketIds: null,
    onlyMarketIds: attivi.length ? attivi : ['0x' + '0'.repeat(64)],
    ...(offsetCents === null ? {} : { offsetTicks: null, offsetCents }),
  };

  const piano = await new Promise((res, rej) => {
    const f = execFile('node', ['--max-old-space-size=900', '--max-semi-space-size=2', '-e', RUNNER], { timeout: 180000, maxBuffer: 48 * 1024 * 1024, env },
      (err, so, se) => err ? rej(new Error(`code=${err.code} signal=${err.signal} killed=${err.killed} — ${(se || '').slice(-800)}`)) : res(JSON.parse(so)));
    f.stdin.end(JSON.stringify(opzioni));
  });

  // ── il conto per causa ────────────────────────────────────────────────────────────────────────
  const scelti = new Set((piano.rows || []).map((r) => String(r.marketId).toLowerCase()));
  const perCausa = {};
  const senzaRiga = [];
  for (const id of attivi) {
    if (scelti.has(id)) continue;
    const c = (piano.candidates || []).find((x) => String(x.marketId).toLowerCase() === id);
    const causa = c ? (c.reasonCode || c.status || 'ignoto') : 'assente-dal-registro';
    senzaRiga.push({ id, causa, reason: c ? c.reason : 'il mercato non compare fra i candidati valutati', netPerDay: c ? c.netPerDay : null, name: c ? c.name : null });
    if (!perCausa[causa]) perCausa[causa] = { causa, mercati: 0, capitaleRappresentatoUsd: 0, ids: [] };
    perCausa[causa].mercati++;
    perCausa[causa].capitaleRappresentatoUsd = +(perCausa[causa].capitaleRappresentatoUsd + MARKET_CAP_FIXED_USD).toFixed(2);
    perCausa[causa].ids.push(id);
  }

  const out = {
    atIso: to, pidAgent41: pid,
    ambiente: { MAKER_QUOTA_CODA_LUNGA: env.MAKER_QUOTA_CODA_LUNGA ?? null, MAKER_MERCATI_CONTEMPORANEI: env.MAKER_MERCATI_CONTEMPORANEI ?? null, MAKER_SLOT_CORTI: env.MAKER_SLOT_CORTI ?? null, MAKER_FILTRO_METEO: env.MAKER_FILTRO_METEO ?? '(assente ⇒ ARMATO)' },
    opzioni: { capital: capitale, maxPerMarketUsd, offsetCents, finestraOre: 6, onlyMarketIds: attivi.length },
    tettoPerMercatoUsd: MARKET_CAP_FIXED_USD,
    selezionatiAttivi: attivi.length, inGestione: inGestione.length,
    righeDiPiano: (piano.rows || []).length,
    capitaleAllocatoDalPianoUsd: piano.totalCapital,
    nonAllocatoDalPianoUsd: piano.unallocated,
    righe: (piano.rows || []).map((r) => ({ id: r.marketId, capital: r.capital, netPerDay: r.netPerDay, name: r.name })),
    selezionatiSenzaRigaDiPiano: senzaRiga,
    perCausa: Object.values(perCausa).sort((a, b) => b.mercati - a.mercati),
    universoValutato: (piano.candidates || []).length,
    istogrammaTutteLeCause: (piano.candidates || []).reduce((a, c) => { const k = c.status === 'scelto' ? 'scelto' : (c.reasonCode || 'ignoto'); a[k] = (a[k] || 0) + 1; return a; }, {}),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ ...out, righe: undefined, selezionatiSenzaRigaDiPiano: undefined }, null, 1));
  console.log('scritto:', OUT);
})().catch((e) => { console.error('ERRORE', e && e.stack); process.exit(1); });

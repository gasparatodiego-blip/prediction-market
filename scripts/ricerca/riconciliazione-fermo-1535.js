'use strict';
// SOLA LETTURA — riconciliazione: slot selezionati vs ordini a libro vs causa del fermo.
// La causa NON viene da un replay del piano (il figlio va in OOM su questa macchina, v. referto):
// viene dal giornale di agent41, cioè dal piano CHE HA GIRATO DAVVERO in produzione.
const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process');
const ROOT = path.join(__dirname, '../..');
const OUT = path.join(ROOT, 'data/ricerca/riconciliazione-fermo-1535.json');
const { MARKET_CAP_FIXED_USD } = require(path.join(ROOT, 'lib/rewards/concentration'));

const now = Date.now();
const sel = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/selezione-mercati.json'), 'utf8'));
const foto = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/ricerca/fotografia-capitale-1520.json'), 'utf8'));
const conOrdini = new Map(foto.perMercato.map((m) => [String(m.marketId).toLowerCase(), m]));

// ── il giornale: ultima causa dichiarata per mercato, finestra 2 h ────────────────────────────────
function codaGiornale(bytes) {
  const f = path.join(ROOT, 'data/realloc-scheduler.jsonl');
  const fd = fs.openSync(f, 'r'); const size = fs.fstatSync(fd).size;
  const start = Math.max(0, size - bytes); const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
  const s = buf.toString('utf8'); const i = s.indexOf('\n');
  return (i >= 0 ? s.slice(i + 1) : s).split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const G = codaGiornale(20 * 1024 * 1024);
const da = now - 2 * 3600_000;
const causaPerMercato = new Map();
const gatePerMercato = new Map();
for (const r of G) {
  if (r.tipo !== 'ripristino-gamba') continue;
  if (Date.parse(r.at) < da) continue;
  const m = String(r.marketId || '').toLowerCase(); if (!m) continue;
  const mo = String(r.motivo || '');
  const mm = mo.match(/non quotabile — ([a-z-]+):?(.*)$/);
  if (mm) causaPerMercato.set(m, { reasonCode: mm[1], dettaglio: mm[2].trim().slice(0, 150), at: r.at });
  if (r.gate) gatePerMercato.set(m, { gate: r.gate, at: r.at, motivo: mo.slice(0, 150) });
}

const righe = [];
for (const [id, v] of Object.entries(sel.selezionati || {})) {
  const k = id.toLowerCase();
  const o = conOrdini.get(k) || null;
  const c = causaPerMercato.get(k) || null;
  const g = gatePerMercato.get(k) || null;
  let causa, dettaglio;
  if (o && o.ordini >= 2) { causa = '(al lavoro)'; dettaglio = `${o.ordini} ordini, $${o.nozionaleUsd.toFixed(2)}`; }
  else if (o && o.ordini === 1) { causa = 'gamba-singola'; dettaglio = `1 ordine, $${o.nozionaleUsd.toFixed(2)}`; }
  else if (c) { causa = c.reasonCode; dettaglio = c.dettaglio; }
  else if (g) { causa = 'gate:' + g.gate; dettaglio = g.motivo; }
  else { causa = 'non-dichiarata'; dettaglio = 'nessun record di ripristino nelle ultime 2 h'; }
  righe.push({
    id: k, question: (v.question || '').slice(0, 62), scaglione: v.scaglione,
    inGestione: v.inGestione === true, uscenteDal: v.uscenteDal, motivoUscita: v.motivoUscita,
    ordini: o ? o.ordini : 0, nozionaleUsd: o ? o.nozionaleUsd : 0,
    causa, dettaglio,
  });
}

const attivi = righe.filter((r) => !r.inGestione);
const perCausa = {};
for (const r of attivi) {
  if (r.causa === '(al lavoro)') continue;
  const k = r.causa;
  if (!perCausa[k]) perCausa[k] = { causa: k, mercati: 0, capitaleFermoUsd: 0, ids: [], esempio: r.dettaglio };
  perCausa[k].mercati++;
  perCausa[k].capitaleFermoUsd = +(perCausa[k].capitaleFermoUsd + (MARKET_CAP_FIXED_USD - r.nozionaleUsd)).toFixed(2);
  perCausa[k].ids.push(r.id.slice(0, 12));
}

const N = Number(execSync("tr '\\0' '\\n' < /proc/$(pm2 jlist | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).find(p=>p.name==='agent41-realloc-scheduler').pid)})\")/environ | grep '^MAKER_MERCATI_CONTEMPORANEI=' | cut -d= -f2").toString().trim());
const limiti = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/safety-risk-limits.json'), 'utf8')).global;

// slot NON assegnati a nessun mercato: N meno i mercati che occupano uno slot (i non-in-gestione)
const slotVuoti = N - attivi.length;
const fermoDaSlotVuoti = +(slotVuoti * MARKET_CAP_FIXED_USD).toFixed(2);

const out = {
  atIso: new Date(now).toISOString(),
  parametriInServizio: { slotN: N, tettoPerMercatoUsd: MARKET_CAP_FIXED_USD, capEsposizioneUsd: limiti.maxOpenNotionalUsd },
  tetto: {
    formula: 'N × tetto ≤ cap/2',
    NxTettoUsd: +(N * MARKET_CAP_FIXED_USD).toFixed(2),
    capMezziUsd: +(limiti.maxOpenNotionalUsd / 2).toFixed(2),
    invarianteRispettata: N * MARKET_CAP_FIXED_USD <= limiti.maxOpenNotionalUsd / 2,
  },
  selezionati: righe.length, attivi: attivi.length, inGestione: righe.length - attivi.length,
  slotVuoti, fermoDaSlotVuotiUsd: fermoDaSlotVuoti,
  mercatiAlLavoro: attivi.filter((r) => r.causa === '(al lavoro)').length,
  nozionaleARiposoUsd: foto.nozionaleARiposoUsd,
  perCausa: Object.values(perCausa).sort((a, b) => b.capitaleFermoUsd - a.capitaleFermoUsd),
  fermoTotaleDichiaratoUsd: +(Object.values(perCausa).reduce((a, x) => a + x.capitaleFermoUsd, 0) + fermoDaSlotVuoti).toFixed(2),
  righe,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, righe: undefined }, null, 1));
console.log('\n── riga per riga ──');
for (const r of righe) console.log((r.inGestione ? '◐' : '●'), r.id.slice(0, 12), String(r.ordini).padStart(2), ('$' + r.nozionaleUsd.toFixed(2)).padStart(8), (r.scaglione || '').padEnd(6), r.causa.padEnd(22), r.dettaglio.slice(0, 70));
console.log('scritto:', OUT);

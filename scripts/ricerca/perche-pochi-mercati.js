'use strict';

/**
 * PERCHÉ SOLO ~8 MERCATI E NON 16 — sola lettura.
 *
 * ═══ LA DOMANDA SI SPOSTA, E VA DETTO SUBITO ═══════════════════════════════════════════════════
 * La domanda era «quali candidati ha scartato l'allocatore, e per quale causa». Quella domanda
 * **non è rispondibile dallo stato salvato**, ed è il difetto §5.2 p.10: `realloc-ultimo-piano.json`
 * persiste solo `at`, `capitale`, `boardAtMs`, `righe` — cioè **i vincitori**. I candidati scartati e
 * i loro `reasonCode` vivono in un processo figlio e non li scrive nessuno.
 *
 * **Ma il divario osservato non sta lì**: il piano contiene **16 righe**, cioè l'allocatore i mercati
 * li ha scelti. La perdita è **a valle**, fra «il piano dice 16» e «ne hanno ordini 8-9». E quella è
 * misurabile, perché ogni tentativo di piazzamento lascia una riga con il suo `gate`.
 *
 * Si filtra su `manual-place`, che porta sia gli invii riusciti sia i rifiuti col gate. È sufficiente:
 * nel giornale gli invii riusciti sono appaiati uno a uno con la conferma del venue.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const piano = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'realloc-ultimo-piano.json'), 'utf8'));
const F = path.join(ROOT, 'data', 'polymarket-maker-audit.jsonl');

const norm = (s) => { const x = String(s || '').replace(/^cid_/, '').toLowerCase(); return x.startsWith('0x') ? x : (x ? `0x${x}` : ''); };
const pianificati = new Map();
for (const r of piano.righe) {
  pianificati.set(norm(r.marketId), {
    nome: (r.name || '').slice(0, 26), capitale: r.capital, minSize: r.minSizeShares,
    inviati: 0, gate: {},
  });
}

// ⚠ `piano.at` È UNA STRINGA ISO, non un numero di millisecondi — e `j.ts` è un numero. Il confronto
// `j.ts >= piano.at` fra numero e stringa in JS non solleva niente: restituisce sempre `false`, e la
// prima stesura di questo script ha concluso «zero righe esaminate» su un giornale che ne conteneva
// 21.211. È la stessa famiglia di `Number(null) === 0`: un confronto che non fallisce, sbaglia e tace.
const DA = typeof piano.at === 'number' ? piano.at : Date.parse(piano.at);
if (!Number.isFinite(DA)) { console.error('istante del piano non leggibile: non si procede'); process.exit(1); }

const st = fs.statSync(F);
const off = Math.max(0, st.size - 140 * 1024 * 1024);
const fd = fs.openSync(F, 'r');
const buf = Buffer.alloc(st.size - off);
fs.readSync(fd, buf, 0, buf.length, off);
fs.closeSync(fd);

let righeViste = 0;
for (const l of buf.toString('utf8').split('\n')) {
  if (l.indexOf('manual-place') < 0) continue;
  let j; try { j = JSON.parse(l); } catch { continue; }
  if (j.op !== 'manual-place') continue;
  if (!(j.ts >= DA)) continue;
  const k = norm(j.marketRef);
  const e = pianificati.get(k);
  if (!e) continue;
  righeViste++;
  const o = String(j.outcome || '');
  if (o === 'sent') { e.inviati++; continue; }
  const g = j.gate || o.replace(/^reject-/, '') || 'ignoto';
  e.gate[g] = (e.gate[g] || 0) + 1;
}

// ── LA TABELLA PER MERCATO ───────────────────────────────────────────────────────────────────────
console.log(`# Il piano aveva ${pianificati.size} mercati — cosa ne è stato\n`);
console.log(`piano del ${new Date(piano.at).toISOString()} · capitale $${piano.capitale.toFixed(2)} · righe di giornale esaminate: ${righeViste}\n`);
console.log('| mercato | nome | $ piano | minSize | invii ok | gate dominante | n | altri |');
console.log('|---|---|---|---|---|---|---|---|');
const righe = [...pianificati.entries()].map(([m, e]) => {
  const g = Object.entries(e.gate).sort((a, b) => b[1] - a[1]);
  return { m, ...e, g };
}).sort((a, b) => b.inviati - a.inviati || (b.g[0] ? b.g[0][1] : 0) - (a.g[0] ? a.g[0][1] : 0));
for (const r of righe) {
  console.log(`| \`${r.m.slice(0, 10)}\` | ${r.nome} | $${(r.capitale || 0).toFixed(2)} | ${r.minSize ?? '—'} `
    + `| **${r.inviati}** | ${r.g[0] ? r.g[0][0] : '—'} | ${r.g[0] ? r.g[0][1] : 0} `
    + `| ${r.g.slice(1, 3).map((x) => `${x[0]}×${x[1]}`).join(' ')} |`);
}

// ── IL CONTEGGIO PER CAUSA, sui soli mercati SENZA invii ─────────────────────────────────────────
const mai = righe.filter((r) => r.inviati === 0);
const conOk = righe.filter((r) => r.inviati > 0);
console.log(`\n**${conOk.length} mercati su ${righe.length} hanno avuto almeno un invio riuscito. ${mai.length} mai.**\n`);

// Le famiglie che la domanda nomina, mappate sui gate reali osservati.
const FAMIGLIE = [
  ['capitale esaurito', /tetto-mercato|limit-max-open-notional|manual-order-cap|capitale|budget/i],
  ['reward contraddittorio (&limit / clobRewards)', /reward|clob-reward|premio|limit-contraddi/i],
  ['mai primo sul libro', /mai-primo|on-top|would-cross|inseguimento/i],
  ['profondità / motore', /profondita|motore-non-conforme|depth/i],
  ['regole del venue (banda, minSize)', /venue-rules|below-min|out-of-band|end-of-scale/i],
  ['idempotenza / duplicati', /idempot|duplicato/i],
  ['stato del bot / precondizioni', /live-min|manual-mode|market-unknown|rules-unreadable|kill/i],
];
const conteggio = new Map(FAMIGLIE.map(([n]) => [n, { mercati: 0, eventi: 0 }]));
const altro = { mercati: 0, eventi: 0, gate: {} };
for (const r of mai) {
  let assegnato = false;
  for (const [nome, re] of FAMIGLIE) {
    const n = Object.entries(r.gate).filter(([g]) => re.test(g)).reduce((s, x) => s + x[1], 0);
    if (n > 0) { const c = conteggio.get(nome); c.eventi += n; if (!assegnato) { c.mercati++; assegnato = true; } }
  }
  if (!assegnato) {
    altro.mercati++;
    for (const [g, n] of Object.entries(r.gate)) { altro.eventi += n; altro.gate[g] = (altro.gate[g] || 0) + n; }
  }
}
console.log('## Conteggio per causa, sui mercati che non hanno MAI piazzato\n');
console.log('| causa | mercati (causa dominante) | eventi di rifiuto |');
console.log('|---|---|---|');
for (const [n, c] of conteggio) if (c.eventi > 0) console.log(`| ${n} | ${c.mercati} | ${c.eventi} |`);
if (altro.mercati) console.log(`| **altro** | ${altro.mercati} | ${altro.eventi} — ${Object.keys(altro.gate).slice(0, 4).join(', ')} |`);

// ── I GATE GREZZI, senza classificazione: la verità prima dell'etichetta ─────────────────────────
const grezzi = {};
for (const r of righe) for (const [g, n] of Object.entries(r.gate)) grezzi[g] = (grezzi[g] || 0) + n;
console.log('\n## I gate osservati, senza classificazione\n');
for (const [g, n] of Object.entries(grezzi).sort((a, b) => b[1] - a[1])) console.log(`- \`${g}\` — ${n}`);

fs.writeFileSync(path.join(ROOT, 'data', 'ricerca', 'perche-pochi-mercati.json'),
  JSON.stringify({ generatoIso: new Date().toISOString(), pianoAt: piano.at, capitale: piano.capitale,
    pianificati: righe.length, conInvii: conOk.length, senzaInvii: mai.length,
    perMercato: righe.map((r) => ({ marketId: r.m, nome: r.nome, capitale: r.capitale, inviati: r.inviati, gate: r.gate })),
    gateGrezzi: grezzi }, null, 1));

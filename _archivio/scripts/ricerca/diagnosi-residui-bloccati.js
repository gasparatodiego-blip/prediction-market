'use strict';

/**
 * DIAGNOSI DEI RESIDUI BLOCCATI — SOLA LETTURA, nessun ordine, nessuna correzione.
 *
 * Compone in una tabella sola quattro fonti che oggi vanno lette a mano e separatamente:
 *   · lo snapshot delle posizioni al venue      → size, carico, prezzo corrente
 *   · il registro dei residui scoperti          → minSize del mercato, quanto manca, `pronto`
 *   · `mid-history` di agent34                  → bestBid/bestAsk, cioè il prezzo VERO di uscita
 *   · il giornale maker                         → quale gate ha rifiutato quel mercato, e quante volte
 *
 * ⚠ Il costo di uscita si calcola sul **bestBid**, non sul `curPrice` dello snapshot: uscire vuol dire
 * attraversare lo spread, e il mark di mezzo non è un prezzo a cui qualcuno compra. Dove il bid non è
 * leggibile il campo resta `null` e la riga lo dichiara: non si stima.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const D = (f) => path.join(ROOT, 'data', f);
const leggi = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ── 1 · POSIZIONI ────────────────────────────────────────────────────────────────────────────────
const snap = leggi(D('venue-positions-snapshot.json')) || leggi(D('maker-positions-snapshot.json'));
let posizioni = [];
if (snap && Array.isArray(snap.positions)) posizioni = snap.positions;
else {
  const { readVenuePositions } = require('../../lib/safety/venue-positions-snapshot');
  const p = readVenuePositions();
  posizioni = (p && p.positions) || [];
}

// ── 2 · REGISTRO RESIDUI ─────────────────────────────────────────────────────────────────────────
const reg = leggi(D('residui-scoperti.json'));
const residui = new Map();
for (const [k, v] of Object.entries((reg && reg.residui) || {})) {
  const [cid, lato] = k.split(':');
  residui.set(`${cid}:${lato}`, v);
  if (!residui.has(cid)) residui.set(cid, v);   // comodo per il join quando il lato non serve
}

// ── 3 · BESTBID / BESTASK dall'ultima riga di mid-history di oggi ───────────────────────────────
const oggi = new Date().toISOString().slice(0, 10);
const libri = new Map();
{
  const f = D(`mid-history-${oggi}.jsonl`);
  try {
    const st = fs.statSync(f);
    const off = Math.max(0, st.size - 8 * 1024 * 1024);
    const fd = fs.openSync(f, 'r');
    const b = Buffer.alloc(st.size - off);
    fs.readSync(fd, b, 0, b.length, off);
    fs.closeSync(fd);
    for (const l of b.toString('utf8').split('\n')) {
      if (l.indexOf('bestBid') < 0) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      const m = String(j.marketId || '');
      if (!m) continue;
      libri.set(m, { bestBid: j.bestBid, bestAsk: j.bestAsk, mid: j.adjMid, ts: Date.parse(j.ts),
        tokenIdYes: String(j.tokenIdYes || '') });
    }
  } catch { /* file assente: i bid restano null e le righe lo diranno */ }
}

// ── 4 · I GATE CHE HANNO RIFIUTATO, per mercato ─────────────────────────────────────────────────
const gatePerMercato = new Map();
{
  const f = D('polymarket-maker-audit.jsonl');
  try {
    const st = fs.statSync(f);
    const off = Math.max(0, st.size - 60 * 1024 * 1024);
    const fd = fs.openSync(f, 'r');
    const b = Buffer.alloc(st.size - off);
    fs.readSync(fd, b, 0, b.length, off);
    fs.closeSync(fd);
    for (const l of b.toString('utf8').split('\n')) {
      if (l.length < 40) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      const oc = String(j.outcome || '');
      const g = j.gate || (/reject-([a-z-]+)/.exec(oc) || [])[1] || (/^skip-([a-z-]+)/.exec(oc) || [])[1];
      if (!g) continue;
      const m = String(j.marketRef || '').replace(/^cid_/, '');
      if (!m) continue;
      if (!gatePerMercato.has(m)) gatePerMercato.set(m, new Map());
      const mm = gatePerMercato.get(m);
      mm.set(g, (mm.get(g) || 0) + 1);
    }
  } catch { /* niente giornale: la colonna resterà vuota */ }
}

// ── LA TABELLA ───────────────────────────────────────────────────────────────────────────────────
const CAUSE = {
  'remainder-below-min-size': 'residuo sotto il minimo',
  'manual-order-cap': 'tetto per ordine',
  'no-target': 'banda sotto il carico',
  'idempotent-duplicate': 'chiave idempotenza',
  'motore-non-conforme': 'motore (profondità/tetto)',
  'venue-rules': 'regole del venue',
};

const righe = [];
for (const p of posizioni) {
  const cid = String(p.conditionId || '');
  const size = Number(p.size);
  const carico = Number(p.avgPrice);
  const cur = Number(p.curPrice);
  const r = residui.get(cid) || null;
  const minSize = r && fin(Number(r.minSize)) ? Number(r.minSize) : null;
  const manca = r && fin(Number(r.manca)) ? Number(r.manca) : null;
  const libro = libri.get(cid) || null;
  // ⚠ `mid-history` PORTA IL LIBRO **YES**, e questa posizione può stare sul NO. Confrontare un carico
  // NO con un bid YES produce numeri senza senso — la prima stesura di questo script diceva che uscire
  // da Tel Aviv rendeva $21 di GUADAGNO, che è il segno opposto della realtà. Il lato si riconosce dal
  // `tokenId` della posizione contro il `tokenIdYes` del libro; sul NO il bid è `1 − askYes`, che è
  // l'identità del mercato binario. Lato non determinabile ⇒ bid `null`, e la riga lo dichiara.
  const tid = String(p.tokenId || '');
  const lato = libro && libro.tokenIdYes ? (tid === libro.tokenIdYes ? 'yes' : 'no') : null;
  let bid = null;
  if (libro && lato === 'yes' && fin(Number(libro.bestBid))) bid = Number(libro.bestBid);
  else if (libro && lato === 'no' && fin(Number(libro.bestAsk))) bid = +(1 - Number(libro.bestAsk)).toFixed(6);

  const gates = gatePerMercato.get(cid) || new Map();
  const ordinati = [...gates.entries()].sort((a, b) => b[1] - a[1]);
  const dominante = ordinati.length ? ordinati[0][0] : null;

  // Il blocco strutturale ha la precedenza su quello osservato: se la size è sotto il minimo del
  // venue, nessun ordine è costruibile e gli altri gate non arrivano nemmeno a esprimersi.
  const sottoMinimo = minSize !== null && size < minSize;
  const causa = sottoMinimo ? 'remainder-below-min-size' : dominante;

  righe.push({
    cid, titolo: (p.title || '').slice(0, 34), lato, size, carico, cur, minSize, manca,
    valoreUsd: fin(size) && fin(cur) ? +(size * cur).toFixed(2) : null,
    bestBid: bid,
    // Il costo di uscire ADESSO attraversando lo spread, contro il carico.
    costoUscitaUsd: bid !== null && fin(size) && fin(carico) ? +((carico - bid) * size).toFixed(2) : null,
    costoUscitaCent: bid !== null && fin(carico) ? +((carico - bid) * 100).toFixed(2) : null,
    causa, causaEtichetta: CAUSE[causa] || causa || '—',
    gateOsservati: ordinati.slice(0, 3).map(([g, n]) => `${g}×${n}`).join(' '),
  });
}
righe.sort((a, b) => (b.valoreUsd || 0) - (a.valoreUsd || 0));

const F = (v, n = 2) => (fin(v) ? v.toFixed(n) : '—');
console.log('\n## Posizioni aperte e causa del blocco\n');
console.log('| mercato | lato | share | min | manca | carico | bid | valore | uscita ¢/sh | uscita $ | blocco |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of righe) {
  console.log(`| \`${r.cid.slice(0, 10)}\` ${r.titolo.slice(0, 20)} | ${r.lato || '—'} | ${F(r.size)} | ${r.minSize ?? '—'} `
    + `| ${F(r.manca)} | ${F(r.carico, 3)} | ${F(r.bestBid, 3)} | $${F(r.valoreUsd)} `
    + `| ${F(r.costoUscitaCent)} | $${F(r.costoUscitaUsd)} | ${r.causaEtichetta} |`);
}

// ── I TOTALI PER CAUSA ──────────────────────────────────────────────────────────────────────────
const perCausa = new Map();
for (const r of righe) {
  const k = r.causaEtichetta;
  if (!perCausa.has(k)) perCausa.set(k, { n: 0, usd: 0, costo: 0, costoNoto: 0 });
  const c = perCausa.get(k);
  c.n++; c.usd += r.valoreUsd || 0;
  if (r.costoUscitaUsd !== null) { c.costo += r.costoUscitaUsd; c.costoNoto++; }
}
console.log('\n## Capitale immobilizzato per causa\n');
console.log('| causa | posizioni | capitale | costo di uscita (dove il bid è leggibile) |');
console.log('|---|---|---|---|');
for (const [k, c] of [...perCausa].sort((a, b) => b[1].usd - a[1].usd)) {
  console.log(`| ${k} | ${c.n} | $${c.usd.toFixed(2)} | $${c.costo.toFixed(2)} (${c.costoNoto}/${c.n} righe) |`);
}
const totV = righe.reduce((a, r) => a + (r.valoreUsd || 0), 0);
const totC = righe.reduce((a, r) => a + (r.costoUscitaUsd || 0), 0);
const senzaBid = righe.filter((r) => r.bestBid === null).length;
console.log(`\n**Totale: ${righe.length} posizioni per $${totV.toFixed(2)}. Costo di uscita a mercato: $${totC.toFixed(2)}**`
  + `${senzaBid ? ` — ⚠ ${senzaBid} righe senza bid leggibile, non incluse nel costo` : ''}`);

fs.writeFileSync(D('ricerca/residui-bloccati.json'),
  JSON.stringify({ generatoIso: new Date().toISOString(), righe, totaleValoreUsd: +totV.toFixed(2),
    totaleCostoUscitaUsd: +totC.toFixed(2), righeSenzaBid: senzaBid }, null, 1));

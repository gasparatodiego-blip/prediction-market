'use strict';
// scripts/ricerca/costo-dopo-il-fill-21-agosto.js — IL COSTO DI UN FILL MISURATO *DOPO* IL FILL.
// SOLA LETTURA.
//
// ⚠ PERCHE' NON BASTA IL BOOK DI ADESSO. «Se questa gamba si riempisse ora» calcolato sul book fermo
// dice +$1,13: e' vero e non serve a niente, perche' un bid due tick sotto il tocco si riempie
// SOLO quando il mercato scende attraverso due livelli — cioe' proprio quando la gamba sorella e'
// diventata piu' cara. Il numero che conta si misura sul book DOPO la stampa, non su quello di prima.
//
//   completare la coppia = comprare la sorella = camminare i BID del NOSTRO book dall'alto:
//   NO_ask(q) ≡ YES_bid(1−q), quindi costoCoppia = prezzoNostro + 1 − (bid medio camminato).
//   ⇒ dentro il tetto 101¢  ⟺  bidMedio ≥ prezzoNostro − 0,01.

const fs = require('fs'); const path = require('path');
const RADICE = path.resolve(__dirname, '..', '..');
const { fileRuntime, NOMI } = require(path.join(RADICE, 'lib', 'percorsi-runtime'));
const ORD = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'ricerca', 'ordini-vivi-21ago.json'), 'utf8'));
const BD = Object.fromEntries(JSON.parse(fs.readFileSync(fileRuntime(NOMI.boardNormalizzato), 'utf8')).markets.map((m) => [m.marketId, m]));
const IDS = [...new Set(ORD.ordini.map((o) => o.market))]; const SET = new Set(IDS);
const GIORNI = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 6;
const FINE = Date.parse(ORD.atIso), INIZIO = FINE - GIORNI * 24 * 3600 * 1000;
const DISTANZE = [0.63, 1.0, 1.5, 2.05, 2.50];
const SIZE = 56.5, TETTO = 1.01, MAX_ETA = 150_000;

function perRiga(file, fn) {
  if (!fs.existsSync(file)) return;
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(1 << 22); let resto = '';
  try { for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (n <= 0) break;
    const t = resto + buf.toString('utf8', 0, n); const r = t.split('\n'); resto = r.pop();
    for (const x of r) if (x) fn(x); } if (resto) fn(resto); } finally { fs.closeSync(fd); }
}
const H = new Map(IDS.map((i) => [i, []])), T = new Map(IDS.map((i) => [i, []]));
const FILES = fs.readdirSync(path.join(RADICE, 'data')).filter((f) => /^mid-history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(12, 22)).sort().slice(-(GIORNI + 1));
for (const g of FILES) {
  perRiga(path.join(RADICE, 'data', `mid-history-${g}.jsonl`), (l) => { let d; try { d = JSON.parse(l); } catch { return; }
    if (!SET.has(d.marketId)) return; const t = Date.parse(d.ts); if (t < INIZIO || t > FINE) return;
    H.get(d.marketId).push({ t, mid: d.adjMid, bb: d.bestBid, ba: d.bestAsk, tick: d.tick, levels: d.levels }); });
  perRiga(path.join(RADICE, 'data', `trade-tape-${g}.jsonl`), (l) => { let d; try { d = JSON.parse(l); } catch { return; }
    if (!SET.has(d.marketId)) return; const t = Number(d.tsVenueMs); if (t < INIZIO || t > FINE) return; T.get(d.marketId).push(d); });
}
for (const a of H.values()) a.sort((x, y) => x.t - y.t);
for (const a of T.values()) a.sort((x, y) => Number(x.tsVenueMs) - Number(y.tsVenueMs));
const prima = (a, t) => { let lo = 0, hi = a.length - 1, b = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].t <= t) { b = a[m]; lo = m + 1; } else hi = m - 1; } return b && t - b.t <= MAX_ETA ? b : null; };
const dopo  = (a, t) => { let lo = 0, hi = a.length - 1, b = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].t >= t) { b = a[m]; hi = m - 1; } else lo = m + 1; } return b && b.t - t <= MAX_ETA ? b : null; };
const gGiu = (p, k) => Math.floor(+(p / k).toFixed(9)) * k;
const gSu  = (p, k) => Math.ceil(+(p / k).toFixed(9)) * k;
/** Cammina una scala (già ordinata dal migliore) per `size`, restituisce il prezzo medio. */
function cammina(scala, size, campoP, campoS) {
  let resta = size, val = 0;
  for (const l of scala) { const p = Number(l[campoP]), s = Number(l[campoS]);
    if (!(p > 0) || !(s > 0)) continue; const q = Math.min(resta, s); val += q * p; resta -= q; if (resta <= 1e-9) return val / size; }
  return null;
}

const esiti = {};
for (const d of DISTANZE) esiti[d] = [];
for (const id of IDS) {
  const b = BD[id];
  for (const tr of T.get(id)) {
    const t = Number(tr.tsVenueMs);
    const pre = prima(H.get(id), t), post = dopo(H.get(id), t);
    if (!pre || !post) continue;
    const yes = String(tr.tokenId) === String(b.tokenId);
    const pYes = yes ? Number(tr.price) : +(1 - Number(tr.price)).toFixed(6);
    const lato = yes ? String(tr.side).toUpperCase() : (String(tr.side).toUpperCase() === 'BUY' ? 'SELL' : 'BUY');
    const tick = pre.tick, mid = pre.mid;
    for (const d of DISTANZE) {
      let bid = gGiu(mid - d / 100, tick), ask = gSu(mid + d / 100, tick);
      if (Number.isFinite(pre.bb)) bid = Math.min(bid, +(pre.bb - tick).toFixed(9));
      if (Number.isFinite(pre.ba)) ask = Math.max(ask, +(pre.ba + tick).toFixed(9));
      let nostro = null, completa = null;
      const liv = Array.isArray(post.levels) ? post.levels : [];
      if (lato === 'SELL' && pYes <= bid + 1e-9) {
        nostro = bid;
        // gamba YES comprata: si completa comprando NO ⇒ si cammina i BID YES del book DOPO
        const m = cammina(liv.filter((l) => Number.isFinite(l.bidPrice) && l.bidPrice > 0), SIZE, 'bidPrice', 'bidSizeAtLevel');
        completa = m == null ? null : nostro + 1 - m;
      } else if (lato === 'BUY' && pYes >= ask - 1e-9) {
        nostro = 1 - ask;   // gamba NO comprata a (1−ask)
        const m = cammina(liv.filter((l) => Number.isFinite(l.askPrice) && l.askPrice > 0), SIZE, 'askPrice', 'askSizeAtLevel');
        completa = m == null ? null : nostro + m;   // costo coppia = NO + YES
      }
      if (nostro == null) continue;
      esiti[d].push({ id: id.slice(0, 12), t, coppia: completa, entroTetto: completa != null ? completa <= TETTO : null,
        pnlUsd: completa != null ? +((1 - completa) * SIZE).toFixed(2) : null,
        midPrima: mid, midDopo: post.mid, mossaC: +((post.mid - mid) * 100).toFixed(2) });
    }
  }
}
fs.writeFileSync(path.join(RADICE, 'data', 'ricerca', 'costo-dopo-il-fill-21-agosto.json'), JSON.stringify({ giorni: GIORNI, esiti }, null, 1));
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
console.log(`finestra ${GIORNI} giorni · tetto coppia ${TETTO * 100}¢ · size ${SIZE} share\n`);
console.log(' dist   eventi  coppia<=101¢   coppia p50   coppia p90   PnL p50    PnL p10   PnL totale');
for (const d of DISTANZE) {
  const e = esiti[d].filter((x) => x.coppia != null);
  if (!e.length) { console.log(`  ${String(d).padStart(4)}¢        0            —            —            —         —          —          —`); continue; }
  const cp = e.map((x) => x.coppia * 100), pn = e.map((x) => x.pnlUsd);
  const dentro = e.filter((x) => x.entroTetto).length;
  console.log(`  ${String(d).padStart(4)}¢  ${String(e.length).padStart(6)}  ${String(dentro + '/' + e.length).padStart(12)}  ${q(cp, .5).toFixed(2).padStart(10)}¢  ${q(cp, .9).toFixed(2).padStart(10)}¢  ${('$' + q(pn, .5).toFixed(2)).padStart(9)}  ${('$' + q(pn, .1).toFixed(2)).padStart(8)}  ${('$' + pn.reduce((a, x) => a + x, 0).toFixed(2)).padStart(9)}`);
}

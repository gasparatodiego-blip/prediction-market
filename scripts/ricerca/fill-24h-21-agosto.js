'use strict';
// scripts/ricerca/fill-24h-21-agosto.js — IL PREZZO DEL RISCHIO: quante volte saremmo stati riempiti.
// SOLA LETTURA. Nessuna probabilita' inventata: si contano EVENTI VERI del tape contro la
// PROFONDITA' VERA del book allo stesso istante.
//
// ⚠ COSA E' MISURATO E COSA NO, dichiarato prima dei numeri:
//   · MISURATO: ogni stampa del tape nelle 24 h sui 4 mercati, portata nello spazio YES, confrontata
//     col prezzo che il motore avrebbe tenuto a quella distanza dal mid di QUELL'ISTANTE, e con la
//     profondita' davanti letta dal book di quell'istante (mid-history, fino a 45 livelli per lato).
//   · NON MISURABILE DA QUI: la nostra POSIZIONE DENTRO il livello. Il book pubblico non dice chi c'e'
//     davanti dentro lo stesso prezzo. Quindi si danno DUE conteggi: `raggiunto` (il livello e' stato
//     toccato: condizione NECESSARIA) e `sfondato` (la stampa era piu' grande di tutta la profondita'
//     davanti: condizione SUFFICIENTE). Il vero sta in mezzo, e non si sceglie un punto a caso.
//   · IL FEED CAMPIONA OGNI ~75 s: un book che si muove e torna fra due campioni non si vede. I
//     numeri sono un LIMITE INFERIORE.

const fs = require('fs'); const path = require('path');
const RADICE = path.resolve(__dirname, '..', '..');
const { fileRuntime, NOMI } = require(path.join(RADICE, 'lib', 'percorsi-runtime'));

const ORD = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'ricerca', 'ordini-vivi-21ago.json'), 'utf8'));
const BD = Object.fromEntries(JSON.parse(fs.readFileSync(fileRuntime(NOMI.boardNormalizzato), 'utf8')).markets.map((m) => [m.marketId, m]));
const IDS = [...new Set(ORD.ordini.map((o) => o.market))];
const FINE = Date.parse(ORD.atIso);
const GIORNI = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 1;
const INIZIO = FINE - GIORNI * 24 * 3600 * 1000;
const DISTANZE = [0.05,0.10,0.15,0.20,0.25,0.30,0.40,0.50,0.63,0.75,1.0,1.25,1.5,2.05,2.50];
const NOSTRA_SIZE = 56.5;

// ── LE FONTI ────────────────────────────────────────────────────────────────────────────────────
const storia = new Map(IDS.map((i) => [i, []]));
const tape = new Map(IDS.map((i) => [i, []]));
const setIds = new Set(IDS);
const FILES = fs.readdirSync(path.join(RADICE, 'data'))
  .filter((f) => /^mid-history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
  .map((f) => f.slice(12, 22)).sort().slice(-(GIORNI + 1));

// ⚠ NON `readFileSync(...,'utf8')`: `mid-history-2026-08-20.jsonl` da solo pesa 296 MB e V8 si ferma
// a ~512 MB per stringa (§4.10). Si legge a blocchi, riga per riga, e non si materializza mai il file.
function perRiga(file, fn) {
  if (!fs.existsSync(file)) return;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 22);
  let resto = '';
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const testo = resto + buf.toString('utf8', 0, n);
      const righe = testo.split('\n');
      resto = righe.pop();
      for (const r of righe) if (r) fn(r);
    }
    if (resto) fn(resto);
  } finally { fs.closeSync(fd); }
}
for (const g of FILES) {
  perRiga(path.join(RADICE, 'data', `mid-history-${g}.jsonl`), (line) => {
    let d; try { d = JSON.parse(line); } catch { return; }
    if (!setIds.has(d.marketId)) return;
    const t = Date.parse(d.ts);
    if (!(t >= INIZIO && t <= FINE)) return;
    storia.get(d.marketId).push({ t, mid: d.adjMid, bestBid: d.bestBid, bestAsk: d.bestAsk, tick: d.tick, levels: d.levels });
  });
  perRiga(path.join(RADICE, 'data', `trade-tape-${g}.jsonl`), (line) => {
    let d; try { d = JSON.parse(line); } catch { return; }
    if (!setIds.has(d.marketId)) return;
    const t = Number(d.tsVenueMs);
    if (!(t >= INIZIO && t <= FINE)) return;
    tape.get(d.marketId).push(d);
  });
}
for (const a of storia.values()) a.sort((x, y) => x.t - y.t);
for (const a of tape.values()) a.sort((x, y) => Number(x.tsVenueMs) - Number(y.tsVenueMs));

const MAX_ETA_MS = 150_000;   // due campioni del feed: oltre, non si giudica
function rowAt(arr, t) {
  let lo = 0, hi = arr.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { best = arr[m]; lo = m + 1; } else hi = m - 1; }
  return best && t - best.t <= MAX_ETA_MS ? best : null;
}
const gridGiu = (p, tick) => Math.floor(+(p / tick).toFixed(9)) * tick;
const gridSu  = (p, tick) => Math.ceil(+(p / tick).toFixed(9)) * tick;

const risultato = [];
for (const id of IDS) {
  const b = BD[id];
  const H = storia.get(id), T = tape.get(id);
  const perDistanza = {};
  let nonGiudicabili = 0;
  for (const d of DISTANZE) perDistanza[d] = { raggiunto: 0, sfondato: 0, volumeRaggiuntoShares: 0, prezziNostri: new Set() };

  for (const tr of T) {
    const t = Number(tr.tsVenueMs);
    const row = rowAt(H, t);
    if (!row || !Number.isFinite(row.mid) || !Number.isFinite(row.tick)) { nonGiudicabili++; continue; }
    const yes = String(tr.tokenId) === String(b.tokenId);
    const pYes = yes ? Number(tr.price) : +(1 - Number(tr.price)).toFixed(6);
    const lato = yes ? String(tr.side).toUpperCase() : (String(tr.side).toUpperCase() === 'BUY' ? 'SELL' : 'BUY');
    const size = Number(tr.size);
    const tick = row.tick, mid = row.mid;
    const liv = Array.isArray(row.levels) ? row.levels : [];

    for (const d of DISTANZE) {
      // Il prezzo che il motore avrebbe tenuto: obiettivo arrotondato ALLONTANANDOSI dal mid,
      // poi il paletto «mai primo sul libro» (un tick dietro il migliore).
      let bid = gridGiu(mid - d / 100, tick);
      let ask = gridSu(mid + d / 100, tick);
      if (Number.isFinite(row.bestBid)) bid = Math.min(bid, +(row.bestBid - tick).toFixed(9));
      if (Number.isFinite(row.bestAsk)) ask = Math.max(ask, +(row.bestAsk + tick).toFixed(9));
      const R = perDistanza[d];
      let nostro = null, davanti = null;
      if (lato === 'SELL' && pYes <= bid + 1e-9) {          // un taker che VENDE scende sui bid
        nostro = bid;
        davanti = liv.reduce((a, l) => (Number.isFinite(l.bidPrice) && l.bidPrice > bid + 1e-9 ? a + (Number(l.bidSizeAtLevel) || 0) : a), 0);
      } else if (lato === 'BUY' && pYes >= ask - 1e-9) {    // un taker che COMPRA sale sugli ask
        nostro = ask;
        davanti = liv.reduce((a, l) => (Number.isFinite(l.askPrice) && l.askPrice < ask - 1e-9 ? a + (Number(l.askSizeAtLevel) || 0) : a), 0);
      }
      if (nostro == null) continue;
      R.raggiunto++; R.volumeRaggiuntoShares += size; R.prezziNostri.add(+nostro.toFixed(4));
      if (size > davanti) R.sfondato++;
    }
  }
  risultato.push({ id, titolo: b.title, tick: Number(b.tickSize),
    campioniBook: H.length, stampeTape: T.length, nonGiudicabili,
    perDistanza: Object.fromEntries(DISTANZE.map((d) => [d, {
      raggiunto: perDistanza[d].raggiunto, sfondato: perDistanza[d].sfondato,
      volumeRaggiuntoShares: +perDistanza[d].volumeRaggiuntoShares.toFixed(1),
      prezziNostri: [...perDistanza[d].prezziNostri].sort((a, x) => a - x) }])) });
}

const tot = { stampe: 0, campioni: 0, nonGiudicabili: 0 };
for (const r of risultato) { tot.stampe += r.stampeTape; tot.campioni += r.campioniBook; tot.nonGiudicabili += r.nonGiudicabili; }
const perDistanzaTot = {};
for (const d of DISTANZE) {
  const ragg = risultato.reduce((a, r) => a + r.perDistanza[d].raggiunto, 0);
  const sfon = risultato.reduce((a, r) => a + r.perDistanza[d].sfondato, 0);
  perDistanzaTot[d] = { raggiunto: ragg, sfondato: sfon,
    // 8 gambe vive; un evento «raggiunto» riguarda UNA gamba di UN mercato.
    fillGiornoMinimo: sfon, fillGiornoMassimo: ragg };
}

const out = { finestra: { da: new Date(INIZIO).toISOString(), a: new Date(FINE).toISOString() },
  totali: tot, perDistanzaTot, mercati: risultato };
fs.writeFileSync(path.join(RADICE, 'data', 'ricerca', 'fill-24h-21-agosto.json'), JSON.stringify(out, null, 1));

console.log(`finestra ${out.finestra.da} → ${out.finestra.a}`);
console.log(`stampe di tape: ${tot.stampe} · campioni di book: ${tot.campioni} · stampe non giudicabili (nessun book entro 150 s): ${tot.nonGiudicabili}`);
console.log('\n dist   raggiunto  sfondato    (raggiunto = condizione NECESSARIA · sfondato = SUFFICIENTE)');
for (const d of DISTANZE) {
  const p = perDistanzaTot[d];
  console.log(`  ${String(d).padStart(4)}¢  ${String(p.raggiunto).padStart(8)}  ${String(p.sfondato).padStart(8)}`);
}
console.log('\nper mercato:');
for (const r of risultato) {
  console.log(` ${r.titolo.slice(0, 44).padEnd(46)} tick ${r.tick} · ${r.stampeTape} stampe · ${r.campioniBook} campioni · ${r.nonGiudicabili} non giudicabili`);
  for (const d of DISTANZE) {
    const p = r.perDistanza[d];
    console.log(`    ${String(d).padStart(4)}¢ raggiunto ${String(p.raggiunto).padStart(3)} · sfondato ${String(p.sfondato).padStart(3)} · volume ${String(p.volumeRaggiuntoShares).padStart(9)} share`);
  }
}

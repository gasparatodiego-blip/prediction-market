'use strict';
// scripts/misura-volatilita-per-fascia.js — I MERCATI A MID ESTREMO SI MUOVONO DAVVERO DI PIÙ?
//
// SOLA LETTURA. Legge `data/mid-history-<giorno>.jsonl`, il giornale che agent34 scrive dal websocket
// pubblico del CLOB (una riga per mercato ogni ~75 s). Non tocca il venue e non scrive niente.
//
// ═══ LA DOMANDA, E PERCHÉ HA DUE RISPOSTE ════════════════════════════════════════════════════════
// L'ipotesi dietro un filtro sullo squilibrio è «i mercati a mid estremo sono più mossi». Ma «più
// mosso» ha due misure che su un mercato binario divergono, e usarne una sola è il modo di ottenere
// la risposta che si voleva:
//
//   · ASSOLUTA, in punti di probabilità (¢). È quella che conta per il RISCHIO VERO: la banda
//     premiante è ±2,25¢ **in assoluto**, quindi è un movimento in centesimi che porta il mid fuori
//     banda e spazza una gamba. Un mercato a 0,05 che va a 0,06 si è mosso di 1¢: la banda non se ne
//     accorge quasi.
//   · RELATIVA, in % del mid. È quella che la domanda usa per istinto. Lo stesso 0,05 → 0,06 è
//     +20%, e per costruzione la percentuale ESPLODE vicino a zero anche quando il movimento in
//     centesimi è minuscolo. È una misura che favorisce la conclusione «gli estremi si muovono di
//     più» quasi indipendentemente dai dati.
//
// Si riportano ENTRAMBE, e si dice quale decide.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const GIORNO = process.env.GIORNO || '2026-08-12';
const FILE = path.join(__dirname, '..', 'data', `mid-history-${GIORNO}.jsonl`);
const MIN_CAMPIONI = 10;   // sotto questo un mercato non ha una serie: si dichiara, non si stima

const FASCE = [
  ['0,02–0,10', 0.02, 0.10],
  ['0,10–0,25', 0.10, 0.25],
  ['0,25–0,35', 0.25, 0.35],
  ['0,35–0,65', 0.35, 0.65],
  ['0,65–0,75', 0.65, 0.75],
  ['0,75–0,90', 0.75, 0.90],
  ['0,90–0,98', 0.90, 0.98],
];

function mediana(v) {
  if (!v.length) return null;
  const s = v.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  if (!fs.existsSync(FILE)) { console.log('file assente:', FILE); return; }
  const per = new Map();   // marketId → { mids: [] }
  const rl = readline.createInterface({ input: fs.createReadStream(FILE) });
  for await (const l of rl) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const mid = o.adjMid ?? o.plainMid;
    if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) continue;
    let e = per.get(o.marketId);
    if (!e) { e = { mids: [] }; per.set(o.marketId, e); }
    e.mids.push(mid);
  }

  // Per ogni mercato: mid tipico, e le due misure di movimento fra campioni CONSECUTIVI.
  const mercati = [];
  let scartati = 0;
  for (const [id, e] of per) {
    if (e.mids.length < MIN_CAMPIONI) { scartati += 1; continue; }
    const midTipico = mediana(e.mids);
    // ⚠ LA MEDIANA DI |Δ| FRA CAMPIONI CONSECUTIVI È ZERO IN OGNI FASCIA, e non è un difetto dei dati:
    // fra due campioni a 75 s il mid della maggior parte dei mercati non cambia affatto. Una statistica
    // schiacciata dalla massa a zero non distingue niente. Servono misure che sopravvivano:
    //   · la MEDIA di |Δ| (la massa a zero la abbassa, ma non la annulla);
    //   · il p90 di |Δ| (quanto si muove nei momenti in cui si muove);
    //   · la FRAZIONE di passi oltre mezza banda (2,25¢) — la domanda operativa vera;
    //   · l'ESCURSIONE della giornata (max − min), che misura quanto il mercato ha girato in tutto.
    const dAss = [], dRel = [];
    for (let i = 1; i < e.mids.length; i++) {
      const a = e.mids[i - 1], b = e.mids[i];
      const rif = Math.min(a, 1 - a);          // la distanza dal bordo più vicino: il lato "sottile"
      dAss.push(Math.abs(b - a) * 100);        // in centesimi di probabilità
      if (rif > 0) dRel.push((Math.abs(b - a) / rif) * 100);   // in % del lato sottile
    }
    const media = (v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);
    const p90 = (v) => (v.length ? v.slice().sort((x, y) => x - y)[Math.floor((v.length - 1) * 0.9)] : 0);
    const range = (Math.max(...e.mids) - Math.min(...e.mids)) * 100;
    const oltreMezzaBanda = dAss.length ? dAss.filter((x) => x >= 2.25).length / dAss.length : 0;
    mercati.push({
      id, midTipico, n: e.mids.length, range,
      assMed: media(dAss), assP90: p90(dAss), relMed: media(dRel),
      salti: oltreMezzaBanda * 100,
    });
  }

  console.log('giornale:', path.basename(FILE));
  console.log('mercati con almeno', MIN_CAMPIONI, 'campioni:', mercati.length, '· scartati per serie troppo corta:', scartati);
  console.log('');
  console.log('fascia di mid | mercati | |Δ| medio ¢ | |Δ| p90 ¢ | passi oltre 2,25¢ | escursione ¢ (med/p90) | relativo %');
  for (const [nome, lo, hi] of FASCE) {
    const g = mercati.filter((m) => m.midTipico >= lo && m.midTipico < hi);
    if (!g.length) { console.log(`${nome.padEnd(13)} |       0 | — | — | — | — | —`); continue; }
    const c = (k) => mediana(g.map((x) => x[k]));
    const rngP90 = g.map((x) => x.range).sort((a, b) => a - b)[Math.floor((g.length - 1) * 0.9)];
    console.log(`${nome.padEnd(13)} | ${String(g.length).padStart(7)} | ${String(c('assMed').toFixed(3)).padStart(10)} | ${String(c('assP90').toFixed(2)).padStart(9)} | ${String(c('salti').toFixed(2) + '%').padStart(17)} | ${String(c('range').toFixed(2)).padStart(10)} / ${String(rngP90.toFixed(1)).padStart(6)} | ${c('relMed').toFixed(2)}`);
  }

  // Il confronto che la decisione chiede: estremi contro centro.
  console.log('');
  const centro = mercati.filter((m) => m.midTipico >= 0.35 && m.midTipico <= 0.65);
  const estremi = mercati.filter((m) => m.midTipico < 0.25 || m.midTipico > 0.75);
  const f = (g, k) => (g.length ? mediana(g.map((x) => x[k])) : null);
  console.log('══ IL CONFRONTO CHE DECIDE');
  for (const [nome, g] of [['CENTRO  [0,35 · 0,65]', centro], ['ESTREMI  <0,25 o >0,75', estremi]]) {
    console.log(`  ${nome.padEnd(24)}: ${String(g.length).padStart(3)} mercati · |Δ| medio ${f(g, 'assMed').toFixed(3)}¢ · p90 ${f(g, 'assP90').toFixed(2)}¢`
      + ` · passi oltre mezza banda ${f(g, 'salti').toFixed(2)}% · escursione ${f(g, 'range').toFixed(2)}¢ · relativo ${f(g, 'relMed').toFixed(2)}%`);
  }
  const rap = (k) => f(estremi, k) / f(centro, k);
  console.log('');
  console.log(`  rapporto ESTREMI/CENTRO — |Δ| medio ${rap('assMed').toFixed(2)}× · p90 ${rap('assP90').toFixed(2)}×`
    + ` · salti ${f(centro, 'salti') > 0 ? rap('salti').toFixed(2) + '×' : 'n/d (centro a 0)'} · escursione ${rap('range').toFixed(2)}× · relativo ${rap('relMed').toFixed(2)}×`);
  console.log('');
  console.log('  Il rischio che il filtro dovrebbe coprire è che il mid esca dalla BANDA, che è ±2,25¢');
  console.log('  in ASSOLUTO. Quindi decide la colonna assoluta; la relativa è riportata perché la');
  console.log('  domanda la usa, ma per costruzione cresce vicino ai bordi anche a movimento nullo.');
}

if (require.main === module) main();

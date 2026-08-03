#!/usr/bin/env node
'use strict';
// scripts/realloc-decay.js — QUANTO VALE ANCORA, FRA SEI ORE, UN PIANO DECISO ADESSO?
//
// ═══ LA DOMANDA ══════════════════════════════════════════════════════════════════════════════════════
// La dashboard mostra già una «frontiera» sull'asse del NUMERO DI MERCATI: quanto rende un piano da 1, 2,
// 3, … mercati. Questa è la stessa domanda sull'asse del TEMPO: un piano deciso all'istante t e lasciato
// fermo, quanto rende all'istante t+Δ rispetto a un piano rifatto in quel momento? La differenza è il
// prezzo di NON riallocare, ed è il numero che decide l'intervallo del riallocatore periodico.
//
// ═══ IL MODELLO, E I SUOI LIMITI, DETTI PRIMA DEI RISULTATI ═════════════════════════════════════════
// La sorgente è data/history/rewards-poly/*.json: fotografie della board reward prese ogni ~42 minuti,
// 29 giorni. Ogni riga porta `levels['500'].netRewardDay`, cioè la stima di reward netto giornaliero per
// $500 su quel mercato — la stessa famiglia di stima che il pannello mostra. Da lì il tasso per dollaro
// r_i = netRewardDay(500) / 500.
//
// Il piano è modellato come lo fa l'allocatore SOTTO IL TETTO DI CONCENTRAZIONE: prendi i mercati con il
// tasso più alto e mettici il massimo consentito (30% del capitale) finché il capitale finisce. Con un
// tetto al 30% sono 3 mercati pieni più un quarto al 10%.
//
// Cosa questo modello NON riproduce, e va tenuto presente leggendo i numeri:
//   · il knapsack vero usa il fill-score strutturale e il tape, non solo il tasso di board;
//   · il reward vero è quadratico rispetto alla liquidità concorrente, qui è lineare nella size;
//   · un mercato ASSENTE da una fotografia non è per forza risolto: la board ne scansiona ~118 e la
//     composizione ruota. L'assenza qui vale come «non allocabile in quel momento», che è la cosa giusta
//     per misurare il decadimento di un piano, ma NON è una misura di risoluzione.
// Il modello sopravvaluta se mai la stabilità (meno mercati, più concentrati, meno rotazione), quindi il
// decadimento misurato è semmai un limite INFERIORE.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'history', 'rewards-poly');
const CAP_FRAC = 0.30;           // lo stesso tetto di concentrazione del riallocatore
const LIVELLO = '500';           // il livello di capitale su cui è calcolato netRewardDay
// Δ = 0.65h è UNA sola fotografia più in là: il mondo non è cambiato, e quel che si misura lì è quasi
// tutto rumore dello stimatore — il piano rifatto è per costruzione il massimo di quell'istante, quindi
// un po' di vantaggio ce l'ha sempre, anche a decadimento zero. È il pavimento su cui leggere il resto.
const DELTAS_H = [0.65, 1, 3, 6, 12, 24, 48];
const TOLLERANZA_MS = 25 * 60_000;   // una fotografia ogni ~42 min: ±25 min trova sempre la più vicina
const ORIZZONTE_MIN_H = 24;      // stesso filtro orizzonte del piano «auto»
const CROLLO = 0.5;              // stessa soglia di «premio-crollato»

function caricaFotografie() {
  const file = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const out = [];
  for (const f of file) {
    let giorno;
    try { giorno = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    for (const s of giorno) {
      if (!s || !Array.isArray(s.rows) || !s.t) continue;
      out.push({ t: s.t, iso: s.iso, rows: s.rows });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** I mercati allocabili in una fotografia, col loro tasso per dollaro. */
function allocabili(snap) {
  const m = new Map();
  for (const r of snap.rows) {
    if (!r || !r.id) continue;
    const lv = r.levels && r.levels[LIVELLO];
    const net = lv && Number(lv.netRewardDay);
    if (!Number.isFinite(net) || net <= 0) continue;
    if (!Number.isFinite(Number(r.dailyPool)) || Number(r.dailyPool) <= 0) continue;
    if (!Number.isFinite(Number(r.maxSpread)) || Number(r.maxSpread) <= 0) continue;
    const fine = r.endDate ? Date.parse(r.endDate) : NaN;
    if (Number.isFinite(fine) && (fine - snap.t) / 3_600_000 < ORIZZONTE_MIN_H) continue;   // filtro orizzonte
    m.set(r.id, { r: net / Number(LIVELLO), pot: Number(r.dailyPool), titolo: r.title });
  }
  return m;
}

/** Il piano: i pesi (frazioni di capitale) sotto il tetto di concentrazione. Capitale = 1. */
function piano(mappa) {
  const ord = [...mappa.entries()].sort((a, b) => b[1].r - a[1].r);
  const pesi = [];
  let resto = 1;
  for (const [id, v] of ord) {
    if (resto <= 1e-9) break;
    const w = Math.min(CAP_FRAC, resto);
    pesi.push({ id, w, r: v.r, pot: v.pot, titolo: v.titolo });
    resto -= w;
  }
  return pesi;
}

const valore = (pesi, mappa) => pesi.reduce((s, p) => s + p.w * (mappa.has(p.id) ? mappa.get(p.id).r : 0), 0);
const mediana = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');

function main() {
  const snaps = caricaFotografie();
  if (snaps.length < 10) { console.error('storico insufficiente'); process.exit(1); }
  console.log(`\nFOTOGRAFIE: ${snaps.length} dal ${new Date(snaps[0].t).toISOString().slice(0, 16)} al ${new Date(snaps[snaps.length - 1].t).toISOString().slice(0, 16)}`);
  const cadenze = [];
  for (let i = 1; i < snaps.length; i++) cadenze.push((snaps[i].t - snaps[i - 1].t) / 60_000);
  console.log(`CADENZA mediana: ${mediana(cadenze).toFixed(1)} minuti\n`);

  // Indice per ricerca del vicino temporale.
  const trova = (t) => {
    let lo = 0, hi = snaps.length - 1, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (best == null || Math.abs(snaps[mid].t - t) < Math.abs(snaps[best].t - t)) best = mid;
      if (snaps[mid].t < t) lo = mid + 1; else hi = mid - 1;
    }
    return best != null && Math.abs(snaps[best].t - t) <= TOLLERANZA_MS ? snaps[best] : null;
  };

  const righe = [];
  for (const dH of DELTAS_H) {
    const relativo = [], assoluto = [], sopravvissuti = [], scattato = [], perditaAssolutaUsd = [];
    const relSeScatta = [], relSeNonScatta = [];
    let coppie = 0;

    for (const s0 of snaps) {
      const m0 = allocabili(s0);
      if (m0.size < 4) continue;
      const p0 = piano(m0);
      const v0 = valore(p0, m0);
      if (!(v0 > 0)) continue;

      const s1 = trova(s0.t + dH * 3_600_000);
      if (!s1) continue;
      const m1 = allocabili(s1);
      if (m1.size < 4) continue;
      coppie++;

      const congelato = valore(p0, m1);          // il piano vecchio, valutato col mondo nuovo
      const rifatto = valore(piano(m1), m1);     // il piano che si sarebbe fatto in quel momento
      relativo.push(rifatto > 0 ? congelato / rifatto : 0);
      assoluto.push(congelato / v0);
      sopravvissuti.push(p0.filter((p) => m1.has(p.id)).length / p0.length);
      // La regola del riallocatore: scatta se anche UN mercato del piano è sparito o ha il montepremi
      // sotto metà di quello su cui il piano era stato deciso.
      const scatta = p0.some((p) => !m1.has(p.id) || m1.get(p.id).pot < p.pot * CROLLO);
      scattato.push(scatta ? 1 : 0);
      (scatta ? relSeScatta : relSeNonScatta).push(rifatto > 0 ? congelato / rifatto : 0);
      // In dollari al giorno, sul capitale reale di oggi.
      perditaAssolutaUsd.push((rifatto - congelato) * 665);
    }

    righe.push({
      dH, coppie,
      relMed: mediana(relativo), relMedio: relativo.reduce((a, b) => a + b, 0) / relativo.length,
      assMed: mediana(assoluto),
      sopr: sopravvissuti.reduce((a, b) => a + b, 0) / sopravvissuti.length,
      scatti: scattato.reduce((a, b) => a + b, 0) / scattato.length,
      persiMed: mediana(perditaAssolutaUsd),
      peggiore: [...relativo].sort((a, b) => a - b)[Math.floor(relativo.length * 0.1)] ?? null,
      relSeScatta: mediana(relSeScatta), nScatta: relSeScatta.length,
      relSeNonScatta: mediana(relSeNonScatta), nNonScatta: relSeNonScatta.length,
    });
  }

  console.log('QUANTO RESTA DI UN PIANO LASCIATO FERMO');
  console.log('Δ      coppie   vs.RIFATTO(mediana)  vs.RIFATTO(media)  decimo peggiore   vs.SE STESSO   mercati del piano ancora allocabili   cicli in cui il reset SAREBBE scattato   $/g persi (mediana, su $665)');
  for (const r of righe) {
    console.log(
      `${String(r.dH + 'h').padEnd(6)} ${String(r.coppie).padStart(6)}   `
      + `${pct(r.relMed).padStart(18)}  ${pct(r.relMedio).padStart(17)}  ${pct(r.peggiore).padStart(15)}   `
      + `${pct(r.assMed).padStart(12)}   ${pct(r.sopr).padStart(35)}   ${pct(r.scatti).padStart(37)}   ${(r.persiMed == null ? '—' : '$' + r.persiMed.toFixed(2)).padStart(27)}`,
    );
  }

  console.log('\nIL CONTROLLO DI VALIDITÀ VEDE TUTTO IL DECADIMENTO? (spaccatura dello stesso campione)');
  console.log('Δ        cicli in cui SAREBBE scattato: quanto restava   |   cicli in cui NON sarebbe scattato: quanto restava');
  for (const r of righe) {
    console.log(`${String(r.dH + 'h').padEnd(8)} ${(pct(r.relSeScatta) + `  (n=${r.nScatta})`).padStart(38)}   |   ${(pct(r.relSeNonScatta) + `  (n=${r.nNonScatta})`).padStart(44)}`);
  }
  console.log('  Se la colonna di destra è molto sotto il 100%, una parte del decadimento sfugge al controllo di validità:');
  console.log('  sono mercati ancora vivi, ancora premiati, ancora in banda, che però hanno smesso di essere i migliori.');

  console.log('\nCOME SI LEGGE');
  console.log('  vs. RIFATTO   = valore del piano vecchio ÷ valore del piano che si sarebbe fatto in quel momento.');
  console.log('                  100% = riallocare non avrebbe aggiunto niente. 70% = si sta lasciando sul tavolo il 30%.');
  console.log('  vs. SE STESSO = quanto rende il piano vecchio rispetto a quanto rendeva quando fu deciso.');
  console.log('                  Scende anche quando il mercato intero si raffredda, non solo per colpa del piano fermo.');
  console.log('  decimo peggiore = il 10° percentile del rapporto vs. RIFATTO: il giro andato male, non quello tipico.');
  console.log('  cicli in cui il reset SAREBBE scattato = quante volte, su quel Δ, almeno un mercato del piano era sparito');
  console.log('                  o aveva perso più di metà del montepremi — cioè quanto spesso il riallocatore agirebbe.');
  console.log();
}

main();

#!/usr/bin/env node
'use strict';
// scripts/ricerca/orizzonte-popolazione.js — QUANTO VALE LA FASCIA SOTTO MIN_HORIZON_DAYS.
//
// SOLA LETTURA. Nessuna rete, nessuna scrittura fuori da data/ricerca/. Non tocca nessuna soglia.
//
// FONTE: data/history/rewards-poly/YYYY-MM-DD.json — le fotografie del board scritte da agent24
// (~una ogni 42 min). Ogni riga porta dailyPool, maxSpread, minSize, mid, bookSpread,
// existingLiquidityUsd, endDate. La profondità è quella TOTALE del book, NON la profondità in banda
// che il pianificatore usa come `competitorShares`: le due non sono la stessa grandezza e qui non
// vengono confuse.
//
// LA DOMANDA CHE DECIDE, e per cui serve lo storico e non una fotografia: un mercato scartato perché
// gli restano meno di 18 ore era MAI stato disponibile con più di 18 ore? Se sì il filtro ne esclude
// solo la coda finale; se no lo esclude per sempre.

const fs = require('fs');
const path = require('path');
const RADICE = path.join(__dirname, '..', '..');
const DIR = path.join(RADICE, 'data', 'history', 'rewards-poly');
const USCITA = path.join(RADICE, 'data', 'ricerca', 'orizzonte-popolazione.json');

const MIN_HORIZON_DAYS = 0.75;              // il valore in vigore, LETTO e non riscritto
const { MIN_HORIZON_DAYS: DAL_MODULO } = require(path.join(RADICE, 'lib', 'rewards', 'horizon'));
if (DAL_MODULO !== MIN_HORIZON_DAYS) {
  console.error(`⚠ il modulo dichiara ${DAL_MODULO}, questo script ${MIN_HORIZON_DAYS} — allineare prima di leggere i numeri`);
  process.exit(2);
}
const COSTO_COPPIA = 0.98;                  // tick 0,01; su tick 0,001 sarebbe 0,998 (+1,8% sul pavimento)
const GIORNI = Number(process.argv[2] || 7); // finestra minima richiesta

const file = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const daIso = (s) => Date.parse(s);
const foto = [];
for (const f of file) {
  let g; try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  for (const s of g) if (s && Array.isArray(s.rows) && s.t) foto.push({ t: s.t, iso: s.iso, rows: s.rows });
}
foto.sort((a, b) => a.t - b.t);
const tFine = foto[foto.length - 1].t;
const tInizio = tFine - GIORNI * 86_400_000;
const finestra = foto.filter((s) => s.t >= tInizio);

const mediana = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const perc = (v, p) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const giorniA = (r, t) => (r.endDate ? (daIso(r.endDate) - t) / 86_400_000 : null);

// ── 1 · LA FASCIA, FOTOGRAFIA PER FOTOGRAFIA ────────────────────────────────────────────────────
// Ogni fotografia è un'occasione di piano: quanti mercati la fascia offriva, e quanto montepremi.
const perFoto = [];
// ── 2 · I MERCATI, CIASCUNO UNA VOLTA SOLA ──────────────────────────────────────────────────────
// La stessa riga compare in decine di fotografie: contarla ogni volta gonfierebbe tutto. Qui ogni
// mercato porta il suo massimo orizzonte MAI osservato — è la domanda che decide.
const perMercato = new Map();

for (const s of finestra) {
  let nCorti = 0, potCorti = 0, nAmmessi = 0, potAmmessi = 0, nSenzaData = 0, nRisolti = 0;
  for (const r of s.rows) {
    if (r.venue !== 'polymarket') continue;
    const pot = Number(r.dailyPool);
    const d = giorniA(r, s.t);
    if (d == null) { nSenzaData++; continue; }
    if (d <= 0) { nRisolti++; continue; }
    const corto = d < MIN_HORIZON_DAYS;
    if (corto) { nCorti++; potCorti += Number.isFinite(pot) ? pot : 0; }
    else { nAmmessi++; potAmmessi += Number.isFinite(pot) ? pot : 0; }
    let m = perMercato.get(r.id);
    if (!m) {
      m = { id: r.id, titolo: r.title, pot: [], minSize: r.minSize, maxSpread: [], mid: [],
        bookSpread: [], depthUsd: [], endDate: r.endDate, dMax: -Infinity, dMin: Infinity,
        visteCorto: 0, visteAmmesso: 0, primaVista: s.t, ultimaVista: s.t };
      perMercato.set(r.id, m);
    }
    m.ultimaVista = s.t;
    if (Number.isFinite(pot)) m.pot.push(pot);
    if (Number.isFinite(Number(r.maxSpread))) m.maxSpread.push(Number(r.maxSpread));
    if (Number.isFinite(Number(r.mid))) m.mid.push(Number(r.mid));
    if (Number.isFinite(Number(r.bookSpread))) m.bookSpread.push(Number(r.bookSpread));
    if (Number.isFinite(Number(r.existingLiquidityUsd))) m.depthUsd.push(Number(r.existingLiquidityUsd));
    if (Number.isFinite(Number(r.minSize))) m.minSize = Number(r.minSize);
    m.dMax = Math.max(m.dMax, d); m.dMin = Math.min(m.dMin, d);
    if (corto) m.visteCorto++; else m.visteAmmesso++;
  }
  perFoto.push({ t: s.t, iso: s.iso, nCorti, potCorti, nAmmessi, potAmmessi, nSenzaData, nRisolti });
}

// ── i mercati che la fascia corta ha toccato almeno una volta ──────────────────────────────────
const corti = [...perMercato.values()].filter((m) => m.visteCorto > 0);
// NATI CORTI = non sono MAI stati visti con più di MIN_HORIZON_DAYS di vita. Il filtro li esclude
// per sempre, non ne taglia la coda.
const natiCorti = corti.filter((m) => m.dMax < MIN_HORIZON_DAYS);
const soloCoda = corti.filter((m) => m.dMax >= MIN_HORIZON_DAYS);

const potDi = (m) => mediana(m.pot);
const rias = (arr, nome) => {
  const pots = arr.map(potDi).filter(Number.isFinite);
  const somma = pots.reduce((a, b) => a + b, 0);
  return {
    nome, mercati: arr.length,
    montepremiSommaUsdGiorno: +somma.toFixed(2),
    montepremiMediano: mediana(pots), montepremiQ1: perc(pots, 0.25), montepremiQ3: perc(pots, 0.75),
    montepremiMax: pots.length ? Math.max(...pots) : null,
  };
};

// ── il pavimento premiante richiesto ────────────────────────────────────────────────────────────
const SOGLIE = [32.67, 50, 61.25, 98];
const perSoglia = {};
for (const s of SOGLIE) perSoglia[s] = corti.filter((m) => Number.isFinite(m.minSize) && m.minSize * COSTO_COPPIA <= s).length;
const distMin = {};
for (const m of corti) { const k = String(m.minSize); distMin[k] = (distMin[k] || 0) + 1; }

// ── banda e profondità ──────────────────────────────────────────────────────────────────────────
const bande = corti.map((m) => mediana(m.maxSpread)).filter(Number.isFinite);
const bandeAmmessi = [...perMercato.values()].filter((m) => m.visteCorto === 0).map((m) => mediana(m.maxSpread)).filter(Number.isFinite);
const depth = corti.map((m) => mediana(m.depthUsd)).filter(Number.isFinite);
const depthAmm = [...perMercato.values()].filter((m) => m.visteCorto === 0).map((m) => mediana(m.depthUsd)).filter(Number.isFinite);

// ── ore di vita utile: quanto tempo un ordine potrebbe stare a book ────────────────────────────
// Per i NATI CORTI è tutta la vita che hanno; per gli altri è la coda che il filtro taglia.
const oreVita = natiCorti.map((m) => m.dMax * 24).filter(Number.isFinite);
const oreCodaTagliata = soloCoda.map((m) => MIN_HORIZON_DAYS * 24).filter(Number.isFinite);
// e quante ore ciascun mercato è stato VISIBILE sopra il pavimento prima di scendere sotto
const oreSopra = soloCoda.map((m) => (m.dMax - MIN_HORIZON_DAYS) * 24).filter(Number.isFinite);

const out = {
  generatoIso: new Date().toISOString(),
  fonte: 'data/history/rewards-poly (fotografie agent24, ~1 ogni 42 min)',
  finestraGiorni: GIORNI,
  finestraDa: new Date(tInizio).toISOString(), finestraA: new Date(tFine).toISOString(),
  fotografie: finestra.length,
  minHorizonDays: MIN_HORIZON_DAYS,
  costoCoppiaUsato: COSTO_COPPIA,
  perFotoMediane: {
    mercatiCortiMediano: mediana(perFoto.map((f) => f.nCorti)),
    mercatiCortiMin: Math.min(...perFoto.map((f) => f.nCorti)),
    mercatiCortiMax: Math.max(...perFoto.map((f) => f.nCorti)),
    mercatiAmmessiMediano: mediana(perFoto.map((f) => f.nAmmessi)),
    montepremiCortiMediano: mediana(perFoto.map((f) => f.potCorti)),
    montepremiAmmessiMediano: mediana(perFoto.map((f) => f.potAmmessi)),
    senzaDataMediano: mediana(perFoto.map((f) => f.nSenzaData)),
  },
  mercatiDistinti: {
    totali: perMercato.size,
    toccatiDallaFasciaCorta: corti.length,
    natiCorti: natiCorti.length,
    soloCodaTagliata: soloCoda.length,
  },
  riassunti: [rias(corti, 'tutti i corti'), rias(natiCorti, 'NATI CORTI (mai sopra il pavimento)'), rias(soloCoda, 'solo coda tagliata')],
  pavimentoPremiante: {
    distribuzioneMinSize: distMin,
    finanziabiliASoglia: perSoglia,
    nota: 'pavimento = minSize × 0,98; su tick 0,001 sarebbe ×0,998, +1,8% — non sposta nessuna soglia qui',
  },
  banda: {
    cortiMediana: mediana(bande), cortiQ1: perc(bande, 0.25), cortiQ3: perc(bande, 0.75),
    ammessiMediana: mediana(bandeAmmessi), ammessiQ1: perc(bandeAmmessi, 0.25), ammessiQ3: perc(bandeAmmessi, 0.75),
  },
  profonditaUsdTotaleBook: {
    cortiMediana: mediana(depth), cortiQ1: perc(depth, 0.25), cortiQ3: perc(depth, 0.75),
    ammessiMediana: mediana(depthAmm), ammessiQ1: perc(depthAmm, 0.25), ammessiQ3: perc(depthAmm, 0.75),
    nota: 'existingLiquidityUsd = book TOTALE, non la profondità in banda che il pianificatore usa',
  },
  vitaUtile: {
    natiCortiOreMediana: mediana(oreVita), natiCortiOreQ1: perc(oreVita, 0.25), natiCortiOreQ3: perc(oreVita, 0.75),
    natiCortiOreMin: oreVita.length ? Math.min(...oreVita) : null, natiCortiOreMax: oreVita.length ? Math.max(...oreVita) : null,
    soloCodaOreSopraPavimentoMediana: mediana(oreSopra),
    soloCodaOreTagliate: mediana(oreCodaTagliata),
  },
  elencoNatiCorti: natiCorti.map((m) => ({
    titolo: m.titolo, pot: potDi(m), minSize: m.minSize, pavimentoUsd: +(m.minSize * COSTO_COPPIA).toFixed(2),
    maxSpread: mediana(m.maxSpread), oreVita: +(m.dMax * 24).toFixed(1),
    depthUsd: mediana(m.depthUsd), mid: mediana(m.mid),
  })).sort((a, b) => (b.pot || 0) - (a.pot || 0)),
};

fs.writeFileSync(USCITA, JSON.stringify(out, null, 1));

// ── stampa ──────────────────────────────────────────────────────────────────────────────────────
const R = out;
console.log(`\n═══ LA FASCIA SOTTO MIN_HORIZON_DAYS=${MIN_HORIZON_DAYS} (${MIN_HORIZON_DAYS * 24} h) — ${GIORNI} giorni, ${R.fotografie} fotografie`);
console.log(`    ${R.finestraDa} → ${R.finestraA}\n`);
console.log(`  per fotografia (mediana):  ${R.perFotoMediane.mercatiCortiMediano} corti [${R.perFotoMediane.mercatiCortiMin}–${R.perFotoMediane.mercatiCortiMax}]`
  + ` · ${R.perFotoMediane.mercatiAmmessiMediano} ammessi · montepremi corti $${R.perFotoMediane.montepremiCortiMediano}/g contro $${R.perFotoMediane.montepremiAmmessiMediano}/g ammessi`);
console.log(`\n  mercati DISTINTI: ${R.mercatiDistinti.totali} totali · ${R.mercatiDistinti.toccatiDallaFasciaCorta} toccati dalla fascia corta`);
console.log(`     ├─ NATI CORTI (mai sopra il pavimento, esclusi PER SEMPRE): ${R.mercatiDistinti.natiCorti}`);
console.log(`     └─ solo coda tagliata (erano entrabili prima):              ${R.mercatiDistinti.soloCodaTagliata}`);
console.log('\n  montepremi:');
for (const r of R.riassunti) console.log(`     ${r.nome.padEnd(36)} ${String(r.mercati).padStart(4)} mkt · somma $${String(r.montepremiSommaUsdGiorno).padStart(9)}/g · mediana $${r.montepremiMediano} · Q1 $${r.montepremiQ1} · Q3 $${r.montepremiQ3} · max $${r.montepremiMax}`);
console.log('\n  pavimento premiante dei corti — distribuzione minSize:', JSON.stringify(distMin));
console.log('     finanziabili al tetto:', SOGLIE.map((s) => `$${s} → ${perSoglia[s]}/${corti.length}`).join(' · '));
console.log(`\n  banda (maxSpread ¢):  corti mediana ${R.banda.cortiMediana} [Q1 ${R.banda.cortiQ1} · Q3 ${R.banda.cortiQ3}]  ·  ammessi mediana ${R.banda.ammessiMediana} [Q1 ${R.banda.ammessiQ1} · Q3 ${R.banda.ammessiQ3}]`);
console.log(`  profondità book TOTALE $: corti mediana ${R.profonditaUsdTotaleBook.cortiMediana} [Q1 ${R.profonditaUsdTotaleBook.cortiQ1} · Q3 ${R.profonditaUsdTotaleBook.cortiQ3}]  ·  ammessi mediana ${R.profonditaUsdTotaleBook.ammessiMediana}`);
console.log(`\n  vita utile dei NATI CORTI (ore): mediana ${R.vitaUtile.natiCortiOreMediana} · Q1 ${R.vitaUtile.natiCortiOreQ1} · Q3 ${R.vitaUtile.natiCortiOreQ3} · min ${R.vitaUtile.natiCortiOreMin} · max ${R.vitaUtile.natiCortiOreMax}`);
console.log(`  ore SOPRA il pavimento per chi ha solo la coda tagliata: mediana ${R.vitaUtile.soloCodaOreSopraPavimentoMediana}`);
console.log(`\n  i NATI CORTI più ricchi:`);
for (const m of R.elencoNatiCorti.slice(0, 15)) console.log(`     $${String(m.pot).padStart(5)}/g · min ${String(m.minSize).padStart(3)} (pav $${String(m.pavimentoUsd).padStart(6)}) · banda ${String(m.maxSpread).padStart(4)}¢ · ${String(m.oreVita).padStart(5)} h · book $${String(m.depthUsd).padStart(9)} · ${String(m.titolo).slice(0, 46)}`);
console.log(`\nscritto in data/ricerca/orizzonte-popolazione.json\n`);

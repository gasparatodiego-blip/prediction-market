#!/usr/bin/env node
'use strict';
/**
 * IL PIANO CHE agent41 FAREBBE DOPO IL RIAVVIO — sola lettura, niente toccato.
 *
 * Risponde alle tre domande del punto 3 con i numeri del board VIVO, prima del riavvio:
 * quanti mercati entrano nel piano, quanto capitale viene impiegato, quale reward è modellato —
 * con orizzonte 0,50 (già in servizio) e la manopola distanza a 0,444.
 *
 * ⚠ PERCHE' LA MANOPOLA ENTRA IN QUESTO CONTO. Non tocca il knapsack, che non conosce la posizione
 * nella banda: entra nel FILTRO DI QUOTABILITA' (`allocator` → `quotabilita` → `planBehindBest`), che
 * gira con la manopola accesa e puo' quindi giudicare non quotabile un lato che a 1,0¢ passava.
 * Si calcolano quindi DUE piani sullo stesso board — manopola spenta e a 0,444 — e si confrontano.
 *
 * ⚠ E IL REWARD MODELLATO DEL PIANO NON CONTIENE LO SCONTO DELLA DISTANZA. Il piano scora al proprio
 * offset di riferimento; il costo del pavimento a 2,0¢ e' il rapporto dei punteggi S(v,s), che si
 * calcola qui a parte con la formula del venue e si applica al lordo. Le due cose sono tenute separate
 * perche' la prima e' una misura del piano e la seconda una CONSEGUENZA aritmetica dichiarata.
 *
 * Uso:  node scripts/ricerca/piano-con-distanza-2c.js [capitale]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'data', 'ricerca');
const OUT = path.join(OUT_DIR, 'piano-con-distanza-2c.json');

const A = require(path.join(ROOT, 'lib', 'rewards', 'allocator'));
const C = require(path.join(ROOT, 'lib', 'rewards', 'concentration'));
const D = require(path.join(ROOT, 'lib', 'maker', 'distanza-obiettivo'));
const { raggioBandaCents, punteggio } = require(path.join(ROOT, 'lib', 'banda-premiante'));
const H = require(path.join(ROOT, 'lib', 'rewards', 'horizon'));

const capitale = Number(process.argv[2]) || 2149.88;
const tetto = C.capPerMarketUsd(capitale);

const piano = (frazione) => {
  const prima = process.env[D.ENV_FRAZIONE];
  if (frazione == null) delete process.env[D.ENV_FRAZIONE];
  else process.env[D.ENV_FRAZIONE] = String(frazione);
  let p = null, err = null;
  try { p = A.planFromCollection({ capital: capitale, maxPerMarketUsd: tetto, horizonFilter: true }); }
  catch (e) { err = e; }
  if (prima === undefined) delete process.env[D.ENV_FRAZIONE]; else process.env[D.ENV_FRAZIONE] = prima;
  if (err) throw err;
  const s = p.selezione || {};
  return {
    righe: (p.rows || []).length,
    capitaleImpiegatoUsd: p.totals ? +Number(p.totals.capital || 0).toFixed(2) : null,
    nonImpiegatoUsd: p.totals ? +Number(p.totals.unallocated || 0).toFixed(2) : null,
    lordoModellatoGiorno: p.totals ? +Number(p.totals.grossPerDay || 0).toFixed(2) : null,
    realisticoGiorno: p.totals ? +Number(p.totals.realisticPerDay || 0).toFixed(2) : null,
    valutati: (p.candidates || []).length,
    scartatiOrizzonte: (s.horizonRejected || []).length,
    nonQuotabili: (s.nonQuotabili || []).length,
    profonditaSottili: (s.profonditaSottile || []).length,
    superstiti: s.profonditaSuperstiti, minimiPerCoprire: s.profonditaMinimiPerCoprire,
    bandeDelPiano: (p.rows || []).map((r) => r.maxSpreadCents).filter((x) => Number.isFinite(x)),
  };
};

console.log(`capitale $${capitale} · tetto per mercato $${tetto} · orizzonte [${H.MIN_HORIZON_DAYS} · ${H.MAX_HORIZON_DAYS}] g`);
console.log('calcolo il piano con la manopola SPENTA…');
const spenta = piano(null);
console.log('calcolo il piano con la manopola a 0,444…');
const acceso = piano(0.444);

// ── IL COSTO DELLA DISTANZA, aritmetico e dichiarato ────────────────────────────────────────────
// S(v,s) = ((v−s)/v)². La posizione di partenza e' 1,0¢ (mediana misurata degli ordini di oggi,
// §5-bis p.158); quella nuova e' max(1,0¢, 0,444·v) — la manopola e' un PAVIMENTO, quindi su bande
// strette puo' non mordere affatto.
const bande = acceso.bandeDelPiano.length ? acceso.bandeDelPiano : spenta.bandeDelPiano;
const perRiga = bande.map((ms) => {
  const v = raggioBandaCents(ms);
  if (v == null) return null;
  const sPrima = 1.0;
  const sDopo = Math.max(sPrima, +(0.444 * v).toFixed(4));
  // ⚠ La firma e' `punteggio(distanzaCents, maxSpreadCents)`, non `(v, s)`: invertirla restituisce 0
  // su ogni riga e il rapporto esce `n/d` — accaduto alla prima stesura di questo script.
  const S0 = punteggio(sPrima, ms), S1 = punteggio(sDopo, ms);
  return { v, sPrima, sDopo, S0, S1, rapporto: S0 > 0 ? S1 / S0 : null, morde: sDopo > sPrima + 1e-9 };
}).filter(Boolean);
const conRapporto = perRiga.filter((x) => Number.isFinite(x.rapporto));
const rapportoMedio = conRapporto.length ? conRapporto.reduce((t, x) => t + x.rapporto, 0) / conRapporto.length : null;
const morde = perRiga.filter((x) => x.morde).length;

const lordo = acceso.lordoModellatoGiorno;
const realistico = acceso.realisticoGiorno;
const corpo = {
  at: new Date().toISOString(), capitaleUsd: capitale, tettoPerMercatoUsd: tetto,
  orizzonte: { min: H.MIN_HORIZON_DAYS, max: H.MAX_HORIZON_DAYS ?? null, longTailDays: H.LONG_TAIL_DAYS },
  manopolaSpenta: spenta, manopolaA0444: acceso,
  costoDellaDistanza: {
    righeConBandaLeggibile: perRiga.length, righeInCuiIlPavimentoMORDE: morde,
    rapportoMedioS: rapportoMedio != null ? +rapportoMedio.toFixed(4) : null,
    lordoModellatoDalPianoUsd: lordo,
    lordoDopoLoScontoDistanzaUsd: (lordo != null && rapportoMedio != null) ? +(lordo * rapportoMedio).toFixed(2) : null,
    realisticoDopoLoScontoDistanzaUsd: (realistico != null && rapportoMedio != null) ? +(realistico * rapportoMedio).toFixed(2) : null,
    perRiga,
  },
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(corpo, null, 2));

const riga = (n, o) => console.log(`  ${n.padEnd(28)} ${String(o.righe).padStart(4)} righe · $${String(o.capitaleImpiegatoUsd).padStart(9)} impiegati · $${String(o.lordoModellatoGiorno).padStart(8)}/g lordo · $${String(o.realisticoGiorno).padStart(8)}/g realistico`);
console.log('');
riga('manopola SPENTA (oggi)', spenta);
riga('manopola 0,444 (dopo)', acceso);
console.log(`\n  valutati ${acceso.valutati} · scartati orizzonte ${acceso.scartatiOrizzonte} · non quotabili ${acceso.nonQuotabili} · profondita' ${acceso.profonditaSottili}`);
console.log(`  superstiti ${acceso.superstiti} contro ${acceso.minimiPerCoprire} minimi per coprire il capitale`);
console.log(`\n  il pavimento a 2,0c MORDE su ${morde}/${perRiga.length} righe · rapporto medio S = ${rapportoMedio != null ? rapportoMedio.toFixed(4) : 'n/d'}`);
console.log(`  lordo dopo lo sconto della distanza: $${corpo.costoDellaDistanza.lordoDopoLoScontoDistanzaUsd}/g (da $${lordo}/g)`);
console.log(`  realistico dopo lo sconto:          $${corpo.costoDellaDistanza.realisticoDopoLoScontoDistanzaUsd}/g (da $${realistico}/g)`);
console.log(`\n→ ${path.relative(ROOT, OUT)}`);

#!/usr/bin/env node
'use strict';
// scripts/misura-ricambio-candidati.js — QUANTO SI MUOVE L'INSIEME DEI CANDIDATI, MISURATO.
//
// ═══ LA DOMANDA ══════════════════════════════════════════════════════════════════════════════════════
// `lib/rewards/collector-priority.js` tiene «caldi» i mercati con due numeri: TOP_K (quanti
// quasi-vincitori restano in elenco oltre le righe del piano) e RETENTION (per quante ore un mercato
// resta caldo dopo l'ultimo interesse). Entrambi devono venire dai dati, non dall'intuito, e i dati
// invecchiano: il codice, la flotta e il capitale del 4 agosto 2026 non sono quelli di adesso.
//
// Questo script rimisura la stessa cosa che fu misurata allora, con lo stesso metodo:
//   • campiona `planFromCollection` N volte a distanza di M minuti;
//   • per ogni coppia ordinata di campioni (t1, t2) guarda a che POSIZIONE della graduatoria di t1
//     stavano le righe che il piano ha scelto a t2 — cioè: «se avessi tenuto caldi i primi K di t1,
//     avrei coperto le righe che il piano vuole a t2?»;
//   • riporta la copertura per ogni K, la profondità massima, e quante righe erano FUORI dalla
//     graduatoria precedente (il caso che nessun K può salvare).
//
// SOLA LETTURA. Chiama `planFromCollection`, che è la stessa funzione che il pannello «Ottimizza»
// esegue per mostrare un piano: non firma, non piazza, non scrive nessun file di stato. L'unico file
// che questo script scrive è il proprio referto, sotto il percorso passato con --out.
//
// ═══ DUE MODI DI CAMPIONARE, E SERVONO A DUE NUMERI DIVERSI ══════════════════════════════════════════
//   --modo vivo     (difetto) N campioni a M minuti l'uno dall'altro, adesso. È la misura di TOP_K: la
//                   domanda «una lista scritta ORA basta al piano di FRA POCO?» vive su questa scala.
//   --modo storico  un campione per ogni offset in ore passato con --offsetOre, ottenuto spostando
//                   INDIETRO la finestra del giornale (`to` = adesso − offset). È la misura di
//                   RETENTION: per sapere quante ore un mercato deve restare caldo bisogna guardare a
//                   che distanza nel tempo un mercato ritorna interessante, e ventiquattro ore non si
//                   aspettano campionando in avanti.
//                   LIMITE DICHIARATO: il board (montepremi, banda, scadenze) è la fotografia di ADESSO
//                   anche per i campioni arretrati — solo il giornale dei prezzi e il nastro scorrono
//                   indietro. Il ricambio misurato è quindi quello dovuto ai PREZZI, non ai montepremi.
//
// Uso:
//   node scripts/misura-ricambio-candidati.js --campioni 8 --intervallo 180 --capitale 660 \
//        --out /tmp/ricambio.json
//   node scripts/misura-ricambio-candidati.js --modo storico --offsetOre 24,20,16,12,8,6,4,2,1,0 \
//        --out /tmp/ricambio-storico.json

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const { planFromCollection } = require(path.join(ROOT, 'lib/rewards/allocator'));
const { capPerMarketUsd } = require(path.join(ROOT, 'lib/rewards/concentration'));

const arg = (n, def) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const MODO = arg('modo', 'vivo');
const CAMPIONI = Number(arg('campioni', 8));
const INTERVALLO_S = Number(arg('intervallo', 180));
const CAPITALE = Number(arg('capitale', 660));
const OFFSET_ORE = String(arg('offsetOre', '24,20,16,12,8,6,4,3,2,1,0')).split(',').map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => b - a);
const OUT = arg('out', path.join(ROOT, 'data', 'ricambio-candidati.json'));

const dormi = (ms) => new Promise((r) => setTimeout(r, ms));
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Un campione: le righe scelte e la graduatoria dei candidati valutati, nell'ordine di
 *  `collector-priority.mercatiDalPiano` — cioè per bestNetPerDay decrescente.
 *  `offsetOre` sposta indietro la finestra del giornale: 0 = adesso. */
function campiona(offsetOre = 0) {
  const t0 = Date.now();
  const finestra = offsetOre > 0
    ? { to: new Date(Date.now() - offsetOre * 3_600_000).toISOString() }
    : {};
  const p = planFromCollection({
    capital: CAPITALE,
    horizonFilter: true,
    maxPerMarketUsd: capPerMarketUsd(CAPITALE),
    usePairCost: true,
    ...finestra,
  });
  const righe = (p.rows || []).map((r) => String(r.marketId).toLowerCase());
  // Lo STESSO criterio di `collector-priority.mercatiDalPiano`: l'obiettivo con cui il knapsack ha
  // ordinato, non la cifra da mostrare. Vedi lì il perché e la misura.
  const criterio = (c) => (fin(c.bestObiettivoPerDay) ? c.bestObiettivoPerDay : (fin(c.bestNetPerDay) ? c.bestNetPerDay : null));
  const graduatoria = (p.candidates || [])
    .filter((c) => c && criterio(c) != null && c.marketId)
    .sort((a, b) => criterio(b) - criterio(a))
    .map((c) => String(c.marketId).toLowerCase());
  return {
    // L'istante che il campione DESCRIVE (fine della finestra del giornale), non quello in cui è stato
    // calcolato: con --modo storico i due differiscono di ore, ed è l'istante descritto che ordina.
    at: new Date(Date.now() - offsetOre * 3_600_000).toISOString(),
    offsetOre,
    calcolatoAt: new Date().toISOString(),
    msImpiegati: Date.now() - t0,
    capitale: CAPITALE,
    righe,
    graduatoria,
    valutati: (p.candidates || []).filter((c) => c.status !== undefined).length,
    universoConMontepremi: p.universe ? p.universe.withPot : null,
    universoValutati: p.universe ? p.universe.evaluated : null,
    totaleLordoGiorno: p.totals ? p.totals.grossPerDay : null,
  };
}

(async () => {
  const campioni = [];
  if (MODO === 'storico') {
    // Dal più vecchio al più recente: l'ordine cronologico è quello che rende leggibili le coppie.
    for (let i = 0; i < OFFSET_ORE.length; i++) {
      const c = campiona(OFFSET_ORE[i]);
      campioni.push(c);
      console.log(`campione ${i + 1}/${OFFSET_ORE.length} — −${OFFSET_ORE[i]}h (${c.at}) · ${c.righe.length} righe · ${c.graduatoria.length} candidati con netto · ${(c.msImpiegati / 1000).toFixed(1)}s`);
    }
  } else {
    for (let i = 0; i < CAMPIONI; i++) {
      const c = campiona(0);
      campioni.push(c);
      console.log(`campione ${i + 1}/${CAMPIONI} — ${c.at} · ${c.righe.length} righe · ${c.graduatoria.length} candidati con netto · ${(c.msImpiegati / 1000).toFixed(1)}s`);
      if (i < CAMPIONI - 1) await dormi(INTERVALLO_S * 1000);
    }
  }

  // ── LA MISURA DI K ────────────────────────────────────────────────────────────────────────────────
  // Per ogni coppia (t1, t2) con t1 < t2: dove stavano, nella graduatoria di t1, le righe di t2.
  const coppie = [];
  const profondita = [];      // una voce per riga futura: la sua posizione (1-based) in t1, o null se assente
  for (let a = 0; a < campioni.length; a++) {
    for (let b = a + 1; b < campioni.length; b++) {
      const pos = new Map(campioni[a].graduatoria.map((id, k) => [id, k + 1]));
      const dettaglio = campioni[b].righe.map((id) => ({ id, rank: pos.has(id) ? pos.get(id) : null }));
      dettaglio.forEach((d) => profondita.push(d.rank));
      coppie.push({
        da: campioni[a].at, a: campioni[b].at,
        minuti: +((Date.parse(campioni[b].at) - Date.parse(campioni[a].at)) / 60000).toFixed(1),
        righeFuture: dettaglio.length,
        ranks: dettaglio.map((d) => d.rank),
        fuoriGraduatoria: dettaglio.filter((d) => d.rank == null).length,
      });
    }
  }

  const perK = [];
  for (const K of [10, 15, 20, 24, 26, 30, 35, 40, 50]) {
    const coperte = profondita.filter((r) => r != null && r <= K).length;
    const coppieIntere = coppie.filter((c) => c.ranks.length > 0 && c.ranks.every((r) => r != null && r <= K)).length;
    perK.push({ K, righeCoperte: coperte, righeTotali: profondita.length, pct: profondita.length ? +((coperte / profondita.length) * 100).toFixed(1) : null, coppieIntere, coppieTotali: coppie.length });
  }

  // ── IL RICAMBIO DELL'INSIEME DEI CANDIDATI, fra campioni CONSECUTIVI ─────────────────────────────
  const ricambio = [];
  for (let i = 1; i < campioni.length; i++) {
    const prima = new Set(campioni[i - 1].graduatoria);
    const dopo = new Set(campioni[i].graduatoria);
    const entrati = [...dopo].filter((x) => !prima.has(x));
    const usciti = [...prima].filter((x) => !dopo.has(x));
    ricambio.push({
      minuti: +((Date.parse(campioni[i].at) - Date.parse(campioni[i - 1].at)) / 60000).toFixed(1),
      prima: prima.size, dopo: dopo.size, entrati: entrati.length, usciti: usciti.length,
    });
  }

  // ── QUANTO DUREREBBE L'UNIONE, cioè il tetto di cui c'è davvero bisogno ──────────────────────────
  const unione = new Set();
  const crescita = [];
  for (const c of campioni) {
    for (const id of c.righe) unione.add(id);
    for (const id of c.graduatoria.slice(0, 30)) unione.add(id);
    crescita.push(unione.size);
  }

  // ── LA MISURA DI RETENTION: QUANTO STA FUORI CHI POI TORNA ──────────────────────────────────────
  // Un mercato è «interessante» a un campione se è una riga del piano oppure sta nei primi TOP_K
  // candidati — la stessa definizione di `collector-priority.mercatiDalPiano`. La domanda che decide
  // RETENTION è: quando smette di esserlo e poi RITORNA, quante ore è stato fuori? Un'isteresi più
  // corta del ritorno tipico lascia raffreddare esattamente i mercati che il piano rivorrà.
  const K_INTERESSE = 30;
  const interessante = campioni.map((c) => new Set([...c.righe, ...c.graduatoria.slice(0, K_INTERESSE)]));
  const istanti = campioni.map((c) => Date.parse(c.at));
  const tuttiId = new Set();
  interessante.forEach((s) => s.forEach((id) => tuttiId.add(id)));
  const ritorni = [];        // ore di assenza fra due presenze, per ogni mercato che è tornato
  const soloRighe = campioni.map((c) => new Set(c.righe));
  const ritorniRighe = [];
  const buchi = (presenza) => {
    const out = [];
    for (const id of tuttiId) {
      const idx = [];
      for (let i = 0; i < presenza.length; i++) if (presenza[i].has(id)) idx.push(i);
      for (let k = 1; k < idx.length; k++) {
        if (idx[k] === idx[k - 1] + 1) continue;   // mai uscito: non è un ritorno
        out.push(+((istanti[idx[k]] - istanti[idx[k - 1]]) / 3_600_000).toFixed(2));
      }
    }
    return out.sort((a, b) => a - b);
  };
  ritorni.push(...buchi(interessante));
  ritorniRighe.push(...buchi(soloRighe));
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);
  const riassuntoRitorni = (arr) => ({
    n: arr.length, min: arr[0] ?? null, mediana: pct(arr, 50), p90: pct(arr, 90), p95: pct(arr, 95), max: arr[arr.length - 1] ?? null,
  });

  const referto = {
    at: new Date().toISOString(),
    parametri: { modo: MODO, campioni: MODO === 'storico' ? OFFSET_ORE.length : CAMPIONI, intervalloSec: INTERVALLO_S, offsetOre: MODO === 'storico' ? OFFSET_ORE : null, capitale: CAPITALE, kInteresse: K_INTERESSE },
    ritorniInteressante: riassuntoRitorni(ritorni),
    ritorniRighe: riassuntoRitorni(ritorniRighe),
    ritorniOre: ritorni,
    campioni: campioni.map((c) => ({ at: c.at, righe: c.righe.length, candidatiConNetto: c.graduatoria.length, valutati: c.universoValutati, conMontepremi: c.universoConMontepremi, lordoGiorno: c.totaleLordoGiorno })),
    coppie: coppie.length,
    righeFutureEsaminate: profondita.length,
    fuoriGraduatoria: profondita.filter((r) => r == null).length,
    profonditaMax: profondita.filter((r) => r != null).length ? Math.max(...profondita.filter((r) => r != null)) : null,
    perK,
    ricambioConsecutivo: ricambio,
    unioneCrescita: crescita,
    dettaglioCoppie: coppie,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(referto, null, 2));

  console.log('\n── COPERTURA PER K ─────────────────────────────────────────────');
  for (const r of perK) console.log(`  K=${String(r.K).padStart(2)} → ${r.righeCoperte}/${r.righeTotali} righe (${r.pct}%), ${r.coppieIntere}/${r.coppieTotali} coppie intere`);
  console.log(`\nprofondità massima osservata: ${referto.profonditaMax}`);
  console.log(`righe FUORI dalla graduatoria precedente: ${referto.fuoriGraduatoria}/${profondita.length}`);
  console.log('\n── RICAMBIO FRA CAMPIONI CONSECUTIVI ───────────────────────────');
  for (const r of ricambio) console.log(`  +${r.minuti}min: ${r.prima} → ${r.dopo} candidati · ${r.entrati} entrati, ${r.usciti} usciti`);
  console.log(`\nunione (righe + primi 30) nel tempo: ${crescita.join(' → ')}`);
  const r1 = referto.ritorniInteressante, r2 = referto.ritorniRighe;
  console.log('\n── QUANTO STA FUORI CHI POI TORNA (ore) ────────────────────────');
  console.log(`  interessante (riga o top-${K_INTERESSE}): n=${r1.n} · mediana ${r1.mediana} · p90 ${r1.p90} · p95 ${r1.p95} · max ${r1.max}`);
  console.log(`  solo righe del piano:              n=${r2.n} · mediana ${r2.mediana} · p90 ${r2.p90} · p95 ${r2.p95} · max ${r2.max}`);
  console.log(`\nreferto: ${OUT}`);
})();

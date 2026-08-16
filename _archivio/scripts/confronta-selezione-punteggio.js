#!/usr/bin/env node
'use strict';
// scripts/confronta-selezione-punteggio.js — LA LISTA DEI MERCATI PRIMA E DOPO IL PUNTEGGIO DI POSIZIONE.
//
// ═══ LA DOMANDA ══════════════════════════════════════════════════════════════════════════════════════
// Dall'8 agosto 2026 l'obiettivo del knapsack pesa il lordo col quadratico del venue alla distanza REALE
// di ogni mercato (un tick), invece di giudicare tutti al ceiling S=1 — che equivaleva a una distanza
// fissa uguale per tutti. Su banda 4,5¢ il peso vale 0,309 a tick 0,01 e 0,913 a tick 0,001: 2,96 volte.
//
// Questo script esegue lo STESSO piano due volte sugli STESSI dati — stessa finestra, stesso capitale,
// stesso tetto, stesso istante — cambiando solo `usePlacementScore`, e stampa chi entra, chi esce e di
// quanto cambia il rendimento stimato. Serve a rispondere con numeri e non con un'aspettativa.
//
// SOLA LETTURA. `planFromCollection` è la stessa funzione che il pannello «Ottimizza» esegue per
// mostrare un piano: non firma, non piazza, non scrive nessun file di stato.
//
// Uso:  node scripts/confronta-selezione-punteggio.js [capitale] [--json] [--out FILE]

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const { planFromCollection } = require(path.join(ROOT, 'lib/rewards/allocator'));
const { capPerMarketUsd } = require(path.join(ROOT, 'lib/rewards/concentration'));

const CAPITALE = Number(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 660);
const JSON_OUT = process.argv.includes('--json');
const iOut = process.argv.indexOf('--out');
const OUT = iOut >= 0 ? process.argv[iOut + 1] : null;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const usd = (v) => (fin(v) ? `$${v.toFixed(2)}` : '—');
const breve = (id) => `${String(id).slice(0, 10)}…${String(id).slice(-4)}`;

// La FINESTRA si fissa una volta sola e si passa a TUTTI i piani: senza, il secondo leggerebbe un
// nastro di qualche secondo più lungo e la differenza fra le liste conterrebbe anche quello.
// `--oreFa N` sposta indietro la fine della finestra: il giornale e il nastro sono file in append, quindi
// il passato si rilegge identico. Il BOARD no — montepremi, banda e scadenze restano la fotografia di
// adesso anche per una finestra arretrata. Il confronto fra configurazioni resta onesto (tutte e tre
// leggono lo stesso board); non lo è il confronto con una misura presa in un giorno diverso.
const iOre = process.argv.indexOf('--oreFa');
const ORE_FA = iOre >= 0 ? Number(process.argv[iOre + 1]) : 0;
const to = new Date(Date.now() - (Number.isFinite(ORE_FA) ? ORE_FA : 0) * 3_600_000).toISOString();

function piano(usePlacementScore, useCredibleShareCap) {
  return planFromCollection({
    capital: CAPITALE,
    horizonFilter: true,
    maxPerMarketUsd: capPerMarketUsd(CAPITALE),
    usePairCost: true,
    usePlacementScore,
    useCredibleShareCap,
    to,
  });
}

// TRE configurazioni, perche' le correzioni sono due e vanno viste anche separate:
//   A · ceiling      — nessuna delle due: ogni mercato giudicato a S=1 e a quota piena (prima del 7 agosto)
//   B · posizione    — solo il punteggio di posizione (lo stato del 7 agosto sera)
//   C · + credibilita — anche il tetto di quota nell'obiettivo (8 agosto)
const ceiling = piano(false, false);
const prima = piano(true, false);   // «prima» = lo stato da cui parte QUESTA sessione
const dopo = piano(true, true);     // «dopo»  = con il tetto di credibilita' nell'obiettivo

const idPrima = new Set(prima.rows.map((r) => r.marketId));
const idDopo = new Set(dopo.rows.map((r) => r.marketId));
const entrati = dopo.rows.filter((r) => !idPrima.has(r.marketId));
const usciti = prima.rows.filter((r) => !idDopo.has(r.marketId));
const restati = dopo.rows.filter((r) => idPrima.has(r.marketId));

// Il tick di ogni mercato, dal registro dei candidati del piano nuovo (dove il peso è dichiarato).
const pesoPer = new Map((dopo.candidates || []).map((c) => [c.marketId, c]));
const tickDi = (id) => {
  const c = pesoPer.get(id);
  return c && fin(c.punteggioTick) ? c.punteggioTick : null;
};
const contaTick = (righe) => {
  const out = {};
  for (const r of righe) { const t = tickDi(r.marketId); const k = t == null ? 'ignoto' : String(t); out[k] = (out[k] || 0) + 1; }
  return out;
};

// ── I DUE TOTALI CHE CONTANO, MISURATI SULLA STESSA SCALA ────────────────────────────────────────
// L'OBIETTIVO (lordo pesato dal punteggio del venue meno il costo misurato) è ciò che questa
// correzione massimizza: deve salire, altrimenti il knapsack non sta facendo quello che gli si è
// chiesto. Si calcola per ENTRAMBI i piani con gli stessi pesi — quelli del registro dei candidati del
// piano nuovo — perché confrontare due piani con due metri diversi non dimostra niente.
// Si legge dalla RIGA, non si ricostruisce: `grossScoredPerDay` e' il lordo con cui quel piano ha
// davvero classificato quel mercato (gia' pesato da posizione e tetto, secondo la configurazione), e il
// costo e' `lordo − netto misurato`. Ricostruirlo qui con un peso scelto da me sarebbe un quarto metro,
// e il punto di questa misura e' proprio che il metro sia uno solo.
const obiettivo = (righe) => {
  let tot = 0, pesate = 0, senzaPeso = 0;
  for (const r of righe) {
    const lordo = fin(r.grossScoredPerDay) ? r.grossScoredPerDay : (fin(r.grossPerDay) ? r.grossPerDay : null);
    if (lordo == null) { senzaPeso += 1; continue; }
    const costo = (fin(r.grossPerDay) && fin(r.netPerDay)) ? r.grossPerDay - r.netPerDay : 0;
    tot += lordo - costo;
    if (fin(r.grossScoredPerDay)) pesate += 1;
  }
  return { usdGiorno: +tot.toFixed(4), righePesate: pesate, righeSenzaPeso: senzaPeso };
};
const obPrima = obiettivo(prima.rows);
const obDopo = obiettivo(dopo.rows);
const obCeiling = obiettivo(ceiling.rows);
// Il divario fra ciO' CHE IL KNAPSACK MASSIMIZZA e cio' su cui il piano viene poi giudicato. E' il
// numero che questa sessione esiste per stringere: se le due grandezze si muovono in direzioni opposte,
// la selezione sta scegliendo su un'informazione che la valutazione poi smentisce.
const divario = (p, ob) => {
  const re = p.totals.realisticPerDay;
  return fin(re) && ob.usdGiorno ? +(((re - ob.usdGiorno) / ob.usdGiorno) * 100).toFixed(1) : null;
};

const referto = {
  at: new Date().toISOString(),
  divarioObiettivoRealistico: { ceiling: divario(ceiling, obCeiling), prima: divario(prima, obPrima), dopo: divario(dopo, obDopo) },
  ceiling: {
    mercati: ceiling.rows.length, capitaleImpiegato: ceiling.totals.capital,
    lordoGiorno: ceiling.totals.grossPerDay, realisticoGiorno: ceiling.totals.realisticPerDay,
    obiettivo: obCeiling.usdGiorno,
    righe: ceiling.rows.map((r) => ({ marketId: r.marketId, nome: r.name, capitale: r.capital })),
  },
  obiettivo: {
    prima: obPrima, dopo: obDopo, ceiling: obCeiling,
    differenzaUsdGiorno: +(obDopo.usdGiorno - obPrima.usdGiorno).toFixed(4),
    differenzaPct: obPrima.usdGiorno ? +(((obDopo.usdGiorno - obPrima.usdGiorno) / obPrima.usdGiorno) * 100).toFixed(1) : null,
    nota: 'letto dalle righe: il lordo con cui quel piano ha davvero classificato ogni mercato (pesato secondo la sua configurazione) meno il costo avverso misurato — è la quantità che quel knapsack ha massimizzato. Le tre configurazioni massimizzano tre quantità diverse per costruzione: il numero confrontabile fra loro è il REALISTICO.',
  },
  finestraFinoA: to,
  capitale: CAPITALE,
  universo: { conMontepremi: dopo.universe.withPot, valutati: dopo.universe.evaluated },
  pesoNonApplicato: dopo.selezione ? dopo.selezione.pesoNonApplicato : null,
  prima: {
    mercati: prima.rows.length,
    capitaleImpiegato: prima.totals.capital,
    lordoGiorno: prima.totals.grossPerDay,
    realisticoGiorno: prima.totals.realisticPerDay,
    tick: contaTick(prima.rows),
    righe: prima.rows.map((r) => ({ marketId: r.marketId, nome: r.name, capitale: r.capital, tick: r.tick, lordo: r.grossPerDay, realistico: r.realisticBestPerDay })),
  },
  dopo: {
    mercati: dopo.rows.length,
    capitaleImpiegato: dopo.totals.capital,
    lordoGiorno: dopo.totals.grossPerDay,
    realisticoGiorno: dopo.totals.realisticPerDay,
    tick: contaTick(dopo.rows),
    righe: dopo.rows.map((r) => ({ marketId: r.marketId, nome: r.name, capitale: r.capital, tick: r.tick, punteggio: r.punteggioPosizione, lordo: r.grossPerDay, lordoPesato: r.grossScoredPerDay, realistico: r.realisticBestPerDay })),
  },
  entrati: entrati.map((r) => ({ marketId: r.marketId, nome: r.name, tick: tickDi(r.marketId), punteggio: r.punteggioPosizione, quotaCeiling: r.quotaCeiling, quotaCapata: r.quotaCapata, capitale: r.capital, realistico: r.realisticBestPerDay })),
  usciti: usciti.map((r) => ({ marketId: r.marketId, nome: r.name, tick: tickDi(r.marketId), quotaCeiling: (pesoPer.get(r.marketId) || {}).quotaCeiling, quotaCapata: (pesoPer.get(r.marketId) || {}).quotaCapata, capitale: r.capital, realistico: r.realisticBestPerDay })),
  restati: restati.length,
  // Il prezzo con cui ogni riga sopravvissuta verrebbe piazzata, prima e dopo. DEVE essere identico:
  // questa correzione tocca la selezione, non l'esecuzione.
  piazzamentoInvariato: (() => {
    const pr = new Map(prima.rows.map((r) => [r.marketId, r]));
    const diverse = [];
    for (const r of restati) {
      const p = pr.get(r.marketId);
      if (!p) continue;
      if (p.computedDefaultOffsetTicks !== r.computedDefaultOffsetTicks) {
        diverse.push({ marketId: r.marketId, prima: p.computedDefaultOffsetTicks, dopo: r.computedDefaultOffsetTicks });
      }
    }
    return { confrontate: restati.length, offsetDiversi: diverse.length, dettaglio: diverse };
  })(),
};

if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(referto, null, 2)); }
if (JSON_OUT) { console.log(JSON.stringify(referto, null, 2)); process.exit(0); }

const linea = (s) => console.log(s);
linea('\n' + '═'.repeat(96));
linea(`SELEZIONE: CEILING S=1 CONTRO PUNTEGGIO REALE — capitale $${CAPITALE}, finestra fino a ${to}`);
linea('═'.repeat(96));
linea(`universo: ${referto.universo.conMontepremi} con montepremi, ${referto.universo.valutati} valutati · mercati senza peso applicabile: ${referto.pesoNonApplicato}`);
linea('');
linea(`PRIMA (ceiling):  ${prima.rows.length} mercati · ${usd(prima.totals.capital)} impiegati · lordo ${usd(prima.totals.grossPerDay)}/g · realistico ${usd(prima.totals.realisticPerDay)}/g · tick ${JSON.stringify(referto.prima.tick)}`);
linea(`DOPO  (reale):    ${dopo.rows.length} mercati · ${usd(dopo.totals.capital)} impiegati · lordo ${usd(dopo.totals.grossPerDay)}/g · realistico ${usd(dopo.totals.realisticPerDay)}/g · tick ${JSON.stringify(referto.dopo.tick)}`);
const dRe = fin(dopo.totals.realisticPerDay) && fin(prima.totals.realisticPerDay) ? dopo.totals.realisticPerDay - prima.totals.realisticPerDay : null;
linea(`differenza sul realistico: ${fin(dRe) ? (dRe >= 0 ? '+' : '') + usd(dRe) + '/g' : '—'}${fin(dRe) && prima.totals.realisticPerDay ? ` (${((dRe / prima.totals.realisticPerDay) * 100).toFixed(1)}%)` : ''}`);
linea(`OBIETTIVO (lordo pesato − costo misurato, stessi pesi per entrambi): ${usd(obPrima.usdGiorno)}/g → ${usd(obDopo.usdGiorno)}/g` +
  ` = ${referto.obiettivo.differenzaUsdGiorno >= 0 ? '+' : ''}${usd(referto.obiettivo.differenzaUsdGiorno)}/g (${referto.obiettivo.differenzaPct}%)`);
linea('');
linea(`A · ceiling (nessuna correzione):   ${ceiling.rows.length} mercati · lordo ${usd(ceiling.totals.grossPerDay)}/g · realistico ${usd(ceiling.totals.realisticPerDay)}/g · divario obiettivo↔realistico ${referto.divarioObiettivoRealistico.ceiling}%`);
linea(`B · + punteggio di posizione:       ${prima.rows.length} mercati · lordo ${usd(prima.totals.grossPerDay)}/g · realistico ${usd(prima.totals.realisticPerDay)}/g · divario ${referto.divarioObiettivoRealistico.prima}%`);
linea(`C · + tetto di credibilità (OGGI):  ${dopo.rows.length} mercati · lordo ${usd(dopo.totals.grossPerDay)}/g · realistico ${usd(dopo.totals.realisticPerDay)}/g · divario ${referto.divarioObiettivoRealistico.dopo}%`);
linea(`mercati con quota tagliata dal tetto: ${(dopo.candidates || []).filter((c) => c.quotaCapata).length} su ${(dopo.candidates || []).filter((c) => c.quotaCeiling != null).length} valutati`);
linea('');
linea(`ENTRATI (${entrati.length}):`);
for (const e of referto.entrati) linea(`  + ${breve(e.marketId)} tick ${e.tick ?? '—'} · quota ${fin(e.quotaCeiling) ? (e.quotaCeiling * 100).toFixed(1) + '%' : '—'}${e.quotaCapata ? ' CAPATA' : ''} · ${usd(e.capitale)} · realistico ${usd(e.realistico)}/g · ${e.nome || '(nome ignoto)'}`);
if (!entrati.length) linea('  (nessuno)');
linea('');
linea(`USCITI (${usciti.length}):`);
for (const e of referto.usciti) linea(`  − ${breve(e.marketId)} tick ${e.tick ?? '—'} · quota ${fin(e.quotaCeiling) ? (e.quotaCeiling * 100).toFixed(1) + '%' : '—'}${e.quotaCapata ? ' CAPATA' : ''} · ${usd(e.capitale)} · realistico ${usd(e.realistico)}/g · ${e.nome || '(nome ignoto)'}`);
if (!usciti.length) linea('  (nessuno)');
linea('');
linea(`RESTATI: ${restati.length} · offset di piazzamento cambiati: ${referto.piazzamentoInvariato.offsetDiversi} (deve essere 0)`);
if (OUT) linea(`\nreferto: ${OUT}`);

#!/usr/bin/env node
'use strict';
// scripts/ricerca/orizzonte-sensibilita.js — IL PIANO VERO A PAVIMENTO DI ORIZZONTE VARIABILE.
//
// SOLA LETTURA, E NON CAMBIA NESSUNA SOGLIA SU DISCO. `MIN_HORIZON_DAYS` resta 0,75 in
// lib/rewards/horizon.js: qui si sostituisce in MEMORIA, dentro QUESTO processo figlio, la sola
// funzione `horizonVerdict`, e solo per il ramo del pavimento. Tutto il resto della catena —
// costruzione delle curve, DP del knapsack, scala sulla profondità, tetto di credibilità, quota
// della coda lunga, tetto sui book vuoti — è il codice di produzione, non una replica.
//
// COME: `require` restituisce lo STESSO oggetto di modulo a tutti; l'allocatore destruttura
// `horizonVerdict` quando viene caricato (allocator.js:78). Sostituendo l'export PRIMA di caricare
// l'allocatore, la catena vera usa la versione parametrica. Se un giorno l'allocatore passasse a una
// chiamata pigra (`H.horizonVerdict(...)`) questo continuerebbe a funzionare; se cambiasse il nome,
// l'asserzione qui sotto fallisce invece di misurare in silenzio la soglia sbagliata.
//
// Uso: node scripts/ricerca/orizzonte-sensibilita.js <capitale> <tetto> <pavimento_g> [file-uscita]

const path = require('path');
const fs = require('fs');
const RADICE = path.join(__dirname, '..', '..');

const capitale = Number(process.argv[2]);
const tetto = process.argv[3] === 'null' ? null : Number(process.argv[3]);
const pavimento = Number(process.argv[4]);
const uscita = process.argv[5] || null;
if (!Number.isFinite(capitale) || !Number.isFinite(pavimento)) {
  console.error('uso: orizzonte-sensibilita.js <capitale> <tetto|null> <pavimento_g> [uscita]');
  process.exit(2);
}

const H = require(path.join(RADICE, 'lib', 'rewards', 'horizon'));
const originale = H.horizonVerdict;
if (typeof originale !== 'function') { console.error('horizonVerdict non è una funzione — la catena è cambiata'); process.exit(3); }
const PAVIMENTO_VERO = H.MIN_HORIZON_DAYS;

// Il delta, e SOLO il delta: si chiama l'originale; se ha rifiutato per il pavimento vero ma il
// mercato sta sopra il pavimento CHIESTO, si rifà il solo test del rientro (payback), che è
// esattamente ciò che l'originale avrebbe fatto se il pavimento fosse stato più basso.
// Se il pavimento chiesto è PIÙ ALTO del vero, si rifiuta in più — stesso codice di rifiuto.
H.horizonVerdict = function horizonVerdictParametrico(a) {
  const v = originale(a);
  const g = v.days;
  if (g == null) return v;
  if (g <= 0) return v;
  if (pavimento > PAVIMENTO_VERO && g < pavimento) {
    return { ...v, state: 'resolved', payback: null, reason: `scade fra ${g.toFixed(2)} g — sotto il pavimento CHIESTO di ${pavimento} g` };
  }
  if (!(v.state === 'resolved' && g >= pavimento && g < PAVIMENTO_VERO)) return v;
  // era stato bocciato SOLO dal pavimento: si applica il resto del verdetto originale
  if (g > v.maxDays) return { ...v, state: 'too-far' };
  const payback = H.paybackDays(a.grossPerDay, a.costPerDay);
  if (payback == null) return { ...v, state: 'unknown', payback: null, reason: 'costo di adverse selection non misurato' };
  if (payback === Infinity) return { ...v, state: 'short', payback, reason: 'il netto non e positivo: il costo non rientra mai' };
  if (g <= payback) return { ...v, state: 'short', payback, reason: `scade fra ${g.toFixed(2)} g ma il rientro ne chiede ${payback.toFixed(2)}` };
  return { ...v, state: 'ok', payback, reason: `scade fra ${g.toFixed(2)} g, rientro in ${payback.toFixed(2)} — pavimento chiesto ${pavimento}` };
};

const { planFromCollection } = require(path.join(RADICE, 'lib', 'rewards', 'allocator'));
const piano = planFromCollection({ capital: capitale, maxPerMarketUsd: tetto, horizonFilter: true });

const conteggi = {};
for (const c of piano.candidates) {
  const k = c.status === 'scelto' ? 'SCELTO' : (c.reasonCode || 'ignoto');
  conteggi[k] = (conteggi[k] || 0) + 1;
}
const pots = new Map(piano.candidates.map((c) => [c.marketId, c.pot]));
const potScelto = piano.rows.reduce((s, r) => s + (pots.get(r.marketId) || 0), 0);
const orizzontiScelti = piano.rows.map((r) => {
  const c = piano.candidates.find((x) => x.marketId === r.marketId);
  return c && c.horizon ? +Number(c.horizon.days).toFixed(3) : null;
});

const ris = {
  capitale, tetto, pavimentoGiorni: pavimento, pavimentoOre: +(pavimento * 24).toFixed(1),
  pavimentoVeroDelModulo: PAVIMENTO_VERO,
  boardGeneratoIso: piano.generatedAt,
  // La fotografia del board si rinnova ogni ~15 min: due righe della tabella calcolate su due board
  // diversi non sono confrontabili, e questo campo lo rende verificabile invece che assunto.
  boardScrittoIso: (() => { try { return new Date(fs.statSync(path.join(RADICE, 'data', 'liquidity-rewards.json')).mtimeMs).toISOString(); } catch { return null; } })(),
  universo: piano.universe,
  scelti: piano.totals.count,
  capitaleUsato: piano.totals.capital,
  fermo: piano.totals.unallocated,
  lordoGiorno: +piano.totals.grossPerDay.toFixed(2),
  realisticoGiorno: piano.totals.realisticPerDay,
  montepremiCoperto: potScelto,
  orizzontiScelti,
  conteggi,
  selezione: piano.selezione,
  righe: piano.rows.map((r) => ({
    nome: r.name, capitale: r.capital, minSize: r.minSizeShares, pot: pots.get(r.marketId),
    quota: +(r.share * 100).toFixed(2), lordo: +r.grossPerDay.toFixed(2),
    giorni: (piano.candidates.find((x) => x.marketId === r.marketId) || {}).horizon || null,
  })),
};
if (uscita) fs.writeFileSync(uscita, JSON.stringify(ris, null, 1));
console.log(JSON.stringify(ris, null, 1));

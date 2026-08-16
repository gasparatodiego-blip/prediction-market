#!/usr/bin/env node
'use strict';
// scripts/ricerca/orizzonte-brevi-rischio.js — I MERCATI BREVI CI FANNO MALE DAVVERO?
//
// SOLA LETTURA. Output in data/ricerca/. Non tocca nessuna soglia, nessun ordine, nessun processo.
//
// TRE FONTI, TENUTE SEPARATE E MAI FUSE:
//   A · I 21 MAKER (data/maker-21-eventi.jsonl) — 2.172 ingressi e 1.601 ritiri osservati on-chain.
//       È l'unica fonte con abbastanza casi per misurare «la risoluzione arriva prima dell'uscita?»
//       divisa per orizzonte d'ingresso. NON è il nostro comportamento: è quello dei vincitori.
//   B · LE NOSTRE POSIZIONI (data/venue-positions.json) — quello che abbiamo addosso adesso.
//   C · I NOSTRI RESIDUI (data/residui-scoperti.json) — le gambe scoperte sotto il minimo del venue.
//
// LIMITE DICHIARATO: i nostri numeri ereditano i 4 giorni di presenza su 30 del maker. Ogni cifra
// che ne dipende è marcata `nostro:` nell'output. Le cifre dei 21 no.

const fs = require('fs');
const path = require('path');
const RADICE = path.join(__dirname, '..', '..');
const { MIN_HORIZON_DAYS } = require(path.join(RADICE, 'lib', 'rewards', 'horizon'));
const SOGLIA_ORE = MIN_HORIZON_DAYS * 24;   // 18 h, letta e non riscritta

const mediana = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(3); };
const perc = (v, p) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3); };

// ══ A · I 21 MAKER ═══════════════════════════════════════════════════════════════════════════════
const ingressi = [], ritiri = [];
for (const l of fs.readFileSync(path.join(RADICE, 'data', 'maker-21-eventi.jsonl'), 'utf8').split('\n')) {
  if (!l.trim()) continue;
  let r; try { r = JSON.parse(l); } catch { continue; }
  if (r.tipo === 'ingresso') ingressi.push(r);
  else if (r.tipo === 'ritiro') ritiri.push(r);
}

// join ingresso → ritiro sulla coppia (wallet, conditionId), primo ritiro DOPO l'ingresso
const perChiave = new Map();
for (const i of ingressi) {
  const k = `${i.wallet}|${i.conditionId}`;
  if (!perChiave.has(k)) perChiave.set(k, { ingressi: [], ritiri: [] });
  perChiave.get(k).ingressi.push(i);
}
for (const u of ritiri) {
  const k = `${u.wallet}|${u.conditionId}`;
  if (perChiave.has(k)) perChiave.get(k).ritiri.push(u);
}

const appaiati = [];
for (const [k, v] of perChiave.entries()) {
  const i = v.ingressi.sort((a, b) => a.ts - b.ts)[0];
  const u = v.ritiri.filter((x) => x.ts >= i.ts).sort((a, b) => a.ts - b.ts)[0];
  if (!u) continue;
  appaiati.push({
    wallet: i.wallet, conditionId: i.conditionId, titolo: i.titolo,
    premiante: i.nelProgrammaPremi === true,
    oreAScadenzaIngresso: Number(i.oreAScadenza),
    montepremiGiorno: Number(i.montepremiGiorno),
    tenutaOre: +((u.ts - i.ts) / 3600).toFixed(2),
    orePrimaDellaRisoluzione: Number(u.orePrimaDellaRisoluzione),
    scadenzaAttendibile: i.scadenzaAttendibile === true && u.scadenzaAttendibile !== false,
  });
}

function bucket(arr, nome) {
  const dopo = arr.filter((x) => Number.isFinite(x.orePrimaDellaRisoluzione) && x.orePrimaDellaRisoluzione <= 0);
  const prima = arr.filter((x) => Number.isFinite(x.orePrimaDellaRisoluzione) && x.orePrimaDellaRisoluzione > 0);
  const t = arr.map((x) => x.tenutaOre).filter(Number.isFinite);
  const m = arr.map((x) => x.orePrimaDellaRisoluzione).filter(Number.isFinite);
  return {
    nome, casi: arr.length,
    conMisura: dopo.length + prima.length,
    uscitiDOPOlaRisoluzione: dopo.length,
    fraseDopo: (dopo.length + prima.length) ? +(100 * dopo.length / (dopo.length + prima.length)).toFixed(1) : null,
    tenutaOreMediana: mediana(t), tenutaOreQ1: perc(t, 0.25), tenutaOreQ3: perc(t, 0.75),
    anticipoOreMediano: mediana(m), anticipoOreQ1: perc(m, 0.25), anticipoOreQ3: perc(m, 0.75),
  };
}

const prem = appaiati.filter((x) => x.premiante);
const A = {
  ingressiTotali: ingressi.length, ritiriTotali: ritiri.length, appaiati: appaiati.length,
  appaiatiPremianti: prem.length,
  // La divisione che decide, sulla popolazione che ci riguarda: ingressi PREMIANTI
  bucket: [
    bucket(prem.filter((x) => x.oreAScadenzaIngresso < SOGLIA_ORE), `premianti · ingresso SOTTO ${SOGLIA_ORE} h`),
    bucket(prem.filter((x) => x.oreAScadenzaIngresso >= SOGLIA_ORE), `premianti · ingresso SOPRA ${SOGLIA_ORE} h`),
    bucket(prem.filter((x) => x.oreAScadenzaIngresso < 6), 'premianti · ingresso sotto 6 h'),
    bucket(prem.filter((x) => x.oreAScadenzaIngresso >= 6 && x.oreAScadenzaIngresso < 12), 'premianti · 6–12 h'),
    bucket(prem.filter((x) => x.oreAScadenzaIngresso >= 12 && x.oreAScadenzaIngresso < 18), 'premianti · 12–18 h'),
    bucket(prem.filter((x) => x.oreAScadenzaIngresso >= 18 && x.oreAScadenzaIngresso < 48), 'premianti · 18–48 h'),
    bucket(prem.filter((x) => x.oreAScadenzaIngresso >= 48), 'premianti · oltre 48 h'),
    bucket(appaiati.filter((x) => !x.premiante), 'NON premianti (tutti gli orizzonti)'),
  ],
};

// ══ B · LE NOSTRE POSIZIONI ═════════════════════════════════════════════════════════════════════
const pos = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'venue-positions.json'), 'utf8'));
const board = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'liquidity-rewards.json'), 'utf8'));
const perCond = new Map(board.markets.map((m) => [m.conditionId, m]));
const oraMs = Date.now();
const perMercato = new Map();
for (const p of pos.positions || []) {
  const c = String(p.conditionId || '').toLowerCase();
  if (!perMercato.has(c)) perMercato.set(c, []);
  perMercato.get(c).push(p);
}
const nostre = [];
for (const [cond, gambe] of perMercato.entries()) {
  const m = perCond.get(cond) || [...perCond.values()].find((x) => x.conditionId.toLowerCase() === cond);
  const end = m && m.endDate ? Date.parse(m.endDate) : null;
  nostre.push({
    conditionId: cond, titolo: gambe[0].title,
    gambe: gambe.length, nuda: gambe.length < 2,
    nozionale: +gambe.reduce((s, g) => s + (Number(g.size) || 0) * (Number(g.curPrice) || 0), 0).toFixed(2),
    oreAllaScadenza: end ? +((end - oraMs) / 3_600_000).toFixed(2) : null,
    sulBoard: !!m, minSize: m ? m.rewardsMinSize : null,
  });
}
const conOre = nostre.filter((x) => x.oreAllaScadenza != null);
const B = {
  posizioniGrezze: (pos.positions || []).length,
  mercatiConEsposizione: nostre.length,
  nudi: nostre.filter((x) => x.nuda).length,
  coppieComplete: nostre.filter((x) => !x.nuda).length,
  nozionaleTotale: +nostre.reduce((s, x) => s + x.nozionale, 0).toFixed(2),
  conScadenzaLeggibile: conOre.length,
  fuoriDalBoard: nostre.filter((x) => !x.sulBoard).length,
  sottoSoglia18h: conOre.filter((x) => x.oreAllaScadenza < SOGLIA_ORE).length,
  sopraSoglia18h: conOre.filter((x) => x.oreAllaScadenza >= SOGLIA_ORE).length,
  gia_scaduti: conOre.filter((x) => x.oreAllaScadenza <= 0).length,
  oreMediana: mediana(conOre.map((x) => x.oreAllaScadenza)),
  elenco: nostre.sort((a, b) => (a.oreAllaScadenza ?? 1e9) - (b.oreAllaScadenza ?? 1e9)),
};

// ══ C · I NOSTRI RESIDUI ════════════════════════════════════════════════════════════════════════
const res = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'residui-scoperti.json'), 'utf8'));
const residui = Object.values(res.residui || {});
const sotto = residui.filter((r) => Number(r.size) < Number(r.minSize));
const C = {
  totali: residui.length,
  sottoIlMinimoDelVenue: sotto.length,
  nozionaleBloccato: +residui.reduce((s, r) => s + (Number(r.notionalUsd) || 0), 0).toFixed(2),
  nozionaleSottoMinimo: +sotto.reduce((s, r) => s + (Number(r.notionalUsd) || 0), 0).toFixed(2),
  frazioneDelMinimoMediana: mediana(residui.map((r) => Number(r.size) / Number(r.minSize)).filter(Number.isFinite)),
  perMercato: (() => {
    const m = {};
    for (const r of residui) {
      const c = String(r.marketId).toLowerCase();
      const b = perCond.get(c);
      const ore = b && b.endDate ? (Date.parse(b.endDate) - oraMs) / 3_600_000 : null;
      m[c] = m[c] || { ore, sulBoard: !!b, n: 0 };
      m[c].n++;
    }
    const v = Object.values(m);
    return { mercatiDistinti: v.length, fuoriDalBoard: v.filter((x) => !x.sulBoard).length,
      sotto18h: v.filter((x) => x.ore != null && x.ore < SOGLIA_ORE).length,
      sopra18h: v.filter((x) => x.ore != null && x.ore >= SOGLIA_ORE).length };
  })(),
};

const out = { generatoIso: new Date().toISOString(), sogliaOre: SOGLIA_ORE, A_ventunoMaker: A, B_nostrePosizioni: B, C_nostriResidui: C };
fs.writeFileSync(path.join(RADICE, 'data', 'ricerca', 'orizzonte-brevi-rischio.json'), JSON.stringify(out, null, 1));

console.log(`\n═══ A · I 21 MAKER — ${A.ingressiTotali} ingressi, ${A.ritiriTotali} ritiri, ${A.appaiati} appaiati (${A.appaiatiPremianti} premianti)\n`);
console.log('  bucket                                    casi  uscitiDOPO  %DOPO   tenuta h (Q1·med·Q3)     anticipo h mediano');
for (const b of A.bucket) {
  console.log(`  ${b.nome.padEnd(40)} ${String(b.casi).padStart(4)}  ${String(b.uscitiDOPOlaRisoluzione).padStart(10)}  ${String(b.fraseDopo ?? '—').padStart(5)}   `
    + `${String(b.tenutaOreQ1 ?? '—').padStart(7)} ${String(b.tenutaOreMediana ?? '—').padStart(7)} ${String(b.tenutaOreQ3 ?? '—').padStart(7)}   ${String(b.anticipoOreMediano ?? '—').padStart(8)}`);
}
console.log(`\n═══ B · LE NOSTRE POSIZIONI (nostro: eredita i 4 giorni su 30)\n`);
console.log(`  ${B.posizioniGrezze} gambe su ${B.mercatiConEsposizione} mercati · NUDI ${B.nudi} · coppie complete ${B.coppieComplete} · nozionale $${B.nozionaleTotale}`);
console.log(`  scadenza leggibile ${B.conScadenzaLeggibile}/${B.mercatiConEsposizione} (fuori dal board ${B.fuoriDalBoard}) · sotto ${SOGLIA_ORE} h: ${B.sottoSoglia18h} · sopra: ${B.sopraSoglia18h} · già scaduti: ${B.gia_scaduti} · mediana ${B.oreMediana} h`);
for (const x of B.elenco.slice(0, 25)) console.log(`     ${String(x.oreAllaScadenza ?? '—').padStart(8)} h · ${x.nuda ? 'NUDA' : 'coppia'} · $${String(x.nozionale).padStart(7)} · ${x.sulBoard ? '' : 'FUORI BOARD · '}${String(x.titolo).slice(0, 50)}`);
console.log(`\n═══ C · I NOSTRI RESIDUI\n`);
console.log(`  ${C.totali} residui · ${C.sottoIlMinimoDelVenue} sotto il minimo del venue · $${C.nozionaleBloccato} bloccati ($${C.nozionaleSottoMinimo} nei soli sotto-minimo)`);
console.log(`  frazione del minimo, mediana: ${(100 * C.frazioneDelMinimoMediana).toFixed(1)}%`);
console.log(`  su ${C.perMercato.mercatiDistinti} mercati distinti · fuori dal board ${C.perMercato.fuoriDalBoard} · sotto 18 h ${C.perMercato.sotto18h} · sopra ${C.perMercato.sopra18h}`);
console.log('\nscritto in data/ricerca/orizzonte-brevi-rischio.json\n');

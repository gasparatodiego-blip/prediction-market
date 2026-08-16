#!/usr/bin/env node
'use strict';
// scripts/ricerca/censimento-109-fase1.js — CHI HA TOCCATO I MERCATI PREMIANTI DEL BOARD, IN 14 GIORNI.
//
// Fase 1 di due: il CENSIMENTO. Scandisce i mercati premianti veri del board (`rewardsDailyRate`
// sopra la soglia di agent24) con `GET /trades?market=<conditionId>`, che filtra davvero — verificato
// contro `conditionId=` e `condition_id=`, che NON filtrano e restituirebbero i trade di tutti.
//
// Serve a rispondere prima di tutto a una domanda di fattibilità: **quanti wallet sono**. Il profilo
// completo di ogni wallet (fase 2) costa diverse chiamate a testa, quindi la popolazione va misurata
// prima di prometterla.
//
// SOLA LETTURA. Nessun ordine, nessuna firma, nessuna transazione.
//
// ⚠ IL TETTO DI OFFSET VALE ANCHE QUI: `/trades` si ferma a offset 10.000. Su un mercato molto
// scambiato i 14 giorni non entrano, e la copertura viene DICHIARATA per mercato invece di essere
// spacciata per completa.

const { apiGet, inParallelo, scrivi, contatore } = require('./screening-lib');
const fs = require('fs');
const path = require('path');

const argomenti = process.argv.slice(2);
const arg = (n, d) => { const i = argomenti.indexOf(n); return i >= 0 ? Number(argomenti[i + 1]) : d; };
const GIORNI = arg('--giorni', 14);
const PER_PAGINA = 500;
const TETTO_OFFSET = 10_000;
const PAGINE_MAX = Math.floor(TETTO_OFFSET / PER_PAGINA);

const normId = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
function numero(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '') { const v = Number(x); return Number.isFinite(v) ? v : null; }
  return null;
}

/** I mercati premianti VERI del board: stessa soglia con cui agent24 li tiene (`rate > 0.01`). */
function mercatiPremianti() {
  const b = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'liquidity-rewards.json'), 'utf8'));
  return (b.markets || []).filter((m) => Number(m.rewardsDailyRate) > 0.01);
}

async function trader(cid, daTs) {
  const perWallet = new Map();
  let pagine = 0, piuVecchio = Infinity, coperto = false, righe = 0;
  for (let p = 0; p < PAGINE_MAX; p += 1) {
    const r = await apiGet(`/trades?market=${cid}&takerOnly=false&limit=${PER_PAGINA}&offset=${p * PER_PAGINA}`);
    if (!r.ok || !Array.isArray(r.dati)) return { ok: false, errore: r.errore || 'non lista', perWallet, pagine, coperto };
    pagine += 1; righe += r.dati.length;
    for (const t of r.dati) {
      const ts = numero(t.timestamp);
      if (ts === null) continue;
      if (ts < piuVecchio) piuVecchio = ts;
      if (ts < daTs) continue;
      const w = normId(t.proxyWallet);
      if (!w) continue;
      const size = numero(t.size), prezzo = numero(t.price);
      if (!perWallet.has(w)) perWallet.set(w, { fill: 0, usd: 0, primo: ts, ultimo: ts });
      const q = perWallet.get(w);
      q.fill += 1;
      if (size !== null && prezzo !== null) q.usd += size * prezzo;
      if (ts < q.primo) q.primo = ts;
      if (ts > q.ultimo) q.ultimo = ts;
    }
    if (r.dati.length < PER_PAGINA) { coperto = true; break; }
    if (piuVecchio <= daTs) { coperto = true; break; }
  }
  return { ok: true, perWallet, pagine, righe, coperto, piuVecchio };
}

async function principale() {
  const adesso = Date.now();
  const daTs = Math.floor(adesso / 1000) - GIORNI * 86400;
  const mercati = mercatiPremianti();
  console.log(`censimento dei mercati premianti del board — ${mercati.length} mercati, finestra ${GIORNI} giorni\n`);

  const globale = new Map();     // wallet → { fill, usd, mercati:Set }
  const perMercato = [];
  let fatti = 0;

  await inParallelo(mercati, 5, async (m) => {
    const cid = normId(m.conditionId);
    const r = await trader(cid, daTs);
    fatti += 1;
    if (fatti % 10 === 0) console.log(`  … ${fatti}/${mercati.length} mercati · ${globale.size} wallet finora`);
    if (!r.ok) { perMercato.push({ conditionId: cid, question: m.question, ok: false, errore: r.errore }); return null; }
    for (const [w, q] of r.perWallet) {
      if (!globale.has(w)) globale.set(w, { fill: 0, usd: 0, mercati: new Set(), primo: q.primo, ultimo: q.ultimo });
      const g = globale.get(w);
      g.fill += q.fill; g.usd += q.usd; g.mercati.add(cid);
      if (q.primo < g.primo) g.primo = q.primo;
      if (q.ultimo > g.ultimo) g.ultimo = q.ultimo;
    }
    perMercato.push({ conditionId: cid, question: m.question, minSize: numero(m.rewardsMinSize),
      maxSpread: numero(m.rewardsMaxSpread), rate: numero(m.rewardsDailyRate),
      depth: numero(m.existing_depth_usd), endDate: m.endDate,
      wallet: r.perWallet.size, fill: r.righe, pagine: r.pagine,
      // ⚠ `coperto:false` = i 14 giorni NON entrano nelle pagine concesse: i wallet di quel mercato
      // sono un SOTTOINSIEME, non l'elenco. Va detto, o il censimento sembra completo e non lo è.
      copertura14g: r.coperto, ok: true });
    return null;
  });

  const righe = [...globale.entries()].map(([w, g]) => ({
    wallet: w, fill: g.fill, usdScambiati: Math.round(g.usd * 100) / 100,
    mercati: g.mercati.size, mercatiElenco: [...g.mercati],
    primo: g.primo, ultimo: g.ultimo,
  })).sort((a, b) => b.mercati - a.mercati || b.fill - a.fill);

  const nonCoperti = perMercato.filter((m) => m.ok && !m.copertura14g).length;
  const falliti = perMercato.filter((m) => !m.ok).length;

  const out = {
    generatoIl: new Date(adesso).toISOString(), giorni: GIORNI,
    mercatiPremianti: mercati.length, mercatiScanditi: perMercato.length,
    mercatiSenzaCopertura14g: nonCoperti, mercatiFalliti: falliti,
    walletTotali: righe.length,
    chiamate: { api: contatore.api, ritentate: contatore.ritentate, errori: contatore.errori },
    perMercato: perMercato.sort((a, b) => (b.wallet || 0) - (a.wallet || 0)),
    wallet: righe,
  };
  const f = scrivi('censimento-109-fase1.json', out);

  console.log(`\n${'═'.repeat(90)}`);
  console.log(`POPOLAZIONE: ${righe.length.toLocaleString('it-IT')} wallet distinti su ${mercati.length} mercati premianti`);
  console.log('═'.repeat(90));
  console.log(`  mercati la cui finestra di ${GIORNI} g NON è coperta dalle pagine: ${nonCoperti}  ⇒ per quelli l'elenco è un sottoinsieme`);
  console.log(`  mercati falliti: ${falliti}`);
  const perNMercati = {};
  for (const r of righe) { const k = r.mercati >= 10 ? '10+' : String(r.mercati); perNMercati[k] = (perNMercati[k] || 0) + 1; }
  console.log('\n  wallet per numero di mercati toccati:');
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10+']) {
    if (perNMercati[k]) console.log(`    ${k.padStart(3)} mercati ⇒ ${String(perNMercati[k]).padStart(6)} wallet`);
  }
  console.log(`\n  ≥2 mercati : ${righe.filter((r) => r.mercati >= 2).length.toLocaleString('it-IT')}`);
  console.log(`  ≥3 mercati : ${righe.filter((r) => r.mercati >= 3).length.toLocaleString('it-IT')}`);
  console.log(`  ≥5 mercati : ${righe.filter((r) => r.mercati >= 5).length.toLocaleString('it-IT')}`);
  console.log(`\n→ ${f}`);
}

principale().catch((e) => { console.error('\nGUASTO: ' + (e && e.stack || e)); process.exitCode = 1; });

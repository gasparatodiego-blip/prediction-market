#!/usr/bin/env node
'use strict';
// scripts/wallet-affini.js — CHI FA DAVVERO IL NOSTRO MESTIERE, E COME.
//
// SOLA LETTURA. Non importa nessuna superficie di piazzamento o cancellazione, non usa credenziali:
// l'unica rete è `data-api.polymarket.com`, endpoint pubblici.
//
// ═══ L'ERRORE CHE QUESTO SCRIPT ESISTE PER NON RIFARE ══════════════════════════════════════════════
// In passato si sono presi wallet dalla classifica PolyRewards e si è scoperto DOPO che il 91% della
// loro attività era spread capture sportivo, non reward. Qui il filtro è A MONTE: si misura l'INTERA
// attività pubblica del wallet — non solo quella sui nostri mercati — e si scarta prima di guardare
// come opera. Un wallet che non passa il filtro non compare nelle statistiche del passo 2.
//
// ═══ LE TRE FONTI ══════════════════════════════════════════════════════════════════════════════════
//   · `data-api/activity?user=<w>`      → attività del wallet: TRADE, MERGE, REDEEM, CONVERSION…
//   · `data/history/rewards-poly/*`     → 32 giorni di board: quali mercati AVEVANO montepremi,
//                                          con `dailyPool` ed `endDate` — nessuna chiamata di rete
//   · `lib/rewards/categoria-mercato`   → la categoria, con il classificatore già nel repo
//
// Uso: node scripts/wallet-affini.js [--pagine 8]

const fs = require('fs');
const path = require('path');

const RADICE = path.join(__dirname, '..');
const { categoriaDi } = require(path.join(RADICE, 'lib', 'rewards', 'categoria-mercato.js'));

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PAGINE = Number(arg('--pagine', '8'));
const LIMITE = 500;

// ── 1 · IL MONDO DEI MERCATI PREMIANTI, dai 32 giorni di board già sul server ────────────────────
// Un mercato «con montepremi» è un mercato che è comparso sul board reward. È un PROXY, e il suo
// limite va detto: il board tiene i primi N per montepremi, quindi un mercato premiante che non è mai
// entrato nel taglio risulta qui «senza montepremi». L'errore va nella direzione di SOTTOSTIMARE la
// quota di attività premiante di un wallet — cioè è conservativo per il filtro.
function mondoPremiante() {
  const pool = new Map(); const fine = new Map(); const banda = new Map();
  const dir = path.join(RADICE, 'data', 'history', 'rewards-poly');
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const snap of (Array.isArray(j) ? j : [])) {
      for (const r of (snap.rows || [])) {
        const id = String(r.id || '').toLowerCase(); if (!id) continue;
        if (Number.isFinite(Number(r.dailyPool))) pool.set(id, Number(r.dailyPool));
        if (r.endDate) fine.set(id, r.endDate);
        if (Number.isFinite(Number(r.maxSpread))) banda.set(id, Number(r.maxSpread));
      }
    }
  }
  return { pool, fine, banda };
}

// ── 2 · L'ATTIVITÀ DI UN WALLET ──────────────────────────────────────────────────────────────────
async function attivita(w) {
  const righe = [];
  for (let p = 0; p < PAGINE; p++) {
    let j;
    try {
      const r = await fetch(`https://data-api.polymarket.com/activity?user=${w}&limit=${LIMITE}&offset=${p * LIMITE}`, { signal: AbortSignal.timeout(25000) });
      if (!r.ok) break;
      j = await r.json();
    } catch { break; }
    const a = Array.isArray(j) ? j : (j.data || []);
    righe.push(...a);
    if (a.length < LIMITE) break;
  }
  return righe;
}

const mediana = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

// ── 3 · IL PROFILO DI UN WALLET ──────────────────────────────────────────────────────────────────
function profila(w, righe, mondo) {
  const tipi = {};
  const perMercato = new Map();     // conditionId → { buy, sell, perLato:Map, categoria, premiante }
  const usdTrade = [];
  const cat = {};
  let primoTs = null; let ultimoTs = null;

  for (const r of righe) {
    const t = String(r.type || '?');
    tipi[t] = (tipi[t] || 0) + 1;
    const ts = Number(r.timestamp) * 1000;
    if (Number.isFinite(ts)) { if (primoTs == null || ts < primoTs) primoTs = ts; if (ultimoTs == null || ts > ultimoTs) ultimoTs = ts; }
    const id = String(r.conditionId || '').toLowerCase();
    if (!id) continue;
    if (!perMercato.has(id)) {
      const c = categoriaDi({ title: r.title, slug: r.slug, eventSlug: r.eventSlug, question: r.title });
      perMercato.set(id, { buy: 0, sell: 0, perLato: new Map(), categoria: (c && (c.categoria || c)) || 'altro',
        premiante: mondo.pool.has(id), trade: 0, redeem: 0, merge: 0, primo: ts, ultimo: ts });
    }
    const m = perMercato.get(id);
    if (Number.isFinite(ts)) { if (ts < m.primo) m.primo = ts; if (ts > m.ultimo) m.ultimo = ts; }
    const usd = Number(r.usdcSize);
    if (t === 'TRADE') {
      m.trade += 1;
      if (Number.isFinite(usd) && usd > 0) {
        usdTrade.push(usd);
        if (String(r.side).toUpperCase() === 'SELL') m.sell += usd; else m.buy += usd;
        const k = String(r.outcomeIndex ?? r.outcome ?? '?');
        m.perLato.set(k, (m.perLato.get(k) || 0) + usd);
      }
      cat[m.categoria] = (cat[m.categoria] || 0) + 1;
    } else if (t === 'REDEEM') m.redeem += 1;
    else if (t === 'MERGE' || t === 'CONVERSION') m.merge += 1;
  }

  const mercati = [...perMercato.values()];
  const conTrade = mercati.filter((m) => m.trade > 0);
  const premianti = conTrade.filter((m) => m.premiante);
  const tradePremiantiFrac = conTrade.length ? premianti.length / conTrade.length : null;

  // Simmetria: per ogni mercato con entrambi i lati, rapporto fra il lato piccolo e il grande.
  const rapporti = [];
  let dueLati = 0;
  for (const m of conTrade) {
    const v = [...m.perLato.values()].sort((a, b) => b - a);
    if (v.length >= 2 && v[0] > 0) { dueLati += 1; rapporti.push(v[1] / v[0]); }
    else if (m.buy > 0 && m.sell > 0) { dueLati += 1; rapporti.push(Math.min(m.buy, m.sell) / Math.max(m.buy, m.sell)); }
  }
  const dueLatiFrac = conTrade.length ? dueLati / conTrade.length : null;

  // Chiusura attiva contro risoluzione.
  const chiusureAttive = mercati.reduce((s, m) => s + m.merge, 0) + mercati.filter((m) => m.sell > 0).length;
  const risoluzioni = mercati.reduce((s, m) => s + m.redeem, 0);
  const chiudeFrac = (chiusureAttive + risoluzioni) > 0 ? chiusureAttive / (chiusureAttive + risoluzioni) : null;

  // Orizzonte e pool dei mercati premianti toccati.
  const orizzonti = []; const pools = []; const bande = [];
  for (const [id, m] of perMercato) {
    if (!m.premiante || !m.trade) continue;
    const p = mondo.pool.get(id); if (Number.isFinite(p)) pools.push(p);
    const b = mondo.banda.get(id); if (Number.isFinite(b)) bande.push(b);
    const e = mondo.fine.get(id);
    if (e && Number.isFinite(m.primo)) {
      const h = (Date.parse(e) - m.primo) / 3_600_000;
      if (Number.isFinite(h) && h > 0 && h < 24 * 400) orizzonti.push(h);
    }
  }

  // Mercati contemporanei: distinti per giorno solare, mediana sui giorni osservati.
  const perGiorno = new Map();
  for (const r of righe) {
    if (String(r.type) !== 'TRADE') continue;
    const ts = Number(r.timestamp) * 1000; if (!Number.isFinite(ts)) continue;
    const g = new Date(ts).toISOString().slice(0, 10);
    if (!perGiorno.has(g)) perGiorno.set(g, new Set());
    perGiorno.get(g).add(String(r.conditionId || '').toLowerCase());
  }
  const contemporanei = [...perGiorno.values()].map((s) => s.size);

  // Capitale osservato: esposizione netta ancora aperta per mercato, sommata. È un PROXY limitato
  // dalla finestra: se la finestra taglia a metà un ciclo compra-vendi, il netto è sovrastimato.
  let nettoAperto = 0;
  for (const m of conTrade) nettoAperto += Math.max(0, m.buy - m.sell);

  return {
    wallet: w, righe: righe.length, tipi,
    finestraDaIso: primoTs ? new Date(primoTs).toISOString() : null,
    finestraAIso: ultimoTs ? new Date(ultimoTs).toISOString() : null,
    finestraOre: (primoTs && ultimoTs) ? +((ultimoTs - primoTs) / 3_600_000).toFixed(1) : null,
    mercatiConTrade: conTrade.length, mercatiPremianti: premianti.length,
    tradePremiantiFrac: tradePremiantiFrac != null ? +tradePremiantiFrac.toFixed(3) : null,
    dueLatiFrac: dueLatiFrac != null ? +dueLatiFrac.toFixed(3) : null,
    rapportoMediano: rapporti.length ? +mediana(rapporti).toFixed(3) : null,
    chiudeFrac: chiudeFrac != null ? +chiudeFrac.toFixed(3) : null,
    chiusureAttive, risoluzioni,
    sizeMediana: usdTrade.length ? +mediana(usdTrade).toFixed(2) : null,
    sizeP90: usdTrade.length ? +[...usdTrade].sort((a, b) => a - b)[Math.floor(usdTrade.length * 0.9)].toFixed(2) : null,
    categorie: cat,
    poolMediano: pools.length ? +mediana(pools).toFixed(0) : null,
    orizzonteMedianoOre: orizzonti.length ? +mediana(orizzonti).toFixed(1) : null,
    bandaMediana: bande.length ? +mediana(bande).toFixed(2) : null,
    contemporaneiMediana: contemporanei.length ? mediana(contemporanei) : null,
    contemporaneiMax: contemporanei.length ? Math.max(...contemporanei) : null,
    nettoApertoUsd: +nettoAperto.toFixed(0),
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
(async () => {
  const mondo = mondoPremiante();
  const d = JSON.parse(fs.readFileSync(path.join(RADICE, 'docs', 'analisi-concorrenti-dati.json'), 'utf8'));

  // La lista di partenza: chi il documento di oggi ha classificato MM, più i ricorrenti per nome.
  const RICORRENTI = ['.liquidity.farm', 'rewardcleaner', 'friendlyreward', 'Mysaria', 'IngressDefender'];
  const cand = new Map();
  for (const m of d.mercati) {
    for (const w of (m.wallet || [])) {
      const perche = w.mm ? 'MM a due lati sui nostri mercati' : (RICORRENTI.some((r) => String(w.nome || '').includes(r)) ? 'nome ricorrente' : null);
      if (!perche) continue;
      if (!cand.has(w.wallet)) cand.set(w.wallet, { wallet: w.wallet, nome: w.nome, perche, presenze: 0 });
      cand.get(w.wallet).presenze += 1;
    }
  }
  console.log(`candidati di partenza: ${cand.size} wallet distinti\n`);

  const profili = [];
  let i = 0;
  for (const c of cand.values()) {
    i += 1;
    process.stdout.write(`  [${i}/${cand.size}] ${c.wallet.slice(0, 12)}… ${(c.nome || '').slice(0, 16).padEnd(17)}`);
    const righe = await attivita(c.wallet);
    const p = profila(c.wallet, righe, mondo);
    p.nome = c.nome; p.perche = c.perche; p.presenzeNostriMercati = c.presenze;
    profili.push(p);
    console.log(` ${String(p.righe).padStart(5)} righe · premianti ${p.tradePremiantiFrac ?? '—'} · dueLati ${p.dueLatiFrac ?? '—'} · chiude ${p.chiudeFrac ?? '—'}`);
  }

  // ── IL FILTRO, A MONTE ─────────────────────────────────────────────────────────────────────────
  // Passa chi ha la MAGGIORANZA dell'attività su mercati con montepremi E la maggioranza dei mercati
  // quotati a due lati. Le due condizioni sono congiunte: la prima esclude lo spread capture sportivo
  // (l'errore del passato), la seconda esclude il direzionale.
  for (const p of profili) {
    const motivi = [];
    if (!(p.tradePremiantiFrac > 0.5)) motivi.push(`solo ${((p.tradePremiantiFrac ?? 0) * 100).toFixed(0)}% dei mercati con montepremi`);
    if (!(p.dueLatiFrac > 0.5)) motivi.push(`solo ${((p.dueLatiFrac ?? 0) * 100).toFixed(0)}% dei mercati a due lati`);
    p.passa = motivi.length === 0;
    p.motivoScarto = motivi.join(' · ') || null;
  }

  const dentro = profili.filter((p) => p.passa).sort((a, b) => b.tradePremiantiFrac - a.tradePremiantiFrac);
  const fuori = profili.filter((p) => !p.passa);

  fs.writeFileSync(path.join(RADICE, 'docs', 'wallet-affini-dati.json'),
    JSON.stringify({ generatoIso: new Date().toISOString(), pagineMax: PAGINE, candidati: cand.size, dentro, fuori }, null, 1));

  console.log(`\n═══ FILTRO ═══  dentro ${dentro.length} · fuori ${fuori.length} (su ${profili.length})\n`);
  console.log('wallet'.padEnd(16), 'nome'.padEnd(18), 'prem.'.padStart(6), '2lati'.padStart(6), 'chiude'.padStart(7), 'size~'.padStart(7), 'pool~'.padStart(6), 'oriz.h'.padStart(7), 'merc/g'.padStart(7));
  for (const p of dentro) {
    console.log(p.wallet.slice(0, 14).padEnd(16), String(p.nome || '—').slice(0, 17).padEnd(18),
      String(p.tradePremiantiFrac).padStart(6), String(p.dueLatiFrac).padStart(6), String(p.chiudeFrac).padStart(7),
      ('$' + p.sizeMediana).padStart(7), ('$' + p.poolMediano).padStart(6),
      String(p.orizzonteMedianoOre ?? '—').padStart(7), String(p.contemporaneiMediana ?? '—').padStart(7));
  }
  console.log('\nSCARTATI:');
  for (const p of fuori) console.log('  ', p.wallet.slice(0, 14) + '…', String(p.nome || '—').slice(0, 18).padEnd(19), p.motivoScarto);
  console.log('\ndati completi in docs/wallet-affini-dati.json\n');
})();

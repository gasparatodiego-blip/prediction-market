#!/usr/bin/env node
'use strict';
// scripts/ricalcola-stima-integrata.js — RICALCOLA A RITROSO LA STIMA COME QUANTITÀ.
//
// Applica Σ(tasso × durata) alle giornate già chiuse, per le quali NON esistono campioni vivi: il
// campionatore di agent40 è nato il 12 agosto 2026, e prima di allora l'unico numero registrato era la
// fotografia delle 23:55. Qui i campioni si RICOSTRUISCONO da due fonti che esistono davvero:
//
//   · `data/history/rewards-poly/<giorno>.json` — 34 istantanee del board al giorno (una ogni ~42 min),
//     ognuna con `dailyPool`, `maxSpread`, `minSize`, `mid` e `levels` per ~115 mercati;
//   · `data/execution-audit.jsonl` — ogni ordine inviato, con istante, mercato (token), prezzo e size.
//
// ═══ COME SI RICOSTRUISCE IL TASSO A UN ISTANTE ════════════════════════════════════════════════════
// 1. CAPITALE IN BANDA. Un ordine vive dalla sua conferma per la finestra GTD del venue
//    (`RESTING_GTD_SECONDS` = 23 min, letto dal modulo, non ricopiato). Il ciclo di riprezzo sostituisce
//    la stessa gamba di continuo, quindi per ogni (mercato, book, lato) vale SOLO l'ultimo invio
//    precedente all'istante: sommarli tutti conterebbe più volte la stessa gamba.
// 2. PARAMETRI DEL MERCATO. Dall'istantanea del board immediatamente precedente.
// 3. IL TASSO. Con la matematica del repo, non con una formula nuova: `recoverCompetitorQ` per la
//    concorrenza e `estimateCapitalLevel` per il $/giorno al nostro capitale.
//    UNA INVERSIONE DICHIARATA: `recoverCompetitorQ` vuole `levels[C].share`, che le righe storiche non
//    portano; portano `netRewardDay`. Si ricava `share = netRewardDay / dailyPool`. È l'unico passaggio
//    che non è già nel percorso vivo, ed è aritmetica sulla definizione stessa di quota.
//
// ═══ IL LIMITE, DICHIARATO E NON AGGIRATO ══════════════════════════════════════════════════════════
// `execution-audit` indicizza per TOKEN, lo storico del board per `conditionId`, e la mappa fra i due si
// ricostruisce solo per i mercati ancora presenti da qualche parte (catalogo di ripiego, board, o la
// scomposizione per mercato già salvata nel registro reward). Misurato: **48-63% del nozionale** a
// seconda del giorno. Il nozionale non mappato NON viene stimato e NON viene scalato: la cifra che esce
// è quindi un **limite inferiore**, e lo script lo stampa e lo scrive (`nozionaleMappatoFrac`).
// Inventare un fattore di scala per «completare» il numero sarebbe esattamente il genere di ottimismo
// che questo lavoro esiste per togliere.
//
// Uso:
//   node scripts/ricalcola-stima-integrata.js                    # anteprima, non scrive
//   node scripts/ricalcola-stima-integrata.js --esegui           # scrive nel registro reward
//   node scripts/ricalcola-stima-integrata.js --da 2026-08-06 --a 2026-08-11

const fs = require('fs');
const path = require('path');

const RADICE = path.join(__dirname, '..');
const { recoverCompetitorQ, estimateCapitalLevel } = require(path.join(RADICE, 'lib', 'rewardScore.js'));
const { RESTING_GTD_SECONDS } = require(path.join(RADICE, 'lib', 'maker', 'auto-reprice-config.js'));
const { integra } = require(path.join(RADICE, 'lib', 'maker', 'stima-integrata.js'));
const { registraStimaIntegrata, leggiConfronto } = require(path.join(RADICE, 'lib', 'maker', 'confronto-reward.js'));

const GTD_MS = RESTING_GTD_SECONDS * 1000;
const PASSO_GRIGLIA_MS = 5 * 60_000;   // lo stesso passo del campionatore vivo
const GIORNO_MS = 86_400_000;

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ESEGUI = process.argv.includes('--esegui');
const DA = arg('--da', '2026-08-06');
const A = arg('--a', '2026-08-11');

// ── LA MAPPA TOKEN → MERCATO, da ogni fonte che ce l'abbia ────────────────────────────────────────
function mappaToken() {
  const m = new Map();
  const metti = (t, cid) => { if (t && cid) m.set(String(t), String(cid).toLowerCase()); };
  try {
    const cat = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'maker-manual-markets.json'), 'utf8'));
    for (const [cid, r] of Object.entries(cat.markets || cat)) { metti(r && r.tokenId, cid); metti(r && r.tokenIdNo, cid); }
  } catch { /* assente */ }
  for (const f of ['/tmp/liquidity-rewards.json', path.join(RADICE, 'data', 'liquidity-rewards.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const r of (Array.isArray(j) ? j : (j.markets || []))) { const cid = r.marketId || r.conditionId; metti(r.tokenId, cid); metti(r.tokenIdNo, cid); }
    } catch { /* assente */ }
  }
  return m;
}

// ── GLI INVII DI UNA GIORNATA ─────────────────────────────────────────────────────────────────────
function inviiDi(giorno, mappa) {
  const t0 = Date.parse(`${giorno}T00:00:00.000Z`);
  const t1 = t0 + GIORNO_MS;
  const invii = []; let nozTot = 0; let nozMappato = 0;
  const okPerChiave = new Set();
  // Prima passata: gli esiti riusciti, per non contare un ordine rifiutato come capitale a riposo.
  const righe = fs.readFileSync(path.join(RADICE, 'data', 'execution-audit.jsonl'), 'utf8').split('\n');
  for (const l of righe) {
    if (!l.trim()) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.kind === 'outcome' && j.ok === true && j.idempotencyKey) okPerChiave.add(j.idempotencyKey);
  }
  for (const l of righe) {
    if (!l.trim()) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.kind !== 'intent' || !Number.isFinite(j.ts) || j.ts < t0 || j.ts >= t1) continue;
    if (j.idempotencyKey && !okPerChiave.has(j.idempotencyKey)) continue;   // rifiutato: non è mai stato a riposo
    const noz = Number(j.notionalUsd);
    if (!Number.isFinite(noz) || noz <= 0) continue;
    nozTot += noz;
    const cid = mappa.get(String(j.market));
    if (!cid) continue;
    nozMappato += noz;
    const d = j.decision || {};
    invii.push({ t: j.ts, cid, chiave: `${cid}|${d.book || '?'}|${d.side || '?'}`, noz });
  }
  invii.sort((a, b) => a.t - b.t);
  return { invii, nozTot, nozMappato };
}

// ── IL CAPITALE IN BANDA PER MERCATO A UN ISTANTE ────────────────────────────────────────────────
function capitaleA(invii, T) {
  const ultimo = new Map();   // chiave gamba → invio più recente ancora vivo
  for (const o of invii) {
    if (o.t > T) break;
    if (T - o.t >= GTD_MS) { ultimo.delete(o.chiave); continue; }
    ultimo.set(o.chiave, o);
  }
  const perMercato = new Map();
  for (const o of ultimo.values()) {
    if (T - o.t >= GTD_MS) continue;
    perMercato.set(o.cid, (perMercato.get(o.cid) || 0) + o.noz);
  }
  return perMercato;
}

// ── IL TASSO DI UN MERCATO, con la matematica del repo ───────────────────────────────────────────
function tassoMercato(riga, capitale) {
  if (!riga || !(capitale > 0)) return 0;
  const pool = Number(riga.dailyPool);
  const v = Number(riga.maxSpread);
  const minSize = Number(riga.minSize);
  const mid = Number(riga.mid);
  if (!Number.isFinite(pool) || pool <= 0 || !Number.isFinite(v) || v <= 0 || !Number.isFinite(mid)) return null;
  // L'inversione dichiarata: share = netRewardDay / pool.
  const levels = {};
  for (const C of ['500', '5000', '50000']) {
    const lv = riga.levels && riga.levels[C];
    const nrd = lv && Number(lv.netRewardDay);
    if (Number.isFinite(nrd) && nrd > 0) levels[C] = { share: Math.min(0.999999, nrd / pool) };
  }
  const q = recoverCompetitorQ(levels, mid, v, minSize);
  if (q == null) return null;
  // ── IL LIMITE DI PROFONDITÀ, la stessa regola di `estimateAtCapital` ─────────────────────────────
  // «Nel book ci sono meno dollari di liquidità premiante del tuo capitale» ⇒ si prezza sulla
  // profondità, non sul capitale. Senza questo passo la ricostruzione sovrastima proprio dove il book
  // è sottile, che è il caso che il tetto di credibilità esiste per correggere.
  const prof = Number(riga.existingLiquidityUsd);
  const prezzato = (Number.isFinite(prof) && prof >= 0 && prof < capitale) ? prof : capitale;
  // `estimateCapitalLevelRange` vuole la concorrenza come OGGETTO `{Qmin, mid}`, non come numero:
  // `recoverCompetitorQ` restituisce il solo Q, quindi va ricomposto qui.
  const est = estimateCapitalLevel({ Qmin: q, mid }, v, minSize, pool, prezzato);
  // LORDO, non netto: la grandezza del percorso vivo è `estGrossUsdPerDay` (`buildSummary`), e
  // confrontare un netto ricostruito con un lordo campionato mescolerebbe due serie.
  const r = est && Number.isFinite(est.grossRewardDay) ? est.grossRewardDay : null;
  return Number.isFinite(r) ? r : null;
}

function istantanee(giorno) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'history', 'rewards-poly', `${giorno}.json`), 'utf8'));
    return (Array.isArray(j) ? j : []).filter((s) => Number.isFinite(s.t) && Array.isArray(s.rows)).sort((a, b) => a.t - b.t);
  } catch { return []; }
}

function giorniFra(da, a) {
  const out = []; let t = Date.parse(`${da}T00:00:00Z`); const fine = Date.parse(`${a}T00:00:00Z`);
  while (t <= fine) { out.push(new Date(t).toISOString().slice(0, 10)); t += GIORNO_MS; }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
const mappa = mappaToken();
const vecchio = new Map((leggiConfronto().giorni || []).map((g) => [g.giorno, g]));
const risultati = [];

for (const giorno of giorniFra(DA, A)) {
  const snaps = istantanee(giorno);
  const { invii, nozTot, nozMappato } = inviiDi(giorno, mappa);
  const t0 = Date.parse(`${giorno}T00:00:00.000Z`);
  const fine = Math.min(t0 + GIORNO_MS, Date.now());

  const campioni = [];
  let nonScorabili = 0;
  for (let T = t0; T < fine; T += PASSO_GRIGLIA_MS) {
    const cap = capitaleA(invii, T);
    if (!cap.size) { campioni.push({ t: T, r: 0 }); continue; }   // sappiamo che non c'era capitale: è uno ZERO VERO
    let snap = null;
    for (const s of snaps) { if (s.t <= T) snap = s; else break; }
    if (!snap) { continue; }                                       // nessuna istantanea ancora: buco dichiarato
    const perId = new Map(snap.rows.map((r) => [String(r.id).toLowerCase(), r]));
    let tot = 0; let qualcunoIgnoto = false;
    for (const [cid, c] of cap) {
      const r = tassoMercato(perId.get(cid), c);
      if (r == null) { qualcunoIgnoto = true; continue; }
      tot += r;
    }
    if (qualcunoIgnoto) nonScorabili += 1;
    campioni.push({ t: T, r: tot });
  }

  // L'integrale con la STESSA funzione del percorso vivo: nessuna seconda aritmetica.
  const res = integra({ giorno, campioni, now: Date.now() });
  const v = vecchio.get(giorno) || {};
  risultati.push({
    giorno,
    stimaVecchia: Number.isFinite(v.stimaUsd) ? v.stimaUsd : null,
    reale: Number.isFinite(v.realeUsd) ? v.realeUsd : null,
    scartoVecchio: Number.isFinite(v.percentuale) ? v.percentuale : null,
    integrata: res.usd, copertura: res.coperturaFrazione, campioni: res.campioni, completo: res.completo,
    nozTot, nozMappato, nozFrac: nozTot > 0 ? nozMappato / nozTot : null,
    istantanee: snaps.length, nonScorabili,
  });
}

// ── LA TABELLA ────────────────────────────────────────────────────────────────────────────────────
const f2 = (x) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : '—');
const pc = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(0)}%` : '—');
console.log(`\n${ESEGUI ? 'RICALCOLO ESEGUITO' : 'ANTEPRIMA (nessuna scrittura — usa --esegui)'}  ·  griglia ${PASSO_GRIGLIA_MS / 60000} min  ·  GTD ${GTD_MS / 60000} min\n`);
console.log('giorno       stima VECCHIA   stima INTEGRATA   reale      scarto VECCHIO   scarto NUOVO   copertura  camp.  nozionale mappato');
console.log('─'.repeat(132));
for (const r of risultati) {
  const nuovo = (Number.isFinite(r.integrata) && Number.isFinite(r.reale) && r.reale !== 0)
    ? ((r.integrata - r.reale) / Math.abs(r.reale)) * 100 : null;
  console.log(
    `${r.giorno}   ${f2(r.stimaVecchia).padStart(11)}   ${f2(r.integrata).padStart(15)}   ${f2(r.reale).padStart(8)}`
    + `   ${pc(r.scartoVecchio).padStart(14)}   ${pc(nuovo).padStart(12)}`
    + `   ${Number.isFinite(r.copertura) ? (r.copertura * 100).toFixed(0) + '%' : '—'}`.padEnd(13)
    + `${String(r.campioni).padStart(5)}  ${r.nozFrac == null ? '—' : (r.nozFrac * 100).toFixed(0) + '%'}`);
}

// I due aggregati vanno calcolati sullo STESSO insieme di giornate, altrimenti «prima» e «dopo» non
// sono confrontabili: il +465,84% storico è misurato sulle 5 giornate che avevano una fotografia E un
// consuntivo, e il 9 agosto non è fra quelle (la stima non fu mai registrata).
const stesseGiornate = risultati.filter((r) => Number.isFinite(r.stimaVecchia) && Number.isFinite(r.reale));
const sV = stesseGiornate.reduce((s, r) => s + r.stimaVecchia, 0);
const sN = stesseGiornate.reduce((s, r) => s + (r.integrata || 0), 0);
const sR = stesseGiornate.reduce((s, r) => s + r.reale, 0);
console.log('─'.repeat(132));
console.log(`TOTALE       ${f2(sV).padStart(11)}   ${f2(sN).padStart(15)}   ${f2(sR).padStart(8)}`
  + `   ${pc(sR ? ((sV - sR) / sR) * 100 : null).padStart(14)}   ${pc(sR ? ((sN - sR) / sR) * 100 : null).padStart(12)}`
  + `   ← ${stesseGiornate.length} giornate confrontabili, le stesse del +465,84% storico`);
const tutte = risultati.filter((r) => Number.isFinite(r.reale));
const tN = tutte.reduce((s, r) => s + (r.integrata || 0), 0);
const tR = tutte.reduce((s, r) => s + r.reale, 0);
console.log(`  e su TUTTE le ${tutte.length} giornate con consuntivo: integrata ${f2(tN)} contro reale ${f2(tR)} ⇒ ${pc(tR ? ((tN - tR) / tR) * 100 : null)}`);

if (ESEGUI) {
  for (const r of risultati) {
    if (!Number.isFinite(r.integrata)) continue;
    const w = registraStimaIntegrata({
      giorno: r.giorno, integrataUsd: r.integrata, coperturaFrazione: r.copertura,
      campioni: r.campioni, completo: r.completo, fonte: 'ricostruzione-storico',
    });
    console.log(`  scritto ${r.giorno}: ${w.scritto ? 'ok' : 'NO — ' + (w.motivo || '?')} (base: ${w.base})`);
  }
}
console.log('\n⚠ Il nozionale non mappato non viene stimato e non viene scalato: la cifra integrata è un LIMITE INFERIORE.\n');

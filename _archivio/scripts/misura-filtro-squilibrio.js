'use strict';
// scripts/misura-filtro-squilibrio.js — QUANTO COSTA UN FILTRO SULLO SQUILIBRIO DELLE DUE GAMBE.
//
// SOLA LETTURA. Non importa nessuna superficie di piazzamento, non scrive niente in `data/`, non
// interroga il venue. Legge il board vivo (`/tmp/liquidity-rewards.json`), gli snapshot storici del
// board (`data/history/rewards-poly/<giorno>.json`) e il giornale dei mid (`data/mid-history-*.jsonl`).
//
// ═══ LA DOMANDA ══════════════════════════════════════════════════════════════════════════════════
// Il 12 agosto 2026 il bot ha aperto un mercato a mid 0,124 — gambe a 12,4¢ e 87,6¢ — che ha prodotto
// una gamba scoperta e una perdita di $0,91. La «finestra di mid [0,36 · 0,64]» che agent41 stampa
// all'avvio NON è un cancello: `concentration.finestraMid` ha due consumatori (quella riga di log e il
// proprio selfcheck) e nessun percorso di piazzamento la consulta. L'unico cancello reale è il tetto
// per ORDINE, che guarda i dollari e non lo squilibrio — e che si allarga quando il tetto scende,
// perché la finestra che ne deriva è `p ≤ costoCoppia · tettoOrdine / capitaleAllocato`.
//
// ═══ COSA MISURA ═════════════════════════════════════════════════════════════════════════════════
//   1. l'imbuto reale (pavimento premiante → orizzonte) e la capacità che ne risulta;
//   2. quanto costa aggiungerci un filtro simmetrico sul mid, per tre soglie candidate;
//   3. il tutto su OGNI snapshot del board della giornata, non su un istante solo — perché la
//      composizione del board oscilla molto durante il giorno e una misura puntuale mente.
//
// ⚠ IL CONFRONTO È CON L'IMBUTO SENZA VINCOLO SUL MID, ed è la scelta onesta: oggi nessun vincolo sul
// mid è applicato al piazzamento. La finestra derivata dal tetto per ordine viene misurata a parte,
// perché dipende dal capitale ALLOCATO (la griglia si ferma a $24-26, non al tetto) e quindi non è una
// costante che si possa mettere in tabella accanto alle altre.

const fs = require('fs');
const path = require('path');
const CO = require('../lib/rewards/concentration');

const CAPITALE = Number(process.env.CAP_USD || 663.11);
const ORIZZONTE_MIN_ORE = 18;             // MIN_HORIZON_DAYS = 0,75 ⇒ 18 h
const SOGLIE = [0.25, 0.30, 0.35];        // simmetriche: [s · 1−s]
const BOARD_VIVO = '/tmp/liquidity-rewards.json';
const STORICO_DIR = path.join(__dirname, '..', 'data', 'history', 'rewards-poly');

const tetto = CO.capPerMarketUsd(CAPITALE);
const tettoOrdine = CO.liveMinOrderCapUsd(CAPITALE);

/** L'imbuto reale, un passo alla volta. `sogliaMid` null ⇒ nessun vincolo sul mid. */
function imbuto(righe, oraMs, sogliaMid) {
  const poly = righe.filter((m) => !m.venue || m.venue === 'polymarket');
  const conMin = poly.filter((m) => {
    const ms = m.minSize ?? m.rewardsMinSize;
    return Number.isFinite(ms) && CO.pavimentoPremiante(ms) <= tetto;
  });
  const conOriz = conMin.filter((m) => {
    const t = Date.parse(m.endDate);
    return Number.isFinite(t) && (t - oraMs) / 3_600_000 >= ORIZZONTE_MIN_ORE;
  });
  if (sogliaMid == null) return { poly: poly.length, pavimento: conMin.length, orizzonte: conOriz.length, finali: conOriz.length, righe: conOriz };
  const dentro = conOriz.filter((m) => {
    const mid = m.mid ?? m.midpoint;
    return Number.isFinite(mid) && mid >= sogliaMid && mid <= 1 - sogliaMid;
  });
  return { poly: poly.length, pavimento: conMin.length, orizzonte: conOriz.length, finali: dentro.length, righe: dentro };
}

const cap = (n) => n * tetto;
const pct = (n) => (cap(n) / CAPITALE) * 100;
function stat(v) {
  const s = v.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.floor((s.length - 1) * p)];
  return { min: q(0), q1: q(0.25), med: q(0.5), q3: q(0.75), max: q(1), n: s.length };
}

function leggiSnapshot() {
  const out = [];
  const f = path.join(STORICO_DIR, '2026-08-12.json');
  if (fs.existsSync(f)) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const snaps = Array.isArray(j) ? j : (j.snapshots || [j]);
    for (const s of snaps) {
      const righe = s.rows || s.markets || [];
      if (righe.length) out.push({ iso: s.iso || null, t: s.t || Date.parse(s.iso), righe });
    }
  }
  return out;
}

function main() {
  console.log('CAPITALE $' + CAPITALE.toFixed(2) + ' · tetto per mercato $' + tetto + ' · tetto per ordine $' + tettoOrdine);
  console.log('orizzonte minimo ' + ORIZZONTE_MIN_ORE + ' h · soglie candidate ' + SOGLIE.map((s) => `[${s} · ${(1 - s).toFixed(2)}]`).join(' '));
  console.log('');

  // ── 1 · IL BOARD VIVO ────────────────────────────────────────────────────────────────────────
  const vivo = JSON.parse(fs.readFileSync(BOARD_VIVO, 'utf8'));
  const righeVive = (vivo.markets || []).map((m) => ({ ...m, mid: m.midpoint, endDate: m.endDate }));
  const ora = Date.now();
  console.log('══ BOARD VIVO (' + (vivo.meta && vivo.meta.generatedAt) + ')');
  const base = imbuto(righeVive, ora, null);
  console.log(`  polymarket ${base.poly} → pavimento ${base.pavimento} → orizzonte ${base.orizzonte}`);
  console.log(`  SENZA FILTRO: ${base.finali} mercati · $${cap(base.finali).toFixed(0)} · ${pct(base.finali).toFixed(0)}% del capitale`);
  for (const s of SOGLIE) {
    const r = imbuto(righeVive, ora, s);
    const persi = base.finali - r.finali;
    console.log(`  [${s} · ${(1 - s).toFixed(2)}]: ${r.finali} mercati (−${persi}) · $${cap(r.finali).toFixed(0)} · ${pct(r.finali).toFixed(0)}%`
      + (cap(r.finali) < CAPITALE ? '   ⚠ SOTTO IL CAPITALE' : ''));
  }
  console.log('');

  // ── 2 · TUTTI GLI SNAPSHOT DELLA GIORNATA ────────────────────────────────────────────────────
  const snaps = leggiSnapshot();
  console.log('══ SNAPSHOT DELLA GIORNATA (' + snaps.length + ')');
  console.log('');
  console.log('ora    | senza filtro      | [0,25·0,75]       | [0,30·0,70]       | [0,35·0,65]');
  const serie = { base: [], 0.25: [], 0.30: [], 0.35: [] };
  for (const s of snaps) {
    const b = imbuto(s.righe, s.t, null);
    serie.base.push(b.finali);
    const celle = [];
    for (const soglia of SOGLIE) {
      const r = imbuto(s.righe, s.t, soglia);
      serie[soglia].push(r.finali);
      celle.push(`${String(r.finali).padStart(2)} · $${String(cap(r.finali).toFixed(0)).padStart(4)} · ${String(pct(r.finali).toFixed(0)).padStart(3)}%`);
    }
    console.log(`${(s.iso || '').slice(11, 16)} | ${String(b.finali).padStart(2)} · $${String(cap(b.finali).toFixed(0)).padStart(4)} · ${String(pct(b.finali).toFixed(0)).padStart(3)}% | ${celle.join(' | ')}`);
  }
  console.log('');
  console.log('══ SINTESI SUGLI SNAPSHOT (mercati ammissibili)');
  console.log('scenario      |  min |   Q1 | MEDIANA |   Q3 |  max | snapshot che coprono il 90% ($' + (CAPITALE * 0.9).toFixed(0) + ')');
  const righeSintesi = [['senza filtro', serie.base], ...SOGLIE.map((s) => [`[${s} · ${(1 - s).toFixed(2)}]`, serie[s]])];
  for (const [nome, v] of righeSintesi) {
    const st = stat(v);
    const coprono = v.filter((n) => cap(n) >= CAPITALE * 0.9).length;
    console.log(`${nome.padEnd(13)} | ${String(st.min).padStart(4)} | ${String(st.q1).padStart(4)} | ${String(st.med).padStart(7)} | ${String(st.q3).padStart(4)} | ${String(st.max).padStart(4)} | ${coprono}/${v.length}`);
  }
  console.log('');
  console.log('══ CAPACITÀ IN DOLLARI (mercati × $' + tetto + ')');
  console.log('scenario      |    min |     Q1 | MEDIANA |     Q3 |    max | snapshot SOTTO il capitale ($' + CAPITALE.toFixed(0) + ')');
  for (const [nome, v] of righeSintesi) {
    const st = stat(v.map(cap));
    const sotto = v.filter((n) => cap(n) < CAPITALE).length;
    console.log(`${nome.padEnd(13)} | $${String(st.min.toFixed(0)).padStart(5)} | $${String(st.q1.toFixed(0)).padStart(5)} | $${String(st.med.toFixed(0)).padStart(6)} | $${String(st.q3.toFixed(0)).padStart(5)} | $${String(st.max.toFixed(0)).padStart(5)} | ${sotto}/${v.length}${sotto > v.length / 2 ? '   ⚠' : ''}`);
  }

  // ── 3 · LA FINESTRA CHE IL TETTO PER ORDINE PRODUCE GIÀ ──────────────────────────────────────
  console.log('');
  console.log('══ LA FINESTRA CHE IL TETTO PER ORDINE PRODUCE GIÀ (dipende dal capitale ALLOCATO)');
  for (const c of [tetto, 26, 24]) {
    const pMax = 0.98 * tettoOrdine / c;
    const hi = Math.min(0.99, pMax);
    console.log(`  capitale allocato $${c.toFixed(2)} ⇒ finestra [${(1 - hi).toFixed(3)} · ${hi.toFixed(3)}]`
      + (Math.abs(c - tetto) < 0.01 ? '   ← al TETTO PIENO (è la riga che agent41 stampa)' : '   ← passo reale della griglia'));
  }
}

if (require.main === module) main();
module.exports = { imbuto, tetto, tettoOrdine };

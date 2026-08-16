'use strict';

/**
 * COSA FANNO GLI ALTRI DOPO UN FILL — sola lettura, API pubblica Polymarket.
 *
 * ═══ FATTIBILITÀ, VERIFICATA PRIMA DI COSTRUIRE ═══════════════════════════════════════════════
 * `data-api.polymarket.com/activity` è paginato (`limit` max 500, `offset` funziona) e restituisce
 * tre tipi che sono esattamente le vie d'uscita da una gamba nuda: **TRADE** (con `side`, `size`,
 * `price`, `usdcSize`), **MERGE** e **REDEEM**. Quindi la ricostruzione fill-per-fill È possibile e
 * non serve ripiegare su differenze di posizione fra due istanti.
 *
 * ⚠ COSA **NON** È MISURABILE, e va detto prima di ogni conclusione:
 *   · **maker contro taker**: `activity` non porta il flag. Chi ha subito il fill e chi lo ha
 *     provocato sono indistinguibili. Quindi «esce a mercato» vs «mette un limite e aspetta» NON si
 *     legge direttamente: si può solo osservare il TEMPO fra ingresso e uscita, che è un proxy —
 *     un'uscita in pochi secondi è quasi certamente aggressiva, una a ore quasi certamente passiva,
 *     e in mezzo c'è una zona grigia che questo script NON pretende di risolvere;
 *   · **il book al momento del fill** non è ricostruibile a posteriori, quindi lo spread pagato si
 *     misura come differenza fra prezzo di uscita e prezzo di entrata dello STESSO wallet sullo
 *     stesso token — che include il movimento del mercato, non solo lo spread. È un limite superiore
 *     del costo di uscita, non lo spread puro.
 *
 * ═══ IL CAMPIONE ═══════════════════════════════════════════════════════════════════════════════
 * Tre strati dichiarati: i primi 30 per incasso, 30 casuali della fascia $10–100/g (seme fisso), i
 * 21 del manuale, più noi. Per ciascuno si prendono fino a 4 pagine di attività (2.000 eventi).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const NOSTRO = '0x4c81f19a436e8174f1f3b07d7c0169150fbdbdee';
const PAGINE = 4;
const PAUSA_MS = 320;
const SEME = 20260813;
const MIN_SIZE_VENUE = 20;   // la size minima tipica del venue, quella che ci lascia i residui

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * p)] : null; };

function rng(seme) { let s = seme >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// ── IL CAMPIONE ──────────────────────────────────────────────────────────────────────────────────
const camp = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'ricerca', 'campione-neutrali.json'), 'utf8'));
const perReward = camp.risultati.filter((w) => w.letto).sort((a, b) => b.totale - a.totale);
const top = perReward.slice(0, 30).map((w) => ({ a: w.a, strato: 'top30', reward: w.totale, giorni: w.giorni }));
const mediaPool = perReward.filter((w) => w.mediaG >= 10 && w.mediaG < 100 && !top.some((t) => t.a === w.a));
const r = rng(SEME);
const media = [];
{ const c = [...mediaPool]; while (media.length < Math.min(30, c.length)) media.push(...c.splice(Math.floor(r() * c.length), 1)); }

let ventuno = [];
try {
  const ros = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'maker-21-roster.json'), 'utf8'));
  const arr = Array.isArray(ros) ? ros : (ros.wallet || ros.roster || ros.makers || []);
  ventuno = arr.map((m) => ({ a: String(m.indirizzo).toLowerCase(), strato: 'i21', nome: m.nome }));
} catch { /* roster assente: lo strato resta vuoto e si dichiara */ }

const bersagli = [
  ...top,
  ...media.map((w) => ({ a: w.a, strato: 'media', reward: w.totale, giorni: w.giorni })),
  ...ventuno,
  { a: NOSTRO, strato: 'noi' },
];
const visti = new Set(); const lista = [];
for (const b of bersagli) { if (visti.has(b.a)) continue; visti.add(b.a); lista.push(b); }

let limitato = 0;
async function attivita(addr, offset, tentativo = 0) {
  try {
    const rr = await fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=500&offset=${offset}`);
    if (rr.status === 429) { limitato++; if (tentativo >= 5) return null; await attesa(2500 * (tentativo + 1)); return attivita(addr, offset, tentativo + 1); }
    if (!rr.ok) return null;
    return await rr.json();
  } catch { if (tentativo >= 3) return null; await attesa(1200 * (tentativo + 1)); return attivita(addr, offset, tentativo + 1); }
}

/**
 * L'ANALISI POST-FILL di un wallet.
 *
 * Si ricostruisce, per ogni (mercato, esito), la sequenza dei TRADE in ordine di tempo e si tiene la
 * posizione corrente. Un **episodio** nasce quando la posizione passa da zero a positiva (un BUY
 * riempito) e si chiude quando torna a zero — per vendita, per MERGE o per REDEEM.
 */
function analizza(eventi) {
  const trade = eventi.filter((e) => String(e.type).toUpperCase() === 'TRADE')
    .map((e) => ({ ts: Number(e.timestamp) * 1000, cond: String(e.conditionId), oi: String(e.outcomeIndex),
      side: String(e.side).toUpperCase(), size: Number(e.size), usd: Number(e.usdcSize), price: Number(e.price) }))
    .filter((e) => Number.isFinite(e.ts) && Number.isFinite(e.size) && e.size > 0)
    .sort((a, b) => a.ts - b.ts);
  const merge = eventi.filter((e) => String(e.type).toUpperCase() === 'MERGE')
    .map((e) => ({ ts: Number(e.timestamp) * 1000, cond: String(e.conditionId), size: Number(e.size) }));
  const redeem = eventi.filter((e) => String(e.type).toUpperCase() === 'REDEEM')
    .map((e) => ({ ts: Number(e.timestamp) * 1000, cond: String(e.conditionId), size: Number(e.size) }));

  const mergePerCond = new Map();
  for (const m of merge) { if (!mergePerCond.has(m.cond)) mergePerCond.set(m.cond, []); mergePerCond.get(m.cond).push(m.ts); }
  const redeemPerCond = new Map();
  for (const m of redeem) { if (!redeemPerCond.has(m.cond)) redeemPerCond.set(m.cond, []); redeemPerCond.get(m.cond).push(m.ts); }

  // Episodi per (mercato, esito)
  const perTok = new Map();
  for (const t of trade) {
    const k = `${t.cond}:${t.oi}`;
    if (!perTok.has(k)) perTok.set(k, []);
    perTok.get(k).push(t);
  }

  const episodi = [];
  const residui = [];
  for (const [k, seq] of perTok) {
    const [cond] = k.split(':');
    let pos = 0; let ep = null;
    for (const t of seq) {
      const prima = pos;
      pos += (t.side === 'BUY' ? t.size : -t.size);
      if (prima <= 1e-9 && pos > 1e-9) {
        ep = { cond, inizio: t.ts, prezzoIn: t.price, sizeMax: pos, usdIn: t.usd, vendite: 0, usdOut: 0, sizeOut: 0 };
      } else if (ep) {
        ep.sizeMax = Math.max(ep.sizeMax, pos);
        if (t.side === 'BUY') { ep.usdIn += t.usd; ep.prezzoIn = (ep.prezzoIn + t.price) / 2; }
        else { ep.vendite++; ep.usdOut += t.usd; ep.sizeOut += t.size; }
      }
      if (ep && pos <= 1e-9) {
        ep.fine = t.ts; ep.via = ep.vendite > 0 ? 'vendita' : 'ignota';
        ep.prezzoOut = ep.sizeOut > 0 ? ep.usdOut / ep.sizeOut : null;
        episodi.push(ep); ep = null;
      }
    }
    if (ep) {
      // Ancora aperta alla fine della finestra: è stata chiusa da un MERGE/REDEEM successivo?
      const m = (mergePerCond.get(cond) || []).filter((ts) => ts > ep.inizio).sort((a, b) => a - b)[0];
      const rd = (redeemPerCond.get(cond) || []).filter((ts) => ts > ep.inizio).sort((a, b) => a - b)[0];
      if (m) { ep.fine = m; ep.via = 'merge'; }
      else if (rd) { ep.fine = rd; ep.via = 'redeem'; }
      else { ep.via = 'aperta'; }
      ep.prezzoOut = ep.sizeOut > 0 ? ep.usdOut / ep.sizeOut : null;
      episodi.push(ep);
      // ⚠ IL RESIDUO: posizione ancora aperta e SOTTO la size minima del venue. È il nostro problema:
      // si guarda se ce l'hanno anche loro.
      if (ep.via === 'aperta' && pos > 0 && pos < MIN_SIZE_VENUE) residui.push({ cond, size: +pos.toFixed(4) });
    }
  }

  const chiusi = episodi.filter((e) => e.via !== 'aperta' && Number.isFinite(e.fine));
  const durate = chiusi.map((e) => (e.fine - e.inizio) / 60000);
  const vie = {};
  for (const e of episodi) vie[e.via] = (vie[e.via] || 0) + 1;
  // Costo di uscita: (prezzo entrata − prezzo uscita) × share uscite, solo dove entrambi sono noti.
  const costi = chiusi.filter((e) => e.via === 'vendita' && Number.isFinite(e.prezzoOut) && Number.isFinite(e.prezzoIn) && e.sizeOut > 0)
    .map((e) => ({ centSh: (e.prezzoIn - e.prezzoOut) * 100, usd: (e.prezzoIn - e.prezzoOut) * e.sizeOut }));
  const tagli = trade.map((t) => t.usd).filter((x) => Number.isFinite(x) && x > 0);

  return {
    eventi: eventi.length, trade: trade.length, merge: merge.length, redeem: redeem.length,
    episodi: episodi.length, chiusi: chiusi.length, aperti: episodi.length - chiusi.length,
    vie,
    quotaMerge: episodi.length ? +((vie.merge || 0) / episodi.length).toFixed(3) : null,
    quotaVendita: episodi.length ? +((vie.vendita || 0) / episodi.length).toFixed(3) : null,
    quotaRedeem: episodi.length ? +((vie.redeem || 0) / episodi.length).toFixed(3) : null,
    quotaAperta: episodi.length ? +((vie.aperta || 0) / episodi.length).toFixed(3) : null,
    durataMedianaMin: durate.length ? +q(durate, 0.5).toFixed(1) : null,
    durataQ25Min: durate.length ? +q(durate, 0.25).toFixed(1) : null,
    durataQ75Min: durate.length ? +q(durate, 0.75).toFixed(1) : null,
    durataQ90Min: durate.length ? +q(durate, 0.9).toFixed(1) : null,
    chiusiEntro60Min: durate.length ? +(durate.filter((d) => d <= 60).length / durate.length).toFixed(3) : null,
    costoUscitaMedianoCentShare: costi.length ? +q(costi.map((c) => c.centSh), 0.5).toFixed(2) : null,
    costoUscitaMedianoUsd: costi.length ? +q(costi.map((c) => c.usd), 0.5).toFixed(3) : null,
    costoUscitaTotaleUsd: costi.length ? +costi.reduce((s, c) => s + c.usd, 0).toFixed(2) : null,
    taglioMedianoUsd: tagli.length ? +q(tagli, 0.5).toFixed(2) : null,
    residuiSottoMinimo: residui.length,
    quotaResidui: episodi.length ? +(residui.length / episodi.length).toFixed(3) : null,
  };
}

(async () => {
  const t0 = Date.now();
  const out = [];
  let fatti = 0;
  for (const b of lista) {
    const eventi = [];
    for (let p = 0; p < PAGINE; p++) {
      const j = await attivita(b.a, p * 500);
      await attesa(PAUSA_MS);
      if (!Array.isArray(j) || !j.length) break;
      eventi.push(...j);
      if (j.length < 500) break;
    }
    fatti++;
    if (fatti % 20 === 0) console.error(`  ${fatti}/${lista.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (!eventi.length) { out.push({ ...b, letto: false }); continue; }
    const ts = eventi.map((e) => Number(e.timestamp) * 1000).filter(Boolean);
    out.push({ ...b, letto: true, daIso: new Date(Math.min(...ts)).toISOString(), aIso: new Date(Math.max(...ts)).toISOString(),
      ...analizza(eventi) });
  }

  const meta = {
    generatoIso: new Date().toISOString(),
    campione: { top30: top.length, media: media.length, i21: ventuno.length, totale: lista.length, seme: SEME },
    paginePerWallet: PAGINE, letti: out.filter((x) => x.letto).length,
    volteRateLimit: limitato, durataSec: +((Date.now() - t0) / 1000).toFixed(1),
    limitiDichiarati: {
      makerVsTaker: 'NON misurabile: activity non porta il flag',
      spread: 'il costo di uscita include il movimento del mercato, non è lo spread puro',
    },
  };
  fs.writeFileSync(path.join(ROOT, 'data', 'ricerca', 'post-fill.json'), JSON.stringify({ meta, wallet: out }, null, 1));
  console.error(`\nletti ${meta.letti}/${lista.length} · rate-limit ${limitato} · ${meta.durataSec}s`);
})();

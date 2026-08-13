'use strict';

/**
 * COSA FANNO DI DIVERSO I TOP INCASSATORI — sola lettura, API pubbliche.
 *
 * ═══ LA DOMANDA CHE GOVERNA TUTTO ═════════════════════════════════════════════════════════════
 * Fanno **market making neutrale** come noi, o **trading direzionale**? La differenza non è di stile:
 * se sono direzionali, copiare i loro parametri non porta i loro incassi, perché il grosso del loro
 * guadagno non viene dai reward.
 *
 * ═══ COME SI DISTINGUONO, CON I DATI CHE ESISTONO ═════════════════════════════════════════════
 *   · **Bilanciamento sui due lati** — `positions` porta `conditionId` e `outcomeIndex`. Un maker
 *     neutrale tende ad avere entrambi gli esiti dello stesso mercato (o nessuno, se ha già fuso);
 *     un direzionale ne ha uno solo. Si misura la quota di mercati con **una gamba sola**.
 *   · **Sbilanciamento in dollari** — |valore lato A − valore lato B| / valore totale del mercato.
 *     Zero = perfettamente appaiato, uno = completamente direzionale.
 *   · **Durata** — dal primo TRADE su un `conditionId` all'ultimo, da `activity`.
 *   · **Reward contro PnL di trading** — `cashPnl` + `realizedPnl` sommati sulle posizioni contro i
 *     reward incassati on-chain nello stesso periodo. È il rapporto che risponde alla domanda.
 *
 * ⚠ QUELLO CHE QUESTE FONTI **NON** DICONO, e non va inventato:
 *   · gli ORDINI A RIPOSO non compaiono da nessuna parte: `positions` mostra le posizioni, `activity`
 *     i fill. Quindi «quanto capitale tengono a libro» **non è misurabile** — si misura solo quello
 *     già in posizione;
 *   · `realizedPnl` è cumulativo sulla vita della posizione, non ritagliabile sulla finestra di 30
 *     giorni: il rapporto reward/PnL è quindi un ORDINE DI GRANDEZZA, non un conto esatto;
 *   · il montepremi del mercato al momento in cui ci sono entrati non è ricostruibile a posteriori.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const NOSTRO = '0x4c81f19a436e8174f1f3b07d7c0169150fbdbdee';
const PAUSA_MS = 400;
const QUANTI = Number(process.argv[2] || 15);

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));
const inc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'ricerca', 'incassatori.json'), 'utf8'));

async function get(url, tentativo = 0) {
  try {
    const r = await fetch(url);
    if (r.status === 429) {
      if (tentativo >= 5) return null;
      await attesa(2000 * (tentativo + 1));
      return get(url, tentativo + 1);
    }
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    if (tentativo >= 3) return null;
    await attesa(1000 * (tentativo + 1));
    return get(url, tentativo + 1);
  }
}

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * p)] : null; };

async function profila(addr) {
  const pos = await get(`https://data-api.polymarket.com/positions?user=${addr}&limit=500`) || [];
  await attesa(PAUSA_MS);
  const act = await get(`https://data-api.polymarket.com/activity?user=${addr}&limit=500`) || [];
  await attesa(PAUSA_MS);

  // ── I DUE LATI DELLO STESSO MERCATO ────────────────────────────────────────────────────────────
  const perMercato = new Map();
  for (const p of pos) {
    const c = String(p.conditionId || '');
    if (!c) continue;
    if (!perMercato.has(c)) perMercato.set(c, { lati: new Map(), titolo: p.title, endDate: p.endDate });
    const m = perMercato.get(c);
    const v = Number(p.currentValue);
    m.lati.set(String(p.outcomeIndex), (m.lati.get(String(p.outcomeIndex)) || 0) + (Number.isFinite(v) ? v : 0));
  }
  const mercati = [...perMercato.values()];
  const unaGamba = mercati.filter((m) => m.lati.size <= 1).length;
  // Sbilanciamento in dollari, per mercato e poi mediano.
  const sbil = mercati.map((m) => {
    const v = [...m.lati.values()];
    const tot = v.reduce((a, x) => a + Math.abs(x), 0);
    if (!(tot > 0)) return null;
    const diff = Math.abs((v[0] || 0) - (v[1] || 0));
    return diff / tot;
  }).filter((x) => x !== null);

  // ── DURATA, dai fill ───────────────────────────────────────────────────────────────────────────
  const trade = act.filter((a) => String(a.type).toUpperCase() === 'TRADE');
  const perCond = new Map();
  for (const a of trade) {
    const c = String(a.conditionId || '');
    if (!c) continue;
    if (!perCond.has(c)) perCond.set(c, []);
    perCond.get(c).push(Number(a.timestamp) * 1000);
  }
  const durate = [...perCond.values()].filter((t) => t.length > 1)
    .map((t) => (Math.max(...t) - Math.min(...t)) / 60000);

  // ── DIMENSIONE DEGLI ORDINI ────────────────────────────────────────────────────────────────────
  const tagli = trade.map((a) => Number(a.usdcSize)).filter((x) => Number.isFinite(x) && x > 0);
  const lati = { BUY: 0, SELL: 0 };
  for (const a of trade) { const s = String(a.side || '').toUpperCase(); if (lati[s] !== undefined) lati[s]++; }

  // ── CAPITALE IN POSIZIONE e PnL ────────────────────────────────────────────────────────────────
  const valore = pos.reduce((s, p) => s + (Number(p.currentValue) || 0), 0);
  const pnlCash = pos.reduce((s, p) => s + (Number(p.cashPnl) || 0), 0);
  const pnlReal = pos.reduce((s, p) => s + (Number(p.realizedPnl) || 0), 0);

  // ── ORIZZONTE dei mercati ──────────────────────────────────────────────────────────────────────
  const orizzonti = mercati.map((m) => (m.endDate ? (Date.parse(m.endDate) - Date.now()) / 86400_000 : null))
    .filter((x) => x !== null && Number.isFinite(x));

  return {
    posizioni: pos.length, mercati: mercati.length,
    mercatiUnaGamba: unaGamba,
    quotaUnaGamba: mercati.length ? +(unaGamba / mercati.length).toFixed(3) : null,
    sbilanciamentoMediano: sbil.length ? +q(sbil, 0.5).toFixed(3) : null,
    valoreInPosizioneUsd: +valore.toFixed(2),
    pnlNonRealizzatoUsd: +pnlCash.toFixed(2), pnlRealizzatoUsd: +pnlReal.toFixed(2),
    fillLetti: trade.length, buy: lati.BUY, sell: lati.SELL,
    taglioMedianoUsd: tagli.length ? +q(tagli, 0.5).toFixed(2) : null,
    taglioQ90Usd: tagli.length ? +q(tagli, 0.9).toFixed(2) : null,
    durataMedianaMin: durate.length ? +q(durate, 0.5).toFixed(1) : null,
    durataQ90Min: durate.length ? +q(durate, 0.9).toFixed(1) : null,
    mercatiConPiuFill: perCond.size,
    orizzonteMedianoGg: orizzonti.length ? +q(orizzonti, 0.5).toFixed(2) : null,
  };
}

(async () => {
  const t0 = Date.now();
  const bersagli = inc.top50.slice(0, QUANTI).map((w) => ({ ...w, tipo: 'top' }));
  bersagli.push({ a: NOSTRO, totaleUsd: inc.noi ? inc.noi.totaleUsd : 0, giorniPresente: inc.noi ? inc.noi.giorniPresente : 0, tipo: 'noi' });

  const out = [];
  for (const b of bersagli) {
    process.stderr.write(`profilo ${b.a.slice(0, 10)}… `);
    let p = null;
    try { p = await profila(b.a); } catch (e) { process.stderr.write(`ERRORE ${e.message}`); }
    process.stderr.write('\n');
    out.push({ ...b, profilo: p });
  }

  console.log('# I top incassatori: neutrali o direzionali?\n');
  console.log('| # | wallet | $/g reward | mercati | 1 gamba | sbil. | valore in pos. | PnL non real. | PnL real. | taglio mediano | durata mediana | orizzonte |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  out.forEach((w, i) => {
    const p = w.profilo;
    const et = w.tipo === 'noi' ? '**NOI**' : `${i + 1}`;
    if (!p) { console.log(`| ${et} | \`${w.a.slice(0, 10)}…\` | — | non misurabile (API muta) | | | | | | | | |`); return; }
    const mediaG = w.giorniPresente ? (w.totaleUsd / w.giorniPresente) : 0;
    console.log(`| ${et} | \`${w.a.slice(0, 10)}…\` | $${mediaG.toFixed(0)} | ${p.mercati} `
      + `| ${p.quotaUnaGamba === null ? '—' : `${(p.quotaUnaGamba * 100).toFixed(0)}%`} `
      + `| ${p.sbilanciamentoMediano === null ? '—' : p.sbilanciamentoMediano.toFixed(2)} `
      + `| $${p.valoreInPosizioneUsd.toFixed(0)} | $${p.pnlNonRealizzatoUsd.toFixed(0)} | $${p.pnlRealizzatoUsd.toFixed(0)} `
      + `| $${p.taglioMedianoUsd ?? '—'} | ${p.durataMedianaMin === null ? '—' : `${p.durataMedianaMin} min`} `
      + `| ${p.orizzonteMedianoGg === null ? '—' : `${p.orizzonteMedianoGg} g`} |`);
  });

  fs.writeFileSync(path.join(ROOT, 'data', 'ricerca', 'profili-top.json'),
    JSON.stringify({ generatoIso: new Date().toISOString(), durataSec: +((Date.now() - t0) / 1000).toFixed(1), profili: out }, null, 1));
  console.error(`\nfatto in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();

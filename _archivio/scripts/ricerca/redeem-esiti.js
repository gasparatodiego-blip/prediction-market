'use strict';

/**
 * IL REDEEM È UNA VIEW O È GESTIONE? — sola lettura, API pubblica.
 *
 * ═══ PERCHÉ LA DOMANDA È MISURABILE, e non lo era per forza ═══════════════════════════════════
 * Il sospetto legittimo era: se una posizione che risolve a **0** non generasse un evento REDEEM,
 * contare i redeem misurerebbe **solo i vincenti per costruzione**, e qualunque conclusione sarebbe
 * un artefatto da sopravvivenza.
 *
 * **Verificato che NON è così**: su `activity`, un REDEEM porta `usdcSize/size` esattamente **0.0000
 * oppure 1.0000** — niente in mezzo — e gli eventi con `usdcSize: 0` **esistono** (esempio reale:
 * `size: 300, usdcSize: 0`). Quindi il perdente genera l'evento come il vincente, e il rapporto fra i
 * due è una misura vera.
 *
 *   `usdcSize == size`  ⇒ risolta a **1**, valore pieno
 *   `usdcSize == 0`     ⇒ risolta a **0**, azzerata
 *
 * ═══ LA DOMANDA CHE SCIOGLIE ═══════════════════════════════════════════════════════════════════
 * Redimono perché **sanno** che quelle posizioni valgono 1 — e allora è una view direzionale, non
 * gestione del residuo, e a noi che siamo neutrali non serve — oppure redimono **indistintamente**,
 * accettando che una parte vada a zero perché sul totale conviene rispetto a pagare lo spread ogni
 * volta? La risposta è il rapporto vinte/perse, e il confronto fra incasso e prezzo di carico.
 *
 * ⚠ IL LIMITE: il prezzo di carico si ricostruisce dai TRADE nella finestra scaricata. Un redeem di
 * una posizione comprata PRIMA della finestra non ha carico ricostruibile, e finisce in
 * `senzaCarico` — dichiarato, non stimato.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PAGINE = 12;          // ~6.000 eventi per wallet: serve profondità per agganciare i carichi
const PAUSA_MS = 320;

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * p)] : null; };

const pf = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'ricerca', 'post-fill.json'), 'utf8'));
// Gli otto a più basso residuo con almeno 100 episodi: sono quelli su cui poggia la conclusione
// «chi non ha residui li redime», quindi sono esattamente quelli da mettere alla prova.
const bersagli = pf.wallet.filter((w) => w.letto && w.episodi >= 100 && w.quotaResidui != null)
  .sort((a, b) => a.quotaResidui - b.quotaResidui).slice(0, 8);

let limitato = 0;
async function attivita(addr, offset, tent = 0) {
  try {
    const r = await fetch(`https://data-api.polymarket.com/activity?user=${addr}&limit=500&offset=${offset}`);
    if (r.status === 429) { limitato++; if (tent >= 5) return null; await attesa(2500 * (tent + 1)); return attivita(addr, offset, tent + 1); }
    if (!r.ok) return null;
    return await r.json();
  } catch { if (tent >= 3) return null; await attesa(1200 * (tent + 1)); return attivita(addr, offset, tent + 1); }
}

(async () => {
  const t0 = Date.now();
  const out = [];

  for (const b of bersagli) {
    const eventi = [];
    for (let p = 0; p < PAGINE; p++) {
      const j = await attivita(b.a, p * 500);
      await attesa(PAUSA_MS);
      if (!Array.isArray(j) || !j.length) break;
      eventi.push(...j);
      if (j.length < 500) break;
    }
    if (!eventi.length) { out.push({ a: b.a, strato: b.strato, letto: false }); continue; }

    // Carico medio per (mercato, esito), dai soli BUY.
    const carico = new Map();
    for (const e of eventi) {
      if (String(e.type).toUpperCase() !== 'TRADE') continue;
      if (String(e.side).toUpperCase() !== 'BUY') continue;
      const k = `${e.conditionId}:${e.outcomeIndex}`;
      const s = Number(e.size); const u = Number(e.usdcSize);
      if (!Number.isFinite(s) || !Number.isFinite(u) || s <= 0) continue;
      if (!carico.has(k)) carico.set(k, { size: 0, usd: 0 });
      const c = carico.get(k); c.size += s; c.usd += u;
    }

    const red = eventi.filter((e) => String(e.type).toUpperCase() === 'REDEEM')
      .map((e) => {
        const s = Number(e.size); const u = Number(e.usdcSize);
        const k = `${e.conditionId}:${e.outcomeIndex}`;
        const c = carico.get(k);
        const prezzoCarico = c && c.size > 0 ? c.usd / c.size : null;
        // ⚠ 0 o 1, e niente in mezzo: si classifica sul rapporto, con tolleranza minima.
        const pps = s > 0 ? u / s : null;
        return { size: s, usd: u, pps, vinta: pps !== null && pps > 0.5, prezzoCarico };
      })
      .filter((r) => Number.isFinite(r.size) && r.size > 0);

    const vinte = red.filter((r) => r.vinta);
    const perse = red.filter((r) => !r.vinta);
    const conCarico = red.filter((r) => r.prezzoCarico !== null);
    const vinteC = conCarico.filter((r) => r.vinta);
    const perseC = conCarico.filter((r) => !r.vinta);

    // ⚠ IL NUMERO CHE DECIDE: incasso totale contro costo totale, sulle sole righe con carico noto.
    const costo = conCarico.reduce((s, r) => s + r.prezzoCarico * r.size, 0);
    const incasso = conCarico.reduce((s, r) => s + r.usd, 0);

    out.push({
      a: b.a, strato: b.strato, letto: true,
      eventiLetti: eventi.length, redeem: red.length,
      vinte: vinte.length, perse: perse.length,
      quotaVinte: red.length ? +(vinte.length / red.length).toFixed(4) : null,
      sizeVinte: +vinte.reduce((s, r) => s + r.size, 0).toFixed(2),
      sizePerse: +perse.reduce((s, r) => s + r.size, 0).toFixed(2),
      incassoTotaleUsd: +red.reduce((s, r) => s + r.usd, 0).toFixed(2),
      conCarico: conCarico.length, senzaCarico: red.length - conCarico.length,
      caricoMedianoVinte: vinteC.length ? +q(vinteC.map((r) => r.prezzoCarico), 0.5).toFixed(4) : null,
      caricoMedianoPerse: perseC.length ? +q(perseC.map((r) => r.prezzoCarico), 0.5).toFixed(4) : null,
      costoUsd: +costo.toFixed(2), incassoUsd: +incasso.toFixed(2),
      pnlUsd: +(incasso - costo).toFixed(2),
      pnlPct: costo > 0 ? +((incasso - costo) / costo * 100).toFixed(2) : null,
    });
    process.stderr.write(`${b.a.slice(0, 10)}… ${red.length} redeem, ${eventi.length} eventi\n`);
  }

  const meta = { generatoIso: new Date().toISOString(), paginePerWallet: PAGINE,
    volteRateLimit: limitato, durataSec: +((Date.now() - t0) / 1000).toFixed(1) };
  fs.writeFileSync(path.join(ROOT, 'data', 'ricerca', 'redeem-esiti.json'), JSON.stringify({ meta, wallet: out }, null, 1));

  const V = out.filter((w) => w.letto && w.redeem > 0);
  console.log('# Il redeem: view direzionale o gestione?\n');
  console.log('| wallet | strato | redeem | vinte (=1) | perse (=0) | quota vinte | carico med. vinte | carico med. perse | con carico | PnL sul redeem |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const w of V) {
    console.log(`| \`${w.a.slice(0, 10)}…\` | ${w.strato} | ${w.redeem} | ${w.vinte} | ${w.perse} `
      + `| **${(w.quotaVinte * 100).toFixed(1)}%** | ${w.caricoMedianoVinte ?? '—'} | ${w.caricoMedianoPerse ?? '—'} `
      + `| ${w.conCarico}/${w.redeem} | ${w.pnlUsd === null ? '—' : `$${w.pnlUsd} (${w.pnlPct}%)`} |`);
  }
  const tR = V.reduce((s, w) => s + w.redeem, 0);
  const tV = V.reduce((s, w) => s + w.vinte, 0);
  const tC = V.reduce((s, w) => s + w.costoUsd, 0);
  const tI = V.reduce((s, w) => s + w.incassoUsd, 0);
  const tCar = V.reduce((s, w) => s + w.conCarico, 0);
  console.log(`\n**AGGREGATO: ${tR} redeem, ${tV} vinte = ${(tV / tR * 100).toFixed(1)}%, ${tR - tV} perse = ${((tR - tV) / tR * 100).toFixed(1)}%**`);
  console.log(`**Con carico ricostruibile: ${tCar}/${tR} (${(tCar / tR * 100).toFixed(1)}%) — costo $${tC.toFixed(2)}, incasso $${tI.toFixed(2)}, PnL $${(tI - tC).toFixed(2)} (${((tI - tC) / tC * 100).toFixed(2)}%)**`);
  console.error(`\n${meta.durataSec}s, rate-limit ${limitato}`);
})();

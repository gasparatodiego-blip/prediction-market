'use strict';

/**
 * IL MERCATO È CALIBRATO AGLI ESTREMI? — sola lettura, API pubbliche.
 *
 * Domanda: un esito quotato 0,95 a 24 ore dalla scadenza vince davvero il 95% delle volte?
 *
 * ═══ COME, E LE SCELTE DICHIARATE ══════════════════════════════════════════════════════════════
 *   · **Universo**: `gamma-api.polymarket.com/markets?closed=true`, ordinato per `closedTime`
 *     discendente. `closedTime` è l'istante VERO di risoluzione (`endDate` è la scadenza nominale e
 *     può essere lontanissima: un mercato risolto in anticipo porta `endDate` nel 2029).
 *   · **Il prezzo di riferimento**: `clob.polymarket.com/prices-history` sul token YES, preso a
 *     **24 ore prima di `endDate`**, cioè la scadenza letterale. Se la serie non copre quell'istante
 *     il mercato viene **scartato**, non approssimato.
 *   · **L'esito**: `outcomePrices` di un mercato risolto vale `["1","0"]` (YES) o `["0","1"]` (NO).
 *     Qualunque altra forma ⇒ scartato.
 *   · **Si campiona la gamba CARA**: per ogni mercato si prende `max(p_yes, 1−p_yes)` e si guarda se
 *     quell'esito ha vinto. È la domanda posta — «quanto spesso il mercato a 90+ sbaglia».
 *
 * ⚠ **Filtro di volume**: si tengono solo i mercati con `volumeNum` sopra una soglia, perché un
 * prezzo su un libro senza scambi non è un'opinione del mercato, è un residuo. La soglia è dichiarata
 * e il conteggio degli scartati pure.
 *
 * ⚠ Questo NON è il campione dei sei wallet della sessione precedente: quello era **selezionato**
 * (wallet scelti perché bravi) e mostrava +56 punti di scarto. Qui l'universo sono i mercati, non i
 * trader, quindi la selezione non c'è.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const GIORNI = Number(process.argv[2] || 90);
const VOLUME_MIN = Number(process.argv[3] || 1000);
const MAX_MERCATI = Number(process.argv[4] || 4000);
const PAUSA_MS = 160;

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));
let limitato = 0; let chiamate = 0;

async function get(url, tent = 0) {
  chiamate++;
  try {
    const r = await fetch(url);
    if (r.status === 429) {
      limitato++;
      if (tent >= 5) return null;
      await attesa(2000 * (tent + 1));
      return get(url, tent + 1);
    }
    if (!r.ok) return null;
    return await r.json();
  } catch {
    if (tent >= 3) return null;
    await attesa(1000 * (tent + 1));
    return get(url, tent + 1);
  }
}

(async () => {
  const t0 = Date.now();
  const limite = Date.now() - GIORNI * 86400_000;

  // ── 1 · L'UNIVERSO DEI MERCATI RISOLTI, PARTIZIONATO PER FINESTRE DI DATA ─────────────────────
  // ⚠ Gamma tronca la paginazione a ~3.000 record per query: senza partizione si copre meno di UN
  // giorno e si scambia il troncamento per «non c'è altro». È la stessa trappola di Etherscan (§149).
  // Si itera quindi su finestre di `end_date`, e dentro ciascuna si pagina fino a esaurirla.
  const mercati = [];
  const FIN_GIORNI = 3;
  const oggi = Date.now();
  let finestre = 0;
  for (let d = GIORNI; d > 0; d -= FIN_GIORNI) {
    const a = new Date(oggi - (d - FIN_GIORNI) * 86400_000).toISOString();
    const da = new Date(oggi - d * 86400_000).toISOString();
    finestre++;
    for (let off = 0; off < 3000; off += 500) {
      const j = await get('https://gamma-api.polymarket.com/markets?closed=true&limit=500'
        + `&offset=${off}&volume_num_min=${VOLUME_MIN}`
        + `&end_date_min=${encodeURIComponent(da)}&end_date_max=${encodeURIComponent(a)}`);
      if (!Array.isArray(j) || !j.length) break;
      for (const m of j) {
        let prezzi; let tok;
        try { prezzi = JSON.parse(m.outcomePrices); } catch { continue; }
        try { tok = JSON.parse(m.clobTokenIds); } catch { continue; }
        if (!Array.isArray(prezzi) || prezzi.length !== 2 || !Array.isArray(tok) || !tok.length) continue;
        const yes = Number(prezzi[0]); const no = Number(prezzi[1]);
        if (!((yes === 1 && no === 0) || (yes === 0 && no === 1))) continue;
        const end = Date.parse(m.endDate);
        if (!Number.isFinite(end)) continue;
        mercati.push({ cid: m.conditionId, tokenYes: String(tok[0]), end,
          yesVince: yes === 1, volume: Number(m.volumeNum) });
      }
      if (j.length < 500) break;
      await attesa(PAUSA_MS);
    }
    if (finestre % 10 === 0) console.error(`  finestre ${finestre} · mercati ${mercati.length}`);
    await attesa(PAUSA_MS);
  }
  const visti = new Set(); const unici = [];
  for (const m of mercati) { if (visti.has(m.cid)) continue; visti.add(m.cid); unici.push(m); }
  mercati.length = 0; mercati.push(...unici);
  const piuVecchio = mercati.length ? Math.min(...mercati.map((m) => m.end)) : NaN;
  console.error(`mercati risolti raccolti: ${mercati.length} unici (volume ≥ $${VOLUME_MIN}) su ${finestre} finestre · `
    + `scadenza più vecchia: ${Number.isFinite(piuVecchio) ? new Date(piuVecchio).toISOString().slice(0, 10) : '—'}`);

  // ── 2 · IL PREZZO A 24 ORE DALLA SCADENZA ─────────────────────────────────────────────────────
  const punti = []; let senzaStoria = 0; let fatti = 0;
  for (const m of mercati) {
    const target = m.end - 86400_000;
    const j = await get(`https://clob.polymarket.com/prices-history?market=${m.tokenYes}`
      + `&startTs=${Math.floor((target - 5400_000) / 1000)}&endTs=${Math.floor((target + 5400_000) / 1000)}&fidelity=10`);
    fatti++;
    if (fatti % 200 === 0) console.error(`  ${fatti}/${mercati.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s · rate-limit ${limitato}`);
    await attesa(PAUSA_MS);
    const h = j && Array.isArray(j.history) ? j.history : [];
    if (!h.length) { senzaStoria++; continue; }
    // Il punto più vicino al bersaglio, e solo se sta entro 90 minuti: oltre non è «24 ore prima».
    let best = null; let dmin = Infinity;
    for (const p of h) {
      const ts = Number(p.t) * 1000; const v = Number(p.p);
      if (!Number.isFinite(ts) || !Number.isFinite(v)) continue;
      const d = Math.abs(ts - target);
      if (d < dmin) { dmin = d; best = v; }
    }
    if (best === null || dmin > 5400_000) { senzaStoria++; continue; }
    // La gamba CARA e se ha vinto.
    const pCara = Math.max(best, 1 - best);
    const caraEYes = best >= 0.5;
    const caraVince = caraEYes ? m.yesVince : !m.yesVince;
    punti.push({ cid: m.cid, pYes: best, pCara, caraVince, volume: m.volume });
  }

  console.error(`punti utilizzabili: ${punti.length} · senza storia utile: ${senzaStoria} · `
    + `chiamate ${chiamate} · rate-limit ${limitato} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  fs.writeFileSync(path.join(ROOT, 'data', 'ricerca', 'calibrazione-mercato.json'),
    JSON.stringify({ generatoIso: new Date().toISOString(), giorni: GIORNI, volumeMin: VOLUME_MIN,
      mercatiRaccolti: mercati.length, puntiUtilizzabili: punti.length, senzaStoria,
      piuVecchioIso: Number.isFinite(piuVecchio) ? new Date(piuVecchio).toISOString() : null,
      chiamate, limitato, punti }, null, 0));
})();

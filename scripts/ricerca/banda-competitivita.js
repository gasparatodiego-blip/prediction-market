'use strict';
/**
 * scripts/ricerca/banda-competitivita.js — SOLA LETTURA.
 *
 * LA PROVA DIRETTA. `GET /rewards/markets/{conditionId}` restituisce
 * `market_competitiveness`: un numero che il VENUE calcola con il PROPRIO scorer
 * sul PROPRIO libro. Se lo si riproduce dal libro pubblico usando v = max_spread e
 * NON usando v = max_spread/2, la lettura giusta di v non è più un'interpretazione
 * della documentazione: è una misura.
 *
 * Non si assume la forma della normalizzazione: si calcolano entrambe le letture e
 * si guarda quale RIPRODUCE il numero del venue, mercato per mercato.
 *
 * Nessuna credenziale, nessuna scrittura fuori da data/ricerca/.
 */

const fs = require('fs');
const path = require('path');
const { scoreOrder, parseOrders, adjustedMid } = require('../../lib/rewardScore');

const CLOB = 'https://clob.polymarket.com';
const OUT = path.join(__dirname, '..', '..', 'data', 'ricerca', 'banda-competitivita.json');
const BOARD = path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, tentativi = 3) {
  for (let i = 0; i < tentativi; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'ricerca-banda/1.0' } });
      if (r.status === 429) { await sleep(1200 * 2 ** i); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(600 * 2 ** i); }
  }
  return null;
}

// Q di un lato con una data semiampiezza v (in centesimi). Solo ordini ≥ minSize:
// è la soglia del venue, sotto la quale un ordine matura ZERO.
function qLato(ordini, mid, v, minSize) {
  let Q = 0;
  for (const o of ordini) {
    if (o.size < minSize) continue;
    const s = Math.abs(o.price - mid) * 100;
    const sc = scoreOrder(s, v);
    if (sc > 0) Q += sc * o.size;
  }
  return Q;
}

(async () => {
  const board = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
  const mercati = (board.markets || []).filter(m => m.rewardsMaxSpread > 0 && m.tokenId && m.tokenIdNo);

  const righe = [];
  let n = 0;
  for (const m of mercati) {
    const [cfg, bookYes] = await Promise.all([
      getJson(`${CLOB}/rewards/markets/${m.conditionId}`),
      getJson(`${CLOB}/book?token_id=${m.tokenId}`),
    ]);
    await sleep(150);
    const rec = (cfg && cfg.data && cfg.data[0]) || null;
    if (!rec || !bookYes || !bookYes.bids || !bookYes.asks) continue;

    const comp = rec.market_competitiveness;
    const V = rec.rewards_max_spread;
    const minSize = rec.rewards_min_size || 0;
    if (!(comp > 0) || !(V > 0)) continue;

    const bids = parseOrders(bookYes.bids, true);
    const asks = parseOrders(bookYes.asks, false);
    if (!bids.length || !asks.length) continue;
    const mid = adjustedMid(bids, asks, minSize, m.mid);

    // Le due letture in disputa.
    const vLarga = V;         // ufficiale: v = max spread from midpoint
    const vStretta = V / 2;   // convenzione interna del bot

    const r = {
      slug: rec.market_slug, conditionId: m.conditionId,
      maxSpread: V, minSize, mid: +mid.toFixed(4),
      competitivitaVenue: comp,
      larga: {
        qBids: qLato(bids, mid, vLarga, minSize),
        qAsks: qLato(asks, mid, vLarga, minSize),
      },
      stretta: {
        qBids: qLato(bids, mid, vStretta, minSize),
        qAsks: qLato(asks, mid, vStretta, minSize),
      },
    };
    for (const k of ['larga', 'stretta']) {
      r[k].somma = r[k].qBids + r[k].qAsks;
      r[k].min = Math.min(r[k].qBids, r[k].qAsks);
    }
    righe.push(r);
    if (++n % 20 === 0) process.stderr.write(`  ${n} mercati\n`);
  }

  // Quale candidato riproduce il numero del venue? Si guarda il rapporto
  // competitivita/candidato: se una lettura è quella giusta, il rapporto è COSTANTE
  // fra mercati (a meno della normalizzazione, che è la stessa per tutti).
  function stat(nome, f) {
    const v = righe.map(f).filter(x => Number.isFinite(x) && x > 0);
    if (v.length < 5) return { nome, n: v.length, esito: 'campione insufficiente' };
    v.sort((a, b) => a - b);
    const med = v[Math.floor(v.length / 2)];
    const q1 = v[Math.floor(v.length * 0.25)], q3 = v[Math.floor(v.length * 0.75)];
    // dispersione relativa dell'IQR: 0 = il rapporto è una costante
    return { nome, n: v.length, mediana: +med.toFixed(4), q1: +q1.toFixed(4), q3: +q3.toFixed(4),
             dispersioneIQR: +((q3 - q1) / med).toFixed(4) };
  }

  const candidati = [
    stat('competitivita / Qsomma  (v = maxSpread)',    r => r.competitivitaVenue / r.larga.somma),
    stat('competitivita / Qmin    (v = maxSpread)',    r => r.competitivitaVenue / r.larga.min),
    stat('competitivita / Qsomma  (v = maxSpread/2)          ',  r => r.competitivitaVenue / r.stretta.somma),
    stat('competitivita / Qmin    (v = maxSpread/2)          ',  r => r.competitivitaVenue / r.stretta.min),
  ];

  // Contro-prova indipendente dalla normalizzazione: quanti mercati hanno
  // competitivita > 0 mentre la lettura STRETTA dice che nel libro non c'è NIENTE
  // di premiante? Ognuno di quelli è un mercato che il venue giudica competitivo e
  // che il bot vede vuoto.
  const strettaVuotaMaVenuePremia = righe.filter(r => r.stretta.somma <= 0 && r.competitivitaVenue > 0);
  const largaVuotaMaVenuePremia   = righe.filter(r => r.larga.somma   <= 0 && r.competitivitaVenue > 0);

  const res = {
    generatoAl: new Date().toISOString(),
    mercati: righe.length,
    candidati,
    contraddizioni: {
      letturaStretta_vuotaMaVenueCompetitivo: strettaVuotaMaVenuePremia.length,
      letturaLarga_vuotaMaVenueCompetitivo: largaVuotaMaVenuePremia.length,
      esempiStretta: strettaVuotaMaVenuePremia.slice(0, 8)
        .map(r => ({ slug: r.slug, maxSpread: r.maxSpread, minSize: r.minSize,
                     competitivitaVenue: r.competitivitaVenue, qStretta: r.stretta.somma, qLarga: +r.larga.somma.toFixed(1) })),
    },
    righe,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1));

  console.log(`mercati confrontati: ${righe.length}\n`);
  console.log('quale lettura riproduce il numero del VENUE? (rapporto costante ⇒ lettura giusta)');
  for (const c of candidati) {
    console.log(`  ${c.nome.padEnd(42)} n=${String(c.n).padStart(3)}  mediana ${String(c.mediana).padStart(10)}  IQR/mediana ${c.dispersioneIQR}`);
  }
  console.log('\ncontro-prova indipendente dalla normalizzazione:');
  console.log(`  mercati dove il VENUE dice "competitivo" ma la lettura STRETTA vede il libro VUOTO: ${strettaVuotaMaVenuePremia.length}`);
  console.log(`  stessi mercati con la lettura LARGA:                                                ${largaVuotaMaVenuePremia.length}`);
  for (const e of res.contraddizioni.esempiStretta) {
    console.log(`    ${e.slug.slice(0, 52).padEnd(52)} V=${e.maxSpread}¢ min=${e.minSize}  venue=${e.competitivitaVenue.toFixed(1)}  Qstretta=${e.qStretta}  Qlarga=${e.qLarga}`);
  }
  console.log(`\nscritto in ${OUT}`);
})();

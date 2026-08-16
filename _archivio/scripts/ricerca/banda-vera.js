'use strict';
/**
 * scripts/ricerca/banda-vera.js — SOLA LETTURA.
 *
 * Domanda: la banda premiante che il venue applica davvero è ±max_spread dal mid
 * (lettura ufficiale) o ±max_spread/2 (convenzione interna del bot)?
 *
 * Metodo: non si chiede al venue, si guarda dove i maker VERI mettono i soldi.
 * Se la banda vale R, chi la insegue smette di quotare oltre R e nel profilo di
 * profondità compare un GRADINO. Il libro decade da sé con la distanza, quindi il
 * segnale non è il decadimento ma la DISCONTINUITÀ: si misura la densità di
 * profondità (share per centesimo) in bin di s/max_spread e si cerca dove cade.
 *
 * Nessuna scrittura fuori da data/ricerca/. Nessuna credenziale. Solo GET pubbliche
 * su clob.polymarket.com (/book), le stesse che agent24 già usa.
 */

const fs = require('fs');
const path = require('path');

const CLOB = 'https://clob.polymarket.com';
const OUT = path.join(__dirname, '..', '..', 'data', 'ricerca', 'banda-vera.json');
const BOARD = path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, tentativi = 3) {
  for (let i = 0; i < tentativi; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'ricerca-banda/1.0' } });
      if (r.status === 429) { await sleep(1000 * 2 ** i); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(500 * 2 ** i); }
  }
  return null;
}

// Un livello del libro conta come "candidato premiante" solo se la sua size regge
// il minimo del venue: sotto min_size un ordine matura ZERO, quindi chi ottimizza
// non lo mette lì e includerlo sporcherebbe il profilo con rumore non premiante.
function profiloLato(livelli, mid, minSize, verso) {
  const out = [];
  for (const l of livelli || []) {
    const p = parseFloat(l.price), sz = parseFloat(l.size);
    if (!(p > 0) || !(sz > 0)) continue;
    if (verso === 'bid' && p > mid) continue;
    if (verso === 'ask' && p < mid) continue;
    out.push({ distC: Math.abs(p - mid) * 100, size: sz, qualificabile: sz >= minSize });
  }
  return out;
}

(async () => {
  const board = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
  const mercati = (board.markets || []).filter(m => m.rewardsMaxSpread > 0 && m.tokenId);

  const BIN = 0.05;               // bin in unità di s/max_spread
  const MAX_R = 1.6;              // si guarda fino a 1,6× max_spread
  const bins = new Map();         // chiave bin -> {share, shareQual, nMercati:Set}
  const perMercato = [];
  let letti = 0, falliti = 0;

  for (const m of mercati) {
    const book = await getJson(`${CLOB}/book?token_id=${m.tokenId}`);
    await sleep(120);
    if (!book || !book.bids || !book.asks) { falliti++; continue; }

    const bids = (book.bids || []).map(b => parseFloat(b.price)).filter(x => x > 0);
    const asks = (book.asks || []).map(a => parseFloat(a.price)).filter(x => x > 0);
    if (!bids.length || !asks.length) { falliti++; continue; }
    const bestBid = Math.max(...bids), bestAsk = Math.min(...asks);
    if (!(bestAsk > bestBid)) { falliti++; continue; }
    const mid = (bestBid + bestAsk) / 2;

    const V = m.rewardsMaxSpread;              // in centesimi
    const minSize = m.rewardsMinSize || 0;
    const liv = [
      ...profiloLato(book.bids, mid, minSize, 'bid'),
      ...profiloLato(book.asks, mid, minSize, 'ask'),
    ];
    if (!liv.length) { falliti++; continue; }

    let dentroStretta = 0, fraLeDue = 0, oltreLarga = 0;
    for (const l of liv) {
      const r = l.distC / V;                   // 1,0 = bordo della banda LARGA
      if (r <= 0.5 + 1e-9) dentroStretta += l.size;
      else if (r <= 1 + 1e-9) fraLeDue += l.size;
      else oltreLarga += l.size;
      if (r > MAX_R) continue;
      const k = Math.floor(r / BIN);
      if (!bins.has(k)) bins.set(k, { share: 0, shareQual: 0, mercati: new Set() });
      const b = bins.get(k);
      b.share += l.size;
      if (l.qualificabile) b.shareQual += l.size;
      b.mercati.add(m.conditionId);
    }
    letti++;
    perMercato.push({
      conditionId: m.conditionId, slug: m.slug, maxSpread: V, minSize, mid,
      dentroStretta: Math.round(dentroStretta), fraLeDue: Math.round(fraLeDue),
      oltreLarga: Math.round(oltreLarga),
    });
    if (letti % 20 === 0) process.stderr.write(`  ${letti} libri letti\n`);
  }

  // Densità per bin: share per unità di s/V, normalizzata sul numero di mercati che
  // contribuiscono, così un mercato spesso non domina il profilo.
  const profilo = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([k, b]) => ({
    da: +(k * BIN).toFixed(2), a: +((k + 1) * BIN).toFixed(2),
    shareMedioPerMercato: +(b.share / b.mercati.size).toFixed(1),
    qualMedioPerMercato: +(b.shareQual / b.mercati.size).toFixed(1),
    mercati: b.mercati.size,
  }));

  const somma = (lo, hi) => profilo.filter(p => p.da >= lo && p.a <= hi)
    .reduce((a, p) => a + p.shareMedioPerMercato, 0);

  const res = {
    generatoAl: new Date().toISOString(),
    domanda: 'la banda vera è ±max_spread o ±max_spread/2?',
    mercatiLetti: letti, mercatiFalliti: falliti,
    profilo,
    aggregati: {
      shareDentroBandaStretta: somma(0, 0.5),
      shareFraStrettaELarga: somma(0.5, 1.0),
      shareOltreBandaLarga: somma(1.0, MAX_R),
    },
    perMercato,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1));

  console.log(`mercati letti: ${letti} (falliti ${falliti})`);
  console.log('\nprofilo di profondità (share medie per mercato, per bin di s/max_spread):');
  console.log('  s/V        share   di cui ≥minSize   mercati');
  for (const p of profilo) {
    const barra = '█'.repeat(Math.min(50, Math.round(p.shareMedioPerMercato / Math.max(1, profilo[0].shareMedioPerMercato) * 40)));
    const bordo = Math.abs(p.da - 0.5) < 1e-9 ? '  <= bordo banda STRETTA' : Math.abs(p.da - 1.0) < 1e-9 ? '  <= bordo banda LARGA' : '';
    console.log(`  ${p.da.toFixed(2)}-${p.a.toFixed(2)}  ${String(p.shareMedioPerMercato).padStart(8)}  ${String(p.qualMedioPerMercato).padStart(12)}  ${String(p.mercati).padStart(6)} ${barra}${bordo}`);
  }
  console.log('\naggregati (share medie per mercato):');
  console.log('  dentro la banda STRETTA (s/V ≤ 0,5): ', res.aggregati.shareDentroBandaStretta.toFixed(1));
  console.log('  fra stretta e larga (0,5 < s/V ≤ 1): ', res.aggregati.shareFraStrettaELarga.toFixed(1));
  console.log('  oltre la banda LARGA (s/V > 1):      ', res.aggregati.shareOltreBandaLarga.toFixed(1));
  console.log(`\nscritto in ${OUT}`);
})();

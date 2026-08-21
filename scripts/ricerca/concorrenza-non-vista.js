'use strict';
// scripts/ricerca/concorrenza-non-vista.js — SOLA LETTURA.
// Il board di agent24 porta 108 mercati su 1.818 premianti veri (tetto MAX_CLOB_MARKETS = 150,
// agent24-liquidity-rewards.js:71-72, che morde a :678). Qui si misura la CONCORRENZA IN BANDA su
// TUTTI i mercati che passerebbero i nostri cancelli (scadenza >= 24 h, minSize <= 50), visti e non
// visti, per rispondere a: il muro e' di capitale o di board?
//
// ⚠ SI USA IL BATCH `POST /books`, che agent24 non usa: agent24 chiama `/book?token_id=` UNO ALLA
// VOLTA (3,63 s/mercato misurati nel suo stesso meta), ed e' da li' che nasce il tetto di 150.
// Il batch non e' una scorciatoia della ricerca: e' una superficie del venue che esiste ed e' pubblica.
//
// FORMULA: la stessa del venue, importata — rewardScore.scoreBook (Q = somma S(v,s)*size, qMin con
// c=3) e size-da-capitale per il costo della coppia. Nessuna aritmetica riscritta qui.
const https = require('https');
const fs = require('fs');
const path = require('path');
const RS = require('../../lib/rewardScore');
const SDC = require('../../lib/rewards/size-da-capitale');

const OUT = path.join(__dirname, '..', '..', 'data', 'ricerca');
const U = JSON.parse(fs.readFileSync(path.join(OUT, 'universo-premiante.json'), 'utf8'));
const BOARD = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json'), 'utf8'));
const VISTI = new Set(BOARD.markets.map(m => m.conditionId));

function postBooks(tokens) {
  const body = JSON.stringify(tokens.map(t => ({ token_id: String(t) })));
  return new Promise((res) => {
    const req = https.request({ host: 'clob.polymarket.com', path: '/books', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (r) => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res([]); } });
    });
    req.on('error', () => res([])); req.write(body); req.end();
  });
}

const D = Number(process.argv[2] || 2.5);        // la distanza VERA misurata sugli ordini a libro
const CAP = Number(process.argv[3] || 61.25);    // il tetto per mercato di oggi

(async () => {
  const cand = U.ammissibili.filter(m => m.tokenIds && m.tokenIds.length >= 1 && m.maxSpread > 0);
  console.log('ammissibili ai NOSTRI cancelli (>=24h, minSize<=50):', cand.length,
    '· di cui sul board di agent24:', cand.filter(m => VISTI.has(m.id)).length);
  const libri = new Map();
  const LOTTO = 40;
  for (let i = 0; i < cand.length; i += LOTTO) {
    const fetta = cand.slice(i, i + LOTTO);
    const r = await postBooks(fetta.map(m => m.tokenIds[0]));
    if (Array.isArray(r)) for (const b of r) if (b && b.asset_id) libri.set(String(b.asset_id), b);
    if (i % 400 === 0) process.stderr.write(`  ${i}/${cand.length}\r`);
  }
  console.log('libri ottenuti:', libri.size, 'su', cand.length);

  const righe = [];
  const scarti = { senzaLibro: 0, senzaMid: 0, cQnonMisurabile: 0, sottoPavimento: 0 };
  for (const m of cand) {
    const b = libri.get(String(m.tokenIds[0]));
    if (!b) { scarti.senzaLibro++; continue; }
    const bids = (b.bids || []).map(o => ({ price: +o.price, size: +o.size })).filter(o => o.price > 0 && o.size > 0);
    const asks = (b.asks || []).map(o => ({ price: +o.price, size: +o.size })).filter(o => o.price > 0 && o.size > 0);
    if (!bids.length || !asks.length) { scarti.senzaMid++; continue; }
    const bb = Math.max(...bids.map(o => o.price)), ba = Math.min(...asks.map(o => o.price));
    const mid = (bb + ba) / 2;
    const sc = RS.scoreBook({ bids: b.bids, asks: b.asks }, m.maxSpread, m.minSize, mid);
    const cQ = sc && Number.isFinite(sc.Qmin) ? sc.Qmin : null;
    if (cQ == null || !(cQ > 0)) { scarti.cQnonMisurabile++; continue; }
    const pc = SDC.costoCoppiaAllaDistanza(D);
    if (pc == null) continue;
    const M = sc.mid != null && Number.isFinite(sc.mid) ? sc.mid : mid;
    if (!(M - D / 100 > 0) || !(M + D / 100 < 1)) { scarti.senzaMid++; continue; }
    const cMin = m.minSize * pc;                       // pavimento premiante VENUE
    const cPav = +(m.minSize * 0.98 * 1.25).toFixed(2); // pavimento del PIANIFICATORE
    if (cPav > CAP) { scarti.sottoPavimento++; continue; }
    // quota con la formula del venue, poi tetto di credibilita' 0,60 (regola di realistic-estimate)
    const S = ((m.maxSpread - D) / m.maxSpread) ** 2;
    const qu = S * (CAP / pc);
    const share = Math.min(0.60, qu / (qu + cQ));
    righe.push({ id: m.id, q: m.q, rate: m.rate, minSize: m.minSize, v: m.maxSpread, ore: m.ore,
      mid: +M.toFixed(4), cQ: +cQ.toFixed(1), share: +share.toFixed(5),
      premio: +(m.rate * share).toFixed(4), visto: VISTI.has(m.id),
      spread: +((ba - bb) * 100).toFixed(2), livelliBid: bids.length, livelliAsk: asks.length });
  }
  righe.sort((a, z) => z.premio - a.premio);
  console.log('righe scorabili:', righe.length, '· scarti', JSON.stringify(scarti));
  console.log('');
  console.log(`I 20 MIGLIORI a $${CAP} ciascuno, distanza ${D}c (VISTO = gia' sul board di agent24):`);
  console.log('premio/g  rate   cQ       share   ore    minSz  visto  domanda');
  for (const r of righe.slice(0, 20)) console.log(
    ('$' + r.premio.toFixed(3)).padEnd(10), ('$' + r.rate).padEnd(6), String(r.cQ).padEnd(9),
    (100 * r.share).toFixed(2).padStart(5) + '%', String(r.ore.toFixed(0)).padStart(6),
    String(r.minSize).padStart(6), (r.visto ? '  SI ' : '  no ').padEnd(7), String(r.q).slice(0, 46));
  const top20 = righe.slice(0, 20).reduce((a, r) => a + r.premio, 0);
  const top5 = righe.slice(0, 5).reduce((a, r) => a + r.premio, 0);
  const nonVisti20 = righe.slice(0, 20).filter(r => !r.visto).length;
  console.log('');
  console.log(`SOMMA dei 20 migliori: $${top20.toFixed(2)}/g su $${(20 * CAP).toFixed(2)} di capitale`);
  console.log(`SOMMA dei  5 migliori: $${top5.toFixed(2)}/g su $${(5 * CAP).toFixed(2)} di capitale`);
  console.log(`dei 20 migliori, NON visti dal board: ${nonVisti20}/20`);
  fs.writeFileSync(path.join(OUT, 'concorrenza-non-vista.json'), JSON.stringify({
    lettoAl: new Date().toISOString(), distanzaCents: D, capMercato: CAP,
    ammissibili: cand.length, sulBoard: cand.filter(m => VISTI.has(m.id)).length,
    libri: libri.size, scorabili: righe.length, scarti,
    sommaTop20: +top20.toFixed(4), sommaTop5: +top5.toFixed(4), nonVistiNeiTop20: nonVisti20,
    righe,
  }, null, 1));
  console.log('\nscritto data/ricerca/concorrenza-non-vista.json');
})();

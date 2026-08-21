'use strict';
// scripts/ricerca/universo-premiante.js — SOLA LETTURA.
// Il board di agent24 vede 150 mercati su 827 premianti (REWARD_MAX_CLOB_MARKETS, §5 p.117/132).
// Qui si censisce l'UNIVERSO INTERO da Gamma — solo GET pubbliche, nessuna credenziale — per
// rispondere a una domanda che il board da solo non puo' rispondere: il muro e' di CAPITALE o di
// BOARD? Se i mercati a 24-48 h esistono e il board non li vede, il muro e' di scansione.
const https = require('https');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'data', 'ricerca');

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'user-agent': 'rewards-bot-ricerca' } }, (r) => {
      let b = ''; r.on('data', d => b += d);
      r.on('end', () => { try { res({ status: r.statusCode, data: JSON.parse(b) }); } catch (e) { res({ status: r.statusCode, data: null }); } });
    }).on('error', rej);
  });
}

(async () => {
  // ⚠ Gamma tetta le pagine a 100 e l'offset a ~2.100: e' per questo che agent24 usa le FETTE di
  // scadenza (una finestra per query ⇒ ognuna ha i suoi 2.100 posti). Qui si replica la stessa
  // strategia, con una finestra piu' larga: 0-21 giorni a fette di 6 h, piu' il listino nudo.
  const PAGE = 100;
  const perId = new Map();
  let pagine = 0;
  const isoZ = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
  const ora0 = Date.now();
  const query = [(off) => `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${PAGE}&offset=${off}`];
  for (let i = 0; i < 84; i++) {
    const da = ora0 + i * 6 * 3600000, a = ora0 + (i + 1) * 6 * 3600000;
    query.push((off) => `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${PAGE}&offset=${off}`
      + `&end_date_min=${encodeURIComponent(isoZ(da))}&end_date_max=${encodeURIComponent(isoZ(a))}`);
  }
  for (const q of query) {
   for (let p = 0; p < 21; p++) {
    const r = await get(q(p * PAGE));
    if (r.status !== 200 || !Array.isArray(r.data) || !r.data.length) break;
    pagine++;
    for (const m of r.data) {
      const cr = m.clobRewards;
      if (!cr || !cr.length) continue;
      const rate = parseFloat(cr[0].rewardsDailyRate);
      const maxSpread = parseFloat(m.rewardsMaxSpread);
      const minSize = parseFloat(m.rewardsMinSize);
      if (!(rate > 0.01) || !(maxSpread > 0)) continue;
      perId.set(m.conditionId, {
        id: m.conditionId, q: m.question, rate, maxSpread, minSize,
        end: m.endDate ? Date.parse(m.endDate) : NaN,
        slug: m.slug, volume: Number(m.volumeNum || m.volume || 0),
        tokenIds: (() => { try { return typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds)
          : (Array.isArray(m.clobTokenIds) ? m.clobTokenIds : []); } catch (_) { return []; } })(),
      });
    }
    if (r.data.length < PAGE) break;
   }
  }
  const tutti = [...perId.values()];
  const ora = Date.now();
  const fasce = [['a <12h', 0, 12], ['b 12-24h', 12, 24], ['c 24-48h', 24, 48], ['d 2-7g', 48, 168],
                 ['e 7-30g', 168, 720], ['f >30g', 720, 1e9]];
  console.log('pagine Gamma lette:', pagine, '· mercati PREMIANTI trovati:', tutti.length);
  console.log('(il board di agent24 ne porta 108, scansionandone 150 — §5 p.117)');
  console.log('');
  console.log('fascia      n     pool/g     n(minSize<=50)  pool(minSize<=50)');
  const perFascia = {};
  for (const [n, a, b] of fasce) {
    const s = tutti.filter(x => Number.isFinite(x.end) && (x.end - ora) / 3600000 >= a && (x.end - ora) / 3600000 < b);
    const s50 = s.filter(x => x.minSize <= 50);
    perFascia[n] = { n: s.length, pool: +s.reduce((z, x) => z + x.rate, 0).toFixed(2),
      n50: s50.length, pool50: +s50.reduce((z, x) => z + x.rate, 0).toFixed(2) };
    console.log(n.padEnd(11), String(s.length).padEnd(6), ('$' + perFascia[n].pool).padEnd(11),
      String(s50.length).padEnd(15), '$' + perFascia[n].pool50);
  }
  const senzaFine = tutti.filter(x => !Number.isFinite(x.end)).length;
  console.log('senza scadenza leggibile:', senzaFine);
  console.log('');
  console.log('TOP 15 per montepremi fra 24h e 7 giorni, minSize<=50:');
  const corti = tutti.filter(x => Number.isFinite(x.end) && (x.end - ora) / 3600000 >= 24 && (x.end - ora) / 3600000 < 168 && x.minSize <= 50)
    .sort((a, b) => b.rate - a.rate);
  for (const m of corti.slice(0, 15)) console.log('  $' + String(m.rate).padEnd(6), 'minSz ' + String(m.minSize).padEnd(4),
    'v ' + String(m.maxSpread).padEnd(5), 'ore ' + ((m.end - ora) / 3600000).toFixed(0).padEnd(5), String(m.q).slice(0, 58));
  fs.writeFileSync(path.join(OUT, 'universo-premiante.json'), JSON.stringify({
    lettoAl: new Date(ora).toISOString(), pagine, totale: tutti.length, perFascia, senzaFine,
    corti24_168_minSize50: corti.map(m => ({ id: m.id, q: m.q, rate: m.rate, minSize: m.minSize,
      maxSpread: m.maxSpread, ore: +((m.end - ora) / 3600000).toFixed(1), slug: m.slug, tokenIds: m.tokenIds })),
    // TUTTI gli ammissibili alla nostra regola (≥24h, minSize≤50) — e' l'universo VERO del bot
    ammissibili: tutti.filter(x => Number.isFinite(x.end) && (x.end - ora) / 3600000 >= 24 && x.minSize <= 50)
      .map(m => ({ id: m.id, q: m.q, rate: m.rate, minSize: m.minSize, maxSpread: m.maxSpread,
        ore: +((m.end - ora) / 3600000).toFixed(1), tokenIds: m.tokenIds, volume: m.volume })),
  }, null, 1));
  console.log('\nscritto data/ricerca/universo-premiante.json');
})();

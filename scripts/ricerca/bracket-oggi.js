'use strict';
// SOLA LETTURA: rimisura il bracket dei 54 wallet (5-24 mercati, $800-3.000) sui dati di ADESSO.
// Quanti incassano davvero, oggi, e quanto — contro la misura del 15 agosto.
const { apiGet } = require('./screening-lib');
const fs = require('fs'); const path = require('path');
const S = require('../../data/ricerca/censimento-109-fase3-sintesi.json');
const W = S.gruppo.wallet;
const GIORNI = 14;
(async () => {
  const da = Date.now() - GIORNI * 86400e3;
  const out = [];
  for (let i = 0; i < W.length; i++) {
    const w = typeof W[i] === 'string' ? W[i] : (W[i].wallet || W[i].a);
    const r = await apiGet(`/activity?user=${w}&type=REWARD&limit=500`);
    const rows = r.ok ? (Array.isArray(r.dati) ? r.dati : (r.dati && r.dati.data) || []) : [];
    const recenti = rows.filter(a => Number(a.timestamp) * 1000 >= da);
    const usd = recenti.reduce((a, x) => a + Number(x.usdcSize ?? x.size ?? x.amount ?? 0), 0);
    const cap = typeof W[i] === 'object' ? Number(W[i].capitaleUsd || 0) : null;
    out.push({ wallet: w, pagamenti: recenti.length, usd: +usd.toFixed(2),
      giorniDistinti: new Set(recenti.map(x => new Date(Number(x.timestamp) * 1000).toISOString().slice(0, 10))).size,
      capitale: cap, ok: r.ok });
    process.stderr.write(`  ${i + 1}/${W.length}\r`);
  }
  const letti = out.filter(x => x.ok);
  const zero = letti.filter(x => x.usd === 0);
  const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
  const perG = letti.map(x => x.usd / GIORNI);
  console.log(`bracket rimisurato: ${letti.length} wallet letti su ${W.length}`);
  console.log(`ZERO in ${GIORNI} giorni: ${zero.length}/${letti.length} (${(100 * zero.length / letti.length).toFixed(1)}%)`);
  console.log(`$/giorno  q25 $${q(perG, .25).toFixed(2)} · mediana $${q(perG, .5).toFixed(2)} · q75 $${q(perG, .75).toFixed(2)} · max $${Math.max(...perG).toFixed(2)}`);
  console.log(`giorni con incasso, mediana: ${q(letti.map(x => x.giorniDistinti), .5)}/${GIORNI}`);
  console.log('');
  console.log('I 10 MIGLIORI del bracket, oggi:');
  for (const x of letti.slice().sort((a, b) => b.usd - a.usd).slice(0, 10))
    console.log('  ' + x.wallet.slice(0, 12) + '…', ('$' + (x.usd / GIORNI).toFixed(2) + '/g').padStart(12),
      ('$' + x.usd.toFixed(0) + ' in ' + GIORNI + 'g').padStart(18), ' giorni ' + x.giorniDistinti,
      x.capitale ? ' capitale $' + x.capitale.toFixed(0) : '');
  fs.writeFileSync(path.join(__dirname, '..', '..', 'data', 'ricerca', 'bracket-oggi.json'),
    JSON.stringify({ lettoAl: new Date().toISOString(), giorni: GIORNI, n: letti.length,
      zero: zero.length, perGiorno: { q25: q(perG, .25), mediana: q(perG, .5), q75: q(perG, .75), max: Math.max(...perG) },
      righe: out }, null, 1));
  console.log('\nscritto data/ricerca/bracket-oggi.json');
})();

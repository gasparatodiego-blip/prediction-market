'use strict';
// SOLA LETTURA: scarica in blocco i libri dei mercati ammissibili e li mette in cache su disco,
// cosi' le analisi successive non rifanno la rete. `POST /books` e' pubblico e senza credenziali.
const https = require('https'); const fs = require('fs'); const path = require('path');
const OUT = path.join(__dirname, '..', '..', 'data', 'ricerca');
const U = JSON.parse(fs.readFileSync(path.join(OUT, 'universo-premiante.json'), 'utf8'));
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
(async () => {
  // ⚠ SI SCARICANO ENTRAMBI I TOKEN: il lato NO ha il suo libro, e la posa e' bilaterale.
  const cand = U.ammissibili.filter(m => m.tokenIds && m.tokenIds.length >= 2);
  const tutti = [];
  for (const m of cand) { tutti.push(m.tokenIds[0], m.tokenIds[1]); }
  const cache = {};
  for (let i = 0; i < tutti.length; i += 40) {
    const r = await postBooks(tutti.slice(i, i + 40));
    if (Array.isArray(r)) for (const b of r) if (b && b.asset_id) cache[String(b.asset_id)] = { bids: b.bids || [], asks: b.asks || [] };
    if (i % 800 === 0) process.stderr.write(`  ${i}/${tutti.length}\r`);
  }
  fs.writeFileSync(path.join(OUT, 'libri-cache.json'), JSON.stringify({ at: new Date().toISOString(), n: Object.keys(cache).length, libri: cache }));
  console.log('libri in cache:', Object.keys(cache).length, 'su', tutti.length, 'token richiesti ·', cand.length, 'mercati');
})();

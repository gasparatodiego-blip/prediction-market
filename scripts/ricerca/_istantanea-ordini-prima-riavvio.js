'use strict';
// SOLA LETTURA — gli ordini a riposo VERI, letti dal venue (non ricostruiti dal giornale).
// Adapter CANCEL-ONLY: nessun `postOrder` nella sua superficie; si chiama solo `listOpenOrders`.
// Scrive una istantanea in data/istantanee/, e nient'altro.
const fs = require('fs');
const path = require('path');
for (const l of fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { createCancelOnlyAdapter } = require('../../lib/venues/polymarket-clob/adapter');
const { polymarketCancelCredsProvider } = require('../../lib/maker/cancel-creds-provider');
const ETICHETTA = process.argv[2] || 'istantanea';
(async () => {
  const a = createCancelOnlyAdapter({ credsProvider: polymarketCancelCredsProvider });
  const r = await a.listOpenOrders();
  const presaAl = new Date().toISOString();
  if (!r.ok) {
    // ⚠ Una lettura fallita NON diventa «zero ordini»: si scrive l'errore e si esce rumorosamente.
    const f = path.join(__dirname, '..', '..', 'data', 'istantanee', `ordini-${ETICHETTA}.json`);
    fs.writeFileSync(f, JSON.stringify({ presaAl, leggibile: false, errore: r }, null, 2) + '\n');
    console.error('LETTURA FALLITA — istantanea NON valida:', JSON.stringify(r).slice(0, 300));
    process.exit(1);
  }
  const ordini = (r.orders || []).map((o) => ({
    id: o.id || o.order_id || null,
    mercato: o.market || null,
    tokenId: o.asset_id || null,
    lato: o.side || null,
    prezzo: Number(o.price),
    size: Number(o.original_size ?? o.size),
    sizeRiempita: Number(o.size_matched ?? 0),
    nozionaleUsd: +(Number(o.price) * Number(o.original_size ?? o.size)).toFixed(4),
    creatoAl: o.created_at || null,
    scadenza: o.expiration || null,
    scadenzaIso: o.expiration ? new Date(Number(o.expiration) * 1000).toISOString() : null,
  }));
  const perMercato = new Map();
  for (const o of ordini) {
    const k = o.mercato || 'ignoto';
    const v = perMercato.get(k) || { mercato: k, ordini: 0, nozionaleUsd: 0 };
    v.ordini++; v.nozionaleUsd = +(v.nozionaleUsd + o.nozionaleUsd).toFixed(4);
    perMercato.set(k, v);
  }
  const out = {
    nota: 'ISTANTANEA LETTA DAL VENUE con l\'adapter cancel-only (listOpenOrders). Non ricostruita dal giornale.',
    etichetta: ETICHETTA, presaAl, leggibile: true,
    totaleOrdini: ordini.length,
    nozionaleTotaleUsd: +ordini.reduce((s, o) => s + o.nozionaleUsd, 0).toFixed(4),
    perMercato: [...perMercato.values()].sort((x, y) => y.nozionaleUsd - x.nozionaleUsd),
    ordini,
  };
  const f = path.join(__dirname, '..', '..', 'data', 'istantanee', `ordini-${ETICHETTA}.json`);
  fs.writeFileSync(f, JSON.stringify(out, null, 2) + '\n');
  console.log('ordini a riposo LETTI DAL VENUE:', ordini.length, '· nozionale $' + out.nozionaleTotaleUsd);
  console.log('scritta:', f);
  for (const o of ordini) console.log(` ${String(o.mercato).slice(0, 12)} ${o.lato} p=${o.prezzo} size=${o.size} $${o.nozionaleUsd} id=${String(o.id).slice(0, 12)}… ${o.creatoAl}`);
})();

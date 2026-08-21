'use strict';
// scripts/ricerca/_leggi-ordini-vivi.js — SOLA LETTURA: gli ordini a riposo VERI, dal venue.
// Usa l'adapter CANCEL-ONLY (nessun postOrder nella sua superficie) e ne chiama solo listOpenOrders.
// Nessuna scrittura fuori da data/ricerca/.
const fs = require('fs');
const path = require('path');
for (const l of fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { createCancelOnlyAdapter } = require('../../lib/venues/polymarket-clob/adapter');
const { polymarketCancelCredsProvider } = require('../../lib/maker/cancel-creds-provider');
(async () => {
  const a = createCancelOnlyAdapter({ credsProvider: polymarketCancelCredsProvider });
  const r = await a.listOpenOrders();
  if (!r.ok) { console.log(JSON.stringify({ ok:false, err:r })); process.exit(1); }
  const out = (r.orders||[]).map(o => ({
    id: o.id||o.order_id||null, market: o.market||null, asset_id: o.asset_id||null,
    side: o.side||null, price: Number(o.price), size: Number(o.original_size ?? o.size),
    matched: Number(o.size_matched ?? 0), expiration: o.expiration||null, created: o.created_at||null,
  }));
  fs.writeFileSync(path.join(__dirname,'..','..','data','ricerca','ordini-vivi-21ago.json'),
    JSON.stringify({ atIso: new Date().toISOString(), n: out.length, ordini: out }, null, 2));
  console.log('ordini a riposo:', out.length);
  for (const o of out) console.log(` ${o.market&&o.market.slice(0,12)} ${o.side} p=${o.price} size=${o.size} matched=${o.matched} tok=${String(o.asset_id).slice(0,10)}`);
})();

'use strict';
// SOLA LETTURA: i pagamenti REWARD veri dal registro attivita' PUBBLICO, keyed sul funder.
const { apiGet } = require('./screening-lib');
const FUNDER = '0x4C81F19a436e8174f1f3b07d7c0169150Fbdbdee'.toLowerCase();
(async () => {
  const r = await apiGet(`/activity?user=${FUNDER}&type=REWARD&limit=200`);
  if (!r.ok) { console.log('errore', JSON.stringify(r).slice(0,300)); return; }
  const rows = Array.isArray(r.dati) ? r.dati : (r.dati && r.dati.data) || [];
  console.log('pagamenti REWARD trovati:', rows.length);
  for (const a of rows.slice(0, 40)) {
    const ts = Number(a.timestamp) * 1000;
    console.log(new Date(ts).toISOString(), '$' + (a.usdcSize ?? a.size ?? a.amount), a.title ? String(a.title).slice(0,45) : '');
  }
})();

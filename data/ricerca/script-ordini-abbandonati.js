// Cosa il riavvio di agent40 ha lasciato indietro: ordini presenti PRIMA e non piu' a libro DOPO,
// e ordini ancora a libro ma che nessuno ha ri-piazzato (stesso mercato+lato, id nuovo).
// SOLA LETTURA. Confronta due istantanee lette dal venue, non ricostruzioni.
const fs = require('fs');
const A = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));   // prima
const B = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));   // dopo
if (A.leggibile !== true || B.leggibile !== true) { console.log('una delle due istantanee non e\' leggibile: non si giudica'); process.exit(1); }
const idB = new Set((B.ordini || []).map((o) => o.id));
const chiave = (o) => `${o.mercato}|${o.lato}|${o.tokenId}`;
const chiaviB = new Map();
for (const o of B.ordini || []) { const k = chiave(o); const v = chiaviB.get(k) || []; v.push(o); chiaviB.set(k, v); }

const spariti = (A.ordini || []).filter((o) => !idB.has(o.id));
const sparitiSenzaSostituto = spariti.filter((o) => !(chiaviB.get(chiave(o)) || []).length);
const sparitiConSostituto = spariti.filter((o) => (chiaviB.get(chiave(o)) || []).length);
const sopravvissuti = (A.ordini || []).filter((o) => idB.has(o.id));
const nuovi = (B.ordini || []).filter((o) => !(A.ordini || []).some((x) => x.id === o.id));

const somma = (l) => +l.reduce((s, o) => s + o.nozionaleUsd, 0).toFixed(4);
const out = {
  prima: { file: process.argv[2], presaAl: A.presaAl, n: (A.ordini || []).length, nozionaleUsd: A.nozionaleTotaleUsd },
  dopo: { file: process.argv[3], presaAl: B.presaAl, n: (B.ordini || []).length, nozionaleUsd: B.nozionaleTotaleUsd },
  sopravvissutiStessoId: { n: sopravvissuti.length, nozionaleUsd: somma(sopravvissuti) },
  spariti: { n: spariti.length, nozionaleUsd: somma(spariti) },
  // ⚠ QUESTI SONO GLI ABBANDONATI: spariti dal libro e NESSUN ordine nuovo sullo stesso mercato+lato.
  abbandonatiSenzaSostituto: {
    n: sparitiSenzaSostituto.length, nozionaleUsd: somma(sparitiSenzaSostituto),
    ordini: sparitiSenzaSostituto.map((o) => ({ mercato: o.mercato, lato: o.lato, prezzo: o.prezzo, size: o.size, nozionaleUsd: o.nozionaleUsd, id: o.id, creatoAl: o.creatoAl })),
  },
  spariti_ma_ripiazzati: { n: sparitiConSostituto.length, nozionaleUsd: somma(sparitiConSostituto) },
  nuoviDopo: { n: nuovi.length, nozionaleUsd: somma(nuovi) },
};
fs.writeFileSync('/home/bot/bot/data/ricerca/ordini-abbandonati-riavvio.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));

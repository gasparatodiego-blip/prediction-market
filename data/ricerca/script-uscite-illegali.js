// CONTROLLO DI LEGALITA' DELLE USCITE A LIBRO — SOLA LETTURA, letto dal venue.
// ① nessun SELL sotto il pavimento della scala (R7: concessione = 5% del carico, un punto solo)
// ② nessun BUY di completamento la cui coppia superi il tetto (MAKER_TETTO_COPPIA_CENTS, 101c)
// Il carico si legge dallo SNAPSHOT DEL VENUE, non da una dichiarazione. Fail-closed: cio' che non
// si riesce a giudicare si dichiara «non giudicabile», mai «legale».
const fs = require('fs');
const { pavimentoConcesso } = require('/home/bot/bot/lib/maker/urgenza-scoperto');
const ORD = process.argv[2] || '/home/bot/bot/data/istantanee/ordini-dopo-riavvio.json';
const pos = JSON.parse(fs.readFileSync('/home/bot/bot/data/venue-positions.json', 'utf8'));
const board = JSON.parse(fs.readFileSync('/home/bot/bot/data/liquidity-rewards.json', 'utf8'));
const snap = JSON.parse(fs.readFileSync(ORD, 'utf8'));
if (snap.leggibile !== true) { console.log(JSON.stringify({ giudicabile: false, motivo: 'istantanea ordini non leggibile' })); process.exit(1); }

const TETTO_COPPIA = 1.01;
const perToken = new Map((pos.positions || []).map((p) => [String(p.tokenId), p]));
const perMercato = new Map();
for (const p of pos.positions || []) {
  const v = perMercato.get(p.conditionId) || []; v.push(p); perMercato.set(p.conditionId, v);
}
const tickDi = new Map((board.markets || []).map((m) => [m.conditionId, Number(m.tickSize)]));

const violazioni = [], nonGiudicabili = [], ok = [];
for (const o of snap.ordini || []) {
  const mieiSulMercato = perMercato.get(o.mercato) || [];
  if (!mieiSulMercato.length) { ok.push({ id: o.id, motivo: 'nessuna posizione su questo mercato: non e\' un\'uscita' }); continue; }
  const tick = tickDi.get(o.mercato);
  if (o.lato === 'SELL') {
    const mia = perToken.get(String(o.tokenId));
    if (!mia) { nonGiudicabili.push({ id: o.id, mercato: o.mercato, lato: o.lato, motivo: 'SELL su un token che non risulta posseduto' }); continue; }
    if (!Number.isFinite(tick) || !Number.isFinite(mia.avgPrice)) { nonGiudicabili.push({ id: o.id, motivo: 'tick o carico non leggibili' }); continue; }
    // Il pavimento PIU' PERMISSIVO che la scala consenta: gradino 2+, concessione massima.
    const pav = pavimentoConcesso({ carico: mia.avgPrice, tick, concessioneTick: 1 });
    if (!Number.isFinite(pav.pavimento)) { nonGiudicabili.push({ id: o.id, motivo: 'pavimento non calcolabile: ' + pav.motivo }); continue; }
    if (o.prezzo < pav.pavimento - 1e-9) {
      violazioni.push({ tipo: 'SELL-sotto-il-pavimento', id: o.id, mercato: o.mercato, prezzo: o.prezzo, carico: mia.avgPrice, pavimento: +pav.pavimento.toFixed(6) });
    } else ok.push({ id: o.id, motivo: `SELL a ${o.prezzo} >= pavimento ${+pav.pavimento.toFixed(4)}` });
  } else if (o.lato === 'BUY') {
    // Un BUY di COMPLETAMENTO e' quello sull'altro token dello stesso mercato.
    const sorella = mieiSulMercato.find((p) => String(p.tokenId) !== String(o.tokenId));
    if (!sorella) { ok.push({ id: o.id, motivo: 'BUY sullo stesso token posseduto o mercato senza gamba sorella: non e\' un completamento' }); continue; }
    if (!Number.isFinite(sorella.avgPrice)) { nonGiudicabili.push({ id: o.id, motivo: 'carico della gamba posseduta non leggibile' }); continue; }
    const coppia = sorella.avgPrice + o.prezzo;
    if (coppia > TETTO_COPPIA + 1e-9) {
      violazioni.push({ tipo: 'BUY-coppia-oltre-il-tetto', id: o.id, mercato: o.mercato, prezzo: o.prezzo, carico: sorella.avgPrice, coppiaCents: +(coppia * 100).toFixed(2) });
    } else ok.push({ id: o.id, motivo: `coppia ${(coppia * 100).toFixed(1)}c <= 101c` });
  }
}
const out = { istantanea: ORD, presaAl: snap.presaAl, ordiniEsaminati: (snap.ordini || []).length, violazioni, nonGiudicabili, conformi: ok.length };
fs.writeFileSync('/home/bot/bot/data/ricerca/uscite-illegali.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ ...out, violazioni, nonGiudicabili }, null, 2));

'use strict';
// scripts/ricerca/costo-scopertura-21-agosto.js — QUANTO COSTA UN FILL, dal book VERO di adesso.
// SOLA LETTURA. Cammina il book per la size vera e confronta col tetto di coppia 101¢.
const fs = require('fs'); const path = require('path');
const RADICE = path.resolve(__dirname, '..', '..');
const { fileRuntime, NOMI } = require(path.join(RADICE, 'lib', 'percorsi-runtime'));
const ORD = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'ricerca', 'ordini-vivi-21ago.json'), 'utf8'));
const LB = JSON.parse(fs.readFileSync(fileRuntime(NOMI.bookVivi), 'utf8')).markets;
const BD = Object.fromEntries(JSON.parse(fs.readFileSync(fileRuntime(NOMI.boardNormalizzato), 'utf8')).markets.map((m) => [m.marketId, m]));
const TETTO_COPPIA = 1.01;

/** Cammina il lato ASK di un book comprando `size` share. `null` se il book non copre. */
function camminaAcquisto(asks, size) {
  let resta = size, costo = 0, ultimo = null;
  for (const l of asks) {
    const p = Number(l.price), s = Number(l.size);
    if (!(p > 0) || !(s > 0)) continue;
    const q = Math.min(resta, s);
    costo += q * p; resta -= q; ultimo = p;
    if (resta <= 1e-9) return { medio: costo / size, peggiore: ultimo, costo };
  }
  return null;
}
/** Cammina il lato BID vendendo `size` share. */
function camminaVendita(bids, size) {
  let resta = size, ricavo = 0, ultimo = null;
  for (const l of bids) {
    const p = Number(l.price), s = Number(l.size);
    if (!(p > 0) || !(s > 0)) continue;
    const q = Math.min(resta, s);
    ricavo += q * p; resta -= q; ultimo = p;
    if (resta <= 1e-9) return { medio: ricavo / size, peggiore: ultimo, ricavo };
  }
  return null;
}

const righe = [];
const perMercato = new Map();
for (const o of ORD.ordini) { if (!perMercato.has(o.market)) perMercato.set(o.market, []); perMercato.get(o.market).push(o); }

for (const [id, ord] of perMercato) {
  const b = BD[id], L = LB[id];
  for (const o of ord) {
    const yes = String(o.asset_id) === String(b.tokenId);
    const nostro = yes ? L.yes : L.no;         // il book su cui sta la NOSTRA gamba
    const sorella = yes ? L.no : L.yes;        // il book dove si compra la gamba che manca
    const size = o.size;
    const acq = camminaAcquisto(sorella.levels.asks, size);
    const ven = camminaVendita(nostro.levels.bids, size);
    const coppia = acq ? o.price + acq.medio : null;
    righe.push({
      mercato: b.title.slice(0, 40), id: id.slice(0, 12), lato: yes ? 'YES' : 'NO',
      prezzoNostro: o.price, size,
      completamentoMedio: acq ? +acq.medio.toFixed(4) : null,
      coppiaCents: coppia != null ? +(coppia * 100).toFixed(2) : null,
      entroTetto: coppia != null ? coppia <= TETTO_COPPIA : null,
      // Se la coppia si completa: si pagano `coppia` per uno share che alla risoluzione vale $1.
      esitoCompletamentoUsd: coppia != null ? +((1 - coppia) * size).toFixed(2) : null,
      // Se invece si deve USCIRE vendendo la gamba (scala d'urgenza): ricavo - carico.
      esitoVenditaUsd: ven ? +((ven.medio - o.price) * size).toFixed(2) : null,
      venditaMedia: ven ? +ven.medio.toFixed(4) : null,
      // Gradino 2 della scala: concessione = 5% del carico.
      concessioneGradino2Usd: +(0.05 * o.price * size).toFixed(2),
    });
  }
}
fs.writeFileSync(path.join(RADICE, 'data', 'ricerca', 'costo-scopertura-21-agosto.json'), JSON.stringify({ at: new Date().toISOString(), tettoCoppia: TETTO_COPPIA, righe }, null, 1));

console.log('SE QUESTA GAMBA SI RIEMPISSE ADESSO — costo dalle due vie d\'uscita, book VERO camminato per la size vera');
console.log('mercato                                  lato  nostro   coppia   entro101  completa(+/-)  vende(+/-)  5% carico');
for (const r of righe) {
  console.log(`${r.mercato.padEnd(41)} ${r.lato.padEnd(4)} ${String(r.prezzoNostro).padStart(6)} ${String(r.coppiaCents).padStart(7)}¢ ${String(r.entroTetto).padStart(9)} ${String(r.esitoCompletamentoUsd).padStart(13)} ${String(r.esitoVenditaUsd).padStart(11)} ${String(r.concessioneGradino2Usd).padStart(9)}`);
}
const c = righe.filter((r) => r.esitoCompletamentoUsd != null).map((r) => r.esitoCompletamentoUsd);
const v = righe.filter((r) => r.esitoVenditaUsd != null).map((r) => r.esitoVenditaUsd);
console.log(`\ncompletamento coppia: da $${Math.min(...c).toFixed(2)} a $${Math.max(...c).toFixed(2)} per gamba · tutte entro il tetto: ${righe.every((r) => r.entroTetto === true)}`);
console.log(`uscita vendendo:      da $${Math.min(...v).toFixed(2)} a $${Math.max(...v).toFixed(2)} per gamba`);

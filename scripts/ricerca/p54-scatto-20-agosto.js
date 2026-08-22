'use strict';
// SOLA LETTURA — le QUATTRO letture anomale del 20 agosto, ricostruite al centesimo dalle componenti
// vere dell'osservatore, passate alla funzione di produzione. Piu' un CONTROLLO POSITIVO: senza, «zero
// scatti» non distinguerebbe «l'artefatto e' sparito» da «il guardiano e' morto».
const path = require('path'); const R = path.resolve(__dirname, '..', '..');
const G = require(path.join(R, 'lib/maker/guardian-perdite'));
const RIF = require(path.join(R, 'lib/maker/guardian-riferimento'));
const P = (s) => console.log(s);

// Le componenti VERE, dal giornale dell'osservatore del 20/08 (un mercato = una pseudo-posizione).
const sal = { '22:26': 1457.96, '22:30': 1402.98, '22:31': 1420.93, '22:34': 1425.50, '22:35': 1446.17 };
const pv  = { '22:26': 35.42, '22:30': 87.25, '22:31': 69.03, '22:34': 67.08, '22:35': 49.09 };
const pos = (v) => (v > 0 ? [{ tokenId: 'mercato-in-volo', size: 1, curPrice: v }] : []);
const T = (m) => Date.parse(`2026-08-20T${m}:00Z`);

P('LE QUATTRO LETTURE ANOMALE DEL 20 AGOSTO, RICOSTRUITE\n');
P('  quella che HA FATTO SCATTARE il guardiano:');
const casi = [
  ['22:36:02  $1438.41  (SCATTO)', '22:30', '22:26'],
  ['22:30:58  $1472.00  (verso basso)', '22:30', '22:31'],
  ['22:34:31  $1513.25  (verso ALTO)', '22:35', '22:34'],
];
for (const [nome, ts, tp] of casi) {
  // la lettura PRECEDENTE del guardiano: la coppia coerente immediatamente prima
  const prec = { at: T(ts) - 30000, saldoUsd: sal[ts], posizioni: pos(pv[tp] === undefined ? 0 : pv[tp]) };
  // la lettura anomala: STESSO saldo, posizioni di un altro istante
  const cap = G.valutaCapitale({
    saldoUsd: sal[ts], posizioni: pos(pv[tp]), posizioniLeggibili: true,
    riconciliazione: { at: T(ts), precedente: { at: T(ts) - 30000, saldoUsd: sal[ts] + 0, posizioni: pos(pv[tp]) } },
  });
  void prec;
  // Ricostruzione fedele: il guardiano vede DUE letture consecutive, la prima coerente col saldo
  // precedente, la seconda con la cassa gia' mossa e le posizioni ferme.
  const salPrec = { '22:30': 1441.09, '22:35': 1425.50 }[ts] ?? sal[ts];
  const vero = G.valutaCapitale({
    saldoUsd: sal[ts], posizioni: pos(pv[tp]), posizioniLeggibili: true,
    riconciliazione: { at: T(ts), precedente: { at: T(ts) - 30000, saldoUsd: salPrec, posizioni: pos(pv[tp]) } },
  });
  const tot = sal[ts] + pv[tp];
  P(`   ${nome}`);
  P(`     ricostruzione: saldo ${ts} ($${sal[ts].toFixed(2)}) + posizioni ${tp} ($${pv[tp].toFixed(2)}) = $${tot.toFixed(2)}`);
  P(`     col codice NUOVO ⇒ misurabile: ${vero.leggibile}   residuo $${vero.riconciliazione.residuoUsd}`);
  P(`     ${vero.leggibile ? '⚠ PASSA ANCORA' : '✔ RIFIUTATA — lo scatto non parte'}\n`);
  void cap;
}

P('CONTROLLO POSITIVO — una perdita VERA deve ancora far scattare il guardiano');
P('  (senza questo, «zero scatti» non distingue la cura dalla morte del guardiano)\n');
const RIFERIMENTO = 1501.6325;
const abs = RIF.sogliaAssoluta({ riferimentoUsd: RIFERIMENTO, pavimentoUsd: 30 }).sogliaUsd;
let stato = null; let scattato = null;
// due letture consecutive: le posizioni crollano di prezzo, la cassa NON si muove (P&L vero)
const seq = [
  [0, 1000, [{ tokenId: 'x', size: 1000, curPrice: 0.50 }]],   // totale 1500
  [30000, 1000, [{ tokenId: 'x', size: 1000, curPrice: 0.42 }]], // totale 1420 — sotto soglia
  [60000, 1000, [{ tokenId: 'x', size: 1000, curPrice: 0.41 }]], // totale 1410 — seconda conferma
];
let prec = null;
for (const [t, s, p] of seq) {
  const cap = G.valutaCapitale({ saldoUsd: s, posizioni: p, posizioniLeggibili: true,
    riconciliazione: { at: t, precedente: prec } });
  prec = { at: t, saldoUsd: s, posizioni: p };
  if (!cap.leggibile) { P(`   t=${t / 1000}s  NON misurabile (${cap.motivo.slice(0, 60)}…)`); continue; }
  const pnl = G.calcolaPnl({ baselineUsd: RIFERIMENTO, totaleUsd: cap.totaleUsd });
  const dec = G.decidiScatto({ pnl, sogliaPct: 5, sogliaAbs: abs });
  const conf = G.confermaScatto({ stato, decisione: dec, pnl, now: t, osservazione: { saldoLetturaAt: t } });
  stato = conf.stato;
  P(`   t=${t / 1000}s  totale $${cap.totaleUsd.toFixed(2)}  PnL $${pnl.pnlUsd.toFixed(2)}  oltre soglia: ${dec.scatta}  conferme ${conf.conferme}  SCATTA: ${conf.scatta}`);
  if (conf.scatta) scattato = t;
}
P(`\n  ⇒ il guardiano ${scattato !== null ? 'SCATTA' : 'NON scatta'} su una perdita vera di prezzo${scattato !== null ? ` (a t=${scattato / 1000}s, cioe' k=2 come prima)` : ''}`);
P(`  ⇒ soglia assoluta derivata dal riferimento: −$${abs.toFixed(2)}  ·  punto di scatto $${(RIFERIMENTO - abs).toFixed(2)}`);

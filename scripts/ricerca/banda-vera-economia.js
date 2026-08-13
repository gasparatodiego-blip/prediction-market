'use strict';
/**
 * scripts/ricerca/banda-vera-economia.js — SOLA LETTURA.
 *
 * Cosa cambia davvero con v = maxSpread invece di maxSpread/2, in dollari al giorno,
 * sul board vivo e con il nostro capitale vero.
 *
 * ⚠ IL PUNTO DA NON SBAGLIARE: v NON è una manopola. Il venue paga già con v =
 * maxSpread, oggi, su ogni ordine che abbiamo a libro. Cambiare il nostro codice non
 * cambia di un centesimo quanto matura un ordine già piazzato: cambia solo le nostre
 * DECISIONI (quali mercati, a quale prezzo, quando cancellare). Quindi il costo
 * dell'errore è tutto e solo nelle decisioni sbagliate, e si conta lì.
 *
 * Nessuna scrittura fuori da data/ricerca/.
 */

const fs = require('fs');
const path = require('path');
const conc = require('../../lib/rewards/concentration');

const OUT = path.join(__dirname, '..', '..', 'data', 'ricerca', 'banda-vera-economia.json');
const COMP = path.join(__dirname, '..', '..', 'data', 'ricerca', 'banda-competitivita.json');
const BOARD = path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json');

const CAPITALE = 650;
const COSTO_COPPIA = 0.98;
const C_FACTOR = 3;

const S = (s, v) => (!(v > 0) || s >= v) ? 0 : ((v - s) / v) ** 2;

function qMin(Qb, Qa, mid) {
  if (mid < 0.10 || mid > 0.90) return Math.min(Qb, Qa);
  return Math.max(Math.min(Qb, Qa), Math.max(Qb / C_FACTOR, Qa / C_FACTOR));
}

const comp = JSON.parse(fs.readFileSync(COMP, 'utf8'));
const board = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
const perCid = new Map((board.markets || []).map(m => [m.conditionId, m]));

const tetto = conc.capPerMarketUsd(CAPITALE);

// ── I mercati finanziabili: il pavimento premiante del mercato deve stare nel tetto.
// Questo cancello NON dipende dalla distanza dal mid, ed è il fatto che decide la
// domanda «allontanarsi permette di coprire più mercati?».
const candidati = [];
for (const r of comp.righe) {
  const m = perCid.get(r.conditionId);
  if (!m || !(m.rewardsDailyRate > 0)) continue;
  const pav = conc.pavimentoPremiante(r.minSize);
  const finanziabile = pav <= tetto + 1e-9;
  candidati.push({
    slug: r.slug, minSize: r.minSize, maxSpread: r.maxSpread, mid: r.mid,
    pool: m.rewardsDailyRate, pavimento: pav, finanziabile,
    qCompBids: r.larga.qBids, qCompAsks: r.larga.qAsks,
  });
}
const finanziabili = candidati.filter(c => c.finanziabile);

// ── Il nostro reward su UN mercato, quotando due lati a distanza s dal mid.
// Le due gambe comprano le STESSE share: Q = capitale / costoCoppia (§4.4).
//
// ⚠ SI APPLICA IL TETTO DI CREDIBILITÀ (§4.4, realistic-estimate.maxCredibleShare
// = 0,60). Senza, un mercato dal book sottile restituisce quota ≈ 1 e il modello
// dichiara che incassiamo l'INTERO montepremi: è la fantasia che quel tetto esiste
// per fermare, e senza di lui questa misura direbbe $637/giorno su $650.
const MAX_CREDIBLE_SHARE = 0.60;

function rewardMercato(c, sCents, capMercato) {
  const v = c.maxSpread;
  const sc = S(sCents, v);
  if (sc <= 0) return { S: sc, share: 0, usdGiorno: 0 };
  const share = capMercato / COSTO_COPPIA;      // share per lato
  const nostro = sc * share;                     // Q su ciascun lato, simmetrico
  const Qu = qMin(nostro, nostro, c.mid);
  const Qcomp = qMin(c.qCompBids, c.qCompAsks, c.mid);
  const grezza = Qu / (Qu + Qcomp);
  const quota = Math.min(grezza, MAX_CREDIBLE_SHARE);
  return { S: sc, share: quota, usdGiorno: quota * c.pool, quotaGrezza: grezza };
}

// ── La griglia dei prezzi è reale: tick 1¢ e mid a metà tick ⇒ le distanze
// possibili sono 0,5 · 1,5 · 2,5 · 3,5 · 4,5 centesimi. Non si valutano posizioni
// che il libro non permette di occupare.
const POSIZIONI = [0.5, 1.5, 2.5, 3.5];

function valuta(sCents, bandaRaggio) {
  // Un mercato è utilizzabile a questa distanza solo se la distanza sta DENTRO il
  // raggio di banda che si sta assumendo.
  const usabili = finanziabili.filter(c => sCents < Math.min(bandaRaggio, c.maxSpread) - 1e-9);
  const capMercato = tetto;
  const nMax = Math.floor(CAPITALE / capMercato);
  const valutati = usabili
    .map(c => ({ c, r: rewardMercato(c, sCents, capMercato) }))
    .sort((a, b) => b.r.usdGiorno - a.r.usdGiorno);
  const scelti = valutati.slice(0, Math.min(nMax, conc.MAX_MERCATI));
  const tot = scelti.reduce((a, x) => a + x.r.usdGiorno, 0);
  const alTetto = scelti.filter(x => x.r.quotaGrezza > MAX_CREDIBLE_SHARE).length;
  return {
    distanzaC: sCents,
    S: +S(sCents, 4.5).toFixed(4),                 // S sul mercato modale (maxSpread 4,5¢)
    mercatiUsabili: usabili.length,
    mercatiCoperti: scelti.length,
    mercatiAlTettoDiCredibilita: alTetto,
    capitalePerMercato: +capMercato.toFixed(2),
    capitaleImpiegato: +(scelti.length * capMercato).toFixed(2),
    rewardTotaleGiorno: +tot.toFixed(3),
    rewardMedioPerMercato: scelti.length ? +(tot / scelti.length).toFixed(4) : 0,
  };
}

// ── L'ANCORAGGIO ALLA MISURA. Il modello sopra è una curva, non un livello: poggia
// sui book di un istante e su un tetto di credibilità che è un'ASSUNZIONE (§5-bis
// p.154). Il livello vero che conosciamo è il consuntivo: $4,40/giorno a distanza
// mediana 1,0¢ (§5-bis p.152) — e quel numero eredita i 4 giorni di presenza su 30.
// Si riporta quindi il RAPPORTO fra posizioni, che è la parte robusta, scalato su
// quel livello. Il rapporto è robusto perché quando la nostra quota è piccola
// share ≈ Qu/Qcomp ∝ S, e S è aritmetica pura.
const REWARD_MISURATO_GIORNO = 4.40;
const S_ATTUALE = S(1.0, 4.5);                   // distanza mediana misurata, banda vera

const risultati = {
  generatoAl: new Date().toISOString(),
  capitale: CAPITALE,
  tettoPerMercato: tetto,
  MAX_MERCATI: conc.MAX_MERCATI,
  mercatiSulBoard: candidati.length,
  mercatiFinanziabili: finanziabili.length,
  mercatiScartatiDalPavimento: candidati.length - finanziabili.length,
  mercatiFinanziabiliCapitale: Math.floor(CAPITALE / tetto),
  // La stessa griglia valutata con le due letture della banda.
  conBandaStretta: POSIZIONI.map(s => valuta(s, 2.25)),
  conBandaVera: POSIZIONI.map(s => valuta(s, 4.5)),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(risultati, null, 1));

console.log(`capitale $${CAPITALE} · tetto per mercato $${tetto} · MAX_MERCATI ${conc.MAX_MERCATI}`);
console.log(`mercati sul board con montepremi: ${candidati.length}`);
console.log(`  finanziabili (pavimento premiante ≤ tetto): ${finanziabili.length}`);
console.log(`  scartati dal PAVIMENTO (non dalla banda):   ${candidati.length - finanziabili.length}`);
console.log(`  finanziabili DAL CAPITALE: ${Math.floor(CAPITALE / tetto)} mercati (650 / ${tetto})`);

for (const [nome, serie] of [['BANDA STRETTA (bot di oggi, raggio 2,25¢)', risultati.conBandaStretta],
                             ['BANDA VERA (raggio 4,5¢)', risultati.conBandaVera]]) {
  console.log(`\n${nome}`);
  console.log('  dist¢    S     usabili  coperti  $/mercato/g   TOTALE $/g');
  for (const r of serie) {
    console.log(`  ${String(r.distanzaC).padStart(5)}  ${String(r.S).padStart(6)}  ${String(r.mercatiUsabili).padStart(7)}  ${String(r.mercatiCoperti).padStart(7)}  ${String(r.rewardMedioPerMercato).padStart(11)}  ${String(r.rewardTotaleGiorno).padStart(10)}`);
  }
}

// ── La domanda dell'operatore: allontanarsi permette di coprire PIÙ mercati?
console.log('\n══ ALLONTANARSI PERMETTE DI COPRIRE PIÙ MERCATI? ══');
console.log('  il capitale per mercato NON dipende dalla distanza dal mid: lo fissano il');
console.log('  tetto ($' + tetto + ') e il pavimento premiante del mercato, che sono in dollari.');
console.log('  ⇒ mercati coperti = capitale / tetto = ' + Math.floor(CAPITALE / tetto) + ', a QUALUNQUE distanza.');
console.log('  verifica dalla tabella: la colonna "coperti" è costante a ' +
  [...new Set(risultati.conBandaVera.map(r => r.mercatiCoperti))].join('/') + '.');
console.log('  il vincolo che morde è il CAPITALE (19 finanziabili) contro ' + finanziabili.length +
  ' mercati disponibili e un tetto di ' + conc.MAX_MERCATI + ': la banda non è mai il collo.');

console.log('\n══ TOTALE ANCORATO ALLA MISURA ($4,40/g a 1,0¢, §5-bis p.152) ══');
console.log('  ⚠ eredita i 4 giorni di presenza su 30: è il livello, non il rapporto.');
console.log('  dist¢     S      rapporto vs oggi   $/giorno ancorato');
for (const r of risultati.conBandaVera) {
  const rap = r.S / S_ATTUALE;
  console.log(`  ${String(r.distanzaC).padStart(5)}  ${String(r.S).padStart(6)}  ${(rap).toFixed(3).padStart(16)}   ${(rap * REWARD_MISURATO_GIORNO).toFixed(2).padStart(16)}`);
}
risultati.ancorato = {
  rewardMisuratoGiorno: REWARD_MISURATO_GIORNO,
  distanzaAttualeC: 1.0, sAttuale: +S_ATTUALE.toFixed(4),
  avvertenza: 'il livello eredita 4 giorni di presenza su 30; il rapporto fra posizioni no',
  serie: risultati.conBandaVera.map(r => ({ distanzaC: r.distanzaC, S: r.S,
    rapportoVsOggi: +(r.S / S_ATTUALE).toFixed(3),
    usdGiornoAncorato: +(r.S / S_ATTUALE * REWARD_MISURATO_GIORNO).toFixed(2) })),
};
fs.writeFileSync(OUT, JSON.stringify(risultati, null, 1));
console.log(`\nscritto in ${OUT}`);

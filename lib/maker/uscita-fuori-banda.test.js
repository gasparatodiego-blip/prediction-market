'use strict';
// lib/maker/uscita-fuori-banda.test.js — L'USCITA PUO' GUARDARE FUORI DALLA BANDA PREMIANTE
// quando completare la coppia e' economicamente impossibile. 22 agosto 2026.
//
// ═══ IL DIFETTO, MISURATO ═══════════════════════════════════════════════════════════════════════
// `exit-plan.planExit` sapeva produrre SOLO prezzi dentro la banda premiante: il clamp porta il
// prezzo a `b.hi`, e se `b.hi` sta sotto il pavimento della scala il verdetto e' `no-target`, cioe'
// NESSUNA uscita. Il miglior bid del libro non veniva nemmeno guardato.
// Caso reale, MrBeast `0x4757745c` del 22 agosto 2026: bordo alto della banda 0,55 · pavimento
// concesso 0,646 (il 5% sotto il carico di 0,68, R7) · miglior bid 0,64 — fuori banda ma NOVE
// centesimi meglio di qualunque prezzo in banda, e mai considerato. Sul giornale la riga e'
// `auto-close skip-no-target` delle 18:12:44Z.
//
// ═══ COSA PROVA QUESTO FILE, E COSA NON PROVA ═══════════════════════════════════════════════════
// Prova il COMPORTAMENTO, non la costante: non asserisce «0,65», asserisce «l'uscita considera il
// bid fuori banda», «non scende MAI sotto il pavimento della scala», «il merge viene prima» e «il
// prezzo sta sulla griglia». I numeri del caso reale servono solo a costruire la fixture; il tappo
// del 5% (R7) e la scala di §7 NON sono toccati e non sono asseriti qui — vivono in
// `urgenza-scoperto` e sono provati la'.
//
// ⚠ ROSSO SUL SORGENTE NON CORRETTO: il blocco ① fallisce con `action === 'skip'`, `gate ===
// 'no-target'`.

const assert = require('assert');
const { decideClose } = require('./auto-close');
const { planExit, decideExit } = require('./exit-plan');
const { pavimentoConcesso } = require('./urgenza-scoperto');

let passati = 0;
const ok = (c, n) => { assert.ok(c, n); passati += 1; };

const TOK_NO = 'tokNO', TOK_YES = 'tokYES';
const CARICO = 0.68, SIZE = 31.25, TICK = 0.01, RAGGIO_C = 4.5;

/** La fixture del caso reale. Ogni blocco cambia UN campo solo. */
function stato({ mid = 0.51, bid = 0.64, askYes = 0.38, sizeAltroLato = 0, gradino = 2,
  asksLeggibili = true, bidLeggibile = true } = {}) {
  const rules = {
    readable: true, tick: TICK, minSize: 20, maxSpreadCents: RAGGIO_C,
    tokenId: TOK_YES, tokenIdNo: TOK_NO, midSource: 'live-book', midAgeSec: 3,
    books: {
      yes: { scoringMid: +(1 - mid).toFixed(4), bestBid: +(1 - mid - 0.01).toFixed(4), bestAsk: askYes },
      no: { scoringMid: mid, bestBid: bidLeggibile ? bid : null, bestAsk: +(bid + 0.02).toFixed(4) },
    },
  };
  return {
    position: { tokenId: TOK_NO, size: SIZE, avgPrice: CARICO },
    restingOrders: [], rules, book: 'no',
    venue: { closed: false, acceptingOrders: true, bestBid: bidLeggibile ? bid : null },
    urgenza: { livello: gradino, etichetta: 'x', minuti: 59,
      concessioneTick: gradino >= 2 ? 3 : 0, profitPct: gradino >= 1 ? 0 : 1,
      anomaliaGrave: false, motivo: '' },
    depth: {
      no: { bids: [{ price: bid, size: 500 }], asks: [{ price: +(bid + 0.02).toFixed(4), size: 500 }] },
      yes: { bids: [{ price: +(askYes - 0.02).toFixed(4), size: 500 }],
        asks: asksLeggibili ? [{ price: askYes, size: 500 }] : [] },
    },
    sizeAltroLato,
  };
}
const bandaHi = (mid) => Math.floor((mid + RAGGIO_C / 100) / TICK + 1e-9) * TICK;
const PAV = pavimentoConcesso({ carico: CARICO, tick: TICK, concessioneTick: 3 }).pavimento;

console.log('\n══ ① IL DIFETTO — con la coppia impossibile, il bid fuori banda DEVE essere considerato');
{
  const d = decideClose(stato());
  // Non si asserisce un prezzo: si asserisce che l'uscita ESISTE e che ha guardato fuori banda.
  ok(d.action !== 'skip', `l'uscita non e' piu' un rifiuto (era ${d.action}/${d.gate})`);
  ok(d.price > bandaHi(0.51) + 1e-9, `il prezzo ${d.price} sta OLTRE il bordo alto della banda ${bandaHi(0.51).toFixed(2)}`);
  ok(d.inBand === false, 'e il verdetto lo dichiara: fuori banda');
  ok(d.fuoriBandaVoluta === true && d.coppiaImpossibile === true, 'il verdetto dichiara la deroga e la sua causa');
  ok(d.size === SIZE, 'si vende TUTTA la posizione, non una parte (un residuo sotto il minimo non ha via d\'uscita)');
  // Il fatto che rende la lacuna reale: il prezzo scelto e' MIGLIORE di ogni prezzo in banda.
  ok(d.price > bandaHi(0.51), 'il prezzo fuori banda batte qualunque prezzo la banda potesse offrire');
}

console.log('\n══ ② IL PAVIMENTO NON SI ALLARGA — su tutta la scala dei bid possibili');
{
  let sotto = 0, fuoriGriglia = 0, casi = 0;
  for (let bidC = 1; bidC <= 98; bidC += 1) {
    for (const mid of [0.20, 0.35, 0.51, 0.55, 0.66, 0.80]) {
      const d = decideClose(stato({ bid: +(bidC / 100).toFixed(2), mid }));
      if (d.action === 'skip') continue;
      casi += 1;
      if (d.price < PAV - 1e-9) sotto += 1;
      if (Math.abs(d.price / TICK - Math.round(d.price / TICK)) > 1e-6) fuoriGriglia += 1;
    }
  }
  ok(casi > 100, `la sweep ha prodotto ${casi} uscite vere`);
  ok(sotto === 0, `nessuna uscita sotto il pavimento della scala (${PAV}): ${sotto} su ${casi}`);
  // E' il difetto che ha rifiutato 55 ordini di fila il 22 agosto (`OFF_TICK` a 0,646): un prezzo
  // che non sta sulla griglia non e' un ordine, e la deroga non deve poterne produrre.
  ok(fuoriGriglia === 0, `nessun prezzo fuori dalla griglia del tick: ${fuoriGriglia} su ${casi}`);
}

console.log('\n══ ③ IL MERGE VIENE PRIMA, SEMPRE');
{
  const d = decideClose(stato({ sizeAltroLato: SIZE }));
  ok(d.action === 'skip' && d.gate === 'no-target',
    'possedendo la gamba sorella la deroga NON si apre: si fonde, non si vende');
  const nonLetta = decideClose(stato({ sizeAltroLato: null }));
  ok(nonLetta.action === 'skip', 'size dell\'altro lato NON LETTA ⇒ nessuna deroga (fail-closed)');
}

console.log('\n══ ④ FAIL-CLOSED — ogni ingresso mancante chiude la deroga');
{
  ok(decideClose(stato({ askYes: 0.30 })).action === 'skip',
    'coppia PERCORRIBILE (98¢ ≤ 101¢): nessuna deroga, si continua sulla strada della coppia');
  ok(decideClose(stato({ asksLeggibili: false })).action === 'skip',
    'ask dell\'altro lato non leggibile ⇒ la coppia non e\' misurabile ⇒ nessuna deroga');
  const senzaBid = decideClose(stato({ bidLeggibile: false }));
  ok(senzaBid.action === 'skip', 'miglior bid non leggibile ⇒ nessuna deroga');
}

console.log('\n══ ⑤ MONOTONIA — senza il flag, `planExit` e\' la funzione di prima');
{
  let diversi = 0, peggiori = 0, confronti = 0;
  for (let midC = 5; midC <= 95; midC += 1) {
    for (const g of [0, 1, 2]) {
      const comune = { entryPrice: CARICO, scoringMid: midC / 100, tick: TICK, bandRadiusCents: RAGGIO_C,
        profitPct: g >= 1 ? 0 : 1, concessioneTick: g >= 2 ? 3 : 0 };
      const senza = planExit(comune);
      const senzaFlagMaConBid = planExit({ ...comune, miglioreBid: 0.64 });
      const con = planExit({ ...comune, uscitaFuoriBanda: true, miglioreBid: 0.64 });
      confronti += 1;
      if (senza.ok !== senzaFlagMaConBid.ok || senza.price !== senzaFlagMaConBid.price) diversi += 1;
      // La deroga puo' solo AGGIUNGERE un'uscita o ALZARNE il prezzo, mai abbassarlo.
      if (senza.ok === true && con.ok === true && con.price < senza.price - 1e-9) peggiori += 1;
      if (senza.ok === true && con.ok !== true) peggiori += 1;
    }
  }
  ok(diversi === 0, `il bid da solo non cambia niente: ${diversi} divergenze su ${confronti}`);
  ok(peggiori === 0, `la deroga non abbassa mai un'uscita ne' la fa sparire: ${peggiori} su ${confronti}`);
}

console.log('\n══ ⑥ IL PREMIO PERSO E\' ZERO PER COSTRUZIONE');
{
  // Un ordine fuori banda non matura reward. Ma un'uscita fuori banda che RESTA A RIPOSO si sceglie
  // SOLO dove la banda non offriva nessun prezzo accettabile — cioe' dove prima non c'era nessun
  // ordine da cui maturare. Quando invece il bid e' dentro la portata del prezzo scelto, l'ordine
  // attraversa e si riempie: non riposa, quindi non c'e' nessun premio da perdere.
  let riposaConAlternativaInBanda = 0, casi = 0;
  for (let bidC = 1; bidC <= 98; bidC += 1) {
    for (let midC = 10; midC <= 90; midC += 1) {
      const bid = +(bidC / 100).toFixed(2);
      const d = decideClose(stato({ bid, mid: midC / 100 }));
      if (d.action === 'skip' || d.fuoriBandaVoluta !== true) continue;
      casi += 1;
      const riposa = d.price > bid + 1e-9;              // non attraversa: resta a libro
      if (!riposa) continue;
      // Esisteva un'uscita DENTRO banda che la scala avrebbe accettato?
      const inBanda = planExit({ entryPrice: CARICO, scoringMid: midC / 100, tick: TICK,
        bandRadiusCents: RAGGIO_C, profitPct: 0, concessioneTick: 3 });
      if (inBanda.ok === true) riposaConAlternativaInBanda += 1;
    }
  }
  ok(casi > 200, `la sweep ha prodotto ${casi} uscite fuori banda`);
  ok(riposaConAlternativaInBanda === 0,
    'un\'uscita fuori banda RESTA A RIPOSO solo dove nessuna uscita in banda era ammessa:'
    + ` premio perso = 0 (violazioni: ${riposaConAlternativaInBanda})`);
}

console.log('\n══ ⑦ IL TRIGGER DI BANDA NON CHIUDE A MERCATO UN\'USCITA FUORI BANDA VOLUTA');
{
  const comune = { exitPrice: 0.65, restingSinceMs: Date.now() - 60_000, scoringMid: 0.51,
    bandRadiusCents: RAGGIO_C, tick: TICK };
  ok(decideExit(comune).action === 'close-at-market',
    'senza la dichiarazione il trigger di banda scatta come sempre');
  const voluta = decideExit({ ...comune, fuoriBandaVoluta: true });
  ok(voluta.action === 'hold' && voluta.trigger === null,
    'con la dichiarazione non si chiude a mercato al bid, che starebbe SOTTO il pavimento');
  // ⚠ Il tetto di tempo NON dipende dalla banda e resta l'unica via d'uscita: non si mura niente.
  const scaduta = decideExit({ ...comune, fuoriBandaVoluta: true, restingSinceMs: Date.now() - 25 * 3_600_000 });
  ok(scaduta.action === 'close-at-market' && scaduta.trigger === 'max-wait',
    'il tetto di attesa resta intatto anche su un\'uscita fuori banda');
}

console.log(`\n✅ ${passati}/${passati} — l'uscita guarda fuori banda, mai sotto il pavimento, e il merge viene prima\n`);

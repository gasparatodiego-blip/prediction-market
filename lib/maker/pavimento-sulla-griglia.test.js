'use strict';
// lib/maker/pavimento-sulla-griglia.test.js — IL PAVIMENTO DELLA SCALA D'USCITA DEVE ESSERE UN PREZZO
// ESPRIMIBILE, sul percorso IN BANDA come su quello fuori banda. 22 agosto 2026.
//
// ═══ IL DIFETTO, MISURATO SUL GIORNALE ══════════════════════════════════════════════════════════
// `pavimentoConcesso` è una frazione del carico (il 5%, R7) e non cade quasi mai su un tick:
// `0,68 × 0,95 = 0,646` e `0,37 × 0,95 = 0,3515` non sono prezzi esprimibili su una griglia da 1¢.
// `auto-close.inseguiIlBid` lo usa come `Math.max`, quindi appena il bid scende sotto il pavimento il
// PREZZO DELL'ORDINE diventa il pavimento stesso, e il guard condiviso lo rifiuta con `OFF_TICK`.
//   · 25 rifiuti `skip-guard-refused` a 0,646 su `0x4757745c` (22/08, 17:47:27Z → 18:14:49Z)
//   · 107 rifiuti `skip-remainder-below-min-size` con codici `OFF_TICK,BELOW_MIN_SIZE` su
//     `0xac3ee338` (20-21/08, carico 0,37 ⇒ pavimento 0,3515) — lì la deroga sul minimo del venue
//     non si applica PROPRIO PERCHÉ c'è anche OFF_TICK, quindi l'arrotondamento le sblocca tutte.
//   · 15 sullo stesso schema su `0x70620889`. Totale 147 righe con OFF_TICK nel giornale vivo.
//
// ⚠ ROSSO SUL SORGENTE NON CORRETTO: il blocco ① fallisce con `action === 'skip'`,
// `gate === 'guard-refused'`, `prezzo 0.646`.
//
// ⚠ COSA NON PROVA: il tappo del 5% (R7) e la scala di §7 non sono toccati e non si asseriscono qui.
// L'arrotondamento è IN SU, quindi può solo STRINGERE la concessione, mai allargarla — ed è la
// proprietà ③.

const assert = require('assert');
const { decideClose } = require('./auto-close');
const { planExit } = require('./exit-plan');
const { pavimentoConcesso } = require('./urgenza-scoperto');

let passati = 0;
const ok = (c, n) => { assert.ok(c, n); passati += 1; };
const suGriglia = (x, t) => Number.isFinite(x) && Math.abs(x / t - Math.round(x / t)) < 1e-6;

/** La fixture: banda che CONTIENE il pavimento (⇒ percorso IN BANDA) e bid SOTTO il pavimento. */
function stato({ carico, size = 60, tick = 0.01, mid, bid, askAltro = 0.30, minSize = 20, gradino = 2 }) {
  return {
    position: { tokenId: 'tokN', size, avgPrice: carico },
    restingOrders: [],
    rules: {
      readable: true, tick, minSize, maxSpreadCents: 4.5,
      tokenId: 'tokY', tokenIdNo: 'tokN', midSource: 'live-book', midAgeSec: 3,
      books: { yes: { scoringMid: +(1 - mid).toFixed(4), bestBid: +(1 - mid - tick).toFixed(4), bestAsk: askAltro },
        no: { scoringMid: mid, bestBid: bid, bestAsk: +(bid + 2 * tick).toFixed(4) } },
    },
    book: 'no', venue: { closed: false, acceptingOrders: true, bestBid: bid },
    urgenza: { livello: gradino, minuti: 59, concessioneTick: gradino >= 2 ? 3 : 0, profitPct: gradino >= 1 ? 0 : 1 },
    depth: { no: { bids: [{ price: bid, size: 900 }], asks: [{ price: +(bid + 2 * tick).toFixed(4), size: 900 }] },
      yes: { bids: [{ price: +(askAltro - 2 * tick).toFixed(4), size: 900 }], asks: [{ price: askAltro, size: 900 }] } },
    sizeAltroLato: 0,
  };
}

console.log('\n══ ① IL DIFETTO — sul percorso IN BANDA un pavimento fuori griglia deve diventare un ORDINE');
{
  // MrBeast `0x4757745c`: carico 0,68 ⇒ pavimento 0,646. La banda arriva a 0,70, quindi la deroga
  // fuori banda della Parte B NON c'entra: siamo sul percorso ordinario, e la coppia è percorribile.
  const d = decideClose(stato({ carico: 0.68, size: 31.25, mid: 0.66, bid: 0.60 }));
  ok(d.fuoriBandaVoluta !== true, 'siamo sul percorso IN BANDA, non sulla deroga della Parte B');
  ok(d.action !== 'skip', `l'uscita non è più un rifiuto (era ${d.action}/${d.gate} a ${d.price})`);
  ok(suGriglia(d.price, 0.01), `il prezzo ${d.price} sta sulla griglia da 1¢`);
  ok(d.price >= pavimentoConcesso({ carico: 0.68, tick: 0.01, concessioneTick: 3 }).pavimento - 1e-9,
    'e non è sceso sotto il pavimento della scala');
  // `0xac3ee338`: carico 0,37 ⇒ pavimento 0,3515. Stesso difetto, 107 rifiuti veri.
  const e = decideClose(stato({ carico: 0.37, mid: 0.35, bid: 0.30 }));
  ok(e.action !== 'skip' && suGriglia(e.price, 0.01),
    `stesso difetto su un carico diverso: ${e.action}/${e.gate} a ${e.price}`);
}

console.log('\n══ ② OGNI PREZZO PRODOTTO STA SULLA GRIGLIA — su due griglie e tutta la scala dei carichi');
{
  let fuori = 0, casi = 0, sottoPav = 0;
  for (const tick of [0.01, 0.001]) {
    for (let cC = 3; cC <= 97; cC += 1) {
      const carico = +(cC / 100).toFixed(4);
      const pav = pavimentoConcesso({ carico, tick, concessioneTick: 3 });
      for (const dMid of [-0.04, -0.02, 0, 0.02, 0.04]) {
        const mid = +(carico + dMid).toFixed(4);
        if (!(mid > 0.05 && mid < 0.95)) continue;
        for (const dBid of [-0.05, -0.01, 0.01]) {
          const bid = +(Math.max(tick, mid + dBid)).toFixed(4);
          const d = decideClose(stato({ carico, tick, mid, bid }));
          if (d.action === 'skip' || !Number.isFinite(d.price)) continue;
          casi += 1;
          if (!suGriglia(d.price, tick)) fuori += 1;
          if (d.price < pav.pavimento - 1e-9) sottoPav += 1;
        }
      }
    }
  }
  ok(casi > 500, `la sweep ha prodotto ${casi} uscite vere`);
  ok(fuori === 0, `nessun prezzo fuori dalla griglia del tick: ${fuori} su ${casi}`);
  ok(sottoPav === 0, `nessun prezzo sotto il pavimento ESATTO della scala: ${sottoPav} su ${casi}`);
}

console.log('\n══ ③ L\'ARROTONDAMENTO PUÒ SOLO STRINGERE — mai allargare la concessione');
{
  let allargati = 0, confronti = 0;
  for (const tick of [0.01, 0.001]) {
    for (let cC = 3; cC <= 97; cC += 1) {
      const carico = +(cC / 100).toFixed(4);
      for (const ct of [0, 3]) {
        const p = pavimentoConcesso({ carico, tick, concessioneTick: ct });
        confronti += 1;
        // Il pavimento come PREZZO non scende mai sotto il pavimento ESATTO: in su, mai in giù.
        if (p.pavimentoGriglia < p.pavimento - 1e-12) allargati += 1;
        // E non si allontana di più di un tick: è un arrotondamento, non una seconda regola.
        if (p.pavimentoGriglia > p.pavimento + tick + 1e-12) allargati += 1;
      }
    }
  }
  ok(allargati === 0, `l'arrotondamento è sempre IN SU e sempre entro un tick: ${allargati} su ${confronti}`);
}

console.log('\n══ ④ UN SOLO PUNTO DI ARROTONDAMENTO, E I DUE PERCORSI CHIAMANO QUELLO');
{
  const fs = require('fs');
  const path = require('path');
  // ⚠ I COMMENTI SI FILTRANO PRIMA: un commento che racconta la riga giusta ha già fatto passare un
  // test che cercava la stringa nel sorgente (§5.3, e mi ha già morso oggi su `prezzo-in-coda`).
  const nudo = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const ep = nudo('exit-plan.js');
  const us = nudo('urgenza-scoperto.js');
  ok(/pavimentoGriglia/.test(us) && /Math\.ceil\(x \/ tick/.test(us),
    'l\'arrotondamento vive in `urgenza-scoperto`, insieme all\'aritmetica del pavimento');
  ok(!/snapTo\(\s*pavimento/.test(ep) && !/Math\.ceil\([^)]*pavimento/.test(ep),
    '`exit-plan` non arrotonda per conto suo: legge `pav.pavimentoGriglia`');
  ok(/pav\.pavimentoGriglia/.test(ep), 'e lo legge davvero dal modulo che lo possiede');
  // La proprietà che conta: UN solo `Math.ceil` sul pavimento in tutto il percorso d'uscita.
  const arrotondamenti = (us.match(/Math\.ceil\(x \/ tick/g) || []).length
    + (ep.match(/Math\.ceil\([^)]*pavimento/g) || []).length;
  ok(arrotondamenti === 1, `un solo arrotondamento del pavimento: ${arrotondamenti}`);
}

console.log('\n══ ⑤ I DUE PERCORSI USANO LO STESSO NUMERO');
{
  const comune = { entryPrice: 0.68, tick: 0.01, bandRadiusCents: 4.5, profitPct: 0, concessioneTick: 3 };
  const inBanda = planExit({ ...comune, scoringMid: 0.66 });                              // b.hi 0,70
  const fuori = planExit({ ...comune, scoringMid: 0.51, uscitaFuoriBanda: true, miglioreBid: 0.64 });
  ok(inBanda.ok === true && fuori.ok === true, 'entrambi i percorsi producono un piano');
  ok(inBanda.pavimento === fuori.pavimento,
    `stesso pavimento sui due percorsi: ${inBanda.pavimento} vs ${fuori.pavimento}`);
  ok(inBanda.pavimentoNonArrotondato === fuori.pavimentoNonArrotondato,
    'e stesso numero esatto a verbale, per l\'audit');
}

console.log('\n══ ⑥ L\'ARROTONDAMENTO NON PUÒ SPINGERE IL PREZZO FUORI DALLA BANDA');
{
  // `b.hi` sta già sulla griglia, quindi `b.hi >= pavimento` implica `b.hi >= pavimentoGriglia`.
  // È la ragione per cui il CONFRONTO resta sul numero esatto e il PREZZO usa quello arrotondato.
  let violazioni = 0, casi = 0;
  for (const tick of [0.01, 0.001]) {
    for (let cC = 3; cC <= 97; cC += 1) {
      const carico = +(cC / 100).toFixed(4);
      const pav = pavimentoConcesso({ carico, tick, concessioneTick: 3 });
      for (let mC = 5; mC <= 95; mC += 2) {
        const p = planExit({ entryPrice: carico, scoringMid: mC / 100, tick,
          bandRadiusCents: 4.5, profitPct: 0, concessioneTick: 3 });
        if (p.ok !== true || p.clampedBy === 'fuori-banda-coppia-impossibile') continue;
        casi += 1;
        if (p.bandHi != null && p.bandHi >= pav.pavimento - 1e-12
          && p.bandHi < pav.pavimentoGriglia - 1e-12) violazioni += 1;
      }
    }
  }
  ok(casi > 500, `la sweep ha coperto ${casi} piani in banda`);
  ok(violazioni === 0, `il pavimento arrotondato non supera mai il bordo alto della banda: ${violazioni}`);
}

console.log(`\n✅ ${passati}/${passati} — il pavimento è un prezzo esprimibile su entrambi i percorsi\n`);

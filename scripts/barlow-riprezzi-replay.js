#!/usr/bin/env node
'use strict';
// RIGIOCA I 21 RIPREZZI DI ERIC BARLOW DEL 5 AGOSTO 2026 CON LA LOGICA NUOVA.
//
// ═══ A COSA SERVE ════════════════════════════════════════════════════════════════════════════════════
// Il rilevamento del conflitto fra inseguimento del mid e «mai primi sul libro» è stato scritto per un
// episodio preciso: 20:34:19 → 20:40:09, 21 riprezzi in sei minuti su Eric Barlow, uno ogni ~35s, fino a
// bruciare il tetto orario e — per il difetto gemello — perdere le due gambe alla scadenza GTD.
//
// Un test con numeri scelti a mano dimostra che la funzione fa quello che dice. QUESTO dimostra una cosa
// diversa e non sostituibile: che su quei fatti, quelli veri, la decisione cambia. Gli ingressi non sono
// inventati — vengono da data/polymarket-maker-audit.jsonl, cioè dal registro append-only che quel giorno
// ha registrato ogni singola mossa:
//   · `observed.price`, `observed.scoringMid`, `observed.secondsToExpiry`  ⇒ lo stato dell'ordine
//   · `requested.toPrice`                                                  ⇒ dove l'inseguimento voleva andare
//   · `priceAdjusted.inCoda.bestOther` della riga di piazzamento appaiata  ⇒ il concorrente che «mai
//     primi» ha guardato, e quindi il prezzo a cui l'ordine è REALMENTE atterrato
//
// ═══ COME LEGGERE L'ESITO ════════════════════════════════════════════════════════════════════════════
// Ogni riga «SOPPRESSO» è un riprezzo che oggi non partirebbe: una cancellazione e un piazzamento in
// meno al venue, e un ventunesimo di tetto orario non consumato.
//
// ═══ NON TOCCA NIENTE ════════════════════════════════════════════════════════════════════════════════
// Legge un file e chiama una funzione pura. Nessun venue, nessun ordine, nessuna scrittura.
//
// Uso:  node scripts/barlow-riprezzi-replay.js [percorso-audit.jsonl]

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { decideReprice } = require('../lib/maker/auto-reprice');
const { DATA_DIR } = require('../lib/safety/store');

const MKT = '0xfb481845055afdf15febad269fcb534be4c5e79d5789b72659a036660b46e11b';
const REF = `cid_${MKT.replace(/^0x/, '')}`;
// L'episodio: dal primo riprezzo automatico all'ultimo. 5 agosto 2026, 20:34:00 → 20:41:00 UTC.
const DA = Date.parse('2026-08-05T20:34:00Z');
const A = Date.parse('2026-08-05T20:41:00Z');

// La configurazione REALE del watcher (lib/maker/auto-reprice-config.js DEFAULTS) e la distanza-bersaglio
// realmente in uso su Barlow quel giorno (data/maker-offsets.json: 0.55¢ su entrambi i lati, «osservata»
// al primo piazzamento). Non sono numeri scelti qui: sono quelli che hanno prodotto l'episodio.
const CFG = {
  restingGtdSeconds: 1380, refreshMarginSeconds: 180, minIntervalMs: 30_000, maxPerHour: 20,
  maxMidAgeSecLive: 60, maxMidAgeSecBlind: 10, feedAliveMinAssets: 5, requireLiveBook: true,
  confirmSamples: 2, hysteresisTicks: 1, pollMs: 5000, strategy: 'band-edge', disconnectCancelSeconds: 180,
};
const TARGET_OFFSET_C = 0.55;
const TICK = 0.001;

const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);
const c3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : '?');

function rules(book, scoringMid) {
  // Il mid dell'altro libro è lo specchio: è la stessa relazione che resolveMarketRules pubblica.
  const yes = book === 'yes' ? scoringMid : +(1 - scoringMid).toFixed(6);
  return {
    readable: true, missing: [], marketId: MKT, title: 'Eric Barlow', mid: yes,
    tick: TICK, minSize: 50, maxSpreadCents: 4.5, tokenId: 'ty', tokenIdNo: 'tn',
    midSource: 'live-book', midAgeSec: 2,
    feedVitality: { assetsWithEvents: 40, seededAssets: 100, windowMs: 30_000 },
    books: { yes: { tokenId: 'ty', scoringMid: yes }, no: { tokenId: 'tn', scoringMid: +(1 - yes).toFixed(6) } },
  };
}

async function raccogli(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const trigger = [];
  const piazzamenti = [];
  for await (const line of rl) {
    // Filtro a stringa prima di parsare: il registro sta su centinaia di MB e parsarlo tutto lo farebbe
    // finire in memoria per intero.
    if (!line || line.indexOf(REF) < 0) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const t = Number(r.ts);
    if (!Number.isFinite(t) || t < DA || t > A) continue;
    if (r.source !== 'auto-reprice-band-exit') continue;
    if (r.outcome === 'trigger' && r.observed && r.requested) trigger.push(r);
    else if (r.op === 'manual-place' && r.priceAdjusted && r.priceAdjusted.inCoda) piazzamenti.push(r);
  }
  return { trigger, piazzamenti };
}

// Il concorrente che «mai primi» ha guardato per quel lato, preso dalla riga di piazzamento più vicina
// nel tempo su quello stesso lato. È un fatto registrato, non una ricostruzione.
function bestOtherPerLato(piazzamenti, book, ts) {
  let best = null, dist = Infinity;
  for (const p of piazzamenti) {
    if (!p.requested || p.requested.book !== book) continue;
    const bo = p.priceAdjusted.inCoda.bestOther;
    if (!Number.isFinite(bo)) continue;
    const d = Math.abs(Number(p.ts) - ts);
    if (d < dist) { dist = d; best = bo; }
  }
  return best;
}

(async () => {
  const file = process.argv[2] || path.join(DATA_DIR, 'polymarket-maker-audit.jsonl');
  if (!fs.existsSync(file)) {
    console.error(`registro non trovato: ${file}`);
    process.exit(2);
  }
  console.log(`\nRIGIOCO L'EPISODIO DI ERIC BARLOW · ${file}`);
  console.log(`finestra ${hhmmss(DA)} → ${hhmmss(A)} UTC del 5 agosto 2026, tick ${TICK}, bersaglio ${TARGET_OFFSET_C}¢\n`);

  const { trigger, piazzamenti } = await raccogli(file);
  if (!trigger.length) {
    console.error('nessun riprezzo trovato nella finestra: il registro non copre più quell\'episodio.');
    process.exit(2);
  }

  let soppressi = 0, ancoraRiprezzati = 0, altro = 0;
  console.log('  ora        lato  ordine a   mid      dist   inseguiva  «mai primi»  esito');
  console.log('  ' + '─'.repeat(96));
  for (const r of trigger) {
    const book = r.requested.book === 'no' ? 'no' : 'yes';
    const bestOther = bestOtherPerLato(piazzamenti, book, Number(r.ts));
    // La profondità come il feed la pubblicava: il concorrente davanti, e il nostro ordine dietro.
    // `prezzoInCoda` sottrae i nostri livello per livello, quindi il nostro va incluso per essere tolto.
    const depth = {
      yes: { bids: [], asks: [] }, no: { bids: [], asks: [] },
    };
    depth[book].bids = [
      ...(Number.isFinite(bestOther) ? [{ price: bestOther, size: 500 }] : []),
      { price: r.observed.price, size: r.requested.size },
    ];

    const d = decideReprice({
      order: {
        orderId: r.orderId, price: r.observed.price, size: r.requested.size, book, side: 'BUY',
        secondsToExpiry: r.observed.secondsToExpiry,
      },
      rules: rules(book, r.observed.scoringMid),
      config: CFG,
      // Nessun rail: si misura la DECISIONE, non i limiti di frequenza. Con i rail attivi il verdetto
      // sarebbe «skip» per un altro motivo, e non si vedrebbe se il conflitto è stato riconosciuto.
      lastRepriceAt: null, repricesThisHour: 0, consecutiveBreaches: 0, now: Number(r.ts),
      ownOrders: [{ orderId: r.orderId, price: r.observed.price, size: r.requested.size, book }],
    }, {
      resolveOffset: () => ({ targetOffsetCents: TARGET_OFFSET_C, source: 'observed', minMoveCents: 0.1 }),
      resolveDepth: () => depth,
    });

    const soppresso = d.action === 'hold' && d.gate === 'inseguimento-contro-mai-primo';
    if (soppresso) soppressi += 1;
    else if (d.action === 'reprice') ancoraRiprezzati += 1;
    else altro += 1;

    console.log(`  ${hhmmss(Number(r.ts))}   ${book.toUpperCase().padEnd(4)}  ${String(r.observed.price).padEnd(9)}`
      + ` ${String(r.observed.scoringMid).padEnd(8)} ${c3(r.observed.distanceC).padEnd(6)}`
      + ` ${String(r.requested.toPrice).padEnd(10)} ${String(d.maiPrimoPrezzo ?? bestOther ?? '?').padEnd(12)}`
      + ` ${soppresso ? 'SOPPRESSO' : d.action === 'reprice' ? `riprezza → ${d.targetPrice}` : `${d.action}/${d.gate}`}`);
  }

  console.log('  ' + '─'.repeat(96));
  console.log(`\n  riprezzi nell'episodio reale: ${trigger.length}`);
  console.log(`  con la logica nuova SOPPRESSI: ${soppressi}`);
  console.log(`  ancora riprezzati:             ${ancoraRiprezzati}`);
  if (altro) console.log(`  fermati da altro:              ${altro}`);
  console.log(`\n  ${soppressi === trigger.length
    ? 'Il ciclo non parte: il primo riprezzo era già una richiesta di allontanarsi dal mid, perché la mano\n  che ha piazzato l\'ordine lo aveva già messo dove «mai primi» lo vuole (0.652 → 0.649).'
    : `Il ciclo si ferma dopo ${ancoraRiprezzati} mossa/e.`}\n`);
  process.exit(0);
})();

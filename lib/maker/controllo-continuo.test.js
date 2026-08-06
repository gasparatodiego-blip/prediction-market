#!/usr/bin/env node
'use strict';
// IL CONTROLLO È CONTINUO, NON A CHECKPOINT — E QUESTO FILE LO DIMOSTRA COL CASO CHE CONTA.
//
// ═══ LA DOMANDA ══════════════════════════════════════════════════════════════════════════════════════
// «Un ordine che diventa non conforme A METÀ fra due rinnovi GTD resta scoperto fino al rinnovo?»
//
// La risposta è NO, e la prova non è che il codice sembri giusto: è che `decideReprice` — la funzione
// che il ciclo di agent40 chiama su OGNI ordine a riposo a ogni giro — restituisce `cancel`/`reprice`
// su un ordine con 20 MINUTI di GTD ancora davanti. Se il controllo fosse legato al rinnovo, quello
// stesso ordine tornerebbe `hold` fino a quando non mancano 3 minuti alla scadenza.
//
// ═══ COSA È GIÀ VERO NEL SISTEMA (misurato, non supposto) ════════════════════════════════════════════
// Due orologi indipendenti, entrambi molto più stretti del GTD da ~23 minuti:
//
//   · agent40 · `cycle` (auto-reprice)   ogni `pollMs` = 5.000 ms — itera `for (const order of owned)`,
//                                        cioè OGNI ordine a riposo, e applica banda + mai-primo-sul-book
//                                        + profondità + rinnovo GTD.
//   · agent40 · `runTracking` (mm-track) PUSH da `fs.watch` sullo snapshot di agent34, con debounce
//                                        120 ms, più un battito di sicurezza ogni TRACKING_POLL_MS.
//
// Quindi la finestra di scopertura reale non è 23 minuti: è al più un giro da 5 secondi. Questo file
// inchioda la proprietà perché resti vera, non perché sia nuova.
//
// NESSUN ORDINE REALE: `decideReprice` è pura e qui riceve un book iniettato.

const fs = require('fs');
const path = require('path');
const { decideReprice } = require('./auto-reprice');
const { findAdaptiveDepthLevelSafe, findAdaptiveDepthLevelRisk } = require('./depth-adattiva');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const c = (p) => (p == null ? '—' : `${(p * 100).toFixed(0)}¢`);

// GTD da 1380s (23 min), rinnovo a 180s dalla scadenza: la finestra "a metà" è tutto ciò che sta
// fra il piazzamento e i 180s finali.
const cfg = {
  hysteresisTicks: 0, confirmSamples: 1, minIntervalMs: 0, maxPerHour: 99, strategy: 'band-edge',
  restingGtdSeconds: 1380, refreshMarginSeconds: 180, requireLiveBook: false, maxMidAgeSec: 60,
};
const mk = (mid, extra = {}) => ({
  readable: true, marketId: `0x${'a'.repeat(64)}`, tick: 0.01, maxSpreadCents: 4.5, minSize: 20,
  midAgeSec: 5, books: { yes: { scoringMid: mid } }, scoringMid: mid, bandRadiusCents: 2.25,
  ...extra,
});

/** Un ordine con VENTI MINUTI di vita davanti: lontanissimo dal rinnovo a 3 minuti. */
const ORDINE_A_META = { orderId: 'x', book: 'yes', side: 'BUY', price: 0.77, size: 20.2, secondsToExpiry: 1200 };

console.log('\n══ 1 · A METÀ FRA DUE RINNOVI, IL LIBRO SI MUOVE E L ORDINE DIVENTA PRIMO');
{
  // Il nostro ordine a 77¢ è ora il migliore del lato (dietro solo roba a 75¢). Un tick dietro darebbe
  // 76¢, che con mid 78¢ e banda ±2,25¢ cade fuori ⇒ si cancella.
  const d = decideReprice(
    { order: ORDINE_A_META, rules: mk(0.78), config: cfg },
    { resolveDepth: () => ({ yes: { bids: [{ price: 0.77, size: 20.2 }, { price: 0.75, size: 60 }], asks: [{ price: 0.85, size: 99 }] }, no: { bids: [], asks: [] } }) },
  );
  ok('il sistema AGISCE, non aspetta', d.action === 'cancel', `${d.action}/${d.gate}`);
  ok('  col motivo «sarebbe primo sul libro»', d.gate === 'sarebbe-primo-sul-libro');
  ok('  e NON è il rinnovo GTD ad averlo svegliato', d.gate !== 'expiry-refresh');

  // LA PROVA CHE IL CASO È DAVVERO «A METÀ»: mancano 1200 secondi alla scadenza, e il rinnovo scatta
  // a 180. Se il controllo fosse legato al rinnovo, qui non succederebbe niente per 17 minuti.
  ok('  mancavano 20 minuti alla scadenza (rinnovo a 3)',
    ORDINE_A_META.secondsToExpiry === 1200 && cfg.refreshMarginSeconds === 180,
    `${ORDINE_A_META.secondsToExpiry}s vs ${cfg.refreshMarginSeconds}s`);
}

console.log('\n══ 2 · LO STESSO ORDINE, LIBRO SANO ⇒ NON SI TOCCA (il test non è vuoto)');
{
  // Se qui uscisse comunque 'cancel', il test sopra non proverebbe niente: proverebbe solo che la
  // funzione cancella sempre.
  const d = decideReprice(
    { order: ORDINE_A_META, rules: mk(0.78), config: cfg },
    { resolveDepth: () => ({ yes: { bids: [{ price: 0.78, size: 60 }, { price: 0.77, size: 20.2 }], asks: [{ price: 0.85, size: 99 }] }, no: { bids: [], asks: [] } }) },
  );
  ok('con un concorrente davanti si tiene', d.action === 'hold', `${d.action}/${d.gate}`);
  ok('  quindi la decisione dipende dal LIBRO, non dall orologio', true);
}

console.log('\n══ 3 · IL LIBRO SI MUOVE ANCORA: RIPREZZO, SEMPRE FUORI DAL RINNOVO');
{
  const d = decideReprice(
    { order: { ...ORDINE_A_META, price: 0.79 }, rules: mk(0.78), config: cfg },
    { resolveDepth: () => ({ yes: { bids: [{ price: 0.79, size: 20.2 }, { price: 0.78, size: 60 }], asks: [{ price: 0.85, size: 99 }] }, no: { bids: [], asks: [] } }) },
  );
  ok('si riprezza un tick dietro il concorrente', d.action === 'reprice' && d.targetPrice === 0.77, c(d.targetPrice));
  ok('  col gate top-of-book, non expiry', d.gate === 'top-of-book');
}

console.log('\n══ 4 · IL BOOK USATO È QUELLO INIETTATO ADESSO, MAI UNO RIUSATO');
{
  // Due valutazioni consecutive con DUE book diversi devono dare due risposte diverse. Se la funzione
  // conservasse la lettura precedente (o una cache per marketId), la seconda risposta ripeterebbe la
  // prima — ed è esattamente il difetto che la FASE 7.4 chiede di escludere.
  let letture = 0;
  const libro = (bids) => () => { letture += 1; return { yes: { bids, asks: [{ price: 0.85, size: 99 }] }, no: { bids: [], asks: [] } }; };

  const sano = decideReprice({ order: ORDINE_A_META, rules: mk(0.78), config: cfg },
    { resolveDepth: libro([{ price: 0.78, size: 60 }, { price: 0.77, size: 20.2 }]) });
  const rotto = decideReprice({ order: ORDINE_A_META, rules: mk(0.78), config: cfg },
    { resolveDepth: libro([{ price: 0.77, size: 20.2 }, { price: 0.75, size: 60 }]) });
  const sanoDiNuovo = decideReprice({ order: ORDINE_A_META, rules: mk(0.78), config: cfg },
    { resolveDepth: libro([{ price: 0.78, size: 60 }, { price: 0.77, size: 20.2 }]) });

  ok('stessa funzione, tre book: tre risposte coerenti col book del momento',
    sano.action === 'hold' && rotto.action === 'cancel' && sanoDiNuovo.action === 'hold',
    `${sano.action} → ${rotto.action} → ${sanoDiNuovo.action}`);
  ok('  e il book è stato riletto a ogni valutazione', letture === 3, `${letture} letture`);
  ok('  tornare allo stato sano NON lascia l ordine cancellato', sanoDiNuovo.action === 'hold',
    'nessuno stato appiccicato fra una valutazione e l altra');
}

console.log('\n══ 5 · SENZA IL LIBRO NON SI DECIDE A CASO');
{
  // `resolveDepth` non iniettata: la regola non può girare. Il comportamento REALE oggi è «non si
  // tocca l'ordine» — e questo test lo registra com'è, non come vorremmo che fosse.
  const cieco = decideReprice({ order: ORDINE_A_META, rules: mk(0.78), config: cfg }, {});
  ok('senza profondità la regola non inventa una decisione', cieco.action === 'hold', `${cieco.action}`);
  ok('  (comportamento REGISTRATO, non approvato: vedi la nota nel riepilogo di sessione'
    + ' — «stale/assente ⇒ cancella» sarebbe un cambiamento di semantica su capitale reale)', true);

  // Il mid stantio invece ha un gate suo, esplicito, e fallisce CHIUSO nel senso di «non muovere».
  // `midSource: 'live-book'` serve per arrivare al gate dell'ETÀ: senza, scatta prima quello sulla
  // PROVENIENZA (`mid-not-live`). Sono due rifiuti diversi e vanno esercitati separatamente, altrimenti
  // si crede di aver provato la staleness e si è provata la provenienza.
  const nonLive = decideReprice(
    { order: ORDINE_A_META, rules: mk(0.78), config: { ...cfg, requireLiveBook: true } },
    { resolveDepth: () => ({ yes: { bids: [{ price: 0.77, size: 20.2 }], asks: [] }, no: { bids: [], asks: [] } }) },
  );
  ok('mid non dal book live ⇒ skip col suo gate', nonLive.action === 'skip' && nonLive.gate === 'mid-not-live',
    `${nonLive.action}/${nonLive.gate}`);

  const stantio = decideReprice(
    { order: ORDINE_A_META, rules: mk(0.78, { midAgeSec: 999, midSource: 'live-book' }), config: { ...cfg, requireLiveBook: true, maxMidAgeSec: 60 } },
    { resolveDepth: () => ({ yes: { bids: [{ price: 0.77, size: 20.2 }], asks: [] }, no: { bids: [], asks: [] } }) },
  );
  ok('mid vecchio ⇒ skip dichiarato, con il suo gate', stantio.action === 'skip' && stantio.gate === 'mid-stale',
    `${stantio.action}/${stantio.gate}`);
  ok('  e il motivo nomina l età del mid', /vecchio di 999s/.test(stantio.reason), stantio.reason);
}

console.log('\n══ 6 · IL CICLO CHE CHIAMA TUTTO QUESTO GIRA DAVVERO A OGNI GIRO');
{
  // Le tre righe che rendono il controllo continuo invece che a checkpoint. Sono cablaggio: se una
  // sparisse, le prove qui sopra resterebbero verdi e il sistema tornerebbe a checkpoint.
  const ag = fs.readFileSync(path.join(ROOT, 'agents', 'agent40-manual-reprice.js'), 'utf8');
  const ar = fs.readFileSync(path.join(ROOT, 'lib', 'maker', 'auto-reprice.js'), 'utf8');

  ok('il ciclo reattivo gira a intervallo, non a scadenza GTD', /setInterval\(run, tuning\.pollMs\)/.test(ag));
  ok('  e valuta OGNI ordine a riposo, non solo quelli in scadenza',
    /for \(const order of owned\)/.test(ar));
  ok('  iniettando la profondità del book a ogni giro', /resolveDepth: \(marketId\) => resolveMarketDepth\(marketId\)/.test(ag));
  ok('il motore di tracking è agganciato al PUSH del feed, non solo a un orologio',
    /fs\.watch\('\/tmp'/.test(ag) && /clob-live-books\.json/.test(ag));
  ok('  con un battito di sicurezza se il feed si ferma', /setInterval\(runTracking, TRACKING_POLL_MS\)/.test(ag));

  // La cadenza dichiarata, letta dalla configurazione invece che affermata a parole.
  const arc = fs.readFileSync(path.join(ROOT, 'lib', 'maker', 'auto-reprice-config.js'), 'utf8');
  const m = arc.match(/pollMs:\s*([0-9_]+)/);
  const pollMs = m ? Number(m[1].replace(/_/g, '')) : null;
  ok('la cadenza del ciclo reattivo è di 5 secondi', pollMs === 5000, `${pollMs} ms`);
  ok('  cioè MOLTO più stretta della finestra GTD da 23 minuti',
    pollMs != null && pollMs < 1380_000 / 100, `${pollMs}ms contro 1.380.000ms`);
}

console.log('\n══ 7 · LA REGOLA NUOVA È PRONTA PER LO STESSO CICLO');
{
  // Le due ricerche adattive sono pure e non conservano niente: possono essere chiamate a ogni giro
  // senza che il giro precedente ne influenzi il risultato. È il prerequisito per agganciarle al ciclo.
  const banda = { lo: 0.46, hi: 0.54 };
  const sano = [{ price: 0.50, size: 100 }, { price: 0.49, size: 300 }];
  const sottile = [{ price: 0.50, size: 100 }, { price: 0.49, size: 2 }];
  const argS = (levels) => ({ marketId: 'M', side: 'BUY', bookLevels: levels, bandBounds: banda, ownOrders: [], proposedSize: 10, tick: 0.01 });
  const argR = (levels) => ({ marketId: 'M', side: 'BUY', bookLevels: levels, bandBounds: banda, ownOrders: [], tick: 0.01 });

  const seqS = [sano, sottile, sano].map((l) => findAdaptiveDepthLevelSafe(argS(l)).ok);
  ok('Safe: il verdetto segue il book del momento', JSON.stringify(seqS) === JSON.stringify([true, false, true]), seqS.join(','));
  const seqR = [sano, sottile, sano].map((l) => findAdaptiveDepthLevelRisk(argR(l)).ok);
  ok('Risk: idem, e un book sottile non lascia strascichi', JSON.stringify(seqR) === JSON.stringify([true, false, true]), seqR.join(','));
}

console.log(`\ncontrollo continuo: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

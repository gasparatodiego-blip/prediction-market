#!/usr/bin/env node
'use strict';
// IL MOTORE UNICO RICEVE LA SCALA DEL BOOK — E LE REGOLE 2-5 GIRANO DAVVERO.
//
// ═══ COSA E' SUCCESSO, CON I NUMERI ══════════════════════════════════════════════════════════════════
// Il commit 1b54e8b (6 agosto 2026, 16:15) ha messo il veto del motore unico dentro il ciclo di
// riprezzo, passandogli `bookLevels: d.bookLevels`. `d` e' il ritorno di `decideReprice`, che quella
// proprieta' NON restituisce — le sue chiavi sono action, gate, reason, targetPrice, distanceC,
// bandRadiusC, scoringMid, breachConfirmed. Quindi `d.bookLevels` era `undefined`, e `|| null` lo
// rendeva `null` a ogni singola chiamata, su ogni mercato.
//
// La Regola 1 («mai primo sul libro») chiede la scala altrui, non la trovava, e usciva con un `return`
// immediato — «se cade qui non si calcola altro». Effetto misurato sull'audit fra le 20:37:26 e le
// 21:48:14 del 6 agosto: 295 veti su 295 con quella sola causa, le Regole 2, 3, 4 e 5 mai eseguite
// nemmeno una volta, e otto ordini morti di scadenza GTD senza rinnovo per ~$522 di capitale fermo.
//
// Il dato era gia' nel ciclo: `resolveDepth` lo risolve e `prezzoInCoda` lo usa DUE volte nelle stesse
// iterazioni. Mancava solo passarlo.
//
// ═══ COSA VERIFICA QUESTO FILE ═══════════════════════════════════════════════════════════════════════
// 1 · che con un book disponibile le Regole 2-5 vengano ESEGUITE, non piu' saltate: un caso che passa
//     (profondita' sufficiente) e uno che fallisce per pavimento non raggiunto. La differenza fra i due
//     e' la prova che il motore sta LEGGENDO, perche' un motore cieco boccia entrambi allo stesso modo;
// 2 · che le due assenze diverse — scala non passata dal chiamante, feed che non pubblica — abbiano
//     due frasi diverse. La frase unica ha mandato una diagnosi intera a caccia di un guasto del feed
//     che non esisteva;
// 3 · che i due numeri della decisione (pavimentoUsd, depthAheadUsd) finiscano nell'audit;
// 4 · che l'aritmetica della VENDITA resti corretta: `top-of-book` dichiara di lavorare in spazio BID
//     e `controlloMaiPrimo` non ha nemmeno un parametro `side`, quindi una scala di ask grezzi gli
//     farebbe leggere il livello PEGGIORE come miglior prezzo altrui.
//
// NESSUN ORDINE REALE: il ciclo gira su dipendenze iniettate, `replaceOrder` e' una funzione di prova.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AR = require('./auto-reprice');
const { othersLadder } = require('./top-of-book');
const { valutaMercato } = require('./motore-unico');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MKT = '0xfb481845055afdf15febad269fcb534be4c5e79d5789b72659a036660b46e11b';
const NOW = 1_700_000_000_000;

const REGOLE = (mid = 0.6515) => ({
  readable: true, missing: [], marketId: MKT, title: 'Eric Barlow', mid, tick: 0.001, minSize: 50,
  maxSpreadCents: 2.25, tokenId: 'ty', tokenIdNo: 'tn', midSource: 'live-book', midAgeSec: 2,
  feedVitality: { assetsWithEvents: 40, seededAssets: 100, windowMs: 30_000 },
  books: { yes: { tokenId: 'ty', scoringMid: mid }, no: { tokenId: 'tn', scoringMid: +(1 - mid).toFixed(6) } },
});

const CFG = {
  restingGtdSeconds: 1380, refreshMarginSeconds: 180, minIntervalMs: 30_000, maxPerHour: 20,
  maxMidAgeSecLive: 60, maxMidAgeSecBlind: 10, feedAliveMinAssets: 5, requireLiveBook: true,
  confirmSamples: 2, hysteresisTicks: 1, pollMs: 5000, strategy: 'band-edge', disconnectCancelSeconds: 180,
};

/** Un ciclo completo con il motore collegato. `depth` e `liquidita` sono i due input sotto esame.
 *  Lo stato sta in una cartella temporanea: il ciclo legge `lastRepriceAt` da lì, e con lo stato reale
 *  del server il rate-limiter fermerebbe tutto prima che il motore venga interpellato. */
function giro({ depth, liquiditaMedia, campioni = 200, ordine = null }) {
  const righe = [];
  const visti = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motore-book-'));
  const configDeps = {
    configFile: path.join(dir, 'config.json'),
    autoStateFile: path.join(dir, 'state.json'),
    autoAuditFile: path.join(dir, 'audit.jsonl'),
  };
  fs.writeFileSync(configDeps.configFile, JSON.stringify({ global: { enabled: true }, markets: { [MKT.toLowerCase()]: { enabled: true } } }));
  fs.writeFileSync(configDeps.autoStateFile, JSON.stringify({
    markets: { [MKT.toLowerCase()]: { lastRepriceAt: NOW - 600_000, recentAt: [] } }, heartbeatAt: NOW, cycles: 1,
  }));
  const o = ordine || {
    orderId: '0xb99f5566', source: 'manual-ui', side: 'BUY', price: 0.649, size: 60.1,
    sizeRemaining: 60.1, marketId: MKT, tokenId: 'ty', secondsToExpiry: 120, orderType: 'GTD',
  };
  return AR.runAutoRepriceCycle({
    now: () => NOW,
    configDeps,
    config: CFG,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    trackedMarketIds: () => [],
    marketWindow: () => ({ tooClose: false }),
    resolveRules: () => REGOLE(),
    resolveOffset: () => ({ targetOffsetCents: 0.55, source: 'observed', minMoveCents: 0.1 }),
    rememberObserved: () => {},
    resolveDepth: () => depth,
    // IL MOTORE VERO, non un finto: e' esattamente cio' che il difetto impediva di raggiungere.
    valutaMercato: (arg) => { visti.push(arg); return valutaMercato(arg); },
    liquiditaMedia: () => ({ media: liquiditaMedia, campioni }),
    saldoUsd: 5000,
    esposizioneMercatoUsd: 0,
    listOrders: async () => ({ ok: true, simulated: false, orders: [o] }),
    replaceOrder: async () => ({ ok: true, oldCancelled: true, replaced: true, place: { sent: true, orderId: '0xNEW' } }),
    audit: (rec) => righe.push(rec),
  }).then((res) => ({ res, righe, visti }));
}

// Un book con abbondanza: il secondo livello in banda porta gia' $650 di profondita' altrui.
const BOOK_RICCO = {
  readable: true,
  yes: {
    bids: [
      { price: 0.652, size: 400 },   // primo in banda — la Regola 1 non ci mette mai nessuno
      { price: 0.651, size: 1000 },  // secondo — $651 davanti, supera qualunque pavimento ragionevole
      { price: 0.650, size: 800 },
      { price: 0.649, size: 60.1 },  // il NOSTRO
    ],
    asks: [{ price: 0.660, size: 300 }, { price: 0.661, size: 900 }, { price: 0.662, size: 700 }],
  },
  no: { bids: [{ price: 0.33, size: 500 }, { price: 0.329, size: 900 }], asks: [] },
};

// Stesso book, ma sottile: oltre il primo livello resta pochissimo.
const BOOK_SOTTILE = {
  readable: true,
  yes: {
    bids: [
      { price: 0.652, size: 400 },
      { price: 0.651, size: 12 },    // secondo livello: ~$7.8 di profondita' altrui, e basta
      { price: 0.649, size: 60.1 },  // il NOSTRO
    ],
    asks: [],
  },
  no: { bids: [], asks: [] },
};

(async () => {

  console.log('\n══ 1 · CON IL BOOK, LE REGOLE 2-5 GIRANO — CASO CHE PASSA');
  {
    // Media 1000 share x mid 0.6515 = $651.5 ⇒ pavimento al 10% = $65.15. Il secondo livello ne porta 651.
    const { righe, visti } = await giro({ depth: BOOK_RICCO, liquiditaMedia: 1000 });
    ok('il motore ha ricevuto una SCALA, non null', Array.isArray(visti[0] && visti[0].bookLevels),
      visti[0] ? `${(visti[0].bookLevels || []).length} livelli` : 'mai chiamato');
    ok('  e gli estremi della banda premiante', !!(visti[0] && visti[0].bandBounds),
      visti[0] && visti[0].bandBounds ? `${visti[0].bandBounds.lo}–${visti[0].bandBounds.hi}` : 'null');

    const v = valutaMercato(visti[0]);
    ok('la Regola 1 e SUPERATA (non piu un return immediato)', v.controlli.maiPrimo.ok === true,
      v.controlli.maiPrimo.motivo);
    // LA PROVA CHE CONTA: con la Regola 1 che esce subito, `controlli` conteneva SOLO maiPrimo.
    ok('  quindi la Regola 2 e stata ESEGUITA (pavimento calcolato)', v.controlli.pavimento != null,
      v.controlli.pavimento ? `$${v.controlli.pavimento.usd}` : 'assente');
    ok('  e la Regola 3 pure (livello cercato)', v.controlli.livello != null,
      v.controlli.livello ? `livello ${v.controlli.livello.level}` : 'assente');
    ok('  e la Regola 5 pure (tetto valutato)', v.controlli.tetto != null);
    ok('il verdetto e PASSA', v.ok === true, v.motivo);
    ok('  con la profondita altrui misurata', Number.isFinite(v.controlli.livello.depthAheadUsd),
      `$${v.controlli.livello.depthAheadUsd}`);
    ok('  sopra il pavimento', v.controlli.livello.depthAheadUsd >= v.controlli.pavimento.usd,
      `${v.controlli.livello.depthAheadUsd} ≥ ${v.controlli.pavimento.usd}`);

    const skip = righe.filter((r) => r.gate === 'motore-non-conforme');
    ok('nessun veto del motore in questo giro', skip.length === 0, `${skip.length} veti`);
  }

  console.log('\n══ 2 · CASO CHE FALLISCE PER PAVIMENTO — ED E UN MOTIVO DIVERSO DA «NON LEGGIBILE»');
  {
    // Media 4000 share x 0.6515 = $2606 ⇒ pavimento $260.6. Il secondo livello ne porta ~$7.8.
    const { righe, visti } = await giro({ depth: BOOK_SOTTILE, liquiditaMedia: 4000 });
    const v = valutaMercato(visti[0]);
    ok('la Regola 1 passa lo stesso', v.controlli.maiPrimo.ok === true);
    ok('  e il pavimento e stato CALCOLATO', v.controlli.pavimento.usd > 0, `$${v.controlli.pavimento.usd}`);
    ok('il verdetto e BOCCIA', v.ok === false);
    ok('  e la bocciatura nomina la PROFONDITA, non il feed',
      v.bocciature.some((b) => b.regola === 'profondita-insufficiente'),
      v.bocciature.map((b) => b.regola).join(' · '));
    ok('  con i due numeri nel motivo', /pavimento/.test(v.controlli.livello.motivo), v.controlli.livello.motivo.slice(0, 90));

    const skip = righe.filter((r) => r.outcome === 'skip-motore-non-conforme');
    ok('il ciclo registra il veto', skip.length === 1, `${skip.length} righe`);
    ok('  e NON dice piu «il feed non pubblica i livelli»',
      skip[0] && !/non pubblica i livelli/.test(skip[0].reason || ''), skip[0] && (skip[0].reason || '').slice(0, 80));
  }

  console.log('\n══ 3 · PUNTO 4 · I DUE NUMERI FINISCONO NELL AUDIT');
  {
    const { righe } = await giro({ depth: BOOK_SOTTILE, liquiditaMedia: 4000 });
    const skip = righe.find((r) => r.outcome === 'skip-motore-non-conforme');
    ok('l audit porta pavimentoUsd', skip && Number.isFinite(skip.observed.pavimentoUsd),
      skip ? `$${skip.observed.pavimentoUsd}` : 'riga assente');
    ok('  e depthAheadUsd', skip && Number.isFinite(skip.observed.depthAheadUsd),
      skip ? `$${skip.observed.depthAheadUsd}` : 'riga assente');
    ok('  e la fonte del pavimento (media o ripiego)', skip && skip.observed.pavimentoFonte === 'media',
      skip && String(skip.observed.pavimentoFonte));
    ok('  i due numeri raccontano la bocciatura', skip && skip.observed.depthAheadUsd < skip.observed.pavimentoUsd,
      skip ? `$${skip.observed.depthAheadUsd} < $${skip.observed.pavimentoUsd}` : '');
  }

  console.log('\n══ 4 · PUNTO 2 · DUE ASSENZE DIVERSE, DUE FRASI DIVERSE');
  {
    const nonPassata = othersLadder({ levels: null, ownOrders: [], tick: 0.001 });
    ok('scala non passata ⇒ dice CABLAGGIO', /cablaggio/.test(nonPassata.reason), nonPassata.reason);
    ok('  e non accusa il feed', !/feed/.test(nonPassata.reason.replace('non un problema di feed', '')));

    const indefinita = othersLadder({ ownOrders: [], tick: 0.001 });
    ok('undefined e trattato come null', /cablaggio/.test(indefinita.reason));

    const feedRotto = othersLadder({ levels: 'non-una-scala', ownOrders: [], tick: 0.001 });
    ok('non-array ⇒ dice FEED', /feed non ha pubblicato/.test(feedRotto.reason), feedRotto.reason);

    ok('le due frasi sono diverse', nonPassata.reason !== feedRotto.reason);
    // Entrambe restano `readable:false`: cambia il messaggio, non il comportamento. Un dato mancante
    // continua a NON essere un via libera, quale che sia la ragione per cui manca.
    ok('  ma entrambe restano non-leggibili (nessun via libera nuovo)',
      nonPassata.readable === false && feedRotto.readable === false);
  }

  console.log('\n══ 5 · LA VENDITA: SPAZIO BID, ALTRIMENTI IL MIGLIORE DIVENTA IL PEGGIORE');
  {
    // Gli ask altrui sono 0.660 / 0.661 / 0.662. Il MIGLIORE per un venditore e' il piu' BASSO: 0.660.
    // Specchiato: 0.340 / 0.339 / 0.338, e il migliore torna a essere il piu' alto — 0.340 — che e' cio'
    // che `othersLadder` sa leggere. Senza specchio prenderebbe 0.662, cioe' il peggiore.
    const grezzi = BOOK_RICCO.yes.asks;
    const specchiati = grezzi.map((l) => ({ price: +(1 - l.price).toFixed(10), size: l.size }));

    const senza = othersLadder({ levels: grezzi, ownOrders: [], tick: 0.001 });
    ok('senza specchio la testa e l ask PEGGIORE', senza.levels[0].price === 0.662, String(senza.levels[0].price));

    const con = othersLadder({ levels: specchiati, ownOrders: [], tick: 0.001 });
    ok('con lo specchio la testa e il migliore (0.660 ⇒ 0.340)', con.levels[0].price === 0.34,
      String(con.levels[0].price));

    // E il ciclo, su un ordine di VENDITA, deve consegnare al motore la scala gia' specchiata.
    const uscita = {
      orderId: '0xSELL', source: 'manual-ui', side: 'SELL', price: 0.34, size: 60.1,
      sizeRemaining: 60.1, marketId: MKT, tokenId: 'ty', secondsToExpiry: 120, orderType: 'GTD',
    };
    const { visti } = await giro({ depth: BOOK_RICCO, liquiditaMedia: 1000, ordine: uscita });
    if (visti.length === 0) {
      ok('il ciclo ha valutato la gamba di vendita', false, 'motore mai chiamato (nessun rinnovo dovuto)');
    } else {
      const prezzi = (visti[0].bookLevels || []).map((l) => l.price);
      ok('il motore riceve prezzi in spazio BID (< 0.5, cioe specchiati)',
        prezzi.length > 0 && prezzi.every((p) => p < 0.5), prezzi.slice(0, 3).join(' · '));
      ok('  e side dichiarato BUY, che dopo lo specchio e la verita', visti[0].side === 'BUY', String(visti[0].side));
      // DISCRIMINANTE, non decorativa: in questa fixture i livelli specchiati stanno tutti sotto 0.5 e
      // il prezzo grezzo sopra. Se `proposedPrice` fosse stato specchiato insieme al resto cadrebbe
      // anch'esso sotto 0.5, e la Regola 5 calcolerebbe il controvalore su un prezzo inventato.
      ok('  mentre proposedPrice resta GREZZO (il controvalore della Regola 5 e vero)',
        visti[0].proposedPrice > 0.5 && prezzi.every((p) => p < 0.5),
        `proposedPrice ${visti[0].proposedPrice} vs livelli ${prezzi[0]}`);
    }
  }

  console.log('\n══ 6 · NON-REGRESSIONE · prezzoInCoda continua a leggere il book');
  {
    const { prezzoInCoda } = require('./prezzo-in-coda');
    const q = prezzoInCoda({
      book: 'yes', side: 'BUY', rules: REGOLE(), depth: BOOK_RICCO,
      ownOrders: [{ orderId: '0xb99f5566', price: 0.649, size: 60.1 }], offsetCents: 0.55,
    });
    ok('risponde con un prezzo', q.ok === true, q.ok ? String(q.price) : q.reason);
    ok('  un tick dietro il miglior altrui (0.652 ⇒ 0.651)', q.price === 0.651, String(q.price));

    const cieco = prezzoInCoda({ book: 'yes', side: 'BUY', rules: REGOLE(), depth: null, offsetCents: 0.55 });
    ok('senza book si tira indietro invece di inventare', cieco.ok === false, cieco.reason);
  }

  console.log('\n══ 7 · NON-REGRESSIONE · il pavimento di ripiego quando lo storico non basta');
  {
    // Meno di 5 campioni ⇒ pavimento di ripiego, non un pavimento dedotto da due misure.
    const { visti } = await giro({ depth: BOOK_RICCO, liquiditaMedia: 1000, campioni: 2 });
    const v = valutaMercato(visti[0]);
    ok('fonte = ripiego', v.controlli.pavimento.fonte === 'fallback', v.controlli.pavimento.fonte);
    ok('  e il motore gira lo stesso', v.controlli.livello != null);
  }

  console.log('\n══ 8 · NON-REGRESSIONE · l uscita di chiusura non viene MAI abbassata');
  {
    // `close-sell-floor` e' la regola che ha fatto scadere la gamba NO di Schwartzel alle 21:01:03 del
    // 6 agosto — comportamento corretto, non un difetto: per una SELL di chiusura il prezzo E' il
    // profitto, e seguire una banda scesa lo eroderebbe. Non aveva un test suo; ora ce l'ha, perche'
    // il cablaggio nuovo passa dallo stesso ramo e non deve poterlo scavalcare.
    const uscita = {
      orderId: '0xSELLFLOOR', source: 'manual-ui', side: 'SELL', price: 0.680, size: 60.1,
      sizeRemaining: 60.1, marketId: MKT, tokenId: 'ty', secondsToExpiry: 120, orderType: 'GTD',
    };
    const { righe, visti } = await giro({ depth: BOOK_RICCO, liquiditaMedia: 1000, ordine: uscita });
    const skip = righe.find((r) => r.gate === 'close-sell-floor');
    ok('il ciclo ferma il ribasso', !!skip, skip ? String(skip.outcome) : righe.map((r) => r.gate).join(','));
    ok('  dicendo che il target è SOTTO il prezzo attuale',
      !!skip && /è sotto il prezzo attuale/.test(skip.reason || ''), skip && (skip.reason || '').slice(0, 70));
    // E il veto del motore non entra nemmeno in scena: `close-sell-floor` produce action 'skip', e il
    // blocco del motore gira solo su azioni diverse da hold/skip. Il fix non ha spostato quel confine.
    ok('  e il motore non viene interpellato su una decisione gia presa', visti.length === 0,
      `${visti.length} chiamate`);
  }

  console.log(`\nmotore riceve il book: ${pass} passati, ${fail} falliti`);
  process.exit(fail === 0 ? 0 : 1);
})();

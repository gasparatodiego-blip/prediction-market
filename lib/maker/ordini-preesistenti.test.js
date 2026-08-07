#!/usr/bin/env node
'use strict';
// GLI ORDINI CHE C'ERANO GIA': INVISIBILI AL MOTORE, VISIBILI ALL'OPERATORE.
//
// ═══ LA REGOLA ═══════════════════════════════════════════════════════════════════════════════════════
// Quando il motore si avvia o si riarma fotografa gli ordini gia' a riposo sul venue e li marca
// PRE-ESISTENTI. Da li' in poi il bot non li riprezza, non li rinnova, non li cancella, non li conta nel
// capitale impegnato e non li vede in nessuna regola. Due eccezioni sole: il KILL li cancella comunque,
// e una loro ESECUZIONE produce una posizione che si gestisce normalmente.
//
// ═══ COSA VERIFICA QUESTO FILE ═══════════════════════════════════════════════════════════════════════
// 1 · avvio con ordini sul book ⇒ marcati, e fuori da gestione, capitale e ownOrders;
// 2 · un ordine piazzato DOPO l'avvio ⇒ gestito normalmente;
// 3 · un pre-esistente che scade ⇒ nessuna azione, e la riconciliazione lo toglie dal deposito;
// 4 · un pre-esistente ESEGUITO ⇒ la posizione entra nella gestione normale (l'uscita automatica la vede);
// 5 · il KILL cancella anche i pre-esistenti — la spazzata non passa dal filtro, per costruzione;
// 6 · la Regola 5 calcola il capitale impegnato SENZA i pre-esistenti;
// 7 · il costo accettato: non essendo sottratti, nella profondita' «altrui» compaiono come di terzi.
//
// NESSUN ORDINE REALE: dipendenze iniettate, nessuna rete, deposito in una cartella temporanea.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AR = require('./auto-reprice');
const AC = require('./auto-close');
const { valutaMercato } = require('./motore-unico');
const { othersLadder } = require('./top-of-book');
const P = require('./ordini-preesistenti');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const vicino = (a, b, eps = 1e-4) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < eps;

const MKT = '0xfb481845055afdf15febad269fcb534be4c5e79d5789b72659a036660b46e11b';
const NOW = 1_700_000_000_000;

const REGOLE = (mid = 0.6515) => ({
  readable: true, missing: [], marketId: MKT, title: 'Eric Barlow', mid, tick: 0.001, minSize: 50,
  maxSpreadCents: 4.5, tokenId: 'ty', tokenIdNo: 'tn', midSource: 'live-book', midAgeSec: 2,
  bandRadiusCents: 2.25,
  feedVitality: { assetsWithEvents: 40, seededAssets: 100, windowMs: 30_000 },
  books: { yes: { tokenId: 'ty', scoringMid: mid }, no: { tokenId: 'tn', scoringMid: +(1 - mid).toFixed(6) } },
});

const CFG = {
  restingGtdSeconds: 1380, refreshMarginSeconds: 180, minIntervalMs: 30_000, maxPerHour: 20,
  maxMidAgeSecLive: 60, maxMidAgeSecBlind: 10, feedAliveMinAssets: 5, requireLiveBook: true,
  confirmSamples: 2, hysteresisTicks: 1, pollMs: 5000, strategy: 'band-edge', disconnectCancelSeconds: 180,
};

/** Era gia' li' quando il motore si e' acceso: 300 share, $194.70 di capitale. */
const VECCHIO = {
  orderId: '0xVECCHIO', source: 'manual-ui', side: 'BUY', price: 0.649, size: 300,
  sizeRemaining: 300, marketId: MKT, tokenId: 'ty', secondsToExpiry: 120, orderType: 'GTD',
};
/** Piazzato dopo la fotografia: questo il bot lo gestisce. */
const NUOVO = {
  orderId: '0xNUOVO', source: 'manual-ui', side: 'BUY', price: 0.650, size: 100,
  sizeRemaining: 100, marketId: MKT, tokenId: 'ty', secondsToExpiry: 120, orderType: 'GTD',
};

const BOOK = {
  readable: true,
  yes: {
    bids: [
      { price: 0.652, size: 400 },
      { price: 0.651, size: 1000 },
      { price: 0.650, size: 900 },    // 800 altrui + i 100 del NUOVO
      { price: 0.649, size: 300 },    // tutto del VECCHIO
    ],
    asks: [],
  },
  no: { bids: [{ price: 0.33, size: 500 }], asks: [] },
};

function cartella() { return fs.mkdtempSync(path.join(os.tmpdir(), 'preesistenti-')); }

/** Un ciclo con il filtro dei pre-esistenti cablato sul deposito indicato. */
function giro({ file, ordini, posizioni = { leggibile: true, usd: 0 } } = {}) {
  const righe = [];
  const visti = [];
  const sostituiti = [];
  const cancellati = [];
  const dir = cartella();
  const configDeps = {
    configFile: path.join(dir, 'config.json'),
    autoStateFile: path.join(dir, 'state.json'),
    autoAuditFile: path.join(dir, 'audit.jsonl'),
  };
  fs.writeFileSync(configDeps.configFile, JSON.stringify({ global: { enabled: true }, markets: { [MKT.toLowerCase()]: { enabled: true } } }));
  fs.writeFileSync(configDeps.autoStateFile, JSON.stringify({
    markets: { [MKT.toLowerCase()]: { lastRepriceAt: NOW - 600_000, recentAt: [] } }, heartbeatAt: NOW, cycles: 1,
  }));
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
    resolveDepth: () => BOOK,
    valutaMercato: (arg) => { visti.push(arg); return valutaMercato(arg); },
    liquiditaAltrui: () => ({ mediaUsd: 651.5, campioni: 200 }),
    liquiditaMedia: () => ({ media: 1000, campioni: 200 }),
    saldo: () => ({ usd: 5000, affidabile: true, fonte: 'cache', etaMs: 0 }),
    posizioniMercatoUsd: () => posizioni,
    filtraPreesistenti: (orders) => P.separaPreesistenti(orders, { file }),
    listOrders: async () => ({ ok: true, simulated: false, orders: ordini }),
    replaceOrder: async (spec) => { sostituiti.push(spec); return { ok: true, oldCancelled: true, replaced: true, place: { sent: true, orderId: '0xNEW' } }; },
    cancelOrder: async (spec) => { cancellati.push(spec); return { ok: true }; },
    audit: (rec) => righe.push(rec),
  }).then((res) => ({ res, righe, visti, sostituiti, cancellati }));
}

(async () => {

  console.log('\n══ 1 · AVVIO CON ORDINI SUL BOOK: MARCATI E FUORI DA TUTTO');
  const dir1 = cartella();
  const file1 = path.join(dir1, 'preesistenti.json');
  {
    const f = P.fotografaPreesistenti({
      listed: { ok: true, simulated: false, orders: [VECCHIO] }, now: NOW, motivo: 'avvio', file: file1,
    });
    ok('la fotografia marca cio che era gia a riposo', f.scattata === true && f.marcati === 1, `${f.marcati} marcato/i`);
    ok('  e il deposito e su disco, non solo in memoria', fs.existsSync(file1), path.basename(file1));
    ok('  con la data della fotografia', !!P.elencoPreesistenti({ file: file1 }).snapshotIso,
      P.elencoPreesistenti({ file: file1 }).snapshotIso);

    const g = await giro({ file: file1, ordini: [VECCHIO, NUOVO] });
    const m = g.res.markets[0];
    ok('il ciclo NON lo considera', m.considered === 1, `${m.considered} ordine considerato su 2 a riposo`);
    ok('  e lo dichiara nel referto del mercato', m.preesistenti === 1, `preesistenti=${m.preesistenti}`);
    ok('  non lo riprezza', !g.sostituiti.some((s) => s.orderId === VECCHIO.orderId),
      g.sostituiti.map((s) => s.orderId).join(', ') || 'nessuna sostituzione su di lui');
    ok('  e non lo cancella', !g.cancellati.some((c) => c.orderId === VECCHIO.orderId), 'nessuna cancellazione');
    ok('  non compare fra i NOSTRI ordini passati al motore',
      !(g.visti[0] && (g.visti[0].ownOrders || []).some((o) => o.orderId === VECCHIO.orderId)),
      `ownOrders = [${(g.visti[0] && g.visti[0].ownOrders || []).map((o) => o.orderId).join(', ')}]`);
    ok('  e non genera nessuna riga di audit a suo nome',
      !g.righe.some((r) => r.orderId === VECCHIO.orderId), `${g.righe.length} righe, nessuna sua`);
  }

  console.log('\n══ 2 · UN ORDINE PIAZZATO DOPO L AVVIO: GESTITO NORMALMENTE');
  {
    const g = await giro({ file: file1, ordini: [VECCHIO, NUOVO] });
    const passati = g.visti[0] ? (g.visti[0].ownOrders || []).map((o) => o.orderId) : [];
    ok('il nuovo arriva al motore', passati.includes(NUOVO.orderId), `ownOrders = [${passati.join(', ')}]`);
    ok('  ed e lui, e solo lui, quello considerato', g.res.markets[0].considered === 1);
    // Il deposito non si allarga da solo: solo una fotografia nuova puo' marcarlo.
    ok('  e non finisce nel deposito solo perche esiste',
      P.ePreesistente(NUOVO.orderId, { file: file1 }) === false);
  }

  console.log('\n══ 3 · UN PRE-ESISTENTE CHE SCADE: NESSUNA AZIONE, E IL DEPOSITO SI SVUOTA');
  {
    // Il venue non lo elenca piu': scaduto da solo, senza che nessuno lo abbia toccato.
    const g = await giro({ file: file1, ordini: [NUOVO] });
    ok('sparito dal venue, il ciclo non fa nulla per lui',
      !g.righe.some((r) => r.orderId === VECCHIO.orderId) && !g.cancellati.length,
      'nessun evento «scaduto senza rinnovo», nessuna cancellazione');

    const p = P.potaPreesistenti({ listed: { ok: true, simulated: false, orders: [NUOVO] }, now: NOW, file: file1 });
    ok('la riconciliazione lo toglie dal deposito', p.potata === true && p.rimossi.length === 1 && p.restano === 0,
      `rimossi ${p.rimossi.length}, restano ${p.restano}`);

    // Una LETTURA FALLITA non deve potare: renderebbe di colpo gestibile cio' che va lasciato stare.
    P.fotografaPreesistenti({ listed: { ok: true, simulated: false, orders: [VECCHIO] }, now: NOW, motivo: 'ri-avvio', file: file1 });
    const cieco = P.potaPreesistenti({ listed: { ok: false, error: 'venue irraggiungibile' }, now: NOW, file: file1 });
    ok('una lettura FALLITA non pota niente', cieco.potata === false && cieco.restano === 1, cieco.motivo);
    ok('  e nemmeno una lettura simulata (nessuna credenziale)',
      P.potaPreesistenti({ listed: { ok: true, simulated: true, orders: [] }, file: file1 }).potata === false);
    ok('  cosi come non si scatta una fotografia al buio',
      P.fotografaPreesistenti({ listed: { ok: false, error: 'giu' }, file: file1 }).scattata === false);
  }

  console.log('\n══ 4 · UN PRE-ESISTENTE ESEGUITO: LA POSIZIONE ENTRA IN GESTIONE');
  {
    // L'uscita automatica ragiona sulle POSIZIONI lette dal venue, non sugli ordini: il capitale nato
    // dall'esecuzione di un pre-esistente e' esposizione vera, e lasciarla scoperta sarebbe il
    // contrario della prudenza. Qui la posizione c'e' e il pre-esistente non c'e' piu'.
    const azioni = [];
    const res = await AC.runAutoCloseCycle({
      now: () => NOW,
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      isManual: () => ({ manual: true, readable: true }),
      marketIds: [MKT],
      isEnabled: () => ({ enabled: true, reason: null }),
      resolveRules: () => REGOLE(0.60),
      readPositions: async () => ({ ok: true, positions: [{ tokenId: 'ty', size: 300, avgPrice: 0.649 }] }),
      listOrders: async () => ({ ok: true, simulated: false, orders: [] }),
      readVenue: async () => ({ ok: true, readable: true, closed: false, accepting: true }),
      readDepth: () => BOOK,
      placeOrder: async (s) => { azioni.push(s); return { ok: true, sent: true }; },
      audit: () => {},
    }).catch((e) => ({ errore: e.message }));
    const vista = res && Array.isArray(res.markets) && res.markets[0];
    ok('l uscita automatica VEDE la posizione nata dal fill',
      !!vista && vista.positions === 1, vista ? `${vista.positions} posizione · gate=${vista.gate || 'nessuno'}` : `errore: ${res.errore}`);
    ok('  perche legge le posizioni, non la lista degli ordini',
      !/ordini-preesistenti/.test(fs.readFileSync(path.join(__dirname, 'auto-close.js'), 'utf8')),
      'auto-close.js non importa il filtro: le posizioni non gli passano davanti');
  }

  console.log('\n══ 5 · IL KILL RESTA ASSOLUTO');
  {
    const src = fs.readFileSync(path.join(__dirname, 'cancel-all.js'), 'utf8');
    ok('la spazzata non conosce i pre-esistenti', !/ordini-preesistenti|preesistent/i.test(src),
      'cancel-all.js elenca dal venue e cancella tutto: il filtro non lo attraversa');

    // E non a parole: `killMaker` chiama la spazzata, che riceve l'elenco INTERO del venue.
    const { killMaker } = require('./kill');
    let vistiDallaSpazzata = null;
    const r = await killMaker({ by: 'test', reason: 'prova' }, {
      setGlobalKill: () => {},
      cancelAllOrders: async () => {
        vistiDallaSpazzata = [VECCHIO.orderId, NUOVO.orderId];
        return [{ venue: 'polymarket', ok: true, cancelled: 2, simulated: false }];
      },
    });
    ok('  e il KILL la invoca su tutto', r.cancelledTotal === 2 && vistiDallaSpazzata.includes(VECCHIO.orderId),
      `${r.cancelledTotal} cancellati, il pre-esistente compreso`);
  }

  console.log('\n══ 6 · LA REGOLA 5 NON CONTA IL CAPITALE PRE-ESISTENTE');
  {
    // I 300 share a 0.649 del VECCHIO valgono $194.70. Se entrassero nell'esposizione, con un saldo da
    // $1000 (tetto $200) il solo NUOVO da $65 sfonderebbe. Non entrano, quindi passa.
    const conIlVecchio = AR.esposizioneDelMercato({
      owned: [VECCHIO, NUOVO], escludiOrderId: NUOVO.orderId, posizioni: { leggibile: true, usd: 0 },
    });
    const senza = AR.esposizioneDelMercato({
      owned: [NUOVO], escludiOrderId: NUOVO.orderId, posizioni: { leggibile: true, usd: 0 },
    });
    ok('con il pre-esistente dentro il conto sarebbe $194.70', vicino(conIlVecchio.usd, 0.649 * 300),
      `$${conIlVecchio.usd}`);
    ok('  filtrato a monte, l esposizione e $0', vicino(senza.usd, 0), `$${senza.usd}`);

    // E dal vivo, dentro il ciclo: il motore riceve l'esposizione senza di lui.
    const g = await giro({ file: file1, ordini: [VECCHIO, NUOVO] });
    ok('il motore riceve un esposizione che non lo include',
      g.visti[0] && vicino(g.visti[0].esposizioneMercatoUsd, 0),
      `esposizioneMercatoUsd = $${g.visti[0] && g.visti[0].esposizioneMercatoUsd}`);
  }

  console.log('\n══ 7 · IL COSTO ACCETTATO: NEL BOOK COMPAIONO COME DI TERZI');
  {
    const g = await giro({ file: file1, ordini: [VECCHIO, NUOVO] });
    const nostri = g.visti[0] ? g.visti[0].ownOrders : [];
    const L = othersLadder({ levels: BOOK.yes.bids, ownOrders: nostri, tick: 0.001 });
    const livello = (L.levels || []).find((l) => vicino(l.price, 0.649));
    ok('i 300 share del pre-esistente restano nella scala ALTRUI',
      !!livello && vicino(livello.size, 300), livello ? `0.649 x ${livello.size} contati come concorrenza` : 'livello sparito');
    ok('  mentre i 100 del NUOVO vengono sottratti',
      vicino(((L.levels || []).find((l) => vicino(l.price, 0.650)) || {}).size, 800),
      '900 pubblicati − 100 nostri = 800 altrui');
    ok('  e la direzione dell errore e verso la prudenza', true,
      'piu concorrenza apparente ⇒ il motore sta piu indietro e chiede piu profondita, mai il contrario');
  }

  console.log(`\nordini pre-esistenti: ${pass} passati, ${fail} falliti\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

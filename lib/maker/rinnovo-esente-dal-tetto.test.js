#!/usr/bin/env node
'use strict';
// IL TETTO ORARIO FERMA UN RIPREZZO, NON TIENE IN VITA GLI ORDINI.
//
// ═══ COSA È SUCCESSO, CON I MINUTI (5 agosto 2026, Eric Barlow) ══════════════════════════════════════
// 20:40:44  tetto orario colpito: 21 riprezzi nell'ultima ora, tetto 20. Il guard ha funzionato.
// 20:40:44 → 21:03:08  540 righe `skip-hourly-cap` identiche, una ogni 5 secondi, su due gambe.
// ~20:59:34  il rinnovo proattivo di scadenza era DOVUTO (180s di margine su una finestra di 1380s).
//            Non è mai stato valutato: la skip dell'inseguimento tornava prima di arrivarci.
// ~21:02:34  la GTD è scaduta. 21:03:09 gli ordini non sono più al venue. Nessuna cancellazione,
//            nessun fill, nessun avviso.
//
// ═══ LA DISTINZIONE ═════════════════════════════════════════════════════════════════════════════════
// Un riprezzo bloccato è prudenza: l'ordine resta a riposo e continua a maturare. Un RINNOVO bloccato è
// una scadenza garantita. Il tetto esiste per fermare una fuga di riprezzi, non per svuotare il libro.
//
// ═══ E PERCHÉ NON È UNA SCAPPATOIA ══════════════════════════════════════════════════════════════════
// L'esenzione si aggancia a `secondsToExpiry`, che arriva dal campo `expiration` pubblicato dal VENUE
// sull'ordine — non da un flag che il chiamante possa dichiarare. Un riprezzo discrezionale non può
// travestirsi da rinnovo: per ottenere l'esenzione dovrebbe far scadere davvero l'ordine. Il prezzo,
// poi, non è quello dell'inseguimento: in banda si ripiazza allo STESSO prezzo, fuori banda al prezzo
// che rientra in banda.
//
// NESSUN ORDINE REALE: `decideReprice` è pura; il ciclo gira su dipendenze iniettate e file temporanei.

const fs = require('fs');
const os = require('os');
const path = require('path');
const AR = require('./auto-reprice');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// Eric Barlow come era davvero: tick 0.001, mid di scoring 0.6515, banda ±2.25¢, distanza-bersaglio
// 0.55¢ (quella osservata al piazzamento e memorizzata in maker-offsets.json).
const MKT = '0xfb481845055afdf15febad269fcb534be4c5e79d5789b72659a036660b46e11b';
const BARLOW = (mid = 0.6515) => ({
  readable: true, missing: [], marketId: MKT, title: 'Eric Barlow', mid, tick: 0.001, minSize: 50,
  maxSpreadCents: 4.5, tokenId: 'ty', tokenIdNo: 'tn', midSource: 'live-book', midAgeSec: 2,
  feedVitality: { assetsWithEvents: 40, seededAssets: 100, windowMs: 30_000 },
  books: { yes: { tokenId: 'ty', scoringMid: mid }, no: { tokenId: 'tn', scoringMid: +(1 - mid).toFixed(6) } },
});
const CFG = {
  restingGtdSeconds: 1380, refreshMarginSeconds: 180, minIntervalMs: 30_000, maxPerHour: 20,
  maxMidAgeSecLive: 60, maxMidAgeSecBlind: 10, feedAliveMinAssets: 5, requireLiveBook: true,
  confirmSamples: 2, hysteresisTicks: 1, pollMs: 5000, strategy: 'band-edge', disconnectCancelSeconds: 180,
};
const CHASE = { resolveOffset: () => ({ targetOffsetCents: 0.55, source: 'observed', minMoveCents: 0.1 }) };
const NOW = 1_700_000_000_000;
// La gamba YES di Barlow, esattamente come l'audit la fotografa: 0.649 a 0.25¢ da un mid di 0.6515.
const GAMBA = (extra = {}) => ({ orderId: '0xb99f5566', price: 0.649, size: 60.1, book: 'yes', side: 'BUY', ...extra });

console.log('\n══ 1 · IL TETTO CONTINUA A FERMARE UN RIPREZZO (nulla è stato indebolito)');
{
  // Inseguimento dovuto, tetto raggiunto, scadenza LONTANA: l'ordine ha 1345s di vita davanti, quindi
  // fermarsi non gli costa niente. È il comportamento di prima, e deve restare.
  const d = AR.decideReprice({
    order: GAMBA({ secondsToExpiry: 1345 }), rules: BARLOW(), config: CFG,
    repricesThisHour: 21, now: NOW,
  }, CHASE);
  ok('non si muove niente', d.action === 'skip', d.action);
  ok('  e il motivo è il tetto', d.gate === 'hourly-cap', String(d.gate));
  ok('  con i numeri su cui è stato deciso', /21 riprezzi/.test(d.reason) && /tetto 20/.test(d.reason));
  ok('  e NESSUNA esenzione dichiarata', d.capExemptRenewal !== true);
}

console.log('\n══ 2 · LO STESSO CASO CON LA SCADENZA DENTRO IL MARGINE → SI RINNOVA');
{
  // 120s di vita contro un margine di 180s: il venue sta per ritirare l'ordine. Fermarsi qui non evita
  // una mossa, garantisce una scadenza. È l'esatto istante in cui, il 5 agosto, non è avvenuto nulla.
  const d = AR.decideReprice({
    order: GAMBA({ secondsToExpiry: 120 }), rules: BARLOW(), config: CFG,
    repricesThisHour: 21, now: NOW,
  }, CHASE);
  ok('il rinnovo PROCEDE', d.action === 'reprice', `${d.action} · ${d.gate}`);
  ok('  ed è un rinnovo, non un inseguimento', d.gate === 'expiry-refresh', String(d.gate));
  ok('  ALLO STESSO PREZZO: non si insegue il mid con la scusa del rinnovo',
    d.targetPrice === 0.649, String(d.targetPrice));
  ok('  l esenzione è dichiarata sulla decisione', d.capExemptRenewal === true);
  ok('  con il conteggio e il tetto', d.repricesThisHour === 21 && d.maxPerHour === 20);
  ok('  e dice quale rail aveva fermato l inseguimento', d.railInseguimento === 'hourly-cap', String(d.railInseguimento));
  ok('  il motivo è leggibile, non un codice', /ESENTE DAL TETTO ORARIO/.test(d.reason));
  ok('  e spiega il perché', /garantirebbe una scadenza/.test(d.reason));
}

console.log('\n══ 3 · L ESENZIONE VALE SOLO PER IL TETTO: GLI ALTRI GATE RESTANO');
{
  // Il limite di 30s per gamba NON è esentato. C'è ancora margine (120s su 180s), quindi attendere
  // il minimo non può costare l'ordine — è la ragione per cui quel rail resta.
  const d = AR.decideReprice({
    order: GAMBA({ secondsToExpiry: 120 }), rules: BARLOW(), config: CFG,
    repricesThisHour: 21, lastRepriceAt: NOW - 5_000, now: NOW,
  }, CHASE);
  ok('mosso 5s fa ⇒ si attende', d.action === 'skip' && d.gate === 'rate-limited', `${d.action}/${d.gate}`);
  ok('  e nessuna esenzione viene dichiarata', d.capExemptRenewal !== true);
}
{
  // Il guard condiviso non è esentato: un residuo sotto la soglia minima resta non rinnovabile, e
  // l'ordine viene lasciato scadere invece di essere cancellato per un rimpiazzo che il venue rifiuta.
  const d = AR.decideReprice({
    order: GAMBA({ size: 30, secondsToExpiry: 120 }), rules: BARLOW(), config: CFG,
    repricesThisHour: 21, now: NOW,
  }, CHASE);
  ok('residuo sotto soglia ⇒ non si rinnova', d.action === 'skip' && d.gate === 'refresh-invalid', `${d.action}/${d.gate}`);
  ok('  e resta l avviso che già esisteva', d.belowMinSize === true);
}
{
  // Il mid vecchio non è esentato: senza un mid affidabile non si tocca nulla, nemmeno per rinnovare.
  const r = BARLOW(); r.midAgeSec = 300;
  const d = AR.decideReprice({
    order: GAMBA({ secondsToExpiry: 120 }), rules: r, config: CFG, repricesThisHour: 21, now: NOW,
  }, CHASE);
  ok('mid vecchio ⇒ nessuna azione', d.action === 'skip' && d.gate === 'mid-stale', `${d.action}/${d.gate}`);
}

console.log('\n══ 4 · NON È AGGIRABILE: SOLO IL VENUE PUÒ APRIRE L ESENZIONE');
{
  // Un ordine GTC (nessuna scadenza dichiarata dal venue) non può ottenere l'esenzione: non c'è niente
  // da rinnovare, quindi il tetto vale pieno.
  const d = AR.decideReprice({
    order: GAMBA({ secondsToExpiry: null }), rules: BARLOW(), config: CFG, repricesThisHour: 21, now: NOW,
  }, CHASE);
  ok('GTC ⇒ il tetto ferma tutto', d.action === 'skip' && d.gate === 'hourly-cap', `${d.action}/${d.gate}`);
}
{
  // E un flag inventato dal chiamante non serve a niente: la condizione è `secondsToExpiry`, che
  // `selectOwnedOrders` copia dal campo `expiration` del venue e da nessun altro posto.
  const d = AR.decideReprice({
    order: GAMBA({ secondsToExpiry: 1345, expiryRefresh: true, capExempt: true, trigger: 'expiry-refresh' }),
    rules: BARLOW(), config: CFG, repricesThisHour: 21, now: NOW,
  }, CHASE);
  ok('un flag dichiarato dal chiamante NON apre l esenzione',
    d.action === 'skip' && d.gate === 'hourly-cap' && d.capExemptRenewal !== true, `${d.action}/${d.gate}`);

  const src = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8');
  ok('  la condizione nel codice è UNA e viene dal venue',
    /const expiring = ttlLeft != null && ttlLeft <= margin;/.test(src));
  ok('  e `selectOwnedOrders` copia quel numero dal venue, non lo inventa',
    /secondsToExpiry: Number\.isFinite\(o\.secondsToExpiry\) \? o\.secondsToExpiry : null/.test(src));
}
{
  // IL LIMITE STRUTTURALE. Ogni rinnovo conia un ordine con una finestra piena, quindi `expiring` non
  // può tornare vero prima di (finestra − margine). Il ritmo massimo dei rinnovi esentati è quindi
  // aritmetica, non fiducia: 3/ora per gamba contro un tetto di 20.
  const rinnoviOra = 3600 / (CFG.restingGtdSeconds - CFG.refreshMarginSeconds);
  ok('i rinnovi esentati sono limitati dalla finestra GTD, non dalla buona volontà',
    rinnoviOra <= CFG.maxPerHour, `${rinnoviOra}/ora contro un tetto di ${CFG.maxPerHour}`);
}

console.log('\n══ 5 · FUORI BANDA CON LA SCADENZA ADDOSSO: STESSA REGOLA');
{
  // Fuori banda di 3¢ su una banda di ±2.25¢, con 60s di vita: «non fare niente» non salva l'ordine,
  // lo perde. Si muove al prezzo che rientra in banda — non a quello dell'inseguimento.
  const d = AR.decideReprice({
    order: GAMBA({ price: 0.60, secondsToExpiry: 60 }), rules: BARLOW(), config: CFG,
    repricesThisHour: 21, consecutiveBreaches: 0, now: NOW,
  }, CHASE);
  ok('si agisce', d.action === 'reprice', `${d.action}/${d.gate}`);
  ok('  con il trigger che nomina entrambe le cause', d.gate === 'band-exit-and-expiry', String(d.gate));
  ok('  l esenzione è dichiarata', d.capExemptRenewal === true);
  ok('  e il prezzo è quello che rientra in banda', d.targetPrice > 0.60, String(d.targetPrice));
  ok('  col motivo che lo dice a parole', /ESENTE DAL TETTO ORARIO/.test(d.reason));
}
{
  // Fuori banda ma con la finestra intera davanti: il tetto ferma, come prima.
  const d = AR.decideReprice({
    order: GAMBA({ price: 0.60, secondsToExpiry: 1300 }), rules: BARLOW(), config: CFG,
    repricesThisHour: 21, consecutiveBreaches: 5, now: NOW,
  }, CHASE);
  ok('fuori banda senza urgenza ⇒ il tetto ferma', d.action === 'skip' && d.gate === 'hourly-cap', `${d.action}/${d.gate}`);
}

console.log('\n══ 6 · IL CICLO LO SCRIVE NEL REGISTRO, E LO SCRIVE SEPARATO');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tetto-'));
  const deps = {
    configFile: path.join(dir, 'config.json'),
    autoStateFile: path.join(dir, 'state.json'),
    autoAuditFile: path.join(dir, 'audit.jsonl'),
  };
  fs.writeFileSync(deps.configFile, JSON.stringify({ global: { enabled: true }, markets: { [MKT.toLowerCase()]: { enabled: true } } }));
  // 21 riprezzi nell'ultima ora, come Barlow alle 20:40:44.
  fs.writeFileSync(deps.autoStateFile, JSON.stringify({
    markets: { [MKT.toLowerCase()]: { lastRepriceAt: NOW - 600_000, recentAt: Array.from({ length: 21 }, (_, i) => NOW - 600_000 - i * 1000) } },
    heartbeatAt: NOW, cycles: 1,
  }));

  const righe = [];
  const inviati = [];
  const res = (async () => AR.runAutoRepriceCycle({
    now: () => NOW,
    configDeps: deps,
    config: CFG,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    trackedMarketIds: () => [],
    marketWindow: () => ({ tooClose: false }),
    resolveRules: () => BARLOW(),
    resolveOffset: CHASE.resolveOffset,
    rememberObserved: () => {},
    // Il concorrente a 0.65: un tick dietro dà 0.649, che è dove l'ordine già sta.
    resolveDepth: () => ({ yes: { bids: [{ price: 0.65, size: 500 }, { price: 0.649, size: 60.1 }], asks: [] }, no: { bids: [], asks: [] } }),
    listOrders: async () => ({ ok: true, simulated: false, orders: [{
      orderId: '0xb99f5566', source: 'manual-ui', side: 'BUY', price: 0.649, size: 60.1,
      sizeRemaining: 60.1, marketId: MKT, tokenId: 'ty', secondsToExpiry: 120, orderType: 'GTD',
    }] }),
    replaceOrder: async (spec) => { inviati.push(spec); return { ok: true, oldCancelled: true, replaced: true, place: { sent: true, orderId: '0xNEW' } }; },
    audit: (rec) => righe.push(rec),
  }))();

  res.then((r) => {
    const esente = righe.filter((x) => x.outcome === 'rinnovo-esente-dal-tetto');
    ok('esiste UNA riga di audit dedicata', esente.length === 1, `${esente.length} righe`);
    ok('  greppabile per nome', esente[0] && esente[0].outcome === 'rinnovo-esente-dal-tetto');
    ok('  col gate che lo nomina', esente[0] && esente[0].gate === 'hourly-cap-exempt', esente[0] && String(esente[0].gate));
    ok('  col conteggio orario e il tetto', esente[0] && esente[0].observed.repricesThisHour === 21 && esente[0].observed.maxPerHour === 20);
    ok('  con quanto restava da vivere e il margine',
      esente[0] && esente[0].observed.secondsToExpiry === 120 && esente[0].observed.refreshMarginSeconds === 180);
    ok('  e con il rail che aveva fermato l inseguimento',
      esente[0] && esente[0].observed.inseguimentoFermatoDa === 'hourly-cap', esente[0] && String(esente[0].observed.inseguimentoFermatoDa));

    ok('il rinnovo è stato eseguito', inviati.length === 1, `${inviati.length} invii`);
    ok('  allo STESSO prezzo', inviati[0] && inviati[0].price === 0.649, inviati[0] && String(inviati[0].price));
    ok('  e SENZA agganciarsi alla coda: un rinnovo non sposta il prezzo',
      inviati[0] && inviati[0].inCoda === false, inviati[0] && String(inviati[0].inCoda));
    ok('l azione lo porta fuori per il log', (r.actions || []).some((a) => a.capExemptRenewal === true));

    console.log(`\nrinnovo esente dal tetto: ${pass} passati, ${fail} falliti`);
    process.exit(fail ? 1 : 0);
  });
}

#!/usr/bin/env node
'use strict';
// I SETTE PUNTI DELLA REVISIONE DEL 2 AGOSTO 2026, uno per blocco.
//
// Un fallimento qui dice SUBITO quale dei sette comportamenti si e' rotto, senza doverlo dedurre.
// Punto 6 ha un file suo (exit-plan.test.js) per l'aritmetica dell'uscita; qui c'e' il suo aggancio.
//
// NESSUN ORDINE REALE, nessuna scrittura di produzione: tutto iniettato o su file temporanei.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ PUNTO 1 · tetto di esposizione e conteggio anticipato RIMOSSO');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  const { resolveLimits } = require('../safety/risk-limits');
  const r = resolveLimits({});
  // I NUMERI SI SONO MOSSI TRE VOLTE DA QUANDO QUESTO TEST E' NATO: $500 → $600 col deposito del
  // 3 agosto 2026, il tetto per ordine $40 → $1000 quando si e' deciso che non doveva piu' tagliare
  // l'allocazione, e **$600 → $150 il 16 agosto 2026**, decisione dell'operatore, per limitare la
  // rotazione di §4.13. Restano fissi qui, e non letti dalla configurazione, perche' il senso del test
  // e' proprio accorgersi se qualcuno li muove senza dirlo.
  //
  // ⚠ QUESTA RIGA E' RIMASTA ROSSA DUE GIORNI, ED ERA GIUSTO: fotografava $600 mentre il file diceva
  // $150. Non si e' ammorbidita subito perche' la fotografia e' il punto — ma una fotografia che
  // resta sbagliata smette di essere un allarme e diventa rumore. L'operatore ha confermato il $150 e
  // ha dato l'invariante vera (18 agosto 2026): `capitale impegnato <= N × MARKET_CAP_FIXED_USD`, che
  // vive in `tetti-per-giro-e-scope.test.js` e si legge N dall'ambiente. Qui resta la FOTOGRAFIA.
  ok('il tetto di esposizione totale e 150', r.ok && r.limits.maxOpenNotionalUsd === 150, String(r.ok && r.limits.maxOpenNotionalUsd));
  // IL RATE LIMIT SI E' MOSSO UNA TERZA VOLTA: 20 → 40 il 12 agosto 2026, su istruzione esplicita
  // dell'operatore. Il motivo sta in data/safety-risk-limits.json: la finestra da 60s e' CONDIVISA fra
  // la corsia che piazza a raffica e quella che rinnova, e a 20 la raffica affamava il rinnovo — 18
  // `skip-rate-limited` e 6 ordini morti per scadenza, misurati alle 20:51 e 20:54 di quel giorno.
  // IL VALORE RESTA SCRITTO QUI, e non letto dalla configurazione, perche' e' esattamente il senso di
  // questa riga: accorgersi se qualcuno lo muove senza dirlo. Chi lo muove aggiorna anche questa riga,
  // e nel farlo deve scrivere perche'.
  // ⚠ AGGIORNATO IL 15 AGOSTO 2026, decisione dell'operatore per il giro di prova con ordini veri:
  // perdita giornaliera $25 → **$100** (il kill switch chiesto) e tetto per ordine $1000 → **$80**,
  // cioe' il primo si allarga e il secondo si STRINGE di piu' di un ordine di grandezza. Il rate limit
  // non e' stato toccato. I valori restano scritti qui, e non letti dalla configurazione, perche' e'
  // esattamente il senso di questa riga: accorgersi se qualcuno li muove senza dirlo.
  ok('  rate limit e perdita giornaliera come dichiarati: sono l unica protezione strutturale rimasta',
    r.limits.maxOrdersPerWindow === 40 && r.limits.maxDailyLossUsd === 100,
    `rate ${r.limits.maxOrdersPerWindow}/60s · giorno ${r.limits.maxDailyLossUsd}`);
  ok('  il tetto per ordine e stato STRETTO a $80, e ora e un limite vero', r.limits.maxOrderNotionalUsd === 80,
    `ordine ${r.limits.maxOrderNotionalUsd}`);
  ok('    ma resta sopra la gamba piu cara che il piano puo proporre, o rifiuterebbe coppie valide',
    r.limits.maxOrderNotionalUsd >= require('../rewards/concentration').LIVE_MIN_ORDER_CAP_USD);

  const { computeExposure } = require('../safety/fills');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-'));
  const deps = { fillsFile: path.join(d, 'fills.jsonl') };

  // IL COMPORTAMENTO NUOVO: due ordini inviati in rapida successione, nessuno ancora riconciliato.
  // Il loro valore combinato supera il tetto, ma l'esposizione misurata resta ZERO — quindi il tetto
  // non li vede e il secondo NON viene bloccato dal conteggio anticipato.
  const inviati = [
    { idempotencyKey: 'a1', notionalUsd: 300, ts: Date.now() },
    { idempotencyKey: 'a2', notionalUsd: 300, ts: Date.now() },
  ];
  const e = computeExposure({ userId: 'op', sentOrders: inviati }, deps);
  ok('due ordini da $300 inviati e non riconciliati…', e.ok === true);
  ok('  …NON pesano sull esposizione', e.openNotionalUsd === 0, `$${e.openNotionalUsd}`);
  ok('  e la lista «unknowns» resta vuota', Array.isArray(e.unknowns) && e.unknowns.length === 0);

  // La prova che il secondo ordine passerebbe: il gate confronta esposizione + ordine contro il tetto.
  const { evaluateLimits } = require('../safety/risk-limits');
  const limiti = { maxOrderNotionalUsd: 40, maxOpenNotionalUsd: 500, maxOrdersPerWindow: 20, windowMs: 60000, maxDailyLossUsd: 25 };
  const usoDopoDue = { openNotionalUsd: e.openNotionalUsd, ordersInWindow: 2, realisedDailyPnlUsd: 0 };
  const terzo = evaluateLimits({ order: { notionalUsd: 30 }, usage: usoDopoDue, limits: limiti });
  ok('un terzo ordine NON viene bloccato dal tetto di esposizione', terzo.allow === true,
    '$600 gia inviati ma non riconciliati: il tetto non li vede — RISCHIO ACCETTATO, vedi commento in fills.js');

  // ...ma DOPO la riconciliazione il tetto morde eccome.
  const usoRiconciliato = { openNotionalUsd: 490, ordersInWindow: 3, realisedDailyPnlUsd: 0 };
  const bloccato = evaluateLimits({ order: { notionalUsd: 30 }, usage: usoRiconciliato, limits: limiti });
  ok('  ma DOPO la riconciliazione il tetto blocca', bloccato.allow === false && bloccato.gate === 'max-open-notional',
    bloccato.reason ? bloccato.reason.slice(0, 60) : '');

  // Cio che RESTA a limitare la finestra: il tetto per ordine e il rate limit.
  const troppoGrande = evaluateLimits({ order: { notionalUsd: 41 }, usage: usoDopoDue, limits: limiti });
  ok('nella finestra resta il tetto PER ORDINE', troppoGrande.allow === false && troppoGrande.gate === 'max-order-notional');
  const troppiOrdini = evaluateLimits({ order: { notionalUsd: 30 }, usage: { ...usoDopoDue, ordersInWindow: 20 }, limits: limiti });
  ok('  e il limite di 20 ordini al minuto', troppiOrdini.allow === false && troppiOrdini.gate === 'rate-limit');
  ok('  ⇒ il massimo teorico della finestra e 20 x $40 = $800, NON il tetto di esposizione', true,
    'conseguenza nota e dichiarata della rimozione');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ PUNTO 2 · un ordine manuale non si esegue MAI come taker');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
{
  // La logica vive dentro placeManualOrder, che tocca audit e adapter reali: qui si verifica il
  // CABLAGGIO (che la distanza viaggi e che il rifiuto esista) leggendo il sorgente, e il
  // comportamento vero e' coperto dall'E2E sul pannello.
  const mo = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  ok('esiste il gate «would-cross»', /refuse\('would-cross'/.test(mo));
  ok('  il prezzo viene ricalcolato dal mid VIVO con la distanza dichiarata',
    /spec\.distanceCents/.test(mo) && /priceAdjusted/.test(mo));
  ok('  il controvalore segue il prezzo ricalcolato', /notionalUsd = \(Number\.isFinite\(price\)/.test(mo));
  ok('  e il rifiuto spiega che non si converte di nascosto',
    /di nascosto/.test(mo) && /allarga la distanza dal mid/.test(mo));
  const route = fs.readFileSync(path.join(__dirname, '../../app/api/maker/manual/order/route.ts'), 'utf8');
  ok('la route accetta distanceCents e belowMid', /distanceCents: z\.number\(\)/.test(route) && /belowMid: z\.boolean\(\)/.test(route));
  const panel = fs.readFileSync(path.join(__dirname, '../../app/components/OrderPanel.tsx'), 'utf8');
  ok('il pannello li invia', /distanceCents: sheetDistC/.test(panel));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ PUNTO 3 · auto-reprice cancella a fine evento, non lascia scadere');
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
(async () => {
  const AR = require('./auto-reprice');
  const MKT = '0x' + 'a7'.repeat(32);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-'));
  const cfgDeps = {
    configFile: path.join(dir, 'config.json'),
    autoStateFile: path.join(dir, 'state.json'),
    autoAuditFile: path.join(dir, 'audit.jsonl'),
  };
  fs.writeFileSync(cfgDeps.configFile, JSON.stringify({ global: { enabled: true }, markets: { [MKT.toLowerCase()]: { enabled: true } } }));

  const cancellati = [], sostituiti = [];
  const ordine = { orderId: 'o1', tokenId: 'ty', side: 'BUY', price: 0.50, size: 100,
    sizeMatched: 0, sizeRemaining: 100, status: 'LIVE', source: 'manual-ui', secondsToExpiry: 1380 };
  const gira = (tooClose) => AR.runAutoRepriceCycle({
    config: { restingGtdSeconds: 1380, refreshMarginSeconds: 180, minIntervalMs: 0, maxPerHour: 20,
      maxMidAgeSec: 30, requireLiveBook: true, confirmSamples: 1, hysteresisTicks: 1, pollMs: 5000,
      strategy: 'x', disconnectCancelSeconds: 120 },
    configDeps: cfgDeps,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    trackedMarketIds: () => [],
    isManual: () => ({ manual: true, readable: true }),
    marketWindow: () => (tooClose
      ? { tooClose: true, gate: 'market-closed', minutesToClose: -4, reason: 'mercato chiuso da 4 min' }
      : { tooClose: false, minutesToClose: 60, minMinutes: 3 }),
    resolveRules: () => ({
      readable: true, missing: [], marketId: MKT, mid: 0.50, tick: 0.01, minSize: 50,
      maxSpreadCents: 4.5, bandRadiusCents: 2.25, tokenId: 'ty', tokenIdNo: 'tn',
      midSource: 'live-book', midAgeSec: 1,
      books: { yes: { tokenId: 'ty', scoringMid: 0.50 }, no: { tokenId: 'tn', scoringMid: 0.50 } },
    }),
    listOrders: async () => ({ ok: true, simulated: false, orders: [ordine] }),
    replaceOrder: async (s) => { sostituiti.push(s); return { ok: true, place: { sent: false } }; },
    cancelOrder: async (s) => { cancellati.push(s.orderId); return { ok: true }; },
    audit: () => {},
    breaches: new Map(),
    link: { downSince: null, consecutiveFailures: 0 },
  });

  const fine = await gira(true);
  const m = (fine.markets || []).find((x) => String(x.marketId).toLowerCase() === MKT.toLowerCase());
  ok('a mercato finito il gate scatta', !!m && m.gate === 'market-closed', m ? String(m.gate) : 'mercato assente');
  ok('  e l ordine viene CANCELLATO', cancellati.includes('o1'), cancellati.join() || 'nessuno');
  ok('  non lasciato scadere per GTD', !/scadono da soli per GTD/.test((m && m.reason) || ''), (m && m.reason || '').slice(0, 80));
  ok('  il motivo lo dice', /CANCELLAT/.test((m && m.reason) || ''));
  const act = (fine.actions || []).find((a) => a.action === 'end-of-life-cancel');
  ok('  con un azione che si chiama per nome', !!act && act.ok === true);
  ok('  e nessun riprezzo tentato', sostituiti.length === 0);

  cancellati.length = 0;
  const vivo = await gira(false);
  const m2 = (vivo.markets || []).find((x) => String(x.marketId).toLowerCase() === MKT.toLowerCase());
  ok('a mercato aperto NON si cancella nulla', cancellati.length === 0, `gate ${m2 && m2.gate}`);

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n══ PUNTO 4 · il mid arriva in PUSH, con il ciclo come rete di sicurezza');
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const ag = fs.readFileSync(path.join(__dirname, '../../agents/agent40-manual-reprice.js'), 'utf8');
    ok('il motore e agganciato al feed con fs.watch', /fs\.watch\(/.test(ag));
    ok('  sulla DIRECTORY, non sul file', /fs\.watch\('\/tmp'/.test(ag),
      'agent34 scrive in modo atomico: un watch sul percorso del file smette di ricevere eventi dopo il primo rename');
    ok('  filtrando lo snapshot del book', /clob-live-books\.json/.test(ag));
    ok('  con un debounce per le scritture multiple', /pushTimer/.test(ag));
    ok('e il ciclo periodico resta come rete di sicurezza', /setInterval\(runTracking, TRACKING_POLL_MS\)/.test(ag));
    const T = require('./mm-tracking');
    ok('  il battito e di 3 secondi', T.TRACKING_POLL_MS === 3000, `${T.TRACKING_POLL_MS}ms`);
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n══ PUNTO 6 · aggancio: l uscita usa il piano unificato');
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { decideClose } = require('./auto-close');
    const rules = { readable: true, tick: 0.01, minSize: 50, maxSpreadCents: 4.5,
      books: { yes: { scoringMid: 0.50 }, no: { scoringMid: 0.50 } } };

    const normale = decideClose({ position: { tokenId: 'ty', size: 50, avgPrice: 0.50 }, restingOrders: [], rules, book: 'yes' });
    ok('dopo un fill si apre una VENDITA dello stesso token', normale.action === 'close', normale.gate || normale.action);
    ok('  a +1% sul carico (arrotondato al tick)', normale.price === 0.51, String(normale.price));
    ok('  e il piano dichiara chi ha deciso il prezzo', normale.clampedBy === 'obiettivo', String(normale.clampedBy));
    ok('  e i bordi della banda viaggiano con la decisione', normale.bandHiPrice != null);

    // REVISIONE 3 AGOSTO: il pavimento fisso al 4% e stato SOSTITUITO dal trigger a banda. Con il
    // mercato crollato non si piazza piu un uscita in perdita a carico-4%: non si piazza affatto, e la
    // posizione viene chiusa a mercato da decideExit. Il dettaglio del nuovo trigger sta in
    // exit-plan.test.js e exit-trigger-cycle.test.js.
    const crollo = decideClose({ position: { tokenId: 'ty', size: 50, avgPrice: 0.50 }, restingOrders: [],
      rules: { ...rules, books: { yes: { scoringMid: 0.30 }, no: { scoringMid: 0.70 } } }, book: 'yes' });
    ok('col mercato crollato NON si piazza un uscita in perdita', crollo.action === 'skip', crollo.action);
    ok('  e il motivo dice che la banda e sotto il pavimento di uscita (= il carico, senza concessione)',
      /sotto il pavimento di uscita/.test(crollo.reason), crollo.reason.slice(0, 80));
    ok('  nessun campo del vecchio pavimento sopravvive', crollo.atRiskFloor === undefined);
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  console.log('\n══ PUNTO 7 · interruttore generale acceso di default, ma spegnibile');
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = require('./auto-close-config');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-'));
    const deps = { closeConfigFile: path.join(d, 'c.json'), closeAuditFile: path.join(d, 'a.jsonl') };
    ok('su uno stato VUOTO il generale risulta ACCESO', A.readAutoCloseConfig(deps).globalEnabled === true,
      'era spento: un interruttore di sicurezza spento di default non protegge nessuno');

    // un file scritto prima che questo default esistesse, senza il campo
    fs.writeFileSync(deps.closeConfigFile, JSON.stringify({ markets: {} }));
    ok('  e anche su un file senza il campo', A.readAutoCloseConfig(deps).globalEnabled === true);

    // RESTA SPEGNIBILE: solo un false esplicito lo spegne
    const off = A.setAutoClose({ scope: 'global', enabled: false, by: 'test' }, deps);
    ok('resta SPEGNIBILE con un false esplicito', off.ok === true && A.readAutoCloseConfig(deps).globalEnabled === false,
      'poter isolare un meccanismo senza usare il KILL vale piu della garanzia che nessuno lo spenga');
    ok('  e riaccenderlo funziona', A.setAutoClose({ scope: 'global', enabled: true }, deps).ok === true
      && A.readAutoCloseConfig(deps).globalEnabled === true);

    // L'AND col per-mercato resta invariato
    const MKT2 = '0x' + 'b3'.repeat(32);
    ok('generale acceso ma mercato non scelto ⇒ NON agisce', A.isAutoCloseEnabled(MKT2, deps).enabled === false);
    A.setAutoClose({ marketId: MKT2, enabled: true }, deps);
    ok('  entrambi accesi ⇒ agisce', A.isAutoCloseEnabled(MKT2, deps).enabled === true);
    A.setAutoClose({ scope: 'global', enabled: false }, deps);
    ok('  generale spento ⇒ il mercato torna inerte', A.isAutoCloseEnabled(MKT2, deps).enabled === false);
  }

  console.log(`\nsette punti: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

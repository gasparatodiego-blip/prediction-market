#!/usr/bin/env node
'use strict';
// LA GAMBA ORFANA DENTRO IL CICLO VERO — non la funzione da sola, `runAutoRepriceCycle` che la usa.
//
// Le proprietà:
//   1. una gamba sola fa partire il timer, e il ciclo NON cancella niente durante la finestra;
//   2. scaduta la finestra il ciclo cancella la superstite, con gate proprio e referto proprio;
//   3. se la coppia torna intera il timer si annulla e non si cancella nulla;
//   4. la cancellazione per «mai primo sul libro» finisce nel referto visibile, con motivo DISTINTO;
//   5. durante la finestra il ciclo NON bypassa nessuna regola per «richiudere in fretta»: non piazza,
//      e le regole di piazzamento restano quelle di sempre;
//   6. due mercati non si influenzano.
//
// NESSUN ORDINE REALE: `cancelOrder` e `replaceOrder` sono funzioni di questo file e contano le chiamate.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAutoRepriceCycle } = require('./auto-reprice');
const cfgMod = require('./auto-reprice-config');
const { ORPHAN_LEG_TOLERANCE_MS } = require('./gamba-orfana');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MKT = '0x' + 'ab'.repeat(32);
const T0 = 9_000_000_000;

/**
 * Un banco in cui il libro è sano (decideReprice dice `hold`), così l'unica cosa che può agire è la
 * regola della gamba orfana. Se il banco cancellasse per altri motivi, il test non proverebbe niente.
 */
function banco({ ordini, orfanaDa = null, now = T0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orfana-ciclo-'));
  const configDeps = {
    configFile: path.join(dir, 'auto-reprice.json'),
    autoAuditFile: path.join(dir, 'audit.jsonl'),
  };
  cfgMod.setAutoReprice({ scope: 'global', enabled: true, by: 'test', reason: 'banco' }, configDeps);
  cfgMod.setAutoReprice({ scope: 'market', marketId: MKT, enabled: true, by: 'test', reason: 'banco' }, configDeps);

  const cancellati = [];
  const rimpiazzi = [];
  const timerScritti = [];
  let timer = orfanaDa;

  const deps = {
    now: () => now,
    configDeps,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    marketWindow: () => ({ tooClose: false, minutesToClose: 600, minMinutes: 3 }),
    resolveRules: () => ({
      readable: true, missing: [], marketId: MKT, title: 'Mercato di prova', tick: 0.01, minSize: 20,
      maxSpreadCents: 4.5, bandRadiusCents: 2.25, tokenId: 'ty', tokenIdNo: 'tn',
      midSource: 'live-book', midAgeSec: 1, mid: 0.50,
      books: { yes: { tokenId: 'ty', scoringMid: 0.50 }, no: { tokenId: 'tn', scoringMid: 0.50 } },
    }),
    listOrders: async () => ({ ok: true, simulated: false, orders: ordini }),
    // Libro SANO su entrambi i lati: c'è un concorrente davanti, quindi `hold`.
    resolveDepth: () => ({
      yes: { bids: [{ price: 0.51, size: 500 }, { price: 0.49, size: 500 }], asks: [{ price: 0.60, size: 99 }] },
      no: { bids: [{ price: 0.51, size: 500 }, { price: 0.49, size: 500 }], asks: [{ price: 0.60, size: 99 }] },
    }),
    cancelOrder: async ({ orderId }) => { cancellati.push(orderId); return { ok: true }; },
    replaceOrder: async (spec) => { rimpiazzi.push(spec); return { ok: true, orderId: 'nuovo' }; },
    audit: () => {},
    leggiOrfanaDa: () => timer,
    aggiornaTimerOrfana: (arg) => { timerScritti.push(arg); if (arg.azione === 'avvia') timer = arg.orfanaDa; if (arg.azione === 'annulla' || arg.azione === 'cancella') timer = null; },
  };
  return { deps, cancellati, rimpiazzi, timerScritti, pulisci: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const ordine = (id, book, token) => ({
  orderId: id, marketId: MKT, tokenId: token, side: 'BUY', price: 0.49, size: 100,
  sizeRemaining: 100, status: 'LIVE', source: 'manual-ui', secondsToExpiry: 1200,
});
const COPPIA = [ordine('o-yes', 'yes', 'ty'), ordine('o-no', 'no', 'tn')];
const SOLA = [ordine('o-no', 'no', 'tn')];

(async () => {
  console.log('\n══ 1 · UNA GAMBA SOLA FA PARTIRE IL TIMER, E NON SI CANCELLA NIENTE');
  {
    const b = banco({ ordini: SOLA, orfanaDa: null });
    const res = await runAutoRepriceCycle(b.deps);
    const t = b.timerScritti[0];
    ok('il timer viene avviato', t && t.azione === 'avvia', t && t.azione);
    ok('  con la superstite dichiarata', t && t.bookSuperstite === 'no');
    ok('NESSUNA cancellazione durante la finestra', b.cancellati.length === 0);
    ok('  e il mercato è marcato orfano nel referto',
      res.markets[0] && res.markets[0].gambaOrfana && res.markets[0].gambaOrfana.stato === 'orfana',
      JSON.stringify(res.markets[0] && res.markets[0].gambaOrfana));
    ok('  con il countdown per la dashboard',
      (res.orfaneAperte || []).length === 1 && res.orfaneAperte[0].restaSec === 600,
      `${res.orfaneAperte[0] && res.orfaneAperte[0].restaSec}s`);
    b.pulisci();
  }

  console.log('\n══ 2 · SCADUTA LA FINESTRA, IL CICLO CANCELLA LA SUPERSTITE');
  {
    const b = banco({ ordini: SOLA, orfanaDa: T0 - ORPHAN_LEG_TOLERANCE_MS, now: T0 });
    const res = await runAutoRepriceCycle(b.deps);
    ok('la superstite viene cancellata', b.cancellati.length === 1 && b.cancellati[0] === 'o-no', b.cancellati.join(','));
    const a = (res.actions || []).find((x) => x.gate === 'gamba-orfana-scaduta');
    ok('  con un gate proprio', !!a && a.action === 'cancel', a && `${a.action}/${a.gate}`);
    ok('  e il motivo spiega la scelta economica', a && /meglio zero capitale impegnato/.test(a.reason));
    const c = (res.cancellazioni || [])[0];
    ok('il referto visibile la riporta', !!c && c.motivo === 'gamba-orfana-scaduta', c && c.motivo);
    ok('  col mercato, il lato e il capitale liberato', c && c.book === 'no' && c.notionalUsd === 49, `$${c && c.notionalUsd}`);
    ok('  e il timer viene spento', b.timerScritti.some((x) => x.azione === 'cancella'));
    ok('nessuna orfana aperta resta segnalata', (res.orfaneAperte || []).length === 0);
    b.pulisci();
  }

  console.log('\n══ 3 · LA COPPIA TORNA INTERA ⇒ TIMER ANNULLATO, NESSUNA CANCELLAZIONE');
  {
    // Timer già acceso e quasi scaduto, ma nel frattempo l'altra gamba è tornata.
    const b = banco({ ordini: COPPIA, orfanaDa: T0 - ORPHAN_LEG_TOLERANCE_MS + 1000, now: T0 });
    const res = await runAutoRepriceCycle(b.deps);
    ok('nessuna cancellazione', b.cancellati.length === 0);
    ok('  e il timer viene annullato', b.timerScritti.some((x) => x.azione === 'annulla'),
      JSON.stringify(b.timerScritti));
    ok('  il mercato risulta «coppia»', res.markets[0].gambaOrfana.stato === 'coppia');
    b.pulisci();
  }

  console.log('\n══ 5 · NESSUN BYPASS: LA FINESTRA NON PIAZZA E NON ALLENTA NIENTE');
  {
    const b = banco({ ordini: SOLA, orfanaDa: null });
    await runAutoRepriceCycle(b.deps);
    ok('durante la finestra il ciclo NON piazza nulla da sé', b.rimpiazzi.length === 0,
      'la regola non ha una scorciatoia per «richiudere in fretta la coppia»');
    ok('  e non cancella nulla', b.cancellati.length === 0);

    // La prova strutturale: il blocco della gamba orfana non nomina nessuna funzione di piazzamento
    // né allenta una soglia. Se un giorno lo facesse, sarebbe il percorso che salta i controlli per un
    // motivo che suona ragionevole — ed è esattamente ciò che questo assert esiste per impedire.
    const src = fs.readFileSync(require.resolve('./auto-reprice'), 'utf8');
    // ANCORA UNIVOCA. «LA GAMBA RIMASTA SOLA» compare anche nel commento dell'import in cima al file:
    // ancorarsi lì farebbe partire lo slice dall'inizio del modulo e il blocco «esaminato» sarebbe
    // l'intero ciclo — che ovviamente piazza. Si ancora alla riga del blocco, che è unica.
    const i = src.indexOf('DIECI MINUTI PER RITROVARE');
    const blocco = src.slice(i, src.indexOf('markets.push(m);', i));
    ok('il blocco non chiama nessun piazzamento',
      !/placeOrder|replaceOrder|placeManualOrder/.test(blocco));
    ok('  e non tocca nessuna soglia di sicurezza',
      !/SAFE_|RISK_|bandRadius\s*=|minSize\s*=/.test(blocco));
    ok('  chiama solo cancelOrder', /deps\.cancelOrder/.test(blocco));
    b.pulisci();
  }

  console.log('\n══ 4 · «MAI PRIMO SUL LIBRO» FINISCE NEL REFERTO, CON MOTIVO DISTINTO');
  {
    // Libro in cui il nostro ordine è il migliore del lato e un tick dietro esce dalla banda ⇒ cancel.
    const b = banco({ ordini: [ordine('o-yes', 'yes', 'ty')], orfanaDa: null });
    b.deps.resolveDepth = () => ({
      yes: { bids: [{ price: 0.49, size: 100 }, { price: 0.46, size: 500 }], asks: [{ price: 0.60, size: 99 }] },
      no: { bids: [], asks: [] },
    });
    const res = await runAutoRepriceCycle(b.deps);
    const c = (res.cancellazioni || []).find((x) => x.motivo === 'mai-primo-sul-libro');
    ok('la cancellazione top-of-book è nel referto', !!c, (res.cancellazioni || []).map((x) => x.motivo).join(','));
    ok('  col motivo DISTINTO da quello della gamba orfana', c && c.motivo !== 'gamba-orfana-scaduta');
    ok('  e col dettaglio del libro', c && /migliore del suo lato/.test(c.dettaglio || ''), c && String(c.dettaglio).slice(0, 60));
    b.pulisci();
  }

  console.log('\n══ 6 · DUE MERCATI NON SI INFLUENZANO');
  {
    // Il timer è per marketId: il banco ne ha uno solo, ma si verifica che la chiave scritta sia quella
    // del mercato valutato e non una globale.
    const b = banco({ ordini: SOLA, orfanaDa: null });
    await runAutoRepriceCycle(b.deps);
    ok('il timer è scritto sotto il marketId di questo mercato',
      b.timerScritti.every((x) => x.marketId === MKT), JSON.stringify(b.timerScritti.map((x) => x.marketId)));
    const src = fs.readFileSync(require.resolve('./gamba-orfana'), 'utf8');
    ok('  e lo store fonde invece di sostituire', /\.\.\.\(st\.markets \|\| \{\}\)/.test(src),
      'due mercati orfani nello stesso giro non devono cancellarsi il timer a vicenda');
    b.pulisci();
  }

  console.log(`\ngamba orfana nel ciclo: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FALLITO:', e && e.stack ? e.stack : String(e)); process.exit(1); });

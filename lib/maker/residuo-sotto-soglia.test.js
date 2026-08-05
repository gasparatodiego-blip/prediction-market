#!/usr/bin/env node
'use strict';
// IL RESIDUO CHE MUORE SOTTO LA SOGLIA MINIMA — e il fatto che qualcuno lo venga a sapere.
//
// Il 5 agosto 2026 l'ordine 0x4c19a7 è morto così: dopo un fill il residuo è sceso sotto
// `min_incentive_size`, il rinnovo proattivo non poteva più partire, il motore ha lasciato scadere
// l'ordine — la decisione GIUSTA — e ha prodotto ventiquattro righe di `skip-refresh-invalid` identiche.
// Nessun avviso. Il capitale è tornato libero senza che nessuno lo sapesse.
//
// Qui si verificano le tre cose che rendono quell'avviso utile invece che rumore:
//   1 · esce SOLO per BELOW_MIN_SIZE (gli altri motivi di refresh-invalid sono guasti di prezzo);
//   2 · esce UNA VOLTA per ordine, non a ogni ciclo;
//   3 · arriva fino alla dashboard, e la posizione già eseguita non viene toccata da nessuna parte.
//
// NESSUN ORDINE REALE: venue, piazzamento e cancellazione sono funzioni iniettate; la configurazione e
// il deposito dell'avviso vivono in cartelle temporanee.

const fs = require('fs');
const os = require('os');
const path = require('path');
const AR = require('./auto-reprice');
const R = require('./residui-sotto-soglia');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const MKT = '0x' + 'cd'.repeat(32);

const RULES = (mid = 0.50) => ({
  readable: true, missing: [], marketId: MKT, title: 'Chi vince le elezioni?', mid, tick: 0.01, minSize: 50,
  maxSpreadCents: 4.5, bandRadiusCents: 2.25, tokenId: 'ty', tokenIdNo: 'tn',
  midSource: 'live-book', midAgeSec: 1,
  books: { yes: { tokenId: 'ty', scoringMid: mid }, no: { tokenId: 'tn', scoringMid: +(1 - mid).toFixed(6) } },
});
const CFG = {
  restingGtdSeconds: 1380, refreshMarginSeconds: 180, minIntervalMs: 0, maxPerHour: 20,
  maxMidAgeSec: 30, requireLiveBook: true, confirmSamples: 1, hysteresisTicks: 1, pollMs: 5000,
  strategy: 'x', disconnectCancelSeconds: 120,
};
// La distanza-bersaglio viene iniettata a 0 perché l'inseguimento del mid non scatti: qui si misura il
// ramo della SCADENZA, e un chase che parte prima non lo farebbe mai raggiungere.
const NO_CHASE = { resolveOffset: () => ({ targetOffsetCents: 0, source: 'test', minMoveCents: 1 }), rememberObserved: () => {} };

// ═══ 1 · LA DECISIONE ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══ IL DISCRIMINANTE · l avviso nasce solo dalla size, mai dal prezzo');
{
  // Residuo dopo un fill: 30 share contro un minimo di 50, e la scadenza dentro il margine di rinnovo.
  const d = AR.decideReprice({
    order: { orderId: 'o1', price: 0.50, size: 30, book: 'yes', side: 'BUY', secondsToExpiry: 100 },
    rules: RULES(), config: CFG, now: 1_700_000_000_000,
  }, NO_CHASE);
  ok('l ordine non viene toccato', d.action === 'skip', d.action);
  ok('  gate «refresh-invalid», come prima', d.gate === 'refresh-invalid', String(d.gate));
  ok('  ma adesso il fatto è MARCATO', d.belowMinSize === true);
  ok('  con la soglia che non raggiunge', d.minSize === 50, String(d.minSize));
  ok('  la size che resta', d.sizeRemaining === 30, String(d.sizeRemaining));
  ok('  il capitale fermo in dollari', d.notionalUsd === 15, `$${d.notionalUsd}`);
  ok('  e quanto manca alla scadenza', d.secondsToExpiry === 100, String(d.secondsToExpiry));
  ok('  il motivo lo dice a parole, non solo in codice', /RESIDUO SOTTO SOGLIA/.test(d.reason), d.reason.slice(-120));
}
{
  // STESSO gate, motivo diverso: prezzo fuori dalla griglia del tick. Un avviso «capitale in attesa di
  // riallocazione» qui sarebbe un falso allarme — non c'è nessun residuo, c'è un prezzo sbagliato.
  const d = AR.decideReprice({
    order: { orderId: 'o2', price: 0.505, size: 100, book: 'yes', side: 'BUY', secondsToExpiry: 100 },
    rules: RULES(), config: CFG, now: 1_700_000_000_000,
  }, NO_CHASE);
  ok('fuori tick ⇒ stesso gate «refresh-invalid»', d.gate === 'refresh-invalid', String(d.gate));
  ok('  ma NESSUN avviso', d.belowMinSize === false);
  ok('  e il codice che l ha rifiutato è dichiarato', (d.refreshInvalidCodes || []).includes('OFF_TICK'),
    (d.refreshInvalidCodes || []).join(','));
  ok('  il testo non parla di residui', !/RESIDUO SOTTO SOGLIA/.test(d.reason));
}
{
  // E finché la scadenza è lontana non si passa nemmeno di lì: un residuo sotto soglia con mezz'ora di
  // vita davanti non è ancora una notizia.
  const d = AR.decideReprice({
    order: { orderId: 'o3', price: 0.50, size: 30, book: 'yes', side: 'BUY', secondsToExpiry: 1200 },
    rules: RULES(), config: CFG, now: 1_700_000_000_000,
  }, NO_CHASE);
  ok('scadenza lontana ⇒ nessun avviso (e nessun gate di rinnovo)', d.belowMinSize !== true, String(d.gate));
}

// ═══ 2 · IL CICLO: UNA VOLTA PER ORDINE ════════════════════════════════════════════════════════════
const AR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'residuo-ar-'));
const AR_DEPS = {
  configFile: path.join(AR_DIR, 'config.json'),
  autoStateFile: path.join(AR_DIR, 'state.json'),
  autoAuditFile: path.join(AR_DIR, 'audit.jsonl'),
};
fs.writeFileSync(AR_DEPS.configFile, JSON.stringify({
  global: { enabled: true }, markets: { [MKT.toLowerCase()]: { enabled: true } },
}));

function giro({ segnalati, audits, orders = null, listOk = true }) {
  const order = { orderId: 'o1', tokenId: 'ty', side: 'BUY', price: 0.50, size: 100, sizeMatched: 70,
    sizeRemaining: 30, status: 'LIVE', source: 'manual-ui', secondsToExpiry: 100 };
  return AR.runAutoRepriceCycle({
    config: CFG, configDeps: AR_DEPS,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    trackedMarketIds: () => [],
    isManual: () => ({ manual: true, readable: true }),
    marketWindow: () => ({ tooClose: false }),
    resolveRules: () => RULES(),
    listOrders: async () => (listOk
      ? { ok: true, simulated: false, orders: orders === null ? [order] : orders }
      : { ok: false, error: 'venue muto (finto)' }),
    replaceOrder: async () => ({ ok: true, place: { sent: false } }),
    cancelOrder: async () => ({ ok: true }),
    audit: (a) => audits.push(a),
    breaches: new Map(),
    residuiSegnalati: segnalati,
    link: { downSince: null, consecutiveFailures: 0 },
    ...NO_CHASE,
  });
}

(async () => {
  console.log('\n══ UNA VOLTA PER ORDINE, non una per ciclo');
  {
    const segnalati = new Set();
    const audits = [];
    const eventi = [];
    // Ventiquattro giri: gli stessi che il 5 agosto hanno prodotto ventiquattro righe identiche.
    for (let i = 0; i < 24; i += 1) {
      const r = await giro({ segnalati, audits });
      eventi.push(...(r.events || []));
    }
    ok('24 cicli sulla stessa condizione ⇒ UN avviso', eventi.length === 1, `${eventi.length} avvisi`);
    const e = eventi[0] || {};
    ok('  nomina il mercato', e.marketTitle === 'Chi vince le elezioni?', String(e.marketTitle));
    ok('  il lato', e.book === 'yes' && e.side === 'BUY', `${e.book}/${e.side}`);
    ok('  la size residua', e.sizeRemaining === 30, String(e.sizeRemaining));
    ok('  la soglia minima applicabile', e.minSize === 50, String(e.minSize));
    ok('  il capitale coinvolto in dollari', e.notionalUsd === 15, `$${e.notionalUsd}`);
    ok('  e la scadenza prevista come ISTANTE', typeof e.expiresAt === 'string' && !Number.isNaN(Date.parse(e.expiresAt)), String(e.expiresAt));
    const uno = audits.filter((a) => a.outcome === 'residuo-sotto-soglia');
    ok('  anche sul registro durevole finisce una volta sola', uno.length === 1, `${uno.length} righe`);
    ok('  l ordine è rimasto sul libro: nessuna cancellazione, nessun rimpiazzo',
      !audits.some((a) => /cancel/.test(String(a.outcome)) || a.outcome === 'sent'));
    ok('  e l id resta in memoria finché l ordine c è', segnalati.has('o1'));
  }

  console.log('\n── l elenco si pulisce quando l ordine sparisce');
  {
    const segnalati = new Set();
    const audits = [];
    await giro({ segnalati, audits });
    ok('segnalato', segnalati.size === 1);
    await giro({ segnalati, audits, orders: [] });
    ok('l ordine non è più a riposo ⇒ l id esce dall elenco', segnalati.size === 0);
  }

  console.log('\n── ma un venue MUTO non è «l ordine è sparito»');
  {
    // Potare qui farebbe uscire l'avviso una seconda volta appena il venue torna a rispondere: «non
    // l'ho letto» e «non c'è più» sono fatti diversi, e questo progetto non li confonde da nessuna parte.
    const segnalati = new Set();
    const audits = [];
    await giro({ segnalati, audits });
    await giro({ segnalati, audits, listOk: false });
    ok('lettura fallita ⇒ l id resta', segnalati.has('o1'));
    const eventi = (await giro({ segnalati, audits })).events || [];
    ok('  e al ritorno del venue l avviso NON esce di nuovo', eventi.length === 0, `${eventi.length}`);
  }

  // ═══ 3 · IL DEPOSITO CHE LA DASHBOARD LEGGE ══════════════════════════════════════════════════════
  console.log('\n══ L AVVISO ARRIVA DOVE SI GUARDA');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'residuo-store-'));
    const file = path.join(dir, 'residui.json');
    const T0 = 1_700_000_000_000;
    const ev = (id, expMin) => ({
      type: 'residuo-sotto-soglia', at: new Date(T0).toISOString(), marketId: MKT, marketTitle: 'M',
      orderId: id, book: 'yes', side: 'BUY', price: 0.5, sizeRemaining: 30, minSize: 50,
      notionalUsd: 15, secondsToExpiry: expMin * 60, expiresAt: new Date(T0 + expMin * 60_000).toISOString(),
    });
    R.registraResiduiSottoSoglia([ev('o1', 2)], { residuiFile: file, now: () => T0 });
    let letto = R.readResiduiSottoSoglia({ residuiFile: file, now: () => T0 });
    ok('l avviso è leggibile', letto.count === 1);
    ok('  col capitale totale', letto.capitaleUsd === 15, `$${letto.capitaleUsd}`);
    ok('  e non è ancora scaduto', letto.residui[0].scaduto === false);

    // Un riavvio di agent40 azzera il Set in memoria e riemette: il deposito NON deve raddoppiare.
    R.registraResiduiSottoSoglia([ev('o1', 2)], { residuiFile: file, now: () => T0 + 30_000 });
    letto = R.readResiduiSottoSoglia({ residuiFile: file, now: () => T0 + 30_000 });
    ok('lo stesso ordine due volte ⇒ resta una voce sola', letto.count === 1, `${letto.count}`);

    // Passata la scadenza l'avviso resta visibile: chi apre il pannello dopo deve poter capire cos'è
    // successo, non trovare il silenzio da cui questa cosa è nata.
    letto = R.readResiduiSottoSoglia({ residuiFile: file, now: () => T0 + 5 * 60_000 });
    ok('dopo la scadenza l avviso si vede ancora', letto.count === 1);
    ok('  e si dichiara scaduto', letto.residui[0].scaduto === true);
    letto = R.readResiduiSottoSoglia({ residuiFile: file, now: () => T0 + 2 * 60_000 + R.RETENTION_MS + 1000 });
    ok('  finita la finestra se ne va da solo', letto.count === 0, `${letto.count}`);

    // Un file che non c'è è lo stato NORMALE, non un errore da propagare.
    const vuoto = R.readResiduiSottoSoglia({ residuiFile: path.join(dir, 'mai-scritto.json'), now: () => T0 });
    ok('nessun file ⇒ nessun avviso, senza rumore', vuoto.count === 0 && vuoto.capitaleUsd === null);
  }

  console.log('\n── il cablaggio: chi emette, chi deposita, chi mostra');
  {
    const leggi = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
    const ag = leggi('../../agents/agent40-manual-reprice.js');
    ok('agent40 tiene l elenco dei già segnalati accanto a `breaches`', /const residuiSegnalati = new Set\(\)/.test(ag));
    ok('  e lo passa al ciclo', /\n\s*residuiSegnalati,/.test(ag));
    ok('  deposita gli avvisi dove li legge la dashboard', /registraResiduiSottoSoglia\(residui\)/.test(ag));

    const rt = leggi('../../app/api/maker/wallet-status/route.ts');
    ok('/api/maker/wallet-status legge il deposito', /readResiduiSottoSoglia/.test(rt));
    ok('  e li mette in `todo`, la lista che il pannello mostra già', /Residuo sotto soglia minima: non rinnovabile, capitale in attesa di riallocazione/.test(rt));
    ok('  senza spacciarli per un blocco al piazzamento', /blockedBy: bloccantiCount \? todo\[0\]\.who : null/.test(rt));

    const ui = leggi('../../app/components/LiquidityRewardsConsole.tsx');
    ok('il pannello ha la casella «Residui sotto soglia»', /Residui sotto soglia/.test(ui));
    ok('  con il capitale in attesa di riallocazione', /in attesa di riallocazione/.test(ui));
    ok('  e dice che la posizione già comprata non c entra',
      /posizione\s+già comprata non c&apos;entra e segue la sua uscita/.test(ui.replace(/\s+/g, ' ')));
  }

  console.log(`\nresiduo sotto soglia: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

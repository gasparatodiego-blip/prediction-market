#!/usr/bin/env node
'use strict';
// UN ORDINE CHE MUORE DI SCADENZA SMETTE DI SPARIRE IN SILENZIO.
//
// ═══ COSA MANCAVA (5 agosto 2026, Eric Barlow) ═══════════════════════════════════════════════════════
// L'audit conteneva 21 riprezzi e 540 skip `hourly-cap`. Alle 21:03:08 c'era una skip; alle 21:03:09 i
// due ordini non erano più al venue. In mezzo: niente. Nessuna cancellazione, nessun fill, nessun evento.
// La decisione era registrata, l'ESITO no — lo stesso buco del lavoro sul «residuo sotto soglia».
//
// ═══ IL DISCRIMINANTE ════════════════════════════════════════════════════════════════════════════════
// Un ordine può sparire per cinque ragioni e quattro non sono la scadenza: un nostro riprezzo, una nostra
// cancellazione, un fill, o la scadenza. Il confronto è con l'ISTANTE DI MORTE che pubblica il venue
// (`expiresAtMs`, già corretto per i 60s di ritiro anticipato): le prime tre avvengono con la scadenza
// lontana, la quarta esattamente lì.
//
// ═══ E CON COSA SI CONFRONTA ═════════════════════════════════════════════════════════════════════════
// Solo con i mercati di cui si è DAVVERO letto il libro. Un mercato passato al tracking o tornato ad
// agent35 non è stato guardato, e «non l'ho visto» non è «non c'è più».
//
// NESSUN ORDINE REALE: il ciclo gira su dipendenze iniettate e file temporanei.

const fs = require('fs');
const os = require('os');
const path = require('path');
const AR = require('./auto-reprice');
const S = require('./scadenze-senza-rinnovo');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MKT = '0xfb481845055afdf15febad269fcb534be4c5e79d5789b72659a036660b46e11b';
const NOW = 1_700_000_000_000;

const RULES = (mid = 0.6515, titolo = 'Eric Barlow') => ({
  readable: true, missing: [], marketId: MKT, title: titolo, mid, tick: 0.001, minSize: 50,
  maxSpreadCents: 4.5, tokenId: 'ty', tokenIdNo: 'tn', midSource: 'live-book', midAgeSec: 2,
  feedVitality: { assetsWithEvents: 40, seededAssets: 100, windowMs: 30_000 },
  books: { yes: { tokenId: 'ty', scoringMid: mid }, no: { tokenId: 'tn', scoringMid: +(1 - mid).toFixed(6) } },
});
const CFG = {
  restingGtdSeconds: 1380, refreshMarginSeconds: 180, minIntervalMs: 30_000, maxPerHour: 20,
  maxMidAgeSecLive: 60, maxMidAgeSecBlind: 10, feedAliveMinAssets: 5, requireLiveBook: true,
  confirmSamples: 2, hysteresisTicks: 1, pollMs: 5000, strategy: 'band-edge', disconnectCancelSeconds: 180,
};

function ambiente(mercati = [MKT]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadenza-'));
  const deps = {
    configFile: path.join(dir, 'config.json'),
    autoStateFile: path.join(dir, 'state.json'),
    autoAuditFile: path.join(dir, 'audit.jsonl'),
    // ⚠ LE POSIZIONI SI INIETTANO, o lo scope del ciclo non e' quello che questo test crede.
    // §4.8: lo scope e' «mercati abilitati UNIONE mercati dove c'e' gia' capitale esposto». Con una
    // posizione aperta sul bot vero il ciclo visita anche QUEL mercato, e siccome `resolveRules` di
    // questo banco risponde per qualunque id, il mercato in piu' finiva fra quelli LETTI — e la
    // potatura della memoria dimentica un ordine solo se il suo mercato e' stato letto. Risultato:
    // l'ordine spariva dalla memoria proprio nel blocco che esiste per provare che NON deve sparire.
    // «Non l'ho guardato» non e' «non c'e' piu'» — e il test lo diceva mentre lo stato vivo lo smentiva.
    posizioni: { readable: true, positions: [] },
  };
  fs.writeFileSync(deps.configFile, JSON.stringify({
    global: { enabled: true },
    markets: Object.fromEntries(mercati.map((m) => [m.toLowerCase(), { enabled: true }])),
  }));
  fs.writeFileSync(deps.autoStateFile, JSON.stringify({ markets: {}, heartbeatAt: NOW, cycles: 0 }));
  return { dir, deps };
}

// L'ordine come il venue lo elenca. `expiresAtMs` è l'istante di morte pubblicato dal venue.
const ORDINE = (extra = {}) => ({
  orderId: '0xb99f5566', source: 'manual-ui', side: 'BUY', price: 0.649, size: 60.1,
  sizeRemaining: 60.1, sizeMatched: 0, marketId: MKT, tokenId: 'ty', orderType: 'GTD',
  secondsToExpiry: 20, expiresAtMs: NOW + 20_000, ...extra,
});

function ciclo({ deps, ordini, now, righe, config = CFG, memoria, rules = RULES(), tracked = [] }) {
  return AR.runAutoRepriceCycle({
    now: () => now,
    configDeps: deps, config,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    trackedMarketIds: () => tracked,
    marketWindow: () => ({ tooClose: false }),
    resolveRules: (id) => (id === MKT ? rules : RULES(0.63, 'TX-15')),
    resolveOffset: () => ({ targetOffsetCents: 0.25, source: 'configured', minMoveCents: 0.1 }),
    rememberObserved: () => {},
    resolveDepth: () => ({ yes: { bids: [{ price: 0.65, size: 500 }, { price: 0.649, size: 60.1 }], asks: [] }, no: { bids: [], asks: [] } }),
    listOrders: async ({ marketId }) => ({ ok: true, simulated: false, orders: (ordini[marketId] || []) }),
    replaceOrder: async () => ({ ok: true, place: { sent: true, orderId: '0xNEW' } }),
    cancelOrder: async () => ({ ok: true }),
    audit: (rec) => righe.push(rec),
    ...memoria,
  });
}

(async () => {
  console.log('\n══ 1 · LA MORTE PER SCADENZA PRODUCE UN EVENTO, CON IL MOTIVO DEL MANCATO RINNOVO');
  {
    const { deps } = ambiente();
    const righe = [];
    const memoria = { ordiniVisti: new Map(), breaches: new Map(), residuiSegnalati: new Set(), conflittiSoppressi: new Set() };
    // Giro 1: l'ordine c'è, la scadenza è dentro il margine (20s su 180s), e il rinnovo è DOVUTO ma non
    // può partire — la size residua è 30 contro un minimo di 50, quindi ripiazzarla non passerebbe il
    // guard condiviso. È una morte per scadenza che avviene ANCHE dopo la correzione del tetto orario:
    // il motivo del mancato rinnovo cambia, il silenzio sull'esito era lo stesso.
    const r1 = await ciclo({ deps, ordini: { [MKT]: [ORDINE({ size: 30, sizeRemaining: 30 })] }, now: NOW, righe, memoria });
    ok('giro 1 · l ordine c è e non viene rinnovato', (r1.events || []).filter((x) => x.type === 'scaduto-senza-rinnovo').length === 0);
    ok('  e la skip che lo dice è nel registro', righe.some((x) => x.outcome === 'skip-refresh-invalid'));

    // Giro 2, 25 secondi dopo: l'ordine non c'è più e la sua scadenza è passata.
    const r2 = await ciclo({ deps, ordini: { [MKT]: [] }, now: NOW + 25_000, righe, memoria });
    const ev = (r2.events || []).filter((e) => e.type === 'scaduto-senza-rinnovo');
    ok('giro 2 · esce UN evento distinto', ev.length === 1, `${ev.length} eventi`);
    const e = ev[0] || {};
    ok('  con il mercato', e.marketId === MKT);
    ok('  e il suo titolo leggibile', e.marketTitle === 'Eric Barlow', String(e.marketTitle));
    ok('  il lato', e.book === 'yes' && e.side === 'BUY', `${e.book}/${e.side}`);
    ok('  il prezzo', e.price === 0.649, String(e.price));
    ok('  la size', e.size === 30, String(e.size));
    ok('  il capitale che torna libero', e.notionalUsd === 19.47, `$${e.notionalUsd}`);
    ok('  l istante della scadenza', e.expiresAt === new Date(NOW + 20_000).toISOString(), String(e.expiresAt));
    ok('  il timestamp dell evento', typeof e.at === 'string' && e.at.endsWith('Z'));
    ok('  IL MOTIVO per cui il rinnovo non è avvenuto', e.bloccoGate === 'refresh-invalid', String(e.bloccoGate));
    ok('  col testo del rifiuto, non solo il codice', /RESIDUO SOTTO SOGLIA/.test(String(e.bloccoReason)));
    ok('  e quando quel rifiuto è avvenuto', typeof e.bloccoAt === 'string');
    ok('  più l ultimo TTL visto, per poter giudicare da soli', e.ultimaTtlSec === 20, String(e.ultimaTtlSec));

    const audit = righe.filter((x) => x.outcome === 'scaduto-senza-rinnovo');
    ok('e c è una riga di audit dedicata', audit.length === 1, `${audit.length}`);
    ok('  greppabile per nome', audit[0] && audit[0].outcome === 'scaduto-senza-rinnovo');
    ok('  che nomina il gate che ha fermato il rinnovo', audit[0] && audit[0].gate === 'refresh-invalid');
    ok('  e dice a parole cos è successo',
      audit[0] && /morto per scadenza GTD senza essere stato rinnovato/.test(audit[0].reason));

    console.log('\n══ 2 · UNA VOLTA SOLA: il giro dopo non lo ridice');
    const r3 = await ciclo({ deps, ordini: { [MKT]: [] }, now: NOW + 30_000, righe, memoria });
    ok('nessun secondo evento', (r3.events || []).filter((x) => x.type === 'scaduto-senza-rinnovo').length === 0);
    ok('  e nessuna seconda riga di audit',
      righe.filter((x) => x.outcome === 'scaduto-senza-rinnovo').length === 1);
    ok('  la memoria dell ordine è stata liberata', !memoria.ordiniVisti.has('0xb99f5566'));
  }

  console.log('\n══ 3 · CIÒ CHE NON È UNA SCADENZA NON VIENE CHIAMATO SCADENZA');
  {
    // Un riprezzo: l'ordine sparisce con 1345s di vita davanti, e al suo posto ne compare un altro.
    const { deps } = ambiente();
    const righe = [];
    const memoria = { ordiniVisti: new Map() };
    await ciclo({ deps, ordini: { [MKT]: [ORDINE({ secondsToExpiry: 1345, expiresAtMs: NOW + 1_345_000 })] }, now: NOW, righe, memoria });
    const r = await ciclo({
      deps, righe, memoria, now: NOW + 40_000,
      ordini: { [MKT]: [ORDINE({ orderId: '0xNUOVO', secondsToExpiry: 1380, expiresAtMs: NOW + 1_420_000 })] },
    });
    ok('un ordine riprezzato NON è un ordine scaduto',
      (r.events || []).filter((x) => x.type === 'scaduto-senza-rinnovo').length === 0);
  }
  {
    // Un fill o una cancellazione a metà vita: stessa cosa, la scadenza era lontana.
    const { deps } = ambiente();
    const righe = [];
    const memoria = { ordiniVisti: new Map() };
    await ciclo({ deps, ordini: { [MKT]: [ORDINE({ secondsToExpiry: 900, expiresAtMs: NOW + 900_000 })] }, now: NOW, righe, memoria });
    const r = await ciclo({ deps, ordini: { [MKT]: [] }, now: NOW + 5_000, righe, memoria });
    ok('un ordine sparito a metà vita NON è un ordine scaduto',
      (r.events || []).filter((x) => x.type === 'scaduto-senza-rinnovo').length === 0);
  }
  {
    // Un GTC non ha scadenza: non gli si può attribuire una morte per scadenza.
    const { deps } = ambiente();
    const righe = [];
    const memoria = { ordiniVisti: new Map() };
    await ciclo({ deps, ordini: { [MKT]: [ORDINE({ orderType: 'GTC', secondsToExpiry: null, expiresAtMs: null })] }, now: NOW, righe, memoria });
    const r = await ciclo({ deps, ordini: { [MKT]: [] }, now: NOW + 5_000, righe, memoria });
    ok('un GTC sparito non viene attribuito a una scadenza che non ha',
      (r.events || []).filter((x) => x.type === 'scaduto-senza-rinnovo').length === 0);
  }

  console.log('\n══ 4 · «NON L HO GUARDATO» NON È «NON C È PIÙ»');
  {
    // Il mercato passa al motore di tracking: il suo libro non viene letto. L'ordine è vivo, e annunciarne
    // la morte sarebbe un falso allarme peggiore del silenzio che questo evento esiste per rompere.
    const { deps } = ambiente();
    const righe = [];
    const memoria = { ordiniVisti: new Map() };
    // ⚠ QUI L'ORDINE NON DEVE ESSERE VICINO ALLA SCADENZA, e questa riga e' la correzione del
    // 18 agosto 2026. `ORDINE()` nasce a 20 secondi dalla morte perche' i blocchi 1-3 parlano proprio
    // di morte per scadenza; riusarlo qui faceva RINNOVARE l'ordine dal primo ciclo — il margine di
    // rinnovo e' 180 s — e quindi l'id che il secondo ciclo cerca in memoria non esisteva piu' PER
    // COSTRUZIONE: era stato sostituito da un ordine nuovo, che e' il comportamento giusto.
    // Il blocco non provava «non l'ho guardato non e' non c'e' piu'»: provava che un ordine rinnovato
    // sparisce dalla memoria, che e' un'altra cosa e che era gia' vera.
    const LONTANO = ORDINE({ secondsToExpiry: 900, expiresAtMs: NOW + 900_000 });
    await ciclo({ deps, ordini: { [MKT]: [LONTANO] }, now: NOW, righe, memoria });
    const r = await ciclo({ deps, ordini: { [MKT]: [] }, now: NOW + 25_000, righe, memoria, tracked: [MKT] });
    ok('mercato non letto ⇒ nessun annuncio di morte',
      (r.events || []).filter((x) => x.type === 'scaduto-senza-rinnovo').length === 0);
    ok('  e l ordine resta in memoria, in attesa di essere riletto', memoria.ordiniVisti.has('0xb99f5566'));
  }
  {
    // Il venue non risponde: identico. Il gate è un altro, la regola è la stessa.
    const { deps } = ambiente();
    const righe = [];
    const memoria = { ordiniVisti: new Map() };
    await ciclo({ deps, ordini: { [MKT]: [ORDINE()] }, now: NOW, righe, memoria });
    const r = await AR.runAutoRepriceCycle({
      now: () => NOW + 25_000, configDeps: deps, config: CFG,
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      isManual: () => ({ manual: true, readable: true }),
      trackedMarketIds: () => [], marketWindow: () => ({ tooClose: false }),
      resolveRules: () => RULES(),
      listOrders: async () => ({ ok: false, error: 'venue muto' }),
      audit: (rec) => righe.push(rec),
      ...memoria,
    });
    ok('venue muto ⇒ nessun annuncio di morte',
      (r.events || []).filter((x) => x.type === 'scaduto-senza-rinnovo').length === 0);
  }

  console.log('\n══ 5 · IL DEPOSITO PER LA DASHBOARD: fonde per orderId e invecchia da solo');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scadenze-file-'));
    const file = path.join(dir, 'scadenze.json');
    const ev = (id, at) => ({
      type: 'scaduto-senza-rinnovo', at: new Date(at).toISOString(), orderId: id,
      marketId: MKT, marketTitle: 'Eric Barlow', book: 'yes', side: 'BUY',
      price: 0.649, size: 60.1, notionalUsd: 39.0049, expiresAt: new Date(at).toISOString(),
      bloccoGate: 'hourly-cap',
    });
    let w = S.registraScadenzeSenzaRinnovo([ev('0xa', NOW)], { scadenzeFile: file, now: () => NOW });
    ok('la prima voce viene scritta', w.ok && w.count === 1);
    w = S.registraScadenzeSenzaRinnovo([ev('0xa', NOW)], { scadenzeFile: file, now: () => NOW + 1000 });
    ok('  la stessa voce NON si duplica', w.count === 1, `${w.count}`);
    w = S.registraScadenzeSenzaRinnovo([ev('0xb', NOW + 2000)], { scadenzeFile: file, now: () => NOW + 2000 });
    ok('  una voce nuova si aggiunge', w.count === 2, `${w.count}`);

    const letto = S.readScadenzeSenzaRinnovo({ scadenzeFile: file, now: () => NOW + 3000 });
    ok('il lettore le vede entrambe', letto.count === 2, `${letto.count}`);
    ok('  e somma il capitale tornato libero', letto.capitaleUsd === 78.01, `$${letto.capitaleUsd}`);

    const dopo = S.readScadenzeSenzaRinnovo({ scadenzeFile: file, now: () => NOW + S.RETENTION_MS + 60_000 });
    ok('dopo la finestra di visibilità se ne vanno da sole', dopo.count === 0, `${dopo.count}`);

    const assente = S.readScadenzeSenzaRinnovo({ scadenzeFile: path.join(dir, 'mai-scritto.json'), now: () => NOW });
    ok('un file assente non è un errore: è «non è mai morto niente»',
      assente.count === 0 && assente.at === null);
  }

  console.log('\n══ 6 · ARRIVA FINO ALLA DASHBOARD, SULLA SUPERFICIE CHE GIÀ ESISTE');
  {
    const ROOT = path.resolve(__dirname, '..', '..');
    const route = fs.readFileSync(path.join(ROOT, 'app', 'api', 'maker', 'wallet-status', 'route.ts'), 'utf8');
    ok('la rotta legge il deposito', /readScadenzeSenzaRinnovo/.test(route));
    ok('  e ne fa una voce di `todo`, la stessa superficie dei residui',
      /todo\.push\(\{[\s\S]{0,400}Ordine spento dalla scadenza/.test(route));
    ok('  con la forma {who, what, how}', /who: 'operatore',[\s\S]{0,600}how:/.test(route));
    ok('  traducendo il motivo tecnico in italiano', /il tetto orario di riprezzi lo ha fermato/.test(route));
    ok('  e distinguendo «fermato» da «mai valutato»', /non è mai stato valutato prima della scadenza/.test(route));
    ok('  senza entrare in `blockedBy`: è un avviso, non un blocco',
      route.indexOf('const bloccantiCount') < route.indexOf('Ordine spento dalla scadenza'));
    ok('  e porta anche i numeri strutturati', /scadenzeSenzaRinnovo: \{/.test(route));

    const panel = fs.readFileSync(path.join(ROOT, 'app', 'components', 'LiquidityRewardsConsole.tsx'), 'utf8');
    ok('il pannello ha il tipo', /scadenzeSenzaRinnovo\?: \{/.test(panel));
    ok('  la casella riassuntiva nella sezione «Stato wallet e piazzamento»',
      /data-lrc-wallet-scadenze=/.test(panel));
    ok('  che compare solo quando ce n è almeno uno',
      /wal\.scadenzeSenzaRinnovo && wal\.scadenzeSenzaRinnovo\.count > 0/.test(panel));
    ok('  col capitale tornato libero', /tornati liberi/.test(panel));
    ok('  e una spiegazione in italiano di cosa è successo',
      /la scadenza del venue li ha spenti/.test(panel));
  }

  console.log(`\nscaduto senza rinnovo: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

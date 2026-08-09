#!/usr/bin/env node
'use strict';
// UN MERCATO MORTO ESCE DALLA ALLOWLIST DA SOLO — E agent40 HA L'ATTESTAZIONE CHE GLI SERVE.
//
// ═══ I DUE DIFETTI, TROVATI INSIEME IL 4 AGOSTO 2026 ═════════════════════════════════════════════════
//
// 1 · L'ATTESTAZIONE, E UNA DIAGNOSI SBAGLIATA DA CUI VALE LA PENA IMPARARE.
//     `pm2 env` e `/proc/<pid>/environ` non mostravano MAKER_FUNDING_APPROVED su agent40, mentre la
//     mostravano su agent41 e agent35. La conclusione tratta — «al primo fill l'uscita automatica e il
//     rimpiazzo verrebbero rifiutati con gate funding-approval» — ERA FALSA: agent40 ha in testa al
//     file un caricatore di .env scritto a mano, e da li' la variabile arrivava eccome.
//
//     /proc mostra l'ambiente al momento dell'EXEC, non quello che il processo si costruisce dopo.
//     Leggere /proc «invece di pm2» sembrava piu' rigoroso e rispondeva a una domanda diversa.
//
//     Cosa resta vero: agent41 quel caricatore NON ce l'ha, e l'attestazione la ereditava dal demone
//     pm2 senza che nessuna riga di configurazione la garantisse. Su agent41 la fragilita' e' reale,
//     ed e' il processo che apre posizioni da solo. Ora entrambi la dichiarano.
//
// 2 · LA ALLOWLIST CHE NON SI SPAZZA. `cfg.enabledMarketIds` conteneva 7 mercati, di cui CINQUE
//     finestre Bitcoin da 5 minuti del 2 agosto, chiuse da oltre 2800 minuti. agent40 le vedeva ogni
//     5 secondi e le annunciava `market-closed` — lasciandole nella lista a ogni giro.
//     Una pulizia esisteva (allocation-reset.js, fase 2) ma e' legata al RESET completo: il
//     riallocatore periodico (in dry-run) o il bottone «Conferma ed esegui». Chi abilita un mercato
//     dal percorso per-mercato non passa mai di li' — quel percorso e' additivo per costruzione.
//     Il motore di tracking la stessa cosa la faceva gia' (mm-tracking.js, «FIX 3»); il riprezzo no,
//     pur dichiarando nel proprio commento che «i due motori devono fare la stessa cosa a fine vita».

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAutoRepriceCycle } = require('./auto-reprice');
const cfgMod = require('./auto-reprice-config');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const MKT = '0x' + 'ab'.repeat(32);
// Un ordine che il watcher RICONOSCE come proprio: `selectOwnedOrders` attribuisce per
// `source === 'manual-ui'` e per token. Senza queste due chiavi l'ordine è di qualcun altro, e il
// watcher non lo conta — cosa che questo test ha imparato sbagliando.
const NOSTRO = { orderId: 'o1', price: 0.4, size: 50, side: 'BUY', source: 'manual-ui', marketId: MKT, tokenId: 'ty' };

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · L ATTESTAZIONE È NELL AMBIENTE DI agent40, E ALLINEATA AGLI ALTRI DUE');
{
  const eco = fs.readFileSync(path.join(ROOT, 'agents', 'ecosystem.config.js'), 'utf8');
  // Il blocco di agent40: dal suo `name:` fino alla graffa che lo chiude.
  const i = eco.indexOf("name:          'agent40-manual-reprice'");
  ok('il blocco di agent40 esiste', i > 0);
  const blocco = eco.slice(i, eco.indexOf("name:          'agent38-tape-watchdog'"));
  ok('agent40 dichiara MAKER_FUNDING_APPROVED', /MAKER_FUNDING_APPROVED:\s*'true'/.test(blocco),
    'senza, uscita automatica e rimpiazzo vengono rifiutati con gate funding-approval al primo fill');
  ok('  e sta nel blocco env:, non in un commento', /env:\s*\{[^}]*MAKER_FUNDING_APPROVED:\s*'true'[^}]*\}/.test(blocco));

  // L'allineamento con l'altro processo che piazza.
  // Il blocco di un agente va da `name:` al `name:` successivo — NON a un numero fisso di caratteri:
  // fra il nome di un agente e il suo `env:` possono esserci novanta righe di commento, e una fetta da
  // 6000 caratteri si fermava prima. È il primo modo in cui questo test ha sbagliato.
  // (agent35-maker era il secondo nome di questo elenco: rimosso il 9 agosto 2026 con l'ARMING.)
  const blocchi = [...eco.matchAll(/name:\s*'([a-z0-9-]+)'/g)].map((m) => ({ nome: m[1], da: m.index }));
  const bloccoDi = (nome) => {
    const k = blocchi.findIndex((b) => b.nome === nome);
    return k < 0 ? '' : eco.slice(blocchi[k].da, k + 1 < blocchi.length ? blocchi[k + 1].da : eco.length);
  };
  for (const ag of ['agent41-realloc-scheduler']) {
    ok(`  ${ag} continua ad averla`, /MAKER_FUNDING_APPROVED:\s*'true'/.test(bloccoDi(ag)));
  }

  // La regressione che conta: NON deve essere finita anche in un processo che non piazza.
  ok('non e stata sparsa dove non serve (il dashboard la riceve gia per suo conto)',
    (eco.match(/MAKER_FUNDING_APPROVED:\s*'true'/g) || []).length <= 4,
    `${(eco.match(/MAKER_FUNDING_APPROVED:\s*'true'/g) || []).length} occorrenze`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · IL CABLAGGIO: agent40 passa la mano che scrive');
{
  const ag = fs.readFileSync(path.join(ROOT, 'agents', 'agent40-manual-reprice.js'), 'utf8');
  ok('agent40 INIETTA disableMarket', /disableMarket:\s*\(\{ marketId, reason \}\)/.test(ag),
    'senza questa riga la decisione esiste e non la prende nessuno');
  ok('  e la mano che scrive e setAutoReprice(enabled:false)',
    /setAutoReprice\(\{[\s\S]{0,120}enabled:\s*false/.test(ag));
  ok('  con setAutoReprice davvero importato', /setAutoReprice\s*\}?\s*=\s*require\('\.\.\/lib\/maker\/auto-reprice-config'\)|setAutoReprice.*require.*auto-reprice-config/.test(ag)
    || /EXPECTED_RENEWALS_PER_HOUR, setAutoReprice/.test(ag));
  ok('  ed e la GEMELLA di disableTracking, non una seconda strada',
    /disableTracking:\s*\(\{ marketId, reason \}\)/.test(ag));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// IL BANCO — una configurazione VERA in cartella temporanea, così l'asserzione non è «ha chiamato la
// funzione» ma «il mercato non è più nella allowlist».
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
function banco({ gate = 'market-closed', tooClose = true, ordini = [], cancelOk = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-'));
  const configFile = path.join(dir, 'auto-reprice.json');
  // ── ANCHE L'AUDIT VA NELLA CARTELLA TEMPORANEA, NON IN data/ ────────────────────────────────────
  // `cfgDeps` risolve il file di audit da `autoAuditFile`, NON da `configFile`: iniettando solo il
  // secondo, la configurazione finiva nel temporaneo e ogni riga di audit in
  // `data/maker-auto-reprice-audit.jsonl`, cioè nel registro VERO. Misurato il 5 agosto 2026: 763 righe
  // su 821 in quel file venivano da questo banco (`by:'test'`, `reason:'banco'`), e i ~58 flip veri
  // dell'operatore erano annegati dentro. Un registro che si consulta per sapere «chi ha acceso questo
  // mercato, e quando» smette di servire quando il 93% delle righe le ha scritte una suite di test.
  const configDeps = { configFile, autoAuditFile: path.join(dir, 'auto-reprice-audit.jsonl') };
  cfgMod.setAutoReprice({ scope: 'global', enabled: true, by: 'test', reason: 'banco' }, configDeps);
  cfgMod.setAutoReprice({ scope: 'market', marketId: MKT, enabled: true, by: 'test', reason: 'banco' }, configDeps);

  const audits = [];
  const deps = {
    now: () => 9_000_000,
    configDeps,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    marketWindow: () => (tooClose
      ? { tooClose: true, gate, minutesToClose: -2800, reason: 'il mercato risulta CHIUSO da 2800 min' }
      : { tooClose: false, minutesToClose: 600, minMinutes: 3 }),
    resolveRules: () => ({
      readable: true, missing: [], marketId: MKT, mid: 0.40, tick: 0.01, minSize: 50,
      maxSpreadCents: 4.5, bandRadiusCents: 2.25, tokenId: 'ty', tokenIdNo: 'tn',
      midSource: 'live-book', midAgeSec: 1,
      books: { yes: { tokenId: 'ty', scoringMid: 0.40 }, no: { tokenId: 'tn', scoringMid: 0.60 } },
    }),
    listOrders: async () => ({ ok: true, simulated: false, orders: ordini }),
    cancelOrder: async () => ({ ok: cancelOk, reason: cancelOk ? null : 'venue ha rifiutato' }),
    replaceOrder: async () => ({ ok: false, gate: 'non-usato' }),
    audit: (r) => audits.push(r),
    disableMarket: async ({ marketId, reason }) =>
      cfgMod.setAutoReprice({ scope: 'market', marketId, enabled: false, by: 'motore · test', reason }, configDeps),
  };
  const ancoraAbilitato = () => cfgMod.readAutoRepriceConfig(configDeps).enabledMarketIds
    .some((k) => k.toLowerCase() === MKT.toLowerCase());
  return { deps, audits, ancoraAbilitato, configDeps, pulisci: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

(async () => {

  console.log('\n══ 3 · MERCATO CHIUSO E LIBRO LIBERO → ESCE DA SOLO');
  {
    const b = banco({ gate: 'market-closed', ordini: [] });
    ok('prima del ciclo il mercato È nella allowlist', b.ancoraAbilitato());
    const res = await runAutoRepriceCycle(b.deps);
    ok('il ciclo gira', res.ran === true || res.markets.length > 0, res.gate || 'ok');
    ok('DOPO il ciclo NON è più nella allowlist', !b.ancoraAbilitato(),
      'questa è la riga che i 5 mercati Bitcoin aspettavano da due giorni');
    const m = res.markets.find((x) => String(x.marketId).toLowerCase() === MKT.toLowerCase());
    ok('  il referto lo dichiara', m && m.autoDisabled === true);
    ok('  e il motivo lo scrive a voce', m && /TOLTO dalla allowlist automaticamente/.test(m.reason || ''), m && m.reason);
    ok('  con una riga di audit dedicata', b.audits.some((a) => a.outcome === 'allowlist-auto-off'));
    b.pulisci();
  }

  console.log('\n══ 4 · E QUANDO NON DEVE, NON LO FA');
  {
    // (a) Vicino alla chiusura ma NON chiuso: il mercato è ancora dell'operatore.
    const a = banco({ gate: 'market-too-close-to-close', ordini: [] });
    await runAutoRepriceCycle(a.deps);
    ok('«troppo vicino» NON è «chiuso»: resta nella allowlist', a.ancoraAbilitato(),
      'dentro la finestra finale il mercato è vivo e deve restare configurato');
    a.pulisci();

    // (b) Chiuso, con un ordine NOSTRO che non si è riusciti a cancellare: prima si libera il libro.
    //     «Nostro» ha un significato preciso: `selectOwnedOrders` attribuisce solo source:'manual-ui'.
    const c = banco({ gate: 'market-closed', ordini: [NOSTRO], cancelOk: false });
    await runAutoRepriceCycle(c.deps);
    ok('cancellazione fallita su un ordine NOSTRO → NON esce',
      c.ancoraAbilitato(),
      'prima si toglie tutto, poi si chiude il registro — mai il contrario');
    c.pulisci();

    // (c) Chiuso, con un ordine nostro cancellato con successo: libro libero ⇒ esce.
    const d = banco({ gate: 'market-closed', ordini: [NOSTRO], cancelOk: true });
    await runAutoRepriceCycle(d.deps);
    ok('cancellazione riuscita → libro libero → esce', !d.ancoraAbilitato());
    d.pulisci();

    // (d) Chiuso, con un ordine di QUALCUN ALTRO (non attribuito al pannello). Il watcher non lo
    //     possiede e non lo tocca — e il mercato esce lo stesso. È corretto, e vale la pena dirlo
    //     esplicitamente invece di scoprirlo per caso: togliere dalla allowlist non impedisce di
    //     cancellare quell'ordine (la cancellazione non è soggetta né alla allowlist né al kill),
    //     e su un mercato chiuso non si piazza comunque nulla. Questo test è la prova che la
    //     semantica è VOLUTA: se un domani si volesse bloccare anche su ordini altrui, fallirebbe qui.
    const f = banco({ gate: 'market-closed', ordini: [{ ...NOSTRO, source: 'agent35' }], cancelOk: true });
    await runAutoRepriceCycle(f.deps);
    ok('ordine non attribuito al pannello: il watcher non lo possiede, e il mercato esce',
      !f.ancoraAbilitato(),
      'la cancellazione resta possibile comunque — non è soggetta alla allowlist');
    f.pulisci();

    // (d) Mercato vivo: nessuno lo tocca.
    const e = banco({ tooClose: false });
    await runAutoRepriceCycle(e.deps);
    ok('mercato vivo: resta, ovviamente', e.ancoraAbilitato());
    e.pulisci();
  }

  console.log('\n══ 5 · SENZA LA DIPENDENZA IL CICLO NON ESPLODE (ma non pulisce)');
  {
    const b = banco({ gate: 'market-closed', ordini: [] });
    delete b.deps.disableMarket;
    const res = await runAutoRepriceCycle(b.deps);
    ok('il ciclo completa lo stesso', Array.isArray(res.markets));
    ok('  ma il mercato resta — ED È ESATTAMENTE LO STATO DI PRIMA DEL FIX', b.ancoraAbilitato());
    b.pulisci();
  }

  console.log('\n══ 6 · TOGLIERE PUÒ SOLO RESTRINGERE — mai il contrario');
  {
    // La proprietà di sicurezza dell'intera modifica: `enabledMarketIds` è la allowlist live-min, e
    // questo percorso la scrive in una sola direzione. Se un giorno qualcuno passasse enabled:true da
    // qui, un mercato chiuso rientrerebbe fra quelli su cui è lecito piazzare.
    const src = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8');
    const i = src.indexOf('deps.disableMarket');
    const intorno = src.slice(i - 200, i + 600);
    ok('il ramo chiama disableMarket e nient altro che scriva la configurazione',
      !/setAutoReprice\(/.test(intorno) && !/enabled:\s*true/.test(intorno));
    const ag = fs.readFileSync(path.join(ROOT, 'agents', 'agent40-manual-reprice.js'), 'utf8');
    const j = ag.indexOf('disableMarket:');
    ok('  e l iniettore scrive SOLO enabled:false', /enabled:\s*false/.test(ag.slice(j, j + 220)) && !/enabled:\s*true/.test(ag.slice(j, j + 220)));
  }

  console.log(`\nigiene della allowlist: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

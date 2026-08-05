#!/usr/bin/env node
'use strict';
// LO SNAPSHOT DELLE POSIZIONI — IL LETTORE C'ERA, LO SCRITTORE NON GIRAVA.
//
// ═══ IL GUASTO ═══════════════════════════════════════════════════════════════════════════════════════
// Un piazzamento reale è stato rifiutato con:
//
//     limit-venue-positions-unreadable — le posizioni aperte al venue non sono leggibili
//     (snapshot delle posizioni non leggibile (mai scritto))
//
// «mai scritto» è ENOENT: il file non era mai esistito. Il gate (lib/safety/risk-limits.js) e il modulo
// dello snapshot sono nati NELLO STESSO COMMIT — 7e923ba, 4 agosto 2026 16:18 — ma lo scrittore era
// raggiungibile solo passando da `closeTask`, che esce subito quando nessun mercato ha l'uscita
// automatica accesa. Lettore in produzione, scrittore irraggiungibile: dalle 16:18 alle 21:30 di quel
// giorno OGNI piazzamento veniva rifiutato, e la causa non era in nessuno dei due file.
//
// ═══ IL SECONDO GUASTO, QUELLO ANCORA ARMATO ════════════════════════════════════════════════════════
// Il 4 agosto alle 21:30 il compito è stato reso autonomo (commit 7b18a48) — ma nel ciclo veniva
// chiamato dietro `if (Date.now() - lastReconcileAt < 1000)`, la condizione della riga sotto, copiata
// insieme alla riga. Il commento sopra diceva «e senza condizioni». Il commento e il codice
// dichiaravano due cose diverse.
//
// Quella condizione regge solo finché la riconciliazione dura meno di un secondo, e dura poco SOLO
// quando non ha niente da fare: `reconcileManualLane` esce prima di toccare la rete se non ci sono
// ordini irrisolti. Appena ce n'è uno — cioè appena si comincia a piazzare davvero — fa tre chiamate al
// venue in fila. Misurato il 5 agosto 2026: la prima da sola, 3948 ms.
//
// Quindi non «ogni tanto salta»: lo snapshot smetteva di aggiornarsi ESATTAMENTE quando si inizia a
// operare, e 180 secondi dopo il gate bloccava tutto. Un guasto che non si incontra provando, solo
// usando — e che si sarebbe presentato al secondo ordine, non al primo.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const S = require('./venue-positions-snapshot');
const { evaluateLimits } = require('./risk-limits');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-pos-'));
const FILE = path.join(tmpdir, 'venue-positions.json');
const lettura = (positions) => ({ ok: true, positions });

console.log('\n══ 1 · IL CONTRATTO DI FRESCHEZZA, ESERCITATO SU UN FILE VERO');
{
  const r0 = S.readVenuePositions({ snapshotFile: FILE });
  ok('file inesistente → NON leggibile, e il motivo e «mai scritto»',
    r0.readable === false && /mai scritto/.test(r0.reason), 'e l ENOENT del guasto');
  ok('  e NON restituisce «nessuna posizione»', r0.positions.length === 0 && r0.readable === false,
    'non ho guardato non e non c e niente');

  const w = S.writeVenuePositions(lettura([
    { tokenId: '123', conditionId: '0xaa', size: 199.9918, avgPrice: 0.1675, curPrice: 0.2, title: 'X' },
  ]), { snapshotFile: FILE, now: () => 1_000_000 });
  ok('scrittura riuscita', w.ok === true && w.written === true && w.count === 1);

  const r1 = S.readVenuePositions({ snapshotFile: FILE, now: () => 1_000_000 + 60_000 });
  ok('a 60s e leggibile', r1.readable === true && r1.positions.length === 1);
  ok('  con l eta dichiarata', r1.ageMs === 60_000);
  const r2 = S.readVenuePositions({ snapshotFile: FILE, now: () => 1_000_000 + 180_000 });
  ok('a 180s esatti e ancora leggibile', r2.readable === true);
  const r3 = S.readVenuePositions({ snapshotFile: FILE, now: () => 1_000_000 + 180_001 });
  ok('a 180,001s NON e piu leggibile', r3.readable === false && /vecchio di/.test(r3.reason));
  ok('  e il motivo dice DOVE guardare', /chi lo scrive non sta girando/.test(r3.reason));

  // Una lettura fallita non deve poter cancellare uno snapshot buono: sarebbe trasformare un singhiozzo
  // di rete in «nessuna posizione aperta», cioe' in un via libera.
  const wKo = S.writeVenuePositions({ ok: false, reason: 'venue irraggiungibile' }, { snapshotFile: FILE });
  ok('una lettura FALLITA non sovrascrive lo snapshot buono', wKo.written === false);
  ok('  e quello di prima e ancora li',
    S.readVenuePositions({ snapshotFile: FILE, now: () => 1_000_000 + 1000 }).positions.length === 1);
}

console.log('\n══ 2 · IL GATE: «NON LEGGIBILE» RIFIUTA, E NON E «ZERO»');
{
  const L = { maxOrderNotionalUsd: 1000, maxOpenNotionalUsd: 600, maxOrdersPerWindow: 20, maxDailyLossUsd: 25 };
  const base = { openNotionalUsd: 0, ordersInWindow: 0, realisedDailyPnlUsd: 0 };
  const ordine = { notionalUsd: 16.5 };   // 20,6 share a 0,80: l'ordine vero che e' stato rifiutato

  const mai = evaluateLimits({ order: ordine, limits: L,
    usage: { ...base, venuePositions: { readable: false, reason: 'snapshot delle posizioni non leggibile (mai scritto)' } } });
  ok('snapshot mai scritto → RIFIUTA', mai.allow === false && mai.gate === 'venue-positions-unreadable');
  ok('  col motivo dell operatore, non un codice',
    /non si apre esposizione nuova senza sapere quanta ce n/.test(mai.reason));

  const vecchio = evaluateLimits({ order: ordine, limits: L,
    usage: { ...base, venuePositions: { readable: false, reason: 'snapshot vecchio di 240s' } } });
  ok('snapshot scaduto → rifiuta allo stesso modo', vecchio.allow === false && vecchio.gate === 'venue-positions-unreadable');

  const buono = evaluateLimits({ order: ordine, limits: L,
    usage: { ...base, venuePositions: { readable: true, count: 1, addedUsd: 33.5 } } });
  ok('snapshot leggibile → il gate lascia passare', buono.allow === true,
    'un blocco che scatta sempre e un blocco che si impara a ignorare');

  // Il nome esatto che compare all'operatore: l'adapter lo prefissa.
  const adapter = leggi('lib', 'venues', 'polymarket-clob-maker', 'adapter.js');
  ok('il nome mostrato e `limit-` + il gate', /gate: `limit-\$\{limits\.gate \|\| 'unknown'\}`/.test(adapter),
    'quindi limit-venue-positions-unreadable');
}

console.log('\n══ 3 · LO SCRITTORE GIRA SEMPRE, NON SOLO QUANDO LA RICONCILIAZIONE E VELOCE');
{
  const a40 = leggi('agents', 'agent40-manual-reprice.js');

  ok('LO SNAPSHOT NON HA PIU CONDIZIONI NEL CICLO',
    /try \{ await snapshotPosizioniTask\(\); \}/.test(a40),
    'era dietro `if (Date.now() - lastReconcileAt < 1000)`');
  ok('  e non e piu agganciato all orologio della riconciliazione',
    !/lastReconcileAt < 1000\) await snapshotPosizioniTask/.test(a40));
  ok('ha un throttle SUO', /const SNAPSHOT_EVERY_MS = 60_000;/.test(a40));
  ok('  ben sotto la scadenza di 180s', 60_000 * 2 < S.MAX_AGE_MS + 60_000);
  ok('  e riprova prima quando la lettura fallisce', /const SNAPSHOT_RETRY_MS = 15_000;/.test(a40),
    'fallire non e rinunciare');
  ok('  con la scelta fra i due throttle esplicita',
    /ultimoSnapshotOk \? SNAPSHOT_EVERY_MS : SNAPSHOT_RETRY_MS/.test(a40));
  ok('un fallimento della lettura si vede nei log', /snapshot posizioni: lettura del venue NON riuscita/.test(a40));

  // LA CHIUSURA AUTOMATICA: stesso difetto, stessa riga, un rigo piu' sotto. L'intento — «gira dopo una
  // riconciliazione» — resta, ma adesso lo si CHIEDE invece di dedurlo dal tempo trascorso.
  ok('la chiusura automatica gira dopo un FATTO, non dopo un orologio',
    /try \{ if \(riconciliato\) await closeTask\(\); \}/.test(a40));
  ok('  e la riconciliazione dichiara se ha girato',
    /if \(now - lastReconcileAt < RECONCILE_EVERY_MS\) return false;/.test(a40) && /\n  return true;\n\}/.test(a40));
  // I COMMENTI VANNO TOLTI PRIMA DI CERCARE. La condizione difettosa e' NOMINATA nei commenti che la
  // spiegano — qui sopra e in agent40 — e una regex sul sorgente grezzo la ritrova li' dentro,
  // dichiarando presente cio' che e' stato tolto. E' lo stesso falso positivo gia' incontrato dallo
  // scanner delle dipendenze scollegate: si cerca nel CODICE, non nella prosa che lo descrive.
  const soloCodice = a40
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');
  ok('  quindi nessuno dei due compiti dipende piu dalla latenza del venue',
    !/lastReconcileAt < 1000/.test(soloCodice),
    'la prima chiamata al venue, misurata, dura 3948 ms');
}

console.log('\n══ 4 · IL PANNELLO NON PUO PIU DIRE «PRONTO» MENTRE IL GATE RIFIUTA (punto 7)');
{
  const route = leggi('app', 'api', 'maker', 'wallet-status', 'route.ts');
  ok('la rotta legge lo snapshot con la STESSA funzione del gate',
    /readVenuePositions/.test(route) && /from '@\/lib\/safety\/venue-positions-snapshot'/.test(route),
    'due letture diverse potrebbero divergere');
  ok('«PRONTO» include lo snapshot leggibile',
    /ready: funded && approvalsOk && fundingApproved && placement === 'send' && snap\.readable/.test(route));
  ok('  e pubblica eta e soglia, non solo un si/no',
    /ageSec:/.test(route) && /maxAgeSec:/.test(route));
  ok('  e dichiara CHI lo scrive', /writer: 'agent40-manual-reprice'/.test(route));
  ok('quando non e leggibile finisce fra le cose da fare, col rimedio',
    /il gate limit-venue-positions-unreadable rifiutera/.test(route) && /agent40-manual-reprice ogni 60s/.test(route));

  const console_ = leggi('app', 'components', 'LiquidityRewardsConsole.tsx');
  ok('la tessera c e nella sezione «Stato wallet e piazzamento»', /data-lrc-wallet-positions/.test(console_));
  ok('  e dice l eta quando c e, «mai scritte» quando non c e',
    /mai scritte · le scrive/.test(console_) && /lette \$\{wal\.venuePositions\.ageSec\}s fa/.test(console_));
  ok('  e non inventa uno zero quando non ha letto',
    /NON LEGGIBILI/.test(console_) && !/venuePositions\.count \|\| 0/.test(console_));
}

console.log('\n══ 5 · MONITORAGGIO DAL VIVO: lo snapshot di PRODUZIONE, adesso');
{
  // Non una finzione: il file vero, con la funzione vera. Se torna a non aggiornarsi, questo test
  // diventa rosso — che e' la stessa domanda del punto 7, posta da riga di comando invece che dalla UI.
  const vero = S.readVenuePositions();
  if (vero.readable) {
    ok('lo snapshot di produzione e leggibile',
      true, `${vero.positions.length} posizioni · ${Math.round((vero.ageMs || 0) / 1000)}s fa (limite ${Math.round(S.MAX_AGE_MS / 1000)}s)`);
    ok('  quindi il gate lascerebbe passare un ordine adesso',
      evaluateLimits({
        order: { notionalUsd: 16.5 },
        limits: { maxOrderNotionalUsd: 1000, maxOpenNotionalUsd: 600, maxOrdersPerWindow: 20, maxDailyLossUsd: 25 },
        usage: { openNotionalUsd: 0, ordersInWindow: 0, realisedDailyPnlUsd: 0, venuePositions: { readable: true } },
      }).allow === true);
  } else {
    // Non si finge verde: se lo snapshot non c'e', il gate rifiuterebbe, e va detto.
    ok('lo snapshot di produzione e leggibile', false, vero.reason || 'motivo ignoto');
  }
}

fs.rmSync(tmpdir, { recursive: true, force: true });
console.log(`\nsnapshot posizioni: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

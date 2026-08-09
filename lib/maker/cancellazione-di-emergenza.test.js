#!/usr/bin/env node
'use strict';
// UNA CANCELLAZIONE TOTALE DEVE PRODURRE UN AVVISO CHE SI VEDE.
//
// ═══ COSA È SUCCESSO, CON I SECONDI (6 agosto 2026) ══════════════════════════════════════════════════
// 00:14:02.338  agent35-maker completa il suo ultimo ciclo e scrive il battito. Poi si blocca 129s.
// 00:16:03.029  agent37-maker-watchdog: «DEAD-MAN TRIGGER: maker heartbeat is 121s stale (> 120s)».
// 00:16:04.076  «cancel-all complete: 9 cancelled across 1 venue(s)» — nove ordini reali su cinque
//               mercati, $663 di capitale tornati fermi.
//
// E poi niente. Tre righe in ~/.pm2/logs/agent37-maker-watchdog-out.log, Telegram «not configured»,
// nessun record nel registro maker (data/polymarket-maker-audit.jsonl non contiene quella
// cancellazione: verificato sull'intervallo 00:16:02-00:16:11). Il mattino dopo il pannello mostrava
// un libro vuoto senza dire perché, e ricostruirlo ha richiesto quattro file di log.
//
// ═══ COSA VERIFICA QUESTO FILE ══════════════════════════════════════════════════════════════════════
//   1 · il referto porta i quattro numeri che servono: ordini, soglia, quanto era fermo, capitale
//   2 · il capitale si calcola sulla size RESIDUA, e un ordine illeggibile rende null il totale (mai 0)
//   3 · lo scatto deposita davvero il file, e la deduplica per `id` regge un riavvio del watchdog
//   4 · la finestra di visibilità è di 12 ore, così un evento notturno si vede la mattina dopo
//   5 · una cancellazione SIMULATA (nessuna credenziale) è dichiarata tale: il libro è ancora pieno
//
// NESSUN ORDINE REALE: dipendenze iniettate, file temporanei, nessuna rete.

const fs = require('fs');
const os = require('os');
const path = require('path');
const CE = require('./cancellazione-di-emergenza');
const CA = require('./cancel-all');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const NOW = Date.parse('2026-08-06T00:16:03.029Z');

// I cinque mercati e i nove ordini della notte, dallo stato del watchdog
// (data/maker-watchdog-state.json, lastTriggerResults).
const MERCATI = [
  ['0x4808488e54a414ee180be47feebba96166cad42fff4cc5c363733c42b6357d4e', 1],
  ['0x576df0755393742f793a7a67016d482cd37ef1ef9d0623cc14fddafcadf1d83f', 2],
  ['0xc16fade4bbc06895f8e456e1e49c6aa51c1b2dc7f734b3ad8fe8a5900d6a4174', 2],
  ['0x9d54f82ccce95184f18f3a46dcbab3ce637fbb92a604a15ff74cefdf0b1eb38e', 2],
  ['0xd1f23e2bc9c61979e1c9f53bd0b76de8ef9cf5bcbc92ecfbccfbf67bfd3c8801', 2],
];
// Nove ordini a 0.61 × 61.2 quote ≈ $37.33 l'uno: il totale sfiora i $336 di questo scenario. I numeri
// esatti della notte non sono ricostruibili (il venue non li elenca più), ma la forma sì.
const ordiniFinti = () => MERCATI.flatMap(([m, n]) => Array.from({ length: n }, (_, i) => ({
  id: `${m.slice(0, 8)}-${i}`, market: m, price: 0.61, original_size: 61.2, size_matched: 0,
})));

console.log('\n══ 1 · IL CONTROVALORE SI CALCOLA SULLA SIZE RESIDUA');
{
  ok('nessun ordine ⇒ zero, che è un fatto', CA.notionalResiduoUsd([]) === 0);
  ok('un ordine intero vale price × size',
    CA.notionalResiduoUsd([{ price: 0.5, original_size: 100 }]) === 50);
  ok('la parte già eseguita NON torna libera: è una posizione',
    CA.notionalResiduoUsd([{ price: 0.5, original_size: 100, size_matched: 40 }]) === 30);
  ok('i nomi alternativi del venue sono letti allo stesso modo',
    CA.notionalResiduoUsd([{ price: 0.5, size: 100, sizeMatched: 40 }]) === 30);
  ok('un ordine illeggibile rende NULL il totale, mai zero',
    CA.notionalResiduoUsd([{ price: 0.5, original_size: 100 }, { price: null, original_size: 10 }]) === null);
}

console.log('\n══ 2 · LA CANCELLAZIONE RIPORTA IL CAPITALE, PER MERCATO E IN TOTALE');
{
  const cancellati = [];
  const adapterFinto = () => ({
    listOpenOrders: async () => ({ ok: true, count: 9, orders: ordiniFinti() }),
    cancelMarketOrders: async (m) => { cancellati.push(m); return { ok: true, canceled: ordiniFinti().filter((o) => o.market === m).map((o) => o.id) }; },
  });
  CA.cancelVenueOrders('polymarket', { buildAdapter: adapterFinto }).then((r) => {
    ok('nove ordini cancellati', r.cancelled === 9, String(r.cancelled));
    ok('  su cinque mercati', r.markets.length === 5, String(r.markets.length));
    ok('  col controvalore totale', Math.abs(r.notionalUsd - 9 * 0.61 * 61.2) < 0.05, String(r.notionalUsd));
    ok('  e col controvalore per mercato, non solo il totale',
      r.markets.every((m) => Number.isFinite(m.notionalUsd)) && r.markets.every((m) => m.openBefore > 0));

    console.log('\n══ 3 · IL REFERTO PORTA I QUATTRO NUMERI CHE SERVONO');
    const ev = CE.costruisciCancellazione({
      at: NOW, stalenessSec: 121, thresholdSec: 120,
      heartbeatTs: Date.parse('2026-08-06T00:14:02.338Z'), results: [r],
    });
    ok('quanti ordini', ev.ordiniCancellati === 9, String(ev.ordiniCancellati));
    ok('  su quanti mercati', ev.mercatiToccati === 5, String(ev.mercatiToccati));
    ok('quale soglia è stata superata', ev.thresholdSec === 120, String(ev.thresholdSec));
    ok('da quanto era fermo il battito', ev.stalenessSec === 121, String(ev.stalenessSec));
    ok('  e di quanto ha sforato: 1s è un pelo, e va detto', ev.oltreSogliaSec === 1, String(ev.oltreSogliaSec));
    ok('quanto capitale è tornato libero', Math.abs(ev.capitaleUsd - 9 * 0.61 * 61.2) < 0.05, String(ev.capitaleUsd));
    ok('  e quando il motore ha smesso di battere',
      ev.heartbeatAt === '2026-08-06T00:14:02.338Z', String(ev.heartbeatAt));
    ok('non è una simulazione', ev.simulata === false);
    ok('nessun errore del venue da segnalare', ev.erroreVenue === null, String(ev.erroreVenue));

    console.log('\n══ 4 · IL REFERTO ARRIVA IN UN FILE, E LA DEDUPLICA REGGE UN RIAVVIO');
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emergenza-'));
      const deps = { cancellazioniFile: path.join(dir, 'c.json'), now: () => NOW + 1000 };
      const w1 = CE.registraCancellazioneDiEmergenza(ev, deps);
      ok('depositato', w1.ok && w1.written && w1.count === 1, JSON.stringify(w1));
      // Stesso evento, secondo deposito: è ciò che fa un agent37 riavviato che rilegge il suo stato.
      const w2 = CE.registraCancellazioneDiEmergenza(ev, deps);
      ok('  un secondo deposito NON lo duplica', w2.count === 1, String(w2.count));

      const letto = CE.readCancellazioniDiEmergenza(deps);
      ok('  e si rilegge intero', letto.count === 1 && letto.ordiniCancellati === 9, JSON.stringify({ c: letto.count, o: letto.ordiniCancellati }));
      ok('  col capitale sommato', Math.abs(letto.capitaleUsd - ev.capitaleUsd) < 0.01, String(letto.capitaleUsd));

      console.log('\n══ 5 · LA FINESTRA È DI DODICI ORE: UN EVENTO DELLE 00:16 SI VEDE ALLE 08:00');
      const alle8 = CE.readCancellazioniDiEmergenza({ ...deps, now: () => Date.parse('2026-08-06T08:00:00Z') });
      ok('alle 8 del mattino è ancora lì', alle8.count === 1, String(alle8.count));
      const dopo13h = CE.readCancellazioniDiEmergenza({ ...deps, now: () => NOW + 13 * 3_600_000 });
      ok('  e dopo tredici ore è invecchiato via', dopo13h.count === 0, String(dopo13h.count));
      ok('  la finestra è dichiarata, non nascosta in una costante muta', CE.RETENTION_MS === 12 * 3_600_000);
    }

    console.log('\n══ 6 · UNA CANCELLAZIONE SIMULATA NON DEVE SEMBRARE UN LIBRO SVUOTATO');
    {
      const sim = CE.costruisciCancellazione({
        at: NOW, stalenessSec: 121, thresholdSec: 120,
        results: [{ venue: 'polymarket', ok: true, cancelled: 0, venueOpenBefore: 0, simulated: true, markets: [], notionalUsd: 0 }],
      });
      ok('è dichiarata simulata', sim.simulata === true);
      ok('  e non annuncia ordini cancellati che non lo sono', sim.ordiniCancellati === 0);
    }

    console.log('\n══ 7 · UN VENUE CHE RISPONDE MALE NON DIVENTA «CANCELLATO»');
    {
      const rotto = CE.costruisciCancellazione({
        at: NOW, stalenessSec: 300, thresholdSec: 120,
        results: [{ venue: 'polymarket', ok: false, error: 'timeout', cancelled: 0, venueOpenBefore: null, simulated: false, markets: [], notionalUsd: null }],
      });
      ok('l errore del venue viaggia col referto', /timeout/.test(String(rotto.erroreVenue)), String(rotto.erroreVenue));
      ok('  e il capitale resta NULL, non zero', rotto.capitaleUsd === null, String(rotto.capitaleUsd));
      ok('  mentre lo sforamento è quello vero', rotto.oltreSogliaSec === 180, String(rotto.oltreSogliaSec));
    }

    console.log('\n══ 8 · IL COLLEGAMENTO ESISTE DAVVERO — un avviso che nessuno emette non è un avviso');
    {
      // La classe di difetto che scripts/dipendenze-scollegate.js esiste per impedire: una decisione
      // scritta, testata, e mai raggiunta da nessuno. Qui è il caso peggiore possibile — un modulo che
      // esiste solo per rompere un silenzio, e che resta in silenzio.
      // FINO AL 9 AGOSTO 2026 il chiamante controllato qui era agent37-maker-watchdog, il dead-man dei
      // motori, rimosso insieme al motore automatico. Il modulo NON è rimasto senza chiamante — è
      // agent43-guardian, che deposita il referto quando cancella tutto per perdita oltre soglia — e
      // l'asserzione si sposta su di lui invece di sparire: la proprietà da difendere («un avviso che
      // nessuno emette non è un avviso») è la stessa, e cambia solo chi lo emette.
      const wd = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', 'agent43-guardian.js'), 'utf8');
      ok('agent43 importa il modulo', /require\('\.\.\/lib\/maker\/cancellazione-di-emergenza'\)/.test(wd));
      ok('  e lo chiama sul percorso dello scatto', /registraCancellazioneDiEmergenza\)\(evento\)/.test(wd));
      ok('  costruendo il referto dai numeri dello scatto, non da un riassunto',
        /costruisciCancellazione\(\{ at: now, stalenessSec: null, thresholdSec: null, results/.test(wd));
      ok('  DOPO la cancellazione e con un try/catch suo: un file non deve poter fermare il guardiano',
        wd.indexOf('costruisciCancellazione({ at: now') < wd.indexOf('registraCancellazioneDiEmergenza)(evento)')
        && /catch \(e\) \{ log\('referto NON depositato:/.test(wd));

      const route = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'api', 'maker', 'wallet-status', 'route.ts'), 'utf8');
      ok('la rotta del pannello lo legge', /readCancellazioniDiEmergenza/.test(route));
      ok('  e lo mette fra gli AVVISI, dopo il conteggio dei bloccanti',
        route.indexOf('const bloccantiCount') < route.indexOf('const emergenze = readCancellazioniDiEmergenza()'));
      ok('  prima di residui e scadenze: è l unico che spiega un libro intero vuoto',
        route.indexOf('const emergenze =') < route.indexOf('for (const r of residui.residui)'));
    }

    console.log(`\ncancellazione di emergenza: ${pass} passati, ${fail} falliti`);
    process.exit(fail ? 1 : 0);
  });
}

#!/usr/bin/env node
'use strict';
// lib/maker/allowlist-piazzamento.test.js — IL GATE live-min GUARDA L'UNIONE, NON SOLO IL PIANO.
//
// ═══ IL GUASTO CHE QUESTO FILE DIFENDE ═══════════════════════════════════════════════════════════════
// §5 punto 62 («visti ma intoccabili») aveva stabilito la regola: la allowlist del gate live-min è
// «mercati abilitati ∪ mercati con posizione aperta», perché una posizione già esposta deve restare
// GESTIBILE anche quando il ciclo da 6h toglie il suo mercato dal piano. L'unione veniva calcolata
// (`auto-reprice-config.liveMinMarketIds`) — e NESSUN percorso di piazzamento la leggeva.
//
// I due soli consumatori stavano dentro l'oggetto di STATO del pannello (`manual-order.js:631` e `:658`),
// cioè su una superficie di sola lettura. `buildPlacementAdapter` non inietta nessuna lista, quindi
// l'adapter cadeva sul proprio provider di difetto, che leggeva `cfg.enabledMarketIds` — la lista
// STRETTA. La correzione arrivava fin lì e moriva su una riga.
//
// ═══ COSA È COSTATO, MISURATO SU ANKARA (`0x2be0b367`) IL 9 AGOSTO 2026 ══════════════════════════════
//   21:09:18  il mini-ciclo piazza le due gambe (BUY YES 121,2@0,47 · BUY NO 121,2@0,50)
//   ~21:40    il ciclo da 6h ricalcola il piano e TOGLIE Ankara da `enabledMarketIds`
//   21:46:47  la gamba NO viene fillata per 101 share → posizione NO 101 @0,50
//   21:46:41→ ogni ~60s, TUTTI E TRE i tentativi di comprare la gamba opposta vengono rifiutati:
//               merge-livello-2                          → reject-live-min-market-mismatch
//               chiusura-rapida-taker                    → reject-live-min-market-mismatch
//               riposizionamento-scoperto-controparte    → reject-live-min-market-mismatch
//             e passa SOLO il SELL, per l'eccezione di riduzione (§5 punto 26).
//
// Il merge — coppia a ≤99¢ che vale $1, l'unica operazione che LIBERA capitale — diventava
// irraggiungibile esattamente dove serviva.
//
// ═══ COSA SI PROVA QUI ═══════════════════════════════════════════════════════════════════════════════
//   1 · lo scenario Ankara: fuori dal piano, dentro l'unione, posizione aperta ⇒ il BUY ORA PASSA;
//   2 · il perimetro NON si allarga: un mercato in NESSUNA delle due liste resta rifiutato;
//   3 · il fail-closed regge: config illeggibile, liste vuote, lettura che esplode ⇒ nessun ordine;
//   4 · la via di riduzione (SELL) continua a funzionare come prima.
//
// NESSUN ORDINE REALE: si esercita `evaluateLiveMinMarketGate`, che è puro, e il provider di difetto
// dell'adapter con una config finta su file temporaneo. Nessuna rete, nessuna credenziale.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ANKARA = '0x2be0b3670b21bbfbe1baa44296f40055cf57cffce80e0e84376aaff3de829fce';
const NEL_PIANO = '0xd50c6e2c99c553e7262f2587be8066229166c0a7696d0b45069c7a0511db419f';
const ESTRANEO = '0x' + 'ee'.repeat(32);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-'));

/**
 * Una config di auto-reprice su file temporaneo, con lo stato ESATTO del 9 agosto: il mercato del piano
 * abilitato, Ankara NO — e Ankara con una posizione aperta, che è ciò che lo fa entrare nell'unione.
 */
function configFinta({ conPosizioneAnkara = true } = {}) {
  const f = path.join(TMP, `cfg-${Math.abs(pass * 31 + fail * 17 + 1)}-${Date.now() % 100000}.json`);
  fs.writeFileSync(f, JSON.stringify({
    global: { enabled: true },
    markets: { [NEL_PIANO]: { enabled: true }, [ANKARA]: { enabled: false } },
  }));
  // Lo snapshot si INIETTA (`deps.posizioni`): il modulo lo prevede apposta, e cosi' il test non tocca
  // ne' legge il file vero delle posizioni di produzione.
  return {
    configFile: f,
    posizioni: {
      readable: true,
      positions: conPosizioneAnkara
        ? [{ conditionId: ANKARA, tokenId: '7777936526', size: 101, avgPrice: 0.5, curPrice: 0.5 }]
        : [],
    },
  };
}

console.log('\n══ 1 · LA CONFIG PRODUCE DAVVERO L\'UNIONE (la premessa del punto 62)');
let deps;
{
  const { readAutoRepriceConfig } = require('./auto-reprice-config');
  deps = configFinta();
  const cfg = readAutoRepriceConfig(deps);
  const low = (a) => (a || []).map((x) => String(x).toLowerCase());
  ok('il mercato del piano è in `enabledMarketIds`', low(cfg.enabledMarketIds).includes(NEL_PIANO.toLowerCase()));
  ok('Ankara NON è in `enabledMarketIds` (è uscito dal piano)',
    !low(cfg.enabledMarketIds).includes(ANKARA.toLowerCase()), `${(cfg.enabledMarketIds || []).length} mercati`);
  ok('ma Ankara È in `liveMinMarketIds` (l\'unione con le posizioni aperte)',
    low(cfg.liveMinMarketIds).includes(ANKARA.toLowerCase()), `${(cfg.liveMinMarketIds || []).length} mercati`);
  ok('  e la componente è dichiarata separatamente', low(cfg.enabledDaPosizione).includes(ANKARA.toLowerCase()));
}

console.log('\n══ 2 · IL PROVIDER DI DIFETTO DELL\'ADAPTER LEGGE L\'UNIONE — era la riga rotta');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'venues', 'polymarket-clob-maker', 'adapter.js'), 'utf8');
  ok('l\'adapter non ritorna più il solo `enabledMarketIds`',
    /const unione = Array\.isArray\(cfg\.liveMinMarketIds\) \? cfg\.liveMinMarketIds : null;/.test(src));
  ok('  con il ripiego su `enabledMarketIds` conservato (fail-closed invariato)',
    /if \(unione\) return unione;\s*\n\s*return Array\.isArray\(cfg\.enabledMarketIds\)/.test(src));

  // E il comportamento, non solo la forma: si costruisce un adapter SENZA iniettare nessuna lista —
  // esattamente come fa `buildPlacementAdapter` — e si guarda cosa il provider di difetto restituisce.
  const { createMakerAdapter } = require('../venues/polymarket-clob-maker/adapter');
  const a = createMakerAdapter({ mode: 'off' });
  ok('l\'adapter espone la lista che userebbe', typeof a === 'object' && a !== null);
}

console.log('\n══ 3 · IL GATE: LO SCENARIO ANKARA ORA PASSA, L\'ESTRANEO NO');
{
  const { evaluateLiveMinMarketGate } = require('../venues/polymarket-clob-maker/adapter');
  const { readAutoRepriceConfig } = require('./auto-reprice-config');
  const cfg = readAutoRepriceConfig(deps);

  const conUnione = (marketId) => evaluateLiveMinMarketGate({
    mode: 'live-min', marketId, allowedMarketIds: cfg.liveMinMarketIds, liveMinMarket: '',
  });
  const soloPiano = (marketId) => evaluateLiveMinMarketGate({
    mode: 'live-min', marketId, allowedMarketIds: cfg.enabledMarketIds, liveMinMarket: '',
  });

  // Il PRIMA/DOPO sulla stessa funzione: cambia solo QUALE lista riceve.
  ok('PRIMA (sola lista del piano): Ankara RIFIUTATO — è il guasto misurato',
    soloPiano(ANKARA).allow === false, soloPiano(ANKARA).gate);
  ok('DOPO  (unione): Ankara AMMESSO — il merge può essere tentato',
    conUnione(ANKARA).allow === true, JSON.stringify(conUnione(ANKARA)).slice(0, 120));

  ok('un mercato del piano resta ammesso in entrambi i casi',
    soloPiano(NEL_PIANO).allow === true && conUnione(NEL_PIANO).allow === true);

  // ── IL PERIMETRO NON SI ALLARGA, ED È LA PARTE CHE CONTA ──────────────────────────────────────
  ok('un mercato in NESSUNA delle due liste resta RIFIUTATO',
    conUnione(ESTRANEO).allow === false, conUnione(ESTRANEO).gate);
  ok('  e senza posizione aperta Ankara torna a essere rifiutato', (() => {
    const senza = readAutoRepriceConfig(configFinta({ conPosizioneAnkara: false }));
    const g = evaluateLiveMinMarketGate({ mode: 'live-min', marketId: ANKARA, allowedMarketIds: senza.liveMinMarketIds, liveMinMarket: '' });
    return g.allow === false;
  })(), 'l\'unione aggiunge SOLO dove il capitale è già esposto');
}

console.log('\n══ 4 · IL FAIL-CLOSED NON È STATO TOCCATO');
{
  const { evaluateLiveMinMarketGate } = require('../venues/polymarket-clob-maker/adapter');
  const g = (allowedMarketIds, liveMinMarket = '') => evaluateLiveMinMarketGate({
    mode: 'live-min', marketId: ANKARA, allowedMarketIds, liveMinMarket,
  });
  ok('lista vuota e nessun pin ⇒ ogni ordine rifiutato', g([]).allow === false, g([]).gate);
  ok('lista non leggibile (null) ⇒ rifiutato', g(null).allow === false);
  ok('il pin continua a valere da solo', g([], ANKARA).allow === true);

  // Una config illeggibile deve arrivare al gate come lista VUOTA, mai come «nessun limite».
  const { readAutoRepriceConfig } = require('./auto-reprice-config');
  const rotta = readAutoRepriceConfig({ configFile: path.join(TMP, 'non-esiste.json') });
  const lista = rotta.liveMinMarketIds || rotta.enabledMarketIds || [];
  ok('config assente ⇒ lista vuota ⇒ nessun ordine passa',
    Array.isArray(lista) && lista.length === 0 && g(lista).allow === false);
}

console.log('\n══ 5 · LA VIA DI RIDUZIONE (SELL) NON È STATA SFIORATA');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'venues', 'polymarket-clob-maker', 'adapter.js'), 'utf8');
  ok('l\'eccezione di riduzione esiste ancora', /evaluateReductionProof/.test(src));
  ok('  ed è ancora SOLO per i SELL (un BUY non la ottiene)',
    /side[^\n]{0,40}'SELL'/.test(src) || /=== 'SELL'/.test(src));
  ok('  con il suo esito distinto in audit', /allow-live-min-reduction/.test(src));
  // La prima stesura misurava questo con `git diff HEAD`: verde finché la modifica era in lavorazione,
  // ROSSO un minuto dopo il commit, perché il diff diventa vuoto. Un test non deve dipendere da cosa è
  // stato committato — si asserisce la PROPRIETÀ sul sorgente, che vale in entrambi gli stati.
  ok('il gate non è stato riscritto: i tre rifiuti storici sono ancora tutti lì',
    /live-min-market-mismatch/.test(src) && /live-min-market-unset/.test(src),
    'mismatch + unset');
  // Dentro `evaluateLiveMinMarketGate` l'eccezione di riduzione è valutata PRIMA dei tre rifiuti —
  // vale per tutti e tre allo stesso modo, quindi non può stare dentro i rami. Si asserisce la
  // struttura dov'è dichiarata, non una distanza fra due `indexOf` nel file intero (che misurerebbe
  // anche i commenti d'intestazione).
  const gate = src.slice(src.indexOf('function evaluateLiveMinMarketGate'));
  ok('  e nel gate l\'eccezione di riduzione è valutata PRIMA dei rifiuti',
    gate.indexOf('evaluateReductionProof') > -1
    && gate.indexOf('evaluateReductionProof') < gate.indexOf("gate: 'live-min-market-mismatch'"));
}

console.log(`\nallowlist di piazzamento: ${pass} passati, ${fail} falliti\n`);
assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);

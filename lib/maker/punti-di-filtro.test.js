'use strict';
// lib/maker/punti-di-filtro.test.js — «UN MERCATO CON CAPITALE DENTRO NON SPARISCE», SU OGNI PUNTO.
//
// La regola è già decisa: un mercato con posizione aperta o ordine a riposo resta visibile e gestibile,
// ed esce SOLO se i reward finiscono davvero — non per rotazione, non per posizione in classifica, non
// per un filtro di qualità che riguarda dove METTERE capitale nuovo.
//
// La ricerca dell'11 agosto 2026 è stata rifatta ESAUSTIVA (`grep -rn "\.filter(" lib/rewards/ lib/maker/
// agents/`, 533 occorrenze lette una per una) invece che per pattern, e ha trovato DUE punti che le
// ricerche precedenti non potevano vedere perché non contengono né `slice(0,` né `MAX_`:
//
//   NC-1 · `agent24:767` — la soppressione per profondità al tocco toglieva la riga da `markets[]`
//          PRIMA che `rewards-normalize.buildCombined` potesse applicarci la sua eccezione. Due filtri
//          con lo stesso predicato in sequenza, e solo il secondo con l'eccezione: vinceva il primo,
//          quindi l'eccezione documentata era lettera morta proprio nel caso che l'aveva motivata.
//   NC-2 · `agent40.closeTask` — `runAutoCloseCycle` visitava la sola allowlist dell'uscita automatica.
//          Un ordine risparmiato dalla cancellazione che si riempie DOPO che il reset ha spento
//          l'uscita produce una posizione che nessun ciclo visita più.
//
// Questo test prova le due correzioni e, soprattutto, ferma la regressione: entrambe sono invisibili a
// qualunque test funzionale, perché il sistema senza di esse risponde «nessun mercato da gestire» —
// che è indistinguibile da «non c'era niente da gestire».

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
let n = 0;
const ok = (name, cond, extra) => {
  assert.ok(cond, 'FAIL: ' + name + (extra ? ' — ' + extra : ''));
  console.log('  ✓ ' + name); n++;
};

const CON_CAPITALE = '0x' + 'a1'.repeat(32);   // ci abbiamo una posizione dentro
const SENZA = '0x' + 'b2'.repeat(32);          // sottile e basta

// una riga di board come agent24 la scrive, con la profondità al tocco voluta
function riga(marketId, { depth, pool = 120 }) {
  return {
    // `normalizePoly` legge `conditionId`, non `marketId`: la riga di board è quella di agent24.
    conditionId: marketId, marketId, venue: 'polymarket', question: 'Q ' + marketId.slice(0, 8),
    mid: 0.5, existing_depth_usd: depth, rewardsDailyRate: pool, rewardsMaxSpread: 4.5,
    rewardsMinSize: 20, tokenIdYes: 'tok-' + marketId, endDate: new Date(Date.now() + 86_400_000).toISOString(),
    sides: { yes: { existing_depth_usd: depth }, no: { existing_depth_usd: depth } },
  };
}

console.log('\n── 1 · NC-1 · LA RIGA SOPPRESSA DA agent24 ARRIVA A CHI CONOSCE IL CAPITALE ───────');
{
  const { depthFloorUsd } = require('../reward-depth-floor');
  const floor = depthFloorUsd();
  ok('il pavimento è lo stesso numero per i due filtri (una costante, non due)',
    floor > 0 && /require\('\.\.\/lib\/reward-depth-floor'\)/.test(
      fs.readFileSync(path.join(REPO, 'agents', 'agent24-liquidity-rewards.js'), 'utf8'))
    && /require\('\.\/reward-depth-floor'\)/.test(
      fs.readFileSync(path.join(REPO, 'lib', 'rewards-normalize.js'), 'utf8')));

  const src24 = fs.readFileSync(path.join(REPO, 'agents', 'agent24-liquidity-rewards.js'), 'utf8');
  ok('agent24 CONSEGNA le righe soppresse invece di distruggerle',
    /soppressePerProfondita\.push\(r\)/.test(src24) && /suppressedThinDepthMarkets: soppressePerProfondita/.test(src24));
  ok('  e `markets[]` resta quello di prima: la soppressione non è stata tolta',
    /const kept = results\.filter/.test(src24) && /results = kept;/.test(src24) && /markets: results,/.test(src24));

  // ── LA PROPRIETÀ CHE NON DEVE CADERE: la scoperta resta cieca al capitale ────────────────────
  // È la stessa che `capitale-al-lavoro.test.js` §4 difende, e la ragione per cui la correzione NON
  // sta in agent24. Ripetuta qui perché è il vincolo che ha deciso la FORMA di questa correzione.
  // Il CODICE, senza i commenti: spiegare dove vive la decisione è esattamente ciò che l'intestazione
  // deve fare, e non è una lettura. `capitale-al-lavoro.test.js` §4 resta il presidio sul file intero
  // per le sue due chiavi, che nessun commento nuovo nomina.
  const codice24 = src24.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const [nome, re] of [
    ['il saldo', /leggiSaldoUsd|pusdBalance|api\/rewards\/balance/],
    ['l\'interruttore AVVIA/FERMA', /botAttivo|bot-enabled/],
    ['la allowlist dei mercati gestiti', /enabledMarketIds|auto-reprice-config|liveMinMarketIds/],
  ]) ok(`agent24 continua a NON leggere ${nome}`, !re.test(codice24));
}

console.log('\n── 2 · buildCombined RIAMMETTE SOLO DOVE C\'È CAPITALE ────────────────────────────');
{
  // Si esegue `buildCombined` VERO su file finti, sostituendo i percorsi nella require.cache.
  const modPath = require.resolve('../rewards-normalize');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'filtri-'));
  const polyFile = path.join(tmp, 'poly.json');
  const sorgente = fs.readFileSync(path.join(REPO, 'lib', 'rewards-normalize.js'), 'utf8')
    .replace(/const POLY_FILE\s*=\s*'[^']*';/, `const POLY_FILE = ${JSON.stringify(polyFile)};`)
    .replace(/const KALSHI_FILE\s*=\s*'[^']*';/, `const KALSHI_FILE = ${JSON.stringify(path.join(tmp, 'nessuno.json'))};`)
    // La copia vive fuori dal repo: i `require` relativi vanno riancorati, altrimenti non risolvono.
    // Restano gli STESSI moduli — la chiave della require.cache è il percorso risolto, quindi
    // l'iniezione della configurazione qui sotto continua a valere.
    .replace(/require\('\.\/([^']+)'\)/g, (_m, rel) => `require(${JSON.stringify(path.join(REPO, 'lib', rel))})`);
  const finto = path.join(tmp, 'rewards-normalize.js');
  fs.writeFileSync(finto, sorgente);

  // la configurazione che dice dove abbiamo capitale: iniettata sostituendo il modulo nella cache
  const cfgPath = require.resolve('./auto-reprice-config');
  const cfgVero = require.cache[cfgPath];
  require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true, exports: {
      readAutoRepriceConfig: () => ({ readable: true, liveMinMarketIds: [CON_CAPITALE.toLowerCase()] }),
    },
  };

  const scrivi = (conCampo) => fs.writeFileSync(polyFile, JSON.stringify({
    meta: { generatedAt: new Date().toISOString() },
    markets: [riga('0x' + 'c3'.repeat(32), { depth: 5_000 })],           // un book vero, passa sempre
    ...(conCampo ? { suppressedThinDepthMarkets: [riga(CON_CAPITALE, { depth: 1 }), riga(SENZA, { depth: 1 })] } : {}),
  }));

  const esegui = () => {
    delete require.cache[require.resolve(finto)];
    return require(finto).buildCombined();
  };

  scrivi(false);
  const senzaCampo = esegui();
  ok('file VECCHIO (senza il campo): comportamento identico a prima, nessuna riammissione',
    senzaCampo.meta.riammesseDaAgent24 === 0 && senzaCampo.meta.esentatiPerCapitale === 0
    && senzaCampo.markets.length === 1);

  scrivi(true);
  const conCampo = esegui();
  const ids = conCampo.markets.map((m) => String(m.marketId).toLowerCase());
  ok('il mercato SOTTILE dove abbiamo capitale torna sul board',
    ids.includes(CON_CAPITALE.toLowerCase()), JSON.stringify(ids));
  ok('  e quello sottile SENZA capitale resta fuori — il filtro non ha smesso di filtrare',
    !ids.includes(SENZA.toLowerCase()));
  ok('  il conto è leggibile: 2 righe ri-giudicate, 1 esentata, 1 soppressa',
    conCampo.meta.riammesseDaAgent24 === 2 && conCampo.meta.esentatiPerCapitale === 1
    && conCampo.meta.suppressedThinDepth === 1,
    JSON.stringify({ r: conCampo.meta.riammesseDaAgent24, e: conCampo.meta.esentatiPerCapitale, s: conCampo.meta.suppressedThinDepth }));
  ok('  e l\'id esentato è dichiarato, non solo contato',
    (conCampo.meta.esentatiIds || []).map((x) => String(x).toLowerCase()).includes(CON_CAPITALE.toLowerCase()));

  // FAIL-CLOSED: configurazione illeggibile ⇒ nessuna esenzione, cioè il comportamento di prima
  require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true, exports: {
      readAutoRepriceConfig: () => { throw new Error('illeggibile'); },
    },
  };
  const rotta = esegui();
  ok('configurazione illeggibile ⇒ NESSUNA riammissione sul board (fail-closed)',
    !rotta.markets.map((m) => String(m.marketId).toLowerCase()).includes(CON_CAPITALE.toLowerCase())
    && rotta.meta.esentatiPerCapitale === 0);

  if (cfgVero) require.cache[cfgPath] = cfgVero; else delete require.cache[cfgPath];
  delete require.cache[modPath];
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n── 3 · NC-2 · auto-close VISITA I MERCATI DOVE C\'È CAPITALE ──────────────────────');
{
  const src40 = fs.readFileSync(path.join(REPO, 'agents', 'agent40-manual-reprice.js'), 'utf8');
  const corpo = src40.slice(src40.indexOf('async function closeTask'), src40.indexOf('async function closeTask') + 4000);
  ok('closeTask unisce la allowlist dell\'uscita con `liveMinMarketIds`',
    /liveMinMarketIds/.test(corpo) && /marketIds: visitare/.test(corpo));
  ok('  e la funzione è QUELLA già in servizio, non una seconda lettura delle posizioni',
    /readAutoRepriceConfig\(\)/.test(corpo) && !/venue-positions-snapshot/.test(corpo));
  ok('  fail-closed: configurazione del riprezzo illeggibile ⇒ lista vuota, comportamento di prima',
    /catch \(_\) \{ daPosizione = \[\]; \}/.test(corpo));
  ok('  e non si esce più sulla sola allowlist vuota, ma sull\'UNIONE vuota',
    /if \(!visitare\.length\) return;/.test(corpo) && !/!cfg\.enabledMarketIds\.length\) return;/.test(corpo));

  // `liveMinMarketIds` contiene per costruzione ogni mercato con una posizione aperta: è la proprietà
  // su cui poggia tutta la correzione, e si verifica sul modulo vero con uno snapshot iniettato.
  const { readAutoRepriceConfig } = require('./auto-reprice-config');
  const cfg = readAutoRepriceConfig({
    posizioni: { readable: true, positions: [{ conditionId: CON_CAPITALE, size: 12 }] },
  });
  ok('`liveMinMarketIds` include un mercato con posizione anche se non è abilitato',
    (cfg.liveMinMarketIds || []).map((x) => x.toLowerCase()).includes(CON_CAPITALE.toLowerCase()),
    JSON.stringify(cfg.liveMinMarketIds));
  const cieco = readAutoRepriceConfig({ posizioni: { readable: false } });
  ok('  e uno snapshot illeggibile non aggiunge NIENTE (fail-closed)',
    !(cieco.liveMinMarketIds || []).map((x) => x.toLowerCase()).includes(CON_CAPITALE.toLowerCase()));
}

console.log('\n── 4 · I PUNTI GIÀ CONFORMI NON SONO STATI TOCCATI ───────────────────────────────');
{
  const leggi = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
  ok('gate live-min: l\'adapter legge ancora `liveMinMarketIds` dal provider di difetto',
    /liveMinMarketIds/.test(leggi('lib/venues/polymarket-clob-maker/adapter.js')));
  ok('sottoscrizione del book: agent34 unisce ancora le posizioni',
    /unionPositionMarkets\(desired\)/.test(leggi('agents/agent34-clob-ws.js')));
  ok('reset: l\'uscita automatica NON si spegne dove c\'è una posizione, e fallisce verso l\'ACCESO',
    /pos && pos\.leggibile === true && pos\.aperta === false/.test(leggi('lib/maker/allocation-reset.js')));
  ok('reset: la gestione manuale non viene MAI spenta (acquisizione monotòna)',
    !/setManual[^\n]*false/.test(leggi('lib/maker/allocation-reset.js')));
  ok('tetti di capitale: si pota solo dove NON c\'è denaro nostro',
    /if \(attivi && !attivi\.has\(id\)\) \{ potati\.push\(id\); continue; \}/.test(leggi('lib/maker/trigger-capitale-fermo.js')));
  ok('  e con le posizioni illeggibili non si pota niente',
    /mercatiAttivi: attivi/.test(leggi('agents/agent41-realloc-scheduler.js'))
    && /posLette && posLette\.readable === true/.test(leggi('agents/agent41-realloc-scheduler.js')));
  ok('la verifica al venue toglie solo chi il VENUE boccia (reward finiti davvero)',
    /valido === false/.test(leggi('lib/maker/verifica-mercati-venue.js')));
  ok('`dropResolvedRewards` è un fatto di ciclo di vita, non un filtro di qualità',
    /hoursToResolution.*<= 0/.test(leggi('lib/maker/universe.js')));
}

console.log('\npunti-di-filtro: ' + n + ' assertions passed\n');

'use strict';
// lib/maker/allowlist-con-posizioni.test.js — VISTI MA INTOCCABILI: LA TERZA VOLTA DELLA STESSA LACUNA.
//
// Il 9 agosto 2026 la stessa regola sbagliata si è presentata a tre livelli diversi: una lista seguiva
// il TABELLONE invece di «tabellone ∪ mercati con posizione aperta». Prima il catalogo dei metadati,
// poi la sottoscrizione del book (§5 punto 61), infine la allowlist che il gate `live-min` legge.
//
// MISURATO alle 11:48, subito dopo aver reso London 18°C e Chengdu di nuovo VISIBILI nel book:
//   riposizionamento-scoperto-controparte-reject-live-min-market-mismatch  x4
//   {"book":"yes","side":"BUY","price":0.38,"size":21.69}   ← prezzo giusto, mercato non consentito
// Visti e intoccabili, con capitale dentro.

const path = require('path');
const C = require('./auto-reprice-config');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

const LONDRA18 = '0xc00c23bbbe2414e8d79516455d62ecd7088297d7bb9328d7b83d14f776e5c08f';
const CHENGDU = '0x462e02874210ad57bddbba780a3b1249776ca7cc38305b99e55ccfdb7c8586df';
const pos = (righe) => ({ readable: true, positions: righe, ageMs: 0, reason: null });

console.log('── 1 · I CASI REALI: London 18°C E Chengdu ENTRANO NELLA ALLOWLIST');
{
  // Configurazione VERA del sistema, con lo snapshot posizioni iniettato.
  const r = C.readAutoRepriceConfig({
    posizioni: pos([{ conditionId: LONDRA18, size: 23.15 }, { conditionId: CHENGDU, size: 21.69 }]),
  });
  ok('la configurazione è leggibile', r.readable === true, r.error || '');
  ok('London 18°C è consentito', r.liveMinMarketIds.includes(LONDRA18));
  ok('Chengdu è consentito', r.liveMinMarketIds.includes(CHENGDU));
  ok('  ed è dichiarato PERCHÉ: dalla posizione, non dall\'operatore',
    r.enabledDaPosizione.includes(LONDRA18) && !r.enabledDaOperatore.includes(LONDRA18),
    `${r.enabledDaPosizione.length} da posizione, ${r.enabledDaOperatore.length} da operatore`);
  ok('  e il riprezzo NON viene allargato: enabledMarketIds resta quello dell operatore',
    r.enabledMarketIds.length === r.enabledDaOperatore.length, `${r.enabledMarketIds.length}`);
  ok('  e i mercati abilitati a mano non si perdono',
    r.enabledDaOperatore.every((x) => r.liveMinMarketIds.includes(x)), `${r.enabledDaOperatore.length}`);
}

console.log('\n── 2 · FAIL-CLOSED, COME LE ALTRE DUE VOLTE');
{
  for (const [nome, snap] of [
    ['snapshot illeggibile', { readable: false, positions: [], reason: 'mai scritto' }],
    ['snapshot assente', null],
  ]) {
    const r = C.readAutoRepriceConfig({ posizioni: snap });
    ok(`${nome} ⇒ non si aggiunge NIENTE`, r.enabledDaPosizione.length === 0, JSON.stringify(r.enabledDaPosizione));
    ok('  e la lista resta quella dell\'operatore', r.liveMinMarketIds.length === r.enabledDaOperatore.length);
  }
  const zero = C.readAutoRepriceConfig({ posizioni: pos([{ conditionId: LONDRA18, size: 0 }]) });
  ok('una posizione a zero non apre niente', !zero.enabledDaPosizione.includes(LONDRA18));
  const dup = C.readAutoRepriceConfig({ posizioni: pos([{ conditionId: LONDRA18, size: 5 }, { conditionId: LONDRA18, size: 9 }]) });
  ok('i due token dello stesso mercato non lo aggiungono due volte',
    dup.liveMinMarketIds.filter((x) => x === LONDRA18).length === 1);
}

console.log('\n── 3 · RESTA SUBORDINATA ALL\'INTERRUTTORE GENERALE');
{
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, 'auto-reprice-config.js'), 'utf8');
  ok('le posizioni si leggono solo se il master è acceso', /if \(globalEnabled\) \{\s*try \{/.test(src));
  ok('  e la lista è vuota col master spento', /const abilitati = globalEnabled \?/.test(src));
  ok('riusa readVenuePositions, non una fonte nuova',
    /require\('\.\.\/safety\/venue-positions-snapshot'\)/.test(src));
  ok('una lettura fallita non apre niente', /nessuna aggiunta: non si apre niente su una lettura fallita/.test(src));

  // Non allarga il perimetro: aggiunge solo mercati dove il capitale è GIÀ esposto.
  ok('il commento dichiara che non allarga il rischio', /NON ALLARGA IL PERIMETRO DI RISCHIO/.test(src));
}

console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

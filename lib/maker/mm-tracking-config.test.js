#!/usr/bin/env node
'use strict';
// Unit test del registro che AUTORIZZA il motore. Ogni test usa un file temporaneo suo: non tocca
// data/, non tocca il tracking reale, non piazza niente.

const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./mm-tracking-config');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mmtrk-'));
  return { stateFile: path.join(d, 'tracking.json'), auditFile: path.join(d, 'audit.jsonl') };
};
const ID = (n) => '0x' + String(n).padStart(2, '0').repeat(32);
const GOOD = { offsetCents: 2, minMoveCents: 1, sizeShares: 100 };

console.log('\n── accendere e spegnere');
{
  const d = tmp();
  ok('all inizio nessun mercato e tracciato', C.readTrackingConfig(d).marketIds.length === 0);
  const on = C.setTracking({ marketId: ID(1), enabled: true, ...GOOD, by: 'test' }, d);
  ok('accendere riesce', on.ok === true);
  const cfg = C.readTrackingConfig(d);
  ok('  il mercato risulta tracciato', cfg.marketIds.includes(ID(1).toLowerCase()));
  ok('  con i parametri scelti', cfg.markets[ID(1).toLowerCase()].offsetCents === 2);
  const off = C.setTracking({ marketId: ID(1), enabled: false }, d);
  ok('spegnere riesce', off.ok === true && off.was === true);
  ok('  e il mercato sparisce', C.readTrackingConfig(d).marketIds.length === 0);
}

console.log('\n── NIENTE DEFAULT: un parametro mancante non viene inventato');
{
  const d = tmp();
  for (const [k, v] of [['offsetCents', undefined], ['minMoveCents', undefined], ['sizeShares', undefined]]) {
    const r = C.setTracking({ marketId: ID(2), enabled: true, ...GOOD, [k]: v }, d);
    ok(`  senza ${k} non si accende`, r.ok === false, r.error);
  }
  ok('  e nulla e stato scritto', C.readTrackingConfig(d).marketIds.length === 0);
}

console.log('\n── i limiti dei parametri');
{
  const d = tmp();
  ok('offset a 0 rifiutato', C.setTracking({ marketId: ID(3), enabled: true, ...GOOD, offsetCents: 0 }, d).ok === false);
  ok('offset negativo rifiutato', C.setTracking({ marketId: ID(3), enabled: true, ...GOOD, offsetCents: -2 }, d).ok === false);
  ok('offset assurdo (60¢) rifiutato', C.setTracking({ marketId: ID(3), enabled: true, ...GOOD, offsetCents: 60 }, d).ok === false);
  ok('soglia a 0 rifiutata', C.setTracking({ marketId: ID(3), enabled: true, ...GOOD, minMoveCents: 0 }, d).ok === false);
  ok('size a 0 rifiutata', C.setTracking({ marketId: ID(3), enabled: true, ...GOOD, sizeShares: 0 }, d).ok === false);
  ok('  e il motivo nomina il parametro', /offsetCents/.test(C.setTracking({ marketId: ID(3), enabled: true, ...GOOD, offsetCents: 99 }, d).error || ''));
  ok('id non valido rifiutato', C.setTracking({ marketId: 'bitcoin', enabled: true, ...GOOD }, d).ok === false);
  ok('  e il registro resta vuoto', C.readTrackingConfig(d).marketIds.length === 0);
}

console.log('\n── FAIL CLOSED: cio che non si legge non e acceso');
{
  const d = tmp();
  fs.writeFileSync(d.stateFile, '{ questo non e json');
  const cfg = C.readTrackingConfig(d);
  ok('file corrotto ⇒ readable false', cfg.readable === false);
  ok('  e ZERO mercati tracciati', cfg.marketIds.length === 0);
  ok('  con il motivo, non un silenzio', typeof cfg.error === 'string' && cfg.error.length > 0, cfg.error);
  ok('trackedMarketIds su file corrotto ⇒ lista vuota', C.trackedMarketIds(d).length === 0);
  ok('non si ACCENDE su uno stato illeggibile', C.setTracking({ marketId: ID(4), enabled: true, ...GOOD }, d).ok === false);
  ok('  ma si SPEGNE eccome: e la direzione sicura', C.setTracking({ marketId: ID(4), enabled: false }, d).ok === true);
}

console.log('\n── un record con parametri fuori limite viene ESCLUSO, non corretto');
{
  const d = tmp();
  fs.writeFileSync(d.stateFile, JSON.stringify({ markets: {
    [ID(5).toLowerCase()]: { enabled: true, offsetCents: 999, minMoveCents: 1, sizeShares: 100 },
    [ID(6).toLowerCase()]: { enabled: true, offsetCents: 2, minMoveCents: 1, sizeShares: 100 },
  } }));
  const cfg = C.readTrackingConfig(d);
  ok('il record corrotto non compare', !cfg.marketIds.includes(ID(5).toLowerCase()));
  ok('  e NON e stato "aggiustato" a un valore plausibile', cfg.markets[ID(5).toLowerCase()] === undefined);
  ok('quello valido resta', cfg.marketIds.includes(ID(6).toLowerCase()));
}

console.log('\n── enabled:false nel file non conta come acceso');
{
  const d = tmp();
  fs.writeFileSync(d.stateFile, JSON.stringify({ markets: { [ID(7).toLowerCase()]: { enabled: false, ...GOOD } } }));
  ok('solo l ON esplicito conta', C.readTrackingConfig(d).marketIds.length === 0);
}

console.log('\n── ogni scrittura lascia una traccia');
{
  const d = tmp();
  C.setTracking({ marketId: ID(8), enabled: true, ...GOOD, by: 'operatore', reason: 'test' }, d);
  C.setTracking({ marketId: ID(8), enabled: false, reason: 'basta' }, d);
  const lines = fs.readFileSync(d.auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('due righe di audit', lines.length === 2, String(lines.length));
  ok('  la prima e un accensione con i parametri', lines[0].event === 'tracking-on' && lines[0].offsetCents === 2);
  ok('  con chi e perche', lines[0].by === 'operatore' && lines[0].reason === 'test');
  ok('  la seconda e uno spegnimento', lines[1].event === 'tracking-off');
}

console.log(`\nmm-tracking-config: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

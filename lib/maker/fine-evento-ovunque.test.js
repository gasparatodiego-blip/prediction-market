#!/usr/bin/env node
'use strict';
// FINE EVENTO: LA STESSA SOGLIA SU TUTTI I PERCORSI, NON SU DUE SU QUATTRO.
//
// ═══ IL GUASTO CHE QUESTO TEST IMPEDISCE ═════════════════════════════════════════════════════════════
// La cancellazione di sicurezza a fine scala (mid < 3¢ o > 97¢) esisteva già ed era scritta bene: una
// sola definizione in lib/maker/end-of-scale.js, importata — e questo era il problema — da DUE soli
// motori, il watcher reattivo (auto-reprice, agent40) e il market maker a due lati (mm-tracking).
//
// Restavano fuori i due percorsi che PIAZZANO:
//   · il motore di agent35, che valuta le rotaie di rischio (lib/maker/risk-rails) e non aveva nessuna
//     rotaia per il prezzo estremo: quotava dentro la zona di risoluzione mentre gli altri due ne
//     uscivano;
//   · `placeManualOrder`, l'imbuto unico da cui passano il pannello manuale, `bulk-allocate` e quindi
//     agent41: un ordine NUOVO poteva nascere a 2¢ e aspettare il giro dopo di agent40 per essere tolto.
//
// È la classe di difetto che in questo progetto si è già vista più volte: la protezione c'è su un
// percorso e manca sull'altro, quindi sembra esserci. Questo test la verifica su OGNI percorso.
//
// ═══ E LE SOGLIE SI RILEGGONO ════════════════════════════════════════════════════════════════════════
// MID_EXTREME_LOW / MID_EXTREME_HIGH in `.env`, in prezzo (0–1), rilette a ogni chiamata. Un valore che
// non si capisce NON allarga niente: si torna a 3¢/97¢, perché il difetto è la protezione.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const { endOfScaleCheck, sogliaFineScala, END_OF_SCALE_LOW_CENTS, END_OF_SCALE_HIGH_CENTS } = require('./end-of-scale');
const { evaluateRails } = require('./risk-rails');
const { placeManualOrder } = require('./manual-order');

(async () => {

console.log('\n══ 1 · LE SOGLIE: difetto 3¢/97¢, e .env le sposta senza riavvio');
{
  ok('senza env, le soglie sono quelle di sempre',
    sogliaFineScala({}).lowCents === 3 && sogliaFineScala({}).highCents === 97,
    `${END_OF_SCALE_LOW_CENTS}¢ / ${END_OF_SCALE_HIGH_CENTS}¢`);

  const largo = { MID_EXTREME_LOW: '0.05', MID_EXTREME_HIGH: '0.95' };
  const s = sogliaFineScala(largo);
  ok('MID_EXTREME_LOW/HIGH spostano le soglie', s.lowCents === 5 && s.highCents === 95 && s.origine === 'env',
    `${s.lowCents}¢ / ${s.highCents}¢`);
  ok('  e un mid a 4¢ diventa fine scala con le soglie larghe',
    endOfScaleCheck(0.04, largo).endOfScale === true && endOfScaleCheck(0.04, {}).endOfScale === false,
    'stesso mid, due risposte, e la differenza è dichiarata');

  // ── La direzione dello scarto è la parte che conta: un .env sbagliato non spegne la protezione.
  for (const [nome, env] of [
    ['non numerico', { MID_EXTREME_LOW: 'tre centesimi' }],
    ['zero (spegnerebbe il lato basso)', { MID_EXTREME_LOW: '0' }],
    ['uno (spegnerebbe il lato alto)', { MID_EXTREME_HIGH: '1' }],
    ['negativo', { MID_EXTREME_LOW: '-0.05' }],
    ['in centesimi invece che in prezzo', { MID_EXTREME_LOW: '3' }],
    ['low ≥ high', { MID_EXTREME_LOW: '0.98', MID_EXTREME_HIGH: '0.02' }],
    ['vuoto', { MID_EXTREME_LOW: '   ' }],
  ]) {
    const v = sogliaFineScala(env);
    ok(`${nome} ⇒ si torna a 3¢/97¢`, v.lowCents === 3 && v.highCents === 97, `${v.lowCents}/${v.highCents} (${v.origine})`);
  }
  ok('  e le soglie effettive viaggiano nel verdetto',
    endOfScaleCheck(0.5).lowCents === 3 && endOfScaleCheck(0.5).highCents === 97,
    'chi legge l audit sa contro quale numero è stato giudicato');
}

console.log('\n══ 2 · IL MOTORE (agent35 → risk-rails): la rotaia che mancava');
{
  const config = {
    killSwitch: false,
    rails: { dailyLossLimitUsd: 25, errorRateMax: 5, errorRateWindowMs: 60_000, totalExposureCapUsd: 0,
      perMarketNotionalCapUsd: 0, perMarketPositionCapUsd: 0 },
  };
  const stato = { dailyPnlUsd: 0, totalExposureUsd: 0, recentErrorCount: 0 };
  const valuta = (mid) => evaluateRails({
    globalState: stato,
    market: { feedLive: true, resolved: false, closed: false, structurallyDegenerate: false,
      newsSeverity: null, marketNotionalUsd: 0, positionUsd: 0, mid },
    config,
  });

  for (const [mid, etichetta] of [[0.02, '2¢'], [0.029, '2,9¢'], [0.98, '98¢'], [0.999, '99,9¢']]) {
    const r = valuta(mid);
    const t = r.trips.find((x) => x.rail === 'end-of-scale');
    ok(`mid ${etichetta} ⇒ rotaia end-of-scale`, !!t, t ? t.detail.slice(0, 60) : 'NESSUNA ROTAIA');
    ok('  e il motore deve CANCELLARE questo mercato', r.cancelScope === 'market' && r.haltMarket === true, r.cancelScope);
    ok('  e non può quotarci niente di nuovo', r.allowNewPlacement === false);
  }

  for (const [mid, etichetta] of [[0.03, '3¢ esatti'], [0.5, '50¢'], [0.97, '97¢ esatti']]) {
    const r = valuta(mid);
    ok(`mid ${etichetta} ⇒ nessuna rotaia (il confine è compreso)`,
      !r.trips.some((x) => x.rail === 'end-of-scale') && r.allowNewPlacement === true, etichetta);
  }

  // Un mid non letto non è un mid a fine scala: cancellare su un dato che non abbiamo è una decisione
  // presa a caso, anche quando la direzione sembra prudente. Il caso «non sappiamo» ha già la sua rotaia.
  for (const [mid, etichetta] of [[null, 'null'], [undefined, 'undefined'], [NaN, 'NaN']]) {
    const r = valuta(mid);
    ok(`mid ${etichetta} ⇒ nessuna rotaia end-of-scale`, !r.trips.some((x) => x.rail === 'end-of-scale'));
  }
  const cieco = evaluateRails({
    globalState: stato,
    market: { feedLive: false, resolved: false, closed: false, structurallyDegenerate: false,
      newsSeverity: null, marketNotionalUsd: 0, positionUsd: 0, mid: null },
    config,
  });
  ok('  ma il feed morto lo ferma comunque (feed-stale)', cieco.haltMarket === true && cieco.cancelScope === 'market');
}

console.log('\n══ 3 · L\'IMBUTO DI PIAZZAMENTO (pannello manuale, bulk-allocate, agent41)');
{
  // Il mondo è iniettato per intero: nessun file di data/, nessuna rete, MANUAL_ORDER_PLACEMENT=dry-run.
  const MKT = '0x' + 'cd'.repeat(32);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fine-evento-'));
  const stateFile = path.join(dir, 'manual-mode.json');
  fs.writeFileSync(stateFile, JSON.stringify({ markets: { [MKT.toLowerCase()]: { manual: true, at: Date.now() } } }));

  const mondo = (mid, env = {}) => ({
    norm: { markets: [{
      marketId: MKT, title: 'Mercato che sta risolvendo', midpoint: mid, tickSize: 0.01,
      maxSpread: 4.5, minSize: 50, tokenId: 'tok-yes', tokenIdNo: 'tok-no', negRisk: false,
      updatedAt: new Date().toISOString(),
    }] },
    books: { markets: { [MKT]: {
      tokenId: 'tok-yes', tokenIdNo: 'tok-no', mid, minSize: 50, maxSpread: 4.5, ageMs: 1_000,
      yes: { live: true, ageMs: 1_000, bestBid: +(mid - 0.01).toFixed(2), bestAsk: +(mid + 0.01).toFixed(2), adjustedMid: mid },
      no: { live: true, ageMs: 1_000, bestBid: +(0.99 - mid).toFixed(2), bestAsk: +(1.01 - mid).toFixed(2), adjustedMid: +(1 - mid).toFixed(2) },
    } } },
    manualDeps: { stateFile },
    env: { MANUAL_ORDER_PLACEMENT: 'dry-run', ...env },
  });
  const piazza = (mid, env, extra = {}) => placeManualOrder(
    { marketId: MKT, book: 'yes', price: mid, size: 50, ...extra }, mondo(mid, env));

  for (const [mid, etichetta] of [[0.02, '2¢'], [0.01, '1¢'], [0.98, '98¢'], [0.99, '99¢']]) {
    const r = await piazza(mid);
    ok(`mid ${etichetta} ⇒ RIFIUTATO`, r.ok === false && r.sent === false, `gate: ${r.gate}`);
    ok('  con gate end-of-scale', r.gate === 'end-of-scale', String(r.gate));
    ok('  e il motivo dice il perché e la soglia',
      /risoluzione/.test(r.reason || '') && /soglia/.test(r.reason || ''), (r.reason || '').slice(0, 70));
  }

  {
    const r = await piazza(0.5);
    ok('mid 50¢ ⇒ NON è quel gate', r.gate !== 'end-of-scale', `fermato da: ${r.gate || 'nessun gate'}`);
    ok('  e niente è stato inviato al venue comunque (dry-run)', r.sent === false);
  }

  {
    // La soglia di .env vale anche qui, ed è lo stesso modulo: un solo numero per tutto il progetto.
    const r = await piazza(0.04, { MID_EXTREME_LOW: '0.05' });
    ok('con MID_EXTREME_LOW=0.05 un mid a 4¢ è rifiutato anche in piazzamento',
      r.gate === 'end-of-scale', String(r.gate));
    const r2 = await piazza(0.04);
    ok('  e senza quell env lo stesso mid passa quel gate', r2.gate !== 'end-of-scale', `fermato da: ${r2.gate || 'nessun gate'}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n══ 4 · UNA SOLA DEFINIZIONE, QUATTRO PERCORSI — nessuna copia locale');
{
  const consumatori = ['lib/maker/auto-reprice.js', 'lib/maker/mm-tracking.js', 'lib/maker/risk-rails.js',
    'lib/maker/manual-order.js'];
  const ROOT = path.resolve(__dirname, '..', '..');
  for (const f of consumatori) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(`${f} importa la soglia`, /require\('\.\/end-of-scale'\)/.test(src));
    // Il difetto da impedire non è «manca l'import»: è la costante ricopiata accanto, che diverge dopo
    // il primo cambio e lascia un motore protetto a 3¢ e l'altro a 2¢.
    ok('  e non ne tiene una copia',
      !/(END_OF_SCALE_(LOW|HIGH)_CENTS|MID_EXTREME_(LOW|HIGH))\s*=/.test(src.replace(/require\([^)]*\)/g, '')));
  }
}

console.log(`\nfine evento su tutti i percorsi: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

})();

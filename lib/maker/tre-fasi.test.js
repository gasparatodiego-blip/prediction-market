#!/usr/bin/env node
'use strict';
// LE TRE FASI DEL 4 AGOSTO 2026 — CONTABILITÀ, RIMPIAZZO, PREZZO.

const { computeExposure } = require('../safety/fills');
const { evaluateLimits, resolveLimits } = require('../safety/risk-limits');
const { readVenuePositions, writeVenuePositions } = require('../safety/venue-positions-snapshot');
const { decideRimpiazzo } = require('./rimpiazzo-gamba');
const { planBehindBest } = require('./top-of-book');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// ═══ FASE 1 · LE POSIZIONI VERE ENTRANO NEL TETTO ═══════════════════════════════════════════════
console.log('\n══ FASE 1 · IL TETTO CONTA LE POSIZIONI REALI, NON SOLO IL LEDGER');
{
  const vp = { readable: true, positions: [{ tokenId: 'T1', size: 200, avgPrice: 0.1675, curPrice: 0 }] };
  const senza = computeExposure({ userId: 'x', sentOrders: [] }, { readFills: () => ({ ok: true, rows: [] }) });
  const con = computeExposure({ userId: 'x', sentOrders: [], venuePositions: vp }, { readFills: () => ({ ok: true, rows: [] }) });
  ok('senza le posizioni del venue l esposizione e zero', senza.openNotionalUsd === 0, String(senza.openNotionalUsd));
  ok('  con le posizioni del venue diventa il loro nozionale di carico',
    Math.abs(con.openNotionalUsd - 200 * 0.1675) < 0.01, `$${con.openNotionalUsd}`);
  ok('  la posizione compare come «solo al venue»', con.positions.some((p) => p.soloAlVenue === true && p.tokenId === 'T1'));
  ok('  e la provenienza e dichiarata', con.venuePositions.readable === true && con.venuePositions.count === 1
    && Math.abs(con.venuePositions.addedUsd - 33.5) < 0.01, JSON.stringify(con.venuePositions));
}

console.log('\n══ FASE 1b · NIENTE DOPPIO CONTEGGIO: LA STESSA POSIZIONE VALE UNA VOLTA');
{
  // La fusione e' per TOKEN: due letture dello stesso token non si sommano, vince la piu' alta.
  // Qui si provano le due direzioni sulla sola fonte venue, che e' quella che il fix aggiunge.
  const uno = computeExposure({ userId: 'x',
    venuePositions: { readable: true, positions: [{ tokenId: 'T1', size: 200, avgPrice: 0.1675, curPrice: 0 }] } });
  const duplicato = computeExposure({ userId: 'x',
    venuePositions: { readable: true, positions: [
      { tokenId: 'T1', size: 200, avgPrice: 0.1675, curPrice: 0 },
      { tokenId: 'T1', size: 200, avgPrice: 0.1675, curPrice: 0 },
    ] } });
  ok('lo stesso token due volte NON raddoppia l esposizione',
    Math.abs(duplicato.openNotionalUsd - uno.openNotionalUsd) < 0.01,
    `una volta $${uno.openNotionalUsd} · due volte $${duplicato.openNotionalUsd}`);
  const piuAlto = computeExposure({ userId: 'x',
    venuePositions: { readable: true, positions: [
      { tokenId: 'T1', size: 200, avgPrice: 0.1675, curPrice: 0 },
      { tokenId: 'T1', size: 200, avgPrice: 0.1675, curPrice: 0.30 },
    ] } });
  ok('  e fra due letture dello stesso token vince la PIU ALTA (si sbaglia per eccesso)',
    Math.abs(piuAlto.openNotionalUsd - 60) < 0.01, `$${piuAlto.openNotionalUsd}`);
  const due = computeExposure({ userId: 'x',
    venuePositions: { readable: true, positions: [
      { tokenId: 'T1', size: 200, avgPrice: 0.1675, curPrice: 0 },
      { tokenId: 'T2', size: 100, avgPrice: 0.50, curPrice: 0.50 },
    ] } });
  ok('  mentre token DIVERSI si sommano', Math.abs(due.openNotionalUsd - (33.5 + 50)) < 0.01, `$${due.openNotionalUsd}`);
}

console.log('\n══ FASE 1c · POSIZIONI NON LEGGIBILI ⇒ NON SI APRE ESPOSIZIONE NUOVA');
{
  const L = resolveLimits({}).limits;
  const base = { openNotionalUsd: 0, ordersInWindow: 0, realisedDailyPnlUsd: 0 };
  const no = evaluateLimits({ order: { notionalUsd: 10 }, limits: L, usage: { ...base, venuePositions: { readable: false, reason: 'mai scritto' } } });
  ok('snapshot assente ⇒ rifiuto', no.allow === false && no.gate === 'venue-positions-unreadable', `${no.gate}`);
  ok('  col motivo giusto: «non ho guardato» non e «non c e niente»',
    /non si apre esposizione nuova senza sapere quanta ce n'e' gia'/.test(no.reason), no.reason.slice(0, 80));
  const si = evaluateLimits({ order: { notionalUsd: 10 }, limits: L, usage: { ...base, venuePositions: { readable: true, count: 0 } } });
  ok('snapshot fresco ⇒ si prosegue', si.allow === true, `${si.gate || 'nessun rifiuto'}`);
}

console.log('\n══ FASE 1d · LO SNAPSHOT SCADE, E SCADUTO NON E «VUOTO»');
{
  const ORA = 1_700_000_000_000;
  const f = require('path').join(require('os').tmpdir(), 'snap-test-' + process.pid + '.json');
  require('fs').writeFileSync(f, JSON.stringify({ at: ORA - 10_000, positions: [{ tokenId: 'T1', size: 5, avgPrice: 0.5 }] }));
  const fresco = readVenuePositions({ now: () => ORA, snapshotFile: f, maxAgeMs: 180_000 });
  ok('entro il limite e leggibile', fresco.readable === true && fresco.positions.length === 1);
  const vecchio = readVenuePositions({ now: () => ORA + 400_000, snapshotFile: f, maxAgeMs: 180_000 });
  ok('  oltre il limite NON e leggibile (mai «zero posizioni»)',
    vecchio.readable === false && vecchio.positions.length === 0 && /vecchio di/.test(vecchio.reason), vecchio.reason.slice(0, 70));
  ok('una lettura fallita NON sovrascrive lo snapshot buono',
    writeVenuePositions({ ok: false, reason: 'venue muto' }).written === false);
  require('fs').unlinkSync(f);
}

// ═══ FASE 2 · IL RIMPIAZZO RISPETTA IL TETTO ════════════════════════════════════════════════════
const rules = { readable: true, mid: 0.43, tick: 0.01, maxSpreadCents: 4.5, books: { yes: { scoringMid: 0.43 }, no: { scoringMid: 0.57 } } };

console.log('\n══ FASE 2 · IL RIMPIAZZO ENTRA SOLO PER QUELLO CHE CI STA');
{
  const r = decideRimpiazzo({ book: 'yes', rules, offsetCents: 1, tettoMercatoUsd: 180, posizioneUsd: 77, ordiniApertiUsd: 0 });
  ok('con spazio libero rimpiazza', r.action === 'rimpiazza', `${r.action} · ${r.gate}`);
  ok('  allo stesso prezzo delle due gambe (mid − offset)', r.price === 0.42, String(r.price));
  ok('  e per il solo spazio rimasto sotto il tetto',
    Math.abs(r.disponibileUsd - 103) < 0.01 && Math.abs(r.price * r.size - 103) < 0.2,
    `spazio $${r.disponibileUsd}, nozionale $${(r.price * r.size).toFixed(2)}`);
  ok('  quindi posizione + rimpiazzo NON superano il tetto',
    77 + r.price * r.size <= 180 + 0.2, `${(77 + r.price * r.size).toFixed(2)} su 180`);
}

console.log('\n══ FASE 2b · TETTO SATURO ⇒ NON SI FORZA, SI DICHIARA');
{
  const r = decideRimpiazzo({ book: 'yes', rules, offsetCents: 1, tettoMercatoUsd: 180, posizioneUsd: 180, ordiniApertiUsd: 5 });
  ok('non rimpiazza', r.action === 'skip' && r.gate === 'tetto-saturo', `${r.gate}`);
  ok('  e il motivo dice che ASPETTA, non che rinuncia',
    /aspetta che la chiusura liberi spazio, non forza il tetto/.test(r.reason), r.reason.slice(-60));
  const nl = decideRimpiazzo({ book: 'yes', rules, offsetCents: 1, tettoMercatoUsd: null, posizioneUsd: 0 });
  ok('tetto non leggibile ⇒ NON si piazza (fail closed su chi APRE)', nl.action === 'skip' && nl.gate === 'tetto-non-leggibile');
  const ms = decideRimpiazzo({ book: 'yes', rules, offsetCents: 1, tettoMercatoUsd: 180, posizioneUsd: 177, minSizeShares: 20 });
  ok('sotto la size minima premiante ⇒ non si piazza capitale fermo', ms.action === 'skip' && ms.gate === 'sotto-size-minima');
}

console.log('\n══ FASE 2c · IL RIMPIAZZO NON PUO CONFONDERSI CON L USCITA');
{
  const r = decideRimpiazzo({ book: 'yes', rules, offsetCents: 1, tettoMercatoUsd: 180, posizioneUsd: 50 });
  ok('il rimpiazzo e sul libro della gamba eseguita', r.book === 'yes');
  const src = require('fs').readFileSync(require('path').join(__dirname, 'auto-close.js'), 'utf8');
  ok('  ed e un BUY, mentre l uscita e un SELL', /e' un BUY; l'uscita e' un SELL/.test(src) || /E' un BUY/.test(src));
  ok('  auto-close conta i SELL per sapere se una posizione e coperta',
    /String\(o\.side \|\| ''\)\.toUpperCase\(\) === 'SELL'/.test(src),
    'quindi un BUY in piu non puo far sembrare coperta una posizione scoperta');
}

// ═══ FASE 3 · UN TICK DIETRO, MA LA BANDA VINCE ═════════════════════════════════════════════════
console.log('\n══ FASE 3 · «UN TICK DIETRO AL MIGLIORE» E IL CONFLITTO CON LA BANDA');
{
  // Banda larga: c'è spazio per stare dietro al migliore e restare premianti.
  const largo = planBehindBest({ bestOther: 0.42, tick: 0.01, scoringMid: 0.43, bandRadiusCents: 4.5 });
  ok('con banda larga si sta un tick DIETRO il migliore', largo.ok === true && largo.price === 0.41, `${largo.price} · ${largo.mode}`);
  ok('  e non siamo in cima al book', largo.onTop === false);

  // Banda stretta: un tick dietro cadrebbe FUORI. La priorità è NON stare in cima — invertita il
  // 5 agosto 2026. Questo blocco pretendeva l'opposto («la banda VINCE», aggancio al bordo con
  // onTop:true); adesso si rinuncia al lato invece di prendere la posizione peggiore del libro.
  const stretto = planBehindBest({ bestOther: 0.42, tick: 0.01, scoringMid: 0.43, bandRadiusCents: 1.0 });
  ok('con banda stretta NON si quota affatto',
    stretto.ok === false && stretto.mode === 'behind-best-fuori-banda', `${stretto.price} · ${stretto.mode}`);
  ok('  «mai primi» VINCE sulla banda', stretto.price === null && stretto.quotabile === false);
  ok('  e il conflitto e dichiarato, non nascosto',
    /fuori dalla banda premiante/.test(stretto.reason) && /non si quota/.test(stretto.reason), stretto.reason.slice(0, 100));
  ok('  con onTop=false, perche in cima non ci si mette', stretto.onTop === false);

  // Nessun altro sul lato: si ripiega sull'offset configurato, non si inventa un prezzo.
  const soli = planBehindBest({ bestOther: null, tick: 0.01, scoringMid: 0.43, bandRadiusCents: 4.5, fallbackOffsetCents: 1 });
  ok('senza altri partecipanti si ripiega sull offset configurato', soli.ok === true && soli.mode === 'fallback-alone', `${soli.price}`);

  // Banda non leggibile: non si risponde, non si tira a indovinare.
  const senzaBanda = planBehindBest({ bestOther: 0.42, tick: 0.01, scoringMid: 0.43, bandRadiusCents: null });
  ok('banda non leggibile ⇒ non si risponde', senzaBanda.ok === false && /non sarebbe garantibile/.test(senzaBanda.reason));
}

console.log('\n══ FASE 3b · LA CHIUSURA FORZATA RESTA AGGRESSIVA');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'auto-close.js'), 'utf8');
  ok('la chiusura a mercato vende al miglior bid, dichiarandolo',
    /attraversaApposta: true/.test(src) && /chiusura a mercato al bid/.test(src));
  const mo = require('fs').readFileSync(require('path').join(__dirname, 'manual-order.js'), 'utf8');
  ok('  e il gate anti-taker la lascia passare SOLO in vendita e SOLO se dichiarata',
    /const attraversaApposta = lato === 'SELL' && spec\.attraversaApposta === true/.test(mo));
  ok('  «un tick dietro» NON viene applicato a quel ramo',
    !/planBehindBest/.test(src), 'la chiusura forzata deve eseguire, non quotare');
}

console.log(`\ntre fasi: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
'use strict';
// ⚠ IL DIFETTO CHE QUESTA REGOLA CORREGGE — 21 agosto 2026, misurato.
// Il ledger dei fill conteneva **5 fill e ZERO SELL** dal 31 luglio, mentre il venue dichiarava 561,90
// share comprate e 1.167,53 vendute. `runFifo` non chiudeva mai niente: `openNotionalUsd` saliva e non
// scendeva ($77,73 contro posizioni reali ZERO) e `realisedDailyPnl` valeva **$0 per costruzione** —
// cioe' il kill a −$100 guardava un registro cieco e non poteva scattare.
//
// LA CAUSA: le due sole prove positive erano `size_matched` (che pretende l'ordine ANCORA APERTO) e
// `/trades`. Un ordine riempito per intero sparisce dagli ordini aperti, e `/trades` NON riporta i
// fill maker — misurato: 53 trade in tre settimane su 51 token distinti, con le SELL su token che i
// BUY non toccano mai. Restava `gone-and-no-trades` ⇒ nofill su un ordine davvero eseguito.
//
// LA CURA: la POSIZIONE e' prova positiva quanto un trade. Il ramo esisteva gia' (il commento del
// 31 luglio aveva la diagnosi giusta) ma concludeva «non risolvere niente», cioe' aspettava un
// `/trades` che non arriva mai.
const RF = require('./reconcile-fills');

let ok = 0, ko = 0;
const t = (m, c, x) => { c ? (ok++, console.log('  ✓ ' + m + (x !== undefined ? ' — ' + JSON.stringify(x) : ''))) : (ko++, console.log('  ✗ ROSSO: ' + m + (x !== undefined ? ' — ' + JSON.stringify(x) : ''))); };

const NOW = 1787000000000;
const TOK = 'tok_A';
const ordine = (over = {}) => ({
  idempotencyKey: 'k1', orderId: '0xORD', userId: 'operator', venue: 'polymarket',
  tokenId: TOK, side: 'BUY', price: 0.42, size: 50, notionalUsd: 21, ts: NOW - 60_000, ...over,
});
// L'ordine NON e' fra quelli aperti (riempito per intero e sparito) e `/trades` non lo vede.
const piano = (over = {}) => RF.planReconcile({
  userId: 'operator', sentOrders: [ordine(over.ordine)], ledgerRows: over.ledgerRows || [],
  venueReachable: true, venueOrders: [], venueFills: over.venueFills !== undefined ? over.venueFills : [],
  venuePositions: over.venuePositions !== undefined ? over.venuePositions : [{ asset: TOK, size: 50 }],
  now: NOW, source: 'test',
});

console.log('\n══ 1 · L\'APERTURA VIENE CATTURATA DALLA POSIZIONE');
{
  const p = piano();
  t('un ordine sparito, senza trade, ma con una POSIZIONE ⇒ si registra il fill', p.toRecord.length === 1);
  const f = p.toRecord[0] || {};
  t('  con la size della posizione', f.filledSize === 50, f.filledSize);
  t('  al prezzo DELL\'ORDINE — per un maker e\' esatto, non una stima', f.filledPrice === 0.42, f.filledPrice);
  t('  e la fonte lo dichiara', /:positions$/.test(String(f.source || '')), f.source);
  t('  e NON finisce fra i nofill', p.toNoFill.length === 0);
  t('  ne fra gli irrisolti', p.stillUnknown.length === 0);
}

console.log('\n══ 2 · NIENTE DOPPIONI');
{
  // Gia' registrato per QUESTO token+lato: la posizione non deve produrre una seconda riga.
  const gia = [{ kind: 'fill', userId: 'operator', venue: 'polymarket', tokenId: TOK, side: 'BUY',
    filledSize: 50, filledPrice: 0.42, ts: NOW - 30_000, idempotencyKey: 'altro' }];
  const p = piano({ ledgerRows: gia, ordine: { idempotencyKey: 'k2' } });
  t('una posizione gia\' coperta dal ledger NON produce una seconda riga', p.toRecord.length === 0);
  t('  e resta dichiarata come irrisolta, non inventata', p.stillUnknown.length === 1);
}
{
  // Copertura PARZIALE: si registra solo il delta.
  const gia = [{ kind: 'fill', userId: 'operator', venue: 'polymarket', tokenId: TOK, side: 'BUY',
    filledSize: 20, filledPrice: 0.42, ts: NOW - 30_000, idempotencyKey: 'altro' }];
  const p = piano({ ledgerRows: gia, ordine: { idempotencyKey: 'k3' } });
  t('copertura parziale ⇒ si registra SOLO il delta', p.toRecord.length === 1 && p.toRecord[0].filledSize === 30,
    p.toRecord[0] && p.toRecord[0].filledSize);
}
{
  // Non si rivendica piu' di quanto QUESTO ordine potesse eseguire.
  const p = piano({ ordine: { size: 10 }, venuePositions: [{ asset: TOK, size: 500 }] });
  t('non si rivendica piu\' della size dell\'ordine', p.toRecord[0] && p.toRecord[0].filledSize === 10,
    p.toRecord[0] && p.toRecord[0].filledSize);
}

console.log('\n══ 3 · UNA SELL NON DIVENTA MAI UN FILL DA QUESTO RAMO');
{
  // ⚠ E' LA GUARDIA CHE IMPEDISCE LO SHORT FANTASMA. Una posizione che COMPARE prova un acquisto; una
  // vendita si prova con una posizione che CALA, e questo ramo non vede la storia. Registrarla da qui
  // aprirebbe uno short in `runFifo` (fills.js:169) su lotti che il ledger non ha mai visto aprire.
  const p = piano({ ordine: { side: 'SELL' } });
  t('un ordine SELL non produce nessun fill da /positions', p.toRecord.length === 0);
  t('  resta irrisolto e dichiarato', p.stillUnknown.length === 1);
  const F = require('./fills');
  const { byKey } = F.runFifo([{ kind: 'fill', venue: 'polymarket', tokenId: TOK, side: 'SELL',
    filledSize: 50, filledPrice: 0.42, ts: NOW }]);
  const lots = (byKey.get('polymarket|' + TOK) || {}).lots || [];
  t('  (e si prova PERCHE\': una SELL senza lotti aperti apre uno SHORT in runFifo)',
    lots.length === 1 && lots[0].shares < 0, lots[0] && lots[0].shares);
}

console.log('\n══ 4 · FAIL-CLOSED: senza posizioni non si inventa niente');
{
  const p = piano({ venuePositions: null });
  t('posizioni NON leggibili ⇒ nessun fill, resta irrisolto', p.toRecord.length === 0 && p.stillUnknown.length === 1);
  t('  col motivo che nomina la mancanza del riscontro',
    /no-positions-crosscheck/.test((p.stillUnknown[0] || {}).reason || ''), (p.stillUnknown[0] || {}).reason);
  const q = piano({ venuePositions: [] });
  t('posizioni lette e VUOTE ⇒ nofill, non fill', q.toRecord.length === 0 && q.toNoFill.length === 1);
  const r = piano({ venueFills: null, venuePositions: [{ asset: TOK, size: 50 }] });
  t('senza /trades il ramo non si raggiunge: nessun fill inventato', r.toRecord.length === 0);
}

console.log('\n══ 5 · IL CABLAGGIO — venuePositions arriva davvero al pianificatore');
{
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'maker', 'manual-reset.js'), 'utf8');
  const cod = src.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  t('`reconcileManualLane` LEGGE le posizioni dal venue', /fetchVenuePositions\)\(\{ address \}\)/.test(cod));
  t('  e le PASSA a planReconcile, non solo le legge',
    /venuePositions: positions\.ok \? positions\.positions : null/.test(cod));
  const rf = fs.readFileSync(path.join(__dirname, 'reconcile-fills.js'), 'utf8');
  const rfc = rf.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  t('il ramo delle posizioni REGISTRA, non si limita a dichiarare',
    /source \+ ':positions'/.test(rfc));
  t('  e resta scoped ai soli BUY', /String\(o\.side \|\| ''\)\.toUpperCase\(\) === 'BUY' && dPos > 1e-9/.test(rfc));
}

console.log(`\n${ok} verdi, ${ko} rossi`);
process.exit(ko === 0 ? 0 : 1);

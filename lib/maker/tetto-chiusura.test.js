'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *  IL TETTO PER MERCATO NON DEVE IMPEDIRE DI CHIUDERE — e non deve diventare un'esenzione in bianco
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Il caso vero: 13 agosto 2026, 07:45:36, Tel Aviv `0xcb034071` — posizione YES di 32,6 share scoperta
 * da un'ora, SOPRA il minimo del venue quindi copribile, e la copertura rifiutata perché «il mercato
 * arriverebbe a $45,63: il tetto per mercato è $32,67». Misurato sulle 24 ore: **6.226 righe
 * `tetto-mercato`** su sei mercati, tutti con posizione aperta.
 */

const assert = require('assert');
const M = require('./motore-unico');
const { capPerMarketUsd } = require('../rewards/concentration');

let passati = 0; let falliti = 0;
const ok = (nome, fn) => { try { fn(); passati += 1; } catch (e) { falliti += 1; console.error(`  ✗ ${nome}\n    ${e.message}`); } };

const SALDO = 664.9;
const tettoOrd = capPerMarketUsd(SALDO);

console.log('§1 · il caso vero di Tel Aviv');

ok('APERTURA: la gamba che porta il mercato a $45,63 resta rifiutata', () => {
  const r = M.tettoMercato({ saldoUsd: SALDO, esposizioneMercatoUsd: 13.5, aggiuntaUsd: 32.13 });
  assert.strictEqual(r.consentito, false);
  assert.ok(/45\.63/.test(r.motivo) && /32\.67/.test(r.motivo));
});

ok('CHIUSURA PROVATA: la stessa gamba passa, e lo dichiara', () => {
  const r = M.tettoMercato({ saldoUsd: SALDO, esposizioneMercatoUsd: 13.5, aggiuntaUsd: 32.13,
    chiusura: { ok: true, motivo: 'BUY entro `manca`' } });
  assert.strictEqual(r.consentito, true);
  assert.strictEqual(r.sforaOrdinario, true, 'deve dichiarare che sta sforando il tetto ordinario');
  assert.ok(/OLTRE il tetto ordinario/.test(r.motivo));
});

console.log('§2 · l\'esenzione NON è in bianco');

ok('esiste un tetto assoluto, ed e\' DERIVATO: (1 + 1/costoCoppia) volte quello ordinario', () => {
  const { COSTO_COPPIA } = require('../rewards/concentration');
  const r = M.tettoMercato({ saldoUsd: SALDO, esposizioneMercatoUsd: 0, aggiuntaUsd: 1, chiusura: { ok: true } });
  assert.strictEqual(r.capUsd, +(tettoOrd * (1 + 1 / COSTO_COPPIA)).toFixed(2));
});

ok('  e basta a chiudere qualunque posizione che il bot possa aprire, e nulla di più', () => {
  // La posizione più grande apribile su un mercato vale il tetto ordinario; comprarne la controparte
  // costa al più `Q × p` con `p → 1`, cioè ancora ~lo stesso. Il doppio copre il caso peggiore.
  const Q = tettoOrd / 0.98;
  const peggiore = tettoOrd + Q * 1.0;
  const r = M.tettoMercato({ saldoUsd: SALDO, esposizioneMercatoUsd: 0, aggiuntaUsd: 1, chiusura: { ok: true } });
  assert.ok(peggiore <= r.capUsd + 1e-9, `il caso peggiore vale ${peggiore.toFixed(2)} contro un tetto di ${r.capUsd}`);
  // «e nulla di piu'»: il tetto non deve essere piu' largo del caso peggiore di piu' di un dollaro.
  assert.ok(r.capUsd - peggiore < 1, `il tetto e' ${(r.capUsd - peggiore).toFixed(2)} piu' largo del necessario`);
});

ok('OLTRE il tetto assoluto si rifiuta anche una chiusura', () => {
  const r = M.tettoMercato({ saldoUsd: SALDO, esposizioneMercatoUsd: 60, aggiuntaUsd: 20, chiusura: { ok: true } });
  assert.strictEqual(r.consentito, false);
  assert.strictEqual(r.dopoUsd, 80);
});

ok('il tetto assoluto non supera mai il saldo: un mercato non è una frazione irragionevole', () => {
  for (const s of [10, 50, 100, 664.9, 5000]) {
    const r = M.tettoMercato({ saldoUsd: s, esposizioneMercatoUsd: 0, aggiuntaUsd: 0.01, chiusura: { ok: true } });
    assert.ok(r.capUsd <= s + 1e-9, `saldo $${s}: tetto di chiusura $${r.capUsd}`);
  }
  const frazione = M.tettoMercato({ saldoUsd: SALDO, esposizioneMercatoUsd: 0, aggiuntaUsd: 1, chiusura: { ok: true } }).capUsd / SALDO;
  assert.ok(frazione < 0.11, `il tetto di chiusura vale il ${(frazione * 100).toFixed(1)}% del capitale`);
});

console.log('§3 · vale SOLO per chi chiude, e serve una PROVA');

ok('una chiusura NON provata non ottiene niente', () => {
  for (const c of [null, undefined, {}, { ok: false }, { ok: 'true' }, { ok: 1 }]) {
    const r = M.tettoMercato({ saldoUsd: SALDO, esposizioneMercatoUsd: 13.5, aggiuntaUsd: 32.13, chiusura: c });
    assert.strictEqual(r.consentito, false, `chiusura ${JSON.stringify(c)} non deve esentare`);
  }
});

ok('  e non esiste una via per APRIRE passando di qui: senza prova il tetto è quello di sempre', () => {
  const r = M.tettoMercato({ saldoUsd: SALDO, esposizioneMercatoUsd: 0, aggiuntaUsd: tettoOrd + 0.01 });
  assert.strictEqual(r.consentito, false);
  assert.strictEqual(r.capUsd, tettoOrd);
});

ok('saldo non leggibile ⇒ nessuna esposizione, nemmeno per chiudere', () => {
  const r = M.tettoMercato({ saldoUsd: null, esposizioneMercatoUsd: 0, aggiuntaUsd: 1, chiusura: { ok: true } });
  assert.strictEqual(r.consentito, false);
});

ok('la prova è iniettata dal chiamante, non dichiarata dall\'ordine', () => {
  const src = require('fs').readFileSync(require.resolve('./auto-reprice.js'), 'utf8');
  assert.ok(/chiusura: typeof deps\.provaChiusura === 'function'/.test(src),
    'auto-reprice deve derivare la prova da una dep, non da un campo dell\'ordine');
  assert.ok(/return null/.test(src.slice(src.indexOf('provaChiusura'), src.indexOf('provaChiusura') + 400)),
    'e una prova che esplode vale «nessuna prova»');
});

console.log('§4 · le altre regole restano intatte');

ok('«mai primo sul libro» resta un veto assoluto e viene PRIMA del tetto', () => {
  const src = require('fs').readFileSync(require.resolve('./motore-unico.js'), 'utf8');
  const iMaiPrimo = src.indexOf('REGOLA 1 ─');
  const iTetto = src.indexOf('REGOLA 5 ─');
  assert.ok(iMaiPrimo > 0 && iTetto > iMaiPrimo, 'la Regola 1 deve restare prima della 5');
  const r = M.valutaMercato({ saldoUsd: SALDO, bookLevels: null, tick: 0.01, scoringMid: 0.5,
    chiusura: { ok: true } });
  assert.strictEqual(r.ok, false, 'senza book non si piazza, chiusura o no');
});

ok('il pavimento di profondità non è toccato dall\'esenzione', () => {
  const src = require('fs').readFileSync(require.resolve('./motore-unico.js'), 'utf8');
  const pav = src.slice(src.indexOf('function pavimentoDepth'), src.indexOf('function pavimentoDepth') + 2500);
  assert.ok(!/chiusura/.test(pav), 'il pavimento di profondità non deve conoscere la chiusura');
});

ok('il tetto ordinario è invariato per tutti gli altri', () => {
  const r = M.tettoMercato({ saldoUsd: SALDO, esposizioneMercatoUsd: 10, aggiuntaUsd: 20 });
  assert.strictEqual(r.capUsd, tettoOrd);
  assert.strictEqual(r.consentito, true);
  assert.ok(!r.sforaOrdinario);
});

console.log(`\ntetto-chiusura: ${passati} passati, ${falliti} falliti`);
process.exit(falliti === 0 ? 0 : 1);

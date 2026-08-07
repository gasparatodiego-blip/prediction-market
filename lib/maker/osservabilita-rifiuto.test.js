#!/usr/bin/env node
'use strict';
// I DUE FATTI SOPRAVVIVONO ANCHE AL RIFIUTO — che è il caso che interessava misurare.
//
// ═══ IL BUCO ════════════════════════════════════════════════════════════════════════════════════════
// `inCodaEsito` (cosa ha deciso la regola «mai primi sul libro») e `priceAdjusted` (di quanto il prezzo
// è stato spostato, e da che mid) viaggiavano nell'audit e nel valore di ritorno SOLO sul percorso
// felice. Su un rifiuto sparivano: il referto diceva quale gate aveva fermato l'ordine e nient'altro.
//
// Ed è il verso sbagliato. «Quante volte la regola mai-primi scarta un mercato» è una domanda sui NO,
// non sui sì; e un ordine rifiutato DOPO che il prezzo era già stato spostato lasciava un referto che
// non diceva che era stato spostato — quindi, riletto dopo, quel prezzo sembrava quello chiesto.
//
// ═══ E LA TRAPPOLA CHE STAVA DIETRO LA CORREZIONE ═══════════════════════════════════════════════════
// Le due variabili erano dichiarate con `let` DOPO `refuse`. Farle leggere a `refuse` senza spostare le
// dichiarazioni avrebbe funzionato sui rifiuti tardivi e sarebbe esploso con un ReferenceError su
// quelli anticipati (mercato ignoto, proprietà, regole illeggibili) — cioè avrebbe rotto il
// piazzamento per chiudere un buco di osservabilità. Le dichiarazioni sono salite sopra `refuse`, e i
// rifiuti anticipati sono la metà di questo test.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const { placeManualOrder } = require('./manual-order');
const MKT = '0x' + '9a'.repeat(32);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osserva-'));
  const stateFile = path.join(dir, 'manual-mode.json');
  fs.writeFileSync(stateFile, JSON.stringify({ markets: { [MKT.toLowerCase()]: { manual: true, at: Date.now() } } }));

  const mondo = (mid) => ({
    norm: { markets: [{
      marketId: MKT, title: 'M', midpoint: mid, tickSize: 0.01, maxSpread: 4.5, minSize: 50,
      tokenId: 'tok-yes', tokenIdNo: 'tok-no', negRisk: false, updatedAt: new Date().toISOString(),
    }] },
    books: { markets: { [MKT]: {
      tokenId: 'tok-yes', tokenIdNo: 'tok-no', mid, minSize: 50, maxSpread: 4.5, ageMs: 1_000,
      yes: { live: true, ageMs: 1_000, bestBid: +(mid - 0.01).toFixed(2), bestAsk: +(mid + 0.01).toFixed(2), adjustedMid: mid,
        levels: { bids: [{ price: +(mid - 0.01).toFixed(2), size: 500 }], asks: [{ price: +(mid + 0.01).toFixed(2), size: 500 }] } },
      no: { live: true, ageMs: 1_000, bestBid: 0.4, bestAsk: 0.42, adjustedMid: 0.41 },
    } } },
    manualDeps: { stateFile },
    env: { MANUAL_ORDER_PLACEMENT: 'dry-run' },
  });

  console.log('\n══ 1 · IL RIFIUTO TARDIVO PORTA I DUE CAMPI');
  {
    // Fine scala: il gate scatta DOPO il calcolo della coda e dopo l'eventuale spostamento del prezzo.
    const r = await placeManualOrder(
      { marketId: MKT, book: 'yes', price: 0.02, size: 50, inCoda: true, distanceCents: 1 }, mondo(0.02));
    ok('rifiutato dal gate atteso', r.ok === false && r.gate === 'end-of-scale', String(r.gate));
    ok('il campo `inCoda` c\'è nel referto', 'inCoda' in r, JSON.stringify(r.inCoda));
    ok('il campo `priceAdjusted` c\'è nel referto', 'priceAdjusted' in r, JSON.stringify(r.priceAdjusted));
  }

  console.log('\n══ 2 · I RIFIUTI ANTICIPATI NON ESPLODONO — la zona morta di `let`');
  {
    // Ognuno di questi rifiuta PRIMA che le due variabili vengano calcolate. Se le dichiarazioni
    // fossero rimaste sotto `refuse`, qui ci sarebbe un ReferenceError invece di un rifiuto pulito.
    const senzaMercato = await placeManualOrder({ book: 'yes', price: 0.5, size: 50 }, mondo(0.5));
    ok('mercato non indicato ⇒ rifiuto pulito, non ReferenceError',
      senzaMercato.ok === false && typeof senzaMercato.gate === 'string', String(senzaMercato.gate));
    ok('  e i due campi ci sono comunque (a null)',
      senzaMercato.inCoda === null && senzaMercato.priceAdjusted === null);

    const altro = '0x' + 'bb'.repeat(32);
    const nonManuale = await placeManualOrder({ marketId: altro, book: 'yes', price: 0.5, size: 50 }, mondo(0.5));
    ok('mercato non in gestione manuale ⇒ rifiuto pulito',
      nonManuale.ok === false && /manual-mode/.test(String(nonManuale.gate)), String(nonManuale.gate));
    ok('  con i due campi presenti', 'inCoda' in nonManuale && 'priceAdjusted' in nonManuale);
  }

  console.log('\n══ 3 · IL PERCORSO FELICE NON È CAMBIATO');
  {
    const r = await placeManualOrder({ marketId: MKT, book: 'yes', price: 0.49, size: 50, inCoda: true }, mondo(0.5));
    ok('i due campi restano nel valore di ritorno', 'inCoda' in r && 'priceAdjusted' in r,
      `gate: ${r.gate || 'nessuno'}`);
    ok('  e niente è stato inviato al venue (dry-run)', r.sent === false);
  }

  console.log('\n══ 4 · ANCHE L\'AUDIT LI RICEVE, non solo il chiamante');
  {
    const src = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
    const iRefuse = src.indexOf('const refuse = (gate, reason, extra = {})');
    const corpo = src.slice(iRefuse, iRefuse + 900);
    ok('`refuse` passa inCoda e priceAdjusted a manualAudit',
      /manualAudit\(\{[\s\S]*inCoda: inCodaEsito, priceAdjusted/.test(corpo));
    ok('  e li restituisce anche a chi ha chiamato',
      /return \{ ok: false[\s\S]*inCoda: inCodaEsito, priceAdjusted/.test(corpo));
    ok('  con `extra` che può ancora sovrascriverli', /priceAdjusted, \.\.\.extra/.test(corpo),
      'il rifiuto taker passa il proprio priceAdjusted e deve continuare a vincere');

    // La dichiarazione DEVE stare sopra `refuse`, o i rifiuti anticipati tornano a esplodere.
    const iDich = src.indexOf('let priceAdjusted = null;');
    ok('le dichiarazioni stanno SOPRA refuse', iDich > 0 && iDich < iRefuse, `dich@${iDich} refuse@${iRefuse}`);
    ok('  e non ce n\'è una seconda copia più in basso',
      (src.match(/let priceAdjusted = null;/g) || []).length === 1
      && (src.match(/let inCodaEsito = null;/g) || []).length === 1);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nosservabilità sul rifiuto: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

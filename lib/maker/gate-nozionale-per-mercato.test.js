'use strict';
// lib/maker/gate-nozionale-per-mercato.test.js — IL TETTO PER MERCATO GUARDA ANCHE GLI ORDINI A RIPOSO.
//
// ═══ IL BUCO, MISURATO ═══════════════════════════════════════════════════════════════════════════════
// 16 agosto 2026: `0x776841ce…` a **$89,08** e `0xde0b0b24…` a **$94,79** di ordini a riposo, contro un
// tetto per mercato di **$61,25**. Ogni singolo ordine era legale, e nessun gate poteva vederlo:
//   · il tetto per MERCATO governava il capitale che il PIANO assegna, non gli ordini vivi;
//   · il tetto per ORDINE guarda un ordine per volta ($44,54 < $65,63);
//   · `maxOpenNotionalUsd` conta i fill RICONCILIATI, e questi erano ordini a riposo.
// Tre cinture, e in mezzo un buco largo quanto un ordine intero.
//
// Si difende la PROPRIETA' — «la somma a riposo di un mercato non supera il tetto» — e non i numeri:
// il tetto vive in `concentration.js` e cambiera' ancora.

const assert = require('assert');
const { MARKET_CAP_FIXED_USD } = require('../rewards/concentration');
const { gemellaEsistente, trovaDoppioni } = require('./doppioni');

let p = 0;
const ok = (nome, cond) => { assert.ok(cond, nome); p += 1; console.log(`  ✓ ${nome}`); };

// La stessa aritmetica del gate in `manual-order.js`, isolata per poterla provare senza rete.
// ⚠ E' una RIPETIZIONE CONSAPEVOLE della somma, non della soglia: la soglia si importa. Se un giorno
// il gate cambiasse formula questo test resterebbe verde a torto — per questo il blocco finale
// verifica che il gate VERO esista e usi la costante importata, non un letterale.
function sommaARiposo(ordini) {
  let t = 0;
  for (const o of ordini) {
    const pr = Number(o.price);
    const s = Number(o.sizeRemaining != null ? o.sizeRemaining : o.size);
    if (!Number.isFinite(pr) || pr <= 0 || !Number.isFinite(s) || s <= 0) return null;   // illeggibile
    t += pr * s;
  }
  return +t.toFixed(4);
}
const passa = (ordini, nuovo) => {
  const a = sommaARiposo(ordini);
  if (a === null) return { allow: false, gate: 'nozionale-mercato-illeggibile' };
  return (a + nuovo > MARKET_CAP_FIXED_USD + 1e-9)
    ? { allow: false, gate: 'nozionale-mercato-oltre-tetto', aRiposo: a, dopo: +(a + nuovo).toFixed(4) }
    : { allow: true, aRiposo: a };
};

console.log('\n════ il tetto per mercato sugli ordini a riposo ════');
const O = (price, size) => ({ orderId: '0x1', price, size });

ok(`il tetto importato vale $${MARKET_CAP_FIXED_USD} e non e' ricopiato`,
  Number.isFinite(MARKET_CAP_FIXED_USD) && MARKET_CAP_FIXED_USD > 0);

ok('mercato vuoto: un ordione sotto il tetto passa', passa([], 44.54).allow === true);
ok('mercato vuoto: un ordine SOPRA il tetto non passa', passa([], MARKET_CAP_FIXED_USD + 0.01).allow === false);

// ⚠ IL CASO REALE: due ordini da $44,54 sullo stesso mercato.
const uno = [O(0.78, 57.1)];
ok('un ordine da $44,54 c\'e\' gia\': il secondo identico NON passa — il caso del 16/08',
  passa(uno, 44.54).allow === false && passa(uno, 44.54).gate === 'nozionale-mercato-oltre-tetto');
ok('  e la somma dichiarata e\' quella vera', Math.abs(passa(uno, 44.54).dopo - 89.08) < 0.02);
ok('  mentre un ordine PICCOLO che sta sotto il tetto passa ancora', passa(uno, 8.56).allow === true);

ok('esattamente AL tetto passa (il confine e\' inclusivo)',
  passa([O(0.5, 100)], MARKET_CAP_FIXED_USD - 50).allow === true);

// ⚠ FAIL-CLOSED: un ordine con prezzo o size illeggibili rende la SOMMA inaffidabile, e una somma
// sbagliata in difetto lascerebbe passare l'ordine di troppo — che e' il difetto, non un dettaglio.
ok('un ordine vivo col prezzo illeggibile ⇒ RIFIUTO, non «vale zero»',
  passa([O(null, 57.1)], 1).allow === false);
ok('  idem per la size', passa([O(0.78, null)], 1).allow === false);
ok('  e `Number(null) === 0` non passa dalla porta di servizio (§5.3)',
  passa([O(0, 57.1)], 1).allow === false);

// ── IL DIVIETO DI DOPPIONI, sulla stessa lettura ─────────────────────────────────────────────────
console.log('\n──── il divieto di doppioni al piazzamento ────');
const vivi = [{ orderId: '0xaaa', marketId: '0xM', tokenId: 'tokA', side: 'BUY', price: 0.73, size: 57.1 }];
const identico = gemellaEsistente(vivi, { conditionId: '0xM', tokenId: 'tokA', side: 'BUY', price: 0.73, size: 57.1 });
ok('un ordine IDENTICO a una gamba viva viene riconosciuto', identico.esiste && identico.identico);
const diverso = gemellaEsistente(vivi, { conditionId: '0xM', tokenId: 'tokA', side: 'BUY', price: 0.75, size: 57.1 });
ok('a prezzo diverso: esiste una gemella da cancellare PRIMA', diverso.esiste && !diverso.identico);
ok('l\'altra gamba della coppia non e\' una gemella',
  gemellaEsistente(vivi, { conditionId: '0xM', tokenId: 'tokB', side: 'BUY', price: 0.2, size: 57.1 }).esiste === false);

const dupli = trovaDoppioni([
  { orderId: '0x1', marketId: '0xM', tokenId: 'tokA', side: 'BUY', price: 0.73, size: 57.1, createdAt: 100 },
  { orderId: '0x2', marketId: '0xM', tokenId: 'tokA', side: 'BUY', price: 0.73, size: 57.1, createdAt: 200 },
  { orderId: '0x3', marketId: '0xM', tokenId: 'tokB', side: 'BUY', price: 0.20, size: 57.1, createdAt: 100 },
]);
ok('il riconciliatore trova UN doppione e lascia la coppia in pace', dupli.daCancellare.length === 1);
ok('  tiene il piu\' vecchio e cancella il nuovo', dupli.daCancellare[0].orderId === '0x2');

// ── IL CABLAGGIO VERO: il gate esiste nel sorgente e importa la costante ─────────────────────────
const fs = require('fs');
const src = fs.readFileSync(require.resolve('./manual-order.js'), 'utf8');
const codice = src.split('\n').map((r) => r.replace(/\/\/.*$/, '')).join('\n');
ok('`manual-order` IMPORTA il tetto per mercato (non lo ricopia)',
  /MARKET_CAP_FIXED_USD\s*\}?\s*=\s*require\('\.\.\/rewards\/concentration'\)|MARKET_CAP_FIXED_USD.*require/.test(codice)
  || /const \{[^}]*MARKET_CAP_FIXED_USD[^}]*\} = require\('\.\.\/rewards\/concentration'\)/.test(codice));
ok('  e nessun letterale 61.25 e\' stato scritto a mano nel gate', !/61\.25/.test(codice));
ok('il gate rifiuta con `nozionale-mercato-oltre-tetto`', /nozionale-mercato-oltre-tetto/.test(codice));
ok('  e con `nozionale-mercato-illeggibile` quando non puo\' sommare', /nozionale-mercato-illeggibile/.test(codice));
ok('il divieto di doppioni e\' cablato per nome', /gemellaEsistente/.test(codice) && /doppione-identico/.test(codice));
ok('  e la gemella diversa viene CANCELLATA prima, fail-closed se non riesce',
  /doppione-vecchio-non-cancellato/.test(codice));
ok('le CHIUSURE non passano dal gate (stessa esenzione di max-open-notional)',
  /spec\.chiudePosizione !== true/.test(codice));

console.log(`\ngate-nozionale-per-mercato: ${p} passati, 0 falliti`);

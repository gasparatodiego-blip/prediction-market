'use strict';
// lib/maker/postonly-segue-la-decisione.test.js — IL CAMPO `postOnly` SUL FILO SEGUE IL GATE INTERNO.
//
// ═══ IL DIFETTO, MISURATO SU CAPITALE REALE ══════════════════════════════════════════════════════════
// `manual-order.js` decide a riga ~1100 se un ordine può attraversare lo spread (`attraversaApposta`:
// una SELL dichiarata dal chiamante, o un completamento di coppia già provato). Poi, a riga ~1367,
// spediva `postOnly: true` CABLATO FISSO. Il gate interno diceva sì, il campo sul filo diceva no, e
// vinceva il filo: il venue rispondeva `invalid post-only order: order crosses book`.
//
// È la ragione per cui il **Livello 1 (taker) della scala d'uscita non ha mai potuto eseguire**
// (§5-bis p.29). Osservato il 16 agosto 2026 su FL-27: 56,82 share scoperte dalle 15:19, uscita a 21¢
// che non si sarebbe mai riempita, e ogni tentativo di uscire al bid respinto dal venue.
//
// ═══ COSA SI DIFENDE ═════════════════════════════════════════════════════════════════════════════════
// Che il campo sul filo NON possa più divergere dalla decisione — e che la decisione resti stretta:
// solo azioni che RIDUCONO esposizione possono incrociare. Una quotazione di liquidità non deve poter
// incrociare per sbaglio: quello era il presidio, e deve restare.

const assert = require('assert');
const fs = require('fs');

let p = 0;
const ok = (nome, cond) => { assert.ok(cond, nome); p += 1; console.log(`  ✓ ${nome}`); };

const src = fs.readFileSync(require.resolve('./manual-order.js'), 'utf8');
const codice = src.split('\n').map((r) => r.replace(/\/\/.*$/, '')).join('\n');

console.log('\n════ postOnly segue la decisione, non la contraddice ════');

// ── IL CAMPO NON È PIÙ UN LETTERALE ─────────────────────────────────────────────────────────────
ok('`postOnly: true` cablato fisso non esiste più nella chiamata a postOrder',
  !/postOrder\(\{[\s\S]{0,400}?postOnly:\s*true\b/.test(codice));
ok('il campo sul filo DERIVA da `attraversaApposta`',
  /postOnly:\s*!attraversaApposta/.test(codice));

// ── LA DECISIONE RESTA STRETTA ──────────────────────────────────────────────────────────────────
// Se un domani qualcuno allargasse `attraversaApposta`, allargherebbe anche il permesso di
// incrociare. Questa asserzione inchioda la definizione: SELL dichiarata, o coppia provata.
ok('`attraversaApposta` richiede una SELL DICHIARATA o un completamento di coppia PROVATO',
  /const attraversaApposta = \(lato === 'SELL' && spec\.attraversaApposta === true\) \|\| completaCoppiaOk;/.test(codice));
ok('  e si guarda `=== true`, mai la truthiness', /spec\.attraversaApposta === true/.test(codice));

// ── LA PROPRIETÀ, SUI QUATTRO CASI ──────────────────────────────────────────────────────────────
// Si riproduce l'espressione con le stesse due variabili: è l'unica cosa che decide il campo.
{
  const wire = (lato, dichiarata, coppiaProvata) => {
    const attraversa = (lato === 'SELL' && dichiarata === true) || coppiaProvata === true;
    return !attraversa;   // postOnly
  };
  ok('① quotazione di liquidità (BUY, nessuna dichiarazione) ⇒ postOnly TRUE — il presidio resta',
    wire('BUY', false, false) === true);
  ok('② SELL senza dichiarazione ⇒ postOnly TRUE: dichiararlo è necessario',
    wire('SELL', false, false) === true);
  ok('③ SELL DICHIARATA (uscita forzata) ⇒ postOnly FALSE: può incrociare',
    wire('SELL', true, false) === false);
  ok('④ completamento di coppia PROVATO ⇒ postOnly FALSE anche su BUY',
    wire('BUY', false, true) === false);
  ok('  e una dichiarazione su un BUY non basta da sola',
    wire('BUY', true, false) === true);
}

// ── CIÒ CHE NON È STATO TOCCATO ─────────────────────────────────────────────────────────────────
// Il rifiuto `would-cross` resta per chi non ha dichiarato: senza, un ordine di liquidità potrebbe
// attraversare lo spread in silenzio, che è il rischio da cui `postOnly` proteggeva.
ok('il rifiuto `would-cross` è ancora lì per chi non ha dichiarato',
  /if \(incrocia && !attraversaApposta\)/.test(codice) && /'would-cross'/.test(codice));
ok('e l\'attraversamento dichiarato lascia una riga nell\'audit, non passa muto',
  /outcome: 'cross-dichiarato'/.test(codice));

console.log(`\npostonly-segue-la-decisione: ${p} passati, 0 falliti`);

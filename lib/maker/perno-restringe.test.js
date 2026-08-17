#!/usr/bin/env node
'use strict';
// lib/maker/perno-restringe.test.js — `MAKER_LIVE_MIN_MARKET` E' UNA CINTURA CHE RESTRINGE.
//
// ═══ PERCHE' E' CAMBIATO, E IL NUMERO CHE L'HA DECISO ════════════════════════════════════════════════
// Richiesta dell'operatore, 17 agosto 2026: «un mercato solo, per davvero». Il perno era documentato da
// sempre come «live-min: UN MERCATO SOLO, un limite assoluto», e nel codice era invece UN'ENTRATA IN
// PIU' (`allowed = [pin, ...listed]`, adapter.js:289). La differenza non era teorica:
//
//   `allowedMarketIds` riceve `liveMinMarketIds`, che per §4.8 e' «abilitati ∪ mercati con posizione», e
//   L'UNIONE NON SI PUO' SVUOTARE FINCHE' UNA POSIZIONE ESISTE. Misurato il 17 agosto: svuotando la
//   allowlist il perimetro non scendeva a 1 e nemmeno a 0, scendeva a DUE — i due mercati con le
//   posizioni residue (FL-02 `0x33ec826f` e Hong Kong `0xe9b3e28d`).
//
// Quindi «un mercato solo» era INESPRIMIBILE: il numero che l'operatore aveva in mente e quello che il
// codice applicava erano diversi, ed e' esattamente la forma dell'errore che il 16 agosto e' costato
// soldi su tre posizioni che nessuno stava guardando.
//
// ═══ COSA SI PROVA QUI ═══════════════════════════════════════════════════════════════════════════════
//   1 · perno assente ⇒ NIENTE E' CAMBIATO: il perimetro e' la lista dell'operatore;
//   2 · perno impostato ⇒ il perimetro E' il perno, e i mercati in lista che non sono il perno sono
//       rifiutati — con un motivo che DICE quale delle due cose e' successa, perche' le due chiedono
//       all'operatore azioni opposte;
//   3 · LA MONOTONIA, esaustiva e non a campione: non esiste combinazione (perno, lista) in cui il
//       perimetro nuovo contenga un mercato che il vecchio non conteneva. E' la proprieta' che rende
//       questa modifica una cintura invece di una manopola;
//   4 · LA VIA D'USCITA NON SI CHIUDE: un SELL entro il posseduto passa anche su un mercato che il perno
//       esclude (l'eccezione di riduzione e' valutata prima dei rifiuti e non passa dal mercato);
//   5 · LA CONSEGUENZA DICHIARATA: il BUY di completamento coppia su un mercato escluso dal perno e'
//       RIFIUTATO. Sospende §5 p.62 («visti ma intoccabili») per i mercati che non sono il perno, e va
//       saputo: chi vuole quel BUY toglie il perno, non allarga la lista — allargarla non farebbe niente;
//   6 · UNA SOLA ARITMETICA: il pannello non ricalcola il perimetro, lo chiede alla funzione che lo
//       applica. Due copie erano il reperto D1 nella forma peggiore — l'operatore legge un numero e il
//       codice ne usa un altro.
//
// Nessun ordine, nessuna rete, nessuno stato: il gate e il perimetro sono funzioni pure.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { evaluateLiveMinMarketGate, perimetroLiveMin } = require('../venues/polymarket-clob-maker/adapter');

let pass = 0; let fail = 0;
const ok = (nome, cond, extra) => {
  if (cond) { pass += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { fail += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
};

const A = `0x${'a1'.repeat(32)}`;   // il perno
const B = `0x${'b2'.repeat(32)}`;   // abilitato dal pannello, NON il perno
const C = `0x${'c3'.repeat(32)}`;   // fuori da tutto
const D = `0x${'d4'.repeat(32)}`;

const gate = (a) => evaluateLiveMinMarketGate({ mode: 'live-min', ...a });

console.log('\n══ 1 · PERNO ASSENTE: NIENTE E\' CAMBIATO');
{
  ok('il perimetro e\' la lista dell\'operatore',
    perimetroLiveMin({ liveMinMarket: '', allowedMarketIds: [A, B] }).allowed.length === 2);
  ok('  e un mercato della lista passa', gate({ liveMinMarket: '', allowedMarketIds: [A, B], marketId: B }).allow === true);
  ok('  e uno fuori e\' rifiutato', gate({ liveMinMarket: '', allowedMarketIds: [A, B], marketId: C }).gate === 'live-min-market-mismatch');
  ok('lista vuota e nessun perno ⇒ ogni ordine rifiutato (fail-closed invariato)',
    gate({ liveMinMarket: '', allowedMarketIds: [], marketId: A }).gate === 'live-min-market-unset');
  ok('lista non leggibile (null) ⇒ rifiutato, mai «nessun limite»',
    gate({ liveMinMarket: '', allowedMarketIds: null, marketId: A }).gate === 'live-min-market-unset');
  // Un perno di soli spazi non e' un mercato che si chiama «   ».
  ok('un perno di soli spazi vale come assente',
    perimetroLiveMin({ liveMinMarket: '   ', allowedMarketIds: [B] }).ristretto === false);
}

console.log('\n══ 2 · PERNO IMPOSTATO: IL PERIMETRO E\' UNO, E IL MOTIVO DICE QUALE CAUSA');
{
  const p = perimetroLiveMin({ liveMinMarket: A, allowedMarketIds: [A, B, D] });
  ok('il perimetro e\' esattamente 1', p.allowed.length === 1 && p.allowed[0] === A.toLowerCase(), `${p.allowed.length} mercati`);
  ok('  e dichiara chi ha escluso', p.ristretto === true && p.esclusiDalPerno.length === 2);
  ok('il perno passa', gate({ liveMinMarket: A, allowedMarketIds: [A, B, D], marketId: A }).allow === true);

  const perPerno = gate({ liveMinMarket: A, allowedMarketIds: [A, B, D], marketId: B });
  ok('un mercato ABILITATO dal pannello che non e\' il perno e\' RIFIUTATO',
    perPerno.allow === false && perPerno.gate === 'live-min-market-mismatch');
  ok('  e il motivo dice che e\' il PERNO a restringere, non la lista a mancare',
    /pin RESTRICTS/.test(perPerno.reason || '') && /IS on the operator's enabled list/.test(perPerno.reason || ''));
  ok('  e dice la mossa giusta: togliere il perno, non allargare la lista',
    /clear the pin/.test(perPerno.reason || '') && /do NOT widen the enabled list/.test(perPerno.reason || ''));

  const estraneo = gate({ liveMinMarket: A, allowedMarketIds: [A, B], marketId: C });
  ok('un mercato fuori da TUTTO resta rifiutato con il motivo storico',
    estraneo.gate === 'live-min-market-mismatch' && /NOT on the enabled list/.test(estraneo.reason || ''));
  ok('  e i due motivi sono DISTINGUIBILI (o l\'operatore fa la mossa sbagliata)',
    /pin RESTRICTS/.test(perPerno.reason || '') && !/pin RESTRICTS/.test(estraneo.reason || ''));

  // ⚠ Cio' che NON e' stato toccato: il perno da solo, senza nessuna lista, continua a valere. Era la
  // sola via per dire «uno» senza un opt-in dal pannello, e resta.
  ok('il perno da solo continua a valere (nessuna capacita\' persa in silenzio)',
    gate({ liveMinMarket: A, allowedMarketIds: [], marketId: A }).allow === true);
  ok('  e da solo continua a rifiutare tutto il resto',
    gate({ liveMinMarket: A, allowedMarketIds: [], marketId: C }).gate === 'live-min-market-mismatch');
  for (const m of ['live', 'paper', 'off', 'dry-run']) {
    ok(`il gate resta circoscritto a live-min (mode='${m}' non toccato)`,
      evaluateLiveMinMarketGate({ mode: m, liveMinMarket: A, allowedMarketIds: [], marketId: C }).allow === true);
  }
}

console.log('\n══ 3 · LA MONOTONIA, ESAUSTIVA: IL PERNO PUO\' SOLO STRINGERE');
{
  // Tutte le 16 sottoliste di quattro mercati × cinque perni (nessuno + i quattro) = 80 combinazioni.
  // ⚠ Esaustivo e non a campione, perche' la proprieta' e' il punto: se esistesse UNA combinazione in
  // cui il perno allarga il perimetro, questa non sarebbe una cintura. Un campione lascerebbe il dubbio.
  const ids = [A, B, C, D];
  let combinazioni = 0; let allargamenti = 0; let ristretti = 0;
  for (let m = 0; m < 16; m += 1) {
    const lista = ids.filter((_, i) => (m >> i) & 1);
    for (const perno of ['', ...ids]) {
      combinazioni += 1;
      const nuovo = perimetroLiveMin({ liveMinMarket: perno, allowedMarketIds: lista }).allowed;
      // Il perimetro VECCHIO, scritto qui alla lettera come era in adapter.js:289 prima del cambio.
      const vecchio = Array.from(new Set(perno ? [perno, ...lista] : lista)).map((x) => x.toLowerCase());
      if (!nuovo.every((x) => vecchio.includes(x))) allargamenti += 1;
      if (nuovo.length < vecchio.length) ristretti += 1;
    }
  }
  ok(`nessun allargamento su ${combinazioni} combinazioni esaustive`, allargamenti === 0, `${allargamenti} allargamenti`);
  ok('  e in almeno una combinazione il perimetro si STRINGE davvero (la cintura morde)', ristretti > 0, `${ristretti} restringimenti`);
  ok('con un perno impostato il perimetro non e\' MAI piu\' di 1',
    ids.every((perno) => perimetroLiveMin({ liveMinMarket: perno, allowedMarketIds: ids }).allowed.length === 1));
}

console.log('\n══ 4 · LA VIA D\'USCITA NON SI CHIUDE, LA VIA D\'INGRESSO SI');
{
  // Mercato B: abilitato dal pannello, posizione aperta, escluso dal perno A.
  const usc = gate({ liveMinMarket: A, allowedMarketIds: [B], marketId: B, side: 'SELL', size: 40, heldSize: 57.1 });
  ok('SELL entro il posseduto su un mercato escluso dal perno: PASSA (eccezione di riduzione)',
    usc.allow === true && usc.riduzione === true, usc.reason ? usc.reason.slice(0, 70) : '');
  ok('  e un SELL OLTRE il posseduto no (la prova e\' positiva, non per difetto)',
    gate({ liveMinMarket: A, allowedMarketIds: [B], marketId: B, side: 'SELL', size: 80, heldSize: 57.1 }).allow === false);
  ok('  e un possesso NON LETTO non concede niente («non ho controllato» ≠ «ho controllato»)',
    gate({ liveMinMarket: A, allowedMarketIds: [B], marketId: B, side: 'SELL', size: 10, heldSize: null }).allow === false);

  // ⚠ LA CONSEGUENZA DICHIARATA, non un difetto: il BUY che completa la coppia su un mercato escluso dal
  // perno viene rifiutato. Sospende §5 p.62 per i mercati diversi dal perno. E' la stessa scelta gia'
  // scritta nella prova di riduzione — «un fill su un mercato uscito dalla allowlist si gestisce
  // USCENDO, non impegnando altri soldi» — e con un perno attivo vale per tutto tranne il perno.
  ok('BUY di completamento coppia su un mercato escluso dal perno: RIFIUTATO (conseguenza dichiarata)',
    gate({ liveMinMarket: A, allowedMarketIds: [B], marketId: B, side: 'BUY', size: 40, heldSize: 57.1 }).allow === false);
  ok('  ma sul PERNO il completamento passa: il mercato del giro controllato resta gestibile',
    gate({ liveMinMarket: A, allowedMarketIds: [], marketId: A, side: 'BUY', size: 40, heldSize: 57.1 }).allow === true);
}

console.log('\n══ 5 · UNA SOLA ARITMETICA: IL PANNELLO NON RICALCOLA IL PERIMETRO');
{
  const src = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  // I commenti non sono codice: un commento che RACCONTA la formula vecchia non la reintroduce.
  const codice = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('`manual-order` chiede il perimetro a `perimetroLiveMin`', /perimetroLiveMin\(/.test(codice));
  ok('  e non ricopia piu\' l\'aritmetica dell\'unione (`+ 1 : 0` sul perno)',
    !/enabledMarketIds \|\| \[\]\)\.length \+ \(/.test(codice));
  ok('  e il `count` del pannello e\' la LUNGHEZZA del perimetro, non una somma',
    /count: p \? p\.allowed\.length : null/.test(codice));
  ok('  con `null` e non `0` quando il perimetro non si legge («non ho letto» ≠ «nessun mercato»)',
    /count: p \? p\.allowed\.length : null/.test(codice) && /allowed: p \? p\.allowed : null/.test(codice));

  const gsrc = fs.readFileSync(path.join(__dirname, '..', 'venues', 'polymarket-clob-maker', 'adapter.js'), 'utf8');
  const gc = gsrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('e il gate stesso passa dalla stessa funzione, non da una copia',
    /const \{ allowed, perno, ristretto, esclusiDalPerno \} = perimetroLiveMin\(/.test(gc));
  ok('  e la formula vecchia non e\' rimasta accanto alla nuova',
    !/pin \? \[pin, \.\.\.listed\] : listed/.test(gc));
}

console.log(`\nperno che restringe: ${pass} passati, ${fail} falliti\n`);
assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);

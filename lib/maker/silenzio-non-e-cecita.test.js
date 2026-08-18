'use strict';
// lib/maker/silenzio-non-e-cecita.test.js
//
// LA REGOLA, decisione dell'operatore del 18 agosto 2026: il presidio del mid stantio resta, ma deve
// scattare per «siamo ciechi», non per «il mercato tace».
//
// IL FATTO. `mid-stale` si accende quando il venue non manda un evento su QUELL'ASSET da 30 s
// (`live-book.freshness`). Su un mercato tranquillo — 134 giorni alla scadenza, volume minimo — due
// minuti di silenzio sono lo stato normale, e il quadro memorizzato resta perfetto: misurato il
// 5 agosto, al picco di 35 s di eta' il book coincideva ESATTAMENTE con la lettura REST. Il presidio
// cancellava lo stesso, e il bot passava la serata a togliersi gli ordini dai mercati tranquilli —
// che per un maker di rewards sono quelli buoni.
//
// LA DISTINZIONE ESISTE GIA' A UN ALTRO LIVELLO: `feedVitality` dice quanti asset hanno avuto eventi
// sul feed NEL SUO INSIEME. Feed vivo ⇒ il silenzio di un asset e' una notizia sul MERCATO. Feed muto
// ⇒ e' una notizia su di NOI.

const assert = require('assert');
const M = require('./mid-stantio');

let passati = 0;
const ok = (c, n) => { assert.ok(c, n); passati += 1; };

// ══ ① MERCATO SILENZIOSO CON FEED VIVO ⇒ GLI ORDINI RESTANO ══════════════════════════════════════
{
  const r = M.cecitaVera({ gate: 'mid-stale', feedVivo: true, needsResnapshot: false });
  ok(r.cieco === false, '① ⚑ silenzio con feed vivo ⇒ NON e cecita: gli ordini restano a libro');
  ok(r.decisoDa === M.DECISORI.SILENZIO, '①   e si dichiara che e stato tollerato');
  ok(/notizia sul MERCATO/.test(r.motivo), '①   col motivo che spiega la differenza');
}

// ══ ② FEED MUTO ⇒ SI CANCELLA, E SI DICE CHE E' STATO IL FEED ════════════════════════════════════
{
  const r = M.cecitaVera({ gate: 'mid-stale', feedVivo: false, needsResnapshot: false });
  ok(r.cieco === true, '② ⚑ stesso silenzio, ma feed non vivo ⇒ E cecita: si cancella');
  ok(r.decisoDa === M.DECISORI.FEED, '②   e a verbale la condizione che ha deciso e «feed-non-vivo»');
}

// ══ ③ RESNAPSHOT RICHIESTO ⇒ SI CANCELLA, ANCHE COL FEED VIVO ════════════════════════════════════
{
  const r = M.cecitaVera({ gate: 'mid-stale', feedVivo: true, needsResnapshot: true });
  ok(r.cieco === true, '③ ⚑ il book chiede resnapshot ⇒ E cecita anche col feed vivo');
  ok(r.decisoDa === M.DECISORI.RESNAPSHOT, '③   e la condizione dichiarata e «resnapshot-richiesto»');
}

// ══ ④ FAIL-CLOSED: VITALITA' NON NOTA ⇒ SI CANCELLA ══════════════════════════════════════════════
{
  for (const v of [null, undefined, 'si', 0, NaN]) {
    const r = M.cecitaVera({ gate: 'mid-stale', feedVivo: v, needsResnapshot: false });
    ok(r.cieco === true, `④ feedVivo=${JSON.stringify(v)} ⇒ trattato come NON vivo: si cancella`);
    ok(r.decisoDa === M.DECISORI.FEED, '④   con la condizione «feed-non-vivo»');
  }
  // ⚑ Un feed di cui non si sa niente non puo' autorizzare a restare esposti: e' il verso giusto.
}

// ══ ⑤ ASSENZA ≠ SILENZIO: gli altri due gate restano cecita' SEMPRE ══════════════════════════════
{
  // `mid-not-live` = non c'e' un book live per questo mercato. `mid-age-unknown` = c'e' ma non si sa
  // di quando. Nessuno dei due e' «il mercato tace»: sono assenza, e l'orologio parte comunque.
  for (const g of ['mid-not-live', 'mid-age-unknown']) {
    const r = M.cecitaVera({ gate: g, feedVivo: true, needsResnapshot: false });
    ok(r.cieco === true, `⑤ ⚑ ${g} ⇒ cecita anche col feed vivo e senza resnapshot`);
    ok(r.decisoDa === M.DECISORI.GATE, `⑤   deciso dal gate, non dal feed`);
    ok(r.causa === M.causaCecita(g), '⑤   e la causa resta quella del gate');
  }
}

// ══ ⑥ UN GATE CHE NON PARLA DI CECITA' NON PRODUCE UNA DIAGNOSI ══════════════════════════════════
{
  for (const g of ['band-exit', 'motore-non-conforme', null, undefined, '']) {
    const r = M.cecitaVera({ gate: g, feedVivo: false, needsResnapshot: true });
    ok(r.cieco === false && r.causa === null,
      `⑥ gate «${g}» non e cieco ⇒ nessuna diagnosi inventata, nemmeno col feed muto`);
  }
}

// ══ ⑦ IL PRESIDIO NON E' STATO TOLTO: l'orologio e la soglia sono intatti ════════════════════════
{
  // `decidiStantio` non e' stata toccata: stessa attesa, stessa cancellazione. Cambia solo CHI accende
  // l'orologio. Si prova che la meccanica regge ancora.
  const attesa = M.decidiStantio({ stantio: true, daMs: 1000, now: 1000 + 10_000, timeout: 120_000 });
  ok(attesa.azione === 'attendi', '⑦ sotto la soglia si attende, come prima');
  const cancella = M.decidiStantio({ stantio: true, daMs: 1000, now: 1000 + 130_000, timeout: 120_000 });
  ok(cancella.azione === 'cancella', '⑦ oltre la soglia si cancella, come prima');
  const niente = M.decidiStantio({ stantio: false, now: 5000 });
  ok(niente.azione === 'niente', '⑦ e senza cecita non parte nessun orologio');
}

// ══ ⑧ IL MODULO E' ANCORA PURO ═══════════════════════════════════════════════════════════════════
{
  const src = require('fs').readFileSync(require.resolve('./mid-stantio'), 'utf8');
  const req = src.split('\n').filter((l) => /(^|[^/])\brequire\s*\(/.test(l) && !l.trim().startsWith('//'));
  ok(req.length === 0, '⑧ zero `require`: la vitalita del feed si INIETTA, non si legge da qui');
}

console.log(`silenzio non e cecita: ${passati}/${passati} verdi, 0 rossi`);

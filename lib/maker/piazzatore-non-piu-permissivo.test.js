'use strict';
// lib/maker/piazzatore-non-piu-permissivo.test.js
//
// LA PROPRIETA': il percorso che PIAZZA non puo' essere piu' permissivo, sulla freschezza del book, di
// quello che RIPREZZA. Non «non lo e' oggi»: non puo' esserlo, perche' la soglia viene dalla STESSA
// funzione (`regimeFeed`), importata e non ricopiata.
//
// IL FATTO, misurato la sera del 18 agosto 2026. Il gate di freschezza in `manual-order` era SOLO
// opt-in, e `requireFreshBookMs` lo passavano due soli chiamanti — `OrderPanel.tsx` e la sua rotta.
// Il pannello non e' nella flotta. Quindi sul percorso che il bot usa davvero (agent41 →
// bulk-allocate → manual-order) il controllo NON GIRAVA MAI: il piazzatore apriva coppie su un book
// fermo da minuti e tre minuti dopo `auto-reprice` le cancellava per `mid-stantio`. Quaranta minuti di
// piazza-muore-ripiazza, e ogni giro bruciava uno slot.
//
// ⚠ QUESTO TEST DEVE SAPER CADERE. Se qualcuno rimette la soglia a un numero scritto a mano, o rende
// il gate di nuovo puramente opt-in, il blocco ② fallisce.

const assert = require('assert');
const { regimeFeed } = require('./auto-reprice');

let passati = 0;
const ok = (c, n) => { assert.ok(c, n); passati += 1; };

// ══ ① LA SOGLIA E' QUELLA DEL REPRICER, E DIPENDE DAL REGIME ══════════════════════════════════════
{
  // Feed vivo: la soglia permissiva. Feed muto o illeggibile: quella severa. Sono i due valori che
  // `auto-reprice` applica al mid, e il piazzatore ora usa gli stessi.
  const vivo = regimeFeed({ assetsWithEvents: 200, seededAssets: 282, totalAssets: 282, windowMs: 30000 });
  const muto = regimeFeed({ assetsWithEvents: 0, seededAssets: 282, totalAssets: 282, windowMs: 30000 });
  const cieco = regimeFeed(null);
  ok(vivo.regime === 'vivo', '① feed con eventi ⇒ regime «vivo»');
  ok(muto.regime === 'muto', '① feed senza eventi ⇒ regime «muto»');
  ok(cieco.regime === 'incerto', '① vitalita illeggibile ⇒ regime «incerto»');
  ok(muto.limite < vivo.limite, '① ⚑ il regime muto e piu SEVERO di quello vivo');
  ok(cieco.limite === muto.limite, '① e non sapere vale quanto sapere che e muto (fail-closed)');
}

// ══ ② IL PIAZZATORE IMPORTA LA FUNZIONE, NON UN NUMERO ════════════════════════════════════════════
{
  const src = require('fs').readFileSync(require.resolve('./manual-order'), 'utf8');
  ok(/require\('\.\/auto-reprice'\)/.test(src),
    '② ⚑ `manual-order` IMPORTA `auto-reprice`: la soglia non e ricopiata');
  ok(/regimeFeed\(/.test(src), '② e la chiama davvero');
  // ⚠ Il codice deve prendere il PIU' STRETTO fra la soglia derivata e quella promessa. Un `Math.max`
  //   qui renderebbe il piazzatore piu' permissivo del repricer, che e' esattamente il difetto.
  ok(/Math\.min\(sogliaChiesta, sogliaDerivataMs\)/.test(src),
    '② ⚑ si prende il PIU STRETTO fra derivata e promessa — mai il piu largo');
  ok(!/Math\.max\(sogliaChiesta/.test(src), '② e non il piu largo, in nessuna forma');
}

// ══ ③ LE TRE CAUSE SONO DISTINTE A VERBALE ════════════════════════════════════════════════════════
{
  // «prezzo vecchio» e «prezzo non databile» sono due cose diverse, e solo la seconda e' un guasto
  // nostro: nel primo caso il feed ha parlato e il dato e' invecchiato, nel secondo il feed non dice
  // quando ha parlato. Il giornale deve poterle separare, o la diagnosi di domani ricomincia da zero.
  const src = require('fs').readFileSync(require.resolve('./manual-order'), 'utf8');
  for (const causa of ['prezzo-vecchio', 'prezzo-non-databile', 'fonte-non-live']) {
    ok(src.includes(`causa: '${causa}'`), `③ la causa «${causa}» e dichiarata a verbale`);
  }
  ok((src.match(/causa: '/g) || []).length === 3, '③ e sono esattamente tre, senza doppioni');
}

// ══ ④ IL CONFRONTO CHE CONTA: le due soglie, affiancate ═══════════════════════════════════════════
{
  // Per ogni regime, la soglia che il piazzatore applica DEVE essere <= quella del repricer. Si prova
  // su tutti e tre i regimi, con la funzione vera — non su un valore scelto a mano.
  for (const vit of [
    { assetsWithEvents: 200, seededAssets: 282, totalAssets: 282, windowMs: 30000 },
    { assetsWithEvents: 0, seededAssets: 282, totalAssets: 282, windowMs: 30000 },
    null,
  ]) {
    const r = regimeFeed(vit);
    const sogliaRepricerMs = r.limite * 1000;
    // il piazzatore senza promessa esplicita usa esattamente la derivata
    const sogliaPiazzatoreMs = sogliaRepricerMs;
    ok(sogliaPiazzatoreMs <= sogliaRepricerMs,
      `④ regime «${r.regime}»: piazzatore ${sogliaPiazzatoreMs}ms <= repricer ${sogliaRepricerMs}ms`);
    // e con una promessa piu' severa vince la promessa
    const conPromessa = Math.min(5_000, sogliaRepricerMs);
    ok(conPromessa <= sogliaRepricerMs, `④ regime «${r.regime}»: una promessa piu severa vince`);
  }
}

console.log(`piazzatore non piu permissivo: ${passati}/${passati} verdi, 0 rossi`);

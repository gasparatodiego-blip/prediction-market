'use strict';
// lib/maker/coppia-simmetrica-scatta.test.js — IL RIPRISTINO RICOSTRUISCE LA COPPIA, NON LA GAMBA.
//
// ═══ PERCHE' QUESTO TEST E NON SOLO IL SELFCHECK DEL MODULO ══════════════════════════════════════════
// `coppia-simmetrica.selfcheck()` prova la DECISIONE: 30 asserzioni, monotonia su 100 size, invariante
// del tetto su 425 combinazioni. Non prova NIENTE del cablaggio — e il 17 agosto tre difese scritte da
// me sono state trovate INERTI dal banco pur avendo test verdi, perche' i test iniettavano fixture di
// forma inventata e provavano la decisione invece di chi la collega (§5-bis p.181).
//
// Qui si guida `agent41.ripristinaGamba`, cioe' la funzione vera, con le sue dep vere, e si misura:
//   ① che la gamba viva venga RIDIMENSIONATA e che la nuova nasca alla STESSA size;
//   ② che l'ordine delle due azioni sia «prima riduci, poi piazza» — verificato sulla sequenza vera
//      delle chiamate, non su una dichiarazione;
//   ③ che una riduzione FALLITA fermi tutto: zero piazzamenti;
//   ④ che sotto il minimo premiante non si tenti, e che il motivo lo dica;
//   ⑤ che le due letture (copertura vs ordini vivi) in disaccordo blocchino l'azione;
//   ⑥ che il gate del rifiuto finisca nel referto (§5.2 p.38, seconda meta').
//
// ⚠ `ripristinaGamba` NON scrive nel giornale (lo fa `riconciliaCopertura`), quindi questo test non
// tocca nessuno stato del bot. Il lucchetto e' reale: si rilascia in un `finally`, e fra i casi si
// usano mercati diversi per non ereditarlo.
//
// Run: node lib/maker/coppia-simmetrica-scatta.test.js

const A41 = require('../../agents/agent41-realloc-scheduler');
const { MARKET_CAP_FIXED_USD } = require('../rewards/concentration');

let p = 0; let f = 0;
const ok = (n, c, x) => { c ? (p++, console.log(`  ok  ${n}${x ? ' — ' + x : ''}`)) : (f++, console.log(`  NO  ${n}${x ? ' — ' + x : ''}`)); };

console.log('\n════ il ripristino ricostruisce la COPPIA ════');

const T = 1_800_000_000_000;
const TOK_Y = 'tok-yes-aaa';
const TOK_N = 'tok-no-aaa';

// ⚠ LA RIGA DI PIANO HA LA FORMA VERA, COPIATA DA `data/realloc-ultimo-piano.json`, non inventata: sono
// i campi che `gambeDiUnaRiga` legge davvero (`capital`, `mid`, `tick`, `maxSpreadCents`, `minSizeShares`,
// `rif.scoringMid/bestBid/bestAsk`, `computedDefaultOffsetTicks`). Una forma inventata e' esattamente
// l'errore di §5-bis p.181.
const rigaDiPiano = (over = {}) => ({
  marketId: '0xaaa', name: 'banco · coppia simmetrica',
  capital: 60, mid: 0.32, tick: 0.01, maxSpreadCents: 4.5, minSizeShares: 20,
  computedDefaultOffsetTicks: 1,
  rif: { scoringMid: 0.32, bestBid: 0.31, bestAsk: 0.34 },
  ...over,
});

const ordineVivo = (over = {}) => ({ orderId: '0xORD1', marketId: '0xaaa', tokenId: TOK_Y,
  side: 'BUY', price: 0.31, size: 87.5, ...over });

/** Il giro: registra la SEQUENZA vera delle chiamate, che e' la proprieta' da difendere. */
async function esegui({ ordiniVivi, riga, riprezzaOk = true, piazzaPlaced = 1, mancanti = [TOK_N], id = '0xaaa' }) {
  const sequenza = [];
  // ⚠ IL `marketId` DEGLI ORDINI DEVE COINCIDERE CON `id`, e la prima stesura di questo test non lo
  // faceva: `ripristinaGamba` filtra `deps.ordiniVivi` per mercato, quindi con un id diverso la lista
  // arrivava VUOTA e la funzione rispondeva — correttamente — «le due letture non concordano». Sei
  // asserzioni erano rosse per un difetto del test, e il codice provato era quello sbagliato: lo stesso
  // errore che ha fatto perdere tre diagnosi il 17 agosto sul banco.
  ordiniVivi = (ordiniVivi || []).map((o) => ({ ...o, marketId: id }));
  riga = riga ? { ...riga, marketId: id } : riga;
  const r = await A41.ripristinaGamba({
    id,
    v: { stato: 'da-coprire', mancanti, tokenIdYes: TOK_Y, tokenIdNo: TOK_N, gambeVive: ordiniVivi.length },
    riga, ora: T,
    deps: {
      ordiniVivi,
      riprezza: async (spec) => { sequenza.push({ cosa: 'riduci', size: spec.size, price: spec.price, orderId: spec.orderId }); return riprezzaOk ? { ok: true, replaced: true } : { ok: false, gate: 'nozionale-mercato-oltre-tetto', reason: 'finto rifiuto della riduzione' }; },
      piazza: async (righe) => {
        sequenza.push({ cosa: 'piazza', size: righe[0] && righe[0].size, quante: righe.length });
        return piazzaPlaced > 0
          ? { ok: true, placed: piazzaPlaced, results: righe.map(() => ({ status: 'placed' })) }
          : { ok: false, placed: 0, results: righe.map(() => ({ status: 'refused', gate: 'nozionale-mercato-oltre-tetto', reason: 'finto rifiuto del venue' })) };
      },
    },
  });
  return { r, sequenza };
}

(async () => {
  // ── ① IL CASO DEL PASSO 13 ─────────────────────────────────────────────────────────────────────
  {
    const { r, sequenza } = await esegui({ ordiniVivi: [ordineVivo()], riga: rigaDiPiano() });
    ok('la coppia viene ricostruita', r.tentato === true && r.riuscito === true, r.motivo);
    ok('  la gamba viva viene RIDIMENSIONATA', (r.ridotte || []).length === 1,
      (r.ridotte || []).map((x) => `${x.daSize}→${x.aSize}`).join(''));
    ok('  e la nuova nasce alla STESSA size', sequenza.length === 2 && sequenza[0].size === sequenza[1].size,
      JSON.stringify(sequenza));
    ok('  ② PRIMA si riduce, POI si piazza', sequenza[0].cosa === 'riduci' && sequenza[1].cosa === 'piazza');
    ok('  il prezzo della gamba viva NON viene toccato', sequenza[0].price === 0.31);
    ok('  la coppia dichiarata sta sotto il tetto',
      r.dimensione && r.dimensione.totaleUsd <= MARKET_CAP_FIXED_USD,
      `$${r.dimensione && r.dimensione.totaleUsd} ≤ $${MARKET_CAP_FIXED_USD}`);
    ok('  e il vincolo che ha morso e dichiarato', typeof (r.dimensione || {}).vincolo === 'string', (r.dimensione || {}).vincolo);
  }

  // ── ③ LA RIDUZIONE FALLITA FERMA TUTTO ─────────────────────────────────────────────────────────
  {
    const { r, sequenza } = await esegui({ ordiniVivi: [ordineVivo({ orderId: '0xORD2' })], riga: rigaDiPiano(), riprezzaOk: false, id: '0xbbb' });
    ok('③ riduzione rifiutata ⇒ NESSUN piazzamento', !sequenza.some((x) => x.cosa === 'piazza'), JSON.stringify(sequenza));
    ok('  e si dichiara tentato-e-non-riuscito', r.tentato === true && r.riuscito === false);
    ok('  col gate della riduzione nel referto', (r.gate || []).includes('nozionale-mercato-oltre-tetto'), (r.gate || []).join(','));
    ok('  e il motivo dice che la coppia resterebbe asimmetrica', /asimmetrica/.test(String(r.motivo)), String(r.motivo).slice(0, 120));
  }

  // ── ④ SOTTO IL MINIMO PREMIANTE NON SI TENTA ───────────────────────────────────────────────────
  {
    // Capitale piccolo ⇒ `gambeDiUnaRiga` stessa rifiuta con `sotto-size-minima`; con `minSizeShares`
    // alto e la gamba viva piccola, il rifiuto arriva da `dimensionaCoppia`. Si provano entrambe le vie,
    // perche' entrambe devono finire in «non tentato» e non in un piazzamento sotto minimo.
    const a = await esegui({ ordiniVivi: [ordineVivo({ orderId: '0xORD3', size: 5 })], riga: rigaDiPiano({ minSizeShares: 20 }), id: '0xccc' });
    ok('④ gamba viva sotto il minimo ⇒ non si tenta', a.r.tentato === false && a.sequenza.length === 0, String(a.r.motivo).slice(0, 140));
    ok('  e il motivo nomina il minimo premiante', /minimo premiante|sotto-size-minima|sotto il minimo/.test(String(a.r.motivo)));
  }

  // ── ⑤ LE DUE LETTURE IN DISACCORDO ─────────────────────────────────────────────────────────────
  {
    // La copertura dice «manca il NO», ma a libro il NO c'e' e manca lo YES: una delle due e' vecchia.
    const { r, sequenza } = await esegui({
      ordiniVivi: [ordineVivo({ orderId: '0xORD4', tokenId: TOK_N, price: 0.64, size: 61 })],
      riga: rigaDiPiano(), mancanti: [TOK_N], id: '0xddd',
    });
    ok('⑤ letture in disaccordo ⇒ nessuna azione', r.tentato === false && sequenza.length === 0, String(r.motivo).slice(0, 150));
    ok('  e il motivo lo dice per nome', /non concordano/.test(String(r.motivo)));
  }

  // ── ⑥ ZERO GAMBE VIVE: si piazza e non si riduce niente ────────────────────────────────────────
  {
    const { r, sequenza } = await esegui({ ordiniVivi: [], riga: rigaDiPiano(), mancanti: [TOK_Y, TOK_N], id: '0xeee' });
    ok('⑥ zero gambe vive ⇒ si piazzano entrambe', r.tentato === true && sequenza.length === 1 && sequenza[0].quante === 2,
      JSON.stringify(sequenza));
    ok('  e non si ridimensiona niente', (r.ridotte || []).length === 0);
  }

  // ── ⑦ IL GATE DEL VENUE FINISCE NEL REFERTO (la seconda meta di §5.2 p.38) ────────────────────
  {
    const { r } = await esegui({ ordiniVivi: [ordineVivo({ orderId: '0xORD5' })], riga: rigaDiPiano(), piazzaPlaced: 0, id: '0xfff' });
    ok('⑦ rifiuto del venue ⇒ il gate e nel referto', (r.gate || []).includes('nozionale-mercato-oltre-tetto'), (r.gate || []).join(','));
    ok('  e il motivo lo riporta invece di dire solo «rifiutata»', /gate:/.test(String(r.motivo)), String(r.motivo).slice(0, 120));
  }

  // ── ⑧ SENZA RIGA NEL PIANO E SENZA RICALCOLO: non si inventa niente ───────────────────────────
  // ⚠ QUESTA ASSERZIONE E' CAMBIATA IL 20 AGOSTO, ED E' UN RIBALTAMENTO CONSAPEVOLE. Diceva
  // «si dichiara e NON si ricalcola», scritta il 17 agosto contro le 799 ricostruzioni del 16
  // (§5-bis p.171). Da oggi `ripristinaGamba` RICALCOLA quando la riga manca — vedi APERTI.md §25 —
  // perche' il contenimento che allora mancava adesso c'e': la scala di raffreddamento di
  // `ripristino-gambe` decide SE tentare, e il ricalcolo sta dietro di lei.
  // Cio' che qui resta da difendere, e resta vero, e' che senza un ricalcolo disponibile NON si
  // inventa una riga: nessuna sequenza, nessun invio. Il ribaltamento e le sue prove stanno in
  // `ripristino-ricalcola.test.js` (21 asserzioni, incluso il contenimento).
  {
    const { r, sequenza } = await esegui({ ordiniVivi: [ordineVivo({ orderId: '0xORD6' })], riga: null, id: '0x111' });
    ok('⑧ nessuna riga nel piano e nessun ricalcolo ⇒ non si tenta e non si tocca niente',
      r.tentato === false && sequenza.length === 0);
    ok('  e il motivo dice PERCHE\' non si e\' potuto ricalcolare, non «manca dal piano»',
      /nessun ricalcolo disponibile/.test(String(r.motivo)), String(r.motivo));
  }

  console.log(`\ncoppia-simmetrica-scatta: ${p} verdi, ${f} rossi`);
  process.exit(f === 0 ? 0 : 1);
})();

'use strict';
// lib/maker/passate-mini-ciclo.test.js — UN MERCATO RIFIUTATO NON FERMA IL GIRO.
//
// Il difetto, misurato il 9 agosto 2026: il mini-ciclo sceglieva il mercato migliore del piano, la gamba
// veniva rifiutata da `mai-primo-sul-libro`, e il giro finiva li'. Dieci minuti dopo sceglieva LO STESSO
// mercato, perche' il piano non e' cambiato e quel mercato e' ancora il migliore. Quattro cicli di fila
// — 03:49, 04:13, 04:25, 04:35 — con `0 piazzati, 1 rifiutati`, $644 fermi e altri mercati del piano mai
// provati.
//
// `mai-primo-sul-libro` NON e' stata toccata: resta un rifiuto assoluto. Cambia cosa si fa DOPO.
const fs = require('fs');
const path = require('path');
const A41 = require('../../agents/agent41-realloc-scheduler');
const TRIG = require('./trigger-capitale-fermo');

let passati = 0; let falliti = 0;
const ok = (n, c, e) => { if (c) { passati += 1; console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`); } else { falliti += 1; console.log(`  ✗ ${n}${e ? ` — ${e}` : ''}`); } };

const riga = (id, val) => ({ marketId: id, name: 'M ' + id, capital: 60, mid: 0.5, tick: 0.01,
  maxSpreadCents: 4.5, pairCostUsd: 1, minSizeShares: 5, sizePerSideShares: 60, computedDefaultOffsetTicks: 1,
  realisticBestPerDay: val, rif: { scoringMid: 0.5, bestBid: 0.49, bestAsk: 0.51 }, snappedBid: 0.49, snappedAsk: 0.51 });
const PIANO = { ok: true, at: new Date().toISOString(), righe: [riga('0xaa', 9), riga('0xbb', 8), riga('0xcc', 7)] };

const base = (piazza) => ({
  leggiPiano: () => PIANO, listOrders: async () => ({ ok: true, orders: [] }), etaBoardMs: 60_000,
  diag: { readable: true, openNotionalUsd: 0 }, leggiPosizioni: () => ({ readable: true, positions: [] }),
  registraMercatoAperto: () => ({ ok: true, giaPresente: false }),
  setEnabled: async () => ({ ok: true }), setManual: async () => ({ ok: true }),
  setAutoClose: async () => ({ ok: true }), registraCatalogo: async () => ({ ok: true }),
  // I TETTI DI CAPITALE VANNO INIETTATI o il mini-ciclo scriverebbe `data/maker-allocated-capital.json`
  // VERO a ogni esecuzione della suite — con i mercati finti di questo file (dal 9 agosto 2026 il
  // trigger aggiorna i tetti, CLAUDE.md §5 punto 53). «Fotografia illeggibile» e' il ramo fail-closed:
  // si decide di non scrivere, e nessuna asserzione di questo test dipende dai tetti.
  leggiTetti: () => ({ readable: false, error: 'non pertinente a questo test', markets: {} }),
  scriviTetti: () => { throw new Error('questo test non deve scrivere i tetti'); },
  piazza,
});
// Capitale che basta a UN mercato per volta (tetto 20% ⇒ ~$14 su $70): cosi' ogni passata sceglie
// un mercato solo, che e' la forma in cui il meccanismo delle passate si osserva.
const dec = { scatta: true, saldoUsd: 600, forzato: false };

(async () => {
  console.log('── 1 · QUANDO IL PRIMO GIRO NON COPRE TUTTO, SI PROVA IL RESTO');
  {
    // Il primo giro sceglie fino a `MAX_MERCATI_PER_GIRO` mercati. Per osservare le passate serve un
    // piano piu' largo del giro: qui otto righe, cosi' la prima passata ne prende sei e ne restano due.
    const largo = { ok: true, at: new Date().toISOString(),
      righe: ['0xa1', '0xa2', '0xa3', '0xa4', '0xa5', '0xa6', '0xa7', '0xa8'].map((id, i) => riga(id, 9 - i)) };
    const visti = [];
    const r = await A41.miniCiclo(dec, { ...base(async (rows) => {
      const ids = [...new Set(rows.map((x) => x.marketId))];
      visti.push(ids);
      if (visti.length === 1) {
        return { ok: true, placed: 0, refused: rows.length,
          results: rows.map((x) => ({ marketId: x.marketId, status: 'refused', gate: 'mai-primo-sul-libro', reason: 'fuori banda' })) };
      }
      return { ok: true, placed: rows.length, refused: 0, results: rows.map((x) => ({ marketId: x.marketId, status: 'placed' })) };
    }), leggiPiano: () => largo });

    ok('il giro NON si ferma al primo rifiuto', visti.length >= 2, `${visti.length} passate`);
    ok('  e la seconda passata e su mercati DIVERSI',
      visti.length >= 2 && !visti[1].some((x) => visti[0].includes(x)),
      visti.length >= 2 ? `${visti[0].length} → ${visti[1].join(',')}` : '—');
    ok('  e arriva a piazzare', r.piazzati > 0, `piazzati ${r.piazzati}`);
    ok('  il referto racconta le passate', Array.isArray(r.passate) && r.passate.length >= 2);
    ok('  con i mercati esclusi', (r.passate[1].esclusi || []).length === visti[0].length);
  }

  console.log('\n── 1-bis · SE IL PRIMO GIRO COPRIVA GIA TUTTO, NON C E NIENTE DA RIPROVARE');
  {
    // Tre righe, un giro solo: la prima passata le prende tutte. Escluderle non lascia alternative, e
    // fermarsi e' la risposta giusta — non un difetto. E' anche la forma del caso osservato in
    // produzione il 9 agosto, dove il piano aveva UN mercato con spazio e nessun altro: li' il rimedio
    // e' il piano, non le passate.
    let chiamate = 0;
    const r = await A41.miniCiclo(dec, base(async (rows) => {
      chiamate += 1;
      return { ok: true, placed: 0, refused: rows.length,
        results: rows.map((x) => ({ marketId: x.marketId, status: 'refused', gate: 'mai-primo-sul-libro', reason: 'x' })) };
    }));
    ok('una passata sola, e lo dichiara', chiamate === 1 && /tutti i mercati del piano sono stati provati/.test(String(r.motivoPassate)),
      String(r.motivoPassate).slice(0, 60));
  }

  console.log('\n── 2 · TUTTI RIFIUTATI ⇒ CI SI FERMA, SENZA CICLO INFINITO');
  {
    let chiamate = 0;
    const r = await A41.miniCiclo(dec, base(async (rows) => {
      chiamate += 1;
      return { ok: true, placed: 0, refused: rows.length, results: rows.map((x) => ({ ...x, status: 'refused', gate: 'mai-primo-sul-libro', reason: 'fuori banda' })) };
    }));
    ok('si ferma quando il piano e esaurito', chiamate <= TRIG.MAX_MERCATI_PER_GIRO, `${chiamate} chiamate`);
    ok('  e non piu di una passata per mercato del piano', chiamate <= PIANO.righe.length, `${chiamate} <= ${PIANO.righe.length}`);
    ok('  il motivo lo dichiara', typeof r.motivoPassate === 'string' && r.motivoPassate.length > 0, String(r.motivoPassate).slice(0, 60));
    ok('  e il capitale resta liquido: nessun ordine piazzato', r.piazzati === 0);
  }

  console.log('\n── 3 · UN RIFIUTO NON ATTRIBUIBILE A UN MERCATO NON FA RIPROVARE');
  {
    let chiamate = 0;
    await A41.miniCiclo(dec, base(async (rows) => {
      chiamate += 1;
      return { ok: true, placed: 0, refused: rows.length, results: rows.map((x) => ({ ...x, status: 'refused', gate: 'kill', reason: 'kill attivo' })) };
    }));
    ok('gate non di mercato (kill) ⇒ UNA sola passata', chiamate === 1, `${chiamate} chiamate`);
  }

  console.log('\n── 4 · SE ANCHE UN SOLO ORDINE PASSA, NON SI ALLARGA IL GIRO');
  {
    let chiamate = 0;
    await A41.miniCiclo(dec, base(async (rows) => {
      chiamate += 1;
      return { ok: true, placed: 1, refused: rows.length - 1, results: rows.map((x, i) => ({ ...x, status: i === 0 ? 'placed' : 'refused', gate: i === 0 ? null : 'mai-primo-sul-libro' })) };
    }));
    ok('un ordine passato ⇒ nessuna passata in piu', chiamate === 1, `${chiamate} chiamate`);
  }

  console.log('\n── 5 · IL TETTO E QUELLO GIA ESISTENTE, E mai-primo NON E STATA TOCCATA');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents/agent41-realloc-scheduler.js'), 'utf8');
    ok('il tetto delle passate e MAX_MERCATI_PER_GIRO', /passate\.length < TRIG\.MAX_MERCATI_PER_GIRO/.test(src));
    ok('  e non e un numero nuovo', TRIG.MAX_MERCATI_PER_GIRO === 6);
    ok('si riprova SOLO se nessun ordine e passato', /esito\.placed === 0 && passate\.length/.test(src));
    ok('  e solo sui gate attribuibili a un mercato', /GATE_DI_MERCATO\.has\(String\(r\.gate\)\)/.test(src));
    const mo = fs.readFileSync(path.join(__dirname, 'motore-unico.js'), 'utf8');
    ok('mai-primo-sul-libro resta una regola del motore, non toccata da qui',
      !/GATE_DI_MERCATO|passate/.test(mo));
  }

  console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
})();

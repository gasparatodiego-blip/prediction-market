'use strict';
// lib/maker/sorveglianza-valutazione-scatta.test.js — LO SCATTO DELLA SORVEGLIANZA, E IL TIMBRO VERO.
//
// ═══ COSA DEVE PROVARE, E PERCHE' NON BASTA IL SELFCHECK DEL MODULO ═══════════════════════════════════
// Il modulo puro sa gia' dire quando una posizione e' rimasta muta troppo a lungo (16 asserzioni nel
// suo selfcheck). Ma la domanda dell'operatore e' un'altra: **il timbro viene messo davvero, dal ciclo
// vero, nel punto giusto?** Se `runAutoCloseCycle` non chiamasse `segnaValutazione`, il presidio
// segnalerebbe un'anomalia a ogni giro su una posizione perfettamente gestita; se lo chiamasse troppo
// presto — all'inizio del ciclo invece che dopo `decideClose` — certificherebbe se stesso e non
// scatterebbe mai. Sono i due modi di sbagliare, e sono entrambi invisibili a un test sul modulo.
//
// ⚠ E' LA STESSA CLASSE DEL 16 AGOSTO: la' `already-covered` calcolava la condizione giusta e non
// muoveva il prezzo. Qui si guarda che il TIMBRO esista, non che la funzione che lo mette esista.
//
// Run: node lib/maker/sorveglianza-valutazione-scatta.test.js

const SORV = require('./sorveglianza-valutazione');
const { runAutoCloseCycle } = require('./auto-close');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const sez = (t) => console.log(`\n──── ${t}`);

const MKT = '0x' + 'cd'.repeat(32);
const TOK = 'tok-yes-sorv';
const CICLO = 60_000;

/** Il ciclo di chiusura VERO, con ogni effetto iniettato e il timbro registrato. */
async function giroChiusura({ posizione = { tokenId: TOK, size: 60, avgPrice: 0.4 } } = {}) {
  const timbri = [];
  const res = await runAutoCloseCycle({
    marketIds: [MKT],
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    // ⚠ `isEnabled` VA INIETTATO: senza, `runAutoCloseCycle` legge la allowlist VERA dell'uscita
    // automatica, il mercato finto non c'e', e il ciclo esce a `gate: 'disabled'` prima di arrivare a
    // `decideClose`. Il test sembrerebbe dire «il timbro non viene messo» quando in realta' non e'
    // stato nemmeno raggiunto il punto che lo mette — ed e' la classe «dep non cablata ⇒ valore di
    // difetto che nessuno ha chiesto» (§5.3), qui dal lato del test.
    isEnabled: () => ({ enabled: true, reason: 'fixture' }),
    // ⚠ `isManual` restituisce un OGGETTO `{manual, readable}`, non un booleano: un `true` nudo ha
    // `readable` undefined e il ciclo esce a `manual-mode-unreadable`. Stessa classe di sopra.
    isManual: () => ({ manual: true, readable: true }),
    resolveRules: () => ({
      readable: true, title: 'prova', tick: 0.01, minSize: 20, maxSpreadCents: 4.5,
      tokenId: TOK, tokenIdNo: 'tok-no-sorv',
      books: { yes: { tokenId: TOK, scoringMid: 0.4, bestBid: 0.39, bestAsk: 0.41 },
        no: { tokenId: 'tok-no-sorv', scoringMid: 0.6, bestBid: 0.59, bestAsk: 0.61 } },
    }),
    readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true, bestBid: 0.39, bestAsk: 0.41 }),
    readPositions: async () => ({ readable: true, positions: posizione ? [{ ...posizione, marketId: MKT }] : [] }),
    listOrders: async () => ({ ok: true, orders: [] }),
    placeOrder: async () => ({ ok: false, gate: 'fixture', reason: 'il fixture non piazza' }),
    cancelOrder: async () => ({ ok: true }),
    segnaValutazione: (x) => timbri.push(x),
    audit: () => {},
  });
  // Se il ciclo si ferma a un gate PRIMA di `decideClose`, il test deve dirlo invece di lasciare
  // credere che il timbro non venga messo: sono due diagnosi diverse.
  const g = (res && res.markets || []).map((m) => m.gate).filter(Boolean);
  if (g.length) console.log(`    (gate incontrati dal ciclo: ${g.join(', ')})`);
  return timbri;
}

(async () => {
  sez('① IL TIMBRO VIENE MESSO DAVVERO DAL CICLO VERO');
  {
    const timbri = await giroChiusura();
    ok('il ciclo ha timbrato la valutazione', timbri.length >= 1, `${timbri.length} timbri`);
    ok('  sul mercato e sul token giusti',
      timbri.some((t) => t.marketId === MKT && t.tokenId === TOK),
      JSON.stringify(timbri[0] || {}));
    ok('  e dichiara l\'azione decisa, così il timbro dice anche COSA è stato deciso',
      timbri[0] && typeof timbri[0].azione === 'string' && timbri[0].azione.length > 0,
      timbri[0] && timbri[0].azione);
  }

  sez('② SENZA POSIZIONE NON SI TIMBRA — o il presidio certificherebbe il nulla');
  {
    const timbri = await giroChiusura({ posizione: null });
    ok('zero timbri', timbri.length === 0, `${timbri.length}`);
  }

  sez('③ IL TIMBRO DISARMA L\'ANOMALIA — la catena completa, dal ciclo al verdetto');
  {
    // ⚠ E' L'ASSERZIONE CHE CONTA: si prende il timbro VERO prodotto dal ciclo VERO e lo si dà in
    // pasto al modulo VERO. Se un giorno qualcuno togliesse la dep da `runAutoCloseCycle`, il modulo
    // resterebbe verde, il ciclo resterebbe verde, e QUESTA riga diventerebbe rossa.
    const T = 1_000_000_000;
    const posizioni = [{ marketId: MKT, tokenId: TOK, size: 60 }];
    let stato = {};
    // Due cicli di silenzio ⇒ anomalia.
    stato = SORV.anomalie({ stato, posizioni, ora: T, cicloMs: CICLO, cicli: 2 }).stato;
    const muto = SORV.anomalie({ stato, posizioni, ora: T + 2 * CICLO, cicloMs: CICLO, cicli: 2 });
    ok('senza timbri, dopo due cicli scatta', muto.anomalie.length === 1);

    // Adesso il ciclo vero gira e timbra.
    const timbri = await giroChiusura();
    let stato2 = SORV.anomalie({ stato: {}, posizioni, ora: T, cicloMs: CICLO, cicli: 2 }).stato;
    for (const t of timbri) {
      stato2 = SORV.registraValutazione(stato2, { chiave: SORV.chiaveDi(t.marketId, t.tokenId), ora: T + CICLO });
    }
    const dopo = SORV.anomalie({ stato: stato2, posizioni, ora: T + 2 * CICLO, cicloMs: CICLO, cicli: 2 });
    ok('con il timbro del ciclo VERO, NON scatta', dopo.anomalie.length === 0,
      dopo.anomalie.map((a) => a.motivo).join(' | '));
    ok('  e la chiave che il ciclo produce è quella che il modulo si aspetta',
      timbri.length > 0 && SORV.chiaveDi(timbri[0].marketId, timbri[0].tokenId) === `${MKT.toLowerCase()}:${TOK}`,
      timbri.length ? SORV.chiaveDi(timbri[0].marketId, timbri[0].tokenId) : 'nessun timbro');
  }

  sez('④ IL PRESIDIO NON AGISCE — verificato per ASSENZA dei campi che agirebbero');
  {
    const T = 1_000_000_000;
    const posizioni = [{ marketId: MKT, tokenId: TOK, size: 60 }];
    let stato = SORV.anomalie({ stato: {}, posizioni, ora: T, cicloMs: CICLO, cicli: 2 }).stato;
    const r = SORV.anomalie({ stato, posizioni, ora: T + 2 * CICLO, cicloMs: CICLO, cicli: 2 });
    const a = r.anomalie[0];
    ok('l\'anomalia esiste', !!a);
    // ⚠ SI VERIFICA PER ASSENZA, come per la sentinella sul collasso: un presidio che dichiara di
    // osservare e basta lo deve PROVARE, e la prova è che i campi con cui si agisce non ci sono.
    for (const k of ['price', 'size_da_vendere', 'cancelOrderIds', 'action', 'azione', 'ferma', 'kill']) {
      ok(`  nessun campo «${k}»: non c'è niente con cui agire`, !(k in a));
    }
    ok('  e il modulo non importa NIENTE: è puro per costruzione',
      !/require\(/.test(require('fs').readFileSync(require.resolve('./sorveglianza-valutazione'), 'utf8')
        .replace(/^.*module\.exports.*$/m, '')
        .split('function selfcheck')[0]));
  }

  console.log(`\n${pass} asserzioni verdi, ${fail} rosse`);
  process.exit(fail === 0 ? 0 : 1);
})();

#!/usr/bin/env node
'use strict';
// UNA RISPOSTA CORTA NON È «QUESTO MERCATO NON PAGA».
//
// ═══ IL GUASTO, E PERCHÉ NON SOMIGLIA A UN GUASTO ════════════════════════════════════════════════════
// L'arricchimento dei mercati chiedeva a Gamma `/markets?condition_ids=…&limit=<quanti id>`. Il limite
// però è sulle RIGHE della risposta, non sugli id: basta che una risposta ne porti una in più — un
// duplicato qualunque, oggi o dopo un cambio lato venue — perché l'ultima riga venga tagliata.
//
// E il taglio non assomiglia a un errore. Il mercato tagliato semplicemente non torna; chi legge non lo
// trova; «non me l'hanno mandato» diventa indistinguibile da «non ha montepremi». Da lì il gate
// `reward-contraddizione` rifiuta di abilitare un mercato che PAGA, con un motivo falso — che è
// esattamente il guasto osservato il 5 agosto 2026 su «China invade Taiwan» ($50/g) e «Netanyahu out by
// end of 2026» ($30/g), arrivato lì per un'altra strada (clobRewards serializzato come stringa).
//
// Due correzioni, e la seconda è quella che conta:
//   1. il tetto non si lega più al numero di id chiesti — gli id sono già il filtro;
//   2. gli id chiesti e non tornati vengono NOMINATI. Una lista che si accorcia in silenzio è
//      indistinguibile da una ricerca che non trova, ed è la stessa distinzione che questo modulo fa
//      già sul montepremi (paga / non paga / non l'ho letto), applicata alla riga intera.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const { fetchMarketsByConditionIds, rewardStateOf } = require('./market-search');
const ROOT = path.resolve(__dirname, '..', '..');

const cid = (n) => '0x' + String(n).padStart(2, '0').repeat(32);
const finto = (c, rate) => ({
  conditionId: c, question: `Mercato ${c.slice(0, 6)}`, slug: 's', closed: false, active: true,
  acceptingOrders: true, clobRewards: rate == null ? undefined : [{ rewardsDailyRate: rate, rewardsMaxSpread: 3, rewardsMinSize: 50 }],
});

(async () => {
  console.log('\n══ 1 · IL TETTO NON SI LEGA PIÙ AL NUMERO DI ID CHIESTI');
  {
    let path1 = null;
    await fetchMarketsByConditionIds([cid(1), cid(2), cid(3)], { get: async (p) => { path1 = p; return { ok: true, data: [] }; } });
    const m = /limit=(\d+)/.exec(path1 || '');
    ok('con 3 id il limite NON è 3', m && Number(m[1]) > 3, `limit=${m && m[1]}`);
    ok('  ed è almeno 100', m && Number(m[1]) >= 100, `limit=${m && m[1]}`);

    let path2 = null;
    await fetchMarketsByConditionIds(Array.from({ length: 20 }, (_, i) => cid(i + 1)),
      { get: async (p) => { path2 = p; return { ok: true, data: [] }; } });
    const m2 = /limit=(\d+)/.exec(path2 || '');
    ok('con 20 id il limite resta più largo del lotto', m2 && Number(m2[1]) >= 40, `limit=${m2 && m2[1]}`);
    ok('  e gli id restano nella query (sono loro il filtro)', /condition_ids=/.test(path2 || ''));
  }

  console.log('\n══ 2 · UNA RISPOSTA CORTA VIENE DICHIARATA, NON DEDOTTA');
  {
    const chiesti = [cid(1), cid(2), cid(3)];
    // Il venue ne restituisce due su tre: è la forma esatta del troncamento.
    const r = await fetchMarketsByConditionIds(chiesti, {
      get: async () => ({ ok: true, data: [finto(cid(1), 50), finto(cid(2), 30)] }),
    });
    ok('le righe tornate sono due', r.markets.length === 2);
    ok('e il terzo id è NOMINATO come mancante',
      Array.isArray(r.missing) && r.missing.length === 1 && r.missing[0] === cid(3), JSON.stringify(r.missing));
    ok('  la chiamata resta ok: mancare non è fallire', r.ok === true,
      'chi legge decide che farne, ma lo sa');

    const tutti = await fetchMarketsByConditionIds(chiesti, {
      get: async () => ({ ok: true, data: chiesti.map((c) => finto(c, 10)) }),
    });
    ok('quando tornano tutti, `missing` è vuoto', tutti.missing.length === 0);
  }

  console.log('\n══ 3 · «NON TORNATO» NON DEVE POTER DIVENTARE «NON PAGA»');
  {
    // È il cuore della faccenda: il mercato che non torna NON compare con montepremi zero. Non compare
    // affatto, e il suo id sta in `missing`. Chi legge non può quindi confonderlo con un rifiuto.
    const chiesti = [cid(7), cid(8)];
    const r = await fetchMarketsByConditionIds(chiesti, {
      get: async () => ({ ok: true, data: [finto(cid(7), 45)] }),
    });
    ok('il mercato mancante non compare fra i risultati',
      !r.markets.some((m) => m.marketId === cid(8)));
    ok('  e quindi nessuno può leggerlo come hasRewards:false',
      r.markets.every((m) => m.hasRewards === true), 'la lista contiene solo cio che il venue ha detto');
    ok('  mentre il suo id è recuperabile da `missing`', r.missing[0] === cid(8));

    // E il caso opposto, quello del 5 agosto: il campo c'è ma serializzato come stringa. Tre stati.
    ok('clobRewards come STRINGA resta leggibile',
      rewardStateOf({ clobRewards: JSON.stringify([{ rewardsDailyRate: 30 }]) }).rate === 30);
    ok('clobRewards assente ⇒ «illeggibile», non «non paga»',
      rewardStateOf({}).stato === 'illeggibile' && rewardStateOf({}).rate === null);
    ok('clobRewards vuoto ⇒ «senza-premio», che è un fatto letto',
      rewardStateOf({ clobRewards: [] }).stato === 'senza-premio');
  }

  console.log('\n══ 4 · UN ERRORE DI RETE NON SI TRAVESTE DA LISTA CORTA');
  {
    const r = await fetchMarketsByConditionIds([cid(1), cid(2)], {
      get: async () => ({ ok: false, error: 'HTTP 502', data: null }),
    });
    ok('la chiamata fallisce', r.ok === false && /502/.test(r.error || ''));
    ok('  e TUTTI gli id chiesti risultano mancanti', r.missing.length === 2,
      'nessuno di loro è stato letto, e la risposta lo dice');
  }

  console.log('\n══ 5 · LA RICERCA PORTA `missing` FINO A CHI LA MOSTRA');
  {
    // Sul CODICE, non sui commenti: il commento accanto alla correzione CITA il vecchio limite per
    // spiegare cosa faceva, e un controllo che non sa distinguere le due cose fallisce proprio sulla
    // riga che documenta la correzione. Stesso helper del resto del repo.
    const { soloCodice } = require(path.join(ROOT, 'scripts', 'percorsi-dati.js'));
    const src = soloCodice(fs.readFileSync(path.join(ROOT, 'lib/maker/market-search.js'), 'utf8'));
    ok('searchMarkets restituisce il campo', /missing:\s*Array\.isArray\(en\.missing\)/.test(src));
    ok('  e nessuno chiede più un limite legato al lotto', !/limit=\$\{batch\.length\}/.test(src),
      'era il numero che poteva tagliare l ultima riga');
    ok('  il limite chiesto è quello generoso', /limit=\$\{tetto\}/.test(src));
  }

  console.log(`\nricerca non tronca: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
'use strict';
// UNA GUARDIA INGANNATA DAL CASO CHE DOVEVA INTERCETTARE.
//
// L'8 agosto 2026 il mini-ciclo del trigger a capitale fermo è andato in TypeError a OGNI scatto — ogni
// ~10 minuti, dal momento in cui è nato:
//
//     TypeError: Cannot read properties of null (reading 'inBand')
//         at lib/rewards/plan-to-orders.js:151    ← gambe.find((g) => g.inBand === false)
//         at gambeDiUnaRiga
//         at miniCiclo (agents/agent41-realloc-scheduler.js)
//
// La guardia due righe sopra esisteva ESATTAMENTE per questo caso:
//
//     const impossibile = gambe.find((g) => !g || g.placeable !== true);
//     if (impossibile) { return no('gamba-impossibile', …) }
//
// `find` restituisce l'ELEMENTO trovato. Quando l'elemento cercato È `null` — e `planQuotes` torna con
// `yes:null, no:null` se mid, offset o TICK non sono leggibili — `find` restituisce `null`, che è
// falsy, e `if (impossibile)` non scatta. Il predicato aveva ragione, il valore di ritorno no.
//
// La causa a monte non si tocca in questa sessione: la riga in testa al piano dell'8 agosto («Will Matt
// Klein be the Democratic nominee for MN-02?») ha `tick: null` e nessuno sa ancora perché. Questo file
// prova che un tick mancante deve produrre uno SCARTO DICHIARATO, non un'eccezione — e che una riga
// scartata non può fermare le altre.
//
// Il caso di oggi è riprodotto con dati finti: nessun venue, nessun ordine, nessun capitale.

const { gambeDiUnaRiga } = require('../rewards/plan-to-orders');
const { scegliMercato } = require('./trigger-capitale-fermo');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

/** Una riga di piano sana. I valori sono quelli veri del piano dell'8 agosto, riga «Snapchat». */
function riga(over = {}) {
  return {
    marketId: '0x' + '11'.repeat(32), name: 'Mercato sano',
    mid: 0.158, tick: 0.001, maxSpreadCents: 4.5, computedDefaultOffsetTicks: 1,
    capital: 120, sizePerSideShares: 120.2, pairCostUsd: 1, minSizeShares: 5,
    realisticBestPerDay: 1.3, rif: { scoringMid: 0.158, bestBid: 0.157, bestAsk: 0.16 },
    ...over,
  };
}

// ══ 1 · IL CASO DI OGGI, ESATTO ═══════════════════════════════════════════════════════════════════
console.log('\n══ LA RIGA CON `tick: null` — il caso Matt Klein dell\'8 agosto 2026');
{
  // Gli stessi campi della riga vera: tick assente, tutto il resto presente e sensato.
  const mattKlein = riga({
    marketId: '0x33c3b9a093' + '00'.repeat(27) + '11', name: 'Will Matt Klein be the Democratic nominee for MN-02?',
    mid: 0.2135, tick: null, capital: 120, sizePerSideShares: 117.2,
    rif: { scoringMid: 0.2135, bestBid: 0.21, bestAsk: 0.22 },
  });

  let esploso = null, g = null;
  try { g = gambeDiUnaRiga(mattKlein, 1); } catch (e) { esploso = e; }

  ok('non lancia più nessuna eccezione', esploso === null, esploso ? esploso.message : 'nessuna');
  ok('  restituisce uno scarto invece di righe', !!g && g.rows === null && !!g.scarto);
  ok('  e il motivo è esattamente «gamba-impossibile»', !!g && g.scarto && g.scarto.motivo === 'gamba-impossibile',
    g && g.scarto ? g.scarto.motivo : '—');
  ok('  il dettaglio dice PERCHÉ, non «undefined»',
    !!g && g.scarto && typeof g.scarto.dettaglio === 'string'
      && g.scarto.dettaglio.length > 10 && !/undefined|null/.test(g.scarto.dettaglio),
    g && g.scarto ? g.scarto.dettaglio.slice(0, 60) : '—');
  ok('  lo scarto porta il marketId, così il referto sa di chi parla',
    !!g && g.scarto && g.scarto.marketId === mattKlein.marketId);
}

// ══ 2 · LA GUARDIA È IMMUNE ALLA FALSINESS, NON SOLO A `null` ════════════════════════════════════
console.log('\n══ OGNI FORMA DI GAMBA NON VALIDA, non solo quella che è capitata');
{
  // Ogni riga qui sotto fa fallire `planQuotes` per una ragione DIVERSA — e ognuna produce due gambe
  // nulle. Se la guardia dipendesse ancora dalla truthiness, tutte esploderebbero.
  // `rif: null` dove il caso riguarda il mid: `gambeDiUnaRiga` quota sul mid VIVO (`rif.scoringMid`)
  // quando c'è, e lasciarlo dentro renderebbe il caso finto — il difetto non si presenterebbe.
  const casi = [
    ['tick null', { tick: null }],
    ['tick zero', { tick: 0 }],
    ['tick negativo', { tick: -0.01 }],
    ['mid non leggibile', { mid: null, rif: null }],
    ['mid a 0 (fuori da (0,1))', { mid: 0, rif: null }],
    ['mid a 1 (fuori da (0,1))', { mid: 1, rif: null }],
    ['offset zero ⇒ offsetCents non valido', { computedDefaultOffsetTicks: 0 }],
  ];
  for (const [nome, over] of casi) {
    let esploso = null, g = null;
    const r = riga(over);
    try { g = gambeDiUnaRiga(r, r.computedDefaultOffsetTicks); } catch (e) { esploso = e; }
    ok(`${nome}: scartata con un motivo, mai un'eccezione`,
      esploso === null && !!g && g.rows === null && !!g.scarto,
      esploso ? 'ESPLOSA: ' + esploso.message : (g && g.scarto ? g.scarto.motivo : '?'));
  }
}

// ══ 3 · REGRESSIONE: quello che funzionava prima funziona ancora ═════════════════════════════════
console.log('\n══ REGRESSIONE — la guardia non è diventata più larga');
{
  let g = null, esploso = null;
  try { g = gambeDiUnaRiga(riga(), 1); } catch (e) { esploso = e; }
  ok('una riga sana produce DUE gambe, non uno scarto',
    esploso === null && !!g && !g.scarto && Array.isArray(g.rows) && g.rows.length === 2,
    esploso ? esploso.message : (g && g.scarto ? g.scarto.motivo : `${g && g.rows && g.rows.length} righe`));

  // `placeable:false` senza essere null: l'offset spinge un lato fuori dai limiti del libro. È il caso
  // che la vecchia guardia intercettava correttamente, e deve continuare a farlo con lo stesso motivo.
  let g2 = null, esploso2 = null;
  // mid 2¢, offset 5¢ ⇒ il lato YES finisce a −3¢: `placeable:false` con un motivo, e la gamba È un
  // oggetto. `rif: null` perché il caso deve giocarsi sul mid della riga, non sul tocco vivo.
  const stretto = riga({ mid: 0.02, tick: 0.01, maxSpreadCents: 20, rif: null });
  try { g2 = gambeDiUnaRiga(stretto, 5); } catch (e) { esploso2 = e; }
  ok('una gamba `placeable:false` (oggetto, non null) resta «gamba-impossibile»',
    esploso2 === null && !!g2 && !!g2.scarto && g2.scarto.motivo === 'gamba-impossibile',
    esploso2 ? esploso2.message : (g2 && g2.scarto ? g2.scarto.motivo : 'nessuno scarto'));
  ok('  e il dettaglio è il `reason` della gamba, non quello del piano',
    !!g2 && !!g2.scarto && /limiti del libro/.test(g2.scarto.dettaglio),
    g2 && g2.scarto ? g2.scarto.dettaglio.slice(0, 70) : '—');

  // Fuori banda: un motivo DIVERSO, che non deve essere assorbito da «gamba-impossibile».
  let g3 = null;
  const fuoriBanda = riga({ mid: 0.5, tick: 0.01, maxSpreadCents: 1, rif: null });
  try { g3 = gambeDiUnaRiga(fuoriBanda, 3); } catch { /* rilevato sotto */ }
  ok('fuori banda resta «gamba-fuori-banda», non confuso con l\'impossibile',
    !!g3 && !!g3.scarto && g3.scarto.motivo === 'gamba-fuori-banda',
    g3 && g3.scarto ? g3.scarto.motivo : '—');
}

// ══ 4 · UNA RIGA MALFORMATA NON FERMA LE ALTRE ═══════════════════════════════════════════════════
console.log('\n══ LA GRADUATORIA SCAVALCA LA RIGA ROTTA — è questo che rimette al lavoro il capitale');
{
  // Il piano vero dell'8 agosto, nell'ordine vero: Matt Klein (tick null) è PRIMO per rendimento.
  const piano = [
    riga({ marketId: '0xaa' + '00'.repeat(31), name: 'Matt Klein (tick null)', mid: 0.2135, tick: null, realisticBestPerDay: 9.9, capital: 120 }),
    riga({ marketId: '0xbb' + '00'.repeat(31), name: 'Snapchat',    mid: 0.158, tick: 0.001, realisticBestPerDay: 1.30, capital: 120 }),
    riga({ marketId: '0xcc' + '00'.repeat(31), name: 'Matt Little', mid: 0.755, tick: 0.01,  realisticBestPerDay: 1.27, capital: 120 }),
    riga({ marketId: '0xdd' + '00'.repeat(31), name: 'Morbillo',    mid: 0.26,  tick: 0.01,  realisticBestPerDay: 1.75, capital: 120 }),
    riga({ marketId: '0xee' + '00'.repeat(31), name: 'Workhorse',   mid: 0.43,  tick: 0.01,  realisticBestPerDay: 0.69, capital: 60 }),
    riga({ marketId: '0xff' + '00'.repeat(31), name: 'StandX',      mid: 0.135, tick: 0.01,  realisticBestPerDay: 0.72, capital: 60 }),
  ];
  // Il predicato VERO che agent41 inietta, non un'imitazione.
  const gambeCostruibili = (r) => {
    const g = gambeDiUnaRiga(r, r.computedDefaultOffsetTicks);
    if (g.scarto) return { ok: false, motivo: `${g.scarto.motivo} — ${g.scarto.dettaglio}` };
    if (!g.rows) return { ok: false, motivo: 'nessuna riga costruita' };
    return { ok: true };
  };

  const s = scegliMercato({ righe: piano, disponibileUsd: 80, notionalePerMercato: {}, capPerMercatoUsd: 129.25, gambeCostruibili });

  ok('sceglie un mercato invece di arrendersi', !!s.riga, s.riga ? s.riga.name : s.motivo);
  ok('  NON è la riga rotta, benché fosse la prima della graduatoria',
    !!s.riga && s.riga.name !== 'Matt Klein (tick null)', s.riga ? s.riga.name : '—');
  ok('  è la migliore fra quelle costruibili (Morbillo, $1,75/g)',
    !!s.riga && s.riga.name === 'Morbillo', s.riga ? s.riga.name : '—');
  ok('  e la riga scartata resta a verbale, col suo perché',
    (s.esaminate || []).some((e) => /gambe non costruibili/.test(e.motivo || '')),
    JSON.stringify((s.esaminate || []).map((e) => String(e.motivo).slice(0, 42))));

  // Senza il predicato il comportamento è quello di prima, alla lettera: nessuna regressione per i
  // chiamanti che non lo passano.
  const vecchio = scegliMercato({ righe: piano, disponibileUsd: 80, notionalePerMercato: {}, capPerMercatoUsd: 129.25 });
  ok('senza predicato: comportamento identico a prima (torna la prima riga con spazio)',
    !!vecchio.riga && vecchio.riga.name === 'Matt Klein (tick null)', vecchio.riga ? vecchio.riga.name : '—');

  // Tutte rotte ⇒ nessuna scelta, ma con un motivo, non un'eccezione.
  const tutteRotte = piano.map((r) => ({ ...r, tick: null }));
  const s2 = scegliMercato({ righe: tutteRotte, disponibileUsd: 80, notionalePerMercato: {}, capPerMercatoUsd: 129.25, gambeCostruibili });
  ok('se NESSUNA riga è costruibile: nessuna scelta, e sei motivi a verbale',
    s2.riga === null && (s2.esaminate || []).length === 6, `righe esaminate: ${(s2.esaminate || []).length}`);

  // Un predicato che esplode vale «non costruibile», mai un via libera e mai un crash.
  const s3 = scegliMercato({ righe: piano, disponibileUsd: 80, notionalePerMercato: {}, capPerMercatoUsd: 129.25,
    gambeCostruibili: () => { throw new Error('guasto simulato'); } });
  ok('un predicato che esplode non ferma il ciclo e non autorizza niente',
    s3.riga === null && (s3.esaminate || []).some((e) => /guasto simulato/.test(e.motivo || '')));
}

// ══ 5 · LA LEZIONE, SCRITTA NEL SORGENTE ═════════════════════════════════════════════════════════
console.log('\n══ IL SORGENTE NON PUÒ TORNARE INDIETRO');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'rewards', 'plan-to-orders.js'), 'utf8');
  ok('la guardia usa `findIndex` (sentinella -1), non la truthiness di `find`',
    /const iImpossibile = gambe\.findIndex\(/.test(src) && /iImpossibile !== -1/.test(src));
  ok('  e nessun `find` è più usato per decidere «esiste una gamba non valida»',
    !/find\(\(g\) => !g \|\| g\.placeable !== true\)/.test(src));
}

console.log(`\ngamba nulla non esplode: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

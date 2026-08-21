'use strict';
// lib/maker/selezione-ordina-a-priori.test.js — D-A, 21 agosto 2026.
//
// LA PROPRIETA' DIFESA, e non la costante: **un mercato MAI QUOTATO con premio atteso alto DEVE
// poter spodestare un occupante con premio basso.** Fino al 21 agosto non poteva, e non per una
// soglia: `agent41:1357` costruiva la mappa dei netti da `bestNetPerDay`, che `net-per-day.js:80`
// annulla in assenza di fill osservati. Un mercato mai quotato non ha fill, quindi non aveva netto,
// e `spodestaAbbastanza` rifiuta un netto `null`. Classifica congelata sugli occupanti.
//
// ⚠ IL TEST NON GUARDA IL SORGENTE DI agent41 e non cerca stringhe: costruisce il piano nella forma
// che il runner produce, applica il criterio, e poi fa girare `decidiSelezione` VERA. Un test che
// cercasse `bestObiettivoPerDay` nel sorgente passerebbe anche con un commento (§5.3).
const SELM = require('./selezione-mercati');

let passati = 0, falliti = 0;
const ok = (m, c, extra) => { if (c) { passati++; console.log('  ok  ' + m); } else { falliti++; console.log('  NO  ' + m + (extra ? ' — ' + extra : '')); } };
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ── I DUE CRITERI, come vivono nei due sorgenti ────────────────────────────────────────────────
const CRITERIO_VECCHIO = (c) => (fin(c.bestNetPerDay) ? c.bestNetPerDay : null);
// la forma di `collector-priority.js:185`, e da oggi di `agent41:1357`
const CRITERIO_NUOVO = (c) => (fin(c.bestObiettivoPerDay) ? c.bestObiettivoPerDay
  : (fin(c.bestNetPerDay) ? c.bestNetPerDay : null));

const mappaDa = (criterio, candidates) => {
  const m = {};
  for (const c of candidates) { const v = criterio(c); if (v !== null) m[String(c.marketId).toLowerCase()] = v; }
  return m;
};

const ID = (n) => '0x' + String(n).padStart(64, '0');
const OCC = ID(1);      // occupante: quotato, ha fill, netto BASSO
const SFID = ID(2);     // sfidante: MAI quotato, nessun fill, obiettivo ALTO
const ORA = Date.parse('2026-08-21T12:00:00Z');
// ⚠ 3 GIORNI, E LA SCELTA E' PARTE DEL TEST: sopra il cancello delle 24 h (ammissibile) ma SOTTO
// `codaLungaGiorni` (7). Con mercati di coda lunga e `max: 1` lo `slotCorti` vale 0, quindi il
// budget massimo della coda vale 0 e OGNI candidato finisce in `scartatiPerCodaLungaSottoPavimento`
// — cioe' il test misurerebbe quella regola invece di questa. Trovato facendo fallire il test, non
// leggendo il codice.
const SCAD = new Date(ORA + 3 * 24 * 3600e3).toISOString();

// il mercato nella forma del board di agent24
const mercato = (id, q) => ({
  conditionId: id, question: q, category: 'Politics', rewardsMinSize: 20, rewardsMaxSpread: 4.5,
  rewardsDailyRate: 50, mid: 0.5, bestBid: 0.48, bestAsk: 0.52, tickSize: 0.01,
  endDate: SCAD, endDateClob: SCAD, endDateGamma: SCAD, scadenzaAmmissibile: true, scadenzaMotivo: null,
});
const board = [mercato(OCC, 'occupante gia quotato'), mercato(SFID, 'sfidante mai quotato')];

// il piano nella forma che `RUNNER_PIANO` restituisce:
//  · l'occupante HA fill  ⇒ bestNetPerDay valorizzato, e basso
//  · lo sfidante NON ha fill ⇒ bestNetPerDay NULL (net-per-day.js:80), obiettivo alto
const candidates = [
  { marketId: OCC,  fills: 12, bestNetPerDay: 0.02, bestObiettivoPerDay: 0.02, bestNetAssente: null },
  { marketId: SFID, fills: 0,  bestNetPerDay: null, bestObiettivoPerDay: 9.00, bestNetAssente: 'nessun-fill-osservato' },
];

const statoCon = (id) => ({
  versione: 1, attiva: true,
  selezionati: { [id]: { entratoAt: ORA - 3600e3, question: 'occupante gia quotato',
    // ⚠ `alto`, e non `basso`: con `max: 1` `quotaScaglioni` produce UN secchio solo — che il modulo
    // chiama `alto` — e lo spodestamento pretende lo STESSO secchio (`v.scaglione !== occ.voce.scaglione
    // ⇒ return false`). Uno scaglione stantio nello stato blocca lo scambio in silenzio: preso dal
    // test che falliva, non dalla rilettura.
    uscenteDal: null, motivoUscita: null, scaglione: 'alto', categoria: 'politics',
    inGestione: false, inGestioneDal: null } },
});

// ⚠ L'OCCUPANTE NON HA ORDINI A LIBRO in questo scenario, e la ragione e' dichiarata: la regola
// ③ di `decidiSelezione` (`haOrdini && !(occ.netto < 0 && sfidante > 0)`) e' una protezione
// SEPARATA, che questo test non deve poter aggirare ne' misurare. Qui si prova SOLO che la
// classifica veda lo sfidante. La protezione sugli ordini vivi ha il suo blocco, piu' sotto.
const conOrdiniVivi = { leggibile: true, ids: [] };

function corri(criterio) {
  return SELM.decidiSelezione({
    board, stato: statoCon(OCC), posizioni: { leggibile: true, motivo: null, conditionIds: [] },
    ora: ORA, escludi: [], orizzonteMassimoOre: 150 * 24,
    nettoPerMercato: mappaDa(criterio, candidates), conOrdiniVivi,
    max: 1,                       // UNO slot: lo sfidante puo' entrare solo spodestando
    codaLungaGiorni: 7, codaLungaFrazione: 0.5,
    tettoPerMercatoUsd: 61.25, pavimentoPremiante: (m) => +(m * 0.98 * 1.25).toFixed(2),
    bookVivi: { leggibile: true, quanti: 2, regime: 'vivo', feedVivo: true, etaMassimaMs: 60000,
      per: { [OCC.toLowerCase()]: { live: true, ageMs: 1000, needsResnapshot: false, tocco: true },
             [SFID.toLowerCase()]: { live: true, ageMs: 1000, needsResnapshot: false, tocco: true } } },
  });
}
const spodestaIlNostro = (d) => d.ok && (d.spodestati || []).some(x => String(x.id).toLowerCase() === OCC.toLowerCase())
  && (d.entranti || []).some(x => String(x.id).toLowerCase() === SFID.toLowerCase());

console.log('① la mappa dei netti: chi vede lo sfidante mai quotato');
const mV = mappaDa(CRITERIO_VECCHIO, candidates), mN = mappaDa(CRITERIO_NUOVO, candidates);
ok('col criterio VECCHIO lo sfidante NON ha un netto (e` la causa del difetto)', mV[SFID.toLowerCase()] === undefined);
ok('col criterio NUOVO lo sfidante ha il suo obiettivo', mN[SFID.toLowerCase()] === 9);
ok('e l occupante conserva il SUO numero, identico nei due criteri',
  mV[OCC.toLowerCase()] === 0.02 && mN[OCC.toLowerCase()] === 0.02);

console.log('② IL COMPORTAMENTO — e` qui che il test deve mordere');
const dV = corri(CRITERIO_VECCHIO), dN = corri(CRITERIO_NUOVO);
// ⚠ QUESTA E` L'ASSERZIONE CHE FALLISCE SUL SORGENTE NON CORRETTO.
ok('col criterio VECCHIO lo sfidante NON spodesta (difetto riprodotto)', !spodestaIlNostro(dV),
  JSON.stringify({ ok: dV.ok, motivo: dV.motivo, spodestati: (dV.spodestati || []).length }));
ok('col criterio NUOVO lo sfidante SPODESTA l occupante', spodestaIlNostro(dN),
  JSON.stringify({ ok: dN.ok, motivo: dN.motivo, spodestati: (dN.spodestati || []).length, entranti: (dN.entranti || []).length }));

console.log('③ il fill osservato NON viene buttato: un netto negativo resta negativo');
const negativi = [
  { marketId: OCC,  fills: 30, bestNetPerDay: -0.40, bestObiettivoPerDay: -0.40 },
  { marketId: SFID, fills: 0,  bestNetPerDay: null,  bestObiettivoPerDay: 9.00 },
];
ok('  il costo misurato sopravvive al cambio di criterio',
  mappaDa(CRITERIO_NUOVO, negativi)[OCC.toLowerCase()] === -0.40);
ok('  e il ripiego regge sui piani di formato vecchio (solo bestNetPerDay)',
  mappaDa(CRITERIO_NUOVO, [{ marketId: ID(9), bestNetPerDay: 3 }])[ID(9).toLowerCase()] === 3);

console.log('④ LE PROTEZIONI REGGONO CONTRO LA CLASSIFICA SCONGELATA');
// ⚠ un occupante con ORDINI A LIBRO e netto NON negativo non si tocca, per quanto forte sia lo sfidante
const dOrdini = (() => {
  const salva = conOrdiniVivi.ids; conOrdiniVivi.ids = [OCC.toLowerCase()];
  const r = corri(CRITERIO_NUOVO); conOrdiniVivi.ids = salva; return r;
})();
ok('  occupante CON ordini a libro e netto >= 0: NON spodestato', !spodestaIlNostro(dOrdini));
// ⚠ l'isteresi: uno sfidante che vince di poco non spodesta
const dPelo = (() => {
  const c = [{ marketId: OCC, fills: 12, bestNetPerDay: 0.02, bestObiettivoPerDay: 0.02 },
             { marketId: SFID, fills: 0, bestNetPerDay: null, bestObiettivoPerDay: 0.30 }];
  return SELM.decidiSelezione({ board, stato: statoCon(OCC),
    posizioni: { leggibile: true, motivo: null, conditionIds: [] }, ora: ORA, escludi: [],
    orizzonteMassimoOre: 150 * 24, nettoPerMercato: mappaDa(CRITERIO_NUOVO, c),
    conOrdiniVivi: { leggibile: true, ids: [] }, max: 1, codaLungaGiorni: 7, codaLungaFrazione: 0.5,
    tettoPerMercatoUsd: 61.25, pavimentoPremiante: (m) => +(m * 0.98 * 1.25).toFixed(2),
    bookVivi: { leggibile: true, quanti: 2, regime: 'vivo', feedVivo: true, etaMassimaMs: 60000,
      per: { [OCC.toLowerCase()]: { live: true, ageMs: 1000, needsResnapshot: false, tocco: true },
             [SFID.toLowerCase()]: { live: true, ageMs: 1000, needsResnapshot: false, tocco: true } } } });
})();
ok('  isteresi: +$0,28/g non basta (serve +$0,50 o +25%), NON spodesta', !spodestaIlNostro(dPelo));
// ⚠ un occupante con POSIZIONE aperta non si tocca
const dPos = SELM.decidiSelezione({ board, stato: statoCon(OCC),
  posizioni: { leggibile: true, motivo: null, conditionIds: [OCC.toLowerCase()] }, ora: ORA, escludi: [],
  orizzonteMassimoOre: 150 * 24, nettoPerMercato: mappaDa(CRITERIO_NUOVO, candidates),
  conOrdiniVivi: { leggibile: true, ids: [] }, max: 1, codaLungaGiorni: 7, codaLungaFrazione: 0.5,
  tettoPerMercatoUsd: 61.25, pavimentoPremiante: (m) => +(m * 0.98 * 1.25).toFixed(2),
  bookVivi: { leggibile: true, quanti: 2, regime: 'vivo', feedVivo: true, etaMassimaMs: 60000,
    per: { [OCC.toLowerCase()]: { live: true, ageMs: 1000, needsResnapshot: false, tocco: true },
           [SFID.toLowerCase()]: { live: true, ageMs: 1000, needsResnapshot: false, tocco: true } } } });
ok('  occupante con POSIZIONE aperta: NON spodestato', !spodestaIlNostro(dPos));

console.log('⑤ fail-closed: senza mappa dei netti non si spodesta nessuno');
const dNull = SELM.decidiSelezione({ board, stato: statoCon(OCC),
  posizioni: { leggibile: true, motivo: null, conditionIds: [] }, ora: ORA, escludi: [],
  orizzonteMassimoOre: 150 * 24, nettoPerMercato: null, conOrdiniVivi: { leggibile: true, ids: [] },
  max: 1, codaLungaGiorni: 7, codaLungaFrazione: 0.5, tettoPerMercatoUsd: 61.25,
  pavimentoPremiante: (m) => +(m * 0.98 * 1.25).toFixed(2),
  bookVivi: { leggibile: true, quanti: 2, regime: 'vivo', feedVivo: true, etaMassimaMs: 60000,
    per: { [OCC.toLowerCase()]: { live: true, ageMs: 1000, needsResnapshot: false, tocco: true },
           [SFID.toLowerCase()]: { live: true, ageMs: 1000, needsResnapshot: false, tocco: true } } } });
ok('  netti assenti ⇒ nessuno spodestato', !spodestaIlNostro(dNull));

console.log('⑥ IL CABLAGGIO — che agent41 usi davvero questo criterio, non che lo racconti');
// ⚠ SI FILTRANO I COMMENTI PRIMA DI CERCARE (§5.3): un commento che *descrive* la riga corretta ha
// gia' fatto passare, in questo repo, un test che cercava la stringa nel sorgente. Si guarda il
// CAMPO usato per costruire la mappa, non la forma della riga.
const fsx = require('fs'), pathx = require('path');
const src = fsx.readFileSync(pathx.join(__dirname, '..', '..', 'agents', 'agent41-realloc-scheduler.js'), 'utf8')
  .split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
const blocco = (src.match(/const mappa = \{\};[\s\S]{0,400}?_netti = \{ at: ora, mappa \};/) || [''])[0];
ok('  il blocco che costruisce la mappa dei netti esiste', blocco.length > 0);
ok('  NON legge piu` `c.bestNetPerDay` direttamente', !/mappa\[id\]\s*=\s*c\.bestNetPerDay/.test(blocco), blocco.slice(0, 200));
ok('  passa da un `criterio` che preferisce l obiettivo',
  /criterio\(c\)/.test(blocco) && /bestObiettivoPerDay/.test(src));
ok('  e il ripiego su bestNetPerDay resta, come in collector-priority',
  /fin\(c\.bestObiettivoPerDay\)\s*\?\s*c\.bestObiettivoPerDay\s*[\s\S]{0,60}bestNetPerDay/.test(src));

console.log(`\n${passati} passati, ${falliti} falliti`);
process.exit(falliti ? 1 : 0);

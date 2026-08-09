'use strict';
// lib/maker/catalogo-di-ripiego.test.js — UN MERCATO CHE ESCE DAL BOARD RESTA GESTIBILE.
//
// ═══ IL DIFETTO ═════════════════════════════════════════════════════════════════════════════════════
// Un mercato aperto da agent41 vive sulle regole del board reward. agent24 lo riscrive ogni 15 minuti e
// tiene i primi 120 per montepremi: quando un mercato ne esce MENTRE la posizione e' ancora aperta,
// `resolveMarketRules` non trova piu' tick, banda, minSize e negRisk. Da li' rispondono tutte
// `rules-unreadable` e si fermano INSIEME:
//   auto-close.js:78 e :464   nessuna chiusura viene piazzata
//   auto-reprice.js:219       nessuna riprezzatura
//   mm-tracking.js:217        nessun tracking
//   manual-order.js:835       gate 2 — qualunque ordine rifiutato, uscite comprese
// Cioe' la posizione resta senza via d'uscita, per un motivo che con la posizione non c'entra.
//
// Misurato il 9 agosto 2026 alle 03:40: 10 mercati su 39 in gestione, quattro aperti la sera prima.
// Primo `rules-unreadable` su London 18°C: 02:09:42Z — il giro di board subito dopo l'ultimo ciclo di
// auto-close riuscito (02:08:57Z).
//
// ═══ IL RIPIEGO ERA GIA' PROGETTATO, MANCAVA CHI LO RIEMPIVA ════════════════════════════════════════
// `resolveMarketRules` consulta gia' `market-catalog` quando il board non conosce il mercato. Ma il
// catalogo lo scriveva SOLO il pannello operatore: agent41 non lo chiamava mai. Da oggi lo chiama,
// mentre il board ha ancora i dati — dopo la rotazione non ci sarebbe piu' nessuna fonte locale.
//
// ═══ COSA SI VERIFICA ═══════════════════════════════════════════════════════════════════════════════
//   1 · il mapper riga-di-board → record di catalogo, compresi i casi che deve RIFIUTARE
//   2 · LA SCENA COMPLETA: mercato sul board → aperto → board ruota → le regole si leggono ancora
//   3 · la quarta scrittura non e' un fermo duro (e le prime tre lo restano)
//   4 · il flusso manuale del pannello e' invariato
//   5 · la fonte del board e' LA STESSA che legge resolveMarketRules

const fs = require('fs');
const os = require('os');
const path = require('path');

const CAT = require('./market-catalog');
const MO = require('./manual-order');
const A41 = require('../../agents/agent41-realloc-scheduler');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ripiego-'));
const ID = '0xc00c23bbbe2414e8d79516455d62ecd7088297d7bb9328d7b83d14f776e5c08f';

// Una riga di board VERA, ridotta ai campi che contano (forma copiata da /tmp/liquidity-rewards.json).
const RIGA = {
  venue: 'polymarket',
  marketId: ID,
  slug: 'lowest-temperature-in-london-on-august-10-2026',
  marketSlug: 'lowest-temperature-in-london-on-august-10-2026-18c',
  negRisk: true,
  title: 'Will the lowest temperature in London be 18°C on August 10?',
  category: 'Weather',
  midpoint: 0.65,
  maxSpread: 4.5,
  minSize: 20,
  dailyPool: 55,
  updatedAt: '2026-08-09T02:00:00.000Z',
  tokenId: '111111111111111111111111111111111111111111111111111111111111111111111111111',
  tokenIdNo: '222222222222222222222222222222222222222222222222222222222222222222222222222',
  tickSize: 0.01,
  bestBid: 0.64,
  bestAsk: 0.66,
};

console.log('── 1 · IL MAPPER: RIGA DI BOARD → RECORD DI CATALOGO');
{
  const r = CAT.recordDaRigaBoard(RIGA);
  ok('i quattro obbligatori ci sono tutti', CAT.missingFields(r).length === 0, JSON.stringify(CAT.missingFields(r)));
  ok('  tick dal campo tickSize del board', r.tick === 0.01);
  ok('  negRisk copiato come booleano, non dedotto', r.negRisk === true);
  ok('  i due token id come stringhe', typeof r.tokenIdYes === 'string' && typeof r.tokenIdNo === 'string');
  ok('  banda e minSize del programma reward', r.rewardsMaxSpreadCents === 4.5 && r.rewardsMinSize === 20);
  ok('  fetchedAt dall\'updatedAt della riga, non da adesso', r.fetchedAt === Date.parse(RIGA.updatedAt));

  // Ogni campo obbligatorio mancante deve produrre un record che upsertMarket RIFIUTA. Fallire qui
  // vorrebbe dire scrivere un ripiego con un tick indovinato, che produce ordini fuori banda invece
  // di un rifiuto leggibile: e' il verso di errore peggiore possibile in questo modulo.
  for (const campo of ['tickSize', 'negRisk', 'tokenId', 'tokenIdNo']) {
    const rotta = { ...RIGA }; delete rotta[campo];
    const rec = CAT.recordDaRigaBoard(rotta);
    ok(`  senza ${campo} il record è RIFIUTATO dal catalogo`, CAT.missingFields(rec).length > 0);
  }
  // negRisk non booleano (una stringa "true" da un feed sciatto) non deve passare per vero.
  ok('  negRisk="true" (stringa) non diventa true', CAT.recordDaRigaBoard({ ...RIGA, negRisk: 'true' }).negRisk === null);
  ok('  tick a zero è rifiutato', CAT.missingFields(CAT.recordDaRigaBoard({ ...RIGA, tickSize: 0 })).includes('tick'));
  ok('riga nulla o senza marketId ⇒ null', CAT.recordDaRigaBoard(null) === null && CAT.recordDaRigaBoard({}) === null);
}

console.log('\n── 2 · LA SCENA COMPLETA: SUL BOARD → APERTO → IL BOARD RUOTA');
{
  const catFile = path.join(TMP, 'catalogo.json');
  const auditFile = path.join(TMP, 'catalogo-audit.jsonl');
  const deps = { catalogFile: catFile, catalogAuditFile: auditFile };

  // ── (a) il mercato è sul board: le regole si leggono di lì, e il catalogo non serve.
  const boardPieno = { markets: [RIGA] };
  const libri = { markets: { [ID]: { mid: 0.65, ageMs: 1000, tokenId: RIGA.tokenId, tokenIdNo: RIGA.tokenIdNo, yes: { bestBid: 0.64, bestAsk: 0.66 } } } };
  const prima = MO.resolveMarketRules(ID, { books: libri, norm: boardPieno, catalogRecord: null });
  ok('(a) sul board: regole leggibili', prima.readable === true, `missing: ${(prima.missing || []).join(',') || '—'}`);

  // ── (b) agent41 apre il mercato: la quarta scrittura copia le regole nel ripiego.
  const rec = CAT.recordDaRigaBoard(RIGA);
  const w = CAT.upsertMarket(rec, { by: 'test', reason: 'copia di sicurezza' }, deps);
  ok('(b) la copia di sicurezza viene scritta', w.ok === true, w.error || '');
  ok('  ed è audiata', fs.existsSync(auditFile) && /market-added/.test(fs.readFileSync(auditFile, 'utf8')));

  // ── (c) IL BOARD RUOTA: il mercato non c'è più. È il momento in cui prima si rompeva tutto.
  const boardVuoto = { markets: [] };
  const senzaRipiego = MO.resolveMarketRules(ID, { books: libri, norm: boardVuoto, catalogRecord: null });
  ok('(c) senza ripiego: rules-unreadable — è il difetto, riprodotto', senzaRipiego.readable === false,
    `missing: ${(senzaRipiego.missing || []).join(', ')}`);
  ok('  e mancano ESATTAMENTE i quattro visti in produzione',
    ['tick', 'maxSpread', 'minSize', 'negRisk'].every((k) => (senzaRipiego.missing || []).includes(k)));

  const dopo = MO.resolveMarketRules(ID, { books: libri, norm: boardVuoto, catalogRecord: CAT.readMarketRecord(ID, deps) });
  ok('(c) CON il ripiego: regole di nuovo leggibili', dopo.readable === true, `missing: ${(dopo.missing || []).join(',') || '—'}`);
  ok('  tick, banda, minSize e negRisk vengono dal ripiego',
    dopo.tick === 0.01 && dopo.maxSpreadCents === 4.5 && dopo.minSize === 20 && dopo.negRisk === true);
  ok('  i token id sono quelli veri, non ricostruiti',
    String(dopo.tokenId) === RIGA.tokenId && String(dopo.tokenIdNo) === RIGA.tokenIdNo);

  // ── (d) e quindi i quattro percorsi che si fermavano possono ripartire. Si prova il GATE che li
  //        accomuna — `rules.readable` — sulla stessa forma che ciascuno controlla.
  ok('(d) auto-close / auto-reprice / mm-tracking passano il loro gate', dopo.readable === true);
  ok('  e il gate 2 di placeManualOrder non ha più motivo di rifiutare', (dopo.missing || []).length === 0);

  // ── (e) IL BOARD RESTA LA PRIMA SCELTA. Il ripiego non deve poter sovrascrivere numeri vivi: se il
  //        mercato torna sul board con un tick diverso, vince il board.
  const tornato = { markets: [{ ...RIGA, tickSize: 0.001, maxSpread: 5.5 }] };
  const r2 = MO.resolveMarketRules(ID, { books: libri, norm: tornato, catalogRecord: CAT.readMarketRecord(ID, deps) });
  ok('(e) se il mercato torna sul board, il BOARD vince sul ripiego', r2.tick === 0.001 && r2.maxSpreadCents === 5.5,
    `tick ${r2.tick} banda ${r2.maxSpreadCents}`);
}

console.log('\n── 3 · LA QUARTA SCRITTURA NON È UN FERMO DURO (E LE PRIME TRE LO RESTANO)');
{
  const okFn = async () => ({ ok: true });
  const noFn = async () => ({ ok: false, error: 'rifiutata dal test' });

  // Le prime tre decidono se il mercato è operabile ADESSO: senza, ogni gamba muore a un gate.
  const senzaAllowlist = A41.preparaMercatoNuovo(ID, noFn, okFn, okFn, okFn);
  const senzaManuale = A41.preparaMercatoNuovo(ID, okFn, noFn, okFn, okFn);
  const senzaUscita = A41.preparaMercatoNuovo(ID, okFn, okFn, noFn, okFn);
  Promise.all([senzaAllowlist, senzaManuale, senzaUscita]).then(([a, b, c]) => {
    ok('setEnabled fallito ⇒ FERMO DURO', a.ok === false, a.motivo);
    ok('setManual fallito ⇒ FERMO DURO', b.ok === false, b.motivo);
    ok('setAutoClose fallito ⇒ FERMO DURO', c.ok === false, c.motivo);
  });

  // La quarta riguarda la gestibilità FUTURA: rinunciare al piazzamento per una copia mancata sarebbe
  // scambiare un danno certo (capitale fermo adesso) con uno possibile (gestione persa se il board ruota).
  A41.preparaMercatoNuovo(ID, okFn, okFn, okFn, async () => ({ ok: false, error: 'catalogo illeggibile' })).then((r) => {
    ok('catalogo fallito ⇒ SI PROSEGUE', r.ok === true, r.motivo || '');
    ok('  ma il fallimento è dichiarato, non silenzioso', r.catalogo === false && /catalogo illeggibile/.test(r.catalogoMotivo || ''));
  });
  A41.preparaMercatoNuovo(ID, okFn, okFn, okFn, undefined).then((r) => {
    ok('nessuna funzione di catalogo cablata ⇒ si prosegue e lo si dice', r.ok === true && r.catalogo === false);
  });
  A41.preparaMercatoNuovo(ID, okFn, okFn, okFn, async () => { throw new Error('esplosione'); }).then((r) => {
    ok('un catalogo che ESPLODE non fa fallire il giro', r.ok === true && r.catalogo === false && /esplosione/.test(r.catalogoMotivo || ''));
  });
  A41.preparaMercatoNuovo(ID, okFn, okFn, okFn, okFn).then((r) => {
    ok('tutte e quattro riuscite ⇒ ok e catalogo true', r.ok === true && r.catalogo === true);
  });
}

console.log('\n── 4 · IL FLUSSO MANUALE DEL PANNELLO È INVARIATO');
{
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app/api/maker/markets/enable/route.ts'), 'utf8');
  ok('la route del pannello chiama ancora upsertMarket direttamente', /upsertMarket\(/.test(src));
  ok('  con la sua etichetta, distinta da quella dello scheduler', /allocation panel/.test(src));
  // La firma di upsertMarket non è cambiata: la route passa `market` dal venue, non un record di board.
  ok('upsertMarket accetta ancora la forma del venue (market-search)',
    CAT.missingFields({ tokenIdYes: 'a', tokenIdNo: 'b', tick: 0.01, negRisk: false }).length === 0);
  ok('recordDaRigaBoard è ADDITIVA: le altre esportazioni ci sono ancora',
    ['readMarketCatalog', 'readMarketRecord', 'upsertMarket', 'removeMarket', 'missingFields']
      .every((k) => typeof CAT[k] === 'function'));
}

console.log('\n── 5 · LA FONTE DEL BOARD È LA STESSA CHE LEGGE resolveMarketRules');
{
  // Due percorsi hardcoded in due file diversi sono una divergenza che aspetta di succedere: se
  // manual-order cambiasse file e agent41 no, la copia di sicurezza conterrebbe le regole di un board
  // che nessuno consulta. Il test li confronta invece di fidarsi.
  const mo = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  const m = mo.match(/const NORMALIZED_FILE = '([^']+)'/);
  ok('manual-order dichiara il board normalizzato', !!m, m && m[1]);
  ok('  e agent41 copia da quello STESSO file', !!m && A41.BOARD_NORMALIZZATO === m[1], A41.BOARD_NORMALIZZATO);

  // Il lettore non solleva mai: un board illeggibile vale «nessuna riga», mai un record inventato.
  ok('board inesistente ⇒ null, senza eccezioni', A41.rigaBoardNormalizzata(ID, path.join(TMP, 'non-esiste.json')) === null);
  const rotto = path.join(TMP, 'rotto.json'); fs.writeFileSync(rotto, '{ non json');
  ok('board illeggibile ⇒ null, senza eccezioni', A41.rigaBoardNormalizzata(ID, rotto) === null);
  const buono = path.join(TMP, 'board.json'); fs.writeFileSync(buono, JSON.stringify({ markets: [RIGA] }));
  ok('board valido ⇒ la riga giusta', (A41.rigaBoardNormalizzata(ID, buono) || {}).marketId === ID);
  ok('  e la ricerca non è sensibile alle maiuscole', (A41.rigaBoardNormalizzata(ID.toUpperCase(), buono) || {}).marketId === ID);
  ok('mercato assente dal board ⇒ null', A41.rigaBoardNormalizzata('0x' + 'f'.repeat(64), buono) === null);
}

setTimeout(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
}, 300);

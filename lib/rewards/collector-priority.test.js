#!/usr/bin/env node
'use strict';
// IL RACCOGLITORE DEVE GUARDARE DOVE GUARDA L'OTTIMIZZATORE.
//
// Il guasto misurato il 3 agosto 2026: il raccoglitore sottoscriveva i primi 60 mercati del board
// ORDINATI PER MONTEPREMI, l'ottimizzatore sceglieva per reward per dollaro, e dei 5 mercati del piano
// fresco uno solo era coperto. «Spider-Man: Brand New Day», posizione 115 con $25/g, aveva l'ultimo
// prezzo di 8,4 ore prima: il piano lo proponeva e il guard di freschezza lo scartava.
//
// Qui si prova la chiusura del cerchio: il piano scrive l'elenco, la corsia di agent34 lo consuma, e un
// mercato mai visto prima entra in copertura alla riconciliazione successiva — senza aspettare che il
// suo montepremi salga abbastanza da entrare nei primi 60.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { priorityFromPlan, writeCollectorPriority, readCollectorPriority, MAX_MARKETS, MAX_AGE_MS } = require('./collector-priority');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ID = (n) => '0x' + String(n).padStart(2, '0').repeat(32);
const ORA = Date.parse('2026-08-03T18:00:00Z');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'priorita-'));
const FILE = path.join(tmp, 'collector-priority.json');

const piano = (over = {}) => ({
  rows: [{ marketId: ID(1) }, { marketId: ID(2) }],
  candidates: [
    { marketId: ID(3), status: 'scartato', bestNetPerDay: 9 },
    { marketId: ID(1), status: 'scelto', bestNetPerDay: 40 },
    { marketId: ID(4), status: 'scartato', bestNetPerDay: 21 },
    { marketId: ID(5), status: 'scartato', bestNetPerDay: null },   // senza storico: non valutato
  ],
  ...over,
});

console.log('\n══ CHI ENTRA NELL ELENCO, E IN CHE ORDINE');
{
  const p = priorityFromPlan(piano());
  ok('le righe scelte dal piano vengono per prime', p[0] === ID(1) && p[1] === ID(2), p.slice(0, 2).map((x) => x.slice(0, 6)).join(','));
  ok('poi i candidati valutati, dal migliore in giu', p[2] === ID(4) && p[3] === ID(3), p.slice(2).map((x) => x.slice(0, 6)).join(','));
  ok('un mercato che e sia riga sia candidato compare UNA volta', p.filter((x) => x === ID(1)).length === 1);
  ok('i candidati SENZA storico non entrano: e proprio cio che questa corsia non puo aiutare', !p.includes(ID(5)));
  ok('nessun doppione in generale', new Set(p).size === p.length);
}
{
  const molti = { rows: [], candidates: Array.from({ length: 60 }, (_, i) => ({ marketId: ID(i + 10), bestNetPerDay: 100 - i })) };
  ok(`l elenco si ferma a ${MAX_MARKETS}: la corsia non deve diventare un secondo board`, priorityFromPlan(molti).length === MAX_MARKETS);
  ok('  e tiene i migliori, non i primi capitati', priorityFromPlan(molti)[0] === ID(10));
  const stretto = priorityFromPlan(molti, { max: 3 });
  ok('  il tetto e configurabile', stretto.length === 3);
}
{
  ok('un piano vuoto non produce un elenco inventato', priorityFromPlan({ rows: [], candidates: [] }).length === 0);
  ok('un piano nullo nemmeno', priorityFromPlan(null).length === 0);
  ok('le righe senza marketId vengono ignorate', priorityFromPlan({ rows: [{}, { marketId: '' }], candidates: [] }).length === 0);
}

console.log('\n══ SCRITTURA E RILETTURA');
{
  const scritto = writeCollectorPriority(piano(), { file: FILE, nowMs: ORA });
  ok('il file porta l istante di scrittura', scritto.at === new Date(ORA).toISOString());
  ok('  e quante righe erano davvero scelte', scritto.scelti === 2);
  const letto = readCollectorPriority({ file: FILE, nowMs: ORA + 60_000 });
  ok('rileggendolo si ritrovano gli stessi mercati', letto.marketIds.length === 4 && letto.fresh === true);
  ok('  con l eta misurata', letto.ageMs === 60_000);
}
{
  const letto = readCollectorPriority({ file: FILE, nowMs: ORA + MAX_AGE_MS + 1 });
  ok('oltre la scadenza l elenco vale ZERO, non «gli ultimi noti»', letto.marketIds.length === 0 && letto.fresh === false);
  ok('  e il motivo lo dice', /vecchio/.test(letto.reason), letto.reason);
  const alPelo = readCollectorPriority({ file: FILE, nowMs: ORA + MAX_AGE_MS });
  ok('esattamente alla scadenza vale ancora', alPelo.marketIds.length === 4);
}
{
  const assente = readCollectorPriority({ file: path.join(tmp, 'non-esiste.json'), nowMs: ORA });
  ok('file assente ⇒ elenco vuoto, non un errore che ferma il raccoglitore', assente.marketIds.length === 0 && !!assente.reason);

  const rotto = path.join(tmp, 'rotto.json');
  fs.writeFileSync(rotto, '{ questo non e json');
  ok('JSON rotto ⇒ elenco vuoto', readCollectorPriority({ file: rotto, nowMs: ORA }).marketIds.length === 0);

  const senzaIstante = path.join(tmp, 'senza-at.json');
  fs.writeFileSync(senzaIstante, JSON.stringify({ marketIds: [ID(9)] }));
  ok('elenco senza istante ⇒ vuoto: non se ne puo giudicare l eta', readCollectorPriority({ file: senzaIstante, nowMs: ORA }).marketIds.length === 0);

  const malformato = path.join(tmp, 'malformato.json');
  fs.writeFileSync(malformato, JSON.stringify({ at: new Date(ORA).toISOString(), marketIds: 'tutti' }));
  ok('campo marketIds non-array ⇒ vuoto', readCollectorPriority({ file: malformato, nowMs: ORA }).marketIds.length === 0);
}

console.log('\n══ LA CORSIA DENTRO agent34');
(async () => {
  const A = require('../../agents/agent34-clob-ws');

  {
    // LO SCENARIO CHIESTO: un mercato che il raccoglitore non ha mai visto — non nel board, non fra gli
    // abilitati — viene proposto dall'ottimizzatore ed entra in copertura alla riconciliazione dopo.
    const nuovo = ID(7);
    const into = new Map([[ID(1), { conditionId: ID(1), source: 'reward-board', rewardsDailyRate: 500 }]]);
    ok('prima: il mercato nuovo NON e coperto', !into.has(nuovo));
    await A.unionPlanMarkets(into, { planIds: [nuovo], catalogRecord: { tokenIdYes: 'a', tokenIdNo: 'b' } });
    ok('dopo una riconciliazione il mercato nuovo E coperto', into.has(nuovo));
    ok('  con entrambi i token, mai uno solo', into.get(nuovo).tokenId === 'a' && into.get(nuovo).tokenIdNo === 'b');
    ok('  marcato come venuto dal piano', into.get(nuovo).source === 'piano' && into.get(nuovo).fromPlan === true);
    ok('  e NON spacciato per un mercato abilitato a mano', into.get(nuovo).operatorEnabled === false);
    ok('il mercato del board che c era resta dov era', into.has(ID(1)));
    ok('la corsia dichiara chi ha attivo', A.planLaneState().active.includes(nuovo) && A.planLaneState().dropped.length === 0);
  }
  {
    // Al tetto totale cede il posto il mercato reward PIÙ POVERO, mai uno del piano.
    const into = new Map();
    for (let i = 0; i < A.TOTAL_MARKET_CAP; i++) into.set(ID(i), { conditionId: ID(i), source: 'reward-board', rewardsDailyRate: i === 3 ? 1 : 900 });
    await A.unionPlanMarkets(into, { planIds: [ID(200)], catalogRecord: { tokenIdYes: 'a', tokenIdNo: 'b' } });
    ok('al tetto il mercato del piano entra comunque', into.has(ID(200)));
    ok('  sfrattando il reward piu povero', !into.has(ID(3)), 'evitto il $1/g');
    ok('  senza sforare il tetto totale', into.size === A.TOTAL_MARKET_CAP);
  }
  {
    // Un mercato già coperto dal board non si sottoscrive due volte: si marca soltanto.
    const into = new Map([[ID(1), { conditionId: ID(1), source: 'reward-board', rewardsDailyRate: 500 }]]);
    await A.unionPlanMarkets(into, { planIds: [ID(1)], catalogRecord: { tokenIdYes: 'a', tokenIdNo: 'b' } });
    ok('un mercato gia coperto viene solo marcato', into.size === 1 && into.get(ID(1)).fromPlan === true);
    ok('  e resta attribuito al board', into.get(ID(1)).source === 'reward-board');
  }
  {
    // Token non risolvibili: si scarta e lo si dice, mai si inventa un token.
    const into = new Map();
    await A.unionPlanMarkets(into, { planIds: [ID(8)], catalogRecord: null, resolveTokens: async () => ({ tokenId: null, tokenIdNo: null }) });
    ok('token non risolvibili ⇒ mercato NON sottoscritto', into.size === 0);
    ok('  e finisce fra gli scartati, a voce alta', A.planLaneState().dropped.includes(ID(8)));
  }
  {
    const into = new Map([[ID(1), { conditionId: ID(1), source: 'reward-board' }]]);
    await A.unionPlanMarkets(into, { planIds: [] });
    ok('elenco vuoto ⇒ la corsia non tocca niente', into.size === 1 && A.planLaneState().active.length === 0);
  }
  {
    // Il caso «chi scriveva l'elenco è morto»: scaduto ⇒ nessuna priorità, comportamento di sempre.
    fs.writeFileSync(FILE, JSON.stringify({ at: new Date(Date.now() - MAX_AGE_MS - 60_000).toISOString(), marketIds: [ID(7)] }));
    const letto = readCollectorPriority({ file: FILE });
    ok('elenco scaduto ⇒ la corsia riceve zero mercati', letto.marketIds.length === 0);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\npriorita del raccoglitore: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

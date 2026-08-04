#!/usr/bin/env node
'use strict';
// IL RACCOGLITORE DEVE GUARDARE DOVE GUARDA L'OTTIMIZZATORE — E CONTINUARE A GUARDARCI.
//
// Primo guasto, 3 agosto 2026: il raccoglitore sottoscriveva i primi 60 mercati del board ORDINATI PER
// MONTEPREMI, l'ottimizzatore sceglieva per reward per dollaro, e dei 5 mercati del piano fresco uno solo
// era coperto. «Spider-Man: Brand New Day», posizione 115 con $25/g, aveva l'ultimo prezzo di 8,4 ore
// prima: il piano lo proponeva e il guard di freschezza lo scartava.
//
// Secondo guasto, la sera dello stesso giorno, DOPO il primo fix: la lista era una FOTOGRAFIA di un solo
// piano, sostituita per intero a ogni scrittura. Un piano calcolato due minuti dopo un ciclo aveva 5
// righe eseguibili su 7; i due mercati stantii (~121 campioni contro 484, buchi di 233 e 232 minuti) non
// erano nella lista scritta quattro minuti prima. Erano usciti dalla graduatoria e vi erano rientrati, e
// nel frattempo nessuno li stava più campionando.
//
// Qui si prova la chiusura di entrambi i cerchi: la selezione (chi entra) e l'UNIONE MOBILE (chi resta).

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  mercatiDalPiano, priorityFromPlan, unioneMobile, writeCollectorPriority, readCollectorPriority,
  MAX_MARKETS, MAX_AGE_MS, TOP_K, RETENTION_MS,
} = require('./collector-priority');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ID = (n) => '0x' + String(n).padStart(2, '0').repeat(32);
const ORA = Date.parse('2026-08-03T18:00:00Z');
const H = 3_600_000;
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

  const m = mercatiDalPiano(piano());
  ok('ogni voce porta il MOTIVO: riga o quasi-vincitore', m[0].motivo === 'piano' && m[2].motivo === 'topK');
  ok('  e il quasi-vincitore porta la sua posizione in graduatoria', m[2].rank === 2, `rank=${m[2].rank}`);
}
{
  const molti = { rows: [], candidates: Array.from({ length: 60 }, (_, i) => ({ marketId: ID(i + 10), bestNetPerDay: 100 - i })) };
  ok(`la selezione si ferma a TOP_K=${TOP_K}: la corsia non deve diventare un secondo board`, priorityFromPlan(molti).length === Math.min(TOP_K, MAX_MARKETS));
  ok('  e tiene i migliori, non i primi capitati', priorityFromPlan(molti)[0] === ID(10));
  ok('  il taglio e configurabile', priorityFromPlan(molti, { topK: 3 }).length === 3);
  const conRighe = { rows: [{ marketId: ID(500) }], candidates: molti.candidates };
  ok('una RIGA fuori dai top-K entra lo stesso: e li che si piazza', priorityFromPlan(conRighe).includes(ID(500)));
}
{
  ok('un piano vuoto non produce un elenco inventato', priorityFromPlan({ rows: [], candidates: [] }).length === 0);
  ok('un piano nullo nemmeno', priorityFromPlan(null).length === 0);
  ok('le righe senza marketId vengono ignorate', priorityFromPlan({ rows: [{}, { marketId: '' }], candidates: [] }).length === 0);
}

console.log('\n══ L UNIONE MOBILE: CHI RESTA CALDO, E PER QUANTO');
{
  // LO SCENARIO OSSERVATO, primo caso: esce dal piano ma resta fra i quasi-vincitori.
  // Deve restare caldo. È il mercato che il piano rivorrà fra sei ore, e se si raffredda lo scarta.
  const prima = unioneMobile({ precedenti: [], freschi: [{ id: ID(1), motivo: 'piano' }], nowMs: ORA });
  const dopo = unioneMobile({ precedenti: prima.mercati, freschi: [{ id: ID(1), motivo: 'topK', rank: 7 }], nowMs: ORA + 6 * H });
  ok('un mercato che esce dal piano ma resta top-K RESTA in elenco', dopo.marketIds.includes(ID(1)));
  ok('  e la sua data di interesse si aggiorna', dopo.mercati[0].visto === new Date(ORA + 6 * H).toISOString());
  ok('  senza perdere memoria di quando era una riga', dopo.mercati[0].piano === new Date(ORA).toISOString());
  ok('  ora e registrato come quasi-vincitore, con la sua posizione', dopo.mercati[0].topK !== null && dopo.mercati[0].rank === 7);
}
{
  // LO SCENARIO OSSERVATO, secondo caso: esce SIA dal piano SIA dai top-K.
  // Non deve sparire subito — deve restare caldo per RETENTION_MS e uscire solo dopo.
  const base = unioneMobile({ precedenti: [], freschi: [{ id: ID(1), motivo: 'topK', rank: 3 }, { id: ID(2), motivo: 'piano' }], nowMs: ORA });

  const subito = unioneMobile({ precedenti: base.mercati, freschi: [{ id: ID(2), motivo: 'piano' }], nowMs: ORA + 60_000 });
  ok('un minuto dopo essere uscito da tutto, il mercato NON sparisce', subito.marketIds.includes(ID(1)));
  ok('  ed e dichiarato come trattenuto dall isteresi', subito.trattenuti.includes(ID(1)));

  const unCiclo = unioneMobile({ precedenti: base.mercati, freschi: [{ id: ID(2), motivo: 'piano' }], nowMs: ORA + 6 * H });
  ok('dopo UN ciclo del riallocatore (6h) e ancora caldo', unCiclo.marketIds.includes(ID(1)));

  const alPelo = unioneMobile({ precedenti: base.mercati, freschi: [{ id: ID(2), motivo: 'piano' }], nowMs: ORA + RETENTION_MS });
  ok(`esattamente a RETENTION (${RETENTION_MS / H}h) e ancora dentro`, alPelo.marketIds.includes(ID(1)));

  const oltre = unioneMobile({ precedenti: base.mercati, freschi: [{ id: ID(2), motivo: 'piano' }], nowMs: ORA + RETENTION_MS + 1 });
  ok('  un millisecondo oltre, esce', !oltre.marketIds.includes(ID(1)));
  ok('  e la scadenza e dichiarata, non silenziosa', oltre.scaduti.includes(ID(1)));
  ok('  mentre chi e rimasto interessante resta', oltre.marketIds.includes(ID(2)));
}
{
  // L'isteresi RINNOVA: ogni volta che torna interessante, il conto riparte. Un mercato che compare
  // ogni ciclo non deve mai scadere per il solo passare del tempo.
  let stato = [];
  for (let i = 0; i < 5; i++) {
    stato = unioneMobile({ precedenti: stato, freschi: [{ id: ID(1), motivo: 'topK', rank: 5 }], nowMs: ORA + i * 6 * H }).mercati;
  }
  ok('un mercato che ricompare a ogni ciclo resta caldo indefinitamente', stato.some((v) => v.id === ID(1)));
}
{
  // Al tetto, chi cede il posto: prima i trattenuti, mai le righe del piano. Se si sta per piazzare su un
  // mercato, quel mercato DEVE essere in copertura — è tutto il punto della corsia.
  const vecchi = Array.from({ length: 10 }, (_, i) => ({ id: ID(i + 20), piano: null, topK: new Date(ORA).toISOString(), visto: new Date(ORA).toISOString(), rank: i + 1 }));
  const u = unioneMobile({
    precedenti: vecchi,
    freschi: [{ id: ID(1), motivo: 'piano' }, { id: ID(2), motivo: 'piano' }, { id: ID(3), motivo: 'topK', rank: 1 }],
    nowMs: ORA + H,
    max: 5,
  });
  ok('al tetto le RIGHE del piano restano sempre', u.marketIds.includes(ID(1)) && u.marketIds.includes(ID(2)));
  ok('  poi i quasi-vincitori di adesso', u.marketIds.includes(ID(3)));
  ok('  e sono i TRATTENUTI a cedere il posto', u.tagliati.length === 8 && u.marketIds.length === 5);
  ok('  chi cede e SOLO un trattenuto, mai un mercato di adesso',
    u.tagliati.length === 8 && !u.tagliati.includes(ID(1)) && !u.tagliati.includes(ID(2)) && !u.tagliati.includes(ID(3)),
    u.tagliati.length + ' tagliati, tutti vecchi');
}
{
  const u = unioneMobile({
    precedenti: [
      { id: ID(1), visto: new Date(ORA - H).toISOString() },
      { id: ID(2), visto: new Date(ORA - 2 * H).toISOString() },
      { id: ID(3), visto: new Date(ORA - 3 * H).toISOString() },
    ],
    freschi: [],
    nowMs: ORA,
    max: 2,
  });
  ok('fra i trattenuti sopravvive il piu recente: e il piu probabile ritorno', u.marketIds[0] === ID(1) && u.marketIds[1] === ID(2));
  ok('  e il piu vecchio e il primo a cadere', u.tagliati[0] === ID(3));
}
{
  const u = unioneMobile({ precedenti: [{ id: ID(1) }, { id: ID(2), visto: 'ieri sera' }], freschi: [], nowMs: ORA });
  ok('una voce senza data leggibile si tratta come SCADUTA, mai come «vista adesso»', u.marketIds.length === 0 && u.scaduti.length === 2);
}

console.log('\n══ SCRITTURA E RILETTURA');
{
  const scritto = writeCollectorPriority(piano(), { file: FILE, nowMs: ORA });
  ok('il file porta l istante di scrittura', scritto.at === new Date(ORA).toISOString());
  ok('  e quante righe erano davvero scelte', scritto.scelti === 2);
  ok('  e dichiara il formato con isteresi', scritto.versione === 2 && Array.isArray(scritto.mercati));
  const letto = readCollectorPriority({ file: FILE, nowMs: ORA + 60_000 });
  ok('rileggendolo si ritrovano gli stessi mercati', letto.marketIds.length === 4 && letto.fresh === true);
  ok('  con l eta misurata', letto.ageMs === 60_000);
}
{
  // LA PROVA CHE CONTA, sul file vero: due scritture di seguito, la seconda senza il mercato della prima.
  // Nella vecchia lista-fotografia spariva. Adesso deve restare.
  const F = path.join(tmp, 'unione.json');
  writeCollectorPriority({ rows: [{ marketId: ID(1) }], candidates: [{ marketId: ID(1), bestNetPerDay: 50 }] }, { file: F, nowMs: ORA });
  writeCollectorPriority({ rows: [{ marketId: ID(2) }], candidates: [{ marketId: ID(2), bestNetPerDay: 50 }] }, { file: F, nowMs: ORA + 6 * H });
  const dopoUnCiclo = readCollectorPriority({ file: F, nowMs: ORA + 6 * H + 1000 });
  ok('sul FILE: il mercato del primo piano sopravvive al secondo piano che non lo sceglie', dopoUnCiclo.marketIds.includes(ID(1)));
  ok('  insieme a quello nuovo', dopoUnCiclo.marketIds.includes(ID(2)));

  writeCollectorPriority({ rows: [{ marketId: ID(2) }], candidates: [{ marketId: ID(2), bestNetPerDay: 50 }] }, { file: F, nowMs: ORA + RETENTION_MS + 2 * H });
  const dopoDueCicli = readCollectorPriority({ file: F, nowMs: ORA + RETENTION_MS + 2 * H + 1000 });
  ok('  ma oltre la finestra di isteresi esce davvero: la corsia non accumula per sempre', !dopoDueCicli.marketIds.includes(ID(1)));
}
{
  // Chi legge non si fida ciecamente di chi scrive: una voce oltre isteresi si scarta anche se il file
  // la contiene ancora e l'elenco nel suo insieme è recente.
  const F = path.join(tmp, 'voce-marcia.json');
  fs.writeFileSync(F, JSON.stringify({
    at: new Date(ORA).toISOString(),
    marketIds: [ID(1), ID(2)],
    mercati: [
      { id: ID(1), visto: new Date(ORA - RETENTION_MS - H).toISOString() },
      { id: ID(2), visto: new Date(ORA - H).toISOString() },
    ],
  }));
  const letto = readCollectorPriority({ file: F, nowMs: ORA });
  ok('in lettura una voce oltre isteresi si scarta anche se il file la elenca', letto.marketIds.length === 1 && letto.marketIds[0] === ID(2));
}
{
  // Il file del formato vecchio (fotografia, senza date per voce) non deve far perdere la copertura di
  // colpo: si adotta la data dell'elenco e da lì in poi vale l'isteresi.
  const F = path.join(tmp, 'vecchio-formato.json');
  fs.writeFileSync(F, JSON.stringify({ at: new Date(ORA).toISOString(), scelti: 1, marketIds: [ID(1), ID(2)] }));
  ok('un file di formato vecchio si legge ancora', readCollectorPriority({ file: F, nowMs: ORA + H }).marketIds.length === 2);
  writeCollectorPriority({ rows: [{ marketId: ID(3) }], candidates: [] }, { file: F, nowMs: ORA + H });
  const dopo = readCollectorPriority({ file: F, nowMs: ORA + H });
  ok('  e la prima scrittura nuova ne EREDITA i mercati invece di buttarli', dopo.marketIds.includes(ID(1)) && dopo.marketIds.includes(ID(3)));
}
{
  const letto = readCollectorPriority({ file: FILE, nowMs: ORA + MAX_AGE_MS + 1 });
  ok('oltre la scadenza l elenco vale ZERO, non «gli ultimi noti»', letto.marketIds.length === 0 && letto.fresh === false);
  ok('  e il motivo lo dice', /vecchio/.test(letto.reason), letto.reason);
  ok('nessuna voce puo sopravvivere all elenco che la contiene', RETENTION_MS <= MAX_AGE_MS, `isteresi ${RETENTION_MS / H}h ≤ scadenza ${MAX_AGE_MS / H}h`);
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

  const rottoInScrittura = path.join(tmp, 'rotto-in-scrittura.json');
  fs.writeFileSync(rottoInScrittura, '{ nemmeno questo e json');
  const ripartito = writeCollectorPriority(piano(), { file: rottoInScrittura, nowMs: ORA });
  ok('scrivere sopra un file rotto riparte dall unione vuota, non fallisce', ripartito.marketIds.length === 4);
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

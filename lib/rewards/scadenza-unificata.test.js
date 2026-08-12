#!/usr/bin/env node
'use strict';
// UNA SOLA FONTE PER LA SCADENZA, E LE FONTI DISCORDI ESCLUDONO A MONTE.
//
// ═══ IL DIFETTO, MISURATO ════════════════════════════════════════════════════════════════════════════
// Le fonti della scadenza erano due, lette in due punti diversi da due parti del sistema:
//
//   · il PIANIFICATORE leggeva il board — cioè Gamma, via agent24 → rewards-normalize;
//   · la VERIFICA leggeva il venue — `clob.polymarket.com/markets/<cid>`, campo `end_date_iso`.
//
// Ciclo delle 15:41:31Z del 12 agosto 2026, sui dati veri:
//
//   0xa19bd9e0…  Clacton by-election   board 2026-08-13T23:59:00Z (32,3 h)  venue 2026-08-13T00:00:00Z (8,3 h)
//   0x2254414c…  Houston 96-97°F       board 2026-08-13T12:00:00Z (20,3 h)  venue 2026-08-13T00:00:00Z (8,3 h)
//
// Il pianificatore li sceglieva, la verifica li rifiutava con «mancano 8,3 h (soglia 18 h)», il ciclo
// ricalcolava tre volte e si fermava. Nessuna delle due letture era sbagliata: erano due letture diverse.
//
// ═══ LA FONTE SCELTA, E PERCHÉ ═══════════════════════════════════════════════════════════════════════
// IL VENUE. Misurato su 38 mercati del board: differenza Gamma − CLOB mai negativa, mediana 0,0 h,
// p90 16,0 h, massimo esattamente 24,0 h — il CLOB tronca a mezzanotte UTC. Quindi il CLOB è, per
// costruzione, MAI PIÙ TARDI di Gamma: a parità di attendibilità è la più prudente, ed è anche il
// registro di chi smette davvero di accettare ordini. Gamma resta come RISCONTRO INCROCIATO.
//
// ═══ COSA PROVA QUESTO FILE ══════════════════════════════════════════════════════════════════════════
//   1. la riconciliazione pura, coi numeri veri dei due mercati;
//   2. IL PUNTO DEL LAVORO: due fonti discordi oltre soglia ESCLUDONO IL MERCATO DAL PIANO — a monte —
//      e non lo lasciano arrivare alla verifica per farsi rifiutare a valle;
//   3. che l'esclusione abbia un motivo PROPRIO, distinto da «scade troppo presto»;
//   4. il cablaggio: agent24 riconcilia, il board porta il verdetto, la verifica non rilegge il venue;
//   5. i fail-closed e i fail-open, che vanno in direzioni opposte e deliberatamente.
//
// Run: node lib/rewards/scadenza-unificata.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { planAllocation } = require('./allocator');
const S = require('./scadenza-mercato');

let pass = 0; let fail = 0;
const ok = (nome, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + nome + (extra ? ' — ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + nome + (extra ? ' — ' + extra : '')); }
};

const ROOT = path.resolve(__dirname, '..', '..');

// I numeri veri del ciclo delle 15:41:31Z.
const CLACTON = { id: '0xa19bd9e0', gamma: '2026-08-13T23:59:00Z', clob: '2026-08-13T00:00:00Z' };
const HOUSTON = { id: '0x2254414c', gamma: '2026-08-13T12:00:00Z', clob: '2026-08-13T00:00:00Z' };

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n══ 1 · LA RICONCILIAZIONE, SUI DUE MERCATI VERI');
{
  pass += S.selfcheck();

  // ⚠ ASSERZIONE RIBALTATA IL 12 AGOSTO 2026, ed è la decisione dell'operatore (Opzione B).
  // Diceva «vince il venue, che è il più prudente». Su questi due mercati il venue è a mezzanotte
  // esatta e il board porta l'ora vera dello stesso giorno: il troncamento è PROVATO, e la regola
  // nuova restituisce l'ora vera. Non è un allentamento — la prudenza resta ovunque il troncamento
  // NON sia dimostrabile, e le sezioni qui sotto lo verificano caso per caso.
  for (const m of [CLACTON, HOUSTON]) {
    const r = S.scadenzaUnificata({ gammaIso: m.gamma, clobIso: m.clob });
    ok(`${m.id}: troncamento provato ⇒ si restituisce l'ora vera del board`,
      r.iso === m.gamma && r.fonte === 'gamma-ora-vera-su-clob-troncato', `${r.iso} · ${r.fonte}`);
    ok('  e il mercato resta AMMISSIBILE: il troncamento non è una contraddizione', r.ammissibile === true,
      `divergenza ${r.divergenzaOre} h`);
    ok('  con un motivo riconoscibile negli audit', /tronca a mezzanotte/.test(r.motivo || ''));
  }

  // La proprietà che regge ANCORA: non si va mai oltre la più tarda delle due letture. Prima il confine
  // era il minimo, adesso è il massimo — ma resta un confine, e nessuna data viene inventata fuori da lì.
  const casi = [CLACTON, HOUSTON, { gamma: '2026-09-01T18:30:00Z', clob: '2026-09-01T00:00:00Z' }];
  ok('la fonte scelta non è MAI più tarda della più tarda delle due letture',
    casi.every((m) => Date.parse(S.scadenzaUnificata({ gammaIso: m.gamma, clobIso: m.clob }).iso) <= Date.parse(m.gamma)));
  ok('  e non è MAI prima della più prudente',
    casi.every((m) => Date.parse(S.scadenzaUnificata({ gammaIso: m.gamma, clobIso: m.clob }).iso) >= Date.parse(m.clob)));

  // ══ I QUATTRO CASI DELLA DECISIONE, uno per uno ═══════════════════════════════════════════════
  {
    const r = S.scadenzaUnificata({ gammaIso: '2026-08-13T23:59:00Z', clobIso: '2026-08-13T00:00:00Z' });
    ok('CASO 1 · CLOB a mezzanotte esatta + Gamma più tardi lo stesso giorno ⇒ si usa GAMMA',
      r.iso === '2026-08-13T23:59:00Z' && r.fonte === 'gamma-ora-vera-su-clob-troncato', `${r.iso}`);
  }
  {
    const r = S.scadenzaUnificata({ gammaIso: '2026-08-13T18:00:00Z', clobIso: '2026-08-13T12:00:00Z' });
    ok('CASO 2 · CLOB NON a mezzanotte ⇒ resta il CLOB',
      r.iso === '2026-08-13T12:00:00Z' && r.fonte === 'clob', `${r.iso} · ${r.fonte}`);
  }
  {
    const r = S.scadenzaUnificata({ gammaIso: '2026-08-14T00:00:01Z', clobIso: '2026-08-13T00:00:00Z' });
    ok('CASO 3 · Gamma oltre 24 h dopo ⇒ mercato ESCLUSO',
      r.ammissibile === false && r.iso === null && /eventi diversi/.test(r.motivo), r.motivo);
  }
  {
    const r = S.scadenzaUnificata({ gammaIso: null, clobIso: '2026-08-13T00:00:00Z' });
    ok('CASO 4 · Gamma assente ⇒ resta il CLOB',
      r.iso === '2026-08-13T00:00:00Z' && r.fonte === 'clob-sola' && r.ammissibile === true, `${r.fonte}`);
    const r2 = S.scadenzaUnificata({ gammaIso: 'presto', clobIso: '2026-08-13T00:00:00Z' });
    ok('  e una Gamma ILLEGGIBILE si comporta come assente', r2.iso === '2026-08-13T00:00:00Z' && r2.fonte === 'clob-sola');
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n══ 2 · IL PUNTO DEL LAVORO: DISCORDI OLTRE SOGLIA ⇒ FUORI DAL PIANO, NON RIFIUTATE A VALLE');
{
  const NOW = 1_800_000_000_000;
  const iso = (ore) => new Date(NOW + ore * 3_600_000).toISOString();
  const riga = (marketId, tsMs, mid = 0.5) => ({
    ts: new Date(tsMs).toISOString(), tsMs, marketId, tokenIdYes: 'TK' + marketId,
    adjMid: mid, plainMid: mid, bestBid: mid - 0.01, bestAsk: mid + 0.01,
    bidDepthInBand: 1000, askDepthInBand: 1000, bandLow: mid - 0.05, bandHigh: mid + 0.05, tick: 0.01, src: 'ws',
  });

  // Due mercati identici in tutto — stesso montepremi, stesso book, stessa scadenza sul board — e
  // diversi in UNA cosa sola: su `DISCORDE` le due fonti si contraddicono oltre la soglia.
  const ids = ['CONCORDE', 'DISCORDE'];
  const base = () => ({
    byMarket: new Map(ids.map((i) => [i, [riga(i, NOW - 86_400_000), riga(i, NOW)]])),
    marketTokens: new Map(ids.map((i) => [i, 'TK' + i])),
    tapeByToken: new Map(),
    potByCond: new Map(ids.map((i) => [i, 100])),
    endDateByMarket: new Map(ids.map((i) => [i, iso(40)])),
    budgetUsd: 200, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold',
    horizonFilter: true, nowMs: NOW,
  });
  const scelti = (p) => new Set((p.rows || []).map((r) => r.marketId));
  const cand = (p, id) => (p.candidates || []).find((c) => c.marketId === id) || null;

  // (a) SENZA il verdetto — è il comportamento di prima: il mercato entra nel piano, e sarà la verifica
  //     a rifiutarlo tre ricalcoli dopo.
  const prima = planAllocation(base());
  ok('PRIMA: il mercato con fonti discordi entra nel piano', scelti(prima).has('DISCORDE'),
    `righe scelte: ${[...scelti(prima)].join(', ') || 'nessuna'}`);

  // (b) CON il verdetto — la riconciliazione lo ha marcato inammissibile a monte.
  const dopo = planAllocation({
    ...base(),
    scadenzaAmmissibileByMarket: new Map([['DISCORDE', false]]),
  });
  ok('DOPO: il mercato con fonti discordi NON entra nel piano', !scelti(dopo).has('DISCORDE'));
  ok('  ed è escluso A MONTE, cioè prima del knapsack',
    cand(dopo, 'DISCORDE') && cand(dopo, 'DISCORDE').status === 'scartato'
    && cand(dopo, 'DISCORDE').capital === 0);
  ok('  con un motivo PROPRIO, non «scade troppo presto»',
    cand(dopo, 'DISCORDE') && cand(dopo, 'DISCORDE').reasonCode === 'scadenza-discorde',
    cand(dopo, 'DISCORDE') && cand(dopo, 'DISCORDE').reasonCode);

  // (c) E il capitale non resta fermo: va sul mercato sano nello stesso giro. È la ragione per cui
  //     l'esclusione a monte vale più di un rifiuto a valle.
  ok('il mercato concorde resta scelto', scelti(dopo).has('CONCORDE'));
  ok('  e il piano non si svuota', (dopo.rows || []).length > 0,
    `${(dopo.rows || []).length} riga/e, $${(dopo.rows || []).reduce((a, r) => a + (r.capital || 0), 0)}`);

  // (d) Un verdetto ASSENTE non esclude: un board scritto prima della riconciliazione non deve
  //     svuotare il piano. È il fail-OPEN, ed è l'opposto del fail-closed sulla divergenza.
  const vecchio = planAllocation({ ...base(), scadenzaAmmissibileByMarket: new Map() });
  ok('un board senza il verdetto non perde nessun mercato', scelti(vecchio).has('DISCORDE'));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n══ 3 · IL CABLAGGIO: UNA FONTE, LETTA IN UN PUNTO SOLO');
{
  const a24 = fs.readFileSync(path.join(ROOT, 'agents', 'agent24-liquidity-rewards.js'), 'utf8');
  const codice = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const a24c = codice(a24);

  ok('agent24 IMPORTA la riconciliazione invece di riscriverla', /scadenzaUnificata/.test(a24c));
  ok('  legge la seconda fonte dal venue', /getScadenzaClob\(m\.conditionId\)/.test(a24c));
  ok('  e la scadenza scritta sul board è quella RICONCILIATA, non più quella di Gamma',
    /endDate:\s+scadenza\.iso/.test(a24c));
  ok('  le due letture grezze restano accanto, verificabili',
    /endDateGamma:/.test(a24c) && /endDateClob:/.test(a24c));
  ok('  e il verdetto di ammissibilità viaggia col board', /scadenzaAmmissibile:/.test(a24c));

  const norm = codice(fs.readFileSync(path.join(ROOT, 'lib', 'rewards-normalize.js'), 'utf8'));
  ok('la normalizzazione fa passare il verdetto', /scadenzaAmmissibile:/.test(norm));
  ok('  e un board vecchio senza il campo NON diventa un sì',
    /typeof m\.scadenzaAmmissibile === 'boolean' \? m\.scadenzaAmmissibile : null/.test(norm));

  const allo = codice(fs.readFileSync(path.join(ROOT, 'lib', 'rewards', 'allocator.js'), 'utf8'));
  ok('l\'allocatore applica il verdetto PRIMA del knapsack',
    /scadenzaDiscordeRejects/.test(allo) && /preKnapsackRejects[\s\S]{0,220}scadenzaDiscordeRejects/.test(allo));
  ok('  e solo un `false` esplicito esclude',
    /scadenzaAmmissibileByMarket\.get\(c\.marketId\) === false/.test(allo));

  // Il punto unico: la verifica NON rilegge la scadenza dal venue per conto suo.
  const a41 = codice(fs.readFileSync(path.join(ROOT, 'agents', 'agent41-realloc-scheduler.js'), 'utf8'));
  ok('la verifica non ricava più la scadenza da `end_date_iso` per conto suo',
    !/endDate:\s*typeof j\.end_date_iso === 'string'/.test(a41),
    'la legge dal board, dove è già riconciliata');
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n══ 4 · LE DUE DIREZIONI DI FALLIMENTO, E SONO OPPOSTE APPOSTA');
{
  ok('DIVERGENZA fra due letture presenti ⇒ si ESCLUDE (fail-closed)',
    S.scadenzaUnificata({ gammaIso: '2026-08-15T00:00:00Z', clobIso: '2026-08-13T00:00:00Z' }).ammissibile === false);
  ok('LETTURA MANCANTE ⇒ si usa quella che c\'è (fail-open sulla lettura)',
    S.scadenzaUnificata({ gammaIso: CLACTON.gamma, clobIso: null }).ammissibile === true);
  ok('  perché una lettura mancante non è una contraddizione, e trattarla come tale',
    S.scadenzaUnificata({ gammaIso: null, clobIso: CLACTON.clob }).ammissibile === true,
    'fermerebbe il bot a ogni singhiozzo del venue');
  ok('NESSUNA lettura ⇒ si esclude: non si alloca capitale su una data che non conosciamo',
    S.scadenzaUnificata({ gammaIso: null, clobIso: null }).ammissibile === false);

  const a24 = fs.readFileSync(path.join(ROOT, 'agents', 'agent24-liquidity-rewards.js'), 'utf8');
  ok('la lettura del venue non può far saltare la scansione',
    /catch\s*\{[^}]*\}\s*\n\s*return c \? c\.iso : null;/.test(a24),
    'un errore lascia `null`, che vale «una fonte sola», non «escludi tutto»');
  ok('  e non inventa mai una data', !/end_date_iso[\s\S]{0,120}\|\|\s*new Date/.test(a24));
}

console.log(`\n===== scadenza-unificata: ${pass} passati, ${fail} falliti =====\n`);
process.exit(fail === 0 ? 0 : 1);

#!/usr/bin/env node
'use strict';
// Unit test del registro dei permessi temporanei e della corsia che lo consuma in agent34.
// Nessuna rete, nessun ordine, nessuna scrittura in data/: ogni test usa un file temporaneo suo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./live-lease');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const tmp = () => ({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lease-')), 'leases.json') });
const ID = (n) => '0x' + String(n).padStart(2, '0').repeat(32);

// ── il ciclo di vita ────────────────────────────────────────────────────────────────────────────
console.log('\n── prendere, rinnovare, rilasciare');
{
  const d = tmp(); const t0 = 1_000_000;
  const a = L.acquireLease(ID(1), {}, { ...d, now: t0 });
  ok('prendere un permesso riesce', a.ok && !a.renewed);
  ok('  e scade dopo il TTL', a.lease.expiresAt === t0 + L.LEASE_TTL_MS, `${a.lease.expiresAt - t0}ms`);
  ok('  risulta attivo', L.readActiveLeaseIds({ ...d, now: t0 + 1 }).includes(ID(1).toLowerCase()));

  const b = L.acquireLease(ID(1), {}, { ...d, now: t0 + 5_000 });
  ok('la stessa chiamata RINNOVA invece di duplicare', b.ok && b.renewed && b.activeCount === 1);
  ok('  e sposta in avanti la scadenza', b.lease.expiresAt === t0 + 5_000 + L.LEASE_TTL_MS);

  const r = L.releaseLease(ID(1), { ...d, now: t0 + 6_000 });
  ok('il rilascio esplicito toglie il permesso', r.ok && r.released && r.activeCount === 0);
  ok('  e da lì non risulta più attivo', L.readActiveLeaseIds({ ...d, now: t0 + 6_001 }).length === 0);
}

// ── LA COSA PER CUI ESISTE LA SCADENZA ──────────────────────────────────────────────────────────
// Un browser chiuso di colpo non rilascia niente. Se il permesso durasse fino al rilascio resterebbe
// appeso per sempre, e dopo qualche settimana il feed sarebbe pieno di mercati che nessuno guarda.
console.log('\n── un permesso mai rilasciato deve morire da solo');
{
  const d = tmp(); const t0 = 2_000_000;
  L.acquireLease(ID(2), {}, { ...d, now: t0 });
  ok('vivo appena preso', L.readActiveLeaseIds({ ...d, now: t0 + 1_000 }).length === 1);
  ok('vivo a un millisecondo dalla scadenza', L.readActiveLeaseIds({ ...d, now: t0 + L.LEASE_TTL_MS - 1 }).length === 1);
  ok('MORTO alla scadenza, senza che nessuno lo abbia rilasciato',
    L.readActiveLeaseIds({ ...d, now: t0 + L.LEASE_TTL_MS }).length === 0);
  ok('  e resta morto molto dopo', L.readActiveLeaseIds({ ...d, now: t0 + 3_600_000 }).length === 0);
  // e la scrittura successiva lo rimuove anche dal file, così non cresce
  L.acquireLease(ID(3), {}, { ...d, now: t0 + L.LEASE_TTL_MS + 1 });
  const raw = JSON.parse(fs.readFileSync(d.file, 'utf8'));
  ok('  lo scaduto sparisce dal file alla prima scrittura', !Object.keys(raw.leases).includes(ID(2).toLowerCase()) && Object.keys(raw.leases).length === 1);
}

// ── il tetto ────────────────────────────────────────────────────────────────────────────────────
console.log('\n── il tetto cede il permesso guardato meno di recente');
{
  const d = tmp(); let t = 3_000_000;
  for (let i = 1; i <= L.LEASE_CAP; i++) L.acquireLease(ID(i), {}, { ...d, now: t + i });
  ok(`${L.LEASE_CAP} permessi stanno tutti dentro`, L.readActiveLeaseIds({ ...d, now: t + 100 }).length === L.LEASE_CAP);
  const over = L.acquireLease(ID(L.LEASE_CAP + 1), {}, { ...d, now: t + 200 });
  const ids = L.readActiveLeaseIds({ ...d, now: t + 201 });
  ok('uno in più non sfonda il tetto', ids.length === L.LEASE_CAP, `${ids.length}`);
  ok('  cede il più vecchio per rinnovo', over.evicted === ID(1).toLowerCase(), String(over.evicted));
  ok('  e il nuovo c\'è', ids.includes(ID(L.LEASE_CAP + 1).toLowerCase()));
  ok('  quello appena chiesto non può mai essere la vittima', !ids.includes(ID(1).toLowerCase()));
}

// ── input non validi ────────────────────────────────────────────────────────────────────────────
console.log('\n── un id non valido non entra');
{
  const d = tmp();
  ok('testo libero rifiutato', L.acquireLease('bitcoin', {}, d).ok === false);
  ok('id corto rifiutato', L.acquireLease('0xabc', {}, d).ok === false);
  ok('vuoto rifiutato', L.acquireLease('', {}, d).ok === false);
  ok('  e il file resta senza permessi', L.readActiveLeaseIds(d).length === 0);
}

// ── file illeggibile ⇒ nessun permesso, mai uno inventato ────────────────────────────────────────
console.log('\n── fallire chiuso');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-bad-'));
  const file = path.join(dir, 'leases.json');
  fs.writeFileSync(file, '{ questo non e json');
  ok('un file corrotto legge ZERO permessi, non esplode', L.readActiveLeaseIds({ file }).length === 0);
  ok('un file assente legge ZERO permessi', L.readActiveLeaseIds({ file: path.join(dir, 'manca.json') }).length === 0);
}

// ── la corsia dentro agent34 ────────────────────────────────────────────────────────────────────
console.log('\n── la corsia di agent34 che consuma i permessi');
(async () => {
  const A = require('../../agents/agent34-clob-ws');
  const meta = (id, source, rate) => [id, {
    conditionId: id, tokenId: `t-${id}`, tokenIdNo: `n-${id}`, source, rewardsDailyRate: rate,
  }];

  {
    const into = new Map([meta('0xaa', 'reward-board', 100)]);
    await A.unionLeaseMarkets(into, {
      leaseIds: [ID(9).toLowerCase()],
      catalogRecord: { tokenIdYes: 'tok-yes', tokenIdNo: 'tok-no', question: 'Mercato in prova' },
    });
    const added = into.get(ID(9).toLowerCase());
    ok('un permesso aggiunge il mercato al set sottoscritto', !!added);
    ok('  marcato come temporaneo', added && added.source === 'live-lease' && added.leased === true);
    ok('  e NON come abilitato dall\'operatore', added && added.operatorEnabled === false);
    ok('  il mercato del board resta intatto', into.get('0xaa') && into.get('0xaa').source === 'reward-board');
  }
  {
    // già sottoscritto per altri motivi ⇒ solo marcato, mai due volte
    const id = ID(9).toLowerCase();
    const into = new Map([[id, { conditionId: id, tokenId: 'x', tokenIdNo: 'y', source: 'operator-enabled', operatorEnabled: true }]]);
    const before = into.size;
    await A.unionLeaseMarkets(into, { leaseIds: [id], catalogRecord: { tokenIdYes: 'a', tokenIdNo: 'b' } });
    ok('un mercato già sottoscritto non viene duplicato', into.size === before);
    ok('  resta di proprietà dell\'operatore, non declassato a temporaneo',
      into.get(id).source === 'operator-enabled' && into.get(id).operatorEnabled === true);
    ok('  ed è marcato come guardato', into.get(id).leased === true);
  }
  {
    // token non risolvibili ⇒ SCARTATO, mai inventato
    const into = new Map();
    await A.unionLeaseMarkets(into, { leaseIds: [ID(7).toLowerCase()], catalogRecord: null, resolveTokens: async () => ({ tokenId: null, tokenIdNo: null }) });
    ok('token non risolvibili ⇒ nessuna sottoscrizione inventata', into.size === 0);
    ok('  e lo scarto viene registrato, non taciuto', A.leaseLaneState().dropped.length === 1);
  }
  {
    // nessun permesso ⇒ nessun effetto
    const into = new Map([meta('0xbb', 'reward-board', 5)]);
    await A.unionLeaseMarkets(into, { leaseIds: [] });
    ok('senza permessi il set non cambia', into.size === 1 && into.get('0xbb').source === 'reward-board');
  }

  console.log(`\nlive-lease: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

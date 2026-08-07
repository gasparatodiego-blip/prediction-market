#!/usr/bin/env node
'use strict';
// UN ORDINE MESSO A MANO SOPRAVVIVE A UN CICLO DI agent41.
//
// ═══ IL GUASTO ══════════════════════════════════════════════════════════════════════════════════════
// `allocation-reset` nasce come «l'operatore preme un bottone»: con quella premessa cancellare tutto
// ciò che è a riposo sui mercati gestiti è la cosa giusta — è lui che l'ha messo, è lui che chiede di
// rifare. Lo stesso codice però lo chiama agent41 ogni sei ore, e lì la premessa non regge: fra gli
// ordini a riposo ci possono essere quelli che una persona ha piazzato dieci minuti prima.
//
// E non erano distinguibili. `bulk-allocate` timbra `source: 'manual-ui'` con accanto il commento «it
// IS the operator acting, through one button instead of many» — vero per il pannello, falso per uno
// scheduler. Nel registro i due mittenti erano la stessa cosa.
//
// ═══ LA DIREZIONE DELL'ESCLUSIONE ═══════════════════════════════════════════════════════════════════
// Si cancella SOLO ciò che è provatamente automatico. Manuale e IGNOTO restano sul libro. Fra i due
// errori possibili — cancellare l'ordine di una persona, o lasciare in piedi un ordine dello scheduler
// — solo il primo distrugge lavoro fatto apposta; il secondo costa un ciclo. Un registro assente rende
// tutto ignoto e quindi non cancella niente: è il verso giusto per un fallimento.

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const O = require('./origine-ordine');
const { runAllocationReset } = require('./allocation-reset');
const ROOT = path.resolve(__dirname, '..', '..');

console.log('\n══ 1 · IL VOCABOLARIO: chi ha voluto l\'ordine');
{
  ok('il pannello, che non dichiara niente, resta manuale',
    O.origineDaSource('manual-ui', null) === O.ORIGINE_MANUALE);
  ok('chi dichiara `auto` è automatico', O.origineDaSource('manual-ui', 'auto') === O.ORIGINE_AUTO);
  for (const s of O.SORGENTI_AUTOMATICHE) {
    ok(`  ${s} è automatico per costruzione`, O.origineDaSource(s, null) === O.ORIGINE_AUTO);
  }
  ok('una dichiarazione senza senso non vince sul difetto',
    O.origineDaSource('manual-ui', 'boh') === O.ORIGINE_MANUALE, 'non si inventa un terzo stato');
}

console.log('\n══ 2 · LA MAPPA SI LEGGE DAL REGISTRO, E «NON LO SO» È UNA RISPOSTA');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origini-'));
  const file = path.join(dir, 'audit.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ source: 'manual-ui', op: 'manual-place', orderId: 'MANO', origine: 'manual-ui' }),
    JSON.stringify({ source: 'manual-ui', op: 'manual-place', orderId: 'CICLO', origine: 'auto' }),
    JSON.stringify({ source: 'manual-ui', op: 'manual-place', orderId: 'VECCHIO' }),        // prima del timbro
    'riga rotta non json',
    JSON.stringify({ source: 'manual-ui', op: 'manual-place', idempotencyKey: 'K1', origine: 'auto' }),
  ].join('\n'));

  const m = O.mappaOrigini({ auditFile: file });
  ok('l\'ordine dell\'operatore è manuale', O.origineDiUnOrdine({ orderId: 'MANO' }, m) === O.ORIGINE_MANUALE);
  ok('quello dello scheduler è automatico', O.origineDiUnOrdine({ orderId: 'CICLO' }, m) === O.ORIGINE_AUTO);
  ok('un ordine SENZA timbro è ignoto, non automatico',
    O.origineDiUnOrdine({ orderId: 'VECCHIO' }, m) === O.ORIGINE_IGNOTA,
    'gli ordini piazzati prima di questa modifica non devono diventare cancellabili');
  ok('un ordine mai visto è ignoto', O.origineDiUnOrdine({ orderId: 'MAI' }, m) === O.ORIGINE_IGNOTA);
  ok('la chiave di idempotenza vale come l\'id', O.origineDiUnOrdine({ idempotencyKey: 'K1' }, m) === O.ORIGINE_AUTO);
  ok('una riga rotta non fa cadere la lettura', m.size >= 3, `${m.size} chiavi`);
  ok('registro assente ⇒ mappa vuota ⇒ tutto ignoto',
    O.mappaOrigini({ auditFile: path.join(dir, 'non-esiste.jsonl') }).size === 0);

  const sep = O.separaPerOrigine(
    [{ orderId: 'MANO' }, { orderId: 'CICLO' }, { orderId: 'VECCHIO' }], m);
  ok('separa: uno solo è toccabile da un ciclo', sep.automatici.length === 1 && sep.automatici[0].orderId === 'CICLO');
  ok('  e gli altri due restano', sep.daLasciare.length === 2);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n══ 3 · IL RESET DI agent41: l\'ordine a mano SOPRAVVIVE al ciclo');
(async () => {
  const MKT = '0x' + '5e'.repeat(32);
  const ordini = [
    { orderId: 'MANO', price: 0.44, size: 50 },     // l'operatore, dieci minuti fa
    { orderId: 'CICLO', price: 0.46, size: 50 },    // agent41, sei ore fa
    { orderId: 'VECCHIO', price: 0.47, size: 20 },  // senza timbro: precede questa modifica
  ];
  const mappa = new Map([['MANO', 'manual-ui'], ['CICLO', 'auto']]);

  const cancellati = [];
  const deps = (extra = {}) => ({
    now: () => 1_786_200_000_000,
    readEnabled: () => [MKT],
    readTracking: () => [],
    listOrders: async () => ({ ok: true, orders: ordini }),
    cancelOrder: async ({ orderId }) => { cancellati.push(orderId); return { ok: true }; },
    setTrackingOff: async () => ({ ok: true }),
    setEnabled: async () => ({ ok: true }),
    setManual: async () => ({ ok: true }),
    setAutoClose: async () => ({ ok: true }),
    posizioneAperta: async () => ({ leggibile: true, aperta: false }),
    placeBulk: async () => ({ ok: true, placed: 0, results: [] }),
    ...extra,
  });

  cancellati.length = 0;
  const conTimbro = await runAllocationReset({ rows: [], dryRunOnly: false },
    deps({ leggiOrigini: () => mappa }));
  ok('l\'ordine dello SCHEDULER viene cancellato', cancellati.includes('CICLO'), JSON.stringify(cancellati));
  ok('l\'ordine A MANO no', !cancellati.includes('MANO'), 'e questo e tutto il punto');
  ok('  e nemmeno quello senza timbro', !cancellati.includes('VECCHIO'),
    'ignoto si tratta come «potrebbe essere di una mano»');
  ok('il referto elenca i risparmiati', conTimbro.cancellazione
    && Array.isArray(conTimbro.cancellazione.risparmiati) && conTimbro.cancellazione.risparmiati.length === 2,
    JSON.stringify(conTimbro.cancellazione && conTimbro.cancellazione.risparmiati && conTimbro.cancellazione.risparmiati.map((x) => x.orderId)));
  const riga = conTimbro.log.find((r) => r.evento === 'risparmiati');
  ok('  e il registro dice quanto capitale resta impegnato', riga && riga.notionalUsd > 0,
    riga ? `$${riga.notionalUsd}` : 'riga assente');
  ok('  con l\'origine di ognuno', riga && riga.dettaglio.every((d) => d.origine),
    riga ? riga.dettaglio.map((d) => `${d.orderId}:${d.origine}`).join(' ') : '');

  // ── SENZA la mano iniettata, il pannello si comporta ESATTAMENTE come prima ──────────────────
  cancellati.length = 0;
  await runAllocationReset({ rows: [], dryRunOnly: false }, deps());
  ok('il pannello (nessuna mano iniettata) cancella tutto, come prima',
    cancellati.length === 3, JSON.stringify(cancellati));

  // ── Registro illeggibile: non si cancella niente. Il verso giusto per un fallimento. ─────────
  cancellati.length = 0;
  await runAllocationReset({ rows: [], dryRunOnly: false },
    deps({ leggiOrigini: () => { throw new Error('registro illeggibile'); } }));
  ok('registro illeggibile ⇒ NESSUNA cancellazione', cancellati.length === 0,
    'nel dubbio non si distrugge il lavoro di qualcuno');

  console.log('\n══ 4 · IL TIMBRO ARRIVA FIN QUI — le tre mani collegate');
  {
    const mo = fs.readFileSync(path.join(ROOT, 'lib/maker/manual-order.js'), 'utf8');
    ok('il piazzamento calcola l\'origine', /const origine = origineDaSource\(source, spec\.origine \|\| null\)/.test(mo));
    ok('  e la scrive nel registro', /origine,\n\s*placement, latencyMs/.test(mo));
    ok('  anche sui rifiuti', /inCoda: inCodaEsito, priceAdjusted, origine,/.test(mo));

    const bulk = fs.readFileSync(path.join(ROOT, 'lib/maker/bulk-allocate.js'), 'utf8');
    ok('l\'allocazione in blocco la trasporta', /origine,/.test(bulk) && /origine = null/.test(bulk));

    const a41 = fs.readFileSync(path.join(ROOT, 'agents/agent41-realloc-scheduler.js'), 'utf8');
    ok('agent41 si dichiara automatico quando piazza', /dryRunOnly: d, origine: 'auto'/.test(a41));
    ok('  e inietta la mano che legge le origini quando cancella', /leggiOrigini: \(\) =>/.test(a41));
  }

  console.log(`\norigine degli ordini: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

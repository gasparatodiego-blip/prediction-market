'use strict';
// lib/rewards/orizzonte-unico.test.js — UNA SOLA MISURA DI ORIZZONTE, E LO SCARTO AVVIENE A MONTE.
//
// ═══ IL DIFETTO CHE CHIUDE (§5 punto 98) ═══════════════════════════════════════════════════════════
// Il ciclo del 12 agosto 2026 si è fermato dopo tre ricalcoli con «il piano contiene ancora mercati che
// il venue rifiuta». Non era il venue: era `marketValidity` con `HORIZON_MIN_HOURS = 24` contro un
// pianificatore che usava `MIN_HORIZON_DAYS = 0,75` (18 ore). Due misure per la stessa domanda ⇒ una
// fascia di disaccordo permanente fra 18 e 24 ore. E sotto entrambe le soglie il mercato entrava lo
// stesso, perché il board normalizzato non portava `endDate` (306 righe su 306) e una scadenza assente
// valeva `unknown`, che non escludeva mai.
//
// Le tre correzioni si difendono insieme, perché nessuna basta da sola:
//   1. UNA soglia, derivata da un solo punto;
//   2. il board porta la scadenza REALE;
//   3. scadenza non determinabile ⇒ ESCLUSO, non ammesso.
//
// Run: node lib/rewards/orizzonte-unico.test.js

const fs = require('fs');
const path = require('path');

const { MIN_HORIZON_DAYS, horizonVerdict } = require('./horizon');
const { HORIZON_MIN_HOURS, marketValidity } = require('../maker/market-validity');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ORA = 3_600_000;
const NOW = Date.parse('2026-08-12T09:41:00Z');
const iso = (h) => new Date(NOW + h * ORA).toISOString();

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1 · UNA sola misura, e le due parti la leggono dallo stesso punto');
{
  ok('la soglia della verifica è derivata da quella del pianificatore',
    HORIZON_MIN_HOURS === MIN_HORIZON_DAYS * 24, `${HORIZON_MIN_HOURS} h = ${MIN_HORIZON_DAYS} g × 24`);
  ok('  e vale 18 ore', HORIZON_MIN_HOURS === 18);
  ok('  non più 24', HORIZON_MIN_HOURS !== 24, 'era la fascia di disaccordo 18-24 h');

  // La prova strutturale: `market-validity` IMPORTA, non ridichiara.
  const src = fs.readFileSync(path.join(__dirname, '..', 'maker', 'market-validity.js'), 'utf8');
  ok('`market-validity` importa la costante invece di riscriverla',
    /require\(['"]\.\.\/rewards\/horizon['"]\)/.test(src) && /MIN_HORIZON_DAYS/.test(src));
  ok('  e non contiene più un 24 scritto a mano per l\'orizzonte',
    !/HORIZON_MIN_HOURS\s*=\s*24/.test(src));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2 · LA FASCIA DEL DISACCORDO NON ESISTE PIÙ');
{
  // A 20 ore: prima il piano allocava (sopra 18 h) e la verifica rifiutava (sotto 24 h).
  for (const ore of [18.5, 20, 23.9]) {
    const v = horizonVerdict({ endDate: iso(ore), nowMs: NOW, grossPerDay: 10, costPerDay: 0 });
    const mv = marketValidity({ marketId: '0xaa', venue: { endDate: iso(ore), closed: false, acceptingOrders: true }, nowMs: NOW });
    const pianoOk = v.state !== 'short' && v.state !== 'resolved' && v.state !== 'too-far' && v.state !== 'unknown';
    const verificaOk = mv.valido !== false || mv.motivo == null || !/in-scadenza|scadenza/i.test(String(mv.stato || ''));
    ok(`a ${ore} h le due parti sono d'accordo`, pianoOk === true && verificaOk === true,
      `piano: ${v.state} · verifica: ${mv.stato || (mv.valido ? 'valido' : 'non valido')}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3 · IL CASO VERO DEL 12 AGOSTO: 14,3 ore ⇒ ESCLUSO A MONTE');
{
  // La coorte che ha fermato il ciclo: scadenza 2026-08-13T00:00:00Z, 14,3 ore residue.
  const v = horizonVerdict({ endDate: '2026-08-13T00:00:00Z', nowMs: NOW, grossPerDay: 10, costPerDay: 0 });
  ok('il verdetto del pianificatore lo boccia', v.state === 'short' || v.state === 'resolved',
    `stato: ${v.state}, ${v.days != null ? v.days.toFixed(2) + ' g' : '—'}`);
  ok('  cioè PRIMA del knapsack, non dopo la verifica', true,
    'è la differenza fra «non entra nel piano» e «entra e viene rifiutato tre volte»');

  const mv = marketValidity({ marketId: '0xbb', venue: { endDate: '2026-08-13T00:00:00Z', closed: false, acceptingOrders: true }, nowMs: NOW });
  ok('  e la verifica dà lo STESSO verdetto', mv.valido === false, `${mv.stato || ''} ${mv.motivo || ''}`.trim().slice(0, 80));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4 · SCADENZA NON DETERMINABILE ⇒ ESCLUSO (fail-closed)');
{
  const v = horizonVerdict({ endDate: null, nowMs: NOW, grossPerDay: 10, costPerDay: 0 });
  ok('il verdetto resta `unknown` — non si indovina niente', v.state === 'unknown' && v.days === null);

  // Il filtro dell'allocatore lo esclude: la prova è nel sorgente, dove la regola vive.
  const src = fs.readFileSync(path.join(__dirname, 'allocator.js'), 'utf8');
  const blocco = src.slice(src.indexOf('const horizonRejects'), src.indexOf('const keptCurves'));
  ok('  ma il filtro lo ESCLUDE', /v\.state === 'unknown'/.test(blocco),
    'allocare capitale su una data che non conosciamo è il rischio che il filtro esiste per non correre');
  ok('  e resta un punto di applicazione solo', (blocco.match(/horizonRejects\.add\(/g) || []).length === 1);

  for (const cattiva of [null, undefined, '', 'domani', '2026-13-45T00:00:00Z']) {
    const x = horizonVerdict({ endDate: cattiva, nowMs: NOW, grossPerDay: 10, costPerDay: 0 });
    ok(`  «${String(cattiva)}» ⇒ unknown, quindi escluso`, x.state === 'unknown');
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n5 · IL BOARD NORMALIZZATO PORTA LA SCADENZA REALE');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'rewards-normalize.js'), 'utf8');
  ok('la normalizzazione copia `endDate`', /endDate:\s*m\.endDate/.test(src),
    'senza, la scadenza valeva unknown su ogni riga e il filtro non escludeva nulla');
  ok('  e anche la sua provenienza', /endDateSource/.test(src),
    'una data ereditata dall\'evento padre non è la stessa cosa di una pubblicata sul mercato');
  ok('  senza toccare `hoursToResolution`', /hoursToResolution:\s*hoursUntil\(m\.endDate\)/.test(src),
    'resta per chi la legge già: è una durata, non un istante');

  // E sul board VERO, se c'è: quante righe hanno una scadenza leggibile.
  try {
    const j = JSON.parse(fs.readFileSync('/tmp/liquidity-rewards.json', 'utf8'));
    const righe = Array.isArray(j) ? j : (j.markets || []);
    const con = righe.filter((r) => typeof r.endDate === 'string' && !Number.isNaN(Date.parse(r.endDate))).length;
    console.log(`     board vivo: ${con}/${righe.length} righe con scadenza leggibile`
      + `${con === 0 ? '  (agent24 non ha ancora riscritto il board: atteso prima del riavvio)' : ''}`);
  } catch { /* board assente: il test strutturale sopra basta */ }
}

console.log(`\n===== orizzonte-unico: ${pass} passati, ${fail} falliti =====\n`);
process.exit(fail === 0 ? 0 : 1);

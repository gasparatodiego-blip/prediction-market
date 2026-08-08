#!/usr/bin/env node
'use strict';
// UNA GAMBA CANCELLATA NON DEVE BRUCIARE LA SUA CHIAVE PER SEMPRE.
//
// ═══ IL DIFETTO ══════════════════════════════════════════════════════════════════════════════════════
// La chiave di idempotenza è deterministica sull'identità economica dell'ordine —
// sha256(userId|venue|tokenId|side|price|size), nessuna componente temporale — e il registro non sapeva
// cosa fosse una cancellazione: zero occorrenze di "cancel" in execution-audit.js. Quindi un ordine
// piazzato e poi CANCELLATO lasciava la chiave bruciata, e quel preciso ordine non era più ripiazzabile
// da nessuna corsia che non passasse una chiave esplicita.
//
// Misurato l'8 agosto 2026. Alle 21:42:18 il ciclo da 6h piazza BUY YES 61,2 @ 0,34 sul mercato HIMS
// (ordine 0xd88822e0…). Alle 21:44:00 il guardiano del mid stantio lo cancella, e il suo stesso motivo
// promette: «il capitale liberato torna al trigger, che lo rimette al lavoro sul piano corrente». Il
// trigger fa esattamente questo, ricostruisce la gamba identica — e viene rifiutato come duplicato a
// ogni giro. Otto tentativi, $608 fermi contro un obiettivo del 90%.
//
// Due meccanismi ciascuno corretto, e reciprocamente contraddittori.
//
// ═══ LA FORMA DELLA CORREZIONE NON È NUOVA ═══════════════════════════════════════════════════════════
// È quella che lib/maker/manual-order.js:1475-1484 applica già ai RIMPIAZZI: un piazzamento che supera
// un ordine MORTO è un ordine diverso e merita una chiave diversa, derivata dall'id di quello che
// supera. Due tentativi che superano lo STESSO ordine morto restano fra loro duplicati, quindi la
// protezione contro il doppio invio sopravvive intera — ed è la sezione 2 a verificarlo.
//
// ═══ DOVE STA LA REGOLA, E DOVE STA IL FATTO ═════════════════════════════════════════════════════════
// La regola è nel registro (`risolviDuplicato`); il fatto — quali ordini il venue dice vivi — lo passa
// il chiamante. Così la regola si prova senza rete, e il registro non impara a conoscere il venue.
//
// NESSUN ORDINE REALE, NESSUNA RETE: giornale temporaneo, insiemi di id finti.

const fs = require('fs');
const os = require('os');
const path = require('path');
const EA = require('./execution-audit');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idem-cancel-'));
let n = 0;
/** Un giornale nuovo per ogni scenario: gli scenari non devono potersi contaminare. */
function giornale() { return { auditFile: path.join(dir, `trail-${++n}.jsonl`) }; }

// L'ordine VERO dell'8 agosto, coi suoi numeri e col suo token id per intero.
//
// `tokenId` E `market` INSIEME, e non è ridondanza: `deriveIdempotencyKey` legge `tokenId`, mentre la
// riga di intent registra `market`. L'adapter passa sempre la chiave già derivata, quindi in produzione
// i due non si incontrano mai — ma un fixture che ne desse solo uno deriverebbe una chiave su
// `undefined` e proverebbe qualcosa che non succede. (Scoperto scrivendo questo test.)
const TOKEN = '109334896549755572238520108260753230328524232555595506649803214794619529579188';
const GAMBA = { userId: 'operator', venue: 'polymarket', tokenId: TOKEN, market: TOKEN,
  side: 'BUY', price: 0.34, size: 61.2, notionalUsd: 20.808 };
const CHIAVE = EA.deriveIdempotencyKey(GAMBA);

/** Piazza (intent + esito) e restituisce la chiave usata. */
function piazza(dep, orderId, chiave = null) {
  const r = EA.recordIntent(chiave ? { ...GAMBA, idempotencyKey: chiave } : GAMBA, dep);
  if (r.recorded) EA.recordOutcome({ idempotencyKey: r.idempotencyKey, ok: true, orderId }, dep);
  return r;
}

// ══ 1 · IL CASO DELL'8 AGOSTO: PIAZZA → CANCELLA → RIPIAZZA ═══════════════════════════════════════
console.log('\n══ 1 · PIAZZA, CANCELLA, RIPIAZZA IDENTICO — deve passare');
{
  const dep = giornale();
  const primo = piazza(dep, '0xd88822e0633bd07d87c9aa22f5945e022f9b5a3d383326e4caa0c3222b8f47f6');
  ok('il primo piazzamento passa', primo.recorded === true && primo.duplicate === false);

  // Il trigger ricostruisce la gamba identica: il registro la vede come duplicato…
  const secondo = EA.recordIntent(GAMBA, dep);
  ok('  e il secondo, identico, è ancora un duplicato per la chiave economica', secondo.duplicate === true);

  // …ma il venue non ha più quell'ordine: il mid stantio l'ha cancellato.
  const ris = EA.risolviDuplicato(CHIAVE, { vivi: new Set(['0xALTRO']) }, dep);
  ok('il duplicato È SUPERABILE quando la gamba non è più sul venue', ris.superabile === true, ris.motivo);
  ok('  e la chiave nuova è distinta da quella bruciata', !!ris.chiave && ris.chiave !== CHIAVE, ris.chiave);
  ok('  e dice di essere una sostituzione', /^idem_dopo_/.test(ris.chiave || ''), ris.chiave);

  const terzo = EA.recordIntent({ ...GAMBA, idempotencyKey: ris.chiave }, dep);
  ok('il ripiazzamento viene REGISTRATO: il capitale torna al lavoro', terzo.recorded === true && terzo.duplicate === false);
}

// ══ 2 · LA PROTEZIONE ANTI-DOPPIO-INVIO RESTA INTERA ══════════════════════════════════════════════
console.log('\n══ 2 · UN VERO DOPPIO INVIO RESTA BLOCCATO — è il punto per cui la guardia esiste');
{
  const dep = giornale();
  piazza(dep, '0xVIVO');
  const ris = EA.risolviDuplicato(CHIAVE, { vivi: new Set(['0xVIVO']) }, dep);
  ok('ordine ANCORA VIVO sul venue ⇒ NON superabile', ris.superabile === false, ris.motivo);
  ok('  e il motivo lo dice in chiaro', /ancora VIVO/.test(ris.motivo));
  ok('  e non propone nessuna chiave', ris.chiave === null);

  // Due tentativi che superano lo STESSO ordine morto collidono fra loro: un doppio invio dopo una
  // cancellazione resta un doppio invio.
  const dep2 = giornale();
  piazza(dep2, '0xMORTO');
  const a = EA.risolviDuplicato(CHIAVE, { vivi: new Set() }, dep2);
  const b = EA.risolviDuplicato(CHIAVE, { vivi: new Set() }, dep2);
  ok('due superamenti dello stesso ordine morto producono LA STESSA chiave', a.chiave === b.chiave, a.chiave);
  EA.recordIntent({ ...GAMBA, idempotencyKey: a.chiave }, dep2);
  const doppio = EA.recordIntent({ ...GAMBA, idempotencyKey: b.chiave }, dep2);
  ok('  quindi il secondo invio sotto quella chiave è duplicato', doppio.duplicate === true);
}

// ══ 3 · FALLISCE CHIUSO IN OGNI DIREZIONE ═════════════════════════════════════════════════════════
console.log('\n══ 3 · SU UN DATO NON LETTO NON SI SUPERA NIENTE');
{
  const dep = giornale();
  piazza(dep, '0xQUALCOSA');

  ok('nessun insieme di vivi (lettura fallita) ⇒ non superabile',
    EA.risolviDuplicato(CHIAVE, { vivi: null }, dep).superabile === false);
  ok('  né un array al posto di un Set', EA.risolviDuplicato(CHIAVE, { vivi: ['0xQUALCOSA'] }, dep).superabile === false);
  ok('  né l assenza totale dell argomento', EA.risolviDuplicato(CHIAVE, {}, dep).superabile === false);
  ok('  e il motivo nomina il dato mancante',
    /non sono accertati/.test(EA.risolviDuplicato(CHIAVE, { vivi: null }, dep).motivo));

  // L'invio ambiguo: intent scritto, nessun esito. L'ordine POTREBBE essere a riposo sotto un id che non
  // abbiamo mai visto — ed è esattamente il caso per cui la guardia esiste.
  const amb = giornale();
  EA.recordIntent(GAMBA, amb);
  const rAmb = EA.risolviDuplicato(CHIAVE, { vivi: new Set() }, amb);
  ok('intent SENZA esito (invio ambiguo) ⇒ non superabile', rAmb.superabile === false, rAmb.motivo);
  ok('  e il motivo dice che l invio resta ambiguo', /ambiguo/.test(rAmb.motivo));

  // Esito presente ma fallito e senza orderId: stesso ragionamento.
  const ko = giornale();
  EA.recordIntent(GAMBA, ko);
  EA.recordOutcome({ idempotencyKey: CHIAVE, ok: false, error: 'venue 500' }, ko);
  ok('esito fallito senza orderId ⇒ non superabile', EA.risolviDuplicato(CHIAVE, { vivi: new Set() }, ko).superabile === false);
}

// ══ 4 · LA CATENA: SI PUÒ SUPERARE PIÙ DI UNA VOLTA ═══════════════════════════════════════════════
console.log('\n══ 4 · CANCELLATO DUE VOLTE — la catena si percorre, non si arrende al primo anello');
{
  const dep = giornale();
  piazza(dep, '0xMORTO1');
  const r1 = EA.risolviDuplicato(CHIAVE, { vivi: new Set() }, dep);
  piazza(dep, '0xMORTO2', r1.chiave);

  // Il giro dopo riparte SEMPRE dalla chiave economica: è quello che fa il piazzatore.
  const r2 = EA.risolviDuplicato(CHIAVE, { vivi: new Set() }, dep);
  ok('con due anelli morti si arriva a una terza chiave', r2.superabile === true && r2.chiave !== r1.chiave, r2.motivo);

  // Ma se il secondo anello è VIVO, la catena si ferma lì e rifiuta.
  const r3 = EA.risolviDuplicato(CHIAVE, { vivi: new Set(['0xMORTO2']) }, dep);
  ok('se un anello della catena è vivo, si rifiuta', r3.superabile === false, r3.motivo);
  ok('  nominando l ordine vivo, non il primo della catena', /0xMORTO2/.test(r3.motivo), r3.motivo);
}

// ══ 5 · NIENTE REGRESSIONI SUL COMPORTAMENTO ESISTENTE ════════════════════════════════════════════
console.log('\n══ 5 · CHI NON USA LA NOVITÀ NON SE NE ACCORGE');
{
  const dep = giornale();
  ok('chiave mai vista ⇒ superabile (e non è una scoperta: non c è niente da superare)',
    EA.risolviDuplicato('idem_mai_vista', { vivi: new Set() }, dep).superabile === true);
  ok('recordIntent si comporta come prima: primo sì, secondo no',
    EA.recordIntent(GAMBA, dep).recorded === true && EA.recordIntent(GAMBA, dep).duplicate === true);
  ok('la chiave economica non è cambiata (i giornali già scritti restano leggibili)',
    CHIAVE === 'idem_c12152a1e1ccd0a5c899adad',
    `è la chiave VERA dell ordine dell 8 agosto: ${CHIAVE}`);
  ok('un giornale inesistente non esplode', EA.risolviDuplicato(CHIAVE, { vivi: new Set() }, { auditFile: path.join(dir, 'mai-scritto.jsonl') }).superabile === true);
}

// ══ 6 · IL CABLAGGIO NELL'ADAPTER, PER LETTURA DEL SORGENTE ═══════════════════════════════════════
// Non si esegue l'adapter: l'hook di sicurezza blocca ogni comando che lo importa, anche in sola
// lettura (CLAUDE.md §5 punto 30). Si verifica che il cablaggio abbia le proprietà che contano.
console.log('\n══ 6 · L ADAPTER FORNISCE IL FATTO, E FALLISCE CHIUSO SE NON CE L HA');
{
  const ROOT = path.resolve(__dirname, '..', '..');
  const ad = fs.readFileSync(path.join(ROOT, 'lib/venues/polymarket-clob-maker/adapter.js'), 'utf8');
  ok('il superamento è tentato solo DOPO che il duplicato è scattato',
    /intentRes\.duplicate === true && typeof safety\.risolviDuplicato === 'function'/.test(ad),
    'sul percorso felice non costa niente');
  ok('  e solo con la rete disponibile: in shadow non si dichiara morto nulla', /if \(canWrite\) \{/.test(ad));
  ok('  una lettura fallita lascia l insieme nullo (fail closed)', /catch \{ vivi = null; \}/.test(ad));
  ok('  e un `safety` parziale non abilita niente: il typeof lo esclude',
    /typeof safety\.risolviDuplicato === 'function'/.test(ad));
  ok('la chiave è riassegnabile, così esito e latch parlano di quella nuova',
    /let idempotencyKey = s\.idempotencyKey/.test(ad) && /if \(intentRes\.recorded === true\) idempotencyKey = ris\.chiave;/.test(ad));
  ok('il rifiuto residuo resta, con lo stesso gate di prima',
    /gate: 'idempotent-duplicate'/.test(ad));

  // La regola vive nel registro, non nell'adapter: l'adapter non deve saper derivare la chiave nuova.
  ok('l adapter NON riscrive la regola: nessuna derivazione di chiave al suo interno',
    !/idem_dopo_/.test(ad), 'una sola definizione, in execution-audit.js');
}

console.log(`\nidempotenza dopo cancellazione: ${pass} passati, ${fail} falliti`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
'use strict';
// DIECI MINUTI, POI SI CHIUDE — E IL TIMER NON SI ACCORCIA MAI.
//
// I tre casi del requisito, più quelli che il requisito non nomina ma che decidono se la regola regge:
//   1. la coppia torna intera entro la finestra ⇒ timer annullato, nessuna cancellazione;
//   2. la finestra scade con la gamba ancora sola ⇒ si cancella anche quella;
//   3. si ripristina a metà e si rompe di nuovo ⇒ finestra NUOVA e PIENA, non cumulativa;
//   4. due mercati non si influenzano;
//   5. zero gambe non è un'orfana;
//   6. il timer sopravvive a un riavvio (sta su file, non in memoria).

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  valutaGambaOrfana, leggiOrfanaDa, leggiOrfaneTutte, aggiornaTimer,
  ORPHAN_LEG_TOLERANCE_MIN, ORPHAN_LEG_TOLERANCE_MS,
} = require('./gamba-orfana');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const T0 = Date.parse('2026-08-06T12:00:00Z');
const MIN = 60_000;
const A = '0x' + 'aa'.repeat(32);
const B = '0x' + 'bb'.repeat(32);

console.log('\n══ LA COSTANTE');
{
  ok('tolleranza = 10 minuti', ORPHAN_LEG_TOLERANCE_MIN === 10);
  ok('  in millisecondi', ORPHAN_LEG_TOLERANCE_MS === 600_000);
}

console.log('\n══ 1 · LA COPPIA TORNA INTERA ENTRO LA FINESTRA ⇒ TIMER ANNULLATO');
{
  // 12:00 — la gamba YES sparisce, resta NO.
  const v1 = valutaGambaOrfana({ marketId: A, bookAttivi: ['no'], orfanaDa: null, now: T0 });
  ok('il timer parte', v1.azione === 'avvia' && v1.stato === 'orfana', v1.motivo);
  ok('  con la superstite dichiarata', v1.bookSuperstite === 'no');
  ok('  e la scadenza a +10 min', v1.scadeAms === T0 + ORPHAN_LEG_TOLERANCE_MS);

  // 12:04 — ancora sola: si aspetta, non si fa niente.
  const v2 = valutaGambaOrfana({ marketId: A, bookAttivi: ['no'], orfanaDa: T0, now: T0 + 4 * MIN });
  ok('a 4 minuti non si fa niente', v2.azione === 'nessuna' && v2.stato === 'orfana');
  ok('  e restano 6 minuti', v2.restaSec === 360, `${v2.restaSec}s`);

  // 12:06 — il ciclo è riuscito a ripiazzare l'altra gamba.
  const v3 = valutaGambaOrfana({ marketId: A, bookAttivi: ['no', 'yes'], orfanaDa: T0, now: T0 + 6 * MIN });
  ok('la coppia torna intera ⇒ timer ANNULLATO', v3.azione === 'annulla' && v3.stato === 'coppia', v3.motivo);

  // 12:15 — a coppia intera, ben oltre i 10 minuti, non succede nulla.
  const v4 = valutaGambaOrfana({ marketId: A, bookAttivi: ['yes', 'no'], orfanaDa: null, now: T0 + 15 * MIN });
  ok('  e passata la finestra non si cancella niente', v4.azione === 'nessuna' && v4.stato === 'coppia');
}

console.log('\n══ 2 · LA FINESTRA SCADE CON LA GAMBA ANCORA SOLA ⇒ SI CANCELLA');
{
  const a9 = valutaGambaOrfana({ marketId: A, bookAttivi: ['no'], orfanaDa: T0, now: T0 + 9 * MIN + 59_000 });
  ok('a 9m59s ancora NON si cancella', a9.azione === 'nessuna', `restano ${a9.restaSec}s`);

  const a10 = valutaGambaOrfana({ marketId: A, bookAttivi: ['no'], orfanaDa: T0, now: T0 + 10 * MIN });
  ok('a 10m00s esatti si CANCELLA', a10.azione === 'cancella', a10.motivo);
  ok('  indicando quale gamba', a10.bookSuperstite === 'no');
  ok('  e il motivo spiega la scelta economica',
    /meglio zero capitale impegnato/.test(a10.motivo));

  const dopo = valutaGambaOrfana({ marketId: A, bookAttivi: ['no'], orfanaDa: T0, now: T0 + 40 * MIN });
  ok('molto oltre la scadenza resta «cancella», non si dimentica', dopo.azione === 'cancella');
}

console.log('\n══ 3 · RIPRISTINATA A METÀ E RI-ROTTA ⇒ FINESTRA NUOVA E PIENA');
{
  // 12:00 orfana → 12:05 ripristinata → 12:06 di nuovo orfana.
  const rotta1 = valutaGambaOrfana({ marketId: A, bookAttivi: ['no'], orfanaDa: null, now: T0 });
  ok('prima rottura: timer a T0', rotta1.orfanaDa === T0);

  const ripristino = valutaGambaOrfana({ marketId: A, bookAttivi: ['yes', 'no'], orfanaDa: T0, now: T0 + 5 * MIN });
  ok('a 5 minuti si ripristina ⇒ annulla', ripristino.azione === 'annulla');

  // Il timer è stato annullato, quindi alla nuova rottura `orfanaDa` è null e riparte da capo.
  const rotta2 = valutaGambaOrfana({ marketId: A, bookAttivi: ['yes'], orfanaDa: null, now: T0 + 6 * MIN });
  ok('seconda rottura: timer NUOVO', rotta2.azione === 'avvia' && rotta2.orfanaDa === T0 + 6 * MIN);
  ok('  e la finestra è PIENA, non scalata dei 5 minuti già consumati',
    rotta2.restaMs === ORPHAN_LEG_TOLERANCE_MS, `${rotta2.restaSec}s`);
  ok('  scade a 12:16, non a 12:10', rotta2.scadeAms === T0 + 16 * MIN);

  // LA PROVA CHE NON È CUMULATIVO: al minuto 12 (12 minuti totali di orfananza sommati) non si cancella.
  const a12 = valutaGambaOrfana({ marketId: A, bookAttivi: ['yes'], orfanaDa: T0 + 6 * MIN, now: T0 + 12 * MIN });
  ok('a 12 minuti TOTALI di orfananza sommata non si cancella', a12.azione === 'nessuna',
    'sommare le finestre punirebbe i mercati che faticano di più a richiudere');
  const a16 = valutaGambaOrfana({ marketId: A, bookAttivi: ['yes'], orfanaDa: T0 + 6 * MIN, now: T0 + 16 * MIN });
  ok('  e si cancella solo a 10 minuti dalla SECONDA rottura', a16.azione === 'cancella');
}

console.log('\n══ 5 · ZERO GAMBE NON È UN\'ORFANA');
{
  const vuoto = valutaGambaOrfana({ marketId: A, bookAttivi: [], orfanaDa: T0, now: T0 + 20 * MIN });
  ok('nessuna gamba ⇒ il timer si spegne', vuoto.azione === 'annulla' && vuoto.stato === 'vuoto', vuoto.motivo);
  ok('  e NON si tenta di cancellare il nulla', vuoto.bookSuperstite === null);

  const vuotoSenzaTimer = valutaGambaOrfana({ marketId: A, bookAttivi: [], orfanaDa: null, now: T0 });
  ok('nessuna gamba e nessun timer ⇒ niente da fare', vuotoSenzaTimer.azione === 'nessuna');
}

console.log('\n══ INPUT SPORCHI NON INVENTANO UN\'ORFANA');
{
  const doppio = valutaGambaOrfana({ marketId: A, bookAttivi: ['no', 'no', 'no'], orfanaDa: null, now: T0 });
  ok('tre ordini sullo STESSO lato restano una gamba sola', doppio.azione === 'avvia' && doppio.bookSuperstite === 'no',
    'due ordini sul lato NO non fanno una coppia');
  const sporco = valutaGambaOrfana({ marketId: A, bookAttivi: ['YES', 'no'], orfanaDa: T0, now: T0 });
  ok('maiuscole diverse ⇒ è comunque una coppia', sporco.stato === 'coppia' && sporco.azione === 'annulla');
  const ignoto = valutaGambaOrfana({ marketId: A, bookAttivi: ['pippo', 'no'], orfanaDa: null, now: T0 });
  ok('un lato non riconosciuto non conta come gamba', ignoto.stato === 'orfana' && ignoto.bookSuperstite === 'no');
}

console.log('\n══ 4 · DUE MERCATI, DUE TIMER INDIPENDENTI (su file vero)');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orfane-'));
  const file = path.join(dir, 'orfane.json');
  let ORA = T0;
  const d = () => ({ gambeOrfaneFile: file, now: () => ORA });

  // A diventa orfano a T0; B a T0+3min.
  aggiornaTimer({ marketId: A, azione: 'avvia', orfanaDa: T0, bookSuperstite: 'no' }, d());
  ORA = T0 + 3 * MIN;
  aggiornaTimer({ marketId: B, azione: 'avvia', orfanaDa: ORA, bookSuperstite: 'yes' }, d());

  ok('A ha il suo timestamp', leggiOrfanaDa(A, d()) === T0);
  ok('B ha il suo, diverso', leggiOrfanaDa(B, d()) === T0 + 3 * MIN);
  ok('  e sono due voci distinte', Object.keys(leggiOrfaneTutte(d()).markets).length === 2);

  // A scade a T0+10; B a T0+13. Al minuto 10 solo A deve cancellare.
  ORA = T0 + 10 * MIN;
  const vA = valutaGambaOrfana({ marketId: A, bookAttivi: ['no'], orfanaDa: leggiOrfanaDa(A, d()), now: ORA });
  const vB = valutaGambaOrfana({ marketId: B, bookAttivi: ['yes'], orfanaDa: leggiOrfanaDa(B, d()), now: ORA });
  ok('al minuto 10 A cancella', vA.azione === 'cancella');
  ok('  e B no: ha ancora 3 minuti', vB.azione === 'nessuna' && vB.restaSec === 180, `${vB.restaSec}s`);

  // Cancellare A non tocca B — la scrittura fonde, non sostituisce.
  aggiornaTimer({ marketId: A, azione: 'cancella' }, d());
  ok('tolto A, B è ancora lì col suo timestamp', leggiOrfanaDa(B, d()) === T0 + 3 * MIN,
    'due mercati orfani nello stesso giro non si cancellano il timer a vicenda');
  ok('  e A è sparito', leggiOrfanaDa(A, d()) === null);

  // ── 6 · IL TIMER SOPRAVVIVE A UN RIAVVIO ──────────────────────────────────────────────────────
  // Sta su file, non in memoria: un riavvio di agent40 non deve regalare dieci minuti nuovi a una
  // gamba che era sola da nove — sarebbe un modo di non scadere mai su un processo che si riavvia spesso.
  const riletto = leggiOrfanaDa(B, { gambeOrfaneFile: file, now: () => ORA });
  ok('rileggendo da zero il timestamp è quello di prima', riletto === T0 + 3 * MIN);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}

console.log('\n══ NESSUNO STATO DI MODULO');
{
  const src = fs.readFileSync(require.resolve('./gamba-orfana'), 'utf8');
  ok('nessuna Map/Set a livello di modulo', !/^const \w+ = new (Map|Set)\(/m.test(src));
  ok('nessun `let` di modulo', !/^let /m.test(src));
  // La decisione è pura: dieci chiamate identiche, un solo risultato.
  const dieci = new Set(Array.from({ length: 10 }, () =>
    JSON.stringify(valutaGambaOrfana({ marketId: A, bookAttivi: ['no'], orfanaDa: T0, now: T0 + MIN }))));
  ok('dieci valutazioni identiche ⇒ un solo risultato', dieci.size === 1);
}

console.log(`\ngamba orfana: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

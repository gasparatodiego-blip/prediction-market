'use strict';
// lib/maker/punto-unico-mercati.test.js — IL NUMERO DI MERCATI HA UNA FONTE SOLA, E NESSUN DIFETTO.
//
// ═══ COSA DIFENDE, E PERCHE' SONO PROPRIETA' E NON FOTOGRAFIE ════════════════════════════════════
// Nessuna asserzione qui dentro nomina il numero 18, 19 o 20. Il numero in servizio e' una manopola
// che l'operatore gira apposta, e un test che lo fotografa diventa rosso il giorno in cui viene
// girato — cioe' proprio quando serve verde (§5.3, «non asserire su un conteggio»). Si difende:
//   ① variabile ASSENTE                       ⇒ THROW, e il messaggio nomina la variabile
//   ② valore FUORI RANGE (e non numerico)     ⇒ THROW
//   ③ N che ROMPE l'invariante cap            ⇒ THROW, coi numeri nell'errore
//   ④ N in servizio col cap in servizio       ⇒ PASSA
//   ⑤ nessun DIFETTO residuo in `selezione-mercati` (per assenza)
//   ⑥ il numero dichiarato e' UNO SOLO per i due processi (per identita', non per valore)
//
// ⚠ ROSSO SUL SORGENTE NON CORRETTO: ognuno dei blocchi ① ② ③ ⑤ fallisce sull'albero di ieri, dove
// `quantiMercati` rispondeva col difetto invece di sollevare e `MAX_MERCATI_CONTEMPORANEI` esisteva.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SEL = require('./selezione-mercati');
const QM = require('./quanti-mercati');
const INV = require('../safety/invariante-cap-slot');
const { MARKET_CAP_FIXED_USD } = require('../rewards/concentration');
const { HARD_CEILINGS } = require('../safety/risk-limits');

let pass = 0; let fail = 0;
const ok = (t, c, d) => { if (c) { pass += 1; console.log('  ok  ', t); } else { fail += 1; console.log('  FAIL', t, d === undefined ? '' : d); } };
const solleva = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const ENV = QM.ENV_QUANTI;
const tmp = path.join(os.tmpdir(), `punto-unico-${process.pid}.json`);
const capFile = (cap) => { fs.writeFileSync(tmp, JSON.stringify({ global: { maxOpenNotionalUsd: cap } })); return tmp; };

// ── ① ASSENZA ⇒ THROW ────────────────────────────────────────────────────────────────────────────
console.log('\n① la variabile assente ferma il processo');
{
  const e1 = solleva(() => QM.quantiMercati({}));
  ok('variabile assente ⇒ SOLLEVA', e1 !== null);
  ok('  e il messaggio nomina la variabile', !!e1 && String(e1.message).includes(ENV), e1 && e1.message);
  const e2 = solleva(() => QM.quantiMercati(null));
  ok('ambiente inesistente ⇒ SOLLEVA', e2 !== null);
  const e3 = solleva(() => QM.quantiMercati({ [ENV]: '' }));
  ok('variabile vuota ⇒ SOLLEVA (e non e\' lo stesso caso dell\'assenza)',
    e3 !== null && /VUOTA/.test(e3.message));
  // ⚠ `Number(null) === 0`: il difetto piu' ricorrente del repo non deve poter dire «zero mercati».
  const e4 = solleva(() => QM.quantiMercati({ [ENV]: null }));
  ok('valore null ⇒ SOLLEVA, mai «zero mercati»', e4 !== null);
}

// ── ② FUORI RANGE ⇒ THROW ────────────────────────────────────────────────────────────────────────
console.log('\n② un valore fuori dall\'intervallo, o non intero, ferma il processo');
{
  const min = SEL.LIMITE_SLOT.min; const max = SEL.LIMITE_SLOT.max;
  // ⚠ I CONFINI SI DERIVANO DAL RANGE, non si scrivono: e' la lezione del letterale '4' di
  // `quanti-mercati` (§5-bis), che divento' rosso quando il tetto passo' da 3 a 12.
  for (const v of [String(min - 1), String(max + 1), '0', '-3', '2.5', 'due', 'true', 'NaN', 'Infinity', '  ']) {
    ok(`"${v}" ⇒ SOLLEVA`, solleva(() => QM.quantiMercati({ [ENV]: v })) !== null);
  }
  ok(`i due estremi del range sono AMMESSI (${min} e ${max})`,
    QM.quantiMercati({ [ENV]: String(min) }).quanti === min
    && QM.quantiMercati({ [ENV]: String(max) }).quanti === max);
  // ⚠ E la stessa aritmetica vale nel modulo PURO: chi chiama `decidiSelezione` senza `max` non
  // ottiene «quelli di sempre».
  ok('decidiSelezione senza `max` ⇒ SOLLEVA',
    solleva(() => SEL.decidiSelezione({ board: [], stato: SEL.statoVuoto(),
      posizioni: { leggibile: true, conditionIds: [] }, ora: Date.now() })) !== null);
  ok('quotaScaglioni senza argomento ⇒ SOLLEVA', solleva(() => SEL.quotaScaglioni()) !== null);
  ok('partizionaSlot senza totale ⇒ SOLLEVA', solleva(() => SEL.partizionaSlot(undefined, 2)) !== null);
}

// ── ③ N CHE ROMPE L'INVARIANTE ⇒ THROW ───────────────────────────────────────────────────────────
console.log('\n③ un N che romperebbe `N x 2 x tetto <= cap` ferma il processo');
{
  const capInServizio = (() => {
    try { return Number(JSON.parse(fs.readFileSync(INV.misuraInvariante.name && require('../safety/risk-limits').CONFIG_FILE, 'utf8')).global.maxOpenNotionalUsd); }
    catch { return null; }
  })();
  ok('il cap versionato e\' leggibile', Number.isFinite(capInServizio), `${capInServizio}`);
  const capEff = Math.min(capInServizio, HARD_CEILINGS.maxOpenNotionalUsd);
  // ⚠ IL PRIMO N CHE ROMPE SI DERIVA DAL CAP, non si scrive: se domani il cap cambia, questo blocco
  // continua a provare la proprieta' giusta invece di diventare rosso su un numero vecchio.
  const primoRotto = Math.floor(capEff / (2 * MARKET_CAP_FIXED_USD)) + 1;
  if (primoRotto <= SEL.LIMITE_SLOT.max) {
    const err = process.stderr.write; process.stderr.write = () => true;
    const e = solleva(() => INV.esigiInvarianteCapSlot({ env: { [ENV]: String(primoRotto) }, configFile: capFile(capInServizio) }));
    process.stderr.write = err;
    ok(`N=${primoRotto} (il primo che sfora $${capEff}) ⇒ SOLLEVA`, e !== null);
    ok('  e l\'errore porta N, il prodotto, il cap e il tetto duro',
      !!(e && e.invariante && e.invariante.N === primoRotto
        && Number.isFinite(e.invariante.richiestoUsd)
        && Number.isFinite(e.invariante.capVersionatoUsd)
        && Number.isFinite(e.invariante.tettoDuroUsd)),
      e && JSON.stringify(e.invariante));
    ok(`  e l'ultimo N buono (${primoRotto - 1}) NON solleva`,
      solleva(() => INV.esigiInvarianteCapSlot({ env: { [ENV]: String(primoRotto - 1) }, configFile: capFile(capInServizio) })) === null);
  } else {
    // ⚠ Se il range sintattico morde prima dell'invariante lo si dichiara invece di saltare il blocco.
    ok(`il range (max ${SEL.LIMITE_SLOT.max}) morde prima dell'invariante (primo rotto ${primoRotto}): il cancello e' comunque chiuso`,
      solleva(() => QM.quantiMercati({ [ENV]: String(primoRotto) })) !== null);
  }
  // ⚠ FAIL-CLOSED: un cap illeggibile non e' «nessun cap».
  ok('cap illeggibile ⇒ invariante NON ok', INV.misuraInvariante({ env: { [ENV]: '1' }, configFile: '/dev/null/assente.json' }).ok === false);
}

// ── ④ IL CASO IN SERVIZIO PASSA ──────────────────────────────────────────────────────────────────
console.log('\n④ N e cap dichiarati nella configurazione stanno insieme');
{
  const eco = require('../../agents/ecosystem.config.js');
  const app41 = eco.apps.find((a) => a.name === 'agent41-realloc-scheduler');
  const app40 = eco.apps.find((a) => a.name === 'agent40-manual-reprice');
  ok('agent41 dichiara la variabile', !!(app41 && app41.env && app41.env[ENV]));
  ok('agent40 la dichiara anche lui (gli serve per l\'invariante d\'avvio)', !!(app40 && app40.env && app40.env[ENV]));
  // ⑥ ⚠ PER IDENTITA', NON PER VALORE: si difende «e' lo stesso numero», non «e' 18».
  ok('⑥ i due processi leggono LO STESSO numero', app40.env[ENV] === app41.env[ENV],
    `${app40 && app40.env[ENV]} vs ${app41 && app41.env[ENV]}`);
  const N = QM.quantiMercati(app41.env).quanti;
  const r = INV.misuraInvariante({ env: app41.env });
  ok(`N=${N} dichiarato: l'invariante REGGE col cap in servizio`, r.ok === true, r.motivo);
  ok('  e la composizione si deriva da quel N senza ridichiararlo',
    SEL.quotaScaglioni(N).reduce((a, b) => a + b.posti, 0) === N);
  console.log(`     ${r.motivo}`);
}

// ── ⑤ NESSUN DIFETTO RESIDUO — PER ASSENZA ───────────────────────────────────────────────────────
console.log('\n⑤ nel modulo puro non e\' rimasto nessun difetto numerico');
{
  ok('`selezione-mercati` non esporta piu\' MAX_MERCATI_CONTEMPORANEI', SEL.MAX_MERCATI_CONTEMPORANEI === undefined);
  ok('`selezione-mercati` non esporta piu\' QUOTA_SCAGLIONI', SEL.QUOTA_SCAGLIONI === undefined);
  ok('`quanti-mercati` non esporta piu\' un difetto', QM.QUANTI_DI_DIFETTO === undefined && QM.QUANTI_MASSIMO === undefined);
  // ⚠ SI FILTRANO I COMMENTI: un commento che racconta la riga corretta ha gia' fatto passare un
  // test che cercava la stringa nel sorgente (§5.3).
  const vive = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('nessuna riga VIVA di `selezione-mercati` dichiara un MAX_MERCATI_CONTEMPORANEI',
    !/const\s+MAX_MERCATI_CONTEMPORANEI\s*=/.test(vive('selezione-mercati.js')));
  ok('nessuna riga VIVA di `quanti-mercati` dichiara un difetto',
    !/QUANTI_DI_DIFETTO\s*=/.test(vive('quanti-mercati.js')));
  // ⚠ L'UNICO POSTO DA CUI IL NUMERO PUO' ENTRARE E' L'AMBIENTE, e si difende per assenza.
  const q = vive('quanti-mercati.js');
  const letture = (q.match(/env\s*\[\s*ENV_QUANTI\s*\]/g) || []).length;
  ok('`quanti-mercati` legge la variabile in un punto solo (piu\' la variante reporter)', letture <= 3, `${letture}`);
  ok('`selezione-mercati` resta PURO: zero require',
    (fs.readFileSync(path.join(__dirname, 'selezione-mercati.js'), 'utf8').match(/require\(/g) || []).length === 0);
}

// ── ⑦ IL CANCELLO E' DAVVERO CABLATO NEI DUE AGENT, E CON LA STESSA GUARDIA DI `main()` ──────────
console.log('\n⑦ l\'invariante e\' cablata all\'avvio dei due processi, non solo scritta');
{
  for (const f of ['agent40-manual-reprice.js', 'agent41-realloc-scheduler.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents', f), 'utf8');
    const vive = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok(`${f} chiama esigiInvarianteCapSlot`, /esigiInvarianteCapSlot\(/.test(vive));
    // ⚠ PER IDENTITA' DI GUARDIA: il cancello dev'essere sotto la STESSA condizione che protegge il
    // lavoro vero. Se un giorno `main()` girasse anche su import, il cancello girerebbe con lui.
    ok(`  e sta sotto la stessa guardia \`require.main === module\` di main()`,
      /require\.main === module[\s\S]{0,220}esigiInvarianteCapSlot/.test(vive)
      && /require\.main === module/.test(vive));
    // ⚠ E il file dev'essere IMPORTABILE senza l'ambiente, o ogni test che lo ispeziona muore.
    ok(`  e ${f} resta importabile senza ${ENV} in ambiente`, (() => {
      const salvato = process.env[ENV]; delete process.env[ENV];
      try { require(path.join(__dirname, '..', '..', 'agents', f)); return true; }
      catch (e) { console.log('       ', String(e.message).slice(0, 120)); return false; }
      finally { if (salvato !== undefined) process.env[ENV] = salvato; }
    })());
  }
}

try { fs.unlinkSync(tmp); } catch { /* niente */ }
console.log(`\npunto unico mercati: ${pass} passati, ${fail} falliti\n`);
process.exit(fail === 0 ? 0 : 1);

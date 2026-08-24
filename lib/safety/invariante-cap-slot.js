'use strict';
// lib/safety/invariante-cap-slot.js — L'INVARIANTE FRA QUANTI MERCATI E QUANTO CAPITALE.
// UN CONTROLLO SOLO, CONDIVISO, ALL'AVVIO DEI DUE PROCESSI CHE DECIDONO UN PREZZO.
//
// ═══ L'INVARIANTE ════════════════════════════════════════════════════════════════════════════════
//
//     N x 2 x TETTO_PER_MERCATO_USD  <=  min(cap versionato su disco, HARD_CEILINGS.maxOpenNotionalUsd)
//
// A sinistra c'e' l'esposizione MASSIMA RAGGIUNGIBILE (§5.2 p.37): N coppie a riposo **piu' il loro
// completamento**, perche' la coppia a riposo costa il capitale del mercato e riempirsi lo costa di
// nuovo. A destra c'e' il tetto che il gate applichera' davvero — il `min`, non il numero versionato,
// perche' `clampNum` fa `min(disco, tetto duro)` **senza sollevare**: un cap scritto piu' alto del
// tetto duro sarebbe in servizio al valore duro, cioe' un numero deciso dall'operatore e
// silenziosamente diverso da quello applicato (§4.2).
//
// ═══ PERCHE' UN CONTROLLO ALL'AVVIO E NON UN CLAMP ═══════════════════════════════════════════════
// Un cap piu' stretto dell'esposizione raggiungibile **non e' un limite piu' prudente**: e' un gate
// che smette di piazzare A META' STRADA. `evaluateLimits` confronta `openNotionalUsd + notional`
// anche sulle APERTURE, quindi con N slot autorizzati e un cap che ne copre N-3 il bot apre finche'
// ci sta e poi rifiuta — lasciando coppie incomplete, cioe' gambe nude, cioe' esattamente il rischio
// direzionale che tutto il resto esiste per evitare. Successe il 16 agosto a cap $150.
// ⚠⚠ E LA CURA NON E' ALZARE IL CAP. Il cap e' un BUDGET, non un permesso (`realloc-cycle.js:242`
// fa `capitale = min(saldo, cap)` PRIMA del knapsack): alzarlo e' un ORDINE DI ALLOCARE DI PIU'.
// Chi trova questa invariante rotta abbassa N, non alza il cap. Questo modulo non alza niente e non
// scrive niente: legge, confronta, e ferma il processo.
//
// ═══ RUMOROSAMENTE ═══════════════════════════════════════════════════════════════════════════════
// Su rottura si stampa su stderr N, il prodotto, il cap versionato, il tetto duro e il cap effettivo,
// e si solleva. Un'invariante che fallisce in silenzio e' una difesa che si conta e non c'e'.
//
// ⚠ NON HA VALORI PROPRI. `N` viene da `quanti-mercati` (che a sua volta viene SOLO dall'ambiente e
// solleva se manca), il tetto per mercato e il prodotto da `concentration` — la definizione unica di
// §5.2 p.37 — il cap dal file versionato e il tetto duro da `risk-limits`. Nessun letterale qui
// dentro sarebbe una quinta copia di numeri che devono restare uno solo (reperto D1).

const fs = require('fs');

const { quantiMercati } = require('../maker/quanti-mercati');
const { MARKET_CAP_FIXED_USD, esposizioneMassimaRaggiungibileUsd } = require('../rewards/concentration');
const { HARD_CEILINGS, CONFIG_FILE } = require('./risk-limits');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * MISURA E BASTA — non solleva, non stampa. Serve a chi RACCONTA (stato.js, i test, un referto).
 *
 * @param {object}  opts.env         ambiente da cui leggere N; di norma `process.env`
 * @param {string}  opts.configFile  il file dei limiti versionati; di norma quello vero
 * @returns {{ok:boolean, N:(number|null), tettoPerMercatoUsd:number, richiestoUsd:(number|null),
 *            capVersionatoUsd:(number|null), tettoDuroUsd:number, capEffettivoUsd:(number|null),
 *            margineUsd:(number|null), motivo:string}}
 */
function misuraInvariante({ env = process.env, configFile = CONFIG_FILE } = {}) {
  const tettoDuroUsd = HARD_CEILINGS.maxOpenNotionalUsd;
  const base = { tettoPerMercatoUsd: MARKET_CAP_FIXED_USD, tettoDuroUsd };

  // ⚠ SI LASCIA SALIRE. Se `MAKER_MERCATI_CONTEMPORANEI` manca o e' scritta male il processo non deve
  // partire, e il messaggio giusto e' quello di `quanti-mercati`, non uno riscritto qui.
  const N = quantiMercati(env).quanti;

  let suDisco = null;
  try { suDisco = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { suDisco = null; }
  const capVersionatoUsd = suDisco && suDisco.global && fin(Number(suDisco.global.maxOpenNotionalUsd))
    ? Number(suDisco.global.maxOpenNotionalUsd) : null;

  // ⚠ FAIL-CLOSED: un cap che non si legge non e' «nessun cap». Il gate stesso fallisce chiuso
  // (`clampNum` marca `missing`, `manual-order` rifiuta con `cap-missing`), quindi un processo che
  // partisse qui direbbe «invariante rispettata» su un limite che non esiste.
  if (capVersionatoUsd === null) {
    return { ...base, ok: false, N, richiestoUsd: esposizioneMassimaRaggiungibileUsd(N),
      capVersionatoUsd: null, capEffettivoUsd: null, margineUsd: null,
      motivo: `il cap versionato non e' leggibile da ${configFile}: non si giudica un'invariante`
        + ' contro un limite che non si e\' letto, e non si parte' };
  }

  const richiestoUsd = esposizioneMassimaRaggiungibileUsd(N);
  const capEffettivoUsd = Math.min(capVersionatoUsd, tettoDuroUsd);
  const margineUsd = +(capEffettivoUsd - richiestoUsd).toFixed(2);
  const ok = richiestoUsd <= capEffettivoUsd;
  return {
    ...base, ok, N, richiestoUsd, capVersionatoUsd, capEffettivoUsd, margineUsd,
    motivo: ok
      ? `N=${N} x 2 x $${MARKET_CAP_FIXED_USD} = $${richiestoUsd} <= cap effettivo $${capEffettivoUsd}`
        + ` (versionato $${capVersionatoUsd}, tetto duro $${tettoDuroUsd}) — margine $${margineUsd}`
      : `N=${N} x 2 x $${MARKET_CAP_FIXED_USD} = $${richiestoUsd} SUPERA il cap effettivo`
        + ` $${capEffettivoUsd} (versionato $${capVersionatoUsd}, tetto duro $${tettoDuroUsd})`
        + ` di $${(-margineUsd).toFixed(2)}`,
  };
}

/**
 * IL CANCELLO. Si chiama all'avvio di agent40 e agent41, prima di qualunque altra cosa.
 * ⚠ Stampa su stderr **e** solleva: il log serve a chi guarda `pm2 logs`, l'eccezione serve a pm2.
 */
function esigiInvarianteCapSlot({ env = process.env, configFile = CONFIG_FILE, processo = '' } = {}) {
  const r = misuraInvariante({ env, configFile });
  if (r.ok) return r;
  const righe = [
    '',
    '════════════════════════════════════════════════════════════════════════════════════',
    `⛔ INVARIANTE CAP ≥ ESPOSIZIONE ROTTA${processo ? ' — ' + processo : ''}: IL PROCESSO NON PARTE`,
    '════════════════════════════════════════════════════════════════════════════════════',
    `  N (MAKER_MERCATI_CONTEMPORANEI)      ${r.N}`,
    `  tetto per mercato                    $${r.tettoPerMercatoUsd}`,
    `  N x 2 x tetto  (esposizione max)     $${r.richiestoUsd}`,
    `  cap versionato (data/safety-risk-limits.json)  $${r.capVersionatoUsd}`,
    `  HARD_CEILINGS.maxOpenNotionalUsd     $${r.tettoDuroUsd}`,
    `  cap EFFETTIVO = min(versionato, duro)  $${r.capEffettivoUsd}`,
    '',
    '  ⚠ LA CURA E\' ABBASSARE N, NON ALZARE IL CAP: il cap e\' un BUDGET, non un permesso —',
    '    `realloc-cycle` fa `capitale = min(saldo, cap)` PRIMA del knapsack, quindi alzarlo e\'',
    '    un ordine di allocare di piu\'. Un cap piu\' stretto dell\'esposizione raggiungibile fa',
    '    smettere di piazzare A META\' STRADA e lascia gambe nude (§4.2, il guasto del 16 agosto).',
    '════════════════════════════════════════════════════════════════════════════════════',
    '',
  ];
  process.stderr.write(righe.join('\n') + '\n');
  const e = new Error(`invariante cap/slot rotta: ${r.motivo}`);
  e.invariante = r;
  throw e;
}

function selfcheck() {
  let pass = 0; let fail = 0;
  const ok = (t, c, d) => { if (c) { pass += 1; console.log('  ok  ', t); } else { fail += 1; console.log('  FAIL', t, d || ''); } };
  const T = MARKET_CAP_FIXED_USD;
  const tmp = require('path').join(require('os').tmpdir(), `inv-cap-slot-${process.pid}.json`);
  const scrivi = (cap) => { fs.writeFileSync(tmp, JSON.stringify({ global: { maxOpenNotionalUsd: cap } })); return tmp; };

  // ① il caso in servizio
  const f2400 = scrivi(2400);
  const r18 = misuraInvariante({ env: { MAKER_MERCATI_CONTEMPORANEI: '18' }, configFile: f2400 });
  ok(`① N=18 con cap $2400 passa (18x2x$${T} = $${r18.richiestoUsd})`, r18.ok === true, r18.motivo);

  // ② il primo N che rompe, DERIVATO e non fotografato
  const capEff = Math.min(2400, HARD_CEILINGS.maxOpenNotionalUsd);
  const primoRotto = Math.floor(capEff / (2 * T)) + 1;
  const rRotto = misuraInvariante({ env: { MAKER_MERCATI_CONTEMPORANEI: String(primoRotto) }, configFile: f2400 });
  ok(`② N=${primoRotto} rompe l'invariante ($${rRotto.richiestoUsd} > $${capEff})`, rRotto.ok === false, rRotto.motivo);
  ok('  e l\'ultimo N buono passa',
    misuraInvariante({ env: { MAKER_MERCATI_CONTEMPORANEI: String(primoRotto - 1) }, configFile: f2400 }).ok === true);

  // ③ il cancello SOLLEVA, non si limita a dire ok:false
  let alzata = null;
  const err = process.stderr.write; process.stderr.write = () => true;
  try { esigiInvarianteCapSlot({ env: { MAKER_MERCATI_CONTEMPORANEI: String(primoRotto) }, configFile: f2400 }); }
  catch (e) { alzata = e; } finally { process.stderr.write = err; }
  ok('③ il cancello SOLLEVA su invariante rotta', alzata !== null);
  ok('  e porta con se\' i numeri', !!(alzata && alzata.invariante && alzata.invariante.N === primoRotto));

  // ④ cap illeggibile ⇒ NON passa (fail-closed)
  ok('④ cap illeggibile ⇒ ok:false, mai «nessun cap»',
    misuraInvariante({ env: { MAKER_MERCATI_CONTEMPORANEI: '18' }, configFile: '/dev/null/assente.json' }).ok === false);

  // ⑤ il tetto duro morde anche se il disco e' piu' alto
  const fAlto = scrivi(HARD_CEILINGS.maxOpenNotionalUsd + 1000);
  const rAlto = misuraInvariante({ env: { MAKER_MERCATI_CONTEMPORANEI: '18' }, configFile: fAlto });
  ok('⑤ il cap effettivo e\' il min(disco, tetto duro), non il disco',
    rAlto.capEffettivoUsd === HARD_CEILINGS.maxOpenNotionalUsd, `${rAlto.capEffettivoUsd}`);

  // ⑥ N assente ⇒ solleva da quanti-mercati, non «invariante ok»
  let alzata2 = null;
  try { misuraInvariante({ env: {}, configFile: f2400 }); } catch (e) { alzata2 = e; }
  ok('⑥ N assente ⇒ SOLLEVA (non «invariante rispettata»)',
    alzata2 !== null && /MAKER_MERCATI_CONTEMPORANEI/.test(String(alzata2.message)));

  try { fs.unlinkSync(tmp); } catch { /* niente */ }
  console.log(`\ninvariante cap/slot: ${pass} passati, ${fail} falliti\n`);
  return fail === 0;
}

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

module.exports = { misuraInvariante, esigiInvarianteCapSlot, selfcheck };

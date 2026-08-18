'use strict';
// lib/maker/tetti-per-giro-e-scope.test.js — I TETTI PER GIRO, E LO SCOPE DEL RINNOVO.
//
// ═══ COSA DIFENDE, E PERCHE' ESISTE ══════════════════════════════════════════════════════════════
// Il 12 agosto 2026 il bot girava con capitale reale al 42,6% di utilizzo contro un obiettivo del 90%,
// e non saliva. La misura ha trovato DUE cause, non una, e stanno sulla stessa finestra da 60 secondi:
//
//   ① il tetto di 6 mercati per giro lasciava fermo meta' del capitale con 17 righe di piano
//      disponibili — referto del mini-ciclo delle 20:57:26Z: `motivoStop: «tetto di 6 mercati per giro
//      raggiunto»`, `allocatoUsd 156`, `residuoUsd 331,67`;
//
//   ② `maxOrdersPerWindow: 20` era CONDIVISO fra la corsia che piazza (a raffica) e quella che rinnova
//      (cancel→replace). La raffica consumava la finestra e i rinnovi venivano rifiutati. Misurato:
//      10 invii alle 20:51 → 18 `skip-rate-limited` nello stesso minuto → 6 `scaduto-senza-rinnovo`
//      alle 20:54. Gli ordini morivano per scadenza GTD perche' il tetto anti-runaway non lasciava
//      spazio al rinnovo che li teneva vivi.
//
// Piu' una lacuna di copertura che NON era la causa di oggi ma lo diventa appena il piano ruota:
//
//   ③ lo scope del rinnovo era la sola allowlist di piano, quindi un mercato uscito dal piano con
//      ordini ancora sopra non veniva piu' visitato e li perdeva per scadenza.
//
// ⚠ LE PROPRIETA' QUI SOTTO SONO RELAZIONI, NON VALORI. Un test che asserisse «12» e «40» diventerebbe
// rosso al prossimo cambio di taratura senza segnalare nessun difetto. Quello che deve restare vero e'
// che `maxOrdersPerWindow >= 2 x MAX_NUOVI_PER_GIRO` con margine, e che il numero di mercati per giro
// viva in UN posto solo. I valori si leggono dai moduli, mai ricopiati.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const UTIL = require('./utilizzo-capitale');
const TRIG = require('./trigger-capitale-fermo');

let n = 0;
const ok = (name, cond, extra) => {
  assert.ok(cond, 'FAIL: ' + name + (extra ? ' — ' + extra : ''));
  console.log('  ✓ ' + name);
  n += 1;
};

console.log('\n① IL NUMERO DI MERCATI PER GIRO VIVE IN UN POSTO SOLO');

ok('utilizzo-capitale esporta il tetto per giro',
  Number.isFinite(UTIL.MAX_NUOVI_PER_GIRO) && UTIL.MAX_NUOVI_PER_GIRO >= 1,
  `vale ${UTIL.MAX_NUOVI_PER_GIRO}`);

ok('trigger-capitale-fermo NON ridichiara il numero: coincide con quello condiviso',
  TRIG.MAX_MERCATI_PER_GIRO === UTIL.MAX_NUOVI_PER_GIRO,
  `trigger ${TRIG.MAX_MERCATI_PER_GIRO} vs utilizzo ${UTIL.MAX_NUOVI_PER_GIRO}`);

// La proprieta' strutturale: il sorgente del trigger non deve contenere un letterale di difetto suo.
// E' il reperto che il rilevatore D1 cerca — due copie dello stesso concetto che divergono in silenzio.
{
  const src = fs.readFileSync(path.join(__dirname, 'trigger-capitale-fermo.js'), 'utf8');
  const righeVive = src.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  const dichiara = /MAX_MERCATI_PER_GIRO\s*=\s*Number\(process\.env\.TRIGGER_CAPITALE_MAX_MERCATI\s*\|\|\s*\d+\)/.test(righeVive);
  ok('il trigger non ha piu' + "' un valore di difetto proprio (importa quello condiviso)", !dichiara);
  ok('il trigger importa utilizzo-capitale per il difetto',
    /require\(['"]\.\/utilizzo-capitale['"]\)\s*\.leggiMaxNuoviPerGiro\(\)/.test(righeVive));
}

console.log('\n② IL TETTO DEGLI INVII REGGE UN GIRO INTERO, COPPIE COMPRESE');

const limiti = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'safety-risk-limits.json'), 'utf8'));
const rateCap = limiti.global.maxOrdersPerWindow;
const perGiro = UTIL.MAX_NUOVI_PER_GIRO;

ok('il tetto per finestra e un numero leggibile', Number.isFinite(rateCap), String(rateCap));

// LA RELAZIONE CHE CONTA. Un giro da N mercati chiede 2N invii: una coppia sono due gambe, e
// bulk-allocate le conta INSIEME (non spezza mai una coppia a meta'). Sotto 2N l'ultima coppia del
// giro viene saltata e il giro non copre quello che il piano gli ha dato.
ok('il tetto per finestra copre un giro intero: rateCap >= 2 x mercati-per-giro',
  rateCap >= 2 * perGiro,
  `rateCap ${rateCap} contro ${2 * perGiro} richiesti da ${perGiro} mercati`);

// IL MARGINE PER I RINNOVI, che e' la seconda causa. La finestra e' condivisa: se il tetto fosse
// ESATTAMENTE 2N, la raffica lo consumerebbe tutto e ogni rinnovo nella stessa finestra verrebbe
// rifiutato — che e' letteralmente l'incidente delle 20:51 del 12 agosto.
ok('resta margine per la corsia di rinnovo dopo la raffica',
  rateCap - 2 * perGiro >= 8,
  `margine ${rateCap - 2 * perGiro} posti dopo ${2 * perGiro} invii`);

// E resta un tetto anti-runaway vero: sotto il ceiling del codice, che lo taglia comunque.
{
  const rl = require('../safety/risk-limits');
  const ceiling = (rl.HARD_CEILINGS && rl.HARD_CEILINGS.maxOrdersPerWindow) || 60;
  ok('il tetto resta sotto il ceiling del codice', rateCap <= ceiling, `${rateCap} <= ${ceiling}`);
  ok('il tetto resta un limite vero, non una porta aperta', rateCap < ceiling * 1.0 && rateCap > 0);
}

// La finestra non e' stata allargata: allungarla indebolirebbe il tetto senza dirlo.
ok('la finestra del rate limit e ancora 60s', limiti.global.windowMs === 60000, String(limiti.global.windowMs));

console.log('\n③ GLI ALTRI TETTI DI RISCHIO NON SONO STATI TOCCATI');

// ⚠ QUESTE TRE ASSERZIONI ERANO FOTOGRAFIE ($1000 / $600 / $25), cioe' la classe di difetto di §5.3:
// diventavano rosse a ogni decisione dell'operatore senza segnalare nessun guasto. Il 15 agosto 2026
// l'operatore ha portato il tetto per ordine a $80 e la perdita giornaliera a $100, e la fotografia e'
// caduta. Adesso si difende la PROPRIETA': ogni limite esiste, e' finito, e' sotto il soffitto del
// codice — che e' l'unica cosa che nessuna configurazione puo' scavalcare — e resta abbastanza largo
// da non tagliare l'allocazione che il piano puo' produrre.
{
  const rl = require('../safety/risk-limits');
  const CONC = require('../rewards/concentration');
  const H = rl.HARD_CEILINGS;
  for (const campo of ['maxOrderNotionalUsd', 'maxOpenNotionalUsd', 'maxDailyLossUsd']) {
    ok(`${campo} e' impostato, finito e positivo (limite assente = rifiuta tutto)`,
      Number.isFinite(limiti.global[campo]) && limiti.global[campo] > 0, `${limiti.global[campo]}`);
    ok(`  e resta sotto il soffitto del codice (${H[campo]})`, limiti.global[campo] <= H[campo]);
  }
  // ⚠ LA RELAZIONE CHE CONTA DAVVERO, e che una fotografia non esprimeva: il tetto di safety non deve
  // essere PIU' STRETTO della gamba piu' cara che il piano puo' proporre, o rifiuterebbe coppie valide
  // — cioe' produrrebbe `coppia-non-atomica`, la prima causa misurata di gambe perse (§5 p.129-130).
  ok('il tetto di safety per ordine copre la gamba piu cara che il tetto per mercato consente',
    limiti.global.maxOrderNotionalUsd >= CONC.MARKET_CAP_FIXED_USD * CONC.PREZZO_MASSIMO_QUOTABILE / CONC.COSTO_COPPIA,
    `$${limiti.global.maxOrderNotionalUsd} contro $${(CONC.MARKET_CAP_FIXED_USD * CONC.PREZZO_MASSIMO_QUOTABILE / CONC.COSTO_COPPIA).toFixed(2)}`);
  // ══ L'INVARIANTE GIUSTA, decisa dall'operatore il 18 agosto 2026 ═══════════════════════════════
  //
  //     capitale impegnato  ≤  MAKER_MERCATI_CONTEMPORANEI × MARKET_CAP_FIXED_USD
  //
  // ⚠ QUESTA ASSERZIONE ERA ROVESCIATA, ed era rossa APPOSTA da due giorni. Diceva
  // «`maxOpenNotionalUsd` ≥ 3 × tetto per mercato», cioè «il tetto di safety deve essere abbastanza
  // LARGO da lasciar aprire tre mercati pieni». Ma `maxOpenNotionalUsd` non è un permesso: è il
  // **limite superiore** al capitale impegnato, e chiedergli di essere più grande del massimo
  // impegnabile è chiedergli di non mordere mai — cioè di non essere un limite.
  //
  // ⚠ E IL «3» ERA CABLATO. Da R1 il numero di mercati vive nell'ambiente di agent41: un test che
  // moltiplica per 3 difende una configurazione, non una proprietà. Adesso N si LEGGE.
  //
  // ⚠ IL $150 NON È IL MASSIMO IMPEGNABILE, ED È PIÙ STRETTO: a N = 3 il massimo sarebbe $183,75, e
  // l'operatore ha scelto $150. Il gate confronta `openNotionalUsd + notional`, quindi la gamba più
  // cara del piano smette di essere piazzabile quando i fill riconciliati superano ~$95: **la
  // rotazione si ferma da sola lì, non a $150**. È scritto perché non venga scoperto su capitale vero.
  {
    const { quantiMercati } = require('./quanti-mercati');
    const N = quantiMercati(process.env).quanti;
    const massimoImpegnabile = N * CONC.MARKET_CAP_FIXED_USD;
    ok('  il tetto di esposizione aperta NON supera il massimo impegnabile (N × tetto per mercato)',
      limiti.global.maxOpenNotionalUsd <= massimoImpegnabile,
      `$${limiti.global.maxOpenNotionalUsd} contro N=${N} × $${CONC.MARKET_CAP_FIXED_USD} = $${massimoImpegnabile.toFixed(2)}`);
    // ⚠ E NON DEVE ESSERE COSÌ STRETTO DA VIETARE LA PRIMA COPPIA: sotto un tetto per mercato non si
    // aprirebbe nemmeno un mercato, e il bot sarebbe fermo per configurazione senza dirlo.
    ok('  ma resta abbastanza largo da aprire almeno un mercato intero',
      limiti.global.maxOpenNotionalUsd >= CONC.MARKET_CAP_FIXED_USD,
      `$${limiti.global.maxOpenNotionalUsd} contro $${CONC.MARKET_CAP_FIXED_USD}`);
  }
}
ok('la allowlist dei venue e invariata', Array.isArray(limiti.global.venues)
  && limiti.global.venues.length === 1 && limiti.global.venues[0] === 'polymarket');

console.log('\n④ IL TETTO PER MERCATO E IL PAVIMENTO PREMIANTE REGGONO AI NUOVI VALORI');

// Piu' mercati per giro NON deve voler dire size piu' piccole: il tetto per mercato e il pavimento
// premiante sono per-mercato e stanno a valle, quindi il numero di mercati non li tocca. Lo si verifica
// invece di assumerlo, perche' e' la promessa che rende sicuro l'aumento.
{
  const CONC = require('../rewards/concentration');
  const capitale = 661.61;
  const tetto = CONC.capPerMarketUsd(capitale);
  const pav20 = CONC.pavimentoPremiante(20);
  ok('il tetto per mercato non dipende da quanti mercati apre un giro',
    CONC.capPerMarketUsd(capitale) === tetto);
  ok('il tetto per mercato resta sopra il pavimento premiante tipico',
    tetto >= pav20, `tetto ${tetto} vs pavimento ${pav20}`);
  // A N mercati per giro il capitale richiesto e' N x tetto: deve stare dentro il capitale, altrimenti
  // il giro proporrebbe piu' di quanto c'e' e il taglio arriverebbe a valle invece che qui.
  //
  // ⚠⚠ QUESTA ASSERZIONE E' ROSSA DAL 13 AGOSTO 2026, E RESTA ROSSA DI PROPOSITO.
  // Col tetto a $61,25 un giro pieno chiede `12 x $61,25 = $735` contro ~$662 di capitale: la
  // coppia (mercati per giro, tetto per mercato) non e' piu' coerente. Il numero coerente sarebbe
  // **10** (`mercatiSostenibili($652) = 10`), cioe' `MAX_NUOVI_PER_GIRO` va da 12 a 10.
  // NON e' stato cambiato: e' un SECONDO parametro, e la sessione ne muove UNO solo per avere 24 ore
  // di dati puliti su una variabile sola. Va deciso dall'operatore.
  // ⚠ Cosa succede finche' resta cosi': il knapsack e' comunque limitato da `budgetUsd`, quindi non
  // si impegna piu' capitale di quanto ce ne sia — le ultime righe del giro finiscono in `saltati`
  // invece che in un piano piu' corto. E' una degradazione dichiarata, non un rischio di capitale.
  ok('un giro pieno non chiede piu del capitale disponibile',
    perGiro * tetto <= capitale + 1e-9,
    `${perGiro} x $${tetto} = $${(perGiro * tetto).toFixed(2)} contro $${capitale}`);
  // E il numero di mercati che il capitale sostiene resta sotto il tetto di CARICO.
  ok('i mercati sostenibili restano sotto il tetto di carico',
    CONC.mercatiSostenibili(capitale) <= CONC.MAX_MERCATI,
    `${CONC.mercatiSostenibili(capitale)} <= ${CONC.MAX_MERCATI}`);
}

console.log('\n⑤ LO SCOPE DEL RINNOVO E L\'UNIONE, NON LA LISTA STRETTA');

{
  const src = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8');
  const righeVive = src.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  ok('il ciclo non itera piu direttamente la allowlist di piano',
    !/for\s*\(const marketId of cfgState\.enabledMarketIds\)/.test(righeVive));
  ok('il ciclo itera lo scope costruito', /for\s*\(const marketId of scopeRinnovo\)/.test(righeVive));
  ok('lo scope include i mercati con posizione aperta',
    /cfgState\.enabledDaPosizione/.test(righeVive));
  ok('lo scope include i mercati con ordini a riposo',
    /deps\.mercatiConOrdiniVivi/.test(righeVive));
  ok('il referto dichiara la memoria da restituire',
    /mercatiConOrdini:\s*\[\.\.\.mercatiConOrdiniQuestoGiro\]/.test(righeVive));
}

// Il comportamento, non solo la forma: si guida il ciclo VERO con le tre componenti.
(async () => {
  const { runAutoRepriceCycle } = require('./auto-reprice');

  const visitati = [];
  const daReferto = (r) => (r.markets || []).map((m) => m.marketId);
  const base = {
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    trackedMarketIds: () => [],
    isManual: () => true,
    // Ogni mercato entra comunque nel referto, qualunque gate lo fermi: e' quello il testimone di
    // «e' stato guardato», e non dipende dall'ordine dei gate — che puo' cambiare senza che lo scope
    // cambi. Sondare una dep specifica legherebbe il test alla sequenza interna invece che alla
    // proprieta'.
    resolveRules: () => ({ readable: false, missing: ['tick'] }),
    listOrders: async () => ({ ok: true, orders: [] }),
    marketWindow: () => null,
    cadenza: () => null,
  };
  // La configurazione si inietta come il ciclo la legge davvero: un file di store in una directory
  // temporanea, MAI quello di produzione. E' la trappola gia' registrata due volte in questo repo
  // (§5 punti 53 e 57): una suite che guida un ciclo vero senza reindirizzare le scritture le manda
  // sullo stato reale. Qui si scrive solo in `os.tmpdir()`, e la config di produzione non viene
  // nemmeno aperta.
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-rinnovo-'));
  const configFile = path.join(tmp, 'auto-reprice.json');
  const scriviConfig = (mercatiAbilitati, globalEnabled = true) => {
    const markets = {};
    for (const id of mercatiAbilitati) markets[id] = { enabled: true };
    fs.writeFileSync(configFile, JSON.stringify({ global: { enabled: globalEnabled }, markets }));
  };
  const cfgDeps = (posizioni) => ({
    configDeps: {
      configFile,
      autoStateFile: path.join(tmp, 'stato.json'),
      autoAuditFile: path.join(tmp, 'audit.jsonl'),
      posizioni,
    },
  });
  const conPosizione = { readable: true, positions: [{ conditionId: '0xbbb', size: 5 }] };
  const senzaPosizioni = { readable: true, positions: [] };
  scriviConfig(['0xaaa']);
  const cfg = cfgDeps(conPosizione);

  // ⑤a — piano ∪ posizione ∪ ordini vivi
  let r = await runAutoRepriceCycle({ ...base, ...cfg, mercatiConOrdiniVivi: () => ['0xccc'] });
  let v = daReferto(r);
  ok('lo scope unisce le tre componenti',
    v.includes('0xaaa') && v.includes('0xbbb') && v.includes('0xccc'),
    `visitati: ${v.join(',')}`);
  ok('il referto conta gli aggiunti separatamente dal piano',
    r.scope && r.scope.daPiano === 1 && r.scope.aggiunti === 2,
    JSON.stringify(r.scope));
  ok('il referto dice PERCHE ogni mercato e nello scope',
    r.scope.perche['0xaaa'] === 'piano'
    && r.scope.perche['0xbbb'] === 'posizione-aperta'
    && r.scope.perche['0xccc'] === 'ordini-a-riposo',
    JSON.stringify(r.scope.perche));

  // ⑤b — SENZA le componenti nuove il comportamento e' identico a prima: il minimo garantito e' il piano
  r = await runAutoRepriceCycle({ ...base, ...cfgDeps(senzaPosizioni) });
  v = daReferto(r);
  ok('senza posizioni e senza memoria, lo scope e esattamente la allowlist di piano',
    v.length === 1 && v[0] === '0xaaa' && r.scope.aggiunti === 0, `visitati: ${v.join(',')}`);

  // ⑤c — FAIL-SAFE: una memoria che esplode non ferma il ciclo e non allarga niente
  r = await runAutoRepriceCycle({
    ...base, ...cfgDeps(senzaPosizioni),
    mercatiConOrdiniVivi: () => { throw new Error('boom'); },
  });
  v = daReferto(r);
  ok('una memoria che solleva vale lista vuota, non un ciclo fermato',
    r.ran === true && v.length === 1 && v[0] === '0xaaa', `visitati: ${v.join(',')}`);

  // ⑤d — un id ripetuto in due componenti non raddoppia la visita
  r = await runAutoRepriceCycle({ ...base, ...cfg, mercatiConOrdiniVivi: () => ['0xaaa', '0xbbb'] });
  v = daReferto(r);
  ok('un mercato presente in piu componenti viene visitato UNA volta',
    v.filter((x) => x === '0xaaa').length === 1 && v.filter((x) => x === '0xbbb').length === 1,
    `visitati: ${v.join(',')}`);
  ok('la ragione piu forte vince: il piano batte gli ordini a riposo',
    r.scope.perche['0xaaa'] === 'piano');

  // ⑤e — il kill resta davanti a tutto: uno scope piu largo non apre nessuna strada nuova
  r = await runAutoRepriceCycle({
    ...base, ...cfg,
    killStatus: () => ({ effectivelyKilled: true, readable: true }),
    mercatiConOrdiniVivi: () => ['0xccc'],
  });
  ok('sotto KILL lo scope allargato non visita niente',
    r.gate === 'kill' && daReferto(r).length === 0);

  // ⑤f — interruttore generale spento ⇒ niente, posizioni o ordini o no
  scriviConfig(['0xaaa'], false);
  r = await runAutoRepriceCycle({ ...base, ...cfg, mercatiConOrdiniVivi: () => ['0xccc'] });
  scriviConfig(['0xaaa'], true);
  ok('con l interruttore generale spento lo scope allargato resta vuoto',
    r.gate === 'disabled-global' && daReferto(r).length === 0);

  console.log(`\n${n}/${n} verdi\n`);
})().catch((e) => { console.error('\nROSSO:', e.message); process.exit(1); });

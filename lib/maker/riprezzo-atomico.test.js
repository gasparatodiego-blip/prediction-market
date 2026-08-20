#!/usr/bin/env node
'use strict';
// IL RIPREZZO NON CANCELLA PIÙ UN ORDINE CHE NON PUÒ RIPIAZZARE.
//
// ═══ IL GUASTO, MISURATO SU 20 GIORNI DI STORICO ═════════════════════════════════════════════════════
// `replaceManualOrder` è cancella→ripiazza. Aveva TRE precontrolli prima della cancellazione (kill,
// orologio del mercato, guard condiviso sul prezzo) e NON aveva gli altri due limiti che possono
// rifiutare il piazzamento: il TETTO PER ORDINE e la CHIAVE DI IDEMPOTENZA. Otto volte in venti giorni il
// vecchio ordine è stato cancellato e il nuovo rifiutato, e in tutti e otto il rifiuto veniva da uno di
// quei due — 6 `idempotent-duplicate`, 1 `mai-primo-sul-libro`, 1 `manual-order-cap`.
//
// IL CASO REALE (2026-08-10 04:08:55, mercato 33c3b9a093):
//   1 · l'inseguimento del mid sposta la gamba NO da 0,671 a 0,677
//   2 · il vecchio ordine viene CANCELLATO, il nuovo RIFIUTATO: $70,38 contro un tetto di $70,00
//   3 · 21 secondi dopo la gamba YES viene riempita: $33,42 di esposizione direzionale scoperta
//   4 · auto-close prova a coprirla e viene rifiutato dallo STESSO tetto, 54 volte
//   5 · la posizione resta scoperta 112 minuti, fino al KILL
//
// ═══ COSA NON DEVE ROMPERSI ══════════════════════════════════════════════════════════════════════════
// Tre percorsi cancellano SENZA rimpiazzo di proposito, e devono continuare a farlo: «mai primo sul
// libro» quando un tick dietro uscirebbe dalla banda, il mid stantio oltre 20s, la fine vita del
// mercato. Nessuno dei tre passa da `replaceManualOrder`: chiamano `deps.cancelOrder`, cioè
// `cancelManualOrder`, che non è e non diventa gated. La sezione 3 lo verifica sul sorgente vero.
//
// NESSUN ORDINE REALE, NESSUNA RETE: i due precontrolli sono funzioni pure con dipendenze iniettate, e
// il registro di idempotenza è un finto in memoria — il giornale vero non viene né letto né scritto.

const fs = require('fs');
const path = require('path');
const MO = require('./manual-order');
const AR = require('./auto-reprice');
const C = require('../rewards/concentration');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const sez = (t) => console.log('\n── ' + t);

// L'impronta del registro VERO, presa prima di qualunque cosa: la sezione 5 verifica che questo test
// non l'abbia toccato. È la stessa classe di trappola di §5 punti 53 e 55 (una suite che scrive sullo
// stato di produzione), e qui la si chiude misurando invece che promettendo.
const AUDIT_VERO = path.join(process.cwd(), 'data', 'execution-audit.jsonl');
let RIGHE_INIZIALI = null;
try { RIGHE_INIZIALI = fs.readFileSync(AUDIT_VERO, 'utf8').split('\n').length; } catch { RIGHE_INIZIALI = null; }

// ════════════════════════════════════════════════════════════════════════════════════════════════════
sez('1 · IL TETTO PER ORDINE, PRECONTROLLATO CON LA STESSA FUNZIONE DEL PIAZZAMENTO');

// Il tetto arriva da `resolveCaps`, che lo prende da `LIVE_MIN_ORDER_CAP_USD` — nessuna costante nuova.
const capsFinti = (liveMin, safety = 1000) => ({
  readable: true, error: null, maxOrderNotionalUsd: safety, liveMinCapUsd: liveMin,
  effectiveOrderCapUsd: Math.min(safety, liveMin),
});

{
  // IL CASO REALE, con i numeri esatti del giornale del 10 agosto.
  const g = MO.evaluateManualCapGate({ notionalUsd: 70.38, caps: capsFinti(70) });
  ok('il caso documentato ($70,38 contro $70,00) viene RIFIUTATO', g.allow === false && g.gate === 'manual-order-cap',
    g.reason ? g.reason.slice(0, 70) : '');
  ok('  e il motivo nomina entrambi i limiti, non solo il totale',
    /safety-risk-limits/.test(g.reason) && /live-min/.test(g.reason));
}
{
  const g = MO.evaluateManualCapGate({ notionalUsd: 70.38, caps: capsFinti(C.LIVE_MIN_ORDER_CAP_USD) });
  ok(`col tetto DI OGGI ($${C.LIVE_MIN_ORDER_CAP_USD}) lo stesso ordine è rifiutato a maggior ragione`,
    g.allow === false && g.gate === 'manual-order-cap');
}
{
  // Un riprezzo vero che passava e deve continuare a passare. La gamba di riferimento era Houston del
  // 9 agosto — 66,3 share @ 0,43 = $28,51 — ma quelle 66,3 share erano la size di un tetto da $65: col
  // tetto DERIVATO la stessa gamba vale la meta'. Si deriva dalla size che il tetto di oggi produce,
  // invece di ripetere un nozionale che apparteneva a un'altra configurazione.
  const shareLato = C.MARKET_CAP_FIXED_USD / C.COSTO_COPPIA;
  const nozGamba = shareLato * 0.43;
  const g = MO.evaluateManualCapGate({ notionalUsd: nozGamba, caps: capsFinti(C.LIVE_MIN_ORDER_CAP_USD) });
  ok(`un riprezzo legittimo ($${nozGamba.toFixed(2)}, sotto il tetto per ordine) passa`, g.allow === true,
    `$${nozGamba.toFixed(2)} contro tetto $${C.LIVE_MIN_ORDER_CAP_USD}`);
}
{
  const g = MO.evaluateManualCapGate({ notionalUsd: NaN, caps: capsFinti(C.LIVE_MIN_ORDER_CAP_USD) });
  ok('controvalore non calcolabile ⇒ RIFIUTA (fail closed)', g.allow === false && g.gate === 'unverified-size');
  const g2 = MO.evaluateManualCapGate({ notionalUsd: 10, caps: { readable: false, error: 'boom' } });
  ok('limiti illeggibili ⇒ RIFIUTA (limite assente ≠ illimitato)', g2.allow === false && g2.gate === 'caps-unreadable');
}
{
  const src = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  ok('il tetto NON è ridichiarato: il precontrollo chiama resolveCaps + evaluateManualCapGate',
    /const capsRimpiazzo = resolveCaps\(/.test(src) && /evaluateManualCapGate\(\{ notionalUsd: notionalRimpiazzo/.test(src));
  // ⚠ QUESTA ASSERZIONE FOTOGRAFAVA LA STRINGA DEL `require`, ED ERA UNA TRAPPOLA (CLAUDE.md §5.3).
  // Cercava `LIVE_MIN_ORDER_CAP_USD } = require('../rewards/concentration')` con una regex ancorata
  // alla graffa: il 16 agosto la riga e' diventata
  // `{ LIVE_MIN_ORDER_CAP_USD, MARKET_CAP_FIXED_USD } = require(...)` — stesso import, stessa fonte,
  // nessun difetto — e il test e' diventato rosso. Un test cosi' si rompe a ogni refactor e non
  // difende niente: e' la classe «test che fotografa il codice invece della proprieta'».
  //
  // ADESSO SI PROVA IL COMPORTAMENTO. La proprieta' vera e': «il tetto per ordine che `manual-order`
  // usa VIENE da `lib/rewards/concentration`, non e' un numero suo». La si prova sostituendo il
  // modulo sorgente in `require.cache` con uno che espone un valore riconoscibile, ricaricando
  // `manual-order` da zero e chiedendogli il tetto: se il numero e' quello finto, l'import e' reale.
  // Nessuna stringa, nessuna forma di destrutturazione, nessun conteggio.
  const SENTINELLA = 1234.5678;
  const viaConc = require.resolve('../rewards/concentration');
  const viaMO = require.resolve('./manual-order');
  const concVero = require.cache[viaConc];
  const moVero = require.cache[viaMO];
  let capLetto = null;
  try {
    const vero = require('../rewards/concentration');
    delete require.cache[viaMO];
    require.cache[viaConc] = { id: viaConc, filename: viaConc, loaded: true, exports:
      { ...vero, LIVE_MIN_ORDER_CAP_USD: SENTINELLA } };
    const MOfresco = require('./manual-order');
    // `engine: {}` di proposito: senza, `readEngineState()` leggerebbe /tmp/maker-state.json e
    // potrebbe fornire un `liveMinCapUsd` suo, cioe' misurare la fonte sbagliata.
    capLetto = MOfresco.resolveCaps({ userId: 'test-riprezzo-atomico', engine: {} }).liveMinCapUsd;
  } finally {
    // Si rimette tutto com'era: un test che lascia `require.cache` sporco avvelena quelli dopo di lui.
    if (concVero) require.cache[viaConc] = concVero; else delete require.cache[viaConc];
    if (moVero) require.cache[viaMO] = moVero; else delete require.cache[viaMO];
  }
  ok('  e il tetto per ordine ARRIVA da lib/rewards/concentration (provato, non letto nel sorgente)',
    capLetto === SENTINELLA, `letto ${capLetto}, atteso la sentinella ${SENTINELLA}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
sez('2 · LA CHIAVE DI IDEMPOTENZA, PRECONTROLLATA PRIMA DELLA CANCELLAZIONE');

// Registro finto: nessuna lettura del giornale vero.
const registro = ({ intents = [], esiti = {}, esplode = false }) => ({
  hasIntent: (k) => { if (esplode) throw new Error('registro illeggibile'); return intents.includes(k); },
  risolviDuplicato: (k, { vivi }) => {
    if (!(vivi instanceof Set)) return { superabile: false, chiave: null, motivo: 'vivi non accertati' };
    const oid = esiti[k];
    if (!oid) return { superabile: false, chiave: null, motivo: 'esito senza orderId' };
    if (vivi.has(oid)) return { superabile: false, chiave: null, motivo: `l ordine ${oid} e ancora VIVO sul venue` };
    return { superabile: true, chiave: 'idem_dopo_x', motivo: 'l ordine precedente non e piu sul venue' };
  },
});
const CHIAVE = 'idem_rep_c3f67e534dc58ba2edc1';   // la chiave vera del guasto dell'8 agosto 23:49

{
  const r = MO.valutaChiaveRimpiazzo(CHIAVE, {}, { executionAudit: registro({ intents: [] }) });
  ok('nessun intent per questa chiave ⇒ si può cancellare', r.allow === true, r.motivo);
}
{
  const r = MO.valutaChiaveRimpiazzo(CHIAVE, {}, { executionAudit: registro({ intents: [CHIAVE] }) });
  ok('chiave GIÀ BRUCIATA e ordini vivi non accertati ⇒ NON si cancella',
    r.allow === false && r.gate === 'idempotent-duplicate');
  ok('  e il motivo dice esplicitamente che il vecchio ordine non è stato toccato',
    /NON è stato cancellato/.test(r.reason));
}
{
  // Il caso vero dell'8 agosto: la chiave collide con un ordine che è ancora VIVO sul venue.
  const reg = registro({ intents: [CHIAVE], esiti: { [CHIAVE]: '0x765c781858f7' } });
  const r = MO.valutaChiaveRimpiazzo(CHIAVE, { vivi: new Set(['0x765c781858f7']) }, { executionAudit: reg });
  ok('chiave bruciata da un ordine ANCORA VIVO ⇒ NON si cancella (sarebbe un doppio invio)',
    r.allow === false && r.gate === 'idempotent-duplicate', r.motivo);
}
{
  // E il caso in cui il duplicato È superabile: l'ordine con cui collide è morto. Qui il riprezzo procede.
  const reg = registro({ intents: [CHIAVE], esiti: { [CHIAVE]: '0xmorto' } });
  const r = MO.valutaChiaveRimpiazzo(CHIAVE, { vivi: new Set(['0xaltro']) }, { executionAudit: reg });
  ok('chiave bruciata da un ordine MORTO e provato tale ⇒ si può cancellare', r.allow === true, r.motivo);
}
{
  const r = MO.valutaChiaveRimpiazzo(CHIAVE, {}, { executionAudit: registro({ esplode: true }) });
  ok('registro di idempotenza illeggibile ⇒ NON si cancella (fail closed)',
    r.allow === false && r.gate === 'idempotent-duplicate');
}
{
  const reg = { hasIntent: () => true, risolviDuplicato: () => { throw new Error('boom'); } };
  const r = MO.valutaChiaveRimpiazzo(CHIAVE, { vivi: new Set() }, { executionAudit: reg });
  ok('risolviDuplicato che solleva ⇒ NON si cancella (fail closed)', r.allow === false);
}
{
  // LA DERIVAZIONE È UNA SOLA: quella precontrollata e quella spedita devono coincidere per costruzione.
  const src = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  const derivazioni = (src.match(/idem_rep_\$\{crypto/g) || []).length;
  ok('la chiave `idem_rep_` è derivata in UN SOLO punto del sorgente', derivazioni === 1, `${derivazioni} occorrenze`);
  ok('  e il precontrollo usa quella funzione, non una copia',
    /const chiaveRimpiazzo = chiaveDiRimpiazzo\(\{/.test(src));
  // ⚠ SI DIFENDE LA PROPRIETA', NON LA FORMA DELLA CHIAMATA — riscritta il 20 agosto 2026.
  // Prima qui c'era il letterale `/idempotencyKey: chiaveRimpiazzo \}, deps\)/`, che ancorava anche la
  // GRAFFA DI CHIUSURA: aggiungere un qualunque altro campo alla stessa chiamata lo faceva fallire, ed
  // e' successo cablando `sostituisceOrderId` (§23) — una modifica che non tocca in nessun modo la
  // chiave. E' il difetto di §5.3 «test che fotografa il codice invece della proprieta'»: rosso su una
  // modifica corretta, e quindi rumore che nasconde le regressioni vere. La proprieta' vera e' che allo
  // STEP 2 si spedisca LA VARIABILE gia' precontrollata — non una chiave ricalcolata — nella chiamata
  // che porta `deps`. Che di derivazioni ce ne sia una sola lo asserisce gia' `derivazioni === 1`.
  ok('  e allo STEP 2 si spedisce la stessa variabile già precontrollata',
    /placeManualOrder\(\{[^}]*idempotencyKey: chiaveRimpiazzo[^}]*\}, deps\)/s.test(src));
  // stabilità della derivazione: stessi ingressi ⇒ stessa chiave, ingressi diversi ⇒ chiave diversa
  const a = MO.chiaveDiRimpiazzo({ userId: 'operator', orderId: '0xA', side: 'BUY', price: 0.671, size: 103.8 });
  const b = MO.chiaveDiRimpiazzo({ userId: 'operator', orderId: '0xA', side: 'BUY', price: 0.671, size: 103.8 });
  const c = MO.chiaveDiRimpiazzo({ userId: 'operator', orderId: '0xA', side: 'BUY', price: 0.677, size: 103.8 });
  ok('  deterministica sugli stessi ingressi e distinta su ingressi diversi', a === b && a !== c);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
sez('3 · L\'ORDINE DELLE OPERAZIONI: I DUE GATE STANNO PRIMA DELLA CANCELLAZIONE');

{
  const src = fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8');
  const iCap = src.indexOf('reject-cap-preflight');
  const iIdem = src.indexOf('reject-idempotency-preflight');
  const iCancel = src.indexOf('// STEP 1 — cancel.');
  ok('il precontrollo del tetto precede lo STEP 1 (cancel)', iCap > 0 && iCancel > 0 && iCap < iCancel);
  ok('il precontrollo della chiave precede lo STEP 1 (cancel)', iIdem > 0 && iIdem < iCancel);
  // ogni ritorno dei due gate deve dichiarare che NON si è cancellato
  const bloccoCap = src.slice(iCap, iCap + 900);
  const bloccoIdem = src.slice(iIdem, iIdem + 700);
  ok('il gate del tetto risponde oldCancelled:false', /oldCancelled: false/.test(bloccoCap));
  ok('il gate della chiave risponde oldCancelled:false', /oldCancelled: false/.test(bloccoIdem));
  ok('entrambi lasciano una riga di audit misurabile',
    /outcome: 'reject-cap-preflight'/.test(src) && /outcome: 'reject-idempotency-preflight'/.test(src));
  // i cinque precontrolli, nell'ordine
  const ordine = ['killNow.killed', 'closeNow.tooClose', '!preflight.valid', '!cgRimpiazzo.allow', '!chiaveOk.allow']
    .map((s) => src.indexOf(s));
  ok('i CINQUE precontrolli sono in sequenza e tutti prima del cancel',
    ordine.every((p, i) => p > 0 && (i === 0 || p > ordine[i - 1])) && ordine[4] < iCancel,
    ordine.join(' < '));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
sez('4 · I TRE PERCORSI DI CANCELLAZIONE DELIBERATA RESTANO INTATTI');

{
  const ar = fs.readFileSync(path.join(__dirname, 'auto-reprice.js'), 'utf8');
  // I tre percorsi cancellano con deps.cancelOrder, che NON passa da replaceManualOrder.
  //
  // ⚠ IL MARCATORE DEL MID STANTIO È L'AZIONE, NON L'ESITO — e la ragione è che l'esito è già cambiato
  // una volta. Fino all'11 agosto 2026 era `outcome: 'mid-stantio-timeout'`; il 12 agosto la
  // distinzione delle tre cecità (§5 blocco C) l'ha reso `cecita-timeout-${causa}`, calcolato a
  // runtime. Questa asserzione cercava la stringa vecchia ed è diventata rossa senza che nulla si
  // fosse rotto — cioè ha segnalato un rinominamento, non un difetto. `action: 'mid-stantio-cancel'`
  // è invece il nome della COSA CHE FA, che è ciò che questa sezione difende: qui si verifica che il
  // percorso cancelli, non come si chiami la sua riga di log.
  for (const [nome, marcatore] of [
    ['mai primo sul libro (cancellazione deliberata)', "out('cancel', 'sarebbe-primo-sul-libro'"],
    ['mid stantio oltre soglia', "action: 'mid-stantio-cancel'"],
    ['fine vita del mercato', "outcome: 'end-of-life-cancel'"],
  ]) {
    const i = ar.indexOf(marcatore);
    ok(`${nome}: presente nel sorgente`, i > 0);
  }
  ok('nessuno dei tre usa replaceOrder: cancellano con deps.cancelOrder',
    /d\.action === 'cancel'/.test(ar) && /deps\.cancelOrder\(\{ orderId/.test(ar));
  ok('cancelManualOrder NON è stata toccata dai due nuovi gate',
    !/reject-cap-preflight|reject-idempotency-preflight/.test(
      fs.readFileSync(path.join(__dirname, 'manual-order.js'), 'utf8')
        .split('async function cancelManualOrder')[1].split('async function replaceManualOrder')[0]));
}
{
  // FUNZIONALE, non solo strutturale: il caso «un tick dietro uscirebbe dalla banda» deve continuare a
  // rispondere `cancel`. Numeri veri del 2026-08-05 su 4808488e54: banda [77¢–80¢], miglior bid altrui 77¢.
  const MKT = '0x4808488e54a414ee180be47feebba96166cad42fff4cc5c363733c42b6357d4e';
  const rules = {
    readable: true, missing: [], marketId: MKT, mid: 0.785, tick: 0.01, minSize: 50, maxSpreadCents: 2.25,
    tokenId: 'ty', tokenIdNo: 'tn', midSource: 'live-book', midAgeSec: 2,
    feedVitality: { assetsWithEvents: 40, seededAssets: 100, windowMs: 30_000 },
    books: { yes: { tokenId: 'ty', scoringMid: 0.785 }, no: { tokenId: 'tn', scoringMid: 0.215 } },
  };
  const CFG = {
    restingGtdSeconds: 1380, refreshMarginSeconds: 180, minIntervalMs: 30_000, maxPerHour: 20,
    maxMidAgeSecLive: 60, maxMidAgeSecBlind: 10, feedAliveMinAssets: 5, requireLiveBook: true,
    confirmSamples: 2, hysteresisTicks: 1, pollMs: 5000, strategy: 'band-edge', disconnectCancelSeconds: 180,
  };
  const order = { orderId: '0xc5f8b540', book: 'yes', side: 'BUY', price: 0.77, size: 48.4 };
  const d = AR.decideReprice(
    { order, rules, config: CFG, lastRepriceAt: null, consecutiveBreaches: 0, repricesThisHour: 0,
      now: 1_700_000_000_000, ownOrders: [{ orderId: order.orderId, price: order.price, size: order.size, book: 'yes' }] },
    { resolveOffset: () => ({ targetOffsetCents: null, source: 'none', minMoveCents: 1 }),
      resolveDepth: () => ({ yes: { bids: [{ price: 0.77, size: 500 }], asks: [] }, no: { bids: [], asks: [] } }) },
  );
  ok('«mai primo sul libro» risponde ancora cancel senza rimpiazzo',
    d.action === 'cancel' && d.gate === 'sarebbe-primo-sul-libro', `${d.action}/${d.gate}`);
  ok('  e non propone nessun prezzo di rimpiazzo', d.targetPrice == null);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
sez('5 · IL GIORNALE VERO NON È STATO TOCCATO DA QUESTO TEST');
{
  const AUDIT = path.join(process.cwd(), 'data', 'execution-audit.jsonl');
  let righe = null;
  try { righe = fs.readFileSync(AUDIT, 'utf8').split('\n').length; } catch { righe = null; }
  ok('il registro di idempotenza è stato solo eventualmente letto, mai scritto da qui',
    righe === null || righe === RIGHE_INIZIALI, `${righe} righe`);
}

console.log(`\n${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

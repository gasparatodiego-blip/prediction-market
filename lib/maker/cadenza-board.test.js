'use strict';
// lib/maker/cadenza-board.test.js — IL PERIODO DEL BOARD E LA FRESCHEZZA CHE AGENT41 PRETENDE.
//
// ═══ OBIETTIVO 1 · IL DIFETTO ═══════════════════════════════════════════════════════════════════════
// agent24 faceva `await scan(); await sleep(15 min)`, cioe' un periodo REALE di
// `durata della scansione + 15 minuti`. Finche' la scansione costava 14 secondi non si vedeva; dopo
// l'allargamento della scoperta dell'8 agosto (§5 punto 23: 21 pagine → 141) costa ~7,5 minuti, quindi
// il board si riscriveva ogni **22,5 minuti** mentre due costanti, un commento e un test dicevano 15.
//
// agent41 rifiuta di quotare su un board piu' vecchio del suo limite, e quel limite era 20. Le eta' che
// hanno bloccato un mini-ciclo, dal giornale del 9 agosto: **21,0 · 22,0 · 22,2 minuti** — tutte fra 20
// e 22,5. Non erano ritardi: era la cadenza. 3 mini-cicli su 22 persi in una giornata.
//
// Due correzioni, e fanno lavori diversi:
//   · la CAUSA, in agent24: si dorme il RESTO del periodo, con un pavimento perche' una scansione piu'
//     lunga del periodo non faccia girare schiena a schiena;
//   · il MARGINE, in agent41: 20 → 25 minuti, perche' la cadenza della scoperta e' gia' cresciuta due
//     volte e un limite a cinque minuti dal periodo si rompera' di nuovo, in silenzio.
//
// ═══ OBIETTIVO 2 · LE DUE STRADE PER USCIRE DAL BOARD ═══════════════════════════════════════════════
// Un mercato in gestione perde le regole di venue per DUE motivi distinti che portano allo stesso
// guasto: la ROTAZIONE (agent24 tiene i primi 120 per montepremi) e la SCADENZA (il mercato si avvicina
// alla risoluzione ed esce dalla finestra di scoperta). Il secondo e' il piu' importante: un mercato
// `in-scadenza` e' esattamente uno su cui una posizione va gestita fino alla fine. Il 9 agosto alle
// 03:41 il reset ne ha lasciati DIECI in una volta, tutti in scadenza.
//
// Il ripiego e' indifferente al motivo — e' keyed sul mercato — ma la copia va scritta da ENTRAMBI i
// percorsi che aprono mercati. Il mini-ciclo la scriveva; la fase 3 del reset delle sei ore, che apre
// tutto il piano in una volta, no.

const CONC_ = require('../rewards/concentration');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TRIG = require('./trigger-capitale-fermo');
const CAT = require('./market-catalog');
const MO = require('./manual-order');
const A41 = require('../../agents/agent41-realloc-scheduler');
const { runAllocationReset } = require('./allocation-reset');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

const SRC24 = fs.readFileSync(path.join(__dirname, '..', '..', 'agents/agent24-liquidity-rewards.js'), 'utf8');
const MIN = 60_000;

console.log('── 1 · IL PERIODO DI agent24 NON DIPENDE PIÙ DA QUANTO DURA LA SCANSIONE');
{
  // La costante si legge dal SORGENTE, non si copia: una copia diverge e il test smetterebbe di
  // verificare il sistema vero.
  const m = SRC24.match(/const SCAN_INTERVAL_MS\s*=\s*(\d+)\s*\*\s*60_000/);
  ok('SCAN_INTERVAL_MS si legge dal sorgente di agent24', !!m, m && `${m[1]} min`);
  const periodo = Number(m[1]) * MIN;
  ok('  ed è 15 minuti', periodo === 15 * MIN);

  // Il difetto era la forma `scan(); sleep(PERIODO)`. Adesso si dorme il RESTO.
  ok('non si dorme più il periodo INTERO dopo la scansione',
    !/await scan\(\);?\s*\}?\s*catch[\s\S]{0,200}?await sleep\(SCAN_INTERVAL_MS\);/.test(SRC24));
  ok('si dorme il RESTO del periodo', /SCAN_INTERVAL_MS\s*-\s*durata/.test(SRC24));
  ok('  con un pavimento, perché una scansione lunga non giri schiena a schiena',
    /Math\.max\(PAUSA_MINIMA_MS,\s*resto\)/.test(SRC24));
  const p = SRC24.match(/const PAUSA_MINIMA_MS\s*=\s*([0-9_]+)/);
  ok('  e il pavimento è dichiarato', !!p, p && `${Number(String(p[1]).replace(/_/g, '')) / 1000}s`);
  ok('lo sforamento si DICHIARA invece di degradare in silenzio',
    /piu' del periodo|più del periodo/.test(SRC24) && /console\.log/.test(SRC24));

  // L'aritmetica del difetto, riprodotta: prima il periodo era scansione+15, adesso è max(15, scansione+pausa).
  const vecchio = (scanMin) => scanMin + 15;
  const nuovo = (scanMin) => Math.max(15, scanMin + 1);
  ok('scansione da 7,5 min: periodo 22,5 → 15', vecchio(7.5) === 22.5 && nuovo(7.5) === 15);
  ok('  ed è la cadenza che spiega le età osservate (21,0 · 22,0 · 22,2)',
    [21.0, 22.0, 22.2].every((e) => e > 20 && e < vecchio(7.5)));
  ok('scansione da 20 min (oltre il periodo): non gira a vuoto, dorme il pavimento', nuovo(20) === 21);
}

console.log('\n── 2 · IL MARGINE DI FRESCHEZZA È REALISTICO E RESTA UN LIMITE');
{
  const periodo = Number(SRC24.match(/const SCAN_INTERVAL_MS\s*=\s*(\d+)/)[1]) * MIN;
  ok('il limite di agent41 è 25 minuti', TRIG.ETA_BOARD_MAX_MS === 25 * MIN, `${TRIG.ETA_BOARD_MAX_MS / MIN} min`);
  ok('  ed è SOPRA il periodo di agent24', TRIG.ETA_BOARD_MAX_MS > periodo, `${TRIG.ETA_BOARD_MAX_MS / MIN} > ${periodo / MIN}`);
  ok('  con almeno 10 minuti di margine', TRIG.ETA_BOARD_MAX_MS - periodo >= 10 * MIN);

  // E NON di più: il limite deve restare capace di vedere agent24 morto. Tollerare due periodi interi
  // vorrebbe dire non accorgersi di una scansione saltata, che è l'evento per cui il controllo esiste.
  ok('  ma NON tollera due periodi interi (agent24 morto resta visibile)', TRIG.ETA_BOARD_MAX_MS < 2 * periodo,
    `${TRIG.ETA_BOARD_MAX_MS / MIN} < ${2 * periodo / MIN}`);

  // Le tre età che oggi bloccavano un mini-ciclo adesso passano; una davvero stantia no.
  for (const eta of [21.0, 22.0, 22.2]) {
    ok(`  un board di ${eta} min ora è accettato`, eta * MIN <= TRIG.ETA_BOARD_MAX_MS);
  }
  for (const eta of [26, 40, 120]) {
    ok(`  un board di ${eta} min resta RIFIUTATO`, eta * MIN > TRIG.ETA_BOARD_MAX_MS);
  }
  ok('si cambia da .env', Number(process.env.TRIGGER_CAPITALE_BOARD_MAX_MS || 25 * MIN) === TRIG.ETA_BOARD_MAX_MS);

  // L'invariante che conta davvero: la cadenza OPERATIVA del trigger resta sotto il periodo del board,
  // altrimenti si agirebbe due volte sulla stessa fotografia. Era gia' verificato: non deve rompersi.
  ok('la cadenza operativa del trigger resta sotto il periodo del board',
    TRIG.CADENZA_OPERATIVA_MS < periodo, `${TRIG.CADENZA_OPERATIVA_MS / MIN} < ${periodo / MIN}`);
}

console.log('\n── 3 · NESSUNA PROTEZIONE VERA È STATA TOCCATA');
{
  // Il margine più largo non deve aver spostato nient'altro nel modulo del trigger.
  ok('soglia del capitale fermo invariata ($50)', TRIG.SOGLIA_USD === 50);
  // ⚠ NON PIU' $34 dal 12 agosto 2026. Col tetto per mercato derivato ($32,67 a $663) un minimo di $34
  // non poteva MAI essere soddisfatto — lo spazio di un mercato non supera il suo tetto — e il
  // mini-ciclo si fermava a ogni giro. Ora deriva dal pavimento premiante, e la proprieta' da
  // difendere e' proprio che non possa piu' superare il tetto.
  ok('il minimo per un ordine sensato non puo\' superare il tetto per mercato',
    TRIG.MIN_ALLOCAZIONE_USD <= CONC_.capPerMarketUsd(CONC_.CAPITALE_RIFERIMENTO_USD),
    `min $${TRIG.MIN_ALLOCAZIONE_USD} contro tetto $${CONC_.capPerMarketUsd(CONC_.CAPITALE_RIFERIMENTO_USD)}`);
  ok('  ed e\' il pavimento premiante, non un numero scelto',
    TRIG.MIN_ALLOCAZIONE_USD === CONC_.pavimentoPremiante(CONC_.MIN_PREMIANTE_TIPICO));
  // Il tetto dei mercati per giro NON e' piu' asserito come valore: e' stato alzato a 12 il 12 agosto
  // 2026 per l'obiettivo di utilizzo, e questa sezione difende «le protezioni non sono state toccate»,
  // non «la taratura non e' cambiata». Quello che resta vero e' che il numero e' finito, e' condiviso
  // con `utilizzo-capitale` invece di essere ridichiarato, e non e' mai illimitato.
  ok('tetto di mercati per giro: finito, mai illimitato, e condiviso in un posto solo',
    Number.isFinite(TRIG.MAX_MERCATI_PER_GIRO) && TRIG.MAX_MERCATI_PER_GIRO >= 1
    && TRIG.MAX_MERCATI_PER_GIRO === require('./utilizzo-capitale').MAX_NUOVI_PER_GIRO);
  ok('cadenza di rilevazione invariata (120s)', TRIG.CADENZA_MS === 120_000);
  ok('cadenza operativa invariata (10 min)', TRIG.CADENZA_OPERATIVA_MS === 10 * MIN);
  // Il gate resta un gate: un board di età IGNOTA non passa, e non è diventato «accettato per difetto».
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'agents/agent41-realloc-scheduler.js'), 'utf8');
  ok('età del board ignota ⇒ il mini-ciclo NON piazza', /etaBoardMs == null \|\| etaBoardMs > TRIG\.ETA_BOARD_MAX_MS/.test(src));
}

console.log('\n── 4 · IL RIPIEGO COPRE ANCHE L\'USCITA PER SCADENZA, NON SOLO LA ROTAZIONE');
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scadenza-'));
  const deps = { catalogFile: path.join(TMP, 'cat.json'), catalogAuditFile: path.join(TMP, 'cat-audit.jsonl') };
  const ID = '0xcf92c77731a57d1fae661041114345536498c149514871c40920bc9566447bc2';
  const RIGA = {
    marketId: ID, title: 'Will the lowest temperature in London be 19°C on August 10?',
    marketSlug: 'london-19c', category: 'Weather', negRisk: true, midpoint: 0.49,
    maxSpread: 4.5, minSize: 20, dailyPool: 55, tickSize: 0.01,
    tokenId: '111', tokenIdNo: '222', bestBid: 0.47, bestAsk: 0.51,
    updatedAt: '2026-08-09T03:00:00.000Z',
  };
  const libri = { markets: { [ID]: { mid: 0.49, ageMs: 1000, tokenId: '111', tokenIdNo: '222', yes: { bestBid: 0.47, bestAsk: 0.51 } } } };

  // Il mercato è sul board e viene aperto: si scrive la copia.
  CAT.upsertMarket(CAT.recordDaRigaBoard(RIGA), { by: 'test', reason: 'apertura' }, deps);

  // ── SCADENZA, non rotazione: il mercato entra in finestra di risoluzione e il piano lo lascia. Il
  //    board smette di pubblicarlo per un motivo DIVERSO dalla rotazione, ma l'effetto sulle regole è
  //    identico — ed è per questo che il ripiego, che è keyed sul mercato, li copre entrambi.
  const senza = MO.resolveMarketRules(ID, { books: libri, norm: { markets: [] }, catalogRecord: null });
  ok('mercato uscito dal board per SCADENZA: senza ripiego è rules-unreadable', senza.readable === false,
    `missing: ${(senza.missing || []).join(', ')}`);
  const con = MO.resolveMarketRules(ID, { books: libri, norm: { markets: [] }, catalogRecord: CAT.readMarketRecord(ID, deps) });
  ok('  CON il ripiego le regole si leggono ancora', con.readable === true);
  ok('  quindi chiusura, riprezzatura e tracking passano il loro gate', (con.missing || []).length === 0);
  ok('  e i valori sono quelli del venue, non ricostruiti',
    con.tick === 0.01 && con.maxSpreadCents === 4.5 && con.minSize === 20 && con.negRisk === true);

  // Il reset NON cancella il ripiego: una posizione su un mercato che sta per risolvere resta gestibile
  // finché la risoluzione non arriva davvero.
  const srcReset = fs.readFileSync(path.join(__dirname, 'allocation-reset.js'), 'utf8');
  ok('il reset non rimuove mai un record dal catalogo', !/removeMarket/.test(srcReset));
  ok('  e non nomina nemmeno il modulo del catalogo (la scrittura è iniettata)', !/market-catalog/.test(srcReset));

  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('\n── 5 · ANCHE IL CICLO DA 6 ORE SCRIVE LA COPIA (ERA IL PERCORSO SCOPERTO)');
{
  // Il mini-ciclo apre qualche mercato ogni tanto; la fase 3 del reset apre TUTTO IL PIANO. Fino al
  // 9 agosto solo il primo scriveva il ripiego, quindi i mercati aperti dal ciclo delle sei ore —
  // la maggioranza — nascevano senza copia di sicurezza.
  const rows = [{ marketId: '0xaaa1', capital: 50 }, { marketId: '0xbbb2', capital: 50 }];
  const base = (extra) => ({
    readEnabled: () => [], readTracking: () => [], listOrders: async () => ({ ok: true, orders: [] }),
    cancelOrder: async () => ({ ok: true }), setTrackingOff: async () => ({ ok: true }),
    setEnabled: async () => ({ ok: true }), setManual: async () => ({ ok: true }),
    setAutoClose: async () => ({ ok: true }), posizioneAperta: async () => false,
    placeBulk: async () => ({ ok: true, placed: 0, refused: 0, results: [] }),
    registraCatalogo: async () => ({ ok: true }),
    ...extra,
  });

  // `dryRunOnly:false` e' NECESSARIO: in anteprima il reset esce alla fase 0 e la fase 3 non gira, quindi
  // un test in anteprima verificherebbe il nulla — ed e' il modo in cui questa asserzione e' passata a
  // vuoto al primo tentativo (`(r.accesi || []).every(...)` su un array vuoto e' sempre vero). Nessun
  // effetto reale: ogni dipendenza che tocca il mondo e' sostituita, `placeBulk` compreso.
  // Sequenziale e con un array PER CHIAMATA: con un array condiviso fra esecuzioni concorrenti il
  // conteggio misura l'ordine di risoluzione delle promise, non il comportamento del reset.
  (async () => {
    const registrati = [];
    const r = await runAllocationReset({ rows, dryRunOnly: false },
      base({ registraCatalogo: async ({ marketId }) => { registrati.push(marketId); return { ok: true }; } }));
    ok('la fase 3 chiama registraCatalogo una volta per mercato del piano', registrati.length === 2, registrati.join(' '));
    ok('  con i marketId del piano', registrati.includes('0xaaa1') && registrati.includes('0xbbb2'));
    ok('  e l\'esito viaggia nel referto', (r.accensione.markets || []).every((a) => a.ripiegoRegole === true));

    // NON e' un fermo duro: una copia mancata non impedisce di piazzare. Le altre tre lo restano.
    const f = await runAllocationReset({ rows, dryRunOnly: false },
      base({ registraCatalogo: async () => ({ ok: false, error: 'catalogo illeggibile' }) }));
    ok('copia fallita ⇒ il mercato si accende lo stesso', (f.accensione.markets || []).every((a) => a.ok === true));
    ok('  ma il fallimento è dichiarato, non silenzioso',
      (f.accensione.markets || []).every((a) => a.ripiegoRegole === false && /catalogo illeggibile/.test(a.ripiegoMotivo || '')));

    const e = await runAllocationReset({ rows, dryRunOnly: false },
      base({ registraCatalogo: async () => { throw new Error('boom'); } }));
    ok('una copia che ESPLODE non fa fallire il reset', (e.accensione.markets || []).every((a) => a.ok === true && a.ripiegoRegole === false));

    const senza = base({}); delete senza.registraCatalogo;
    const n = await runAllocationReset({ rows, dryRunOnly: false }, senza);
    ok('dep non cablata ⇒ si prosegue e lo si dice', (n.accensione.markets || []).every((a) => a.ok === true && a.ripiegoRegole === false));

    // Ma setAutoClose e setManual restano fermi duri: la distinzione è tutto il punto.
    const a1 = await runAllocationReset({ rows, dryRunOnly: false }, base({ setAutoClose: async () => ({ ok: false, error: 'no' }) }));
    ok('setAutoClose fallito resta un FERMO DURO', (a1.accensione.markets || []).every((a) => a.ok === false));
    const a2 = await runAllocationReset({ rows, dryRunOnly: false }, base({ setManual: async () => ({ ok: false, error: 'no' }) }));
    ok('setManual fallito resta un FERMO DURO', (a2.accensione.markets || []).every((a) => a.ok === false));
  })();

  // I due percorsi condividono UNA funzione: due copie della stessa traduzione divergerebbero.
  ok('mini-ciclo e reset usano la stessa funzione di copia', typeof A41.copiaRegoleNelRipiego === 'function');
  const src41 = fs.readFileSync(path.join(__dirname, '..', '..', 'agents/agent41-realloc-scheduler.js'), 'utf8');
  ok('  e c\'è una sola traduzione riga-di-board → record',
    (src41.match(/recordDaRigaBoard/g) || []).length === 1, `${(src41.match(/recordDaRigaBoard/g) || []).length} occorrenze`);
}

setTimeout(() => {
  console.log(`\n${falliti === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
}, 500);

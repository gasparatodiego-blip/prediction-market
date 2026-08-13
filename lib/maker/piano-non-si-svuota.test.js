'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *  IL VUOTO DEL 13 AGOSTO 2026 — tre ore, zero ordini, $609 fermi, e nessun errore in nessun log
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Questo file difende le tre proprietà che quella notte non erano difese da niente:
 *
 *  §1  la GRIGLIA del piano deve poter arrivare al tetto per mercato — altrimenti l'allocazione
 *      massima cade sotto il pavimento del mini-ciclo e OGNI riga viene rifiutata, per sempre;
 *  §2  il PAVIMENTO di una riga si misura su quella riga, non su un mercato tipico;
 *  §3  il piano si RICOSTRUISCE quando le righe spendibili scendono sotto i posti di un giro;
 *  §4  la SENTINELLA vede il vuoto in minuti, non in ore;
 *  §5  la SCADENZA è sempre recuperabile, e `scadenzaMercato → null` non è più un vicolo cieco.
 *
 * I numeri delle asserzioni sono quelli VERI misurati sul giornale vivo, non inventati: capitale
 * $609,10, tetto $32,67, unità $12, allocazione $24,00, pavimento $24,50, 114 rifiuti consecutivi.
 */

const assert = require('assert');
const TRIG = require('./trigger-capitale-fermo');
const SENT = require('./sentinella-vuoto');
const REC = require('./scadenza-recupero');
const { capPerMarketUsd, pavimentoPremiante, COSTO_COPPIA, MIN_PREMIANTE_TIPICO } = require('../rewards/concentration');
const { recordDaRigaBoard } = require('./market-catalog');

let passati = 0; let falliti = 0;
function ok(nome, fn) {
  try { fn(); passati += 1; } catch (e) { falliti += 1; console.error(`  ✗ ${nome}\n    ${e.message}`); }
}
async function okA(nome, fn) {
  try { await fn(); passati += 1; } catch (e) { falliti += 1; console.error(`  ✗ ${nome}\n    ${e.message}`); }
}

/** La riga com'era davvero nel piano delle 02:30: minSize 20, coppia 0,98, $24 allocati. */
const riga = (over = {}) => ({
  marketId: '0x' + '1'.repeat(64), capital: 24, minSizeShares: 20, pairCostUsd: 0.98,
  sizePerSideShares: 24.489795918367346, realisticBestPerDay: 3, ...over,
});

// ═══ §1 · LA GRIGLIA DEVE POTER ARRIVARE AL TETTO ═══════════════════════════════════════════════════
console.log('§1 · la griglia del capitale contro il tetto per mercato');

// Riproduce l'aritmetica di `allocator.js`: è il calcolo esatto che produceva $24.
const unitVecchia = (budget) => Math.max(2, Math.round(budget / 50));
const unitNuova = (budget, tetto) => Math.min(unitVecchia(budget), Math.max(1, Math.floor(tetto / 8)));
const maxAlloc = (unit, tetto) => Math.max(1, Math.floor(tetto / unit)) * unit;

ok('il caso vero: capitale $609,10 ⇒ unità $12 ⇒ massimo allocabile $24,00', () => {
  const tetto = capPerMarketUsd(664.6);
  assert.strictEqual(+tetto.toFixed(2), 32.67, 'il tetto misurato quella notte');
  assert.strictEqual(unitVecchia(609.1), 12);
  assert.strictEqual(maxAlloc(unitVecchia(609.1), tetto), 24, 'i $24 di ogni riga di ogni piano');
});

ok('e $24,00 stava SOTTO il pavimento di $24,50: il deadlock, in due numeri', () => {
  const pavimento = pavimentoPremiante(MIN_PREMIANTE_TIPICO);
  assert.strictEqual(pavimento, 24.5);
  assert.ok(maxAlloc(unitVecchia(609.1), capPerMarketUsd(664.6)) < pavimento,
    'se questa asserzione cade, il difetto del 13 agosto non è più riproducibile');
});

ok('NON era un caso isolato: la griglia vecchia è un dente di sega e cade sotto il pavimento a bande', () => {
  const rotti = [609.1, 900, 1000, 1200].filter((c) => {
    const t = capPerMarketUsd(Math.max(c, 664.6));
    return maxAlloc(unitVecchia(c), t) < pavimentoPremiante(MIN_PREMIANTE_TIPICO);
  });
  assert.deepStrictEqual(rotti, [609.1, 900, 1000, 1200], 'quattro bande di capitale bloccate, e peggiora crescendo');
});

ok('con la griglia nuova il tetto è raggiungibile a OGNI capitale, e il dente di sega sparisce', () => {
  for (const c of [200, 400, 500, 609.1, 664.6, 900, 1000, 1200, 2000, 5000]) {
    const t = capPerMarketUsd(c);
    const m = maxAlloc(unitNuova(c, t), t);
    assert.ok(m >= pavimentoPremiante(MIN_PREMIANTE_TIPICO) || t < pavimentoPremiante(MIN_PREMIANTE_TIPICO),
      `capitale $${c}: massimo allocabile $${m} contro pavimento $${pavimentoPremiante(MIN_PREMIANTE_TIPICO)}`);
    assert.ok(m >= t * 0.9, `capitale $${c}: la griglia arriva a $${m} contro un tetto di $${t.toFixed(2)}`);
  }
});

ok('la griglia può solo INFITTIRSI, mai diradarsi (è un Math.min)', () => {
  for (const c of [100, 609.1, 5000]) {
    assert.ok(unitNuova(c, capPerMarketUsd(c)) <= unitVecchia(c));
  }
});

ok('un chiamante che passa unitUsd esplicito non viene toccato: i backtest restano confrontabili', () => {
  const src = require('fs').readFileSync(require.resolve('../rewards/allocator.js'), 'utf8');
  assert.ok(/const unitUsd = cfg\.unitUsd \|\|/.test(src),
    'la nuova granularità deve restare dietro `cfg.unitUsd ||`, cioè valere solo per il pianificatore');
});

// ═══ §2 · IL PAVIMENTO SI MISURA SULLA RIGA ═════════════════════════════════════════════════════════
console.log('§2 · il pavimento di una riga');

ok('una riga da $24 su minSize 20 è premiante: 24,49 share, il 22% sopra il minimo del venue', () => {
  const r = riga();
  assert.ok(r.sizePerSideShares > r.minSizeShares);
  assert.strictEqual(TRIG.pavimentoDiRiga(r).usd, +(20 * 0.98).toFixed(2));
  assert.ok(r.capital >= TRIG.pavimentoDiRiga(r).usd, 'e quindi deve passare');
});

ok('IL CASO VERO: la riga da $24 adesso viene SCELTA (prima era rifiutata)', () => {
  const s = TRIG.scegliMercato({ righe: [riga()], disponibileUsd: 609.1, capPerMercatoUsd: 32.67 });
  assert.ok(s.riga, `nessuna riga scelta: ${s.motivo} · ${JSON.stringify(s.esaminate)}`);
  assert.strictEqual(s.allocatoUsd, 24);
});

ok('il pavimento è PIÙ STRETTO dove deve esserlo: minSize 200 chiede $196, non $24,50', () => {
  const r = riga({ minSizeShares: 200 });
  assert.strictEqual(TRIG.pavimentoDiRiga(r).usd, 196);
  assert.strictEqual(TRIG.scegliMercato({ righe: [r], disponibileUsd: 609.1, capPerMercatoUsd: 32.67 }).riga, null);
});

ok('una riga che non dichiara il proprio minimo ricade sulla costante globale', () => {
  const r = riga({ minSizeShares: null });
  assert.strictEqual(TRIG.pavimentoDiRiga(r).usd, TRIG.MIN_ALLOCAZIONE_USD);
  assert.ok(/minimo tipico/.test(TRIG.pavimentoDiRiga(r).come));
});

ok('IL CANCELLO DURO SUL MINIMO DEL VENUE NON È TOCCATO: sotto minSize si rifiuta ancora, in share', () => {
  // $10 su minSize 20: sopra il pavimento in dollari di una riga a minSize 10, ma le share non bastano.
  const r = riga({ minSizeShares: 20, capital: 10, sizePerSideShares: 10.2 });
  const s = TRIG.scegliMercato({ righe: [r], disponibileUsd: 10, capPerMercatoUsd: 32.67 });
  assert.strictEqual(s.riga, null, 'una riga sotto il minimo del venue non deve mai essere scelta');
});

ok('il costo della coppia si legge dalla riga, e in sua assenza dalla costante condivisa', () => {
  assert.strictEqual(TRIG.pavimentoDiRiga(riga({ pairCostUsd: 0.9 })).usd, 18);
  assert.strictEqual(TRIG.pavimentoDiRiga(riga({ pairCostUsd: null })).usd, +(20 * COSTO_COPPIA).toFixed(2));
});

// ═══ §3 · IL PIANO CHE SCENDE SOTTO SOGLIA ═════════════════════════════════════════════════════════
console.log('§3 · il piano che si consuma');

ok('contaRigheUtili conta le righe SPENDIBILI, non quelle presenti', () => {
  const righe = [riga({ marketId: '0x' + 'a'.repeat(64) }), riga({ marketId: '0x' + 'b'.repeat(64) })];
  assert.strictEqual(TRIG.contaRigheUtili({ righe, capPerMercatoUsd: 32.67, disponibileUsd: 609 }), 2);
  // Uno dei due è già pieno di ordini nostri: resta nel piano ma non è più spendibile.
  const pieno = { [righe[0].marketId]: 24 };
  assert.strictEqual(TRIG.contaRigheUtili({ righe, notionalePerMercato: pieno, capPerMercatoUsd: 32.67, disponibileUsd: 609 }), 1);
});

ok('LA SCENA DEL 13 AGOSTO: 17 righe dichiarate, ZERO spendibili con il pavimento vecchio', () => {
  const righe = Array.from({ length: 17 }, (_, i) => riga({ marketId: '0x' + String(i).padStart(64, '0') }));
  // Con il pavimento globale di allora ($24,50) nessuna delle 17 era spendibile.
  const conVecchio = righe.filter((r) => r.capital >= 24.5).length;
  assert.strictEqual(conVecchio, 0, 'il piano ne dichiarava 17 e le spendibili erano zero');
  // Con il pavimento della riga, tutte e diciassette.
  assert.strictEqual(TRIG.contaRigheUtili({ righe, capPerMercatoUsd: 32.67, disponibileUsd: 609 }), 17);
});

ok('la soglia di ricostruzione è i posti di un giro, non un numero nuovo', () => {
  assert.strictEqual(TRIG.SOGLIA_RIGHE_UTILI, TRIG.MAX_MERCATI_PER_GIRO);
});

ok('conteggio e scelta usano LO STESSO pavimento: non possono dare risposte diverse', () => {
  const src = require('fs').readFileSync(require.resolve('./trigger-capitale-fermo.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  const usi = (src.match(/pavimentoDiRiga\(/g) || []).length;
  assert.ok(usi >= 3, `pavimentoDiRiga deve essere chiamata da entrambi i percorsi (trovate ${usi} occorrenze)`);
});

ok('un piano sotto soglia è riconoscibile dal chiamante', () => {
  const righe = [riga({ marketId: '0x' + 'c'.repeat(64) })];
  const utili = TRIG.contaRigheUtili({ righe, capPerMercatoUsd: 32.67, disponibileUsd: 609 });
  assert.ok(utili < TRIG.SOGLIA_RIGHE_UTILI, 'una riga sola deve far scattare la ricostruzione');
});

ok('la ricostruzione passa dalla stessa porta del ciclo pesante (nessuna scorciatoia)', () => {
  const src = require('fs').readFileSync(require.resolve('../../agents/agent41-realloc-scheduler.js'), 'utf8');
  const corpo = src.slice(src.indexOf('async function pianoLeggero'), src.indexOf('async function pianoLeggero') + 1400);
  assert.ok(/calcolaPianoFuoriProcesso/.test(corpo), 'pianoLeggero deve passare da calcolaPianoFuoriProcesso');
  assert.ok(/horizonFilter/.test(corpo), 'e portarsi dietro il filtro di orizzonte');
});

// ═══ §4 · LA SENTINELLA ════════════════════════════════════════════════════════════════════════════
console.log('§4 · zero ordini a riposo per N minuti');

ok('la soglia è molto bassa: cinque minuti, contro i 180 di stanotte', () => {
  assert.strictEqual(SENT.SOGLIA_MS, 5 * 60_000);
});

ok('il vuoto del 13 agosto sarebbe stato visto in 5 minuti invece che in 180', () => {
  const T = 1_700_000_000_000;
  let s = SENT.valutaVuoto({ stato: null, ordiniARiposo: 0, killAttivo: false, botAvviato: true, now: T });
  let visto = null;
  for (let m = 2; m <= 180 && visto == null; m += 2) {         // la cadenza di rilevazione è 120 s
    s = SENT.valutaVuoto({ stato: s.stato, ordiniARiposo: 0, killAttivo: false, botAvviato: true, now: T + m * 60_000 });
    if (s.anomalia) visto = m;
  }
  assert.strictEqual(visto, 6, `scoperto a ${visto} minuti invece dei 180 reali`);
});

ok('e chiede la ricostruzione a OGNI giro finché il vuoto dura, non solo al primo', () => {
  const T = 1_700_000_000_000;
  let s = SENT.valutaVuoto({ stato: { vuotoDa: T, allarmato: true }, ordiniARiposo: 0, killAttivo: false, botAvviato: true, now: T + 30 * 60_000 });
  assert.strictEqual(s.deveRicostruire, true);
  assert.strictEqual(s.nuova, false, 'ma l\'allarme si scrive una volta per episodio');
});

ok('a bot FERMO o con KILL attivo il vuoto NON è un\'anomalia', () => {
  const T = 1_700_000_000_000;
  const st = { vuotoDa: T - 60 * 60_000, allarmato: true };
  assert.strictEqual(SENT.valutaVuoto({ stato: st, ordiniARiposo: 0, killAttivo: true, botAvviato: true, now: T }).anomalia, false);
  assert.strictEqual(SENT.valutaVuoto({ stato: st, ordiniARiposo: 0, killAttivo: false, botAvviato: false, now: T }).anomalia, false);
});

ok('un conteggio illeggibile NON arma e NON disarma: si congela', () => {
  const T = 1_700_000_000_000;
  const st = { vuotoDa: T - 60_000, allarmato: false };
  const v = SENT.valutaVuoto({ stato: st, ordiniARiposo: null, killAttivo: false, botAvviato: true, now: T });
  assert.strictEqual(v.anomalia, false);
  assert.strictEqual(v.stato, st, 'lo stato deve restare identico, non azzerato');
});

ok('la riga d\'allarme porta la ripartizione del fermo IN DOLLARI', () => {
  const r = SENT.rigaAllarme({
    vuotoMs: 6 * 60_000,
    capitale: { leggibile: true, alLavoroUsd: 55.5, totaleUsd: 664.6, pct: 8.4, obiettivoPct: 95 },
    ripartizione: { riga: 'fermo $609.10: piano senza righe utilizzabili $609.10 (100%)' },
  });
  assert.ok(/609\.10/.test(r) && /ZERO ordini a riposo/.test(r));
});

ok('la sentinella non piazza e non cancella: nessuna superficie nel modulo', () => {
  const src = require('fs').readFileSync(require.resolve('./sentinella-vuoto.js'), 'utf8');
  assert.ok(!/require\(/.test(src.replace(/^[\s\S]*?module\.exports/m, '')), 'nessun require dopo gli export');
  for (const proibito of ['placeManualOrder', 'cancelOrder', 'cancelManualOrder', 'createOrder', 'replaceManualOrder']) {
    assert.ok(!src.includes(proibito), `il modulo non deve nominare ${proibito}`);
  }
});

ok('è la LETTURA a costare, non un invio: la quota dei rinnovi non viene toccata', () => {
  const src = require('fs').readFileSync(require.resolve('../../agents/agent41-realloc-scheduler.js'), 'utf8');
  const corpo = src.slice(src.indexOf('async function sorvegliaVuoto'), src.indexOf('/** Il controllo periodico'));
  assert.ok(/listManualOrders/.test(corpo), 'la sentinella legge gli ordini');
  assert.ok(!/piazzaCoppia|placeManualOrder|cancelManualOrder/.test(corpo), 'e non ne invia né ne cancella nessuno');
});

// ═══ §5 · LA SCADENZA CHE RISPONDE null ════════════════════════════════════════════════════════════
console.log('§5 · scadenzaMercato → null non è più un vicolo cieco');

ok('IL DIFETTO: il mapper del ripiego non copiava endDate — adesso sì', () => {
  const rec = recordDaRigaBoard({ marketId: '0x' + 'd'.repeat(64), tokenId: '1', tokenIdNo: '2', tickSize: 0.01,
    minSize: 20, endDate: '2026-08-14T16:00:00Z', endDateFonte: 'gamma-ora-vera-su-clob-troncato' });
  assert.strictEqual(rec.endDate, '2026-08-14T16:00:00Z');
  assert.strictEqual(rec.endDateFonte, 'gamma-ora-vera-su-clob-troncato', 'la fonte viaggia con la data');
});

ok('una riga di board senza scadenza non produce una data inventata', () => {
  const rec = recordDaRigaBoard({ marketId: '0x' + 'e'.repeat(64), endDate: '   ' });
  assert.strictEqual(rec.endDate, null);
});

ok('chi ha già la scadenza non viene chiesto al venue', () => {
  assert.strictEqual(REC.daRecuperare({ marketIds: ['0x' + 'a'.repeat(64)], scadenzaNota: () => Date.now() + 3600_000 }).length, 0);
});

ok('LE CINQUE POSIZIONI MURATE: senza data si chiedono tutte', () => {
  const ids = ['cd126ec4', 'e0ef2559', '3286f89e', '9b5b7143', 'e9b3e28d'].map((p) => '0x' + p + '0'.repeat(56));
  const chiesti = REC.daRecuperare({ marketIds: ids, scadenzaNota: () => null, maxPerGiro: 10 });
  assert.strictEqual(chiesti.length, 5);
});

okA('la scadenza recuperata viene SCRITTA nel ripiego, e da lì la chiusura forzata la vede', async () => {
  const scritti = [];
  const r = await REC.recuperaScadenze({
    marketIds: ['0x' + 'a'.repeat(64)], scadenzaNota: () => null,
    fetchOne: async () => ({ ok: true, market: { endDate: '2026-08-14T16:00:00Z' } }),
    salva: (x) => { scritti.push(x); return { ok: true }; },
  });
  assert.strictEqual(r.recuperati.length, 1);
  assert.strictEqual(scritti[0].endDate, '2026-08-14T16:00:00Z');
});

okA('una data non parsabile NON viene mai scritta: meglio nessuna scadenza che una inventata', async () => {
  const scritti = [];
  const r = await REC.recuperaScadenze({
    marketIds: ['0x' + 'b'.repeat(64)], scadenzaNota: () => null,
    fetchOne: async () => ({ ok: true, market: { endDate: 'presto' } }),
    salva: (x) => { scritti.push(x); return { ok: true }; },
  });
  assert.strictEqual(scritti.length, 0);
  assert.strictEqual(r.recuperati.length, 0);
});

okA('venue muto: nessuna scrittura, e non si martella (finestra di ritentativo)', async () => {
  const id = '0x' + 'c'.repeat(64);
  const r = await REC.recuperaScadenze({ marketIds: [id], scadenzaNota: () => null, fetchOne: async () => ({ ok: false, error: '429' }), salva: () => ({ ok: true }) });
  assert.strictEqual(r.recuperati.length, 0);
  assert.strictEqual(REC.daRecuperare({ marketIds: [id], scadenzaNota: () => null, falliti: r.falliti, now: Date.now() }).length, 0);
});

ok('il recupero non chiude, non piazza e non cancella niente', () => {
  const src = require('fs').readFileSync(require.resolve('./scadenza-recupero.js'), 'utf8');
  for (const proibito of ['placeManualOrder', 'cancelManualOrder', 'createOrder', 'planExit', 'mergePosition']) {
    assert.ok(!src.includes(proibito), `il modulo non deve nominare ${proibito}`);
  }
});

setTimeout(() => {
  console.log(`\npiano-non-si-svuota: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
}, 150);

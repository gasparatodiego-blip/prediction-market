'use strict';
// lib/maker/selezione-coda-lunga.test.js
//
// LA PROPRIETA': la selezione non puo' comporsi TUTTA di coda lunga quando esiste un candidato in
// fascia corta — perche' l'allocatore finanzia la coda lunga solo a partire dal budget della fascia
// corta, e «fascia corta vuota ⇒ la coda non ottiene niente» (§4.4).
//
// IL FATTO DA CUI NASCE, misurato il 18 agosto 2026: con `MAKER_MERCATI_CONTEMPORANEI=1` l'unico slot
// e' finito su un mercato a 134,2 giorni. Il piano e' ristretto alla selezione, quindi la sua fascia
// corta era vuota, quindi il ricalcolo produceva **zero righe** — per 196 minuti, e per sempre se
// nessuno avesse guardato. La scala di sblocco e' salita al gradino 6 SETTE VOLTE senza poterlo
// sciogliere: il blocco non era nello stato del bot, era fra due regole che non si parlavano.
//
// ⚠ NON SI ASSERISCE IL NUMERO 7, SI ASSERISCE LA RELAZIONE. La soglia arriva iniettata; il test la
// passa esplicitamente e verifica il COMPORTAMENTO al di qua e al di la', non il valore.

const assert = require('assert');
const S = require('./selezione-mercati');

let passati = 0;
const ok = (cond, nome) => { assert.ok(cond, nome); passati += 1; };

const ORA = Date.parse('2026-08-18T18:00:00Z');
const GIORNO = 86_400_000;
const CODA = 7;   // la stessa soglia che `horizon.LONG_TAIL_DAYS` porta in produzione

const mkt = (id, giorni, extra = {}) => ({
  conditionId: id,
  question: `mercato ${id} a ${giorni} giorni`,
  category: 'elections',
  rewardsMinSize: 20,
  endDate: new Date(ORA + giorni * GIORNO).toISOString(),
  ...extra,
});
const POSIZIONI = { leggibile: true, conditionIds: [] };
const decidi = (board, opts = {}) => S.decidiSelezione({
  board, stato: S.statoVuoto(), posizioni: POSIZIONI, ora: ORA, max: 1, ...opts,
});
const ids = (d) => d.entranti.map((x) => x.id);

// ══ ① SENZA LA SOGLIA, IL COMPORTAMENTO E' QUELLO DI PRIMA ═════════════════════════════════════════
{
  // Un mercato a 134 giorni e uno a 2. Senza `codaLungaGiorni` la regola non esiste e vince il netto.
  const board = [mkt('0xlungo', 134), mkt('0xcorto', 2)];
  const netto = { '0xlungo': 99, '0xcorto': 1 };   // il lungo e' nettamente il migliore
  const senza = decidi(board, { nettoPerMercato: netto });
  ok(senza.ok === true, '① la decisione si prende');
  ok(ids(senza).includes('0xlungo'),
    '① senza la soglia entra il mercato a 134 g — cioe il comportamento del 18 agosto');
  ok((senza.scartatiPerCodaLunga || []).length === 0, '① e non si dichiara nessuno scarto');
}

// ══ ② CON LA SOGLIA, LO SLOT VA ALLA FASCIA CORTA ══════════════════════════════════════════════════
{
  const board = [mkt('0xlungo', 134), mkt('0xcorto', 2)];
  const netto = { '0xlungo': 99, '0xcorto': 1 };
  const con = decidi(board, { nettoPerMercato: netto, codaLungaGiorni: CODA });
  ok(!ids(con).includes('0xlungo'),
    '② ⚑ col vincolo il mercato a 134 g NON entra, benche sia il migliore per netto');
  ok(ids(con).includes('0xcorto'),
    '② ⚑ entra quello in fascia corta — e il piano avra un budget da cui derivare la coda');
  const sc = con.scartatiPerCodaLunga || [];
  ok(sc.length === 1 && sc[0].id === '0xlungo', '② e lo scarto e dichiarato, col suo id');
  ok(sc[0].motivo === 'coda-lunga-senza-fascia-corta', '② con un motivo leggibile');
}

// ══ ③ IL CONFINE E' DOVE LO DICE LA SOGLIA, E SI PROVA DAI DUE LATI ════════════════════════════════
{
  // A 6,9 giorni e' corto; a 7,1 e' lungo. Nessun numero cablato: si sposta la soglia e si guarda.
  const quasiCorto = decidi([mkt('0xa', 6.9)], { codaLungaGiorni: CODA });
  ok(ids(quasiCorto).includes('0xa'), '③ sotto la soglia il mercato entra');

  const quasiLungo = decidi([mkt('0xb', 7.1)], { codaLungaGiorni: CODA });
  ok(ids(quasiLungo).includes('0xb'),
    '③ sopra la soglia entra LO STESSO se non ci sono candidati corti: meglio un mercato che nessuno');
  ok((quasiLungo.scartatiPerCodaLunga || []).length === 0,
    '③ e non si dichiara uno scarto che non c e stato');

  // Con entrambi, la soglia decide chi ha diritto allo slot.
  const insieme = decidi([mkt('0xb', 7.1), mkt('0xa', 6.9)], { codaLungaGiorni: CODA });
  ok(ids(insieme).includes('0xa') && !ids(insieme).includes('0xb'),
    '③ ⚑ con entrambi vince il corto — il confine e la soglia, non un numero scritto nel test');
}

// ══ ④ SE C'E' GIA' UN CORTO ATTIVO, LA CODA LUNGA E' AMMESSA ═══════════════════════════════════════
{
  // Due slot: uno gia' occupato da un mercato in fascia corta. Il budget della corta esiste, quindi la
  // seconda passata dell'allocatore ha da cosa derivare e il vincolo non deve mordere.
  // ⚠ Lo scaglione conta: con `max=2` la quota e' 1 «basso» (minSize <= 20) + 1 «alto» (<= 50). Se
  // entrambi fossero minSize 20 il secondo verrebbe escluso per COMPOSIZIONE, e il test misurerebbe
  // quel vincolo credendo di misurare questo. Il lungo prende quindi il posto «alto».
  const board = [mkt('0xcorto', 2), mkt('0xlungo', 134, { rewardsMinSize: 50 })];
  const stato = S.normalizzaStato({
    selezionati: { '0xcorto': { entratoAt: ORA - 1000, question: 'corto', scaglione: 'basso', inGestione: false } },
  });
  const d = S.decidiSelezione({
    board, stato, posizioni: POSIZIONI, ora: ORA, max: 2, codaLungaGiorni: CODA,
    nettoPerMercato: { '0xlungo': 99 },
  });
  ok(ids(d).includes('0xlungo'),
    '④ ⚑ con un corto gia attivo la coda lunga entra: il vincolo protegge il budget, non punisce la scadenza');
  ok((d.scartatiPerCodaLunga || []).length === 0, '④ e non si dichiara nessuno scarto');
}

// ══ ⑤ COSA GARANTISCE DAVVERO, e la prima stesura lo aveva scritto SBAGLIATO ═══════════════════════
//
// ⚠ QUI C'ERA UN'ASSERZIONE DI «MONOTONIA» come inclusione fra insiemi: «ogni mercato scelto col
// vincolo era gia scelto senza». E' FALSA, e il test l'ha presa. Il vincolo restringe i CANDIDATI, non
// la SELEZIONE: con uno slot solo, escludere il lungo fa entrare un corto che prima non entrava. Cioe'
// l'insieme scelto CAMBIA, non si restringe — ed e' esattamente lo scopo della regola.
// La proprieta' vera e' doppia, e si asserisce quella.
{
  const board = [mkt('0xl1', 40), mkt('0xl2', 90), mkt('0xc1', 3), mkt('0xc2', 5)];
  const netto = { '0xl1': 10, '0xl2': 9, '0xc1': 1, '0xc2': 2 };
  const oreCoda = CODA * 24;
  const eLungo = (id) => ({ '0xl1': 40, '0xl2': 90, '0xc1': 3, '0xc2': 5 }[id] * 24) > oreCoda;
  for (const max of [1, 2, 3]) {
    const senza = decidi(board, { max, nettoPerMercato: netto });
    const con = decidi(board, { max, nettoPerMercato: netto, codaLungaGiorni: CODA });
    ok(ids(con).length <= ids(senza).length,
      `⑤ max=${max}: il vincolo non fa entrare PIU mercati di prima`);
    // ⚑ La garanzia che conta: non si finisce mai con una selezione tutta coda lunga quando un corto
    //   era disponibile — che e' la condizione da cui nasceva il deadlock.
    const scelti = ids(con);
    ok(scelti.length === 0 || scelti.some((id) => !eLungo(id)),
      `⑤ max=${max}: ⚑ almeno un mercato scelto e in fascia corta — mai una selezione tutta coda lunga`);
  }
}

// ══ ⑥ SOGLIA MALFATTA ⇒ REGOLA NON APPLICATA, mai una regola inventata ═════════════════════════════
{
  const board = [mkt('0xlungo', 134), mkt('0xcorto', 2)];
  const netto = { '0xlungo': 99, '0xcorto': 1 };
  for (const cattiva of [null, undefined, 0, -1, NaN, 'sette', {}]) {
    const d = decidi(board, { nettoPerMercato: netto, codaLungaGiorni: cattiva });
    ok(ids(d).includes('0xlungo'),
      `⑥ soglia ${JSON.stringify(cattiva)} ⇒ regola NON applicata, comportamento di prima`);
  }
}

// ══ ⑦ IL MODULO E' ANCORA PURO ════════════════════════════════════════════════════════════════════
{
  const src = require('fs').readFileSync(require.resolve('./selezione-mercati'), 'utf8');
  const requires = src.split('\n').filter((l) => /(^|[^/])\brequire\s*\(/.test(l) && !l.trim().startsWith('//'));
  ok(requires.length === 0,
    '⑦ zero `require`: la soglia si INIETTA proprio perche questo modulo non puo importarla');
}

console.log(`selezione coda lunga: ${passati}/${passati} verdi, 0 rossi`);

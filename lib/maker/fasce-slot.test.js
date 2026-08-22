'use strict';
// lib/maker/fasce-slot.test.js — LE DUE FASCE SONO DUE CONTATORI SEPARATI, E MORDONO.
//
// ⚠ QUESTO TEST DEVE FALLIRE SUL SORGENTE NON CORRETTO, e i suoi blocchi sono scritti per quello:
//   ① a 12 slot con 10 lunghi e 5 corti ammissibili il bot ne tiene **12**, non 10 (il tetto era 10);
//   ② un CORTO non prende mai un posto LUNGO, nemmeno quando i posti lunghi avanzano e i corti sono
//      finiti — e viceversa. Sul sorgente di ieri (nessuna nozione di fascia) i corti riempivano
//      qualunque posto libero, quindi il blocco ② e' rosso;
//   ③ i posti corti avanzati restano VUOTI e si dichiarano, invece di passare ai lunghi;
//   ④ ogni fascia riceve la PROPRIA distanza, e resta dentro banda;
//   ⑤ uno spodestamento non e' la porta di servizio da cui un corto prende un posto lungo.
// Ognuno morde sul COMPORTAMENTO (quali id finiscono in selezione, quale numero esce dal modulo della
// distanza), mai sul testo del sorgente: un test che cerca una stringa e' verde appena si scrive il
// commento giusto (§5.3).

const SEL = require('./selezione-mercati');
const DF = require('./distanza-fascia');
const QM = require('./quanti-mercati');

let pass = 0; let fail = 0;
// ⚠ SU UN SORGENTE SENZA FASCE `d.fasce` E' `undefined`, e un `TypeError` interromperebbe il test a
// meta': chi lo esegue sul sorgente vecchio (che e' il modo di verificare che MORDA) vedrebbe due
// rossi e uno stack, invece dell'elenco completo. `F()` risponde con una forma vuota.
const F = (d) => (d && d.fasce) || { attiva: null, postiVuoti: [], scartatiPerFascia: [],
  entrantiPerFascia: { corta: null, lunga: null }, slotCorti: null, slotLunghi: null };
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ok  ${n}`); } else { fail += 1; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };

const ORA = Date.parse('2026-08-22T14:00:00Z');
const H = 3600000;
// Un mercato sintetico ammissibile: minSize 20 (secchio «basso») o 50 («alto»), niente meteo,
// scadenza esplicita. `_atMidShare500` non serve: la selezione ordina sul netto INIETTATO.
const M = (id, ore, minSize, nome) => ({
  conditionId: id, question: nome || `mercato ${id}`, category: 'Economy',
  rewardsMinSize: minSize, rewardsDailyRate: 100, rewardsMaxSpread: 4.5, tickSize: 0.01,
  endDate: new Date(ORA + ore * H).toISOString(),
});
const vuoto = { selezionati: {} };
const nessunaPosizione = { conditionIds: [], leggibile: true };
const ordiniVuoti = { leggibile: true, ids: [] };

// ── ① IL TETTO E' 12, NON 10 ────────────────────────────────────────────────────────────────────
// ⚠ SI ASSERISCE SUL COMPORTAMENTO, non sulla costante: con 10 lunghi e 5 corti ammissibili il bot
// deve TENERNE 12. Un test su `MAX_MERCATI_CONTEMPORANEI === 12` sarebbe una fotografia del numero.
{
  // 12 lunghi + 6 corti disponibili, tutti «alto» tranne uno per secchio, cosi' la composizione non
  // e' il vincolo che sta mordendo (la si prova a parte, in ⑥).
  const board = [];
  for (let i = 0; i < 12; i += 1) board.push(M(`0xL${i}`, 200 + i, i === 0 ? 20 : 50));
  for (let i = 0; i < 6; i += 1) board.push(M(`0xC${i}`, 30 + i, i === 0 ? 20 : 50));
  const netto = {}; board.forEach((r, i) => { netto[r.conditionId] = 100 - i; });
  const d = SEL.decidiSelezione({ board, stato: vuoto, posizioni: nessunaPosizione, ora: ORA,
    max: 12, slotCorti: 5, nettoPerMercato: netto, conOrdiniVivi: ordiniVuoti });
  const dentro = Object.keys(d.statoNuovo.selezionati);
  ok('① dodici slot, dodici mercati tenuti (era 10: rosso sul sorgente di ieri)',
    d.ok === true && dentro.length === 12, `${d.ok} · ${dentro.length}`);
}

// ── ② UN CORTO NON PRENDE MAI UN POSTO LUNGO ────────────────────────────────────────────────────
// Il caso costruito apposta: SETTE corti disponibili per CINQUE posti corti, e i corti hanno il netto
// piu' alto di tutti. Senza le due fasce la classifica li farebbe entrare tutti e sette, prendendo due
// posti lunghi. Con le fasce ne entrano esattamente cinque.
{
  const board = [];
  for (let i = 0; i < 7; i += 1) board.push(M(`0xC${i}`, 30 + i, 50));
  for (let i = 0; i < 7; i += 1) board.push(M(`0xL${i}`, 200 + i, 50));
  const netto = {};
  board.forEach((r) => { netto[r.conditionId] = r.conditionId.startsWith('0xc') || r.conditionId.startsWith('0xC') ? 900 : 1; });
  const d = SEL.decidiSelezione({ board, stato: vuoto, posizioni: nessunaPosizione, ora: ORA,
    max: 12, slotCorti: 5, nettoPerMercato: netto, conOrdiniVivi: ordiniVuoti });
  const dentro = Object.keys(d.statoNuovo.selezionati);
  const corti = dentro.filter((id) => id.startsWith('0xc'));
  ok('② sette corti col netto migliore, ma i posti corti sono cinque ⇒ ne entrano CINQUE',
    corti.length === 5, `entrati ${corti.length}`);
  ok('  e i due esclusi lo sono PER FASCIA, non per secchio',
    F(d).scartatiPerFascia.filter((x) => x.motivo === 'fascia-piena').length === 2,
    JSON.stringify(F(d).scartatiPerFascia));
  // ⚠ SEI, NON SETTE, E IL SETTIMO E' TENUTO FUORI DALLA COMPOSIZIONE, NON DALLA FASCIA.
  // Il board di questo blocco e' tutto `minSize 50`, cioe' tutto secchio «alto», che a 12 slot ha
  // 11 posti (1 basso + 11 alti). Cinque li prendono i corti ⇒ ne restano SEI per i lunghi, e il
  // posto «basso» resta vuoto perche' nessun candidato ha `minSize ≤ 20`. Le due partizioni sono
  // ortogonali e mordono ENTRAMBE: e' il comportamento voluto, e va asserito com'e' invece di
  // aspettarsi che una delle due si faccia da parte.
  ok('  i posti lunghi vanno ai LUNGHI, e il dodicesimo lo ferma il SECCHIO non la fascia',
    dentro.filter((id) => id.startsWith('0xl')).length === 6
    && d.scartatiPerComposizione.length >= 1
    && d.postiNonAssegnati.some((x) => x.scaglione === 'basso'),
    `lunghi ${dentro.filter((id) => id.startsWith('0xl')).length} · scartatiComp ${d.scartatiPerComposizione.length}`);
}

// ── ③ I POSTI CORTI AVANZATI RESTANO VUOTI ──────────────────────────────────────────────────────
// Due soli corti ammissibili per cinque posti: i tre che avanzano NON vanno ai lunghi.
{
  const board = [];
  for (let i = 0; i < 2; i += 1) board.push(M(`0xC${i}`, 30 + i, 50));
  for (let i = 0; i < 12; i += 1) board.push(M(`0xL${i}`, 200 + i, 50));
  const netto = {}; board.forEach((r, i) => { netto[r.conditionId] = 100 - i; });
  const d = SEL.decidiSelezione({ board, stato: vuoto, posizioni: nessunaPosizione, ora: ORA,
    max: 12, slotCorti: 5, nettoPerMercato: netto, conOrdiniVivi: ordiniVuoti });
  const dentro = Object.keys(d.statoNuovo.selezionati);
  // Anche qui il secchio «basso» resta vuoto (nessun `minSize ≤ 20`), quindi i lunghi sono 7 su 11
  // posti «alto»: la fascia si ferma a 7 PRIMA che il secchio morda, ed e' cio' che si vuole provare.
  ok('③ due corti su cinque posti ⇒ nove mercati, NON dodici (i tre posti corti restano vuoti)',
    dentro.length === 9, `${dentro.length}`);
  ok('  i lunghi si fermano ai loro sette, non prendono i posti corti avanzati',
    dentro.filter((id) => id.startsWith('0xl')).length === 7);
  ok('  e i tre posti vuoti si DICHIARANO',
    F(d).postiVuoti.some((x) => x.fascia === 'corta' && x.posti === 3), JSON.stringify(F(d).postiVuoti));
}

// ── ④ OGNI FASCIA RICEVE LA PROPRIA DISTANZA, E RESTA DENTRO BANDA ─────────────────────────────
{
  const env = { [DF.ENV_DISTANZA_CORTI]: '3.0' };
  const LUNGHI_C = 2.052;                       // 0,456 × 4,5 — la distanza di oggi, non toccata
  const corto = DF.distanzaPerMercato({ oreAllaScadenza: 33.3, bandRadiusCents: 4.5, tick: 0.01,
    distanzaLunghiCents: LUNGHI_C, env });
  const lungo = DF.distanzaPerMercato({ oreAllaScadenza: 200, bandRadiusCents: 4.5, tick: 0.01,
    distanzaLunghiCents: LUNGHI_C, env });
  ok('④ il corto riceve 3,0¢', corto.applica === true && corto.cents === 3);
  ok('  il lungo NON e\' toccato', lungo.applica === false);
  ok('  e sono davvero DUE distanze diverse', corto.cents !== LUNGHI_C);
  ok('  il corto resta DENTRO la banda', corto.cents <= 4.5);
  // Su qualunque banda e qualunque ora: mai fuori, mai piu' vicino al mid dei lunghi.
  let sempre = true;
  for (const v of [0.5, 1, 2.25, 3, 4.5, 6, 10]) {
    for (const ore of [0.5, 12, 24, 47.9, 48, 48.1, 200, 3000]) {
      const r = DF.distanzaPerMercato({ oreAllaScadenza: ore, bandRadiusCents: v, tick: 0.01,
        distanzaLunghiCents: LUNGHI_C, env });
      if (!r.applica) continue;
      if (ore > DF.SOGLIA_CORTI_ORE) { sempre = false; break; }        // un lungo non deve applicare
      if (r.cents > v + 1e-9) { sempre = false; break; }               // mai fuori banda
      if (r.cents < LUNGHI_C - 1e-9) { sempre = false; break; }        // mai piu' vicino al mid
    }
  }
  ok('  su 56 combinazioni banda×scadenza: mai fuori banda, mai piu\' vicina al mid, mai su un lungo', sempre);
}

// ── ⑤ LO SPODESTAMENTO NON E' LA PORTA DI SERVIZIO ─────────────────────────────────────────────
// Un corto fortissimo contro un occupante LUNGO debolissimo: lo scambio non deve avvenire, o il corto
// si prenderebbe un posto lungo senza passare dai contatori.
{
  const board = [M('0xCforte', 30, 50), M('0xLdebole', 200, 50)];
  const stato = { selezionati: { '0xldebole': { entratoAt: ORA - H, question: 'debole',
    uscenteDal: null, motivoUscita: null, scaglione: 'alto', categoria: 'Economy',
    inGestione: false, inGestioneDal: null } } };
  const netto = { '0xcforte': 999, '0xldebole': -50 };
  const d = SEL.decidiSelezione({ board, stato, posizioni: nessunaPosizione, ora: ORA,
    max: 12, slotCorti: 5, nettoPerMercato: netto, conOrdiniVivi: ordiniVuoti });
  ok('⑤ un corto NON spodesta un lungo (fasce diverse), anche col netto nove volte migliore',
    !d.spodestati.some((x) => x.uscente === '0xldebole' || x.id === '0xldebole'),
    JSON.stringify(d.spodestati));
  ok('  ma il corto entra lo stesso, su un posto CORTO',
    Object.keys(d.statoNuovo.selezionati).includes('0xcforte'));
  ok('  e il lungo resta dentro', Object.keys(d.statoNuovo.selezionati).includes('0xldebole'));
}

// ── ⑥ LA REGOLA SPENTA E' ESATTAMENTE IL COMPORTAMENTO DI PRIMA ────────────────────────────────
// ⚠ E' il CONTROLLO, senza il quale i blocchi sopra non proverebbero che la fascia stia facendo
// qualcosa: se anche a fascia spenta i corti si fermassero a cinque, il vincolo non sarebbe suo.
{
  const board = [];
  for (let i = 0; i < 7; i += 1) board.push(M(`0xC${i}`, 30 + i, 50));
  for (let i = 0; i < 7; i += 1) board.push(M(`0xL${i}`, 200 + i, 50));
  const netto = {}; board.forEach((r) => { netto[r.conditionId] = r.conditionId.startsWith('0xC') ? 900 : 1; });
  const d = SEL.decidiSelezione({ board, stato: vuoto, posizioni: nessunaPosizione, ora: ORA,
    max: 12, slotCorti: 0, nettoPerMercato: netto, conOrdiniVivi: ordiniVuoti });
  const corti = Object.keys(d.statoNuovo.selezionati).filter((id) => id.startsWith('0xc'));
  ok('⑥ CONTROLLO: a fascia SPENTA i sette corti entrano tutti e sette',
    corti.length === 7, `${corti.length}`);
  ok('  e il referto dichiara la fascia spenta invece di tacere', F(d).attiva === false);
}

// ── ⑦ I DUE CONTATORI SOMMANO SEMPRE AL TETTO ──────────────────────────────────────────────────
{
  let sempre = true;
  for (let T = 1; T <= QM.QUANTI_MASSIMO; T += 1) {
    for (const v of ['0', '1', '5', '12', '99', '-1', 'x', '', null]) {
      const r = QM.slotDiFascia({ MAKER_MERCATI_CONTEMPORANEI: String(T), MAKER_SLOT_CORTI: v }, T);
      if (r.corti + r.lunghi !== T || r.corti < 0 || r.lunghi < 0) { sempre = false; break; }
    }
  }
  ok('⑦ corti + lunghi = tetto, per ogni tetto e ogni ingresso (prova esaustiva)', sempre);
  const p = QM.slotDiFascia({ MAKER_MERCATI_CONTEMPORANEI: '12', MAKER_SLOT_CORTI: '5' }, 12);
  ok('  e la configurazione decisa e\' 5 corti + 7 lunghi = 12', p.corti === 5 && p.lunghi === 7);
}

console.log(`\nfasce e slot: ${pass} passati, ${fail} falliti\n`);
process.exit(fail === 0 ? 0 : 1);

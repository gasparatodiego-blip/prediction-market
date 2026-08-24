'use strict';
// lib/maker/travaso-fasce.test.js — IL TRAVASO FRA FASCE, E I QUATTRO MODI IN CUI NON DEVE AGIRE.
//
// ⚠ QUESTO TEST DEVE FALLIRE SUL SORGENTE DI IERI, e i suoi blocchi sono scritti per quello. Lo
// scenario di ① e' la MISURA del 24 agosto 2026 alle 10:58Z, non un'invenzione: 18 slot, 15 occupati
// (13 lunghi + 2 corti), `slotCorti 2 · slotLunghi 16`, tre posti vuoti TUTTI della fascia lunga,
// zero entranti in entrambe le fasce, e dodici candidati CORTI respinti uno per uno con
// `fascia-piena`. Tre slot fermi con dodici candidati pronti.
//
//   ① tre posti vuoti nella fascia lunga, zero entranti, undici/dodici scartati per fascia-piena
//      nell'altra ⇒ TRE travasi, nell'ordine del netto giornaliero;
//   ② un candidato con netto NON misurabile non travasa — nel dubbio non si agisce;
//   ③ il travaso non porta mai gli slot totali sopra `MAKER_MERCATI_CONTEMPORANEI`: quando il budget
//      globale di ingressi vale 1 si travasa UNO, anche se i posti di fascia liberi sono tre;
//   ④ il travaso non spodesta nessun occupante, nemmeno quando i candidati hanno un netto migliore;
//   ⑤ il referto punta al campo che contiene DAVVERO la causa (§5.2 p.72), e quando gli scarti sono
//      per fascia lo dice con il nome della fascia piena e il conteggio;
//   ⑥ una fascia con posti vuoti ma UN entrante proprio non riceve nessun travaso.
//
// Ogni blocco morde sul COMPORTAMENTO — quali id finiscono in selezione, quanti posti restano vuoti,
// cosa dice il referto — mai sul testo del sorgente (§5.3).

const SEL = require('./selezione-mercati');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { if (c) { pass += 1; console.log(`  ok  ${n}`); } else { fail += 1; console.log(`FAIL  ${n}${x ? ' — ' + x : ''}`); } };
// ⚠ SU UN SORGENTE SENZA TRAVASO `d.travaso` E' `undefined`: un `TypeError` interromperebbe il test a
// meta' e chi lo esegue per verificare che MORDA vedrebbe uno stack invece dell'elenco completo.
const T = (d) => (d && d.travaso) || { travasi: [], posti: 0, postiVuotiDopo: [], nonTravasati: [], motivo: null };
const F = (d) => (d && d.fasce) || { postiVuoti: [], scartatiPerFascia: [], entrantiPerFascia: {} };

const ORA = Date.parse('2026-08-24T11:00:00Z');
const H = 3600000;
const M = (id, ore, minSize) => ({
  conditionId: id, question: `mercato ${id}`, category: 'Economy',
  rewardsMinSize: minSize, rewardsDailyRate: 100, rewardsMaxSpread: 4.5, tickSize: 0.01,
  endDate: new Date(ORA + ore * H).toISOString(),
});
const nessunaPosizione = { conditionIds: [], leggibile: true };
/** Uno stato con gli occupanti gia' dentro, come lo scriverebbe un giro precedente. */
const statoCon = (righe) => ({
  versione: 1, attiva: true, aggiornatoAl: ORA - 3600000,
  selezionati: Object.fromEntries(righe.map((r) => [r.conditionId.toLowerCase(), {
    entratoAt: ORA - 7200000, question: r.question, uscenteDal: null, motivoUscita: null,
    scaglione: Number(r.rewardsMinSize) <= 20 ? 'basso' : 'alto', categoria: 'Economy',
    inGestione: false, inGestioneDal: null,
  }])),
});

// ══ ① LA MISURA DEL 24 AGOSTO: TRE POSTI LUNGHI VUOTI, DODICI CANDIDATI CORTI ═══════════════════
// Occupanti 15 = 6 «basso» lunghi + 9 «alto» (7 lunghi + 2 corti) ⇒ fasce: corta 2, lunga 13.
// A N=18 la partizione di fascia vale 2 corti / 16 lunghi ⇒ posti vuoti: corta 0, lunga 3.
// La quota di scaglione vale 6 «basso» / 12 «alto» ⇒ posti di capitale liberi: basso 0, alto 3.
// I dodici candidati sono CORTI e «alto»: passano il secchio, cadono sulla fascia.
function scenarioMisurato({ netti = 'tutti' } = {}) {
  const occupanti = [];
  for (let i = 0; i < 6; i += 1) occupanti.push(M(`0xOB${i}`, 400 + i, 20));      // basso, lunghi
  for (let i = 0; i < 7; i += 1) occupanti.push(M(`0xOA${i}`, 400 + i, 50));      // alto, lunghi
  for (let i = 0; i < 2; i += 1) occupanti.push(M(`0xOC${i}`, 30 + i, 50));       // alto, CORTI
  const candidati = [];
  for (let i = 0; i < 12; i += 1) candidati.push(M(`0xK${String(i).padStart(2, '0')}`, 36 + i * 0.1, 50));
  const netto = {};
  // Gli occupanti valgono molto: nessuno dev'essere spodestabile per merito in questo scenario.
  occupanti.forEach((r) => { netto[r.conditionId.toLowerCase()] = 50; });
  candidati.forEach((r, i) => {
    if (netti === 'tutti') netto[r.conditionId.toLowerCase()] = 20 - i;           // 20, 19, 18, …
    else if (netti === 'nessuno') { /* nessun netto: solo il ripiego lordo */ }
    else if (netti === 'due' && i < 2) netto[r.conditionId.toLowerCase()] = 20 - i;
  });
  return {
    board: [...occupanti, ...candidati], stato: statoCon(occupanti), posizioni: nessunaPosizione,
    ora: ORA, max: 18, slotCorti: 2, nettoPerMercato: netto,
    // ⚠ TUTTI GLI OCCUPANTI HANNO ORDINI A RIPOSO: e' la condizione ③ dello spodestamento, ed e'
    // cio' che rende il blocco ④ una prova e non una coincidenza.
    conOrdiniVivi: { leggibile: true, ids: occupanti.map((r) => r.conditionId.toLowerCase()) },
  };
}

{
  const d = SEL.decidiSelezione(scenarioMisurato());
  const dentro = Object.keys(d.statoNuovo.selezionati);
  ok('① lo scenario e\' quello misurato: 15 occupati, 3 posti vuoti tutti nella fascia LUNGA',
    d.ammissibili === 27 && F(d).slotCorti === 2 && F(d).slotLunghi === 16,
    `ammissibili ${d.ammissibili} · corti ${F(d).slotCorti} · lunghi ${F(d).slotLunghi}`);
  ok('  i dodici candidati corti sono respinti per FASCIA-PIENA, non per secchio',
    F(d).scartatiPerFascia.filter((x) => x.motivo === 'fascia-piena' && x.fascia === 'corta').length === 12
    && d.scartatiPerComposizione.length === 0,
    `perFascia ${F(d).scartatiPerFascia.length} · perComposizione ${d.scartatiPerComposizione.length}`);
  ok('  ⇒ TRE travasi dalla fascia «corta» alla fascia «lunga»',
    T(d).posti === 3 && T(d).travasi.length === 1
    && T(d).travasi[0].da === 'corta' && T(d).travasi[0].a === 'lunga' && T(d).travasi[0].posti === 3,
    JSON.stringify(T(d).travasi));
  ok('  e sono i TRE MIGLIORI PER NETTO GIORNALIERO, in ordine',
    JSON.stringify(T(d).travasi[0] && T(d).travasi[0].ids) === JSON.stringify(['0xk00', '0xk01', '0xk02'])
    && JSON.stringify(T(d).travasi[0] && T(d).travasi[0].netti) === JSON.stringify([20, 19, 18]),
    JSON.stringify(T(d).travasi[0]));
  ok('  i tre posti sono davvero occupati: 18 mercati dentro, zero posti vuoti dopo',
    dentro.length === 18 && T(d).postiVuotiDopo.length === 0 && d.slotVuotiPerScarsita === null,
    `dentro ${dentro.length} · vuotiDopo ${JSON.stringify(T(d).postiVuotiDopo)}`);
  ok('  ⇒ e il travaso lascia una riga con origine, destinazione, posti, id, netti e vuoti dopo',
    T(d).tipo === 'travaso-fasce' && typeof T(d).motivo === 'string'
    && /corta/.test(T(d).motivo) && /lunga/.test(T(d).motivo) && /0xk00/.test(T(d).motivo)
    && /20\.000\/g/.test(T(d).motivo) && /restano 0 posti vuoti/.test(T(d).motivo),
    T(d).motivo);
}

// ══ ② UN NETTO NON MISURABILE NON TRAVASA — nel dubbio non si agisce ════════════════════════════
{
  const d = SEL.decidiSelezione(scenarioMisurato({ netti: 'nessuno' }));
  const dentro = Object.keys(d.statoNuovo.selezionati);
  ok('② dodici candidati senza netto misurabile ⇒ ZERO travasi',
    T(d).posti === 0 && dentro.length === 15, `posti ${T(d).posti} · dentro ${dentro.length}`);
  ok('  e la riga dice PERCHE\': nessuno ha un netto misurabile',
    typeof T(d).motivo === 'string' && /netto misurabile/.test(T(d).motivo), T(d).motivo);
}
{
  const d = SEL.decidiSelezione(scenarioMisurato({ netti: 'due' }));
  ok('  con DUE soli netti misurabili su dodici travasano quei due e basta',
    T(d).posti === 2
    && JSON.stringify(T(d).travasi[0] && T(d).travasi[0].ids) === JSON.stringify(['0xk00', '0xk01']),
    JSON.stringify(T(d).travasi));
  ok('  i dieci senza netto sono dichiarati uno per uno, non taciuti',
    T(d).nonTravasati.filter((x) => x.motivo === 'netto-non-misurabile').length === 10,
    JSON.stringify(T(d).nonTravasati.length));
  ok('  e il terzo posto resta VUOTO: non si riempie con un candidato non misurato',
    JSON.stringify(T(d).postiVuotiDopo) === JSON.stringify([{ fascia: 'lunga', posti: 1 }]),
    JSON.stringify(T(d).postiVuotiDopo));
}

// ══ ③ IL TRAVASO NON ALZA MAI IL NUMERO TOTALE DI SLOT ══════════════════════════════════════════
// ⚠ IL CASO E' COSTRUITO PERCHE' LE DUE CONTABILITA' DIVERGANO: la fascia corta e' SOVRA-occupata
// (8 corti su 6 posti), quindi la fascia lunga dichiara TRE posti vuoti mentre il budget globale di
// ingressi ne concede UNO SOLO (17 occupanti su 18 slot). Un travaso che guardasse i soli posti di
// fascia ne farebbe tre e porterebbe il bot a 20 slot: e' l'invariante `N × 2 × $61,25 ≤ cap` di
// §4.2 che ne dipende, e per questo il budget e' lo STESSO del 3-ter e non un contatore nuovo.
{
  const occupanti = [];
  for (let i = 0; i < 4; i += 1) occupanti.push(M(`0xPB${i}`, 400 + i, 20));      // basso, lunghi
  for (let i = 0; i < 5; i += 1) occupanti.push(M(`0xPA${i}`, 400 + i, 50));      // alto, lunghi
  for (let i = 0; i < 8; i += 1) occupanti.push(M(`0xPC${i}`, 30 + i, 50));       // alto, CORTI
  const candidati = [];
  for (let i = 0; i < 5; i += 1) candidati.push(M(`0xQ${i}`, 36 + i * 0.1, 20));  // basso, CORTI
  const netto = {};
  occupanti.forEach((r) => { netto[r.conditionId.toLowerCase()] = 50; });
  candidati.forEach((r, i) => { netto[r.conditionId.toLowerCase()] = 20 - i; });
  const d = SEL.decidiSelezione({ board: [...occupanti, ...candidati], stato: statoCon(occupanti),
    posizioni: nessunaPosizione, ora: ORA, max: 18, slotCorti: 6, nettoPerMercato: netto,
    conOrdiniVivi: { leggibile: true, ids: occupanti.map((r) => r.conditionId.toLowerCase()) } });
  const dentro = Object.keys(d.statoNuovo.selezionati);
  ok('③ tre posti di fascia liberi ma UN solo slot nel budget ⇒ UN travaso, non tre',
    T(d).posti === 1, `posti ${T(d).posti} · vuoti ${JSON.stringify(F(d).postiVuoti)}`);
  ok('  e gli slot totali restano 18, mai 19 o 20',
    dentro.length === 18 && dentro.length <= 18, `dentro ${dentro.length}`);
  ok('  i due posti che il budget non copre restano vuoti e si dichiarano',
    JSON.stringify(T(d).postiVuotiDopo) === JSON.stringify([{ fascia: 'lunga', posti: 2 }]),
    JSON.stringify(T(d).postiVuotiDopo));
}

// ══ ④ IL TRAVASO NON SPODESTA NESSUNO ═══════════════════════════════════════════════════════════
// I candidati corti hanno netto 20…9 e gli occupanti 1: per merito sarebbero tutti spodestabili, e a
// fermarli e' la condizione ③ (ordini a riposo). Il travaso deve prendere i POSTI VUOTI e nient'altro.
{
  const base = scenarioMisurato();
  for (const k of Object.keys(base.nettoPerMercato)) {
    if (/^0xo/.test(k)) base.nettoPerMercato[k] = 1;                 // occupanti a netto BASSO
  }
  const prima = Object.keys(base.stato.selezionati).sort();
  const d = SEL.decidiSelezione(base);
  const dentro = Object.keys(d.statoNuovo.selezionati);
  ok('④ nessun occupante e\' uscito: tutti e 15 sono ancora dentro',
    prima.every((id) => dentro.includes(id)), `mancano ${prima.filter((id) => !dentro.includes(id)).join(',')}`);
  ok('  nessuno spodestato e nessuno slot liberato dal travaso',
    d.spodestati.length === 0 && d.liberati.length === 0,
    `spodestati ${d.spodestati.length} · liberati ${d.liberati.length}`);
  ok('  e i tre entrati sono ENTRATI, cioe\' 15 + 3 = 18',
    dentro.length === 18 && T(d).posti === 3, `dentro ${dentro.length} · travasi ${T(d).posti}`);
}

// ══ ⑤ IL REFERTO PUNTA AL CAMPO CHE CONTIENE DAVVERO LA CAUSA — §5.2 p.72 ═══════════════════════
// ⚠ SUL SORGENTE DI IERI il motivo diceva «la ragione e' nella composizione o negli scarti dichiarati
// qui accanto» mentre `scartatiPerComposizione` era **[]**: mandava il lettore su una lista vuota.
{
  const d = SEL.decidiSelezione(scenarioMisurato({ netti: 'due' }));
  const s = d.slotVuotiPerScarsita;
  ok('⑤ resta un posto vuoto, e il referto lo dichiara', s !== null && s.quanti === 1, JSON.stringify(s));
  ok('  il motivo NON manda piu\' a «la composizione», che qui e\' vuota',
    typeof s.motivo === 'string' && !/nella composizione o negli scarti dichiarati qui accanto/.test(s.motivo),
    s.motivo);
  ok('  nomina il campo che contiene la causa: fasce.scartatiPerFascia',
    Array.isArray(s.campi) && s.campi.includes('fasce.scartatiPerFascia')
    && !s.campi.includes('scartatiPerComposizione')
    && /fasce\.scartatiPerFascia/.test(s.motivo), `${JSON.stringify(s.campi)} · ${s.motivo}`);
  ok('  e dice la FASCIA piena e il CONTEGGIO, per nome e per numero',
    /fascia «corta» piena, 12 candidati respinti/.test(s.motivo)
    && JSON.stringify(s.perFasciaPiena) === JSON.stringify([{ fascia: 'corta', quanti: 12 }]),
    `${s.motivo} · ${JSON.stringify(s.perFasciaPiena)}`);
  ok('  e riporta l\'esito del travaso, che e\' l\'ultima cosa che ha provato a riempirlo',
    typeof s.travaso === 'string' && s.travaso.length > 0, s.travaso);
}

// ══ ⑥ UNA FASCIA CON UN ENTRANTE PROPRIO NON RICEVE TRAVASI ═════════════════════════════════════
// ⚠ E' IL CONFINE DELLA REGOLA, e va provato o il travaso diventerebbe l'abolizione della partizione:
// basta UN entrante lungo perche' i posti lunghi restino dei lunghi.
{
  const base = scenarioMisurato();
  const lungo = M('0xZL0', 500, 50);                                  // un candidato LUNGO, «alto»
  base.board = [...base.board, lungo];
  base.nettoPerMercato[lungo.conditionId.toLowerCase()] = 30;
  const d = SEL.decidiSelezione(base);
  ok('⑥ con UN entrante lungo la fascia lunga non riceve nessun travaso',
    F(d).entrantiPerFascia.lunga === 1 && T(d).posti === 0,
    `entrantiLunga ${F(d).entrantiPerFascia.lunga} · travasi ${T(d).posti}`);
  ok('  e la riga lo dice: posti vuoti ma entranti propri',
    typeof T(d).motivo === 'string' && /entrante/.test(T(d).motivo), T(d).motivo);
}

console.log(`\ntravaso fra fasce: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

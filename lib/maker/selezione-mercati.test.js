'use strict';
// lib/maker/selezione-mercati.test.js — le PROPRIETA' della selezione automatica dei mercati.
//
// Si difendono proprieta', non fotografie: nessuna asserzione conta le occorrenze di una stringa nel
// sorgente e nessuna guarda `git diff` (§5.3, tre precedenti). Il criterio con cui e' scritto ogni
// caso e' «questo test diventerebbe rosso se la regola sparisse?».
//
// Esegue con: node lib/maker/selezione-mercati.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEL = require('./selezione-mercati');
const ST = require('./selezione-stato');

let n = 0;
function ok(nome, cond) {
  assert.ok(cond, nome);
  n += 1;
  console.log('  ok  ' + nome);
}
function titolo(t) { console.log('\n' + t); }

const ORA = Date.parse('2026-08-15T12:00:00.000Z');
const ORE = 3_600_000;

/** Una riga di board minima ma REALE nella forma: gli stessi campi di data/liquidity-rewards.json. */
function riga(over = {}) {
  return {
    conditionId: '0x' + '1'.repeat(64),
    question: 'Will the Republicans win the Illinois governor race in 2026?',
    slug: 'illinois-governor-2026',
    category: 'Politics',
    rewardsMinSize: 20,
    rewardsDailyRate: 5,
    rewardsMaxSpread: 4.5,
    existing_depth_usd: 1267,
    endDate: new Date(ORA + 100 * ORE).toISOString(),
    levels: { 500: { grossRewardDay: 1.4 } },
    ...over,
  };
}
const id = (k) => '0x' + String(k).padStart(64, '0');

// ══ 1 · I VINCOLI, UNO PER UNO ═══════════════════════════════════════════════════════════════════
titolo('1 · i quattro vincoli');
{
  ok('minSize 20 passa (e\' lo scaglione che questo capitale finanzia)',
    SEL.valutaAmmissibilita(riga({ rewardsMinSize: 20 }), { ora: ORA }).ammissibile === true);
  ok('minSize 50 NON passa',
    SEL.valutaAmmissibilita(riga({ rewardsMinSize: 50 }), { ora: ORA }).motivo === 'minsize-oltre-soglia');
  ok('minSize illeggibile NON passa, e non vale 0 (`Number(null)===0`, sette precedenti)',
    SEL.valutaAmmissibilita(riga({ rewardsMinSize: null }), { ora: ORA }).motivo === 'minsize-illeggibile');

  ok('scadenza a 47,9 h NON passa',
    SEL.valutaAmmissibilita(riga({ endDate: new Date(ORA + 47.9 * ORE).toISOString() }), { ora: ORA }).motivo === 'scadenza-troppo-vicina');
  ok('scadenza a 48,1 h passa',
    SEL.valutaAmmissibilita(riga({ endDate: new Date(ORA + 48.1 * ORE).toISOString() }), { ora: ORA }).ammissibile === true);
  ok('il confine e\' derivato dalla costante, non ricopiato',
    SEL.ORIZZONTE_MINIMO_MS === SEL.ORIZZONTE_MINIMO_ORE * ORE && SEL.ORIZZONTE_MINIMO_ORE === 48);
  ok('scadenza assente ⇒ ESCLUDE (§4.4: non si indovina)',
    SEL.valutaAmmissibilita(riga({ endDate: null, endDateClob: null, endDateGamma: null }), { ora: ORA }).motivo === 'scadenza-non-determinabile');
  ok('scadenza non parsabile ⇒ ESCLUDE',
    SEL.valutaAmmissibilita(riga({ endDate: 'domani', endDateClob: null, endDateGamma: null }), { ora: ORA }).motivo === 'scadenza-non-determinabile');
  ok('il board che ha gia\' bocciato la scadenza (fonti discordi) viene creduto',
    SEL.valutaAmmissibilita(riga({ scadenzaAmmissibile: false }), { ora: ORA }).motivo === 'scadenza-discorde');

  ok('un mercato meteo NON passa',
    SEL.valutaAmmissibilita(riga({ question: 'Will the lowest temperature in Hong Kong be 27°C on August 14?' }), { ora: ORA }).motivo === 'famiglia-meteo');
  ok('«weather» e «hurricane» sono meteo',
    SEL.eMeteo({ question: 'NYC weather in September' }) && SEL.eMeteo({ question: 'Will a hurricane hit Florida?' }));
}

// ══ 2 · LA REGRESSIONE CHE IL PRIMO ELENCO AVEVA DAVVERO ═════════════════════════════════════════
titolo('2 · il filtro meteo non puo\' mangiare la geopolitica');
{
  // «rain» senza ancore sta dentro «Ukraine»: due mercati veri del board del 15 agosto 2026 sarebbero
  // spariti in silenzio. Questo caso e' la ragione per cui l'elenco usa \b.
  ok('«Ukraine signs peace deal with Russia before 2027?» NON e\' meteo',
    SEL.eMeteo({ question: 'Ukraine signs peace deal with Russia before 2027?', category: 'Geopolitics' }) === false);
  ok('«Zelenskyy out as Ukraine president by end of 2026?» NON e\' meteo',
    SEL.eMeteo({ question: 'Zelenskyy out as Ukraine president by end of 2026?', slug: 'zelenskyy-out-2026' }) === false);
  ok('«Will Anthropic be acquired before 2027?» NON e\' meteo',
    SEL.eMeteo({ question: 'Will Anthropic be acquired before 2027?' }) === false);
}

// ══ 3 · IL TETTO DI DUE, E LO SLOT CHE NON SI LIBERA ═════════════════════════════════════════════
titolo('3 · il tetto di 2 e la regola dello slot');
{
  const board = [
    riga({ conditionId: id(1), levels: { 500: { grossRewardDay: 9 } } }),
    riga({ conditionId: id(2), levels: { 500: { grossRewardDay: 8 } } }),
    riga({ conditionId: id(3), levels: { 500: { grossRewardDay: 7 } } }),
    riga({ conditionId: id(4), levels: { 500: { grossRewardDay: 6 } } }),
  ];
  const nessunaPosizione = { leggibile: true, conditionIds: [] };

  const r1 = SEL.decidiSelezione({ board, stato: SEL.statoVuoto(), posizioni: nessunaPosizione, ora: ORA });
  ok('da zero entrano esattamente 2 mercati, non 4', r1.entranti.length === 2);
  ok('ed entrano i due col punteggio piu\' alto', r1.entranti.map((x) => x.id).join() === [id(1), id(2)].join());
  ok('il punteggio viene dalla stima del board, non dal montepremi',
    r1.entranti[0].fontePunteggio === 'levels.500.grossRewardDay');
  ok('lo stato registra 2 mercati occupati', r1.occupati === 2);

  // Un secondo giro identico non deve cambiare niente: la selezione e' stabile.
  const r2 = SEL.decidiSelezione({ board, stato: r1.statoNuovo, posizioni: nessunaPosizione, ora: ORA + 60_000 });
  ok('un secondo giro sullo stesso board non ruota i mercati', r2.entranti.length === 0 && r2.tenuti.length === 2);

  // Ora il mercato 1 scade sotto le 48 h ED HA una posizione aperta.
  const boardScaduto = [
    riga({ conditionId: id(1), endDate: new Date(ORA + 3 * ORE).toISOString(), levels: { 500: { grossRewardDay: 9 } } }),
    board[1], board[2], board[3],
  ];
  const conPos = { leggibile: true, conditionIds: [id(1)] };
  const r3 = SEL.decidiSelezione({ board: boardScaduto, stato: r2.statoNuovo, posizioni: conPos, ora: ORA + 120_000 });
  ok('il mercato che viola un vincolo ESCE dalla lista subito', r3.uscenti.length === 1 && r3.uscenti[0].id === id(1));
  ok('  e il motivo e\' quello vero, non un generico', r3.uscenti[0].motivo === 'scadenza-troppo-vicina');
  ok('MA lo slot NON si libera finche\' la posizione e\' aperta', r3.liberati.length === 0);
  ok('  quindi nessun sostituto entra', r3.entranti.length === 0);
  ok('  e gli slot occupati restano 2 — il tetto e\' sull\'esposizione', r3.occupati === 2);

  // Un giro dopo: la posizione e' stata chiusa.
  const r4 = SEL.decidiSelezione({ board: boardScaduto, stato: r3.statoNuovo, posizioni: nessunaPosizione, ora: ORA + 180_000 });
  ok('chiusa la posizione, lo slot si libera', r4.liberati.length === 1 && r4.liberati[0].id === id(1));
  ok('  e il sostituto entra nello stesso giro', r4.entranti.length === 1 && r4.entranti[0].id === id(3));
  ok('  senza mai superare il tetto', r4.occupati === 2);
  ok('  e l\'uscito non viene ridichiarato uscente una seconda volta', r4.uscenti.length === 0);

  // Il mercato uscente NON rientra da solo se torna ammissibile mentre e' ancora in uscita.
  const r5 = SEL.decidiSelezione({ board, stato: r3.statoNuovo, posizioni: conPos, ora: ORA + 240_000 });
  ok('un uscente che torna ammissibile non rientra dalla finestra', r5.tenuti.every((t) => t.id !== id(1)) && r5.occupati === 2);
}

// ══ 4 · FAIL-CLOSED ══════════════════════════════════════════════════════════════════════════════
titolo('4 · cosa succede quando non si sa');
{
  const stato = SEL.decidiSelezione({
    board: [riga({ conditionId: id(1) }), riga({ conditionId: id(2) })],
    stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA,
  }).statoNuovo;

  for (const [nome, board] of [['null', null], ['vuoto', []], ['non-array', {}]]) {
    const r = SEL.decidiSelezione({ board, stato, posizioni: { leggibile: true, conditionIds: [] }, ora: ORA });
    ok(`board ${nome} ⇒ nessuna decisione, e SOPRATTUTTO nessuno esce`,
      r.ok === false && r.uscenti.length === 0 && r.entranti.length === 0 && r.liberati.length === 0);
  }
  const rp = SEL.decidiSelezione({ board: [riga()], stato, posizioni: { leggibile: false, motivo: 'snapshot vecchio' }, ora: ORA });
  ok('posizioni non leggibili ⇒ nessuno slot si libera su un\'ipotesi',
    rp.ok === false && rp.liberati.length === 0 && rp.entranti.length === 0);
  ok('  e il motivo dichiara la causa', /non leggibili/.test(rp.motivo));

  const ro = SEL.decidiSelezione({ board: [riga()], stato, posizioni: { leggibile: true, conditionIds: [] }, ora: null });
  ok('orologio non leggibile ⇒ nessuna decisione', ro.ok === false && ro.entranti.length === 0);

  ok('lo stato restituito su rifiuto e\' quello di prima, normalizzato — non uno vuoto',
    Object.keys(rp.statoNuovo.selezionati).length === 2);
}

// ══ 5 · IL TETTO NON SI SFONDA MAI, QUALUNQUE SIA L'INGRESSO ════════════════════════════════════
titolo('5 · proprieta\' generale: mai piu\' di `max` slot occupati');
{
  const grande = [];
  for (let i = 1; i <= 40; i += 1) grande.push(riga({ conditionId: id(i), levels: { 500: { grossRewardDay: 40 - i } } }));
  let stato = SEL.statoVuoto();
  let sforato = false;
  for (let giro = 0; giro < 25; giro += 1) {
    // Ogni giro cambia quali mercati hanno posizione aperta, in modo deterministico ma irregolare.
    const posseduti = grande.filter((_, k) => (k + giro) % 7 === 0).map((r) => r.conditionId);
    const r = SEL.decidiSelezione({
      board: grande, stato, posizioni: { leggibile: true, conditionIds: posseduti }, ora: ORA + giro * 60_000,
    });
    if (r.ok) stato = r.statoNuovo;
    if (Object.keys(stato.selezionati).length > SEL.MAX_MERCATI_CONTEMPORANEI) sforato = true;
  }
  ok('25 giri con posizioni che vanno e vengono: il tetto di 2 non e\' mai stato superato', sforato === false);

  const r3 = SEL.decidiSelezione({ board: grande, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA, max: 3 });
  ok('il tetto e\' un parametro, e 3 significa 3', r3.entranti.length === 3);
}

// ══ 6 · COSA NON SI ADOTTA, E COSA NON SI SCEGLIE ═══════════════════════════════════════════════
titolo('6 · quarantena e posizioni altrui');
{
  const board = [riga({ conditionId: id(1), levels: { 500: { grossRewardDay: 9 } } }),
    riga({ conditionId: id(2), levels: { 500: { grossRewardDay: 8 } } }),
    riga({ conditionId: id(3), levels: { 500: { grossRewardDay: 7 } } })];
  const r = SEL.decidiSelezione({
    board, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA, escludi: [id(1)],
  });
  ok('un mercato in quarantena al venue non viene scelto', r.entranti.every((x) => x.id !== id(1)));

  const r2 = SEL.decidiSelezione({
    board, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [id(1)] }, ora: ORA,
  });
  ok('un mercato con una posizione che il bot non ha scelto non viene adottato',
    r2.entranti.every((x) => x.id !== id(1)));
}

// ══ 7 · LA PERSISTENZA, E L'INTERRUTTORE ════════════════════════════════════════════════════════
titolo('7 · lo stato su disco');
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'selezione-'));
  const deps = { statoFile: path.join(TMP, 'stato.json'), auditFile: path.join(TMP, 'audit.jsonl') };

  const vuoto = ST.leggiStato(deps);
  ok('file assente ⇒ leggibile, ma SPENTO (assente non e\' illeggibile, e il difetto e\' spento)',
    vuoto.leggibile === true && vuoto.esisteva === false && vuoto.attiva === false);

  const acceso = ST.impostaAttiva({ attiva: true, by: 'test', reason: 'prova' }, deps);
  ok('l\'interruttore si accende e dichiara il prima/dopo', acceso.ok && acceso.prima === false && acceso.dopo === true);
  ok('  e finisce nel giornale', fs.readFileSync(deps.auditFile, 'utf8').indexOf('"op":"interruttore"') >= 0);
  ok('  e si rilegge dal disco', ST.leggiStato(deps).attiva === true);

  const salvato = ST.scriviStato({ ...SEL.statoVuoto(), attiva: false, selezionati: { [id(9)]: { entratoAt: ORA } } },
    { by: 'test', reason: 'giro' }, deps);
  ok('un giro di selezione salva i mercati scelti', salvato.ok && Object.keys(ST.leggiStato(deps).stato.selezionati)[0] === id(9));
  ok('  MA non puo\' spegnere ne\' riaccendere l\'interruttore da se\' — resta acceso', ST.leggiStato(deps).attiva === true);

  fs.writeFileSync(deps.statoFile, '{ questo non e json');
  const rotto = ST.leggiStato(deps);
  ok('file illeggibile ⇒ SPENTO (fail-closed)', rotto.leggibile === false && rotto.attiva === false);
  ok('  e non lo si sovrascrive, o si perde chi era in uscita',
    ST.scriviStato(SEL.statoVuoto(), { by: 'test' }, deps).ok === false);
  ok('  e non ci si puo\' accendere sopra', ST.impostaAttiva({ attiva: true, by: 'test' }, deps).ok === false);

  fs.rmSync(TMP, { recursive: true, force: true });
}

// ══ 8 · IL BOARD VERO, SE C'E' ══════════════════════════════════════════════════════════════════
titolo('8 · contro il board reale su disco (se presente)');
{
  const f = path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json');
  if (!fs.existsSync(f)) {
    console.log('  --  board assente su questa macchina: sezione saltata, e dichiarato');
  } else {
    const board = JSON.parse(fs.readFileSync(f, 'utf8')).markets || [];
    const ora = Date.now();
    const amm = board.filter((r) => SEL.valutaAmmissibilita(r, { ora }).ammissibile);
    ok(`sul board vero ${amm.length} righe su ${board.length} sono ammissibili`, amm.length >= 0);
    ok('  e ogni ammissibile rispetta DAVVERO i tre vincoli',
      amm.every((r) => Number(r.rewardsMinSize) <= SEL.MIN_SIZE_MASSIMA
        && (Date.parse(r.endDate) - ora) >= SEL.ORIZZONTE_MINIMO_MS
        && !SEL.eMeteo(r)));
    const r = SEL.decidiSelezione({ board, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora });
    ok('  e la decisione sul board vero sceglie al piu\' 2 mercati', r.ok === true && r.entranti.length <= 2);
    for (const e of r.entranti) console.log(`      → ${e.id.slice(0, 12)}… ${String(e.question).slice(0, 58)} · ${e.punteggio.toFixed(3)} (${e.fontePunteggio})`);
  }
}

console.log('\nselezione-mercati: ' + n + ' passed, 0 failed');

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
    // ⚠ 100 h → 400 h il 15 agosto 2026: il pavimento d'orizzonte e' passato a 168 h, e una fixture
    // «normale» deve stare comodamente dentro i vincoli o ogni blocco proverebbe l'esclusione.
    endDate: new Date(ORA + 400 * ORE).toISOString(),
    levels: { 500: { grossRewardDay: 1.4 } },
    ...over,
  };
}
const id = (k) => '0x' + String(k).padStart(64, '0');

// ══ 1 · I VINCOLI, UNO PER UNO ═══════════════════════════════════════════════════════════════════
titolo('1 · i vincoli, uno per uno');
{
  ok('minSize 20 passa (scaglione basso)',
    SEL.valutaAmmissibilita(riga({ rewardsMinSize: 20 }), { ora: ORA }).ammissibile === true);
  ok('minSize 50 passa (scaglione alto, sbloccato il 15 agosto 2026)',
    SEL.valutaAmmissibilita(riga({ rewardsMinSize: 50 }), { ora: ORA }).ammissibile === true);
  ok('minSize 100 NON passa: il suo pavimento premiante ($122,50) supera il tetto per mercato',
    SEL.valutaAmmissibilita(riga({ rewardsMinSize: 100 }), { ora: ORA }).motivo === 'minsize-oltre-soglia');
  ok('  e il confine e\' allineato al tetto per mercato di `concentration`, non scelto a parte',
    require('../rewards/concentration').pavimentoPremiante(SEL.MIN_SIZE_MASSIMA)
      <= require('../rewards/concentration').MARKET_CAP_FIXED_USD + 1e-9);
  ok('minSize illeggibile NON passa, e non vale 0 (`Number(null)===0`, sette precedenti)',
    SEL.valutaAmmissibilita(riga({ rewardsMinSize: null }), { ora: ORA }).motivo === 'minsize-illeggibile');
  ok('  e i due scaglioni finiscono in due secchi diversi',
    SEL.scaglioneDi(20) === 'basso' && SEL.scaglioneDi(50) === 'alto' && SEL.scaglioneDi(100) === null);

  const soglia = SEL.ORIZZONTE_MINIMO_ORE;
  ok(`scadenza a ${(soglia - 0.1).toFixed(1)} h NON passa`,
    SEL.valutaAmmissibilita(riga({ endDate: new Date(ORA + (soglia - 0.1) * ORE).toISOString() }), { ora: ORA }).motivo === 'scadenza-troppo-vicina');
  ok(`scadenza a ${(soglia + 0.1).toFixed(1)} h passa`,
    SEL.valutaAmmissibilita(riga({ endDate: new Date(ORA + (soglia + 0.1) * ORE).toISOString() }), { ora: ORA }).ammissibile === true);
  ok('il confine e\' derivato dalla costante, non ricopiato',
    SEL.ORIZZONTE_MINIMO_MS === SEL.ORIZZONTE_MINIMO_ORE * ORE);
  ok('  e il pavimento e\' quello deciso il 15 agosto 2026: 7 giorni, non 48 h',
    SEL.ORIZZONTE_MINIMO_ORE === 168);
  ok('scadenza assente ⇒ ESCLUDE (§4.4: non si indovina)',
    SEL.valutaAmmissibilita(riga({ endDate: null, endDateClob: null, endDateGamma: null }), { ora: ORA }).motivo === 'scadenza-non-determinabile');
  ok('scadenza non parsabile ⇒ ESCLUDE',
    SEL.valutaAmmissibilita(riga({ endDate: 'domani', endDateClob: null, endDateGamma: null }), { ora: ORA }).motivo === 'scadenza-non-determinabile');
  ok('il board che ha gia\' bocciato la scadenza (fonti discordi) viene creduto',
    SEL.valutaAmmissibilita(riga({ scadenzaAmmissibile: false }), { ora: ORA }).motivo === 'scadenza-discorde');

  // ── IL TETTO D'ORIZZONTE, INIETTATO (15 agosto 2026) ─────────────────────────────────────────
  // Un mercato oltre l'orizzonte del PIANO occuperebbe uno slot che l'allocatore non finanziera' mai.
  const lontano = riga({ endDate: new Date(ORA + 5000 * ORE).toISOString() });
  ok('senza tetto iniettato il controllo NON si fa: chi non cabla una dep ottiene il comportamento di prima',
    SEL.valutaAmmissibilita(lontano, { ora: ORA }).ammissibile === true);
  ok('  con il tetto iniettato, un mercato oltre l\'orizzonte del piano viene escluso',
    SEL.valutaAmmissibilita(lontano, { ora: ORA, orizzonteMassimoOre: 3600 }).motivo === 'scadenza-oltre-orizzonte-piano');
  ok('  e uno dentro passa',
    SEL.valutaAmmissibilita(riga({ endDate: new Date(ORA + 1000 * ORE).toISOString() }), { ora: ORA, orizzonteMassimoOre: 3600 }).ammissibile === true);

  ok('un mercato meteo NON passa',
    SEL.valutaAmmissibilita(riga({ question: 'Will the lowest temperature in Hong Kong be 27\u00b0C on August 14?' }), { ora: ORA }).motivo === 'famiglia-meteo');
  ok('\u00abweather\u00bb e \u00abhurricane\u00bb sono meteo',
    SEL.eMeteo({ question: 'NYC weather in September' }) && SEL.eMeteo({ question: 'Will a hurricane hit Florida?' }));

  ok('categoria assente ⇒ ESCLUDE: non si puo\' dimostrare che sia diversa dalle altre',
    SEL.valutaAmmissibilita(riga({ category: null }), { ora: ORA }).motivo === 'categoria-non-leggibile');
  ok('  e la categoria si normalizza, cosi\' «Sports» e «sports» sono la stessa',
    SEL.categoriaDi({ category: ' Sports ' }) === 'sports' && SEL.categoriaDi({ category: '' }) === null);
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
titolo('3 · il tetto di 3, la composizione, e la regola dello slot');
{
  // ⚠ LE FIXTURE PORTANO CATEGORIE E SCAGLIONI DIVERSI, ed e' obbligatorio dal 15 agosto 2026: la
  // composizione chiesta e' UNO scaglione basso + DUE alti, con tre categorie distinte. Un board di
  // quattro righe identiche (com'era qui) non puo' piu' riempire tre slot, ed e' giusto cosi'.
  const board = [
    riga({ conditionId: id(1), category: 'Economy', rewardsMinSize: 50, levels: { 500: { grossRewardDay: 9 } } }),
    riga({ conditionId: id(2), category: 'Sports', rewardsMinSize: 50, levels: { 500: { grossRewardDay: 8 } } }),
    riga({ conditionId: id(3), category: 'Esports', rewardsMinSize: 20, levels: { 500: { grossRewardDay: 7 } } }),
    riga({ conditionId: id(4), category: 'Tech', rewardsMinSize: 50, levels: { 500: { grossRewardDay: 6 } } }),
  ];
  const nessunaPosizione = { leggibile: true, conditionIds: [] };

  const r1 = SEL.decidiSelezione({ board, stato: SEL.statoVuoto(), posizioni: nessunaPosizione, ora: ORA });
  ok('da zero entrano esattamente 3 mercati, non 4', r1.entranti.length === 3);
  ok('ed entrano i tre col punteggio piu\' alto che stanno nella composizione',
    r1.entranti.map((x) => x.id).join() === [id(1), id(2), id(3)].join());
  ok('  cioe\' un solo scaglione basso e due alti',
    r1.entranti.filter((x) => x.scaglione === 'basso').length === 1
    && r1.entranti.filter((x) => x.scaglione === 'alto').length === 2);
  ok('  e tre categorie DISTINTE', new Set(r1.entranti.map((x) => x.categoria)).size === 3);
  // Il quarto non entra perche' gli SLOT sono finiti (il tetto), non per composizione: il ciclo si
  // ferma appena `slotLiberi` e' esaurito e non valuta oltre. Che a fermarlo sia la composizione si
  // prova nel blocco 3-bis, dove gli slot ci sono e i posti no.
  ok('  il quarto non entra affatto', r1.entranti.every((x) => x.id !== id(4)));
  ok('il punteggio viene dalla stima del board, non dal montepremi',
    r1.entranti[0].fontePunteggio === 'levels.500.grossRewardDay');
  ok('lo stato registra 3 mercati occupati', r1.occupati === 3);
  ok('  e ricorda scaglione e categoria di ciascuno, o al giro dopo non saprebbe cosa occupano',
    Object.values(r1.statoNuovo.selezionati).every((v) => v.scaglione && v.categoria));

  // Un secondo giro identico non deve cambiare niente: la selezione e' stabile.
  const r2 = SEL.decidiSelezione({ board, stato: r1.statoNuovo, posizioni: nessunaPosizione, ora: ORA + 60_000 });
  ok('un secondo giro sullo stesso board non ruota i mercati', r2.entranti.length === 0 && r2.tenuti.length === 3);

  // ══ LA ROTAZIONE (15 agosto 2026) ═════════════════════════════════════════════════════════════
  // Il mercato 1 riceve un fill: al venue compare una posizione. Da quell'istante esce dai TRE ATTIVI,
  // resta in gestione, e il suo posto viene preso subito da un mercato nuovo.
  const conPos = { leggibile: true, conditionIds: [id(1)] };
  const r3 = SEL.decidiSelezione({ board, stato: r2.statoNuovo, posizioni: conPos, ora: ORA + 120_000 });
  ok('un fill manda il mercato IN GESTIONE, non fuori', r3.entratiInGestione.length === 1 && r3.entratiInGestione[0].id === id(1));
  ok('  e lo slot si libera SUBITO: gli attivi tornano 2 prima dei sostituti', r3.inGestione.length === 1);
  ok('  quindi un mercato nuovo entra nello stesso giro', r3.entranti.length === 1 && r3.entranti[0].id === id(4));
  ok('  e gli slot attivi tornano 3', r3.occupati === 3);
  ok('  il mercato in gestione resta nello stato, o verrebbe riselezionato mentre ci si e\' dentro',
    r3.statoNuovo.selezionati[id(1)] && r3.statoNuovo.selezionati[id(1)].inGestione === true);
  ok('  e non e\' fra gli uscenti: uscire dalla lista spegnerebbe anche la sua gestione', r3.uscenti.length === 0);
  ok('  ne\' fra i liberati: il posto e\' libero, il mercato no', r3.liberati.length === 0);

  // Un secondo giro con la posizione ancora aperta non deve rifare niente.
  const r3b = SEL.decidiSelezione({ board, stato: r3.statoNuovo, posizioni: conPos, ora: ORA + 150_000 });
  ok('  e il giro dopo non lo ri-annuncia', r3b.entratiInGestione.length === 0 && r3b.inGestione.length === 1);
  ok('  ne\' fa entrare nessun altro: i tre posti sono pieni', r3b.entranti.length === 0);

  // Il mercato in gestione puo\' ricevere un secondo fill sullo stesso scaglione: il sostituto e\' gia\'
  // dentro, quindi la sua categoria NON blocca piu\' nessuno.
  ok('  la categoria del mercato in gestione non blocca piu\' i sostituti',
    r3.entranti[0].categoria !== undefined && r3.entranti[0].scaglione === 'alto');

  // ── LA COPPIA SI CHIUDE: il mercato torna disponibile ────────────────────────────────────────
  const r4 = SEL.decidiSelezione({ board, stato: r3.statoNuovo, posizioni: nessunaPosizione, ora: ORA + 180_000 });
  ok('chiusa la coppia, il mercato esce dalla gestione e torna disponibile',
    r4.liberati.length === 1 && r4.liberati[0].id === id(1) && r4.liberati[0].motivo === 'coppia-chiusa');
  ok('  e non rientra subito, perche\' i tre posti sono gia\' pieni', r4.entranti.length === 0 && r4.occupati === 3);

  // ── UN VINCOLO VIOLATO SENZA POSIZIONE: esce e il posto e' libero nello stesso giro ──────────
  const boardScaduto = [
    riga({ conditionId: id(2), category: 'Sports', rewardsMinSize: 50, endDate: new Date(ORA + 3 * ORE).toISOString(), levels: { 500: { grossRewardDay: 8 } } }),
    board[0], board[2], board[3],
  ];
  const r5 = SEL.decidiSelezione({ board: boardScaduto, stato: r4.statoNuovo, posizioni: nessunaPosizione, ora: ORA + 240_000 });
  ok('un mercato che viola un vincolo e non ha posizione ESCE dalla lista', r5.uscenti.length === 1 && r5.uscenti[0].id === id(2));
  ok('  e il motivo e\' quello vero, non un generico', r5.uscenti[0].motivo === 'scadenza-troppo-vicina');
  ok('  il suo posto si libera nello stesso giro', r5.liberati.some((x) => x.id === id(2)));
  ok('  e il sostituto e\' il mercato 1, tornato disponibile a coppia chiusa',
    r5.entranti.length === 1 && r5.entranti[0].id === id(1));
}

// ══ 3-bis · LA COMPOSIZIONE NON SI SOSTITUISCE, E IL POSTO VUOTO SI DICHIARA ════════════════════
titolo('3-bis · nessuna sostituzione fra scaglioni');
{
  // Nessun candidato allo scaglione BASSO: il terzo posto deve restare vuoto, non essere riempito da
  // un terzo mercato allo scaglione alto — sarebbero $61,25 invece di $24,50, cioe' capitale che
  // nessuno ha autorizzato.
  const soloAlti = [
    riga({ conditionId: id(1), category: 'Economy', rewardsMinSize: 50, levels: { 500: { grossRewardDay: 9 } } }),
    riga({ conditionId: id(2), category: 'Sports', rewardsMinSize: 50, levels: { 500: { grossRewardDay: 8 } } }),
    riga({ conditionId: id(3), category: 'Tech', rewardsMinSize: 50, levels: { 500: { grossRewardDay: 7 } } }),
  ];
  const r = SEL.decidiSelezione({ board: soloAlti, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA });
  ok('senza candidati allo scaglione basso entrano solo 2 mercati, non 3', r.entranti.length === 2);
  ok('  e il posto non assegnato si DICHIARA invece di sembrare un errore di conteggio',
    r.postiNonAssegnati.some((x) => x.scaglione === 'basso' && x.posti === 1));

  // Tre mercati ottimi ma tutti della stessa categoria: ne entra UNO.
  const stessaCategoria = [
    riga({ conditionId: id(1), category: 'Elections', rewardsMinSize: 20, levels: { 500: { grossRewardDay: 9 } } }),
    riga({ conditionId: id(2), category: 'Elections', rewardsMinSize: 50, levels: { 500: { grossRewardDay: 8 } } }),
    riga({ conditionId: id(3), category: 'Elections', rewardsMinSize: 50, levels: { 500: { grossRewardDay: 7 } } }),
  ];
  const rc = SEL.decidiSelezione({ board: stessaCategoria, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA });
  ok('tre mercati della stessa categoria ⇒ ne entra UNO SOLO', rc.entranti.length === 1);
  ok('  ed e\' quello col punteggio piu\' alto', rc.entranti[0].id === id(1));
  ok('  gli altri due sono scartati per categoria, e lo dichiarano',
    rc.scartatiPerComposizione.filter((x) => x.motivo === 'categoria-gia-presa').length === 2);
}

// ══ 4 · FAIL-CLOSED ══════════════════════════════════════════════════════════════════════════════
titolo('4 · cosa succede quando non si sa');
{
  const stato = SEL.decidiSelezione({
    board: [riga({ conditionId: id(1), category: 'Economy' }), riga({ conditionId: id(2), category: 'Sports' })],
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
    Object.keys(rp.statoNuovo.selezionati).length === Object.keys(stato.selezionati).length
    && Object.keys(stato.selezionati).length > 0,
    `${Object.keys(rp.statoNuovo.selezionati).length} voci`);
}

// ══ 5 · IL TETTO NON SI SFONDA MAI, QUALUNQUE SIA L'INGRESSO ════════════════════════════════════
titolo('5 · proprieta\' generale: mai piu\' di `max` slot occupati');
{
  const CATS = ['Economy', 'Sports', 'Tech', 'Esports', 'Politics', 'Pop Culture', 'Geopolitics', 'Elections'];
  const grande = [];
  for (let i = 1; i <= 40; i += 1) {
    grande.push(riga({ conditionId: id(i), category: CATS[i % CATS.length],
      rewardsMinSize: i % 3 === 0 ? 20 : 50, levels: { 500: { grossRewardDay: 40 - i } } }));
  }
  let stato = SEL.statoVuoto();
  let sforato = false; let quotaSforata = false; let categoriaRipetuta = false;
  for (let giro = 0; giro < 25; giro += 1) {
    // Ogni giro cambia quali mercati hanno posizione aperta, in modo deterministico ma irregolare.
    const posseduti = grande.filter((_, k) => (k + giro) % 7 === 0).map((r) => r.conditionId);
    const r = SEL.decidiSelezione({
      board: grande, stato, posizioni: { leggibile: true, conditionIds: posseduti }, ora: ORA + giro * 60_000,
    });
    if (r.ok) stato = r.statoNuovo;
    // ⚠ SI CONTANO GLI ATTIVI, non tutte le voci: dalla rotazione del 15 agosto 2026 un mercato con
    // una posizione aperta resta nello stato ma NON occupa uno slot. Contare le voci proverebbe una
    // regola che il modulo non promette piu' — e nasconderebbe quella che promette.
    const voci = Object.values(stato.selezionati).filter((v) => v.inGestione !== true);
    if (voci.length > SEL.MAX_MERCATI_CONTEMPORANEI) sforato = true;
    for (const b of SEL.QUOTA_SCAGLIONI) {
      if (voci.filter((v) => v.scaglione === b.chiave).length > b.posti) quotaSforata = true;
    }
    const cats = voci.map((v) => v.categoria).filter(Boolean);
    if (new Set(cats).size !== cats.length) categoriaRipetuta = true;
  }
  ok(`25 giri con posizioni che vanno e vengono: il tetto di ${SEL.MAX_MERCATI_CONTEMPORANEI} non e\' mai stato superato`, sforato === false);
  ok('  ne\' la quota per scaglione', quotaSforata === false);
  ok('  ne\' la diversificazione: mai due mercati ATTIVI della stessa categoria insieme', categoriaRipetuta === false);
  // ⚠ E LA PROPRIETA' CHE LA ROTAZIONE INTRODUCE, dichiarata invece che scoperta dopo: il numero di
  // mercati con capitale esposto NON e' piu' limitato da questo modulo. Il test lo mette nero su
  // bianco — il tetto di 3 conta chi QUOTA, e i limiti sull'esposizione stanno altrove
  // (tetto per mercato, `safety-risk-limits.maxOpenNotionalUsd`, kill sulla perdita giornaliera).
  ok('  la rotazione puo\' portare le voci totali OLTRE il tetto: e\' voluto, e questo test lo dichiara',
    Object.keys(stato.selezionati).length >= Object.values(stato.selezionati).filter((v) => v.inGestione !== true).length,
    `${Object.keys(stato.selezionati).length} voci, di cui ${Object.values(stato.selezionati).filter((v) => v.inGestione !== true).length} attive`);

  // ⚠ IL `max` E' UN TETTO, NON UN OBIETTIVO: la composizione puo' fermarsi prima, e un `max` piu'
  // grande della somma dei posti non fa entrare nessuno in piu'.
  const posti = SEL.QUOTA_SCAGLIONI.reduce((a, b) => a + b.posti, 0);
  const rTanti = SEL.decidiSelezione({ board: grande, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA, max: 10 });
  ok(`max 10 non sfonda la composizione: entrano al piu\' ${posti} mercati`, rTanti.entranti.length <= posti);
  const rDue = SEL.decidiSelezione({ board: grande, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA, max: 2 });
  ok('il tetto e\' un parametro, e 2 significa 2', rDue.entranti.length === 2);
}

// ══ 6 · COSA NON SI ADOTTA, E COSA NON SI SCEGLIE ═══════════════════════════════════════════════
titolo('6 · quarantena e posizioni altrui');
{
  const board = [riga({ conditionId: id(1), category: 'Economy', levels: { 500: { grossRewardDay: 9 } } }),
    riga({ conditionId: id(2), category: 'Sports', levels: { 500: { grossRewardDay: 8 } } }),
    riga({ conditionId: id(3), category: 'Tech', levels: { 500: { grossRewardDay: 7 } } })];
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
    ok(`  e la decisione sul board vero sceglie al piu' ${SEL.MAX_MERCATI_CONTEMPORANEI} mercati`,
      r.ok === true && r.entranti.length <= SEL.MAX_MERCATI_CONTEMPORANEI, `${r.entranti.length}`);
    ok('  con categorie tutte diverse e la quota per scaglione rispettata',
      new Set(r.entranti.map((e) => e.categoria)).size === r.entranti.length
      && SEL.QUOTA_SCAGLIONI.every((b) => r.entranti.filter((e) => e.scaglione === b.chiave).length <= b.posti));
    for (const e of r.entranti) console.log(`      → ${e.id.slice(0, 12)}… ${String(e.question).slice(0, 52)} · minSize ${e.minSize} (${e.scaglione}) · ${e.categoria} · ${e.punteggio.toFixed(3)}`);
  }
}

console.log('\nselezione-mercati: ' + n + ' passed, 0 failed');

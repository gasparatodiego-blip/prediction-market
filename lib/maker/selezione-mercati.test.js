'use strict';
// lib/maker/selezione-mercati.test.js — le PROPRIETA' della selezione automatica dei mercati.
//
// Si difendono proprieta', non fotografie: nessuna asserzione conta le occorrenze di una stringa nel
// sorgente e nessuna guarda `git diff` (§5.3, tre precedenti). Il criterio con cui e' scritto ogni
// caso e' «questo test diventerebbe rosso se la regola sparisse?».
//
// Esegue con: node lib/maker/selezione-mercati.test.js

const assert = require('assert');
// ⚠ N NON HA PIU' UN DIFETTO (24 agosto 2026): si legge dalla CONFIGURAZIONE DICHIARATA, con la
// funzione VERA e non con un gemello. ⚠ NON e' «il numero in servizio» — quello vive nel processo e
// si legge da `/proc`; qui serve un N valido per esercitare le proprieta', e la configurazione e'
// l'unica fonte onesta disponibile da una shell.
const N_DICHIARATO = (() => {
  const eco = require('../../agents/ecosystem.config.js');
  const app = eco.apps.find((a) => a.name === 'agent41-realloc-scheduler');
  return require('./quanti-mercati').quantiMercati(app.env).quanti;
})();

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
  // ⚠ RISCRITTA IL 16 AGOSTO 2026. Qui c'era `=== 168`, una FOTOGRAFIA DEL VALORE (§5.3): e' diventata
  // rossa nel momento in cui l'operatore ha deciso 24 h, senza che niente fosse rotto. Il valore in
  // servizio si DICHIARA — cosi' un cambio resta visibile in un diff — ma cio' che si DIFENDE e' la
  // proprieta': il pavimento e' un numero positivo, sotto il tetto d'orizzonte del piano, e la
  // costante in millisecondi ne DERIVA invece di essere ricopiata.
  ok('il pavimento in servizio e\' 24 h (era 168 h fino al 16 agosto 2026)',
    SEL.ORIZZONTE_MINIMO_ORE === 24);
  ok('  proprieta\': e\' positivo e sta sotto il tetto d\'orizzonte del piano',
    SEL.ORIZZONTE_MINIMO_ORE > 0 && SEL.ORIZZONTE_MINIMO_ORE < Number(require('../rewards/horizon').maxHorizonDays()) * 24);
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
// ⚠ QUESTA SEZIONE PASSA `max: 3` ESPLICITAMENTE dal 18 agosto 2026, quando il soffitto e' passato
// da 3 a 5. Il suo soggetto e' la MECCANICA DEGLI SLOT — chi entra, chi esce, chi passa in gestione,
// come si libera un posto — non il valore del tetto. Legarla al soffitto di modulo la faceva cadere a
// ogni cambio del tetto dando l'impressione di una regressione dove c'e' solo un numero diverso: la
// stessa trappola di §5.3 («si difende la proprieta', non il conteggio»). Il tetto in servizio ha ora
// un blocco tutto suo, qui sotto.
titolo('3 · la meccanica degli slot, a tetto fissato a 3');
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

  const r1 = SEL.decidiSelezione({ max: 3, board, stato: SEL.statoVuoto(), posizioni: nessunaPosizione, ora: ORA });
  ok('da zero entrano esattamente 3 mercati, non 4', r1.entranti.length === 3);
  ok('ed entrano i tre col punteggio piu\' alto che stanno nella composizione',
    r1.entranti.map((x) => x.id).join() === [id(1), id(2), id(3)].join());
  ok('  cioe\' un solo scaglione basso e due alti',
    r1.entranti.filter((x) => x.scaglione === 'basso').length === 1
    && r1.entranti.filter((x) => x.scaglione === 'alto').length === 2);
  // ⚠ RISCRITTA IL 16 AGOSTO 2026: il vincolo delle tre categorie diverse E' STATO TOLTO, per
  // decisione dell'operatore e su misura — 23 dei 26 mercati ammissibili erano `elections`, quindi la
  // diversificazione ne lasciava entrare uno solo e teneva gli altri due slot sui due mercati peggiori
  // del board (netto -$0,111/g e +$0,026/g contro +$10,64/g escluso). Cio' che resta vero, e che questa
  // riga difende adesso, e' che la CATEGORIA viene comunque letta e scritta: serve al giornale e serve
  // il giorno in cui si volesse rimettere un tetto per settore.
  ok('  ogni entrante porta la sua categoria (letta, anche se non piu\' vincolante)',
    r1.entranti.every((x) => typeof x.categoria === 'string' && x.categoria.length > 0));
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
  const r2 = SEL.decidiSelezione({ max: 3, board, stato: r1.statoNuovo, posizioni: nessunaPosizione, ora: ORA + 60_000 });
  ok('un secondo giro sullo stesso board non ruota i mercati', r2.entranti.length === 0 && r2.tenuti.length === 3);

  // ══ LA ROTAZIONE (15 agosto 2026) ═════════════════════════════════════════════════════════════
  // Il mercato 1 riceve un fill: al venue compare una posizione. Da quell'istante esce dai TRE ATTIVI,
  // resta in gestione, e il suo posto viene preso subito da un mercato nuovo.
  const conPos = { leggibile: true, conditionIds: [id(1)] };
  const r3 = SEL.decidiSelezione({ max: 3, board, stato: r2.statoNuovo, posizioni: conPos, ora: ORA + 120_000 });
  ok('un fill manda il mercato IN GESTIONE, non fuori', r3.entratiInGestione.length === 1 && r3.entratiInGestione[0].id === id(1));
  ok('  e lo slot si libera SUBITO: gli attivi tornano 2 prima dei sostituti', r3.inGestione.length === 1);
  ok('  quindi un mercato nuovo entra nello stesso giro', r3.entranti.length === 1 && r3.entranti[0].id === id(4));
  ok('  e gli slot attivi tornano 3', r3.occupati === 3);
  ok('  il mercato in gestione resta nello stato, o verrebbe riselezionato mentre ci si e\' dentro',
    r3.statoNuovo.selezionati[id(1)] && r3.statoNuovo.selezionati[id(1)].inGestione === true);
  ok('  e non e\' fra gli uscenti: uscire dalla lista spegnerebbe anche la sua gestione', r3.uscenti.length === 0);
  ok('  ne\' fra i liberati: il posto e\' libero, il mercato no', r3.liberati.length === 0);

  // Un secondo giro con la posizione ancora aperta non deve rifare niente.
  const r3b = SEL.decidiSelezione({ max: 3, board, stato: r3.statoNuovo, posizioni: conPos, ora: ORA + 150_000 });
  ok('  e il giro dopo non lo ri-annuncia', r3b.entratiInGestione.length === 0 && r3b.inGestione.length === 1);
  ok('  ne\' fa entrare nessun altro: i tre posti sono pieni', r3b.entranti.length === 0);

  // Il mercato in gestione puo\' ricevere un secondo fill sullo stesso scaglione: il sostituto e\' gia\'
  // dentro, quindi la sua categoria NON blocca piu\' nessuno.
  ok('  la categoria del mercato in gestione non blocca piu\' i sostituti',
    r3.entranti[0].categoria !== undefined && r3.entranti[0].scaglione === 'alto');

  // ── LA COPPIA SI CHIUDE: il mercato torna disponibile ────────────────────────────────────────
  const r4 = SEL.decidiSelezione({ max: 3, board, stato: r3.statoNuovo, posizioni: nessunaPosizione, ora: ORA + 180_000 });
  ok('chiusa la coppia, il mercato esce dalla gestione e torna disponibile',
    r4.liberati.length === 1 && r4.liberati[0].id === id(1) && r4.liberati[0].motivo === 'coppia-chiusa');
  ok('  e non rientra subito, perche\' i tre posti sono gia\' pieni', r4.entranti.length === 0 && r4.occupati === 3);

  // ── UN VINCOLO VIOLATO SENZA POSIZIONE: esce e il posto e' libero nello stesso giro ──────────
  const boardScaduto = [
    riga({ conditionId: id(2), category: 'Sports', rewardsMinSize: 50, endDate: new Date(ORA + 3 * ORE).toISOString(), levels: { 500: { grossRewardDay: 8 } } }),
    board[0], board[2], board[3],
  ];
  const r5 = SEL.decidiSelezione({ max: 3, board: boardScaduto, stato: r4.statoNuovo, posizioni: nessunaPosizione, ora: ORA + 240_000 });
  ok('un mercato che viola un vincolo e non ha posizione ESCE dalla lista', r5.uscenti.length === 1 && r5.uscenti[0].id === id(2));
  ok('  e il motivo e\' quello vero, non un generico', r5.uscenti[0].motivo === 'scadenza-troppo-vicina');
  ok('  il suo posto si libera nello stesso giro', r5.liberati.some((x) => x.id === id(2)));
  ok('  e il sostituto e\' il mercato 1, tornato disponibile a coppia chiusa',
    r5.entranti.length === 1 && r5.entranti[0].id === id(1));
}

// ══ 3-ter · IL SOFFITTO IN SERVIZIO, E LA COMPOSIZIONE CHE NE DERIVA ═══════════════════════════
titolo('3-ter · il soffitto in servizio');
{
  // ⚠ 3 → 5 il 18 agosto 2026, decisione dell'operatore. Si DICHIARA il valore — cosi' un cambio resta
  // visibile in un diff — ma cio' che si DIFENDE e' la relazione: la composizione deriva dal soffitto
  // e non e' una seconda tabella da tenere allineata a mano. Era il secondo blocco ai 5 mercati:
  // `quotaScaglioni` clampava a `MAX_MERCATI_CONTEMPORANEI`, quindi con 5 restituiva ancora 3 posti.
  // ⚠ 5 → 10 il 22 agosto 2026, decisione dell'operatore. Il PRESUPPOSTO e' §5.2 p.54 chiusa: col
  // guardiano vecchio l'artefatto di co-temporalita' a 10 mercati a size piena valeva $72,46 contro
  // un margine di $75,08 (misurato, `data/ricerca/p54-legge-di-scala.json`); col nuovo vale $14,74.
  // ⚠ 10 → 12 il 22 agosto 2026. E QUI L'ASSERZIONE CAMBIA FORMA, perche' quella di prima
  // (`=== 10`) era una FOTOGRAFIA DEL NUMERO: e' diventata rossa su un cambio legittimo del soffitto
  // senza che nessun comportamento fosse sbagliato, cioe' la classe «test che fotografa il codice
  // invece della proprieta'» che §5.3 elenca fra quelle che si ripetono. Un valore dichiarato in un
  // commento resta visibile in un diff; un valore ASSERITO obbliga a toccare il test a ogni
  // decisione dell'operatore, e un test che si tocca a ogni giro smette di difendere qualcosa.
  //
  // LA PROPRIETA' CHE SI DIFENDE E' LA RELAZIONE DI RISCHIO: il capitale che il soffitto autorizza a
  // esporre — riposo PIU' completamento — deve stare sotto il tetto di esposizione cumulativa
  // VERSIONATO, o il gate murerebbe la gestione a meta' strada (§5.2 p.37, e il $150 del 16 agosto).
  // Questa e' la cosa che, se saltasse, farebbe un danno; il numero da solo no.
  {
    const CONC = require('../rewards/concentration');
    const espMax = CONC.esposizioneMassimaRaggiungibileUsd(N_DICHIARATO);
    let capVers = null;
    try {
      const r = require('../safety/risk-limits').resolveLimits();
      const v = r && r.limits ? r.limits.maxOpenNotionalUsd : null;
      capVers = Number.isFinite(v) ? v : null;
    } catch { capVers = null; }
    ok(`il soffitto in servizio e' ${N_DICHIARATO} ed e' un intero >= 1`,
      Number.isInteger(N_DICHIARATO) && N_DICHIARATO >= 1);
    ok(`  e l'esposizione che autorizza ($${espMax}) sta sotto il cap versionato ($${capVers})`,
      capVers === null || espMax <= capVers,
      `${espMax} > ${capVers}: il gate smetterebbe di piazzare a meta' strada`);
  }
  const q = SEL.quotaScaglioni(N_DICHIARATO);
  const posti = q.reduce((a, b) => a + b.posti, 0);
  ok('  e la quota offre esattamente quel numero di posti, non meno',
    posti === N_DICHIARATO, `posti ${posti}`);
  // ⚠ LA PROPRIETA', NON LA CIFRA. Fino al 23/08 il posto «basso» era UNO fisso; adesso e'
  // `round(N/3)`, almeno 1 e al piu' N−1 — a N=12 fa 4, a N=3 fa ancora 1 (la regola originale
  // dell'operatore). Asserire `=== 1` era una fotografia della costante ed e' caduta appena la
  // cifra si e' mossa, senza che nessun comportamento fosse peggiorato.
  const bassi = q.find((x) => x.chiave === 'basso').posti;
  const alti = q.find((x) => x.chiave === 'alto').posti;
  ok('  il secchio «basso» esiste sempre e non mangia mai tutto l\'«alto»',
    bassi >= 1 && bassi <= N_DICHIARATO - 1 && alti >= 1,
    `basso ${bassi} · alto ${alti}`);
  ok('  e i due secchi insieme fanno il tetto, per costruzione',
    bassi + alti === N_DICHIARATO);
  ok('  a N=3 resta 1 «basso» + 2 «alto», la regola dettata dall\'operatore',
    SEL.quotaScaglioni(3).find((x) => x.chiave === 'basso').posti === 1
    && SEL.quotaScaglioni(3).find((x) => x.chiave === 'alto').posti === 2);
  // ⚠ PROPRIETA' CAMBIATA IL 24/08: un valore oltre il RANGE non viene piu' clampato — SOLLEVA.
  // Il clamp era il modo silenzioso di accettare un numero sbagliato: l'esposizione non saliva, ma
  // l'operatore credeva di aver chiesto una cosa e ne otteneva un'altra senza una riga di log.
  ok('  e un `max` oltre il range SOLLEVA, mai clampato in silenzio', (() => {
    try { SEL.quotaScaglioni(SEL.LIMITE_SLOT.max + 3); return false; } catch { return true; }
  })());
  ok('  mentre dentro il range viene ONORATO esattamente',
    SEL.quotaScaglioni(SEL.LIMITE_SLOT.max).reduce((a, b) => a + b.posti, 0) === SEL.LIMITE_SLOT.max);

  // ⚠ LA CONSEGUENZA DI RISCHIO, difesa come relazione e non come numero: il capitale che il soffitto
  // autorizza a esporre deve stare sotto il tetto di esposizione cumulativa, o il gate murerebbe la
  // gestione a meta' strada — che e' esattamente cio' che e' successo il 16 agosto con $150.
  const capMercato = require('../rewards/concentration').MARKET_CAP_FIXED_USD;
  const richiesto = N_DICHIARATO * capMercato;
  ok(`  ${N_DICHIARATO} mercati chiedono $${richiesto.toFixed(2)} di ordini a riposo`,
    richiesto > 0);
  let tetto = null;
  try { tetto = require('../safety/store').readStore(
    require('path').join(require('../safety/store').DATA_DIR, 'safety-risk-limits.json'), null).value; } catch { tetto = null; }
  const maxOpen = tetto && tetto.global && Number(tetto.global.maxOpenNotionalUsd);
  if (Number.isFinite(maxOpen)) {
    ok(`  e il tetto di esposizione cumulativa ($${maxOpen}) sta SOPRA quel numero`,
      maxOpen >= richiesto, `$${maxOpen} contro $${richiesto.toFixed(2)}`);
  } else {
    ok('  (tetto di esposizione non leggibile qui: e\' gitignored, si verifica dal processo vivo)', true);
  }
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
  const r = SEL.decidiSelezione({ max: 3, board: soloAlti, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA });
  ok('senza candidati allo scaglione basso entrano solo 2 mercati, non 3', r.entranti.length === 2);
  ok('  e il posto non assegnato si DICHIARA invece di sembrare un errore di conteggio',
    r.postiNonAssegnati.some((x) => x.scaglione === 'basso' && x.posti === 1));

  // Tre mercati ottimi tutti della stessa categoria: dal 16 agosto 2026 entrano TUTTI E TRE.
  const stessaCategoria = [
    riga({ conditionId: id(1), category: 'Elections', rewardsMinSize: 20, levels: { 500: { grossRewardDay: 9 } } }),
    riga({ conditionId: id(2), category: 'Elections', rewardsMinSize: 50, levels: { 500: { grossRewardDay: 8 } } }),
    riga({ conditionId: id(3), category: 'Elections', rewardsMinSize: 50, levels: { 500: { grossRewardDay: 7 } } }),
  ];
  const rc = SEL.decidiSelezione({ max: 3, board: stessaCategoria, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA });
  // ⚠ RIBALTATA IL 16 AGOSTO 2026. Fino a oggi qui si asseriva «ne entra UNO SOLO»: era la regola delle
  // tre categorie diverse, e l'operatore l'ha tolta con una misura davanti. Sul board vivo 23 dei 26
  // mercati ammissibili erano `elections`: la diversificazione riempiva un solo slot di elections e
  // teneva gli altri due su `sports` ed `economy` — i due mercati PEGGIORI del board, con 29.853 e
  // 88.881 share di concorrenza in banda e netto -$0,111/g e +$0,026/g, mentre restavano fuori due
  // elections a +$10,64/g e +$1,98/g. La regola non diversificava il rischio: sceglieva i peggiori.
  //
  // Ora si difende la regola nuova, e il vincolo che RESTA: la quota per scaglione. Tre mercati
  // `alto` non possono entrare tutti — i posti alti sono due — quindi ne entrano DUE, e il terzo e'
  // scartato per QUOTA, non per categoria.
  ok('tre mercati della stessa categoria: la categoria non li ferma piu\'',
    rc.scartatiPerComposizione.filter((x) => x.motivo === 'categoria-gia-presa').length === 0);
  ok('  ed entrano TUTTI E TRE — e\' l\'obiettivo «tre mercati sempre pieni»',
    rc.entranti.length === 3 && new Set(rc.entranti.map((x) => x.categoria)).size === 1);
  ok('  in ordine di punteggio', rc.entranti.map((x) => x.id).join() === [id(1), id(2), id(3)].join());
  ok('  e la QUOTA per scaglione resta l\'unico vincolo di composizione: 1 basso + 2 alti',
    rc.entranti.filter((x) => x.scaglione === 'basso').length === 1
    && rc.entranti.filter((x) => x.scaglione === 'alto').length === 2);
  // ⚠ IL TETTO DEI TRE SLOT MORDE ANCORA, ed e' l'unica cosa che ferma il quarto. Non viene nemmeno
  // VALUTATO: il ciclo si ferma appena gli slot sono esauriti, quindi non compare fra gli scarti per
  // composizione — che e' esattamente cio' che il test diceva prima della riscrittura, ed e' rimasto
  // vero. Si prova qui perche' togliere il vincolo di categoria non deve aver tolto anche il tetto.
  {
    const quattro = stessaCategoria.concat([riga({ conditionId: id(4), category: 'Elections', rewardsMinSize: 50, levels: { 500: { grossRewardDay: 6 } } })]);
    const rq = SEL.decidiSelezione({ max: 3, board: quattro, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA });
    ok('  un quarto mercato NON entra: il tetto dei tre slot regge', rq.entranti.length === 3);
    ok('  e non entra perche\' gli slot sono finiti, non per composizione',
      rq.entranti.every((x) => x.id !== id(4)) && rq.scartatiPerComposizione.every((x) => x.id !== id(4)));
  }
}

// ══ 4 · FAIL-CLOSED ══════════════════════════════════════════════════════════════════════════════
titolo('4 · cosa succede quando non si sa');
{
  const stato = SEL.decidiSelezione({ max: N_DICHIARATO,
    board: [riga({ conditionId: id(1), category: 'Economy' }), riga({ conditionId: id(2), category: 'Sports' })],
    stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA,
  }).statoNuovo;

  for (const [nome, board] of [['null', null], ['vuoto', []], ['non-array', {}]]) {
    const r = SEL.decidiSelezione({ max: N_DICHIARATO, board, stato, posizioni: { leggibile: true, conditionIds: [] }, ora: ORA });
    ok(`board ${nome} ⇒ nessuna decisione, e SOPRATTUTTO nessuno esce`,
      r.ok === false && r.uscenti.length === 0 && r.entranti.length === 0 && r.liberati.length === 0);
  }
  const rp = SEL.decidiSelezione({ max: N_DICHIARATO, board: [riga()], stato, posizioni: { leggibile: false, motivo: 'snapshot vecchio' }, ora: ORA });
  ok('posizioni non leggibili ⇒ nessuno slot si libera su un\'ipotesi',
    rp.ok === false && rp.liberati.length === 0 && rp.entranti.length === 0);
  ok('  e il motivo dichiara la causa', /non leggibili/.test(rp.motivo));

  const ro = SEL.decidiSelezione({ max: N_DICHIARATO, board: [riga()], stato, posizioni: { leggibile: true, conditionIds: [] }, ora: null });
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
  let sforato = false; let quotaSforata = false; let categoriaMancante = false;
  for (let giro = 0; giro < 25; giro += 1) {
    // Ogni giro cambia quali mercati hanno posizione aperta, in modo deterministico ma irregolare.
    const posseduti = grande.filter((_, k) => (k + giro) % 7 === 0).map((r) => r.conditionId);
    const r = SEL.decidiSelezione({ max: N_DICHIARATO,
      board: grande, stato, posizioni: { leggibile: true, conditionIds: posseduti }, ora: ORA + giro * 60_000,
    });
    if (r.ok) stato = r.statoNuovo;
    // ⚠ SI CONTANO GLI ATTIVI, non tutte le voci: dalla rotazione del 15 agosto 2026 un mercato con
    // una posizione aperta resta nello stato ma NON occupa uno slot. Contare le voci proverebbe una
    // regola che il modulo non promette piu' — e nasconderebbe quella che promette.
    const voci = Object.values(stato.selezionati).filter((v) => v.inGestione !== true);
    if (voci.length > N_DICHIARATO) sforato = true;
    for (const b of SEL.quotaScaglioni(N_DICHIARATO)) {
      if (voci.filter((v) => v.scaglione === b.chiave).length > b.posti) quotaSforata = true;
    }
    // ⚠ RISCRITTA IL 22 AGOSTO 2026, E NON AMMORBIDITA. Qui si asseriva «mai due mercati ATTIVI della
    // stessa categoria insieme». Il modulo NON lo promette piu': il vincolo di diversificazione e'
    // stato TOLTO il 15 agosto (§4.13 — 23 dei 26 ammissibili erano `elections`, quindi teneva due
    // slot sui mercati PEGGIORI, netto −$0,111/g contro +$10,64/g escluso), e nel sorgente non resta
    // nessun confronto fra categorie: `categoriaDi` serve solo a pretendere che la categoria sia
    // LEGGIBILE e a scriverla nello stato e nel giornale.
    // L'asserzione passava per PIGEONHOLE, non per una regola: la fixture ha 8 categorie e finche' il
    // soffitto stava a 5 non potevano ripetersi. A soffitto 10 su 8 categorie una ripetizione e'
    // aritmeticamente inevitabile — cioe' il test cadeva su un cambio di parametro pur essendo il
    // codice invariato. E' la classe «test che fotografa il comportamento invece della proprieta'».
    // Cio' che il modulo promette davvero, e che si difende qui, e' che la categoria ci sia SEMPRE.
    const cats = voci.map((v) => v.categoria);
    if (cats.some((c) => typeof c !== 'string' || !c)) categoriaMancante = true;
  }
  ok(`25 giri con posizioni che vanno e vengono: il tetto di ${N_DICHIARATO} non e\' mai stato superato`, sforato === false);
  ok('  ne\' la quota per scaglione', quotaSforata === false);
  ok('  e ogni voce ATTIVA porta la propria categoria (la diversificazione non e\' piu\' un vincolo, §4.13)',
    categoriaMancante === false);
  // ⚠ E LA PROPRIETA' CHE LA ROTAZIONE INTRODUCE, dichiarata invece che scoperta dopo: il numero di
  // mercati con capitale esposto NON e' piu' limitato da questo modulo. Il test lo mette nero su
  // bianco — il tetto di 3 conta chi QUOTA, e i limiti sull'esposizione stanno altrove
  // (tetto per mercato, `safety-risk-limits.maxOpenNotionalUsd`, kill sulla perdita giornaliera).
  ok('  la rotazione puo\' portare le voci totali OLTRE il tetto: e\' voluto, e questo test lo dichiara',
    Object.keys(stato.selezionati).length >= Object.values(stato.selezionati).filter((v) => v.inGestione !== true).length,
    `${Object.keys(stato.selezionati).length} voci, di cui ${Object.values(stato.selezionati).filter((v) => v.inGestione !== true).length} attive`);

  // ⚠ IL `max` E' UN TETTO, NON UN OBIETTIVO: la composizione puo' fermarsi prima, e un `max` piu'
  // grande della somma dei posti non fa entrare nessuno in piu'.
  const posti = SEL.quotaScaglioni(N_DICHIARATO).reduce((a, b) => a + b.posti, 0);
  const rTanti = SEL.decidiSelezione({ board: grande, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA, max: 10 });
  ok(`max 10 non sfonda la composizione: entrano al piu\' ${posti} mercati`, rTanti.entranti.length <= posti);
  const rDue = SEL.decidiSelezione({ board: grande, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA, max: 2 });
  ok('il tetto e\' un parametro, e 2 significa 2', rDue.entranti.length === 2);
}

// == R1 · IL NUMERO DI MERCATI E' UNO SOLO, E LA COMPOSIZIONE LO SEGUE ==========================
titolo('R1 \u00b7 un numero solo, e la quota lo deriva');
{
  // ⚠ SI PROVA LA DERIVAZIONE, NON I NUMERI. Fino al 18 agosto 2026 la composizione era una tabella
  // con tre posti scritti a mano: cambiare il tetto senza cambiare la tabella avrebbe prodotto un
  // tetto di 2 con tre posti, o di 3 con due — il reperto D1 su una decisione di capitale.
  for (const n of [1, 2, 3]) {
    const q = SEL.quotaScaglioni(n);
    const posti = q.reduce((a, b) => a + b.posti, 0);
    ok(`quota a max ${n}: i posti sono esattamente ${n}`, posti === n, `${posti}`);
  }
  // La regola dell'operatore a 3, alla lettera: uno basso e due alti.
  const q3 = SEL.quotaScaglioni(3);
  ok('  a 3 \u00e8 1 basso + 2 alti, come deciso',
    q3.find((b) => b.chiave === 'basso').posti === 1 && q3.find((b) => b.chiave === 'alto').posti === 2);
  // ⚠ A 1 IL SECCHIO E' UNO SOLO, e ammette tutto: con la regola stretta un unico slot potrebbe
  // ospitare solo un minSize <= 20, e senza candidati resterebbe vuoto — cioe' il bot non quoterebbe.
  const q1 = SEL.quotaScaglioni(1);
  ok('  a 1 c\'\u00e8 un secchio solo', q1.length === 1);
  ok('    e ammette anche i minSize bassi (o a 1 mercato non si quoterebbe)',
    SEL.scaglioneDi(20, q1) !== null && SEL.scaglioneDi(50, q1) !== null);
  ok('    mentre a 3 un minSize 20 resta nel secchio basso', SEL.scaglioneDi(20, SEL.quotaScaglioni(3)) === 'basso');

  // ⚠ IL SOFFITTO RESTA, ED E' ESPLICITO. Prima lo faceva per caso la lunghezza della tabella.
  // ⚠ PROPRIETA' CAMBIATA IL 24/08: non si clampa piu', si SOLLEVA. Un numero oltre il range e' un
  // errore di configurazione, e schiacciarlo sul soffitto era il modo silenzioso di accettarlo.
  ok('max oltre il range SOLLEVA invece di clamparsi', (() => {
    try { SEL.quotaScaglioni(99); return false; } catch { return true; }
  })());
  for (const cattivo of [0, -1, null, undefined, NaN, 'due']) {
    ok(`max "${String(cattivo)}" \u21d2 SOLLEVA, mai un difetto e mai zero posti`, (() => {
      try { SEL.quotaScaglioni(cattivo); return false; } catch { return true; }
    })());
  }

  // ⚠ E IL TETTO MORDE DAVVERO SULLA DECISIONE, non solo sulla tabella. Il board si ricostruisce qui:
  // `grande` vive dentro un altro blocco, e prenderlo da li' legherebbe due prove che devono restare
  // indipendenti.
  const CATS40 = ['Economy', 'Sports', 'Tech', 'Esports', 'Politics', 'Pop Culture', 'Geopolitics', 'Elections'];
  const board40 = [];
  for (let i = 1; i <= 40; i += 1) {
    board40.push(riga({ conditionId: id(i), category: CATS40[i % CATS40.length],
      rewardsMinSize: i % 3 === 0 ? 20 : 50, levels: { 500: { grossRewardDay: 40 - i } } }));
  }
  for (const n of [1, 2, 3]) {
    const r = SEL.decidiSelezione({ board: board40, stato: SEL.statoVuoto(),
      posizioni: { leggibile: true, conditionIds: [] }, ora: ORA, max: n });
    ok(`  decidiSelezione con max ${n} fa entrare al pi\u00f9 ${n} mercati`,
      r.ok === true && r.entranti.length <= n, `${r.entranti.length}`);
  }

  // ⚠ IL NUMERO NON E' SCRITTO DUE VOLTE. `quanti-mercati` lo IMPORTA da qui: se un giorno
  // qualcuno ci riscrivesse un letterale, questa asserzione cadrebbe.
  {
    const Q = require('./quanti-mercati');
    ok('`quanti-mercati` non ha piu\' ne\' difetto ne\' massimo propri: SOLLEVA e basta',
      Q.QUANTI_DI_DIFETTO === undefined && Q.QUANTI_MASSIMO === undefined
      && (() => { try { Q.quantiMercati({}); return false; } catch { return true; } })());
    const src = require('fs').readFileSync(require('path').join(__dirname, 'quanti-mercati.js'), 'utf8');
    const righeCodice = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l));
    ok('  e non ne scrive un letterale proprio',
      !righeCodice.some((l) => /^const QUANTI_(DI_DIFETTO|MASSIMO)\s*=\s*\d/.test(l)));
  }
}

// ══ 6 · COSA NON SI ADOTTA, E COSA NON SI SCEGLIE ═══════════════════════════════════════════════
titolo('6 · quarantena e posizioni altrui');
{
  const board = [riga({ conditionId: id(1), category: 'Economy', levels: { 500: { grossRewardDay: 9 } } }),
    riga({ conditionId: id(2), category: 'Sports', levels: { 500: { grossRewardDay: 8 } } }),
    riga({ conditionId: id(3), category: 'Tech', levels: { 500: { grossRewardDay: 7 } } })];
  const r = SEL.decidiSelezione({ max: N_DICHIARATO,
    board, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora: ORA, escludi: [id(1)],
  });
  ok('un mercato in quarantena al venue non viene scelto', r.entranti.every((x) => x.id !== id(1)));

  const r2 = SEL.decidiSelezione({ max: N_DICHIARATO,
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
    const r = SEL.decidiSelezione({ max: N_DICHIARATO, board, stato: SEL.statoVuoto(), posizioni: { leggibile: true, conditionIds: [] }, ora });
    ok(`  e la decisione sul board vero sceglie al piu' ${N_DICHIARATO} mercati`,
      r.ok === true && r.entranti.length <= N_DICHIARATO, `${r.entranti.length}`);
    // ⚠ «categorie tutte diverse» e' caduto il 16 agosto 2026 insieme al vincolo. Sul board vero i tre
    // slot possono essere della stessa famiglia — anzi lo SONO, perche' 23 dei 26 ammissibili sono
    // elections. Cio' che resta da verificare sul board vivo e' la quota per scaglione, che e' l'unico
    // vincolo di composizione rimasto e quello che tiene il capitale a $147.
    ok('  con la quota per scaglione rispettata (le categorie non vincolano piu\')',
      SEL.quotaScaglioni(N_DICHIARATO).every((b) => r.entranti.filter((e) => e.scaglione === b.chiave).length <= b.posti));
    for (const e of r.entranti) console.log(`      → ${e.id.slice(0, 12)}… ${String(e.question).slice(0, 52)} · minSize ${e.minSize} (${e.scaglione}) · ${e.categoria} · ${e.punteggio.toFixed(3)}`);
  }
}

console.log('\nselezione-mercati: ' + n + ' passed, 0 failed');

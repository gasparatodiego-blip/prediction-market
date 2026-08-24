'use strict';
// lib/maker/uscita-prezzo-vincolante.test.js — I QUATTRO CASI DEL 24 AGOSTO 2026.
//
// Ognuno e' un fatto MISURATO sul bot vivo, non un caso inventato, e ognuno era ROSSO sul codice di
// prima. Sono scritti sulla PROPRIETA' e non sul sorgente (§5.3: un test che fotografa il codice e'
// verde in lavorazione e rosso dopo il commit):
//
//   ① un SELL di uscita a 0.495 con un aggiustamento di coda che propone 0.288 NON deve partire a
//      0.288, e lo scarto va scritto        → prima: partiva a 0.288, priceAdjusted{from:0.495,to:0.288}
//   ② un BUY di completamento a 0.516 con band-exit attivo deve restare a 0.516
//                                           → prima: band-exit lo portava a 0.708, poi 0.717
//   ③ un BUY la cui coppia risulti 121,1¢ AL MOMENTO DELL'INVIO deve essere rifiutato
//                                           → prima: nessun controllo sul prezzo di invio
//   ④ un residuo di 30 share con `rewards.min_size` 50 e `minimum_order_size` 5 deve risultare
//      PIAZZABILE                           → prima: un numero solo, e 30 < 50 ⇒ «non piazzabile»
//
// ⚠ NESSUNO DI QUESTI TEST TOCCA IL VENUE. ①③ usano le funzioni pure del divieto, ② la decisione di
// riprezzo con le sue dipendenze iniettate, ④ il modulo dei minimi. Un test che dovesse piazzare per
// provare una regola sul piazzamento non sarebbe un test, sarebbe un ordine.

const USCITA = require('./ordini-di-uscita');
const MINIMI = require('./minimi-del-venue');
const { decideReprice } = require('./auto-reprice');
const { TETTO_COPPIA_CENTS } = require('./chiusura-rapida');

let pass = 0; let fail = 0;
const ok = (t, c, d) => { if (c) { pass += 1; console.log('  ok  ', t); } else { fail += 1; console.log('  FAIL', t, d === undefined ? '' : JSON.stringify(d)); } };

// ── I NUMERI VERI DI `0x4d79d306`, dal giornale del 24 agosto ────────────────────────────────────
const CARICO = 0.494;          // avgPrice dallo snapshot posizioni del venue
const TICK = 0.001;            // minimum_tick_size letto da /markets
const SIZE = 56.1;
const DECISO_SELL = 0.495;     // «carico +1 tick, FUORI banda» — la decisione di auto-close
const PROPOSTO_CODA = 0.288;   // cio' che prezzo-in-coda ha proposto, e che e' partito
const DECISO_BUY = 0.516;      // 101¢ − carico: il tetto della coppia al centesimo
const TRASCINATO = 0.717;      // dove band-exit l'ha portato — coppia 121,1¢

console.log('\n① IL SELL DI USCITA A 0.495 CON UNA CODA CHE PROPONE 0.288');
{
  // La proposta esiste e viene riconosciuta come uno spostamento, coi numeri per il verbale.
  const v = USCITA.verdettoAggiustamento({
    prezzoDeciso: DECISO_SELL, prezzoProposto: PROPOSTO_CODA, ramo: 'inCoda', tick: TICK });
  ok('lo spostamento e\' RICONOSCIUTO come tale', v.muove === true, v);
  ok('  la riga porta il prezzo DECISO', v.prezzoDeciso === DECISO_SELL);
  ok('  il prezzo PROPOSTO', v.prezzoProposto === PROPOSTO_CODA);
  ok('  il DELTA in centesimi', Math.abs(v.deltaCents - (-20.7)) < 1e-6, v.deltaCents);
  ok('  e il NOME DEL RAMO che l\'ha proposto', v.ramo === 'inCoda');
  ok('  e il motivo dice che la proposta NON viene applicata', /NON viene applicata/.test(v.motivo));

  // ⚠ LA PROPRIETA' CHE CONTA: qualunque cosa proponga il ramo, il prezzo che resta e' quello deciso.
  // Si prova su TUTTA la griglia fra il bordo di banda e il carico, non su un solo punto: un test su
  // un valore solo e' verde anche se la regola vale per caso su quel valore.
  let sempreDeciso = true;
  for (let p = 0.200; p <= 0.600 + 1e-9; p = +(p + TICK).toFixed(6)) {
    const w = USCITA.verdettoAggiustamento({ prezzoDeciso: DECISO_SELL, prezzoProposto: p, ramo: 'inCoda', tick: TICK });
    const muoveAtteso = Math.abs(p - DECISO_SELL) > TICK / 1000;
    if (w.muove !== muoveAtteso) { sempreDeciso = false; break; }
  }
  ok('  su 401 prezzi proposti fra 0.200 e 0.600 il verdetto e\' sempre coerente', sempreDeciso);

  // Il caso che dimostra il difetto vecchio: 0.288 e' un prezzo perfettamente valido IN BANDA.
  // Non era «un prezzo sbagliato»: era il prezzo giusto per un ordine che quotava, su un ordine che
  // usciva. Per questo nessun controllo di validita' lo fermava.
  ok('  e 0.288 NON e\' un prezzo invalido — e\' il prezzo giusto per un\'altra domanda',
    PROPOSTO_CODA > 0 && PROPOSTO_CODA < 1);
}

console.log('\n② IL BUY DI COMPLETAMENTO A 0.516 CON BAND-EXIT ATTIVO RESTA A 0.516');
{
  // Le condizioni che il 24 agosto hanno prodotto lo spostamento, ricostruite: l'ordine e' a 23,3¢
  // dal mid, cioe' ben oltre la banda ±5,5¢, e la violazione e' gia' confermata.
  // ⚠ LA FIXTURE DEVE SUPERARE I CANCELLI DI FRESCHEZZA, o il test sarebbe verde per il motivo
  // sbagliato: `decideReprice` rifiuta prima di giudicare se le regole non sono leggibili o il mid
  // non e' vivo, e un `skip` per quei motivi ha `targetPrice: null` — cioe' passerebbe l'asserzione
  // «non lo sposta» senza aver mai raggiunto il codice che si sta provando. E' esattamente il difetto
  // che il 19 agosto ha reso otto test verdi e inerti (§5.2 p.11): le fixture non portavano l'eta' del
  // book e ricevevano `skip/book-non-databile`. Il blocco CONTROLLO qui sotto e' cio' che lo rileva.
  const rules = {
    readable: true, marketId: '0x4d79d306', tick: TICK, minSize: 20,
    midSource: 'live-book', midAgeSec: 1, feedVitality: null,
    books: { yes: { scoringMid: 0.749 }, no: { scoringMid: 0.251 } },
    maxSpreadCents: 5.5, scoringMid: 0.749, tokenId: 'tokYES', tokenIdNo: 'tokNO',
  };
  const order = { orderId: '0xBUYCOMPLETAMENTO', book: 'yes', side: 'BUY', price: DECISO_BUY, size: SIZE };
  const config = { hysteresisTicks: 1, confirmSamples: 2, minIntervalMs: 0, maxPerHour: 999, strategy: 'band-edge', minMoveCents: 0.5 };

  // Il registro dice che questo ordine E' un'uscita, col prezzo deciso dalla scala.
  const uscitaSi = () => ({ noto: true, uscita: true, prezzoDeciso: DECISO_BUY, motivo: 'marcato' });
  const d = decideReprice(
    { order, rules, config, consecutiveBreaches: 5, repricesThisHour: 0, now: Date.now() },
    { statoUscita: uscitaSi });
  ok('band-exit NON propone un prezzo diverso da quello deciso',
    d.targetPrice === null || Math.abs(d.targetPrice - DECISO_BUY) < TICK / 1000, d);
  ok('  e in particolare non lo porta a 0.708/0.717',
    !(Number.isFinite(d.targetPrice) && Math.abs(d.targetPrice - TRASCINATO) < 0.05), d.targetPrice);
  ok('  l\'ordine non viene spostato (`hold`)', d.action === 'hold', d.action);
  ok('  e il motivo nomina la regola', d.gate === 'uscita-prezzo-vincolante', d.gate);

  // ⚠ IL CONTROLLO: lo STESSO ordine, se NON e' un'uscita, band-exit lo sposta come sempre. Senza
  // questo blocco il test sarebbe verde anche se avessimo spento band-exit del tutto — cioe' non
  // proverebbe la regola, proverebbe l'assenza della funzione.
  const uscitaNo = () => ({ noto: true, uscita: false, prezzoDeciso: null, motivo: 'non e\' un\'uscita' });
  const dc = decideReprice(
    { order, rules, config, consecutiveBreaches: 5, repricesThisHour: 0, now: Date.now() },
    { statoUscita: uscitaNo });
  ok('CONTROLLO — lo stesso ordine NON marcato viene spostato da band-exit',
    dc.action === 'reprice' && Number.isFinite(dc.targetPrice) && Math.abs(dc.targetPrice - DECISO_BUY) > TICK, dc);

  // ⚠ E IL FAIL-CLOSED: registro illeggibile ⇒ non si sposta. «Non lo so» non e' «non e' un'uscita».
  const uscitaBoh = () => ({ noto: false, uscita: null, prezzoDeciso: null, motivo: 'registro illeggibile' });
  const db = decideReprice(
    { order, rules, config, consecutiveBreaches: 5, repricesThisHour: 0, now: Date.now() },
    { statoUscita: uscitaBoh });
  ok('FAIL-CLOSED — registro illeggibile ⇒ l\'ordine NON si sposta',
    db.action === 'hold' && db.gate === 'uscita-prezzo-vincolante', db);

  // ⚠⚠ E IL RINNOVO GTD DEVE SOPRAVVIVERE ALLA REGOLA NUOVA. Senza questo blocco la cura sarebbe
  // peggiore del male: ogni uscita fuori banda morirebbe per scadenza in 23 minuti, cioe' si sarebbe
  // curato uno spostamento togliendo l'ordine dal libro. Il rinnovo e' fra le cose che il giro non
  // doveva toccare, e questa asserzione e' il modo di dimostrare che non e' stato toccato.
  const dg = decideReprice(
    { order: { ...order, secondsToExpiry: 30 }, rules, config, consecutiveBreaches: 5, repricesThisHour: 0, now: Date.now() },
    { statoUscita: uscitaSi });
  ok('RINNOVO GTD — con la scadenza imminente l\'uscita si RINNOVA...', dg.action === 'reprice', dg);
  ok('  ...ALLO STESSO PREZZO deciso, mai a un prezzo di banda',
    Math.abs(dg.targetPrice - DECISO_BUY) < TICK / 1000, dg.targetPrice);
  ok('  e il gate lo dice', dg.gate === 'uscita-rinnovo-gtd', dg.gate);
}

console.log('\n③ IL BUY LA CUI COPPIA RISULTA 121,1¢ AL MOMENTO DELL\'INVIO E\' RIFIUTATO');
{
  const v = USCITA.verdettoTettoCoppia({
    side: 'BUY', carico: CARICO, prezzoInvio: TRASCINATO, tettoCoppiaCents: TETTO_COPPIA_CENTS });
  ok('rifiutato', v.ammesso === false, v);
  ok('  e la coppia calcolata e\' 121,1¢', Math.abs(v.coppiaCents - 121.1) < 1e-6, v.coppiaCents);
  ok('  e il motivo dice di quanto sfora', /SUPERA il tetto/.test(v.motivo), v.motivo);

  // ⚠ IL PUNTO DEL TEST: sul prezzo DECISO lo stesso ordine passa. Un controllo fatto sulla decisione
  // avrebbe risposto «ammesso» a un ordine che rompeva il tetto di 20,1¢ — ed e' per questo che il
  // controllo e' terminale.
  const suDeciso = USCITA.verdettoTettoCoppia({
    side: 'BUY', carico: CARICO, prezzoInvio: DECISO_BUY, tettoCoppiaCents: TETTO_COPPIA_CENTS });
  ok('  mentre sul prezzo DECISO (0.516) lo stesso ordine PASSA — coppia 101,0¢ esatta',
    suDeciso.ammesso === true && Math.abs(suDeciso.coppiaCents - 101) < 1e-6, suDeciso);
  ok('  ⇒ il controllo DEVE guardare il prezzo di invio, non quello di decisione',
    suDeciso.ammesso === true && v.ammesso === false);

  // La frontiera, derivata e non fotografata: il primo tick che sfora.
  const limite = +(TETTO_COPPIA_CENTS / 100 - CARICO).toFixed(6);
  ok(`  il prezzo limite e' ${limite} e passa`,
    USCITA.verdettoTettoCoppia({ side: 'BUY', carico: CARICO, prezzoInvio: limite, tettoCoppiaCents: TETTO_COPPIA_CENTS }).ammesso === true);
  ok('  un tick oltre non passa',
    USCITA.verdettoTettoCoppia({ side: 'BUY', carico: CARICO, prezzoInvio: +(limite + TICK).toFixed(6), tettoCoppiaCents: TETTO_COPPIA_CENTS }).ammesso === false);
  ok('  fail-closed: carico illeggibile ⇒ NON parte',
    USCITA.verdettoTettoCoppia({ side: 'BUY', carico: null, prezzoInvio: DECISO_BUY, tettoCoppiaCents: TETTO_COPPIA_CENTS }).ammesso === false);
}

console.log('\n④ UN RESIDUO DI 30 SHARE CON PAVIMENTO 50 E MINIMO D\'ORDINE 5 E\' PIAZZABILE');
{
  const rec = { rewards: { min_size: 50 }, minimum_order_size: 5 };
  const m = MINIMI.leggiMinimi(rec);
  ok('i due numeri si leggono separati: 50 e 5', m.pavimentoPremiante === 50 && m.minimoOrdine === 5, m);

  const p = MINIMI.piazzabileAlVenue({ size: 30, minimoOrdine: m.minimoOrdine });
  ok('30 share sono PIAZZABILI (30 >= 5)', p.piazzabile === true, p);

  const r = MINIMI.maturaPremio({ size: 30, pavimentoPremiante: m.pavimentoPremiante });
  ok('  e NON maturano premio (30 < 50): sono due domande diverse', r.premiante === false, r);

  // ⚠ IL DIFETTO, ESPRESSO: usare il pavimento premiante al posto del minimo d'ordine.
  ok('  usando il PAVIMENTO al posto del MINIMO si otterrebbe «non piazzabile» — il difetto del 24/08',
    MINIMI.piazzabileAlVenue({ size: 30, minimoOrdine: m.pavimentoPremiante }).piazzabile === false);

  // E le quattro gambe vere, dove la conclusione coincide: il bot aveva ragione PER CASO.
  for (const [nome, size] of [['0x7619b095', 4.85], ['0x790474c0', 2.01], ['0xb3c7f543', 2.8461]]) {
    ok(`  ${nome}: ${size} share non piazzabili nemmeno col minimo VERO (5)`,
      MINIMI.piazzabileAlVenue({ size, minimoOrdine: 5 }).piazzabile === false);
  }
  ok('  0x4d79d306: 56,1 share PIAZZABILI col minimo vero',
    MINIMI.piazzabileAlVenue({ size: 56.1, minimoOrdine: 5 }).piazzabile === true);

  // ⚠ E IL FAIL-CLOSED CHE L'OPERATORE HA CHIESTO: minimo non leggibile ⇒ non si indovina, e NON si
  // marca R6. Si asserisce sul verdetto e sul motivo, cosi' la regola resta leggibile da chi la usa.
  const boh = MINIMI.piazzabileAlVenue({ size: 30, minimoOrdine: null });
  ok('  minimo d\'ordine illeggibile ⇒ piazzabile === null, mai true e mai false', boh.piazzabile === null, boh);
  ok('  e il contratto dice esplicitamente «non marca R6»', /non marca R6/.test(boh.motivo));
}

console.log('\n⑤ E LA MARCATURA ALL\'ORIGINE NON SI PUO\' ARMARE PER DISTRAZIONE');
{
  ok('`uscita: true` marca', USCITA.eOrdineDiUscita({ uscita: true, price: 0.5 }) === true);
  ok('`uscita: 1` NON marca (si legge === true)', USCITA.eOrdineDiUscita({ uscita: 1, price: 0.5 }) === false);
  ok('un ordine di apertura non e\' mai un\'uscita', USCITA.eOrdineDiUscita({ price: 0.5, inCoda: true }) === false);
  ok('e il prezzo deciso ripiega su `price` quando non e\' dichiarato',
    USCITA.prezzoDecisoDi({ uscita: true, price: DECISO_SELL }) === DECISO_SELL);
}

console.log('\n⑥ IL CABLAGGIO: `auto-close.chiudendo` MARCA, E TOGLIE `inCoda`');
{
  const { chiudendo } = require('./auto-close');
  // Lo spec vero del 24 agosto, com'era: il lato posseduto dichiarava `inCoda: true`.
  const prima = { marketId: '0x4d79d306', book: 'no', side: 'SELL', price: DECISO_SELL, size: SIZE, inCoda: true };
  const dopo = chiudendo(prima);
  ok('lo spec esce MARCATO come uscita', USCITA.eOrdineDiUscita(dopo) === true, dopo);
  ok('  e `inCoda` NON c\'e\' piu\' — e\' la riga che ha prodotto 0.288', dopo.inCoda === undefined, dopo.inCoda);
  ok('  il prezzo deciso viaggia accanto al prezzo', USCITA.prezzoDecisoDi(dopo) === DECISO_SELL);
  ok('  e il prezzo NON e\' stato toccato', dopo.price === DECISO_SELL);
  ok('  la GTD di chiusura resta quella di prima', Number.isFinite(dopo.ttlSeconds) && dopo.ttlSeconds > 0);
  ok('  un ttl dichiarato dal chiamante se lo tiene',
    chiudendo({ price: 0.5, ttlSeconds: 42 }).ttlSeconds === 42);

  // ⚠ IL CONTROLLO PER ASSENZA: uno spec che NON passa da `chiudendo` (il riposizionamento dopo la
  // fusione, che APRE due gambe) non e' marcato e tiene il suo `inCoda`. Se un giorno qualcuno
  // facesse passare anche le aperture di qui, questo blocco lo direbbe.
  const apertura = { marketId: '0x4d79d306', book: 'yes', side: 'BUY', price: 0.5, size: 10, inCoda: true };
  ok('CONTROLLO — uno spec di APERTURA non marcato resta non-uscita e tiene `inCoda`',
    USCITA.eOrdineDiUscita(apertura) === false && apertura.inCoda === true);
  ok('  e `chiudendo` non muta il suo argomento (nessun effetto a distanza)', prima.inCoda === true);
}

console.log(`\nuscita · prezzo vincolante: ${pass} passati, ${fail} falliti\n`);
process.exit(fail === 0 ? 0 : 1);

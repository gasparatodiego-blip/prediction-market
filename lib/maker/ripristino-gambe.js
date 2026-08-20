'use strict';
// lib/maker/ripristino-gambe.js — QUANDO SI PUO' RIMETTERE UNA GAMBA MANCANTE, E QUANTO SPESSO. PURO.
//
// ═══ IL BUCO CHE CHIUDE ══════════════════════════════════════════════════════════════════════════════
// `copertura-gambe.valutaCopertura` decide correttamente da giorni — `coperto` / `da-coprire` /
// `non-quotabile` / `da-sostituire` — ed e' cablato in `agent41.riconciliaCopertura`. Ma quel
// cablaggio DICHIARA E BASTA: nessuno rimette la gamba a libro.
//
// LA MISURA CHE DICE QUANTO COSTA (17 agosto 2026, `data/ricerca/gambe-16-agosto.md`): il 16 agosto
// il bot ha avuto **due gambe vive solo il 50,0% del tempo** — 14,70 h contro 7,15 h a gamba singola
// e 7,54 h a zero. **17 delle 22 cadute lunghe non sono mai tornate.** Le gambe non tornavano perche'
// nessun percorso le rimetteva: il trigger a capitale fermo apre MERCATI, non gambe, e agent40
// riprezza cio' che esiste — su zero ordini non ha niente su cui iterare.
//
// ═══ PERCHE' ESISTE QUESTO MODULO E NON UN `if` DENTRO L'AGENT ═══════════════════════════════════════
// Perche' la parte difficile non e' piazzare: e' NON piazzare troppo spesso. Il 16 agosto la stessa
// idea — «uno slot scoperto e' capitale che non lavora, si chiede il ripiazzamento» — e' stata cablata
// chiamando `controlloCapitaleFermo` da dentro il riconciliatore, e ha prodotto **799 ricostruzioni
// del piano consecutive**, agent41 da 9 a 14 riavvii, e un QUARTO mercato aggiunto alla allowlist.
//
// LA LEZIONE, scritta per esteso perche' e' l'unica cosa che conta qui: *un riconciliatore osserva.
// Nel momento in cui agisce sull'anello che sta osservando, e l'azione non risolve la condizione
// osservata, l'anello non si chiude piu' — e LA FREQUENZA DEL CICLO DIVENTA LA FREQUENZA
// DELL'AZIONE.* Il ciclo che ospita questa decisione gira ogni **120 secondi**, cioe' **720 volte al
// giorno** (misurato: `TRIG.CADENZA_MS` in agent41, `controlloCapitaleFermo` via `setInterval`).
// Senza raffreddamento, un mercato che rifiuta sempre verrebbe ritentato 720 volte.
//
// ═══ IL RAFFREDDAMENTO, E I NUMERI CHE LO SCELGONO ═══════════════════════════════════════════════════
// Non e' un intervallo fisso: e' una scala che si allunga sui fallimenti CONSECUTIVI e si azzera
// appena il mercato torna coperto.
//
//     tentativo 1 · SUBITO          — la gamba manca adesso e il mercato e' quotabile adesso
//     dopo 1 fallimento ·  5 min
//     dopo 2 fallimenti · 10 min
//     dopo 3 fallimenti · 20 min
//     dopo 4+          · 30 min (tetto)
//
// I tre numeri che circondano la scala:
//   · il primo tentativo e' IMMEDIATO perche' la scadenza GTD e' **23 minuti**: aspettare cinque
//     minuti su una gamba appena morta significa regalare un quinto della sua vita utile;
//   · il tetto e' **30 min**, cioe' sopra la scadenza GTD: oltre quella soglia il problema non e' piu'
//     «la gamba manca», e' «questo mercato non si riesce a quotare», e la risposta giusta e' la
//     sostituzione dello slot (`da-sostituire`, soglia 10 min in `copertura-gambe`), non l'insistenza;
//   · nel caso peggiore — tre mercati che rifiutano sempre — si passa da 2.160 tentativi al giorno
//     (720 × 3) a **circa 150**, cioe' un fattore **14**. E' la differenza fra un riconciliatore e
//     una macchina di rifiuti.
//
// ⚠ IL RAFFREDDAMENTO SI AZZERA SU `coperto`, NON SU UN PIAZZAMENTO RIUSCITO. Sono due cose diverse:
// un invio accettato dal venue puo' essere seguito da una cancellazione immediata (fuori banda, mid
// stantio), e contare quello come successo rimetterebbe il contatore a zero su un mercato che in
// realta' non e' tornato coperto. Si azzera su ciò che si osserva, non su ciò che si è tentato.
//
// ⚠ QUESTO MODULO NON PIAZZA E NON CONOSCE IL VENUE. Zero `require` — la stessa disciplina di
// `copertura-gambe` e `presa-di-profitto`. Restituisce un'intenzione; chi la esegue passa dalle
// funzioni di sempre (`gambeDiUnaRiga` → `piazzaCoppia` → `runBulkAllocation`), cosi' che non nasca
// una seconda strada verso il venue con una seconda verita' sui prezzi e sui gate.

// La scala, in minuti, indicizzata sui fallimenti consecutivi. L'ultimo valore e' il tetto.
const SCALA_MIN = [0, 5, 10, 20, 30];

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const norm = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');

/** L'attesa dovuta dopo `n` fallimenti consecutivi, in millisecondi. */
function attesaMs(fallimenti) {
  const n = fin(fallimenti) && fallimenti > 0 ? Math.floor(fallimenti) : 0;
  return SCALA_MIN[Math.min(n, SCALA_MIN.length - 1)] * 60_000;
}

/**
 * SI PUO' TENTARE ADESSO?
 *
 * @param a.stato            l'esito di `copertura-gambe.valutaCopertura`: 'coperto' | 'da-coprire' | …
 * @param a.mancanti         i token senza ordine a riposo (da `valutaCopertura`)
 * @param a.memoria          {ultimoTentativo:number|null, fallimenti:number} per QUESTO mercato, o null
 * @param a.ora
 * @param a.lockPreso        true se un altro percorso tiene il lucchetto di questo mercato
 * @returns {{tenta:boolean, motivo:string, attesaMs:number, restaMs:number, mancanti:string[]}}
 */
function valutaRipristino(a = {}) {
  const stato = norm(a.stato);
  const mancanti = Array.isArray(a.mancanti) ? a.mancanti.filter((t) => norm(t)) : [];
  const mem = a.memoria && typeof a.memoria === 'object' ? a.memoria : null;
  const fallimenti = mem && fin(mem.fallimenti) ? mem.fallimenti : 0;
  const ultimo = mem && fin(mem.ultimoTentativo) ? mem.ultimoTentativo : null;
  const ora = fin(a.ora) ? a.ora : null;
  const attesa = attesaMs(fallimenti);
  const no = (motivo, resta = 0) => ({ tenta: false, motivo, attesaMs: attesa, restaMs: resta, mancanti });

  // ⚠ SOLO `da-coprire`. Gli altri tre stati sono risposte gia' date, e agire su di loro sarebbe
  // scavalcare una decisione presa da qualcun altro:
  //   · `coperto`        — non manca niente;
  //   · `non-quotabile`  — il motore dice che NON ESISTE un prezzo conforme; insistere sarebbe
  //                        sbattere contro una regola di rischio a ogni ciclo (§4.1 Regola 1);
  //   · `da-sostituire`  — lo slot sta gia' tornando alla riclassificazione;
  //   · `ignoto`         — non si e' potuto giudicare, e non si piazza al buio.
  if (stato !== 'da-coprire') return no(`stato «${stato || 'assente'}»: si ripristina solo su «da-coprire»`);
  if (!mancanti.length) return no('nessuna gamba dichiarata mancante: niente da ripristinare');

  // ⚠ IL LUCCHETTO DEL MERCATO VIENE PRIMA DELL'OROLOGIO. Se un altro percorso sta gia' cancellando e
  // ripiazzando su questo mercato, la gamba che qui sembra mancante puo' essere una gamba IN VIAGGIO:
  // e' esattamente la corsa che il 16 agosto ha prodotto due ordini identici a libro due volte in
  // un'ora. Non e' un rinvio da contare come fallimento — non abbiamo tentato niente.
  if (a.lockPreso === true) return no('un altro percorso tiene il lucchetto di questo mercato: la gamba potrebbe essere gia\' in viaggio');

  // ⚠ OROLOGIO NON LEGGIBILE ⇒ NON SI TENTA. Senza `ora` non si puo' dire se il raffreddamento e'
  // scaduto, e «non so da quanto» non e' «e' passato abbastanza»: e' il difetto `Number(null) === 0`
  // di questo repo, scritto sei volte e sempre trovato da una prova.
  if (ora == null) return no('istante non leggibile: senza orologio non si puo\' dire se il raffreddamento e\' scaduto');

  // Primo tentativo in assoluto su questo mercato, o raffreddamento scaduto.
  if (ultimo == null) return { tenta: true, motivo: 'prima gamba mancante osservata su questo mercato: si tenta subito', attesaMs: attesa, restaMs: 0, mancanti };
  const passato = ora - ultimo;
  // ⚠ UN `ultimoTentativo` NEL FUTURO NON AZZERA L'ATTESA: un orologio che torna indietro
  // (correzione NTP, riavvio) darebbe `passato < 0`, e il confronto `>= attesa` sarebbe falso —
  // cioe' si aspetta. E' il verso prudente, ed e' dichiarato per non doverlo ridedurre.
  if (passato >= attesa) {
    return { tenta: true, motivo: `raffreddamento scaduto (${Math.round(passato / 60000)} min dall\'ultimo tentativo, ne servivano ${Math.round(attesa / 60000)})`, attesaMs: attesa, restaMs: 0, mancanti };
  }
  const resta = attesa - passato;
  return no(`raffreddamento: ${fallimenti} fallimento/i consecutivo/i ⇒ si riprova fra ${Math.max(1, Math.round(resta / 60000))} min`, resta);
}

/**
 * LA MEMORIA DOPO UN GIRO. Pura: prende la memoria di prima e restituisce quella di dopo.
 *
 * ⚠⚠ UN RICALCOLO ESEGUITO E' UN TENTATIVO AVVENUTO — corretto il 20 agosto 2026, e il difetto era
 * misurato: **15 ricalcoli in 30 minuti = 720/giorno**, la stessa identica cifra dell'incidente del
 * 16 agosto (§5-bis p.171), contro i ~48/giorno che il contenimento doveva garantire. Sforo 15x.
 *
 * LA CAUSA stava nella riga `if (a.tentato !== true) return mem;`. Quando `ripristinaGamba` ricalcola
 * il piano e l'allocatore risponde «non quotabile», l'esito e' `tentato:false` — non si e' piazzato
 * niente — quindi la memoria restava INVARIATA, `fallimenti` restava 0, `attesaMs(0)` valeva 0, e la
 * scala concedeva un nuovo tentativo **a ogni ciclo**. Ma un processo figlio da 13-22 s E' STATO
 * ESEGUITO: costava 2,6-4,4 ore di CPU al giorno per un mercato che l'allocatore dichiarava a netto
 * −$30/g. «Non ho piazzato» non e' «non ho fatto niente».
 *
 * I TRE CASI, distinti esplicitamente, e solo il primo lascia la memoria com'era:
 *   ① ricalcolo NON eseguito (riga gia' nel piano salvato, o scala che nega, o nessun ricalcolo
 *      disponibile)              ⇒ memoria INVARIATA, la scala non sale;
 *   ② ricalcolo eseguito con esito NEGATIVO (piano rifatto, mercato ancora non quotabile)
 *                                ⇒ **fallimento**, la scala sale 0→5→10→20→30;
 *   ③ ricalcolo eseguito con SUCCESSO (riga trovata) ⇒ si prosegue al piazzamento, e a decidere
 *      tornano `tentato`/`riuscito` come sempre.
 *
 * ⚠ NON TOCCA L'AZZERAMENTO: `coperto` osservato continua a cancellare la memoria, ed e' l'unico
 * azzeramento vero. Un mercato che torna quotabile riparte dal gradino zero al primo giro coperto.
 *
 * @param a.memoria             quella di prima, o null
 * @param a.stato               lo stato OSSERVATO in questo giro
 * @param a.tentato             true se in questo giro si e' provato a PIAZZARE
 * @param a.riuscito            true se il piazzamento ha messo almeno una gamba a libro
 * @param a.ricalcoloEseguito   true se il piano e' stato RICALCOLATO in questo giro, comunque sia
 *                              finito: e' un tentativo avvenuto anche quando non si e' piazzato
 * @param a.ora
 */
function memoriaDopo(a = {}) {
  const stato = norm(a.stato);
  const mem = a.memoria && typeof a.memoria === 'object' ? a.memoria : null;
  const ora = fin(a.ora) ? a.ora : null;
  // ⚠ SI AZZERA SU `coperto` OSSERVATO, non su un invio accettato — vedi la nota in testa al file.
  if (stato === 'coperto') return null;
  // ① Ne' piazzato ne' ricalcolato: non e' successo niente che costi, e la scala non sale.
  if (a.tentato !== true && a.ricalcoloEseguito !== true) return mem;
  const fallimenti = mem && fin(mem.fallimenti) ? mem.fallimenti : 0;
  return {
    ultimoTentativo: ora,
    // Un tentativo riuscito NON azzera il contatore: lo lascia dov'e'. Se la gamba e' davvero tornata,
    // il giro dopo osservera' `coperto` e la memoria sparira' del tutto — che e' l'azzeramento vero.
    // Se invece l'ordine e' stato accettato e subito cancellato, il contatore non e' stato regalato.
    // ⚠ E un ricalcolo eseguito senza piazzamento e' un FALLIMENTO: `riuscito` non e' true, quindi
    // cade nel ramo `+1` senza bisogno di un caso a parte. Il caso ③ passa da `riuscito`.
    fallimenti: a.riuscito === true ? fallimenti : fallimenti + 1,
  };
}

/**
 * LE GAMBE DA MANDARE, filtrate su quelle che MANCANO.
 *
 * ⚠ E' QUI CHE SI PIAZZA UNA GAMBA SOLA DI PROPOSITO, e va detto perche' non contraddice §4.6.
 * Il precontrollo atomico della coppia esiste perche' «meglio zero invii che una gamba orfana»: una
 * coppia in cui una gamba sfonda il tetto va abbandonata INTERA. Qui la premessa e' rovesciata —
 * l'altra gamba E' GIA' A LIBRO, ed e' la ragione per cui lo stato e' `da-coprire` e non `da-aprire`.
 * Mandare la mancante RICOSTITUISCE la coppia; mandarle entrambe creerebbe un doppione su quella viva.
 * `runBulkAllocation` applica il precontrollo atomico solo dentro `if (accoppiato)`, e un gruppo di
 * una riga non e' accoppiato: quindi non lo si aggira, non lo si incontra.
 *
 * ⚠ LE DUE META' PARLANO LINGUE DIVERSE, E QUESTA FUNZIONE E' IL TRADUTTORE.
 * `valutaCopertura` ragiona in TOKEN — sono gli ordini a riposo a portare un `tokenId`, e la domanda
 * «questa gamba c'e'?» si risponde solo li'. `gambeDiUnaRiga` produce invece righe con `book: 'yes'`
 * / `'no'` e **nessun tokenId**: il token lo risolve `placeManualOrder` a valle, dalle regole del
 * mercato. Filtrare le righe costruite per `tokenId` non poteva quindi corrispondere MAI, e il
 * risultato era zero invii con un motivo che dava la colpa alla riga di piano.
 * ⚠ Non e' un difetto trovato ragionando: la prima stesura di questo file faceva esattamente cosi', e
 * l'ha preso il test dello SCATTO al primo giro. Un test sulla condizione — «lo stato e' da-coprire?»
 * — sarebbe stato verde.
 *
 * @param a.gambe        le due righe d'ordine costruite da `gambeDiUnaRiga` (portano `book`, non token)
 * @param a.mancanti     i token senza ordine a riposo, da `valutaCopertura`
 * @param a.tokenIdYes   i due token del mercato: sono la tabella di traduzione token → book
 * @param a.tokenIdNo
 */
function gambeDaMandare(a = {}) {
  const gambe = Array.isArray(a.gambe) ? a.gambe : [];
  const mancanti = new Set((Array.isArray(a.mancanti) ? a.mancanti : []).map(norm).filter(Boolean));
  if (!gambe.length || !mancanti.size) return { righe: [], motivo: 'nessuna gamba costruita o nessun token mancante' };

  const y = norm(a.tokenIdYes); const n = norm(a.tokenIdNo);
  // ⚠ SENZA I DUE TOKEN NON SI TRADUCE, E NON SI TIRA A INDOVINARE. Mandare «la gamba no» perche' il
  // token mancante non e' quello yes sarebbe una deduzione su un dato che non si ha: fail-closed.
  if (!y || !n || y === n) {
    return { righe: [], motivo: 'i due token del mercato non sono leggibili o coincidono: non si traduce token → book, e non si manda niente al buio' };
  }
  const booksMancanti = new Set();
  for (const t of mancanti) {
    if (t === y) booksMancanti.add('yes');
    else if (t === n) booksMancanti.add('no');
    // Un token mancante che non e' nessuno dei due: si IGNORA quel token, non si ignora il controllo.
    // Se resta l'unico, `booksMancanti` esce vuoto e il ramo qui sotto rifiuta.
  }
  if (!booksMancanti.size) {
    return { righe: [], motivo: 'i token dichiarati mancanti non appartengono a questo mercato: la riga di piano non lo descrive' };
  }
  const righe = gambe.filter((g) => booksMancanti.has(norm(g && g.book)));
  // ⚠ SE NESSUNA DELLE GAMBE COSTRUITE COPRE I BOOK MANCANTI, NON SI MANDA NIENTE — stessa ragione.
  if (!righe.length) {
    return { righe: [], motivo: `nessuna gamba costruita per il/i book mancante/i (${[...booksMancanti].join('+')}): la riga di piano non li produce` };
  }
  return { righe, motivo: `${righe.length} gamba/e da rimettere su ${gambe.length} costruite (book ${[...booksMancanti].join('+')})` };
}

// ── SELFCHECK ─────────────────────────────────────────────────────────────────────────────────────
function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c, x) => { c ? (p++, console.log(`  ok  ${n}${x ? ' — ' + x : ''}`)) : (f++, console.log(`  NO  ${n}${x ? ' — ' + x : ''}`)); };
  console.log('\n════ ripristino-gambe ════');

  const T = 1_000_000_000;
  const base = { stato: 'da-coprire', mancanti: ['tokA'], ora: T };

  ok('senza memoria si tenta SUBITO', valutaRipristino(base).tenta === true);
  ok('  e la scala parte da zero', attesaMs(0) === 0 && attesaMs(1) === 300_000 && attesaMs(2) === 600_000);
  ok('  il tetto e 30 min e non cresce oltre', attesaMs(4) === 1_800_000 && attesaMs(99) === 1_800_000);

  const m1 = { ultimoTentativo: T - 60_000, fallimenti: 1 };
  ok('dopo 1 fallimento, a 1 minuto NON si tenta', valutaRipristino({ ...base, memoria: m1 }).tenta === false);
  ok('  a 5 minuti esatti si tenta', valutaRipristino({ ...base, memoria: { ultimoTentativo: T - 300_000, fallimenti: 1 } }).tenta === true);
  ok('  a 4:59 ancora no (il confine non si anticipa)',
    valutaRipristino({ ...base, memoria: { ultimoTentativo: T - 299_000, fallimenti: 1 } }).tenta === false);

  ok('sugli altri tre stati non si tenta MAI', ['coperto', 'non-quotabile', 'da-sostituire', 'ignoto']
    .every((s) => valutaRipristino({ ...base, stato: s }).tenta === false));
  ok('nessuna gamba mancante ⇒ non si tenta', valutaRipristino({ ...base, mancanti: [] }).tenta === false);
  ok('lucchetto preso ⇒ non si tenta, e non e un fallimento',
    valutaRipristino({ ...base, lockPreso: true }).tenta === false);
  ok('orologio non leggibile ⇒ non si tenta (Number(null) non diventa 0)',
    valutaRipristino({ ...base, ora: null, memoria: m1 }).tenta === false);
  ok('un ultimoTentativo nel FUTURO fa aspettare, non tentare',
    valutaRipristino({ ...base, memoria: { ultimoTentativo: T + 600_000, fallimenti: 1 } }).tenta === false);

  // memoria
  ok('`coperto` cancella la memoria', memoriaDopo({ stato: 'coperto', memoria: m1, ora: T }) === null);
  ok('un giro senza tentativo non tocca la memoria', memoriaDopo({ stato: 'da-coprire', memoria: m1, ora: T }) === m1);
  const dopoFail = memoriaDopo({ stato: 'da-coprire', memoria: m1, tentato: true, riuscito: false, ora: T });
  ok('un tentativo fallito incrementa i fallimenti', dopoFail.fallimenti === 2 && dopoFail.ultimoTentativo === T);
  const dopoOk = memoriaDopo({ stato: 'da-coprire', memoria: m1, tentato: true, riuscito: true, ora: T });
  ok('un tentativo RIUSCITO non azzera il contatore: lo fa il `coperto` osservato', dopoOk.fallimenti === 1);

  // gambe — ⚠ le righe costruite portano `book`, NON `tokenId`: e' il punto della traduzione.
  const gY = { book: 'yes', side: 'BUY', price: 0.3, size: 60 };
  const gN = { book: 'no', side: 'BUY', price: 0.68, size: 60 };
  const tok = { tokenIdYes: 'tokA', tokenIdNo: 'tokB' };
  const sel = gambeDaMandare({ gambe: [gY, gN], mancanti: ['tokB'], ...tok });
  ok('si manda SOLO la gamba mancante, tradotta in book', sel.righe.length === 1 && sel.righe[0].book === 'no');
  ok('due mancanti ⇒ si mandano entrambe', gambeDaMandare({ gambe: [gY, gN], mancanti: ['tokA', 'tokB'], ...tok }).righe.length === 2);
  ok('un token estraneo al mercato ⇒ ZERO righe (fail-closed)',
    gambeDaMandare({ gambe: [gY, gN], mancanti: ['tokZ'], ...tok }).righe.length === 0);
  ok('senza i due token non si traduce, e non si manda niente',
    gambeDaMandare({ gambe: [gY, gN], mancanti: ['tokB'] }).righe.length === 0);
  ok('  ne se i due token COINCIDONO (la traduzione sarebbe ambigua)',
    gambeDaMandare({ gambe: [gY, gN], mancanti: ['tokA'], tokenIdYes: 'x', tokenIdNo: 'x' }).righe.length === 0);
  ok('il confronto dei token e insensibile a maiuscole e spazi',
    gambeDaMandare({ gambe: [gY, gN], mancanti: [' TOKB '], ...tok }).righe.length === 1);

  // ⚠ IL CONTENIMENTO, PROVATO CON I NUMERI E NON PROMESSO: si simulano 24 ore di cicli a 120 s su un
  // mercato che rifiuta SEMPRE, e si conta quante volte si sarebbe tentato. Senza raffreddamento
  // sarebbero 720. E' l'asserzione che difende la lezione delle 799 ricostruzioni.
  {
    let memoria = null; let tentativi = 0;
    for (let t = 0; t < 24 * 60 * 60_000; t += 120_000) {
      const v = valutaRipristino({ stato: 'da-coprire', mancanti: ['tokA'], ora: t, memoria });
      if (v.tenta) { tentativi++; memoria = memoriaDopo({ stato: 'da-coprire', memoria, tentato: true, riuscito: false, ora: t }); }
    }
    ok('24 h su un mercato che rifiuta sempre: i tentativi restano sotto 60', tentativi < 60, `${tentativi} contro i 720 cicli`);
    ok('  e non e zero: il presidio agisce, non si spegne', tentativi > 10, `${tentativi}`);
  }

  console.log(`\nripristino-gambe selfcheck: ${p} verdi, ${f} rossi`);
  return f === 0;
}

module.exports = { valutaRipristino, memoriaDopo, gambeDaMandare, attesaMs, SCALA_MIN, selfcheck };

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

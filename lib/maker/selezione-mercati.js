'use strict';
// lib/maker/selezione-mercati.js — QUALI MERCATI IL BOT SI SCEGLIE DA SOLO, e quando li lascia.
//
// ═══ IL PROBLEMA CHE CHIUDE ══════════════════════════════════════════════════════════════════════
// Fino a qui la lista dei mercati quotabili (`data/maker-auto-reprice.json`) si riempiva a mano, con
// `scripts/cli/mercati.js aggiungi <conditionId>`. Va bene per una prova, non per un bot che deve
// girare da solo: un mercato scelto a mano invecchia — scade, cambia scaglione, esce dal board — e
// nessuno se ne accorge finche' il capitale non e' gia' fermo.
//
// Questo modulo risponde a UNA domanda e non ad altre: **quali sono i mercati su cui il bot puo'
// quotare adesso**. Non decide quanto capitale mettere (lo fa il knapsack in `lib/rewards/allocator`),
// non decide il prezzo (lo fa `motore-unico`), non piazza e non cancella niente. E' un filtro piu'
// una classifica, ed e' PURO: nessuna lettura di rete, nessun orologio proprio, nessuna scrittura.
//
// ═══ I VINCOLI, E PERCHE' PROPRIO QUESTI — rivisti il 15 agosto 2026 ═════════════════════════════
//   1. `rewardsMinSize <= 50` — era 20. E' lo scaglione piu' ALTO finanziabile: il pavimento premiante
//      di uno scaglione 50 e' $61,25, cioe' esattamente il tetto per mercato di §4.2; uno scaglione 100
//      ne chiederebbe $122,50, oltre il tetto, e sotto `min_incentive_size` il reward non e' piu' basso,
//      e' **ZERO**. Un mercato che non si puo' finanziare fino al pavimento e' capitale fermo.
//   2. **scadenza fra 168 h e il tetto d'orizzonte del piano** — il pavimento vive qui e non in
//      `horizon.js` perche' e' un vincolo DELL'OPERATORE («preferisci scadenze lontane, non i mercati a
//      51 ore»), non il filtro d'orizzonte del piano (0,50 giorni, e resta dov'e'). Il TETTO invece e'
//      quello del piano, INIETTATO da chi chiama: un mercato oltre l'orizzonte dell'allocatore
//      occuperebbe uno slot che nessuno finanziera' mai.
//   3. **niente famiglia meteo** — sono mercati a 24 ore per costruzione (la temperatura di domani),
//      quindi il vincolo 2 li toglie gia' tutti. Il filtro resta lo stesso, ESPLICITO, per due ragioni:
//      un mercato meteo settimanale passerebbe il vincolo 2 senza essere l'esposizione che l'operatore
//      ha chiesto, e una regola che vale «per conseguenza» smette di valere il giorno in cui la
//      conseguenza cambia. ⚠ MISURATO sul board del 15 agosto 2026: toglie **0 righe**, perche' il
//      vincolo 2 le aveva gia' tolte tutte. Va detto invece di lasciar credere che stia lavorando.
//   4. **al piu' 3 mercati contemporaneamente** — non e' un filtro, e' un tetto di esposizione, e per
//      questo si conta sugli SLOT OCCUPATI e non sulle righe della lista: vedi qui sotto.
//   5. **la COMPOSIZIONE: un posto allo scaglione basso, due all'alto, e tre categorie diverse** —
//      non tocca chi e' ammissibile, decide chi entra fra gli ammissibili. Vedi `QUOTA_SCAGLIONI`.
//
// ═══ LA ROTAZIONE — decisione dell'operatore, 15 agosto 2026, e ROVESCIA LA REGOLA PRECEDENTE ════
// Fino a oggi qui c'era scritto l'opposto: «uno slot non si libera alla scadenza ma alla chiusura»,
// perche' il tetto era letto come un tetto di ESPOSIZIONE. L'operatore ha deciso diversamente, e la
// regola nuova e': **il tetto di 3 conta i mercati che QUOTANO, non quelli in cui c'e' capitale.**
//
//   · un mercato che riceve un fill (totale o PARZIALE) esce dal conteggio dei tre **subito**, e
//     contemporaneamente entra un mercato nuovo con la sua liquidita' al pavimento premiante;
//   · quel mercato non sparisce: passa **IN GESTIONE** (`inGestione: true`). Resta nello stato — cosi'
//     non puo' essere riselezionato mentre ci si e' ancora dentro — continua a completare o a mollare
//     la coppia, e non riceve piu' ordini di APERTURA perche' il piano si restringe ai soli attivi;
//   · torna disponibile **solo a coppia chiusa o mollata**, cioe' quando al venue non resta niente.
//
// ⚠ LA CONSEGUENZA VA DETTA, PERCHE' E' IL PREZZO DELLA ROTAZIONE: l'esposizione totale NON e' piu'
// limitata a tre mercati. Tre quotano e N completano, quindi il capitale al lavoro puo' superare i
// $147,00 dei tre pavimenti. Cio' che resta a limitarla e' il tetto per mercato ($61,25), il tetto di
// esposizione aperta di `safety-risk-limits` ($600) e il kill sulla perdita giornaliera ($100).
//
// ⚠ E USCIRE DAI TRE ATTIVI NON SPEGNE L'USCITA: la regola di copertura di §4.8 e' «board ∪ mercati
// dove il capitale e' gia' esposto», quindi uscita automatica, riprezzatura della gamba sorella e
// chiusura forzata continuano a lavorare. Chi cabla questo modulo deve lasciare `setAutoReprice`
// ACCESO sui mercati in gestione, o la sorella morirebbe per scadenza GTD in 23 minuti — cioe' prima
// dei 30 minuti che la scala d'uscita le concede.
//
// ═══ FAIL-CLOSED, NELLE DUE DIREZIONI CHE CONTANO ════════════════════════════════════════════════
// «Non lo so» non e' mai «non c'e'», ed e' il difetto piu' ricorrente di questo repo (`Number(null)`,
// sette occorrenze). Qui si traduce cosi':
//   · **board illeggibile o vuoto** ⇒ NESSUNA decisione. Non si aggiunge (non si sa cosa sia buono) e
//     soprattutto non si TOGLIE: un board che non si legge farebbe sembrare scaduto tutto il mondo, e
//     il bot sfratterebbe i propri mercati sani a ogni singhiozzo dello scanner.
//   · **posizioni non leggibili** ⇒ NESSUNA decisione. Senza lo snapshot non si puo' DIMOSTRARE che
//     una posizione sia chiusa, e liberare uno slot su un'ipotesi e' esattamente il modo di ritrovarsi
//     con tre mercati aperti.
//   · **scadenza non determinabile** ⇒ il mercato e' **escluso**, come in §4.4. Qui il verso e'
//     opposto ai due sopra ed e' voluto: li' l'ignoranza riguarda TUTTO l'insieme e la risposta e' non
//     agire; qui riguarda UN mercato, e non poter leggere quando finisce e' gia' una ragione per non
//     entrarci.
//
// ⚠ QUESTO MODULO NON ACCENDE NIENTE. Restituisce un elenco. Chi lo chiama (agent41) trasforma
// l'elenco in scritture passando dalle STESSE funzioni che usa gia' — `preparaMercatoNuovo` per chi
// entra, `setAutoReprice({enabled:false})` per chi esce — perche' una seconda strada verso la
// allowlist sarebbe una seconda verita' sullo stesso file.

// ── LE COSTANTI, IN UN POSTO SOLO ───────────────────────────────────────────────────────────────
// Non si ricopiano altrove: chi le vuole le importa. Ricopiarle sarebbe il reperto D1 dell'audit —
// due numeri per lo stesso concetto che un giorno divergono in silenzio.
const MIN_SIZE_MASSIMA = 50;                    // scaglione del venue: `rewardsMinSize` ammesso
// ⚠ 20 → 50 il 15 agosto 2026, decisione dell'operatore. Sblocca lo scaglione da 50, il cui pavimento
// premiante e' **$61,25** — cioe' esattamente `TETTO_BASE_USD` di `concentration.js`: non e' una
// coincidenza, il tetto per mercato E' `pavimentoPremiante(50)`. Uno scaglione 100 chiederebbe $122,50
// per mercato, oltre il tetto, e sarebbe capitale fermo: 50 e' il piu' alto finanziabile.

// ⚠ 48 → 168 h (7 giorni) il 15 agosto 2026, decisione dell'operatore: «preferisci scadenze lontane,
// non i mercati a 51 ore». Sul board del 15/08 il taglio e' netto e non e' una scelta di comodo: fra i
// candidati ammissibili le scadenze sono **50 h** (un blocco di 10 mercati Elections) e poi **1.826 h**
// — in mezzo NON cade nessun mercato. La soglia sta nel vuoto fra le due popolazioni, come §5-bis p.140.
//
// ⚠⚠ 168 → 24 h IL 16 AGOSTO 2026, DECISIONE DELL'OPERATORE. La ragione di sopra resta vera e resta
// scritta: e' il motivo per cui questo numero era alto, e va riletto se un giorno lo si rialza.
// COSA HA CAMBIATO LA DECISIONE — simulazione a 168/96/48/24 h sul board vivo (148 righe), piano
// calcolato con `planFromCollection`, cioe' lo stesso pianificatore del processo figlio di agent41:
//   · 168 h · 96 h · 48 h ⇒ risultato IDENTICO: 6 ammissibili (sports 2, economy 2, elections 2), 2
//     scelti, **piano VUOTO**. Fra 48 h e 168 h il board non ha niente: abbassare a 96 o a 48 non
//     cambia un byte, e questa e' la misura che rende 24 l'unico valore con un effetto.
//   · 24 h ⇒ **27 ammissibili** (elections 23), e il piano finanzia la PRIMA riga da giorni.
// LA VARIABILE CHE DECIDE NON E' LA SCADENZA, E' L'AFFOLLAMENTO. A 168 h i due mercati superstiti hanno
// **30.027** e **88.848** share di concorrenza in banda: la nostra quota e' 0,023% e 0,064%, il lordo
// modellato e' $0,00 e $0,04 al giorno, e il netto di uno dei due e' NEGATIVO (−$0,1136/g). Il mercato
// che si sblocca a 24 h ha **320** share di concorrenza: quota **15,15%**, lordo $16,97/g, netto
// **+$8,88/g**. Non e' piu' capitale, e' un libro dove $56 contano qualcosa.
// ⚠ IL PREZZO, MISURATO E ACCETTATO: si passa da orizzonti di 76-137 giorni a **~38 ore**. Rotazione
// molto piu' veloce, piu' cicli di apertura e chiusura, e il tempo per completare la coppia si misura
// in ore invece che in mesi. Restiamo comunque sopra il confine di rischio di §4.4 — sotto le 6 h il
// 35,1% delle uscite arriva dopo la risoluzione, fra 6 e 12 h e' 0/36 — ma il margine si assottiglia,
// e **24 h non e' piu' una soglia che sta nel vuoto**: taglia dentro una popolazione, non fra due.
const ORIZZONTE_MINIMO_ORE = 24;
const ORIZZONTE_MINIMO_MS = ORIZZONTE_MINIMO_ORE * 3_600_000;
// ⚠ 2 → 3 il 15 agosto 2026, decisione dell'operatore. Resta un tetto di ESPOSIZIONE, quindi si conta
// sugli slot occupati e non sulle righe della lista (vedi sotto). A $61,25 di tetto per mercato,
// tre slot pieni valgono al piu' $183,75.
const MAX_MERCATI_CONTEMPORANEI = 3;

// ── LA COMPOSIZIONE CHIESTA: UNO SCAGLIONE BASSO, DUE ALTI ──────────────────────────────────────
// «Uno con minSize 20, due con minSize 50» non e' un filtro — il filtro e' `MIN_SIZE_MASSIMA` e li
// ammette entrambi — e' una QUOTA sulla composizione, e serve a fissare il capitale: un mercato allo
// scaglione 20 chiede $24,50, uno allo scaglione 50 ne chiede $61,25, quindi 1+2 vale **$147,00**.
// Ogni riga cade nel PRIMO secchio il cui `maxMinSize` la contiene, cosi' uno scaglione 30 (che sul
// board non esiste oggi, ma potrebbe) finisce fra gli «alti» e non fra i bassi.
//
// ⚠ NESSUNA SOSTITUZIONE FRA SECCHI, ed e' la scelta prudente sul capitale. Se non ci fosse nessun
// candidato allo scaglione 20, un terzo mercato allo scaglione 50 porterebbe il capitale impegnato da
// $147,00 a $183,75 — cioe' il 25% in piu' di quello che l'operatore ha chiesto, deciso da un ripiego.
// Il posto resta VUOTO e lo si dichiara (`postiNonAssegnati`).
// ⚠⚠ R1 (18 agosto 2026): LA QUOTA SI DERIVA DAL TETTO, NON LO RIDICHIARA.
// Qui c'era `[{basso, posti:1}, {alto, posti:2}]`, cioe' un SECONDO letterale del numero 3. Con il
// tetto diventato configurabile dall'operatore, i due sarebbero divergiti al primo cambio: tetto 2 con
// tre posti di scaglione, o tetto 3 con due. E' il reperto D1 su una decisione di capitale.
//
// LA DERIVAZIONE, e le sue due ragioni:
//   · N ≥ 2 ⇒ **1 basso + (N−1) alti**. E' esattamente la regola dell'operatore a N = 3 («uno con
//     minSize 20, due con minSize 50»), generalizzata invece che abbandonata. Capitale: N = 2 ⇒
//     $24,50 + $61,25 = **$85,75**; N = 3 ⇒ **$147,00**, la cifra decisa.
//   · N = 1 ⇒ **un secchio solo**, quello alto, che ammette tutto fino a `MIN_SIZE_MASSIMA`. Con la
//     regola stretta («1 basso») un unico slot potrebbe ospitare SOLO un mercato con minSize ≤ 20, e
//     se sul board non ce ne fosse nemmeno uno il posto resterebbe vuoto e il bot non quoterebbe
//     niente — una composizione pensata per ripartire il capitale fra tre mercati che, applicata a
//     uno, lo ferma. A N = 1 la composizione non ha nulla da comporre.
//
// ⚠ RESTA VERO CHE NESSUNO SCAGLIONE SI RIEMPIE COL VICINO: `postiNonAssegnati` non e' toccato.
//
// ⚠⚠ E `MAX_MERCATI_CONTEMPORANEI` RESTA IL SOFFITTO, non solo il difetto. Prima la composizione lo
// faceva per caso — la tabella aveva tre posti, quindi `max: 10` ne faceva entrare tre lo stesso — e
// una derivazione ingenua avrebbe trasformato quel caso in dieci mercati aperti. Il clamp rende la
// vecchia protezione ESPLICITA invece di lasciarla dipendere dalla lunghezza di una tabella. E' anche
// il motivo per cui `quanti-mercati.js` non dichiara un massimo proprio: lo importa da qui, o il 3
// tornerebbe a essere scritto due volte per la seconda volta in due giorni.
function quotaScaglioni(max = MAX_MERCATI_CONTEMPORANEI) {
  const n = (fin(max) && max >= 1) ? Math.min(Math.floor(max), MAX_MERCATI_CONTEMPORANEI) : MAX_MERCATI_CONTEMPORANEI;
  if (n <= 1) return Object.freeze([Object.freeze({ chiave: 'alto', maxMinSize: MIN_SIZE_MASSIMA, posti: 1 })]);
  return Object.freeze([
    Object.freeze({ chiave: 'basso', maxMinSize: 20, posti: 1 }),
    Object.freeze({ chiave: 'alto', maxMinSize: MIN_SIZE_MASSIMA, posti: n - 1 }),
  ]);
}

/** La quota al tetto di difetto. Resta esportata perche' i test e la CLI la nominano; chi conosce il
 *  tetto vero deve usare `quotaScaglioni(max)`, non questa. */
const QUOTA_SCAGLIONI = quotaScaglioni(MAX_MERCATI_CONTEMPORANEI);

// ══ L'ISTERESI DELLO SPODESTAMENTO — 16 agosto 2026 ═════════════════════════════════════════════════
// Un occupante viene spodestato solo se lo sfidante lo supera di un margine, MAI per un pelo. Senza
// isteresi due mercati con netto quasi uguale si scambierebbero lo slot a ogni ciclo (120 s), e ogni
// scambio costa un giro di cancellazioni e ripiazzamenti — cioe' il churn che questo bot passa la vita
// a evitare.
//
// IL MARGINE E' IL PIU' GRANDE FRA UN ASSOLUTO E UN RELATIVO, la stessa forma della divergenza sul
// saldo di §4.5 (`max(2%, $5)`), e per la stessa ragione: sotto il mezzo dollaro al giorno la
// differenza sta dentro il rumore del modello, e su un occupante grosso mezzo dollaro sarebbe una
// soglia che non protegge niente.
const SPODESTA_MARGINE_USD_GIORNO = 0.50;
const SPODESTA_MARGINE_FRAZIONE = 0.25;

/**
 * Lo sfidante batte l'occupante abbastanza da giustificare uno scambio?
 *
 * ⚠ SI USA `Math.abs` SUL RELATIVO. Con un occupante a netto NEGATIVO (misurato: «Kane» a −$0,111/g)
 * un `vecchio × 0,25` sarebbe negativo e ABBASSEREBBE l'asticella invece di alzarla — il margine si
 * trasformerebbe in uno sconto proprio nel caso in cui l'occupante e' peggiore.
 *
 * ⚠ UN NETTO CHE NON SI SA NON SPODESTA E NON SI FA SPODESTARE. Se manca il netto dello sfidante non si
 * puo' affermare che sia migliore; se manca quello dell'occupante non si puo' affermare che sia
 * peggiore. In entrambi i casi si lascia tutto com'e': lo scambio e' l'azione, e nel dubbio non si agisce.
 */
function spodestaAbbastanza(nettoNuovo, nettoVecchio) {
  if (!fin(nettoNuovo) || !fin(nettoVecchio)) return false;
  const margine = Math.max(SPODESTA_MARGINE_USD_GIORNO, Math.abs(nettoVecchio) * SPODESTA_MARGINE_FRAZIONE);
  return nettoNuovo > nettoVecchio + margine;
}

/** In quale secchio cade questo `rewardsMinSize`. `null` se non ne esiste uno (⇒ non ammissibile).
 *  ⚠ LA QUOTA E' UN PARAMETRO (R1, 18 agosto 2026): a tetto 1 i secchi sono UNO, e classificare con la
 *  tabella a due secchi manderebbe un mercato da minSize 20 nel secchio `basso`, che a tetto 1 non
 *  esiste — cioe' lo escluderebbe per composizione proprio quando la composizione non ha niente da
 *  comporre. Chi conosce il tetto vero passa la sua quota; il difetto resta quello di prima. */
function scaglioneDi(minSize, quota = QUOTA_SCAGLIONI) {
  if (!fin(minSize) || minSize <= 0) return null;
  for (const b of (Array.isArray(quota) && quota.length ? quota : QUOTA_SCAGLIONI)) {
    if (minSize <= b.maxMinSize) return b.chiave;
  }
  return null;
}

/**
 * LA CATEGORIA, NORMALIZZATA — o `null` se non e' leggibile.
 *
 * ⚠ IL VINCOLO CHE QUESTA CLAUSOLA SERVIVA NON ESISTE PIU' (16 agosto 2026). «Tre categorie diverse»
 * era un vincolo di DIVERSIFICAZIONE, e una categoria non leggibile non poteva essere dimostrata
 * diversa dalle altre: si escludeva. Tolto quel vincolo, la clausola resta come CONTROLLO DI QUALITA'
 * della riga — una riga di board senza categoria e' una riga di cui sappiamo meno del normale — ma non
 * difende piu' niente di strutturale. Misurato sul board vivo del 16/08: esclude **ZERO** mercati su
 * 148, quindi toglierla o tenerla non cambia un solo mercato oggi. E' rimasta per non allargare in
 * silenzio l'insieme ammissibile nello stesso commit che cambia le regole degli slot.
 * La categoria continua a essere SCRITTA nello stato e nel giornale: serve a leggere cosa e' successo,
 * e serve il giorno in cui si volesse rimettere un tetto per categoria.
 */
function categoriaDi(riga) {
  const c = riga && typeof riga.category === 'string' ? riga.category.trim().toLowerCase() : '';
  return c === '' ? null : c;
}

// ── LA FAMIGLIA METEO ───────────────────────────────────────────────────────────────────────────
// ⚠ LE ANCORE `\b` NON SONO UN VEZZO. La prima stesura di questo elenco conteneva `rain` senza ancore
// e classificava come meteo **«Ukraine signs peace deal with Russia before 2027?»** — la sottostringa
// «rain» sta dentro «Ukraine». Due mercati geopolitici sarebbero spariti dall'universo senza che
// nessuna riga di log lo dicesse. Un filtro che sbaglia in silenzio e' peggio di un filtro assente.
const METEO = [
  /\btemperature\b/i, /\bweather\b/i, /\btemp\b/i,
  /\brain(fall|y)?\b/i, /\bsnow(fall|y)?\b/i, /\bhurricane\b/i, /\btyphoon\b/i,
  /\bheat\s?wave\b/i, /\bhighest\s+temp/i, /\blowest\s+temp/i,
  /\d\s*°\s*[cf]\b/i, /\bdegrees\b/i,
];

function testo(riga) {
  if (!riga || typeof riga !== 'object') return '';
  return [riga.question, riga.slug, riga.marketSlug, riga.groupItemTitle, riga.category]
    .filter((x) => typeof x === 'string').join(' § ');
}

/** Vero se la riga appartiene alla famiglia meteo. Guarda testo E categoria: il venue non ha una
 *  categoria «Weather» stabile — sul board del 15 agosto 2026 i meteo finivano in `other`. */
function eMeteo(riga) {
  const t = testo(riga);
  if (!t) return false;
  return METEO.some((re) => re.test(t));
}

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }
function normId(x) { return typeof x === 'string' ? x.trim().toLowerCase() : ''; }

/**
 * UN NUMERO, O `null`. Mai zero per un campo assente.
 *
 * ⚠ QUESTA FUNZIONE ESISTE PERCHE' IL SUO TEST L'HA PRETESA, ed e' l'OTTAVA occorrenza della classe
 * `Number(null) === 0` in questo repo (§5.3). La prima stesura leggeva `Number(riga.rewardsMinSize)`:
 * un campo `null` diventava `0`, `0` e' finito, `0 <= 20` e' vero — e un mercato del quale non si sa
 * quale sia il pavimento premiante veniva dichiarato **il piu' finanziabile di tutti**. Il verso
 * dell'errore e' quello che rassicura, come sempre in questa famiglia.
 */
function numero(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '') {
    const v = Number(x);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

/** La scadenza in millisecondi, o `null` se non e' determinabile. `null` NON diventa mai 0. */
function scadenzaMs(riga) {
  const grezza = riga && (riga.endDate || riga.endDateClob || riga.endDateGamma);
  if (typeof grezza !== 'string' && !(grezza instanceof Date)) return null;
  const t = Date.parse(grezza);
  return Number.isFinite(t) ? t : null;
}

/**
 * I QUATTRO VINCOLI SU UNA RIGA SOLA. Restituisce sempre un motivo leggibile, anche quando ammette:
 * il giornale di domani deve poter dire *perche'* un mercato e' entrato, non solo che e' entrato.
 *
 * L'ordine dei controlli e' quello del costo crescente, ma soprattutto e' quello che rende il motivo
 * piu' utile: «minSize 200» spiega piu' di «scaduto» su un mercato che e' entrambe le cose.
 */
function valutaAmmissibilita(riga, { ora, orizzonteMassimoOre = null, quota = QUOTA_SCAGLIONI,
  bookVivi = null } = {}) {
  const adesso = fin(ora) ? ora : NaN;
  if (!riga || typeof riga !== 'object') {
    return { ammissibile: false, motivo: 'riga-assente', dettaglio: 'nessuna riga di board per questo mercato', oreAllaScadenza: null };
  }
  const id = normId(riga.conditionId);
  if (!id) return { ammissibile: false, motivo: 'senza-conditionId', dettaglio: 'la riga non porta un conditionId', oreAllaScadenza: null };

  // 1 · scaglione del venue
  const ms = numero(riga.rewardsMinSize);
  if (ms === null) {
    return { ammissibile: false, motivo: 'minsize-illeggibile', dettaglio: 'rewardsMinSize non leggibile: non si entra dove non si sa quale sia il pavimento premiante', oreAllaScadenza: null };
  }
  if (ms > MIN_SIZE_MASSIMA) {
    return { ammissibile: false, motivo: 'minsize-oltre-soglia', dettaglio: `rewardsMinSize ${ms} oltre ${MIN_SIZE_MASSIMA}: il pavimento premiante non e' finanziabile con questo capitale`, oreAllaScadenza: null };
  }

  // 2 · orizzonte
  const fine = scadenzaMs(riga);
  if (fine == null) {
    return { ammissibile: false, motivo: 'scadenza-non-determinabile', dettaglio: 'nessuna data di fine leggibile: §4.4 esclude, non indovina', oreAllaScadenza: null };
  }
  const ore = fin(adesso) ? (fine - adesso) / 3_600_000 : null;
  // La riga del board porta gia' il verdetto sulla CONCORDANZA delle due fonti (§4.7). Se il board ha
  // detto che le due scadenze divergono, qui non si prova a rimediare: si esclude.
  if (riga.scadenzaAmmissibile === false) {
    return { ammissibile: false, motivo: 'scadenza-discorde', dettaglio: `il board ha gia' escluso questa scadenza (${riga.scadenzaMotivo || 'motivo non dichiarato'})`, oreAllaScadenza: ore };
  }
  if (!fin(adesso)) {
    return { ammissibile: false, motivo: 'orologio-non-leggibile', dettaglio: 'nessun istante di riferimento: non si giudica una scadenza senza sapere che ora e\'', oreAllaScadenza: null };
  }
  if (fine - adesso < ORIZZONTE_MINIMO_MS) {
    return { ammissibile: false, motivo: 'scadenza-troppo-vicina', dettaglio: `mancano ${ore.toFixed(1)} h alla risoluzione, ne servono ${ORIZZONTE_MINIMO_ORE}`, oreAllaScadenza: ore };
  }
  // ⚠ IL TETTO D'ORIZZONTE E' INIETTATO, NON RICOPIATO. Questo modulo e' puro per costruzione (un test
  // conta i suoi `require` e pretende zero), quindi non puo' importare `MAX_HORIZON_DAYS` da
  // `lib/rewards/horizon.js` — e ricopiarne il valore sarebbe il reperto D1. Chi chiama lo passa da li'.
  // Non passato ⇒ il controllo NON si fa, cioe' il comportamento di prima: chi non cabla una dep ottiene
  // quello di sempre, mai uno nuovo. Serve perche' un mercato oltre l'orizzonte del PIANO occuperebbe
  // uno slot che l'allocatore non finanziera' mai — sul board del 15/08 ce ne sono due a 19.538 h.
  if (fin(orizzonteMassimoOre) && orizzonteMassimoOre > 0 && ore > orizzonteMassimoOre) {
    return { ammissibile: false, motivo: 'scadenza-oltre-orizzonte-piano',
      dettaglio: `${ore.toFixed(0)} h alla risoluzione contro il tetto d'orizzonte del piano (${orizzonteMassimoOre.toFixed(0)} h): l'allocatore non lo finanzierebbe, e lo slot resterebbe fermo`,
      oreAllaScadenza: ore };
  }

  // 3 · famiglia meteo
  if (eMeteo(riga)) {
    return { ammissibile: false, motivo: 'famiglia-meteo', dettaglio: 'famiglia meteo esclusa per decisione dell\'operatore', oreAllaScadenza: ore };
  }

  // ── 4 · IL BOOK DEVE ESSERE VIVO E DATABILE — 18 agosto 2026, decisione dell'operatore ──────────
  //
  // IL FATTO. La sera del 18 il bot ha scelto un mercato la cui sottoscrizione al feed era caduta: il
  // book restava fermo, l'eta' saliva monotona (86s → 98s → 110s → 134s) mentre gli altri 124 mercati
  // erano freschi. Il piazzatore apriva la coppia lo stesso e tre minuti dopo `auto-reprice` la
  // cancellava per `mid-stantio`. Piazza, muore, ripiazza — e ogni giro bruciava uno slot.
  //
  // Non serviva un cancello di PIAZZAMENTO: serviva un cancello di SELEZIONE. Un mercato che non si
  // puo' PREZZARE non si puo' quotare, quindi non deve occupare uno slot — sta accanto al pavimento
  // premiante, alle 24 ore e al meteo, e per la stessa ragione: sono tutte condizioni per cui il
  // mercato non e' utilizzabile, note PRIMA di provarci.
  //
  // ⚠ E' QUESTO che impedisce all'insieme delle tre correzioni di trasformare il churn in immobilita':
  // il gate non lascia lo slot vuoto, lo sposta su uno dei mercati che il feed segue davvero.
  //
  // ⚠ MAPPA ILLEGGIBILE ⇒ CANCELLO NON APPLICATO. Se non si sa la liveness di NESSUNO, escludere tutti
  // svuoterebbe la selezione — cioe' il guasto peggiore di quello che si sta curando. Un mercato
  // SINGOLO assente dalla mappa invece si esclude: li' non e' «non ho letto», e' «il feed non lo
  // segue», ed e' esattamente la condizione da evitare. Stessa asimmetria di §4.4 fra board illeggibile
  // (non si tocca niente) e singola scadenza non determinabile (quel mercato esce).
  // ⚠⚠ CORRETTO LA SERA STESSA IN CUI E' STATO SCRITTO — il criterio era SBAGLIATO.
  //
  // La prima stesura escludeva un mercato con `live !== true`. Ma `live` in agent34 significa «e'
  // arrivato un evento su questo asset negli ultimi 30 s» (`live-book.freshness`), NON «siamo
  // abbonati»: su un libro fermo l'eta' cresce **mentre il quadro memorizzato resta perfetto**, e il
  // commento di quella funzione lo dichiara dal 5 agosto (al picco di 35 s il book coincideva
  // esattamente con la lettura REST).
  //
  // Conseguenza: il gate escludeva i mercati TRANQUILLI — cioe' esattamente quelli che un maker di
  // liquidity rewards vuole, perche' senza selezione avversa gli ordini restano a libro e maturano. E
  // li escludeva a intermittenza, perche' un mercato quieto attraversa la soglia piu' volte all'ora:
  // il churn che questo gate doveva togliere, riprodotto da lui.
  // Misurato: 19% degli asset sono silenziosi in un istante qualunque, e il mercato che sembrava
  // «caduto» e' tornato `live` da solo appena e' arrivato un evento.
  //
  // LA DOMANDA GIUSTA NON E' «ha avuto eventi di recente» MA «il book memorizzato e' utilizzabile».
  //   · `needsResnapshot` ⇒ NO: il libro ha perso il proprio ancoraggio e agent34 lo sa;
  //   · nessun tocco       ⇒ NO: senza bid/ask non c'e' un prezzo da cui partire;
  //   · eta non leggibile  ⇒ NO: non si afferma la freschezza di un dato non databile;
  //   · silenzio           ⇒ SI', purche' il FEED nel suo complesso sia vivo. La distinzione fra
  //     «questo asset tace» e «siamo ciechi» non si fa per asset: la fa `feedVitality`, ed e' il
  //     livello a cui `regimeFeed` gia' la faceva. Se il feed NON e' vivo, allora il silenzio di un
  //     asset torna a essere sospetto e la soglia stretta si applica.
  //
  // ⚠ RESTA UN TETTO ASSOLUTO, e non e' un numero scelto a occhio: `etaMassimaAssolutaMs` vale la GTD.
  // Oltre la vita di un ordine si starebbe quotando su una fotografia piu' vecchia dell'ordine che si
  // sta per piazzare, e quello non e' piu' silenzio: e' un dato che non descrive piu' niente.
  if (bookVivi && bookVivi.leggibile === true) {
    const b = (bookVivi.per && typeof bookVivi.per === 'object') ? bookVivi.per[id] : null;
    if (!b) {
      return { ammissibile: false, motivo: 'book-non-sottoscritto',
        dettaglio: 'il feed non segue questo mercato: non se ne puo leggere il prezzo, quindi non lo si puo quotare', oreAllaScadenza: ore };
    }
    if (b.needsResnapshot === true) {
      return { ammissibile: false, motivo: 'book-da-risincronizzare',
        dettaglio: 'agent34 dichiara che questo book ha perso il proprio ancoraggio (needsResnapshot): il quadro memorizzato non e utilizzabile', oreAllaScadenza: ore };
    }
    if (b.haTocco === false) {
      return { ammissibile: false, motivo: 'book-senza-tocco',
        dettaglio: 'il book non ha ne bid ne ask: non c e un prezzo da cui partire', oreAllaScadenza: ore };
    }
    // ⚠⚠ E NESSUNA SOGLIA DI ETA', DI NESSUN TIPO — decisione dell'operatore.
    // La selezione risponde a UNA domanda: «il book memorizzato e' utilizzabile?». L'eta' non c'entra:
    // un mercato silenzioso da venti minuti con uno snapshot ancorato si quota benissimo, ed e'
    // esattamente il mercato che un maker di rewards vuole. La domanda «siamo ciechi?» e' un'altra e ha
    // un altro posto — `mid-stantio`, che decide se TOGLIERE un ordine gia' a libro, e che la risolve
    // con `feedVitality` invece che col silenzio del singolo asset.
    // Tenere due volte la stessa soglia, qui e li', vorrebbe dire due opinioni sullo stesso fatto.
  }

  // 4 · scaglione e categoria devono essere ENTRAMBI attribuibili, o la composizione non e' verificabile
  const sc = scaglioneDi(ms, quota);
  if (sc === null) {
    return { ammissibile: false, motivo: 'scaglione-non-attribuibile', dettaglio: `rewardsMinSize ${ms} non cade in nessun secchio della quota`, oreAllaScadenza: ore };
  }
  const cat = categoriaDi(riga);
  if (cat === null) {
    return { ammissibile: false, motivo: 'categoria-non-leggibile', dettaglio: 'nessuna categoria leggibile: non si puo\' dimostrare che sia diversa dalle altre due', oreAllaScadenza: ore };
  }

  return { ammissibile: true, motivo: 'ammissibile', scaglione: sc, categoria: cat,
    dettaglio: `minSize ${ms} (${sc}) · ${cat} · ${ore.toFixed(1)} h alla risoluzione`, oreAllaScadenza: ore };
}

/**
 * IL PUNTEGGIO CON CUI SI SCEGLIE FRA DUE MERCATI AMMISSIBILI, e da dove viene.
 *
 * ⚠ NON si ordina per montepremi (`rewardsDailyRate`). E' l'errore misurato in §5 p.132: il montepremi
 * grande vive sugli scaglioni grandi, cioe' esattamente sui mercati che il vincolo 1 ha appena tolto,
 * e fra i superstiti direbbe solo «questo pot e' piu' grosso» senza dire quanto ce ne toccherebbe.
 *
 * Si usa invece la stima che il BOARD HA GIA' CALCOLATO con la formula quadratica del venue:
 * `levels[<capitale>].grossRewardDay`, cioe' il reward giornaliero modellato tenendo conto della
 * concorrenza gia' a libro. E' un numero di agent24, non uno inventato qui — una seconda aritmetica
 * su questa domanda sarebbe il reperto D1.
 *
 * La catena di ripiego e' dichiarata, e ogni gradino dice di essere un ripiego: `grossRewardDay` al
 * livello di capitale piu' BASSO disponibile (il piu' vicino al nostro) → `rateOrdinamento` (l'ordine
 * che agent24 usa gia' per sceglere i 150) → `rewardsDailyRate`. Niente ⇒ punteggio 0: un mercato che
 * non sa dire quanto rende non batte uno che lo sa.
 */
function punteggio(riga) {
  const liv = riga && riga.levels;
  if (liv && typeof liv === 'object') {
    const chiavi = Object.keys(liv).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    for (const k of chiavi) {
      const v = liv[String(k)] || liv[k];
      const g = v ? numero(v.grossRewardDay) : null;
      if (g !== null && g > 0) return { valore: g, fonte: `levels.${k}.grossRewardDay` };
    }
  }
  const ro = riga ? numero(riga.rateOrdinamento) : null;
  if (ro !== null && ro > 0) return { valore: ro, fonte: 'rateOrdinamento (ripiego)' };
  const rd = riga ? numero(riga.rewardsDailyRate) : null;
  if (rd !== null && rd > 0) return { valore: rd, fonte: 'rewardsDailyRate (ripiego)' };
  return { valore: 0, fonte: 'nessuna stima leggibile' };
}

/**
 * IL VALORE DI UN CANDIDATO — IL NETTO DEL KNAPSACK QUANDO C'E', IL LORDO QUANDO NON C'E'.
 *
 * ═══ PERCHE' IL LORDO NON BASTAVA — misurato il 16 agosto 2026 ═══════════════════════════════════════
 * `punteggio()` legge `levels[<capitale minimo>].grossRewardDay`, ed e' sbagliato per noi su TRE assi
 * insieme: e' LORDO (non sottrae il markout), e' calcolato al livello di capitale piu' basso del board
 * — **$500**, otto volte il nostro tetto per mercato — e non vede l'AFFOLLAMENTO, che e' la variabile
 * che decide davvero. Misura sul board vivo: «Kane» prendeva pSel 4,53 (montepremi $136/g) con 29.853
 * share di concorrenza in banda, quota 0,023% e netto **−$0,111/g**; «Eliott Rodriguez FL-27» prendeva
 * pSel 38,2 con **168** share di concorrenza, quota 25,4% e netto **+$10,068/g**. L'ordinamento lordo
 * metteva il primo davanti a mercati che rendono cento volte tanto.
 *
 * ⚠ IL NETTO E' INIETTATO, NON CALCOLATO QUI, E NON PUO' ESSERE ALTRIMENTI. Questo modulo e' PURO
 * (zero `require`, un test li conta e pretende zero) mentre il netto nasce da `planFromCollection`, che
 * gira in un processo figlio e costa secondi. Lo passa il chiamante — `agent41`, che il piano lo calcola
 * gia' — come mappa `id → netto/giorno`.
 *
 * ⚠ FALLBACK DICHIARATO: mappa assente, o mercato non nella mappa, o netto non finito ⇒ si torna a
 * `punteggio()`. Un netto che non si sa NON diventa zero (§5.3), perche' zero e' un valore ordinabile e
 * getterebbe il mercato in fondo alla classifica come se fosse stato misurato male invece che non
 * misurato. `fonte` dice sempre quale delle due strade e' stata presa.
 */
function valoreCandidato(riga, nettoPerMercato) {
  const id = normId(riga && riga.conditionId);
  if (id && nettoPerMercato && typeof nettoPerMercato === 'object') {
    const n = numero(nettoPerMercato[id]);
    if (n !== null) return { valore: n, fonte: 'netto-knapsack', netto: true };
  }
  // ⚠ La `fonte` del ripiego resta ESATTAMENTE quella di `punteggio()`: e' una stringa che finisce nel
  // giornale e che i test confrontano per intero, e allungarla per dire «sono un ripiego» romperebbe
  // asserzioni senza cambiare un comportamento. Chi vuole distinguere le due strade guarda `netto`.
  const p = punteggio(riga);
  return { valore: p.valore, fonte: p.fonte, netto: false };
}

/** Ordina i candidati. Il pareggio si rompe sul conditionId: due giri con lo stesso board devono dare
 *  la stessa risposta, o il bot cambierebbe mercato a ogni ciclo per un pareggio.
 *  ⚠ I candidati con netto MISURATO precedono sempre quelli col solo ripiego lordo: le due grandezze
 *  non sono confrontabili fra loro (un lordo di 38 non e' migliore di un netto di 10), e mescolarle in
 *  un unico ordinamento sarebbe il difetto che questa funzione esiste per togliere. */
function ordinaCandidati(righe, nettoPerMercato = null) {
  return (righe || []).slice().sort((a, b) => {
    const va = valoreCandidato(a, nettoPerMercato), vb = valoreCandidato(b, nettoPerMercato);
    if (va.netto !== vb.netto) return va.netto ? -1 : 1;
    if (vb.valore !== va.valore) return vb.valore - va.valore;
    const da = numero(a.existing_depth_usd), db = numero(b.existing_depth_usd);
    const xa = da === null ? -1 : da, xb = db === null ? -1 : db;
    if (xb !== xa) return xb - xa;
    return normId(a.conditionId) < normId(b.conditionId) ? -1 : 1;
  });
}

/** Lo stato vuoto, cioe' quello di un bot che non ha mai scelto niente. `attiva:false` e' voluto: la
 *  selezione automatica AUTORIZZA capitale su un mercato, e un file che non c'e' non puo' autorizzare. */
function statoVuoto() {
  return { versione: 1, attiva: false, aggiornatoAl: null, selezionati: {} };
}

function normalizzaStato(grezzo) {
  const s = statoVuoto();
  if (!grezzo || typeof grezzo !== 'object') return s;
  s.attiva = grezzo.attiva === true;
  s.aggiornatoAl = fin(grezzo.aggiornatoAl) ? grezzo.aggiornatoAl : null;
  const sel = grezzo.selezionati;
  if (sel && typeof sel === 'object') {
    for (const [k, v] of Object.entries(sel)) {
      const id = normId(k);
      if (!id || !v || typeof v !== 'object') continue;
      s.selezionati[id] = {
        entratoAt: fin(v.entratoAt) ? v.entratoAt : null,
        question: typeof v.question === 'string' ? v.question : null,
        uscenteDal: fin(v.uscenteDal) ? v.uscenteDal : null,
        motivoUscita: typeof v.motivoUscita === 'string' ? v.motivoUscita : null,
        // ── COSA OCCUPA QUESTO SLOT, e perche' si PERSISTE invece di rileggerlo dal board ─────────
        // Uno slot resta occupato finche' c'e' una posizione aperta, e una posizione puo' sopravvivere
        // all'uscita del mercato dal board (§4.8). Rileggendo scaglione e categoria dalla riga di board
        // si perderebbero proprio nel caso in cui servono. Assenti (stato scritto prima del 15 agosto
        // 2026) ⇒ `null`: lo slot conta comunque nel tetto globale, ma non blocca ne' un secchio ne'
        // una categoria — l'unico verso possibile, perche' bloccare su un dato che non c'e' sarebbe
        // inventarlo.
        scaglione: typeof v.scaglione === 'string' && v.scaglione ? v.scaglione : null,
        categoria: typeof v.categoria === 'string' && v.categoria ? v.categoria : null,
        // ── LA ROTAZIONE (15 agosto 2026) ────────────────────────────────────────────────────────
        // `inGestione` = il mercato ha ricevuto un fill e sta completando la coppia. NON occupa piu'
        // uno slot fra i tre attivi, ma non e' nemmeno libero: resta nello stato perche' non deve
        // essere riselezionato mentre ci si sta ancora dentro.
        inGestione: v.inGestione === true,
        inGestioneDal: fin(v.inGestioneDal) ? v.inGestioneDal : null,
      };
    }
  }
  return s;
}

/**
 * LA DECISIONE. Pura: dentro board, stato, posizioni e un istante; fuori un elenco di intenzioni.
 *
 * @param board        array di righe `data/liquidity-rewards.json` (`.markets`), o null se illeggibile
 * @param stato        lo stato persistito (vedi `statoVuoto`)
 * @param posizioni    { leggibile:boolean, conditionIds:string[] } — i mercati con posizione APERTA
 * @param ora          Date.now() del chiamante (mai letto qui dentro: un modulo puro non ha orologio)
 * @param max          tetto di mercati contemporanei; di difetto MAX_MERCATI_CONTEMPORANEI
 * @param escludi      id da non scegliere (quarantena del venue, §5 p.137). Non fa USCIRE nessuno:
 *                     la quarantena dice «non entrarci adesso», non «abbandona quello che hai».
 * @param nettoPerMercato  { [id]: netto $/giorno } dal knapsack — vedi `valoreCandidato`. Assente ⇒ si
 *                     ordina col lordo di `punteggio()` e **non si spodesta nessuno**: senza netto non
 *                     si puo' dimostrare che uno sfidante sia migliore, e lo scambio e' l'azione.
 * @param conOrdiniVivi  { leggibile:boolean, ids:string[] } — i mercati con ordini a riposo al venue.
 *                     ⚠ FAIL-CLOSED: `leggibile:false` ⇒ si assume che TUTTI ne abbiano, quindi nessuno
 *                     viene spodestato. «Non ho guardato» non puo' autorizzare a cancellare ordini vivi.
 */
function decidiSelezione({ board, stato, posizioni, ora, max = MAX_MERCATI_CONTEMPORANEI, escludi = [],
  orizzonteMassimoOre = null, nettoPerMercato = null, conOrdiniVivi = null,
  codaLungaGiorni = null, bookVivi = null } = {}) {
  const S = normalizzaStato(stato);
  // ⚠ R1 · LA QUOTA SI DERIVA DAL TETTO DI QUESTA CHIAMATA, non dalla costante di modulo. E' l'unico
  // modo perche' «quanti mercati» resti UN numero: chi passa `max` ottiene anche la composizione
  // coerente, senza doverla dichiarare una seconda volta e senza poterla dichiarare diversa.
  const quota = quotaScaglioni(max);
  const vuoto = (motivo) => ({
    ok: false, motivo, tenuti: [], uscenti: [], liberati: [], entranti: [],
    occupati: Object.keys(S.selezionati).length, slotLiberi: 0, statoNuovo: S, valutati: 0, ammissibili: 0,
    postiNonAssegnati: [],
  });

  if (!fin(ora)) return vuoto('istante di riferimento non leggibile: non si giudica una scadenza senza orologio');
  if (!Array.isArray(board) || board.length === 0) {
    // ⚠ IL VERSO CHE CONTA: non si TOGLIE niente. Un board illeggibile farebbe sembrare scaduto il
    // mondo intero, e il bot sfratterebbe i propri mercati sani a ogni singhiozzo dello scanner.
    return vuoto('board non leggibile o vuoto: nessun mercato entra e — soprattutto — nessuno esce');
  }
  if (!posizioni || posizioni.leggibile !== true) {
    // Senza snapshot non si puo' DIMOSTRARE che una posizione sia chiusa. Si potrebbe ancora far
    // uscire un mercato dalla lista, ma non liberarne lo slot: e siccome uscire senza liberare non
    // cambia niente per il capitale e complica lo stato, non si fa niente e lo si dichiara.
    return vuoto(`posizioni al venue non leggibili (${(posizioni && posizioni.motivo) || 'motivo non dichiarato'}): nessuno slot si libera su un'ipotesi`);
  }

  const conPosizione = new Set((posizioni.conditionIds || []).map(normId).filter(Boolean));
  const fuori = new Set((escludi || []).map(normId).filter(Boolean));
  const perId = new Map();
  for (const r of board) {
    const id = normId(r && r.conditionId);
    if (id && !perId.has(id)) perId.set(id, r);
  }

  const tenuti = [];
  const uscenti = [];
  const liberati = [];
  const entratiInGestione = [];
  const statoNuovo = { ...S, selezionati: {} };

  // ── 1 · CHI C'E' GIA': resta attivo, passa in gestione, o esce del tutto ──────────────────────
  for (const [id, voce] of Object.entries(S.selezionati)) {
    const riga = perId.get(id) || null;
    const v = valutaAmmissibilita(riga, { ora, orizzonteMassimoOre, quota, bookVivi });
    const nome = voce.question || (riga && riga.question) || null;
    const haPosizione = conPosizione.has(id);

    if (haPosizione) {
      // ══ LA ROTAZIONE ═══════════════════════════════════════════════════════════════════════════
      // Il mercato ha ricevuto un fill (totale o parziale): ha una posizione al venue. Da questo
      // istante ESCE DAL CONTEGGIO DEI TRE ATTIVI e passa IN GESTIONE — continua a completare o a
      // mollare la coppia, non riceve piu' ordini di apertura, e libera il posto per un mercato nuovo.
      // Torna disponibile solo quando al venue non c'e' piu' niente: coppia chiusa, fusa o mollata.
      const nuovo = voce.inGestione !== true;
      if (nuovo) {
        entratiInGestione.push({ id, question: nome, motivo: 'fill-al-venue',
          dettaglio: 'posizione aperta al venue: il mercato esce dai tre attivi e resta in gestione fino a coppia chiusa' });
      }
      statoNuovo.selezionati[id] = {
        ...voce, question: nome,
        inGestione: true,
        inGestioneDal: fin(voce.inGestioneDal) ? voce.inGestioneDal : ora,
        // Se intanto viola anche un vincolo lo si registra, ma non cambia niente: un mercato in
        // gestione non riceve gia' piu' ordini di apertura, quindi non c'e' un ingresso da spegnere.
        uscenteDal: voce.uscenteDal != null ? voce.uscenteDal : (v.ammissibile ? null : ora),
        motivoUscita: voce.motivoUscita != null ? voce.motivoUscita : (v.ammissibile ? null : v.motivo),
      };
      continue;
    }

    if (voce.inGestione === true) {
      // Era in gestione e al venue non c'e' piu' niente: la coppia e' chiusa (o mollata). La voce
      // sparisce e il mercato torna selezionabile dalla porta normale, se sara' ancora il migliore.
      liberati.push({ id, question: nome, motivo: 'coppia-chiusa',
        dettaglio: 'nessuna posizione al venue: la gestione e\' finita e il mercato torna disponibile' });
      continue;
    }

    if (v.ammissibile) {
      // Un mercato tornato ammissibile dopo essere stato dichiarato uscente NON rientra: la decisione
      // di uscire e' gia' stata comunicata alla allowlist, e un rientro automatico farebbe sbattere il
      // mercato dentro e fuori a ogni oscillazione del board.
      if (voce.uscenteDal == null) {
        tenuti.push({ id, question: nome, motivo: v.motivo, dettaglio: v.dettaglio, oreAllaScadenza: v.oreAllaScadenza });
        statoNuovo.selezionati[id] = { ...voce, question: nome };
        continue;
      }
    }

    // Viola un vincolo (o era gia' uscente) e non ha nessuna posizione: esce e il posto e' libero.
    const giaUscente = voce.uscenteDal != null;
    if (!giaUscente) uscenti.push({ id, question: nome, motivo: v.motivo, dettaglio: v.dettaglio });
    liberati.push({ id, question: nome,
      motivo: giaUscente ? voce.motivoUscita : v.motivo,
      dettaglio: giaUscente ? 'gia\' dichiarato uscente in un giro precedente' : v.dettaglio });
  }

  // ⚠ SOLO GLI ATTIVI CONSUMANO UNO SLOT. I mercati in gestione restano nello stato — per non essere
  // riselezionati — ma non contano nel tetto, non occupano un posto di scaglione e non bloccano una
  // categoria: e' esattamente cio' che la rotazione chiede.
  // ⚠ `let` E NON `const`: il vincolo sulla coda lunga (2-bis) puo' liberare un occupante, e allora
  // questi tre vanno RICALCOLATI. Erano `const` e la prima stesura del vincolo se n'era dimenticata:
  // il candidato corto veniva ammesso e poi non trovava lo slot, perche' `slotLiberi` era ancora 0.
  const slotTotali = () => (fin(max) && max > 0 ? Math.floor(max) : MAX_MERCATI_CONTEMPORANEI);
  let attivi = Object.entries(statoNuovo.selezionati).filter(([, v]) => v.inGestione !== true);
  let occupati = attivi.length;
  let slotLiberi = Math.max(0, slotTotali() - occupati);

  // ── 2 · CHI PUO' ENTRARE ──────────────────────────────────────────────────────────────────────
  let ammissibili = 0;
  const candidati = [];
  for (const r of board) {
    const id = normId(r && r.conditionId);
    if (!id) continue;
    const v = valutaAmmissibilita(r, { ora, orizzonteMassimoOre, quota, bookVivi });
    if (!v.ammissibile) continue;
    ammissibili += 1;
    if (statoNuovo.selezionati[id]) continue;   // gia' dentro (attivo o in gestione): non si ri-sceglie
    if (fuori.has(id)) continue;                // in quarantena al venue
    // ⚠ Un mercato con una posizione aperta che NON e' nostra selezione non si adotta: sarebbe il bot
    // che si prende in carico un'esposizione che non ha aperto lui, e con essa uno slot.
    if (conPosizione.has(id)) continue;
    candidati.push(r);
  }

  // ── 2-bis · LA SELEZIONE NON PUO' ESSERE TUTTA CODA LUNGA — 18 agosto 2026 ────────────────────
  //
  // ⚠ IL DEADLOCK CHE CHIUDE, misurato oggi. L'allocatore finanzia la coda lunga (oltre
  // `LONG_TAIL_DAYS`) con una SECONDA passata che riceve `S·q/(1−q)` del budget della fascia CORTA —
  // e §4.4 lo dice per esteso: «fascia corta vuota ⇒ la coda non ottiene niente». Ma la selezione non
  // conosceva quella regola: sceglieva per netto, e con `MAKER_MERCATI_CONTEMPORANEI=1` l'unico slot
  // e' finito su un mercato a **134 giorni**. Il piano e' ristretto alla selezione ⇒ fascia corta
  // VUOTA ⇒ **zero righe, per sempre**, qualunque cosa faccia la scala di sblocco. Il 18 agosto il
  // piano e' rimasto fermo 196 minuti e la scala e' salita al gradino 6 sette volte senza poterlo
  // sciogliere, perche' il blocco non era nello stato del bot: era in due regole che non si parlavano.
  // Stessa forma del deadlock del 13 agosto (§5-bis p.120), su una coppia di moduli diversa.
  //
  // ⚠ LA SOGLIA E' INIETTATA, NON IMPORTATA. Questo modulo e' PURO — zero `require`, e un test lo
  // asserisce — quindi non puo' leggere `horizon.LONG_TAIL_DAYS` da se'. La passa il chiamante, che
  // la importa dall'unica fonte. Assente ⇒ regola NON applicata, cioe' il comportamento di prima:
  // una soglia che non si conosce non puo' diventare un vincolo inventato.
  //
  // ⚠ RESTRINGE I **CANDIDATI**, NON LA SELEZIONE, e la differenza e' stata scritta sbagliata una
  // volta: l'insieme scelto puo' CAMBIARE, non solo rimpicciolirsi — con uno slot solo, escludere il
  // lungo fa entrare un corto che prima non entrava, ed e' proprio lo scopo. Cio' che e' garantito e'
  // che non entrano piu' mercati di prima, e che non si finisce mai con una selezione tutta coda
  // lunga quando un candidato corto era disponibile. Non tocca l'ordinamento e non spodesta nessuno.
  let scartatiPerCodaLunga = [];
  if (fin(codaLungaGiorni) && codaLungaGiorni > 0) {
    const oreCoda = codaLungaGiorni * 24;
    const eCorto = (ore) => fin(ore) && ore <= oreCoda;
    // Un mercato ATTIVO in fascia corta basta a sbloccare la coda: il budget della corta esiste, e la
    // seconda passata avra' da cosa derivare. Si guarda solo agli attivi, perche' i mercati in
    // gestione non ricevono piu' ordini di apertura e quindi non portano budget.
    const cortoGiaAttivo = tenuti.some((t) => eCorto(t.oreAllaScadenza));
    if (!cortoGiaAttivo) {
      const corti = candidati.filter((r) => eCorto(valutaAmmissibilita(r, { ora, orizzonteMassimoOre, quota, bookVivi }).oreAllaScadenza));
      // ⚠ SE NON C'E' NESSUN CANDIDATO CORTO NON SI FA NIENTE, e si dichiara. Svuotare i candidati
      // qui vorrebbe dire preferire ZERO mercati a un mercato che rende poco: sarebbe la stessa
      // aritmetica del deadlock, al contrario. Meglio una selezione che l'allocatore non finanzia —
      // visibile, e che il giro dopo puo' cambiare — di una selezione vuota per costruzione.
      if (corti.length > 0) {
        scartatiPerCodaLunga = candidati
          .filter((r) => !corti.includes(r))
          .map((r) => ({ id: normId(r.conditionId), question: r && r.question ? r.question : null,
            motivo: 'coda-lunga-senza-fascia-corta',
            dettaglio: `oltre ${codaLungaGiorni} g e nessun mercato attivo sotto quella soglia: l'allocatore non avrebbe budget da cui derivare la coda` }));
        candidati.length = 0;
        for (const r of corti) candidati.push(r);

        // ⚠⚠ E SI LIBERA L'OCCUPANTE, O IL VINCOLO NON SERVE A NIENTE. Filtrare i soli candidati
        // lascia il deadlock intatto quando lo slot e' GIA' occupato da un mercato di coda lunga: con
        // `max=1` nessun corto potrebbe mai entrare, perche' non c'e' posto. E' esattamente lo stato
        // in cui il bot si trovava il 18 agosto alle 19:00 — la regola nuova scartava due candidati e
        // il piano restava a zero righe. Misurato sul bot vivo, non dedotto.
        //
        // ⚠ GLI STESSI GUARDIANI DELLO SPODESTAMENTO, non guardiani nuovi:
        //   · un mercato con ORDINI A RIPOSO e' intoccabile — liberarlo significa cancellarglieli, e
        //     un ordine a riposo e' capitale che sta gia' maturando reward;
        //   · FAIL-CLOSED: lista degli ordini non leggibile ⇒ non si libera NESSUNO. Non si toglie
        //     capitale dal libro su un'ipotesi;
        //   · i mercati IN GESTIONE non sono in `attivi`, quindi non sono nemmeno candidabili qui: una
        //     posizione aperta continua a essere gestita, sempre (§4.13).
        const ordiniNoti = !!(conOrdiniVivi && conOrdiniVivi.leggibile === true);
        const conOrdini = new Set(ordiniNoti && Array.isArray(conOrdiniVivi.ids)
          ? conOrdiniVivi.ids.map((x) => normId(x)).filter(Boolean) : []);
        if (ordiniNoti) {
          for (const t of tenuti.slice()) {
            if (eCorto(t.oreAllaScadenza)) continue;      // e' corto: e' lui che sblocca, non si tocca
            if (conOrdini.has(t.id)) continue;            // ha capitale a libro: intoccabile
            const dettaglio = `oltre ${codaLungaGiorni} g, nessun altro mercato attivo sotto quella soglia`
              + ' e un candidato corto disponibile: l\'allocatore non potrebbe finanziare questo slot';
            uscenti.push({ id: t.id, question: t.question, motivo: 'coda-lunga-senza-fascia-corta', dettaglio });
            liberati.push({ id: t.id, question: t.question, motivo: 'coda-lunga-senza-fascia-corta', dettaglio });
            scartatiPerCodaLunga.push({ id: t.id, question: t.question,
              motivo: 'coda-lunga-senza-fascia-corta', dettaglio: `${dettaglio} — era OCCUPANTE, lo slot si libera` });
            delete statoNuovo.selezionati[t.id];
            const i = tenuti.indexOf(t);
            if (i >= 0) tenuti.splice(i, 1);
          }
          // I tre valori dipendono da chi e' rimasto: si rifanno, non si aggiustano a mano.
          attivi = Object.entries(statoNuovo.selezionati).filter(([, v]) => v.inGestione !== true);
          occupati = attivi.length;
          slotLiberi = Math.max(0, slotTotali() - occupati);
        }
      }
    }
  }

  // ── 3 · LA COMPOSIZIONE: UN POSTO PER SECCHIO. LE CATEGORIE NON VINCOLANO PIU' ────────────────
  //
  // ⚠ IL VINCOLO «TRE CATEGORIE DIVERSE» E' STATO TOLTO — decisione dell'operatore, 16 agosto 2026.
  // Costava piu' di quanto proteggesse, ed e' misurato: sul board vivo **23 dei 26 mercati ammissibili
  // sono `elections`**, quindi la diversificazione ne lasciava entrare UNO SOLO e teneva gli altri due
  // slot su `sports` ed `economy` — le uniche due categorie disponibili — cioe' su mercati con 29.853 e
  // 88.881 share di concorrenza in banda, netto **−$0,111/g** e **+$0,026/g**. I due migliori esclusi
  // erano entrambi elections a **+$10,64/g** e **+$1,98/g**: la regola non stava diversificando il
  // rischio, stava scegliendo i mercati peggiori del board perche' erano gli unici di un'altra famiglia.
  // Gli slot possono ora essere tutti della stessa categoria.
  //
  // ⚠ COSA RESTA A LIMITARE LA CONCENTRAZIONE, e va detto perche' una difesa tolta va sostituita o
  // dichiarata assente: il tetto per mercato ($61,25), il numero di slot (3), `maxOpenNotionalUsd`
  // ($150) e il kill sulla perdita giornaliera ($100). NON c'e' piu' nessun limite per SETTORE, quindi
  // tre mercati sulla stessa elezione condividono lo stesso evento risolutivo. E' una conseguenza
  // voluta della decisione, non una svista.
  //
  // ⚠ LA QUOTA PER SECCHIO RESTA (1 basso + 2 alti): non e' stata toccata, ed e' cio' che tiene il
  // capitale a $147 invece di $183,75.
  //
  // ⚠ E SI CONTA SUI SOLI ATTIVI: un mercato in gestione ha gia' liberato il suo posto (la rotazione).
  const postiLiberi = new Map(quota.map((b) => [b.chiave, b.posti]));
  for (const [, voce] of attivi) {
    if (voce.scaglione && postiLiberi.has(voce.scaglione)) {
      postiLiberi.set(voce.scaglione, postiLiberi.get(voce.scaglione) - 1);
    }
  }

  // ── 3-bis · LA RICLASSIFICAZIONE: UN OCCUPANTE PUO' ESSERE SPODESTATO ─────────────────────────
  //
  // ⚠ PRIMA DEL 16 AGOSTO 2026 UN MERCATO ENTRATO NON USCIVA PIU' finche' restava ammissibile: i
  // candidati nuovi competevano solo per gli slot LIBERI. Misurato il costo: «Kane» ed «Fed» erano
  // entrati quando l'orizzonte a 168 h lasciava 6 ammissibili e loro erano fra i migliori di quei 6;
  // abbassata la soglia sono arrivati 20 mercati migliori e **nessuno poteva entrare**, perche' non era
  // previsto che qualcuno uscisse. Stavano al 19° e 22° posto su 26 e tenevano due slot su tre.
  //
  // LE QUATTRO CONDIZIONI, TUTTE NECESSARIE. Nessuna e' un dettaglio: ognuna chiude un modo di
  // trasformare un miglioramento in un danno.
  //   ① il netto di ENTRAMBI dev'essere noto      — senza, non si dimostra che lo scambio migliora;
  //   ② lo sfidante supera l'occupante col MARGINE — `spodestaAbbastanza`, o si oscilla ogni 120 s;
  //   ③ l'occupante NON ha ordini vivi al venue    — spodestarlo significa cancellarglieli, e un ordine
  //      a riposo e' capitale che sta gia' maturando reward. FAIL-CLOSED: lista non leggibile ⇒ si
  //      assume che ne abbia, e non si spodesta nessuno;
  //   ④ l'occupante NON e' in gestione             — una gamba riempita in attesa della sorella non si
  //      abbandona a meta'. Per costruzione un `inGestione` non e' fra gli `attivi`, quindi non e'
  //      nemmeno candidato allo spodestamento: la condizione e' gia' vera, e resta scritta perche' chi
  //      legge deve poterlo verificare senza ricostruire l'invariante.
  //   E lo sfidante deve entrare nello STESSO secchio dell'occupante: uno scambio non deve cambiare in
  //   silenzio la composizione del capitale.
  const entranti = [];
  const spodestati = [];
  const ordiniLeggibili = !!(conOrdiniVivi && conOrdiniVivi.leggibile === true);
  const idsConOrdini = new Set(
    ordiniLeggibili && Array.isArray(conOrdiniVivi.ids)
      ? conOrdiniVivi.ids.map((x) => normId(x)).filter(Boolean) : [],
  );
  const nettoDi = (id) => {
    const n = (nettoPerMercato && typeof nettoPerMercato === 'object') ? numero(nettoPerMercato[normId(id)]) : null;
    return n;
  };
  // Si spodesta solo se il netto e' iniettato: senza, `nettoDi` risponde `null` ovunque e ① blocca tutto.
  if (nettoPerMercato && ordiniLeggibili) {
    // Gli sfidanti sono i candidati ordinati per netto; gli occupanti si guardano dal peggiore in su.
    const sfidanti = ordinaCandidati(candidati, nettoPerMercato)
      .filter((r) => fin(nettoDi(r.conditionId)));
    const occupantiOrdinati = attivi
      .map(([id, voce]) => ({ id, voce, netto: nettoDi(id) }))
      .filter((x) => fin(x.netto))
      .sort((a, b) => a.netto - b.netto);   // il piu' debole per primo

    const giaUsati = new Set();
    for (const occ of occupantiOrdinati) {
      if (idsConOrdini.has(occ.id)) continue;                       // ③ ha ordini a riposo: intoccabile
      if (occ.voce.inGestione === true) continue;                   // ④ ridondante e voluto
      const sf = sfidanti.find((r) => {
        const id = normId(r.conditionId);
        if (giaUsati.has(id) || statoNuovo.selezionati[id]) return false;
        const v = valutaAmmissibilita(r, { ora, orizzonteMassimoOre, quota });
        if (!v.ammissibile || v.scaglione !== occ.voce.scaglione) return false;   // stesso secchio
        return spodestaAbbastanza(nettoDi(id), occ.netto);          // ①②
      });
      if (!sf) continue;
      const idSf = normId(sf.conditionId);
      const v = valutaAmmissibilita(sf, { ora, orizzonteMassimoOre, quota });
      giaUsati.add(idSf);
      delete statoNuovo.selezionati[occ.id];
      liberati.push({ id: occ.id, question: occ.voce.question || null, motivo: 'spodestato',
        dettaglio: `netto ${occ.netto.toFixed(3)}/g contro ${nettoDi(idSf).toFixed(3)}/g dello sfidante,`
          + ` oltre il margine max($${SPODESTA_MARGINE_USD_GIORNO}, ${Math.round(SPODESTA_MARGINE_FRAZIONE * 100)}%)`
          + ' — nessun ordine a riposo, nessuna gamba in attesa di coppia' });
      spodestati.push({ id: occ.id, question: occ.voce.question || null, netto: occ.netto,
        sostituitoDa: idSf, nettoNuovo: nettoDi(idSf), scaglione: occ.voce.scaglione });
      statoNuovo.selezionati[idSf] = { entratoAt: ora, question: sf.question || null, uscenteDal: null,
        motivoUscita: null, scaglione: v.scaglione, categoria: v.categoria,
        inGestione: false, inGestioneDal: null };
      entranti.push({ id: idSf, question: sf.question || null,
        punteggio: nettoDi(idSf), fontePunteggio: 'netto-knapsack (spodestamento)',
        minSize: numero(sf.rewardsMinSize), scaglione: v.scaglione, categoria: v.categoria,
        oreAllaScadenza: v.oreAllaScadenza, riga: sf });
    }
  }

  // ── 3-ter · GLI SLOT ANCORA LIBERI ────────────────────────────────────────────────────────────
  // Si scorre la classifica dall'alto e si SALTA chi non trova posto nel proprio secchio. Un mercato
  // saltato non e' bocciato: sara' il primo il giorno in cui un posto del suo secchio si libera.
  const scartatiPerComposizione = [];
  for (const r of ordinaCandidati(candidati, nettoPerMercato)) {
    if (entranti.length >= slotLiberi + spodestati.length) break;
    const id = normId(r.conditionId);
    if (statoNuovo.selezionati[id]) continue;       // gia' entrato come sfidante in 3-bis
    const v = valutaAmmissibilita(r, { ora, orizzonteMassimoOre, quota });
    if (!v.ammissibile) continue;                                  // non puo' accadere: gia' filtrato
    if (!(postiLiberi.get(v.scaglione) > 0)) {
      scartatiPerComposizione.push({ id, motivo: 'quota-scaglione-piena', scaglione: v.scaglione });
      continue;
    }
    const p = valoreCandidato(r, nettoPerMercato);
    postiLiberi.set(v.scaglione, postiLiberi.get(v.scaglione) - 1);
    statoNuovo.selezionati[id] = { entratoAt: ora, question: r.question || null, uscenteDal: null,
      motivoUscita: null, scaglione: v.scaglione, categoria: v.categoria,
      inGestione: false, inGestioneDal: null };
    entranti.push({ id, question: r.question || null, punteggio: p.valore, fontePunteggio: p.fonte,
      minSize: numero(r.rewardsMinSize), scaglione: v.scaglione, categoria: v.categoria,
      oreAllaScadenza: v.oreAllaScadenza, riga: r });
  }

  // I posti che nessun candidato ha potuto prendere. Si DICHIARANO invece di lasciare che «tre slot,
  // due mercati» sembri un errore di conteggio: e' la regola di non sostituzione che sta lavorando.
  const postiNonAssegnati = [];
  for (const [chiave, resto] of postiLiberi) {
    if (resto > 0) postiNonAssegnati.push({ scaglione: chiave, posti: resto });
  }

  statoNuovo.aggiornatoAl = ora;

  const inGestione = Object.entries(statoNuovo.selezionati)
    .filter(([, v]) => v.inGestione === true)
    .map(([id, v]) => ({ id, question: v.question || null, dal: v.inGestioneDal, scaglione: v.scaglione, categoria: v.categoria }));

  // Gli slot davvero occupati alla fine di tutto: gli in-gestione non contano (la rotazione), e nessun
  // contatore intermedio entra in questo numero.
  const attiviFinali = Object.values(statoNuovo.selezionati).filter((v) => v.inGestione !== true).length;

  return {
    ok: true, motivo: null,
    tenuti, uscenti, liberati, entranti, spodestati, entratiInGestione, inGestione,
    // `occupati` sono gli SLOT, cioe' i soli attivi. Chi vuole quante voci ci sono in tutto guarda
    // `statoNuovo.selezionati`: tenerli distinti e' il punto della rotazione.
    //
    // ⚠ SI DERIVA DALLO STATO FINALE, NON SI SOMMANO I CONTATORI — corretto il 16 agosto 2026.
    // Qui c'era `occupati + entranti.length`, che era giusto finche' un mercato poteva solo ENTRARE:
    // `occupati` e' l'istantanea di PRIMA dello spodestamento e continua a contare chi e' appena
    // uscito, mentre `entranti` contiene gia' chi lo ha sostituito — lo stesso slot contato due volte.
    // Misurato al primo giro con la riclassificazione accesa: **«5/3 slot attivi»** con 2 spodestati e
    // 2 entrati, mentre lo stato su disco ne portava correttamente 3.
    // Contare cio' che C'E' invece di rincorrere cio' che e' cambiato e' la stessa regola di §4.5
    // (`alLavoro` derivato per differenza, mai risommato), e vale per la stessa ragione: una somma di
    // delta e' giusta finche' nessuno inventa un delta nuovo, e prima o poi qualcuno lo fa.
    occupati: attiviFinali,
    slotLiberi: Math.max(0, (fin(max) && max > 0 ? Math.floor(max) : MAX_MERCATI_CONTEMPORANEI) - attiviFinali),
    statoNuovo, valutati: perId.size, ammissibili,
    postiNonAssegnati, scartatiPerComposizione,
    // Chi e' stato tolto dai candidati perche' la selezione sarebbe stata tutta coda lunga. Va a
    // verbale come gli altri scarti: un candidato che sparisce senza una riga e' esattamente il
    // genere di silenzio che oggi e' costato tre volte.
    scartatiPerCodaLunga,
  };
}

module.exports = {
  MIN_SIZE_MASSIMA, ORIZZONTE_MINIMO_ORE, ORIZZONTE_MINIMO_MS, MAX_MERCATI_CONTEMPORANEI,
  QUOTA_SCAGLIONI, quotaScaglioni, scaglioneDi, categoriaDi,
  eMeteo, valutaAmmissibilita, punteggio, valoreCandidato, ordinaCandidati, numero,
  SPODESTA_MARGINE_USD_GIORNO, SPODESTA_MARGINE_FRAZIONE, spodestaAbbastanza,
  statoVuoto, normalizzaStato, decidiSelezione,
};

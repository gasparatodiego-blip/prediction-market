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
const ORIZZONTE_MINIMO_ORE = 168;
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
const QUOTA_SCAGLIONI = Object.freeze([
  Object.freeze({ chiave: 'basso', maxMinSize: 20, posti: 1 }),
  Object.freeze({ chiave: 'alto', maxMinSize: 50, posti: 2 }),
]);

/** In quale secchio cade questo `rewardsMinSize`. `null` se non ne esiste uno (⇒ non ammissibile). */
function scaglioneDi(minSize) {
  if (!fin(minSize) || minSize <= 0) return null;
  for (const b of QUOTA_SCAGLIONI) if (minSize <= b.maxMinSize) return b.chiave;
  return null;
}

/**
 * LA CATEGORIA, NORMALIZZATA — o `null` se non e' leggibile.
 *
 * ⚠ «tre categorie diverse» e' un vincolo di DIVERSIFICAZIONE, e una categoria che non si legge non
 * puo' essere dimostrata diversa da nessun'altra: si esclude quel mercato, con lo stesso verso della
 * scadenza non determinabile (l'ignoranza riguarda UN mercato, e sapere di non sapere e' gia' una
 * ragione per starne fuori). Misurato sul board del 15/08: **117 righe su 117 hanno una categoria**,
 * quindi oggi questa clausola non toglie niente — resta perche' un giorno potrebbe.
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
function valutaAmmissibilita(riga, { ora, orizzonteMassimoOre = null } = {}) {
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

  // 4 · scaglione e categoria devono essere ENTRAMBI attribuibili, o la composizione non e' verificabile
  const sc = scaglioneDi(ms);
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

/** Ordina i candidati. Il pareggio si rompe sul conditionId: due giri con lo stesso board devono dare
 *  la stessa risposta, o il bot cambierebbe mercato a ogni ciclo per un pareggio. */
function ordinaCandidati(righe) {
  return (righe || []).slice().sort((a, b) => {
    const pa = punteggio(a).valore, pb = punteggio(b).valore;
    if (pb !== pa) return pb - pa;
    const da = numero(a.existing_depth_usd), db = numero(b.existing_depth_usd);
    const va = da === null ? -1 : da, vb = db === null ? -1 : db;
    if (vb !== va) return vb - va;
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
 */
function decidiSelezione({ board, stato, posizioni, ora, max = MAX_MERCATI_CONTEMPORANEI, escludi = [],
  orizzonteMassimoOre = null } = {}) {
  const S = normalizzaStato(stato);
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
    const v = valutaAmmissibilita(riga, { ora, orizzonteMassimoOre });
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
  const attivi = Object.entries(statoNuovo.selezionati).filter(([, v]) => v.inGestione !== true);
  const occupati = attivi.length;
  const slotLiberi = Math.max(0, (fin(max) && max > 0 ? Math.floor(max) : MAX_MERCATI_CONTEMPORANEI) - occupati);

  // ── 2 · CHI PUO' ENTRARE ──────────────────────────────────────────────────────────────────────
  let ammissibili = 0;
  const candidati = [];
  for (const r of board) {
    const id = normId(r && r.conditionId);
    if (!id) continue;
    const v = valutaAmmissibilita(r, { ora, orizzonteMassimoOre });
    if (!v.ammissibile) continue;
    ammissibili += 1;
    if (statoNuovo.selezionati[id]) continue;   // gia' dentro (attivo o in gestione): non si ri-sceglie
    if (fuori.has(id)) continue;                // in quarantena al venue
    // ⚠ Un mercato con una posizione aperta che NON e' nostra selezione non si adotta: sarebbe il bot
    // che si prende in carico un'esposizione che non ha aperto lui, e con essa uno slot.
    if (conPosizione.has(id)) continue;
    candidati.push(r);
  }

  // ── 3 · LA COMPOSIZIONE: UN POSTO PER SECCHIO, UNA CATEGORIA A TESTA ──────────────────────────
  //
  // La classifica resta quella di `ordinaCandidati` — cioe' il MONTEPREMI modellato, esattamente come
  // prima. Qui non si riordina niente: si scorre la classifica dall'alto e si SALTA chi non trova
  // posto. Un mercato saltato per composizione non e' un mercato bocciato: e' il secondo migliore
  // della sua categoria, e sara' il primo il giorno in cui il primo esce.
  //
  // ⚠ COSA OCCUPANO GLI SLOT GIA' PIENI. Un occupante con secchio o categoria `null` (stato vecchio,
  // o mercato uscito dal board prima che li scrivessimo) NON blocca niente di specifico. Il tetto che
  // protegge davvero resta quello GLOBALE — `slotLiberi` lo ha gia' contato — e la quota per secchio
  // e la diversificazione modellano solo COME si riempie il resto. Bloccare su un campo assente
  // sarebbe trattare «non l'ho letto» come «e' quello», che e' il difetto di §5.3.
  //
  // ⚠ E SI CONTA SUI SOLI ATTIVI, non su tutto lo stato: un mercato in gestione ha gia' liberato il
  // suo posto e la sua categoria (la rotazione), quindi il sostituto puo' essere del suo stesso
  // scaglione. La diversificazione vale sui TRE CHE QUOTANO — che e' la lettura letterale di «entra
  // un mercato nuovo rispettando il vincolo delle categorie diverse» — e non sull'insieme storico:
  // altrimenti dopo tre rotazioni non resterebbe piu' nessuna categoria disponibile.
  const postiLiberi = new Map(QUOTA_SCAGLIONI.map((b) => [b.chiave, b.posti]));
  const categorieOccupate = new Set();
  for (const [, voce] of attivi) {
    if (voce.scaglione && postiLiberi.has(voce.scaglione)) {
      postiLiberi.set(voce.scaglione, postiLiberi.get(voce.scaglione) - 1);
    }
    if (voce.categoria) categorieOccupate.add(voce.categoria);
  }

  const entranti = [];
  const scartatiPerComposizione = [];
  for (const r of ordinaCandidati(candidati)) {
    if (entranti.length >= slotLiberi) break;
    const id = normId(r.conditionId);
    const v = valutaAmmissibilita(r, { ora, orizzonteMassimoOre });
    if (!v.ammissibile) continue;                                  // non puo' accadere: gia' filtrato
    if (!(postiLiberi.get(v.scaglione) > 0)) {
      scartatiPerComposizione.push({ id, motivo: 'quota-scaglione-piena', scaglione: v.scaglione });
      continue;
    }
    if (categorieOccupate.has(v.categoria)) {
      scartatiPerComposizione.push({ id, motivo: 'categoria-gia-presa', categoria: v.categoria });
      continue;
    }
    const p = punteggio(r);
    postiLiberi.set(v.scaglione, postiLiberi.get(v.scaglione) - 1);
    categorieOccupate.add(v.categoria);
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

  return {
    ok: true, motivo: null,
    tenuti, uscenti, liberati, entranti, entratiInGestione, inGestione,
    // `occupati` sono gli SLOT, cioe' i soli attivi. Chi vuole quante voci ci sono in tutto guarda
    // `statoNuovo.selezionati`: tenerli distinti e' il punto della rotazione.
    occupati: occupati + entranti.length,
    slotLiberi: Math.max(0, slotLiberi - entranti.length),
    statoNuovo, valutati: perId.size, ammissibili,
    postiNonAssegnati, scartatiPerComposizione,
  };
}

module.exports = {
  MIN_SIZE_MASSIMA, ORIZZONTE_MINIMO_ORE, ORIZZONTE_MINIMO_MS, MAX_MERCATI_CONTEMPORANEI,
  QUOTA_SCAGLIONI, scaglioneDi, categoriaDi,
  eMeteo, valutaAmmissibilita, punteggio, ordinaCandidati, numero,
  statoVuoto, normalizzaStato, decidiSelezione,
};

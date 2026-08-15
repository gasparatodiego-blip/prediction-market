'use strict';
// lib/maker/selezione-mercati.js — QUALI MERCATI IL BOT SI SCEGLIE DA SOLO, e quando li lascia.
//
// ═══ IL PROBLEMA CHE CHIUDE ══════════════════════════════════════════════════════════════════════
// Fino a qui la lista dei mercati quotabili (`data/maker-auto-reprice.json`) si riempiva a mano, con
// `scripts/cli/mercati.js aggiungi <conditionId>`. Va bene per una prova, non per un bot che deve
// girare da solo: un mercato scelto a mano invecchia — scade, cambia scaglione, esce dal board — e
// nessuno se ne accorge finche' il capitale non e' gia' fermo.
//
// Questo modulo risponde a UNA domanda e non ad altre: **quali sono i due mercati su cui il bot puo'
// quotare adesso**. Non decide quanto capitale mettere (lo fa il knapsack in `lib/rewards/allocator`),
// non decide il prezzo (lo fa `motore-unico`), non piazza e non cancella niente. E' un filtro piu'
// una classifica, ed e' PURO: nessuna lettura di rete, nessun orologio proprio, nessuna scrittura.
//
// ═══ I QUATTRO VINCOLI, E PERCHE' PROPRIO QUESTI ═════════════════════════════════════════════════
//   1. `rewardsMinSize <= 20` — e' lo scaglione piu' basso del venue, e l'unico alla portata di questo
//      capitale: il pavimento premiante di uno scaglione 20 e' $24,50, quello di uno scaglione 50 e'
//      $61,25 (§4.2). Sotto `min_incentive_size` il reward non e' piu' basso, e' **ZERO**: un mercato
//      che non possiamo finanziare fino al pavimento non e' un mercato piu' povero, e' capitale fermo.
//   2. **scadenza >= 48 ore** — vive qui e non in `horizon.js` perche' e' un vincolo DELL'OPERATORE,
//      non il filtro d'orizzonte del piano (che sta a 0,50 giorni = 12 h e resta dov'e'). Il piu'
//      stretto dei due vince per costruzione: questo modulo sceglie l'universo, l'allocatore filtra
//      di nuovo dentro quell'universo.
//   3. **niente famiglia meteo** — sono mercati a 24 ore per costruzione (la temperatura di domani),
//      quindi il vincolo 2 li toglie gia' tutti. Il filtro resta lo stesso, ESPLICITO, per due ragioni:
//      un mercato meteo settimanale passerebbe il vincolo 2 senza essere l'esposizione che l'operatore
//      ha chiesto, e una regola che vale «per conseguenza» smette di valere il giorno in cui la
//      conseguenza cambia. ⚠ MISURATO sul board del 15 agosto 2026: toglie **0 righe su 143**, perche'
//      il vincolo 2 le aveva gia' tolte tutte. Va detto invece di lasciar credere che stia lavorando.
//   4. **al piu' 2 mercati contemporaneamente** — non e' un filtro, e' un tetto di esposizione, e per
//      questo si conta sugli SLOT OCCUPATI e non sulle righe della lista: vedi qui sotto.
//
// ═══ LA REGOLA CHE COSTA PIU' DI QUANTO SEMBRI: UNO SLOT NON SI LIBERA ALLA SCADENZA ═════════════
// «Se un mercato scade o esce dai vincoli, esce dalla lista e viene sostituito solo dopo che le sue
// posizioni sono chiuse.» Sono DUE momenti distinti e vanno tenuti distinti, o si apre un buco:
//
//   · **esce dalla lista** subito, appena viola un vincolo. Vuol dire che il bot non apre piu' niente
//     li' sopra. Non vuol dire che lo abbandona: la regola di copertura di §4.8 e' «board ∪ mercati
//     dove il capitale e' gia' esposto», quindi uscita automatica, riprezzatura e chiusura forzata
//     continuano a lavorare sulla posizione aperta. Togliere dalla lista SPEGNE l'ingresso, non l'uscita.
//   · **libera lo slot** solo quando al venue non c'e' piu' nessuna posizione su quel mercato.
//
// Se lo slot si liberasse subito, il bot aprirebbe il terzo mercato mentre il secondo ha ancora
// capitale dentro: il tetto direbbe 2 e l'esposizione vera sarebbe 3. Il tetto e' sull'esposizione, e
// l'esposizione finisce quando finisce la posizione — non quando finisce l'interesse.
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
const MIN_SIZE_MASSIMA = 20;                    // scaglione del venue: `rewardsMinSize` ammesso
const ORIZZONTE_MINIMO_ORE = 48;
const ORIZZONTE_MINIMO_MS = ORIZZONTE_MINIMO_ORE * 3_600_000;
const MAX_MERCATI_CONTEMPORANEI = 2;

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
function valutaAmmissibilita(riga, { ora } = {}) {
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

  // 3 · famiglia meteo
  if (eMeteo(riga)) {
    return { ammissibile: false, motivo: 'famiglia-meteo', dettaglio: 'famiglia meteo esclusa per decisione dell\'operatore', oreAllaScadenza: ore };
  }

  return { ammissibile: true, motivo: 'ammissibile', dettaglio: `minSize ${ms} · ${ore.toFixed(1)} h alla risoluzione`, oreAllaScadenza: ore };
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
function decidiSelezione({ board, stato, posizioni, ora, max = MAX_MERCATI_CONTEMPORANEI, escludi = [] } = {}) {
  const S = normalizzaStato(stato);
  const vuoto = (motivo) => ({
    ok: false, motivo, tenuti: [], uscenti: [], liberati: [], entranti: [],
    occupati: Object.keys(S.selezionati).length, slotLiberi: 0, statoNuovo: S, valutati: 0, ammissibili: 0,
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
  const statoNuovo = { ...S, selezionati: {} };

  // ── 1 · CHI C'E' GIA': resta, esce, o libera lo slot ──────────────────────────────────────────
  for (const [id, voce] of Object.entries(S.selezionati)) {
    const riga = perId.get(id) || null;
    const v = valutaAmmissibilita(riga, { ora });
    const haPosizione = conPosizione.has(id);

    if (v.ammissibile) {
      // Un mercato tornato ammissibile dopo essere stato dichiarato uscente NON rientra: la decisione
      // di uscire e' gia' stata comunicata alla allowlist, e un rientro automatico farebbe sbattere il
      // mercato dentro e fuori a ogni oscillazione del board. Resta uscente finche' lo slot non si
      // libera, e poi rientrera' — se sara' ancora il migliore — dalla porta normale.
      if (voce.uscenteDal == null) {
        tenuti.push({ id, question: voce.question || (riga && riga.question) || null, motivo: v.motivo, dettaglio: v.dettaglio, oreAllaScadenza: v.oreAllaScadenza });
        statoNuovo.selezionati[id] = { ...voce, question: voce.question || (riga && riga.question) || null };
        continue;
      }
    }

    // Viola un vincolo (o era gia' uscente): esce dalla lista adesso, se non ne era gia' uscito.
    const giaUscente = voce.uscenteDal != null;
    const motivo = giaUscente ? voce.motivoUscita : v.motivo;
    const dettaglio = giaUscente ? 'gia\' dichiarato uscente in un giro precedente' : v.dettaglio;
    if (!giaUscente) {
      uscenti.push({ id, question: voce.question || (riga && riga.question) || null, motivo: v.motivo, dettaglio: v.dettaglio });
    }

    if (haPosizione) {
      // LO SLOT RESTA OCCUPATO. E' la meta' della regola che si dimentica: il mercato non riceve piu'
      // ordini nuovi, ma il capitale e' ancora li' dentro e il tetto e' sull'esposizione.
      statoNuovo.selezionati[id] = {
        ...voce,
        question: voce.question || (riga && riga.question) || null,
        uscenteDal: giaUscente ? voce.uscenteDal : ora,
        motivoUscita: motivo,
      };
    } else {
      // Nessuna posizione al venue: adesso lo slot e' davvero libero e la voce sparisce dallo stato.
      liberati.push({ id, question: voce.question || (riga && riga.question) || null, motivo, dettaglio });
    }
  }

  const occupati = Object.keys(statoNuovo.selezionati).length;
  const slotLiberi = Math.max(0, (fin(max) && max > 0 ? Math.floor(max) : MAX_MERCATI_CONTEMPORANEI) - occupati);

  // ── 2 · CHI PUO' ENTRARE ──────────────────────────────────────────────────────────────────────
  let ammissibili = 0;
  const candidati = [];
  for (const r of board) {
    const id = normId(r && r.conditionId);
    if (!id) continue;
    const v = valutaAmmissibilita(r, { ora });
    if (!v.ammissibile) continue;
    ammissibili += 1;
    if (statoNuovo.selezionati[id]) continue;   // gia' dentro, o uscente che occupa ancora lo slot
    if (fuori.has(id)) continue;                // in quarantena al venue
    // ⚠ Un mercato con una posizione aperta che NON e' nostra selezione non si adotta: sarebbe il bot
    // che si prende in carico un'esposizione che non ha aperto lui, e con essa uno slot.
    if (conPosizione.has(id)) continue;
    candidati.push(r);
  }

  const entranti = ordinaCandidati(candidati).slice(0, slotLiberi).map((r) => {
    const id = normId(r.conditionId);
    const p = punteggio(r);
    const v = valutaAmmissibilita(r, { ora });
    statoNuovo.selezionati[id] = { entratoAt: ora, question: r.question || null, uscenteDal: null, motivoUscita: null };
    return { id, question: r.question || null, punteggio: p.valore, fontePunteggio: p.fonte,
      minSize: numero(r.rewardsMinSize), oreAllaScadenza: v.oreAllaScadenza, riga: r };
  });

  statoNuovo.aggiornatoAl = ora;

  return {
    ok: true, motivo: null,
    tenuti, uscenti, liberati, entranti,
    occupati: Object.keys(statoNuovo.selezionati).length,
    slotLiberi: Math.max(0, slotLiberi - entranti.length),
    statoNuovo, valutati: perId.size, ammissibili,
  };
}

module.exports = {
  MIN_SIZE_MASSIMA, ORIZZONTE_MINIMO_ORE, ORIZZONTE_MINIMO_MS, MAX_MERCATI_CONTEMPORANEI,
  eMeteo, valutaAmmissibilita, punteggio, ordinaCandidati, numero,
  statoVuoto, normalizzaStato, decidiSelezione,
};

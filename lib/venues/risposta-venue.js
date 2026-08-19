'use strict';
// lib/venues/risposta-venue.js — «questa risposta del venue e' una lettura, o non ho letto?»
//
// PURO: zero `require`. Una domanda sola, una risposta sola, importata da entrambi gli adapter
// Polymarket (quello di piazzamento e quello di sola cancellazione) invece di essere ricopiata —
// il reperto D1 qui non e' un fastidio estetico: due copie che divergono decidono se il KILL
// crede di aver finito.
//
// ── PERCHE' ESISTE ────────────────────────────────────────────────────────────────────────────────
// L'SDK (`@polymarket/clob-client` e `-v2`, entrambi installati e entrambi in uso) NON solleva su un
// errore HTTP quando `throwOnError` e' spento — ed e' spento, perche' nessuno dei due client viene
// costruito con quel campo. `http-helpers/errorHandling` trasforma la risposta di errore in un
// OGGETTO NORMALE `{ error, status }` e lo restituisce come se fosse il corpo. Da li' in poi:
//
//   ① IN LETTURA  `getOpenOrders` fa `results = [...results, ...response.data]` (v1 client.js:553,
//      v2 client.js:515). Su `{error,status}` `response.data` e' `undefined` e lo spread SOLLEVA
//      `response.data is not iterable` — che e' il messaggio visto per un'ora il 19 agosto, e che
//      NON contiene ne' lo status ne' il corpo. Un'ora di guasto non ha lasciato una prova.
//      E quando invece lo spread riesce su una forma inattesa, l'adapter faceva
//      `Array.isArray(res) ? res : (res && Array.isArray(res.data) ? res.data : [])`:
//      **una forma che non si capisce diventava una lista VUOTA, con `ok:true`.**
//      «Non ho letto» presentato come «non c'e' niente» — la classe di difetto piu' ricorrente di
//      questo repo (§5.3, `Number(null) === 0`), qui applicata all'elenco degli ordini a libro.
//
//   ② IN CANCELLAZIONE  `cancelMarketOrders` non solleva affatto: l'adapter riceveva `{error,status}`
//      e rispondeva `ok: true, sent: true`. **Il KILL poteva dire «fatto» su una cancellazione che il
//      venue aveva rifiutato.** Il percorso di PIAZZAMENTO aveva gia' questa difesa (v. il commento
//      «HONESTY AT THE VENUE BOUNDARY» in `polymarket-clob-maker/adapter.js`), il percorso di
//      cancellazione no: la classe «protezione presente su un percorso e assente sul gemello».
//
// ── LA DIREZIONE DI FALLIMENTO, DICHIARATA ───────────────────────────────────────────────────────
// Tutto qui dentro FALLISCE CHIUSO: nel dubbio la risposta e' «non ho letto», mai «non c'e' niente».
// Costa una lettura mancata; l'errore opposto costa il capitale di cui si e' persa la traccia.

// Le cause, nominate: un chiamante che le distingue puo' reagire diversamente, e il giornale le conta.
const CAUSE = Object.freeze({
  ERRORE_VENUE: 'errore-venue',       // il venue ha risposto, e la risposta e' un errore
  FORMA_INATTESA: 'forma-inattesa',   // ha risposto qualcosa che non e' la lista attesa
  RISPOSTA_ASSENTE: 'risposta-assente', // non c'e' proprio una risposta (null/undefined)
});

// Quante chiavi e quanti caratteri si conservano di una risposta che non si e' capita. Serve a
// riconoscerla la prossima volta, non a ricostruirla: il giornale non e' un archivio del venue.
const MAX_CHIAVI = 20;
const MAX_CAMPIONE = 400;

/**
 * LA FORMA DI CIO' CHE E' ARRIVATO — cioe' la cattura del corpo grezzo.
 * Non giudica: descrive. E' quello che mancava il 19 agosto, quando dell'ora di guasto e' rimasto
 * soltanto «response.data is not iterable» e nessuna traccia di cosa avesse risposto il venue.
 * ⚠ Il campione va passato allo scrubber del chiamante (`redact`/`scrubString`) prima di finire a
 *   verbale: qui non si importa niente, nemmeno la redazione.
 */
function descriviForma(x, { maxCampione = MAX_CAMPIONE, maxChiavi = MAX_CHIAVI } = {}) {
  const forma = { tipo: x === null ? 'null' : typeof x, array: Array.isArray(x) };
  if (Array.isArray(x)) forma.lunghezza = x.length;
  if (typeof x === 'string') {
    forma.lunghezza = x.length;
    forma.campione = x.slice(0, maxCampione);
    return forma;
  }
  if (x && typeof x === 'object') {
    let chiavi = [];
    try { chiavi = Object.keys(x); } catch { chiavi = []; }
    forma.chiavi = chiavi.slice(0, maxChiavi);
    if (chiavi.length > maxChiavi) forma.chiaviOltre = chiavi.length - maxChiavi;
    // Lo status e il messaggio si estraggono a parte perche' sono i due campi da cui si capisce
    // subito se e' stato il venue a rifiutare o noi a chiedere male.
    const st = Number(x.status);
    if (Number.isFinite(st)) forma.status = st;
  }
  try { forma.campione = String(JSON.stringify(x)).slice(0, maxCampione); }
  catch { forma.campione = '(non serializzabile)'; }
  return forma;
}

/**
 * E' UN ERRORE DEL VENUE?
 * Tre segnali, e basta uno: un campo `error` valorizzato, `success === false`, o uno status >= 400.
 * ⚠ `error: null` NON e' un errore — alcune risposte buone portano il campo a null, e trattarlo come
 *   errore renderebbe illeggibile una lettura sana (fallimento nella direzione sbagliata: chiuso, si',
 *   ma su un caso normale, che e' come si costruisce un bot che non fa mai niente).
 * ⚠ Lo status si guarda solo se e' FINITO: `Number(undefined)` e' NaN e non deve valere 0 ne' 500.
 */
function erroreDelVenue(res) {
  if (res === null || res === undefined) {
    return { errore: true, causa: CAUSE.RISPOSTA_ASSENTE, status: null, messaggio: 'nessuna risposta dal venue' };
  }
  if (typeof res !== 'object') return { errore: false, causa: null, status: null, messaggio: null };
  const st = Number(res.status);
  const status = Number.isFinite(st) ? st : null;
  const httpErrore = status !== null && status >= 400;
  const campoErrore = res.error !== null && res.error !== undefined;
  const successoFalso = res.success === false;
  if (!httpErrore && !campoErrore && !successoFalso) {
    return { errore: false, causa: null, status, messaggio: null };
  }
  let messaggio;
  if (campoErrore) messaggio = typeof res.error === 'string' ? res.error : safeStringify(res.error);
  else if (httpErrore) messaggio = `HTTP ${status}`;
  else messaggio = 'il venue ha risposto success:false';
  if (httpErrore && campoErrore) messaggio = `HTTP ${status}: ${messaggio}`;
  return { errore: true, causa: CAUSE.ERRORE_VENUE, status, messaggio };
}

/**
 * LA LISTA, O IL MOTIVO PER CUI NON C'E'.
 * Accetta le due forme che il venue usa davvero: l'array nudo (quando l'SDK ha gia' impaginato) e
 * l'oggetto con il campo (`data` per gli ordini, `data` per le posizioni della data-api).
 *
 * @returns {{ok:true, lista:Array}} oppure {{ok:false, causa, status, messaggio, forma}}
 *
 * ⚠ UN ARRAY VUOTO E' UNA LETTURA BUONA. La differenza fra «zero ordini» e «non ho letto» e' proprio
 *   questa funzione: `{data: []}` ⇒ `ok:true, lista:[]`. Chi confonde i due casi e' il difetto.
 */
function listaDaRisposta(res, campi = ['data']) {
  const err = erroreDelVenue(res);
  if (err.errore) {
    return { ok: false, causa: err.causa, status: err.status, messaggio: err.messaggio, forma: descriviForma(res) };
  }
  if (Array.isArray(res)) return { ok: true, lista: res };
  if (res && typeof res === 'object') {
    for (const c of campi) {
      if (Array.isArray(res[c])) return { ok: true, lista: res[c] };
    }
  }
  return {
    ok: false, causa: CAUSE.FORMA_INATTESA, status: err.status, forma: descriviForma(res),
    messaggio: `risposta del venue senza lista: attesi un array oppure ${campi.map((c) => `\`${c}\``).join(' / ')}`,
  };
}

/**
 * L'ESITO DI UNA CANCELLAZIONE, letto dalla risposta invece che dedotto dal fatto che non ha sollevato.
 * Non decide da solo il caso benigno «l'ordine non c'era gia' piu'»: quello lo riconosce
 * `isAlreadyGone` sul MESSAGGIO, che vive in ciascun adapter perche' e' un elenco di stringhe del
 * venue, non un'aritmetica. Qui si dice soltanto: e' un errore, e cosa diceva.
 *
 * ⚠ `nonCancellati` si DICHIARA e non cambia `ok`: il venue elenca in `not_canceled` anche gli ordini
 *   che nel frattempo si erano riempiti, e trattarli come un fallimento renderebbe rosso un KILL
 *   riuscito. Ma tacerli significherebbe dire «cancellati 3» quando erano 5 — quindi si contano.
 */
function esitoCancellazione(res) {
  const err = erroreDelVenue(res);
  const corpo = res && typeof res === 'object' ? res : {};
  const cancellati = Array.isArray(corpo.canceled) ? corpo.canceled.length
    : Array.isArray(corpo.cancelled) ? corpo.cancelled.length : null;
  let nonCancellati = null;
  const nc = corpo.not_canceled !== undefined ? corpo.not_canceled : corpo.notCanceled;
  if (Array.isArray(nc)) nonCancellati = nc.length;
  else if (nc && typeof nc === 'object') { try { nonCancellati = Object.keys(nc).length; } catch { nonCancellati = null; } }
  return {
    ok: !err.errore,
    status: err.status,
    messaggio: err.messaggio,
    cancellati,
    nonCancellati,
    forma: err.errore ? descriviForma(res) : null,
  };
}

/**
 * CIO' CHE RESTA DI UN'ECCEZIONE — status e corpo compresi, quando ci sono.
 * `safeError` conserva il solo `message`, ed e' il motivo per cui del guasto del 19 agosto non e'
 * rimasto niente: `ApiError` porta `.status` e `.data` (il corpo intero), gli errori axios portano
 * `.response.status` e `.response.data`, e tutto questo veniva buttato via un carattere prima.
 * ⚠ Il chiamante deve passare il risultato allo scrubber prima di scriverlo.
 */
function dettagliErrore(e) {
  const d = { nome: e && e.name ? String(e.name) : null };
  const st = Number(e && (e.status !== undefined ? e.status : (e.response && e.response.status)));
  if (Number.isFinite(st)) d.status = st;
  const corpo = e && (e.data !== undefined ? e.data : (e.response ? e.response.data : undefined));
  if (corpo !== undefined) d.corpo = descriviForma(corpo);
  return d;
}

function safeStringify(x) {
  try { return String(JSON.stringify(x)).slice(0, MAX_CAMPIONE); } catch { return '(non serializzabile)'; }
}

module.exports = { CAUSE, descriviForma, erroreDelVenue, listaDaRisposta, esitoCancellazione, dettagliErrore };

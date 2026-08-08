'use strict';
// lib/maker/backoff-venue.js — QUANDO IL VENUE DICE «RALLENTA», E QUANDO NON SI SA COS'È SUCCESSO.
//
// ═══ DUE PROBLEMI DIVERSI, E VANNO TENUTI DIVERSI ═══════════════════════════════════════════════════
//
// 1 · IL RATE LIMIT. Un 429 significa una cosa sola: stai andando troppo veloce. L'attesa che c'era —
//     250 ms, poi 500, poi 1000 — è un backoff nella forma ma non nella sostanza: un venue che ti ha
//     appena detto di rallentare vede la richiesta successiva un quarto di secondo dopo. E il 429 porta
//     spesso `Retry-After`, cioè il venue dice ESATTAMENTE quanto aspettare: ignorarlo per usare una
//     progressione inventata è preferire una supposizione a un dato.
//
// 2 · L'ESITO AMBIGUO. Un timeout o un 5xx DOPO che la POST è partita non è un fallimento: è
//     un'incognita. L'ordine può essere a riposo al venue. Ritentarlo è il modo classico di ritrovarsi
//     due ordini da un'intenzione sola — e su questo venue due ordini sono due volte il capitale.
//     La regola: prima di ritentare si GUARDA, e si ritenta solo se il venue dice che non c'è niente.
//
// ═══ PERCHÉ IN UN MODULO PURO ═══════════════════════════════════════════════════════════════════════
// Le due decisioni — quanto aspettare, e se si può ritentare — sono aritmetica e classificazione: non
// hanno bisogno di rete per essere prese, e averle qui significa poterle provare ai confini esatti
// senza un venue. Chi chiama fa l'unica cosa che richiede il mondo esterno: la lettura di verifica.
//
// PURO: nessuna rete, nessun file, nessuno stato.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** La base del backoff per un errore TRANSITORIO che non è un rate limit (5xx). Invariata: 250 ms. */
const BASE_TRANSITORIO_MS = 250;
/**
 * La base per un 429, e il salto rispetto ai 5xx è voluto. Un 5xx è «il venue ha singhiozzato»: si
 * riprova quasi subito. Un 429 è «sei tu che stai esagerando»: ripartire dopo un quarto di secondo
 * significa ripresentarsi con la stessa velocità che ha causato il rifiuto. Un secondo di base, che
 * raddoppia, dà 1 s → 2 s → 4 s: abbastanza da uscire davvero dalla finestra del limitatore.
 */
const BASE_RATE_LIMIT_MS = 1_000;
/** Il tetto: oltre, non si sta più facendo backoff, si sta abbandonando il ciclo. */
const ATTESA_MAX_MS = 30_000;

/**
 * QUANTO ASPETTARE PRIMA DEL PROSSIMO TENTATIVO.
 *
 * `Retry-After` VINCE su qualunque progressione: è il venue che dice quanto vuole aspettare, e una
 * nostra formula non può saperlo meglio di lui. Si accetta sia in secondi (il formato comune) sia come
 * data HTTP. Resta comunque limitato da `ATTESA_MAX_MS`: un `Retry-After` di un'ora non deve
 * congelare un ciclo che sorveglia capitale.
 *
 * @param {object} a
 *   tentativo      il numero del tentativo che sta per partire (1 = il primo ritentativo)
 *   status         lo status HTTP che ha causato l'attesa
 *   retryAfter     il valore grezzo dell'header, se c'è (secondi o data)
 *   now            per rendere verificabile il formato data
 * @returns {{attesaMs:number, fonte:'retry-after'|'rate-limit'|'transitorio', motivo:string}}
 */
function attesaBackoff({ tentativo = 1, status = null, retryAfter = null, now = Date.now(),
  baseTransitorioMs = BASE_TRANSITORIO_MS, baseRateLimitMs = BASE_RATE_LIMIT_MS, maxMs = ATTESA_MAX_MS } = {}) {
  const n = fin(tentativo) && tentativo >= 1 ? Math.floor(tentativo) : 1;
  const limita = (ms) => Math.min(maxMs, Math.max(0, Math.round(ms)));

  const dallHeader = leggiRetryAfter(retryAfter, now);
  if (dallHeader != null) {
    return { attesaMs: limita(dallHeader), fonte: 'retry-after',
      motivo: `il venue ha chiesto di aspettare ${(dallHeader / 1000).toFixed(1)}s (Retry-After): si obbedisce invece di indovinare`
        + (dallHeader > maxMs ? `, limitato a ${maxMs / 1000}s perché un ciclo che sorveglia capitale non può congelarsi più a lungo` : '') };
  }
  if (status === 429) {
    return { attesaMs: limita(baseRateLimitMs * 2 ** (n - 1)), fonte: 'rate-limit',
      motivo: `rate limit senza Retry-After: attesa progressiva dal secondo (tentativo ${n})` };
  }
  return { attesaMs: limita(baseTransitorioMs * 2 ** (n - 1)), fonte: 'transitorio',
    motivo: `errore transitorio (${status == null ? 'status ignoto' : status}): attesa breve e progressiva (tentativo ${n})` };
}

/** `Retry-After` in millisecondi: secondi interi o data HTTP. Illeggibile ⇒ null, mai zero. */
function leggiRetryAfter(raw, now = Date.now()) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) { const v = Number(s); return fin(v) && v >= 0 ? v * 1000 : null; }
  const t = Date.parse(s);
  if (!fin(t)) return null;
  return Math.max(0, t - now);
}

/**
 * CHE TIPO DI FALLIMENTO È, E SI PUÒ RITENTARE ALLA CIECA?
 *
 * Tre esiti, e la differenza è tutta nella terza colonna:
 *   `netto`        il venue ha rifiutato prima di fare niente (4xx di validazione): nessun ordine può
 *                  esistere, quindi ritentare è sicuro — e di solito inutile, perché rifiuterà uguale.
 *   `transitorio`  la richiesta non è arrivata (errore di rete PRIMA dell'invio, 429 su una lettura):
 *                  niente è stato creato, si può ritentare.
 *   `ambiguo`      la POST è partita e la risposta non è arrivata (timeout, 5xx, connessione caduta).
 *                  L'ordine PUÒ essere a riposo. Qui ritentare alla cieca è come piazzare due volte.
 *
 * `inviata` è il fatto decisivo e viene da chi chiama, non da noi: solo lui sa se il byte è partito.
 */
function classificaErrore({ inviata = false, status = null, messaggio = '' } = {}) {
  const m = String(messaggio || '');
  const reteInterrotta = /timeout|ETIMEDOUT|ECONNRESET|ECONNABORTED|EPIPE|socket hang up|network|aborted/i.test(m);
  if (inviata) {
    return { tipo: 'ambiguo', ritentabileAllaCieca: false,
      motivo: 'la richiesta di piazzamento era già partita quando è fallita: l\'ordine può essere a riposo al venue,'
        + ' e ritentare senza guardare è il modo classico di ritrovarsi due ordini da un\'intenzione sola' };
  }
  if (status === 429 || (fin(status) && status >= 500 && status <= 599) || reteInterrotta) {
    return { tipo: 'transitorio', ritentabileAllaCieca: true,
      motivo: 'la richiesta non è mai partita o non ha prodotto niente: nessun ordine può esistere, si può ritentare' };
  }
  return { tipo: 'netto', ritentabileAllaCieca: true,
    motivo: `rifiuto netto${fin(status) ? ` (HTTP ${status})` : ''}: il venue ha risposto prima di creare qualcosa` };
}

/**
 * DOPO UN ESITO AMBIGUO: L'ORDINE C'È O NO?
 *
 * Pura: riceve la lista che chi chiama ha appena letto dal venue e risponde. Non decide di ritentare —
 * dice cosa si è visto, e la decisione resta di chi ha il contesto.
 *
 * FAIL-CLOSED, E QUI IL VERSO CONTA: una lettura FALLITA non è «l'ordine non c'è». Se non si riesce a
 * guardare, la risposta è `trovato: null` e `ritentare: false` — perché fra «ripiazzo e forse ne ho
 * due» e «non ripiazzo e forse ne ho zero», il secondo errore costa un ordine mancato e il primo costa
 * capitale doppio su un mercato reale.
 *
 * @param {object} a
 *   ordini      la lista letta dal venue (null/undefined ⇒ lettura fallita)
 *   tokenId, side, price, size  l'ordine che si stava piazzando
 *   tolleranza  quanto può differire la size (i fill parziali la riducono)
 * @returns {{trovato:boolean|null, ritentare:boolean, orderId:string|null, motivo:string}}
 */
function verificaDopoAmbiguo({ ordini = null, tokenId = null, side = null, price = null, size = null, tolleranza = 0.02 } = {}) {
  if (!Array.isArray(ordini)) {
    return { trovato: null, ritentare: false, orderId: null,
      motivo: 'la verifica al venue non è riuscita: non si sa se l\'ordine sia a riposo, e su un\'incognita non si ripiazza'
        + ' — un ordine mancato costa meno di un ordine doppio' };
  }
  const tok = tokenId == null ? null : String(tokenId);
  const lato = side == null ? null : String(side).toUpperCase();
  const trovato = ordini.find((o) => {
    if (!o) return false;
    if (tok && String(o.tokenId ?? o.asset_id ?? o.assetId ?? '') !== tok) return false;
    if (lato && String(o.side || '').toUpperCase() !== lato) return false;
    if (fin(price) && fin(Number(o.price)) && Math.abs(Number(o.price) - price) > 1e-9) return false;
    if (fin(size)) {
      const s = Number(o.sizeRemaining != null ? o.sizeRemaining : o.size);
      // Un fill parziale riduce la size residua: si accetta qualunque residuo NON superiore a quello
      // chiesto. Un ordine più grande di quello che volevamo non è il nostro.
      if (!fin(s) || s > size * (1 + tolleranza)) return false;
    }
    return true;
  });
  if (trovato) {
    return { trovato: true, ritentare: false, orderId: trovato.orderId || trovato.id || null,
      motivo: 'l\'ordine È a riposo al venue: l\'esito ambiguo era in realtà un successo, e ripiazzarlo raddoppierebbe il capitale impegnato' };
  }
  return { trovato: false, ritentare: true, orderId: null,
    motivo: `il venue è stato interrogato e su questo lato non c'è nessun ordine corrispondente (${ordini.length} letti):`
      + ' l\'esito ambiguo era un fallimento vero, quindi ritentare non può duplicare niente' };
}

module.exports = {
  attesaBackoff, leggiRetryAfter, classificaErrore, verificaDopoAmbiguo,
  BASE_TRANSITORIO_MS, BASE_RATE_LIMIT_MS, ATTESA_MAX_MS,
};

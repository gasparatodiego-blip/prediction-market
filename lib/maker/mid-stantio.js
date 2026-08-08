'use strict';
// lib/maker/mid-stantio.js — QUANTO SI PUÒ RESTARE CIECHI SU UN MERCATO PRIMA DI RITIRARSI.
//
// ═══ IL PROBLEMA, COM'ERA ═══════════════════════════════════════════════════════════════════════════
// Quando il feed di UN mercato smette di aggiornarsi, `decideReprice` rifiuta con `mid-stale`: non si
// muove un ordine reale contro un prezzo vecchio. È la regola giusta, ed è la più importante del
// modulo. Ma era anche l'UNICA cosa che succedeva: il rifiuto si ripeteva a ogni ciclo, per sempre.
//
// Il risultato è capitale fermo su un mercato di cui non abbiamo più visibilità, in una posizione che
// non possiamo più correggere. L'ordine resta sul libro — a maturare premi, forse, o a farsi riempire
// da chi il prezzo lo vede — e noi non lo sappiamo. «Non muovo l'ordine» era prudente sul singolo
// gesto e imprudente sul risultato: rimanere esposti è una decisione anche quando la si prende non
// decidendo.
//
// ═══ LA REGOLA NUOVA: VENTI SECONDI, POI CI SI RITIRA ═══════════════════════════════════════════════
// Il primo ciclo in cui il mid risulta stantio fa partire un orologio. Finché resta sotto i venti
// secondi non cambia niente rispetto a prima: si rifiuta di riprezzare e si riprova al giro dopo — è
// la finestra in cui un buco del feed si richiude da solo, che è il caso di gran lunga più frequente.
// Superati i venti secondi, gli ordini di quel mercato si CANCELLANO: il capitale torna liquido, e il
// trigger a capitale fermo di agent41 lo rimette al lavoro sul piano corrente.
//
// PERCHÉ VENTI SECONDI. Il feed di agent34 ripubblica ogni ~3 s e il regime «vivo» ammette già fino a
// 60 s di silenzio su un singolo asset. Venti secondi sono quindi ~7 pubblicazioni mancate: abbastanza
// perché non sia un singolo pacchetto perso, abbastanza poco da non lasciare un ordine cieco per un
// minuto intero. Si cambia con `MAKER_MID_STANTIO_TIMEOUT_MS`; un valore illeggibile o fuori da
// [5 s, 120 s] viene SCARTATO in favore del difetto — la stessa regola di fine scala e dell'orizzonte.
//
// ═══ CANCELLARE NON È PIAZZARE, E QUI STA LA SICUREZZA ══════════════════════════════════════════════
// L'unica azione che questo percorso autorizza è una CANCELLAZIONE, che riduce esposizione e non ne
// crea. È la stessa ragione per cui il guardiano delle perdite può cancellare senza conferma e non può
// piazzare. Non si sceglie un mercato nuovo da qui e non si sposta capitale: si toglie e basta. Chi
// rimette al lavoro il capitale è il trigger di agent41, con i suoi cancelli.
//
// ═══ L'OROLOGIO SI AZZERA SOLO SU UNA LETTURA BUONA ═════════════════════════════════════════════════
// Non sul passare del tempo, non su un ciclo saltato: solo quando il mid torna fresco. Un mercato che
// non viene guardato affatto (cadenza non scaduta) non fa progredire l'orologio e non lo azzera — il
// che è corretto: l'orologio misura da quanto siamo ciechi, e se non abbiamo guardato non sappiamo.
//
// PURO: nessun file, nessuna rete, nessuno stato globale. Il registro degli orologi lo tiene chi chiama.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

const TIMEOUT_DEFAULT_MS = 20_000;

/** Il timeout, riletto a ogni chiamata come le soglie di fine scala. Fuori scala ⇒ difetto. */
function timeoutMs(env = process.env) {
  const v = Number(env && env.MAKER_MID_STANTIO_TIMEOUT_MS);
  return fin(v) && v >= 5_000 && v <= 120_000 ? v : TIMEOUT_DEFAULT_MS;
}

/**
 * IL REGISTRO DEGLI OROLOGI. Una funzione che ne fabbrica uno: chi chiama lo tiene per tutta la vita
 * del processo, così l'orologio sopravvive ai cicli ma non al riavvio — e non deve, perché dopo un
 * riavvio non sappiamo da quanto quel mercato era cieco e ricominciare da zero è l'unica risposta
 * onesta (oltre che la più prudente: si aspetta di nuovo il timeout intero prima di cancellare).
 */
function registroStantio() {
  const da = new Map();
  return {
    /** Il mid è tornato buono: si dimentica. Ritorna quanto era durata la cecità, o null. */
    azzera(marketId) {
      const t = da.get(marketId);
      da.delete(marketId);
      return fin(t) ? t : null;
    },
    /** Il mid è stantio: si segna l'istante del PRIMO ciclo cieco e si restituisce quello. */
    segna(marketId, now) {
      if (!da.has(marketId)) da.set(marketId, now);
      return da.get(marketId);
    },
    da: (marketId) => (da.has(marketId) ? da.get(marketId) : null),
    quanti: () => da.size,
  };
}

/**
 * COSA FARE, ADESSO, SU QUESTO MERCATO. Pura.
 *
 * @param {object} a
 *   stantio      true se questo ciclo ha giudicato il mid non utilizzabile (mid-stale / mid-not-live /
 *                mid-age-unknown: sono tutti «non so che prezzo c'è», e vanno trattati allo stesso modo)
 *   daMs         l'istante del PRIMO ciclo cieco (dal registro), o null se questo è il primo
 *   now
 *   timeout      il timeout in ms
 * @returns {{azione:'niente'|'attendi'|'cancella', cecitaMs:number|null, restaMs:number|null, motivo:string}}
 */
function decidiStantio({ stantio = false, daMs = null, now = Date.now(), timeout = timeoutMs() } = {}) {
  if (!stantio) {
    return { azione: 'niente', cecitaMs: null, restaMs: null,
      motivo: 'il mid è utilizzabile: nessun orologio in corso' };
  }
  const inizio = fin(daMs) ? daMs : now;
  const cecita = Math.max(0, now - inizio);
  if (cecita < timeout) {
    return { azione: 'attendi', cecitaMs: cecita, restaMs: timeout - cecita,
      motivo: `mid stantio da ${(cecita / 1000).toFixed(1)}s: si riprova, mancano ${((timeout - cecita) / 1000).toFixed(1)}s al ritiro`
        + ' — un buco del feed si richiude da solo quasi sempre, e cancellare al primo ciclo cieco costerebbe più di quanto protegge' };
  }
  return { azione: 'cancella', cecitaMs: cecita, restaMs: 0,
    motivo: `mid stantio da ${(cecita / 1000).toFixed(1)}s, oltre il limite di ${(timeout / 1000).toFixed(0)}s:`
      + ' si cancellano gli ordini di questo mercato. Non si tiene capitale esposto su un book che non vediamo —'
      + ' il capitale liberato torna al trigger, che lo rimette al lavoro sul piano corrente.' };
}

/** I codici di rifiuto che significano tutti «non so che prezzo c'è». Uno solo di essi avvia l'orologio. */
const GATE_CIECHI = Object.freeze(['mid-stale', 'mid-not-live', 'mid-age-unknown']);
const eCieco = (gate) => GATE_CIECHI.includes(String(gate || ''));

module.exports = {
  decidiStantio, registroStantio, timeoutMs, eCieco,
  GATE_CIECHI, TIMEOUT_DEFAULT_MS,
};

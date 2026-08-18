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

// ══ LA SOGLIA UNICA DELLA CECITÀ SUL MID — 16 agosto 2026 ═══════════════════════════════════════════
// ⚠ ERANO DUE NUMERI SCOLLEGATI, E L'ASIMMETRIA HA UCCISO UNA COPPIA. `decideReprice` rifiutava di
// MUOVERE un ordine oltre i **60 s** di mid (regime «vivo»), mentre questo modulo lo CANCELLAVA a 20 s;
// stamattina il secondo e' stato portato a 120 s e l'asimmetria si e' rovesciata — con il risultato
// peggiore dei due. Misurato il 16/08: quattro `skip-mid-stale` fra le 15:59 e le 16:03 con mid vecchio
// di 61-91 s, il completamento della coppia su FL-27 **non riprezzabile e non cancellato**, morto per
// GTD alle 16:08:06 (`expired`, 1397s su 1380). La posizione e' rimasta scoperta.
//
// LA REGOLA, decisa dall'operatore: **una soglia sola**. Sotto, l'ordine si riprezza e si rinnova
// normalmente; sopra, **non si riprezza, non si rinnova, si CANCELLA**. Non esiste piu' nessuna
// finestra in cui un ordine resta vivo a un prezzo che non possiamo aggiornare — che e' esattamente
// cio' che e' successo fra i 60 e i 120 secondi.
//
// ⚠ SI DERIVA, NON SI RICOPIA. `auto-reprice-config.maxMidAgeSecLive` IMPORTA questo valore invece di
// dichiararne uno proprio: due numeri per lo stesso concetto sono il reperto D1, e qui la divergenza
// e' costata una gamba scoperta. Scollegarli di nuovo richiederebbe di cancellare l'import, non di
// dimenticare un allineamento.
//
// PERCHÉ 120 s E NON 60. Il feed di agent34 ripubblica ogni ~3 s: 120 s sono ~40 pubblicazioni mancate,
// abbastanza perche' non sia un pacchetto perso. Su un mercato elections a 37 ore con 320 share di
// profondita' il silenzio di un minuto e' normalita', non anomalia — e muovere un ordine su un mid di
// 90 s e' meno rischioso che lasciarlo morire fermo su uno di 20 minuti fa.
const TIMEOUT_DEFAULT_MS = 120_000;
/** La stessa soglia in SECONDI, per chi ragiona in secondi (`regimeFeed`). Derivata, mai ridichiarata. */
const MAX_MID_AGE_SEC = TIMEOUT_DEFAULT_MS / 1000;

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

// ══ ⚠⚠ «IL MERCATO TACE» NON E' «SIAMO CIECHI» — 18 agosto 2026, decisione dell'operatore ══════════
//
// IL FATTO. `mid-stale` si accende quando il venue non manda un evento su QUELL'ASSET da 30 s
// (`live-book.freshness`). Su un mercato tranquillo — «1 taglio dei tassi entro il 2026», 134 giorni
// alla scadenza, volume minimo — due minuti di silenzio sono lo stato normale, e il quadro memorizzato
// resta perfetto: misurato il 5 agosto, al picco di 35 s di eta' il book coincideva ESATTAMENTE con la
// lettura REST. Il presidio pero' cancellava lo stesso, e il bot passava la serata a togliersi gli
// ordini dai mercati tranquilli — che per un maker di rewards sono quelli buoni, perche' senza
// selezione avversa gli ordini restano a libro e maturano.
//
// LA DISTINZIONE ESISTE GIA', ED E' A UN ALTRO LIVELLO: `feedVitality` dice quanti asset hanno avuto
// eventi sul feed NEL SUO INSIEME. Se il feed e' vivo, il silenzio di un asset e' una notizia sul
// MERCATO; se il feed e' muto, e' una notizia su di NOI. `regimeFeed` fa gia' questa lettura per il
// riprezzo: qui si usa la stessa, invece di dedurre la cecita' dal silenzio di un singolo libro.
//
// ⚠ IL PRESIDIO NON SI TOGLIE, SI RESTRINGE AL CASO PER CUI ESISTE:
//   · `mid-not-live` e `mid-age-unknown` restano cecita' SEMPRE — li' non c'e' un libro, o non se ne
//     puo' datare il contenuto: non e' silenzio, e' assenza;
//   · `mid-stale` (silenzio) e' cecita' SOLO se il feed non e' vivo, oppure se quel book chiede un
//     resnapshot — cioe' se agent34 stesso dichiara di aver perso l'ancoraggio.
//
// ⚠ FAIL-CLOSED: `feedVivo` non noto ⇒ si tratta come feed NON vivo ⇒ si cancella. Un feed di cui non
// si sa niente non puo' autorizzare a restare esposti.
const DECISORI = Object.freeze({
  GATE: 'gate-di-assenza',
  RESNAPSHOT: 'resnapshot-richiesto',
  FEED: 'feed-non-vivo',
  SILENZIO: 'silenzio-con-feed-vivo',
});

/**
 * E' CECITA' VERA, o e' solo un mercato che tace?
 * @param {{gate:string, feedVivo:(boolean|null), needsResnapshot:(boolean|null)}} p
 * @returns {{cieco:boolean, causa:(string|null), decisoDa:(string|null), motivo:string}}
 */
function cecitaVera({ gate, feedVivo = null, needsResnapshot = null } = {}) {
  if (!eCieco(gate)) {
    return { cieco: false, causa: null, decisoDa: null, motivo: 'il gate non parla di cecita' };
  }
  if (String(gate) !== 'mid-stale') {
    return { cieco: true, causa: causaCecita(gate), decisoDa: DECISORI.GATE,
      motivo: `${motivoCecita(gate)} — non e silenzio, e assenza: l'orologio parte comunque` };
  }
  if (needsResnapshot === true) {
    return { cieco: true, causa: causaCecita(gate), decisoDa: DECISORI.RESNAPSHOT,
      motivo: 'il book chiede un resnapshot: agent34 dichiara di aver perso l ancoraggio di questo libro, quindi il silenzio non e affidabile' };
  }
  if (feedVivo !== true) {
    return { cieco: true, causa: causaCecita(gate), decisoDa: DECISORI.FEED,
      motivo: 'il feed NEL SUO INSIEME non e vivo: il silenzio di questo asset non e distinguibile dalla cecita (fail-closed anche quando la vitalita non e leggibile)' };
  }
  return { cieco: false, causa: null, decisoDa: DECISORI.SILENZIO,
    motivo: 'il feed e vivo e questo book non chiede resnapshot: il silenzio e una notizia sul MERCATO, non su di noi — l ordine resta a libro' };
}

// ══ TRE CECITÀ DIVERSE SOTTO LO STESSO OROLOGIO (12 agosto 2026) ════════════════════════════════════
// I tre gate portano tutti alla stessa AZIONE — venti secondi e poi si cancella — ed è giusto: in tutti
// e tre non sappiamo che prezzo c'è, e restare esposti su un book che non vediamo è la stessa decisione.
//
// Ma non sono la stessa DIAGNOSI, e fino a oggi finivano tutti in `mid-stantio-*`: dal log non si poteva
// distinguere «il prezzo è vecchio» (il feed pubblica, ma in ritardo) da «non c'è nessun libro» (il feed
// non pubblica affatto per questo mercato). La prima è una lentezza; la seconda è una sottoscrizione che
// non è mai partita o è caduta — e si risolvono in due modi diversi.
//
// Il comportamento NON cambia: stessi venti secondi, stessa cancellazione, stesso orologio. Cambia solo
// che il log dice quale delle tre è stata.
const CAUSE = Object.freeze({
  'mid-stale': { causa: 'mid-stantio', umano: 'il feed pubblica ma il prezzo è vecchio' },
  'mid-not-live': { causa: 'nessun-libro', umano: 'il feed non pubblica un book live per questo mercato' },
  'mid-age-unknown': { causa: 'eta-ignota', umano: 'il book non dichiara la propria età: non si può affermare che sia fresco' },
});

/**
 * LA CAUSA DELLA CECITÀ, dal gate che l'ha prodotta.
 * Un gate non cieco ⇒ `null`: non si inventa una diagnosi per un rifiuto che parla d'altro.
 */
function causaCecita(gate) {
  const c = CAUSE[String(gate || '')];
  return c ? c.causa : null;
}

/** La frase per il log. Gate sconosciuto ⇒ una frase onesta, non un vuoto. */
function motivoCecita(gate) {
  const c = CAUSE[String(gate || '')];
  return c ? c.umano : 'motivo della cecità non riconosciuto';
}

module.exports = {
  decidiStantio, registroStantio, timeoutMs, eCieco, causaCecita, motivoCecita, cecitaVera, DECISORI,
  GATE_CIECHI, CAUSE, TIMEOUT_DEFAULT_MS, MAX_MID_AGE_SEC,
};

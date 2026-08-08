'use strict';
// lib/maker/cadenza-adattiva.js — OGNI MERCATO ALLA SUA VELOCITÀ, MISURATA E NON IMMAGINATA.
//
// ═══ IL PROBLEMA ════════════════════════════════════════════════════════════════════════════════════
// I due motori di agent40 guardano OGNI mercato con lo stesso orologio: 5s il watcher reattivo, 3s il
// market maker a due lati. Ma i mercati non sono uguali, e la differenza è stata misurata (6 agosto
// 2026, lib/rewards/velocita-mercato.js): quelli su cui c'era il capitale erano da 5 a 13 volte più
// silenziosi della media del board. Con un orologio solo si paga due volte:
//   · sul mercato FERMO si spendono chiamate al venue per riconfermare, giro dopo giro, che non è
//     successo niente — ed è la spesa che il guardiano del 6 agosto ha visto come «undici chiamate ogni
//     cinque secondi»;
//   · sul mercato VELOCE cinque secondi sono un'era: il mid può uscire e rientrare dalla banda fra due
//     sguardi, e il motore lo scopre tardi.
//
// ═══ COSA DECIDE, E COSA NON DECIDE ═════════════════════════════════════════════════════════════════
// Decide SOLO OGNI QUANTO GUARDARE un mercato. Non decide se riprezzare: quella resta la soglia di
// movimento (`minMoveCents` del tracking, `hysteresisTicks` del watcher), che non viene toccata da qui
// e continua a valere identica a ogni valutazione. È una distinzione che va tenuta ferma, perché è
// esattamente il punto in cui questa modifica potrebbe diventare il loop di ratcheting già diagnosticato
// in passato: guardare più spesso NON abbassa la soglia. Un mercato veloce guardato ogni secondo con una
// soglia di mezzo tick riprezza esattamente quando riprezzava prima — solo, se ne accorge prima.
//
// ═══ LA MISURA ══════════════════════════════════════════════════════════════════════════════════════
// `lib/rewards/velocita-mercato.leggiFinestraMercato` su una finestra mobile (15 min di difetto): stessa
// funzione, stesso giornale e stessa finestra che il pannello usa per il filtro «⚡ Veloci», senza cache
// e su un mercato solo — è nata per essere chiamata dentro un ciclo di piazzamento.
// Da lì si ricava l'escursione del mid riportata all'ora, in centesimi, e la si confronta con il TICK di
// quel mercato: «quattro tick l'ora» vuol dire la stessa cosa su un mercato da 1¢ e su uno da 0,1¢,
// mentre «quattro centesimi l'ora» no.
//
// ═══ NEL DUBBIO NON SI CAMBIA NIENTE ════════════════════════════════════════════════════════════════
// Misura assente, illeggibile o basata su troppi pochi campioni ⇒ classe `ignota` ⇒ CADENZA DI DIFETTO,
// cioè esattamente il comportamento di prima. Non la più veloce (costerebbe chiamate al venue su una
// convinzione che non abbiamo) e non la più lenta (renderebbe cieco un mercato che magari corre). Un
// dato che non si legge non è un'informazione: è l'assenza di una.

const MIN_MS = 1_000;      // il pavimento di sicurezza: sotto il secondo si rientra nel territorio del
                           // ratcheting sui tick fini, e il feed di agent34 non pubblica più in fretta.
const MAX_MS = 10_000;     // il tetto: oltre, un mercato lento smetterebbe di essere sorvegliato.
const FINESTRA_MIN = 15;   // la finestra mobile su cui si misura: abbastanza lunga da non seguire il
                           // rumore, abbastanza corta da accorgersi che un mercato si è svegliato.

// Le due soglie, in TICK ALL'ORA di escursione del mid. Sono deliberatamente distanti fra loro: in mezzo
// c'è la classe `media`, che tiene la cadenza di prima. Una banda morta larga significa che un mercato
// non rimbalza fra due cadenze a ogni giro solo perché la misura oscilla attorno a un confine.
const VELOCE_TICK_ORA = 4.0;
const LENTO_TICK_ORA = 0.5;

const CAMPIONI_MINIMI = 4;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * L'escursione del mid riportata all'ora, in TICK di questo mercato.
 * @returns {number|null} null quando la misura non consente di rispondere.
 */
function tickOra(misura, tickCents) {
  if (!misura || misura.leggibile !== true) return null;
  if (!fin(misura.rangeMid) || !fin(misura.coperturaMin) || misura.coperturaMin <= 0) return null;
  if (!fin(misura.campioni) || misura.campioni < CAMPIONI_MINIMI) return null;
  const t = fin(tickCents) && tickCents > 0 ? tickCents : 1;
  const centsOra = (misura.rangeMid * 100) * (60 / misura.coperturaMin);
  return centsOra / t;
}

/**
 * Ogni quanto va guardato QUESTO mercato, e va guardato adesso?
 *
 * Puro: nessun file, nessun orologio proprio, nessuna rete. Chi chiama inietta la misura (così i test
 * girano senza giornale) e il proprio `now`.
 *
 * @param {object}   o
 * @param {number}   o.now                      millisecondi
 * @param {number|null} o.ultimaValutazioneMs   quando questo mercato è stato valutato l'ultima volta
 * @param {object|null} o.misura                il ritorno di leggiFinestraMercato per questo mercato
 * @param {number}   o.tickCents                il tick del mercato in centesimi (difetto 1)
 * @param {number}   o.difettoMs                la cadenza del motore che chiama (5000 o 3000)
 * @param {boolean}  o.attiva                   false ⇒ si risponde sempre «valuta», cadenza di difetto
 * @param {number|null} o.bookAggiornatoMs        quando il feed ha pubblicato l'ultimo book di QUESTO
 *                                                mercato. Se è più recente dell'ultima valutazione, si
 *                                                valuta ADESSO senza aspettare la cadenza — vedi sotto.
 * @param {number|null} o.bookValutatoMs          il `bookAggiornatoMs` dell'ultima valutazione
 * @returns {{valuta:boolean, cadenzaMs:number, classe:string, tickOra:number|null, motivo:string,
 *            attesaMs:number, perEvento:boolean}}
 */
function decidiCadenza({ now, ultimaValutazioneMs = null, misura = null, tickCents = 1,
  difettoMs = 5_000, attiva = true, minMs = MIN_MS, maxMs = MAX_MS,
  bookAggiornatoMs = null, bookValutatoMs = null } = {}) {
  const difetto = fin(difettoMs) && difettoMs > 0 ? difettoMs : 5_000;
  const lo = fin(minMs) && minMs > 0 ? minMs : MIN_MS;
  const hi = fin(maxMs) && maxMs > 0 ? maxMs : MAX_MS;

  // ── IL FEED HA PARLATO? ALLORA SI DECIDE ADESSO (8 agosto 2026, sera) ─────────────────────────
  //
  // PRIMA: la cadenza era l'UNICO modo di arrivare a una decisione. Un mercato classificato «lento»
  // aspettava dieci secondi anche quando il suo book era appena cambiato — cioè il dato era live e la
  // decisione no. Su un mercato lento «lento» descrive la media, non il singolo istante: un mercato
  // fermo per un'ora e poi mosso di tre tick resta classificato lento, e con dieci secondi di attesa il
  // motore se ne accorge fino a dieci secondi dopo.
  //
  // ADESSO: se il feed ha pubblicato per QUESTO mercato un book più recente di quello su cui si è
  // deciso l'ultima volta, si valuta subito. La cadenza resta come PAVIMENTO DI RIPOSO — quanto si
  // aspetta quando il feed tace — e smette di essere un tetto alla reattività.
  //
  // ═══ E IL FRENO SUI VELOCI RESTA, INTATTO ═══════════════════════════════════════════════════════
  // Il rischio noto è il loop di ratcheting: un mercato che si muove di continuo, valutato a ogni
  // evento, riprezzato a ogni valutazione. Tre freni lo impediscono, e nessuno dei tre è toccato qui:
  //   · `minMs` (1s) — il pavimento fra due VALUTAZIONI dello stesso mercato, che vale anche per gli
  //     eventi: un feed che pubblicasse dieci volte al secondo non produce dieci valutazioni;
  //   · `minIntervalMs` (30s per ordine) e `hysteresisTicks`/`confirmSamples` — le soglie che decidono
  //     se RIPREZZARE, che vivono altrove e che questa funzione non ha mai toccato.
  // Vale quindi ancora, parola per parola, la riga dell'intestazione: guardare più spesso NON abbassa
  // la soglia. Un mercato veloce valutato a ogni evento riprezza esattamente quando riprezzava prima.
  const eventoNuovo = fin(bookAggiornatoMs) && (!fin(bookValutatoMs) || bookAggiornatoMs > bookValutatoMs);
  const scaduta = (cadenzaMs) => {
    if (!fin(ultimaValutazioneMs)) return { valuta: true, attesaMs: 0, perEvento: false };   // mai visto ⇒ si guarda
    const trascorso = now - ultimaValutazioneMs;
    // Un `ultimaValutazione` nel futuro (orologio spostato) non deve congelare un mercato: si guarda.
    if (trascorso < 0) return { valuta: true, attesaMs: 0, perEvento: false };
    if (trascorso >= cadenzaMs) return { valuta: true, attesaMs: 0, perEvento: false };
    // La cadenza non è ancora scaduta: decide l'evento, e solo sopra il pavimento di sicurezza.
    if (eventoNuovo && trascorso >= lo) return { valuta: true, attesaMs: 0, perEvento: true };
    return { valuta: false, attesaMs: Math.max(0, cadenzaMs - trascorso), perEvento: false };
  };

  if (attiva !== true) {
    const s = scaduta(difetto);
    return { ...s, cadenzaMs: difetto, classe: 'spenta', tickOra: null,
      motivo: 'cadenza adattiva disattivata — orologio fisso come prima'
        + (s.perEvento ? ' · valutato SUBITO per un book nuovo' : '') };
  }

  const t = tickOra(misura, tickCents);
  if (t == null) {
    const s = scaduta(difetto);
    return { ...s, cadenzaMs: difetto, classe: 'ignota', tickOra: null,
      motivo: `velocità non misurabile (${(misura && misura.motivo) || 'nessuna misura'}) — cadenza di difetto ${difetto}ms`
        + (s.perEvento ? ' · valutato SUBITO per un book nuovo' : '') };
  }

  let cadenzaMs, classe;
  if (t >= VELOCE_TICK_ORA) { cadenzaMs = lo; classe = 'veloce'; }
  else if (t <= LENTO_TICK_ORA) { cadenzaMs = hi; classe = 'lenta'; }
  else { cadenzaMs = difetto; classe = 'media'; }

  // Il pavimento e il tetto valgono SEMPRE, anche contro un difetto configurato fuori scala.
  cadenzaMs = Math.min(hi, Math.max(lo, cadenzaMs));

  const s = scaduta(cadenzaMs);
  return { ...s, cadenzaMs, classe, tickOra: +t.toFixed(3),
    motivo: `escursione ${t.toFixed(2)} tick/ora su ${FINESTRA_MIN} min ⇒ ${classe} (${cadenzaMs}ms)`
      + (s.perEvento ? ' · valutato SUBITO: il feed ha pubblicato un book nuovo' : '') };
}

/** L'interruttore, con lo stesso criterio degli altri: si spegne solo scrivendolo per esteso. */
function cadenzaAttiva(env = process.env) {
  return String(env.MAKER_CADENZA_ADATTIVA || '').trim().toLowerCase() !== 'off';
}

module.exports = {
  decidiCadenza, cadenzaAttiva, tickOra,
  MIN_MS, MAX_MS, FINESTRA_MIN, VELOCE_TICK_ORA, LENTO_TICK_ORA, CAMPIONI_MINIMI,
};

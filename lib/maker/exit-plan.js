'use strict';
// lib/maker/exit-plan.js — DOVE VA L'ORDINE DI USCITA DOPO UN FILL, e quando si smette di aspettarlo.
//
// DUE DECISIONI SEPARATE, e tenerle separate e' il punto:
//   · planExit()    — a che prezzo si piazza l'uscita. Si calcola una volta, al fill.
//   · decideExit()  — se quell'uscita va ancora aspettata, o se e' ora di chiudere a mercato.
//                     Si ricontrolla A OGNI CICLO, perche' le condizioni cambiano sotto l'ordine fermo.
//
// ── COSA E' CAMBIATO, E PERCHE' (revisione del 3 agosto 2026) ─────────────────────────────────────
// La versione precedente congelava l'uscita a un PAVIMENTO FISSO del 4% sotto il carico: sotto quel
// livello non si inseguiva piu' e l'ordine restava li'. Un backtest su 216 fill reali (25 luglio →
// 3 agosto, 61 mercati premianti, banda letta dallo storico e non approssimata) ha confrontato quel
// pavimento fisso con un trigger legato alla banda reward:
//
//   trigger        uscite forzate   netto      coda sinistra (3 casi peggiori)
//   banda                     48    +$3.22     −$6 / −$4 / −$4
//   4% fisso                  67    −$6.84     −$6.18 / −$6 / −$4.85
//   10% fisso                 46   −$26.43     −$12.84 / −$8.18 / −$8
//
// Il margine complessivo e' sottile e dentro il rumore. Quello che NON e' dentro il rumore e' la coda:
// il trigger a banda perde meno quando va male, ed e' l'unico dei tre a non chiudere in perdita.
//
// E c'e' un fatto che solo la banda puo' cogliere: in 4 delle 48 uscite forzate il mid non si era mosso
// AFFATTO — si era ristretta la banda. Il programma reward cambia `maxSpread` nel tempo, e un ordine
// fermo si ritrova fuori senza che il mercato abbia fatto nulla. Una soglia percentuale sul prezzo di
// carico non puo' vedere quel caso, per costruzione. Per questo la banda va RILETTA a ogni ciclo e non
// calcolata una volta sola al fill.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ── L'OBIETTIVO ─────────────────────────────────────────────────────────────────────────────────────
// Percentuale sul carico, non centesimi fissi: a 10¢ un centesimo e' il 10%, a 90¢ e' l'1.1%, e la
// stessa costante direbbe due cose diverse a seconda del prezzo.
const EXIT_PROFIT_PCT = 1;

// ── IL TETTO DI ATTESA ──────────────────────────────────────────────────────────────────────────────
// Oltre questo tempo l'uscita si forza A MERCATO, dentro banda o no.
//
// PERCHE' ESISTE, e perche' proprio 24 ore. Lo stesso backtest ha misurato quanto ci mette il prezzo a
// tornare profittevole dopo un'uscita forzata prematura: mediana 76 ORE. Cioe' «sarebbe tornato buono»
// e' vero, ma al prezzo di tenere capitale immobilizzato per tre giorni su una posizione che nessuno
// sta piu' guadagnando. Ventiquattro ore e' un giorno intero di pazienza — abbastanza per assorbire
// una deriva normale (le uscite al target hanno mediana 0.51 giorni), non abbastanza per trasformare
// un'uscita in un investimento.
//
// SI CAMBIA SOLO QUI. Nessun altro file scrive questo numero.
const MAX_WAIT_HOURS = 24;
const MAX_WAIT_MS = MAX_WAIT_HOURS * 3_600_000;

/** Il prezzo piu' vicino a `p` sulla griglia del tick, arrotondato nella direzione indicata. */
function snapTo(p, tick, dir) {
  if (!fin(p) || !fin(tick) || tick <= 0) return null;
  const n = dir === 'up' ? Math.ceil(p / tick - 1e-9) : Math.floor(p / tick + 1e-9);
  return +(n * tick).toFixed(10);
}

/** La banda corrente in prezzi assoluti, da mid di scoring e mezzo raggio in centesimi. */
function bandBounds({ scoringMid, bandRadiusCents, tick } = {}) {
  if (!fin(scoringMid) || !fin(bandRadiusCents) || bandRadiusCents <= 0 || !fin(tick) || tick <= 0) {
    return { readable: false, lo: null, hi: null };
  }
  return {
    readable: true,
    lo: snapTo(scoringMid - bandRadiusCents / 100, tick, 'up'),
    hi: snapTo(scoringMid + bandRadiusCents / 100, tick, 'down'),
  };
}

/**
 * DOVE PIAZZARE L'USCITA. Obiettivo +1%, tenuto DENTRO la banda premiante.
 *
 * ── +1% SU COSA (correzione del 3 agosto 2026) ────────────────────────────────────────────────────
 * Fino a questa revisione l'obiettivo nasceva SEMPRE dal prezzo di carico, e il mercato corrente
 * serviva solo a limitare verso l'alto. Su una posizione andata a favore quella regola lascia sul
 * tavolo tutto il guadagno gia' maturato. Osservato in produzione, e non in astratto:
 *
 *     fill YES a 16.75¢ · mercato salito a 99.9¢ (praticamente risolto a favore)
 *     → uscita proposta a 17¢, cioe' +1% dal carico, su qualcosa che ne valeva 99.9
 *     → ~$166 di guadagno maturato che l'ordine avrebbe regalato a chi lo avesse preso
 *
 * L'unica ragione per cui non e' successo un danno e' che la guardia della banda ha rifiutato quel
 * prezzo perche' troppo lontano dal mid. Una protezione che si attiva per il motivo sbagliato non e'
 * una protezione: e' un caso fortunato.
 *
 * ADESSO la base dell'obiettivo e' il MASSIMO fra prezzo di carico e prezzo corrente di mercato — ma
 * solo quando il mercato ha gia' superato l'obiettivo originale. Sotto quella soglia non cambia niente:
 * il target resta carico +1%, esattamente come prima.
 *
 * PERCHE' «solo quando lo ha superato» e non «sempre il massimo dei due». Sono la stessa cosa in
 * aritmetica, ma dirlo cosi' rende esplicito che il comportamento ordinario e' invariato: la modifica
 * riguarda un caso solo — quello in cui il mercato ci ha gia' dato piu' di quanto stessimo chiedendo.
 *
 * IL CRICCHETTO. Questa funzione produce un piano nuovo a ogni ciclo, e `exitNeedsMove` non abbassa
 * mai un'uscita gia' a riposo. Le due cose insieme fanno un cricchetto: l'uscita SALE con il mercato e
 * non torna piu' giu'. Se poi il mercato scende, non si svende un tick alla volta — decide `decideExit`,
 * che chiude a mercato.
 *
 * DUE TETTI, NON UNO. Alla banda si aggiunge il limite del libro (1 − tick): con il mercato a 99.9¢
 * l'obiettivo +1% vale 100.9¢, che non e' un prezzo. Prima quel caso usciva come errore «fuori dai
 * limiti del libro» e non si piazzava nulla; adesso si esce al massimo prezzo esprimibile, che e'
 * esattamente cio' che si vuole su una posizione praticamente risolta.
 *
 * La banda limita ancora l'obiettivo VERSO L'ALTO, e non e' in contraddizione col fatto che ora sia
 * anche il trigger: un'uscita piazzata gia' fuori banda sarebbe fuori dal primo istante, quindi il
 * trigger scatterebbe subito e la posizione verrebbe chiusa a mercato senza nemmeno provare a uscire
 * in profitto. Clampare all'ingresso e' cio' che rende il trigger sensato.
 *
 * NON esiste nessun pavimento: l'uscita non viene mai spinta SOTTO l'obiettivo. Se la banda e' scesa
 * tanto da non contenere piu' un prezzo profittevole, non si piazza un'uscita in perdita — se ne occupa
 * `decideExit`, che chiude a mercato.
 */
function planExit({ entryPrice, scoringMid, tick, bandRadiusCents = null, profitPct = EXIT_PROFIT_PCT, priceMax = null } = {}) {
  const out = (reason, extra = {}) => ({
    ok: false, price: null, reason, target: null, bandLo: null, bandHi: null,
    clampedBy: null, profitPct: null, ...extra,
  });
  if (!fin(entryPrice) || entryPrice <= 0) return out('prezzo di carico non leggibile — nessuna uscita viene inventata');
  if (!fin(tick) || tick <= 0) return out('tick del venue non leggibile — nessuna uscita viene inventata');

  // Arrotondato IN SU: arrotondare in giu' consegnerebbe meno guadagno di quello promesso, e su un
  // tick da 0.001 la differenza e' quasi tutto l'obiettivo.
  const targetFromEntry = snapTo(entryPrice * (1 + profitPct / 100), tick, 'up');

  // ── IL MERCATO CI HA GIA' DATO PIU' DI QUANTO CHIEDEVAMO? ────────────────────────────────────────
  // Un mid NON leggibile non e' un mercato fermo: senza quel numero si resta sull'obiettivo dal carico,
  // che e' il comportamento di prima. L'assenza di un fatto non ne prende il posto.
  const marketAhead = fin(scoringMid) && scoringMid > targetFromEntry;
  const basePrice = marketAhead ? scoringMid : entryPrice;
  const target = marketAhead ? snapTo(basePrice * (1 + profitPct / 100), tick, 'up') : targetFromEntry;
  const b = bandBounds({ scoringMid, bandRadiusCents, tick });

  // Il massimo prezzo che il venue accetta. Stesso default di venue-rules (`priceMax = 1 − tick`), per
  // non avere due idee diverse di dove finisce il libro.
  const pMax = fin(priceMax) && priceMax > 0 ? priceMax : +(1 - tick).toFixed(10);

  let price = target;
  let clampedBy = marketAhead ? 'mercato-a-favore' : 'obiettivo';
  if (b.readable && b.hi != null && price > b.hi) { price = b.hi; clampedBy = 'banda'; }
  if (price > pMax) { price = pMax; clampedBy = 'limite-del-libro'; }

  if (!(price > 0) || price >= 1) {
    return out(`il prezzo di uscita calcolato (${price}) e' fuori dai limiti del libro`, { target, bandLo: b.lo, bandHi: b.hi });
  }
  // LA BANDA E' SCESA SOTTO IL CARICO: nessun prezzo dentro banda sarebbe profittevole. Non si piazza
  // un'uscita in perdita per rispettare la banda — la posizione va chiusa, e lo decide decideExit.
  if (b.readable && b.hi != null && b.hi <= entryPrice) {
    return out(
      `la banda premiante corrente (fino a ${b.hi}) e' gia' sotto il prezzo di carico (${entryPrice}):`
      + ' nessuna uscita dentro banda sarebbe in guadagno. Non si piazza un ordine in perdita per restare premiati.',
      { target, bandLo: b.lo, bandHi: b.hi, belowEntry: true },
    );
  }

  const realizedPct = +(((price - entryPrice) / entryPrice) * 100).toFixed(3);
  const reason = clampedBy === 'obiettivo'
    ? `uscita all'obiettivo: carico ${entryPrice} + ${profitPct}% = ${price}`
    : clampedBy === 'mercato-a-favore'
      ? `il mercato e' GIA' andato a favore (${scoringMid}) oltre l'obiettivo dal carico (${targetFromEntry}):`
        + ` l'uscita segue il mercato invece di regalare il guadagno maturato — ${price}, cioe' ${realizedPct}% sul carico di ${entryPrice}`
      : clampedBy === 'limite-del-libro'
        ? `l'obiettivo ${target} supera il massimo prezzo esprimibile: si esce a ${price}`
          + ` (${realizedPct}% sul carico di ${entryPrice})`
        : `uscita LIMITATA DALLA BANDA: l'obiettivo ${target} cadeva oltre il bordo premiante ${b.hi},`
          + ` quindi si esce al bordo (${realizedPct}% sul carico) dove l'attesa matura`;

  return {
    ok: true, price, reason, target, bandLo: b.lo, bandHi: b.hi, clampedBy, profitPct: realizedPct,
    // Perche' la base e' quella: serve a poter leggere un audit senza rifare il conto a mano.
    basePrice, marketAhead, targetFromEntry, priceMax: pMax,
  };
}

/**
 * L'USCITA VA ANCORA ASPETTATA, O SI CHIUDE A MERCATO?
 *
 * Si chiama A OGNI CICLO su un'uscita gia' a riposo, con la banda RILETTA in quel momento. Due trigger,
 * entrambi terminali:
 *
 *   1. FUORI BANDA — il prezzo dell'uscita non e' piu' dentro la banda corrente. Puo' essere successo
 *      perche' il mid si e' mosso, oppure perche' la banda si e' ristretta senza che il mid si muovesse
 *      (misurato: 4 casi su 48 nel backtest). In entrambi i casi l'ordine non matura piu' e non ha piu'
 *      motivo di aspettare li'.
 *   2. TEMPO SCADUTO — l'uscita e' a riposo da piu' di MAX_WAIT_HOURS. Vale ANCHE se e' ancora dentro
 *      banda: un'uscita che matura ma non si riempie sta comunque tenendo fermo del capitale.
 *
 * In entrambi i casi la posizione si chiude A MERCATO. E' deliberatamente un ordine che attraversa lo
 * spread: e' un'uscita, non una quotazione, e il punto e' proprio smettere di aspettare.
 *
 * SE LA BANDA NON E' LEGGIBILE non si chiude nulla: «non so dove sia la banda» non e' «sei fuori».
 * Resta solo il tetto di tempo, che non dipende dalla banda.
 */
function decideExit({ exitPrice, restingSinceMs, now = Date.now(), scoringMid, bandRadiusCents, tick, maxWaitMs = MAX_WAIT_MS } = {}) {
  const hold = (reason, extra = {}) => ({ action: 'hold', trigger: null, reason, ...extra });
  if (!fin(exitPrice)) return hold('nessuna uscita a riposo da giudicare');

  const waited = fin(restingSinceMs) ? Math.max(0, now - restingSinceMs) : null;
  const b = bandBounds({ scoringMid, bandRadiusCents, tick });

  // 1 · FUORI BANDA — solo se la banda si e' potuta leggere.
  if (b.readable) {
    const dentro = exitPrice >= b.lo - 1e-12 && exitPrice <= b.hi + 1e-12;
    if (!dentro) {
      return {
        action: 'close-at-market', trigger: 'band-exit',
        reason: `l'uscita a ${exitPrice} e' USCITA dalla banda premiante corrente (${b.lo}–${b.hi}):`
          + ' non matura piu\' e non ha piu\' motivo di aspettare li\'. Si chiude la posizione a mercato.',
        bandLo: b.lo, bandHi: b.hi, waitedMs: waited,
      };
    }
  }

  // 2 · TEMPO SCADUTO — indipendente dalla banda, e vale anche se l'uscita sta ancora maturando.
  if (waited != null && waited >= maxWaitMs) {
    return {
      action: 'close-at-market', trigger: 'max-wait',
      reason: `l'uscita e' a riposo da ${(waited / 3_600_000).toFixed(1)}h, oltre il tetto di ${maxWaitMs / 3_600_000}h:`
        + ' si chiude a mercato anche se e\' ancora dentro banda. Un\'uscita che matura ma non si riempie tiene comunque fermo del capitale.',
      bandLo: b.lo, bandHi: b.hi, waitedMs: waited,
    };
  }

  return hold(
    b.readable
      ? `uscita dentro banda (${b.lo}–${b.hi})${waited != null ? `, a riposo da ${(waited / 3_600_000).toFixed(1)}h` : ''}: si aspetta`
      : 'banda non leggibile: non si afferma che l\'uscita ne sia fuori, quindi si aspetta (resta solo il tetto di tempo)',
    { bandLo: b.lo, bandHi: b.hi, waitedMs: waited },
  );
}

/**
 * IL PREZZO E' ANCORA QUELLO GIUSTO? Confronta un'uscita gia' a riposo col piano di adesso.
 *
 * NON SI ABBASSA MAI un'uscita gia' piazzata: alzarla insegue un mercato che sale (piu' guadagno),
 * abbassarla peggiora un'uscita gia' fatta. Quando il mercato scende non si insegue verso il basso —
 * a quel punto decide `decideExit`, che chiude a mercato invece di svendere un tick alla volta.
 */
function exitNeedsMove({ restingPrice, plan, tick } = {}) {
  if (!plan || plan.ok !== true) return { move: false, reason: 'nessun piano valido: non si tocca nulla' };
  if (!fin(restingPrice)) return { move: true, reason: 'nessuna uscita a riposo: la si piazza' };
  const t = fin(tick) && tick > 0 ? tick : 0.01;
  if (Math.abs(restingPrice - plan.price) < t / 1000) return { move: false, reason: 'l\'uscita e\' gia\' al prezzo giusto' };
  if (plan.price < restingPrice) {
    return { move: false, reason: `l'uscita a riposo (${restingPrice}) e' MIGLIORE del piano di adesso (${plan.price}): non si abbassa un'uscita gia' piazzata` };
  }
  return { move: true, reason: `l'uscita si alza da ${restingPrice} a ${plan.price}` };
}

module.exports = {
  planExit, decideExit, exitNeedsMove, snapTo, bandBounds,
  EXIT_PROFIT_PCT, MAX_WAIT_HOURS, MAX_WAIT_MS,
};

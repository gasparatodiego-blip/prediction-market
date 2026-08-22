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

// Il pavimento della chiusura peggiorativa vive in `urgenza-scoperto`, insieme alla scala che lo
// decide. Qui si IMPORTA: due copie di un limite di rischio che divergono in silenzio sono il
// reperto D1 dell'audit di scoperta, e questo e' un limite di rischio.
const { pavimentoConcesso } = require('./urgenza-scoperto');

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
 *
 * ⚠ UNA SOLA ECCEZIONE, E VA CHIESTA (22 agosto 2026): con `uscitaFuoriBanda: true` il chiamante
 * dichiara di aver PROVATO che completare la coppia e' economicamente impossibile, e allora l'uscita
 * puo' scegliere un prezzo FUORI dalla banda premiante — mai sotto il pavimento della scala. Senza
 * quel flag questa funzione si comporta riga per riga come prima. Dettaglio nel corpo.
 */
function planExit({ entryPrice, scoringMid, tick, bandRadiusCents = null, profitPct = EXIT_PROFIT_PCT,
  priceMax = null, concessioneTick = 0, uscitaFuoriBanda = false, miglioreBid = null } = {}) {
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

  // L'aritmetica del pavimento vive in UN punto solo (`urgenza-scoperto.pavimentoConcesso`): scriverla
  // qui sarebbe la seconda copia di un limite di rischio, cioe' il reperto D1. Si calcola QUI, prima
  // del clamp, perche' dal 22 agosto 2026 serve anche al ramo fuori banda qui sotto — e' lo stesso
  // numero di prima, spostato di venti righe, non un secondo pavimento.
  const pav = pavimentoConcesso({ carico: entryPrice, tick, concessioneTick });
  const pavimento = fin(pav.pavimento) ? pav.pavimento : entryPrice;
  // ⚠ IL PAVIMENTO COME PREZZO STA SULLA GRIGLIA, E L'ARROTONDAMENTO NON E' QUI — 22 agosto 2026.
  // `pavimentoConcesso` ne restituisce due: `pavimento` e' il limite ESATTO e serve a CONFRONTARE,
  // `pavimentoGriglia` e' lo stesso limite portato sulla griglia del mercato e serve a PREZZARE.
  // A valle `auto-close.inseguiIlBid` usa questo numero come `Math.max`, quindi quando il bid sta
  // sotto il pavimento il PREZZO DELL'ORDINE diventa il pavimento stesso: fuori griglia, il guard
  // condiviso lo rifiuta con `OFF_TICK` — 25 rifiuti veri a 0,646 su `0x4757745c` e 107 a 0,3515 su
  // `0xac3ee338`. L'arrotondamento vive in UN punto solo, ed e' `pavimentoConcesso`: qui si LEGGE.
  // Vale per ENTRAMBI i percorsi, quello in banda e quello fuori banda — nascendo dentro il solo ramo
  // fuori banda era la meta' della correzione, e la meta' che non serviva ai 132 rifiuti veri.
  const pavimentoGriglia = fin(pav.pavimentoGriglia) ? pav.pavimentoGriglia : pavimento;

  // ══ L'USCITA PUO' GUARDARE FUORI BANDA QUANDO LA COPPIA E' IMPOSSIBILE — 22 agosto 2026 ═══════════
  //
  // IL BUCO, e vale a prescindere dalla posizione che lo ha mostrato. Questa funzione sapeva produrre
  // SOLO prezzi dentro la banda premiante: il clamp qui sotto porta il prezzo a `b.hi`, e se `b.hi`
  // sta sotto il pavimento della scala il verdetto e' `no-target`, cioe' NESSUNA uscita. Il miglior
  // bid del libro non veniva nemmeno guardato. Misurato il 22 agosto 2026 su MrBeast `0x4757745c`:
  // bordo alto della banda 0,55, pavimento concesso 0,646, miglior bid reale 0,64 — fuori banda ma
  // NOVE centesimi meglio di qualunque prezzo in banda, e mai considerato.
  //
  // LA REGOLA (decisione dell'operatore): quando la gamba e' scoperta e completare la coppia e'
  // economicamente impossibile — carico + ask della sorella sopra il tetto di 101¢ — l'uscita
  // considera anche prezzi FUORI dalla banda premiante. Si rinuncia al premio su quella gamba pur di
  // non restare direzionali: un ordine fuori banda non matura nulla, ma una gamba nuda il cui esito
  // peggiore vale 100¢/share costa molto di piu'.
  //
  // ⚠ IL PAVIMENTO RESTA QUELLO DELLA SCALA, E NON SI ALLARGA DI UN CENTESIMO. Il prezzo e'
  // `max(pavimento, min(obiettivo, miglior bid))` — la STESSA aritmetica di `auto-close.inseguiIlBid`,
  // non una seconda: il pavimento e' un `Math.max`, quindi questo ramo puo' solo scegliere un prezzo
  // che la scala gia' consentiva. Se il pavimento resta sopra il bid, l'ordine sta a riposo fuori
  // banda e non si riempie finche' il bid non sale — ed e' la risposta voluta, non un difetto.
  //
  // ⚠ E' UN'OPZIONE DEL CHIAMANTE, MAI UN DIFETTO: senza `uscitaFuoriBanda === true` questa funzione
  // si comporta riga per riga come prima. Il chiamante deve aver PROVATO che la coppia e' impossibile
  // e che la gamba sorella non e' gia' in portafoglio (il merge viene prima, sempre): quella prova sta
  // in `auto-close.decideClose`, non qui, perche' qui non c'e' il libro dell'altro lato.
  //
  // ⚠ FAIL-CLOSED: bid non leggibile, pavimento non leggibile, tick assente ⇒ nessun ramo fuori banda
  // e comportamento identico a prima. Non sapere dove sta il libro non e' una ragione per uscirne.
  const fuoriBandaAmmessa = uscitaFuoriBanda === true
    && fin(miglioreBid) && miglioreBid > 0 && fin(pavimento) && pavimento > 0;
  const candidatoFuoriBanda = (fuoriBandaAmmessa && fin(pavimentoGriglia) && fin(target))
    ? Math.min(Math.max(pavimentoGriglia, Math.min(target, miglioreBid)), pMax)
    : null;

  let price = target;
  let clampedBy = marketAhead ? 'mercato-a-favore' : 'obiettivo';
  if (b.readable && b.hi != null && price > b.hi) { price = b.hi; clampedBy = 'banda'; }
  if (price > pMax) { price = pMax; clampedBy = 'limite-del-libro'; }

  // Il candidato fuori banda si prende SOLO se e' migliore del prezzo in banda: e' un `>`, quindi
  // questo ramo non puo' mai peggiorare un'uscita che la banda gia' consentiva.
  const fuoriBandaScelta = candidatoFuoriBanda != null && candidatoFuoriBanda > price + 1e-12;
  if (fuoriBandaScelta) {
    price = +candidatoFuoriBanda.toFixed(10);
    clampedBy = 'fuori-banda-coppia-impossibile';
  }

  if (!(price > 0) || price >= 1) {
    return out(`il prezzo di uscita calcolato (${price}) e' fuori dai limiti del libro`, { target, bandLo: b.lo, bandHi: b.hi });
  }
  // ── LA BANDA E' SCESA SOTTO IL CARICO ──────────────────────────────────────────────────────────
  // Senza concessione (`concessioneTick = 0`, il difetto) il pavimento E' il carico e questo ramo si
  // comporta ESATTAMENTE come prima: nessun prezzo dentro banda sarebbe in guadagno, quindi non si
  // piazza un'uscita in perdita per restare premiati.
  //
  // ⚠ CON LA CONCESSIONE il pavimento scende, e il rifiuto diventa condizionato. La concessione la
  // decide `urgenza-scoperto` dal TEMPO DI SCOPERTURA (§5 p.138) e vale solo su una posizione rimasta
  // scoperta oltre le due ore: e' il caso misurato il 13 agosto 2026, dove il bordo alto della banda
  // era ESATTAMENTE il carico (0,43 contro 0,43) e questo `<=` produceva `no-target` per otto ore.
  //
  // ⚠ LA CONCESSIONE NON ESCE DALLA BANDA, e non e' una promessa ma una conseguenza: si arriva qui
  // solo quando `b.hi <= entryPrice`, cioe' il bordo ALTO della banda sta sotto il carico; un prezzo
  // fra il pavimento e il carico e' quindi sotto `b.hi`, cioe' DENTRO la banda. Il prezzo che si
  // restituisce resta `b.hi`, che e' il migliore disponibile dentro banda — la concessione decide se
  // accettarlo, non lo peggiora oltre.
  //
  // L'aritmetica del pavimento vive in UN punto solo (`urgenza-scoperto.pavimentoConcesso`): scriverla
  // qui sarebbe la seconda copia di un limite di rischio, cioe' il reperto D1.
  // ⚠ IL CONFRONTO E' STRETTO O LARGO A SECONDA DI CHI CHIAMA, e la differenza NON e' un dettaglio:
  // e' il caso reale del 13 agosto, dove il bordo della banda era ESATTAMENTE il carico (0,43 contro
  // 0,43) e il vecchio `<=` rifiutava un'uscita in PAREGGIO — che non e' una perdita, e che almeno
  // matura premi mentre aspetta.
  //   · chiamante ordinario (`profitPct > 0`, nessuna concessione) ⇒ `<=`, cioe' ESATTAMENTE il
  //     comportamento di prima: serve un guadagno stretto, il pareggio non basta;
  //   · chiamante in urgenza (`profitPct === 0`, dal gradino 2) ⇒ `<`, cioe' il pareggio basta;
  //   · con una concessione in tick (dal gradino 3) il pavimento e' gia' sceso sotto il carico.
  // La scala non puo' quindi allentare niente per sbaglio: senza `urgenza-scoperto` che passa
  // `profitPct: 0`, questo ramo e' la riga di prima.
  //
  // ⚠ E IL RIFIUTO NON SI APPLICA QUANDO L'USCITA E' GIA' USCITA DALLA BANDA APPOSTA (22 agosto 2026).
  // Questo ramo dice «nessun prezzo DENTRO BANDA sarebbe accettabile»: e' vero, ed e' precisamente la
  // condizione in cui il ramo fuori banda esiste per rispondere. Il prezzo scelto la' e' per
  // costruzione `>= pavimentoGriglia >= pavimento`, quindi non c'e' niente da rifiutare.
  const pareggioAmmesso = !(profitPct > 0 && concessioneTick <= 0);
  const sottoPavimento = pareggioAmmesso
    ? b.hi < pavimento - 1e-12
    : b.hi <= pavimento;
  if (b.readable && b.hi != null && sottoPavimento && !fuoriBandaScelta) {
    return out(
      `la banda premiante corrente (fino a ${b.hi}) e' sotto il pavimento di uscita (${pavimento}):`
      + (pav.tickConcessi > 0
        ? ` nemmeno la concessione di ${pav.tickConcessi} tick sotto il carico (${entryPrice}) basta. ${pav.motivo}`
        : ' nessuna uscita dentro banda sarebbe in guadagno. Non si piazza un ordine in perdita per restare premiati.'),
      { target, bandLo: b.lo, bandHi: b.hi, belowEntry: true,
        pavimento, tickConcessi: pav.tickConcessi, limitatoDa: pav.limitatoDa },
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
        : clampedBy === 'fuori-banda-coppia-impossibile'
          ? `uscita FUORI dalla banda premiante (${b.lo}\u2013${b.hi}) a ${price}: completare la coppia e'`
            + ' economicamente impossibile, quindi l\'unica alternativa a questo prezzo e\' restare'
            + ` direzionali. Il prezzo e' il maggiore fra il pavimento della scala (${pavimentoGriglia})`
            + ` e il miglior bid (${miglioreBid}), fermato all'obiettivo ${target} —`
            + ` ${realizedPct}% sul carico di ${entryPrice}. Non matura premi mentre aspetta.`
          : `uscita LIMITATA DALLA BANDA: l'obiettivo ${target} cadeva oltre il bordo premiante ${b.hi},`
            + ` quindi si esce al bordo (${realizedPct}% sul carico) dove l'attesa matura`;

  // ⚠ UN'USCITA SOTTO IL CARICO NON PASSA MUTA. `peggiorativa` viaggia nel piano perche' chi legge —
  // il ramo che piazza, l'audit, l'operatore — sappia che quella riga sta accettando una perdita, e
  // quanta. Senza questo campo una chiusura in perdita sarebbe indistinguibile da una in guadagno.
  const peggiorativa = price < entryPrice - 1e-12;
  return {
    ok: true, price, target, bandLo: b.lo, bandHi: b.hi, clampedBy, profitPct: realizedPct,
    reason: peggiorativa
      ? `USCITA PEGGIORATIVA a ${price}, cioe' ${realizedPct}% sul carico di ${entryPrice}:`
        + ` ${pav.tickConcessi} tick concessi dalla scala di urgenza (${pav.motivo}).`
        + ' Si accetta questa perdita per non restare direzionali — l\'alternativa non e\' zero,'
        + ' e\' un\'esposizione il cui esito peggiore vale 100¢/share.'
      : reason,
    peggiorativa,
    // ⚠ IL PAVIMENTO CHE ESCE E' QUELLO CHE SI PUO' PREZZARE, SU ENTRAMBI I PERCORSI. A valle
    // `auto-close.inseguiIlBid` lo riusa come `Math.max`, e restituire qui il numero esatto lo
    // riporterebbe fuori griglia — cioe' produrrebbe di nuovo un prezzo che il guard condiviso
    // rifiuta come `OFF_TICK`, che e' il difetto dei 132 rifiuti veri. Il numero esatto resta a
    // verbale accanto, perche' l'audit dei giorni scorsi lo contiene e i due periodi devono restare
    // confrontabili.
    pavimento: pavimentoGriglia,
    pavimentoNonArrotondato: pavimento,
    fuoriBanda: fuoriBandaScelta,
    miglioreBid: fin(miglioreBid) ? miglioreBid : null,
    tickConcessi: pav.tickConcessi, limitatoDa: pav.limitatoDa,
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
function decideExit({ exitPrice, restingSinceMs, now = Date.now(), scoringMid, bandRadiusCents, tick,
  maxWaitMs = MAX_WAIT_MS, fuoriBandaVoluta = false } = {}) {
  const hold = (reason, extra = {}) => ({ action: 'hold', trigger: null, reason, ...extra });
  if (!fin(exitPrice)) return hold('nessuna uscita a riposo da giudicare');

  const waited = fin(restingSinceMs) ? Math.max(0, now - restingSinceMs) : null;
  const b = bandBounds({ scoringMid, bandRadiusCents, tick });

  // ⚠ IL TRIGGER DI BANDA NON PUO' GIUDICARE UN'USCITA CHE E' FUORI BANDA APPOSTA — 22 agosto 2026.
  // `band-exit` chiude A MERCATO, cioe' vende al miglior bid: su un'uscita piazzata deliberatamente
  // fuori banda (coppia impossibile, v. `planExit`) scatterebbe al primo ciclo e venderebbe SOTTO il
  // pavimento che la scala concede — trasformando una regola nata per smettere di aspettare in un
  // modo di aggirare il pavimento del rischio. Con `fuoriBandaVoluta: true` il trigger 1 non si
  // valuta e lo dichiara; il trigger 2 (tetto di attesa) resta intatto, perche' non dipende dalla
  // banda ed e' l'unica via d'uscita che non passa dal pavimento.
  // ⚠ FAIL-CLOSED NEL VERSO GIUSTO: il difetto e' `false`, cioe' il comportamento di prima.
  // 1 · FUORI BANDA — solo se la banda si e' potuta leggere.
  if (b.readable && fuoriBandaVoluta !== true) {
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
    b.readable && fuoriBandaVoluta === true
      ? `uscita FUORI banda (${b.lo}–${b.hi}) per decisione, perche' completare la coppia e' impossibile:`
        + ` il trigger di banda non si applica${waited != null ? `, a riposo da ${(waited / 3_600_000).toFixed(1)}h` : ''}.`
        + ' Non matura premi mentre aspetta, e resta solo il tetto di tempo'
      : b.readable
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

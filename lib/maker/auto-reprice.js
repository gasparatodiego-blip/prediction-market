'use strict';
const { raggioBandaCents } = require('../banda-premiante');
// lib/maker/auto-reprice.js — AUTOMATIC BAND-EXIT RE-PRICING for hand-placed orders.
//
// THE CHANGE THIS IMPLEMENTS. A manual order used to carry a fixed ~180s GTD expiry: the venue killed it
// on a clock, whatever the price was doing. That is backwards for a reward maker — what matters is not
// how long the order has rested but whether it is still inside the band that pays. So, for a market whose
// auto-reprice switch is ON, THIS is what moves the order, on TWO triggers that share one mechanism:
//   • BAND EXIT — the mid has travelled far enough to push the order out of the band that pays. If the
//     mid does not move that far, the order is NOT TOUCHED: no cancel, no replace, no churn.
//   • PROACTIVE RENEWAL — the order's venue-side GTD window is running out while its price is still fine,
//     so it is re-placed at the SAME price to reset the clock, with margin to spare.
// The window exists precisely so it can lapse: it is the DEAD-MAN'S SWITCH the exchange enforces if this
// host stops renewing. Both numbers live in lib/maker/auto-reprice-config.js and nowhere else.
//
// IT ADDS NO AUTHORITY. Every belt that governs a hand order governs this one, because it does not
// re-implement placement: it calls lib/maker/manual-order.replaceManualOrder, the SAME function the
// panel's "Riprezza" button calls, which runs manual-ownership → venue-rules → caps → kill →
// the adapter's own chain → the exchange's validateOrder(). What this module adds is SUBTRACTIVE:
//
//   1. IT ONLY ACTS WHERE IT IS SWITCHED ON. Global master switch AND per-market opt-in, both durable,
//      both default OFF, both fail-closed to OFF (lib/maker/auto-reprice-config.js).
//   2. IT ONLY TOUCHES THE PANEL'S OWN ORDERS. An order it cannot POSITIVELY attribute to the manual
//      panel (by idempotency key / order id in the append-only audit trail) is left alone. agent35's
//      orders and unattributable orders are never candidates — not "probably ours", PROVABLY ours.
//   3. IT REFUSES TO ACT ON A MID IT DOES NOT TRUST. The mid must come from agent34's LIVE book and be
//      fresh. A stale mid is how an automatism walks an order somewhere nobody asked for, so an unfresh
//      or board-row mid produces a SKIP, never a re-price.
//   4. IT CHECKS THE KILL SWITCH BEFORE IT CANCELS ANYTHING. A re-price is a cancel followed by a place;
//      if the place would be refused, cancelling first would leave the operator with nothing resting for
//      no reason. So kill is read up front and a killed system does nothing at all.
//   5. IT HAS ITS OWN RAILS: confirm-samples, hysteresis, a per-order rate limit and a per-market hourly
//      ceiling. An automatism without a runaway guard is not a feature, it is an incident waiting.
//   6. IT VALIDATES THE REPLACEMENT BEFORE PROPOSING IT. If the new price would not itself pass the
//      shared guard, it does nothing — it never cancels an order it cannot validly replace.
//      QUESTA PROMESSA ERA VERA A META' FINO ALL'11 AGOSTO 2026, e la meta' mancante ha prodotto l'unico
//      danno misurato in venti giorni di storico. `validateQuote` qui sotto verifica tick, banda e size
//      minima — cioe' le regole del VENUE — ma non i due limiti NOSTRI che il piazzamento applica dopo:
//      il tetto per ordine e il registro di idempotenza. Otto volte il ciclo ha cancellato convinto di
//      poter ripiazzare e si e' visto rifiutare il ripiazzo da uno di quei due. La verifica completa vive
//      ora dove avviene davvero la cancellazione — `manual-order.replaceManualOrder`, cinque precontrolli
//      prima dello STEP 1 — cosi' la garanzia vale per OGNI chiamante, non solo per questo ciclo. Vedi
//      §5 punto 73 di CLAUDE.md e `lib/maker/riprezzo-atomico.test.js`.
//   7. IT CANCELS RATHER THAN GUESSES AFTER A BLACKOUT. Back from a long spell unable to reach the venue,
//      it retires the hand orders it can no longer vouch for instead of renewing on an unobserved state.
//
// EVERYTHING IT DOES IS STAMPED source:'auto-reprice-band-exit' in the one append-only maker trail —
// distinct from 'manual-ui' (a human pressed a button) and from 'agent35' (the automatic engine), so the
// trail always answers "what moved this order" without anyone having to infer it.
//
// The DECISION is pure (decideReprice) so the selfcheck can exhaust it with no venue, no files and no
// clock. The CYCLE (runAutoRepriceCycle) takes every side effect as an injected dependency for the same
// reason — the simulated tests drive a whole scenario without a single network call.

/**
 * QUALE LIMITE DI ETA' DEL MID VALE ADESSO, e perche'.
 *
 * IL PROBLEMA CHE RISOLVE. `midAgeSec` misura «da quanto il venue non dice niente su QUESTO asset».
 * Su un libro fermo quel numero cresce mentre il nostro quadro resta esatto — misurato il 5 agosto
 * 2026 su TX-15: al picco di 35s di eta' il book memorizzato coincideva alla virgola con la lettura
 * REST. Trattare quel silenzio come «dato inaffidabile» rendeva cieco il motore per ~17% dei cicli.
 *
 * IL SEGNALE CHE DISAMBIGUA. Il silenzio su un asset significa «nessuna notizia» SOLO se il socket
 * sta consegnando eventi su altri asset. agent34 pubblica il conteggio (feed.vitality); qui si
 * decide che farsene.
 *
 * NEL DUBBIO, SEVERO. Vitalita' assente, illeggibile, o un denominatore troppo piccolo perche' il
 * conteggio voglia dire qualcosa ⇒ regime «incerto» ⇒ limite severo. Un campo che non sappiamo
 * leggere non e' un permesso: e' esattamente il caso in cui non sappiamo se il libro e' fermo o se
 * abbiamo perso la connessione.
 *
 * @param {{assetsWithEvents:number, seededAssets:number, windowMs:number}|null|undefined} vit
 * @param {{maxMidAgeSecLive:number, maxMidAgeSecBlind:number, feedAliveMinAssets:number}} cfg
 * @returns {{regime:'vivo'|'muto'|'incerto', limite:number, perche:string}}
 */
function regimeFeed(vit, cfg = {}) {
  const severo = Number.isFinite(cfg.maxMidAgeSecBlind) ? cfg.maxMidAgeSecBlind : 10;
  const permissivo = Number.isFinite(cfg.maxMidAgeSecLive) ? cfg.maxMidAgeSecLive : 60;
  const minAsset = Number.isFinite(cfg.feedAliveMinAssets) ? cfg.feedAliveMinAssets : 5;

  if (!vit || typeof vit !== 'object' || !Number.isFinite(vit.assetsWithEvents)) {
    return { regime: 'incerto', limite: severo, perche: 'agent34 non pubblica la vitalita del feed' };
  }
  // Il conteggio ha senso solo con un denominatore che lo regga: chiedere «almeno 5 asset attivi»
  // quando ne esistono 3 e' una condizione impossibile, non un test. Li' non si sa, quindi severo.
  const seeded = Number.isFinite(vit.seededAssets) ? vit.seededAssets : null;
  if (seeded == null || seeded < minAsset) {
    return { regime: 'incerto', limite: severo,
      perche: `asset con book solo ${seeded == null ? '?' : seeded}, sotto il minimo ${minAsset}: il conteggio non e' interpretabile` };
  }
  if (vit.assetsWithEvents >= minAsset) {
    return { regime: 'vivo', limite: permissivo,
      perche: `eventi su ${vit.assetsWithEvents}/${seeded} asset negli ultimi ${Math.round((vit.windowMs || 0) / 1000)}s` };
  }
  return { regime: 'muto', limite: severo,
    perche: `eventi su soli ${vit.assetsWithEvents}/${seeded} asset negli ultimi ${Math.round((vit.windowMs || 0) / 1000)}s (minimo ${minAsset})` };
}

const { validateQuote, inBandPriceBounds } = require('./venue-rules');

// ── LA SCALA DEL BOOK PER IL MOTORE UNICO ────────────────────────────────────────────────────────
//
// PERCHE' ESISTE. Il veto del motore (`valutaMercato`) riceveva `bookLevels: d.bookLevels`, dove `d`
// e' il ritorno di `decideReprice` — che quella proprieta' non l'ha mai restituita. Risultato:
// `null` a ogni chiamata, la Regola 1 rispondeva «non leggibile» e usciva subito, e le Regole 2-5
// non giravano mai. Fra le 20:37 e le 21:48 del 6 agosto 2026 sono 295 veti su 295 con quella sola
// causa, e otto ordini morti di scadenza senza rinnovo. La scala era gia' nel ciclo: `resolveDepth`
// la risolve e `prezzoInCoda` la usa due volte nelle stesse iterazioni. Mancava solo passarla.
//
// LO SPAZIO BID. `top-of-book` dichiara il proprio contratto: «la scala e' sempre in spazio BID, per
// la vendita il chiamante ha gia' specchiato». `controlloMaiPrimo` non ha nemmeno un parametro
// `side`, quindi quel contratto non e' negoziabile: una scala di ask grezzi gli farebbe leggere il
// livello PEGGIORE come miglior prezzo altrui. Quindi in vendita si specchia tutto — livelli, mid,
// estremi di banda, nostri ordini — e si dichiara `side: 'BUY'`, perche' dopo lo specchio quella e'
// la verita': si sta ragionando su bid.
//
// COSA NON SI SPECCHIA: `proposedPrice`. Serve alla Regola 5 per il controvalore (prezzo x size), e
// un prezzo specchiato darebbe un notional inventato. Resta quello vero.
const specchiaPrezzo = (p) => +(1 - p).toFixed(10);

function scalaPerIlMotore({ rules = null, book = null, side = 'BUY', scoringMid = null, ownOrders = [], depth = null } = {}) {
  const nulla = (motivo) => ({ bookLevels: null, bandBounds: null, scoringMid, ownOrders, motivo });
  if (!rules || rules.readable !== true) return nulla('regole di venue non leggibili');
  // Si guarda la SCALA, non il flag: `prezzoInCoda` fa lo stesso, e legare il motore a `readable`
  // significherebbe che una sorgente di profondità che non lo dichiara — ma i livelli ce li ha —
  // spegne le Regole 2-5 in silenzio. Il flag serve solo a dare un motivo migliore quando manca.
  if (!depth) return nulla('profondità del book non risolta per questo mercato');
  const vendita = String(side).toUpperCase() === 'SELL';
  const lato = String(book).toLowerCase() === 'no' ? depth.no : depth.yes;
  const grezza = lato && Array.isArray(vendita ? lato.asks : lato.bids) ? (vendita ? lato.asks : lato.bids) : null;
  if (!Array.isArray(grezza)) {
    return nulla(depth.readable === false && depth.reason
      ? depth.reason
      : `lo snapshot non pubblica i livelli ${vendita ? 'ask' : 'bid'} di questo libro`);
  }
  const b = inBandPriceBounds({ tick: rules.tick, scoringMid, maxSpreadCents: rules.maxSpreadCents, minSize: rules.minSize });
  const bounds = b && b.readable === true && Number.isFinite(b.lo) && Number.isFinite(b.hi) ? { lo: b.lo, hi: b.hi } : null;
  if (!vendita) return { bookLevels: grezza, bandBounds: bounds, scoringMid, ownOrders: ownOrders || [], motivo: null };
  return {
    bookLevels: grezza
      .map((l) => ({ price: specchiaPrezzo(Number(l && l.price)), size: Number(l && l.size) }))
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size)),
    // Specchiare inverte anche l'ordine: il basso diventa alto.
    bandBounds: bounds ? { lo: specchiaPrezzo(bounds.hi), hi: specchiaPrezzo(bounds.lo) } : null,
    scoringMid: Number.isFinite(scoringMid) ? specchiaPrezzo(scoringMid) : scoringMid,
    ownOrders: (ownOrders || []).map((o) => ({
      ...o, price: Number.isFinite(Number(o && o.price)) ? specchiaPrezzo(Number(o.price)) : null,
    })),
    motivo: null,
  };
}
const { inBand } = require('../rewards-live-band');
// La selezione dei NOSTRI ordini su un lato — condivisa con `manual-order` (percorso di piazzamento).
const { nostriSulLato: nostriOrdiniSulLato } = require('./nostri-ordini');
// Il lock per mercato che chiude la corsa cancel+place del 16 agosto 2026 — vedi GATE 1-bis nel ciclo.
const LOCK = require('./lock-mercato');
// La prova che un ordine sta RINNOVANDO e non aprendo: esenta dal pavimento di profondita'. Vedi §5.2 p.21.
const RINNOVO = require('./esenzione-rinnovo');
const {
  isAutoRepriceEnabled, readAutoRepriceConfig, readAutoRepriceState, recordAutoRepriceState,
  loadAutoRepriceTuning, AUTO_REPRICE_SOURCE,
  RESTING_GTD_SECONDS, REFRESH_MARGIN_SECONDS, DISCONNECT_CANCEL_SECONDS,
} = require('./auto-reprice-config');
const { resolveOffsetFor, rememberObserved } = require('./offset-config');
const { endOfScaleCheck } = require('./end-of-scale');
// «Mai primi sul libro», la STESSA funzione che decide il prezzo al piazzamento. Qui serve per la
// domanda opposta: un ordine gia' a riposo e' diventato il migliore del suo lato?
const { prezzoInCoda } = require('./prezzo-in-coda');
// Il margine dal bordo premiante: la STESSA definizione che usa il piazzamento (`top-of-book`), o il
// prezzo di rientro e quello di apertura sarebbero due decisioni diverse sullo stesso ordine.
const { bordiConMargine } = require('./distanza-obiettivo');
// IL MOTORE UNICO. Una sola valutazione per ogni ordine — nessuna biforcazione per profilo, che dal
// 6 agosto 2026 non esiste piu': la formula del venue e' una curva continua e non conosce bucket.
// `latoSingolo` risponde con la formula (qMin) alla domanda «un lato solo qui matura qualcosa?».
const { latoSingolo } = require('./motore-unico');
const { decidiStantio, registroStantio, timeoutMs: timeoutStantioMs, eCieco, causaCecita, motivoCecita } = require('./mid-stantio');
const { verdettoOrfano, ORFANO: ORFANO_CONFERMATO } = require('./ordine-orfano');

// ── L'OROLOGIO DELLA CECITÀ, PER MERCATO ────────────────────────────────────────────────────────
// Vive fuori dal ciclo perché deve sopravvivere fra un giro e l'altro: è la memoria di «da quando non
// vediamo il prezzo di questo mercato». NON sopravvive al riavvio, e non deve: dopo un riavvio non
// sappiamo da quanto eravamo ciechi, e ricominciare da zero è insieme l'unica risposta onesta e la più
// prudente — si aspetta di nuovo il timeout intero prima di cancellare qualcosa.
// Iniettabile per i test, come tutto il resto di questo modulo.
const registroStantioGlobale = registroStantio();

// ── THE PURE DECISION ────────────────────────────────────────────────────────────────────────────────

/**
 * Decide what to do with ONE resting order, given the market's CURRENT live rules.
 *
 * Returns one of three actions, and NAMES ITS REASON in every case (there is never a silent no-op):
 *   'hold'    — the order is still inside the band. DO NOT TOUCH IT. This is the answer the whole
 *               feature exists to produce: a resting order that the mid has not invalidated is left
 *               exactly where it is, for as long as that stays true. No clock can change this answer.
 *   'reprice' — the mid has moved enough that the order is out of the band by more than the hysteresis,
 *               the breach has been confirmed on consecutive samples, and the rails allow acting.
 *               `targetPrice` is the price to move to, already proven valid by the shared guard.
 *   'skip'    — something is not trustworthy or not permitted right now (stale mid, unreadable rules,
 *               rate limit, hourly ceiling, a replacement that would not itself qualify). SKIP LEAVES
 *               THE ORDER ALONE too — it differs from 'hold' only in WHY, and the why is reported.
 *
 * @param {object} args
 *   order   { orderId, price, size, book:'yes'|'no' }  — size is the size the replacement will carry
 *   rules   the resolveMarketRules() shape: { readable, mid, tick, maxSpreadCents, minSize, midSource,
 *           midAgeSec, feedLive, books:{ yes:{scoringMid}, no:{scoringMid} } }
 *   config  loadAutoRepriceTuning() shape
 *   lastRepriceAt      epoch ms of the last automatic re-price ON THIS MARKET, or null. Market-keyed,
 *                      not order-keyed: a re-price mints a new order id, so an id-keyed limit would
 *                      never bind on the replacement.
 *   consecutiveBreaches how many consecutive prior cycles have already seen this order out of band
 *   repricesThisHour   how many automatic re-prices this MARKET has had in the rolling hour
 *   now     epoch ms
 * @returns {{action:'hold'|'reprice'|'skip', gate:(string|null), reason:string,
 *            targetPrice:(number|null), distanceC:(number|null), bandRadiusC:(number|null),
 *            scoringMid:(number|null), breachConfirmed:boolean}}
 */
function decideReprice({ order, rules, config, lastRepriceAt = null, consecutiveBreaches = 0, repricesThisHour = 0, now = Date.now(), ownOrders = null } = {}, deps = {}) {
  const cfg = config || loadAutoRepriceTuning();
  const out = (action, gate, reason, extra = {}) => ({
    action, gate, reason,
    targetPrice: null, distanceC: null, bandRadiusC: null, scoringMid: null, breachConfirmed: false,
    ...extra,
  });

  const o = order || {};
  const price = Number(o.price);
  const size = Number(o.size);
  const book = o.book === 'no' ? 'no' : 'yes';

  if (!Number.isFinite(price) || !Number.isFinite(size) || !(price > 0) || !(size > 0)) {
    return out('skip', 'order-unreadable', 'the resting order has no usable price/size — refusing to judge it (a check that could not run is not a check that passed)');
  }

  // ── GATE: the market's rules must be readable at all. Fail closed, exactly as placement does. ──
  if (!rules || rules.readable !== true) {
    const missing = rules && Array.isArray(rules.missing) ? rules.missing.join(', ') : 'unknown';
    return out('skip', 'rules-unreadable', `venue rules not readable (missing: ${missing}) — no band to judge against, so nothing is touched`);
  }

  // ── GATE: THE MID MUST BE ONE WE TRUST. ──
  // (la scelta del limite vive in regimeFeed(), sotto — funzione pura, verificabile da sola)
  // This is the single most important refusal in the module. Re-pricing is driven ENTIRELY by the mid;
  // acting on a stale or second-hand mid means moving a real order on the strength of a number that no
  // longer describes the book. Both conditions fail CLOSED (skip), never "probably fine".
  if (cfg.requireLiveBook && rules.midSource !== 'live-book') {
    return out('skip', 'mid-not-live', `the mid comes from ${rules.midSource || 'an unknown source'}, not agent34's live book — refusing to move a real order on a second-hand mid`);
  }
  const reg = regimeFeed(rules.feedVitality, cfg);
  if (Number.isFinite(reg.limite) && Number.isFinite(rules.midAgeSec) && rules.midAgeSec > reg.limite) {
    return out('skip', 'mid-stale',
      `il mid e' vecchio di ${rules.midAgeSec}s, oltre i ${reg.limite}s ammessi in regime «${reg.regime}» (${reg.perche})`
      + ' — non si muove un ordine reale contro un prezzo vecchio',
      { feedRegime: reg.regime, feedPerche: reg.perche, maxMidAgeSecApplicato: reg.limite });
  }
  if (!Number.isFinite(rules.midAgeSec) && cfg.requireLiveBook) {
    return out('skip', 'mid-age-unknown', 'the age of the mid could not be read — refusing (an age we cannot read is not an age within limits)');
  }

  // Each side is judged in ITS OWN book's space: a NO order at q IS a YES order at 1−q. Same mirror the
  // engine and the placement path use — never a second interpretation of it.
  const scoringMid = book === 'no' ? (rules.books && rules.books.no ? rules.books.no.scoringMid : null) : (rules.books && rules.books.yes ? rules.books.yes.scoringMid : null);
  const tick = rules.tick;
  const maxSpreadCents = rules.maxSpreadCents;
  if (!Number.isFinite(scoringMid) || !(tick > 0) || !(maxSpreadCents > 0)) {
    return out('skip', 'band-unreadable', 'scoring mid / tick / band could not be read for this side — nothing is touched (never a guessed band)');
  }

  const bandRadiusC = raggioBandaCents(maxSpreadCents);
  const distanceC = Math.abs(price - scoringMid) * 100;
  const base = { scoringMid, distanceC: +distanceC.toFixed(4), bandRadiusC: +bandRadiusC.toFixed(4) };

  // ── HOW MUCH LIFE IS LEFT ON THE VENUE-SIDE EXPIRY ────────────────────────────────────────────────
  // `secondsToExpiry` comes from the venue's own `expiration` field, already corrected for the 60s the
  // exchange retires GTD orders early (see listManualOrders). null ⇒ GTC, no deadline, so the expiry
  // trigger simply never fires for that order.
  const ttlLeft = Number.isFinite(o.secondsToExpiry) ? o.secondsToExpiry : null;
  const margin = Number.isFinite(cfg.refreshMarginSeconds) ? cfg.refreshMarginSeconds : REFRESH_MARGIN_SECONDS;
  const expiring = ttlLeft != null && ttlLeft <= margin;
  const withTtl = { ...base, secondsToExpiry: ttlLeft, refreshMarginSeconds: margin, expiring };

  // ── TRIGGER 3: THE MID CHASE ────────────────────────────────────────────────────────────────────
  // The order holds a fixed DISTANCE from the mid, not a fixed price. mid 10 with orders at 7 and 13
  // (distance −3/+3) becomes 8 and 14 when the mid moves to 11. Computed BEFORE the band test because
  // it applies whether or not the order is still in band — a chase that also fixes a band exit is one
  // move, not two.
  //
  // WHICH SIDE OF THE MID the order sits on is preserved: the target is mid ± target, with the sign
  // taken from where the order already is. Flipping an order across the mid would not be "keeping its
  // distance", it would be a different order.
  const belowMid = price <= scoringMid;
  const observedOffsetC = distanceC;
  const off = (deps && typeof deps.resolveOffset === 'function')
    ? deps.resolveOffset({ marketId: rules.marketId, book, observedOffsetCents: observedOffsetC, tick })
    : resolveOffsetFor({ marketId: rules.marketId, book, observedOffsetCents: observedOffsetC, tick }, deps.offsetDeps || {});
  const targetOffC = off.targetOffsetCents;
  const minMoveC = off.minMoveCents;
  // N, la profondità richiesta davanti. Dalla STESSA risoluzione che porta distanza e soglia — un solo
  // posto da cui arrivano i tre parametri per-mercato, quindi non possono descrivere mercati diversi.
  // 0 o assente ⇒ protezione spenta ⇒ ogni chiamata a `prezzoInCoda` qui sotto è quella di sempre.
  const depthMultipleN = Number.isFinite(off.depthMultiple) && off.depthMultiple > 0 ? off.depthMultiple : null;
  const chase = { targetOffsetCents: targetOffC, offsetSource: off.source, minMoveCents: minMoveC, currentOffsetCents: +observedOffsetC.toFixed(4), depthMultiple: depthMultipleN };

  let chaseTarget = null;
  let chaseDriftC = null;
  if (Number.isFinite(targetOffC) && targetOffC > 0) {
    chaseDriftC = +(observedOffsetC - targetOffC).toFixed(4);
    // The price that restores the target distance on the SAME side of the mid, snapped to the grid.
    const raw = belowMid ? scoringMid - targetOffC / 100 : scoringMid + targetOffC / 100;
    chaseTarget = +(Math.round(raw / tick) * tick).toFixed(10);
  }

  // ── THE ACTUAL QUESTION: is the order still in the band? Uses the SSOT (rewards-live-band.inBand),
  //    the same predicate validateQuote's OUT_OF_BAND check calls. No parallel band math anywhere. ──
  if (inBand(price, scoringMid, maxSpreadCents)) {
    // ── IL TETTO ORARIO FERMA UN RIPREZZO, NON DEVE POTER UCCIDERE UN ORDINE ─────────────────────────
    //
    // COSA È SUCCESSO IL 5 AGOSTO 2026, con i minuti. Su Eric Barlow il tetto orario è stato toccato
    // alle 20:40:44 (21 riprezzi nell'ora, tetto 20). Da quel momento OGNI ciclo trovava l'inseguimento
    // dovuto, entrava in questo ramo, e usciva con `skip-hourly-cap` — 540 righe identiche fino alle
    // 21:03:08. Il rinnovo proattivo di scadenza, che vive nel ramo `expiring` QUI SOTTO, non è mai
    // stato nemmeno valutato: la skip dell'inseguimento tornava prima. Alle ~21:02:34 la GTD è scaduta
    // e i due ordini sono spariti dal venue senza una cancellazione, senza un fill e senza un avviso.
    //
    // LA DISTINZIONE CHE MANCAVA. Un riprezzo bloccato è prudenza: l'ordine resta dov'è, a riposo, e
    // continua a maturare. Un RINNOVO bloccato è una scadenza garantita — l'unica differenza fra
    // «non ti muovo» e «ti lascio morire» è se qualcuno rinnova l'orologio che il venue tiene.
    // Il tetto esiste per fermare una fuga di riprezzi, non per svuotare il libro.
    //
    // COME È DISTINTO IN MODO NON AGGIRABILE. La condizione dell'esenzione è `expiring`, cioè
    // `secondsToExpiry <= refreshMarginSeconds`, e `secondsToExpiry` viene dal campo `expiration` che
    // il VENUE pubblica sull'ordine (vedi listManualOrders) — non da un flag che questo modulo o il
    // chiamante possano dichiarare. Un riprezzo discrezionale non può quindi travestirsi da rinnovo:
    // per ottenere l'esenzione dovrebbe far scadere davvero l'ordine, e a quel punto il rinnovo è
    // esattamente ciò che serve. E il prezzo non è quello dell'inseguimento: il ramo `expiring`
    // ripiazza allo STESSO prezzo, e il ramo fuori banda al prezzo di rientro in banda.
    //
    // PERCHÉ NON RIAPRE LA FUGA. Ogni rinnovo conia un ordine con una finestra piena
    // (restingGtdSeconds), quindi `expiring` non può tornare vero prima di (finestra − margine) = 20
    // minuti: al massimo 3 rinnovi/ora per gamba, contro un tetto di 20. Il limite di 30s per gamba
    // continua a valere, e tutti gli altri gate restano al loro posto — mai-primo-sul-libro, banda
    // premiante, book stale, manual-mode. L'esenzione riguarda IL SOLO CONTEGGIO del tetto.
    //
    // I rinnovi esentati vengono comunque REGISTRATI nel conteggio orario: l'esenzione non li rende
    // invisibili, altrimenti il tetto perderebbe la memoria di ciò che è successo davvero.
    const inseguimentoDovuto = chaseTarget != null && Math.abs(chaseDriftC) > minMoveC + 1e-9;
    let railInseguimento = null;
    if (inseguimentoDovuto) {
      if (lastRepriceAt != null && Number.isFinite(cfg.minIntervalMs) && (now - lastRepriceAt) < cfg.minIntervalMs) {
        railInseguimento = { gate: 'rate-limited',
          reason: `inseguimento dovuto (distanza ${observedOffsetC.toFixed(3)}¢ contro target ${targetOffC}¢) ma questa gamba e' stata mossa ${Math.round((now - lastRepriceAt) / 1000)}s fa — si attende il minimo di ${Math.round(cfg.minIntervalMs / 1000)}s` };
      } else if (Number.isFinite(cfg.maxPerHour) && repricesThisHour >= cfg.maxPerHour) {
        railInseguimento = { gate: 'hourly-cap',
          reason: `inseguimento dovuto ma questo mercato ha gia' avuto ${repricesThisHour} riprezzi nell'ultima ora (tetto ${cfg.maxPerHour})` };
      }
      // Il rail ferma l'inseguimento, che è discrezionale. Se la scadenza è dentro il margine NON si
      // torna qui: si prosegue fino al ramo del rinnovo, che decide con le sue regole.
      if (railInseguimento && !expiring) {
        return out('skip', railInseguimento.gate, railInseguimento.reason, { ...withTtl, ...chase });
      }
    }
    if (inseguimentoDovuto && !railInseguimento) {
      // ── UN INSEGUIMENTO CHE NON PARTE NON DEVE POTER OSCURARE UN RINNOVO DOVUTO ──────────────────
      // Ogni esito «non inseguire» di questo ramo viene RACCOLTO invece che restituito subito, per la
      // stessa ragione che ha ucciso le due gambe di Barlow: il ramo del rinnovo vive QUI SOTTO, e un
      // `return` da qui lo rende inaccessibile. Con la scadenza lontana quel return è la risposta giusta
      // (l'ordine resta a riposo e continua a maturare); con la scadenza dentro il margine sarebbe una
      // scadenza garantita. Quindi: se il rinnovo è dovuto si prosegue, e il motivo del mancato
      // inseguimento viaggia con la decisione del rinnovo invece di sostituirla.
      let noInseguire = null;
      // THE BAND IS THE CEILING. If restoring the target distance would put the order outside the
      // reward band, we go as far as the band allows and no further: the chase never buys distance at
      // the cost of the reward it exists to earn.
      const bounds = inBandPriceBounds({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize });
      let want = chaseTarget;
      let clamped = false;
      if (bounds.readable && bounds.lo != null && bounds.hi != null) {
        if (want < bounds.lo) { want = bounds.lo; clamped = true; }
        if (want > bounds.hi) { want = bounds.hi; clamped = true; }
      }
      const vqChase = validateQuote({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize }, { side: o.side === 'SELL' ? 'SELL' : 'BUY', price: want, size });
      if (!vqChase.valid) {
        noInseguire = { action: 'skip', gate: 'chase-target-invalid',
          reason: `il prezzo di inseguimento ${want} non passa il guard condiviso (${vqChase.reasons.map((r) => r.code).join(',')}) — l'ordine non viene toccato`,
          extra: { targetPrice: want } };
      } else if (o.side === 'SELL' && want < price - 1e-12) {
        noInseguire = { action: 'skip', gate: 'close-sell-floor',
          reason: `inseguimento verso il basso rifiutato su un ordine di CHIUSURA: il prezzo e' il profitto`,
          extra: { targetPrice: want } };
      } else if (Math.abs(want - price) < tick / 1000) {
        noInseguire = { action: 'hold', gate: 'chase-noop',
          reason: `la distanza e' derivata di ${chaseDriftC.toFixed(3)}¢ ma il prezzo di inseguimento coincide con quello attuale dopo l'arrotondamento al tick — nessun movimento reale da fare`,
          extra: { targetPrice: want } };
      }

      // ── DOVE L'ORDINE FINIREBBE DAVVERO: «MAI PRIMI» DECIDE IL PREZZO, NON L'INSEGUIMENTO ────────
      //
      // IL CICLO, MISURATO. Su Eric Barlow (tick 0.001) il 5 agosto: mid YES 0.6515, inseguimento a
      // 0.55¢ ⇒ obiettivo 0.646. Al piazzamento «mai primi» guarda il miglior bid altrui (0.650), si
      // mette un tick dietro, e l'ordine atterra a 0.649 — a 0.25¢ dal mid, non 0.55¢. Il ciclo dopo
      // l'inseguimento rilegge 0.25¢, vuole di nuovo 0.646, e ricomincia: 21 riprezzi in sei minuti,
      // uno ogni ~35s (il minimo fra due mosse e' 30s), finche' il tetto orario non ha chiuso tutto.
      // La prova diretta e' nell'audit: l'ordine 0x1535868b, creato alle 20:39:35 con obiettivo 0.647,
      // alle 20:40:09 viene riletto a 0.649. Lo stesso sul lato NO: obiettivo 0.343, riportato a 0.346.
      //
      // PERCHE' BARLOW SI' E TX-15 NO — e' strutturale, e dipende dal tick. Su tick 0.001 un tick
      // dietro il concorrente cade a 0.25¢ dal mid, cioe' PIU' VICINO del bersaglio di 0.55¢: le due
      // regole tirano in direzioni opposte e nessuna cede. Su tick 0.01 (TX-15, Ed Markey) un tick
      // dietro coincide col bersaglio di 2.00¢, le due regole concordano, e non c'e' niente da
      // rilevare — quei mercati restano in hold esattamente come prima.
      //
      // CHI CEDE. Mai «mai primi»: e' la priorita' piu' alta, gia' decisa e verificata (vedi
      // prezzo-in-coda.js e il commit «mai primi sul libro vince sulla banda premiante»). Cede
      // l'INSEGUIMENTO, e senza rimpianti: 0.25¢ dal mid e' piu' vicino al mid di 0.55¢, quindi
      // PUNTEGGIO REWARD MIGLIORE. L'inseguimento sta chiedendo di allontanarsi da una posizione
      // migliore di quella che chiede. Non e' un compromesso: e' una richiesta priva di senso
      // economico, e si ignora.
      //
      // COME SI RILEVA — la condizione e' STRUTTURALE, non un contatore di tentativi. Si chiede a
      // `prezzoInCoda` (la STESSA funzione che decidera' il prezzo al piazzamento, non una sua copia)
      // dove finirebbe l'ordine, e si confrontano le distanze dal mid. Un contatore direbbe «ho
      // provato N volte»; questo dice PERCHE', e quindi si scioglie da solo appena il book cambia:
      // se il concorrente si sposta, se il mid si muove abbastanza, o se l'ordine esce dalla banda
      // (che e' un altro ramo), l'inseguimento riparte senza che nessuno debba azzerare niente.
      if (noInseguire == null && typeof deps.resolveDepth === 'function') {
        // TUTTA la nostra presenza sul lato, questo ordine compreso: è l'insieme ESATTO che il percorso
        // di piazzamento passa a `prezzoInCoda` (vedi `replaceOrder`, più sotto). La domanda «dove
        // atterrerebbe il rimpiazzo» ha senso solo con lo stesso insieme, altrimenti si predice il
        // comportamento di un'altra chiamata.
        //
        // Qui prima si toglieva l'ordine valutato, «perché sta per essere cancellato». Sembrava la
        // cosa giusta e non lo era: `ownOrders` è ciò che si SOTTRAE dal book per ottenere i
        // concorrenti, e un ordine appena cancellato è ancora nella fotografia di agent34 (fino a 3s).
        // Non sottrarlo significa scambiare la propria size per quella di un concorrente. Con due
        // nostre coppie sullo stesso mercato — Ed Markey, 5 agosto — il conto cadeva su noi stessi.
        const q = prezzoInCoda({
          book, side: o.side === 'SELL' ? 'SELL' : 'BUY', rules,
          depth: deps.resolveDepth(rules.marketId),
          ownOrders: Array.isArray(ownOrders) ? ownOrders : [],
          offsetCents: targetOffC,
          // La profondità entra ANCHE qui, e deve: questa chiamata serve a prevedere dove atterrerebbe
          // il rimpiazzo, e se la previsione ignorasse l'arretramento predirebbe un prezzo diverso da
          // quello che il piazzamento produrrà davvero. Il confronto del requisito 7 va fatto sul
          // prezzo FINALE dopo profondità, non sul minimo.
          depthMultiple: depthMultipleN,
          ownSize: Number.isFinite(size) && size > 0 ? size : null,
        });
        // ── IL CASO IN CUI IL PIAZZAMENTO RIFIUTEREBBE ────────────────────────────────────────────
        // `quotabile === false` significa che un tick dietro il concorrente uscirebbe dalla banda, e
        // che il piazzamento RIFIUTERA'. Proporre comunque la mossa non e' neutro: `replaceManualOrder`
        // cancella al passo 1 e piazza al passo 2, quindi il rifiuto arriva quando l'ordine vecchio
        // non c'e' piu' — si resterebbe senza niente a riposo per aver inseguito il mid. Qui non si
        // parte affatto, e lo si dichiara.
        if (q.quotabile === false) {
          noInseguire = { action: 'skip', gate: 'mai-primo-non-quotabile',
            reason: `l'inseguimento vorrebbe ${want} ma «mai primi sul libro» non ammette un prezzo su questo lato: ${q.reason}`
              + ' — non si tenta la mossa: il riprezzo cancella prima di piazzare, e un piazzamento rifiutato dopo la cancellazione '
              + "lascerebbe la gamba senza nulla a riposo. L'ordine resta dov'e'.",
            extra: { targetPrice: want, bestOther: q.bestOther } };
        }
        if (noInseguire == null && q.ok && Number.isFinite(q.price)) {
          const distCodaC = Math.abs(q.price - scoringMid) * 100;
          const distWantC = Math.abs(want - scoringMid) * 100;
          // DUE CONDIZIONI, e la seconda non e' un dettaglio.
          //  1 · «mai primi» tira VERSO IL MID rispetto al bersaglio: il prezzo che imporra' e' piu'
          //      vicino al mid di quello che l'inseguimento chiede. E' il conflitto strutturale.
          //  2 · l'ordine E' GIA' almeno tanto vicino al mid quanto il bersaglio. Senza questa, un
          //      ordine finito LONTANO dal mid (che l'inseguimento vorrebbe portare piu' dentro, e
          //      che «mai primi» porterebbe ancora piu' dentro) verrebbe abbandonato dov'e': la
          //      soppressione lo inchioderebbe nel posto peggiore invece di lasciarlo migliorare.
          //      Con la condizione, quel caso fa la sua mossa — e al giro dopo, arrivato dove «mai
          //      primi» lo vuole, la soppressione scatta e il ciclo non parte. Converge in una mossa.
          const codaTiraDentro = distCodaC < distWantC - 1e-9;
          const giaMeglioDelBersaglio = distanceC <= distWantC + 1e-9;
          // ── LA TERZA CONDIZIONE, E PERCHE' LA PROFONDITA' LA RENDE NECESSARIA ─────────────────
          // Le due condizioni sopra descrivono UN conflitto: «mai primi» tira verso il mid. La
          // protezione di profondita' tira nel verso OPPOSTO — allontana — e con lei `distCodaC`
          // cresce invece di calare, quindi `codaTiraDentro` diventa falso e la soppressione non
          // scatterebbe piu'.
          //
          // Il ciclo che ne nascerebbe e' esattamente quello di Barlow, con i ruoli invertiti:
          // l'inseguimento chiede di avvicinarsi al mid, il piazzamento riporta l'ordine al prezzo
          // arretrato, `distanceC` resta maggiore di `distWantC` (quindi nemmeno la seconda
          // condizione salva), e al giro dopo l'inseguimento richiede la stessa mossa. Cancella e
          // ripiazza allo STESSO prezzo, per sempre, bruciando il tetto orario.
          //
          // La condizione che chiude entrambi i casi non e' una direzione: e' che la mossa sia un
          // NO-OP. Se il prezzo che il piazzamento imporrebbe e' gia' quello dell'ordine, muoverlo
          // non cambia niente — e questo vale qualunque sia il verso da cui ci si e' arrivati. E'
          // anche cio' che il messaggio del gate dice da sempre («esattamente dove l'ordine sta
          // ora»): qui la frase diventa la condizione, invece di esserne una conseguenza.
          const codaCoincide = Math.abs(q.price - price) < tick / 1000;
          if (codaCoincide || (codaTiraDentro && giaMeglioDelBersaglio)) {
            const perProfondita = !!(q.depth && q.depth.applied && q.depth.ticksBack > 0);
            // Le due ragioni NON si escludono, e il caso storico le ha tutte e due: l'ordine sta dove
            // «mai primi» lo vuole (no-op) E quel posto e' piu' vicino al mid del bersaglio (conflitto
            // direzionale). Il messaggio dice quelle che valgono davvero, invece di sceglierne una:
            // sceglierne una farebbe sparire dal registro meta' della spiegazione nel caso piu' comune.
            noInseguire = { action: 'hold', gate: 'inseguimento-contro-mai-primo',
              reason:
              `CONFLITTO RILEVATO fra inseguimento del mid e «mai primi sul libro», e vince «mai primi». `
              + `L'inseguimento chiede ${want} (${distWantC.toFixed(3)}¢ dal mid ${scoringMid.toFixed(6)}), `
              + `ma al piazzamento si otterrebbe ${q.price} (${distCodaC.toFixed(3)}¢ dal mid, un tick dietro il miglior bid altrui ${q.bestOther}`
              + (perProfondita
                ? `, poi arretrato di ${q.depth.ticksBack} tick per profondità: davanti ${q.depth.depthAhead} share contro una soglia di ${q.depth.required}`
                : '')
              + `) — cioe' esattamente dove l'ordine sta ora (${price}, ${distanceC.toFixed(3)}¢). `
              + `Muoverlo lo riporterebbe dove e' gia', e il ciclo dopo l'inseguimento richiederebbe la stessa mossa: `
              + `e' il ciclo che il 5 agosto ha prodotto 21 riprezzi in sei minuti su Eric Barlow e ha bruciato il tetto orario. `
              + (codaTiraDentro
                ? `SOPPRESSO: ${distCodaC.toFixed(3)}¢ dal mid e' PIU' VICINO di ${distWantC.toFixed(3)}¢, quindi migliore per il punteggio reward — `
                  + `non c'e' nessuna ragione economica per allontanarlo. `
                : '')
              + (codaCoincide
                ? `SOPPRESSO anche perche' la mossa sarebbe un NO-OP: cancellare e ripiazzare allo stesso prezzo `
                  + `costa una finestra scoperta e non compra niente`
                  + (perProfondita
                    ? ` — ed e' il caso che la protezione di profondita' produce, visto che allontana invece di avvicinare, `
                      + `quindi il confronto direzionale da solo non lo vedrebbe.`
                    : '.')
                : '')
              + ` L'ordine non viene toccato finche' non cambia il book `
              + `(il concorrente si sposta, il mid si muove abbastanza, o l'ordine esce dalla banda premiante).`,
              extra: {
                // I numeri su cui la soppressione e' stata decisa, per poterla verificare a
                // posteriori senza ricalcolarli — e senza doverli dedurre da un testo.
                soppresso: true,
                targetPrice: want,
                inseguimentoPrezzo: want,
                inseguimentoDistanzaC: +distWantC.toFixed(4),
                maiPrimoPrezzo: q.price,
                maiPrimoDistanzaC: +distCodaC.toFixed(4),
                bestOther: q.bestOther,
                maiPrimoMode: q.mode || null,
                // QUALE delle due condizioni ha soppresso: il no-op (che copre anche il caso in cui
                // la profondita' ha allontanato il prezzo) o il conflitto direzionale storico.
                soppressoPerNoOp: codaCoincide,
                profondita: perProfondita ? q.depth : null } };
          }
        }
      }

      if (noInseguire) {
        // Scadenza lontana ⇒ questa È la risposta: l'ordine resta dov'è, col motivo dichiarato.
        if (!expiring) {
          return out(noInseguire.action, noInseguire.gate, noInseguire.reason,
            { ...withTtl, ...chase, ...(noInseguire.extra || {}) });
        }
        // Scadenza dentro il margine ⇒ NON si torna qui. Il motivo del mancato inseguimento diventa un
        // dato che accompagna la decisione del rinnovo, invece di sostituirla: è la stessa correzione
        // applicata al tetto orario, sullo stesso ramo, per lo stesso motivo.
        railInseguimento = { gate: noInseguire.gate, reason: noInseguire.reason };
      } else {
        return out('reprice', 'mid-chase',
          `inseguimento del mid: distanza ${observedOffsetC.toFixed(3)}¢ contro target ${targetOffC}¢ (deriva ${chaseDriftC.toFixed(3)}¢ > soglia ${minMoveC}¢) → da ${price} a ${want}`
          + (clamped ? ` · LIMITATO DALLA BANDA: il target avrebbe voluto ${chaseTarget}, ma il bordo premiante e' ${want}` : ''),
          { ...withTtl, ...chase, breachConfirmed: false, targetPrice: want, bandClamped: clamped });
      }
    }
    // ── TRIGGER 2: THE PROACTIVE REFRESH ────────────────────────────────────────────────────────────
    // The order is priced correctly and nothing about the market says to move it — but its venue-side
    // expiry is running out. Renew it at the SAME price: a cancel→replace whose only purpose is to reset
    // the dead-man clock the exchange holds. We do this with margin still on the order rather than
    // waiting for expiry, because an order that actually expires leaves the book until the next poll
    // notices, whereas a renewal is a ~3-second gap we choose when to take.
    if (expiring) {
      if (lastRepriceAt != null && Number.isFinite(cfg.minIntervalMs) && (now - lastRepriceAt) < cfg.minIntervalMs) {
        return out('skip', 'rate-limited',
          `expiry refresh due (${ttlLeft}s left) but this leg was moved ${Math.round((now - lastRepriceAt) / 1000)}s ago — waiting out the ${Math.round(cfg.minIntervalMs / 1000)}s minimum interval. There is still margin: the refresh fires with ${margin}s of life to spare, so a short wait cannot cost the order.`,
          withTtl);
      }
      // The replacement must still be a valid quote in its own right. Re-priced at the SAME price, since
      // the mid has not invalidated it — this renews the clock, it does not chase the market.
      const vqSame = validateQuote({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize }, { side: 'BUY', price, size });
      if (!vqSame.valid) {
        // ── IL RESIDUO CHE MUORE SOTTO LA SOGLIA, DICHIARATO INVECE CHE TACIUTO ──────────────────────
        // Questo ramo è già la decisione giusta — non si cancella un ordine per rimpiazzarlo con uno che
        // il venue rifiuterebbe — ma finora la produceva in silenzio: ventiquattro righe di skip identiche
        // sull'ordine 0x4c19a7 il 5 agosto, l'ordine morto, e nessuno avvisato. Il capitale che quel
        // residuo porta resta immobilizzato fino alla scadenza e poi torna libero senza che nessuno lo
        // sappia, quindi senza che nessuno lo rimetta in gioco.
        //
        // IL DISCRIMINANTE È BELOW_MIN_SIZE, E SOLO QUELLO. Gli altri motivi di refresh-invalid — prezzo
        // fuori dalla griglia del tick, prezzo fuori dai limiti del venue — sono guasti di prezzo, non
        // residui di liquidità: un avviso «capitale in attesa di riallocazione» su quelli sarebbe un
        // falso allarme. Qui si marca il fatto; chi lo trasforma in avviso è il ciclo, che sa quali
        // ordini ha già segnalato.
        const codes = vqSame.reasons.map((r) => r.code);
        const sottoSoglia = codes.includes('BELOW_MIN_SIZE');
        return out('skip', 'refresh-invalid',
          `expiry refresh due (${ttlLeft}s left) but re-placing at the same price ${price} would not pass the shared guard (${codes.join(',')}) — leaving the order to run out rather than cancelling it for a replacement the venue would refuse`
          + (sottoSoglia
            ? ` · RESIDUO SOTTO SOGLIA: restano ${size} share contro il minimo di ${rules.minSize}, quindi questo ordine muore alla scadenza e i ${(price * size).toFixed(2)} $ che porta tornano da riallocare`
            : ''),
          {
            ...withTtl,
            refreshInvalidCodes: codes,
            belowMinSize: sottoSoglia,
            minSize: rules.minSize,
            sizeRemaining: size,
            price,
            book,
            side: o.side === 'SELL' ? 'SELL' : 'BUY',
            notionalUsd: +(price * size).toFixed(4),
          });
      }
      // ── L'ESENZIONE, DICHIARATA SULLA DECISIONE STESSA ────────────────────────────────────────
      // Se il tetto orario è raggiunto, questo rinnovo procede COMUNQUE — ma non in silenzio: il
      // fatto viaggia sulla decisione, il ciclo ne fa una riga di audit sua (`rinnovo-esente-dal-tetto`)
      // e agent40 una riga di log. Un'esenzione che non si vede nel registro è indistinguibile da un
      // tetto che non funziona.
      const tettoRaggiunto = Number.isFinite(cfg.maxPerHour) && repricesThisHour >= cfg.maxPerHour;
      return out('reprice', 'expiry-refresh',
        `proactive renewal: ${ttlLeft}s of venue-side life left (margin ${margin}s), price still in band at ${distanceC.toFixed(2)}¢ of ±${bandRadiusC.toFixed(2)}¢ → re-place at the SAME price ${price} to reset the exchange-held expiry`
        + (tettoRaggiunto
          ? ` · ESENTE DAL TETTO ORARIO: il mercato ha già ${repricesThisHour} riprezzi nell'ultima ora (tetto ${cfg.maxPerHour}), ma questo è un RINNOVO allo stesso prezzo — bloccarlo non eviterebbe una mossa, garantirebbe una scadenza. Ogni altro gate resta applicato.`
          : '')
        + (railInseguimento
          ? ` · l'inseguimento del mid in questo stesso ciclo è stato fermato da ${railInseguimento.gate}: si rinnova senza muovere il prezzo.`
          : ''),
        { ...withTtl, targetPrice: price, breachConfirmed: false,
          capExemptRenewal: tettoRaggiunto,
          repricesThisHour, maxPerHour: Number.isFinite(cfg.maxPerHour) ? cfg.maxPerHour : null,
          railInseguimento: railInseguimento ? railInseguimento.gate : null });
    }
    // ── TRIGGER 3: SIAMO DIVENTATI I PRIMI SUL LIBRO ────────────────────────────────────────────
    // L'ordine è in banda e il mid non si è mosso, ma il libro sì: un concorrente si è ritirato e
    // adesso il nostro ordine è il miglior bid. Prima non scattava niente — questo motore guardava
    // solo l'uscita dalla banda e la scadenza — e l'ordine restava in cima a incassare il flusso
    // aggressivo, che è precisamente ciò che la regola «mai primi» esiste per evitare.
    //
    // COMPORTAMENTO INTERMEDIO, e non «cancella sempre». Su un mercato tranquillo diventare primi
    // capita per il semplice ritiro di un concorrente: cancellare e ripiazzare a ogni occorrenza
    // vorrebbe dire due chiamate al venue e una finestra scoperta ogni volta, su un rate limit
    // (20 ordini/60s) che il 5 agosto è già stato toccato cinque volte in un'ora. Quindi:
    //   · ci si sposta un tick dietro SE il prezzo resta in banda    → reprice
    //   · si cancella SENZA rimpiazzo solo se spostarsi uscirebbe    → cancel
    //   · se la profondità non è leggibile non si fa niente          → hold, dichiarato
    if (typeof deps.resolveDepth === 'function' && o.side !== 'SELL') {
      const depth = deps.resolveDepth(rules.marketId);
      const q = prezzoInCoda({
        book, side: 'BUY', rules, depth,
        // I NOSTRI ordini esclusi, questo compreso: senza, ci vedremmo come concorrenti di noi stessi
        // e scenderemmo di un tick a ogni giro fino al bordo della banda.
        // Tutti i nostri su questo lato — li passa il ciclo. Il ripiego al solo ordine valutato vale
        // per i test che chiamano `decideReprice` da soli: fuori da lì il ciclo li passa sempre.
        ownOrders: Array.isArray(ownOrders) && ownOrders.length ? ownOrders : [{ price, size, orderId: o.orderId }],
        offsetCents: null,
        // Anche qui la profondita': se il concorrente si e' ritirato e ci si deve rimettere dietro,
        // ci si rimette dietro CON la protezione, non al minimo — altrimenti questo ramo riporterebbe
        // l'ordine a un tick dal migliore e il ciclo successivo dovrebbe arretrarlo di nuovo.
        depthMultiple: depthMultipleN,
        ownSize: Number.isFinite(size) && size > 0 ? size : null,
      });
      if (q.quotabile === false) {
        return out('cancel', 'sarebbe-primo-sul-libro',
          `il libro si è mosso e questo ordine è ora il migliore del suo lato. ${q.reason} — si cancella senza rimpiazzo: `
          + 'non si resta in cima nemmeno per restare premianti.',
          { ...withTtl, targetPrice: null, bestOther: q.bestOther });
      }
      if (q.ok && Number.isFinite(q.price) && q.onTop === false && Math.abs(q.price - price) > tick / 1000 && price > q.price) {
        // Solo verso il BASSO: risalire vorrebbe dire avvicinarsi al tocco, che è il contrario dello
        // scopo. E solo se il nuovo prezzo passa il guard condiviso, come ogni altro target qui dentro.
        const vqCoda = validateQuote({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize }, { side: 'BUY', price: q.price, size });
        if (vqCoda.valid) {
          const arr = q.depth && q.depth.applied && q.depth.ticksBack > 0 ? q.depth : null;
          return out('reprice', 'top-of-book',
            `il libro si è mosso e questo ordine è ora il migliore del suo lato: ci si rimette un tick dietro al `
            + `miglior bid altrui (${q.bestOther}) spostandosi da ${price} a ${q.price}, restando in banda `
            + `(${distanceC.toFixed(2)}¢ di ±${bandRadiusC.toFixed(2)}¢)`
            + (arr
              ? ` · ARRETRATO PER PROFONDITÀ di ${arr.ticksBack} tick oltre il minimo ${arr.minPrice}: `
                + `davanti ${arr.depthAhead} share altrui contro la soglia di ${arr.required} (${arr.multiple}× la size ${arr.ownSize}), `
                + `fermato ${arr.stoppedBy === 'soglia' ? 'dal raggiungimento della soglia' : 'dal bordo della banda premiante'}.`
              : '.'),
            { ...withTtl, targetPrice: q.price, breachConfirmed: true, bestOther: q.bestOther, profondita: arr });
        }
      }
    }

    // ── TRIGGER 4: L'EROSIONE DELLA PROFONDITÀ DAVANTI — R4, 18 agosto 2026 ─────────────────────
    // «Riprezza ANCHE se la profondità davanti scende. Cancella e resta fuori — non l'arretramento di
    //  un tick, che sul bordo è una protezione finta.» (l'operatore)
    //
    // IL FATTO: il TRIGGER 3 vede solo il caso ESTREMO — siamo diventati i primi del nostro lato. La
    // degradazione PARZIALE — un taker mangia tre livelli su cinque, il mid non si muove, davanti
    // resta qualcuno ma molto meno — non la vedeva nessuno. È il momento in cui il rischio di essere
    // riempiti sale proprio mentre il prezzo sta per muoversi contro.
    //
    // LE QUATTRO COSE DECISE DALL'OPERATORE, e dove vivono:
    //   ① **solo erosione RELATIVA**: «è sparito un livello» è stato BUTTATO. Misurato sul 17 agosto:
    //      1.690 scatti su 1.775 venivano da lì, e su un feed troncato a **3 livelli** quel conteggio
    //      è rumore — fra il nostro prezzo e il mid ci stanno pochissimi livelli e ne sparisce uno di
    //      continuo. Resta la macchina di `book-erosion`: baseline adattiva per mercato e per lato,
    //      riscaldamento, conferma a due letture, isteresi 40/60 sulla baseline CONGELATA.
    //   ② **freno 60 s** (era 30): `sospensione-erosione.FRENO_MS`, per rispettare il rail del venue.
    //   ③ **SELL esclusi**, come il TRIGGER 3: arretrare un'uscita è il contrario di uscire.
    //   ④ **cancella e resta fuori, tetto 5 minuti**: `sospensione-erosione`. Senza quel registro la
    //      regola non esisterebbe — `ripristinaGamba` rimetterebbe l'ordine a libro entro 120 s.
    //
    // ⚠ NON PRODUCE MAI UN PREZZO. Questo trigger può solo CANCELLARE. Un ordine che non c'è non può
    // essere riempito male, e nessuna regola di prezzo viene toccata: banda, «mai primo», tetti e
    // scala d'urgenza restano identici. È monotono — si aggiunge una cancellazione, mai un ordine.
    //
    // ⚠ L'ORDINE DEI TRIGGER È PARTE DELLA REGOLA: il 4 sta DOPO il 3. Se siamo diventati i primi, la
    // risposta giusta è quella del 3 (spostarsi dietro al nuovo migliore, o cancellare per banda), non
    // un'astensione di cinque minuti. Il 4 raccoglie il caso che il 3 non vede.
    if (deps.erosione && o.side !== 'SELL') {
      const e = deps.erosione({ marketId: rules.marketId, book: o.book, price, size, scoringMid, now });
      if (e && e.fired === true) {
        return out('cancel', 'erosione-profondita',
          `la profondità DAVANTI a questo ordine è crollata e il mid non si è mosso: ${e.reason}`
          + ` — si esce dal libro per al più ${Math.round((e.tettoMs || 0) / 60000)} minuti, e si rientra sul bordo`
          + ' appena la profondità risale sopra la soglia di rientro (o allo scadere del tetto, dichiarato).',
          { ...withTtl, targetPrice: null, erosione: { baseline: e.baseline, ratioPct: e.ratioPct, finoA: e.finoA } });
      }
    }

    return out('hold', null,
      `in band: |${price} − ${scoringMid.toFixed(6)}| = ${distanceC.toFixed(2)}¢ ≤ ±${bandRadiusC.toFixed(2)}¢`
      + (chaseTarget != null ? ` · distanza ${observedOffsetC.toFixed(3)}¢ contro target ${targetOffC}¢ (deriva ${chaseDriftC.toFixed(3)}¢ ≤ soglia ${minMoveC}¢)` : '')
      + (ttlLeft != null ? ` · ${ttlLeft}s of venue expiry left, refresh at ${margin}s` : ' · no venue expiry (GTC)')
      + ' — the order is NOT touched',
      { ...withTtl, ...chase });
  }

  // ── THE TWO TRIGGERS MEET HERE, AND THEY MUST NOT FIGHT ──────────────────────────────────────────
  // The order is OUT OF BAND. Normally that has to clear hysteresis, confirmation and the rate limit
  // before anything moves — those exist so a twitchy mid cannot cause churn.
  //
  // But if the venue-side expiry is ALSO nearly up, waiting is not the conservative choice any more: the
  // order is about to be retired by the exchange whatever we decide, so "wait and see" means "let it die
  // and leave the book empty until the next place". When both triggers are live, the band-exit move takes
  // priority and skips the patience gates — one action satisfies BOTH needs, because the replacement is
  // a fresh order with a fresh full RESTING_GTD_SECONDS window at a price back inside the band.
  //
  // This is also why the two triggers can never produce a double re-price: every re-price, from either
  // trigger, mints a NEW order with a full window, so the expiry trigger cannot fire again for
  // (window − margin) minutes; and the rate limit is market-keyed, so it binds across the id change.
  const forcedByExpiry = expiring;

  // ── HYSTERESIS. Out of band, but only just? An order sitting a hair past the edge would otherwise flap
  //    in and out on rounding alone, and every flap is a cancel+place with a real out-of-book window. ──
  const hysteresisC = (Number.isFinite(cfg.hysteresisTicks) ? cfg.hysteresisTicks : 0) * tick * 100;
  if (distanceC <= bandRadiusC + hysteresisC + 1e-9 && !forcedByExpiry) {
    return out('hold', 'hysteresis',
      `out of band by ${(distanceC - bandRadiusC).toFixed(3)}¢ but within the ${hysteresisC.toFixed(3)}¢ hysteresis (${cfg.hysteresisTicks} tick) — left alone rather than flapping at the edge`,
      withTtl);
  }

  // ── CONFIRMATION. One sample is not a signal. The breach must survive consecutive observations. ──
  const needed = Number.isFinite(cfg.confirmSamples) ? cfg.confirmSamples : 1;
  const seen = consecutiveBreaches + 1; // this cycle's observation included
  if (seen < needed && !forcedByExpiry) {
    return out('skip', 'awaiting-confirmation',
      `out of band by ${distanceC.toFixed(2)}¢ (band ±${bandRadiusC.toFixed(2)}¢), observation ${seen}/${needed} — waiting for confirmation before moving a real order`,
      { ...withTtl, breachConfirmed: false });
  }

  // ── RAILS. Both of these leave the order alone; they bound how often the automatism may act. ──
  // The rate limit binds even under expiry pressure: two re-prices inside 30 seconds is churn whatever
  // the reason, and the refresh margin is deliberately many multiples of the limit, so waiting it out
  // cannot cost the order. The hourly ceiling binds too — a market that has already had 20 automatic
  // moves in an hour is one to look at by hand, not one to keep feeding.
  if (lastRepriceAt != null && Number.isFinite(cfg.minIntervalMs) && (now - lastRepriceAt) < cfg.minIntervalMs) {
    return out('skip', 'rate-limited',
      `this leg was automatically re-priced ${Math.round((now - lastRepriceAt) / 1000)}s ago (minimum interval ${Math.round(cfg.minIntervalMs / 1000)}s) — not touched again yet`
      + (forcedByExpiry ? ` · ${ttlLeft}s of venue expiry left, still well inside the ${margin}s margin` : ''),
      { ...withTtl, breachConfirmed: true });
  }
  // ── IL TETTO ORARIO, E L'UNICA COSA CHE NON PUÒ FERMARE ──────────────────────────────────────────
  // Fuori banda con la scadenza dentro il margine, «non fare niente» NON è la scelta prudente: il venue
  // ritira l'ordine da solo entro pochi minuti, quindi fermarsi qui non evita una mossa, garantisce una
  // scadenza. È la stessa distinzione applicata al rinnovo in banda, sulla stessa condizione strutturale
  // (`forcedByExpiry` = `secondsToExpiry <= refreshMarginSeconds`, letto dal campo `expiration` del
  // venue): un riprezzo discrezionale resta bloccato, un ordine che sta morendo viene rinnovato — qui al
  // prezzo che lo riporta in banda, perché ripiazzarlo fuori banda sarebbe rinnovare per non maturare
  // niente. Ogni altro gate ha già parlato o parlerà: il limite di 30s per gamba sopra, il guard
  // condiviso sul prezzo proposto sotto, mai-primo-sul-libro al piazzamento.
  const tettoRaggiunto = Number.isFinite(cfg.maxPerHour) && repricesThisHour >= cfg.maxPerHour;
  if (tettoRaggiunto && !forcedByExpiry) {
    return out('skip', 'hourly-cap',
      `this market has already had ${repricesThisHour} automatic re-prices in the last hour (ceiling ${cfg.maxPerHour}) — the runaway guard stops here; re-price by hand if this is genuinely wanted`,
      { ...withTtl, breachConfirmed: true });
  }

  // ── WHERE TO MOVE IT. The bounds come from lib/maker/venue-rules.inBandPriceBounds, which derives them
  //    by ASKING validateQuote — so a target can never be looser than the guard that will re-check it. ──
  const bounds = inBandPriceBounds({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize });
  if (!bounds.readable || bounds.lo == null || bounds.hi == null) {
    return out('skip', 'no-valid-target',
      'no qualifying price could be derived for the current band (band narrower than one tick, or unreadable) — nothing is touched rather than inventing a price',
      { ...withTtl, breachConfirmed: true });
  }

  // ── IL RIENTRO NON AVVIENE SUL BORDO NUDO: È LA METÀ ASIMMETRICA DEL TRIGGER (15 agosto 2026) ───
  //
  // Si ESCE dalla banda a `v + hysteresisTicks`, e fin qui era già così. Si RIENTRAVA invece esattamente
  // dove si era usciti — sull'ultimo prezzo di griglia ancora premiante, che dista dal bordo meno di un
  // tick — quindi lo stato dopo il rientro era identico allo stato prima dell'uscita: due soglie uguali,
  // nessuna asimmetria, e un mid che respira di due tick produce un cancel+place a ogni respiro. È il
  // rischio che l'operatore ha posto per primo, e al bordo esterno (dove questa configurazione mette gli
  // ordini di proposito) è la condizione normale, non un caso limite.
  //
  // Adesso il rientro si ferma `MAKER_DISTANZA_MARGINE_BORDO_TICK` tick DENTRO il bordo. Con isteresi 1
  // e margine 1 la banda morta passa da 2 a 3 tick di corsa del mid, e — la parte che conta — sparisce
  // lo stato in cui UN solo tick rimette l'ordine fuori.
  //
  // ⚠ `hysteresisTicks` e `confirmSamples` NON sono toccati: l'operatore ha chiesto di tenerli, e
  // questo agisce sull'altro capo del ciclo (DOVE si rientra, non QUANDO si esce).
  // ⚠ Il margine può solo STRINGERE la zona ammessa, quindi un target che era valido resta valido: il
  // guard condiviso `validateQuote` qui sotto lo ricontrolla comunque, sull'esatto prezzo proposto.
  const bordi = bordiConMargine({ bandLo: bounds.lo, bandHi: bounds.hi, tick, maxSpreadCents, env: deps.env || process.env });
  const loRientro = bordi.applicato ? bordi.lo : bounds.lo;
  const hiRientro = bordi.applicato ? bordi.hi : bounds.hi;

  let targetPrice;
  if (cfg.strategy === 'nearest-mid') {
    // The qualifying price closest to the mid: snap the mid to the grid, then clamp into [lo, hi].
    const snapped = +(Math.round(scoringMid / tick) * tick).toFixed(10);
    targetPrice = Math.min(hiRientro, Math.max(loRientro, snapped));
  } else {
    // 'band-edge' (default): the nearest qualifying price to where the order ALREADY sat — i.e. the band
    // edge on the same side of the mid, meno il margine. Minimum movement, original stance preserved.
    targetPrice = price > scoringMid ? hiRientro : loRientro;
  }
  targetPrice = +Number(targetPrice).toFixed(10);

  // ── A CLOSING SELL IS NEVER WALKED DOWN ─────────────────────────────────────────────────────────
  // For a BUY, moving with the band is neutral: the order is a bid and the operator's stance is an offset
  // from the mid. For the SELL that CLOSES a position, the price IS the profit: it was set to entry plus a
  // margin, so moving it down erodes exactly what the exit exists to capture, and far enough down it turns
  // a close into a realised loss. Moving it UP is always fine (more profit). So a SELL is re-priced only
  // upward; if the band has moved below it, the exit simply stops earning rewards while it waits, which is
  // the cheap half of the trade-off. lib/maker/auto-close.closeFloorPrice states the same floor at
  // placement time; this is the same rule enforced on every later move.
  if (o.side === 'SELL' && targetPrice < price - 1e-12) {
    return out('skip', 'close-sell-floor',
      `questo è un ordine di CHIUSURA: il target di banda ${targetPrice} è sotto il prezzo attuale ${price}, e abbassarlo eroderebbe il profitto per cui l'uscita esiste. Resta dov'è (fuori banda non matura premi, ma il guadagno è protetto).`,
      { ...withTtl, breachConfirmed: true, targetPrice });
  }

  // ── FINAL SELF-CHECK. Run the SHARED guard on the exact replacement we are about to propose. If it
  //    would not qualify, we do NOTHING: cancelling an order we cannot validly replace is strictly worse
  //    than leaving an out-of-band order resting, because it earns nothing either way but costs the size. ──
  const vq = validateQuote({ tick, scoringMid, maxSpreadCents, minSize: rules.minSize }, { side: 'BUY', price: targetPrice, size });
  if (!vq.valid) {
    return out('skip', 'replacement-invalid',
      `the proposed replacement at ${targetPrice} would not pass the shared guard (${vq.reasons.map((r) => r.code).join(',')}) — the resting order is left untouched rather than cancelled for nothing`,
      { ...withTtl, breachConfirmed: true, targetPrice });
  }

  if (Math.abs(targetPrice - price) < tick / 1000 && !forcedByExpiry) {
    // Cannot happen for a genuine breach, but if the target equals the current price there is nothing to
    // do and a cancel+place would be pure loss (an out-of-book window for an identical order).
    // Under expiry pressure the same-price case is exactly the refresh, so it falls through instead.
    return out('hold', 'target-unchanged',
      `the computed target ${targetPrice} equals the current price — nothing to move`,
      { ...withTtl, targetPrice });
  }

  return out('reprice', forcedByExpiry ? 'band-exit-and-expiry' : null,
    (forcedByExpiry
      ? `band exit AND expiry: out of band by ${distanceC.toFixed(2)}¢ (band ±${bandRadiusC.toFixed(2)}¢) with only ${ttlLeft}s of venue-side life left → one move handles both, to ${targetPrice} (${cfg.strategy}). The patience gates (hysteresis, ${needed}-sample confirmation) are deliberately skipped here: the exchange is about to retire this order anyway, so waiting would mean losing it rather than protecting it.`
      : `band exit: |${price} − ${scoringMid.toFixed(6)}| = ${distanceC.toFixed(2)}¢ > ±${bandRadiusC.toFixed(2)}¢ + ${hysteresisC.toFixed(3)}¢ hysteresis, confirmed on ${seen} consecutive observations → move to ${targetPrice} (${cfg.strategy})`)
    + (forcedByExpiry && tettoRaggiunto
      ? ` · ESENTE DAL TETTO ORARIO: il mercato ha già ${repricesThisHour} riprezzi nell'ultima ora (tetto ${cfg.maxPerHour}), ma senza questa mossa l'ordine scade fra ${ttlLeft}s — il tetto ferma i riprezzi discrezionali, non tiene in vita gli ordini.`
      : ''),
    { ...withTtl, breachConfirmed: true, targetPrice,
      capExemptRenewal: forcedByExpiry && tettoRaggiunto,
      repricesThisHour, maxPerHour: Number.isFinite(cfg.maxPerHour) ? cfg.maxPerHour : null });
}

// ── THE CYCLE ────────────────────────────────────────────────────────────────────────────────────────
// One pass over every market the operator has opted in. Every side effect is an injected dependency, so
// the whole thing runs in a test with no venue, no files and a fake clock.

/**
 * QUANTO CAPITALE E' GIA' IMPEGNATO SU QUESTO MERCATO — l'ingresso che alla Regola 5 mancava.
 *
 * DUE ADDENDI. Gli ordini NOSTRI ancora a riposo (`owned`, la stessa lista che `othersLadder`
 * sottrae dal book: una fonte sola) e le posizioni gia' eseguite, che arrivano dallo snapshot del
 * venue. Non si ricalcola nulla da zero: sono i due insiemi che il ciclo ha gia' in mano.
 *
 * FAIL CLOSED. Se le posizioni non sono leggibili, o se un ordine a riposo non ha prezzo o size,
 * l'esposizione e' IGNOTA e il chiamante deve bloccare. Non e' zero: un'esposizione che non si sa
 * misurare, contata come zero, allarga il tetto proprio quando si e' piu' ciechi.
 *
 * IL DOPPIO CONTEGGIO SI PREFERISCE AL SOTTOCONTEGGIO. Una SELL di uscita e una posizione aperta
 * sullo stesso lato descrivono lo stesso capitale in due momenti, e qui vengono sommate entrambe. Fra
 * stringere il tetto e allargarlo si sceglie sempre di stringerlo — la stessa scelta gia' fatta nel
 * rimpiazzo di gamba di agent40.
 *
 * @param {object} a
 *   owned           i nostri ordini a riposo su questo mercato ({orderId, price, size})
 *   escludiOrderId  l'ordine in valutazione, che esce dal conto perche' `aggiuntaUsd` e' il suo rimpiazzo
 *   posizioni       {leggibile, usd, motivo} — il nozionale delle posizioni aperte su questo mercato
 *   imposta         un valore secco che sostituisce tutto il calcolo (i banchi, e chi il numero ce l'ha)
 * @returns {{leggibile:boolean, usd:number|null, ordiniUsd:number|null, posizioniUsd:number|null, motivo:string|null}}
 */
function esposizioneDelMercato({ owned = [], escludiOrderId = null, posizioni = null, imposta = null } = {}) {
  if (Number.isFinite(imposta)) {
    return { leggibile: true, usd: imposta, ordiniUsd: null, posizioniUsd: null, motivo: 'esposizione imposta dal chiamante' };
  }
  let ordiniUsd = 0;
  for (const o of owned || []) {
    if (!o || (escludiOrderId != null && o.orderId === escludiOrderId)) continue;
    // `Number(null)` e' 0, e uno 0 al posto di un prezzo mancante e' esattamente il modo in cui un
    // campo vuoto si traveste da misura. Un campo assente e' NaN qui, e NaN blocca.
    const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));
    const p = num(o.price);
    const s = num(o.size);
    if (!Number.isFinite(p) || !Number.isFinite(s)) {
      return { leggibile: false, usd: null, ordiniUsd: null, posizioniUsd: null,
        motivo: `ordine ${o.orderId || '(senza id)'} senza prezzo o size: il capitale a riposo non si sa contare` };
    }
    ordiniUsd += p * s;
  }
  if (!posizioni || posizioni.leggibile !== true || !Number.isFinite(posizioni.usd)) {
    return { leggibile: false, usd: null, ordiniUsd: +ordiniUsd.toFixed(4), posizioniUsd: null,
      motivo: (posizioni && posizioni.motivo) || 'posizioni aperte non leggibili: nessuna nuova esposizione' };
  }
  return {
    leggibile: true,
    usd: +(ordiniUsd + posizioni.usd).toFixed(4),
    ordiniUsd: +ordiniUsd.toFixed(4),
    posizioniUsd: +posizioni.usd.toFixed(4),
    motivo: null,
  };
}

/**
 * Which of these resting orders may the automatism touch?
 *
 * ONLY the ones the manual panel PROVABLY placed. `attributeOrder`'s 'unknown' (the panel has never
 * placed anything, so there is no evidence either way) and 'agent35' are both excluded — an automatism
 * that moves an order it merely believes is ours is how the engine's quotes get trampled.
 */
function selectOwnedOrders(orders, { marketId, rules }) {
  const list = Array.isArray(orders) ? orders : [];
  const wantMarket = typeof marketId === 'string' ? marketId.trim().toLowerCase() : '';
  const yesToken = rules && rules.tokenId ? String(rules.tokenId) : null;
  const noToken = rules && rules.tokenIdNo ? String(rules.tokenIdNo) : null;
  const out = [];
  for (const o of list) {
    if (!o || !o.orderId) continue;
    // Positive attribution only. 'manual-ui' covers both the hand-placed original and every automatic
    // re-price of it (the audit trail records the panel core's idempotency keys under either source).
    if (o.source !== 'manual-ui') continue;
    // BUY, or a SELL that is a CLOSING order. The panel's own orders are BUYs; the only SELLs it ever
    // places are exits produced by lib/maker/auto-close.js, and those want the same band management as
    // anything else — an exit that drifts out of band stops earning while it waits. A SELL from anywhere
    // else is still left alone: this path measures no inventory of its own.
    const sideU = o.side ? String(o.side).toUpperCase() : 'BUY';
    if (sideU !== 'BUY' && sideU !== 'SELL') continue;
    if (wantMarket && o.marketId && String(o.marketId).trim().toLowerCase() !== wantMarket) continue;
    // WHICH BOOK. Resolved by matching the order's token against the market's two token ids — never
    // guessed. An order whose token matches neither is skipped: we cannot mirror its band correctly.
    const tok = o.tokenId ? String(o.tokenId) : null;
    const book = tok && yesToken && tok === yesToken ? 'yes' : (tok && noToken && tok === noToken ? 'no' : null);
    if (!book) continue;
    const size = Number.isFinite(o.sizeRemaining) && o.sizeRemaining > 0 ? o.sizeRemaining : Number(o.size);
    out.push({
      orderId: o.orderId, price: Number(o.price), size, book, tokenId: tok, marketId: o.marketId, status: o.status,
      side: sideU,
      // Carried through from the VENUE's own `expiration` field (already corrected for the 60s the
      // exchange retires GTD orders early). This is what the proactive-refresh trigger reads; null means
      // GTC, so that trigger simply never fires for the order.
      secondsToExpiry: Number.isFinite(o.secondsToExpiry) ? o.secondsToExpiry : null,
      // LO STESSO FATTO COME ISTANTE, non come conto alla rovescia. Serve a rispondere «e' morto per
      // scadenza?» su un ordine che NON si vede piu': un countdown letto un ciclo prima non lo puo' dire,
      // un istante si'. Viene dal campo `expiration` del venue, gia' corretto per i 60s di ritiro
      // anticipato (vedi listManualOrders) — non e' una nostra stima.
      expiresAtMs: Number.isFinite(o.expiresAtMs) ? o.expiresAtMs : null,
      sizeMatched: Number.isFinite(o.sizeMatched) ? o.sizeMatched : null,
      orderType: o.orderType || null,
    });
  }
  return out;
}

/**
 * Run ONE watcher pass.
 *
 * @param {object} deps  every side effect, injected:
 *   killStatus()                      → { effectivelyKilled, readable, ... }   (lib/safety/kill-switch)
 *   isManual(marketId)                → { manual, readable }                    (lib/maker/manual-mode)
 *   listOrders({marketId})            → { ok, simulated, orders }               (manual-order.listManualOrders)
 *   resolveRules(marketId)            → resolveMarketRules() shape
 *   replaceOrder(spec)                → replaceManualOrder() shape
 *   audit(rec)                        → append one line to the maker trail
 *   config                            → loadAutoRepriceTuning() shape
 *   configDeps                        → deps forwarded to the auto-reprice config/state store (tests)
 *   breaches                          → Map<orderId, count> carried BETWEEN cycles by the caller
 *   now()                             → epoch ms
 * @returns {{at:string, ran:boolean, gate:(string|null), reason:(string|null), markets:Array, actions:Array}}
 */
async function runAutoRepriceCycle(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const t0 = now();
  // ── I DUE REFERTI CHE ESCONO DA QUESTO CICLO PER FINIRE SOTTO GLI OCCHI DELL'OPERATORE ────────
  // `cancellazioni`: ogni ordine che il motore ha tolto dal libro, col motivo distinto.
  // `latiSingoli`: i mercati che in questo istante hanno un lato solo che matura 1/3 — non un allarme,
  //   uno stato che va detto perche' l'operatore sappia che quel capitale lavora a frazione.
  // Erano entrambi invisibili fino al 6 agosto 2026, ed è per questo che una gamba è rimasta sola
  // per due ore senza che nessuno lo sapesse.
  const daRipianificare = [];
  const cancellazioni = [];
  const latiSingoli = [];
  const config = deps.config || loadAutoRepriceTuning();
  const configDeps = deps.configDeps || {};
  const breaches = deps.breaches instanceof Map ? deps.breaches : new Map();
  // The connection-blackout clock, carried BETWEEN cycles by the caller exactly like `breaches`. A fresh
  // process starts with no blackout recorded, which is right: it did not witness one.
  const link = deps.link && typeof deps.link === 'object' ? deps.link : { downSince: null, consecutiveFailures: 0 };
  // ── GLI ORDINI PER CUI L'AVVISO «RESIDUO SOTTO SOGLIA» È GIÀ USCITO ─────────────────────────────
  // Portato FRA un ciclo e l'altro dal chiamante, esattamente come `breaches`, e per lo stesso motivo:
  // la condizione si ripresenta identica a ogni giro finché l'ordine non scade, e un avviso ripetuto
  // ogni cinque secondi è la stessa cosa del silenzio da cui viene. Un ciclo senza il Set iniettato ne
  // usa uno usa-e-getta — quindi un test che chiama il ciclo da solo vede sempre l'avviso, e la
  // deduplica resta una proprietà del processo lungo, non un effetto nascosto del modulo.
  const residuiSegnalati = deps.residuiSegnalati instanceof Set ? deps.residuiSegnalati : new Set();
  // Gemello di `residuiSegnalati` per l'anomalia del rinnovo fermato: UNA riga per ordine, non una per
  // ciclo. Un rinnovo bloccato resta bloccato per tutti i ~36 giri che restano prima della scadenza, e
  // trentasei righe identiche non dicono nulla che la prima non abbia già detto — anzi coprono il resto.
  const rinnoviSegnalati = deps.rinnoviSegnalati instanceof Set ? deps.rinnoviSegnalati : new Set();
  // I rinnovi dovuti e fermati di QUESTO giro. Lista propria, non `events`: vedi la nota al punto in
  // cui viene riempita.
  const rinnoviFermati = [];
  // ── GLI ORDINI PER CUI IL CONFLITTO INSEGUIMENTO/MAI-PRIMO È GIÀ STATO DICHIARATO ────────────────
  // Stessa ragione del Set qui sopra, e stessa forma. La soppressione è uno STATO: finché il book non
  // cambia si ripresenta identica a ogni giro, e su Barlow avrebbe scritto una riga ogni 5 secondi per
  // ventidue minuti — cioè lo stesso rumore da cui i 540 `skip-hourly-cap` non hanno avvisato nessuno.
  // Quindi nel registro durevole vanno le TRANSIZIONI (entra in conflitto, ne esce), con tutti i numeri
  // su cui la decisione è stata presa; i numeri di OGNI ciclo restano in `m.holds`, che agent40 stampa
  // nella sua riga di holding. Stesso criterio già usato per `erosion-armed`/`erosion-recovered`.
  const conflittiSoppressi = deps.conflittiSoppressi instanceof Set ? deps.conflittiSoppressi : new Set();
  // ── COSA SAPPIAMO DI OGNI ORDINE CHE ABBIAMO VISTO A RIPOSO ──────────────────────────────────────
  // Portata FRA i cicli dal chiamante come `breaches`. Esiste per una domanda che non si puo' porre a un
  // ordine che non c'e' piu': «e' morto per scadenza, e perche' nessuno l'ha rinnovato?». Il 5 agosto le
  // due gambe di Barlow sono scomparse alle 21:03:09 e l'audit conteneva 21 riprezzi e 540 skip — ma
  // nessun evento per la morte. Non e' che il dato mancasse: mancava il momento in cui qualcuno lo
  // confrontasse con l'assenza. Questa mappa e' quel momento.
  const ordiniVisti = deps.ordiniVisti instanceof Map ? deps.ordiniVisti : new Map();

  // ── UN ORDINE CHE ABBIAMO TOLTO NOI NON È MORTO DI SCADENZA ──────────────────────────────────────
  //
  // IL FALSO ALLARME, MISURATO. Il rilevatore «scaduto-senza-rinnovo» in fondo a questo ciclo dichiara
  // morto ogni id che era a riposo, non c'è più, e la cui scadenza era vicina (grazia 60s). Un RINNOVO
  // RIUSCITO produce esattamente quella firma: il replace cancella il vecchio id e ne conia uno NUOVO,
  // quindi il vecchio sparisce dal libro pur essendo stato rinnovato benissimo. Verificato su TX-15
  // (cid_d1f23e2b) il 5 agosto 2026: alle 23:56:11.617 le due gambe sono state rinnovate con successo —
  // `replaced:true`, `sent`, successori 0xc22e6b7e e 0x747c9372 — e cinque secondi dopo, alle
  // 23:56:16.616, l'audit conteneva due `scaduto-senza-rinnovo` sui predecessori 0x8ba4ae88 e
  // 0xbcef2547. Stessa cosa su Ed Markey alle 23:17:33.
  //
  // PERCHÉ PROPRIO LÌ E NON SEMPRE. Il rinnovo proattivo parte a 180s dalla scadenza, ben fuori dalla
  // grazia di 60s. Ma quando gli skip (mid-stale, tetto orario, rate-limit) rimandano il rinnovo, questo
  // scivola dentro la grazia: le due righe di TX-15 dicono «57s of venue-side life left» e «56s». Cioè
  // il falso allarme si presenta ESATTAMENTE nelle notti storte, quando si sta già guardando l'audit per
  // capire cos'è successo — il momento peggiore per un avviso che non descrive niente.
  //
  // LA REGOLA. Un ordine che questo ciclo ha tolto DI PROPOSITO — sostituito da un successore con un id
  // diverso, oppure cancellato da una delle mosse deliberate (fine vita del mercato, fine scala,
  // recupero dopo blackout, «sarei primo sul libro») — viene dimenticato subito. Ognuna di quelle mosse
  // ha già il suo record nell'audit, con il suo nome; attribuirle in più una morte per scadenza sarebbe
  // raccontare due volte lo stesso fatto, e la seconda volta sbagliando.
  //
  // COSA NON SI DIMENTICA, ed è il punto: un replace il cui piazzamento è FALLITO lasciando il libro
  // vuoto NON ha successore, quindi l'ordine resta in questa mappa e la sua sparizione continua a
  // produrre l'avviso. Il rilevatore perde solo i casi in cui sappiamo per certo dove è finito l'ordine.
  const dimenticaOrdineTolto = (orderId) => { if (orderId) ordiniVisti.delete(orderId); };

  const audit = typeof deps.audit === 'function' ? deps.audit : () => {};
  const actions = [];
  const events = [];
  const result = (gate, reason, extra = {}) => ({
    at: new Date(t0).toISOString(), ran: gate == null, gate, reason, markets: [], actions, events, ...extra,
  });

  // ── GATE 0 — the master switch. Off or unreadable ⇒ the automatism does nothing, and says which. ──
  const cfgState = readAutoRepriceConfig(configDeps);
  if (!cfgState.readable) {
    return result('config-unreadable', `auto-reprice config ${cfgState.error} — doing nothing (fail closed)`);
  }
  if (!cfgState.globalEnabled) {
    return result('disabled-global', 'auto-reprice is off globally — no market is watched');
  }
  if (cfgState.enabledMarketIds.length === 0) {
    return result('no-markets', 'auto-reprice is on globally but no market is opted in');
  }

  // ── GATE 1 — THE GLOBAL KILL SWITCH, read BEFORE anything is cancelled. ──
  // A re-price is cancel-then-place. Under a kill the place would be refused, so cancelling first would
  // strip the operator's resting order for nothing. Reading kill here means a killed system never starts
  // the sequence at all. (replaceManualOrder now refuses under kill for the same reason — this is the
  // belt in front of that brace.)
  const kill = typeof deps.killStatus === 'function' ? deps.killStatus() : { effectivelyKilled: false, readable: true };
  if (kill.effectivelyKilled === true || kill.readable === false) {
    return result('kill', kill.readable === false
      ? 'kill-switch state is UNREADABLE — treated as active (fail closed); the automatism does nothing'
      : 'the global kill switch is ACTIVE — the automatism does nothing (cancelling now would leave nothing resting, since a replacement could not be placed)');
  }

  // ── UN MERCATO, UN SOLO MOTORE ──────────────────────────────────────────────────────────────────
  // I mercati con il tracking attivo (lib/maker/mm-tracking) appartengono a QUEL motore, che li quota su
  // due lati inseguendo il mid. Questo watcher e' reattivo e sposta un ordine solo quando rischia di
  // uscire dalla banda: due logiche diverse sullo stesso ordine si contenderebbero il posto, e il
  // risultato sarebbe un ordine che viene cancellato e ripiazzato da due processi con due idee diverse
  // di dove debba stare. Qui il tracking VINCE, perche' e' l'unico dei due che l'operatore ha acceso
  // esplicitamente per quel mercato.
  //
  // La lista si legge a ogni ciclo, non si memorizza: spegnere il tracking deve restituire il mercato a
  // questo watcher entro un ciclo, non entro un riavvio.
  let tracked = [];
  try {
    tracked = typeof deps.trackedMarketIds === 'function'
      ? deps.trackedMarketIds()
      : require('./mm-tracking-config').trackedMarketIds();
  } catch { tracked = []; }
  const trackedSet = new Set(tracked.map((x) => String(x).trim().toLowerCase()));

  const markets = [];
  // ── COSA ABBIAMO EFFETTIVAMENTE VISTO A RIPOSO, QUESTO GIRO ─────────────────────────────────────
  // Serve a una cosa sola: sapere quali ordini già segnalati sono spariti, per togliere il loro id dal
  // Set e non tenerlo in memoria per sempre. `letturaCompleta` è la condizione che rende quel confronto
  // lecito — se anche un solo mercato non è stato letto (regole illeggibili, venue muto, nessuna
  // credenziale), «non l'ho visto» non significa «non c'è più», e potare lì dentro farebbe uscire
  // l'avviso una seconda volta sullo stesso ordine appena il venue torna a rispondere.
  const vistiARiposo = new Set();
  let letturaCompleta = true;
  // ── I MERCATI DI CUI SI E' DAVVERO LETTO IL LIBRO, QUESTO GIRO ───────────────────────────────────
  // Piu' preciso di `letturaCompleta`, e per il confronto «c'era e non c'e' piu'» serve la precisione:
  // un mercato saltato perche' e' passato al motore di tracking, o perche' e' tornato ad agent35, non e'
  // stato letto — e «non l'ho guardato» non e' «non c'e' piu'». Con il solo flag globale gli ordini di
  // quei mercati risulterebbero spariti, e la morte per scadenza verrebbe annunciata su ordini vivi.
  const mercatiLetti = new Set();

  // ── LO SCOPE DEL RINNOVO E' L'UNIONE, NON LA LISTA STRETTA (12 agosto 2026) ──────────────────────
  // Fino a oggi questo ciclo iterava `cfgState.enabledMarketIds`, cioe' la sola allowlist di piano. La
  // conseguenza era dichiarata in §5 punto 69 e accettata allora: un mercato che esce dal piano non
  // viene piu' visitato, quindi i suoi ordini non vengono rinnovati e muoiono per scadenza GTD entro 23
  // minuti. Su un bot che ruota il piano ogni sei ore e ricalcola ogni dieci minuti quella non e' una
  // rarita': e' il modo ordinario in cui il capitale torna fermo senza che nessuno lo decida.
  //
  // E' LA STESSA REGOLA DI COPERTURA gia' applicata quattro volte altrove — catalogo dei metadati
  // (§5 punto 44), sottoscrizione del book (61), allowlist del gate live-min (62/69), scansione dei
  // registri (82) — e violata ogni volta per lo stesso motivo: la lista che si aveva a portata di mano
  // era quella del piano. Le tre componenti:
  //
  //   1. `enabledMarketIds`  — cosa il piano vuole quotare ADESSO;
  //   2. `enabledDaPosizione` — dove il capitale e' GIA' esposto (dallo snapshot del venue, fail-closed
  //      per costruzione: snapshot illeggibile ⇒ lista vuota, non «nessuna posizione»);
  //   3. `mercatiConOrdiniVivi` — dove abbiamo ordini a riposo che il piano non nomina piu'.
  //
  // ⚠ LA TERZA COMPONENTE E' UNA MEMORIA, NON UNA LETTURA, ed e' voluto. Non esiste uno snapshot locale
  // degli ordini a riposo (§5 punto 55 lo dichiara come lavoro a se'), e interrogare il venue per
  // scoprire mercati che non stiamo guardando costerebbe una chiamata per mercato per ciclo — cioe' il
  // carico che questo stesso lavoro sta cercando di ridurre. Quello che serve davvero e' piu' stretto:
  // un mercato che ERA nello scope e ne e' uscito lasciandoci degli ordini. Quel mercato lo abbiamo
  // guardato l'ultimo giro, quindi la memoria del giro precedente basta e non costa niente.
  //   Il limite, detto: un mercato uscito dallo scope mentre il processo era giu' non rientra da questa
  // strada. Rientra dalla (2) se ha una posizione, e per i soli ordini resta la scadenza GTD — che e'
  // il comportamento di oggi, quindi non si perde nulla rispetto a prima.
  //
  // FAIL-SAFE VERSO IL COMPORTAMENTO DI PRIMA: qualunque componente non leggibile viene semplicemente
  // omessa dall'unione. Il minimo garantito resta `enabledMarketIds`, cioe' esattamente lo scope che
  // questo ciclo aveva prima di oggi.
  const scopeRinnovo = [];
  const daScope = new Map();   // id → perche' e' nello scope, per il referto
  const aggiungiAlloScope = (id, perche) => {
    const k = String(id || '').trim().toLowerCase();
    if (!k) return;
    if (!daScope.has(k)) { daScope.set(k, perche); scopeRinnovo.push(k); return; }
    // un mercato puo' essere nello scope per piu' ragioni: si tiene la piu' forte, cioe' la prima.
  };
  for (const id of cfgState.enabledMarketIds) aggiungiAlloScope(id, 'piano');
  for (const id of (Array.isArray(cfgState.enabledDaPosizione) ? cfgState.enabledDaPosizione : [])) {
    aggiungiAlloScope(id, 'posizione-aperta');
  }
  const ordiniVivi = (() => {
    try {
      const v = typeof deps.mercatiConOrdiniVivi === 'function' ? deps.mercatiConOrdiniVivi() : deps.mercatiConOrdiniVivi;
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  })();
  for (const id of ordiniVivi) aggiungiAlloScope(id, 'ordini-a-riposo');
  const scopeAggiunti = scopeRinnovo.length - cfgState.enabledMarketIds.length;
  // Cosa il venue dice, QUESTO giro, di avere a riposo per noi. Viaggia nel referto perché il
  // chiamante possa restituircelo al giro dopo: è la memoria che tiene aperto lo scope su un mercato
  // che il piano ha appena lasciato.
  const mercatiConOrdiniQuestoGiro = new Set();

  for (const marketId of scopeRinnovo) {
    if (trackedSet.has(String(marketId).trim().toLowerCase())) {
      markets.push({ marketId, gate: 'owned-by-tracking', considered: 0, held: 0, skipped: 0, repriced: 0, holds: [],
        reason: 'questo mercato ha il tracking attivo (market making a due lati): lo gestisce quel motore, e questo watcher sta alla larga per non contendersi lo stesso ordine' });
      continue;
    }
    const m = { marketId, gate: null, reason: null, considered: 0, held: 0, skipped: 0, repriced: 0, holds: [] };

    // ── GATE 1-bis — IL LOCK DEL MERCATO (16 agosto 2026) ────────────────────────────────────────
    //
    // ⚠ IL DIFETTO CHE CHIUDE, MISURATO SUL VENUE: due `manual-replace` a 11:34:56 e 11:34:59 sullo
    // STESSO `orderId` (`0x7dd17698…`), entrambi riusciti, due ordini identici a libro su `0x776841ce…`.
    //
    // ⚠ E NON ERA UN PROBLEMA DI CHIAVE. `minIntervalMs` (30 s) e' gia' ancorato al MERCATO e non
    // all'orderId — il commento poco piu' sotto lo dice da sempre, ed e' corretto. Non ha protetto
    // perche' `readAutoRepriceState` legge lo stato all'INIZIO del ciclo e la scrittura arriva alla
    // FINE: due cicli sovrapposti leggono entrambi «l'ultimo riprezzo e' vecchio di minuti». E' una
    // corsa fra lettura e scrittura, e nessuna riancoratura della chiave l'avrebbe chiusa.
    // A renderla probabile e' stata la cadenza: `MAKER_AUTO_REPRICE_POLL_MS` a 1000 ms piu' il feed in
    // PUSH fanno passare venti volte piu' spesso dentro quella finestra.
    //
    // Il lock tiene per TUTTA la sequenza cancel+place di questo mercato e si rilascia nel `finally`
    // in fondo al giro. Scade da solo dopo 20 s: un `replace` morto a meta' non puo' murare il mercato,
    // che altrimenti perderebbe gli ordini per GTD in 23 minuti senza che nessuno dica perche'.
    const lock = LOCK.prendi(marketId, { da: 'auto-reprice' });
    if (!lock.preso) {
      m.gate = 'riprezzo-in-corso'; m.reason = lock.motivo;
      audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
        outcome: 'riprezzo-in-corso', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: lock.motivo });
      markets.push(m); continue;
    }
    // ⚠ INCOERENTE NON E' VIA LIBERA: il lock precedente e' scaduto senza rilasciarsi, quindi fra un
    // cancel riuscito e un place mai partito c'e' un ordine in meno, e fra un cancel fallito e un place
    // riuscito ce n'e' uno in piu'. Si DICHIARA e si lascia che il giro rilegga gli ordini vivi dal
    // venue (cosa che fa comunque, piu' sotto): agire piu' in fretta sarebbe il modo di raddoppiare.
    if (lock.incoerente) {
      m.lockIncoerente = true;
      audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
        outcome: 'lock-scaduto-stato-incoerente', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
        reason: lock.motivo, tenutoDaMs: lock.tenutoDaMs });
    }
    try {

    // ── GATE 2 — MANUAL OWNERSHIP. Same precondition as a hand order: the automatism may only act where
    //    agent35 is provably standing off. A market handed back to the engine is dropped immediately. ──
    const mm = typeof deps.isManual === 'function' ? deps.isManual(marketId) : { manual: true, readable: true };
    if (!mm.readable) { m.gate = 'manual-mode-unreadable'; m.reason = 'market ownership is unreadable — skipping (fail closed)'; markets.push(m); continue; }
    if (!mm.manual) { m.gate = 'manual-mode-inactive'; m.reason = 'this market is no longer in manual mode — agent35 owns it again, so the automatism stands off'; markets.push(m); continue; }

    // ── GATE 2-bis — LA CADENZA DI QUESTO MERCATO (lib/maker/cadenza-adattiva.js) ───────────────────
    // Stesso gate, stesso modulo e stessa posizione del motore di tracking: prima di qualunque I/O col
    // venue. Un mercato lento viene guardato ogni 10s invece che ogni 5, uno veloce ogni secondo.
    // Non tocca `hysteresisTicks` ne' `confirmSamples`: la soglia che decide SE riprezzare resta quella,
    // e resta valutata a ogni sguardo. Qui si decide solo QUANDO guardare.
    const cad = typeof deps.cadenza === 'function' ? deps.cadenza(marketId) : { valuta: true, cadenzaMs: null, classe: 'spenta', motivo: null };
    if (cad && cad.valuta === false) {
      m.gate = 'cadenza-adattiva';
      m.reason = `mercato ${cad.classe}: si guarda ogni ${cad.cadenzaMs}ms, mancano ${cad.attesaMs}ms — ${cad.motivo}`;
      m.cadenzaMs = cad.cadenzaMs; m.cadenzaClasse = cad.classe;
      markets.push(m); continue;
    }
    if (cad) { m.cadenzaMs = cad.cadenzaMs; m.cadenzaClasse = cad.classe; }
    if (typeof deps.segnaValutazione === 'function') deps.segnaValutazione(marketId, t0);

    // ── THE MARKET'S OWN CLOCK — checked BEFORE any venue I/O ───────────────────────────────────────
    // A renewal is a cancel→replace, and the replace is refused inside the market's final minutes
    // (lib/maker/market-clock.js). Discovering that per-order, every 5s, would mean a cancel attempt and a
    // refusal on every poll for the whole tail of a short market. Standing off here is both quieter and
    // more correct: with nothing renewing, the venue's own GTD retires the resting orders by itself, which
    // is exactly the behaviour wanted as a market closes. Skipped entirely when the close time is
    // unreadable — unknown is not "closing soon" (same rule as everywhere else).
    const win = typeof deps.marketWindow === 'function'
      ? deps.marketWindow(marketId)
      : (() => {
        try {
          return require('./market-clock').marketWindowFor({ marketId, baseTtlSeconds: config.restingGtdSeconds, baseRefreshMarginSeconds: config.refreshMarginSeconds });
        } catch { return null; }
      })();
    // L'orologio si LEGGE qui ma si APPLICA dopo aver visto il libro: il suo gate deve poter cancellare,
    // e per cancellare bisogna sapere cosa c'e' a riposo. Stessa correzione gia' applicata al motore di
    // tracking — i due motori devono comportarsi allo stesso modo a fine vita di un mercato.

    const rules = typeof deps.resolveRules === 'function' ? deps.resolveRules(marketId) : null;
    if (!rules || rules.readable !== true) {
      m.gate = 'rules-unreadable';
      m.reason = `venue rules not readable (missing: ${rules && Array.isArray(rules.missing) ? rules.missing.join(', ') : 'unknown'}) — skipping this market`;
      letturaCompleta = false;
      markets.push(m); continue;
    }

    // ── VENUE TRUTH, not local belief. The resting orders are read from the venue every cycle. ──
    let listed;
    try { listed = await deps.listOrders({ marketId }); }
    catch (e) { listed = { ok: false, error: e.message }; }
    if (!listed || listed.ok === false) {
      // ── THE CONNECTION BLACKOUT CLOCK STARTS HERE ────────────────────────────────────────────────
      // The process is alive but cannot see the venue. Note the FIRST failure and carry on failing; the
      // recovery branch below decides what to do about it once the venue answers again.
      if (link.downSince == null) link.downSince = t0;
      link.consecutiveFailures = (link.consecutiveFailures || 0) + 1;
      letturaCompleta = false;
      m.gate = 'list-failed';
      m.reason = `venue read FAILED (${listed && listed.error ? listed.error : 'unknown'}) — skipping; we do not know what is resting, and that is not the same as nothing resting`
        + ` · blind for ${Math.round((t0 - link.downSince) / 1000)}s (${link.consecutiveFailures} consecutive failures). While blind nothing is renewed, so the venue-side GTD expiry is doing exactly the job it exists for.`;
      markets.push(m); continue;
    }
    if (listed.simulated === true) {
      letturaCompleta = false;
      m.gate = 'simulated';
      m.reason = 'no venue credentials — the venue was not queried, so there is nothing to act on (this is "we did not read", not "you have no orders")';
      markets.push(m); continue;
    }

    // ── THE VENUE ANSWERED. WAS THIS A RECOVERY FROM A LONG BLACKOUT? ────────────────────────────────
    // Being blind is survivable — the GTD expiry retires orders on its own. The RECOVERY is the dangerous
    // moment: after a blackout longer than the refresh margin we can no longer claim to know which of our
    // orders survived, which the exchange already retired, and which were filled while we could not see.
    // Renewing on top of that guesswork would be asserting a state we did not observe.
    //
    // So we cancel the panel's own resting orders on this market and stop. The operator re-places
    // deliberately. Cancelling is the direction that can only reduce exposure, it goes through the
    // CANCEL-ONLY adapter, and it leaves the book in a state we can describe honestly.
    // ── IL FILTRO DEI PRE-ESISTENTI — UNO SOLO, E STA QUI ────────────────────────────────────────
    //
    // Gli ordini gia' a riposo quando il motore si e' avviato sono INVISIBILI da questo punto in poi.
    // Il filtro e' QUI e in nessun altro posto: `owned` e' l'unico insieme da cui discendono il
    // riprezzo, il rinnovo, le cancellazioni di questo ciclo, l'esposizione della Regola 5, gli
    // `ownOrders` della profondita', la gamba orfana, il lato singolo e gli eventi. Toglierli una volta
    // sola all'imbocco vale piu' di dieci `if` corretti sparsi a valle, perche' il decimo si dimentica.
    //
    // COSA NON PASSA DI QUI, ED E' VOLUTO: `lib/maker/cancel-all.js` (il KILL) elenca dal venue e
    // cancella tutto, pre-esistenti compresi — lo stop resta assoluto. E le POSIZIONI non sono ordini:
    // se un pre-esistente viene eseguito, quel capitale entra nella gestione normale dall'uscita
    // automatica, che legge le posizioni dal venue e non questa lista.
    //
    // ASSENTE PER DIFETTO: senza `deps.filtraPreesistenti` non c'e' nessun pre-esistente e il ciclo e'
    // byte per byte quello di prima.
    const tuttiNostri = selectOwnedOrders(listed.orders, { marketId, rules });
    const sep = typeof deps.filtraPreesistenti === 'function'
      ? deps.filtraPreesistenti(tuttiNostri)
      : { gestiti: tuttiNostri, preesistenti: [] };
    const owned = Array.isArray(sep && sep.gestiti) ? sep.gestiti : tuttiNostri;
    const preesistenti = Array.isArray(sep && sep.preesistenti) ? sep.preesistenti : [];
    m.preesistenti = preesistenti.length;

    // ── IL CAMPIONE DI PROFONDITA' ALTRUI ──────────────────────────────────────────────────────────
    // Qui, e non altrove, perche' questo e' l'unico punto del sistema in cui il book, la banda e i
    // NOSTRI ordini letti dal venue esistono nella stessa iterazione. Il denominatore del pavimento
    // nasce dalla stessa sottrazione del numeratore (`othersLadder`), quindi i due non possono piu'
    // divergere. Il modulo si autolimita a un campione ogni 45s per mercato.
    // Best-effort in senso stretto: una misura mancata e' una lacuna nella serie, mai uno zero, e non
    // deve poter fermare il giro che sorveglia ordini veri.
    if (typeof deps.campionaProfondita === 'function') {
      try { deps.campionaProfondita({ marketId, rules, ownOrders: owned, now: t0 }); }
      catch { /* la misura non governa niente in questo giro: il pavimento la legge al giro dopo */ }
    }

    // Gli orderId tolti dal libro DURANTE questo giro: servono al controllo della gamba orfana per
    // sapere quali lati sono ancora vivi ADESSO, non all'inizio del giro.
    const tolti = new Set();
    mercatiLetti.add(String(marketId).trim().toLowerCase());
    // ── LA MEMORIA CHE TIENE LO SCOPE APERTO AL GIRO DOPO ─────────────────────────────────────────
    // Se qui c'è anche un solo ordine a riposo, questo mercato deve restare visitabile al giro
    // successivo ANCHE SE il piano lo toglie nel frattempo: è la terza componente dell'unione dello
    // scope, e si costruisce da ciò che il venue ha appena detto, non da una lista nostra.
    if (owned.length > 0) mercatiConOrdiniQuestoGiro.add(String(marketId).trim().toLowerCase());
    for (const o of owned) {
      vistiARiposo.add(o.orderId);
      // La fotografia di ciò che il venue dice ADESSO di questo ordine. Si sovrascrive a ogni giro, così
      // quando l'ordine sparisce l'ultima riga descrive l'ultimo istante in cui esisteva davvero.
      const prima = ordiniVisti.get(o.orderId) || {};
      ordiniVisti.set(o.orderId, {
        ...prima,
        marketId, marketTitle: rules.title || null,
        book: o.book, side: o.side, price: o.price,
        size: o.size, sizeMatched: o.sizeMatched,
        orderType: o.orderType,
        expiresAtMs: o.expiresAtMs,
        ultimaTtlSec: o.secondsToExpiry,
        ultimaVistaMs: t0,
      });
    }
    if (link.downSince != null) {
      const blindSec = Math.round((t0 - link.downSince) / 1000);
      const threshold = Number.isFinite(config.disconnectCancelSeconds) ? config.disconnectCancelSeconds : DISCONNECT_CANCEL_SECONDS;
      link.downSince = null;
      link.consecutiveFailures = 0;
      if (blindSec > threshold) {
        m.gate = 'reconnect-cancel';
        m.reason = `venue reachable again after ${blindSec}s blind (threshold ${threshold}s) — cancelling this market's hand orders rather than renewing on top of a state we did not observe`;
        audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'reconnect-cancel',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: m.reason, observed: { blindSeconds: blindSec, thresholdSeconds: threshold, orders: owned.length } });
        for (const o of owned) {
          let c = null;
          try { c = typeof deps.cancelOrder === 'function' ? await deps.cancelOrder({ orderId: o.orderId, marketId }) : null; }
          catch (e) { c = { ok: false, reason: e.message }; }
          if (c && c.ok) dimenticaOrdineTolto(o.orderId);   // tolto di proposito: non è una morte per scadenza
          actions.push({ marketId, orderId: o.orderId, action: 'reconnect-cancel', ok: !!(c && c.ok), reason: (c && c.reason) || null });
          audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: (c && c.ok) ? 'reconnect-cancelled' : 'reconnect-cancel-failed',
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: o.orderId, reason: (c && c.reason) || null });
        }
        m.considered = owned.length;
        m.skipped = owned.length;
        markets.push(m);
        continue;
      }
      m.reason = `venue reachable again after ${blindSec}s blind — under the ${threshold}s threshold, so the normal cycle resumes without cancelling anything`;
    }
    m.considered = owned.length;

    // ── FINE VITA DEL MERCATO — SI CANCELLA, NON SI ABBANDONA (punto 3) ─────────────────────────────
    // Prima questo gate stava piu' in alto e usciva dal ciclo lasciando gli ordini a scadere per GTD.
    // «Lasciar scadere» suona prudente e non lo e': un ordine dimenticato su un mercato che sta
    // risolvendo puo' essere eseguito fino all'ultimo secondo, a un prezzo che nessuno sta piu'
    // guardando. La GTD e' una rete per il caso «il processo e' morto», non una politica di uscita.
    //
    // La stessa correzione e' gia' nel motore di tracking: i due motori devono fare la stessa cosa a
    // fine vita, altrimenti lo stesso mercato si comporta in due modi a seconda di chi lo gestisce.
    //
    // La soglia governa cio' che si PIAZZA; cancellare non richiede alcuna finestra GTD ed e' l'unica
    // direzione che puo' solo ridurre l'esposizione.
    if (win && win.tooClose === true) {
      m.gate = win.gate || 'market-too-close-to-close';
      audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'end-of-life-cancel',
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, gate: m.gate, reason: win.reason,
        observed: { minutesToClose: win.minutesToClose ?? null, orders: owned.length } });
      let tolti = 0;
      for (const o of owned) {
        let c = null;
        try { c = typeof deps.cancelOrder === 'function' ? await deps.cancelOrder({ orderId: o.orderId, marketId }) : null; }
        catch (e) { c = { ok: false, reason: e.message }; }
        const okc = !!(c && c.ok);
        if (okc) { tolti += 1; dimenticaOrdineTolto(o.orderId); }   // tolto di proposito, non scaduto
        actions.push({ marketId, orderId: o.orderId, action: 'end-of-life-cancel', ok: okc,
          minutesToClose: win.minutesToClose ?? null, reason: (c && c.reason) || null });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
          outcome: okc ? 'end-of-life-cancelled' : 'end-of-life-cancel-failed',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: o.orderId, reason: (c && c.reason) || null });
      }
      m.skipped = owned.length;
      m.reason = `${win.reason} — il watcher non rinnova piu' su questo mercato`
        + (owned.length ? `; ${tolti}/${owned.length} ordini a riposo CANCELLATI invece di essere lasciati scadere` : '; nessun ordine a riposo da togliere');

      // ── LA ALLOWLIST NON RESTA ACCESA SU UN MERCATO MORTO ───────────────────────────────────────
      // Simmetrico al FIX 3 di lib/maker/mm-tracking.js, che spegne il registro di tracking sulla
      // stessa condizione. Il commento poco sopra dice gia' che «i due motori devono fare la stessa
      // cosa a fine vita» — valeva per la cancellazione, non per lo spegnimento, e la meta' mancante
      // e' costata cinque mercati.
      //
      // MISURATO IL 4 AGOSTO 2026: `cfg.enabledMarketIds` conteneva 7 mercati, di cui CINQUE finestre
      // Bitcoin da 5 minuti del 2 agosto, chiuse da oltre 2800 minuti. agent40 le vedeva ogni 5
      // secondi e le annunciava `market-closed` — e le lasciava nella allowlist a ogni giro. Una
      // pulizia esisteva (allocation-reset.js, fase 2) ma e' legata al RESET completo, cioe' al
      // riallocatore periodico (in dry-run) o al bottone «Conferma ed esegui». Chi abilita un mercato
      // dal percorso per-mercato non passa mai di li': quel percorso e' additivo per costruzione.
      //
      // PERCHE' E' SICURO TOGLIERE. `enabledMarketIds` e' la allowlist live-min: toglierne un mercato
      // puo' solo RESTRINGERE cio' che e' piazzabile, mai allargarlo. Su un mercato chiuso non si
      // piazza comunque nulla, e la cancellazione — l'unica direzione che riduce l'esposizione — non e'
      // soggetta ne' alla allowlist ne' al kill.
      //
      // E PERCHE' SOLO QUI. `market-closed` e non `tooClose`: dentro la finestra finale il mercato e'
      // ancora vivo e deve restare configurato. E solo a libro libero: prima si toglie tutto, poi si
      // chiude il registro — mai il contrario, o si resterebbe con un ordine vero su un mercato che il
      // sistema non governa piu'.
      const tuttoTolto = tolti === owned.length;
      if (win.gate === 'market-closed' && tuttoTolto && typeof deps.disableMarket === 'function') {
        let off = null;
        try { off = await deps.disableMarket({ marketId, reason: 'mercato chiuso e libro libero: esce dalla allowlist da solo' }); }
        catch (e) { off = { ok: false, error: e.message }; }
        m.autoDisabled = !!(off && off.ok);
        audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
          outcome: (off && off.ok) ? 'allowlist-auto-off' : 'allowlist-auto-off-failed',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
          reason: (off && off.error) || 'mercato chiuso e nessun ordine residuo' });
        if (off && off.ok) m.reason += ' · TOLTO dalla allowlist automaticamente: mercato chiuso e nessun ordine residuo';
      }

      markets.push(m); continue;
    }

    // ── FINE SCALA — SI CANCELLA, NON SI RIPREZZA ───────────────────────────────────────────────────
    // Sotto i 3¢ o sopra i 97¢ (lib/maker/end-of-scale.js, unica definizione) il mercato sta risolvendo,
    // non facendo mercato. Ogni altra decisione di questo ciclo — insegui il mid, rinnova la scadenza,
    // rimetti l'ordine dentro banda — rimetterebbe capitale esattamente dove lo stiamo togliendo,
    // quindi questo controllo viene PRIMA di decideReprice e non dopo.
    //
    // CONVIVENZA CON IL DEAD-MAN'S SWITCH GTD, che è il punto delicato. I due meccanismi non si
    // contendono nulla perché rispondono a due domande diverse e agiscono in due modi diversi:
    //   · la GTD a 23 minuti col rinnovo a 3 è un TIMER tenuto dal VENUE. Protegge dal caso «questo
    //     processo è morto»: se nessuno rinnova, l'exchange ritira l'ordine da solo.
    //   · questa è una soglia di PREZZO valutata QUI, a ogni giro. Protegge dal caso «il processo è vivo
    //     e sta facendo la cosa sbagliata», che nessun timer può notare.
    // Non si escludono: un ordine cancellato qui non ha più una scadenza da rinnovare, e un ordine
    // scaduto per GTD non ha più nulla da cancellare. Il primo dei due che arriva vince, ed entrambi gli
    // esiti sono quello voluto — l'ordine non è più sul book. Non tocchiamo il rinnovo proattivo: qui si
    // esce dal ciclo con `continue`, quindi il rinnovo per questo mercato semplicemente non viene
    // nemmeno considerato finché il mid resta a fine scala.
    const eos = endOfScaleCheck(rules.mid);
    if (eos.endOfScale) {
      m.gate = 'end-of-scale';
      m.reason = eos.reason;
      m.endOfScale = { midCents: eos.midCents, side: eos.side };
      audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'end-of-scale-cancel',
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, gate: 'end-of-scale', reason: eos.reason,
        observed: { midCents: eos.midCents, side: eos.side, orders: owned.length } });
      for (const o of owned) {
        let c = null;
        try { c = typeof deps.cancelOrder === 'function' ? await deps.cancelOrder({ orderId: o.orderId, marketId }) : null; }
        catch (e) { c = { ok: false, reason: e.message }; }
        if (c && c.ok) dimenticaOrdineTolto(o.orderId);   // tolto di proposito, non scaduto
        actions.push({ marketId, orderId: o.orderId, action: 'end-of-scale-cancel', ok: !!(c && c.ok),
          midCents: eos.midCents, reason: (c && c.reason) || null });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
          outcome: (c && c.ok) ? 'end-of-scale-cancelled' : 'end-of-scale-cancel-failed',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: o.orderId,
          reason: (c && c.reason) || eos.reason, observed: { midCents: eos.midCents, side: eos.side } });
      }
      m.skipped = owned.length;
      markets.push(m);
      continue;
    }

    const state = readAutoRepriceState(configDeps);
    const marketState = state.markets[String(marketId).toLowerCase()] || {};
    const repricesThisHour = Array.isArray(marketState.recentAt)
      ? marketState.recentAt.filter((t) => Number.isFinite(t) && t0 - t < 3_600_000).length
      : 0;

    // Quanti ordini di QUESTO mercato questo ciclo ha dovuto saltare perché non sappiamo che prezzo
    // c'è. Se sono tutti, il mercato è cieco — e da qui parte l'orologio dei venti secondi.
    let ordiniCiechi = 0;
    // Quale delle tre cecita' ha fermato gli ordini: serve al log, non alla decisione.
    const causeCieche = new Map();
    // Le posizioni di QUESTO mercato, lette al piu' una volta per giro e SOLO se un rinnovo arriva a
    // chiederle (vedi il controllo dell'orfano piu' sotto). `undefined` = non ancora chiesta,
    // `null` = chiesta e non leggibile — due stati diversi, e il secondo non deve far rileggere.
    let posizioniDelMercato;
    for (const order of owned) {
      const prevBreaches = breaches.get(order.orderId) || 0;
      // THE RATE LIMIT IS PER MARKET, NOT PER ORDER ID — and that is deliberate. A re-price produces a
      // NEW order id, so an id-keyed limit would never bind on the replacement: the automatism could
      // re-price the thing it had just placed, immediately, forever. Keying on the market means "this
      // leg was moved N seconds ago" survives the id change, which is what the limit is actually about.
      const lastAt = Number.isFinite(marketState.lastRepriceAt) ? marketState.lastRepriceAt : null;

      // ── LA NOSTRA PRESENZA SU QUESTO LATO — UN INSIEME SOLO, PER LA DECISIONE E PER IL PIAZZAMENTO ──
      //
      // `ownOrders` significa una cosa precisa (lib/maker/top-of-book.othersLadder): è l'insieme che
      // viene SOTTRATTO dalla scala pubblicata per ottenere la scala ALTRUI. Un ordine che non sta qui
      // dentro resta nel libro e conta come CONCORRENTE.
      //
      // L'ASIMMETRIA CHE C'ERA. La decisione passava tutti i nostri ordini del lato, il piazzamento
      // (`replaceOrder`, più sotto) li passava tutti TRANNE quello valutato — con la motivazione che
      // quell'ordine sta per essere cancellato, quindi non sarà più sul libro. La motivazione confonde
      // due cose diverse: se l'ordine sarà ancora A RIPOSO (no, viene cancellato) e se è ancora nella
      // FOTOGRAFIA del book su cui si fa il conto (sì — lo snapshot di agent34 ha fino a 3 secondi, e
      // la cancellazione è avvenuta pochi millisecondi prima). Quindi il piazzamento trovava la nostra
      // stessa size in cima al lato e la trattava come il concorrente da cui stare dietro: un tick
      // dietro a noi stessi.
      //
      // QUANDO SI VEDE. Serve una nostra size in testa al lato, e con DUE nostre coppie sullo stesso
      // mercato — la situazione di Ed Markey il 5 agosto — diventa facile: valutando la gamba davanti,
      // la decisione la sottraeva e il piazzamento no, quindi i due percorsi rispondevano a due libri
      // diversi nello stesso ciclo.
      //
      // LA SEMANTICA UNICA. «Chi è il miglior concorrente» non si risponde mai con roba nostra, in
      // nessuna fase del ciclo di vita di un ordine. Quindi si sottrae TUTTA la nostra presenza sul
      // lato, questo ordine compreso, e l'insieme è UNO — calcolato qui, passato a entrambi i rami.
      // ── LA STESSA SELEZIONE DEL PERCORSO DI PIAZZAMENTO ────────────────────────────────────────
      // Era `owned.filter((x) => x.book === order.book)`, cioè un filtro scritto a mano; `manual-order`
      // ne aveva un altro, scritto a mano anche lui, per `tokenId`. Due filtri sullo stesso concetto
      // producono due book ALTRUI diversi fra chi DECIDE il prezzo e chi lo PIAZZA — cioè due risposte
      // a «chi è il miglior concorrente». Adesso è una funzione sola, chiamata da entrambi.
      // Il comportamento su un ingresso ben formato è identico a prima; cambia che non può divergere.
      const nostriSulLato = nostriOrdiniSulLato({ orders: owned, book: order.book }).ordini;

      const d = decideReprice(
        {
          order, rules, config, lastRepriceAt: lastAt, consecutiveBreaches: prevBreaches, repricesThisHour, now: t0,
          ownOrders: nostriSulLato,
          // IN-PROCESS E AUTOREVOLE: questo ciclo ha appena letto gli ordini del venue, quindi la corsia di
          // piazzamento non deve rileggerli — sarebbe una chiamata sprecata a ogni riprezzo. Il pannello NON
          // puo' dichiararlo: il campo non e' nello schema zod della sua rotta, e zod scarta cio' che non
          // conosce. Il confine di fiducia e' quello schema, non una promessa.
          ownOrdersAuthoritative: true,
        },
        { resolveOffset: deps.resolveOffset, offsetDeps: deps.offsetDeps, resolveDepth: deps.resolveDepth },
      );
      // ══ IL VETO DI PROFILO — SAFE O RISK, LETTO A OGNI GIRO ═══════════════════════════════════
      //
      // COSA FA E COSA NON FA. Non sostituisce `decideReprice`: gli si mette DAVANTI come veto. Se il
      // percorso del profilo dice no, l'azione diventa `skip` e nient'altro cambia. La direzione è
      // quindi solo restrittiva — questo blocco può impedire un ordine, mai crearne uno, mai spostarne
      // uno che `decideReprice` non avrebbe spostato. Su un motore che gira su capitale reale è
      // l'unica forma di aggiunta che non possa peggiorare lo stato.
      //
      // IL PROFILO SI RILEGGE OGNI VOLTA, dallo store che porta anche il tetto (allocated-capital):
      // un mercato che passa da Risk a Safe fra due giri viene valutato col profilo NUOVO al giro
      // successivo. Nessuna cache: la freschezza è quella del file.
      //
      // PROFILO SCONOSCIUTO ⇒ SI SALTA. Un mercato fuori dal piano corrente, o un piano più vecchio di
      // 24 h, non hanno un profilo, e `valutaPiazzamento` rifiuta un profilo che non riconosce. È la
      // stessa direzione che il tetto applica già: fuori dal piano ⇒ nessuna esposizione nuova.
      //
      // ASSENTE PER DIFETTO. Senza `deps.leggiProfilo` e `deps.valutaPiazzamento` questo blocco non
      // gira e il ciclo è byte-per-byte quello di prima: è ciò che permette ai test esistenti di
      // continuare a esercitare `decideReprice` da solo.
      if (d.action !== 'hold' && d.action !== 'skip' && typeof deps.valutaMercato === 'function') {
        let veto = null;
        try {
          // ── GLI INGRESSI DELLA REGOLA 5, PRIMA DI CHIAMARLA ─────────────────────────────────
          // Il tetto del 20% per mercato ha bisogno di due numeri, e fino al 6 agosto 2026 non ne
          // riceveva nessuno: falliva chiuso a ogni giro con «saldo non leggibile». Erano scollegati
          // esattamente come lo era `bookLevels` — la regola scritta, gli ingressi no.
          const saldo = typeof deps.saldo === 'function'
            ? deps.saldo()
            : { usd: Number.isFinite(deps.saldoUsd) ? deps.saldoUsd : null, affidabile: Number.isFinite(deps.saldoUsd), motivo: null };
          const espo = esposizioneDelMercato({
            owned,
            // L'ordine in valutazione ESCE dal conto: `proposedSize x proposedPrice` e' il suo
            // rimpiazzo, e sommarli entrambi lo conterebbe due volte. Su un mercato gia' al tetto
            // ogni riprezzo si bloccherebbe da solo per sempre. E' l'opposto del caso del rimpiazzo
            // di gamba in agent40, dove l'uscita appena piazzata NON e' ancora nella lista e quindi
            // va aggiunta a mano: li' il rischio e' contare zero volte, qui e' contarne due.
            escludiOrderId: order.orderId,
            posizioni: typeof deps.posizioniMercatoUsd === 'function'
              ? deps.posizioniMercatoUsd(marketId)
              : (Number.isFinite(deps.esposizioneMercatoUsd)
                ? { leggibile: true, usd: 0, motivo: 'esposizione imposta dal chiamante' }
                : { leggibile: false, usd: null, motivo: 'nessun lettore delle posizioni cablato' }),
            // Un chiamante che passa un numero secco sa gia' tutto: lo si usa cosi' com'e'.
            imposta: Number.isFinite(deps.esposizioneMercatoUsd) ? deps.esposizioneMercatoUsd : null,
          });
          const lm = typeof deps.liquiditaMedia === 'function' ? deps.liquiditaMedia(marketId) : { media: null, campioni: 0 };
          const la = typeof deps.liquiditaAltrui === 'function' ? deps.liquiditaAltrui(marketId) : { mediaUsd: null, campioni: null };
          // La scala arriva da `resolveDepth` — la STESSA chiamata di riga ~358, gia' usata da
          // `prezzoInCoda` nelle stesse iterazioni. Non c'e' una seconda fonte da tenere allineata.
          const sc = scalaPerIlMotore({
            rules, book: order.book, side: order.side, scoringMid: d.scoringMid,
            ownOrders: nostriSulLato,
            // IN-PROCESS E AUTOREVOLE: questo ciclo ha appena letto gli ordini del venue, quindi la corsia di
            // piazzamento non deve rileggerli — sarebbe una chiamata sprecata a ogni riprezzo. Il pannello NON
            // puo' dichiararlo: il campo non e' nello schema zod della sua rotta, e zod scarta cio' che non
            // conosce. Il confine di fiducia e' quello schema, non una promessa.
            ownOrdersAuthoritative: true,
            depth: typeof deps.resolveDepth === 'function' ? deps.resolveDepth(rules.marketId) : null,
          });
          // ESPOSIZIONE NON MISURABILE ⇒ NON SI PIAZZA, e non si chiama nemmeno il motore: passargli 0
          // (il vecchio comportamento) allargava il tetto in silenzio, ed e' la stessa direzione
          // sbagliata del `bookLevels: null`. Un'esposizione che non si sa misurare non e' un'esposizione
          // piccola. Il veto lo si dichiara qui perche' e' il cablaggio a non avere il dato, non la regola.
          const v = !espo.leggibile ? { ok: false, controlli: {}, motivo: `tetto-mercato: ${espo.motivo}` } : deps.valutaMercato({
            // `side: 'BUY'` e non `order.side`: dopo lo specchio di `scalaPerIlMotore` i prezzi sono
            // bid, e questo e' il verso in cui `othersLadder` e `trovaLivello` devono ordinarli.
            marketId, side: 'BUY',
            bookLevels: sc.bookLevels, bandBounds: sc.bandBounds,
            bandRadiusCents: d.bandRadiusC, tick: rules.tick, scoringMid: sc.scoringMid,
            ownOrders: sc.ownOrders,
            proposedSize: order.size, proposedPrice: d.targetPrice != null ? d.targetPrice : order.price,
            saldoUsd: saldo.affidabile ? saldo.usd : null,
            esposizioneMercatoUsd: espo.usd,
            // ── LA PROVA DI CHIUSURA, SE IL CHIAMANTE PUO' FARLA ────────────────────────────────
            // Il tetto per MERCATO esiste per limitare l'APERTURA di posizioni nuove. Applicarlo a una
            // gamba che sta CHIUDENDO significa tenere aperta un'esposizione per rispettare un limite
            // pensato contro le esposizioni — misurato il 13 agosto 2026: 6.226 righe `tetto-mercato`
            // in 24 ore su sei mercati, TUTTI con posizione aperta.
            // La prova la fa chi ha lo snapshot delle posizioni, con le stesse funzioni del tetto per
            // ordine (§5 p.76): SELL entro il posseduto, BUY entro `manca`. Non iniettata ⇒ `null` ⇒
            // tetto ordinario, cioe' il comportamento di prima.
            chiusura: typeof deps.provaChiusura === 'function'
              ? (() => { try { return deps.provaChiusura(order); } catch { return null; } })()
              : null,
            // ── LA PROVA DI RINNOVO (16 agosto 2026) ────────────────────────────────────────────
            // Stessa forma della prova di chiusura, e per la stessa ragione: il pavimento di
            // profondita' limita l'APERTURA, e questo ordine sta sostituendo `order`, che e' gia' a
            // libro. La prova la fa `esenzione-rinnovo` contro gli ordini VIVI di questo mercato —
            // `owned` — non contro una dichiarazione. Qualunque incertezza vale «apertura».
            rinnovo: (() => {
              try {
                return RINNOVO.provaRinnovo({
                  conditionId: marketId, tokenId: order.tokenId, side: order.side,
                  size: order.size, price: order.price, ordiniVivi: owned,
                });
              } catch { return null; }
            })(),
            // La media SPORCA resta, ma solo come termine di paragone nell'audit (`pavimento.lordoUsd`):
            // include i nostri ordini, quindi non puo' fare da denominatore a un numeratore che li toglie.
            liquiditaMediaShare: lm.media, liquiditaCampioni: lm.campioni,
            liquiditaMediaUsd: la.mediaUsd, liquiditaCampioniAltrui: la.campioni,
            now: t0,
          });
          // ── I NUMERI DELLA DECISIONE, VERSO L'AUDIT ────────────────────────────────────────
          // Senza questi la taratura del pavimento si fa ricostruendo il book a posteriori, che e'
          // esattamente cio' che ha reso illeggibile l'episodio del 6 agosto: il verdetto c'era, i
          // due numeri che lo spiegano no.
          const c = (v && v.controlli) || {};
          d.pavimentoUsd = c.pavimento && Number.isFinite(c.pavimento.usd) ? c.pavimento.usd : null;
          d.pavimentoFonte = c.pavimento && c.pavimento.fonte ? c.pavimento.fonte : null;
          // Il pavimento che la media SPORCA avrebbe imposto sullo stesso book. E' il prima/dopo del
          // denominatore, misurato dal vivo invece che ricostruito a posteriori.
          d.pavimentoLordoUsd = c.pavimento && Number.isFinite(c.pavimento.lordoUsd) ? c.pavimento.lordoUsd : null;
          d.depthAheadUsd = c.livello && Number.isFinite(c.livello.depthAheadUsd) ? c.livello.depthAheadUsd : null;
          d.livelloScelto = c.livello && Number.isFinite(c.livello.level) ? c.livello.level : null;
          // Gli ingressi della Regola 5, accanto al suo verdetto: senza questi «saldo non leggibile»
          // non dice se manca il saldo o se manca il cablaggio, che e' la domanda costata sei ore.
          d.saldoUsd = saldo.affidabile && Number.isFinite(saldo.usd) ? saldo.usd : null;
          d.saldoFonte = saldo.fonte || (saldo.affidabile ? 'imposto' : 'assente');
          d.saldoEtaMs = Number.isFinite(saldo.etaMs) ? saldo.etaMs : null;
          d.esposizioneMercatoUsd = espo.leggibile ? espo.usd : null;
          d.esposizioneOrdiniUsd = espo.leggibile ? espo.ordiniUsd : null;
          d.esposizionePosizioniUsd = espo.leggibile ? espo.posizioniUsd : null;
          if (!v || v.ok !== true) veto = { motivo: (v && v.motivo) || 'motore: controlli non superati' };
        } catch (e) {
          // UN ERRORE QUI NON APRE: si salta. Una regola che non ha potuto girare non è una regola
          // superata — la stessa scelta che governa il kill-switch illeggibile in bulk-allocate.
          veto = { motivo: `valutazione del motore fallita: ${e.message}` };
        }
        if (veto) {
          d.action = 'skip';
          d.gate = 'motore-non-conforme';
          d.reason = veto.motivo;
        }
      }

      // ── LA POSIZIONE CHE GIUSTIFICAVA QUEST'ORDINE ESISTE ANCORA? ──────────────────────────────
      // Si chiede SOLO quando il rinnovo sta per partire (`d.action === 'reprice'` con gate
      // `expiry-refresh`), e non a ogni giro: e' l'istante in cui il sistema tocca comunque questa
      // gamba per darle altri 23 minuti di vita, quindi e' l'istante giusto per chiedersi se quella
      // vita ha ancora una ragione. Un riprezzo che INSEGUE il mid non passa di qui — li' la gamba si
      // sta muovendo per conto suo e la domanda non si pone.
      //
      // PERCHE' LA LETTURA DELLE POSIZIONI STA QUI E NON IN CIMA AL CICLO. Questo ciclo, a differenza
      // di `auto-close`, NON legge le posizioni: metterla in cima significherebbe una chiamata al venue
      // ogni pochi secondi per ogni mercato gestito. Qui invece scatta al piu' una volta per finestra
      // GTD per mercato (~3 volte l'ora), ed e' pigra e memoizzata per mercato dentro il giro.
      //
      // FAIL-CLOSED: senza il lettore iniettato, o con una lettura che non riesce, il verdetto e'
      // `ignoto` e il rinnovo procede ESATTAMENTE come prima. Cancellare e' l'azione irreversibile, e
      // non si prende mai su un'assenza di informazione.
      if (d.action === 'reprice' && d.gate === 'expiry-refresh' && typeof deps.readPositions === 'function') {
        try {
          if (posizioniDelMercato === undefined) {
            const pr = await deps.readPositions({ marketId });
            posizioniDelMercato = pr && pr.ok !== false && Array.isArray(pr.positions) ? pr.positions : null;
          }
          const reg = deps.registroOrfani || null;
          const armatoDa = reg && typeof reg.leggi === 'function' ? reg.leggi(String(marketId)) : null;
          const vo = verdettoOrfano({
            ordiniARiposo: owned, posizioni: posizioniDelMercato,
            tokenId: rules.tokenId, tokenIdNo: rules.tokenIdNo,
            armatoDa, now: t0,
          });
          d.orfanoVerdetto = vo.verdetto;
          d.orfanoGambe = vo.gambe;
          d.orfanoPosizioni = vo.posizioni;
          if (reg) {
            // L'armamento vive fuori: la funzione pura non ha memoria, e il ciclo non deve inventarne
            // una seconda. Un verdetto diverso da «da confermare» o «orfano» DISARMA — cosi' una
            // posizione ricomparsa (il fill era vero) cancella l'allarme invece di lasciarlo maturare.
            if (vo.verdetto === ORFANO_CONFERMATO || vo.verdetto === 'da-confermare') {
              if (typeof reg.scrivi === 'function' && Number.isFinite(vo.armatoDa)) reg.scrivi(String(marketId), vo.armatoDa);
            } else if (typeof reg.pulisci === 'function') reg.pulisci(String(marketId));
          }
          if (vo.verdetto === ORFANO_CONFERMATO) {
            d.action = 'cancel';
            d.gate = 'posizione-sparita';
            d.orfano = true;
            d.reason = `rinnovo NON dovuto: ${vo.motivo}. Si cancella invece di rinnovare, e il mercato torna da ripianificare.`;
          }
        } catch (e) {
          // Una verifica che non ha potuto girare non e' una verifica superata, ma qui «non superata»
          // vuol dire NON CANCELLARE: si rinnova come prima e il fatto resta a verbale.
          d.orfanoVerdetto = 'ignoto';
          d.orfanoErrore = e && e.message ? e.message : String(e);
        }
      }

      // Seed "stay where you were placed": the FIRST distance seen for a (market, book) becomes the
      // target, so the default needs no configuration and survives both a re-price and a restart.
      if (d.offsetSource === 'observed' && Number.isFinite(d.currentOffsetCents)) {
        try { (deps.rememberObserved || rememberObserved)({ marketId, book: order.book, offsetCents: d.currentOffsetCents }, deps.offsetDeps || {}); }
        catch { /* best-effort: a failed memory only means the next cycle re-observes the same distance */ }
      }

      // Carry the breach counter between cycles: a breach that clears resets it, so "consecutive" really
      // means consecutive rather than cumulative.
      if (d.action === 'hold') breaches.delete(order.orderId);
      else breaches.set(order.orderId, prevBreaches + 1);

      // ── PERCHÉ IL RINNOVO NON È AVVENUTO, REGISTRATO MENTRE SI PUÒ ANCORA SAPERLO ───────────
      // La condizione che conta è `d.expiring`: il rinnovo era DOVUTO (la scadenza è dentro il margine)
      // e non è partito. Quel motivo è l'unica cosa che, dopo la morte dell'ordine, nessuno può più
      // ricostruire — l'ordine non c'è, e il registro contiene mille skip su cui bisognerebbe indovinare
      // quale fosse l'ultimo. Su Barlow sarebbe stato `hourly-cap`, e sarebbe bastato.
      if (d.expiring === true && d.action !== 'reprice') {
        const vis = ordiniVisti.get(order.orderId);
        if (vis) {
          vis.bloccoRinnovo = { gate: d.gate || null, reason: d.reason || null, action: d.action, at: t0 };
          ordiniVisti.set(order.orderId, vis);
        }
      }

      // ── IL CONFLITTO ENTRA E ESCE DAL REGISTRO, CON I QUATTRO NUMERI ─────────────────────────
      // Serve a due cose diverse: verificare che il meccanismo lavori (senza doverlo dedurre da un
      // hold silenzioso, che è il buco di osservabilità da cui viene tutto questo lavoro) e vedere
      // quando si scioglie. Un conflitto che non si sciogliesse mai sarebbe un ordine congelato, e
      // deve poter essere notato.
      if (d.gate === 'inseguimento-contro-mai-primo') {
        if (!conflittiSoppressi.has(order.orderId)) {
          conflittiSoppressi.add(order.orderId);
          audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
            outcome: 'inseguimento-soppresso', gate: d.gate,
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId,
            reason: d.reason,
            observed: {
              book: order.book, price: order.price, scoringMid: d.scoringMid,
              distanzaAttualeC: d.distanceC,
              inseguimentoPrezzo: d.inseguimentoPrezzo, inseguimentoDistanzaC: d.inseguimentoDistanzaC,
              maiPrimoPrezzo: d.maiPrimoPrezzo, maiPrimoDistanzaC: d.maiPrimoDistanzaC,
              bestOther: d.bestOther, maiPrimoMode: d.maiPrimoMode,
              targetOffsetCents: d.targetOffsetCents, tick: rules.tick,
              motivo: 'il prezzo imposto da «mai primi» è più VICINO al mid di quello che l\'inseguimento chiede: '
                + 'spostarsi sarebbe allontanarsi da una posizione migliore, e il ciclo dopo l\'inseguimento richiederebbe la stessa mossa',
            } });
        }
      } else if (conflittiSoppressi.has(order.orderId)) {
        conflittiSoppressi.delete(order.orderId);
        audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
          outcome: 'inseguimento-ripreso', gate: d.gate || null,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId,
          reason: 'il conflitto fra inseguimento e «mai primi» non c\'è più: qualcosa nel book è cambiato'
            + ` e questa gamba torna alla decisione normale (${d.action}${d.gate ? `/${d.gate}` : ''})`,
          observed: { book: order.book, price: order.price, scoringMid: d.scoringMid, distanceC: d.distanceC } });
      }

      if (d.action === 'hold') {
        m.held++;
        // ── LA FOTOGRAFIA DI CIO' CHE LA DECISIONE HA VISTO ───────────────────────────────────
        // Prima l'hold non lasciava traccia: la riga «holding 2/2 in band» non portava un solo
        // numero, e a posteriori non si poteva dire quale fosse il mid ne' quanto margine
        // restasse rispetto al bordo premiante. I valori vengono da `d`, cioe' esattamente
        // quelli su cui la decisione e' stata presa — non ricalcolati qui, altrimenti
        // fotograferebbero un istante diverso da quello che ha deciso.
        m.holds.push({
          orderId: order.orderId, book: order.book, price: order.price,
          scoringMid: d.scoringMid, distanceC: d.distanceC, bandRadiusC: d.bandRadiusC,
          marginC: (Number.isFinite(d.distanceC) && Number.isFinite(d.bandRadiusC))
            ? +(d.bandRadiusC - d.distanceC).toFixed(4) : null,
          midAgeSec: Number.isFinite(rules.midAgeSec) ? rules.midAgeSec : null,
          gate: d.gate,
          // I numeri della soppressione viaggiano su OGNI ciclo, non solo sulla transizione: il registro
          // durevole tiene una riga per episodio, ma chi guarda il processo girare deve poter leggere
          // adesso perché quella gamba non si muove.
          inseguimentoSoppresso: d.soppresso === true,
          inseguimentoPrezzo: d.inseguimentoPrezzo != null ? d.inseguimentoPrezzo : null,
          inseguimentoDistanzaC: d.inseguimentoDistanzaC != null ? d.inseguimentoDistanzaC : null,
          maiPrimoPrezzo: d.maiPrimoPrezzo != null ? d.maiPrimoPrezzo : null,
          maiPrimoDistanzaC: d.maiPrimoDistanzaC != null ? d.maiPrimoDistanzaC : null,
          bestOther: d.bestOther != null ? d.bestOther : null,
        });
        continue;
      }

      // ── CANCELLA SENZA RIMPIAZZO ─────────────────────────────────────────────────────────────
      // L'unica azione di questo motore che TOGLIE liquidità senza rimetterla. Esiste per un caso
      // solo: l'ordine è diventato il migliore del suo lato e spostarsi dietro uscirebbe dalla
      // banda. Va per la stessa strada del recupero dopo blackout — l'adapter di sola cancellazione,
      // che non può firmare un piazzamento — quindi non può trasformarsi in un piazzamento nemmeno
      // per errore. Se la mano che cancella non è iniettata NON si fa niente: una decisione che non
      // può essere eseguita non deve diventare un silenzio.
      if (d.action === 'cancel') {
        if (typeof deps.cancelOrder !== 'function') {
          m.skipped++;
          audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'skip-cancel-non-collegato',
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId, gate: d.gate,
            reason: `${d.reason} — ma nessuna funzione di cancellazione è collegata a questo ciclo: l'ordine resta dov'è` });
          actions.push({ marketId, orderId: order.orderId, action: 'skip', gate: 'cancel-non-collegato', reason: d.reason, price: order.price });
          continue;
        }
        audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'trigger', trigger: 'top-of-book-cancel',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId, reason: d.reason,
          observed: { price: order.price, scoringMid: d.scoringMid, distanceC: d.distanceC, bandRadiusC: d.bandRadiusC, bestOther: d.bestOther },
          requested: { book: order.book, fromPrice: order.price, toPrice: null, size: order.size } });
        let rc;
        try { rc = await deps.cancelOrder({ orderId: order.orderId, marketId }); }
        catch (e) { rc = { ok: false, reason: e && e.message ? e.message : String(e) }; }
        const okc = !!(rc && rc.ok !== false);
        audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
          outcome: okc ? 'cancelled-top-of-book' : 'reject-cancel-failed', trigger: 'top-of-book-cancel',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId,
          reason: okc ? d.reason : `cancellazione non riuscita (${(rc && rc.reason) || 'motivo ignoto'}) — l'ordine resta sul libro`,
          requested: { book: order.book, fromPrice: order.price, toPrice: null, size: order.size } });
        if (okc) {
          m.repriced = (m.repriced || 0); dimenticaOrdineTolto(order.orderId); tolti.add(order.orderId);   // tolto di proposito
          // ── E ADESSO SI VEDE ────────────────────────────────────────────────────────────────
          // Fino al 6 agosto 2026 questa cancellazione esisteva solo nell'audit: il 6 agosto la gamba
          // YES di Catalina Lauf è sparita così e l'operatore se n'è accorto guardando l'app del venue,
          // tre ore dopo. Il referto va dove la dashboard lo legge, col MOTIVO distinto — «ordine
          // cancellato» senza causa non è un avviso, è una notifica.
          cancellazioni.push({
            orderId: order.orderId, marketId, marketTitle: rules.title || null,
            book: order.book, price: order.price, size: order.size,
            notionalUsd: Number.isFinite(order.price) && Number.isFinite(order.size)
              ? +(order.price * order.size).toFixed(2) : null,
            // Il motivo distingue le due cancellazioni senza rimpiazzo, che hanno cause opposte:
            // «mai primo» toglie una gamba VIVA che non puo' stare dov'e'; l'orfano toglie una gamba
            // che non ha piu' niente con cui accoppiarsi. `gamba-orfana-scaduta` era gia' dichiarato
            // in `cancellazioni-visibili.MOTIVI` e non aveva nessun produttore: questo e' il produttore.
            motivo: d.orfano === true ? 'gamba-orfana-scaduta' : 'mai-primo-sul-libro', dettaglio: d.reason,
            at: new Date(t0).toISOString(),
          });
          // ── E IL MERCATO TORNA DA PIANIFICARE ──────────────────────────────────────────────
          // Non si ripiazza da qui: questo ciclo non ha mai aperto esposizione nuova, e dargliela
          // adesso sarebbe un allargamento che questa modifica non chiede. Si dichiara il mercato
          // «da ripianificare» e lo raccoglie chi il riposizionamento lo sa gia' fare — il loop del
          // Lavoro B in `auto-close`, con `capitalePerRiposizionamento` e il tetto in vigore.
          if (d.orfano === true) {
            daRipianificare.push({ marketId, motivo: 'orfano-alla-scadenza', orderId: order.orderId,
              at: new Date(t0).toISOString() });
            if (deps.registroOrfani && typeof deps.registroOrfani.pulisci === 'function') {
              // L'allarme ha fatto il suo lavoro: si azzera, cosi' il mercato riparte pulito.
              deps.registroOrfani.pulisci(String(marketId));
            }
          }
        }
        else m.failed = (m.failed || 0) + 1;
        actions.push({ marketId, orderId: order.orderId, action: okc ? 'cancel' : 'cancel-failed', gate: d.gate, reason: d.reason, price: order.price, targetPrice: null });
        continue;
      }

      if (d.action === 'skip') {
        m.skipped++;
        // «mid-stale», «mid-not-live» e «mid-age-unknown» dicono tutti la stessa cosa — non so che
        // prezzo c'è — e vanno contati insieme: distinguerli qui vorrebbe dire tre orologi per un
        // solo tipo di cecità.
        if (eCieco(d.gate)) {
          ordiniCiechi += 1;
          const cz = causaCecita(d.gate);
          if (cz) causeCieche.set(cz, (causeCieche.get(cz) || 0) + 1);
        }
        actions.push({ marketId, orderId: order.orderId, action: 'skip', gate: d.gate, reason: d.reason, price: order.price, targetPrice: d.targetPrice, distanceC: d.distanceC, bandRadiusC: d.bandRadiusC });
        // ── L'AVVISO: UNA VOLTA PER ORDINE, NON UNA PER CICLO ────────────────────────────────────
        // La posizione già eseguita NON viene toccata da qui: segue la sua uscita a carico+1% come
        // prima. Quello che si rompe è solo il silenzio sul residuo — l'ordine resta a scadere,
        // esattamente come deciso, ma smette di morire senza che nessuno lo sappia.
        if (d.gate === 'refresh-invalid' && d.belowMinSize === true && !residuiSegnalati.has(order.orderId)) {
          residuiSegnalati.add(order.orderId);
          const scadeFraMs = Number.isFinite(d.secondsToExpiry) ? d.secondsToExpiry * 1000 : null;
          events.push({
            type: 'residuo-sotto-soglia',
            at: new Date(t0).toISOString(),
            marketId,
            marketTitle: rules.title || null,
            orderId: order.orderId,
            book: d.book || order.book,
            side: d.side || order.side || 'BUY',
            price: d.price != null ? d.price : order.price,
            sizeRemaining: d.sizeRemaining != null ? d.sizeRemaining : order.size,
            minSize: d.minSize != null ? d.minSize : rules.minSize,
            notionalUsd: d.notionalUsd,
            secondsToExpiry: Number.isFinite(d.secondsToExpiry) ? d.secondsToExpiry : null,
            // La scadenza come ISTANTE, non come conto alla rovescia: chi legge il pannello due minuti
            // dopo deve poter dire «è già morto» invece di leggere «fra 40s» congelato nel file.
            expiresAt: scadeFraMs == null ? null : new Date(t0 + scadeFraMs).toISOString(),
          });
          audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'residuo-sotto-soglia',
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId, gate: d.gate, reason: d.reason,
            observed: { sizeRemaining: d.sizeRemaining, minSize: d.minSize, notionalUsd: d.notionalUsd, secondsToExpiry: d.secondsToExpiry, book: d.book, side: d.side } });
        }
        // Only the interesting skips reach the durable trail; 'awaiting-confirmation' fires every few
        // seconds by design and would drown the log without telling anyone anything new.
        if (d.gate !== 'awaiting-confirmation') {
          audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: `skip-${d.gate}`, marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId, gate: d.gate, reason: d.reason, observed: { price: order.price, scoringMid: d.scoringMid, distanceC: d.distanceC, bandRadiusC: d.bandRadiusC,
            // Il regime del feed viaggia con OGNI skip, non solo con mid-stale: e' cosi' che a
            // posteriori si verifica se il guard ha scelto il limite giusto invece di doverlo dedurre.
            feedRegime: d.feedRegime || null, maxMidAgeSecApplicato: d.maxMidAgeSecApplicato || null,
            // ── I DUE NUMERI DEL MOTORE ─────────────────────────────────────────────────────
            // `pavimentoUsd` e' la soglia che quel mercato chiedeva in quel momento; `depthAheadUsd`
            // quanta profondita' ALTRUI c'era davvero davanti al livello raggiunto. Null quando il
            // veto e' caduto prima di calcolarli (Regola 1 esce subito) o quando il motore non ha
            // girato affatto: null significa «non misurato», e non va letto come zero.
            pavimentoUsd: d.pavimentoUsd != null ? d.pavimentoUsd : null,
            pavimentoFonte: d.pavimentoFonte || null,
            // Il pavimento che la vecchia media — quella che sommava anche i NOSTRI ordini — avrebbe
            // imposto sullo stesso identico book. Il prima e il dopo del denominatore, sulla stessa riga.
            pavimentoLordoUsd: d.pavimentoLordoUsd != null ? d.pavimentoLordoUsd : null,
            depthAheadUsd: d.depthAheadUsd != null ? d.depthAheadUsd : null,
            livelloScelto: d.livelloScelto != null ? d.livelloScelto : null,
            // ── GLI INGRESSI DELLA REGOLA 5 ─────────────────────────────────────────────────
            saldoUsd: d.saldoUsd != null ? d.saldoUsd : null,
            saldoFonte: d.saldoFonte || null,
            saldoEtaMs: d.saldoEtaMs != null ? d.saldoEtaMs : null,
            esposizioneMercatoUsd: d.esposizioneMercatoUsd != null ? d.esposizioneMercatoUsd : null,
            esposizioneOrdiniUsd: d.esposizioneOrdiniUsd != null ? d.esposizioneOrdiniUsd : null,
            esposizionePosizioniUsd: d.esposizionePosizioniUsd != null ? d.esposizionePosizioniUsd : null } });
        }
        // ── UN RINNOVO FERMATO È UN'ANOMALIA, NON UNA RIGA DI ROUTINE (12 agosto 2026) ─────────────
        // Quando `expiring` è vero il rinnovo era DOVUTO: l'ordine ha meno di `refreshMarginSeconds`
        // di vita e, se il rimpiazzo non parte, muore. Fino a oggi quel caso finiva nella stessa riga
        // `skip-<gate>` di qualunque altra decisione di non toccare un ordine — indistinguibile, in un
        // giornale che ne scrive centinaia all'ora, da «tutto a posto, non c'era niente da fare».
        //
        // La differenza è che qui c'è un conto alla rovescia. `scaduto-senza-rinnovo` esiste già ma
        // arriva DOPO la morte; questa riga arriva mentre restano ancora `secondsToExpiry` secondi per
        // accorgersene. Le due non si sostituiscono: una è la diagnosi, l'altra è il certificato.
        //
        // ⚠ IL `gate` È LA COSA DA GUARDARE, e sui dati veri NON è il rate limit: il campo `reason` di
        // `scaduto-senza-rinnovo` dice «il rinnovo era dovuto ed è stato fermato da motore-non-conforme»
        // — `mai-primo-sul-libro`, `profondita-insufficiente`. Il rimpiazzo non sarebbe stato un ordine
        // valido, e il motore ha ragione a non piazzarlo. Il capitale che torna fermo è il PREZZO di
        // quella correttezza, non un difetto: si recupera aprendo altrove, non forzando qui.
        if (d.expiring === true && d.gate !== 'awaiting-confirmation' && !rinnoviSegnalati.has(order.orderId)) {
          rinnoviSegnalati.add(order.orderId);
          const anomalia = {
            type: 'rinnovo-fermato',
            at: new Date(t0).toISOString(),
            marketId,
            marketTitle: rules.title || null,
            orderId: order.orderId,
            book: order.book,
            price: order.price,
            size: order.size,
            notionalUsd: Number.isFinite(order.price) && Number.isFinite(order.size)
              ? +(order.price * order.size).toFixed(2) : null,
            secondsToExpiry: Number.isFinite(d.secondsToExpiry) ? d.secondsToExpiry : null,
            gate: d.gate,
            reason: d.reason,
            // `rate-limited` qui è l'intervallo anti-churn LOCALE (30s), non la finestra del venue, e
            // per costruzione non può costare l'ordine: il margine di rinnovo è molte volte più lungo.
            // Distinguerlo evita di leggere come starvation ciò che è solo un'attesa breve e sicura.
            costaLOrdine: d.gate !== 'rate-limited',
          };
          // ⚠ NON entra in `events`, e la ragione è concreta: `events` è una lista che i consumatori
          // CONTANO — `residuo-sotto-soglia.test.js` asserisce «24 cicli ⇒ UN avviso» contandone gli
          // elementi. Un tipo nuovo lì dentro rompe quel conteggio senza che nulla sia rotto davvero.
          // Va in una lista sua, che chi la vuole legge per nome.
          rinnoviFermati.push(anomalia);
          audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
            outcome: 'anomalia-rinnovo-fermato',
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId,
            gate: d.gate, corsia: 'rinnovo', anomalia: anomalia.costaLOrdine,
            reason: `RINNOVO DOVUTO E FERMATO (${d.secondsToExpiry}s alla scadenza): ${d.reason}`,
            observed: { secondsToExpiry: d.secondsToExpiry, notionalUsd: anomalia.notionalUsd, costaLOrdine: anomalia.costaLOrdine } });
        }
        continue;
      }

      // ── ACT. Through the SAME server-side sequence the panel's own button uses, with every gate. ──
      // WHICH TRIGGER fired is recorded on every line, because "the mid moved" and "the clock was running
      // out" are different events that happen to share a mechanism, and an audit trail that blurred them
      // would make the renewal rate impossible to reason about after the fact.
      const trigger = d.gate === 'expiry-refresh' ? 'expiry-refresh'
        : d.gate === 'band-exit-and-expiry' ? 'band-exit-and-expiry' : 'band-exit';
      // ── UN RINNOVO CHE PASSA IN ESENZIONE DAL TETTO LO DICE, PRIMA DI FARLO ──────────────────
      // Riga PROPRIA e non un campo in più su quella del trigger: l'esenzione è la cosa che si va a
      // cercare quando si vuole verificare che il meccanismo abbia lavorato, e cercarla dentro il
      // corpo di un'altra riga è il motivo per cui i 21 riprezzi di Barlow sono stati registrati come
      // `band-exit` senza che nessuno vedesse il ciclo. Un `grep rinnovo-esente-dal-tetto` deve
      // bastare.
      if (d.capExemptRenewal === true) {
        audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
          outcome: 'rinnovo-esente-dal-tetto', trigger, gate: 'hourly-cap-exempt',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId,
          reason: `rinnovo di scadenza ammesso a tetto orario raggiunto (${d.repricesThisHour}/${d.maxPerHour} nell'ultima ora): `
            + `restano ${d.secondsToExpiry}s di vita al venue contro un margine di ${d.refreshMarginSeconds}s. `
            + 'Fermarlo non eviterebbe una mossa, garantirebbe una scadenza. Tutti gli altri gate restano applicati.',
          observed: { repricesThisHour: d.repricesThisHour, maxPerHour: d.maxPerHour,
            secondsToExpiry: d.secondsToExpiry, refreshMarginSeconds: d.refreshMarginSeconds,
            price: order.price, targetPrice: d.targetPrice, book: order.book,
            inseguimentoFermatoDa: d.railInseguimento || null } });
      }
      audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'trigger', trigger,
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId, reason: d.reason,
        observed: { price: order.price, scoringMid: d.scoringMid, distanceC: d.distanceC, bandRadiusC: d.bandRadiusC, secondsToExpiry: d.secondsToExpiry, strategy: config.strategy },
        requested: { book: order.book, fromPrice: order.price, toPrice: d.targetPrice, size: order.size } });

      let res;
      try {
        res = await deps.replaceOrder({
          orderId: order.orderId, marketId, book: order.book,
          side: order.side,   // load-bearing: without it a re-priced CLOSE would be re-placed as a BUY
          price: d.targetPrice, size: order.size,
          // MAI PRIMI SUL LIBRO, anche quando si insegue il mid. Il target qui e' una distanza dal mid;
          // `inCoda` lo aggancia poi alla coda del book al momento del piazzamento. `ownOrders` sottrae i
          // NOSTRI ordini a riposo dalla scala: senza, inseguiremmo noi stessi di un tick a ogni ciclo
          // fino al bordo banda. Il rinnovo proattivo NON lo dichiara — quello ri-piazza allo STESSO
          // prezzo per azzerare l'orologio del venue, e spostarlo tradirebbe il suo scopo.
          inCoda: trigger !== 'expiry-refresh',
          // LO STESSO INSIEME DELLA DECISIONE, questo ordine compreso (vedi `nostriSulLato` sopra):
          // un ordine appena cancellato è ancora nella fotografia del book su cui si fa il conto, e
          // trattarlo da concorrente vuol dire mettersi un tick dietro a se stessi.
          ownOrders: nostriSulLato,
          // IN-PROCESS E AUTOREVOLE: questo ciclo ha appena letto gli ordini del venue, quindi la corsia di
          // piazzamento non deve rileggerli — sarebbe una chiamata sprecata a ogni riprezzo. Il pannello NON
          // puo' dichiararlo: il campo non e' nello schema zod della sua rotta, e zod scarta cio' che non
          // conosce. Il confine di fiducia e' quello schema, non una promessa.
          ownOrdersAuthoritative: true,
          // ttlSeconds is DELIBERATELY NOT passed. Omitting it lets resolveManualTtlSeconds decide from
          // the market's live auto-reprice switch — which is the single source for that choice. Pinning a
          // number here would mean an order placed with a full resting window a moment after the operator
          // switched the automatism OFF, i.e. a long-lived order nothing is watching.
          source: AUTO_REPRICE_SOURCE,
          note: trigger === 'expiry-refresh'
            ? `auto: rinnovo proattivo, ${d.secondsToExpiry}s alla scadenza`
            : `auto: band exit ${d.distanceC}¢ > ±${d.bandRadiusC}¢${trigger === 'band-exit-and-expiry' ? ` + scadenza fra ${d.secondsToExpiry}s` : ''}`,
        });
      } catch (e) {
        m.skipped++;
        actions.push({ marketId, orderId: order.orderId, action: 'error', reason: e.message });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'error', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId, reason: e.message });
        continue;
      }

      const ok = res && res.ok === true;
      if (ok) m.repriced++; else m.skipped++;
      // ── IL SUCCESSORE HA UN ID DIVERSO, E QUESTO CICLO LO SA ───────────────────────────────────
      // Il vecchio id sparirà dal libro al prossimo giro perché è stato SOSTITUITO, non perché è
      // scaduto. Dimenticarlo qui è l'unico punto in cui la sostituzione e il predecessore sono
      // entrambi in mano: dal ciclo dopo restano solo «un id in meno» e una scadenza vicina, cioè la
      // firma indistinguibile che produceva i due falsi allarmi su TX-15 e su Ed Markey.
      // La condizione è il SUCCESSORE, non l'esito: un replace che cancella e poi non riesce a
      // piazzare lascia il libro vuoto senza successore, e quell'ordine deve restare sorvegliato.
      const successorOrderId = (res && res.place && res.place.orderId) || null;
      if (ok && successorOrderId) dimenticaOrdineTolto(order.orderId);
      actions.push({
        marketId, orderId: order.orderId, action: 'reprice', trigger, ok,
        fromPrice: order.price, toPrice: d.targetPrice, size: order.size, book: order.book,
        secondsToExpiry: d.secondsToExpiry,
        // L'esenzione dal tetto viaggia anche qui, perche' agent40 ne fa una riga di log e il pannello
        // legge le azioni: un fatto che sta solo nell'audit non lo vede chi guarda il processo girare.
        capExemptRenewal: d.capExemptRenewal === true,
        repricesThisHour: Number.isFinite(d.repricesThisHour) ? d.repricesThisHour : null,
        maxPerHour: Number.isFinite(d.maxPerHour) ? d.maxPerHour : null,
        sent: !!(res && res.place && res.place.sent), oldCancelled: !!(res && res.oldCancelled),
        gate: (res && res.gate) || null, reason: (res && res.reason) || null,
        newOrderId: successorOrderId,
        newExpiry: (res && res.expiry) || null,
      });
      audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', trigger,
        outcome: ok ? ((res.place && res.place.sent) ? 'sent' : 'dry-run-validated') : `reject-${(res && res.gate) || 'replace'}`,
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: order.orderId,
        requested: { book: order.book, fromPrice: order.price, toPrice: d.targetPrice, size: order.size },
        response: { ok, oldCancelled: !!(res && res.oldCancelled), replaced: !!(res && res.replaced), newOrderId: successorOrderId },
        gate: (res && res.gate) || null, reason: (res && res.reason) || null, latencyMs: now() - t0 });

      // The breach counter resets on ANY completed attempt: the next cycle re-observes the world rather
      // than acting on a stale count. And the rails are fed whether or not the venue accepted it —
      // a rejected attempt still consumed a cancel, so it must count against the hourly ceiling.
      breaches.delete(order.orderId);
      recordAutoRepriceState({
        marketId,
        reprice: { orderId: order.orderId, fromPrice: order.price, toPrice: d.targetPrice, ok, sent: !!(res && res.place && res.place.sent), gate: (res && res.gate) || null, reason: (res && res.reason) || null, trigger },
        heartbeat: false,
      }, configDeps);
    }

    // ══ MID STANTIO: VENTI SECONDI DI TENTATIVI, POI CI SI RITIRA ══════════════════════════════
    //
    // Prima questo ramo non esisteva: il rifiuto `mid-stale` si ripeteva a ogni ciclo, per sempre, e il
    // capitale restava esposto su un mercato che non vedevamo. «Non muovo l'ordine» era prudente sul
    // singolo gesto e imprudente sul risultato — restare esposti è una decisione anche quando la si
    // prende non decidendo.
    //
    // L'orologio parte al primo ciclo in cui TUTTI gli ordini del mercato sono stati saltati per
    // cecità, e si azzera solo su una lettura buona. Sotto il timeout non cambia niente rispetto a
    // prima. Sopra, si CANCELLA — e cancellare è l'unica azione che questo percorso conosce: riduce
    // esposizione e non ne crea. Il capitale liberato lo rimette al lavoro il trigger di agent41, con
    // i suoi cancelli, sul piano corrente.
    if (owned.length > 0) {
      const registro = deps.registroStantio || registroStantioGlobale;
      const cieco = ordiniCiechi === owned.length;
      const st = decidiStantio({
        stantio: cieco, daMs: cieco ? registro.segna(marketId, t0) : registro.da(marketId), now: t0,
        timeout: timeoutStantioMs(),
      });
      if (!cieco) {
        const durata = registro.azzera(marketId);
        if (durata != null) {
          m.midStantio = { risolto: true, cecitaMs: t0 - durata };
          audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice', outcome: 'mid-stantio-risolto',
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
            reason: `il feed è tornato fresco dopo ${((t0 - durata) / 1000).toFixed(1)}s di cecità: il ciclo riprende normalmente`,
            observed: { cecitaMs: t0 - durata, ordini: owned.length } });
        }
      } else if (st.azione === 'attendi') {
        m.midStantio = { attesa: true, cecitaMs: st.cecitaMs, restaMs: st.restaMs };
      } else if (st.azione === 'cancella') {
        m.gate = 'mid-stantio';
        m.reason = st.motivo;
        m.midStantio = { cancellato: true, cecitaMs: st.cecitaMs };
        // ── LA CAUSA DELLA CECITA', NEL LOG E NON SOLO NELL'AZIONE ────────────────────────────
        // I tre gate ciechi portano alla stessa azione (venti secondi, poi si cancella) ma NON alla
        // stessa diagnosi: «il prezzo e' vecchio» e «non c'e' nessun libro» si risolvono in due modi
        // diversi. Fino a oggi finivano entrambi in `mid-stantio-*` e dal log erano indistinguibili.
        const causaDom = [...causeCieche.entries()].sort((a, b) => b[1] - a[1])[0];
        const causa = causaDom ? causaDom[0] : 'mid-stantio';
        const gateDom = causa === 'nessun-libro' ? 'mid-not-live' : (causa === 'eta-ignota' ? 'mid-age-unknown' : 'mid-stale');
        m.cecita = { causa, per: Object.fromEntries(causeCieche) };
        audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
          outcome: `cecita-timeout-${causa}`,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, gate: 'mid-stantio',
          reason: `${st.motivo} · causa: ${motivoCecita(gateDom)}`,
          observed: { causa, perCausa: Object.fromEntries(causeCieche),
            cecitaMs: st.cecitaMs, timeoutMs: timeoutStantioMs(), ordini: owned.length } });
        for (const o of owned) {
          if (tolti.has(o.orderId)) continue;
          let c = null;
          try { c = typeof deps.cancelOrder === 'function' ? await deps.cancelOrder({ orderId: o.orderId, marketId }) : null; }
          catch (e) { c = { ok: false, reason: e.message }; }
          if (c && c.ok) { dimenticaOrdineTolto(o.orderId); tolti.add(o.orderId); }
          actions.push({ marketId, orderId: o.orderId, action: 'mid-stantio-cancel', ok: !!(c && c.ok),
            cecitaMs: st.cecitaMs, reason: (c && c.reason) || null });
          audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
            // Il nome vecchio resta come PREFISSO, cosi' la serie storica di `mid-stantio-cancellato`
            // non si spezza, e la causa si legge nel suffisso e nel campo `observed.causa`.
            outcome: (c && c.ok) ? `mid-stantio-cancellato-${causa}` : `mid-stantio-cancel-fallito-${causa}`,
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: o.orderId,
            reason: (c && c.reason) || st.motivo, observed: { causa, cecitaMs: st.cecitaMs } });
        }
        // L'orologio si azzera solo DOPO aver cancellato: se la cancellazione fallisce si riprova al
        // giro dopo invece di ripartire da zero e aspettare altri venti secondi.
        if (owned.every((o) => tolti.has(o.orderId))) registro.azzera(marketId);
        markets.push(m);
        continue;
      }
    }

    // ══ REGOLA 4 · UN LATO SOLO — LO DECIDE LA FORMULA, NON UN TIMER ═══════════════════════════
    //
    // Fino al 6 agosto 2026 qui c'era una tolleranza di dieci minuti: una proxy ragionevole di una
    // domanda a cui la formula del venue risponde ESATTAMENTE. `qMin` dice che un lato solo matura
    // 1/3 se il midpoint sta in [0.10, 0.90] e ZERO fuori. Quindi:
    //
    //   dentro il range → si TIENE. Chiuderlo costerebbe un terzo di punteggio per niente, e il ciclo
    //                     continua a ritentare l'altro lato con le stesse regole di sempre.
    //   fuori dal range → si CANCELLA SUBITO. Non c'è nessun timer da aspettare: quel capitale sta
    //                     maturando zero adesso, e aspettare dieci minuti non lo fa maturare di più.
    //
    // Il mid si rilegge a OGNI giro: un mercato che scavalca il confine cambia comportamento nello
    // stesso ciclo, non resta legato alla condizione del giro precedente.
    if (typeof deps.cancelOrder === 'function') {
      try {
        const vivi = owned.filter((o) => !tolti.has(o.orderId));
        const lati = [...new Set(vivi.map((o) => o.book))];
        if (lati.length === 1) {
          const midOra = rules.books && rules.books[lati[0]] ? rules.books[lati[0]].scoringMid : null;
          const v = latoSingolo({ mid: midOra, esisteGia: true });
          m.latoSingolo = { book: lati[0], mid: midOra, frazione: v.frazione, azione: v.azione };

          if (v.azione === 'cancella') {
            for (const o of vivi) {
              let rc;
              try { rc = await deps.cancelOrder({ orderId: o.orderId, marketId }); }
              catch (e) { rc = { ok: false, reason: e && e.message ? e.message : String(e) }; }
              const okc = !!(rc && rc.ok !== false);
              audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
                outcome: okc ? 'cancelled-lato-singolo-zero' : 'reject-cancel-failed',
                trigger: 'lato-singolo-senza-punteggio',
                marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, orderId: o.orderId, reason: v.motivo,
                requested: { book: o.book, fromPrice: o.price, toPrice: null, size: o.size } });
              if (okc) {
                dimenticaOrdineTolto(o.orderId);
                cancellazioni.push({
                  orderId: o.orderId, marketId, marketTitle: rules.title || null,
                  book: o.book, price: o.price, size: o.size,
                  notionalUsd: fin(o.price) && fin(o.size) ? +(o.price * o.size).toFixed(2) : null,
                  motivo: 'lato-singolo-senza-punteggio', dettaglio: v.motivo, at: new Date(t0).toISOString(),
                });
              } else m.failed = (m.failed || 0) + 1;
              actions.push({ marketId, orderId: o.orderId, action: okc ? 'cancel' : 'cancel-failed',
                gate: 'lato-singolo-senza-punteggio', reason: v.motivo, price: o.price, targetPrice: null });
            }
          } else if (v.azione === 'tieni') {
            // Non è un allarme: è uno stato che rende un terzo e va DETTO, perché l'operatore sappia
            // che quel mercato sta lavorando a frazione mentre il ciclo ritenta l'altro lato.
            latiSingoli.push({ marketId, marketTitle: rules.title || null, book: lati[0],
              mid: midOra, frazione: v.frazione, motivo: v.motivo });
          }
        }
      } catch (e) {
        m.latoSingoloError = e && e.message ? e.message : String(e);
      }
    }

    markets.push(m);
    } finally {
      // ⚠ NEL `finally`, E NON ALLA FINE DEL CORPO. Il giro di un mercato esce da una ventina di
      // `continue` diversi, e un rilascio scritto in fondo non verrebbe raggiunto da nessuno di quelli:
      // il lock resterebbe appeso fino alla scadenza e il mercato salterebbe 20 s di riprezzo a ogni
      // gate. `continue` dentro un `try` esegue il `finally`, quindi questa e' l'unica forma che copre
      // tutte le uscite, comprese le eccezioni.
      LOCK.rilascia(marketId);
    }
  }

  // ── L'ELENCO DEI GIÀ SEGNALATI SI PULISCE QUANDO L'ORDINE SPARISCE ──────────────────────────────
  // Un ordine scaduto non torna: il suo id non verrà mai riusato, quindi toglierlo non può far riapparire
  // l'avviso. Si pota SOLO dopo un giro in cui ogni mercato è stato letto davvero — vedi `letturaCompleta`.
  if (letturaCompleta) {
    for (const id of residuiSegnalati) if (!vistiARiposo.has(id)) residuiSegnalati.delete(id);
    // Stessa potatura per i rinnovi segnalati: un ordine che non è più a riposo non ha più un rinnovo
    // in sospeso, e tenerlo nel Set impedirebbe l'avviso al suo successore se ricadesse nello stesso
    // gate. Si pota solo su lettura completa, come sopra: «non l'ho visto» non è «non c'è più».
    for (const id of rinnoviSegnalati) if (!vistiARiposo.has(id)) rinnoviSegnalati.delete(id);
    // Idem per i conflitti: un riprezzo conia un id nuovo, quindi l'id vecchio resterebbe in memoria per
    // sempre. Un id che non torna non può far riapparire la dichiarazione, perché non verrà mai riusato.
    for (const id of conflittiSoppressi) if (!vistiARiposo.has(id)) conflittiSoppressi.delete(id);
  }

  // ── UN ORDINE CHE MUORE PER SCADENZA SMETTE DI SPARIRE IN SILENZIO ───────────────────────────────
  //
  // COSA MANCAVA. Il 5 agosto l'audit di Barlow conteneva 21 riprezzi e 540 skip `hourly-cap`. La morte
  // delle due gambe alle ~21:02:34 non ha prodotto NIENTE: alle 21:03:08 c'era una skip, alle 21:03:09
  // non c'erano più gli ordini, e in mezzo nessun evento. È lo stesso buco di osservabilità del lavoro
  // sull'avviso «residuo sotto soglia», su un caso diverso: la decisione era registrata, il suo ESITO no.
  //
  // COME SI DISTINGUE UNA SCADENZA DA TUTTO IL RESTO. Un ordine può sparire dal libro per cinque ragioni,
  // e quattro non sono questa: un riprezzo (lo cancelliamo noi, con ~1345s di vita davanti), una
  // cancellazione (fine vita del mercato, fine scala, recupero da blackout, «sarei primo»), un fill, o la
  // scadenza. Il discriminante è il CONFRONTO CON L'ISTANTE DI MORTE che il venue stesso pubblica
  // (`expiresAtMs`, già corretto per i 60s di ritiro anticipato): le prime tre avvengono con la scadenza
  // ancora lontana, la quarta esattamente lì. Una GRAZIA di 60s copre lo scarto misurato fra l'istante
  // calcolato (21:02:34) e la sparizione osservata (21:03:09).
  //
  // COSA QUESTO EVENTO NON PUÒ SAPERE, detto invece che nascosto: un fill che arrivasse negli ultimi
  // secondi di vita dell'ordine è indistinguibile da qui. Per questo l'evento porta l'ultima size
  // residua e l'ultimo TTL visti — chi legge ha i numeri per giudicare, invece di una certezza inventata.
  //
  // E SI CONFRONTA SOLO CON CIÒ CHE SI È LETTO. `mercatiLetti`, non `letturaCompleta`: un mercato passato
  // al tracking o tornato ad agent35 non è stato guardato, e annunciare la morte dei suoi ordini vivi
  // sarebbe un falso allarme peggiore del silenzio che questo evento esiste per rompere.
  const GRAZIA_SCADENZA_MS = 60_000;
  for (const [orderId, v] of [...ordiniVisti.entries()]) {
    if (vistiARiposo.has(orderId)) continue;
    if (!v || !mercatiLetti.has(String(v.marketId).trim().toLowerCase())) continue;
    // Non c'è più, e il suo mercato è stato letto: da qui in poi si decide COME è morto e si dimentica
    // l'ordine in ogni caso — un id non viene mai riusato, quindi tenerlo sarebbe solo memoria che cresce.
    ordiniVisti.delete(orderId);
    const morteAttesa = Number.isFinite(v.expiresAtMs) ? v.expiresAtMs : null;
    if (morteAttesa == null) continue;                       // GTC: nessuna scadenza da attribuire
    if (t0 < morteAttesa - GRAZIA_SCADENZA_MS) continue;     // sparito troppo presto: riprezzo, cancellazione o fill
    const blocco = v.bloccoRinnovo || null;
    const notionalUsd = (Number.isFinite(v.price) && Number.isFinite(v.size)) ? +(v.price * v.size).toFixed(4) : null;
    const evento = {
      type: 'scaduto-senza-rinnovo',
      at: new Date(t0).toISOString(),
      marketId: v.marketId, marketTitle: v.marketTitle || null,
      orderId,
      book: v.book, side: v.side || 'BUY',
      price: v.price, size: v.size, sizeMatched: v.sizeMatched, notionalUsd,
      expiresAt: new Date(morteAttesa).toISOString(),
      // Il motivo per cui il rinnovo non è avvenuto, con il suo nome tecnico E a parole. `null` significa
      // «il rinnovo non è mai stato nemmeno valutato», che è un'informazione diversa da «è stato rifiutato».
      bloccoGate: blocco ? blocco.gate : null,
      bloccoReason: blocco ? blocco.reason : null,
      bloccoAt: blocco ? new Date(blocco.at).toISOString() : null,
      ultimaTtlSec: Number.isFinite(v.ultimaTtlSec) ? v.ultimaTtlSec : null,
      ultimaVista: Number.isFinite(v.ultimaVistaMs) ? new Date(v.ultimaVistaMs).toISOString() : null,
    };
    events.push(evento);
    audit({ ts: t0, venue: 'polymarket', source: AUTO_REPRICE_SOURCE, op: 'auto-reprice',
      outcome: 'scaduto-senza-rinnovo', gate: evento.bloccoGate,
      marketRef: `cid_${String(v.marketId).replace(/^0x/, '')}`, orderId,
      reason: `l'ordine è morto per scadenza GTD senza essere stato rinnovato`
        + ` (${v.book ? v.book.toUpperCase() : '?'} ${v.side || 'BUY'} ${v.price} x ${v.size}`
        + `${notionalUsd != null ? `, ${notionalUsd.toFixed(2)} $` : ''}), scadenza prevista ${evento.expiresAt}`
        + (blocco
          ? ` · il rinnovo era dovuto ed è stato fermato da «${blocco.gate}»: ${blocco.reason}`
          : ' · nessun rinnovo è stato valutato prima della scadenza'),
      observed: {
        book: v.book, side: v.side, price: v.price, size: v.size, sizeMatched: v.sizeMatched,
        notionalUsd, expiresAt: evento.expiresAt, ultimaTtlSec: evento.ultimaTtlSec,
        ultimaVista: evento.ultimaVista, bloccoGate: evento.bloccoGate, bloccoAt: evento.bloccoAt,
      } });
  }

  // Heartbeat LAST, and only on a pass that actually ran: it is what the panel reads to answer "is the
  // thing that is supposed to be minding my GTC orders alive?"
  recordAutoRepriceState({ heartbeat: true }, configDeps);

  return { at: new Date(t0).toISOString(), ran: true, gate: null, reason: null, markets, actions, events,
    cancellazioni, daRipianificare, latiSingoli, rinnoviFermati,
    // ── LO SCOPE DEL RINNOVO, DICHIARATO ────────────────────────────────────────────────────────────
    // `mercatiConOrdini` è la memoria che il chiamante deve restituire al giro dopo: senza, la terza
    // componente dell'unione è sempre vuota e lo scope torna a essere la sola lista di piano.
    // `scope` esiste perché «lo scope si è allargato» e «il piano è cresciuto» non siano lo stesso
    // numero: senza la scomposizione, un mercato tenuto vivo dai suoi ordini sarebbe indistinguibile
    // da uno che il piano ha appena aggiunto.
    mercatiConOrdini: [...mercatiConOrdiniQuestoGiro],
    scope: {
      totale: scopeRinnovo.length,
      daPiano: cfgState.enabledMarketIds.length,
      aggiunti: scopeAggiunti,
      perche: Object.fromEntries(daScope),
    },
    latencyMs: now() - t0 };
}

module.exports = { decideReprice, selectOwnedOrders, esposizioneDelMercato, runAutoRepriceCycle, regimeFeed, AUTO_REPRICE_SOURCE };

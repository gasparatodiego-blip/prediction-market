'use strict';
// lib/maker/auto-close.js — AUTOMATIC POSITION CLOSING: when a hand order fills, put the exit on the book
// at a fixed small profit instead of leaving inventory exposed to whatever the market does next.
//
// ─── HOW A POSITION IS CLOSED ON POLYMARKET (verified, not assumed) ─────────────────────────────────
// By SELLING the outcome token you already hold, on the same CLOB. The docs are explicit: "To sell your
// position, you give up an outcome token and receive payment in return", and a SELL order "gives outcome
// tokens in exchange for USDC" (docs.polymarket.com/trading/overview, /concepts/positions-tokens).
//
// It is NOT done by buying the opposite outcome. So the close order is a SELL of the very token the fill
// produced, at the same tokenId, for the size actually held.
//
// PRECISAZIONE SUL SET COMPLETO (7 agosto 2026). Questa riga diceva che comprare l'altro lato
// «raddoppierebbe il capitale bloccato invece di liberarlo». E' vero solo finche' non si FONDE: 1 YES +
// 1 NO valgono $1 per costruzione, e `mergePositions` riconsegna la coppia restituendo subito il
// collaterale — quindi una coppia comprata sotto il dollaro e' profitto matematico, non capitale morto.
// La distinzione conta perche' cambia quale sia la mossa giusta dopo un fill. Vedi
// lib/maker/strategia-merge.js: la meccanica c'e', il merge on-chain oggi non e' eseguibile da questo
// stack, e per questo la strategia gira in OSSERVAZIONE invece che agire.
//
// ─── THE TRIGGER IS THE POSITION, NOT THE FILL EVENT ────────────────────────────────────────────────
// The obvious design is "on the reconciliation's fill event, place a close". This does something subtly
// different and much sturdier: every cycle it asks "is there a position with no close order resting
// against it?" — and if so, places one. Why:
//   • IDEMPOTENT BY CONSTRUCTION. A fill event can be observed twice (a re-read, a restart, a partial
//     followed by another partial); a position with a close already resting is visibly already handled,
//     so a duplicate exit can never be placed.
//   • SELF-HEALING. If the close order expires, is cancelled, or is refused by a gate, the next cycle
//     simply sees an uncovered position again and retries. No event to miss, no state to lose.
//   • PARTIALS FALL OUT FOR FREE. The close is sized to the position ACTUALLY HELD, so two partial fills
//     produce one correctly-sized exit rather than two.
//
// ─── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────────────────────────────
//   • It adds no authority: the close goes through lib/maker/manual-order.placeManualOrder, the same
//     function and the same gate chain as any hand order — manual ownership, the shared venue-rules
//     guard, the per-order cap, the global kill switch, the adapter's own chain, and the exchange's
//     validateOrder(). MANUAL_ORDER_PLACEMENT still decides whether anything is actually sent.
//   • It only ever sells a quantity the VENUE says is held. The position size comes from the venue's own
//     positions read, never from our belief about what filled. A SELL for shares we do not hold would be
//     a naked short, which is why the size is never inferred.
//   • L'uscita non viene mai piazzata sotto il carico. Il target e' carico +1% (lib/maker/exit-plan);
//     se la banda premiante e' scesa sotto il carico non si piazza affatto — si chiude a mercato.
//   • Both switches must be on, both default OFF, both fail closed to OFF.

const { isAutoCloseEnabled, AUTO_CLOSE_SOURCE, CLOSE_PROFIT_CENTS } = require('./auto-close-config');
// ── IL PIANO DI USCITA, UNIFICATO ─────────────────────────────────────────────────────────────────
// Sostituisce il vecchio «carico + 1 centesimo». Obiettivo PERCENTUALE (+1%), limitato dalla banda
// premiante, con un pavimento di rischio al 4% oltre cui l'uscita smette di inseguire il prezzo.
// Le due percentuali vivono in exit-plan.js, non qui: chi le cambia le trova insieme.
const { planExit, decideExit, EXIT_PROFIT_PCT, MAX_WAIT_HOURS } = require('./exit-plan');
const { validateQuote } = require('./venue-rules');
const { inBand } = require('../rewards-live-band');
// LA STRATEGIA DELLA COPPIA. Modulo puro: decide quale dei tre livelli si applica a una posizione
// appena creata da un fill. Oggi gira in OSSERVAZIONE — vedi la sua intestazione per il perche'.
const { decidiLivello, MERGE_STRATEGY_ENABLED, MERGE_DISABLED_REASON } = require('./strategia-merge');

/**
 * Decide whether to place a closing SELL for ONE position.
 *
 * @param {object} args
 *   position   { tokenId, size, avgPrice }  — from the VENUE's positions read, never inferred
 *   restingOrders  the account's resting orders on this market (to detect a close already in place)
 *   rules      resolveMarketRules() shape
 *   book       'yes'|'no' — which book this token is
 *   venue      il record del CLOB per questo mercato ({closed, acceptingOrders, …}), iniettato dal
 *              chiamante. Assente ⇒ il gate «mercato risolto» non si applica e si prosegue: questa
 *              funzione CHIUDE esposizione, e rifiutarsi di chiudere per un dato mancante lascerebbe
 *              capitale bloccato. Si blocca solo su uno stato davvero LETTO.
 * @returns {{action:'close'|'skip'|'already-covered', gate, reason, price, size, profitCents, inBand}}
 */
function decideClose({ position, restingOrders = [], rules, book, venue = null, now = Date.now(), maxWaitMs = undefined } = {}) {
  const out = (action, gate, reason, extra = {}) => ({ action, gate, reason, price: null, size: null, profitCents: null, inBand: null, ...extra });
  const p = position || {};
  const size = Number(p.size);
  const entry = Number(p.avgPrice);
  if (!Number.isFinite(size) || !(size > 0)) return out('skip', 'no-position', 'nessuna posizione aperta su questo token');
  if (!Number.isFinite(entry) || !(entry > 0)) return out('skip', 'no-entry-price', 'prezzo medio di carico non leggibile dal venue — nessun target di chiusura calcolabile');
  if (!rules || rules.readable !== true) return out('skip', 'rules-unreadable', 'regole di venue non leggibili — nessuna chiusura viene piazzata');

  // ── IL MERCATO È ANCORA VIVO? È LA PRIMA DOMANDA, NON L'ULTIMA ──────────────────────────────────
  //
  // Misurato il 4 agosto 2026: questa funzione ha tentato 53 volte in un'ora di vendere 199,99 share
  // sul mercato «Bitcoin Up or Down - August 2, 6PM ET», convinta di un +61% sul carico. Quel mercato
  // era RISOLTO dal 2 agosto: il CLOB rispondeva `closed:true`, `accepting_orders:false`, e per quel
  // token «No orderbook exists». L'esito che detenevamo valeva ZERO — il +61% veniva da un prezzo
  // residuo rimasto in uno snapshot, non dal venue.
  //
  // A fermarla non è stato un controllo: è stato un gate a valle che rifiutava per un motivo diverso
  // e per giunta con una regola sbagliata (vedi manual-order, il caso dei SELL). Cioè si è fermata per
  // caso. Un'uscita automatica che decide su un mercato risolto e si salva per fortuna non è una
  // protezione, è una coincidenza — e su un mercato risolto una vendita non ha nemmeno un significato:
  // la posizione si RISCATTA, non si vende.
  //
  // Quindi il controllo sta QUI, come primo livello, prima di qualunque aritmetica di prezzo. E si
  // applica anche al ramo «chiudi a mercato»: un mercato che non accetta ordini non li accetta né in
  // banda né a mercato.
  //
  // FAIL-CLOSED ALL'INCONTRARIO, e con intenzione: se lo stato non è leggibile NON si blocca. Questa
  // funzione non apre esposizione — la chiude — e rifiutarsi di chiudere perché un campo manca
  // lascerebbe capitale bloccato per un dato mancante. Si blocca solo su un `closed`/`acceptingOrders`
  // davvero LETTO.
  // `venue` è il record letto dal CLOB (lib/maker/verifica-mercati-venue.leggiVenueClob), iniettato dal
  // chiamante: questa funzione resta pura e non apre una seconda strada verso la rete. `rules` NON basta
  // — non porta lo stato di chiusura, e infatti il 4 agosto non lo portava.
  const v = venue || null;
  if (v && v.closed === true) {
    return out('skip', 'market-closed',
      'il mercato risulta CHIUSO sul venue: la posizione si riscatta, non si vende. Nessun ordine di chiusura viene tentato.',
      { size, closed: true });
  }
  if (v && v.acceptingOrders === false) {
    return out('skip', 'market-not-accepting',
      'il venue non accetta più ordini su questo mercato: un ordine di chiusura verrebbe rifiutato comunque, e ritentarlo a ogni ciclo è solo rumore.',
      { size, acceptingOrders: false });
  }

  // ── C'E' GIA' UN'USCITA A RIPOSO? ─────────────────────────────────────────────────────────────
  // Se si', la domanda NON e' piu' «dove la piazzo» ma «va ancora aspettata». E' qui che vive il
  // trigger a banda: la banda si rilegge ADESSO, non si usa quella del momento del fill, perche' puo'
  // essersi ristretta da sola — misurato nel backtest, 4 uscite forzate su 48 con il mid fermo.
  const covering = restingOrders.filter((o) => o && String(o.tokenId) === String(p.tokenId) && String(o.side || '').toUpperCase() === 'SELL');
  const coveredSize = covering.reduce((s, o) => s + (Number(o.sizeRemaining ?? o.size) || 0), 0);
  if (coveredSize + 1e-9 >= size) {
    const scoringMidOra = book === 'no' ? rules.books.no.scoringMid : rules.books.yes.scoringMid;
    // La piu' VECCHIA delle uscite che coprono: e' quella che tiene fermo il capitale da piu' tempo,
    // ed e' il suo orologio che deve far scattare il tetto di attesa.
    const piuVecchia = covering.reduce((a, b) => {
      const ta = Number.isFinite(a && a.createdMs) ? a.createdMs : Infinity;
      const tb = Number.isFinite(b && b.createdMs) ? b.createdMs : Infinity;
      return tb < ta ? b : a;
    }, covering[0]);
    const verdetto = decideExit({
      exitPrice: Number(piuVecchia && piuVecchia.price),
      restingSinceMs: Number.isFinite(piuVecchia && piuVecchia.createdMs) ? piuVecchia.createdMs : null,
      now, scoringMid: scoringMidOra, tick: rules.tick,
      bandRadiusCents: Number.isFinite(rules.maxSpreadCents) ? rules.maxSpreadCents / 2 : null,
      maxWaitMs,
    });
    if (verdetto.action === 'close-at-market') {
      // CHIUSURA A MERCATO: si vende al miglior bid, cioe' attraversando lo spread. E' deliberato —
      // e' un'uscita, non una quotazione, e il punto e' proprio smettere di aspettare. Senza un bid
      // leggibile non si inventa un prezzo: si dichiara e non si fa nulla.
      const bid = book === 'no'
        ? (rules.books.no && rules.books.no.bestBid)
        : (rules.books.yes && rules.books.yes.bestBid);
      if (!Number.isFinite(bid) || !(bid > 0)) {
        return out('skip', 'no-market-bid',
          `${verdetto.reason} Ma il miglior bid non e' leggibile: non si chiude a un prezzo inventato.`,
          { size, coveredSize, trigger: verdetto.trigger, bandLo: verdetto.bandLo, bandHi: verdetto.bandHi });
      }
      // ── GATE ANTI-AUTO-INCROCIO ─────────────────────────────────────────────────────────────
      // Su questo lato ci sono DUE nostri ordini con scopi opposti:
      //   binario A  il BUY di liquidita' a riposo, che fa reward (agent40)
      //   binario B  il SELL che chiude la posizione filata (questo modulo)
      // In funzionamento normale non si incrociano: B sta a carico +1%, SOPRA A. Ma un
      // `close-at-market` vende al miglior BID — attraversa lo spread di proposito — e quel margine e'
      // di due tick: lo scavalca senza sforzo. A quel punto il nostro SELL puo' eseguirsi contro il
      // nostro stesso BUY, e il fill che ne nasce e' fantasma: crea una posizione che innesca un altro
      // ciclo di uscita, che vende di nuovo contro la liquidita' rimasta.
      //
      // Il venue non ci protegge: la self-trade prevention del CLOB non e' documentata e non e' stata
      // trovata ne' nell'API ne' nelle pagine ufficiali (vedi lib/maker/inventory-guard.js:27).
      //
      // NON SI COSTRUISCE UN SECONDO MECCANISMO: la liquidita' entra in `cancelOrderIds`, la stessa
      // lista che il ciclo gia' cancella e di cui gia' ATTENDE conferma — e se una sola cancellazione
      // fallisce, non vende. Quella disciplina vale ora anche per il binario A, senza scriverla due volte.
      //
      // Vale su ENTRAMBI i trigger (`band-exit` e `max-wait`) perche' e' `close-at-market` a essere
      // pericoloso, non il motivo per cui ci si arriva.
      const liquidita = restingOrders.filter((o) => o
        && String(o.tokenId) === String(p.tokenId)
        && String(o.side || '').toUpperCase() === 'BUY');
      const daCancellare = [...covering, ...liquidita].map((o) => o.orderId).filter(Boolean);
      return out('close-at-market', null,
        verdetto.reason + (liquidita.length
          ? ` · self-trade-guard-close-at-market (${verdetto.trigger}): ${liquidita.length} ordine/i di liquidita' a riposo su questo lato verrebbero attraversati dalla vendita a mercato — si cancellano PRIMA, e se la cancellazione non e' confermata non si vende.`
          : ''),
        { price: bid, size: coveredSize, trigger: verdetto.trigger, waitedMs: verdetto.waitedMs,
          bandLo: verdetto.bandLo, bandHi: verdetto.bandHi, entryPrice: entry,
          selfTradeGuard: liquidita.length
            ? { attivato: true, trigger: verdetto.trigger, ordiniLiquidita: liquidita.length,
              ids: liquidita.map((o) => o.orderId).filter(Boolean) }
            : { attivato: false, trigger: verdetto.trigger, ordiniLiquidita: 0, ids: [] },
          cancelOrderIds: daCancellare });
    }
    return out('already-covered', null,
      `già coperta: ${covering.length} ordine/i di vendita a riposo per ${coveredSize} share contro una posizione di ${size}. ${verdetto.reason}`,
      { size, coveredSize, bandLo: verdetto.bandLo, bandHi: verdetto.bandHi, waitedMs: verdetto.waitedMs });
  }

  // The remaining size to cover — partials are handled by construction.
  const toClose = +(size - coveredSize).toFixed(6);
  const scoringMid = book === 'no' ? rules.books.no.scoringMid : rules.books.yes.scoringMid;

  // IL PIANO DI USCITA. Non piu' un target a centesimi fissi: obiettivo +1% sul carico, tenuto DENTRO
  // la banda premiante (cosi' l'attesa matura invece di essere gratis per il mercato), e fermato al 4%
  // sotto il carico — oltre quel punto non si insegue piu' il prezzo verso il basso.
  const plan = planExit({
    entryPrice: entry, scoringMid, tick: rules.tick,
    bandRadiusCents: Number.isFinite(rules.maxSpreadCents) ? rules.maxSpreadCents / 2 : null,
  });
  if (!plan.ok) return out('skip', 'no-target', plan.reason);
  const target = { price: plan.price, profitCents: +((plan.price - entry) * 100).toFixed(3), reason: plan.reason };

  // ── THE SHARED GUARD, on the exact order we are about to propose. Same function the server re-runs. ──
  const vq = validateQuote({ tick: rules.tick, scoringMid, maxSpreadCents: rules.maxSpreadCents, minSize: rules.minSize },
    { side: 'SELL', price: target.price, size: toClose });
  const stillInBand = inBand(target.price, scoringMid, rules.maxSpreadCents);
  if (!vq.valid) {
    const codes = vq.reasons.map((r) => r.code);
    // OUT OF BAND is not a refusal to close: it only means the exit will not ALSO earn rewards while it
    // waits, and getting out beats earning. Everything else IS a refusal.
    if (!codes.every((c) => c === 'OUT_OF_BAND')) {
      // BELOW MIN SIZE deserves its own message, because it is the one refusal the operator can act on
      // and would otherwise misread. It happens when a PARTIAL exit already covers most of a position and
      // the remainder falls under the market's min_incentive_size. The shared guard refuses it and the
      // adapter refuses it again independently, so this path genuinely cannot place it — and weakening
      // that guard for one caller is not a trade worth making. The remainder stays open and is reported,
      // so it can be closed by hand.
      if (codes.includes('BELOW_MIN_SIZE')) {
        return out('skip', 'remainder-below-min-size',
          `restano ${toClose} share da chiudere, sotto la size minima ${rules.minSize} di questo mercato: il guard condiviso (e l'adapter, indipendentemente) rifiutano un ordine cosi piccolo. Il resto resta aperto e va chiuso a mano.`,
          { price: target.price, size: toClose, profitCents: target.profitCents, inBand: stillInBand });
      }
      return out('skip', 'guard-refused',
        `l'ordine di chiusura a ${target.price} non passa il guard condiviso (${codes.join(',')}) — non viene piazzato`,
        { price: target.price, size: toClose, profitCents: target.profitCents, inBand: stillInBand });
    }
  }

  return out('close', null,
    `${target.reason} · vendita di ${toClose} share del token in portafoglio${stillInBand ? ' (dentro la banda: l\'uscita matura premi mentre aspetta)' : ' (FUORI banda: chiude comunque, ma non matura premi nell\'attesa)'}`,
    { price: target.price, size: toClose, profitCents: target.profitCents, inBand: stillInBand,
      // Chi ha deciso il prezzo, e se siamo al pavimento del rischio: viaggia fino allo schermo e
      // all'audit, perche' «uscita a −4%» e «uscita a +1%» non sono lo stesso fatto.
      // Chi ha deciso il prezzo, e dove sono i bordi della banda in questo istante: viaggia fino allo
      // schermo e all'audit, perche' «uscita all'obiettivo» e «uscita al bordo premiante» non sono lo
      // stesso fatto. Nessun campo del vecchio pavimento fisso: quella logica non esiste piu'.
      clampedBy: plan.clampedBy, exitPct: plan.profitPct,
      bandLoPrice: plan.bandLo, bandHiPrice: plan.bandHi });
}

/**
 * One pass: for every managed market with the switch on, cover any uncovered position with a close SELL.
 * Every side effect injected, so the selfcheck drives the whole scenario with no venue and no network.
 *
 * @returns {{ran:boolean, gate:string|null, reason:string|null, markets:Array, actions:Array}}
 */
async function runAutoCloseCycle(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const t0 = now();
  const actions = [];
  const markets = [];
  const audit = typeof deps.audit === 'function' ? deps.audit : () => {};
  const result = (gate, reason) => ({ at: new Date(t0).toISOString(), ran: gate == null, gate, reason, markets, actions });

  const marketIds = Array.isArray(deps.marketIds) ? deps.marketIds : [];
  if (!marketIds.length) return result('no-markets', 'nessun mercato con la chiusura automatica abilitata');

  // The kill switch stops this exactly as it stops any placement: a close is a NEW order.
  const kill = typeof deps.killStatus === 'function' ? deps.killStatus() : { effectivelyKilled: false, readable: true };
  if (kill.effectivelyKilled === true || kill.readable === false) {
    return result('kill', kill.readable === false
      ? 'stato del kill-switch NON leggibile — trattato come attivo: nessuna chiusura viene piazzata'
      : 'kill-switch ATTIVO — nessuna chiusura viene piazzata (una chiusura è comunque un ordine nuovo)');
  }

  for (const marketId of marketIds) {
    const m = { marketId, gate: null, reason: null, positions: 0, covered: 0, placed: 0, skipped: 0 };
    const en = (deps.isEnabled || isAutoCloseEnabled)(marketId, deps.configDeps || {});
    if (!en.enabled) { m.gate = 'disabled'; m.reason = en.reason; markets.push(m); continue; }

    const mm = typeof deps.isManual === 'function' ? deps.isManual(marketId) : { manual: true, readable: true };
    if (!mm.readable || !mm.manual) {
      m.gate = mm.readable ? 'manual-mode-inactive' : 'manual-mode-unreadable';
      m.reason = 'la chiusura automatica agisce solo dove il mercato è in gestione manuale';
      markets.push(m); continue;
    }

    const rules = typeof deps.resolveRules === 'function' ? deps.resolveRules(marketId) : null;
    if (!rules || rules.readable !== true) { m.gate = 'rules-unreadable'; m.reason = 'regole di venue non leggibili'; markets.push(m); continue; }

    // VENUE TRUTH on both sides: what we hold, and what is already resting.
    let positions, resting;
    try { positions = await deps.readPositions({ marketId }); }
    catch (e) { m.gate = 'positions-read-failed'; m.reason = e.message; markets.push(m); continue; }
    if (!positions || positions.ok === false) { m.gate = 'positions-read-failed'; m.reason = (positions && positions.reason) || 'lettura posizioni fallita'; markets.push(m); continue; }
    try { resting = await deps.listOrders({ marketId }); }
    catch (e) { m.gate = 'orders-read-failed'; m.reason = e.message; markets.push(m); continue; }
    if (!resting || resting.ok === false || resting.simulated === true) {
      m.gate = 'orders-read-failed';
      m.reason = resting && resting.simulated ? 'venue non interrogato (nessuna credenziale): non so cosa sia già a riposo, quindi non piazzo nulla' : 'lettura ordini fallita';
      markets.push(m); continue;
    }

    // Only positions on THIS market's two tokens, and only those the panel could have created.
    const mine = (positions.positions || []).filter((p) => {
      const tok = String(p.tokenId ?? p.asset ?? '');
      return tok && (tok === String(rules.tokenId) || tok === String(rules.tokenIdNo));
    });
    m.positions = mine.length;

    // ── LO STATO DEL MERCATO AL VENUE, UNA VOLTA PER MERCATO ───────────────────────────────────
    // Si legge solo se c'e' davvero una posizione da giudicare: su un ciclo senza posizioni non si
    // interroga niente. `readVenue` e' iniettabile per i test; di difetto e' il lettore condiviso
    // (lib/maker/verifica-mercati-venue), lo stesso che usa la verifica dei mercati del piano.
    let venue = null;
    if (mine.length) {
      const leggi = typeof deps.readVenue === 'function'
        ? deps.readVenue
        : require('./verifica-mercati-venue').leggiVenueClob;
      try { venue = await leggi({ marketId }); }
      catch (e) { venue = { readable: false, error: e && e.message ? e.message : String(e) }; }
      if (venue && venue.readable === false) {
        // Non si blocca: questa funzione CHIUDE esposizione. Ma si dice, perche' un ciclo che decide
        // senza sapere se il mercato e' vivo deve lasciare traccia di cosa non ha potuto leggere.
        m.venueUnreadable = venue.error || 'ignoto';
      }
    }

    for (const pos of mine) {
      const tok = String(pos.tokenId ?? pos.asset ?? '');
      const book = tok === String(rules.tokenIdNo) ? 'no' : 'yes';

      // ── LA STRATEGIA DELLA COPPIA, IN OSSERVAZIONE ────────────────────────────────────────────
      // 1 YES + 1 NO valgono $1 per costruzione: completare la coppia sotto il dollaro e' profitto
      // matematico, e il merge lo incassa subito. Ma il merge on-chain non e' eseguibile da questo
      // stack (lib/maker/strategia-merge.js, intestazione: nessun percorso di scrittura on-chain, i
      // token stanno nel funder-contratto e non nell'EOA che firma, funder senza MATIC, deposit wallet
      // ERC-1271, mercati neg-risk). Senza merge, comprare il secondo lato IMMOBILIZZA capitale invece
      // di liberarlo — un'operazione diversa da quella che i tre livelli servono a fare.
      //
      // DALL'8 AGOSTO 2026 L'INTERRUTTORE E' ACCESO e i Livelli 1 e 2 AGISCONO: il ramo che li esegue
      // sta piu' sotto, subito prima dell'uscita ordinaria. Qui si calcola il livello e lo si registra
      // — la registrazione resta utile anche adesso, perche' e' l'unico punto in cui si vede il livello
      // con TUTTI i numeri che l'hanno prodotto, compresi i casi in cui poi il ramo rinuncia.
      //
      // Il merge on-chain resta NON eseguibile (CTF_RELAYER_ENABLED=false): completare la coppia oggi
      // immobilizza il capitale fino alla risoluzione invece di liberarlo subito. E' una decisione
      // dell'operatore, presa esplicitamente, non una conseguenza tecnica — vedi CLAUDE.md §4.
      // ── IL REGISTRO DELL'ATTESA ───────────────────────────────────────────────────────────────
      // Il Livello 2 e' un'attesa con una scadenza, e un'attesa senza memoria non scade mai: fino
      // all'8 agosto 2026 `attesaDaMs` non veniva passato, quindi `attesaMin` restava null e il ramo
      // del timeout in strategia-merge era codice irraggiungibile. La memoria sta FUORI da questo
      // modulo (iniettata) perche' qui non si scrive su disco e perche' deve sopravvivere al ciclo.
      const chiaveMerge = `${marketId}:${tok}`;
      const reg = deps.attesaMerge && typeof deps.attesaMerge.leggi === 'function' ? deps.attesaMerge : null;
      let attesa = null;
      if (reg) { try { attesa = reg.leggi(chiaveMerge); } catch { attesa = null; } }

      // La profondita' si legge UNA volta e resta in scope: la usa il calcolo del livello (la scala ask
      // del secondo lato) e la usa il ramo che piazza (il miglior ask, per far riposare il Livello 2).
      let dpMerge = null;
      try { dpMerge = typeof deps.readDepth === 'function' ? deps.readDepth(marketId) : null; }
      catch { dpMerge = null; }

      let liv = null;
      try {
        const altro = book === 'yes' ? 'no' : 'yes';
        const dp = dpMerge;
        const altraPos = mine.find((x) => String(x.tokenId ?? x.asset ?? '') !== tok);
        liv = decidiLivello({
          book,
          sizePosseduta: Number(pos.size),
          prezzoCarico: Number(pos.avgPrice),
          sizeAltroLato: altraPos ? Math.abs(Number(altraPos.size)) : 0,
          asksAltroLato: dp && dp[altro] && Array.isArray(dp[altro].asks) ? dp[altro].asks : null,
          attesaDaMs: attesa && Number.isFinite(Number(attesa.at)) ? Number(attesa.at) : null,
          now: t0,
        });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: MERGE_STRATEGY_ENABLED ? `merge-livello-${liv.livello}` : `merge-livello-${liv.livello}-osservato`,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
          reason: MERGE_STRATEGY_ENABLED ? liv.motivo : `${liv.motivo} · NON ESEGUITO: ${MERGE_DISABLED_REASON}`,
          observed: { livello: liv.livello, azione: liv.azione, eseguito: MERGE_STRATEGY_ENABLED, book, ...liv.numeri } });
      } catch (e) {
        // Un'osservazione che non riesce non deve poter fermare la chiusura, che e' l'unica cosa che
        // qui protegge davvero del capitale.
        liv = null; void e;
      }

      const d = decideClose({ position: { tokenId: tok, size: pos.size, avgPrice: pos.avgPrice }, restingOrders: resting.orders || [], rules, book, venue });
      if (liv) { d.mergeLivello = liv.livello; d.mergeAzione = liv.azione; d.mergeEseguito = MERGE_STRATEGY_ENABLED; }

      if (d.action === 'skip' && (d.gate === 'market-closed' || d.gate === 'market-not-accepting')) {
        m.skipped = (m.skipped || 0) + 1;
        actions.push({ marketId, tokenId: tok, book, action: 'skip', gate: d.gate, reason: d.reason });
        audit({ ts: now(), venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: d.gate,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: d.reason, observed: { size: d.size } });
        continue;
      }

      if (d.action === 'already-covered') { m.covered++; actions.push({ marketId, tokenId: tok, book, action: 'already-covered', reason: d.reason }); continue; }

      // ── CHIUSURA A MERCATO: il trigger e' scattato ────────────────────────────────────────────
      // Due passi, in quest'ordine: prima si TOGLIE l'uscita che non serve piu', poi si vende al bid.
      // Invertirli lascerebbe per un istante due ordini di vendita sulla stessa posizione, cioe' il
      // rischio di venderla due volte. Se la cancellazione fallisce NON si vende: si riprova al giro
      // dopo, perche' una posizione con un'uscita orfana e' recuperabile, una venduta due volte no.
      if (d.action === 'close-at-market') {
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: `exit-trigger-${d.trigger}`,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: d.reason,
          observed: { trigger: d.trigger, waitedMs: d.waitedMs, bandLo: d.bandLo, bandHi: d.bandHi, entryPrice: d.entryPrice,
            // Il gate viaggia nell'audit col trigger che l'ha invocato: «quante volte la vendita a
            // mercato ha dovuto togliere di mezzo la liquidita'» e' una domanda che si pone dopo.
            selfTradeGuard: d.selfTradeGuard || null } });
        let tolte = 0; let fallita = null;
        for (const oid of (d.cancelOrderIds || [])) {
          let c = null;
          try { c = typeof deps.cancelOrder === 'function' ? await deps.cancelOrder({ orderId: oid, marketId }) : null; }
          catch (e) { c = { ok: false, reason: e.message }; }
          if (c && c.ok !== false) tolte += 1; else fallita = (c && c.reason) || 'ignoto';
        }
        if (fallita) {
          m.skipped++;
          actions.push({ marketId, tokenId: tok, book, action: 'close-at-market', ok: false, gate: 'cancel-failed',
            reason: `cancellazione fallita (${fallita}): NON vendo a mercato. La lista comprende le uscite a riposo e`
              + ` — da oggi — gli ordini di LIQUIDITA' su questo lato${(d.selfTradeGuard && d.selfTradeGuard.attivato) ? ` (${d.selfTradeGuard.ordiniLiquidita})` : ''};`
              + ` vendere con uno dei due ancora vivo significherebbe o due ordini di vendita sulla stessa posizione,`
              + ` o una vendita a mercato che si esegue contro il nostro stesso acquisto. Riprovo al prossimo ciclo.` });
          audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: 'exit-cancel-failed',
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: fallita });
          continue;
        }
        let mres;
        try {
          mres = await deps.placeOrder({
            marketId, book, side: 'SELL', price: d.price, size: d.size,
            // Questa vendita ATTRAVERSA lo spread di proposito: e' l'uscita forzata, non una
            // quotazione. Il gate anti-taker la riconosce solo perche' gliela dichiariamo, e la
            // marca nell'audit — non e' un permesso generale (vale solo in vendita).
            attraversaApposta: true,
            source: AUTO_CLOSE_SOURCE,
            note: `uscita forzata (${d.trigger}): chiusura a mercato al bid ${d.price}`,
          });
        } catch (e) { mres = { ok: false, gate: 'exception', reason: e.message }; }
        const mok = !!(mres && mres.ok);
        if (mok) m.placed++; else m.skipped++;
        actions.push({ marketId, tokenId: tok, book, action: 'close-at-market', ok: mok, trigger: d.trigger,
          price: d.price, size: d.size, cancelled: tolte, sent: !!(mres && mres.sent),
          gate: (mres && mres.gate) || null, reason: (mres && mres.reason) || d.reason });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: mok ? ((mres && mres.sent) ? 'exit-market-sent' : 'exit-market-dry-run') : `exit-market-reject-${(mres && mres.gate) || 'venue'}`,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
          requested: { book, side: 'SELL', price: d.price, size: d.size, trigger: d.trigger },
          gate: (mres && mres.gate) || null, reason: (mres && mres.reason) || null });
        continue;
      }
      if (d.action === 'skip') {
        m.skipped++;
        actions.push({ marketId, tokenId: tok, book, action: 'skip', gate: d.gate, reason: d.reason });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: `skip-${d.gate}`,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: d.reason });
        continue;
      }

      // ══ LIVELLI 1 E 2 · COMPLETARE LA COPPIA INVECE DI VENDERE ═══════════════════════════════════
      // Sta QUI, e il punto d'innesto e' scelto: sopra sono gia' passati il mercato chiuso, il mercato
      // che non accetta ordini, la posizione gia' coperta da un'uscita a riposo e la chiusura forzata a
      // mercato. Cioe' si arriva qui solo quando il modulo sta per piazzare l'uscita ORDINARIA — che e'
      // esattamente il Livello 3. Sostituirlo qui rende la gerarchia vera senza toccare nessuno dei
      // percorsi urgenti: una chiusura che deve eseguire adesso non viene mai rimandata da un merge.
      //
      // NON SI FANNO LE DUE COSE INSIEME. Se si compra il secondo lato E si mette l'uscita sul primo,
      // si paga per completare una coppia che si sta contemporaneamente smontando. Quindi il ramo o
      // piazza il completamento e salta l'uscita (`continue`), o rinuncia e lascia proseguire il L3.
      if (MERGE_STRATEGY_ENABLED && liv && (liv.livello === 1 || liv.livello === 2)) {
        const altroTok = book === 'yes' ? String(rules.tokenIdNo) : String(rules.tokenId);
        const altroBook = book === 'yes' ? 'no' : 'yes';
        const fallback = (gate, reason) => {
          actions.push({ marketId, tokenId: tok, book, action: 'merge-non-tentato', gate, reason, livello: liv.livello });
          audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: `merge-saltato-${gate}`,
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason,
            observed: { livello: liv.livello, azione: liv.azione, book, altroBook } });
        };

        // FAIL-CLOSED SENZA REGISTRO. Senza la memoria dell'attesa il Livello 2 non ha scadenza e
        // ripiazzerebbe il completamento a ogni ciclo: due difetti che si sommano. Meglio il Livello 3,
        // che e' il comportamento noto.
        if (!reg) {
          fallback('senza-registro', 'nessun registro delle attese iniettato: il timeout del Livello 2 non sarebbe'
            + ' applicabile e il completamento verrebbe ripiazzato a ogni ciclo — si ripiega sul Livello 3');
        } else if (attesa && attesa.orderId) {
          // Gia' in attesa e non ancora scaduta (se fosse scaduta, decidiLivello avrebbe detto 3).
          // Non si tocca niente: l'ordine di completamento e' sul libro e sta facendo il suo lavoro.
          m.inAttesaMerge = (m.inAttesaMerge || 0) + 1;
          actions.push({ marketId, tokenId: tok, book, action: 'merge-in-attesa', livello: 2,
            attesaMin: liv.numeri && liv.numeri.attesaMin, orderId: attesa.orderId });
          continue;
        } else {
          const tick = Number(rules.tick);
          const minSize = Number(rules.minSize);
          const alTick = (x) => (Number.isFinite(tick) && tick > 0 && Number.isFinite(x)
            ? +(Math.floor((x + 1e-9) / tick) * tick).toFixed(6) : x);
          // Il miglior ask del secondo lato, ricavato dalla scala che il Livello 1 ha gia' guardato.
          // Serve a un solo scopo: prezzare il Livello 2 in modo che RIPOSI davvero.
          const askAltro = dpMerge && dpMerge[altroBook] && Array.isArray(dpMerge[altroBook].asks)
            ? dpMerge[altroBook].asks.map((l) => Number(l && l.price)).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b)[0]
            : null;
          const manca = Number(liv.numeri && liv.numeri.mancaAllaCoppia);

          // ── I DUE TENTATIVI, IN ORDINE ────────────────────────────────────────────────────────
          // Il Livello 1 e' un TAKER e oggi non puo' passare: `manual-order` consente di attraversare
          // lo spread solo in VENDITA («un acquisto aggressivo APRE esposizione: per il BUY la regola
          // resta assoluta», manual-order.js:1008). Quella regola NON e' stata toccata — e' una
          // protezione esplicita e allentarla e' una decisione dell'operatore, non di questo file.
          // Quindi il Livello 1 si tenta lo stesso (se un giorno l'eccezione arrivera', funziona da
          // solo) ma quando il gate lo rifiuta si degrada al Livello 2 NELLO STESSO CICLO, invece di
          // precipitare al Livello 3: la coppia resta completabile, solo piu' lentamente.
          const tentativi = [];
          if (liv.livello === 1 && Number.isFinite(Number(liv.prezzo))) {
            tentativi.push({ livello: 1, prezzo: alTick(Number(liv.prezzo)), size: Number(liv.size), taker: true });
          }
          // Il Livello 2 riposa: mai sopra il tetto (sfondarlo farebbe costare la coppia piu' di $1) e
          // mai sopra il miglior ask meno un tick (altrimenti incrocia e viene rifiutato come il L1).
          const tettoRiposo = Number.isFinite(askAltro) && Number.isFinite(tick) && tick > 0
            ? Math.min(Number(liv.tetto), askAltro - tick)
            : Number(liv.tetto);
          tentativi.push({ livello: 2, prezzo: alTick(tettoRiposo), size: manca, taker: false });

          let piazzato = false; let ultimoMotivo = null;
          for (const t of tentativi) {
            if (!Number.isFinite(t.prezzo) || !(t.prezzo > 0) || !Number.isFinite(t.size) || !(t.size > 0)) {
              ultimoMotivo = `livello ${t.livello}: prezzo (${t.prezzo}) o size (${t.size}) non utilizzabili`;
              continue;
            }
            if (Number.isFinite(minSize) && t.size < minSize) {
              ultimoMotivo = `livello ${t.livello}: il completamento sarebbe di ${t.size} share, sotto il minimo del venue (${minSize})`;
              continue;
            }
            let cres;
            try {
              cres = await deps.placeOrder({
                marketId, book: altroBook, side: 'BUY', price: t.prezzo, size: t.size,
                // Livello 1 ATTRAVERSA lo spread di proposito (e' un taker: la convenienza e' adesso e
                // domani puo' non esserci). Livello 2 e' una quotazione che aspetta il suo turno.
                ...(t.taker ? { attraversaApposta: true } : { inCoda: true }),
                source: AUTO_CLOSE_SOURCE,
                note: `merge livello ${t.livello}: completa la coppia comprando ${t.size} share di ${altroBook.toUpperCase()}`
                  + ` a ${t.prezzo} (tetto ${liv.tetto}) su carico ${pos.avgPrice}`,
              });
            } catch (e) { cres = { ok: false, gate: 'exception', reason: e.message }; }
            const cok = !!(cres && cres.ok);
            audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
              outcome: cok ? `merge-livello-${t.livello}-piazzato` : `merge-livello-${t.livello}-reject-${(cres && cres.gate) || 'venue'}`,
              marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: liv.motivo,
              requested: { book: altroBook, side: 'BUY', price: t.prezzo, size: t.size, livello: t.livello, taker: t.taker },
              gate: (cres && cres.gate) || null,
              observed: { livello: liv.livello, azione: liv.azione, tetto: liv.tetto, askAltro, ...liv.numeri } });
            if (cok) {
              // Il Livello 1 e' immediato e non apre un'attesa: al giro dopo la coppia risulta completa
              // (o quel che ne resta torna qui). Solo il Livello 2 fa partire l'orologio dei 60 minuti.
              if (t.livello === 2) {
                try { reg.segna(chiaveMerge, { at: t0, orderId: (cres && cres.orderId) || null, size: t.size, prezzo: t.prezzo }); } catch { /* il giro dopo riprova */ }
              }
              m.mergePiazzati = (m.mergePiazzati || 0) + 1;
              actions.push({ marketId, tokenId: tok, book, action: `merge-livello-${t.livello}`, ok: true,
                altroBook, price: t.prezzo, size: t.size, sent: !!(cres && cres.sent), orderId: (cres && cres.orderId) || null });
              piazzato = true;
              break;
            }
            ultimoMotivo = `livello ${t.livello}: ${(cres && cres.reason) || 'piazzamento non riuscito'}`;
          }
          if (piazzato) continue;   // ← l'uscita NON si piazza: la coppia si sta completando
          fallback('piazzamento', ultimoMotivo || 'nessun livello di completamento e stato piazzabile');
        }
      }

      // Il Livello 3 e' arrivato per scadenza: l'ordine di completamento che aspettava non ha piu'
      // motivo di stare sul libro, e lasciarlo li' significherebbe comprare il secondo lato mentre si
      // vende il primo. Si toglie PRIMA di vendere, e se non si riesce a toglierlo non si vende.
      if (MERGE_STRATEGY_ENABLED && reg && attesa && attesa.orderId && liv && liv.livello === 3) {
        let c = null;
        try { c = typeof deps.cancelOrder === 'function' ? await deps.cancelOrder({ orderId: attesa.orderId, marketId }) : null; }
        catch (e) { c = { ok: false, reason: e.message }; }
        if (c && c.ok === false) {
          m.skipped++;
          actions.push({ marketId, tokenId: tok, book, action: 'merge-timeout-cancel-fallita', gate: 'cancel-failed', reason: (c && c.reason) || 'ignoto' });
          audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: 'merge-timeout-cancel-fallita',
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: (c && c.reason) || 'ignoto' });
          continue;
        }
        try { reg.pulisci(chiaveMerge); } catch { /* non blocca l'uscita */ }
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: 'merge-timeout-livello-3',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: liv.motivo,
          observed: { attesaMin: liv.numeri && liv.numeri.attesaMin } });
      }

      audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: 'trigger',
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: d.reason,
        requested: { book, side: 'SELL', tokenId: tok, price: d.price, size: d.size, entryPrice: pos.avgPrice, profitCents: d.profitCents, inBand: d.inBand } });

      let res;
      try {
        res = await deps.placeOrder({
          marketId, book, side: 'SELL', price: d.price, size: d.size,
          source: AUTO_CLOSE_SOURCE,
          // Questa e' una QUOTAZIONE maker: sta in coda come le altre. La chiusura forzata a mercato,
          // poche righe sopra, NON lo dichiara — quella deve eseguire, non aspettare il suo turno.
          inCoda: true,
          note: `auto-close: uscita a ${d.price} su carico ${pos.avgPrice} (+${d.profitCents}¢/share)`,
        });
      } catch (e) {
        m.skipped++;
        actions.push({ marketId, tokenId: tok, book, action: 'error', reason: e.message });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: 'error', reason: e.message });
        continue;
      }

      const ok = res && res.ok === true;
      if (ok) m.placed++; else m.skipped++;

      // ── E LA GAMBA ESEGUITA TORNA SUL LIBRO ──────────────────────────────────────────────────
      // L'uscita si occupa della sicurezza di queste share; questo si occupa di rimettere il mercato
      // a produrre, senza aspettare il ciclo di riallocazione (fino a sei ore). Entra SOLO per quello
      // che ci sta sotto il tetto del mercato: la posizione in chiusura e l'uscita a riposo occupano
      // ancora il loro spazio, e sommarci una gamba intera raddoppierebbe l'esposizione.
      //
      // E' un BUY; l'uscita e' un SELL. auto-close conta i SELL a riposo per sapere se una posizione
      // e' coperta, quindi questo ordine non puo' far sembrare coperta una posizione che non lo e'.
      if (ok && typeof deps.rimpiazzaGamba === 'function') {
        try {
          // COSA SI PASSA, E COSA NO. Non l'offset: `decideClose` non lo conosce e non deve — la
          // distanza dal mid a cui questo mercato quota è una CONFIGURAZIONE del mercato, non una
          // proprietà della chiusura, e chi rimpiazza la risolve da lib/maker/offset-config come fa
          // il riprezzo. (Fino a questa revisione qui passava `d.offsetCents`, che decideClose non ha
          // mai restituito: sarebbe arrivato `null` e planQuotes avrebbe rifiutato «offset non valido».)
          //
          // Si passano invece i due nozionali che il tetto del mercato deve contare: la posizione
          // appena aperta dal fill, e l'uscita che si è appena messa a riposo sopra di essa.
          const rp = await deps.rimpiazzaGamba({
            marketId, book, tokenId: tok,
            posizioneUsd: Number(pos.avgPrice) * Number(pos.size),
            uscitaUsd: Number(d.price) * Number(d.size),
          });
          if (rp && rp.action === 'rimpiazza') {
            m.rimpiazzate = (m.rimpiazzate || 0) + 1;
            actions.push({ marketId, tokenId: tok, book, action: 'rimpiazzo', ok: rp.ok !== false, price: rp.price, size: rp.size, reason: rp.reason });
          } else if (rp) {
            actions.push({ marketId, tokenId: tok, book, action: 'rimpiazzo-saltato', gate: rp.gate, reason: rp.reason });
          }
          audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'rimpiazzo-gamba',
            outcome: (rp && rp.action === 'rimpiazza') ? 'rimpiazzata' : `saltato-${(rp && rp.gate) || 'ignoto'}`,
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: (rp && rp.reason) || null });
        } catch (e) {
          actions.push({ marketId, tokenId: tok, book, action: 'rimpiazzo-saltato', gate: 'eccezione', reason: e.message });
        }
      }

      actions.push({ marketId, tokenId: tok, book, action: 'close', ok, price: d.price, size: d.size,
        entryPrice: pos.avgPrice, profitCents: d.profitCents, inBand: d.inBand,
        sent: res && res.sent === true, orderId: (res && res.orderId) || null, gate: (res && res.gate) || null, reason: (res && res.reason) || null });
      audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
        outcome: ok ? (res.sent ? 'sent' : 'dry-run-validated') : `reject-${(res && res.gate) || 'place'}`,
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
        requested: { book, side: 'SELL', price: d.price, size: d.size, entryPrice: pos.avgPrice, profitCents: d.profitCents },
        response: { ok, orderId: (res && res.orderId) || null }, gate: (res && res.gate) || null, reason: (res && res.reason) || null,
        latencyMs: now() - t0 });
    }
    markets.push(m);
  }

  return { at: new Date(t0).toISOString(), ran: true, gate: null, reason: null, markets, actions, latencyMs: now() - t0 };
}

module.exports = { runAutoCloseCycle, decideClose, AUTO_CLOSE_SOURCE, EXIT_PROFIT_PCT, MAX_WAIT_HOURS };

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
// ── LA CHIUSURA RAPIDA (9 agosto 2026) ──────────────────────────────────────────────────────────────
// Costante di sorgente e non una env, come `MERGE_STRATEGY_ENABLED`: due interruttori per una decisione
// sola vogliono dire che spegnerne uno non la spegne. Accende il completamento AGGRESSIVO della coppia
// dopo un fill su un lato solo — taker fino al tetto della coppia (`TETTO_COPPIA_CENTS`), limit per il resto.
const CHIUSURA_RAPIDA_ENABLED = true;
// Il riposizionamento immediato dopo una fusione. Costante di sorgente per la stessa ragione delle altre
// due: un interruttore che si puo' spegnere da due posti non e' un interruttore.
const RIPOSIZIONA_DOPO_CHIUSURA = true;
const { pianificaChiusuraRapida, pianificaRiposizionamentoScoperto, rispettaIlTetto, TETTO_COPPIA_CENTS } = require('./chiusura-rapida');
// La sottrazione dei NOSTRI ordini dalla scala del book: la stessa funzione con cui il motore di
// piazzamento applica «mai primo sul libro», riusata qui come protezione anti-self-trade sui percorsi
// taker. Una definizione sola: due modi di dire «il book altrui» potrebbero divergere.
const { othersLadder } = require('./top-of-book');
// Il backoff progressivo del venue, gia' in servizio nell'adapter per le LETTURE. Qui serve per i
// piazzamenti di CHIUSURA — vedi `piazzaChiudendo` piu' sotto.
const { attesaBackoff, classificaErrore } = require('./backoff-venue');
// (a)(b)(c)(d) del 9 agosto 2026: la classificazione del fill, il piano del rimasuglio e la size del
// riposizionamento. Modulo PURO — non piazza, non legge, non scrive: qui si propone, i gate giudicano.
const { classificaFill, pianificaRimasuglio, capitalePerRiposizionamento,
  FILL_PARZIALE, FILL_COMPLETO } = require('./risposta-al-fill');
// LA MODALITA' CHIUSURA. Il modulo e' PURO: qui si legge e si scrive un registro iniettato, mai un file.
const MC = require('./modalita-chiusura');
// ── IL PIANO DI USCITA, UNIFICATO ─────────────────────────────────────────────────────────────────
// Sostituisce il vecchio «carico + 1 centesimo». Obiettivo PERCENTUALE (+1%), limitato dalla banda
// premiante, con un pavimento di rischio al 4% oltre cui l'uscita smette di inseguire il prezzo.
// Le due percentuali vivono in exit-plan.js, non qui: chi le cambia le trova insieme.
const { planExit, decideExit, EXIT_PROFIT_PCT, MAX_WAIT_HOURS } = require('./exit-plan');
// LA PRESA DI PROFITTO (§5 p.169). Decide sul prezzo REALIZZABILE — il bid camminato — e mai sul mid,
// perche' la misura del 16 agosto dice che il mid non era consumabile in nessuno dei 283 campioni.
const { presaDiProfitto } = require('./presa-di-profitto');
// Il carico quando il venue non l'ha ancora pubblicato (§ carico-di-ripiego): 2 fill su 2 il 16 agosto
// hanno perso un ciclo intero per questo, ed e' il ciclo in cui la gamba e' appena diventata nuda.
const { caricoDaUsare } = require('./carico-di-ripiego');
// Il permesso di attraversare lo spread su un'uscita (§ attraversamento-uscita): quattro limiti
// dichiarati dall'operatore il 17 agosto 2026, letti tutti insieme in un modulo puro.
const { valutaAttraversamento } = require('./attraversamento-uscita');
const { validateQuote } = require('./venue-rules');
const { inBand } = require('../rewards-live-band');
// LA STRATEGIA DELLA COPPIA. Modulo puro: decide quale dei tre livelli si applica a una posizione
// appena creata da un fill. Oggi gira in OSSERVAZIONE — vedi la sua intestazione per il perche'.
const { decidiLivello, MERGE_STRATEGY_ENABLED, MERGE_DISABLED_REASON } = require('./strategia-merge');
const { raggioBandaCents } = require('../banda-premiante');
// ── LA SCALA DI URGENZA SUL TEMPO DI SCOPERTURA (§5 p.138) ────────────────────────────────────────
// Modulo PURO: riceve i minuti di scopertura e restituisce quali vie si aprono. Le soglie vengono
// dagli episodi misurati sulle 48 ore, non da cifre tonde — vedi la sua intestazione.
const { livelloUrgenza, SOGLIE_MIN: SOGLIE_URGENZA } = require('./urgenza-scoperto');

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
// ── LA SCALA DI URGENZA SUL TEMPO DI SCOPERTURA (§5 p.138) ────────────────────────────────────────
// `urgenza` arriva dal chiamante, che e' l'unico a poter leggere da quanto la posizione e' scoperta
// (il registro della modalita' chiusura, che vive su disco). NON iniettata ⇒ gradino 0 ⇒ il
// comportamento di prima, riga per riga: `profitPct` torna a +1% e la concessione a zero tick.
function decideClose({ position, restingOrders = [], rules, book, venue = null, now = Date.now(),
  maxWaitMs = undefined, urgenza = null, depth = null } = {}) {
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

  // ══ SI PUO' INCASSARE ADESSO INVECE DI COMPLETARE LA COPPIA? — 17 agosto 2026 ═════════════════
  //
  // ⚠ STA QUI, E LA POSIZIONE NEL FILE E' LA META' DELLA CORREZIONE. Dopo le guardie sul mercato
  // (non si vende su un mercato risolto) e PRIMA del ramo `already-covered`, che RITORNA: un'uscita
  // gia' a riposo non deve poter impedire di prendere un guadagno migliore, ed e' la stessa forma di
  // difetto di §5-bis p.138, dove quel `return` impediva di RIDURRE il prezzo. Li' bloccava la discesa,
  // qui bloccherebbe l'incasso.
  //
  // ⚠ COSA NON FA, e va detto perche' e' cio' che lo rende sicuro:
  //   · non produce prezzi propri — il prezzo e' il bid del libro, camminato per la nostra size;
  //   · non tocca la scala di urgenza, e non puo' incrociarla: quella opera sotto il carico, questa
  //     pretende un ricavo sopra il carico piu' il margine. Domini disgiunti per costruzione;
  //   · non rilegge niente: `depth` e' la lettura che il ciclo ha gia' fatto;
  //   · se `depth` non e' cablato ⇒ `scatta:false` ⇒ il comportamento e' ESATTAMENTE quello di prima,
  //     riga per riga. E' la stessa disciplina di `urgenza` (dep non cablata ⇒ gradino 0).
  //
  // ⚠ LA SCALA SI RIPULISCE DAI NOSTRI ORDINI con `othersLadder`, la STESSA funzione di «mai primo sul
  // libro» gia' importata in questo file. Senza, il bid conterrebbe i nostri stessi BUY di liquidita'
  // e si venderebbe contro se' stessi — il fill fantasma di cui parla il gate anti-auto-incrocio.
  const altroBookNome = book === 'yes' ? 'no' : 'yes';
  const scalaPulita = (livelli, nostri) => {
    if (!Array.isArray(livelli)) return null;
    if (!nostri.length) return livelli;
    try {
      const L = othersLadder({ levels: livelli, ownOrders: nostri, tick: Number(rules && rules.tick) });
      return L.readable === true ? L.levels : livelli;
    } catch { return livelli; }
  };
  const nostriDi = (stessoToken, lato) => (Array.isArray(restingOrders) ? restingOrders : [])
    .filter((o) => o && String(o.side || '').toUpperCase() === lato
      && (stessoToken ? String(o.tokenId) === String(p.tokenId) : String(o.tokenId) !== String(p.tokenId)))
    .map((o) => ({ orderId: o.orderId, price: Number(o.price),
      size: Number(o.sizeRemaining != null ? o.sizeRemaining : o.size) }))
    .filter((o) => Number.isFinite(o.price) && Number.isFinite(o.size) && o.size > 0);

  const tp = presaDiProfitto({
    carico: entry, size,
    // I BID del libro che possiedo — li colpisco vendendo. Tolti i NOSTRI BUY sullo stesso token.
    bidsMioLato: scalaPulita(
      depth && depth[book] && Array.isArray(depth[book].bids) ? depth[book].bids : null,
      nostriDi(true, 'BUY')),
    // Gli ASK dell'altro libro — li pagherei per completare la coppia. Tolti i NOSTRI SELL su quel token.
    asksAltroLato: scalaPulita(
      depth && depth[altroBookNome] && Array.isArray(depth[altroBookNome].asks) ? depth[altroBookNome].asks : null,
      nostriDi(false, 'SELL')),
  });
  if (tp.scatta === true) {
    // ── SI RIUSA IL GATE ANTI-AUTO-INCROCIO, NON SE NE COSTRUISCE UN SECONDO ────────────────────
    // Questa e' una vendita che ATTRAVERSA lo spread, esattamente come `close-at-market`, e corre lo
    // stesso rischio: i nostri BUY di liquidita' a riposo su questo lato verrebbero attraversati.
    // Finiscono in `cancelOrderIds` — la stessa lista che il ciclo gia' cancella e di cui gia' ATTENDE
    // conferma — insieme alle uscite che coprono, che vanno tolte o si venderebbe due volte.
    const suQuestoToken = (lato) => (Array.isArray(restingOrders) ? restingOrders : [])
      .filter((o) => o && String(o.tokenId) === String(p.tokenId)
        && String(o.side || '').toUpperCase() === lato);
    const daTogliere = [...suQuestoToken('BUY'), ...suQuestoToken('SELL')]
      .map((o) => o.orderId).filter(Boolean);
    return out('close-at-market', null, tp.motivo, {
      price: tp.prezzo, size: tp.size, entryPrice: entry,
      trigger: 'presa-di-profitto', viaPresaDiProfitto: tp.via,
      profitCents: +((tp.prezzo - entry) * 100).toFixed(3),
      peggiorativa: false,
      presaDiProfitto: {
        ricavoIncassoUsd: tp.ricavoIncassoUsd, ricavoCoppiaUsd: tp.ricavoCoppiaUsd,
        guadagnoUsd: tp.guadagnoUsd, bidCamminato: tp.bidCamminato, askAltroLato: tp.askAltroLato,
        coppiaCents: tp.coppiaCents, tettoCoppiaCents: tp.tettoCoppiaCents,
        margineCents: tp.margineCents, via: tp.via,
      },
      selfTradeGuard: { attivato: daTogliere.length > 0, trigger: 'presa-di-profitto',
        ordiniLiquidita: suQuestoToken('BUY').length, ids: daTogliere },
      cancelOrderIds: daTogliere,
    });
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
      bandRadiusCents: Number.isFinite(rules.maxSpreadCents) ? raggioBandaCents(rules.maxSpreadCents) : null,
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
    // ══ L'USCITA GIÀ A LIBRO VA RIPREZZATA QUANDO LA SCALA CONCEDE DI PIÙ — 16 agosto 2026 ═══════
    //
    // ⚠ QUESTO È IL DIFETTO CHE HA TENUTO UNA POSIZIONE APERTA CINQUE ORE, e la misura lo ha trovato
    // dove non lo cercavo. L'orologio NON si era azzerato: `modalita-chiusura.json` portava
    // `da: 15:20:41Z` corretto per tutte le cinque ore, e la dep era cablata. Il difetto è che questo
    // ramo RITORNA PRIMA che il prezzo d'uscita venga ricalcolato: l'uscita si piazza una volta, al
    // gradino che la scala concedeva allora, e non scende MAI più.
    // Misurato sul giornale del 16/08: `urgenzaLivello` compare **UNA volta in cinque ore** su
    // `0xde0b0b24…`. La scala non è stata quasi mai valutata — non perché il suo orologio fosse
    // sbagliato, ma perché nessuno glielo chiedeva più.
    // Conseguenza vista dal vivo: uscita ferma a 21¢ con carico 20¢ mentre il book scendeva a 16/18.
    // Un ordine appeso sopra il mercato non è un'uscita: è una posizione direzionale con un alibi.
    //
    // ⚠ RIDUCE E BASTA, PER COSTRUZIONE: si agisce solo se il prezzo nuovo è **più basso** di quello a
    // libro di almeno un tick. Un'uscita non può mai essere alzata da qui, quindi questo ramo non può
    // trasformarsi in un modo di pretendere di più da una posizione che il mercato ha già superato.
    {
      // ⚠ `scoringMid` è dichiarato più sotto (TDZ): qui si ricava dalla stessa fonte, `rules.books`,
      // con la stessa espressione di `scoringMidOra`. Non è una seconda idea del mid — è la stessa
      // letta prima, perché questo ramo esce prima che la variabile esista.
      const midQui = book === 'no'
        ? (rules.books && rules.books.no ? rules.books.no.scoringMid : null)
        : (rules.books && rules.books.yes ? rules.books.yes.scoringMid : null);
      const pianoOra = planExit({
        entryPrice: entry, scoringMid: midQui, tick: rules.tick,
        bandRadiusCents: Number.isFinite(rules.maxSpreadCents) ? raggioBandaCents(rules.maxSpreadCents) : null,
        ...(urgenza && Number.isFinite(urgenza.profitPct) ? { profitPct: urgenza.profitPct } : {}),
        ...(urgenza && Number.isFinite(urgenza.concessioneTick) ? { concessioneTick: urgenza.concessioneTick } : {}),
      });
      const prezziCoprenti = covering.map((o) => Number(o.price)).filter((x) => Number.isFinite(x) && x > 0);
      const piuBasso = prezziCoprenti.length ? Math.min(...prezziCoprenti) : null;
      const tick = Number(rules.tick);
      // ══ IL PAVIMENTO VA CONSUMATO, O RESTA UN PERMESSO CHE NESSUNO USA ═══════════════════════════
      // `planExit` produce un PREZZO (il carico + profitPct) e un PAVIMENTO (quanto sotto si puo'
      // scendere). Fino a oggi nessuno consumava il pavimento: al gradino 2 la scala concedeva 19¢ e
      // l'uscita restava a 20¢, cioe' sopra un book a 16/18. Il permesso c'era, il prezzo no.
      // Qui l'uscita INSEGUE il mercato: si mira al miglior ask — dove un maker si mette per essere
      // preso — e si scende fin li', ma MAI sotto il pavimento della scala. I due limiti restano
      // entrambi: la scala dice quanto si puo' perdere, il book dice dove si viene presi.
      // ══ SI INSEGUE IL BID, NON L'ASK — corretto il 17 agosto 2026 ════════════════════════════════
      //
      // ⚠ QUI C'ERA `venue.bestAsk`, ED E' IL DIFETTO CHE HA RESO INESEGUIBILI 146 USCITE.
      // Il commento diceva «si mira al miglior ask — dove un maker si mette per essere preso», e per
      // una QUOTA e' vero. Per una VENDITA e' il lato sbagliato del libro: mettersi al miglior ask
      // significa mettersi in coda con gli altri venditori, e si viene presi solo se qualcuno
      // attraversa. **Il prezzo a cui si viene presi e' il BID.**
      // Misurato il 16 agosto su FL-02: gamba NO ferma a 51¢ con il bid a 47¢, gamba YES a 56¢ con il
      // bid a 52¢, **146 ordini in 2h36m, zero eseguiti**. L'inseguimento c'era e funzionava — mirava
      // 4-5¢ troppo in alto.
      //
      // ⚠ IL PAVIMENTO NON SI TOCCA, ed e' quello che impedisce a questa correzione di diventare una
      // svendita: `Math.max(pavimento, …)` resta dov'e'. Se il bid sta sotto il pavimento, l'uscita si
      // ferma al pavimento e NON e' colpibile — ed e' la risposta giusta, non un difetto: la scala
      // dice quanto si puo' perdere, il book dice dove si viene presi, e vince il piu' stretto.
      //
      // ⚠ E RESTA UN ORDINE `post-only`: al prezzo del bid un SELL incrocia, quindi il venue lo
      // rifiuterebbe. Attraversare di proposito e' una decisione di rischio separata e NON e' presa
      // qui — si veda la nota nel referto della sessione. Questa riga rende il prezzo GIUSTO; renderlo
      // ESEGUIBILE richiede il permesso di attraversare, che oggi ha solo la corsia manuale.
      const bidLato = rules.books && rules.books[book] && Number.isFinite(Number(rules.books[book].bestBid))
        ? Number(rules.books[book].bestBid)
        : (venue && Number.isFinite(Number(venue.bestBid)) ? Number(venue.bestBid) : null);
      const askOra = bidLato;
      const pavimento = Number.isFinite(pianoOra.pavimento) ? pianoOra.pavimento : null;
      // ⚠ SI INSEGUE SOLO DAL GRADINO 1 IN SU. Al gradino 0 la scala non ha concesso niente e
      // l'uscita sta a carico + profitPct: abbassarla li' vorrebbe dire rinunciare al guadagno prima
      // che la regola lo permetta. E' il gradino 1 che dice «l'uscita puo' scendere fino al carico»,
      // ed e' da li' che questo ramo comincia a lavorare.
      const gradino = urgenza && Number.isFinite(urgenza.livello) ? urgenza.livello : 0;
      const bersaglio = (pianoOra.ok && askOra !== null && pavimento !== null && gradino >= 1)
        ? Math.max(pavimento, Math.min(pianoOra.price, askOra))
        : (pianoOra.ok ? pianoOra.price : null);
      if (bersaglio !== null) {
        pianoOra.price = +bersaglio.toFixed(10);
        // ⚠ LA BANDIERA SEGUE IL PREZZO, non il piano di partenza. Abbassare il prezzo senza
        // ricalcolare `peggiorativa` renderebbe una vendita SOTTO IL CARICO indistinguibile nell'audit
        // da una in guadagno — ed e' esattamente la distinzione per cui quel campo esiste.
        pianoOra.peggiorativa = pianoOra.price < entry - 1e-9;
      }
      if (pianoOra.ok && piuBasso !== null && Number.isFinite(tick) && tick > 0
        && pianoOra.price < piuBasso - tick / 2) {
        return out('close', 'uscita-da-abbassare',
          `l'uscita a riposo è a ${(piuBasso * 100).toFixed(2)}¢ ma la scala ora concede`
          + ` ${(pianoOra.price * 100).toFixed(2)}¢ (${pianoOra.reason}): un ordine appeso sopra il mercato`
          + ' non è un\'uscita. Si cancella e si riprezza — solo verso il basso.',
          { price: pianoOra.price, size: coveredSize, entryPrice: entry,
            profitCents: +((pianoOra.price - entry) * 100).toFixed(3),
            peggiorativa: pianoOra.peggiorativa === true,
            urgenzaLivello: urgenza ? urgenza.livello : null,
            urgenzaMin: urgenza ? urgenza.minuti : null,
            tickConcessi: Number.isFinite(pianoOra.tickConcessi) ? pianoOra.tickConcessi : 0,
            prezzoPrecedente: piuBasso,
            // Gli stessi due ingressi del ramo ordinario: il permesso di attraversare si valuta a valle.
            pavimentoUscita: pavimento, bidLato,
            cancelOrderIds: covering.map((o) => o.orderId).filter(Boolean) });
      }
    }
    return out('already-covered', null,
      `già coperta: ${covering.length} ordine/i di vendita a riposo per ${coveredSize} share contro una posizione di ${size}. ${verdetto.reason}`,
      { size, coveredSize, bandLo: verdetto.bandLo, bandHi: verdetto.bandHi, waitedMs: verdetto.waitedMs,
        // GLI ID DELLE USCITE CHE COPRONO, anche su questo ramo. Servono al tentativo di completamento
        // della coppia: se il merge conviene, quelle uscite vanno tolte PRIMA di comprare l'altro lato,
        // altrimenti si comprerebbe e si venderebbe insieme. Prima questo ramo non li portava, e il
        // completamento non era nemmeno tentabile qui — cioè «c'è già un'uscita a riposo» era di fatto
        // un modo di saltare la gerarchia del merge.
        cancelOrderIds: covering.map((o) => o.orderId).filter(Boolean) });
  }

  // The remaining size to cover — partials are handled by construction.
  const toClose = +(size - coveredSize).toFixed(6);
  const scoringMid = book === 'no' ? rules.books.no.scoringMid : rules.books.yes.scoringMid;

  // IL PIANO DI USCITA. Non piu' un target a centesimi fissi: obiettivo +1% sul carico, tenuto DENTRO
  // la banda premiante (cosi' l'attesa matura invece di essere gratis per il mercato), e fermato al 4%
  // sotto il carico — oltre quel punto non si insegue piu' il prezzo verso il basso.
  // ⚠ I DUE PARAMETRI DELLA SCALA DI URGENZA, E LA RAGIONE PER CUI SONO DUE. `profitPct: 0` autorizza
  // il PAREGGIO (gradino 2); `concessioneTick` autorizza una perdita LIMITATA e dichiarata (gradino 3).
  // Sono due concessioni diverse e si aprono in due momenti diversi, perche' uscire in pareggio non e'
  // perdere: e' smettere di pretendere un guadagno da una posizione che il mercato ha gia' superato.
  const plan = planExit({
    entryPrice: entry, scoringMid, tick: rules.tick,
    bandRadiusCents: Number.isFinite(rules.maxSpreadCents) ? raggioBandaCents(rules.maxSpreadCents) : null,
    ...(urgenza && Number.isFinite(urgenza.profitPct) ? { profitPct: urgenza.profitPct } : {}),
    ...(urgenza && Number.isFinite(urgenza.concessioneTick) ? { concessioneTick: urgenza.concessioneTick } : {}),
  });
  if (!plan.ok) {
    // Il gradino di urgenza viaggia nel verdetto anche quando NON e' bastato: «no-target dopo aver
    // concesso due tick» e «no-target senza aver concesso niente» sono due fatti diversi, e chi legge
    // l'audit deve poterli distinguere senza rifare il conto.
    return out('skip', 'no-target', plan.reason,
      { urgenzaLivello: urgenza ? urgenza.livello : null, urgenzaMin: urgenza ? urgenza.minuti : null,
        pavimento: plan.pavimento != null ? plan.pavimento : null,
        tickConcessi: plan.tickConcessi != null ? plan.tickConcessi : null });
  }
  // `peggiorativa` NON e' cosmetica: e' il segnale che questa uscita accetta una perdita, e senza di
  // esso una chiusura sotto il carico sarebbe indistinguibile nell'audit da una in guadagno.
  const target = { price: plan.price, profitCents: +((plan.price - entry) * 100).toFixed(3), reason: plan.reason,
    peggiorativa: plan.peggiorativa === true,
    urgenzaLivello: urgenza ? urgenza.livello : null,
    urgenzaMin: urgenza ? urgenza.minuti : null,
    tickConcessi: Number.isFinite(plan.tickConcessi) ? plan.tickConcessi : 0 };

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
      bandLoPrice: plan.bandLo, bandHiPrice: plan.bandHi,
      // ── I DUE NUMERI CHE SERVONO A DECIDERE SE ATTRAVERSARE — 17 agosto 2026 ────────────────
      // Il permesso di attraversare lo valuta chi ESEGUE, non chi decide il prezzo: qui si producono
      // solo i due ingressi, cosi' l'esecutore non deve ricalcolarli (e non puo' calcolarli diversi).
      // `pavimentoUscita` e' il minimo che la scala concede a questo gradino; `bidLato` e' il prezzo
      // a cui si viene presi. Entrambi possono essere `null`, e `null` fa rifiutare l'attraversamento.
      pavimentoUscita: Number.isFinite(plan.pavimento) ? plan.pavimento : null,
      bidLato: (rules.books && rules.books[book] && Number.isFinite(Number(rules.books[book].bestBid)))
        ? Number(rules.books[book].bestBid)
        : (venue && Number.isFinite(Number(venue.bestBid)) ? Number(venue.bestBid) : null),
      urgenzaLivello: urgenza && Number.isFinite(urgenza.livello) ? urgenza.livello : null });
}

/**
 * IL COMPLETAMENTO DELLA COPPIA — UN SOLO POSTO, CHIAMATO DA OGNI RAMO.
 *
 * ═══ PERCHE' ESISTE COME FUNZIONE ════════════════════════════════════════════════════════════════════
 * Fino all'8 agosto 2026 il tentativo di completare la coppia viveva in UN ramo solo del ciclo — quello
 * appena prima dell'uscita ordinaria. Tutti gli altri rami arrivavano prima e facevano `continue`:
 *   · `already-covered`  (c'e' gia' un'uscita a riposo)  → il merge non veniva nemmeno valutato
 *   · `close-at-market`  (l'attesa ha superato le 24h)   → idem, e per costruzione
 * Cioe' la gerarchia «prima si prova a completare la coppia, poi si vende» era vera solo su un percorso
 * su tre, e i due percorsi che la saltavano erano proprio quelli in cui una posizione stava ferma da
 * piu' tempo. Su Schwartzel FL-19 il Livello 1 era calcolato, conveniente (coppia a 98,8¢) e
 * irraggiungibile per ventiquattro ore di seguito.
 *
 * Estrarla in una funzione sola e chiamarla da TUTTI i rami rende la precedenza una proprieta' del
 * codice invece di una promessa in un commento.
 *
 * ═══ LA DISCIPLINA CHE NON CAMBIA ═══════════════════════════════════════════════════════════════════
 * Comprare il secondo lato mentre un'uscita sul primo e' a riposo significa pagare per completare una
 * coppia che si sta contemporaneamente smontando. Quindi: le uscite a riposo si TOLGONO PRIMA, e se
 * anche una sola cancellazione non riesce NON si compra niente. E' la stessa regola della chiusura a
 * mercato, applicata alla stessa lista di ordini, con lo stesso verso di fallimento.
 *
 * ═══ E IL LIVELLO 1 SI PUO' PRENDERE ANCHE DOPO ═════════════════════════════════════════════════════
 * Un'attesa gia' aperta non congela piu' la decisione. Se mentre il Livello 2 riposa l'ask dell'altro
 * lato scende dentro il tetto, il Livello 1 diventa disponibile: si cancella il completamento a riposo
 * e si prende l'ask, che e' il senso di «piu' aggressivo verso il completamento». Se l'ask non scende,
 * non succede niente e l'attesa prosegue col suo orologio.
 *
 * @returns {{esito:'piazzato'|'in-attesa'|'rinuncia'|'cancellazione-fallita'|'non-applicabile',
 *            motivo:string, livello:(1|2|null), prezzo:number|null, size:number|null, orderId:string|null}}
 */
/**
 * LA FUSIONE ON-CHAIN DI UNA COPPIA COMPLETA. È l'ultimo passo della gerarchia del merge, e l'unico
 * che libera capitale ADESSO invece che alla risoluzione.
 *
 * ═══ COSA FA, E PERCHÉ NON È UN ORDINE ══════════════════════════════════════════════════════════
 * `mergePositions` sul ConditionalTokens converte N YES + N NO in N dollari di collaterale. Non passa
 * dal book, non ha controparte, non ha slippage e non attraversa nessuno spread: è una conversione di
 * qualcosa che è già nostro. Il gas lo paga il relayer di Polymarket (gasless), quindi il costo è zero
 * anche se il funder non ha MATIC — che era il blocco storico.
 *
 * ═══ IL CONFINE NON SI ALLARGA ═════════════════════════════════════════════════════════════════
 * `ctf-relayer` resta il modulo isolato che era: costruisce UNA chiamata sola, la ri-decodifica prima
 * di firmare (`verificaConfinamento`) e rifiuta qualunque target che non sia uno dei due adapter CTF.
 * Da qui si chiama la sua funzione pubblica, non se ne aggira nessuna: il wiring aggiunge un
 * CHIAMANTE, non una capacità.
 *
 * ═══ FAIL-CLOSED, IN OGNI DIREZIONE ════════════════════════════════════════════════════════════
 *   · `negRisk` non booleano ⇒ non si tenta. Decide QUALE adapter riceve la chiamata, e con quello
 *     sbagliato la transazione reverte senza dire perché. Non si indovina — è la stessa regola con cui
 *     `resolveMarketRules` rifiuta un mercato senza negRisk letto.
 *   · size non finita o ≤ 0 ⇒ non si tenta.
 *   · `CTF_RELAYER_ENABLED` false ⇒ `esegui` non firma e non invia: restituisce il piano con
 *     `eseguito:false`, che qui vale «non riuscito», quindi ripiego pulito.
 *   · qualunque eccezione (relayer giù, nonce, HTTP, timeout) ⇒ `ok:false` col motivo. MAI un'azione
 *     a metà: o la coppia è fusa on-chain, o non è successo niente.
 *
 * @returns {Promise<{ok:boolean, motivo:string, size:number|null, transactionHash:string|null}>}
 */
async function fondiCoppia({ marketId, rules, size, deps = {}, audit = () => {}, t0 = Date.now(), book = null }) {
  const no = (motivo) => ({ ok: false, motivo, size: null, transactionHash: null });
  const negRisk = rules && typeof rules.negRisk === 'boolean' ? rules.negRisk : null;
  if (negRisk === null) return no('negRisk non leggibile: l\'adapter CTF non si indovina');
  if (!Number.isFinite(size) || !(size > 0)) return no(`size della coppia non utilizzabile (${size})`);

  // Iniettabile: i test guidano la fusione senza rete, e il modulo del relayer resta importato in un
  // punto solo. `require` differito per la stessa ragione per cui l'header di ctf-relayer insiste
  // sull'isolamento: chi non fonde non lo carica nemmeno.
  //
  // ═══ IL FIRMATARIO VA PASSATO, E FINO AL 9 AGOSTO 2026 NON LO ERA ══════════════════════════════
  // Questa riga costruiva `{ negRisk }` e basta. `esegui` riceveva quindi `deps = {}` e moriva alla
  // firma su `await deps.signerProvider()` — «deps.signerProvider is not a function» — DOPO aver
  // costruito l'operazione e DOPO aver letto il nonce dal relayer. Misurato su Dallas (cid_a7245f90…)
  // il 9 agosto: 21 tentativi in 21 minuti, 21 righe `fase:'intento'` nel giornale e ZERO righe
  // `fase:'esito'`, perche' l'eccezione arrivava prima. Il difetto non era nel merge — la coppia era
  // rilevata completa a ogni giro, `azione:'merge'`, `eseguito:true` — era nel cablaggio.
  //
  // E' LA STESSA FONTE DELLA CORSIA MANUALE, non una seconda custodia: `manual-order.js:730` chiama
  // `makerLiveProviders()` di `live-providers.js:69` per firmare gli ordini, e qui si chiama la stessa
  // funzione. Verificato on-chain il 9 agosto, sola lettura: il SIGNER in custodia e
  // `POLYMARKET_RELAYER_API_KEY_ADDRESS` sono lo STESSO indirizzo (0x7bd09f34…85d3), che e' l'owner del
  // funder 0x4C81F1…bdee dove stanno i token da fondere. Stesso wallet, stesso scopo.
  //
  // E SE UN GIORNO DIVERGESSERO? Non serve un controllo qui: `ctf-relayer.js:415-417` ricava
  // l'indirizzo dalla chiave e rifiuta di firmare se non coincide con quello delle credenziali. Un
  // secondo controllo in questo punto sarebbe una seconda verita' da tenere allineata.
  //
  // SI PASSA SOLO `signerProvider`. E' l'unica dep che `esegui` chiede per firmare: le intestazioni del
  // relayer se le prende da `.env` per conto suo (`credenziali()`), e `credsProvider` e' della corsia
  // ordini — qui non ha uso, e una chiave in piu' nell'oggetto sarebbe superficie senza scopo. Il
  // `require` e' differito insieme all'altro: chi non fonde non carica nemmeno la custodia.
  const fondi = deps.mergeOnChain
    || ((a) => require('./ctf-relayer').mergePosition(a.marketId, a.size, {
      negRisk: a.negRisk,
      deps: { signerProvider: require('./live-providers').makerLiveProviders().signerProvider },
    }));

  let r = null;
  try { r = await fondi({ marketId, size, negRisk }); }
  catch (e) {
    const motivo = e && e.message ? e.message : String(e);
    audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
      outcome: 'merge-onchain-fallito', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
      reason: motivo, observed: { book, size, negRisk } });
    return no(motivo);
  }
  if (!r || r.eseguito !== true) {
    const motivo = (r && r.motivo) || 'esito del relayer non leggibile';
    audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
      outcome: 'merge-onchain-non-eseguito', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
      reason: motivo, observed: { book, size, negRisk, adapter: r && r.piano && r.piano.adapter } });
    return no(motivo);
  }
  const hash = r.transactionHash || null;
  audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
    outcome: 'merge-onchain-eseguito', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
    reason: `coppia di ${size} share fusa: $${size.toFixed(2)} di collaterale tornano liquidi subito`,
    observed: { book, size, negRisk, transactionID: r.transactionID || null, transactionHash: hash, stato: r.stato || null } });
  return { ok: true, motivo: null, size, transactionHash: hash };
}

/**
 * RIMETTERE IL CAPITALE AL LAVORO SUBITO DOPO UNA FUSIONE (9 agosto 2026).
 *
 * ═══ IL BUCO CHE CHIUDE ═════════════════════════════════════════════════════════════════════════════
 * Dopo un merge on-chain la coppia sparisce e il collaterale torna liquido. Fin qui il ramo faceva
 * `continue`: il capitale tornava genericamente disponibile e restava fermo fino al mini-ciclo
 * successivo — dieci minuti nel caso buono, sei ore se il piano non lo sceglieva. E lo faceva proprio
 * sul mercato su cui avevamo appena dimostrato di saper operare.
 *
 * ═══ COSA FA, E COSA NON PUO' FARE ══════════════════════════════════════════════════════════════════
 * Propone due gambe di liquidita' — BUY YES e BUY NO — un tick DIETRO il miglior bid di ciascun lato,
 * che e' la stessa regola del motore. Non decide se sono ammissibili: quello lo decidono i gate a valle,
 * gli stessi di sempre e senza eccezioni — `mai-primo-sul-libro`, la banda premiante, fine scala, il
 * tetto per ordine, il kill. Qui si propone; la' si giudica.
 *
 * ═══ NIENTE LOOP, E LA GARANZIA E' STRUTTURALE ══════════════════════════════════════════════════════
 * Si tenta UNA volta, come ultimo passo della chiusura che l'ha resa possibile. Se le gambe vengono
 * rifiutate il capitale resta liquido e la decisione torna al ciclo normale: non c'e' nessun ritentativo
 * qui dentro, e non ci puo' essere, perche' la funzione non ha un ciclo — viene chiamata da un merge, e
 * un merge sullo stesso mercato non si ripete (la coppia non c'e' piu').
 *
 * ═══ E SE IL MERCATO NON E' PIU' BUONO ══════════════════════════════════════════════════════════════
 * Non ci si riposiziona. Le condizioni si rileggono ADESSO, non si assumono da quando il mercato era
 * stato scelto: regole leggibili, tocco leggibile, tick leggibile. Il resto — banda, scadenza, fine
 * scala — vive nei gate e li' viene applicato. Un dato mancante vale «non riposizionare», mai «prova lo
 * stesso»: dopo una fusione il capitale e' al sicuro, e lasciarlo liquido un giro non costa niente.
 */
async function riposizionaDopoChiusura({ marketId, rules, capitaleUsd, deps = {}, audit = () => {}, t0 = Date.now() }) {
  const no = (motivo) => ({ ok: false, motivo, gambe: [] });
  if (!RIPOSIZIONA_DOPO_CHIUSURA) return no('riposizionamento spento');
  if (!rules || rules.readable !== true) return no('regole di venue non leggibili adesso: non ci si riposiziona su un mercato che non si sa piu\' giudicare');
  const tick = Number(rules.tick);
  const minSize = Number(rules.minSize);
  if (!Number.isFinite(tick) || tick <= 0) return no('tick non leggibile: nessun prezzo viene indovinato');
  if (!Number.isFinite(capitaleUsd) || capitaleUsd <= 0) return no('capitale liberato non quantificabile');

  const gambe = [];
  for (const lato of ['yes', 'no']) {
    const b = rules.books && rules.books[lato];
    const bid = b && Number(b.bestBid);
    if (!Number.isFinite(bid) || bid <= 0) return no(`miglior bid di ${lato.toUpperCase()} non leggibile: le due gambe si propongono insieme o non si propongono`);
    // UN TICK DIETRO, mai sopra: e' la regola del motore, ed e' la stessa frase con cui
    // `mai-primo-sul-libro` motiva i suoi rifiuti. Se cosi' si esce dalla banda, il gate lo dira'.
    const prezzo = +(Math.floor((bid - tick + 1e-9) / tick) * tick).toFixed(6);
    if (!(prezzo > 0)) return no(`un tick dietro il miglior bid di ${lato.toUpperCase()} darebbe ${prezzo}: non e' un prezzo`);
    gambe.push({ book: lato, prezzo });
  }
  // Il capitale si divide fra le due gambe: una coppia sbilanciata sarebbe esattamente l'esposizione
  // direzionale da cui la fusione ci ha appena tolti.
  const perLato = capitaleUsd / 2;
  for (const g of gambe) {
    g.size = +(perLato / g.prezzo).toFixed(2);
    if (Number.isFinite(minSize) && g.size < minSize) {
      return no(`con $${capitaleUsd.toFixed(2)} le gambe sarebbero di ${g.size} share, sotto il minimo del venue (${minSize})`);
    }
  }

  const fatte = [];
  for (const g of gambe) {
    let r;
    try {
      r = await deps.placeOrder({ marketId, book: g.book, side: 'BUY', price: g.prezzo, size: g.size,
        inCoda: true, source: AUTO_CLOSE_SOURCE,
        note: `riposizionamento dopo chiusura: ${g.size} share di ${g.book.toUpperCase()} a ${g.prezzo}`
          + ` — il capitale liberato dalla fusione torna a fare liquidita' sullo stesso mercato` });
    } catch (e) { r = { ok: false, gate: 'exception', reason: e.message }; }
    const rok = !!(r && r.ok);
    audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
      outcome: rok ? 'riposizionamento-piazzato' : `riposizionamento-reject-${(r && r.gate) || 'venue'}`,
      marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
      reason: rok ? null : ((r && r.reason) || 'piazzamento non riuscito'),
      requested: { book: g.book, side: 'BUY', price: g.prezzo, size: g.size },
      gate: (r && r.gate) || null, observed: { capitaleUsd, tick, minSize } });
    if (rok) fatte.push({ ...g, orderId: (r && r.orderId) || null });
  }
  // UNA GAMBA SOLA NON E' UN RIPOSIZIONAMENTO: e' la stessa esposizione direzionale da cui si e' appena
  // usciti. Se ne passa una sola la si RITIRA, e il capitale torna al ciclo normale.
  if (fatte.length === 1 && typeof deps.cancelOrder === 'function' && fatte[0].orderId) {
    try { await deps.cancelOrder({ orderId: fatte[0].orderId, marketId }); } catch { /* al giro dopo lo vede il watchdog */ }
    return no('una sola gamba e passata: ritirata, il capitale torna al ciclo normale invece di restare direzionale');
  }
  if (fatte.length !== 2) return no('nessuna gamba di riposizionamento e passata: il capitale torna al ciclo normale');
  return { ok: true, motivo: `riposizionato: ${fatte.map((f) => `${f.book.toUpperCase()} ${f.size}@${f.prezzo}`).join(' + ')}`, gambe: fatte };
}

// ══ IL PIAZZAMENTO DI CHIUSURA RIPROVA, CON BACKOFF ══════════════════════════════════════════════
// Decisione dell'operatore, 12 agosto 2026: «riprova sempre». Vale per i percorsi di CHIUSURA e per
// nessun altro — un ordine di liquidita' rifiutato puo' aspettare il ciclo dopo senza che nulla peggiori,
// una posizione scoperta no: ogni secondo in piu' e' esposizione direzionale che nessuno ha scelto.
//
// ═══ SI RIPROVA SOLO CIO' CHE HA SENSO RIPROVARE, ED E' LA PARTE CHE EVITA IL RUMORE ══════════════
// La corsia manuale risponde con un `gate` quando a rifiutare e' una NOSTRA regola (tetto, allowlist,
// banda, mai-primo, duplicato). Quelle decisioni non cambiano fra un tentativo e l'altro dentro lo
// stesso ciclo: ritentarle sarebbe martellare il proprio codice, non il venue. Si riprova quindi solo
// quando il rifiuto viene dal VENUE — `gate` assente, `'venue'` o un'eccezione di rete — che e'
// esattamente cio' che `classificaErrore` sa distinguere.
//
// ⚠ L'ESITO AMBIGUO NON SI RIPROVA MAI. Se la richiesta era gia' partita, l'ordine puo' essere a riposo
// al venue: ritentare alla cieca e' il modo classico di ritrovarsi due ordini da un'intenzione sola.
// `classificaErrore` lo dichiara (`ritentabileAllaCieca:false`) e qui ci si ferma — la stessa dottrina
// per cui l'invio dell'adapter non e' avvolto in `withRetry`.
//
// ═══ IL KILL RESTA SOVRAORDINATO ═════════════════════════════════════════════════════════════════
// Si rilegge PRIMA di ogni ritentativo, non solo all'inizio del ciclo: fra un tentativo e l'altro
// possono passare secondi, e in quei secondi l'operatore puo' aver premuto il KILL. Un kill attivo
// ferma la sequenza SUBITO. Non e' l'unico presidio e non pretende di esserlo — il gate vero sta a
// valle e rifiuterebbe comunque; questo evita di continuare a bussare a una porta appena chiusa.
const TENTATIVI_CHIUSURA = 3;
async function piazzaChiudendo(spec, { deps, audit, t0, etichetta }) {
  const rif = `cid_${String(spec.marketId).replace(/^0x/, '')}`;
  let ultimo = null;
  for (let tentativo = 1; tentativo <= TENTATIVI_CHIUSURA; tentativo += 1) {
    if (tentativo > 1) {
      let killed = false;
      try { killed = typeof deps.killStatus === 'function' ? deps.killStatus().killed === true : false; }
      catch { killed = false; }
      if (killed) {
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: `${etichetta}-ritentativo-fermato-dal-kill`, marketRef: rif,
          reason: `KILL attivo: la sequenza di ritentativi si ferma al tentativo ${tentativo} di ${TENTATIVI_CHIUSURA}`,
          observed: { tentativo, ultimoGate: ultimo && ultimo.gate } });
        return ultimo || { ok: false, gate: 'kill', reason: 'kill attivo durante la sequenza di ritentativi' };
      }
      const a = attesaBackoff({ tentativo: tentativo - 1, status: ultimo && ultimo.status, now: t0 });
      await new Promise((r) => setTimeout(r, a.attesaMs));
    }
    let r;
    try { r = await deps.placeOrder(spec); }
    catch (e) { r = { ok: false, gate: 'exception', reason: e && e.message ? e.message : String(e) }; }
    if (r && r.ok) {
      if (tentativo > 1) {
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: `${etichetta}-riuscito-al-ritentativo`, marketRef: rif,
          reason: `piazzato al tentativo ${tentativo} di ${TENTATIVI_CHIUSURA}, dopo ${tentativo - 1} rifiuto/i del venue`,
          observed: { tentativo } });
      }
      return r;
    }
    ultimo = r || { ok: false, gate: 'venue', reason: 'nessuna risposta dal piazzamento' };
    const daVenue = !ultimo.gate || ultimo.gate === 'venue' || ultimo.gate === 'exception';
    const cls = classificaErrore({ inviata: ultimo.sent === true || ultimo.ambiguous === true,
      status: ultimo.status, messaggio: ultimo.reason || '' });
    const riprovabile = daVenue && cls.ritentabileAllaCieca === true && tentativo < TENTATIVI_CHIUSURA;
    // OGNI FALLIMENTO A VERBALE, col motivo: «quante volte il venue ha rifiutato una chiusura» deve
    // essere una domanda con una risposta, e senza questa riga sarebbe indistinguibile da un solo
    // rifiuto finale.
    audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
      outcome: `${etichetta}-tentativo-fallito`, marketRef: rif, gate: ultimo.gate || null,
      reason: `tentativo ${tentativo}/${TENTATIVI_CHIUSURA} fallito: ${ultimo.reason || 'motivo non dichiarato'}`
        + ` — ${riprovabile ? 'si riprova' : `non si riprova (${daVenue ? cls.motivo : 'rifiuto di un nostro gate: non cambia entro il ciclo'})`}`,
      observed: { tentativo, tipo: cls.tipo, daVenue } });
    if (!riprovabile) return ultimo;
  }
  return ultimo;
}

async function completaCoppia({
  marketId, tok, book, rules, liv, dpMerge = null, attesa = null, chiaveMerge, reg = null,
  cancelOrderIds = [], prezzoCarico = null, deps = {}, audit = () => {}, t0 = Date.now(),
  // Gli ordini a riposo del mercato, GIA' letti dal ciclo (`resting.orders`). Passati e non riletti:
  // una seconda lettura del venue potrebbe divergere dalla prima, e qui la divergenza deciderebbe
  // quali ordini cancellare.
  ordiniMercato = null,
}) {
  const altroBook = book === 'yes' ? 'no' : 'yes';
  const tokAltro = book === 'yes' ? (rules && rules.tokenIdNo) : (rules && rules.tokenId);
  const nonApplicabile = (motivo) => ({ esito: 'non-applicabile', motivo, livello: null, prezzo: null, size: null, orderId: null });

  // ══ ANTI-SELF-TRADE SUI PERCORSI TAKER (12 agosto 2026) ═══════════════════════════════════════
  // Il guard che esisteva copriva UN percorso solo: `close-at-market`, che prima di vendere al bid
  // cancella i nostri BUY di liquidita' su quel lato (`decideClose`, gate anti-auto-incrocio). I
  // percorsi taker di QUESTO file non ne avevano nessuno: leggevano `dpMerge[…].asks` e `.bids`
  // GREZZI, cioe' una scala che contiene anche i nostri ordini. Un taker prezzato sul miglior ask
  // puo' quindi eseguirsi contro il nostro stesso ask, e il fill che ne nasce e' fantasma — crea una
  // posizione che innesca un altro ciclo di chiusura, che compra di nuovo contro cio' che resta.
  //
  // Il venue non ci protegge: la self-trade prevention del CLOB non e' documentata e non e' stata
  // trovata ne' nell'API ne' nelle pagine ufficiali (lib/maker/inventory-guard.js:27).
  //
  // NON SI COSTRUISCE UN SECONDO MECCANISMO: si riusa `othersLadder` — la STESSA funzione con cui il
  // motore di piazzamento sottrae i propri ordini per «mai primo sul libro» — sugli ordini a riposo
  // che il ciclo ha GIA' letto. Nessuna lettura nuova del venue.
  //
  // FAIL-CLOSED, e in una direzione sola: se la scala non e' leggibile o il tick manca, `othersLadder`
  // risponde `readable:false` e si torna alla scala grezza — cioe' al comportamento di prima. Non si
  // inventa una scala vuota, che direbbe «non c'e' nessuno» proprio quando non lo sappiamo, e non si
  // blocca la chiusura per un dato mancante.
  const nostriSuToken = (tokenId, lato) => (Array.isArray(ordiniMercato) ? ordiniMercato : [])
    .filter((o) => o && String(o.tokenId) === String(tokenId)
      && String(o.side || '').toUpperCase() === lato)
    .map((o) => ({ orderId: o.orderId, price: Number(o.price),
      size: Number(o.sizeRemaining != null ? o.sizeRemaining : o.size) }))
    .filter((o) => Number.isFinite(o.price) && Number.isFinite(o.size) && o.size > 0);

  // L'arrotondamento GIU' al tick, lo stesso che `alTick` applica piu' sotto: qui serve prima che
  // `alTick` sia in scope, e un secondo verso di arrotondamento sforerebbe il tetto della coppia.
  const giuAlTickLocale = (x) => {
    const tk = Number(rules && rules.tick);
    return (Number.isFinite(tk) && tk > 0 && Number.isFinite(x)) ? +(Math.floor((x + 1e-9) / tk) * tk).toFixed(6) : x;
  };

  // La scala di un lato del book TOLTI I NOSTRI ordini. `verso` e' 'asks' (i nostri sono SELL) o
  // 'bids' (i nostri sono BUY).
  const scalaAltrui = (qualeBook, verso) => {
    const grezza = dpMerge && dpMerge[qualeBook] && Array.isArray(dpMerge[qualeBook][verso])
      ? dpMerge[qualeBook][verso] : null;
    if (!grezza) return null;
    const tokenDelBook = qualeBook === book ? tok : tokAltro;
    const nostri = nostriSuToken(tokenDelBook, verso === 'asks' ? 'SELL' : 'BUY');
    if (!nostri.length) return grezza;
    try {
      const L = othersLadder({ levels: grezza, ownOrders: nostri, tick: Number(rules && rules.tick) });
      return L.readable === true ? L.levels : grezza;
    } catch { return grezza; }
  };

  // ── IL CANALE UNICO VERSO IL REGISTRO DEI RESIDUI (regola generale, punto 3) ────────────────────
  // Una funzione sola, chiamata da tutti gli esiti terminali, invece di tre chiamate sparse che possono
  // divergere. Non è iniettata ⇒ non succede niente: il registro è un'osservazione, non un gate, e un
  // ciclo che non lo ha cablato deve comportarsi ESATTAMENTE come prima.
  //
  // `quanto` è l'INTERA quantità scoperta di QUESTO lato adesso (`manca` = sizePosseduta −
  // sizeAltroLato), mai un incremento: il registro tiene l'ultima osservazione, non una somma, perché
  // sommare due misure della stessa cosa la conterebbe due volte. Un valore ≤ 0 CHIUDE la voce — è così
  // che uno scoperto rientrato smette di comparire, senza bisogno di un percorso apposta.
  const segnalaScoperto = (quanto, causa) => {
    if (typeof deps.registraResiduo !== 'function') return;
    try {
      deps.registraResiduo({
        marketId, book, sizeScoperta: Number.isFinite(quanto) ? quanto : null,
        minSize: rules && Number.isFinite(rules.minSize) ? rules.minSize : null,
        causa, prezzoCarico, t0,
      });
    } catch { /* un'osservazione che non riesce non deve poter fermare la gestione di una posizione */ }
  };

  if (!MERGE_STRATEGY_ENABLED) return nonApplicabile(`merge spento: ${MERGE_DISABLED_REASON}`);

  // ══ IL VERDETTO DELLA CHIUSURA FORZATA SI CALCOLA QUI, PRIMA DELLA GUARDIA DI LIVELLO ═══════════
  // ⚠ DIFETTO MISURATO IL 12 AGOSTO 2026, e non era il numero: era la POSIZIONE nel file.
  // Il verdetto stava piu' sotto, DOPO la guardia che esce per qualunque livello diverso da 1 o 2. Ma
  // il livello 3 — «il tempo da maker e' finito, si ripiega sull'uscita classica» — e' l'esito PIU'
  // COMUNE: **1.119 occorrenze** di `merge-livello-3` sui due giornali maker. Su tutte quelle la
  // chiusura forzata non veniva nemmeno VALUTATA. Una regola che dice «entro 3 ore dalla risoluzione
  // si chiude a qualunque prezzo» non puo' dipendere da quale ramo del merge si sta percorrendo.
  //
  // E `manca` va DERIVATO, non letto: `mancaAllaCoppia` lo scrive il ramo del Livello 2, quindi al
  // livello 3 arrivava `undefined` ⇒ `null` ⇒ `forza:false` anche a scadenza vicina. La sottrazione e'
  // la stessa che `decidiLivello` fa per conto suo, e i due addendi sono in `numeri` a OGNI livello.
  const numeriLiv = (liv && liv.numeri) || {};
  const mancaOra = Number.isFinite(Number(numeriLiv.mancaAllaCoppia))
    ? Number(numeriLiv.mancaAllaCoppia)
    : (Number.isFinite(Number(numeriLiv.sizePosseduta)) && Number.isFinite(Number(numeriLiv.sizeAltroLato))
      ? +(Number(numeriLiv.sizePosseduta) - Number(numeriLiv.sizeAltroLato)).toFixed(6)
      : null);
  const forza = MC.chiusuraForzataPreScadenza({
    scadenzaMs: typeof deps.scadenzaMercato === 'function' ? deps.scadenzaMercato(marketId) : null,
    manca: mancaOra, ora: t0,
  });

  // ⚠ LA GUARDIA NON ESCE PIU' QUANDO LA CHIUSURA FORZATA DEVE SCATTARE. Per ogni altro caso il
  // comportamento e' identico a prima: si segnala lo scoperto e si esce.
  if (!forza.forza && (!liv || (liv.livello !== 1 && liv.livello !== 2))) {
    // ── IL LIVELLO 3 È UN ESITO TERMINALE, E FINO AL 9 AGOSTO 2026 USCIVA DI QUI IN SILENZIO ───────
    // Misurato su London 19°C (`cid_cf92c777`): il Livello 2 era scaduto da 546 minuti contro un limite
    // di 60, il completamento veniva cancellato, e la posizione restava scoperta di 21,18 share NO senza
    // che il registro dei lati scoperti ne sapesse niente — perche' questo `return` sta PRIMA di
    // `segnalaScoperto`. Il principio del punto 54 dice «qualunque lato scoperto, qualunque causa»: un
    // timeout e' una causa come le altre, e questa e' la riga che glielo fa rispettare.
    segnalaScoperto(Number(liv && liv.numeri && liv.numeri.mancaAllaCoppia), `non-applicabile · livello ${liv && liv.livello}`);
    return nonApplicabile(liv ? `livello ${liv.livello}: non c'e' una coppia da completare` : 'livello non calcolato');
  }
  // FAIL-CLOSED SENZA REGISTRO. Senza la memoria dell'attesa il Livello 2 non ha scadenza e
  // ripiazzerebbe il completamento a ogni ciclo: due difetti che si sommano.
  // ⚠ NON blocca una CHIUSURA FORZATA: il registro serve al timeout del Livello 2, e una chiusura a
  // scadenza non ha nessun timeout da rispettare. Bloccarla qui vorrebbe dire lasciare una posizione
  // scoperta a due ore dalla risoluzione per un registro non cablato.
  if (!reg && !forza.forza) {
    return { esito: 'rinuncia', livello: liv.livello, prezzo: null, size: null, orderId: null,
      motivo: 'nessun registro delle attese iniettato: il timeout del Livello 2 non sarebbe applicabile e il completamento verrebbe ripiazzato a ogni ciclo' };
  }

  // ══ FASE 1 DELLA MODALITA' CHIUSURA · IL TIMESTAMP, E IL RESIDUO CHE SPARISCE ═══════════════════
  // Ordine deciso da Diego l'11 agosto 2026, e le due cose stanno QUI — prima di ogni tentativo —
  // perche' nessuna delle due dipende dall'esito dei tentativi:
  //   · il TIMESTAMP e' l'istante del fill, non l'istante in cui abbiamo rinunciato a chiudere in fretta;
  //   · le share NON FILLATE si cancellano IN OGNI CASO, «indipendentemente dall'esito del tentativo
  //     immediato» (requisito, punto 4). Se restassero, il ciclo di riprezzo continuerebbe a rinnovarle
  //     e potrebbero riempirsi ancora, spostando il bersaglio che stiamo cercando di centrare.
  // Le REGOLE di prezzo speciali NON si aprono qui: quelle sono la fase 2, e le apre solo il fallimento
  // del tentativo immediato (piu' sotto, nel ciclo dei tentativi).
  const fill = classificaFill({
    sizePosseduta: Number(liv.numeri && liv.numeri.sizePosseduta),
    sizeAltroLato: Number(liv.numeri && liv.numeri.sizeAltroLato),
  });
  const chi = deps.chiusura && typeof deps.chiusura.entra === 'function' ? deps.chiusura : null;
  let statoChiusura = { attiva: false, regoleAttive: false, daIso: null, nuova: false };
  // I RESIDUI SI CALCOLANO PRIMA DI ENTRARE, e per una ragione precisa: e' il LIBRO a dire se l'ordine
  // e' stato eseguito in parte o per intero (`fillOrdine`), e quell'etichetta va registrata insieme al
  // timestamp. `residuiDaCancellare` e' puro — guardarlo prima non cancella niente.
  const resid = MC.residuiDaCancellare({ ordini: ordiniMercato,
    tokenIdPosseduto: tok, tokenIdSorella: book === 'yes' ? rules.tokenIdNo : rules.tokenId });
  if (chi && (fill.tipo === FILL_PARZIALE || fill.tipo === FILL_COMPLETO)) {
    try {
      const e = chi.entra({ marketId, book, tipoFill: fill.tipo, fillOrdine: resid.fillOrdine,
        sizeFillata: fill.sizePosseduta, ora: t0 });
      statoChiusura = { attiva: true, regoleAttive: !!(e.voce && e.voce.regoleAttive),
        daIso: e.voce && e.voce.daIso, nuova: e.nuova === true };
      if (e.nuova === true) {
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: 'modalita-chiusura-ingresso', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
          reason: e.motivo, observed: { book, tipoFill: fill.tipo, fillOrdine: resid.fillOrdine,
            sizeFillata: fill.sizePosseduta, sizeAltroLato: fill.sizeAltroLato, manca: fill.manca,
            da: e.voce && e.voce.daIso } });
      }
    } catch { statoChiusura = { attiva: false, regoleAttive: false, daIso: null, nuova: false }; }
  }

  // ── PASSO 2 · LE SHARE NON FILLATE SPARISCONO (una volta sola, all'ingresso) ────────────────────
  // Il gate e' `nuova`: si cancella al PRIMO giro e mai piu'. Dal secondo in poi gli acquisti a riposo
  // su questa coppia sono i NOSTRI ordini di chiusura, e ricancellarli a ogni giro sarebbe una churn che
  // azzera la priorita' di coda ogni sessanta secondi.
  //
  // FILL TOTALE: nessun `if` su `tipoFill`. `residuiDaCancellare` guarda il libro, e con un fill totale
  // sulla gamba riempita non resta niente a riposo — la lista esce vuota da sola e non parte nessuna
  // cancellazione. La ramificazione e' nei dati, non in due percorsi che potrebbero divergere.
  //
  // ══ FILL PARZIALE: IL RESIDUO RESTA A LIBRO FINCHE' LA COPPIA NON E' CHIUSA ═══════════════════════
  // Decisione dell'operatore, 15 agosto 2026: «se un ordine viene riempito solo in parte, posa subito
  // la gamba opposta della stessa quantita' riempita. Quando anche quella si chiude, cancella il
  // residuo dell'ordine originale ancora a libro».
  //
  // ⚠ E' UN CAMBIO DI MOMENTO, NON DI AZIONE, e va capito perche' conta. Prima il residuo della gamba
  // riempita veniva cancellato QUI, al primo giro, insieme alla sorella da ridimensionare. Ma quel
  // residuo e' un ordine maker valido, dentro banda, che sta MATURANDO PREMI — cioe' l'intero ricavo di
  // questo bot — e buttarlo via nell'istante del fill parziale regala reward per un rischio che non si
  // e' ancora materializzato. Adesso resta a libro, e si cancella nel momento in cui diventa davvero
  // pericoloso: quando la coppia e' completa, perche' da li' in poi un suo fill riaprirebbe una gamba
  // scoperta. E' la riga «non deve restare una gamba scoperta», applicata al momento giusto.
  //
  // ⚠ IL RISCHIO CHE SI ACCETTA, DICHIARATO: mentre la sorella riposa, il residuo puo' riempirsi
  // ancora e la posizione cresce oltre la sorella gia' piazzata. NON resta scoperto in silenzio —
  // `decidiIncrementoSorella` (poco sotto) ALZA il bersaglio della sorella al giro successivo, che e'
  // il meccanismo gia' esistente per «la sorella era stata piazzata a meta'». Il costo e' al piu' un
  // giro di ritardo sulla copertura della quota nuova.
  //
  // ⚠ LA SORELLA DA RIDIMENSIONARE SI CANCELLA COME PRIMA, all'ingresso: quella non matura niente di
  // utile — e' dimensionata sulla coppia INTERA invece che sul fillato — e lasciarla vorrebbe dire
  // comprare piu' controparte di quanta ne serva, cioe' aprire esposizione sull'altro lato.
  // ══ SU UN FILL PARZIALE IL RESIDUO SI CANCELLA SUBITO — decisione dell'operatore, 16 agosto 2026 ══
  //
  // ⚠ QUESTA RIGA ROVESCIA UNA DECISIONE PRESA STAMATTINA, e la ragione va scritta perche' il commento
  // qui sopra dice ancora il contrario. La scelta di stamattina era: lasciare vivo il residuo
  // dell'ordine che ha prodotto il fill, perche' cancellarlo «rinuncerebbe alla parte di coppia che il
  // mercato stava gia' completando da solo». Ragionamento corretto in astratto, smentito dalla
  // giornata: un residuo vivo sullo stesso token e lato e' un ordine che puo' RIEMPIRSI ANCORA, e
  // ingrossare la gamba scoperta invece di completarla. E' il `BUY 14¢ × 237,6` e il `BUY 14¢ × 152,4`
  // comparsi due volte sul token che gia' possedevamo, quattro volte la posizione: non completavano
  // niente, aumentavano l'esposizione direzionale mentre la scala d'uscita cercava di ridurla.
  //
  // La regola nuova e' la stessa del fill totale: **la gamba opposta si compra per la sola quantita'
  // riempita, il residuo esce dal libro, lo slot si libera subito.** Cio' a cui si rinuncia — che il
  // residuo si riempia da solo e completi la coppia — vale meno di cio' che si evita: una posizione
  // direzionale che cresce mentre stiamo cercando di chiuderla.
  //
  // ⚠⚠ IL DISCRIMINANTE ERA LA VARIABILE SBAGLIATA — corretto il 17 agosto 2026, su requisito
  // esplicito dell'operatore («un fill, totale o parziale, deve produrre la reazione entro il ciclo
  // successivo: gamba opposta a libro per la quantita' riempita, residuo cancellato se parziale»).
  //
  // Qui c'era `fill.tipo === FILL_PARZIALE`. Ma in `classificaFill` «parziale» e «completo»
  // descrivono la COPERTURA, non l'ordine:
  //     40 possedute / 0 coperte  ⇒ `fill-completo`  (manca 40: TOTALMENTE scoperta)
  //     40 possedute / 25 coperte ⇒ `fill-parziale`  (manca 15: parzialmente coperta)
  // Quindi la riga faceva l'OPPOSTO di quello che il commento qui sopra ragiona: il residuo veniva
  // cancellato nello stato MENO esposto e sopravviveva in quello PIU' esposto — cioe' proprio nel
  // caso appena dopo un fill, quando la gamba e' nuda e un secondo riempimento la ingrossa.
  // Misurato il 17 agosto: il `BUY 14¢ × 237,6` che motivo' `43523d9` non veniva nemmeno da qui — e'
  // `rimpiazzo-gamba` / `auto-close-on-fill` — quindi la regola non era mai stata esercitata sul caso
  // che diceva di coprire.
  //
  // ADESSO IL DISCRIMINANTE E' IL FATTO GIUSTO: `resid.fillOrdine`, che `residuiDaCancellare` deriva
  // DAL LIBRO — «e' rimasto qualcosa a riposo sulla gamba riempita?». Su un fill totale la lista e'
  // vuota per costruzione e questa riga non cambia niente; su un parziale il residuo esce sempre.
  // Non e' una condizione in piu': e' la stessa condizione, letta dove vive davvero.
  //
  // ⚠ COSA SI PERDE, dichiarato: che il residuo si riempia da solo e completi la coppia senza pagare
  // lo spread. Vale meno di cio' che si evita — una posizione direzionale che cresce mentre la scala
  // d'uscita cerca di ridurla — ed e' la stessa scelta di `43523d9`, applicata al caso che intendeva.
  const residuiIngresso = resid.fillOrdine === MC.FILL_ORDINE_PARZIALE
    ? resid.daCancellare
    : resid.daCancellare.filter((x) => x.quale !== 'residuo-non-fillato');
  const residuiTolti = [];
  if (statoChiusura.nuova && typeof deps.cancelOrder === 'function') {
    for (const x of residuiIngresso) {
      let c = null;
      try { c = await deps.cancelOrder({ orderId: x.orderId, marketId }); }
      catch (e) { c = { ok: false, reason: e.message }; }
      const cok = !!(c && c.ok !== false);
      if (cok) residuiTolti.push(x.orderId);
      audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
        outcome: cok ? `modalita-chiusura-${x.quale}-cancellato` : `modalita-chiusura-${x.quale}-cancellazione-fallita`,
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: x.motivo,
        observed: { orderId: x.orderId, size: x.size, fillOrdine: resid.fillOrdine } });
    }
    // ⚠ UNA CANCELLAZIONE FALLITA QUI NON FERMA IL FLUSSO, ed e' una scelta motivata: il residuo che
    // resta e' un ordine di ACQUISTO nella stessa direzione della coppia, non un ordine di segno
    // opposto. Non c'e' il rischio di «comprare e vendere insieme» che governa `cancelOrderIds` qui
    // sotto — al massimo il residuo si riempie e il giro successivo lo rivede come piu' scoperto.
    // Fermarsi lascerebbe invece la posizione senza NESSUNA gestione, che e' il danno peggiore.
  }

  // ── PASSO 2-bis · COPPIA COMPLETA ⇒ VIA IL RESIDUO DELLA GAMBA RIEMPITA ────────────────────────
  // NON e' gated su `nuova`: la coppia si completa quando si completa, che puo' essere il primo giro
  // (Livello 1 al volo) o il ventesimo. Ed e' IDEMPOTENTE per costruzione — una volta cancellato,
  // l'ordine non e' piu' sul libro e `residuiDaCancellare` restituisce una lista vuota, quindi il
  // giro dopo non fa niente senza bisogno di ricordarsi di aver gia' agito.
  //
  // La condizione e' `manca <= 0`, cioe' l'altro lato copre almeno quanto possediamo: e' la stessa
  // aritmetica con cui `strategia-merge.decidiLivello` risponde `azione: 'merge'`, letta dalla stessa
  // `classificaFill`. Non e' un secondo criterio: e' lo stesso, letto una volta sola.
  const coppiaCompleta = Number.isFinite(fill.manca) && fill.manca <= 0;
  const residuiGambaRiempita = resid.daCancellare.filter((x) => x.quale === 'residuo-non-fillato');
  if (coppiaCompleta && residuiGambaRiempita.length && typeof deps.cancelOrder === 'function') {
    for (const x of residuiGambaRiempita) {
      let c = null;
      try { c = await deps.cancelOrder({ orderId: x.orderId, marketId }); }
      catch (e) { c = { ok: false, reason: e.message }; }
      const cok = !!(c && c.ok !== false);
      if (cok) residuiTolti.push(x.orderId);
      audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
        outcome: cok ? 'coppia-completa-residuo-cancellato' : 'coppia-completa-residuo-cancellazione-fallita',
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
        reason: 'la coppia e\' completa: il residuo dell ordine originale a libro riaprirebbe una gamba scoperta se si riempisse',
        observed: { orderId: x.orderId, size: x.size, manca: fill.manca,
          sizePosseduta: fill.sizePosseduta, sizeAltroLato: fill.sizeAltroLato } });
    }
  }

  // ── ATTESA GIA' APERTA ────────────────────────────────────────────────────────────────────────
  // Di norma non si tocca niente: l'ordine di completamento e' sul libro e sta facendo il suo lavoro.
  // L'unica eccezione e' il Livello 1 diventato disponibile nel frattempo — prendere l'ask adesso
  // completa la coppia SUBITO invece di sperare che qualcuno venga a riempire il nostro bid.
  const attesaAperta = !!(attesa && attesa.orderId);
  if (attesaAperta && liv.livello !== 1) {
    // ══ LA SORELLA CRESCE SE ERA STATA PIAZZATA A META' ═══════════════════════════════════════════
    // Decisione dell'operatore, 12 agosto 2026. Fin qui questo ramo usciva senza guardare QUANTO il
    // completamento coprisse: una sorella da 40 share su un bersaglio di 100 restava 40 per sempre, e
    // la posizione restava scoperta per 60 senza che nessun numero lo dicesse. Adesso, se il capitale
    // nel frattempo si e' liberato, si AGGIUNGE la differenza.
    //
    // SI AGGIUNGE, NON SI SOSTITUISCE: cancellare 40 share che stanno gia' lavorando per ripiazzarne
    // 100 aprirebbe una finestra in cui la posizione e' scoperta per INTERO, che e' esattamente cio'
    // che stiamo chiudendo. Il bersaglio vive nel registro su disco, quindi sopravvive a un riavvio.
    //
    // `sizeARiposo` si legge dal LIBRO, non dal registro: il registro dice cosa abbiamo chiesto, solo
    // il libro dice cosa c'e'. Se divergono vince il libro.
    const voceChi = (chi && typeof chi.leggi === 'function') ? (() => { try { return chi.leggi(marketId, book); } catch { return null; } })() : null;
    const bersaglio = voceChi && voceChi.voce && voceChi.voce.sorella ? Number(voceChi.voce.sorella.target) : NaN;
    if (Number.isFinite(bersaglio) && bersaglio > 0) {
      const aRiposo = nostriSuToken(tokAltro, 'BUY').reduce((a, o) => a + o.size, 0);
      const inc = MC.decidiIncrementoSorella({
        target: bersaglio, sizeARiposo: aRiposo,
        capitaleLiberoUsd: typeof deps.capitaleLibero === 'function' ? deps.capitaleLibero() : null,
        prezzo: Number(liv.prezzo), minSize: Number(rules.minSize),
      });
      if (inc.azione === 'aumenta') {
        const rInc = await piazzaChiudendo({
          marketId, book: altroBook, side: 'BUY', price: giuAlTickLocale(Number(liv.prezzo)), size: inc.size,
          chiudePosizione: true, source: AUTO_CLOSE_SOURCE,
          note: `modalita' chiusura · INCREMENTO sorella: +${inc.size} share (a riposo ${aRiposo} su ${bersaglio})`,
        }, { deps, audit, t0, etichetta: 'modalita-chiusura-sorella-incremento' });
        const incOk = !!(rInc && rInc.ok);
        if (incOk && chi && typeof chi.registraSorella === 'function') {
          try { chi.registraSorella({ marketId, book, target: bersaglio, piazzata: inc.size, ora: t0 }); }
          catch { /* la memoria che non si aggiorna non deve fermare un ordine gia' partito */ }
        }
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: incOk ? 'modalita-chiusura-sorella-aumentata' : `modalita-chiusura-sorella-incremento-reject-${(rInc && rInc.gate) || 'venue'}`,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: inc.motivo,
          requested: { book: altroBook, side: 'BUY', price: giuAlTickLocale(Number(liv.prezzo)), size: inc.size },
          gate: (rInc && rInc.gate) || null,
          observed: { bersaglio, aRiposo, mancante: inc.mancante, orderId: (rInc && rInc.orderId) || null } });
        if (incOk) {
          return { esito: 'in-attesa', livello: 2, prezzo: null, size: inc.size, orderId: attesa.orderId,
            sorellaAumentata: inc.size,
            motivo: `${inc.motivo} — il completamento resta a riposo, con ${aRiposo + inc.size} share su ${bersaglio}` };
        }
      } else if (inc.mancante > 0) {
        // Non si e' potuto aumentare, e va detto: senza questa riga «coperto per intero» e «coperto a
        // meta' perche' mancava il capitale» sarebbero lo stesso silenzio.
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: 'modalita-chiusura-sorella-sotto-bersaglio', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
          reason: inc.motivo, observed: { bersaglio, aRiposo, mancante: inc.mancante } });
      }
    }
    return { esito: 'in-attesa', livello: 2, prezzo: null, size: null, orderId: attesa.orderId,
      motivo: `completamento gia' a riposo da ${liv.numeri && liv.numeri.attesaMin != null ? liv.numeri.attesaMin : '?'} min` };
  }

  // ── SI TOGLIE DI MEZZO CIO' CHE VA IN DIREZIONE OPPOSTA, PRIMA DI COMPRARE ────────────────────
  // Due liste, e vanno entrambe: le uscite a riposo sul primo lato (venderebbero cio' che stiamo
  // appaiando) e — se stiamo passando dal Livello 2 al Livello 1 — il completamento a riposo, che
  // altrimenti resterebbe sul libro a comprare una seconda volta lo stesso lato.
  const daTogliere = [...(cancelOrderIds || [])];
  if (attesaAperta && liv.livello === 1) daTogliere.push(attesa.orderId);

  // ══ IL VERDETTO DELLA CHIUSURA FORZATA SI CALCOLA QUI, DOVE NON AGISCE ANCORA ══════════════════
  // E' puro (scadenza + `manca` + ora) e non tocca niente. Serve adesso perche' decide COSA va tolto
  // dal libro prima di vendere, e la cancellazione e' il passo subito sotto. Il ramo che ESEGUE resta
  // dov'era, dopo le cancellazioni — quell'ordine e' una correzione trovata da un test e non si tocca.
  // `forza` e' gia' stato calcolato in cima, prima della guardia di livello: qui si riusa.

  // ── IL BUCO APERTO L'11 AGOSTO, E CHIUSO QUI ──────────────────────────────────────────────────
  // La chiusura forzata pre-scadenza vende al miglior bid — attraversa lo spread di proposito — ma
  // passava solo dalla cancellazione di `cancelOrderIds`, che porta le USCITE (i SELL che coprono).
  // I nostri BUY di LIQUIDITA' sullo stesso lato restavano vivi, e sul ramo `already-covered` non
  // c'era nessun altro percorso a toglierli: la vendita forzata poteva eseguirsi contro il nostro
  // stesso acquisto. E' esattamente il caso per cui il gate anti-auto-incrocio di `close-at-market`
  // esiste dal 5 agosto — mancava su questo percorso, che e' nato dopo.
  //
  // SI RIUSA LA STESSA LISTA, non un secondo meccanismo: entrando in `daTogliere` la liquidita'
  // eredita la disciplina che gia' vale li' — cancellazione confermata una per una, e se ANCHE UNA
  // sola fallisce non si vende niente. Prezzare il bid altrui (sopra) e togliere i nostri ordini di
  // mezzo (qui) sono due meta' della stessa protezione: la prima evita di mirarci, la seconda evita
  // che ci finiamo per movimento del book fra la decisione e l'invio.
  const liquiditaPropria = forza.forza ? nostriSuToken(tok, 'BUY').map((o) => o.orderId).filter(Boolean) : [];
  if (liquiditaPropria.length) daTogliere.push(...liquiditaPropria);

  const unici = [...new Set(daTogliere.filter(Boolean))];
  for (const oid of unici) {
    let c = null;
    try { c = typeof deps.cancelOrder === 'function' ? await deps.cancelOrder({ orderId: oid, marketId }) : null; }
    catch (e) { c = { ok: false, reason: e.message }; }
    // `!c` E NON `c && c.ok === false`: un cancellatore non iniettato restituisce `null`, e trattarlo
    // come riuscito farebbe comprare il secondo lato con l'uscita ancora viva sul primo.
    if (!c || c.ok === false) {
      return { esito: 'cancellazione-fallita', livello: liv.livello, prezzo: null, size: null, orderId: null,
        motivo: `non si e' potuto togliere l'ordine ${String(oid).slice(0, 12)}… (${(c && c.reason) || 'nessun cancellatore iniettato'}):`
          + ' non si compra il secondo lato mentre il primo ha un ordine di segno opposto ancora sul libro' };
    }
  }
  // Il completamento a riposo non c'e' piu': l'attesa va chiusa PRIMA di aprirne un'altra, altrimenti
  // resterebbe a puntare a un orderId cancellato.
  if (attesaAperta && liv.livello === 1 && reg) { try { reg.pulisci(chiaveMerge); } catch { /* non blocca */ } }

  // ⚠ LA CHIUSURA FORZATA STA QUI, DOPO LE CANCELLAZIONI, E NON PRIMA. Una prima stesura la metteva in
  // cima e il test l'ha presa: vendere l'intera posizione mentre un'uscita a riposo la copre gia' in
  // parte significa venderla DUE volte, cioe' aprire esposizione al contrario proprio nel momento in cui
  // si sta cercando di chiuderla. `cancelOrderIds` porta esattamente quelle uscite, e la regola di
  // questo file — «si toglie di mezzo cio' che va in direzione opposta, prima» — vale anche qui.
  // ══ CHIUSURA FORZATA PRE-SCADENZA ═══════════════════════════════════════════════════════════════
  // Decisione di Diego, 11 agosto 2026. Sotto le tre ore dalla risoluzione una posizione SCOPERTA non e'
  // piu' un rischio da gestire: e' una scommessa sull'esito. Si chiude subito, e il costo non decide.
  //
  // ═══ QUALE PERCORSO CHIUDE PRIMA, E PERCHE' NON E' UNA SCELTA LIBERA ═══════════════════════════════
  // Il requisito dice «usa il percorso che chiude prima, non quello che costa meno». I percorsi immediati
  // sono due — vendere il lato posseduto, o comprare la controparte da taker — e NON sono equivalenti:
  //   · la VENDITA che attraversa lo spread e' permessa senza tetto di prezzo
  //     (`manual-order.js:1056`, `lato === 'SELL' && spec.attraversaApposta === true`);
  //   · l'ACQUISTO aggressivo passa solo per `completaCoppiaOk`, che RIFA' l'aritmetica sull'ordine
  //     esatto e rifiuta se `carico + prezzo` supera il tetto dichiarato — e accetta un tetto al piu' di
  //     200¢ (`tettoCoppia <= 200`). Non e' una dichiarazione di cui il gate si fida: e' un vincolo che
  //     verifica lui.
  // Quindi la vendita e' l'unico percorso che chiude a QUALUNQUE prezzo, ed e' anche quello che esegue
  // di sicuro: si prova per prima. L'acquisto resta come secondo tentativo, col tetto portato al massimo
  // che il gate accetta — 200¢ — senza toccare di una riga la regola che lo governa.
  //
  // ⚠ LIMITE DICHIARATO: «a qualsiasi prezzo» vale per intero sulla VENDITA e fino a 200¢ di costo
  // coppia sull'acquisto. Renderlo illimitato anche sull'acquisto richiederebbe di allentare
  // `completaCoppiaOk`, che e' una protezione di §2 — vedi la nota all'operatore.
  //
  // COSA RESTA SOVRAORDINATO, e non e' reimplementato qui: il KILL. Ogni ordine passa da
  // `placeManualOrder`, che legge il kill come PRIMO gate (`manual-order.js:585`), e `runAutoCloseCycle`
  // lo controlla gia' prima del giro. Non c'e' nessun percorso di questa funzione che scavalchi l'uno o
  // l'altro: con il kill attivo `deps.placeOrder` rifiuta, e qui si registra il rifiuto come per
  // qualunque altro ordine.
  if (forza.forza) {
    const sizePos = Number(liv.numeri && liv.numeri.sizePosseduta);
    // ANTI-SELF-TRADE, entrambi i percorsi: si vende al miglior bid ALTRUI e si compra al miglior ask
    // ALTRUI. La vendita e' il caso pericoloso — attraversa lo spread di proposito, quindi scavalca
    // senza sforzo il margine che separa le nostre due gambe sullo stesso lato.
    const bidScala = scalaAltrui(book, 'bids');
    const bidMio = Array.isArray(bidScala)
      ? bidScala.map((l) => Number(l && l.price)).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => b - a)[0]
      : null;
    const askScalaF = scalaAltrui(altroBook, 'asks');
    const askAltroF = Array.isArray(askScalaF)
      ? askScalaF.map((l) => Number(l && l.price)).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b)[0]
      : null;
    const prove = [];
    if (Number.isFinite(bidMio) && Number.isFinite(sizePos) && sizePos > 0) {
      prove.push({ quale: 'vendita', book, side: 'SELL', price: bidMio, size: sizePos,
        extra: { attraversaApposta: true, chiudePosizione: true },
        costo: +(((prezzoCarico || 0) - bidMio) * sizePos).toFixed(4) });
    }
    if (Number.isFinite(askAltroF) && Number.isFinite(forza.oreAllaScadenza)) {
      const mancaF = mancaOra;
      prove.push({ quale: 'acquisto-controparte', book: altroBook, side: 'BUY', price: askAltroF, size: mancaF,
        extra: { attraversaApposta: true, completaCoppia: true, prezzoCaricoCoppia: prezzoCarico, tettoCoppiaCents: 200, chiudePosizione: true },
        costo: +(((prezzoCarico || 0) + askAltroF - 1) * mancaF).toFixed(4) });
    }
    for (const pv of prove) {
      let r;
      try {
        r = await piazzaChiudendo({ marketId, book: pv.book, side: pv.side, price: pv.price, size: pv.size,
          ...pv.extra, source: AUTO_CLOSE_SOURCE,
          note: `chiusura forzata pre-scadenza (${pv.quale}): ${forza.motivo}` },
        { deps, audit, t0, etichetta: `chiusura-forzata-pre-scadenza-${pv.quale}` });
      } catch (e) { r = { ok: false, gate: 'exception', reason: e.message }; }
      const rok = !!(r && r.ok);
      audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
        outcome: rok ? 'chiusura-forzata-pre-scadenza' : `chiusura-forzata-pre-scadenza-reject-${(r && r.gate) || 'venue'}`,
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: forza.motivo,
        requested: { book: pv.book, side: pv.side, price: pv.price, size: pv.size },
        gate: (r && r.gate) || null,
        // IL COSTO EFFETTIVO, così la regola è misurabile nel tempo invece che solo dichiarata.
        observed: { percorso: pv.quale, oreAllaScadenza: forza.oreAllaScadenza, costoUsd: pv.costo,
          prezzoCarico, sizePosseduta: sizePos, manca: mancaOra, livello: liv && liv.livello } });
      if (rok) {
        if (chi && typeof chi.esci === 'function') { try { chi.esci({ marketId, book }); } catch { /* non blocca */ } }
        return { esito: 'piazzato', livello: liv.livello, prezzo: pv.price, size: pv.size,
          orderId: (r && r.orderId) || null, altroBook, chiusuraForzata: true, percorso: pv.quale,
          costoUsd: pv.costo, cancellatiPrima: unici, residuiTolti,
          motivo: `${forza.motivo} · chiusa per ${pv.quale} a ${(pv.price * 100).toFixed(1)}¢ (costo $${pv.costo})` };
      }
    }
    // Nessuno dei due percorsi e' passato: si prosegue con la gerarchia ordinaria invece di fermarsi —
    // un tentativo di chiusura fallito non deve lasciare la posizione senza nemmeno un ordine a riposo.
    audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
      outcome: 'chiusura-forzata-pre-scadenza-non-riuscita', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
      reason: `${forza.motivo} — nessuno dei ${prove.length} percorsi immediati e' passato: si prosegue con la gerarchia ordinaria`,
      observed: { oreAllaScadenza: forza.oreAllaScadenza, percorsiProvati: prove.map((p) => p.quale) } });
  }


  // ── LA COPPIA È GIÀ COMPLETA: SI FONDE, NON SI VENDE ──────────────────────────────────────────
  // `decidiLivello` risponde `azione:'merge'` quando `mancaAllaCoppia <= 0` (strategia-merge.js:218):
  // non c'è un secondo lato da comprare, restano solo YES e NO in parti uguali. Fino al 9 agosto 2026
  // questo caso finiva nel nulla — `liv.prezzo` è `null` e `manca` è 0, quindi entrambi i tentativi
  // qui sotto venivano scartati e si ripiegava sulla VENDITA. Che è la cosa sbagliata da fare, e non
  // per poco.
  //
  // ═══ PERCHÉ IL MERGE VINCE SEMPRE, E PERCHÉ NON SERVE UN CONFRONTO ═════════════════════════════
  // Il primo istinto era scrivere una regola di preferenza — «fondi se conviene più che vendere». È
  // stato scartato dopo averlo scritto: non esiste una condizione di mercato in cui vendere una coppia
  // completa batta fonderla, quindi il confronto potrebbe solo sbagliare.
  //   · il merge rende ESATTAMENTE $1 per coppia, subito, senza slippage e senza gas (paga il relayer);
  //   · la vendita rende `bid × size` su UN lato solo — e lascia l'altro ancora in portafoglio, quindi
  //     non chiude nemmeno la posizione: la trasforma in un'esposizione direzionale a un solo lato;
  //   · e attraversa lo spread, cioè paga il costo che il merge non ha.
  // Il confronto avrebbe due termini di cui uno è sempre maggiore. La regola è quindi: coppia completa
  // ⇒ merge; la vendita resta il ripiego per quando il merge non è disponibile.
  //
  // ═══ COSA SUCCEDE SE FALLISCE ═════════════════════════════════════════════════════════════════
  // Si ritorna `rinuncia` col motivo, e il chiamante prosegue con il comportamento di prima — la
  // gerarchia arriva al Livello 3 e vende. Nessuna azione doppia: o la coppia è fusa (e allora non
  // c'è più niente da vendere) o non lo è (e non è stato fatto nulla). In mezzo non esistono stati:
  // `mergePosition` o conferma on-chain o solleva, e con `CTF_RELAYER_ENABLED` a false non firma
  // nemmeno — restituisce il piano con `eseguito:false`, che qui è un ripiego pulito come un altro.
  if (liv.azione === 'merge') {
    const f = await fondiCoppia({ marketId, rules, size: Number(liv.size), deps, audit, t0, book });
    if (f.ok) {
      // Questo LATO non è più scoperto — `azione:'merge'` vuol dire `mancaAllaCoppia <= 0`. Se il
      // registro aveva una voce aperta qui, si chiude. Il residuo di una fusione PARZIALE non sparisce
      // per questo: vive sull'ALTRO lato, dove `manca > 0`, e il giro successivo lo porta alla rinuncia
      // in fondo a questa funzione — che è il punto in cui viene registrato. Un percorso solo.
      segnalaScoperto(0, 'coppia fusa');
      // LA COPPIA E' CHIUSA: si esce dalla modalita' chiusura. Da qui in poi il mercato torna ordinario
      // — «mai primo sul libro» ridiventa assoluto anche sulla sorella, e la ripianificazione del passo
      // 5 riparte con le regole standard. Lasciare la voce aperta terrebbe viva un'esenzione su una
      // coppia che non esiste piu'.
      if (chi && typeof chi.esci === 'function') {
        try { chi.esci({ marketId, book }); } catch { /* non blocca una fusione riuscita */ }
      }
      return { esito: 'fuso', livello: liv.livello, prezzo: null, size: f.size, orderId: null, book,
        transactionHash: f.transactionHash || null, altroBook,
        motivo: `coppia di ${f.size} share fusa on-chain: $${f.size.toFixed(2)} tornano liquidi subito invece che alla risoluzione` };
    }
    return { esito: 'rinuncia', livello: liv.livello, prezzo: null, size: null, orderId: null,
      motivo: `coppia completa ma merge non eseguito (${f.motivo}) — si ripiega sull'uscita classica` };
  }

  const tick = Number(rules.tick);
  const minSize = Number(rules.minSize);
  const alTick = (x) => (Number.isFinite(tick) && tick > 0 && Number.isFinite(x)
    ? +(Math.floor((x + 1e-9) / tick) * tick).toFixed(6) : x);
  // ANTI-SELF-TRADE: il miglior ask ALTRUI, non il miglior ask. Se il tocco fosse nostro, il Livello 1
  // si prezzerebbe per eseguirsi contro il nostro stesso ordine.
  const askAltroScala = scalaAltrui(altroBook, 'asks');
  const askAltro = Array.isArray(askAltroScala)
    ? askAltroScala.map((l) => Number(l && l.price)).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b)[0]
    : null;
  const manca = Number(liv.numeri && liv.numeri.mancaAllaCoppia);

  // ── I DUE TENTATIVI, IN ORDINE ────────────────────────────────────────────────────────────────
  // Il Livello 1 e' un TAKER e oggi non puo' passare: `manual-order` consente di attraversare lo
  // spread solo in VENDITA. Quella regola NON e' stata toccata — allentarla e' una decisione
  // dell'operatore, non di questo file. Quindi il Livello 1 si tenta lo stesso (se un giorno
  // l'eccezione arrivera', funziona da solo) e quando il gate lo rifiuta si degrada al Livello 2
  // NELLO STESSO CICLO, invece di precipitare al Livello 3.
  const tentativi = [];
  if (liv.livello === 1 && Number.isFinite(Number(liv.prezzo))) {
    tentativi.push({ livello: 1, prezzo: alTick(Number(liv.prezzo)), size: Number(liv.size), taker: true });
  }
  // Il Livello 2 riposa: mai sopra il tetto (sfondarlo farebbe costare la coppia piu' di $1) e mai
  // sopra il miglior ask meno un tick (altrimenti incrocia e viene rifiutato come il L1).
  const tettoRiposo = Number.isFinite(askAltro) && Number.isFinite(tick) && tick > 0
    ? Math.min(Number(liv.tetto), askAltro - tick)
    : Number(liv.tetto);

  // ── «PIU' AGGRESSIVO VERSO IL COMPLETAMENTO»: NON C'E' PIU' MARGINE, ED E' ALGEBRA ────────────
  //
  // La domanda era se si potesse alzare il prezzo del completamento per avvicinarlo al mid — cosi'
  // si riempirebbe prima E maturerebbe premi restando dentro la banda. La risposta e' NO, e non per
  // prudenza: per aritmetica. Il prezzo di riposo e' gia'
  //
  //     min(tetto della coppia, miglior ask − un tick)
  //
  // cioe' il massimo dei due soli vincoli che esistono. Qualunque «alzata» sarebbe limitata dagli
  // stessi due termini, quindi non puo' produrre un numero piu' alto di quello che c'e' gia'. Un
  // primo tentativo di questo lavoro aveva scritto proprio quel rialzo: era codice morto, e la prova
  // e' una riga — `min(bordo, tetto, ask−tick) <= min(tetto, ask−tick)` sempre.
  //
  // Resta utile SAPERE se il prezzo cade dentro la banda premiante, perche' cambia cosa aspettarsi
  // dall'attesa: dentro la banda il Livello 2 matura anche premi, fuori e' solo capitale fermo in
  // attesa di appaiarsi. Quindi si calcola e si DICHIARA, senza fingere di poterlo cambiare.
  let fuoriBanda = null;
  const bandaRaggio = Number.isFinite(rules.maxSpreadCents) ? raggioBandaCents(rules.maxSpreadCents) : null;
  const midAltro = rules.books && rules.books[altroBook] ? rules.books[altroBook].scoringMid : null;

  // ── ABBASSARE DENTRO LA BANDA SI PUO', E CONVIENE DUE VOLTE — decisione dell'operatore, 13/08/2026 ──
  //
  // Il blocco qui sopra dimostra che ALZARE il prezzo è impossibile, ed è vero. Ma la domanda che
  // conta è l'altra, e per anni non è stata posta: quando il tetto della coppia cade SOPRA il bordo
  // alto della banda premiante, si può ABBASSARE il completamento fino al bordo. Conviene due volte:
  //   · si paga MENO la controparte, quindi la coppia costa meno e il margine cresce;
  //   · l'ordine matura REWARD mentre aspetta, invece di essere capitale fermo.
  // L'unico prezzo che si paga è il tempo: un BUY più basso si riempie più tardi. L'operatore ha
  // deciso esplicitamente questo scambio — «a parità di condizioni, il prezzo dentro la banda invece
  // di quello che chiude prima» — perché la riapertura della gamba sorella NON è solo un modo di
  // chiudere: è anche una quotazione che rende.
  //
  // ⚠ NON ALLENTA NESSUN VINCOLO, E NON PUO' PER COSTRUZIONE: è un `Math.min`, quindi il prezzo può
  // solo SCENDERE rispetto a quello di prima. Il tetto della coppia resta dove sta, «mai primo sul
  // libro» resta come prima (l'esenzione è quella già esistente e non si allarga), e la size non si
  // tocca. Se la banda non è leggibile, o se il suo bordo sta SOPRA il tetto, il prezzo è identico a
  // quello di prima — cioè l'assenza del dato non cambia niente.
  //
  // ⚠ E LA CHIUSURA RESTA GARANTITA DA ALTRO: il ritardo di fill è coperto dalla scala di urgenza
  // (§5 p.138) e dalla chiusura forzata a 3 ore dalla risoluzione, che non passano di qui.
  let prezzoRiposo = tettoRiposo;
  let abbassatoInBanda = false;
  if (Number.isFinite(bandaRaggio) && Number.isFinite(midAltro) && Number.isFinite(tettoRiposo)) {
    const bandaHi = midAltro + bandaRaggio / 100;
    if (bandaHi > 0 && bandaHi < tettoRiposo) { prezzoRiposo = bandaHi; abbassatoInBanda = true; }
    // `fuoriBanda` si misura sul prezzo SCELTO, non su quello di partenza: dopo l'abbassamento la
    // risposta cambia, ed è la risposta nuova quella che descrive l'ordine che si sta per piazzare.
    fuoriBanda = Math.abs(prezzoRiposo - midAltro) > bandaRaggio / 100 + 1e-9;
  }
  const sizeL2 = liv.livello === 1 ? manca : Number(liv.size != null ? liv.size : manca);
  tentativi.push({ livello: 2, prezzo: alTick(prezzoRiposo), size: sizeL2, taker: false, fuoriBanda,
    abbassatoInBanda, tettoRiposo: alTick(tettoRiposo) });

  let ultimoMotivo = null;
  // Vero da quando il piano A e' fallito. Governa DUE cose e nient'altro: l'esenzione da «mai primo»
  // sulla sorella qui sotto, e il flag `modalitaChiusura` passato a `pianificaRiposizionamentoScoperto`.
  let regoleAttive = statoChiusura.regoleAttive === true;

  // ── LA REGOLA 3b IN UN POSTO SOLO ───────────────────────────────────────────────────────────────
  // «Dentro banda se possibile, altrimenti +1 tick sopra il carico anche fuori banda, mai sotto il
  // carico» vive gia' dentro `pianificaRiposizionamentoScoperto`, che la calcola per il lato posseduto.
  // Qui la si RIUSA invece di riscriverla: due copie di una regola di prezzo che tocca capitale reale
  // divergerebbero, e questa in particolare porta il vincolo «mai sotto il carico».
  const bandaRaggioP = Number.isFinite(rules.maxSpreadCents) ? raggioBandaCents(rules.maxSpreadCents) : null;
  const midMioP = rules.books && rules.books[book] ? Number(rules.books[book].scoringMid) : null;
  const bandaHiMioP = Number.isFinite(bandaRaggioP) && Number.isFinite(midMioP) ? midMioP + bandaRaggioP / 100 : null;
  const gambaLatoPosseduto = () => {
    try {
      const p = pianificaRiposizionamentoScoperto({
        prezzoCarico, sizePosseduta: Number(liv.numeri && liv.numeri.sizePosseduta), manca,
        bandaHi: bandaHiMioP, tick, minSize, modalitaChiusura: true,
      });
      if (!p || !p.latoPosseduto) return null;
      return { ...p.latoPosseduto, motivo: p.latoPossedutoMotivo || p.motivo };
    } catch { return null; }
  };
  for (const t of tentativi) {
    if (!Number.isFinite(t.prezzo) || !(t.prezzo > 0) || !Number.isFinite(t.size) || !(t.size > 0)) {
      ultimoMotivo = `livello ${t.livello}: prezzo (${t.prezzo}) o size (${t.size}) non utilizzabili`;
      continue;
    }
    // ══ IL BERSAGLIO SI REGISTRA PRIMA DI TENTARE, E LA SIZE SI LIMITA AL CAPITALE ════════════════
    // `t.size` e' quanto SERVE per chiudere (`manca`). Il capitale libero puo' non bastare: in quel
    // caso si piazza cio' che si puo' e si aumenta ai cicli successivi (§5, passo 5). Il bersaglio
    // resta comunque `t.size` e va a registro PRIMA del tentativo, cosi' anche un ordine che parte e
    // poi fallisce lascia dietro l'informazione di quanto serviva.
    //
    // CAPITALE NON LETTO ⇒ NON SI RIDUCE, ed e' voluto: `sizeSostenibile` risponde 0, e qui uno 0 da
    // «non lo so» non deve trasformarsi in «non piazzare». Si prosegue con la size piena e il gate a
    // valle giudichera' — che e' il comportamento di prima, invariato per chi non cabla il capitale.
    const bersaglioSorella = t.size;
    if (chi && typeof chi.registraSorella === 'function') {
      try { chi.registraSorella({ marketId, book, target: bersaglioSorella, piazzata: 0, ora: t0 }); }
      catch { /* la memoria che non si scrive non deve fermare la chiusura */ }
    }
    const capOra = typeof deps.capitaleLibero === 'function' ? deps.capitaleLibero() : null;
    if (Number.isFinite(Number(capOra))) {
      const sost = MC.sizeSostenibile({ sizeVoluta: t.size, capitaleLiberoUsd: capOra,
        prezzo: t.prezzo, minSize: Number.isFinite(minSize) ? minSize : null });
      if (sost.ridotta) {
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: sost.size > 0 ? 'modalita-chiusura-sorella-ridotta-dal-capitale' : 'modalita-chiusura-sorella-rimandata-dal-capitale',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: sost.motivo,
          observed: { bersaglio: bersaglioSorella, sizeOra: sost.size, capitaleLiberoUsd: capOra, prezzo: t.prezzo } });
      }
      if (sost.size > 0) t.size = sost.size;
    }
    if (Number.isFinite(minSize) && t.size < minSize) {
      ultimoMotivo = `livello ${t.livello}: il completamento sarebbe di ${t.size} share, sotto il minimo del venue (${minSize})`;
      continue;
    }
    // ══ FASE 2 · LE REGOLE DI CHIUSURA SI APRONO QUI, E SOLO QUI ═══════════════════════════════════
    // Il tentativo immediato a mercato e' il Livello 1 (taker). Si arriva a un tentativo di Livello 2
    // in due modi, e sono ESATTAMENTE i tre casi che il requisito elenca:
    //   · `liv.livello === 2` — `decidiLivello` ha gia' stabilito che il taker non e' praticabile
    //     (prezzo oltre il tetto della coppia, oppure book troppo sottile per coprire `manca`);
    //   · `liv.livello === 1` ma la POSTA del L1 e' stata rifiutata dal venue o da un gate — in quel
    //     caso il ciclo e' passato al secondo elemento di `tentativi`, quindi siamo di nuovo qui.
    // In entrambi i casi il piano A e' fallito, ed e' il momento — non prima — di attivare le regole.
    if (!t.taker && !regoleAttive) {
      const perche = liv.livello === 2
        ? `il tentativo immediato a mercato non e' praticabile: ${liv.motivo}`
        : `il tentativo immediato a mercato e' stato rifiutato (${ultimoMotivo || 'motivo non registrato'})`;
      if (chi && statoChiusura.attiva && typeof chi.attiva === 'function') {
        try {
          const a = chi.attiva({ marketId, book, motivo: perche, ora: t0 });
          if (a.voce && a.voce.regoleAttive === true) regoleAttive = true;
          if (a.attivate === true) {
            audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
              outcome: 'modalita-chiusura-regole-attive', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
              reason: a.motivo, observed: { book, tipoFill: fill.tipo, daIso: statoChiusura.daIso } });
          }
        } catch { /* un registro che non risponde non deve poter fermare la chiusura */ }
      }
    }
    let cres;
    try {
      cres = await piazzaChiudendo({
        marketId, book: altroBook, side: 'BUY', price: t.prezzo, size: t.size,
        // ── L'ESENZIONE DA «MAI PRIMO», E IL SUO PERIMETRO ESATTO ───────────────────────────────
        // `inCoda` e' OPT-IN (`manual-order.js:886`): la regola vale solo per chi la dichiara, quindi
        // ometterlo NON modifica la regola — la lascia intatta ovunque e la disapplica su QUESTA gamba.
        // Si omette solo quando le regole di chiusura sono attive, cioe' solo sulla SORELLA di una
        // coppia il cui tentativo immediato e' gia' fallito. Il lato POSSEDUTO qui accanto e ogni altra
        // gamba di questo file continuano a dichiararlo.
        // ── IL LIVELLO 1 NON POTEVA ESEGUIRE: DICHIARAVA UN CAMPO SU TRE ────────────────────────
        // Misurato sui due giornali maker: **852 `merge-livello-1-reject-would-cross`**, cioe' ogni
        // singolo tentativo di taker mai fatto da questo stack. La causa non e' la regola anti-incrocio:
        // dal 9 agosto esiste `completaCoppiaOk` (`manual-order.js:1044`), l'eccezione che consente a un
        // BUY di attraversare lo spread per completare una coppia gia' aperta. Ma quell'eccezione chiede
        // TRE dichiarazioni, non una — `attraversaApposta` da solo «continua a non fare niente su un
        // BUY», lo dice il suo stesso commento — e qui se ne dichiarava una.
        //
        // E' la stessa classe di difetto di §5 punto 52 (`deps.signerProvider` non cablato): la regola
        // c'era, il chiamante non le passava cio' che chiede. Il modello giusto era gia' in questo file,
        // dodici righe piu' sotto, sul taker della chiusura rapida.
        //
        // ⚠ E QUI IL TEST HA TROVATO UN SECONDO PROBLEMA, STRUTTURALE E NON DI CABLAGGIO.
        // `liv.tetto` non e' in centesimi: e' il PREZZO massimo della controparte (0,59 su un carico di
        // 0,40), cioe' una coppia a 99¢ — il tetto del merge, che e' sotto la pari perche' il merge deve
        // essere profittevole. Ma il gate accetta `tettoCoppia >= 100 && <= 200`: un tetto di 99¢ non e'
        // dichiarabile, e la prima stesura di questo fix passava 0,59 — rifiutato per lo stesso motivo.
        //
        // Si dichiara quindi **100**, il minimo che il gate accetta, e la cosa e' sicura per una ragione
        // precisa: il tetto vero resta piu' STRETTO e sta a monte. `decidiLivello` non propone nemmeno il
        // Livello 1 se la coppia supera 99¢ (`strategia-merge`), quindi il prezzo che arriva qui e' gia'
        // limitato a 99¢. Il gate e' la seconda linea, non l'unica, e con 100 continua a rifare
        // l'aritmetica e a rifiutare qualunque cosa sopra la pari. La differenza fra i due numeri e' un
        // centesimo di margine che il primo vincolo non concede comunque.
        ...(t.taker
          ? { attraversaApposta: true, completaCoppia: true,
            prezzoCaricoCoppia: prezzoCarico, tettoCoppiaCents: 100 }
          : (regoleAttive ? {} : { inCoda: true })),
        // ── IL TETTO PER ORDINE NON RIGUARDA QUESTA GAMBA ────────────────────────────────────────
        // Vale per ENTRAMBI i rami — il taker del Livello 1 e la sorella a riposo del Livello 2 — perche'
        // entrambi comprano `manca` share per completare una coppia gia' aperta: la size non la scegliamo
        // noi, la impone la posizione. `provaChiusura` la riverifica contro lo snapshot del venue e
        // rifiuta l'esenzione su qualunque share oltre `manca`.
        chiudePosizione: true,
        source: AUTO_CLOSE_SOURCE,
        note: `merge livello ${t.livello}: completa la coppia comprando ${t.size} share di ${altroBook.toUpperCase()}`
          + ` a ${t.prezzo} (tetto ${liv.tetto}) su carico ${prezzoCarico}`
          + (t.abbassatoInBanda === true ? ` · ABBASSATO dal tetto ${t.tettoRiposo} al bordo della banda: costa meno e matura premi mentre aspetta` : '')
          + (t.fuoriBanda === true ? ' · FUORI banda: il tetto della coppia è più stretto della banda premiante, quindi l\'attesa non matura premi'
            : (t.fuoriBanda === false ? ' · dentro la banda: l\'attesa matura anche premi' : '')),
      },
      { deps, audit, t0, etichetta: `merge-livello-${t.livello}` });
    } catch (e) { cres = { ok: false, gate: 'exception', reason: e.message }; }
    const cok = !!(cres && cres.ok);
    audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
      outcome: cok ? `merge-livello-${t.livello}-piazzato` : `merge-livello-${t.livello}-reject-${(cres && cres.gate) || 'venue'}`,
      marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: liv.motivo,
      requested: { book: altroBook, side: 'BUY', price: t.prezzo, size: t.size, livello: t.livello, taker: t.taker,
        fuoriBanda: t.fuoriBanda, abbassatoInBanda: t.abbassatoInBanda === true, tettoRiposo: t.tettoRiposo },
      gate: (cres && cres.gate) || null,
      observed: { livello: liv.livello, azione: liv.azione, tetto: liv.tetto, askAltro, cancellatiPrima: unici.length, ...liv.numeri } });
    if (cok) {
      // QUANTO E' FINITO SUL LIBRO, cumulativo. Qui sommare e' giusto: ogni voce e' un ordine nostro
      // da `t.size` share, cioe' un incremento vero — al contrario di `osservazioni`, dove la fonte
      // (la posizione al venue) era gia' cumulativa e sommare avrebbe raddoppiato (§5 punto 6-bis).
      if (chi && typeof chi.registraSorella === 'function') {
        try { chi.registraSorella({ marketId, book, target: bersaglioSorella, piazzata: t.size, ora: t0 }); }
        catch { /* non blocca */ }
      }
      // Il Livello 1 e' immediato e non apre un'attesa: al giro dopo la coppia risulta completa (o
      // quel che ne resta torna qui). Solo il Livello 2 fa partire l'orologio dei 60 minuti.
      if (t.livello === 2) {
        try { reg.segna(chiaveMerge, { at: t0, orderId: (cres && cres.orderId) || null, size: t.size, prezzo: t.prezzo }); } catch { /* il giro dopo riprova */ }
        // LA FASE, PER IL RIAVVIO: la sorella e' a riposo. Dopo un crash questo dice al bot che
        // l'ordine di completamento esiste gia' e non ne va piazzato un secondo.
        if (chi && typeof chi.fase === 'function') {
          try { chi.fase({ marketId, book, fase: MC.FASE_ATTESA, ora: t0 }); } catch { /* non blocca */ }
        }
      }
      // ── LA GAMBA FILLATA NON RESTA SENZA ORDINE MENTRE LA SORELLA ASPETTA ─────────────────────
      // Fino all'11 agosto 2026 un Livello 2 piazzato tornava subito, e il ramo che quota il lato
      // POSSEDUTO stava piu' in basso: non veniva mai raggiunto. Risultato: per tutta l'attesa (fino a
      // 60 minuti) la posizione riempita non aveva nessun ordine sopra — zero premi e nessuna uscita.
      // Il requisito chiede le DUE gambe insieme, quindi la si piazza qui, con la regola 3b: dentro
      // banda se possibile, altrimenti +1 tick sopra il carico anche fuori banda, mai sotto il carico.
      let latoMesso = null;
      if (regoleAttive && !t.taker) {
        const g = gambaLatoPosseduto();
        if (g) {
          let rp;
          try {
            rp = await piazzaChiudendo({
              marketId, book, side: 'SELL', price: g.prezzo, size: g.size,
              // Il lato posseduto NON e' esente da «mai primo»: e' un ordine che ASPETTA e matura
              // premi, quindi la regola gli si applica per intero. L'esenzione vale solo sulla sorella.
              inCoda: true, source: AUTO_CLOSE_SOURCE,
              note: `modalita' chiusura · lato posseduto: ${g.size} share a ${g.prezzo} su carico ${prezzoCarico}`
                + (g.fuoriBanda ? ' — FUORI banda, a carico +1 tick: nessun premio, ma si puo\' uscire in pari'
                  : ' — dentro banda, cosi\' l\'attesa matura premi'),
            },
            { deps, audit, t0, etichetta: 'modalita-chiusura-lato-posseduto' });
          } catch (e) { rp = { ok: false, gate: 'exception', reason: e.message }; }
          const rpok = !!(rp && rp.ok);
          audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
            outcome: rpok ? 'modalita-chiusura-lato-posseduto-piazzato'
              : `modalita-chiusura-lato-posseduto-reject-${(rp && rp.gate) || 'venue'}`,
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: g.motivo,
            requested: { book, side: 'SELL', price: g.prezzo, size: g.size },
            gate: (rp && rp.gate) || null,
            observed: { prezzoCarico, fuoriBanda: g.fuoriBanda === true, tipoFill: fill.tipo } });
          if (rpok) latoMesso = { prezzo: g.prezzo, size: g.size, orderId: (rp && rp.orderId) || null };
        }
      }
      return { esito: 'piazzato', livello: t.livello, prezzo: t.prezzo, size: t.size,
        orderId: (cres && cres.orderId) || null, sent: !!(cres && cres.sent), altroBook,
        cancellatiPrima: unici, residuiTolti, latoPosseduto: latoMesso,
        modalitaChiusura: regoleAttive, tipoFill: fill.tipo, motivo: liv.motivo };
    }
    ultimoMotivo = `livello ${t.livello}: ${(cres && cres.reason) || 'piazzamento non riuscito'}`;
  }

  // ── LA CHIUSURA RAPIDA: L'ULTIMA CARTA, E COSTA ─────────────────────────────────────────────────
  // I due livelli del merge hanno un tetto STRETTO — la coppia non deve costare piu' di ~99¢, perche'
  // quel tetto protegge il profitto. Quando falliscono, la posizione resta esposta su un lato solo e
  // aspetta: e' il comportamento che l'operatore ha deciso di cambiare il 9 agosto 2026.
  //
  // Qui si accetta di pagare la coppia fino a `TETTO_COPPIA_CENTS`, cioe' SOPRA LA PARI. Va detto
  // senza attenuanti: una coppia sopra i 100¢ paga $1 alla risoluzione, quindi e' una perdita certa
  // pari all'eccedenza. Non e' un difetto — e' il prezzo di non restare direzionali, ed e' una
  // decisione dell'operatore, non un'ottimizzazione.
  // ⚠ IL VALORE NON SI RIPETE QUI. Questo commento diceva «(120¢)» e prima ancora «(110¢)», e per due
  // giorni ha descritto un tetto che il codice non applicava (§5.2 p.28, reperto D7): il numero vive in
  // `chiusura-rapida.TETTO_COPPIA_DEFAULT_CENTS`, oggi 101¢, ed e' l'unico posto in cui va letto.
  //
  // ORDINE, e non e' negoziabile: prima i livelli 1 e 2 (che GUADAGNANO), poi questa (che paga). Sta
  // dopo il `for` proprio per questo — si arriva qui solo se il completamento a sconto non e' passato.
  if (CHIUSURA_RAPIDA_ENABLED && Number.isFinite(manca) && manca > 0) {
    const piano = pianificaChiusuraRapida({
      prezzoCarico, manca, asksAltroLato: scalaAltrui(altroBook, 'asks'),
      tick, minSize,
    });
    if (piano.ok && rispettaIlTetto(piano, prezzoCarico)) {
      const gambe = [];
      // Il taker per primo: chiude subito quello che il book copre sotto il tetto. Il limit poi, per il
      // resto — e va piazzato ANCHE se il taker fallisce, perche' e' l'unica cosa che resta a lavorare.
      if (piano.taker) gambe.push({ ...piano.taker, taker: true });
      if (piano.limite) gambe.push({ ...piano.limite, taker: false });
      const fatte = [];
      for (const g of gambe) {
        let r;
        try {
          r = await piazzaChiudendo({
            marketId, book: altroBook, side: 'BUY', price: g.prezzo, size: g.size,
            // I TRE CAMPI CHE IL GATE RIVERIFICA. `manual-order` rifa' l'aritmetica del tetto e rifiuta
            // se `carico + prezzo` lo supera: il limite e' duro perche' e' controllato due volte, qui e la'.
            ...(g.taker
              ? { attraversaApposta: true, completaCoppia: true, prezzoCaricoCoppia: prezzoCarico, tettoCoppiaCents: piano.tettoCents }
              : { inCoda: true }),
            // Entrambe le gambe della chiusura rapida comprano dentro `manca`: `pianificaChiusuraRapida`
            // non propone mai piu' dello scoperto, e `provaChiusura` lo riverifica sullo snapshot.
            chiudePosizione: true,
            source: AUTO_CLOSE_SOURCE,
            note: `chiusura rapida ${g.taker ? 'TAKER' : 'LIMIT'}: ${g.size} share di ${altroBook.toUpperCase()} a ${g.prezzo}`
              + ` su carico ${prezzoCarico} — coppia a ${((prezzoCarico + g.prezzo) * 100).toFixed(1)}¢, tetto ${piano.tettoCents}¢`,
          },
          { deps, audit, t0, etichetta: `chiusura-rapida-${g.taker ? 'taker' : 'limit'}` });
        } catch (e) { r = { ok: false, gate: 'exception', reason: e.message }; }
        const rok = !!(r && r.ok);
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: rok ? `chiusura-rapida-${g.taker ? 'taker' : 'limit'}-piazzata`
            : `chiusura-rapida-${g.taker ? 'taker' : 'limit'}-reject-${(r && r.gate) || 'venue'}`,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: piano.motivo,
          requested: { book: altroBook, side: 'BUY', price: g.prezzo, size: g.size, taker: g.taker },
          gate: (r && r.gate) || null,
          observed: { tettoCents: piano.tettoCents, prezzoCarico, prezzoMassimo: piano.prezzoMassimo,
            coppiaCents: +((prezzoCarico + g.prezzo) * 100).toFixed(2), manca, scoperto: piano.scoperto } });
        if (rok) fatte.push({ ...g, orderId: (r && r.orderId) || null });
      }
      if (fatte.length) {
        // Il limit di chiusura rapida e' un'attesa come il Livello 2, e va all'orologio per la stessa
        // ragione: senza scadenza resterebbe sul libro per sempre e verrebbe ripiazzato a ogni ciclo.
        const conLimite = fatte.find((f) => f.taker === false);
        if (conLimite) { try { reg.segna(chiaveMerge, { at: t0, orderId: conLimite.orderId, size: conLimite.size, prezzo: conLimite.prezzo }); } catch { /* il giro dopo riprova */ } }
        const tk = fatte.find((f) => f.taker === true);
        return { esito: 'piazzato', livello: liv.livello, chiusuraRapida: true,
          prezzo: (tk || conLimite).prezzo, size: fatte.reduce((s, f) => s + f.size, 0),
          orderId: (tk || conLimite).orderId, altroBook, cancellatiPrima: unici,
          motivo: `chiusura rapida: ${piano.motivo}` };
      }
      ultimoMotivo = `chiusura rapida non piazzata (${ultimoMotivo || 'nessun motivo dai livelli'})`;
    } else if (!piano.ok) {
      ultimoMotivo = `${ultimoMotivo || 'livelli non piazzabili'} · chiusura rapida non applicabile: ${piano.motivo}`;
    }
  }

  // ── ULTIMO PASSO: NON RESTARE MUTI ──────────────────────────────────────────────────────────────
  // Si arriva qui quando NIENTE ha completato la coppia: ne' i Livelli 1-2 del merge, ne' la chiusura
  // rapida. Fino al 9 agosto 2026 il flusso finiva qui e proseguiva verso l'uscita ordinaria, che nel
  // caso «banda scesa sotto il carico» risponde `skip-no-target` — cioe' nessun ordine, zero premi,
  // posizione direzionale ferma. Era lo stato di entrambe le posizioni London quel giorno.
  //
  // ORDINE, ed e' quello che il requisito chiede: questa parte sta DOPO la chiusura rapida, non in
  // parallelo. Se il taker e' scattato non si arriva mai qui — si e' gia' tornati con `piazzato`.
  //
  // DUE GAMBE, DUE LAVORI: il lato POSSEDUTO va a +1% dal carico (schiacciato sul tetto della banda se
  // lo supera) cosi' l'attesa matura premi; la CONTROPARTE va a limit per completare la coppia senza
  // taker. Sono indipendenti: se una non e' proponibile si piazza l'altra.
  if (CHIUSURA_RAPIDA_ENABLED) {
    const bandaRaggioR = Number.isFinite(rules.maxSpreadCents) ? raggioBandaCents(rules.maxSpreadCents) : null;
    const midMio = rules.books && rules.books[book] ? rules.books[book].scoringMid : null;
    const bandaHi = Number.isFinite(bandaRaggioR) && Number.isFinite(midMio) ? midMio + bandaRaggioR / 100 : null;
    // La banda dell'ALTRO libro: serve a mettere la controparte in cima alla banda quando il lato
    // posseduto e' muto per banda-sotto-carico. Si legge dallo stesso posto della propria, e se non c'e'
    // resta null — allora l'eccezione non si apre e si torna al prezzo da tetto, cioe' a prima.
    const midAltro = rules.books && rules.books[altroBook] ? rules.books[altroBook].scoringMid : null;
    const bandaHiAltro = Number.isFinite(bandaRaggioR) && Number.isFinite(midAltro) ? midAltro + bandaRaggioR / 100 : null;
    const rip = pianificaRiposizionamentoScoperto({
      prezzoCarico, sizePosseduta: Number(liv.numeri && liv.numeri.sizePosseduta), manca,
      bandaHi, tick, minSize, bandaHiControparte: bandaHiAltro,
      // La PROFONDITA' dell'altro libro: e' li' che si legge «davanti a chi». Stessa lettura gia' in
      // scope per il Livello 1, nessuna chiamata nuova al venue.
      bidsControparte: dpMerge && dpMerge[altroBook] && Array.isArray(dpMerge[altroBook].bids) ? dpMerge[altroBook].bids : null,
      asksControparte: dpMerge && dpMerge[altroBook] && Array.isArray(dpMerge[altroBook].asks) ? dpMerge[altroBook].asks : null,
      // Si arriva qui solo dopo che i Livelli 1 e 2 e la chiusura rapida hanno fallito: il piano A e'
      // fallito da un pezzo, quindi le regole di chiusura sono attive e valgono anche su questo stadio.
      modalitaChiusura: regoleAttive,
    });
    if (rip.ok) {
      const messe = [];
      for (const [quale, g] of [['lato-posseduto', rip.latoPosseduto], ['controparte', rip.controparte]]) {
        if (!g) continue;
        const vende = quale === 'lato-posseduto';
        // ── L'UNICO PUNTO IN CUI «MAI PRIMI SUL LIBRO» NON SI APPLICA ─────────────────────────────
        // `inCoda` e' OPT-IN: la regola si applica solo a chi la dichiara (`manual-order.js:879`).
        // Qui la si omette per la SOLA controparte, e SOLO quando `pianificaRiposizionamentoScoperto`
        // ha marcato `primoAssoluto` — cioe' quando il lato posseduto e' muto per banda-sotto-carico e
        // quell'ordine e' l'unica cosa che puo' chiudere la posizione. Ogni altra gamba di questo file,
        // compreso il lato POSSEDUTO qui accanto, continua a dichiarare `inCoda: true`.
        const primoAssoluto = !vende && g.primoAssoluto === true;
        let r;
        try {
          r = await deps.placeOrder({
            marketId, book: vende ? book : altroBook, side: vende ? 'SELL' : 'BUY',
            price: g.prezzo, size: g.size, ...(primoAssoluto ? {} : { inCoda: true }), source: AUTO_CLOSE_SOURCE,
            // ── IL TETTO PER ORDINE NON RIGUARDA NEMMENO QUESTO RAMO (13 agosto 2026) ──────────────
            // ⚠ IL FATTO. L'esenzione di §5 p.76 era dichiarata dal completamento coppia e NON da qui,
            // che è il ramo che gestisce una posizione NUDA quando la banda è sotto il carico. Misurato:
            // una SELL di 52,6 share GIÀ POSSEDUTE su `0x791c61d4` rifiutata con `manual-order-cap`
            // — «controvalore $24,72 oltre il tetto per ordine $21,34» — e **1.331 rifiuti
            // `manual-order-cap`** nello slice recente. Un tetto che esiste per limitare le APERTURE
            // impediva di RIDURRE un'esposizione già aperta. Quinta occorrenza della classe
            // «protezione presente su un percorso e assente sul suo gemello».
            //
            // ⚠ E VALE PER ENTRAMBE LE GAMBE, che riducono entrambe — in due modi diversi:
            //   · `lato-posseduto` è una SELL di share che POSSEDIAMO: toglie esposizione, punto;
            //   · `controparte` è una BUY sull'altro lato che APPAIA: non riduce il conteggio dei
            //     token, ma porta l'esposizione DIREZIONALE verso zero, che è ciò che il tetto protegge.
            //
            // ⚠ NON È UNA DICHIARAZIONE DI CUI CI SI FIDA. `placeManualOrder` (GATE 4) rifà l'aritmetica
            // con `provaChiusura` sullo snapshot posizioni del venue: una SELL oltre il posseduto o una
            // BUY oltre `manca` NON viene esentata, e il tetto di `safety-risk-limits` resta comunque
            // intatto — l'esenzione riguarda il solo cap live-min, e solo quando è lui a mordere.
            // Se lo snapshot non è leggibile non c'è esenzione: il capitale resta fermo, che è il verso
            // giusto in cui sbagliare.
            chiudePosizione: true,
            note: `riposizionamento scoperto (${quale}): ${g.size} share a ${g.prezzo} su carico ${prezzoCarico}`
              + (vende ? ' — dentro banda e sopra il carico, cosi\' l\'attesa matura premi'
                : ` — completa la coppia a limit, coppia a ${((prezzoCarico + g.prezzo) * 100).toFixed(1)}¢`)
              + (primoAssoluto ? ' · PRIMO ASSOLUTO in banda: il lato posseduto e\' muto per banda-sotto-carico,'
                + ' questo ordine e\' l\'unico che puo\' chiudere la posizione' : ''),
          });
        } catch (e) { r = { ok: false, gate: 'exception', reason: e.message }; }
        const rok = !!(r && r.ok);
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: rok ? `riposizionamento-scoperto-${quale}-piazzato` : `riposizionamento-scoperto-${quale}-reject-${(r && r.gate) || 'venue'}`,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: rip.motivo,
          requested: { book: vende ? book : altroBook, side: vende ? 'SELL' : 'BUY', price: g.prezzo, size: g.size },
          gate: (r && r.gate) || null,
          observed: { prezzoCarico, bandaHi, bandaHiAltro, manca, primoAssoluto,
            latoPossedutoMotivo: rip.latoPossedutoMotivo } });
        if (rok) messe.push({ quale, ...g, orderId: (r && r.orderId) || null });
      }
      if (messe.length) {
        return { esito: 'piazzato', livello: liv.livello, riposizionamentoScoperto: true, altroBook,
          prezzo: messe[0].prezzo, size: messe.reduce((a, x) => a + x.size, 0),
          orderId: messe[0].orderId, cancellatiPrima: unici,
          motivo: `riposizionamento scoperto: ${rip.motivo}` };
      }
      ultimoMotivo = `${ultimoMotivo || 'nessun livello piazzabile'} · riposizionamento scoperto non piazzato`;
    } else {
      ultimoMotivo = `${ultimoMotivo || 'nessun livello piazzabile'} · riposizionamento scoperto non applicabile: ${rip.motivo}`;
    }
  }

  // ── IL RESIDUO NON RESTA MUTO: È IL PUNTO 3 DELLA REGOLA GENERALE ───────────────────────────────
  // Questo è l'UNICO punto in cui convergono tutti i modi di NON aver coperto un lato: i Livelli 1 e 2
  // del merge, la chiusura rapida, il riposizionamento scoperto — e, al giro successivo, il residuo
  // lasciato da un merge PARZIALE, che rientra qui come un normalissimo lato scoperto. Registrarlo qui
  // e non in tre posti diversi è ciò che lo rende un principio e non tre toppe.
  //
  // Misurato su Dallas il 9 agosto 2026: il merge fonde 36,3 delle 39,7 share di NO e lascia 3,4
  // scoperte; il Livello 2 vorrebbe comprare le 3,4 mancanti di YES ma sono sotto il minimo del venue
  // (20), quindi `merge-saltato-rinuncia` — venti volte di fila, senza che da nessuna parte risultasse
  // che quelle 3,4 share esistono. Adesso risultano.
  segnalaScoperto(manca, `rinuncia · ${liv.azione}`);

  // ── (a)(b)(c) · IL RIMASUGLIO SOTTO IL MINIMO NON RESTA SOLO A REGISTRO ──────────────────────────
  // Il registro qui sopra continua a fare il suo lavoro — questo passo si AGGIUNGE, non lo sostituisce.
  // `fill` e' la STESSA classificazione calcolata in cima alla fase 1: una sola lettura dei numeri, cosi'
  // «che tipo di fill e' questo» non puo' avere due risposte diverse dentro la stessa funzione.
  if (fill.tipo === FILL_PARZIALE || fill.tipo === FILL_COMPLETO) {
    // Il prezzo della RIMANENZA: dentro la banda e sopra il carico, la stessa regola del lato posseduto
    // del riposizionamento scoperto. Se non e' calcolabile la rimanenza non si propone e resta la sola
    // controparte — le due gambe sono indipendenti.
    const bandaRaggio = Number.isFinite(rules.maxSpreadCents) ? raggioBandaCents(rules.maxSpreadCents) : null;
    const midMio = rules.books && rules.books[book] ? Number(rules.books[book].scoringMid) : null;
    const bandaHiMio = Number.isFinite(bandaRaggio) && Number.isFinite(midMio) ? midMio + bandaRaggio / 100 : null;
    const prezzoRim = Number.isFinite(prezzoCarico) && Number.isFinite(bandaHiMio)
      ? Math.min(bandaHiMio, prezzoCarico * 1.01) : null;
    const rim = pianificaRimasuglio({
      manca, minSize, book, prezzoRimanenza: prezzoRim, tick,
      bidsControparte: dpMerge && dpMerge[altroBook] ? dpMerge[altroBook].bids : null,
      asksControparte: dpMerge && dpMerge[altroBook] ? dpMerge[altroBook].asks : null,
      // Il tetto della coppia, quello di sempre: il prezzo della controparte non puo' portare la coppia
      // oltre il tetto della coppia. Non e' un numero nuovo — e' `TETTO_COPPIA_CENTS`, riusato, e il
      // suo valore si legge in `chiusura-rapida` e in nessun altro posto (§5.2 p.28).
      massimoControparte: Number.isFinite(prezzoCarico) ? (TETTO_COPPIA_CENTS / 100) - prezzoCarico : null,
    });
    if (rim.ok) {
      const messe = [];
      for (const [quale, g] of [['rimanenza', rim.rimanenza], ['controparte-aggressiva', rim.controparte]]) {
        if (!g) continue;
        // ── LA SECONDA ECCEZIONE A «MAI PRIMI SUL LIBRO», E RESTA PUNTUALE ─────────────────────────
        // `inCoda` e' opt-in: si omette SOLO sulla controparte aggressiva, e solo perche' `g.primoAssoluto`
        // e' true — cioe' solo in questo caso. La RIMANENZA qui accanto dichiara `inCoda: true` come
        // ogni altra gamba del file: e' un ordine che aspetta, quindi la regola gli si applica intera.
        const esente = g.primoAssoluto === true;
        let r;
        try {
          r = await deps.placeOrder({
            marketId, book: g.book, side: g.side, price: g.prezzo, size: g.size,
            ...(esente ? {} : { inCoda: true }), source: AUTO_CLOSE_SOURCE,
            note: `${quale}: ${g.size} share di ${g.book.toUpperCase()} a ${g.prezzo} — rimasuglio di ${manca} share`
              + ` sotto il minimo del venue (${minSize}), ${fill.tipo}`
              + (esente ? ' · PRIMO ASSOLUTO: serve a chiudere il rimasuglio con un merge, non a maturare premi' : ''),
          });
        } catch (e) { r = { ok: false, gate: 'exception', reason: e.message }; }
        const rok = !!(r && r.ok);
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: rok ? `rimasuglio-${quale}-piazzato` : `rimasuglio-${quale}-reject-${(r && r.gate) || 'venue'}`,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
          reason: rok ? rim.motivo : ((r && r.reason) || 'piazzamento non riuscito'),
          requested: { book: g.book, side: g.side, price: g.prezzo, size: g.size },
          gate: (r && r.gate) || null,
          observed: { tipoFill: fill.tipo, manca, minSize, primoAssoluto: esente, sizePosseduta: fill.sizePosseduta, sizeAltroLato: fill.sizeAltroLato } });
        if (rok) messe.push({ quale, ...g, orderId: (r && r.orderId) || null });
      }
      if (messe.length) {
        return { esito: 'piazzato', livello: liv.livello, rimasuglio: true, tipoFill: fill.tipo, altroBook,
          prezzo: messe[0].prezzo, size: messe.reduce((a, x) => a + x.size, 0), orderId: messe[0].orderId,
          cancellatiPrima: unici, motivo: `${fill.motivo} · ${rim.motivo}` };
      }
      ultimoMotivo = `${ultimoMotivo || 'nessun livello piazzabile'} · rimasuglio non piazzato (${rim.motivo})`;
    } else {
      ultimoMotivo = `${ultimoMotivo || 'nessun livello piazzabile'} · rimasuglio: ${rim.motivo}`;
    }
  }

  return { esito: 'rinuncia', livello: liv.livello, prezzo: null, size: null, orderId: null,
    tipoFill: fill.tipo,
    motivo: ultimoMotivo || 'nessun livello di completamento e stato piazzabile', cancellatiPrima: unici };
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
  // Un mercato ha DUE lati e il ciclo li visita entrambi: senza questo, la pulizia dei registri
  // partirebbe due volte per lo stesso mercato morto, e la seconda troverebbe tutto gia' pulito
  // producendo una riga d'audit che sembra un'anomalia.
  const mercatiRipuliti = new Set();
  // Le fusioni riuscite di questo giro, da riposizionare a fine ciclo: si esegue FUORI dal ramo perche'
  // un riposizionamento non deve poter allungare ne' far fallire la chiusura che l'ha reso possibile.
  const riposizionamenti = [];
  const audit = typeof deps.audit === 'function' ? deps.audit : () => {};

  // ══ OGNI DECISIONE DI MERGE DEVE PRODURRE UN ESITO SCRITTO ═══════════════════════════════════════
  // ⚠ DIFETTO MISURATO IL 12 AGOSTO 2026, ed e' il piu' insidioso di questo file perche' non produce
  // NIENTE: sul mercato Vindman (`cid_b73f32c2`), fra le 17:59:38 e le 18:12, il ciclo ha scritto
  // **14 righe `merge-livello-2`** — la decisione, con tutti i suoi numeri — e **zero righe di esito**.
  // Non un `-piazzato`, non un `-reject-`, non un `merge-saltato-*`. La causa e' nel ramo `skip`
  // (piu' sotto), ma la CLASSE del difetto e' qui: una decisione presa poteva uscire senza che nessun
  // ramo fosse obbligato a dire com'era finita, e chi legge l'audit non aveva modo di distinguere
  // «non e' stato tentato» da «e' stato tentato e rifiutato».
  //
  // LA GARANZIA NON E' UNA PROMESSA, E' UN OBBLIGO CHE SI APRE E VA CHIUSO. `apriObbligo` lo registra
  // nell'istante in cui la riga di decisione viene scritta; `chiudiObbligo` lo scarica da ogni esito;
  // `flushObblighi` emette `merge-esito-mancante` per qualunque obbligo ancora aperto. I due punti di
  // flush sono scelti perche' NESSUN `continue` puo' saltarli:
  //   · in cima a ogni iterazione della posizione — scarica quella precedente;
  //   · dopo il ciclo delle posizioni — scarica l'ultima, e un `continue` sull'ultima posizione
  //     esce dal ciclo e arriva comunque li'.
  // ⚠ CASO RESIDUO DICHIARATO: un'eccezione che sfugge dal corpo della posizione fa fallire l'INTERO
  // ciclo, quindi nessun flush gira. Non e' un ramo silenzioso — agent40 lo registra come `lastError`
  // sul battito e il ciclo risulta non eseguito, che e' visibile in un modo diverso e piu' rumoroso.
  const obblighiEsito = new Map();
  const apriObbligo = (chiave, dati) => { obblighiEsito.set(chiave, dati); };
  const chiudiObbligo = (chiave) => { obblighiEsito.delete(chiave); };
  const flushObblighi = () => {
    for (const [chiave, d] of obblighiEsito) {
      audit({ ts: now(), venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
        outcome: 'merge-esito-mancante', marketRef: d.marketRef,
        reason: `decisione di merge livello ${d.livello} registrata senza nessun esito: il ciclo e' uscito`
          + ` da un ramo che non ha ne' tentato ne' dichiarato il completamento`
          + (d.ultimoRamo ? ` (ultimo ramo visto: ${d.ultimoRamo})` : ''),
        observed: { chiave, livello: d.livello, azione: d.azione, book: d.book, ramo: d.ultimoRamo || null } });
      actions.push({ marketId: d.marketId, tokenId: d.tokenId, book: d.book,
        action: 'merge-esito-mancante', livello: d.livello, gate: 'esito-non-scritto' });
    }
    obblighiEsito.clear();
  };

  const result = (gate, reason) => ({ at: new Date(t0).toISOString(), ran: gate == null, gate, reason, markets, actions });

  const marketIds = Array.isArray(deps.marketIds) ? deps.marketIds : [];

  // ── LA CODA DEGLI ORFANI SI LEGGE QUI, E NON PIU' IN FONDO ────────────────────────────────────
  // Un mercato la cui gamba orfana e' stata cancellata ha ZERO posizioni per definizione, quindi puo'
  // benissimo non essere in `marketIds` (che elenca i mercati con la chiusura automatica accesa). Con
  // la lettura in fondo, il `return` qui sotto la saltava e la coda non veniva MAI drenata: il
  // riposizionamento sarebbe esistito nel codice e non sarebbe mai partito. La si legge una volta
  // sola — quindi si drena una volta sola — e la sua presenza basta a far girare il ciclo.
  let codaOrfani = [];
  if (typeof deps.mercatiDaRipianificare === 'function') {
    try { codaOrfani = deps.mercatiDaRipianificare() || []; }
    catch (e) { codaOrfani = []; actions.push({ action: 'ripianificazione-orfani', ok: false, reason: e && e.message ? e.message : String(e) }); }
  }
  if (!marketIds.length && !codaOrfani.length) return result('no-markets', 'nessun mercato con la chiusura automatica abilitata');

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

    for (let pos of mine) {
      // PRIMO FLUSH: scarica l'obbligo lasciato aperto dalla posizione precedente. Sta in CIMA e non
      // in fondo perche' il corpo e' pieno di `continue` — in fondo non ci arriverebbe quasi mai.
      flushObblighi();
      const tok = String(pos.tokenId ?? pos.asset ?? '');
      const book = tok === String(rules.tokenIdNo) ? 'no' : 'yes';

      // ══ IL CARICO, CON IL RIPIEGO SE IL VENUE NON L'HA ANCORA PUBBLICATO — 17 agosto 2026 ═══════
      // Misurato: su ENTRAMBI i fill avversi del 16 agosto il primo ciclo dopo il riempimento e' uscito
      // a `skip-no-entry-price`, e `decidiLivello` ha calcolato «il lato riempito e' costato 0,0¢».
      // Un ciclo intero — 60 s — in cui ne' la scala ne' il merge potevano agire, il 100% delle volte.
      // Il ripiego e' il prezzo del NOSTRO ordine limite, che per un BUY e' un limite SUPERIORE del
      // prezzo pagato: sbaglia verso l'inerzia in entrambe le direzioni (tetto del merge piu' stretto,
      // bersaglio d'uscita piu' alto). Non sostituisce mai il dato vero e dichiara sempre la fonte.
      const rip = caricoDaUsare({
        avgPrice: Number(pos.avgPrice), tokenId: tok,
        ordiniVivi: (resting.orders || []),
        ultimoNostroPrezzo: typeof deps.ultimoNostroPrezzo === 'function'
          ? deps.ultimoNostroPrezzo({ marketId, tokenId: tok, book }) : null,
      });
      if (rip.stimato === true) {
        // ⚠ SI DICHIARA A VERBALE OGNI VOLTA. Un carico stimato che si presenta come misurato e' peggio
        // di un carico assente: domani nessuno saprebbe quali decisioni sono state prese su una stima.
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: 'carico-di-ripiego',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: rip.motivo,
          observed: { book, tokenId: tok, carico: rip.carico, fonte: rip.fonte, size: pos.size } });
      }
      // Da qui in giu' `pos` porta il carico da usare. Si sostituisce l'oggetto invece di mutarlo:
      // `mine` viene dallo snapshot e altri rami lo rileggono.
      if (rip.carico !== null && !(Number(pos.avgPrice) > 0)) pos = { ...pos, avgPrice: rip.carico };

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
        // L'OBBLIGO SI APRE QUI, NELLA STESSA ISTRUZIONE CHE SCRIVE LA DECISIONE: da questo punto in
        // poi il ciclo non puo' piu' uscire in silenzio su questa posizione.
        apriObbligo(chiaveMerge, { marketId, tokenId: tok, book, livello: liv.livello, azione: liv.azione,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, ultimoRamo: null });
      } catch (e) {
        // Un'osservazione che non riesce non deve poter fermare la chiusura, che e' l'unica cosa che
        // qui protegge davvero del capitale.
        liv = null; void e;
      }

      // ══ DA QUANTO TEMPO QUESTA POSIZIONE E' SCOPERTA — §5 punto 138 ══════════════════════════════
      // L'orologio non e' nuovo: e' il timestamp della MODALITA' CHIUSURA, che nasce col fill, e'
      // persistito su disco e viene cancellato da `esciDaChiusura` quando la coppia si chiude. Cioe'
      // e' gia' esattamente «da quando questa gamba e' scoperta», e non serviva un secondo registro.
      //
      // ⚠ REGISTRO NON CABLATO O TIMESTAMP ILLEGGIBILE ⇒ GRADINO 0, cioe' il comportamento di prima.
      // La concessione costa capitale reale e non si paga contro un dato che non si e' letto: e' la
      // stessa direzione di `ignota` altrove, e qui coincide con «non concedere niente».
      let urgenza = null;
      try {
        // `leggi(marketId, book)` restituisce gia' il verdetto di `MC.leggiChiusura`, con `daMin`
        // calcolato: non si rilegge il registro a mano, o nascerebbe una seconda idea di quel numero.
        const st = deps.chiusura && typeof deps.chiusura.leggi === 'function'
          ? deps.chiusura.leggi(marketId, book) : null;
        urgenza = livelloUrgenza({ scopertoDaMin: st && st.attiva === true ? st.daMin : null });
      } catch { urgenza = livelloUrgenza({ scopertoDaMin: null }); }

      let ordiniVivi = resting.orders || [];
      // ⚠ `depth` E' LA STESSA LETTURA CHE IL CICLO HA GIA' FATTO SOPRA (`dpMerge`), non una nuova.
      // La presa di profitto ha bisogno della scala dei bid del lato posseduto e di quella degli ask
      // dell'altro lato: entrambe sono qui dentro. Passarla invece di rileggerla e' la differenza fra
      // aggiungere una decisione e aggiungere del lavoro a un ciclo che gira ogni ~60s per mercato.
      let d = decideClose({ position: { tokenId: tok, size: pos.size, avgPrice: pos.avgPrice }, restingOrders: ordiniVivi, rules, book, venue, urgenza, depth: dpMerge });
      // ══ IL TIMBRO DELLA VALUTAZIONE — 17 agosto 2026, requisito dell'operatore ═══════════════════
      // Si timbra QUI e non all'inizio del ciclo, ed e' tutta la differenza: un ciclo che parte e non
      // arriva a questo mercato NON lo ha valutato, e timbrarlo a monte trasformerebbe il presidio in
      // una macchina che certifica se stessa. Il 16 agosto una posizione e' rimasta aperta cinque ore
      // con `urgenzaLivello` comparso UNA volta: il ciclo girava, quella posizione no.
      // ⚠ Il timbro sta DOPO `decideClose` e non dopo l'esecuzione: la domanda dell'operatore e' «la
      // scala e' stata VALUTATA?», non «ha agito?». Una valutazione che decide `already-covered` e'
      // una valutazione a tutti gli effetti; un ciclo che non la fa e' il difetto.
      // ⚠ Dep non cablata ⇒ non si timbra e non si rompe niente (§5.3).
      if (typeof deps.segnaValutazione === 'function') {
        try { deps.segnaValutazione({ marketId, tokenId: tok, book, azione: d.action }); }
        catch { /* un registro non scritto non deve poter fermare una chiusura */ }
      }
      if (liv) { d.mergeLivello = liv.livello; d.mergeAzione = liv.azione; d.mergeEseguito = MERGE_STRATEGY_ENABLED; }

      // ══ L'ANOMALIA GRAVE: OLTRE LE QUATTRO ORE NESSUNA SCOPERTURA E' MAI RIENTRATA ══════════════
      // Misurato sulle 48 ore: 7 scoperture chiuse (mediana 10,5 min, q75 29,3) contro 17 ancora
      // aperte (mediana 126,5 min, massimo 553,7). Oltre la quarta ora non e' piu' un'attesa lunga:
      // e' un guasto, e in questo progetto non c'e' nessuno a leggere i log — quindi si scrive nel
      // giornale, dove la sentinella e l'autodiagnosi lo trovano, e NON si tace.
      //
      // ⚠ NON AGISCE. E' l'unico gradino della scala che non apre nessuna via: le vie sono gia' tutte
      // aperte al gradino 3, e se a quel punto la posizione e' ancora scoperta e' perche' il libro non
      // la lascia chiudere — inventarne una quarta significherebbe violare una regola di rischio.
      if (urgenza && urgenza.anomaliaGrave === true) {
        console.log(`⚠ ANOMALIA GRAVE · ${String(marketId).slice(0, 10)} ${book}: posizione scoperta da `
          + `${(urgenza.minuti / 60).toFixed(1)}h (${pos.size} share, carico ${pos.avgPrice}). `
          + 'Tutte le vie della scala di urgenza sono aperte e nessuna ha chiuso la posizione.');
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: 'scoperto-oltre-soglia-grave',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
          reason: `posizione scoperta da ${urgenza.minuti} minuti: oltre la soglia grave di `
            + `${SOGLIE_URGENZA.anomalia} min nessuna scopertura misurata e' mai rientrata da sola`,
          observed: { book, urgenzaLivello: urgenza.livello, scopertoDaMin: urgenza.minuti,
            size: Number(pos.size), prezzoCarico: Number(pos.avgPrice),
            nozionaleUsd: +(Number(pos.size) * Number(pos.avgPrice) || 0).toFixed(2),
            concessioneTick: urgenza.concessioneTick, profitPct: urgenza.profitPct } });
      }
      // Ridecidere dopo che il tentativo di merge ha cancellato qualcosa: gli ordini che non ci sono
      // piu' non devono continuare a contare. Senza questo, una rinuncia dopo una cancellazione
      // riuscita lascerebbe la posizione senza uscita a riposo fino al giro dopo.
      const ridecidi = (idsTolti) => {
        if (!idsTolti || !idsTolti.length) return;
        const tolti = new Set(idsTolti.map(String));
        ordiniVivi = ordiniVivi.filter((o) => !tolti.has(String(o && o.orderId)));
        d = decideClose({ position: { tokenId: tok, size: pos.size, avgPrice: pos.avgPrice }, restingOrders: ordiniVivi, rules, book, venue, urgenza, depth: dpMerge });
        if (liv) { d.mergeLivello = liv.livello; d.mergeAzione = liv.azione; d.mergeEseguito = MERGE_STRATEGY_ENABLED; }
      };

      if (d.action === 'skip' && (d.gate === 'market-closed' || d.gate === 'market-not-accepting')) {
        m.skipped = (m.skipped || 0) + 1;
        actions.push({ marketId, tokenId: tok, book, action: 'skip', gate: d.gate, reason: d.reason });
        audit({ ts: now(), venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: d.gate,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: d.reason, observed: { size: d.size } });
        // ══ IL MERCATO E' MORTO: I SUOI REGISTRI SE NE VANNO CON LUI ═════════════════════════════
        // Fin qui questo ramo faceva `continue` e basta, quindi un mercato risolto restava scritto in
        // sei file di stato e ogni ciclo continuava a visitarlo per poi rifiutarsi di fare qualcosa.
        //
        // ⚠ SI ATTACCA A `closed`/`acceptingOrders`, NON ALL'OROLOGIO, ed e' la meta' che mancava:
        // `market-clock` legge `endDate`, quindi vede la scadenza NOMINALE. Un mercato ANNULLATO prima
        // — voidato, risolto in anticipo, ritirato — quella scadenza non la raggiunge mai. Qui la
        // domanda e' «il venue lo accetta ancora?», che copre entrambi i casi con lo stesso codice.
        //
        // A LIBRO LIBERO E BASTA: se abbiamo ancora un ordine a riposo qui non si tocca niente. Vale
        // la stessa disciplina di `allowlist-auto-off` — prima si toglie tutto, poi si chiudono i
        // registri, mai il contrario. `ordiniVivi` e' la lettura che il ciclo ha GIA' fatto.
        if (typeof deps.pulisciMercatoChiuso === 'function' && !mercatiRipuliti.has(marketId)) {
          mercatiRipuliti.add(marketId);
          const nostriQui = (Array.isArray(ordiniVivi) ? ordiniVivi : []).length;
          try {
            const pul = deps.pulisciMercatoChiuso({ marketId, causa: d.gate, libroLibero: nostriQui === 0 });
            audit({ ts: now(), venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
              outcome: (pul && pul.ok && pul.puliti && pul.puliti.length) ? 'registri-ripuliti-mercato-chiuso'
                : (nostriQui === 0 ? 'registri-mercato-chiuso-niente-da-pulire' : 'registri-mercato-chiuso-libro-non-libero'),
              marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
              reason: (pul && pul.motivo) || 'nessun referto dalla pulizia',
              observed: { causa: d.gate, ordiniARiposo: nostriQui, puliti: (pul && pul.puliti) || [],
                falliti: (pul && pul.falliti) || [] } });
          } catch (e) {
            audit({ ts: now(), venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
              outcome: 'registri-mercato-chiuso-errore', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
              reason: e && e.message ? e.message : String(e) });
          }
        }
        continue;
      }

      // ── IL COMPLETAMENTO DELLA COPPIA VIENE PRIMA DELLA VENDITA. SEMPRE. ─────────────────────────
      // Un solo cablaggio, riusato dai tre rami che seguono, cosi' «prima si prova a completare» non
      // puo' piu' essere vero solo su uno di essi. Cosa passa PRIMA e non viene toccato: mercato
      // chiuso e mercato che non accetta ordini (sopra, con `continue`) — la' non si piazza niente di
      // niente, quindi non c'e' gerarchia da rispettare.
      const provaCoppia = (idsDaTogliere) => completaCoppia({
        marketId, tok, book, rules, liv, dpMerge, attesa, chiaveMerge, reg,
        cancelOrderIds: idsDaTogliere, prezzoCarico: pos.avgPrice, deps, audit, t0,
        // Gli ordini a riposo di QUESTO mercato, dalla lettura che il ciclo ha gia' fatto.
        ordiniMercato: ordiniVivi,
      });
      const registraCoppia = (esito, ramo) => {
        // ── L'OBBLIGO SI SCARICA QUI, PER COSTRUZIONE ─────────────────────────────────────────────
        // Un esito e' arrivato: qualunque esso sia, la decisione ha una risposta. Ogni ramo di questa
        // funzione scrive una riga — `piazzato` e `fuso` la scrivono piu' a fondo (nel piazzamento e
        // nella fusione), `in-attesa` e tutto il resto la scrivono qui.
        chiudiObbligo(chiaveMerge);
        // LA FUSIONE CHIUDE IL CASO. Dopo un merge on-chain la coppia non esiste più: non c'è niente
        // da vendere e niente da attendere, quindi si torna `true` e il ramo fa `continue`. È l'unico
        // esito che rende la posizione VERAMENTE chiusa dentro questo ciclo.
        if (esito.esito === 'fuso') {
          m.fusi = (m.fusi || 0) + 1;
          actions.push({ marketId, tokenId: tok, book, action: 'merge-onchain', ok: true, ramo,
            size: esito.size, transactionHash: esito.transactionHash || null, reason: esito.motivo });
          // IL PASSO FINALE DELLA CHIUSURA, non un'azione separata: il collaterale appena liberato torna
          // a fare liquidita' sullo stesso mercato, se il mercato regge ancora i suoi gate. Un tentativo
          // solo; se non passa, il capitale torna al ciclo normale.
          // ── (d) LA SIZE DEL RIPOSIZIONAMENTO — 9 agosto 2026 ────────────────────────────────────
          // Qui c'era `capitaleUsd: Number(esito.size)`, cioè «rimetti al lavoro quanto hai appena
          // fuso». Sbagliato per due ragioni: la size fusa è un caso, non un obiettivo, e il mercato
          // restava sotto-quotato rispetto a quello che il tetto in vigore consente. Adesso il target
          // è il TETTO ATTUALE (`maker-allocated-capital.json`, oggi $130), col ripiego su quanto
          // c'è davvero. Vedi `risposta-al-fill.capitalePerRiposizionamento`.
          riposizionamenti.push({ marketId, rules, book, causa: 'merge riuscito' });
          return true;
        }
        if (esito.esito === 'piazzato') {
          m.mergePiazzati = (m.mergePiazzati || 0) + 1;
          actions.push({ marketId, tokenId: tok, book, action: `merge-livello-${esito.livello}`, ok: true, ramo,
            altroBook: esito.altroBook, price: esito.prezzo, size: esito.size, sent: esito.sent, orderId: esito.orderId,
            rimasuglio: esito.rimasuglio === true, tipoFill: esito.tipoFill || null });
          // ── (d) · IL SECONDO PERCORSO CHE RIPOSIZIONA ──────────────────────────────────────────
          // Fino al 9 agosto 2026 il riposizionamento partiva SOLO dal merge riuscito. Ma «la gestione
          // del fill e' conclusa» vale anche quando a chiuderla e' stata la gamba aggressiva — del
          // rimasuglio o del riposizionamento scoperto. In entrambi i casi il mercato ha finito di
          // reagire al fill e deve tornare alle quantita' che il tetto in vigore consente.
          //
          // NON si riposiziona su un `piazzato` dei Livelli 1/2 ordinari: li' la coppia si sta ancora
          // completando e l'esito e' aperto. Solo i due esiti TERMINALI della gestione del fill.
          if (esito.rimasuglio === true || esito.riposizionamentoScoperto === true) {
            riposizionamenti.push({ marketId, rules, book,
              causa: esito.rimasuglio === true ? 'rimasuglio gestito' : 'riposizionamento scoperto' });
          }
          return true;
        }
        if (esito.esito === 'in-attesa') {
          m.inAttesaMerge = (m.inAttesaMerge || 0) + 1;
          actions.push({ marketId, tokenId: tok, book, action: 'merge-in-attesa', livello: 2, ramo,
            attesaMin: liv && liv.numeri && liv.numeri.attesaMin, orderId: esito.orderId });
          // Il ramo «completamento gia' a riposo» non scriveva nessuna riga: l'attesa e' un ESITO —
          // e' la risposta «ci sto gia' lavorando» — e senza traccia era indistinguibile dal silenzio.
          audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
            outcome: 'merge-in-attesa', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
            reason: esito.motivo,
            observed: { ramo, livello: esito.livello, book, orderId: esito.orderId || null,
              attesaMin: liv && liv.numeri && liv.numeri.attesaMin, sorellaAumentata: esito.sorellaAumentata || null } });
          return true;
        }
        // ── `non-applicabile` NON E' PIU' UN ESITO MUTO ──────────────────────────────────────────
        // Era l'unico ramo di questa funzione che usciva senza scrivere niente, con il ragionamento
        // implicito «non c'era niente da fare, quindi non c'e' niente da dire». Sbagliato: «non c'era
        // una coppia da completare» e «il completamento non e' stato nemmeno tentato» sono due fatti
        // diversi, e distinguerli e' esattamente il lavoro dell'audit. Adesso ogni esito — riuscito,
        // fallito, non applicabile — lascia una riga con il suo motivo.
        actions.push({ marketId, tokenId: tok, book, action: 'merge-non-tentato', ramo,
          gate: esito.esito, reason: esito.motivo, livello: esito.livello });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: `merge-saltato-${esito.esito}`, marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
          reason: esito.motivo, observed: { ramo, livello: esito.livello, book } });
        return false;
      };

      if (d.action === 'already-covered') {
        // ── IL RAMO CHE SALTAVA LA GERARCHIA SENZA DIRLO ─────────────────────────────────────────
        // «C'e' gia' un'uscita a riposo» chiudeva il discorso: la coppia non veniva mai completata su
        // una posizione che stava aspettando di essere venduta, cioe' proprio dove il capitale era
        // fermo da piu' tempo. Adesso il completamento viene tentato PRIMA — togliendo l'uscita, che
        // e' la condizione perche' comprare l'altro lato abbia un senso. Se il merge non e'
        // applicabile o rinuncia, l'uscita e' ancora dov'era e si resta in attesa come prima.
        const c = await provaCoppia(d.cancelOrderIds || []);
        if (registraCoppia(c, 'already-covered')) continue;
        // Se il tentativo ha tolto le uscite e poi ha rinunciato, la posizione e' scoperta ADESSO: si
        // ridecide con la lista vera degli ordini rimasti, cosi' l'uscita torna sul libro in QUESTO
        // ciclo invece che al prossimo. Se non ha cancellato niente, `ridecidi` non fa nulla e il
        // verdetto resta «gia' coperta», identico a prima.
        ridecidi(c.cancellatiPrima);
        if (d.action === 'already-covered') {
          m.covered++;
          actions.push({ marketId, tokenId: tok, book, action: 'already-covered', reason: d.reason });
          continue;
        }
      }

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
        // ── E IL COMPLETAMENTO A RIPOSO, SE C'E' ──────────────────────────────────────────────────
        // `d.cancelOrderIds` porta le uscite e la liquidita' sul lato RIEMPITO; il completamento del
        // Livello 2 sta sull'ALTRO lato, quindi non ci finisce mai. Senza questa riga la chiusura
        // forzata vendeva il primo lato lasciando sul libro il BUY che stava comprando il secondo:
        // comprare e vendere insieme, cioe' esattamente il guasto che tutta questa disciplina esiste
        // per impedire. Si aggiunge alla STESSA lista, cosi' eredita la stessa regola — se una sola
        // cancellazione non riesce, non si vende.
        const daTogliere = [...(d.cancelOrderIds || [])];
        if (attesa && attesa.orderId && !daTogliere.includes(attesa.orderId)) daTogliere.push(attesa.orderId);
        let tolte = 0; let fallita = null;
        for (const oid of daTogliere) {
          let c = null;
          try { c = typeof deps.cancelOrder === 'function' ? await deps.cancelOrder({ orderId: oid, marketId }) : null; }
          catch (e) { c = { ok: false, reason: e.message }; }
          if (c && c.ok !== false) tolte += 1; else fallita = (c && c.reason) || 'ignoto';
        }
        // ── IL MERGE COME ULTIMO TENTATIVO, PRIMA DI VENDERE AL BID ──────────────────────────────
        // Il timeout di chiusura forzata dice «smetti di aspettare», non «vendi comunque». Se la coppia
        // costa meno di un dollaro, completarla e' un profitto matematico e vendere al bid e' la sola
        // alternativa peggiore. Sta QUI, dopo che le cancellazioni sono confermate e prima della
        // vendita: la posizione e' gia' scoperta, quindi comprare l'altro lato non incrocia niente.
        //
        // E' l'ultimo tentativo, non un rinvio senza fine: se il completamento va a riposo (Livello 2)
        // parte il suo orologio di 60 minuti, e alla scadenza `decidiLivello` risponde 3 — cioe' si
        // torna qui e si vende davvero. Se il merge rinuncia, si vende adesso.
        // Tolto l'ordine, l'attesa non ha piu' un oggetto: si chiude, altrimenti resterebbe a puntare
        // a un id cancellato e il giro dopo `decidiLivello` conterebbe ancora i suoi minuti.
        if (!fallita && attesa && attesa.orderId && reg) { try { reg.pulisci(chiaveMerge); attesa = null; } catch { /* non blocca */ } }
        // ⚠ LA PRESA DI PROFITTO NON PASSA DI QUI, ED E' IL PUNTO DELLA REGOLA (§5 p.169).
        // Questo tentativo di coppia esiste perche' «se la coppia costa meno di un dollaro, completarla
        // e' un profitto matematico e vendere al bid e' la sola alternativa peggiore». La presa di
        // profitto ha gia' verificato ESATTAMENTE quella premessa, con l'ask vero e nello stesso
        // istante, e l'ha trovata FALSA: `bid + ask > 100¢ + margine` significa che incassare rende
        // piu' di completare. Lasciar girare `provaCoppia` qui prenderebbe la strada che la decisione
        // ha appena scartato — e la prenderebbe con un confronto piu' debole di quello gia' fatto.
        if (!fallita && d.trigger !== 'presa-di-profitto') {
          const c = await provaCoppia([]);
          if (registraCoppia(c, 'close-at-market')) continue;
        } else if (d.trigger === 'presa-di-profitto') {
          // ⚠ L'OBBLIGO DI ESITO VA SCARICATO A MANO SU QUESTO RAMO. `registraCoppia` lo fa per prima
          // cosa (riga 2083) e qui non viene chiamata: senza questa riga l'obbligo scadrebbe nel flush
          // e comparirebbe come `merge-esito-mancante`, cioe' come un DIFETTO — mentre l'esito c'e',
          // e' scritto (`exit-trigger-presa-di-profitto` piu' sopra, `exit-market-*` piu' sotto) ed e'
          // semplicemente un esito diverso dal merge. E' la stessa forma della riga 2303.
          chiudiObbligo(chiaveMerge);
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
        // ④ ANCHE QUESTO ATTRAVERSAMENTO SI DICHIARA — 17 agosto 2026.
        // Questo percorso PRECEDE il permesso concesso oggi e attraversa da sempre: `attraversaApposta`
        // e' cablato qui sotto. Il limite ④ dell'operatore («ogni attraversamento va dichiarato nel
        // giornale con gradino, prezzo, bid colpito e perdita rispetto al carico») vale per TUTTI, non
        // solo per quelli nuovi — altrimenti il conteggio di domani mancherebbe proprio della meta'
        // che attraversa piu' spesso.
        //
        // ⚠ E QUI VA DETTO CIO' CHE QUESTO PERCORSO **NON** RISPETTA, perche' e' una differenza vera e
        // non un dettaglio: i limiti ② (solo dal gradino 1) e ③ (mai sotto il pavimento della scala)
        // NON si applicano. La ragione e' che questa non e' una concessione della scala: e' la
        // constatazione che l'uscita a riposo e' uscita dalla BANDA premiante, quindi non matura piu'
        // niente e non ha motivo di restare li'. Misurato: puo' vendere a 48¢ su un carico di 54¢,
        // cioe' −6¢, dove la scala ne concederebbe 1. E' una regola preesistente e una decisione di
        // rischio dell'operatore: e' segnalata, non cambiata.
        {
          const perdita = Number.isFinite(Number(pos.avgPrice)) ? +(d.price - Number(pos.avgPrice)).toFixed(6) : null;
          audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
            outcome: 'attraversamento-consentito', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
            reason: `uscita forzata fuori banda (${d.trigger}): attraversa il book. ⚠ Questo percorso NON passa`
              + ' dai limiti di gradino e pavimento — vedi la nota nel sorgente.',
            observed: { book, tokenId: tok, size: d.size, tipo: 'uscita-forzata-fuori-banda',
              gradino: Number.isFinite(d.urgenzaLivello) ? d.urgenzaLivello : null,
              prezzo: d.price, bidColpito: d.price, pavimento: null, carico: pos.avgPrice,
              perditaVsCaricoUsdPerShare: perdita,
              perditaVsCaricoCents: perdita === null ? null : +(perdita * 100).toFixed(3),
              inGuadagno: perdita === null ? null : perdita >= 0,
              limitiGradinoEPavimentoApplicati: false } });
        }
        let mres;
        try {
          mres = await piazzaChiudendo({
            marketId, book, side: 'SELL', price: d.price, size: d.size,
            // Questa vendita ATTRAVERSA lo spread di proposito: e' l'uscita forzata, non una
            // quotazione. Il gate anti-taker la riconosce solo perche' gliela dichiariamo, e la
            // marca nell'audit — non e' un permesso generale (vale solo in vendita).
            attraversaApposta: true,
            // ── ESENTATA DAL TETTO PER ORDINE, ED E' LA CHIUSURA CON LA PROVA PIU' FORTE ──────────
            // Non era nell'elenco dei quattro percorsi della decisione dell'operatore, ed e' stata
            // aggiunta lo stesso: e' l'uscita forzata di una posizione detenuta, cioe' esattamente il
            // caso su cui `evaluateReductionProof` gia' esiste — `size <= share possedute`, letto dal
            // venue. Lasciarla fuori avrebbe prodotto un sistema che sa chiudere una coppia sopra
            // $37,50 ma non sa VENDERE una posizione sopra $37,50: la stessa lacuna, un percorso piu'
            // in la', e visibile solo alla ripartenza.
            chiudePosizione: true,
            source: AUTO_CLOSE_SOURCE,
            note: `uscita forzata (${d.trigger}): chiusura a mercato al bid ${d.price}`,
          },
          { deps, audit, t0, etichetta: 'uscita-forzata-a-mercato' });
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
        // ══ IL QUARTO RAMO CHE SALTAVA LA GERARCHIA — E L'UNICO RIMASTO ═══════════════════════════
        // ⚠ QUESTA E' LA CAUSA DEL 12 AGOSTO 2026, misurata sui dati vivi e non ipotizzata.
        // Alle 17:58:0x un fill ha lasciato 24 share NO scoperte su Vindman (`cid_b73f32c2`). Da li'
        // in poi, ogni ~60 s: `merge-livello-2` (la decisione: «compra 24 YES da maker, tetto 86,6¢»)
        // seguita da `skip-no-target` — **14 coppie esatte, e zero esiti**. `planExit` rifiutava
        // giustamente di quotare un'uscita in perdita (banda fino a 0,115 contro un carico di 0,124),
        // `decideClose` rispondeva `skip/no-target`, e QUESTO `continue` usciva **prima** del blocco
        // che tenta il completamento della coppia, quaranta righe piu' sotto.
        //
        // E' esattamente il difetto dei punti 27 e 34 di §5, alla quarta occorrenza: `already-covered`
        // e `close-at-market` erano stati corretti l'8 agosto, l'uscita ordinaria era gia' a posto, e
        // `skip` era rimasto indietro perche' sembrava «non c'e' niente da fare». Ma «non posso
        // VENDERE in guadagno» non vuol dire «non posso COMPRARE l'altro lato»: sono due domande
        // diverse, e la seconda e' proprio quella che la regola della gamba scoperta esiste per porre.
        // Il caso in cui la banda sta sotto il carico e' il caso che quella regola doveva coprire.
        //
        // ── DOVE IL TENTATIVO NON SI FA, E PERCHE' ────────────────────────────────────────────────
        // Non una allowlist di gate «buoni» — che invecchierebbe al primo gate nuovo — ma la lista
        // corta dei gate su cui il completamento e' STRUTTURALMENTE impossibile, perche' manca un
        // ingresso che `completaCoppia` richiede:
        //   · `no-position`    non c'e' nessuna posizione da appaiare;
        //   · `no-entry-price` il carico non e' leggibile, e `completaCoppia` prezza il tetto su quello;
        //   · `rules-unreadable` senza tick/banda/minSize non si costruisce nessun ordine.
        // (`market-closed` e `market-not-accepting` non arrivano fin qui: escono piu' sopra, con il
        // loro `continue` e la pulizia dei registri. Restano in elenco perche' la lista dica il vero
        // anche se un domani quel ramo cambiasse.)
        // Su OGNI ALTRO gate — `no-target`, `guard-refused`, `remainder-below-min-size`,
        // `no-market-bid` — il completamento si tenta, e se rinuncia lo dice.
        const SENZA_INGRESSI = new Set(['no-position', 'no-entry-price', 'rules-unreadable',
          'market-closed', 'market-not-accepting']);
        if (!SENZA_INGRESSI.has(d.gate)) {
          const c = await provaCoppia([]);
          if (registraCoppia(c, `skip-${d.gate}`)) continue;
        } else if (obblighiEsito.has(chiaveMerge)) {
          // Anche «non l'ho tentato perche' non potevo» e' un esito, e va DICHIARATO: lasciarlo
          // scadere nel flush lo farebbe comparire come `merge-esito-mancante`, cioe' come un difetto,
          // quando invece e' una rinuncia motivata e corretta.
          chiudiObbligo(chiaveMerge);
          audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
            outcome: 'merge-saltato-senza-ingressi', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
            reason: `completamento non tentabile: ${d.reason}`,
            observed: { gate: d.gate, livello: liv && liv.livello, book } });
          actions.push({ marketId, tokenId: tok, book, action: 'merge-non-tentato', ramo: `skip-${d.gate}`,
            gate: d.gate, reason: d.reason, livello: liv && liv.livello });
        }
        m.skipped++;
        actions.push({ marketId, tokenId: tok, book, action: 'skip', gate: d.gate, reason: d.reason });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: `skip-${d.gate}`,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: d.reason,
          observed: { coppiaTentata: !SENZA_INGRESSI.has(d.gate) } });
        continue;
      }

      // ══ LIVELLI 1 E 2 · COMPLETARE LA COPPIA INVECE DI VENDERE ═══════════════════════════════════
      // L'uscita ORDINARIA e' il Livello 3, quindi qui il completamento va tentato per ultimo — ma con
      // la STESSA funzione dei due rami piu' sopra, non con una seconda copia della stessa logica. Era
      // l'unico posto in cui questo tentativo esisteva, ed e' la ragione per cui i rami
      // `already-covered` e `close-at-market` lo saltavano senza che nessun test se ne accorgesse.
      //
      // NON SI FANNO LE DUE COSE INSIEME: o si piazza il completamento e si salta l'uscita
      // (`continue`), o si rinuncia e prosegue il Livello 3.
      {
        const c = await provaCoppia([]);
        if (registraCoppia(c, 'uscita-ordinaria')) continue;
      }

      // Il Livello 3 e' arrivato per scadenza: l'ordine di completamento che aspettava non ha piu'
      // motivo di stare sul libro, e lasciarlo li' significherebbe comprare il secondo lato mentre si
      // vende il primo. Si toglie PRIMA di vendere, e se non si riesce a toglierlo non si vende.
      if (MERGE_STRATEGY_ENABLED && reg && attesa && attesa.orderId && liv && liv.livello === 3) {
        let c = null;
        try { c = typeof deps.cancelOrder === 'function' ? await deps.cancelOrder({ orderId: attesa.orderId, marketId }) : null; }
        catch (e) { c = { ok: false, reason: e.message }; }
        // `!c` E NON `c && c.ok === false`. Un cancellatore NON INIETTATO restituisce `null`, e con la
        // guardia di prima quel `null` passava per «cancellazione riuscita»: si puliva il registro e si
        // scendeva a vendere il primo lato con l'ordine di completamento ANCORA sul libro — cioe'
        // esattamente il «comprare e vendere insieme» che le tre righe di commento qui sopra dichiarano
        // di voler impedire. Il ramo gemello della chiusura a mercato (poche decine di righe sopra) tratta
        // gia' `null` come fallimento: questa e' la stessa regola, non una nuova. Misurato l'8 agosto
        // 2026: `closeTask` in agent40 NON inietta `cancelOrder`, quindi il caso era il 100% della
        // produzione, non un'ipotesi.
        if (!c || c.ok === false) {
          m.skipped++;
          actions.push({ marketId, tokenId: tok, book, action: 'merge-timeout-cancel-fallita', gate: 'cancel-failed', reason: (c && c.reason) || 'nessun cancellatore iniettato: non si vende con il completamento ancora a riposo' });
          audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: 'merge-timeout-cancel-fallita',
            marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
            reason: (c && c.reason) || 'nessun cancellatore iniettato: non si vende con il completamento ancora a riposo' });
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

      // ══ IL PERMESSO DI ATTRAVERSARE — 17 agosto 2026, concesso dall'operatore ═══════════════════
      //
      // Fino a oggi questa uscita partiva SEMPRE `post-only` (`inCoda: true`), e al prezzo del bid il
      // venue la rifiutava: e' la ragione per cui il 16 agosto 146 SELL su FL-02 non hanno eseguito.
      // Il permesso e' il piu' pericoloso che questo bot abbia, e per questo la decisione NON e' qui:
      // e' in `attraversamento-uscita.js`, dove i quattro limiti si leggono tutti insieme.
      //
      // ⚠ SE IL PERMESSO NON C'E', NON CAMBIA NIENTE: `inCoda: true` e post-only, come sempre. Il caso
      // «non serve» (prezzo sopra il bid) e il caso «non si puo'» (gradino 0, sotto il pavimento) danno
      // lo stesso ordine di prima, e il secondo lo dichiara.
      const attr = valutaAttraversamento({
        tipo: 'uscita',
        gradino: Number.isFinite(d.urgenzaLivello) ? d.urgenzaLivello : (urgenza && urgenza.livello),
        prezzo: d.price, pavimento: d.pavimentoUscita, bid: d.bidLato, carico: pos.avgPrice,
      });
      if (attr.attraversa === true) {
        // ④ LA DICHIARAZIONE, e sta PRIMA dell'invio: un attraversamento che fallisse a meta' strada
        // deve comunque avere lasciato la sua riga. Il conteggio di domani si fa su questa.
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: 'attraversamento-consentito', marketRef: `cid_${String(marketId).replace(/^0x/, '')}`,
          reason: attr.motivo, observed: { book, tokenId: tok, size: d.size, ...attr.dichiarazione } });
      }
      let res;
      try {
        res = await deps.placeOrder({
          marketId, book, side: 'SELL', price: d.price, size: d.size,
          source: AUTO_CLOSE_SOURCE,
          // Questa e' una QUOTAZIONE maker: sta in coda come le altre — TRANNE quando la scala ha
          // concesso di attraversare, e allora deve eseguire e non aspettare il suo turno. La chiusura
          // forzata a mercato, poche righe sopra, non lo dichiara mai per la stessa ragione.
          ...(attr.attraversa === true
            ? { attraversaApposta: true, chiudePosizione: true }
            : { inCoda: true }),
          note: `auto-close: uscita a ${d.price} su carico ${pos.avgPrice} (+${d.profitCents}¢/share)`
            + (attr.attraversa === true ? ` · ATTRAVERSA il bid ${d.bidLato} (gradino ${attr.dichiarazione.gradino})` : ''),
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
    // SECONDO FLUSH: scarica l'obbligo dell'ULTIMA posizione del mercato. Un `continue` sull'ultima
    // iterazione esce dal ciclo e arriva comunque qui, quindi fra i due punti di flush non esiste un
    // percorso che possa portare via un obbligo aperto.
    flushObblighi();
    markets.push(m);
  }

  // ── IL RIPOSIZIONAMENTO, A CHIUSURE FATTE ───────────────────────────────────────────────────────
  // Fuori dal ramo, e apposta: un riposizionamento non deve poter allungare ne' far fallire la chiusura
  // che l'ha reso possibile. Se solleva, si registra e il giro finisce comunque bene.
  // ── I MERCATI RIMASTI ORFANI, CONSEGNATI DAL CICLO DI RIPREZZO ────────────────────────────────
  // Una gamba orfana viene cancellata la' — al momento del rinnovo GTD, che e' quando il sistema tocca
  // comunque quell'ordine — ma il RIPOSIZIONAMENTO si fa qui, dove vive gia': un secondo posto che
  // costruisce due gambe sarebbe la struttura parallela che questo lavoro esiste per non creare.
  // Il mercato entra nella STESSA coda del merge riuscito e degli esiti terminali del fill, quindi
  // eredita senza modifiche `capitalePerRiposizionamento`, il tetto in vigore e il ripiego sul capitale
  // libero. Non e' un fermo duro: se le regole non si risolvono, si salta e si dice.
  {
    for (const c of codaOrfani) {
      const mid = c && c.marketId ? String(c.marketId) : null;
      if (!mid) continue;
      // Se il mercato ha gia' un riposizionamento in coda da un altro percorso, non se ne accoda un
      // secondo: due riposizionamenti sullo stesso mercato nello stesso giro impegnerebbero il tetto
      // due volte.
      if (riposizionamenti.some((r) => String(r.marketId) === mid)) continue;
      let rl = null;
      try { rl = await deps.resolveRules(mid); }   // posizionale: e' la convenzione di questo modulo (riga 941)
      catch { rl = null; }
      if (!rl || rl.readable !== true) {
        actions.push({ marketId: mid, action: 'riposizionamento-dopo-chiusura', ok: false,
          causa: 'gamba orfana cancellata', reason: 'regole di venue non leggibili: il mercato resta da ripianificare', gambe: 0 });
        continue;
      }
      riposizionamenti.push({ marketId: mid, rules: rl, causa: 'gamba orfana cancellata' });
    }
  }

  for (const r of riposizionamenti) {
    let esitoRip;
    try {
      // ══ PASSO 5 · SI RIPIANIFICA DA ZERO SOLO SE IL MERCATO E' ANCORA VALIDO ═══════════════════
      // La parte fillata e' stata chiusa (fusa o venduta) e il capitale e' tornato disponibile. Il
      // requisito distingue due esiti, e prima di questo lavoro il codice ne conosceva uno solo:
      //   · mercato ancora valido ⇒ due gambe NUOVE con le regole standard, come un mercato appena
      //     entrato nel piano. «Mai primo» ridiventa attivo, dentro banda, size dal tetto corrente;
      //   · mercato non piu' valido ⇒ NIENTE, e il capitale torna disponibile per altri mercati.
      // `riposizionaDopoChiusura` controllava solo `rules.readable`: un mercato senza piu' programma
      // reward, o a due ore dalla risoluzione, ci passava attraverso.
      const scad = typeof deps.scadenzaMercato === 'function' ? deps.scadenzaMercato(r.marketId) : undefined;
      const val = MC.validoPerRipianificare({ rules: r.rules, scadenzaMs: scad, ora: t0 });
      if (!val.valido) {
        // L'uscita dalla modalita' chiusura avviene COMUNQUE: la coppia e' chiusa, e questo e' il
        // motivo per cui siamo qui. Non ripianificare non e' un fallimento della chiusura — e' la sua
        // conclusione corretta su un mercato che non merita piu' capitale.
        if (r.book && deps.chiusura && typeof deps.chiusura.esci === 'function') {
          try { deps.chiusura.esci({ marketId: r.marketId, book: r.book }); } catch { /* non blocca */ }
        }
        actions.push({ marketId: r.marketId, action: 'riposizionamento-dopo-chiusura', ok: false,
          causa: r.causa || null, azione: 'mercato-non-valido', reason: val.motivo, gambe: 0 });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: 'riposizionamento-mercato-non-valido',
          marketRef: `cid_${String(r.marketId).replace(/^0x/, '')}`, reason: val.motivo,
          observed: { causa: r.causa || null, scadenzaMs: scad === undefined ? 'non-cablata' : scad } });
        continue;
      }
      // ── (d) IL TARGET SI DECIDE QUI, NON DENTRO ─────────────────────────────────────────────────
      // Il tetto in vigore per QUESTO mercato e il capitale libero ADESSO sono due letture, e stanno
      // fuori dalla funzione pura che poi le usa. Entrambe iniettabili: chi non le cabla ottiene
      // `azione: 'niente'` e il comportamento è quello di prima, cioè nessun riposizionamento.
      const tetto = typeof deps.tettoMercato === 'function' ? deps.tettoMercato(r.marketId) : null;
      const libero = typeof deps.capitaleLibero === 'function' ? deps.capitaleLibero() : null;
      const prezzoRif = r.rules && r.rules.books && r.rules.books.yes
        ? Number(r.rules.books.yes.scoringMid) : null;
      const q = capitalePerRiposizionamento({
        tettoUsd: tetto && Number.isFinite(tetto.capUsd) ? tetto.capUsd : null,
        capitaleLiberoUsd: Number.isFinite(libero) ? libero : null,
        minSize: r.rules && Number(r.rules.minSize), prezzoRif,
      });
      if (q.azione !== 'riposiziona') {
        actions.push({ marketId: r.marketId, action: 'riposizionamento-dopo-chiusura', ok: false,
          causa: r.causa || null, azione: q.azione, reason: q.motivo, gambe: 0 });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close',
          outcome: `riposizionamento-${q.azione}`, marketRef: `cid_${String(r.marketId).replace(/^0x/, '')}`,
          reason: q.motivo, observed: { causa: r.causa || null, tettoUsd: tetto && tetto.capUsd, capitaleLiberoUsd: libero } });
        continue;
      }
      esitoRip = await riposizionaDopoChiusura({ ...r, capitaleUsd: q.capitaleUsd, deps, audit, t0 });
      // Il PERCHE' di quella cifra non deve sparire quando il riposizionamento riesce: se il tetto non
      // e' stato raggiunto perche' il capitale libero era meno, chi legge il referto deve vederlo qui e
      // non doverlo dedurre dalla size delle gambe.
      esitoRip.motivo = esitoRip.motivo ? `${esitoRip.motivo} · ${q.motivo}` : q.motivo;
      esitoRip.capitaleUsd = q.capitaleUsd;
    }
    catch (e) { esitoRip = { ok: false, motivo: e && e.message ? e.message : String(e), gambe: [] }; }
    // LA CHIUSURA E' CONCLUSA: si esce dalla modalita' e il mercato torna ordinario. Vale anche quando
    // la ripianificazione non e' passata — l'esenzione da «mai primo» esiste per chiudere una coppia,
    // e quella coppia e' chiusa. Se resta del capitale da rimettere al lavoro se ne occupa il ciclo
    // normale, con le regole normali.
    if (r.book && deps.chiusura && typeof deps.chiusura.esci === 'function') {
      try { deps.chiusura.esci({ marketId: r.marketId, book: r.book }); } catch { /* non blocca */ }
    }
    actions.push({ marketId: r.marketId, action: 'riposizionamento-dopo-chiusura', ok: esitoRip.ok === true,
      causa: r.causa || null, reason: esitoRip.motivo, gambe: (esitoRip.gambe || []).length,
      // La cifra DECISA, accanto all'esito: senza, «$130» e «$80 perche' non c'era altro» si leggono
      // uguali nel referto e si distinguono solo ricostruendo la size delle gambe.
      capitaleUsd: Number.isFinite(esitoRip.capitaleUsd) ? esitoRip.capitaleUsd : null });
  }

  return { at: new Date(t0).toISOString(), ran: true, gate: null, reason: null, markets, actions, latencyMs: now() - t0 };
}

module.exports = { runAutoCloseCycle, decideClose, fondiCoppia, completaCoppia, riposizionaDopoChiusura,
  RIPOSIZIONA_DOPO_CHIUSURA,
  CHIUSURA_RAPIDA_ENABLED, TETTO_COPPIA_CENTS, AUTO_CLOSE_SOURCE, EXIT_PROFIT_PCT, MAX_WAIT_HOURS };

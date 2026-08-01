'use strict';
// mm-tracking — IL MOTORE DI MARKET MAKING A DUE LATI, con offset costante dal mid.
//
// LA DIFFERENZA CON L'AUTO-REPRICE ESISTENTE, che non e' una sfumatura. lib/maker/auto-reprice.js e'
// REATTIVO: guarda un ordine gia' piazzato a mano e lo sposta SOLO quando il mid si e' mosso abbastanza
// da spingerlo fuori dalla banda che paga. Finche' l'ordine e' dentro, non lo tocca — e giustamente,
// perche' il suo compito e' impedire che smetta di maturare.
//
// Questo modulo fa l'altra cosa: TIENE una distanza. Quota entrambi i lati a mid ∓ offset e li rifa'
// ogni volta che il mid si sposta oltre una soglia, dentro o fuori banda che sia. Non aspetta che
// qualcosa si rompa: insegue.
//
// I DUE LATI SONO ENTRAMBI ACQUISTI, e questa e' la scelta di modello che conta.
//   · lato bid  → BUY YES  a  mid − offset
//   · lato ask  → BUY NO   a  (1 − mid) − offset
// Comprare NO a q e' economicamente identico a vendere YES a 1 − q, e infatti (1−mid)−offset = 1−(mid+offset).
// Verificato con l'esempio concordato: mid 10¢ offset 3¢ ⇒ BUY YES @7¢ e BUY NO @87¢, cioe' vendere YES
// a 13¢. Mid a 11¢ ⇒ 8¢ e 86¢, cioe' 14¢.
// Perche' non un SELL vero: vendere consegna il token, quindi richiede di possederlo. Un maker che
// quota due lati partendo da collaterale non ha inventario su nessuno dei due, e comprare l'altro book
// e' il modo in cui il venue stesso intende la quotazione bilaterale — e' anche cio' che il punteggio
// reward misura, prendendo il minimo fra i due lati.
//
// COSA QUESTO MODULO NON FA. Non tocca il venue. Non ha adapter, credenziali, chiavi. E' aritmetica e
// decisioni: il chiamante (agent40) inietta piazzamento, cancellazione e lettura ordini, che sono le
// STESSE funzioni del pannello manuale — quindi ogni gate che governa un ordine a mano governa ogni
// ordine di questo motore, senza un secondo percorso che possa divergere dal primo.

const { validateQuote } = require('./venue-rules');

const TRACKING_SOURCE = 'mm-tracking';

// ── OGNI QUANTO SI LEGGE IL MID, E QUANDO SI SMETTE DI FIDARSENE ───────────────────────────────────
// 3 secondi: alla scala prevista (10-15 mercati) e' il compromesso fra reattivita' e carico, e il
// costo e' una lettura di file locale per mercato — agent34 scrive lo snapshot ogni 3s comunque, quindi
// leggere piu' spesso non produrrebbe informazione nuova.
const TRACKING_POLL_MS = 3_000;
// 18 secondi: sei letture perse di fila. Sotto i 15 un singolo giro andato male metterebbe in pausa un
// mercato sano; sopra i 20 si continuerebbe a quotare troppo a lungo attorno a un prezzo che non
// esiste piu'. La pausa e' PER MERCATO e si scioglie da sola appena il feed torna: non serve
// riaccendere niente a mano, perche' il gate viene rivalutato a ogni ciclo.
const MID_STALE_PAUSE_SEC = 18;

const { planQuotes, decideRetrack, snap } = require('./mm-quote-math');
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const p2c = (price) => price * 100;

/**
 * Il lato di un ordine a riposo, dedotto dal token. Un ordine il cui token non corrisponde a nessuno
 * dei due book del mercato NON viene attribuito a un lato: resta fuori, e il motore non lo tocca.
 * Indovinare qui significherebbe cancellare l'ordine di qualcun altro.
 */
function bookOf(order, rules) {
  const t = String(order.tokenId || '');
  if (rules.tokenId && t === String(rules.tokenId)) return 'yes';
  if (rules.tokenIdNo && t === String(rules.tokenIdNo)) return 'no';
  return null;
}

/**
 * Valida una quota contro le regole del venue riusando la STESSA funzione che il pannello manuale e
 * l'adapter usano. Non una copia: la stessa, cosi' i due non possono dare due risposte.
 */
function quoteIsValid({ rules, book, price, size }) {
  const scoringMid = book === 'no' ? (rules.books && rules.books.no ? rules.books.no.scoringMid : null)
    : (rules.books && rules.books.yes ? rules.books.yes.scoringMid : null);
  const v = validateQuote(
    { tick: rules.tick, scoringMid, maxSpreadCents: rules.maxSpreadCents, minSize: rules.minSize },
    { side: 'BUY', price, size },
  );
  // OUT_OF_BAND non e' un rifiuto per questo motore: e' una conseguenza dell'offset che l'operatore ha
  // scelto, e viaggia gia' fino allo schermo come `inBand:false` con il suo badge. Tutti gli altri
  // motivi restano bloccanti — fuori tick, fuori dai limiti di prezzo, sotto la size minima.
  const blocking = v.reasons.filter((r) => r.code !== 'OUT_OF_BAND');
  return { valid: blocking.length === 0, reasons: blocking, outOfBand: v.reasons.some((r) => r.code === 'OUT_OF_BAND') };
}

module.exports = { TRACKING_SOURCE, TRACKING_POLL_MS, MID_STALE_PAUSE_SEC, planQuotes, decideRetrack, snap, bookOf, quoteIsValid };

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// IL CICLO
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
//
// Struttura deliberatamente identica a runAutoRepriceCycle: stessi gate, stesso ordine, stessi nomi.
// Non e' pigrizia — e' che quei gate sono stati scritti uno per uno per un motivo, e un secondo motore
// con una scala di controlli LEGGERMENTE diversa e' esattamente il modo in cui due sistemi finiscono per
// non essere d'accordo su cosa sia sicuro.
//
// LO STATO PER MERCATO vive nella Map che il chiamante passa e conserva fra un ciclo e l'altro:
//   referenceMid   il mid all'ultimo piazzamento — l'ancora da cui si misura il movimento
//   sides          { yes: {...}, no: {...} } con orderId, prezzo, e `filled`
//   repriceCount   quanti reprice, per la tabella in dashboard
//   lastRepriceAt  il freno
// Un riavvio azzera tutto, ed e' giusto: gli ordini a riposo portano una scadenza GTD venue-enforced,
// quindi un processo che riparte senza memoria non lascia nulla di eterno dietro di se'.

function emptyMarketState() {
  return {
    referenceMid: null,
    sides: {
      yes: { orderId: null, price: null, filled: false, filledAt: null, needsRenewal: false },
      no: { orderId: null, price: null, filled: false, filledAt: null, needsRenewal: false },
    },
    repriceCount: 0,
    lastRepriceAt: null,
    lastError: null,
  };
}

async function runTrackingCycle(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const t0 = now();
  const audit = typeof deps.audit === 'function' ? deps.audit : () => {};
  const state = deps.state instanceof Map ? deps.state : new Map();
  const tuning = deps.tuning || {};
  const actions = [];
  const events = [];
  const result = (gate, reason, extra = {}) => ({
    at: new Date(t0).toISOString(), ran: gate == null, gate, reason, markets: [], actions, events, ...extra,
  });

  // ── GATE 0 — chi ha il tracking acceso. Vuoto o illeggibile ⇒ non si fa nulla. ──
  const cfg = deps.readConfig ? deps.readConfig() : require('./mm-tracking-config').readTrackingConfig();
  if (!cfg.readable) return result('config-unreadable', `configurazione del tracking ${cfg.error} — non faccio nulla (fail closed)`);
  if (!cfg.marketIds.length) return result('no-markets', 'nessun mercato ha il tracking attivo');

  // ── GATE 1 — IL KILL SWITCH GLOBALE, letto prima di qualunque cancellazione. ──
  // Un reprice e' cancella-poi-piazza: sotto kill il piazzamento verrebbe rifiutato, quindi cancellare
  // per primo toglierebbe all'operatore un ordine a riposo in cambio di niente.
  const kill = typeof deps.killStatus === 'function' ? deps.killStatus() : { effectivelyKilled: false, readable: true };
  if (kill.effectivelyKilled === true || kill.readable === false) {
    return result('kill', kill.readable === false
      ? 'stato del kill-switch ILLEGGIBILE — trattato come attivo (fail closed)'
      : 'kill-switch globale ATTIVO — il motore non tocca nulla');
  }

  const markets = [];
  for (const marketId of cfg.marketIds) {
    const conf = cfg.markets[marketId];
    const m = { marketId, gate: null, reason: null, offsetCents: conf.offsetCents, minMoveCents: conf.minMoveCents,
      sizeShares: conf.sizeShares, referenceMid: null, movedCents: null, repriceCount: 0, sides: null, placed: 0, cancelled: 0 };
    if (!state.has(marketId)) state.set(marketId, emptyMarketState());
    const st = state.get(marketId);
    m.repriceCount = st.repriceCount;
    m.referenceMid = st.referenceMid;
    m.sides = st.sides;

    // ── GATE 2 — PROPRIETA' MANUALE. Il motore agisce solo dove agent35 sta provatamente alla larga. ──
    const mm = typeof deps.isManual === 'function' ? deps.isManual(marketId) : { manual: true, readable: true };
    if (!mm.readable) { m.gate = 'manual-mode-unreadable'; m.reason = 'proprieta del mercato illeggibile — salto (fail closed)'; markets.push(m); continue; }
    if (!mm.manual) { m.gate = 'manual-mode-inactive'; m.reason = 'il mercato non e piu in gestione manuale: agent35 lo ha ripreso, il motore sta alla larga'; markets.push(m); continue; }

    // ── GATE 3 — L'OROLOGIO DEL MERCATO. Sotto la soglia dei 3 minuti non si riprezza: la finestra GTD
    //    piu' corta che il venue accetta sopravvivrebbe al mercato. Senza rinnovo gli ordini a riposo
    //    scadono da soli, che e' esattamente il comportamento voluto a ridosso della chiusura. ──
    const win = typeof deps.marketWindow === 'function' ? deps.marketWindow(marketId) : null;
    if (win && win.tooClose === true) {
      m.gate = win.gate || 'market-too-close-to-close';
      m.reason = `${win.reason} — il motore NON riprezza piu su questo mercato; gli ordini gia a riposo scadono per GTD`;
      markets.push(m); continue;
    }

    const rules = typeof deps.resolveRules === 'function' ? deps.resolveRules(marketId) : null;
    if (!rules || rules.readable !== true) {
      m.gate = 'rules-unreadable';
      m.reason = `regole di venue non leggibili (mancano: ${rules && Array.isArray(rules.missing) ? rules.missing.join(', ') : 'ignoto'})`;
      markets.push(m); continue;
    }

    // ── GATE 4 — IL MID DEV'ESSERE VIVO. Inseguire un mid vecchio significa quotare attorno a un prezzo
    //    che non esiste piu', ed e' peggio che non quotare affatto. ──
    if (tuning.requireLiveBook !== false && rules.midSource !== 'live-book') {
      m.gate = 'mid-not-live';
      m.reason = `il mid viene da «${rules.midSource || 'fonte ignota'}», non dal book live — non si insegue un mid che non e del book`;
      markets.push(m); continue;
    }
    const maxAge = Number.isFinite(tuning.midStalePauseSec) ? tuning.midStalePauseSec : MID_STALE_PAUSE_SEC;
    m.midAgeSec = Number.isFinite(rules.midAgeSec) ? rules.midAgeSec : null;
    m.midSource = rules.midSource || null;
    if (Number.isFinite(rules.midAgeSec) && rules.midAgeSec > maxAge) {
      // IN PAUSA, non spento. Il tracking resta configurato e riparte da solo appena il feed torna:
      // spegnerlo obbligherebbe l'operatore a riaccenderlo dopo ogni singhiozzo di rete, e un
      // interruttore che si spegne da solo si finisce per lasciarlo acceso a forza.
      m.gate = 'mid-stale';
      m.paused = true;
      m.reason = `dati non freschi — in pausa: il mid del book live e vecchio di ${rules.midAgeSec}s, oltre i ${maxAge}s ammessi. Il tracking resta configurato e riprende da solo appena il feed torna.`;
      markets.push(m); continue;
    }

    // ── VERITA' DEL VENUE, non convinzione locale ──
    let listed;
    try { listed = await deps.listOrders({ marketId }); }
    catch (e) { listed = { ok: false, error: e.message }; }
    if (!listed || listed.ok === false) {
      m.gate = 'list-failed';
      m.reason = `lettura del venue FALLITA (${listed && listed.error ? listed.error : 'ignoto'}) — salto; non sapere cosa e a riposo non e la stessa cosa di non avere nulla a riposo`;
      markets.push(m); continue;
    }
    if (listed.simulated === true) {
      m.gate = 'simulated';
      m.reason = 'nessuna credenziale di lettura: il venue non e stato interrogato';
      markets.push(m); continue;
    }

    const resting = (listed.orders || []).filter((o) => o && o.orderId);
    const restingById = new Map(resting.map((o) => [String(o.orderId), o]));

    // ── IL FILL: si rileva, si dice, e mette in pausa UN LATO SOLO ────────────────────────────────
    // Un ordine che il motore aveva piazzato e che non e' piu' a riposo se n'e' andato per una di due
    // ragioni: e' stato eseguito, oppure e' scaduto/cancellato. Le due cose non si distinguono da qui
    // (servirebbe la riconciliazione, che gira altrove), quindi il motore NON afferma «eseguito» — dice
    // «sparito» e si comporta nel modo conservativo: se il venue riporta size eseguita, e' un fill e
    // quel lato si ferma; altrimenti si riparte con un piazzamento normale.
    for (const side of ['yes', 'no']) {
      const s = st.sides[side];
      if (!s.orderId) continue;
      const still = restingById.get(String(s.orderId));
      if (still) {
        // ── IL RINNOVO PROATTIVO, che E' il dead-man's switch ────────────────────────────────────
        // L'ordine porta una scadenza GTD che il VENUE fa rispettare: se questo processo muore, nessuno
        // rinnova e l'exchange lo ritira da solo. Perche' quella protezione resti reale, la finestra
        // dev'essere lunga (23 min) e il rinnovo deve arrivare PRIMA che scada — non dopo, o l'ordine
        // sparirebbe dal libro per qualche secondo a ogni giro di vita.
        // Marcare il lato come «da rifare» e' sufficiente: il resto del ciclo lo cancella e lo ripiazza
        // ai livelli correnti, che e' esattamente cio' che un rinnovo deve fare per un motore che
        // insegue il mid — rimetterlo dov'e' giusto adesso, non dov'era 23 minuti fa.
        const toExpiry = Number(still.secondsToExpiry);
        const margin = Number.isFinite(tuning.refreshMarginSeconds) ? tuning.refreshMarginSeconds : 180;
        if (Number.isFinite(toExpiry) && toExpiry <= margin) {
          s.needsRenewal = true;
          events.push({ type: 'renewal-due', marketId, side, orderId: s.orderId, secondsToExpiry: toExpiry, marginSeconds: margin });
        }
        const matched = Number(still.sizeMatched);
        if (Number.isFinite(matched) && matched > 0 && !s.filled) {
          s.filled = true; s.filledAt = t0;
          events.push({ type: 'fill', marketId, side, orderId: s.orderId, sizeMatched: matched, price: s.price });
          audit({ source: TRACKING_SOURCE, event: 'fill-detected', marketId, book: side, orderId: s.orderId, sizeMatched: matched, price: s.price, at: new Date(t0).toISOString() });
        }
      } else {
        // sparito dal book: non piu' nostro da gestire. Non si dichiara eseguito.
        events.push({ type: 'gone', marketId, side, orderId: s.orderId });
        s.orderId = null; s.price = null;
      }
    }

    const plan = planQuotes({ mid: rules.mid, offsetCents: conf.offsetCents, tick: rules.tick, bandRadiusCents: rules.bandRadiusCents });
    m.plan = plan;
    if (!plan.ok) { m.gate = 'plan-unplaceable'; m.reason = plan.reason; markets.push(m); continue; }

    const dec = decideRetrack({
      mid: rules.mid, referenceMid: st.referenceMid, minMoveCents: conf.minMoveCents,
      lastRepriceAt: st.lastRepriceAt, minIntervalMs: tuning.minIntervalMs || 0, now: t0,
    });
    m.movedCents = dec.movedCents ?? null;
    if (!dec.act) {
      // Non si riprezza — ma un lato SENZA ordine a riposo e senza fill va comunque piazzato: e' il caso
      // del primo giro, e quello di un lato appena scaduto per GTD mentre il mid non si muoveva.
      const missing = ['yes', 'no'].filter((s) => (!st.sides[s].orderId || st.sides[s].needsRenewal) && !st.sides[s].filled && plan[s].placeable);
      if (!missing.length) { m.gate = dec.gate; m.reason = dec.reason; markets.push(m); continue; }
      m.reason = `${dec.reason} — ma ${missing.length} lato/i da piazzare o da rinnovare prima della scadenza GTD`;
    }

    // ── IL REPRICE: cancella cio' che c'e', piazza ai livelli nuovi ────────────────────────────────
    const sidesToDo = ['yes', 'no'].filter((s) => !st.sides[s].filled && plan[s].placeable);
    for (const side of sidesToDo) {
      const s = st.sides[side];
      const target = plan[side];
      // gia' esattamente li? niente da fare: cancellare e ripiazzare allo stesso prezzo e' solo rischio
      if (!s.needsRenewal && s.orderId && fin(s.price) && Math.abs(s.price - target.price) < (rules.tick || 0.01) / 1000) continue;

      const v = quoteIsValid({ rules, book: side, price: target.price, size: conf.sizeShares });
      if (!v.valid) {
        actions.push({ action: 'skip', marketId, book: side, gate: 'venue-rules', reason: v.reasons.map((r) => `${r.code}: ${r.detail}`).join('; '), price: target.price });
        continue;
      }

      if (s.orderId) {
        let can;
        try { can = await deps.cancelOrder({ orderId: s.orderId, marketId }); }
        catch (e) { can = { ok: false, reason: e.message }; }
        actions.push({ action: 'cancel', marketId, book: side, orderId: s.orderId, ok: can && can.ok !== false, reason: can && can.reason ? can.reason : null });
        if (!can || can.ok === false) {
          // NON si piazza il nuovo se il vecchio non e' stato tolto: sarebbero due ordini dello stesso
          // lato sullo stesso mercato, cioe' il doppio dell'esposizione che l'operatore ha scelto.
          m.gate = 'cancel-failed';
          m.reason = `cancellazione del lato ${side.toUpperCase()} fallita (${can && can.reason ? can.reason : 'ignoto'}) — non piazzo il sostituto: avere due ordini sullo stesso lato raddoppierebbe l esposizione`;
          continue;
        }
        m.cancelled += 1;
        s.orderId = null; s.price = null;
      }

      let placed;
      try {
        placed = await deps.placeOrder({
          marketId, book: side, price: target.price, size: conf.sizeShares,
          source: TRACKING_SOURCE,
          // La deroga, dichiarata per nome. Vale SOLO per il codice OUT_OF_BAND: tick, limiti di prezzo
          // e size minima continuano a rifiutare come per qualunque altro ordine.
          allowOutOfBand: true,
          note: `tracking attivo · offset ${conf.offsetCents}¢ · mid ${(p2c(rules.mid)).toFixed(2)}¢${target.inBand === false ? ' · FUORI BANDA (nessun reward su questo lato)' : ''}`,
        });
      } catch (e) { placed = { ok: false, gate: 'exception', reason: e.message }; }

      const act = {
        action: 'place', marketId, book: side,
        fromMid: fin(st.referenceMid) ? +p2c(st.referenceMid).toFixed(3) : null,
        toMid: +p2c(rules.mid).toFixed(3),
        movedCents: dec.movedCents ?? null,
        offsetCents: conf.offsetCents,
        price: target.price, priceCents: target.priceCents, size: conf.sizeShares,
        inBand: target.inBand,
        ok: !!(placed && placed.ok), sent: !!(placed && placed.sent),
        gate: placed && placed.gate ? placed.gate : null,
        reason: placed && placed.reason ? placed.reason : null,
        orderId: placed && placed.orderId ? placed.orderId : null,
        trigger: s.needsRenewal ? 'expiry-renewal' : (fin(st.referenceMid) ? 'mid-moved' : 'initial'),
      };
      actions.push(act);
      audit({ source: TRACKING_SOURCE, event: 'reprice', ...act, at: new Date(t0).toISOString() });

      if (placed && placed.ok) {
        m.placed += 1;
        // In dry-run non c'e' orderId: si registra comunque il prezzo, cosi' il ciclo successivo non
        // ripiazza all'infinito lo stesso livello e il comportamento nel tempo e' osservabile.
        s.orderId = placed.orderId || (placed.sent === false ? `dry-${side}-${t0}` : null);
        s.price = target.price;
        s.needsRenewal = false;
        st.lastError = null;
      } else {
        st.lastError = { at: t0, book: side, gate: act.gate, reason: act.reason };
      }
    }

    m.midReadAt = t0;
    m.mid = rules.mid;
    if (m.placed > 0) {
      st.referenceMid = rules.mid;
      st.lastRepriceAt = t0;
      if (dec.act && fin(dec.movedCents)) st.repriceCount += 1;
      m.referenceMid = st.referenceMid;
      m.repriceCount = st.repriceCount;
    }
    markets.push(m);
  }

  return result(null, null, { markets });
}

module.exports.runTrackingCycle = runTrackingCycle;
module.exports.emptyMarketState = emptyMarketState;

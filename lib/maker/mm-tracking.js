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

const { validateQuote, splitVerdict } = require('./venue-rules');

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

// ── IL FRENO SUI FALLIMENTI RIPETUTI ───────────────────────────────────────────────────────────────
// Un piazzamento rifiutato da un gate NON e' un caso da ritentare subito. Misurato al primo test dal
// vivo: con `funding-approval` chiuso il motore ha ritentato 112 volte in 30 secondi — perche' il push
// lo sveglia a ogni scrittura dello snapshot e nulla gli diceva di aspettare. Il gate non si sarebbe
// aperto da solo, quindi erano 112 tentativi identici e 112 righe di log per una cosa che si sapeva
// gia' dopo il primo.
//
// Il freno raddoppia a ogni fallimento CONSECUTIVO CON LO STESSO GATE, da 3 secondi fino a un tetto di
// 5 minuti. Due dettagli che contano:
//   · lo streak si azzera se il gate CAMBIA — un guasto diverso e' un fatto nuovo e merita un tentativo
//     subito, non l'attesa accumulata dal guasto precedente;
//   · si azzera anche al primo successo, ovviamente.
// Il tetto e' 5 minuti e non "per sempre" perche' quasi tutti questi gate SI aprono da soli quando la
// causa passa (kill tolto, credenziali tornate, cap liberato): smettere di ritentare vorrebbe dire non
// accorgersene mai.
const RETRY_BASE_MS = 3_000;
const RETRY_MAX_MS = 300_000;
function backoffMs(streak) {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.max(0, streak - 1)));
}

const { planQuotes, decideRetrack, decideSide, snap } = require('./mm-quote-math');
const { endOfScaleCheck } = require('./end-of-scale');
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
  // OUT_OF_BAND non e' un rifiuto per questo motore: e' una conseguenza dell'offset che l'operatore ha
  // scelto, e viaggia gia' fino allo schermo come `inBand:false` con il suo badge. Tutti gli altri
  // motivi restano bloccanti — fuori tick, fuori dai limiti di prezzo, sotto la size minima.
  // La separazione la fa splitVerdict, che e' la STESSA funzione usata dalla corsia manuale e
  // dall'adapter: tre `filter` scritti a mano in tre file sono tre occasioni di divergere.
  const v = splitVerdict(validateQuote(
    { tick: rules.tick, scoringMid, maxSpreadCents: rules.maxSpreadCents, minSize: rules.minSize },
    { side: 'BUY', price, size },
  ), { allowOutOfBand: true });
  return { valid: v.valid, reasons: v.reasons, outOfBand: v.outOfBand };
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
      yes: { orderId: null, price: null, filled: false, filledAt: null, needsRenewal: false, placedAtMid: null, placedAt: null, inBand: null, distanceCents: null, lastVerdict: null,
        failStreak: 0, failGate: null, nextRetryAt: null, failReason: null },
      no: { orderId: null, price: null, filled: false, filledAt: null, needsRenewal: false, placedAtMid: null, placedAt: null, inBand: null, distanceCents: null, lastVerdict: null,
        failStreak: 0, failGate: null, nextRetryAt: null, failReason: null },
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

    // ── FINE SCALA — SI CANCELLA, NON SI RIPREZZA ───────────────────────────────────────────────────
    // Stessa soglia, stessa unica definizione (lib/maker/end-of-scale.js) del watcher reattivo. Vale
    // ancora di piu' qui: questo motore INSEGUE il mid, quindi lasciato a se' stesso seguirebbe un
    // mercato in risoluzione fin dentro i 2¢ ripiazzando a ogni movimento, che e' esattamente il
    // comportamento che la soglia esiste per fermare.
    //
    // Si cancella e si esce dal ciclo per questo mercato. Il tracking resta ACCESO in configurazione —
    // come per la pausa da dati non freschi — perche' spegnerlo di nascosto lascerebbe l'operatore con
    // un interruttore che dice «attivo» e un motore che non lo e'. Se il mid rientra, il giro successivo
    // ripiazza da solo; se il mercato risolve davvero, non c'e' piu' nulla da piazzare comunque.
    //
    // CONVIVENZA CON LA GTD: nessun conflitto. Il rinnovo proattivo a 3 minuti dalla scadenza vive nel
    // blocco qui sotto, che questo `continue` non raggiunge — quindi a fine scala non si rinnova nulla,
    // che e' la stessa direzione (togliere l'ordine dal book) presa per la via piu' rapida.
    const eos = endOfScaleCheck(rules.mid);
    if (eos.endOfScale) {
      m.gate = 'end-of-scale';
      m.reason = eos.reason;
      m.endOfScale = { midCents: eos.midCents, side: eos.side };
      audit({ source: TRACKING_SOURCE, event: 'end-of-scale-cancel', marketId, reason: eos.reason,
        midCents: eos.midCents, endSide: eos.side, at: new Date(t0).toISOString() });
      events.push({ type: 'end-of-scale', marketId, midCents: eos.midCents, side: eos.side, reason: eos.reason });
      for (const side of ['yes', 'no']) {
        const s = st.sides[side];
        if (!s.orderId) continue;
        let can;
        try { can = await deps.cancelOrder({ orderId: s.orderId, marketId }); }
        catch (e) { can = { ok: false, reason: e.message }; }
        const ok = !!(can && can.ok !== false);
        actions.push({ action: 'end-of-scale-cancel', marketId, book: side, orderId: s.orderId, ok,
          midCents: eos.midCents, reason: (can && can.reason) || eos.reason });
        audit({ source: TRACKING_SOURCE, event: ok ? 'end-of-scale-cancelled' : 'end-of-scale-cancel-failed',
          marketId, book: side, orderId: s.orderId, reason: (can && can.reason) || eos.reason,
          midCents: eos.midCents, at: new Date(t0).toISOString() });
        if (ok) {
          m.cancelled += 1;
          // Lo stato del lato si azzera SOLO su una cancellazione riuscita: dimenticare un orderId che
          // e' ancora sul venue significherebbe perderne le tracce e non riprovare mai piu' a toglierlo.
          s.orderId = null; s.price = null; s.placedAtMid = null; s.needsRenewal = false;
        }
      }
      markets.push(m); continue;
    }

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

    // ── LA DECISIONE, ORA PER LATO ────────────────────────────────────────────────────────────────
    // Prima era una sola: «il mid si e' mosso oltre la soglia?» e i due lati si spostavano insieme.
    // Adesso ogni lato risponde per se' alla domanda che conta davvero — «sto ancora maturando?» — e
    // un lato dentro banda non viene toccato nemmeno se l'altro si e' dovuto spostare.
    const bandR = fin(rules.bandRadiusCents) ? rules.bandRadiusCents : null;
    const sideMid = { yes: rules.mid, no: fin(rules.mid) ? +(1 - rules.mid).toFixed(6) : null };
    const decs = {};
    for (const side of ['yes', 'no']) {
      const s = st.sides[side];
      // IL FRENO, valutato per primo: se questo lato sta scontando un backoff non si decide nemmeno
      // cosa farne, perche' qualunque cosa si decida finirebbe nello stesso rifiuto.
      decs[side] = (fin(s.nextRetryAt) && t0 < s.nextRetryAt)
        ? { act: false, gate: 'backoff', inBand: s.inBand, distanceCents: s.distanceCents,
          reason: `in attesa dopo ${s.failStreak} rifiuti consecutivi al gate «${s.failGate}»: riprovo fra ${Math.ceil((s.nextRetryAt - t0) / 1000)}s. ${s.failReason || ''}`.trim() }
        : s.filled
        ? { act: false, gate: 'filled', inBand: null, distanceCents: null, reason: 'lato eseguito: non si ripiazza finche non intervieni a mano' }
        : !plan[side].placeable
          ? { act: false, gate: 'unplaceable', inBand: null, distanceCents: null, reason: plan[side].reason }
          : s.needsRenewal
            ? { act: true, gate: null, inBand: null, distanceCents: null, trigger: 'expiry-renewal', reason: 'rinnovo prima della scadenza GTD' }
            : decideSide({
              sideMid: sideMid[side], price: s.price, offsetCents: conf.offsetCents,
              bandRadiusCents: bandR, minMoveCents: conf.minMoveCents, placedAtMid: s.placedAtMid,
            });
      // il verdetto viaggia fino allo schermo: la tabella mostra per ogni lato dentro/fuori e perche'
      s.inBand = decs[side].inBand;
      s.distanceCents = decs[side].distanceCents;
      s.lastVerdict = decs[side].gate || decs[side].trigger || null;
    }
    m.sideDecisions = { yes: decs.yes, no: decs.no };
    m.movedCents = fin(st.referenceMid) && fin(rules.mid)
      ? +Math.abs(p2c(rules.mid) - p2c(st.referenceMid)).toFixed(4) : null;

    const sidesToDo = ['yes', 'no'].filter((side) => decs[side].act);
    if (!sidesToDo.length) {
      // Nessun lato da toccare: e' lo stato che il motore deve produrre quasi sempre. Il gate racconta
      // il caso piu' informativo fra i due lati invece di un generico «niente da fare».
      m.gate = decs.yes.gate === 'in-band' && decs.no.gate === 'in-band' ? 'both-in-band' : (decs.yes.gate || decs.no.gate);
      m.reason = `YES: ${decs.yes.reason} · NO: ${decs.no.reason}`;
      markets.push(m); continue;
    }

    // ── IL REPRICE: cancella cio' che c'e', piazza ai livelli nuovi ────────────────────────────────
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
        movedCents: m.movedCents,
        sideVerdict: decs[side].gate || decs[side].trigger || null,
        sideReason: decs[side].reason,
        distanceCents: decs[side].distanceCents,
        inBandBefore: decs[side].inBand,
        offsetCents: conf.offsetCents,
        price: target.price, priceCents: target.priceCents, size: conf.sizeShares,
        inBand: target.inBand,
        ok: !!(placed && placed.ok), sent: !!(placed && placed.sent),
        gate: placed && placed.gate ? placed.gate : null,
        reason: placed && placed.reason ? placed.reason : null,
        orderId: placed && placed.orderId ? placed.orderId : null,
        trigger: decs[side].trigger || (fin(s.placedAtMid) ? 'out-of-band' : 'initial'),
      };
      actions.push(act);
      audit({ source: TRACKING_SOURCE, event: 'reprice', ...act, at: new Date(t0).toISOString() });

      if (placed && placed.ok) {
        m.placed += 1;
        // In dry-run non c'e' orderId: si registra comunque il prezzo, cosi' il ciclo successivo non
        // ripiazza all'infinito lo stesso livello e il comportamento nel tempo e' osservabile.
        s.orderId = placed.orderId || (placed.sent === false ? `dry-${side}-${t0}` : null);
        s.price = target.price;
        s.placedAtMid = sideMid[side];
        s.placedAt = t0;
        s.needsRenewal = false;
        s.failStreak = 0; s.failGate = null; s.nextRetryAt = null; s.failReason = null;
        st.lastError = null;
      } else {
        // Stesso gate ⇒ lo streak cresce e l'attesa raddoppia. Gate diverso ⇒ si riparte da capo:
        // un guasto nuovo merita un tentativo subito.
        const gate = act.gate || 'ignoto';
        s.failStreak = (s.failGate === gate) ? s.failStreak + 1 : 1;
        s.failGate = gate;
        s.failReason = act.reason || null;
        s.nextRetryAt = t0 + backoffMs(s.failStreak);
        act.backoffMs = backoffMs(s.failStreak);
        act.failStreak = s.failStreak;
        // Una riga di log SOLO quando l'attesa cambia, non a ogni tentativo: e' l'informazione nuova.
        act.logWorthy = true;
        st.lastError = { at: t0, book: side, gate, reason: act.reason, streak: s.failStreak, retryInMs: backoffMs(s.failStreak) };
      }
    }

    m.midReadAt = t0;
    m.mid = rules.mid;
    if (m.placed > 0) {
      st.referenceMid = rules.mid;
      st.lastRepriceAt = t0;
      st.repriceCount += 1;
      m.referenceMid = st.referenceMid;
      m.repriceCount = st.repriceCount;
    }
    markets.push(m);
  }

  return result(null, null, { markets });
}

module.exports.runTrackingCycle = runTrackingCycle;
module.exports.emptyMarketState = emptyMarketState;

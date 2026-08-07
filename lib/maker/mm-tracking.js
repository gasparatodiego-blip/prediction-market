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
// IL SECONDO SEGNALE. Vive in un modulo suo, puro come mm-quote-math: la macchina a stati dell'erosione
// va poter essere esaurita da un test senza un venue, senza un file e senza un orologio vero.
const {
  erosionConfig, zoneDepth, emptyErosionState, updateErosion, ottimizzaScope, repriceAllowed,
  erosionRetreat, retreatReset, triggerKind,
} = require('./book-erosion');
// MAI IN CIMA AL BOOK. Stesso stile degli altri due moduli di calcolo: puro, e quindi esauribile da un
// test senza venue. Governa DOVE va l'ordine; mm-tracking resta l'unico a decidere SE muoverlo.
const { bestOtherBid, planBehindBest, followNeedsMove } = require('./top-of-book');
// La traduzione «configurazione → lati da quotare» vive nel registro e si importa: tenerne una copia qui
// vorrebbe dire poter rispondere «entrambi» dove il pannello dice «solo YES».
const { activeSides } = require('./mm-tracking-config');
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
        failStreak: 0, failGate: null, nextRetryAt: null, failReason: null, lastRepriceAt: null },
      no: { orderId: null, price: null, filled: false, filledAt: null, needsRenewal: false, placedAtMid: null, placedAt: null, inBand: null, distanceCents: null, lastVerdict: null,
        failStreak: 0, failGate: null, nextRetryAt: null, failReason: null, lastRepriceAt: null },
    },
    // LA SERIE DELLA PROFONDITA', per lato. Sta accanto allo stato del lato e non dentro, perche' e' una
    // storia che si azzera per ragioni sue — a ogni riposizionamento — mentre il resto del lato no.
    erosion: { yes: emptyErosionState(), no: emptyErosionState() },
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

    // ── GATE 2-bis — LA CADENZA DI QUESTO MERCATO (lib/maker/cadenza-adattiva.js) ──────────────────
    // Un mercato fermo non ha bisogno di essere interrogato ogni 3 secondi: rispondere «non e' successo
    // niente» costa una chiamata al venue per ogni giro. Qui si salta PRIMA di listOrders, che e' la
    // chiamata vera — saltare dopo non avrebbe risparmiato nulla.
    // NON abbassa nessuna soglia: `minMoveCents` piu' sotto decide ancora se riprezzare. Questo decide
    // solo se GUARDARE. Un mercato mai visto viene sempre guardato.
    const cad = typeof deps.cadenza === 'function' ? deps.cadenza(marketId) : { valuta: true, cadenzaMs: null, classe: 'spenta', motivo: null };
    if (cad && cad.valuta === false) {
      m.gate = 'cadenza-adattiva';
      m.reason = `mercato ${cad.classe}: si guarda ogni ${cad.cadenzaMs}ms, mancano ${cad.attesaMs}ms — ${cad.motivo}`;
      m.cadenzaMs = cad.cadenzaMs; m.cadenzaClasse = cad.classe;
      markets.push(m); continue;
    }
    if (cad) { m.cadenzaMs = cad.cadenzaMs; m.cadenzaClasse = cad.classe; }
    if (typeof deps.segnaValutazione === 'function') deps.segnaValutazione(marketId, t0);

    // L'orologio si LEGGE qui ma si APPLICA piu' sotto, dopo aver visto il libro: il suo gate deve poter
    // cancellare, e per cancellare serve sapere cosa c'e' a riposo.
    const win = typeof deps.marketWindow === 'function' ? deps.marketWindow(marketId) : null;

    // Le REGOLE si risolvono PRIMA dell'orologio, e non e' un riordino cosmetico: senza tick e token di
    // questo mercato non si puo' attribuire un ordine a un lato, e senza quello non si puo' cancellare
    // nulla in sicurezza. L'orologio qui sotto ha bisogno di poter cancellare.
    const rules = typeof deps.resolveRules === 'function' ? deps.resolveRules(marketId) : null;
    if (!rules || rules.readable !== true) {
      m.gate = 'rules-unreadable';
      m.reason = `regole di venue non leggibili (mancano: ${rules && Array.isArray(rules.missing) ? rules.missing.join(', ') : 'ignoto'})`;
      markets.push(m); continue;
    }

    // ── LA VERITA' DEL VENUE, PRIMA DELL'OROLOGIO ─────────────────────────────────────────────────
    // Stava dopo. Spostarla qui e' il cuore di questa correzione: finche' la lettura veniva dopo il
    // gate dell'orologio, un mercato in chiusura usciva dal ciclo SENZA che il motore avesse mai
    // guardato cosa c'era a riposo — quindi non poteva ne' cancellarlo, ne' accorgersi che qualcuno
    // l'aveva cancellato a mano. Misurato dal vivo: un ordine rimasto a 53c mentre il mid saliva a 94c,
    // per venti minuti, con il motore che a ogni giro diceva «non riprezzo» e non guardava.
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

    // ── GATE 3 — L'OROLOGIO DEL MERCATO, ORA CON UNA VIA D'USCITA ─────────────────────────────────
    // Sotto la soglia non si piazza piu' nulla: la finestra GTD piu' corta che il venue accetta
    // sopravvivrebbe al mercato, quindi un ordine NUOVO non sarebbe esprimibile.
    //
    // MA NON PIAZZARE E LASCIARE FERMO SONO DUE COSE DIVERSE, e prima erano la stessa. La soglia
    // riguarda cio' che si PIAZZA; togliere un ordine dal libro non richiede alcuna finestra ed e'
    // l'unica direzione che puo' solo ridurre l'esposizione. Quindi qui si cancella.
    //
    // COSA SI CANCELLA: gli ordini a riposo attribuibili a uno dei due libri di QUESTO mercato. Un
    // ordine il cui token non appartiene ne' al libro YES ne' a quello NO non viene toccato — non e'
    // nostro da giudicare, e indovinare significherebbe cancellare l'ordine di qualcun altro.
    if (win && win.tooClose === true) {
      m.gate = win.gate || 'market-too-close-to-close';
      m.endOfLife = { minutesToClose: win.minutesToClose ?? null, closed: win.gate === 'market-closed' };
      const daTogliere = resting.filter((o) => bookOf(o, rules) !== null);
      for (const o of daTogliere) {
        const side = bookOf(o, rules);
        let can;
        try { can = await deps.cancelOrder({ orderId: o.orderId, marketId }); }
        catch (e) { can = { ok: false, reason: e.message }; }
        const ok = !!(can && can.ok !== false);
        actions.push({ action: 'end-of-life-cancel', marketId, book: side, orderId: o.orderId, ok,
          minutesToClose: win.minutesToClose ?? null, reason: (can && can.reason) || null });
        audit({ source: TRACKING_SOURCE, event: ok ? 'end-of-life-cancelled' : 'end-of-life-cancel-failed',
          marketId, book: side, orderId: o.orderId, minutesToClose: win.minutesToClose ?? null,
          reason: (can && can.reason) || 'mercato a fine vita: non si puo piu riprezzare, quindi si toglie dal libro',
          at: new Date(t0).toISOString() });
        if (ok) {
          m.cancelled += 1;
          const s = st.sides[side];
          if (s && String(s.orderId) === String(o.orderId)) { s.orderId = null; s.price = null; s.placedAtMid = null; s.needsRenewal = false; }
        }
      }
      m.reason = `${win.reason} — il motore non piazza piu su questo mercato`
        + (daTogliere.length
          ? `; ${m.cancelled}/${daTogliere.length} ordini a riposo CANCELLATI invece di essere lasciati fermi`
          : '; nessun ordine a riposo da togliere');

      // ── FIX 3 · IL REGISTRO NON RESTA ACCESO SU UN MERCATO MORTO ────────────────────────────────
      // Solo a mercato effettivamente CHIUSO, non nei minuti finali: dentro la finestra il tracking
      // deve restare configurato, perche' e' ancora il mercato dell'operatore. Dopo la chiusura non c'e'
      // piu' niente da tracciare, e un record acceso su un mercato risolto e' rumore che si accumula —
      // e, peggio, fa credere che il motore stia lavorando dove non puo' piu' fare nulla.
      // Si spegne SOLO dopo aver tolto tutto: prima si libera il libro, poi si chiude il registro.
      const tuttoTolto = daTogliere.length === m.cancelled;
      if (win.gate === 'market-closed' && tuttoTolto && typeof deps.disableTracking === 'function') {
        let off = null;
        try { off = deps.disableTracking({ marketId, reason: 'mercato chiuso: non c e piu nulla da tracciare' }); }
        catch (e) { off = { ok: false, error: e.message }; }
        m.autoDisabled = !!(off && off.ok);
        events.push({ type: 'tracking-auto-off', marketId, ok: !!(off && off.ok), error: off && off.error });
        audit({ source: TRACKING_SOURCE, event: (off && off.ok) ? 'tracking-auto-off' : 'tracking-auto-off-failed',
          marketId, reason: 'mercato chiuso e libro libero: il tracking si spegne da solo', at: new Date(t0).toISOString() });
        if (off && off.ok) m.reason += ' · tracking SPENTO automaticamente: mercato chiuso e nessun ordine residuo';
      }
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
          events.push({ type: 'fill', marketId, side, orderId: s.orderId, sizeMatched: matched, price: s.price, kind: 'parziale' });
          audit({ source: TRACKING_SOURCE, event: 'fill-detected', marketId, book: side, orderId: s.orderId, sizeMatched: matched, price: s.price, kind: 'parziale', at: new Date(t0).toISOString() });
        }
      } else {
        // ── SPARITO DAL LIBRO: TRATTATO COME ESEGUITO (punto 6) ─────────────────────────────────
        // Prima questo ramo azzerava il lato e basta, quindi al giro dopo il motore RIPIAZZAVA. Era
        // l'asimmetria piu' costosa del motore: un fill PARZIALE fermava il lato, un fill TOTALE lo
        // faceva ripartire — e il fill totale e' esattamente il caso in cui si e' comprato di piu'.
        // Su un mercato che scende in linea retta significava riempirsi e ricomprare piu' in basso, a
        // ripetizione, senza che nulla nel motore lo notasse.
        //
        // Adesso i due casi sono UNO SOLO. Un ordine che era nostro e non e' piu' sul libro, quando non
        // siamo stati noi a cancellarlo (le nostre cancellazioni azzerano `orderId` subito prima), e'
        // stato eseguito, e' scaduto, o l'ha tolto l'operatore. Non sappiamo quale — e la lettura
        // conservativa e' «eseguito», perche' e' l'unica delle tre che lascia esposizione aperta.
        //
        // CONSEGUENZA DICHIARATA: quel lato SMETTE di riquotare finche' non intervieni. Se invece era
        // una cancellazione tua o una scadenza, non c'e' nessuna posizione e il meccanismo di uscita non
        // trovera' nulla da chiudere: il costo dell'errore e' un lato fermo, non un ordine sbagliato.
        s.filled = true; s.filledAt = t0;
        events.push({ type: 'fill', marketId, side, orderId: s.orderId, sizeMatched: null, price: s.price, kind: 'totale-presunto' });
        audit({ source: TRACKING_SOURCE, event: 'fill-detected', marketId, book: side, orderId: s.orderId,
          sizeMatched: null, price: s.price, kind: 'totale-presunto',
          reason: 'ordine sparito dal libro senza che fossimo noi a cancellarlo: trattato come eseguito (lettura conservativa)',
          at: new Date(t0).toISOString() });
        s.orderId = null; s.price = null;
      }
    }

    // ── QUALI LATI QUOTA QUESTO MERCATO ───────────────────────────────────────────────────────────
    // Una sola definizione, importata dal registro: se il motore ne tenesse una sua, «entrambi» qui e
    // «solo YES» nel pannello sarebbero due verita' su uno stesso mercato.
    const wanted = activeSides(conf.sides);
    m.sides = conf.sides || 'both';
    m.activeSides = wanted;

    // ── IL RITIRO DI UN LATO SPENTO ───────────────────────────────────────────────────────────────
    // Cambiare i lati su un tracking gia' acceso lascia un ordine a riposo sul lato ritirato. Chi ha
    // fatto il cambio lo cancella subito (la route lo fa nello stesso istante, come parte dell'azione),
    // ma se quella cancellazione fallisce nessun altro se ne occuperebbe MAI: quel lato non e' piu'
    // tracciato, quindi nessuna decisione lo riguarda e resterebbe sul libro fino alla scadenza GTD.
    //
    // Questo e' il paracadute. Gira a ogni ciclo, non costa nulla quando non c'e' niente da ritirare, e
    // trasforma «un tentativo di cancellazione» in «cancellato, o si continua a provarci».
    for (const side of ['yes', 'no']) {
      if (wanted.includes(side)) continue;
      const s = st.sides[side];
      if (!s.orderId) continue;
      let can;
      try { can = await deps.cancelOrder({ orderId: s.orderId, marketId }); }
      catch (e) { can = { ok: false, reason: e.message }; }
      const ok = !!(can && can.ok !== false);
      actions.push({ action: 'retire-side', marketId, book: side, orderId: s.orderId, ok, reason: (can && can.reason) || null });
      audit({ source: TRACKING_SOURCE, event: ok ? 'side-retired' : 'side-retire-failed', marketId, book: side,
        orderId: s.orderId, sides: m.sides, reason: (can && can.reason) || 'lato non piu tracciato', at: new Date(t0).toISOString() });
      // Lo stato si azzera SOLO se la cancellazione e' riuscita: dimenticare un orderId ancora vivo sul
      // venue significherebbe non riprovare mai piu' a toglierlo.
      if (ok) { m.cancelled += 1; s.orderId = null; s.price = null; s.placedAtMid = null; s.needsRenewal = false; }
    }

    const plan = planQuotes({ mid: rules.mid, offsetCents: conf.offsetCents, tick: rules.tick, bandRadiusCents: rules.bandRadiusCents });
    m.plan = plan;
    // `plan.ok` riguarda mid/offset/tick, non i lati: resta un rifiuto per l'intero mercato.
    if (!plan.ok) { m.gate = 'plan-unplaceable'; m.reason = plan.reason; markets.push(m); continue; }

    // Il mid di ciascun book. Si risolve QUI e non piu' in fondo perche' la misura della profondita' ne
    // ha bisogno, e la profondita' si campiona prima delle decisioni.
    const bandR = fin(rules.bandRadiusCents) ? rules.bandRadiusCents : null;
    const sideMid = { yes: rules.mid, no: fin(rules.mid) ? +(1 - rules.mid).toFixed(6) : null };

    // ── IL SECONDO SEGNALE: L'EROSIONE DEL BOOK DAVANTI ALL'ORDINE ────────────────────────────────
    // Si misura QUI, prima delle decisioni, e per TUTTI i lati con un ordine a riposo — anche quelli che
    // poi non agiranno. La serie temporale deve essere continua: campionarla solo quando fa comodo
    // produrrebbe una baseline fatta dei momenti in cui stavamo gia' guardando, che non e' una baseline.
    const eroCfg = erosionConfig(tuning);
    if (!st.erosion) st.erosion = { yes: emptyErosionState(), no: emptyErosionState() };
    // LO SCOPO DEI COMPORTAMENTI DINAMICI, calcolato UNA VOLTA e usato da entrambi: «mai in cima» e
    // l'erosione devono valere esattamente sugli stessi mercati. Due predicati separati sarebbero due
    // occasioni di divergere di un mercato, e nessuno se ne accorgerebbe.
    const eroGate = ottimizzaScope({
      closeKnown: win ? win.closeKnown : null,
      minutesToClose: win ? win.minutesToClose : null,
      bandRadiusCents: rules.bandRadiusCents,
      cfg: eroCfg,
    });
    const depthSnap = eroGate.eligible && typeof deps.readDepth === 'function'
      ? (() => { try { return deps.readDepth(marketId); } catch (e) { return { readable: false, reason: e.message }; } })()
      : null;
    const ero = { yes: null, no: null };
    for (const side of ['yes', 'no']) {
      const s = st.sides[side];
      if (!eroGate.eligible) {
        // Mercato non candidato: la serie si azzera, cosi' se un giorno lo diventasse ripartirebbe dal
        // riscaldamento invece di ereditare una storia raccolta quando la misura non valeva.
        st.erosion[side] = emptyErosionState();
        ero[side] = { applies: false, gate: eroGate.gate, reason: eroGate.reason };
        continue;
      }
      if (!s.orderId || !fin(s.price) || s.filled) {
        st.erosion[side] = emptyErosionState();
        ero[side] = { applies: false, gate: 'no-resting-order', reason: 'nessun ordine a riposo su questo lato: non esiste una zona da misurare' };
        continue;
      }
      const levels = depthSnap && depthSnap.readable && depthSnap[side] ? depthSnap[side].bids : null;
      const z = zoneDepth({ levels, orderPrice: s.price, sideMid: sideMid[side] });
      const v = updateErosion(st.erosion[side], { depth: z.readable ? z.depth : null, now: t0, cfg: eroCfg });
      ero[side] = {
        applies: true, gate: null,
        depth: v.depth, levels: z.levels, baseline: v.baseline, ratioPct: v.ratioPct,
        belowStreak: v.belowStreak, samples: v.samples, established: v.established,
        erosion: v.erosion, fired: v.fired, recovered: v.recovered,
        reason: z.readable ? v.reason : (depthSnap && depthSnap.reason) || z.reason,
      };
      // Una riga di audit SOLO alle transizioni — innesco e rientro — non a ogni lettura. E' l'unica
      // informazione nuova, ed e' quella che servira' per tarare 40/60 sui dati veri.
      if (v.fired || v.recovered) {
        audit({ source: TRACKING_SOURCE, event: v.fired ? 'erosion-armed' : 'erosion-recovered',
          marketId, book: side, depth: v.depth, baseline: v.baseline, ratioPct: v.ratioPct,
          triggerPct: eroCfg.triggerPct, recoveryPct: eroCfg.recoveryPct, belowStreak: v.belowStreak,
          windowMs: eroCfg.windowMs, samples: v.samples, reason: v.reason, at: new Date(t0).toISOString() });
        events.push({ type: v.fired ? 'erosion-armed' : 'erosion-recovered', marketId, side,
          depth: v.depth, baseline: v.baseline, ratioPct: v.ratioPct, reason: v.reason });
      }
    }
    m.erosion = ero;
    m.erosionGate = eroGate.eligible ? null : eroGate.gate;

    // ── DOVE VA L'ORDINE: MAI IN CIMA AL BOOK ─────────────────────────────────────────────────────
    // Il bersaglio non e' piu' «mid meno offset». E' «un tick dietro il miglior prezzo che qualcun ALTRO
    // sta offrendo su questo lato», e la distanza dal mid diventa una conseguenza del book invece che un
    // numero scelto. Vale SOLO dentro lo scopo Ottimizza: un mercato direzionale veloce, o senza banda,
    // continua a passare per `plan` esattamente come prima — non una riga di questo blocco lo tocca.
    //
    // L'OFFSET CONFIGURATO NON SPARISCE, CAMBIA MESTIERE: da bersaglio diventa il RIPIEGO per quando
    // siamo gli unici su quel lato e non esiste un «migliore altrui» dietro cui mettersi. E' anche il
    // motivo per cui questo comportamento non aggiunge nessun controllo da impostare: il numero che
    // serve al ripiego e' quello che l'operatore ha gia' scelto.
    const tgt = { yes: null, no: null };
    for (const side of ['yes', 'no']) {
      if (!eroGate.eligible) { tgt[side] = null; continue; }   // fuori scopo ⇒ decide `plan`, come sempre
      const levels = depthSnap && depthSnap.readable && depthSnap[side] ? depthSnap[side].bids : null;
      // I NOSTRI ordini su questo book, per poterli togliere dal book prima di guardarlo. Senza questo
      // il motore inseguirebbe se stesso, scendendo di un tick a ogni ciclo.
      const nostri = resting.filter((o) => bookOf(o, rules) === side)
        .map((o) => ({ price: Number(o.price), size: Number(o.size), sizeRemaining: Number(o.sizeRemaining) }));
      const bo = bestOtherBid({ levels, ownOrders: nostri, tick: rules.tick });
      // Book illeggibile ⇒ NON si finge di essere soli: si torna al piano a offset fisso, che e' il
      // comportamento di prima e non dipende dal book. «Non ho letto» non diventa «non c'e' nessuno».
      if (!bo.readable) {
        tgt[side] = { ok: false, unreadable: true, reason: `${bo.reason} — si resta sull offset configurato` };
        continue;
      }
      // EROSIONE ARMATA ⇒ IL BERSAGLIO E' IL BORDO PREMIANTE, non il book. Finche' il segnale difensivo
      // e' attivo non si torna a inseguire il miglior bid altrui: sarebbe rimettersi subito dove si e'
      // appena deciso di non stare. E' l'isteresi che governa quando si smette.
      const armata = ero[side] && ero[side].applies && ero[side].erosion === true;
      if (armata) {
        const r = erosionRetreat({ offsetCents: conf.offsetCents, bandRadiusCents: bandR, tick: rules.tick });
        if (r.ok) {
          const p = snap(sideMid[side] - r.offsetCents / 100, rules.tick);
          tgt[side] = { ok: fin(p) && p > 0 && p < 1, price: p, priceCents: fin(p) ? +(p2c(p)).toFixed(3) : null,
            inBand: true, mode: 'erosion-retreat', onTop: fin(bo.price) ? p >= bo.price - 1e-9 : null,
            offsetCents: r.offsetCents, bestOther: bo.price, alone: bo.alone,
            reason: `erosione armata: ${r.reason}` };
          continue;
        }
        // niente arretramento possibile ⇒ si continua col bersaglio normale, e l'OR piu' sotto lo dira'
      }
      const pb = planBehindBest({
        bestOther: bo.price, tick: rules.tick, scoringMid: sideMid[side],
        bandRadiusCents: bandR, fallbackOffsetCents: conf.offsetCents,
      });
      // `inBand` non e' un controllo a posteriori: planBehindBest aggancia il prezzo al bordo della
      // banda prima di restituirlo, quindi un bersaglio `ok` E' dentro banda per costruzione.
      tgt[side] = { ...pb, inBand: pb.ok ? true : null, bestOther: bo.price, bestOtherSize: bo.size, alone: bo.alone, otherLevels: bo.levels };
    }
    m.target = tgt;

    // ── LA DECISIONE, ORA PER LATO ────────────────────────────────────────────────────────────────
    // Prima era una sola: «il mid si e' mosso oltre la soglia?» e i due lati si spostavano insieme.
    // Adesso ogni lato risponde per se' alla domanda che conta davvero — «sto ancora maturando?» — e
    // un lato dentro banda non viene toccato nemmeno se l'altro si e' dovuto spostare.
    // LA DECISIONE QUANDO IL BERSAGLIO LO DETTA IL BOOK. Stessa domanda di prima — «questo lato va
    // spostato?» — ma il metro non e' piu' la distanza dal mid: e' la distanza dal punto in cui il book
    // dice che dovremmo stare adesso. L'ordine dei controlli e' deliberato e va letto dall'alto:
    //   rinnovo GTD   il dead-man's switch viene prima di ogni ragionamento sul prezzo
    //   missing       niente a riposo: si piazza, non si «riposiziona»
    //   fuori banda   si muove SEMPRE, a qualunque distanza dal bersaglio: li' matura zero
    //   erosione      il bersaglio e' gia' il bordo premiante; questo ramo gli da' il nome giusto
    //   follow-book   il book si e' spostato oltre la soglia gia' configurata
    const decidiSulBook = (side, s, t) => {
      if (s.needsRenewal) return { act: true, gate: null, inBand: null, distanceCents: null, trigger: 'expiry-renewal', reason: 'rinnovo prima della scadenza GTD' };
      if (!s.orderId || !fin(s.price)) {
        return { act: true, gate: null, inBand: null, distanceCents: null, trigger: 'missing',
          reason: `nessun ordine a riposo su questo lato: lo piazzo — ${t.reason}` };
      }
      const distanceCents = +Math.abs(p2c(s.price) - p2c(sideMid[side])).toFixed(4);
      const inBand = fin(bandR) ? distanceCents <= bandR + 1e-9 : null;
      if (inBand === false) {
        return { act: true, gate: null, inBand: false, distanceCents, trigger: 'out-of-band',
          reason: `FUORI BANDA: dista ${distanceCents}¢ dal mid, oltre il raggio ${bandR}¢ — sta rendendo zero. ${t.reason}` };
      }
      const mv = followNeedsMove({ restingPrice: s.price, targetPrice: t.price, minMoveCents: conf.minMoveCents, tick: rules.tick });
      const armata = ero[side] && ero[side].applies && ero[side].erosion === true;
      if (mv.move && armata && t.mode === 'erosion-retreat') {
        return { act: true, gate: null, inBand, distanceCents, trigger: 'erosion', byErosion: true,
          reason: `EROSIONE DEL BOOK: ${ero[side].reason} — ${t.reason}` };
      }
      if (mv.move) {
        return { act: true, gate: null, inBand, distanceCents, trigger: 'follow-book',
          reason: `${mv.reason} — ${t.reason}` };
      }
      return { act: false, gate: 'in-band', inBand, distanceCents,
        reason: `dentro banda e gia al posto giusto: ${mv.reason}. ${t.mode === 'fallback-alone' ? 'Siamo gli unici su questo lato.' : `Il migliore altrui e a ${t.bestOther != null ? +(t.bestOther * 100).toFixed(2) : '—'}¢.`}` };
    };

    const decs = {};
    for (const side of ['yes', 'no']) {
      const s = st.sides[side];
      const t = tgt[side];
      // Il bersaglio dal book vale solo se si e' potuto calcolare. Altrimenti — mercato fuori scopo,
      // feed illeggibile, banda assente — si torna al percorso a offset fisso, che e' esattamente il
      // comportamento di prima: i mercati direzionali veloci non passano MAI dal ramo nuovo.
      const usaBook = !!(t && t.ok === true);
      // IL LATO SPENTO, per primo di tutti: non e' «niente da fare adesso», e' «questo lato non e'
      // governato da questo motore». Compare comunque nelle decisioni, con il suo gate, perche' la
      // tabella in dashboard deve poter dire PERCHE' quel lato e' fermo invece di lasciarlo vuoto.
      decs[side] = !wanted.includes(side)
        ? { act: false, gate: 'side-disabled', inBand: null, distanceCents: null,
          reason: `lato non attivo: il tracking di questo mercato quota ${m.sides === 'both' ? 'entrambi i lati' : `solo ${m.sides.toUpperCase()}`}` }
        // IL FRENO: se questo lato sta scontando un backoff non si decide nemmeno cosa farne, perche'
        // qualunque cosa si decida finirebbe nello stesso rifiuto.
        : (fin(s.nextRetryAt) && t0 < s.nextRetryAt)
        ? { act: false, gate: 'backoff', inBand: s.inBand, distanceCents: s.distanceCents,
          reason: `in attesa dopo ${s.failStreak} rifiuti consecutivi al gate «${s.failGate}»: riprovo fra ${Math.ceil((s.nextRetryAt - t0) / 1000)}s. ${s.failReason || ''}`.trim() }
        : s.filled
        ? { act: false, gate: 'filled', inBand: null, distanceCents: null, reason: 'lato eseguito: non si ripiazza finche non intervieni a mano' }
        // ── «MAI PRIMI SUL LIBRO»: UN RIFIUTO NON È UN «BOOK NON DISPONIBILE» ──────────────────
        // `usaBook` è `t.ok === true`, quindi un `ok:false` faceva ricadere il motore sul percorso
        // basato sul mid — che il libro non lo guarda affatto, e piazzava lo stesso. Cioè la
        // decisione «non quotare questo lato» veniva presa e poi scavalcata dal ripiego.
        // Il rifiuto va intercettato PRIMA di quel bivio: è l'unico caso in cui la risposta è
        // «nessun prezzo esiste per questo lato», e non c'è ripiego che possa rimediarci.
        : (t && t.quotabile === false)
        ? { act: false, gate: 'sarebbe-primo-sul-libro', inBand: null, distanceCents: null,
          reason: t.reason || 'un tick dietro il miglior concorrente uscirebbe dalla banda: questo lato non si quota' }
        : usaBook
          ? decidiSulBook(side, s, t)
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

    // ── L'OR FRA I DUE SEGNALI, E DOVE VIVE ADESSO ───────────────────────────────────────────────
    // L'OR non e' piu' un blocco che riscrive una decisione gia' presa: e' entrato nel bersaglio. Quando
    // l'erosione e' armata, `tgt[side]` E' il bordo premiante invece del posto dietro al miglior bid, e
    // `decidiSulBook` gli da' il nome (`trigger:'erosion'`). Un solo posto decide dove va l'ordine, e la
    // versione precedente — che calcolava un secondo piano qui sotto — poteva contraddire il primo.
    //
    // COSA RESTA QUI: i casi in cui l'erosione e' armata ma NON si agisce, che vanno detti lo stesso.
    // Sono i due che il punto 7 impone — nessun arretramento possibile, o bersaglio che non maturerebbe —
    // piu' l'annotazione per l'audit quando a muovere e' stato il mid mentre l'erosione era armata.
    for (const side of ['yes', 'no']) {
      const e = ero[side];
      if (!e || !e.applies || !e.erosion) continue;
      const d = decs[side];
      if (d.trigger === 'erosion') continue;               // gia' governato dal bersaglio
      if (d.act) { d.byErosion = true; continue; }          // si muove per il mid: si annota e basta
      if (d.gate !== 'in-band') continue;
      // Erosione armata, lato fermo: il bersaglio non e' l'arretramento. O non c'era dove arretrare, o
      // il bersaglio coincide con dov'e' gia' l'ordine. In entrambi i casi si dichiara.
      const t = tgt[side];
      d.byErosion = true;
      d.erosionHeld = t && t.mode === 'erosion-retreat' ? 'already-at-retreat' : 'no-retreat';
      d.reason += t && t.mode === 'erosion-retreat'
        ? ' · erosione armata: l ordine e gia al bordo premiante, non c e nulla da spostare'
        : ` · erosione armata ma non si agisce: ${erosionRetreat({ offsetCents: conf.offsetCents, bandRadiusCents: bandR, tick: rules.tick }).reason}`;
    }

    // ── IL FRENO FRA DUE RIPREZZI, PER LATO E PER ENTRAMBI I TRIGGER ──────────────────────────────
    // Vale a valle dell'OR, cosi' non conta quale dei due segnali ha chiesto il movimento: due trigger
    // vicini nel tempo producono UN riposizionamento. Primo piazzamento e rinnovo GTD sono esenti — la
    // funzione lo decide, e il perche' e' scritto li'.
    for (const side of ['yes', 'no']) {
      const d = decs[side];
      if (!d.act) continue;
      const brake = repriceAllowed({
        trigger: d.trigger, lastRepriceAt: st.sides[side].lastRepriceAt, now: t0, cfg: eroCfg,
      });
      if (brake.allowed) continue;
      decs[side] = {
        act: false, gate: 'reprice-rate-limited', inBand: d.inBand, distanceCents: d.distanceCents,
        heldTrigger: d.trigger, byErosion: d.byErosion === true, reason: brake.reason,
      };
    }

    for (const side of ['yes', 'no']) {
      // Il verdetto definitivo — dopo OR e freno — e' quello che deve arrivare allo schermo.
      st.sides[side].lastVerdict = decs[side].gate || decs[side].trigger || null;
    }
    m.sideDecisions = { yes: decs.yes, no: decs.no };
    m.movedCents = fin(st.referenceMid) && fin(rules.mid)
      ? +Math.abs(p2c(rules.mid) - p2c(st.referenceMid)).toFixed(4) : null;

    const sidesToDo = ['yes', 'no'].filter((side) => decs[side].act);
    if (!sidesToDo.length) {
      // Nessun lato da toccare: e' lo stato che il motore deve produrre quasi sempre. Il gate racconta
      // il caso piu' informativo fra i lati ATTIVI — non fra tutti e due. Su un mercato a lato singolo
      // il lato spento e' sempre fermo per definizione, e lasciarlo vincere qui vorrebbe dire riportare
      // «side-disabled» come stato del mercato mentre il lato che lavora sta tranquillamente in banda:
      // vero alla lettera, e completamente fuorviante su cosa stia succedendo.
      m.gate = wanted.every((s) => decs[s].gate === 'in-band')
        ? (wanted.length === 2 ? 'both-in-band' : 'in-band')
        : (wanted.map((s) => decs[s].gate).find(Boolean) || 'side-disabled');
      m.reason = wanted.map((s) => `${s.toUpperCase()}: ${decs[s].reason}`).join(' · ');
      markets.push(m); continue;
    }

    // ── IL REPRICE: cancella cio' che c'e', piazza ai livelli nuovi ────────────────────────────────
    for (const side of sidesToDo) {
      const s = st.sides[side];
      // IL BERSAGLIO: quello dettato dal book quando il mercato e' nello scopo Ottimizza, quello a
      // offset fisso altrimenti. Sono due percorsi, non due varianti dello stesso: un mercato fuori
      // scopo non tocca mai il primo.
      const target = (tgt[side] && tgt[side].ok === true) ? tgt[side] : plan[side];
      // gia' esattamente li? niente da fare: cancellare e ripiazzare allo stesso prezzo e' solo rischio
      if (!s.needsRenewal && s.orderId && fin(s.price) && Math.abs(s.price - target.price) < (rules.tick || 0.01) / 1000) continue;

      // L'offset EFFETTIVO di questo piazzamento. Con il bersaglio dettato dal book non e' piu' un
      // parametro ma un risultato, e scrivere quello configurato farebbe leggere l'audit come se
      // l'ordine fosse andato dove non e' andato.
      const effOffset = fin(target.offsetCents) ? target.offsetCents : conf.offsetCents;
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
          note: `tracking attivo · offset ${effOffset}¢ · mid ${(p2c(rules.mid)).toFixed(2)}¢`
            + `${target.mode ? ` · ${target.mode}` : ''}`
            + `${target.onTop === true ? ' · IN CIMA AL BOOK (bordo banda)' : ''}`
            + `${decs[side].trigger === 'erosion' ? ' · ARRETRATO PER EROSIONE DEL BOOK' : ''}`
            + `${target.inBand === false ? ' · FUORI BANDA (nessun reward su questo lato)' : ''}`,
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
        // L'offset EFFETTIVO di questo piazzamento: quello configurato di norma, quello di
        // arretramento quando a muovere e' stata l'erosione. Scrivere sempre il primo farebbe leggere
        // l'audit come se l'ordine fosse andato dove non e' andato.
        offsetCents: effOffset,
        configuredOffsetCents: conf.offsetCents,
        price: target.price, priceCents: target.priceCents, size: conf.sizeShares,
        inBand: target.inBand,
        ok: !!(placed && placed.ok), sent: !!(placed && placed.sent),
        gate: placed && placed.gate ? placed.gate : null,
        reason: placed && placed.reason ? placed.reason : null,
        orderId: placed && placed.orderId ? placed.orderId : null,
        trigger: decs[side].trigger || (fin(s.placedAtMid) ? 'out-of-band' : 'initial'),
        // ── OSSERVABILITA': QUALE SEGNALE HA MOSSO QUESTO ORDINE ──────────────────────────────────
        // `mid` | `erosione` | `entrambi`, piu' i numeri con cui l'erosione lo ha affermato. Serve a
        // poter rispondere, fra un mese e con i dati veri, a «quanto ha contribuito ciascuno dei due» e
        // a «40/60, finestra 10 min e 2 letture sono la taratura giusta» — che oggi sono stime.
        triggerKind: triggerKind({
          mid: decs[side].trigger !== 'erosion',
          erosion: decs[side].byErosion === true,
        }),
        // ── DOVE SIAMO FINITI RISPETTO AL BOOK, per il pannello e per l'audit ──────────────────────
        placement: (tgt[side] && tgt[side].ok === true)
          ? { mode: tgt[side].mode, onTop: tgt[side].onTop, bestOther: tgt[side].bestOther,
            bestOtherSize: tgt[side].bestOtherSize, alone: tgt[side].alone,
            otherLevels: tgt[side].otherLevels, offsetCents: tgt[side].offsetCents }
          : { mode: 'fixed-offset', onTop: null, offsetCents: conf.offsetCents,
            reason: tgt[side] ? tgt[side].reason : (m.erosionGate || 'mercato fuori dallo scopo Ottimizza') },
        erosion: ero[side] && ero[side].applies
          ? { depth: ero[side].depth, baseline: ero[side].baseline, ratioPct: ero[side].ratioPct,
            belowStreak: ero[side].belowStreak, samples: ero[side].samples, armed: ero[side].erosion,
            triggerPct: eroCfg.triggerPct, recoveryPct: eroCfg.recoveryPct, windowMs: eroCfg.windowMs }
          : { applies: false, gate: ero[side] ? ero[side].gate : null },
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
        // Il freno parte da adesso, per QUESTO lato.
        s.lastRepriceAt = t0;
        // ── LA SERIE DELLA PROFONDITA' RIPARTE DA ZERO ──────────────────────────────────────────
        // L'ordine ha un prezzo nuovo, quindi la zona fra l'ordine e il mid e' un'altra zona: i campioni
        // raccolti prima descrivevano una coda che non e' piu' la mia. Tenerli vorrebbe dire confrontare
        // la profondita' di adesso con la media di un posto diverso del libro.
        //
        // E' anche il freno piu' forte dell'intero meccanismo, ed e' voluto: dopo ogni riposizionamento
        // servono di nuovo il riscaldamento completo (campioni E span) prima che l'erosione possa
        // riarmarsi. Un lato non puo' quindi essere mosso dall'erosione piu' di una volta ogni
        // ~2 minuti, qualunque cosa faccia il book.
        //
        // CON UN'ECCEZIONE, che e' la difesa stessa: se a muovere e' stata l'erosione, `armed` deve
        // sopravvivere all'azzeramento — altrimenti al giro dopo il segnale risulta spento, il bersaglio
        // torna dietro al miglior bid, e l'ordine rientra dove si era appena deciso di non stare.
        st.erosion[side] = decs[side].trigger === 'erosion'
          ? retreatReset(st.erosion[side])
          : emptyErosionState();
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

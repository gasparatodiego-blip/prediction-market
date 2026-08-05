#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent40-manual-reprice — the BAND-EXIT WATCHER for hand-placed orders.
//
// WHY IT EXISTS. A manual order used to carry a fixed ~180s GTD expiry: the venue killed it on a clock,
// whatever the price was doing. That is the wrong axis for a reward maker — what matters is whether the
// order is still inside the band that pays, not how long it has been sitting there. So on an auto-reprice
// market a hand order carries a RESTING_GTD_SECONDS window (23 min) and this process does three things:
//   • RE-PRICES it when the mid has travelled far enough to push it out of the band that pays. If the mid
//     does not move that far, the order is not touched at all;
//   • RENEWS the window proactively before it can lapse, so time never kills a healthy order — while the
//     window itself stays real, as the DEAD-MAN'S SWITCH the exchange enforces if this host stops;
//   • RECONCILES the manual lane's sent orders against venue truth, so an order the venue retired stops
//     counting as open exposure in the risk ledger. Nothing else does this for the manual lane.
//
// NAMED agent40: slots 36-39 are taken (book-velocity, maker-watchdog, tape-watchdog, net-rerun). This
// process CAN cause a placement,
// so it is deliberately the narrowest thing that can: it owns no adapter, no credentials and no signing
// key of its own. Its only reachable venue surface is lib/maker/manual-order.replaceManualOrder — the
// SAME function the panel's "Riprezza" button calls — so every gate that governs a hand order governs
// every automatic re-price, with no second code path that could drift from the first.
//
// WHAT IT WILL NOT DO, and these are structural, not stylistic:
//   • It does nothing at all unless BOTH the global master switch and the per-market opt-in are on
//     (data/maker-auto-reprice.json). Both default OFF and both fail closed to OFF.
//   • It touches ONLY orders it can PROVE the manual panel placed (attributed from the append-only audit
//     trail). agent35's orders and unattributable orders are never candidates.
//   • It refuses to act on a mid that is not from agent34's live book, or that is stale.
//   • It reads the GLOBAL KILL SWITCH before it cancels anything — a re-price is cancel-then-place, and
//     cancelling under a kill would strip a resting order the replacement could not restore.
//   • It has a per-order rate limit and a per-market hourly ceiling. An automatism without a runaway
//     guard is an incident waiting.
//   • It never sends anything MANUAL_ORDER_PLACEMENT would not send: with the panel's switch on dry-run
//     (the default), an automatic re-price builds, signs and validates the replacement — and drops it.
//
// EVERYTHING it does is stamped source:'auto-reprice-band-exit' in data/polymarket-maker-audit.jsonl —
// distinct from 'manual-ui' and from 'agent35', so the trail always says what moved what.
//
// IF THIS PROCESS DIES, THE ORDERS ARE STILL SAFE — that is the whole point of keeping a real GTD window
// rather than resting GTC: nothing renews, and the exchange retires them within it. What is lost is the
// re-pricing and the reconciliation, so it writes a heartbeat every cycle which the manual panel displays;
// a stale heartbeat next to an ON switch is the operator's signal to look.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// ── Load .env (pm2 does not auto-load project env files) — read-only, never printed, never committed ──
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* file absent → fine */ }
}

const { runAutoRepriceCycle } = require('../lib/maker/auto-reprice');
// ── IL MOTORE DI MARKET MAKING A DUE LATI ──────────────────────────────────────────────────────────
// Ospitato QUI, non in un processo suo. La ragione non e' la comodita': i due motori devono essere
// d'accordo su chi possiede quale mercato, e in un processo solo quell'accordo e' una lettura di lista
// in memoria invece di due processi che leggono lo stesso file e possono agire nella stessa finestra.
// In piu' questo processo e' gia' «la cosa piu' stretta che possa piazzare» — nessun adapter, nessuna
// credenziale, nessuna chiave, solo le funzioni del pannello manuale — quindi aggiungere qui non allarga
// la superficie: la riusa.
const { runTrackingCycle, TRACKING_POLL_MS, MID_STALE_PAUSE_SEC } = require('../lib/maker/mm-tracking');
const { readTrackingConfig, setTracking } = require('../lib/maker/mm-tracking-config');
const { marketWindowFor } = require('../lib/maker/market-clock');
const { loadAutoRepriceTuning, EXPECTED_RENEWALS_PER_HOUR, setAutoReprice } = require('../lib/maker/auto-reprice-config');
const { listManualOrders, replaceManualOrder, resolveMarketRules, resolveMarketDepth, cancelManualOrder } = require('../lib/maker/manual-order');
// THE STANDING RECONCILIATION FOR THE MANUAL LANE. Without it, every hand order that reaches its
// venue-side expiry leaves a permanent phantom at full notional in the risk ledger, and the cap gate
// slowly starts refusing orders that nothing real is backing (that is exactly how "open exposure $67.04"
// appeared next to an empty orders table). agent35 was never going to do this for us: its reconciliation
// is "dormant until arming" and it stands off manual markets by design.
const { reconcileManualLane, fetchVenuePositions } = require('../lib/maker/manual-reset');
const { decideRimpiazzo } = require('../lib/maker/rimpiazzo-gamba');
const { resolveOffsetFor } = require('../lib/maker/offset-config');
const { readAllocatedCapital } = require('../lib/maker/allocated-capital');
const { AUTO_CLOSE_SOURCE } = require('../lib/maker/auto-close-config');
const { writeVenuePositions } = require('../lib/safety/venue-positions-snapshot');
// AUTOMATIC POSITION CLOSING. Runs on the same throttle as the reconciliation and for the same reason:
// a fill is only observable after the venue is asked. Default OFF everywhere; see lib/maker/auto-close.js.
const { runAutoCloseCycle } = require('../lib/maker/auto-close');
const { readAutoCloseConfig } = require('../lib/maker/auto-close-config');
const { placeManualOrder } = require('../lib/maker/manual-order');
const { resolveFunder, venueAccountAddress } = require('../lib/venues/polymarket-clob-maker/funder');
const { isManualMarket } = require('../lib/maker/manual-mode');
const { appendMakerAudit } = require('../lib/venues/polymarket-clob-maker/audit');
const killSwitch = require('../lib/safety/kill-switch');
const { atomicWriteJson } = require('../lib/atomicJsonWrite');

const HEARTBEATS = '/tmp/agent-heartbeats.json';
// Lo stato vivo del tracking, per la dashboard. Un motore che piazza da solo deve poter rispondere
// «cosa stai facendo adesso» senza che si debbano leggere i log di un processo.
const TRACKING_STATE_FILE = '/tmp/maker-mm-tracking-state.json';
const log = (...a) => console.log(new Date().toISOString(), '[agent40-manual-reprice]', ...a);

// The breach counter lives HERE, in process memory, deliberately. "N consecutive observations" is a
// statement about an unbroken run of cycles, and a restart genuinely breaks that run — so a fresh process
// must start counting again rather than inheriting a claim it did not witness. The DURABLE state (last
// re-price, hourly counts) is what must survive a restart, and that lives in data/ instead.
const breaches = new Map();

// Lo stato per mercato del motore di tracking, portato fra un ciclo e l'altro. In memoria di proposito,
// come `breaches`: un riavvio lo azzera, ed e' corretto — gli ordini a riposo portano una scadenza GTD
// venue-enforced, quindi un processo che riparte senza memoria non lascia nulla di eterno dietro di se.
const trackingState = new Map();
// Le ultime azioni del motore, per la tabella in dashboard. Limitato: e' una finestra, non un archivio
// (l'archivio e' l'audit append-only).
const trackingLog = [];
const TRACKING_LOG_MAX = 200;

// The CONNECTION BLACKOUT clock, also in process memory and also on purpose. "We have been unable to
// reach the venue since T" is a claim about a continuous observation this process made; a restarted
// process has not made it, and must not inherit it. Note that a restart is itself the safe direction
// here — the orders it lost track of are carrying a venue-side expiry that retires them regardless.
const link = { downSince: null, consecutiveFailures: 0 };

// Reconciliation cadence. NOT every 5s cycle: it is not urgent (a phantom costs nothing until the next
// order is sized) and each run that finds work makes venue calls. 60s matches agent35's own
// RECONCILE_INTERVAL_MS. In the steady state it costs nothing at all — the function's first act is a
// two-file local check, and it returns without touching the network when there is nothing unresolved.
const RECONCILE_EVERY_MS = Number(process.env.MAKER_MANUAL_RECONCILE_MS || 60_000);
let lastReconcileAt = 0;

function heartbeat() {
  try {
    const hb = (() => { try { return JSON.parse(fs.readFileSync(HEARTBEATS, 'utf8')); } catch { return {}; } })();
    hb['agent40-manual-reprice'] = Date.now();
    atomicWriteJson(HEARTBEATS, hb);
  } catch { /* best-effort; the durable heartbeat in data/ is the one the panel reads */ }
}

// Summarise a cycle in one line, and ONLY when something is worth saying. A watcher that logs "nothing
// happened" every 5 seconds buries the one line that matters.
let lastQuietGate = null;
function logCycle(res) {
  if (!res.ran) {
    // A steady-state "off" is normal; say it once per change of reason, not 12 times a minute.
    if (res.gate !== lastQuietGate) { log(`idle: ${res.gate} — ${res.reason}`); lastQuietGate = res.gate; }
    return;
  }
  lastQuietGate = null;
  const acted = res.actions.filter((a) => a.action === 'reprice');
  const skips = res.actions.filter((a) => a.action === 'skip');
  const totals = res.markets.reduce((t, m) => ({ considered: t.considered + m.considered, held: t.held + m.held }), { considered: 0, held: 0 });
  for (const m of res.markets) {
    if (m.gate) log(`market cid_${String(m.marketId).replace(/^0x/, '')}: ${m.gate} — ${m.reason}`);
  }
  for (const a of acted) {
    log(`${a.trigger === 'expiry-refresh' ? 'REFRESH' : 'REPRICE'} ${a.ok ? 'ok' : 'FAILED'} · ${a.trigger} · order ${a.orderId}`
      + ` · ${a.book.toUpperCase()} ${a.fromPrice} → ${a.toPrice} (size ${a.size})`
      + `${a.secondsToExpiry != null ? ` · ${a.secondsToExpiry}s to expiry` : ''}`
      + `${a.sent ? ' · SENT to venue' : ' · not sent (dry-run)'}`
      + `${a.ok ? '' : ` · gate=${a.gate} ${a.reason || ''}`}`);
  }
  for (const a of res.actions.filter((x) => x.action === 'reconnect-cancel')) {
    log(`RECONNECT-CANCEL ${a.ok ? 'ok' : 'FAILED'} · order ${a.orderId}${a.reason ? ` · ${a.reason}` : ''}`);
  }
  // Skips that are not the routine "waiting for confirmation" deserve a line — they are the automatism
  // declining to act on something it saw.
  for (const s of skips) if (s.gate !== 'awaiting-confirmation') log(`skip · order ${s.orderId} · ${s.gate}: ${s.reason}`);
  if (acted.length === 0 && skips.length === 0 && totals.considered > 0) {
    // The steady state the whole feature exists to produce: orders resting, untouched, in band.
    log(`holding ${totals.held}/${totals.considered} order(s) in band — nothing touched`);
  }
}

// Deliberately NOT inside cycle(): the reprice cycle returns early on a kill, on a disabled switch and on
// a market handed back to the engine, and none of those should stop the ledger from being told the truth.
// This places nothing and cancels nothing — it reads the venue and writes resolutions to our own ledger —
// so a killed system is exactly when it is most worth running.
// ── RESTITUISCE SE HA GIRATO IN QUESTO GIRO ───────────────────────────────────────────────────────
// Serve a chi deve girare SUBITO DOPO. Prima quel «subito dopo» si deduceva da
// `Date.now() - lastReconcileAt < 1000`, cioè si INDOVINAVA guardando l'orologio: un proxy che regge
// solo finché la riconciliazione dura meno di un secondo. Misurato il 5 agosto 2026: quando ha
// davvero lavoro la sola prima chiamata al venue impiega 3948 ms. Restituire il fatto invece di
// dedurlo dal tempo toglie la dipendenza dalla latenza.
async function reconcileTask() {
  const now = Date.now();
  if (now - lastReconcileAt < RECONCILE_EVERY_MS) return false;
  lastReconcileAt = now;
  try {
    const r = await reconcileManualLane({ now });
    // Silent in the steady state. A watcher that logs "nothing to do" every minute buries the one line
    // that matters — and here that line is "we just retired a phantom from the risk ledger".
    if (r.ran && (r.nofills > 0 || r.fills > 0)) {
      log(`reconcile: ${r.fills} risolti come eseguiti, ${r.nofills} come NON eseguiti`
        + `${r.resolvedUsd ? ` (${r.resolvedUsd} $ di esposizione fantasma ritirata dal gate cap)` : ''}`
        + `${r.stillUnknown ? `, ${r.stillUnknown} ancora sconosciuti` : ''} — ${r.reason}`);
    } else if (r.ran && r.stillUnknown > 0) {
      log(`reconcile: ${r.stillUnknown} ordini inviati restano irrisolti — ${r.reason}`);
    } else if (!r.ran && r.checked > 0) {
      log(`reconcile: ${r.checked} ordini da risolvere ma non è stato possibile — ${r.reason}`);
    }
  } catch (e) {
    log('reconcile failed:', e && e.message ? e.message : String(e));
  }
  return true;
}

// The closer shares the reconciliation's throttle: both only learn anything by asking the venue, and a
// position cannot be covered before the fill that created it has been observed. Its own try/catch, so a
// failure here cannot stop the reconciliation or the reprice cycle.
// ── LO SNAPSHOT DELLE POSIZIONI NON DIPENDE PIÙ DALL'USCITA AUTOMATICA ─────────────────────────────
// Era scritto DENTRO `readPositions` della chiusura automatica, cioè dopo il `return` che salta tutto
// quando nessun mercato ha l'uscita accesa. Il guaio è che quello snapshot non serve solo alla
// chiusura: `lib/safety/risk-limits.js` lo legge per calcolare l'esposizione, e se ha più di 180
// secondi RIFIUTA OGNI PIAZZAMENTO con `venue-positions-unreadable`.
//
// Cioè: «nessun mercato ha l'uscita automatica» diventava silenziosamente «il sistema non piazza più
// niente», per una catena che non è ovvia in nessuno dei due file. Il 4 agosto 2026 reggeva solo
// perché tre mercati morti tenevano acceso l'auto-close: ripulendoli senza accorgersene, il conteggio
// sarebbe andato a zero e ogni ordine sarebbe stato rifiutato per un motivo che non c'entra niente.
//
// Adesso la lettura del venue è un compito suo, sullo stesso ritmo della riconciliazione (60s, ben
// sotto i 180 di scadenza) e SENZA condizioni. La chiusura automatica la riusa invece di rifarla: la
// cache brevissima qui sotto evita di chiedere due volte al venue nello stesso giro.
const POSIZIONI_FRESCHE_MS = 5_000;
let ultimePosizioni = { at: 0, res: null };

async function leggiPosizioniVenue() {
  const now = Date.now();
  if (ultimePosizioni.res && now - ultimePosizioni.at < POSIZIONI_FRESCHE_MS) return ultimePosizioni.res;
  const address = venueAccountAddress(resolveFunder(process.env), null);
  const p = await fetchVenuePositions({ address });
  // ── LE POSIZIONI VERE VANNO A CHI CALCOLA I TETTI ──────────────────────────────────────────────
  // Questa è la STESSA lettura che alimenta l'uscita automatica: una sola fonte di verità. Chiude il
  // buco del 4 agosto, quando il ledger locale diceva $0 mentre al venue c'erano 199,99 share e il
  // tetto di esposizione non le vedeva.
  try {
    const w = writeVenuePositions(p);
    if (!w.written) log('snapshot posizioni NON aggiornato:', w.reason);
  } catch (e) { log('snapshot posizioni fallito:', e && e.message ? e.message : String(e)); }
  ultimePosizioni = { at: now, res: p };
  return p;
}

// ── LO SNAPSHOT HA IL SUO OROLOGIO, E NON LO PRENDE IN PRESTITO DA NESSUNO ────────────────────────
// Il compito era già «autonomo» nel nome e nel commento, ma nel ciclo veniva chiamato dietro
// `if (Date.now() - lastReconcileAt < 1000)` — la condizione della riga sotto, copiata insieme alla
// riga. Il commento diceva «senza condizioni» e il codice ne aveva una.
//
// La condizione regge solo finché la riconciliazione dura meno di un secondo, e lei dura poco SOLO nel
// caso in cui non ha niente da fare: `reconcileManualLane` esce prima di toccare la rete quando non ci
// sono ordini irrisolti. Appena ce n'è uno — cioè appena si comincia a piazzare davvero — fa tre
// chiamate al venue in fila. Misurata il 5 agosto 2026: la prima da sola, 3948 ms.
//
// Quindi l'effetto non era «ogni tanto salta»: era che lo snapshot smetteva di essere scritto ESATTAMENTE
// quando si inizia a operare, e dopo 180 secondi il gate di esposizione rifiutava ogni piazzamento. Un
// guasto che non si può incontrare provando, solo usando.
//
// Ora la cadenza è sua: 60 secondi, un terzo della scadenza. E se una lettura fallisce si riprova dopo
// 15 invece di aspettarne altri 60 — dentro i 180 secondi di budget ci stanno una decina di tentativi
// invece di due. Fallire non è la stessa cosa che rinunciare.
const SNAPSHOT_EVERY_MS = 60_000;
const SNAPSHOT_RETRY_MS = 15_000;
let lastSnapshotAt = 0;
let ultimoSnapshotOk = false;

/** Il compito autonomo: aggiorna lo snapshot comunque, anche senza un solo mercato con uscita accesa. */
async function snapshotPosizioniTask() {
  const now = Date.now();
  if (now - lastSnapshotAt < (ultimoSnapshotOk ? SNAPSHOT_EVERY_MS : SNAPSHOT_RETRY_MS)) {
    return { girato: false };
  }
  lastSnapshotAt = now;
  const p = await leggiPosizioniVenue();
  const ok = !!(p && p.ok);
  // Un fallimento si dice UNA volta, non a ogni giro: un log che si ripete ogni minuto seppellisce la
  // riga che conta. Ma il passaggio da «va» a «non va» e viceversa si dice sempre.
  if (ok !== ultimoSnapshotOk) {
    log(ok ? 'snapshot posizioni: lettura del venue tornata a funzionare'
      : `snapshot posizioni: lettura del venue NON riuscita (${(p && p.reason) || 'motivo ignoto'}) — lo snapshot invecchia, e oltre 180s ogni piazzamento verrà rifiutato`);
  }
  ultimoSnapshotOk = ok;
  return { girato: true, ok };
}

async function closeTask() {
  try {
    const cfg = readAutoCloseConfig();
    if (!cfg.readable || !cfg.enabledMarketIds.length) return;   // OFF: silent — lo snapshot lo tiene vivo snapshotPosizioniTask
    const res = await runAutoCloseCycle({
      marketIds: cfg.enabledMarketIds,
      killStatus: () => killSwitch.killStatus(),
      isManual: (marketId) => isManualMarket(marketId),
      resolveRules: (marketId) => resolveMarketRules(marketId),
      listOrders: ({ marketId }) => listManualOrders({ marketId }),
      // La stessa lettura del compito dello snapshot, riusata: una fonte sola, e nessuna seconda
      // chiamata al venue nello stesso giro.
      readPositions: async () => {
        const p = await leggiPosizioniVenue();
        return { ok: p.ok, reason: p.reason, positions: (p.positions || []).map((x) => ({ tokenId: String(x.asset ?? x.tokenId ?? ''), size: Number(x.size), avgPrice: Number(x.avgPrice) })) };
      },
      placeOrder: (spec) => placeManualOrder(spec),
      // ── LA GAMBA ESEGUITA TORNA SUL LIBRO ────────────────────────────────────────────────────
      // Subito dopo che l'uscita e' stata piazzata. Senza questa iniezione la decisione esiste ma non
      // viene mai presa: `decideRimpiazzo` era scritto e testato e non lo chiamava nessuno, e la
      // guardia `typeof deps.rimpiazzaGamba === 'function'` in auto-close era sempre falsa.
      //
      // Tre cose che questa funzione risolve da se', perche' auto-close non le ha e non deve averle:
      //   · l'OFFSET, dal registro per mercato (lib/maker/offset-config) — lo stesso che usa il riprezzo;
      //   · il TETTO del mercato, dal piano di allocazione corrente (lib/maker/allocated-capital);
      //   · gli ORDINI GIA' A RIPOSO su quel mercato, che occupano spazio sotto il tetto insieme alla
      //     posizione e all'uscita appena messa.
      rimpiazzaGamba: async ({ marketId, book, posizioneUsd, uscitaUsd }) => {
        const rules = resolveMarketRules(marketId);
        const off = resolveOffsetFor({ marketId, book, tick: rules && rules.tick });
        const tetto = readAllocatedCapital(marketId);

        // Il nozionale gia' a riposo su questo mercato. L'uscita appena piazzata puo' non essere ancora
        // visibile al venue, quindi la si somma a parte: contarla due volte stringerebbe il tetto, non
        // contarla affatto lo allargherebbe — e fra i due errori si sceglie il primo.
        let ordiniUsd = Number(uscitaUsd) || 0;
        try {
          const listed = await listManualOrders({ marketId });
          if (listed && listed.ok !== false) {
            for (const o of listed.orders || []) {
              if (o && o.source === 'manual-ui' && Number.isFinite(o.notionalUsd)) ordiniUsd += o.notionalUsd;
            }
          }
        } catch { /* illeggibile: resta il solo nozionale dell'uscita, che e' il piu' prudente noto */ }

        const d = decideRimpiazzo({
          book, rules,
          offsetCents: off && off.targetOffsetCents,
          tettoMercatoUsd: tetto && tetto.readable ? tetto.capUsd : null,
          posizioneUsd: Number(posizioneUsd) || 0,
          ordiniApertiUsd: ordiniUsd,
          minSizeShares: rules && rules.minSize,
        });
        if (d.action !== 'rimpiazza') return d;

        // Si piazza dalla STESSA porta di tutto il resto, con la regola della coda accesa: e' una
        // quotazione maker come le altre, non un'uscita. La sorgente resta quella dell'uscita
        // automatica perche' MANUAL_SOURCES e' un'allowlist di sicurezza che non vale la pena
        // allargare per un'etichetta — la nota dice cosa e'.
        const res = await placeManualOrder({
          marketId, book, side: 'BUY', price: d.price, size: d.size,
          inCoda: true, source: AUTO_CLOSE_SOURCE,
          note: `rimpiazzo della gamba ${book.toUpperCase()} eseguita: torna a riposo a ${d.price} x ${d.size}`,
        });
        return { ...d, ok: res && res.ok === true, sent: res && res.sent === true, gate: (res && res.gate) || d.gate };
      },
      audit: (rec) => { try { appendMakerAudit(rec); } catch (e) { log('audit write failed:', e.message); } },
    });
    for (const m of res.markets) if (m.gate && m.gate !== 'disabled') log(`auto-close cid_${String(m.marketId).replace(/^0x/, '')}: ${m.gate} — ${m.reason}`);
    for (const a of res.actions) {
      if (a.action === 'close') log(`AUTO-CLOSE ${a.ok ? 'ok' : 'FALLITA'} · ${a.book.toUpperCase()} SELL ${a.size} @ ${a.price} su carico ${a.entryPrice} (+${a.profitCents}c/share)${a.sent ? ' · INVIATA' : ' · non inviata (dry-run)'}${a.ok ? '' : ` · gate=${a.gate} ${a.reason || ''}`}`);
      else if (a.action === 'rimpiazzo') log(`RIMPIAZZO ${a.ok ? 'ok' : 'FALLITO'} · ${a.book.toUpperCase()} BUY ${a.size} @ ${a.price} — ${a.reason}`);
      else if (a.action === 'rimpiazzo-saltato') log(`rimpiazzo saltato · ${a.gate}: ${a.reason}`);
      else if (a.action === 'skip') log(`auto-close skip · ${a.gate}: ${a.reason}`);
    }
  } catch (e) {
    log('close task failed:', e && e.message ? e.message : String(e));
  }
}

async function cycle() {
  const res = await runAutoRepriceCycle({
    killStatus: () => killSwitch.killStatus(),
    isManual: (marketId) => isManualMarket(marketId),
    listOrders: ({ marketId }) => listManualOrders({ marketId }),
    resolveRules: (marketId) => resolveMarketRules(marketId),
    replaceOrder: (spec) => replaceManualOrder(spec),
    // ── LA PROFONDITÀ, PER SAPERE SE SIAMO DIVENTATI I PRIMI ────────────────────────────────────
    // Senza questa riga il trigger «top-of-book» non potrebbe mai scattare: `decideReprice` lo salta
    // in silenzio quando `resolveDepth` non è una funzione. È la classe di difetto che
    // scripts/dipendenze-scollegate.js esiste per impedire — una decisione scritta e mai raggiunta.
    resolveDepth: (marketId) => resolveMarketDepth(marketId),
    // Used ONLY by the reconnect-after-blackout path AND by the top-of-book cancel. It goes through the
    // CANCEL-ONLY adapter (address-only signer, structurally cannot place), so both can stop orders and
    // neither can ever start one.
    cancelOrder: (spec) => cancelManualOrder(spec, 'auto-reprice-band-exit'),
    // TOGLIERE UN MERCATO CHIUSO DALLA ALLOWLIST. Gemella di `disableTracking` qui sotto, sulla stessa
    // condizione e per lo stesso motivo: il motore decide QUANDO (solo a mercato risolto e a libro gia'
    // libero), qui si passa la mano che scrive. Senza questa riga la decisione esisterebbe e non la
    // prenderebbe nessuno — la guardia `typeof deps.disableMarket === 'function'` sarebbe sempre falsa,
    // che e' il difetto trovato quattro volte in una settimana e che scripts/dipendenze-scollegate.js
    // ora impedisce di lasciar passare.
    disableMarket: ({ marketId, reason }) => setAutoReprice({
      scope: 'market', marketId, enabled: false, by: 'motore · mercato chiuso', reason,
    }),
    audit: (rec) => { try { appendMakerAudit(rec); } catch (e) { log('audit write failed:', e.message); } },
    config: loadAutoRepriceTuning(),
    breaches,
    link,
  });
  logCycle(res);
  return res;
}

// ── IL CICLO DEL TRACKING ──────────────────────────────────────────────────────────────────────────
// Try/catch suo, come la riconciliazione e la chiusura automatica: un motore che fallisce non deve poter
// fermare gli altri due, e viceversa.
async function trackingTask() {
  const res = await runTrackingCycle({
    readConfig: () => readTrackingConfig(),
    // SPEGNERE IL TRACKING SU UN MERCATO CHIUSO. Il motore decide QUANDO (solo a mercato risolto e a
    // libro gia' libero); qui si passa la mano che scrive. Iniettarla invece di importarla dentro il
    // modulo tiene il ciclo puro e testabile senza toccare la configurazione vera.
    disableTracking: ({ marketId, reason }) => setTracking({ marketId, enabled: false, by: 'motore · mercato chiuso', reason }),
    killStatus: () => killSwitch.killStatus(),
    isManual: (marketId) => isManualMarket(marketId),
    marketWindow: (marketId) => {
      try {
        const t = loadAutoRepriceTuning();
        return marketWindowFor({ marketId, baseTtlSeconds: t.restingGtdSeconds, baseRefreshMarginSeconds: t.refreshMarginSeconds });
      } catch { return null; }
    },
    resolveRules: (marketId) => resolveMarketRules(marketId),
    // I LIVELLI DEL BOOK, per il secondo trigger di riposizionamento (erosione della coda davanti
    // all'ordine). Stessa fonte del mid — lo snapshot di agent34 — letta con la funzione che vive
    // accanto a resolveMarketRules, non con un secondo lettore che potrebbe non essere d'accordo.
    readDepth: (marketId) => resolveMarketDepth(marketId),
    listOrders: ({ marketId }) => listManualOrders({ marketId }),
    // LO STESSO percorso di piazzamento del pannello a mano. Non una copia: la stessa funzione, quindi
    // ogni gate che governa un ordine a mano governa ogni ordine di questo motore.
    placeOrder: (spec) => placeManualOrder(spec),
    // Cancella tramite l'adapter CANCEL-ONLY (signer di solo indirizzo, strutturalmente incapace di
    // piazzare): la mossa che toglie un ordine non puo' mai, per costruzione, crearne uno.
    cancelOrder: (spec) => cancelManualOrder(spec, 'mm-tracking'),
    audit: (rec) => { try { appendMakerAudit(rec); } catch (e) { log('audit write failed:', e.message); } },
    tuning: (() => { const t = loadAutoRepriceTuning(); return { minIntervalMs: t.minIntervalMs, midStalePauseSec: MID_STALE_PAUSE_SEC, requireLiveBook: t.requireLiveBook, refreshMarginSeconds: t.refreshMarginSeconds }; })(),
    state: trackingState,
  });

  // ── I LOG: solo cio' che vale una riga ────────────────────────────────────────────────────────────
  for (const e of res.events || []) {
    if (e.type === 'fill') {
      log(`FILL RILEVATO · cid_${String(e.marketId).replace(/^0x/, '').slice(0, 10)} · lato ${e.side.toUpperCase()} · ${e.sizeMatched} share eseguite @ ${e.price}`
        + ' — quel lato NON viene piu ripiazzato finche non intervieni a mano; l altro continua.');
    } else if (e.type === 'erosion-armed' || e.type === 'erosion-recovered') {
      // Solo le TRANSIZIONI, non ogni lettura: il ciclo gira ogni 3s e una riga per lettura sarebbe
      // 1200 righe l'ora per lato senza dire mai niente di nuovo.
      log(`${e.type === 'erosion-armed' ? 'EROSIONE ARMATA' : 'erosione rientrata'} · cid_${String(e.marketId).replace(/^0x/, '').slice(0, 10)}`
        + ` · lato ${e.side.toUpperCase()} · profondita ${e.depth} share contro baseline ${e.baseline} (${e.ratioPct}%)`);
    }
  }
  for (const a of res.actions || []) {
    if (a.action === 'place') {
      log(`TRACKING ${a.ok ? 'ok' : 'FALLITO'} · ${a.trigger}${a.triggerKind ? ` [${a.triggerKind}]` : ''} · ${a.book.toUpperCase()} @ ${a.priceCents}c`
        + `${a.erosion && a.erosion.armed ? ` · EROSIONE ${a.erosion.ratioPct}% della baseline ${a.erosion.baseline}` : ''}`
        + ` · mid ${a.fromMid != null ? a.fromMid + 'c → ' : ''}${a.toMid}c`
        + `${a.movedCents != null ? ` (mosso ${a.movedCents}c)` : ''}`
        + ` · offset ${a.offsetCents}c · size ${a.size}`
        + `${a.inBand === false ? ' · FUORI BANDA (nessun reward su questo lato)' : ''}`
        + `${a.sent ? ' · INVIATO al venue' : ' · non inviato (dry-run)'}`
        + `${a.ok ? '' : ` · gate=${a.gate}${a.failStreak ? ` (${a.failStreak}° rifiuto consecutivo, riprovo fra ${Math.round((a.backoffMs || 0) / 1000)}s)` : ''} ${a.reason || ''}`}`);
    } else if (a.action === 'skip') {
      log(`tracking skip · ${a.book.toUpperCase()} · ${a.gate}: ${a.reason}`);
    }
  }
  for (const m of res.markets || []) {
    if (m.gate && m.gate !== 'below-threshold') log(`tracking cid_${String(m.marketId).replace(/^0x/, '').slice(0, 10)}: ${m.gate} — ${m.reason}`);
  }

  // ── LO STATO PER LA DASHBOARD ─────────────────────────────────────────────────────────────────────
  for (const a of (res.actions || []).filter((x) => x.action === 'place')) {
    trackingLog.unshift({ at: res.at, ...a });
  }
  for (const e of res.events || []) trackingLog.unshift({ at: res.at, action: 'event', ...e });
  if (trackingLog.length > TRACKING_LOG_MAX) trackingLog.length = TRACKING_LOG_MAX;

  try {
    atomicWriteJson(TRACKING_STATE_FILE, {
      at: res.at,
      ran: res.ran, gate: res.gate, reason: res.reason,
      placement: process.env.MANUAL_ORDER_PLACEMENT === 'send' ? 'send' : 'dry-run',
      markets: (res.markets || []).map((m) => ({
        marketId: m.marketId, gate: m.gate, reason: m.reason,
        offsetCents: m.offsetCents, minMoveCents: m.minMoveCents, sizeShares: m.sizeShares,
        referenceMid: m.referenceMid, movedCents: m.movedCents, repriceCount: m.repriceCount,
        mid: m.mid ?? null, midAgeSec: m.midAgeSec ?? null, midSource: m.midSource ?? null,
        midReadAt: m.midReadAt ?? null, paused: m.paused === true,
        plan: m.plan ? { yes: m.plan.yes, no: m.plan.no } : null,
        sides: m.sides || null,
        sideDecisions: m.sideDecisions || null,
        // ── IL BERSAGLIO VERO, PER LATO ────────────────────────────────────────────────────────────
        // `offsetCents` qui sopra e' quello CONFIGURATO nel registro, e da quando il motore si mette
        // «un tick dietro il migliore altrui» non descrive piu' dove sta l'ordine: e' solo il valore di
        // ripiego per quando siamo soli sul lato. Senza questi campi la dashboard mostrava un numero
        // statico al posto di una distanza che cambia a ogni ciclo — un dato falso, non incompleto.
        //
        // Si trasporta solo cio' che serve a dirlo a schermo: modo, se siamo in cima, il migliore
        // altrui, e la distanza REALE dal mid. Non l'oggetto intero, che porterebbe anche i bordi banda
        // e la scala dei livelli senza che nessuno li legga.
        target: m.target
          ? {
            yes: m.target.yes && m.target.yes.ok === true
              ? { mode: m.target.yes.mode, onTop: m.target.yes.onTop, alone: m.target.yes.alone,
                bestOther: m.target.yes.bestOther, offsetCents: m.target.yes.offsetCents, priceCents: m.target.yes.priceCents }
              : null,
            no: m.target.no && m.target.no.ok === true
              ? { mode: m.target.no.mode, onTop: m.target.no.onTop, alone: m.target.no.alone,
                bestOther: m.target.no.bestOther, offsetCents: m.target.no.offsetCents, priceCents: m.target.no.priceCents }
              : null,
          }
          : null,
        // Lo scopo dei comportamenti dinamici: quando e' valorizzato, questo mercato NON e' governato
        // da «mai in cima» ne' dall'erosione, e il pannello deve poter dire perche' invece di mostrare
        // celle vuote che sembrano un guasto.
        dynamicGate: m.erosionGate || null,
      })),
      recent: trackingLog.slice(0, 60),
    });
  } catch (e) { log('tracking state write failed:', e.message); }
  return res;
}

async function main() {
  const tuning = loadAutoRepriceTuning();
  log('starting — band-exit watcher for HAND-PLACED orders only.');
  log(`poll ${tuning.pollMs}ms · confirm ${tuning.confirmSamples} samples · hysteresis ${tuning.hysteresisTicks} tick`
    + ` · min interval ${Math.round(tuning.minIntervalMs / 1000)}s/order · ceiling ${tuning.maxPerHour}/hour/market`
    + ` · mid must be live-book${tuning.requireLiveBook ? '' : ' (RELAXED)'} and ≤ ${tuning.maxMidAgeSec}s old · strategy ${tuning.strategy}`);
  log(`venue-side expiry ${Math.round(tuning.restingGtdSeconds / 60)} min (GTD), proactive renewal with ${Math.round(tuning.refreshMarginSeconds / 60)} min left`
    + ` → one renewal every ${Math.round((tuning.restingGtdSeconds - tuning.refreshMarginSeconds) / 60)} min = ${EXPECTED_RENEWALS_PER_HOUR.toFixed(1)}/hour in quiet conditions.`);
  log(`DEAD-MAN'S SWITCH: if this process stops, nothing renews and the EXCHANGE retires every managed order`
    + ` within ${Math.round(tuning.restingGtdSeconds / 60)} minutes. That protection is the venue's, not ours — no second supervisor is required.`);
  log(`connection blackout: if the venue is unreachable for more than ${tuning.disconnectCancelSeconds}s, the hand orders on managed markets are CANCELLED on reconnect rather than renewed on top of an unobserved state.`);
  log('placement switch: MANUAL_ORDER_PLACEMENT=' + (process.env.MANUAL_ORDER_PLACEMENT === 'send' ? 'send (an automatic re-price REACHES the venue)' : 'dry-run (nothing reaches POST /order)'));
  log(`manual-lane reconciliation: every ${Math.round(RECONCILE_EVERY_MS / 1000)}s, and ONLY when something is unresolved`
    + ' — resolves expired/cancelled hand orders against venue truth so they stop counting as open exposure.'
    + ' It places nothing and cancels nothing, and is deliberately NOT gated on the kill switch.');
  log('this process owns no adapter, no credentials and no signing key: it can only call the same manual replace path the panel button calls.');
  const tr = readTrackingConfig();
  log(`market making a due lati: ${tr.readable ? `${tr.marketIds.length} mercato/i con tracking attivo` : `configurazione ILLEGGIBILE (${tr.error}) — nessun mercato tracciato (fail closed)`}.`
    + ' Su quei mercati il watcher reattivo sta alla larga: un mercato ha UN SOLO motore di reprice.');
  if (tr.readable) for (const id of tr.marketIds) {
    const m = tr.markets[id];
    log(`  cid_${id.replace(/^0x/, '').slice(0, 10)} · offset ${m.offsetCents}c · soglia ${m.minMoveCents}c · size ${m.sizeShares}`);
  }

  // Never let one bad cycle kill the watcher — but never let a failure be silent either.
  const run = async () => {
    try { await cycle(); }
    catch (e) { log('cycle failed:', e && e.message ? e.message : String(e)); }
    // The reconciliation runs on its OWN throttle and its OWN try/catch: a reprice cycle that fails must
    // not stop the ledger being reconciled, and vice versa.
    // `riconciliato` è un FATTO restituito dalla riconciliazione, non un'ipotesi dedotta dall'orologio.
    let riconciliato = false;
    try { riconciliato = await reconcileTask(); }
    catch (e) { log('reconcile task failed:', e && e.message ? e.message : String(e)); }
    // Lo snapshot delle posizioni SENZA CONDIZIONI, come dice da sempre il commento qui accanto: chi
    // calcola i tetti di esposizione lo legge, e se scade oltre 180s ogni piazzamento viene rifiutato.
    // Ha il suo throttle (60s), quindi chiamarlo a ogni giro non moltiplica le chiamate al venue.
    try { await snapshotPosizioniTask(); }
    catch (e) { log('snapshot posizioni task failed:', e && e.message ? e.message : String(e)); }
    // La chiusura automatica gira DOPO una riconciliazione, e questo resta: una posizione non si copre
    // prima di aver osservato il fill che l'ha creata. Ma «dopo una riconciliazione» ora si chiede a
    // lei, invece di dedurlo dal tempo trascorso — che è ciò che la faceva saltare proprio nei giri in
    // cui la riconciliazione aveva davvero lavoro da fare, cioè quando serviva di più.
    try { if (riconciliato) await closeTask(); }
    catch (e) { log('close task failed:', e && e.message ? e.message : String(e)); }

    finally { heartbeat(); }
  };
  await run();
  setInterval(run, tuning.pollMs);

  // ── IL MOTORE DI MARKET MAKING HA IL SUO OROLOGIO ────────────────────────────────────────────────
  // 3 secondi, non i 5 del watcher reattivo. Sono due compiti diversi: quello reattivo interviene solo
  // quando un ordine rischia di uscire dalla banda e puo' permettersi di guardare piu' di rado; questo
  // insegue il mid, e la soglia di movimento ha senso solo se il mid viene guardato spesso abbastanza
  // da coglierne il movimento. Intervallo separato anche perche' un ciclo lento dell'uno non deve poter
  // rallentare l'altro.
  let trackingRunning = false;
  const runTracking = async () => {
    // Niente sovrapposizioni: se un giro dura piu' di 3 secondi il successivo salta invece di
    // accavallarsi, altrimenti due cicli potrebbero cancellare e ripiazzare lo stesso ordine.
    if (trackingRunning) return;
    trackingRunning = true;
    try { await trackingTask(); }
    catch (e) { log('tracking task failed:', e && e.message ? e.message : String(e)); }
    finally { trackingRunning = false; }
  };
  await runTracking();

  // ── PUSH DAL FEED, NON POLLING ─────────────────────────────────────────────────────────────────
  // agent34 e' un processo separato: il websocket del venue arriva LI', non qui. Il canale fra i due e'
  // lo snapshot che agent34 scrive; fs.watch su quel file sveglia il motore nell'istante in cui lo
  // snapshot cambia, invece di scoprirlo al prossimo giro di un intervallo fisso.
  //
  // ONESTA' SU COSA QUESTO COMPRA E COSA NO. Toglie il disallineamento del MOTORE (fino a un intervallo
  // intero di ritardo fra «il prezzo e' cambiato» e «il motore lo sa»). NON scende sotto la cadenza con
  // cui agent34 scrive lo snapshot: quello e' il pavimento vero, e per abbassarlo bisognerebbe toccare
  // WRITE_INTERVAL_MS in agent34 — una decisione separata, con un costo suo.
  //
  // L'intervallo resta come BATTITO DI SICUREZZA: se il file smettesse di cambiare (feed fermo), il
  // ciclo deve girare lo stesso per accorgersene e mettere in pausa i mercati.
  let pushTimer = null;
  try {
    // SI GUARDA LA DIRECTORY, NON IL FILE. agent34 scrive in modo atomico (tmp + rename), quindi
    // l'inode del file cambia a ogni scrittura e un watch sul percorso del file smette di ricevere
    // eventi dopo la PRIMA sostituzione. Misurato: 1 risveglio su 10. Guardando la cartella e
    // filtrando per nome, ogni rename viene visto.
    fs.watch('/tmp', (ev, name) => {
      if (name !== 'clob-live-books.json') return;
      // Debounce corto: una scrittura atomica produce piu' eventi (rename + change) e senza questo il
      // ciclo partirebbe due o tre volte per lo stesso snapshot.
      if (pushTimer) return;
      pushTimer = setTimeout(() => { pushTimer = null; runTracking(); }, 120);
    });
    log('market making: agganciato al feed in PUSH (fs.watch sullo snapshot di agent34) — il ciclo parte quando il prezzo cambia, non a orologio.');
  } catch (e) {
    log('market making: fs.watch non disponibile (' + e.message + ') — resta il solo battito periodico.');
  }
  setInterval(runTracking, TRACKING_POLL_MS);
  log(`market making: battito di sicurezza ogni ${TRACKING_POLL_MS / 1000}s, cosi un feed fermo viene comunque notato.`);
  log(`market making: ciclo ogni ${TRACKING_POLL_MS / 1000}s · mid piu vecchio di ${MID_STALE_PAUSE_SEC}s ⇒ quel mercato va IN PAUSA (e riprende da solo).`);
}

if (require.main === module) {
  main().catch((e) => { log('fatal:', e && e.stack ? e.stack : String(e)); process.exit(1); });
}

module.exports = { cycle, reconcileTask, closeTask, snapshotPosizioniTask, trackingTask, breaches, trackingState };

'use strict';
// lib/maker/auto-reprice-config.js — the ON/OFF control for AUTOMATIC BAND-EXIT RE-PRICING, plus the
// watcher's own runtime state. Durable, audited, per-market AND global.
//
// WHAT THIS SWITCHES. With it OFF (the default, everywhere) a hand order behaves exactly as it always
// has: a fixed GTD expiry (~180s) kills it on a clock regardless of price. With it ON for a market, the
// order instead carries the RESTING_GTD_SECONDS window declared below, and agent40-manual-reprice becomes
// the thing that decides when it moves: it RENEWS the window proactively before it can lapse, and
// re-prices EARLY when the mid has travelled far enough to push the order out of the reward band. So time
// never kills a healthy order — but the window is real, and it is what retires the order if this host
// stops.
//
// WHY IT IS TWO SWITCHES, NOT ONE. `global` is a master kill for the whole automatism (one flip stops
// every market at once, without having to remember which markets were opted in). `markets[id]` is the
// per-market opt-in. BOTH must be true for the watcher to touch anything — an automatism that could be
// switched on for a market while the master is off would be exactly the invisible behaviour this file
// exists to prevent.
//
// DEFAULT OFF, AND FAIL CLOSED. An absent file means "nothing is automatic" (the normal state of a fresh
// install). An UNREADABLE file also means "nothing is automatic" — for an automatism, fail-closed is the
// direction that does nothing, which is the opposite of the manual-mode flag's fail-closed (there,
// refusing to place is the safe direction; here, refusing to ACT is). A control we cannot read never
// grants authority to move a real order.
//
// SHAPE, and why a file under data/ rather than an env var — identical reasoning to lib/maker/manual-mode:
//   • DURABLE — a pm2 restart must not silently re-arm (or silently disarm) an automatism while orders
//     it is supposed to be renewing are resting.
//   • READ LIVE at the decision point — the watcher re-reads it every cycle, so a flip binds in seconds
//     without a restart. A control that needs a deploy is not a control.
//   • AUDITED — every flip appends a who/when/why line to data/maker-auto-reprice-audit.jsonl.
//
// TWO FILES, TWO OWNERS. The CONFIG (this file's `markets`/`global`) is the OPERATOR's, written only by
// the panel. The STATE (last automatic re-price, counts, heartbeat) is the WATCHER's, written only by
// agent40. Keeping them apart means the watcher can never accidentally rewrite a switch the operator set,
// and a corrupt state file can never be mistaken for a config that turns something on.

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');

const CONFIG_FILE = path.join(DATA_DIR, 'maker-auto-reprice.json');
const STATE_FILE = path.join(DATA_DIR, 'maker-auto-reprice-state.json');
const AUDIT_FILE = path.join(DATA_DIR, 'maker-auto-reprice-audit.jsonl');

const EMPTY_CONFIG = Object.freeze({ global: { enabled: false }, markets: {} });
const EMPTY_STATE = Object.freeze({ markets: {}, heartbeatAt: null, cycles: 0 });

// The audit `source` this automatism stamps on everything it does. DELIBERATELY distinct from both
// 'manual-ui' (a human pressed a button) and 'agent35' (the automatic engine), so the one append-only
// trail always answers "what moved this order" without inference.
const AUTO_REPRICE_SOURCE = 'auto-reprice-band-exit';

// ── THE DEAD-MAN'S SWITCH, AND IT IS THE VENUE'S, NOT OURS ──────────────────────────────────────────
//
// A resting order on the Polymarket CLOB survives a PM2 crash, a VPS reboot and a network partition. A
// dead process does NOT cancel its orders. So the ONLY protection that survives this host dying is the
// signed GTD expiration the exchange itself enforces. Every watcher, heartbeat and alarm in this repo
// runs on the same box as the thing it watches; this constant does not.
//
// THE TWO PRESSURES, AND HOW THIS NUMBER SPLITS THEM:
//   • KEEP THE ORDER IN THE BOOK. Every renewal is a cancel→replace with a real out-of-book window, so
//     renewing often is churn, venue load, and a small chance each time of "old cancelled, new refused".
//   • LET IT DIE BY ITSELF. If this process stops, nothing renews, and the order must expire on its own
//     within a contained time — minutes, not hours, and with no second external supervisor required.
//
// WHAT THE SNAPSHOT CADENCE SETTLED. The venue scores maker liquidity from ONE RANDOM SAMPLE PER MINUTE
// — 1,440 samples a day, 10,080 in a weekly epoch (docs.polymarket.com/market-makers/liquidity-rewards:
// "Q_ne is calculated every minute using random sampling"; the per-second reading is wrong). That
// measurement settles one half of the design: a ~3-second gap between cancel and replace costs 0.05 of
// one sample out of 1,440 — about 0.003% of a day's reward. Coverage is therefore NOT the thing to
// optimise, and the instinct to keep the window long "so the order is never out of the book" was
// protecting against a cost that barely exists. Freed of that, the window is chosen almost entirely on
// the OTHER pressure: how long an unattended order may legally rest.
//
// THE ARITHMETIC OF THE RENEWAL RATE — renewals/hour = 3600 / (window − margin). Every combination that
// hits a given rate is a straight trade of unattended exposure against retry room:
//     window 15m, margin 3m → every 12m → 5.0/h   (the previous setting)
//     window 21m, margin 1m → every 20m → 3.0/h   (12 polls of retry room — thin)
//     window 22m, margin 2m → every 20m → 3.0/h   (24 polls)
//     window 23m, margin 3m → every 20m → 3.0/h   ← CHOSEN (36 polls)
//     window 25m, margin 5m → every 20m → 3.0/h   (60 polls, but 2 more minutes of exposure)
//
// WHY 23/3 AMONG THOSE. The rate target (3/hour, set deliberately to cut churn) fixes the CYCLE at 20
// minutes; what is left to choose is how that 20 minutes is split between window and margin. Three
// reasons for this split:
//   1. It MINIMISES EXPOSURE. Among the combinations with a margin already proven adequate, 23 minutes
//      is the shortest window. Exposure is the risk; the margin is only room to retry.
//   2. THE 3-MINUTE MARGIN IS PROVEN, not assumed — it is what ran in production at the earlier 15-minute
//      window. 36 consecutive polls at the 5s cadence to complete a ~2-second cancel→replace, and a
//      failed attempt simply retries on the next poll.
//   3. IT MOVES NOTHING ELSE. DISCONNECT_CANCEL_SECONDS below is DEFINED as the refresh margin, so
//      changing the margin would silently shift the network-blackout threshold too. Holding the margin
//      at 180s keeps a change that is only about the renewal rate from quietly altering blackout
//      behaviour as a side effect.
//
// THE PRICE, STATED PLAINLY. Going from a 15- to a 23-minute window buys the lower churn with EIGHT MORE
// MINUTES of unattended exposure. If this host dies, a managed order now rests for up to 23 minutes
// before the exchange retires it (the minimum is still the margin, 3 minutes — death just before a
// renewal; the worst case is death just after one, when the order carries a full window). That is the
// whole trade, and it is the operator's to make: fewer cancel→replace cycles, a longer tail if the
// machine stops. Nothing else about the design changes.
const RESTING_GTD_SECONDS = 1380;       // 23 minutes of EFFECTIVE life (see order-ttl: stated = now+60+ttl)
const REFRESH_MARGIN_SECONDS = 180;     // renew proactively once this little life remains (unchanged)
// Expected renewals per hour in quiet conditions, derived from the two constants above rather than
// asserted — so it can never drift out of date if either is changed.
const EXPECTED_RENEWALS_PER_HOUR = 3600 / (RESTING_GTD_SECONDS - REFRESH_MARGIN_SECONDS);

// ── THE CONNECTION BLACKOUT THRESHOLD ───────────────────────────────────────────────────────────────
// The process being ALIVE is not the same as the process being able to REACH the venue. A watcher that
// is up but blind cannot renew anything, and it also cannot see what is resting. While blind, the GTD
// window is doing its job (orders age out). The danger is the RECOVERY: if we were blind for longer than
// the refresh margin, we can no longer claim to know which of our orders survived, which expired, and
// which were filled meanwhile. So on reconnection after a blackout longer than this, the watcher cancels
// the panel's own orders on the markets it manages and lets the operator re-place deliberately.
// Set to the refresh margin: past that point a renewal we believed we made cannot be assumed to exist.
const DISCONNECT_CANCEL_SECONDS = REFRESH_MARGIN_SECONDS;

// ── THE WATCHER'S TUNING, all overridable by env, all defaulting conservative ────────────────────────
// These are the rails on the automatism itself, not on the order: how sure it must be that the band was
// really breached, how often it may act, and how stale a mid it will refuse to act on.
const DEFAULTS = Object.freeze({
  // How often the watcher looks. agent34 republishes the live books every 3s, so looking faster than
  // that only re-reads the same snapshot; 5s is "coherent with the venue sampling cadence".
  pollMs: 5_000,
  // A breach must be seen this many CONSECUTIVE cycles before acting. One noisy sample is not a signal.
  confirmSamples: 2,
  // Extra distance beyond the band edge, in TICKS, before a breach counts. Stops an order sitting exactly
  // on the boundary from flapping in and out on rounding alone.
  hysteresisTicks: 1,
  // Rate limit per ORDER: never re-price the same leg twice inside this window.
  minIntervalMs: 30_000,
  // Runaway guard per MARKET: at most this many automatic re-prices per rolling hour.
  maxPerHour: 20,
  // The mid must be THIS fresh, and must come from agent34's live book — never from the slower board
  // row. Re-pricing against a stale mid is how an automatism walks an order somewhere nobody asked for.
  maxMidAgeSec: 30,
  // ── I DUE REGIMI DEL GUARD MID-STALE ──────────────────────────────────────────────────────────
  // `maxMidAgeSec` sopra misurava una cosa sola — «da quanto il venue non parla di QUESTO asset» — e
  // la trattava come sinonimo di «il nostro dato non e' affidabile». Non lo e': misurato il 5 agosto
  // 2026, al picco di 35s di eta' il book memorizzato per TX-15 coincideva ESATTAMENTE con la
  // lettura REST. Il libro era fermo, non stavamo perdendo niente. Sulla flotta (105 mercati) la
  // mediana e' 4s e il p90 e' 30s: il vecchio limite stava sul novantesimo percentile, quindi per
  // costruzione ~10% dei mercati risultava «stale» in ogni istante senza che nulla fosse rotto.
  //
  // Adesso il limite dipende dal REGIME, cioe' da cosa sta facendo il socket nel suo insieme:
  //   feed vivo  → il silenzio su un asset e' genuino, il mid regge fino a maxMidAgeSecLive
  //   feed muto  → non sappiamo se il libro e' fermo o se siamo ciechi: maxMidAgeSecBlind, severo
  //   incerto    → severo, sempre. Meglio saltare un reprice che muoverne uno contro un prezzo
  //                vecchio; e' la decisione dell'operatore del 5 agosto 2026, non un ripiego.
  maxMidAgeSecLive: 60,
  maxMidAgeSecBlind: 10,
  // COSA CONTA COME «FEED VIVO». Eventi su almeno questo numero di asset DISTINTI nella finestra.
  // In condizioni normali la flotta ne rinnova ~190 in 30s (p90=30s su ~210 asset sottoscritti):
  // 5 e' circa il 2.6% di quel livello — abbastanza sotto il pavimento della variazione normale da
  // rendere implausibile un falso «muto», e abbastanza sopra 0/1 da distinguere un socket morente.
  // La finestra combacia con quella che agent34 usa per pubblicare il conteggio.
  feedAliveWindowSec: 30,
  feedAliveMinAssets: 5,
  requireLiveBook: true,
  // WHERE the re-priced order lands. Both keep it inside the band; they differ in intent:
  //   'band-edge'   (default) — the nearest qualifying price to where the order ALREADY was, i.e. the
  //                 band edge on the same side of the mid. Minimum movement, preserves the operator's
  //                 original above/below-mid stance, and stays as far from the mid (and from being
  //                 filled) as the band allows.
  //   'nearest-mid' — the qualifying price closest to the mid. Scores the most reward (the published
  //                 quadratic rewards proximity to the mid) and carries the most fill risk.
  strategy: 'band-edge',
});

const STRATEGIES = Object.freeze(['band-edge', 'nearest-mid']);

function envNum(v, dflt) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : dflt; }

/** Resolve the watcher's tuning from an env bag. Every field falls back to the conservative default. */
function loadAutoRepriceTuning(env = process.env) {
  const rawStrategy = typeof env.MAKER_AUTO_REPRICE_STRATEGY === 'string' ? env.MAKER_AUTO_REPRICE_STRATEGY.trim() : '';
  return {
    pollMs: envNum(env.MAKER_AUTO_REPRICE_POLL_MS, DEFAULTS.pollMs),
    confirmSamples: envNum(env.MAKER_AUTO_REPRICE_CONFIRM_SAMPLES, DEFAULTS.confirmSamples),
    hysteresisTicks: envNum(env.MAKER_AUTO_REPRICE_HYSTERESIS_TICKS, DEFAULTS.hysteresisTicks),
    minIntervalMs: envNum(env.MAKER_AUTO_REPRICE_MIN_INTERVAL_MS, DEFAULTS.minIntervalMs),
    maxPerHour: envNum(env.MAKER_AUTO_REPRICE_MAX_PER_HOUR, DEFAULTS.maxPerHour),
    maxMidAgeSec: envNum(env.MAKER_AUTO_REPRICE_MAX_MID_AGE_SEC, DEFAULTS.maxMidAgeSec),
    maxMidAgeSecLive: envNum(env.MAKER_AUTO_REPRICE_MAX_MID_AGE_SEC_LIVE, DEFAULTS.maxMidAgeSecLive),
    maxMidAgeSecBlind: envNum(env.MAKER_AUTO_REPRICE_MAX_MID_AGE_SEC_BLIND, DEFAULTS.maxMidAgeSecBlind),
    feedAliveWindowSec: envNum(env.MAKER_AUTO_REPRICE_FEED_ALIVE_WINDOW_SEC, DEFAULTS.feedAliveWindowSec),
    feedAliveMinAssets: envNum(env.MAKER_AUTO_REPRICE_FEED_ALIVE_MIN_ASSETS, DEFAULTS.feedAliveMinAssets),
    // Only the exact string 'false' relaxes the live-book requirement, and it is a deliberate, visible act.
    requireLiveBook: env.MAKER_AUTO_REPRICE_REQUIRE_LIVE_BOOK !== 'false',
    strategy: STRATEGIES.includes(rawStrategy) ? rawStrategy : DEFAULTS.strategy,
    // ── The proactive-renewal window. These two travel together with the placement path's own copy
    //    (lib/maker/manual-order.resolveManualTtlSeconds reads the SAME constants), so the lifetime an
    //    order is given and the moment it is renewed can never drift apart.
    restingGtdSeconds: envNum(env.MAKER_AUTO_REPRICE_GTD_SECONDS, RESTING_GTD_SECONDS),
    refreshMarginSeconds: envNum(env.MAKER_AUTO_REPRICE_REFRESH_MARGIN_SECONDS, REFRESH_MARGIN_SECONDS),
    disconnectCancelSeconds: envNum(env.MAKER_AUTO_REPRICE_DISCONNECT_CANCEL_SECONDS, DISCONNECT_CANCEL_SECONDS),
  };
}

function cfgDeps(deps) {
  return {
    configFile: deps.configFile || CONFIG_FILE,
    stateFile: deps.autoStateFile || STATE_FILE,
    auditFile: deps.autoAuditFile || AUDIT_FILE,
    now: deps.now || (() => Date.now()),
    fs: deps.fs || require('fs'),
  };
}

function normId(marketId) { return typeof marketId === 'string' ? marketId.trim().toLowerCase() : ''; }

/**
 * Read the whole switch map. Never throws.
 * @returns {{readable:boolean, error:(string|null), globalEnabled:boolean, markets:object,
 *            enabledMarketIds:string[], configFile:string, record:(object|null)}}
 */
function readAutoRepriceConfig(deps = {}) {
  const c = cfgDeps(deps);
  const r = readStore(c.configFile, EMPTY_CONFIG, deps);
  if (!r.ok) {
    // Unreadable ⇒ the automatism is OFF. For a thing that MOVES ORDERS BY ITSELF, "we could not read
    // the switch" must mean "do nothing", never "carry on".
    return { readable: false, error: r.error, globalEnabled: false, markets: {}, enabledMarketIds: [], configFile: c.configFile, record: null };
  }
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY_CONFIG;
  const g = (st.global && typeof st.global === 'object') ? st.global : {};
  const markets = (st.markets && typeof st.markets === 'object') ? st.markets : {};
  const globalEnabled = g.enabled === true;
  return {
    readable: true, error: null,
    globalEnabled,
    globalRecord: g.enabled === undefined ? null : g,
    markets,
    // Markets opted in AND covered by the master switch. When the master is off this is empty, which is
    // the honest answer to "what will the watcher touch right now".
    enabledMarketIds: globalEnabled ? Object.keys(markets).filter((k) => markets[k] && markets[k].enabled === true) : [],
    // What the operator has opted in, independent of the master — the panel shows both.
    optedInMarketIds: Object.keys(markets).filter((k) => markets[k] && markets[k].enabled === true),
    configFile: c.configFile,
  };
}

/**
 * THE DECISION POINT. May the watcher touch orders on THIS market right now?
 * Enabled ⇔ the state is readable AND the master switch is on AND this market is opted in.
 * @returns {{enabled:boolean, readable:boolean, globalEnabled:boolean, marketEnabled:boolean,
 *            error:(string|null), record:(object|null), reason:string}}
 */
function isAutoRepriceEnabled(marketId, deps = {}) {
  const st = readAutoRepriceConfig(deps);
  if (!st.readable) {
    return {
      enabled: false, readable: false, globalEnabled: false, marketEnabled: false, error: st.error, record: null,
      reason: `auto-reprice config ${st.error} — failing CLOSED (the automatism does NOTHING; a switch we cannot read never authorises moving a real order)`,
    };
  }
  const id = normId(marketId);
  if (!id) return { enabled: false, readable: true, globalEnabled: st.globalEnabled, marketEnabled: false, error: null, record: null, reason: 'no marketId supplied' };
  const rec = st.markets[id] || null;
  const marketEnabled = !!(rec && rec.enabled === true);
  const enabled = st.globalEnabled && marketEnabled;
  return {
    enabled, readable: true, globalEnabled: st.globalEnabled, marketEnabled, error: null, record: rec,
    reason: enabled
      ? `auto-reprice is ACTIVE on ${id}${rec.reason ? ` — ${rec.reason}` : ''}`
      : !st.globalEnabled
        ? `auto-reprice is off globally (master switch) — ${marketEnabled ? 'this market is opted in but the master switch overrides it' : 'and this market is not opted in either'}`
        : `auto-reprice is not enabled on ${id} — hand orders here keep the fixed ${180}s GTD expiry`,
  };
}

function appendAudit(rec, c) {
  try {
    c.fs.mkdirSync(path.dirname(c.auditFile), { recursive: true });
    c.fs.appendFileSync(c.auditFile, JSON.stringify(rec) + '\n');
  } catch (_e) { /* best-effort: an audit-write failure must never stop a switch from being flipped */ }
}

/**
 * Flip a switch. scope:'global' is the master; scope:'market' needs a marketId. Audited.
 *
 * Read-modify-write on a FRESH object (readStore may return the frozen EMPTY singleton). An unreadable
 * config REFUSES an ENABLE (we will not turn an automatism on over a state we cannot read) but PERMITS a
 * DISABLE — turning it off is the direction that can only reduce activity, and must always be available.
 *
 * @returns {{ok:boolean, error?:string, scope:string, marketId:(string|null), enabled:boolean, record?:object}}
 */
function setAutoReprice({ scope = 'market', marketId = null, enabled, by = null, reason = null }, deps = {}) {
  const c = cfgDeps(deps);
  if (scope !== 'global' && scope !== 'market') return { ok: false, error: "scope must be 'global' or 'market'", scope, marketId, enabled: false };
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean', scope, marketId, enabled: false };
  const id = scope === 'market' ? normId(marketId) : null;
  if (scope === 'market' && !id) return { ok: false, error: 'marketId required for scope:market', scope, marketId, enabled: false };

  const r = readStore(c.configFile, EMPTY_CONFIG, deps);
  if (!r.ok && enabled === true) {
    return {
      ok: false, scope, marketId: id, enabled: false,
      error: `auto-reprice config ${r.error} — refusing to ENABLE the automatism over a state we cannot read (fix the file first; DISABLING is still permitted)`,
    };
  }
  const base = (r.ok && r.value) ? r.value : {};
  const st = {
    global: (base.global && typeof base.global === 'object') ? { ...base.global } : { enabled: false },
    markets: { ...((base.markets && typeof base.markets === 'object') ? base.markets : {}) },
  };
  const at = c.now();
  const record = { enabled, at, atIso: new Date(at).toISOString(), by, reason };
  if (scope === 'global') st.global = record; else st.markets[id] = record;
  st.updatedAt = at;
  writeStoreAtomic(c.configFile, st, deps);
  appendAudit({ ts: at, event: enabled ? 'auto-reprice-on' : 'auto-reprice-off', scope, marketId: id, by, reason }, c);
  return { ok: true, scope, marketId: id, enabled, record };
}

// ── THE WATCHER'S OWN STATE (written ONLY by agent40, read by the panel) ─────────────────────────────
// It carries no authority: nothing here can enable anything. It answers "when did this last move, and is
// the thing that is supposed to be minding my GTC orders actually alive?"

/**
 * Read the watcher's runtime state. Unreadable ⇒ an EMPTY state flagged readable:false — the panel then
 * shows "unknown", which is a different fact from "never re-priced".
 */
function readAutoRepriceState(deps = {}) {
  const c = cfgDeps(deps);
  const r = readStore(c.stateFile, EMPTY_STATE, deps);
  if (!r.ok) return { readable: false, error: r.error, markets: {}, heartbeatAt: null, heartbeatAgeSec: null, cycles: 0, stateFile: c.stateFile };
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY_STATE;
  const heartbeatAt = Number.isFinite(st.heartbeatAt) ? st.heartbeatAt : null;
  return {
    readable: true, error: null,
    markets: (st.markets && typeof st.markets === 'object') ? st.markets : {},
    heartbeatAt,
    heartbeatAgeSec: heartbeatAt != null ? Math.max(0, Math.round((c.now() - heartbeatAt) / 1000)) : null,
    cycles: Number.isFinite(st.cycles) ? st.cycles : 0,
    lastCycleAt: Number.isFinite(st.lastCycleAt) ? st.lastCycleAt : null,
    stateFile: c.stateFile,
  };
}

/**
 * The watcher's heartbeat + per-market record of the last automatic re-price. Best-effort: a failed
 * state write must never stop the watcher, and must never be read as "it did not happen" — the
 * append-only maker audit trail is the real record of what moved.
 */
function recordAutoRepriceState({ marketId = null, reprice = null, heartbeat = true }, deps = {}) {
  const c = cfgDeps(deps);
  const r = readStore(c.stateFile, EMPTY_STATE, deps);
  const base = (r.ok && r.value && typeof r.value === 'object') ? r.value : {};
  const at = c.now();
  const markets = { ...((base.markets && typeof base.markets === 'object') ? base.markets : {}) };
  const id = normId(marketId);
  // ── IL FILE DI PRODUZIONE ACCETTA SOLO ID DI ORDINI VERI ────────────────────────────────────────
  // Il 2 agosto sette voci con orderId 'o1' (una forma che il venue non emette mai: un id CLOB e'
  // 0x + 64 hex) sono finite qui dentro, e il pannello le ha mostrate come riprezzi reali — e' cio'
  // che il 5 agosto ha fatto sembrare TX-15 in dry-run quando non lo era. Il varco e' strutturale:
  // runAutoRepriceCycle fa `deps.configDeps || {}`, quindi QUALUNQUE banco che dimentichi di
  // iniettare autoStateFile scrive sul file vero. Il rifiuto vale solo per il file di DEFAULT: un
  // test che inietta il proprio percorso resta libero di registrare gli id fittizi che gli servono.
  const suFilePrduzione = c.stateFile === STATE_FILE;
  const idOrdineVero = typeof (reprice && reprice.orderId) === 'string' && /^0x[0-9a-f]{64}$/i.test(reprice.orderId);
  if (id && reprice && suFilePrduzione && !idOrdineVero) {
    return { ok: false, at, refused: 'synthetic-order-id',
      error: `rifiutata la scrittura sullo stato di produzione: orderId "${reprice.orderId}" non ha la forma di un id CLOB (0x + 64 hex). Un banco di prova deve iniettare il proprio autoStateFile.` };
  }
  if (id && reprice) {
    const prev = markets[id] || {};
    // A rolling hour of timestamps — this is what the maxPerHour runaway guard counts.
    const recent = Array.isArray(prev.recentAt) ? prev.recentAt.filter((t) => Number.isFinite(t) && at - t < 3_600_000) : [];
    recent.push(at);
    markets[id] = {
      lastRepriceAt: at,
      lastRepriceIso: new Date(at).toISOString(),
      lastOrderId: reprice.orderId || null,
      lastFromPrice: Number.isFinite(reprice.fromPrice) ? reprice.fromPrice : null,
      lastToPrice: Number.isFinite(reprice.toPrice) ? reprice.toPrice : null,
      lastOk: reprice.ok === true,
      lastSent: reprice.sent === true,
      lastGate: reprice.gate || null,
      lastReason: reprice.reason || null,
      // WHICH trigger moved it: 'band-exit' (the mid walked away), 'expiry-refresh' (the venue-side clock
      // was running out and the price was still fine), or both at once. Kept separate because the renewal
      // RATE only makes sense when the two are countable apart.
      lastTrigger: reprice.trigger || null,
      bandExits: (Number.isFinite(prev.bandExits) ? prev.bandExits : 0) + (reprice.trigger === 'expiry-refresh' ? 0 : 1),
      expiryRefreshes: (Number.isFinite(prev.expiryRefreshes) ? prev.expiryRefreshes : 0) + (reprice.trigger === 'expiry-refresh' ? 1 : 0),
      count: (Number.isFinite(prev.count) ? prev.count : 0) + 1,
      recentAt: recent,
    };
  }
  const st = {
    markets,
    heartbeatAt: heartbeat ? at : (Number.isFinite(base.heartbeatAt) ? base.heartbeatAt : null),
    lastCycleAt: heartbeat ? at : (Number.isFinite(base.lastCycleAt) ? base.lastCycleAt : null),
    cycles: (Number.isFinite(base.cycles) ? base.cycles : 0) + (heartbeat ? 1 : 0),
  };
  try { writeStoreAtomic(c.stateFile, st, deps); return { ok: true, at }; }
  catch (e) { return { ok: false, error: e.message, at }; }
}

/** How many automatic re-prices this market has had in the rolling last hour (the runaway guard's input). */
function repricesInLastHour(marketId, deps = {}, now = Date.now()) {
  const st = readAutoRepriceState(deps);
  const rec = st.markets[normId(marketId)];
  if (!rec || !Array.isArray(rec.recentAt)) return 0;
  return rec.recentAt.filter((t) => Number.isFinite(t) && now - t < 3_600_000).length;
}

module.exports = {
  readAutoRepriceConfig, isAutoRepriceEnabled, setAutoReprice,
  readAutoRepriceState, recordAutoRepriceState, repricesInLastHour,
  loadAutoRepriceTuning,
  CONFIG_FILE, STATE_FILE, AUDIT_FILE, AUTO_REPRICE_SOURCE, DEFAULTS, STRATEGIES,
  RESTING_GTD_SECONDS, REFRESH_MARGIN_SECONDS, EXPECTED_RENEWALS_PER_HOUR, DISCONNECT_CANCEL_SECONDS,
};

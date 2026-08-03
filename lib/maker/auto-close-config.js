'use strict';
// lib/maker/auto-close-config.js — the ON/OFF control for AUTOMATIC POSITION CLOSING.
//
// WHAT THIS SWITCHES. With it OFF (the default, everywhere) a filled hand order simply becomes an open
// position and stays there until the operator does something about it — exactly today's behaviour. With
// it ON for a market, the moment reconciliation confirms a fill on that market, the system places a
// closing order at a fixed small profit over the entry price.
//
// HOW A POSITION IS CLOSED ON POLYMARKET — verified, not assumed. You close by SELLING the outcome token
// you already hold, on the same CLOB. From the docs: "To sell your position, you give up an outcome token
// and receive payment in return", and a SELL order "gives outcome tokens in exchange for USDC"
// (docs.polymarket.com/trading/overview, /concepts/positions-tokens). Buying the OPPOSITE outcome does
// NOT close anything: holding 1 YES + 1 NO is a complete set worth $1 at resolution — a merge construct,
// not an exit. So the close order is a SELL of the very token the fill produced.
//
// SAME SHAPE AS THE AUTO-REPRICE SWITCH, deliberately: a durable file under data/, a global master plus a
// per-market opt-in, BOTH required, both defaulting OFF, both fail-closed to OFF, every flip audited. An
// operator who has learned one of these controls has learned the other.
//
// WHY IT IS A SEPARATE FILE FROM THE AUTO-REPRICE SWITCH. They are different powers. Auto-reprice MOVES an
// order that is already yours and already sized; auto-close OPENS A NEW ORDER on a side the manual panel
// has never used, against inventory. Wiring them to one flag would mean turning on the second by accident
// while reaching for the first.

const path = require('path');
const { readStore, writeStoreAtomic, DATA_DIR } = require('../safety/store');

const CONFIG_FILE = path.join(DATA_DIR, 'maker-auto-close.json');
const AUDIT_FILE = path.join(DATA_DIR, 'maker-auto-close-audit.jsonl');
// ── L'INTERRUTTORE GENERALE E' ACCESO DI DEFAULT (punto 7) ─────────────────────────────────────────
// Era spento, e per un anno «spento di default» e' stata la scelta giusta: l'uscita automatica apriva
// ordini contro inventario, ed era un potere nuovo da accendere di proposito.
//
// Adesso quel potere ha cambiato natura. Non e' piu' «piazza un ordine in piu'»: e' l'UNICO meccanismo
// che chiude una posizione riempita, cioe' l'unica cosa che oggi limiti la perdita su qualcosa che si e'
// gia' comprato. Un interruttore di sicurezza spento di default protegge chi non lo conosce dal suo
// funzionamento, e non protegge nessuno dal rischio che esiste comunque.
//
// RESTA SPEGNIBILE, e questa e' una scelta deliberata contro l'alternativa (renderlo non disattivabile):
// un interruttore che non si puo' spegnere e' un interruttore che, il giorno in cui si comporta male,
// costringe a usare il KILL — che ferma anche tutto il resto. Poter isolare UN meccanismo senza fermare
// la macchina intera vale piu' della garanzia che nessuno lo spenga per errore. Lo spegnimento resta
// audito, con chi e perche'.
const EMPTY = Object.freeze({ global: { enabled: true }, markets: {} });

// The audit `source` for everything this feature does. Distinct from 'manual-ui' (a human), 'agent35'
// (the engine) and 'auto-reprice-band-exit' (the band watcher), so the one trail always says which of the
// four moved an order.
const AUTO_CLOSE_SOURCE = 'auto-close-on-fill';

// ── THE PROFIT TARGET, IN ONE PLACE ─────────────────────────────────────────────────────────────────
// Expressed in CENTS, not ticks, because the intent is economic ("a cent of profit per share") and the
// tick differs per market — the pinned market's tick is 0.001, so one cent is TEN ticks there and one
// tick elsewhere. The close price is derived as entry + this, then SNAPPED UP to the market's own tick
// grid, so the realised profit is never less than intended by a rounding.
const CLOSE_PROFIT_CENTS = 1;

// A close SELL is never re-priced below this above entry, whatever the band does. See auto-close.js: the
// band watcher may move a resting close order to keep it earning rewards, and without a floor a moving
// mid could walk the exit down through break-even and turn a closing order into a realised loss.
const MIN_PROFIT_CENTS = CLOSE_PROFIT_CENTS;

function cfgDeps(deps) {
  return {
    configFile: deps.closeConfigFile || CONFIG_FILE,
    auditFile: deps.closeAuditFile || AUDIT_FILE,
    now: deps.now || (() => Date.now()),
    fs: deps.fs || require('fs'),
  };
}
function normId(marketId) { return typeof marketId === 'string' ? marketId.trim().toLowerCase() : ''; }

/** Read the whole switch map. Unreadable ⇒ OFF (an automatism we cannot read never gets to act). */
function readAutoCloseConfig(deps = {}) {
  const c = cfgDeps(deps);
  const r = readStore(c.configFile, EMPTY, deps);
  if (!r.ok) return { readable: false, error: r.error, globalEnabled: false, markets: {}, enabledMarketIds: [], optedInMarketIds: [], configFile: c.configFile };
  const st = (r.value && typeof r.value === 'object') ? r.value : EMPTY;
  const g = (st.global && typeof st.global === 'object') ? st.global : {};
  const markets = (st.markets && typeof st.markets === 'object') ? st.markets : {};
  // Assente ⇒ ACCESO. Solo un `false` scritto esplicitamente spegne: un file senza il campo e' un file
  // scritto prima che questo default esistesse, e non deve poter disattivare una protezione.
  const globalEnabled = g.enabled !== false;
  const optedIn = Object.keys(markets).filter((k) => markets[k] && markets[k].enabled === true);
  return {
    readable: true, error: null, globalEnabled, globalRecord: g.enabled === undefined ? null : g,
    markets, optedInMarketIds: optedIn,
    enabledMarketIds: globalEnabled ? optedIn : [],
    configFile: c.configFile,
  };
}

/** May the closer act on THIS market? Enabled ⇔ readable AND master on AND market opted in. */
function isAutoCloseEnabled(marketId, deps = {}) {
  const st = readAutoCloseConfig(deps);
  if (!st.readable) {
    return { enabled: false, readable: false, globalEnabled: false, marketEnabled: false, error: st.error, record: null,
      reason: `configurazione della chiusura automatica ${st.error} — fail CLOSED: nessuna chiusura viene piazzata` };
  }
  const id = normId(marketId);
  if (!id) return { enabled: false, readable: true, globalEnabled: st.globalEnabled, marketEnabled: false, error: null, record: null, reason: 'nessun marketId indicato' };
  const rec = st.markets[id] || null;
  const marketEnabled = !!(rec && rec.enabled === true);
  const enabled = st.globalEnabled && marketEnabled;
  return {
    enabled, readable: true, globalEnabled: st.globalEnabled, marketEnabled, error: null, record: rec,
    reason: enabled
      ? `chiusura automatica ATTIVA su ${id}${rec.reason ? ` — ${rec.reason}` : ''}`
      : !st.globalEnabled
        ? `chiusura automatica spenta globalmente${marketEnabled ? ' (questo mercato è abilitato, ma l\'interruttore generale ha la precedenza)' : ''}`
        : `chiusura automatica non abilitata su ${id} — una posizione riempita resta aperta finché non intervieni tu`,
  };
}

function appendAudit(rec, c) {
  try {
    c.fs.mkdirSync(path.dirname(c.auditFile), { recursive: true });
    c.fs.appendFileSync(c.auditFile, JSON.stringify(rec) + '\n');
  } catch (_e) { /* best-effort; an audit failure must never stop a switch being flipped */ }
}

/**
 * Flip a switch. Enabling over an unreadable state is REFUSED; disabling is always permitted — the
 * direction that can only reduce activity must never be blocked.
 */
function setAutoClose({ scope = 'market', marketId = null, enabled, by = null, reason = null }, deps = {}) {
  const c = cfgDeps(deps);
  if (scope !== 'global' && scope !== 'market') return { ok: false, error: "scope must be 'global' or 'market'", scope, marketId, enabled: false };
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean', scope, marketId, enabled: false };
  const id = scope === 'market' ? normId(marketId) : null;
  if (scope === 'market' && !id) return { ok: false, error: 'marketId required for scope:market', scope, marketId, enabled: false };

  const r = readStore(c.configFile, EMPTY, deps);
  if (!r.ok && enabled === true) {
    return { ok: false, scope, marketId: id, enabled: false,
      error: `configurazione ${r.error} — rifiuto di ACCENDERE la chiusura automatica su uno stato che non so leggere (spegnerla resta sempre permesso)` };
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
  appendAudit({ ts: at, event: enabled ? 'auto-close-on' : 'auto-close-off', scope, marketId: id, by, reason }, c);
  return { ok: true, scope, marketId: id, enabled, record };
}

module.exports = {
  readAutoCloseConfig, isAutoCloseEnabled, setAutoClose,
  CONFIG_FILE, AUDIT_FILE, AUTO_CLOSE_SOURCE, CLOSE_PROFIT_CENTS, MIN_PROFIT_CENTS,
};

'use strict';
// lib/maker/market-clock.js — HOW LONG THIS MARKET HAS LEFT, and what order lifetime that permits.
//
// WHY THIS EXISTS. Until now every hand order got the same window regardless of the market: 180s with the
// band-exit watcher off, or a 23-minute GTD renewed with 3 minutes to spare with it on (see
// lib/maker/auto-reprice-config.js for the arithmetic behind 23/3). Those numbers were chosen against
// long-dated markets — the Ballon d'Or resolves in months, so a 23-minute window is a rounding error next
// to the market's own life. On a SHORT market that same constant is a bug with real money attached: a
// "Bitcoin Up or Down — 5 minute" market closes in minutes, and an order carrying a 23-minute GTD would be
// signed to outlive the market it is quoting. The venue would hold it past the moment the book stops
// meaning anything, and the only thing retiring it would be resolution, not us.
//
// THE RULE, stated plainly:
//   • The order's native expiry is a FRACTION of the market's REMAINING life (GTD_FRACTION, 90%), capped
//     by the ordinary window for the market's mode. It is never longer than the market has left.
//   • The proactive refresh margin shrinks with it (a 4-minute order cannot be renewed "3 minutes early"),
//     with a floor so the watcher always has real poll cycles to work in.
//   • Under MIN_MINUTES_TO_CLOSE minutes of remaining life, NOTHING new is placed. The bot refuses and
//     says so, rather than placing an order into the last minutes of a book that is about to stop.
//
// WHY REFUSING IS THE RIGHT END STATE, and not "place something even shorter". The venue's GTD floor is a
// stated expiration at least 3 minutes out, which expires 60s early — so the SHORTEST native lifetime that
// can be expressed at all is 120 effective seconds (lib/maker/order-ttl.js, primary-source). Below the
// refusal threshold there is no honest window left to ask for: we would either clamp UP past the market's
// close (an order that outlives its market — exactly what this module exists to prevent) or send an
// expiration the venue rejects. MIN_MINUTES_TO_CLOSE is therefore floored at MIN_SAFE_MINUTES, which is
// derived from the venue floor rather than picked: at 90% of remaining life, 3 minutes of life is the
// least that still yields a window above the floor.
//
// AN UNKNOWN CLOSE TIME IS NOT A SHORT ONE. When no source states this market's end date, the ordinary
// fixed window applies and the result says `closeKnown:false` so the caller can surface it. Refusing on an
// unreadable end date would ground every market whose board row lacks the field, including ones that have
// been quoted safely for months; the risk this module addresses (an order outliving its market) needs a
// SHORT market to exist, and "unknown" is not evidence of one. What is NOT done is inventing a close time.
//
// Pure arithmetic (resolveMarketWindow) is separated from the I/O (readMarketCloseMs) so the selfcheck can
// exhaust the policy with no files at all.

const fs = require('fs');
const path = require('path');
// La cartella `data/` si CHIEDE al risolutore condiviso, non si conta con i «..»: sotto `lib/` un
// modulo puo' essere importato da una rotta, e nel bundle di Next `__dirname` e' .next/server/… —
// dove i «..» portano in `.next/data/`, una cartella che non esiste. Vedi lib/safety/store.js.
const { DATA_DIR } = require('../safety/store');
const { MIN_EFFECTIVE_TTL_SEC } = require('./order-ttl');

// Fraction of the market's REMAINING life an order may be signed for. Deliberately < 1: an order whose
// expiry lands exactly on the close is an order resting in the final seconds of a book.
const GTD_FRACTION = 0.9;
// The proactive-renewal margin is this share of the (possibly shortened) window, never below the floor.
const REFRESH_MARGIN_FRACTION = 0.2;
// The watcher polls every 5s (auto-reprice DEFAULTS.pollMs), so this floor is ~6 poll cycles of room to
// complete a ~2s cancel→replace, with retries.
const MIN_REFRESH_MARGIN_SECONDS = 30;
// ── LA SOGLIA DI FINE VITA, IN UN PUNTO SOLO ────────────────────────────────────────────────────────
// Sotto questi minuti di vita residua non si piazza NULLA di nuovo su quel mercato. E' l'unica
// definizione nel progetto: il watcher reattivo, il motore di tracking e il piazzamento a mano la
// leggono tutti da qui attraverso `minMinutesToClose()`, e nessuno ne tiene una copia.
//
// PERCHE' 3 E NON 5. Il valore derivato qui sotto (MIN_SAFE_MINUTES) e' il PAVIMENTO VERO del venue:
// la finestra GTD piu' corta che l'exchange sa esprimere, ceil(120s / 0.9) = 134s, arrotondata a 3
// minuti. Sotto quella soglia un ordine nuovo non e' esprimibile e verrebbe rifiutato — quindi 3 e' il
// punto oltre il quale il limite smette di essere una scelta e diventa un fatto.
//
// Il default era 5, cioe' due minuti di margine PRUDENZIALE sopra il pavimento. Su mercati lunghi non
// si nota; su una finestra Bitcoin da 5 minuti rendeva il tracking inutilizzabile per costruzione —
// misurato dal vivo il 2 agosto 2026: tracking attivato con 7.6 minuti di vita residua, tre ordini
// piazzati, e il gate chiuso 2 minuti e 17 secondi dopo, con l'ordine lasciato fermo a 53c mentre il
// mid saliva a 94c. Portarlo al pavimento restituisce quei due minuti senza permettere nulla che il
// venue rifiuterebbe.
//
// SI PUO' ALZARE, NON ABBASSARE: `MAKER_MIN_MINUTES_TO_CLOSE` nell'ambiente sovrascrive questo valore,
// ma resta comunque bloccato al pavimento — un refuso o uno zero non possono aprire una finestra che
// l'exchange non sa esprimere.
//
// QUESTA SOGLIA NON GOVERNA LE CANCELLAZIONI. Vale per cio' che si PIAZZA. Togliere un ordine dal libro
// e' sempre permesso e non richiede alcuna finestra: vedi lib/maker/mm-tracking.js, che a mercato in
// chiusura cancella invece di lasciare fermo.
const MIN_SAFE_MINUTES = Math.ceil(MIN_EFFECTIVE_TTL_SEC / GTD_FRACTION / 60);
const DEFAULT_MIN_MINUTES_TO_CLOSE = MIN_SAFE_MINUTES;

const BOARD_FILE = path.join(DATA_DIR, 'liquidity-rewards.json');
// Una definizione sola per il percorso del board: vedi `./percorsi-feed`.
const PERCORSI = require('./percorsi-feed');

/** MAKER_MIN_MINUTES_TO_CLOSE, clamped to the venue-derived floor. A typo or a too-small value lands on
 *  the default/floor rather than silently permitting an order the venue could not express. */
function minMinutesToClose(env = process.env) {
  const n = Number(env.MAKER_MIN_MINUTES_TO_CLOSE);
  const wanted = Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_MINUTES_TO_CLOSE;
  return Math.max(MIN_SAFE_MINUTES, wanted);
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function normId(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }
function parseMs(v) { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; }

/**
 * WHEN DOES THIS MARKET CLOSE? Read from the venue-sourced records this repo already keeps, in order of
 * how directly each one describes the market:
 *   1. the manual market catalog (data/maker-manual-markets.json) — written from Gamma when the operator
 *      adds a market by hand, and the ONLY source that knows about a market with no reward program;
 *   2. the reward board (data/liquidity-rewards.json) — agent24's endDate, verbatim from Gamma;
 *   3. the normalized board (/tmp/liquidity-rewards.json) — hoursToResolution, which is a duration rather
 *      than a timestamp, so it is used LAST and converted against the row's own updatedAt.
 * Nothing is inferred: a market absent from all three returns readable:false, and the caller keeps the
 * ordinary fixed window rather than pretending to know a close time.
 *
 * @returns {{readable:boolean, endMs:(number|null), endIso:(string|null), source:(string|null)}}
 */
function readMarketCloseMs(marketId, deps = {}) {
  const id = normId(marketId);
  if (!id) return { readable: false, endMs: null, endIso: null, source: null };

  // Injected end time (tests, and callers that already hold the market record).
  if (Number.isFinite(deps.endMs)) {
    return { readable: true, endMs: deps.endMs, endIso: new Date(deps.endMs).toISOString(), source: 'injected' };
  }

  const cat = deps.catalog !== undefined ? deps.catalog : (() => {
    try { return require('./market-catalog').readMarketCatalog(deps); } catch { return null; }
  })();
  const rec = cat && cat.markets ? cat.markets[id] : null;
  const catEnd = rec ? parseMs(rec.endDate) : null;
  if (catEnd != null) return { readable: true, endMs: catEnd, endIso: new Date(catEnd).toISOString(), source: 'manual-catalog' };

  const board = deps.board !== undefined ? deps.board : readJson(deps.boardFile || BOARD_FILE);
  const bm = board && Array.isArray(board.markets) ? board.markets.find((m) => m && normId(m.conditionId) === id) : null;
  const boardEnd = bm ? parseMs(bm.endDate) : null;
  if (boardEnd != null) return { readable: true, endMs: boardEnd, endIso: new Date(boardEnd).toISOString(), source: 'reward-board' };

  const norm = deps.norm !== undefined ? deps.norm : readJson(deps.normFile || PERCORSI.fileBoardNormalizzato());
  const nm = norm && Array.isArray(norm.markets) ? norm.markets.find((m) => m && normId(m.marketId) === id) : null;
  if (nm && Number.isFinite(nm.hoursToResolution)) {
    const base = parseMs(nm.updatedAt);
    if (base != null) {
      const end = base + nm.hoursToResolution * 3_600_000;
      return { readable: true, endMs: end, endIso: new Date(end).toISOString(), source: 'normalized-board' };
    }
  }
  return { readable: false, endMs: null, endIso: null, source: null };
}

/**
 * THE POLICY, as pure arithmetic. Given when the market closes and the window the caller WOULD have used,
 * return the window it MAY use — and whether it may place at all.
 *
 * @param {object} a
 *   endMs                     when the market closes (null/undefined ⇒ unknown, see the header)
 *   nowMs                     clock
 *   baseTtlSeconds            the window this order would otherwise get (180, or the 23-min resting window)
 *   baseRefreshMarginSeconds  the proactive renewal margin it would otherwise get (null when not renewed)
 *   minMinutes                refusal threshold (defaults to the env-resolved value)
 * @returns {{closeKnown:boolean, endMs:number|null, secondsToClose:number|null, minutesToClose:number|null,
 *            tooClose:boolean, minMinutes:number, ttlSeconds:number, refreshMarginSeconds:number|null,
 *            shortened:boolean, gate:string|null, reason:string}}
 */
function resolveMarketWindow({ endMs = null, nowMs = Date.now(), baseTtlSeconds, baseRefreshMarginSeconds = null, minMinutes = null } = {}) {
  const minM = Number.isFinite(minMinutes) && minMinutes > 0 ? Math.max(MIN_SAFE_MINUTES, minMinutes) : minMinutesToClose();
  const baseTtl = Number.isFinite(baseTtlSeconds) ? baseTtlSeconds : 0;
  const baseMargin = Number.isFinite(baseRefreshMarginSeconds) ? baseRefreshMarginSeconds : null;

  if (!Number.isFinite(endMs)) {
    return {
      closeKnown: false, endMs: null, secondsToClose: null, minutesToClose: null,
      tooClose: false, minMinutes: minM, ttlSeconds: baseTtl, refreshMarginSeconds: baseMargin,
      shortened: false, gate: null,
      reason: 'orario di chiusura del mercato non leggibile da nessuna fonte — resta la finestra fissa consueta (una chiusura ignota NON viene trattata come imminente, ma non viene nemmeno inventata)',
    };
  }

  const secondsToClose = Math.floor((endMs - nowMs) / 1000);
  const minutesToClose = secondsToClose / 60;

  if (secondsToClose <= 0) {
    return {
      closeKnown: true, endMs, secondsToClose, minutesToClose,
      tooClose: true, minMinutes: minM, ttlSeconds: 0, refreshMarginSeconds: null, shortened: true,
      gate: 'market-closed',
      reason: `il mercato risulta CHIUSO da ${Math.abs(Math.round(minutesToClose))} min (chiusura ${new Date(endMs).toISOString()}) — nessun ordine nuovo`,
    };
  }
  if (minutesToClose < minM) {
    return {
      closeKnown: true, endMs, secondsToClose, minutesToClose,
      tooClose: true, minMinutes: minM, ttlSeconds: 0, refreshMarginSeconds: null, shortened: true,
      gate: 'market-too-close-to-close',
      reason: `mancano ${minutesToClose.toFixed(1)} min alla chiusura del mercato (${new Date(endMs).toISOString()}), sotto la soglia di ${minM} min — rifiuto di piazzare: un ordine con la finestra GTD minima del venue sopravvivrebbe alla chiusura del mercato`,
    };
  }

  // The window: the ordinary one, unless the market has less life than that.
  const roomSeconds = Math.floor(secondsToClose * GTD_FRACTION);
  const ttlSeconds = Math.max(MIN_EFFECTIVE_TTL_SEC, Math.min(baseTtl > 0 ? baseTtl : roomSeconds, roomSeconds));
  const shortened = baseTtl > 0 && ttlSeconds < baseTtl;
  // The margin shrinks with the window but never below the floor, and never reaches the window itself
  // (a margin >= the window would mean "renew it before it exists").
  const refreshMarginSeconds = baseMargin == null
    ? null
    : Math.min(baseMargin, Math.max(MIN_REFRESH_MARGIN_SECONDS, Math.round(ttlSeconds * REFRESH_MARGIN_FRACTION)), Math.max(1, ttlSeconds - 1));

  return {
    closeKnown: true, endMs, secondsToClose, minutesToClose,
    tooClose: false, minMinutes: minM, ttlSeconds, refreshMarginSeconds, shortened, gate: null,
    reason: shortened
      ? `finestra ridotta a ${ttlSeconds}s (${(ttlSeconds / 60).toFixed(1)} min = ${Math.round(GTD_FRACTION * 100)}% dei ${minutesToClose.toFixed(1)} min residui) invece dei ${baseTtl}s consueti: l'ordine non può sopravvivere al mercato che quota${refreshMarginSeconds != null ? `, rinnovo anticipato a ${refreshMarginSeconds}s dalla scadenza` : ''}`
      : `${minutesToClose.toFixed(1)} min alla chiusura: la finestra consueta di ${baseTtl}s resta dentro la vita residua del mercato (tetto ${roomSeconds}s)`,
  };
}

/** Read the close time and apply the policy in one call — what the placement path uses. */
function marketWindowFor({ marketId, nowMs = Date.now(), baseTtlSeconds, baseRefreshMarginSeconds = null, minMinutes = null } = {}, deps = {}) {
  const close = readMarketCloseMs(marketId, deps);
  const w = resolveMarketWindow({ endMs: close.endMs, nowMs, baseTtlSeconds, baseRefreshMarginSeconds, minMinutes });
  return { ...w, endIso: close.endIso, closeSource: close.source, marketId };
}

module.exports = {
  readMarketCloseMs, resolveMarketWindow, marketWindowFor, minMinutesToClose,
  GTD_FRACTION, REFRESH_MARGIN_FRACTION, MIN_REFRESH_MARGIN_SECONDS,
  DEFAULT_MIN_MINUTES_TO_CLOSE, MIN_SAFE_MINUTES,
  BOARD_FILE,
};

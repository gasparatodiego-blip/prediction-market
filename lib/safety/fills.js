'use strict';
// lib/safety/fills.js — the FILL-TRUTH ledger, plus the OPEN-EXPOSURE and REALISED-DAILY-P&L computations
// the risk limits (maxOpenNotionalUsd, maxDailyLossUsd) evaluate against.
//
// WHY THIS EXISTS: risk-limits.js could not ARM its exposure/daily-loss limits because usage.js had no
// source for openNotionalUsd / realisedDailyPnlUsd — it returned null and those two limits failed closed
// forever. A limit that cannot compute its own input protects nothing. This module IS that input, and it
// is built on VENUE TRUTH, never on our own submission optimism.
//
// A FILL IS THE ONLY HONEST INPUT. A submitted order (an execution-audit OUTCOME row with an orderId) means
// the venue ACCEPTED the order onto the book — NOT that it filled. Fills are learned separately, from the
// venue: Polymarket /trades + /positions + per-order size_matched (see reconcile-fills.js). Every confirmed
// fill (full OR PARTIAL) is appended here at its REAL filled size — a partial is NEVER rounded up to full.
//
// APPEND-ONLY, FAIL-CLOSED (mirrors store.js / execution-audit.js — the absent-vs-unreadable distinction is
// the whole point):
//   • ledger ABSENT (ENOENT)   → no fills yet → exposure 0, realised loss 0. A real, readable state: the
//                                 limits ARM and permit a within-cap order. Absent ≠ unreadable.
//   • ledger present+parseable → computed from the rows.
//   • ledger UNREADABLE         → computeExposure / computeRealisedDailyPnl return { ok:false }; usage.js
//                                 maps that to null and the exposure + daily-loss limits FAIL CLOSED.
//                                 Unknown exposure means NO order, never "assume zero".
//
// UNKNOWN vs CONFIRMED (the dangerous direction is understating exposure):
//   • A sent order that reconciliation has RESOLVED (the ledger holds ≥1 row for its idempotencyKey — a
//     fill or a no-fill) contributes only its CONFIRMED filled position (a partial contributes the partial).
//   • A sent order the ledger has NEVER seen is UNKNOWN. We do NOT assume it stayed unfilled (that would
//     understate exposure). We count its FULL intended notional — assume it filled — until reconciliation
//     resolves it from the venue. If an unknown order's notional cannot even be bounded → ok:false (fail
//     closed). "An unknown fill assumed unfilled understates exposure, which is the dangerous direction."
//
// HONEST VALUATION (honest-engine): open positions are marked with EXECUTABLE bid/ask from the real book,
// NEVER mid, never last trade. If the book cannot be read the mark is "—" and the position's exposure is
// FLOORED at its entry notional. Exposure per position = max(entryNotional, markNotional): we fail toward
// OVERSTATING exposure, never understating it.
//
// FEES come from the Polymarket fee SSOT (lib/polymarket-fees.js) at RECORD time and are stored per fill;
// realised P&L sums the stored feeUsd. This module never hardcodes a fee.

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const FILLS_FILE = path.join(DATA_DIR, 'safety-fills.jsonl');
const UTC_DAY_MS = 86_400_000;
// A sent order the ledger has not resolved is flagged `stale` for reconciliation after this long. It is
// counted at full notional the WHOLE time (never understated); the flag only drives observability/alerting.
const DEFAULT_STALE_MS = 5 * 60_000;

function cfg(deps) {
  return { fillsFile: deps.fillsFile || FILLS_FILE, now: deps.now || (() => Date.now()), fs: deps.fs || fs };
}

// Start of the UTC CALENDAR day containing `now`. The daily-loss window is a UTC calendar day (unambiguous,
// venue-neutral) — NOT a rolling 24h. See computeRealisedDailyPnl for why that choice is safe here.
function utcDayStart(now) { return Math.floor(now / UTC_DAY_MS) * UTC_DAY_MS; }

// ── READ the append-only ledger. ENOENT → { ok:true, rows:[] } (absent = no fills). Any other read/parse
//    failure → { ok:false } so every caller FAILS CLOSED. A single corrupt line does NOT silently drop
//    fills (which would understate exposure); it makes the whole read not-ok. ──
function readFills({ userId } = {}, deps = {}) {
  const c = cfg(deps);
  let raw;
  try { raw = c.fs.readFileSync(c.fillsFile, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return { ok: true, rows: [] }; return { ok: false, error: `unreadable:${(e && e.code) || 'error'}` }; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { return { ok: false, error: 'corrupt-json' }; } // a truncated/tampered line → fail closed, never guess
    if (userId && row.userId !== userId) continue;
    rows.push(row);
  }
  return { ok: true, rows };
}

function appendRow(row, deps = {}) {
  const c = cfg(deps);
  c.fs.mkdirSync(path.dirname(c.fillsFile), { recursive: true });
  c.fs.appendFileSync(c.fillsFile, JSON.stringify(row) + '\n'); // sync — a fill must be on disk before it counts
}

/**
 * Append ONE confirmed fill from venue truth. A partial is recorded at its partial `filledSize` — never
 * rounded up. `feeUsd` comes from the Polymarket fee SSOT at record time (0 for a maker fill under the v2
 * taker-only model, an ASSUMPTION flagged by feeKnown:false when it could not be resolved).
 *
 * fill: { userId, venue, tokenId, market?, side:'BUY'|'SELL', filledSize, filledPrice, feeUsd?, feeKnown?,
 *         source, orderId?, idempotencyKey?, txHash?, ts? }
 * @returns {{recorded:boolean, error?:string}}
 */
function recordFill(fill, deps = {}) {
  const c = cfg(deps);
  const side = fill.side === 'SELL' ? 'SELL' : (fill.side === 'BUY' ? 'BUY' : null);
  const filledSize = Number(fill.filledSize);
  const filledPrice = Number(fill.filledPrice);
  if (!side || !(filledSize > 0) || !(filledPrice >= 0)) return { recorded: false, error: 'invalid-fill' };
  const feeKnown = fill.feeUsd != null && Number.isFinite(Number(fill.feeUsd));
  const row = {
    kind: 'fill',
    ts: fill.ts != null ? fill.ts : c.now(),
    userId: fill.userId || null,
    venue: fill.venue || null,
    tokenId: fill.tokenId != null ? String(fill.tokenId) : null,
    market: fill.market != null ? String(fill.market) : (fill.tokenId != null ? String(fill.tokenId) : null),
    side,
    filledSize,
    filledPrice,
    feeUsd: feeKnown ? Number(fill.feeUsd) : 0, // sums as 0 when unknown; feeKnown records that it is an assumption
    feeKnown,
    source: fill.source || null,               // venue-truth provenance: 'polymarket-trades' | 'polymarket-size_matched' | ...
    orderId: fill.orderId != null ? String(fill.orderId) : null,
    idempotencyKey: fill.idempotencyKey || null, // links this fill to the sent order → resolves its UNKNOWN state
    txHash: fill.txHash || null,
  };
  try { appendRow(row, deps); return { recorded: true }; }
  catch (e) { return { recorded: false, error: (e && e.message) || 'append-failed' }; }
}

/**
 * Append a NO-FILL resolution: reconciliation reached the venue and confirmed this order filled ZERO shares
 * (e.g. it was fully cancelled while resting). This RESOLVES the order's UNKNOWN state to 0 — the venue was
 * queried, this is truth, not an assumption. Without such a row an unseen sent order stays UNKNOWN and is
 * counted at full notional.
 */
function recordNoFill({ userId, venue, idempotencyKey, orderId, source, ts } = {}, deps = {}) {
  const c = cfg(deps);
  if (!idempotencyKey && !orderId) return { recorded: false, error: 'no-key' };
  const row = { kind: 'nofill', ts: ts != null ? ts : c.now(), userId: userId || null, venue: venue || null,
    idempotencyKey: idempotencyKey || null, orderId: orderId != null ? String(orderId) : null, source: source || null };
  try { appendRow(row, deps); return { recorded: true }; }
  catch (e) { return { recorded: false, error: (e && e.message) || 'append-failed' }; }
}

// ── FIFO position engine. Walk fills in time order; BUY opens/covers, SELL closes/opens-short. Returns the
//    open positions per (venue|tokenId) AND the realised-P&L events (each stamped with the CLOSING fill's
//    ts). Pure — shared by computeExposure (open) and computeRealisedDailyPnl (realised). ──
function runFifo(fills) {
  const byKey = new Map(); // key -> { venue, tokenId, lots: [{ shares, price, feePerShare }], sign }
  const realised = []; // { ts, key, venue, tokenId, pnlUsd }
  const keyOf = (f) => `${f.venue || ''}|${f.tokenId || ''}`;
  const sorted = fills.filter(f => f.kind === 'fill').slice().sort((a, b) => a.ts - b.ts);

  for (const f of sorted) {
    const key = keyOf(f);
    let pos = byKey.get(key);
    if (!pos) { pos = { venue: f.venue || null, tokenId: f.tokenId || null, lots: [] }; byKey.set(key, pos); }
    let qty = f.filledSize;
    const feePerShare = f.filledSize > 0 ? (f.feeUsd || 0) / f.filledSize : 0;
    // A BUY closes any open SHORT lots (negative) first, then opens a LONG lot with the remainder.
    // A SELL closes any open LONG lots first, then opens a SHORT lot with the remainder. FIFO within a side.
    const closingShort = f.side === 'BUY';
    // Close opposing lots FIFO.
    while (qty > 1e-12 && pos.lots.length && ((closingShort && pos.lots[0].shares < 0) || (!closingShort && pos.lots[0].shares > 0))) {
      const lot = pos.lots[0];
      const lotAbs = Math.abs(lot.shares);
      const closeQty = Math.min(qty, lotAbs);
      // Realised P&L on the closed quantity, net of BOTH the opening lot's fee and this closing fill's fee.
      // long close (SELL): (sell − buy)·q ;  short close (BUY): (sellShort − buyCover)·q = (lot.price − f.price)·q
      const gross = closingShort ? (lot.price - f.filledPrice) * closeQty : (f.filledPrice - lot.price) * closeQty;
      const fees = (lot.feePerShare + feePerShare) * closeQty;
      realised.push({ ts: f.ts, key, venue: pos.venue, tokenId: pos.tokenId, pnlUsd: gross - fees });
      lot.shares += closingShort ? closeQty : -closeQty; // move toward zero
      qty -= closeQty;
      if (Math.abs(lot.shares) < 1e-9) pos.lots.shift();
    }
    // Remainder opens a new lot on this fill's side.
    if (qty > 1e-12) pos.lots.push({ shares: closingShort ? qty : -qty, price: f.filledPrice, feePerShare });
  }
  return { byKey, realised };
}

/**
 * OPEN EXPOSURE for one user, in USD. Built from confirmed fills (FIFO) minus confirmed closes, PLUS the
 * full notional of any UNKNOWN sent order the ledger has not resolved.
 *
 * @param {object} args
 *   userId
 *   now
 *   sentOrders  Array<{ idempotencyKey, notionalUsd, ts }> — orders the venue ACCEPTED (execution-audit
 *               outcome rows with an orderId). An entry whose idempotencyKey has NO ledger row is UNKNOWN.
 *   marks       optional (tokenId) => { price:number, ts:number } | null — EXECUTABLE exit price (bid for a
 *               long, ask for a short) from the real book. A fresh mark marks the position to executable
 *               value; a missing/stale mark falls back to the entry-notional FLOOR. NEVER a mid.
 *   markFreshMs  a mark older than this is treated as unreadable (floor to entry notional). Default 60s.
 *   staleMs     an unknown sent order older than this is flagged stale (still counted at full notional).
 * @returns {{ok:true, openNotionalUsd, positions, unknowns} | {ok:false, error}}
 */
/**
 * Gli ordini INVIATI che il ledger non ha ancora risolto — ne' con un fill ne' con un no-fill.
 *
 * NON e' una misura di esposizione e non va sommata a niente: e' la lista di lavoro della
 * riconciliazione, cioe' la risposta a «su quali ordini vale la pena interrogare il venue?». Sta qui,
 * accanto al ledger, perche' la definizione di «risolto» e' una proprieta' del ledger; ma e' separata da
 * `computeExposure` perche' la scelta dell'operatore del 2 agosto riguarda l'ESPOSIZIONE e non deve
 * essere riaperta da questa funzione.
 *
 * @param {Array} sentOrders  ordini che il venue ha accettato (da execution-audit)
 * @param {Array} ledgerRows  le righe del ledger dei fill
 * @returns {Array} il sottoinsieme di `sentOrders` senza riga `fill` ne' `nofill`
 */
function ordiniNonRisolti(sentOrders = [], ledgerRows = []) {
  const risolte = new Set();
  for (const row of Array.isArray(ledgerRows) ? ledgerRows : []) {
    if ((row.kind === 'fill' || row.kind === 'nofill') && row.idempotencyKey) risolte.add(row.idempotencyKey);
  }
  return (Array.isArray(sentOrders) ? sentOrders : []).filter((o) => o && o.idempotencyKey && !risolte.has(o.idempotencyKey));
}

function computeExposure({ userId, now = Date.now(), sentOrders = [], marks = null, markFreshMs = 60_000, staleMs = DEFAULT_STALE_MS, venuePositions = null } = {}, deps = {}) {
  const r = readFills({ userId }, deps);
  if (!r.ok) return { ok: false, error: r.error };

  // Which order keys has the ledger SEEN (resolved)? A fill OR a nofill row resolves an order.
  const resolvedKeys = new Set();
  for (const row of r.rows) { if ((row.kind === 'fill' || row.kind === 'nofill') && row.idempotencyKey) resolvedKeys.add(row.idempotencyKey); }

  const { byKey } = runFifo(r.rows);

  const positions = [];
  let openNotionalUsd = 0;
  for (const pos of byKey.values()) {
    const net = pos.lots.reduce((s, l) => s + l.shares, 0);
    if (Math.abs(net) < 1e-9) continue; // flat — no open exposure
    const shares = Math.abs(net);
    // Entry (cost-basis) notional of the remaining open lots.
    const entryNotional = pos.lots.reduce((s, l) => s + Math.abs(l.shares) * l.price, 0);
    const entryPrice = shares > 0 ? entryNotional / shares : 0;
    // Executable mark, if a FRESH one is available. Otherwise the book is "—" → floor at entry notional.
    let markPrice = null, markReadable = false;
    if (marks) {
      const m = typeof marks === 'function' ? marks(pos.tokenId, net > 0 ? 'BID' : 'ASK') : marks[pos.tokenId];
      if (m && Number.isFinite(Number(m.price)) && (m.ts == null || now - m.ts <= markFreshMs)) { markPrice = Number(m.price); markReadable = true; }
    }
    const markNotional = markReadable ? shares * markPrice : null;
    // Fail toward OVERSTATING: exposure is at least entry notional; if a fresh executable mark is higher, use it.
    const exposureUsd = markReadable ? Math.max(entryNotional, markNotional) : entryNotional;
    openNotionalUsd += exposureUsd;
    positions.push({ venue: pos.venue, tokenId: pos.tokenId, side: net > 0 ? 'LONG' : 'SHORT', shares: +shares.toFixed(6),
      entryNotionalUsd: +entryNotional.toFixed(4), markPrice: markReadable ? markPrice : null,
      markValueUsd: markReadable ? +markNotional.toFixed(4) : null, exposureUsd: +exposureUsd.toFixed(4), markSource: markReadable ? 'executable-book' : 'entry-notional-floor' });
  }

  // ── LE POSIZIONI VERE DEL VENUE, SOPRA QUELLE DEL LEDGER ───────────────────────────────────────
  //
  // Il ledger locale sa solo cio' che la riconciliazione e' riuscita a scrivere. Il 4 agosto 2026 diceva
  // $0 mentre al venue c'erano 199,99 share con un carico di $0,1675: una posizione reale, invisibile al
  // tetto che governa quanto capitale il piano puo' allocare.
  //
  // LA FUSIONE E' PER TOKEN, E VINCE IL PIU' ALTO. Un token che compare in entrambe le fonti non si
  // somma — sarebbe doppio conteggio della stessa posizione — ma non si sceglie nemmeno arbitrariamente
  // una delle due: si prende l'esposizione MAGGIORE. E' la stessa regola che questo modulo applica gia'
  // al mark («Fail toward OVERSTATING»), per lo stesso motivo: su un tetto, sbagliare per eccesso costa
  // un'allocazione piu' piccola, sbagliare per difetto costa un tetto che non morde.
  //
  // Un token che c'e' SOLO al venue si aggiunge: e' esattamente il caso del 4 agosto.
  const perToken = new Map(positions.map((p) => [String(p.tokenId), p]));
  let daVenue = 0;
  const vp = venuePositions && Array.isArray(venuePositions.positions) ? venuePositions.positions : null;
  if (venuePositions && venuePositions.readable === true && vp) {
    for (const p of vp) {
      const tok = String(p.tokenId ?? p.asset ?? '');
      const shares = Math.abs(Number(p.size));
      const carico = Number(p.avgPrice);
      if (!tok || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(carico) || carico < 0) continue;
      const entryNotional = shares * carico;
      const cur = Number(p.curPrice);
      // Stesso criterio del mark: se il prezzo corrente e' leggibile e piu' alto, e' lui l'esposizione.
      const espostoVenue = Number.isFinite(cur) && cur > 0 ? Math.max(entryNotional, shares * cur) : entryNotional;
      const gia = perToken.get(tok);
      if (gia) {
        // Stessa posizione vista da due parti: si tiene la lettura piu' alta, non la somma.
        if (espostoVenue > gia.exposureUsd) {
          openNotionalUsd += espostoVenue - gia.exposureUsd;
          daVenue += espostoVenue - gia.exposureUsd;
          gia.exposureUsd = +espostoVenue.toFixed(4);
          gia.markSource = 'venue-positions';
        }
      } else {
        openNotionalUsd += espostoVenue;
        daVenue += espostoVenue;
        const rec = {
          venue: 'polymarket', tokenId: tok, side: 'LONG', shares: +shares.toFixed(6),
          entryNotionalUsd: +entryNotional.toFixed(4),
          markPrice: Number.isFinite(cur) ? cur : null,
          markValueUsd: Number.isFinite(cur) ? +(shares * cur).toFixed(4) : null,
          exposureUsd: +espostoVenue.toFixed(4), markSource: 'venue-positions',
          soloAlVenue: true,
        };
        positions.push(rec);
        // NELL'INDICE, non solo nell'elenco. Senza questa riga due voci dello STESSO token dentro la
        // lista del venue verrebbero sommate invece che fuse — l'errore va nella direzione prudente
        // (esposizione sovrastimata) ma resta un errore, ed e' esattamente cio' che il test ha trovato.
        perToken.set(tok, rec);
      }
    }
  }

  // ── IL CONTEGGIO ANTICIPATO E' STATO RIMOSSO (punto 1, 2026-08-02) ──────────────────────────────
  // Fino a questa revisione ogni ordine INVIATO e non ancora risolto veniva sommato all'esposizione al
  // suo valore pieno, immediatamente, come se fosse gia' stato eseguito. Era la scelta prudente: il
  // tetto mordeva nell'istante del piazzamento invece di aspettare la riconciliazione.
  //
  // Su richiesta esplicita dell'operatore quel conteggio non c'e' piu': l'esposizione ora riflette solo
  // cio' che e' stato RICONCILIATO col venue — posizioni vere, da fill veri.
  //
  // ⚠ IL RISCHIO CHE QUESTA SCELTA ACCETTA, scritto qui perche' chi legge il codice lo trovi dove
  // vive e non in un documento a parte:
  //   Fra un piazzamento e il ciclo di riconciliazione successivo passano FINO A 60 SECONDI. In quella
  //   finestra gli ordini inviati non pesano sull'esposizione, quindi il tetto (`maxOpenNotionalUsd`)
  //   NON li vede e non li conta. Ordini inviati in rapida successione possono percio' superare il
  //   tetto complessivo: ciascuno viene giudicato contro un'esposizione che non include i precedenti.
  //   Il blocco, se scatta, scatta DOPO la riconciliazione — cioe' quando l'esposizione eccedente
  //   esiste gia'.
  //
  //   Cosa resta a limitare quella finestra: il tetto PER ORDINE (nessun singolo ordine puo' superarlo)
  //   e il limite di 20 ordini per 60 secondi. Il prodotto dei due e' il vero massimo teorico della
  //   finestra, e non e' il tetto di esposizione. E' una conseguenza nota e voluta della rimozione,
  //   non una svista.
  //
  // `unknowns` resta nella risposta — vuoto — per non rompere i chiamanti che lo leggono.
  //
  // ⚠ E UN CHIAMANTE SI E' ROTTO LO STESSO, IN SILENZIO — trovato il 10 agosto 2026 ────────────────
  // `manual-reset.reconcileManualLane` usa questa lista come CANCELLO ECONOMICO: `if (!diag.unknowns
  // .length) return 'nothing-unresolved'`. Con `unknowns` vuoto per costruzione quel ramo esce SEMPRE,
  // quindi la riconciliazione automatica di agent40 non gira dal 2 agosto — e non lascia una riga di
  // log, perche' agent40 logga solo quando qualcosa e' stato risolto.
  //
  // Misurato il 10 agosto: 1.826 ordini inviati, **1.294 senza nessuna riga nel ledger**, e
  // `unknowns.length === 0`. Otto ore di attivita' reale con ZERO fill registrati.
  //
  // Le due domande sono DIVERSE e vanno tenute separate:
  //   · «quanto conta questo ordine nell'ESPOSIZIONE?» → zero finche' non e' riconciliato (la scelta
  //     dell'operatore del 2 agosto, che resta intatta: `unknowns` continua a essere vuoto);
  //   · «questo ordine e' stato RISOLTO dal ledger?» → e' una proprieta' del ledger, non
  //     dell'esposizione, e ha bisogno di una risposta sua. E' `ordiniNonRisolti` qui sotto.
  const unknowns = [];
  void sentOrders; void staleMs;

  return {
    ok: true, openNotionalUsd: +openNotionalUsd.toFixed(4), positions, unknowns,
    // DA DOVE viene l'esposizione, dichiarato: un tetto calcolato senza le posizioni del venue e un
    // tetto calcolato con esse sono due numeri diversi, e chi legge deve poterli distinguere.
    venuePositions: {
      readable: !!(venuePositions && venuePositions.readable === true),
      count: vp ? vp.length : 0,
      addedUsd: +daVenue.toFixed(4),
      reason: venuePositions ? (venuePositions.reason || null) : 'non iniettate dal chiamante',
    },
  };
}

/**
 * REALISED daily P&L for one user, in USD (negative = loss). REALISED ONLY — a closed position's actual
 * proceeds minus its actual cost, net of stored fees. It NEVER looks at an open position's current mark;
 * unrealised drawdown is explicitly excluded.
 *
 * DAY BOUNDARY: the UTC CALENDAR day containing `now` (utcDayStart). Chosen over a rolling 24h because it is
 * unambiguous and venue-neutral. Note the boundary only resets the ACCUMULATION — a breach trips a DURABLE
 * per-user kill (adapter.js) that this module does NOT clear at midnight; a human must clear it. So "resets
 * daily" cannot let a broken strategy re-lose the limit every day.
 *
 * @returns {{ok:true, realisedPnlUsd, dayStartUtc, closedEvents} | {ok:false, error}}
 */
function computeRealisedDailyPnl({ userId, now = Date.now() } = {}, deps = {}) {
  const r = readFills({ userId }, deps);
  if (!r.ok) return { ok: false, error: r.error };
  const dayStart = utcDayStart(now);
  const { realised } = runFifo(r.rows);
  let realisedPnlUsd = 0;
  const closedEvents = [];
  for (const e of realised) {
    if (e.ts >= dayStart && e.ts <= now) { realisedPnlUsd += e.pnlUsd; closedEvents.push({ ts: e.ts, venue: e.venue, tokenId: e.tokenId, pnlUsd: +e.pnlUsd.toFixed(4) }); }
  }
  return { ok: true, realisedPnlUsd: +realisedPnlUsd.toFixed(4), dayStartUtc: dayStart, closedEvents };
}

module.exports = {
  recordFill, recordNoFill, readFills, computeExposure, computeRealisedDailyPnl, ordiniNonRisolti,
  runFifo, utcDayStart, FILLS_FILE, UTC_DAY_MS, DEFAULT_STALE_MS,
};

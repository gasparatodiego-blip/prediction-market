'use strict';
// lib/maker/auto-close.js — AUTOMATIC POSITION CLOSING: when a hand order fills, put the exit on the book
// at a fixed small profit instead of leaving inventory exposed to whatever the market does next.
//
// ─── HOW A POSITION IS CLOSED ON POLYMARKET (verified, not assumed) ─────────────────────────────────
// By SELLING the outcome token you already hold, on the same CLOB. The docs are explicit: "To sell your
// position, you give up an outcome token and receive payment in return", and a SELL order "gives outcome
// tokens in exchange for USDC" (docs.polymarket.com/trading/overview, /concepts/positions-tokens).
//
// It is NOT done by buying the opposite outcome. Holding 1 YES + 1 NO is a COMPLETE SET, worth exactly $1
// at resolution — that is a merge/redeem construct, not an exit, and it would double the capital tied up
// rather than release it. So the close order is a SELL of the very token the fill produced, at the same
// tokenId, for the size actually held.
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
//   • It never sells below break-even. See closeTargetPrice: the target is entry + CLOSE_PROFIT_CENTS,
//     snapped UP to the tick grid, and the band watcher may not walk it below that floor.
//   • Both switches must be on, both default OFF, both fail closed to OFF.

const { isAutoCloseEnabled, AUTO_CLOSE_SOURCE, CLOSE_PROFIT_CENTS, MIN_PROFIT_CENTS } = require('./auto-close-config');
// ── IL PIANO DI USCITA, UNIFICATO ─────────────────────────────────────────────────────────────────
// Sostituisce il vecchio «carico + 1 centesimo». Obiettivo PERCENTUALE (+1%), limitato dalla banda
// premiante, con un pavimento di rischio al 4% oltre cui l'uscita smette di inseguire il prezzo.
// Le due percentuali vivono in exit-plan.js, non qui: chi le cambia le trova insieme.
const { planExit, exitNeedsMove, EXIT_PROFIT_PCT, MAX_ADVERSE_PCT } = require('./exit-plan');
const { validateQuote } = require('./venue-rules');
const { inBand } = require('../rewards-live-band');

/**
 * THE CLOSE PRICE. entry + CLOSE_PROFIT_CENTS, snapped UP to the market's tick.
 *
 * SNAPPED UP, not to-nearest: rounding down would quietly deliver less profit than the constant promises,
 * and on a 0.001-tick market the difference is most of the target. The constant is expressed in CENTS
 * because the intent is economic — one cent per share — while the tick differs per market (ten ticks here,
 * one tick on a 0.01 market).
 *
 * @returns {{price:number|null, profitCents:number|null, reason:string}}
 */
function closeTargetPrice({ entryPrice, tick, profitCents = CLOSE_PROFIT_CENTS } = {}) {
  const e = Number(entryPrice);
  const t = Number(tick);
  if (!Number.isFinite(e) || !(e > 0) || !Number.isFinite(t) || !(t > 0)) {
    return { price: null, profitCents: null, reason: 'prezzo di entry o tick non leggibili — nessun prezzo di chiusura viene inventato' };
  }
  const raw = e + profitCents / 100;
  // Snap UP to the grid. The tiny epsilon keeps a value already exactly on the grid from jumping a tick.
  const snapped = +(Math.ceil((raw - 1e-9) / t) * t).toFixed(10);
  const actual = +((snapped - e) * 100).toFixed(4);
  return {
    price: snapped,
    profitCents: actual,
    reason: `entry ${e} + ${profitCents}¢ = ${+raw.toFixed(6)}, arrotondato IN SU al tick ${t} → ${snapped} (profitto reale ${actual}¢/share)`,
  };
}

/**
 * Decide whether to place a closing SELL for ONE position.
 *
 * @param {object} args
 *   position   { tokenId, size, avgPrice }  — from the VENUE's positions read, never inferred
 *   restingOrders  the account's resting orders on this market (to detect a close already in place)
 *   rules      resolveMarketRules() shape
 *   book       'yes'|'no' — which book this token is
 * @returns {{action:'close'|'skip'|'already-covered', gate, reason, price, size, profitCents, inBand}}
 */
function decideClose({ position, restingOrders = [], rules, book, profitCents = CLOSE_PROFIT_CENTS } = {}) {
  const out = (action, gate, reason, extra = {}) => ({ action, gate, reason, price: null, size: null, profitCents: null, inBand: null, ...extra });
  const p = position || {};
  const size = Number(p.size);
  const entry = Number(p.avgPrice);
  if (!Number.isFinite(size) || !(size > 0)) return out('skip', 'no-position', 'nessuna posizione aperta su questo token');
  if (!Number.isFinite(entry) || !(entry > 0)) return out('skip', 'no-entry-price', 'prezzo medio di carico non leggibile dal venue — nessun target di chiusura calcolabile');
  if (!rules || rules.readable !== true) return out('skip', 'rules-unreadable', 'regole di venue non leggibili — nessuna chiusura viene piazzata');

  // ── ALREADY COVERED? A resting SELL on this token for at least the held size IS the close order. ──
  const covering = restingOrders.filter((o) => o && String(o.tokenId) === String(p.tokenId) && String(o.side || '').toUpperCase() === 'SELL');
  const coveredSize = covering.reduce((s, o) => s + (Number(o.sizeRemaining ?? o.size) || 0), 0);
  if (coveredSize + 1e-9 >= size) {
    return out('already-covered', null,
      `già coperta: ${covering.length} ordine/i di vendita a riposo per ${coveredSize} share contro una posizione di ${size}`,
      { size, coveredSize });
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
      clampedBy: plan.clampedBy, atRiskFloor: plan.atFloor, exitPct: plan.profitPct,
      riskFloorPrice: plan.floor, bandHiPrice: plan.bandHi });
}

/**
 * THE FLOOR FOR A RE-PRICED CLOSE. The band watcher may move a resting close order to keep it earning,
 * but it must never walk the exit down through break-even: a "closing" order that realises a loss is not
 * a close, it is a capitulation with extra steps. Returns the lowest price a close SELL may be moved to.
 */
function closeFloorPrice({ entryPrice, tick, minProfitCents = MIN_PROFIT_CENTS } = {}) {
  const t = closeTargetPrice({ entryPrice, tick, profitCents: minProfitCents });
  return t.price;
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

    for (const pos of mine) {
      const tok = String(pos.tokenId ?? pos.asset ?? '');
      const book = tok === String(rules.tokenIdNo) ? 'no' : 'yes';
      const d = decideClose({ position: { tokenId: tok, size: pos.size, avgPrice: pos.avgPrice }, restingOrders: resting.orders || [], rules, book });

      if (d.action === 'already-covered') { m.covered++; actions.push({ marketId, tokenId: tok, book, action: 'already-covered', reason: d.reason }); continue; }
      if (d.action === 'skip') {
        m.skipped++;
        actions.push({ marketId, tokenId: tok, book, action: 'skip', gate: d.gate, reason: d.reason });
        audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: `skip-${d.gate}`,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: d.reason });
        continue;
      }

      audit({ ts: t0, venue: 'polymarket', source: AUTO_CLOSE_SOURCE, op: 'auto-close', outcome: 'trigger',
        marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, reason: d.reason,
        requested: { book, side: 'SELL', tokenId: tok, price: d.price, size: d.size, entryPrice: pos.avgPrice, profitCents: d.profitCents, inBand: d.inBand } });

      let res;
      try {
        res = await deps.placeOrder({
          marketId, book, side: 'SELL', price: d.price, size: d.size,
          source: AUTO_CLOSE_SOURCE,
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

module.exports = { runAutoCloseCycle, decideClose, closeTargetPrice, closeFloorPrice, AUTO_CLOSE_SOURCE, CLOSE_PROFIT_CENTS };

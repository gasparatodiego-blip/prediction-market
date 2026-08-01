'use strict';
// lib/maker/fill-strategy.js — WHAT HAPPENS THE MOMENT AN ORDER FILLS.
//
// Three things at once, plus a stop over all of them:
//   1. TAKE-PROFIT   an exit goes on the book immediately, near the entry price.
//   2. REPLACEMENT   a new quote goes back on the same side at the same price: the fill consumed our
//                    liquidity, and the whole point of being a maker is that it is there again.
//   3. THE CEILING   unless the position accumulated on that market AND THAT SIDE has reached the
//                    capital the allocation planner assigned it — then the replacement is withheld and
//                    that side stays dark until the position comes back down. The exit still goes on.
//   4. STOP-LOSS     over all of it: drawdown measured on the WEIGHTED AVERAGE of everything accumulated
//                    on that market/side, not on the last fill. Past the threshold, the position is
//                    closed — but never blindly (see the thin-book section).
//
// ─── THE TRIGGER IS THE POSITION, NOT THE FILL EVENT ────────────────────────────────────────────────
// Same discipline lib/maker/auto-close.js already uses, for the same reasons: a fill event can be seen
// twice (a re-read, a restart, a partial then another partial), while a position either has an exit
// resting against it or does not. Reading state instead of reacting to events makes this idempotent by
// construction, self-healing after any refusal, and correct across partials without special cases.
//
// ─── IT ADDS NO AUTHORITY ───────────────────────────────────────────────────────────────────────────
// Every order it proposes goes out through the same placement path and the same gate chain as a hand
// order — manual ownership, the shared venue-rules guard, the per-order cap, the global kill switch, the
// adapter chain and the exchange's own validateOrder(). MANUAL_ORDER_PLACEMENT still decides whether
// anything is actually sent. Both switches default OFF and fail closed to OFF.
//
// ─── THIN-BOOK PROTECTION: A MARKETABLE LIMIT, NEVER A MARKET ORDER ─────────────────────────────────
// A market order on a thin book is an unbounded loss with a bounded intention. The stop exists to cap a
// 4% drawdown; filling it through an empty book could realise 20% and there is no mechanism in a market
// order that would stop that. So the stop NEVER sends a market order. Instead it:
//   • reads the book,
//   • walks the bids from the top down to a floor priced `maxSlippagePct` BELOW the best bid,
//   • sizes the exit to the depth that actually exists above that floor,
//   • sends a LIMIT at the floor — marketable, so it sweeps everything down to it and no further,
//   • and reports the remainder, which the next cycle re-attempts against the refilled book.
// The worst realised price is therefore bounded BY CONSTRUCTION rather than by hope, and a book that
// cannot absorb the position produces several bounded exits over several cycles instead of one
// unbounded one now. A position that cannot be closed at all is REPORTED, never silently abandoned.

const {
  isFillStrategyEnabled, paramsFor, FILL_STRATEGY_SOURCE,
} = require('./fill-strategy-config');
const { readAllocatedCapital } = require('./allocated-capital');
const { validateQuote } = require('./venue-rules');

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

/** Snap UP to the tick grid. Never to-nearest: rounding a target down quietly delivers less than promised. */
function snapUp(price, tick) {
  if (!fin(price) || !fin(tick) || !(tick > 0)) return null;
  return +(Math.ceil((price - 1e-9) / tick) * tick).toFixed(10);
}
/** Snap DOWN — used for a sell floor, where rounding up would make the floor unreachable. */
function snapDown(price, tick) {
  if (!fin(price) || !fin(tick) || !(tick > 0)) return null;
  return +(Math.floor((price + 1e-9) / tick) * tick).toFixed(10);
}

/**
 * THE TAKE-PROFIT PRICE.
 *
 * Two modes, and the default is the mirror:
 *   takeProfitCents = 0  → MIRROR. The entry rested `d` cents from the mid; the exit rests `d` cents from
 *                          the mid on the other side. exit = mid + (mid − entry) = 2·mid − entry.
 *                          This is the brief's default and the only one that needs no constant: it is
 *                          derived from the order that actually filled.
 *   takeProfitCents > 0  → FIXED. exit = entry + that many cents.
 * Either way the result is snapped UP to the market's own tick, so the realised profit is never less
 * than intended by a rounding, and it is never below entry.
 *
 * @returns {{price:number|null, mode:'mirror'|'fixed', gainCents:number|null, reason:string}}
 */
function takeProfitPrice({ entryPrice, mid, tick, takeProfitCents = 0 } = {}) {
  const e = Number(entryPrice), t = Number(tick);
  if (!fin(e) || !(e > 0) || !fin(t) || !(t > 0)) {
    return { price: null, mode: null, gainCents: null, reason: 'entry o tick non leggibili — nessun prezzo di uscita viene inventato' };
  }
  const mode = takeProfitCents === 0 ? 'mirror' : 'fixed';
  let raw;
  if (mode === 'mirror') {
    const m = Number(mid);
    if (!fin(m) || !(m > 0)) {
      return { price: null, mode, gainCents: null, reason: 'mid non leggibile: la distanza dell\'entry non è misurabile, quindi non c\'è nulla da specchiare' };
    }
    if (m <= e) {
      // The entry did not rest below the mid (it was at or above it): there is no distance to mirror.
      // Fall back to the smallest positive step the grid allows, and SAY so rather than invent a target.
      const one = snapUp(e + t, t);
      return { price: one, mode, gainCents: fin(one) ? +((one - e) * 100).toFixed(4) : null,
        reason: `l'entry ${e} non stava sotto il mid ${m}: niente da specchiare, uscita al primo tick sopra il carico (${one})` };
    }
    raw = 2 * m - e;
  } else {
    raw = e + takeProfitCents / 100;
  }
  let price = snapUp(raw, t);
  // Never below entry: a "take-profit" that realises a loss is not one.
  if (price != null && price <= e) price = snapUp(e + t, t);
  const gain = fin(price) ? +((price - e) * 100).toFixed(4) : null;
  return {
    price, mode, gainCents: gain,
    reason: mode === 'mirror'
      ? `specchiata: entry ${e} a ${(((Number(mid) - e) * 100)).toFixed(2)}¢ sotto il mid ${mid} → uscita a ${price} (+${gain}¢/share)`
      : `entry ${e} + ${takeProfitCents}¢ → ${price} (+${gain}¢/share)`,
  };
}

/**
 * THE CEILING, PER MARKET AND PER SIDE.
 *
 * `capUsd` is the capital the allocation planner assigned to this market (allocated-capital.js). It is
 * applied to EACH SIDE separately, as the brief requires: YES and NO each get the full allocation as
 * their own ceiling, because they are two independent inventories.
 *
 * FAIL CLOSED. A null ceiling — unread, stale, or the market simply is not in the current plan — blocks
 * the replacement. "We could not read your ceiling" must never be spent as "you have no ceiling".
 *
 * @returns {{allow:boolean, gate:string|null, capUsd:number|null, usedUsd:number, headroomUsd:number|null, reason:string}}
 */
function positionCapVerdict({ capUsd, positionNotionalUsd, incomingNotionalUsd = 0 } = {}) {
  const used = fin(positionNotionalUsd) ? positionNotionalUsd : null;
  if (used == null) {
    return { allow: false, gate: 'position-unreadable', capUsd: fin(capUsd) ? capUsd : null, usedUsd: 0, headroomUsd: null,
      reason: 'esposizione corrente non leggibile dal venue — nessun ordine nuovo su questo lato' };
  }
  if (!fin(capUsd) || capUsd <= 0) {
    return { allow: false, gate: 'cap-unreadable', capUsd: null, usedUsd: used, headroomUsd: null,
      reason: 'tetto non leggibile dal piano di allocazione — fail closed: nessun ripiazzamento' };
  }
  const incoming = fin(incomingNotionalUsd) ? incomingNotionalUsd : 0;
  const headroom = +(capUsd - used).toFixed(6);
  if (used + incoming > capUsd + 1e-9) {
    return { allow: false, gate: 'cap-reached', capUsd, usedUsd: used, headroomUsd: headroom,
      reason: headroom <= 1e-9
        ? `tetto raggiunto: ${used.toFixed(2)} di ${capUsd.toFixed(2)} USD su questo lato — nessun ripiazzamento finché la posizione non scende`
        : `il ripiazzamento da ${incoming.toFixed(2)} supererebbe il tetto: restano ${headroom.toFixed(2)} di ${capUsd.toFixed(2)} USD` };
  }
  return { allow: true, gate: null, capUsd, usedUsd: used, headroomUsd: headroom,
    reason: `sotto il tetto: ${used.toFixed(2)} + ${incoming.toFixed(2)} di ${capUsd.toFixed(2)} USD` };
}

/**
 * The weighted-average entry over every accumulated fill on one market/side. This is what the stop-loss
 * measures against — NOT the last fill, which is the whole point: three fills at 60, 55 and 50 average to
 * something the last one alone never tells you.
 * @returns {{avgPrice:number|null, size:number, notionalUsd:number|null, reason:string}}
 */
function weightedAverageEntry(fills) {
  const list = Array.isArray(fills) ? fills.filter((f) => f && fin(f.price) && fin(f.size) && f.size > 0) : [];
  if (!list.length) return { avgPrice: null, size: 0, notionalUsd: null, reason: 'nessun fill misurato su questo lato' };
  const size = list.reduce((s, f) => s + f.size, 0);
  const notional = list.reduce((s, f) => s + f.price * f.size, 0);
  if (!(size > 0)) return { avgPrice: null, size: 0, notionalUsd: null, reason: 'size totale nulla' };
  return { avgPrice: +(notional / size).toFixed(10), size: +size.toFixed(10), notionalUsd: +notional.toFixed(10),
    reason: `${list.length} fill, ${size} share, carico medio ponderato ${+(notional / size).toFixed(6)}` };
}

/**
 * THE STOP. Drawdown measured on the weighted average, against the current mark.
 * @returns {{trigger:boolean, drawdownPct:number|null, thresholdPct:number, reason:string}}
 */
function decideStopLoss({ avgPrice, markPrice, stopLossPct } = {}) {
  const a = Number(avgPrice), m = Number(markPrice), th = Number(stopLossPct);
  if (!fin(th) || th <= 0) return { trigger: false, drawdownPct: null, thresholdPct: th, reason: 'soglia di stop non configurata' };
  if (!fin(a) || !(a > 0)) return { trigger: false, drawdownPct: null, thresholdPct: th, reason: 'carico medio non calcolabile — nessuno stop su un numero che non abbiamo' };
  if (!fin(m) || !(m > 0)) return { trigger: false, drawdownPct: null, thresholdPct: th, reason: 'mark non leggibile — nessuno stop al buio' };
  const dd = +(((a - m) / a) * 100).toFixed(6);
  if (dd < th) {
    return { trigger: false, drawdownPct: dd, thresholdPct: th,
      reason: dd <= 0 ? `nessun drawdown (${dd.toFixed(2)}%)` : `drawdown ${dd.toFixed(2)}% sotto la soglia ${th}%` };
  }
  return { trigger: true, drawdownPct: dd, thresholdPct: th,
    reason: `drawdown ${dd.toFixed(2)}% sul carico medio ${a} contro mark ${m} — oltre la soglia ${th}%` };
}

/**
 * THIN-BOOK PROTECTION. Plan the stop's exit against the book that actually exists.
 *
 * Walks the bids from the top down to a floor `maxSlippagePct` below the best bid, sums the depth above
 * that floor, and returns a MARKETABLE LIMIT at the floor sized to that depth. Never a market order —
 * see the header. The remainder is returned, not dropped, and the caller re-attempts it next cycle.
 *
 * @returns {{action:'exit'|'partial'|'none', size:number, limitPrice:number|null, remainder:number,
 *            bestBid:number|null, floorPrice:number|null, depthUsd:number|null, reason:string}}
 */
function planStopLossExit({ size, bids, tick, maxSlippagePct } = {}) {
  const want = Number(size);
  const slip = Number(maxSlippagePct);
  const levels = Array.isArray(bids) ? bids.filter((b) => b && fin(b.price) && fin(b.size) && b.size > 0) : [];
  const none = (reason, extra = {}) => ({ action: 'none', size: 0, limitPrice: null, remainder: fin(want) ? want : 0, bestBid: null, floorPrice: null, depthUsd: null, reason, ...extra });
  if (!fin(want) || want <= 0) return none('niente da chiudere');
  if (!levels.length) return none('book non leggibile o vuoto sul lato acquisto — nessuna uscita al buio, si ritenta al ciclo successivo');
  if (!fin(slip) || slip <= 0) return none('budget di slippage non configurato');

  const sorted = [...levels].sort((a, b) => b.price - a.price);   // best bid first
  const bestBid = sorted[0].price;
  const rawFloor = bestBid * (1 - slip / 100);
  const floorPrice = fin(tick) && tick > 0 ? snapDown(rawFloor, tick) : +rawFloor.toFixed(10);
  if (!fin(floorPrice) || floorPrice <= 0) return none('prezzo minimo accettabile non calcolabile', { bestBid });

  let avail = 0, depthUsd = 0;
  for (const l of sorted) {
    if (l.price < floorPrice - 1e-12) break;   // below the floor: outside the slippage budget
    avail += l.size;
    depthUsd += l.price * l.size;
  }
  if (avail <= 0) {
    return none(`nessuna profondità entro ${slip}% dal best bid ${bestBid} — si ritenta al ciclo successivo`, { bestBid, floorPrice });
  }

  const take = Math.min(want, avail);
  const remainder = +(want - take).toFixed(6);
  return {
    action: remainder > 1e-9 ? 'partial' : 'exit',
    size: +take.toFixed(6), limitPrice: floorPrice, remainder,
    bestBid, floorPrice, depthUsd: +depthUsd.toFixed(4),
    reason: remainder > 1e-9
      ? `book sottile: entro ${slip}% dal best bid ${bestBid} c'è profondità per ${+take.toFixed(4)} share su ${want}. Esco per quelle con un limite a ${floorPrice}; le restanti ${remainder} si ritentano al ciclo successivo — mai un ordine a mercato su un book che non le regge.`
      : `profondità sufficiente: ${want} share entro ${slip}% dal best bid ${bestBid}, limite aggressivo a ${floorPrice}`,
  };
}

/**
 * The whole decision for ONE market/side, composed. Pure: every input is a measured value handed in.
 *
 * @returns {{takeProfit:object|null, replacement:object|null, stop:object|null, cap:object, reason:string}}
 */
function decideOnFill({
  marketId, book, side = 'BUY',
  fills, position, mid, tick, minSize, maxSpreadCents,
  entryPrice, entrySize,
  capUsd, params, markPrice, bids,
} = {}) {
  const p = params || {};
  const wavg = weightedAverageEntry(fills);
  const heldSize = fin(position && position.size) ? position.size : wavg.size;
  const usedUsd = fin(wavg.notionalUsd) ? wavg.notionalUsd : (fin(heldSize) && fin(wavg.avgPrice) ? heldSize * wavg.avgPrice : null);

  // ── 4 · THE STOP COMES FIRST. If we are past the threshold, the answer is "get out", and re-arming a
  //        quote on a side we are trying to leave would be working against ourselves.
  const stopVerdict = decideStopLoss({ avgPrice: wavg.avgPrice, markPrice, stopLossPct: p.stopLossPct });
  if (stopVerdict.trigger) {
    const plan = planStopLossExit({ size: heldSize, bids, tick, maxSlippagePct: p.maxSlippagePct });
    return {
      takeProfit: null, replacement: null,
      stop: { ...stopVerdict, ...plan, avgPrice: wavg.avgPrice, heldSize },
      cap: { allow: false, gate: 'stop-loss', capUsd: fin(capUsd) ? capUsd : null, usedUsd: usedUsd ?? 0, headroomUsd: null,
        reason: 'stop-loss in corso: nessun ripiazzamento su un lato che stiamo chiudendo' },
      reason: `STOP: ${stopVerdict.reason} · ${plan.reason}`,
    };
  }

  // ── 1 · TAKE-PROFIT
  const tp = takeProfitPrice({ entryPrice, mid, tick, takeProfitCents: p.takeProfitCents });
  const tpSize = fin(entrySize) && entrySize > 0 ? entrySize : heldSize;
  let takeProfit = null;
  if (tp.price != null && fin(tpSize) && tpSize > 0) {
    const vq = validateQuote({ tick, scoringMid: mid, maxSpreadCents, minSize },
      { side: 'SELL', price: tp.price, size: tpSize });
    const codes = vq.valid ? [] : vq.reasons.map((r) => r.code);
    // OUT_OF_BAND is not a refusal to exit: it only means the exit will not ALSO earn rewards while it
    // waits. Getting out beats earning. Anything else is a real refusal.
    const blocked = codes.length > 0 && !codes.every((c) => c === 'OUT_OF_BAND');
    takeProfit = {
      side: 'SELL', price: tp.price, size: +tpSize.toFixed(6), mode: tp.mode, gainCents: tp.gainCents,
      blocked, gate: blocked ? `guard-${codes.join(',')}` : null, reason: blocked ? `uscita rifiutata dal guard condiviso (${codes.join(',')})` : tp.reason,
    };
  } else {
    takeProfit = { side: 'SELL', price: null, size: null, mode: tp.mode, gainCents: null, blocked: true, gate: 'no-target', reason: tp.reason };
  }

  // ── 2+3 · REPLACEMENT, subject to the ceiling
  const incoming = fin(entryPrice) && fin(entrySize) ? entryPrice * entrySize : null;
  const cap = positionCapVerdict({ capUsd, positionNotionalUsd: usedUsd, incomingNotionalUsd: incoming ?? 0 });
  let replacement = null;
  if (cap.allow && fin(entryPrice) && fin(entrySize) && entrySize > 0) {
    const vq = validateQuote({ tick, scoringMid: mid, maxSpreadCents, minSize },
      { side: 'BUY', price: entryPrice, size: entrySize });
    const codes = vq.valid ? [] : vq.reasons.map((r) => r.code);
    replacement = {
      side: 'BUY', book, price: entryPrice, size: +entrySize.toFixed(6),
      blocked: codes.length > 0, gate: codes.length ? `guard-${codes.join(',')}` : null,
      reason: codes.length ? `ripiazzamento rifiutato dal guard condiviso (${codes.join(',')})` : `ripiazzo ${entrySize} share a ${entryPrice}: il fill ha consumato la nostra liquidità, torna sul book`,
    };
  }

  return {
    takeProfit, replacement, stop: { ...stopVerdict, avgPrice: wavg.avgPrice, heldSize }, cap,
    reason: `${wavg.reason} · ${cap.reason}`,
  };
}

/**
 * One pass over the managed markets. Every side effect injected, so the tests drive whole scenarios with
 * no venue and no network. Returns what it did and, for everything it did NOT do, why.
 */
async function runFillStrategyCycle(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const t0 = now();
  const audit = typeof deps.audit === 'function' ? deps.audit : () => {};
  const markets = [];
  const actions = [];
  const done = (gate, reason) => ({ at: new Date(t0).toISOString(), ran: gate == null, gate, reason, markets, actions });

  const marketIds = Array.isArray(deps.marketIds) ? deps.marketIds : [];
  if (!marketIds.length) return done('no-markets', 'nessun mercato con la strategia sul fill abilitata');

  // The kill switch stops this exactly as it stops any placement: everything here is a NEW order.
  const kill = typeof deps.killStatus === 'function' ? deps.killStatus() : { effectivelyKilled: false, readable: true };
  if (kill.effectivelyKilled === true || kill.readable === false) {
    return done('kill', kill.readable === false
      ? 'stato del kill-switch NON leggibile — trattato come attivo: nessun ordine'
      : 'kill-switch ATTIVO — nessun ordine');
  }

  for (const marketId of marketIds) {
    const m = { marketId, gate: null, reason: null, sides: [] };
    const en = (deps.isEnabled || isFillStrategyEnabled)(marketId, deps.configDeps || {});
    if (!en.enabled) { m.gate = 'disabled'; m.reason = en.reason; markets.push(m); continue; }

    const mm = typeof deps.isManual === 'function' ? deps.isManual(marketId) : { manual: true, readable: true };
    if (!mm.readable || !mm.manual) {
      m.gate = mm.readable ? 'manual-mode-inactive' : 'manual-mode-unreadable';
      m.reason = 'la strategia agisce solo dove il mercato è in gestione manuale';
      markets.push(m); continue;
    }

    const rules = typeof deps.resolveRules === 'function' ? deps.resolveRules(marketId) : null;
    if (!rules || rules.readable !== true) { m.gate = 'rules-unreadable'; m.reason = 'regole di venue non leggibili'; markets.push(m); continue; }

    const capRead = (deps.readCap || readAllocatedCapital)(marketId, deps.configDeps || {});
    const params = (deps.paramsFor || paramsFor)(marketId, deps.configDeps || {});

    let state;
    try { state = await deps.readSideState({ marketId }); }
    catch (e) { m.gate = 'state-read-failed'; m.reason = e.message; markets.push(m); continue; }
    if (!state || state.ok === false) { m.gate = 'state-read-failed'; m.reason = (state && state.reason) || 'lettura stato fallita'; markets.push(m); continue; }

    for (const side of state.sides || []) {
      const d = decideOnFill({
        marketId, book: side.book,
        fills: side.fills, position: side.position, mid: side.mid, tick: rules.tick,
        minSize: rules.minSize, maxSpreadCents: rules.maxSpreadCents,
        entryPrice: side.lastEntryPrice, entrySize: side.lastEntrySize,
        capUsd: capRead.capUsd, params, markPrice: side.markPrice, bids: side.bids,
      });
      const rec = { book: side.book, decision: d, placed: [] };

      const emit = async (kind, order) => {
        audit({ ts: t0, venue: 'polymarket', source: FILL_STRATEGY_SOURCE, op: kind, outcome: 'trigger',
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, requested: order, reason: d.reason });
        let res;
        try { res = await deps.placeOrder({ marketId, book: side.book, source: FILL_STRATEGY_SOURCE, ...order }); }
        catch (e) { rec.placed.push({ kind, ok: false, error: e.message }); return; }
        const ok = res && res.ok === true;
        rec.placed.push({ kind, ok, sent: res && res.sent === true, orderId: (res && res.orderId) || null, gate: (res && res.gate) || null, ...order });
        audit({ ts: t0, venue: 'polymarket', source: FILL_STRATEGY_SOURCE, op: kind,
          outcome: ok ? (res.sent ? 'sent' : 'dry-run-validated') : `reject-${(res && res.gate) || 'place'}`,
          marketRef: `cid_${String(marketId).replace(/^0x/, '')}`, requested: order,
          response: { ok, orderId: (res && res.orderId) || null }, latencyMs: now() - t0 });
      };

      if (d.stop && d.stop.trigger) {
        if (d.stop.action === 'none') {
          actions.push({ marketId, book: side.book, action: 'stop-deferred', reason: d.stop.reason });
        } else {
          await emit('stop-loss', { side: 'SELL', price: d.stop.limitPrice, size: d.stop.size, note: `stop-loss ${d.stop.drawdownPct}% · limite aggressivo` });
          if (d.stop.remainder > 0) actions.push({ marketId, book: side.book, action: 'stop-partial', remainder: d.stop.remainder, reason: d.stop.reason });
        }
      } else {
        if (d.takeProfit && !d.takeProfit.blocked && d.takeProfit.price != null) {
          await emit('take-profit', { side: 'SELL', price: d.takeProfit.price, size: d.takeProfit.size, note: `take-profit ${d.takeProfit.mode} (+${d.takeProfit.gainCents}¢)` });
        }
        if (d.replacement && !d.replacement.blocked) {
          await emit('replacement', { side: 'BUY', price: d.replacement.price, size: d.replacement.size, note: 'ripiazzamento liquidità dopo il fill' });
        } else if (!d.cap.allow) {
          actions.push({ marketId, book: side.book, action: 'replacement-withheld', gate: d.cap.gate, reason: d.cap.reason });
        }
      }
      m.sides.push(rec);
    }
    markets.push(m);
  }
  return { at: new Date(t0).toISOString(), ran: true, gate: null, reason: null, markets, actions, latencyMs: now() - t0 };
}

module.exports = {
  runFillStrategyCycle, decideOnFill,
  takeProfitPrice, positionCapVerdict, weightedAverageEntry, decideStopLoss, planStopLossExit,
  snapUp, snapDown, FILL_STRATEGY_SOURCE,
};

#!/usr/bin/env node
'use strict';
/**
 * funding-perpspot-realmaker.js — recompute perp-vs-spot economics with REAL maker fees.
 *
 * OFFLINE. Reads data/venue-maker-fees.json (fetched from public APIs by
 * scripts/venue-maker-fees.js) + the Jul 6-19 board history. Writes one file:
 * data/funding-perpspot-realmaker.json. Wired into no agent, API or dashboard.
 *
 * THE QUESTION: the perp-vs-spot lane fails on its SPOT TAKER leg (~79.5% of an ~8-day
 * breakeven). The theory was that a maker/zero spot leg would drop breakeven to ~1.6d and put
 * the durable subset over the line. This tests that with the REAL published rates.
 *
 * HONESTY CONTRACT
 *   - A venue whose maker rate is UNAVAILABLE on a public endpoint STAYS TAKER. Never assumed
 *     zero, never back-filled from a docs page. The count of opportunities that pins is reported.
 *   - Repo-documented maker rates (lib/funding-math.js comments: hyperliquid/aster/paradex/
 *     lighter/extended = 0, edgex .018, pacifica .015, apex .02, grvt -.0001) are used for the
 *     PERP leg only, and are marked as doc-sourced rather than API-sourced.
 *   - Survival is reported against BOTH bounds. Venue-keyed (coin|perp|spot) is the LOWER bound
 *     and is what a real position keyed to a venue actually experiences. Coin-alone is an UPPER
 *     bound that ignores venue flips. Two independent scripts agree on the lower bound (~0.5h)
 *     and DISAGREE on the upper bound, so no single upper-bound number is treated as settled.
 *   - A maker order that does not fill and crosses to taker reverts to taker economics; that
 *     downside is computed, not hand-waved.
 */
const fs = require('fs');
const { venueFeePct, spotVenueFeePct } = require('../lib/funding-math');

const FEES_FILE = 'data/venue-maker-fees.json';
const PERPSPOT_DIR = 'data/history/perp-spot';
const OUT = 'data/funding-perpspot-realmaker.json';
const GAP_MS = 35 * 60_000;
const FILL_H = 1;                 // a maker order needs at least this long to rest & fill

// Maker rates documented in lib/funding-math.js comments (doc-sourced, not API-sourced).
const DOC_PERP_MAKER = { hyperliquid: 0, aster: 0, paradex: 0, lighter: 0, extended: 0,
                         edgex: 0.018, pacifica: 0.015, apex: 0.02, grvt: -0.0001 };

const q = (s, p) => s.length ? [...s].sort((a, b) => a - b)[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';
const money = v => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
const out = [];
const say = s => { console.log(s); out.push(s); };

// ── real fee table ──────────────────────────────────────────────────────────
const feeDoc = JSON.parse(fs.readFileSync(FEES_FILE, 'utf8'));
const API_MAKER = {};   // `${venue}|${market}` -> pct
for (const r of feeDoc.results) {
  if (r.available && r.makerPct != null && r.market !== 'perp-crosscheck') API_MAKER[`${r.venue}|${r.market}`] = r.makerPct;
}
/** Effective per-leg fee %, and whether it is a real maker rate or a taker fallback. */
function perpFee(venue, useMaker) {
  const taker = venueFeePct(venue);
  if (!useMaker) return { pct: taker, maker: false, src: 'taker' };
  if (API_MAKER[`${venue}|perp`] != null) return { pct: API_MAKER[`${venue}|perp`], maker: true, src: 'api' };
  if (DOC_PERP_MAKER[venue] != null) return { pct: DOC_PERP_MAKER[venue], maker: true, src: 'doc' };
  return { pct: taker, maker: false, src: 'taker (maker UNAVAILABLE)' };
}
function spotFee(venue, useMaker) {
  const taker = spotVenueFeePct(venue);
  if (!useMaker) return { pct: taker, maker: false, src: 'taker' };
  if (API_MAKER[`${venue}|spot`] != null) return { pct: API_MAKER[`${venue}|spot`], maker: true, src: 'api' };
  return { pct: taker, maker: false, src: 'taker (maker UNAVAILABLE)' };
}

// ── board ───────────────────────────────────────────────────────────────────
function load(dir) {
  const o = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json') && !x.startsWith('_'))) {
    const a = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'));
    if (Array.isArray(a)) for (const s of a) if (s && Number.isFinite(s.t) && Array.isArray(s.rows)) o.push({ t: s.t, rows: s.rows });
  }
  o.sort((a, b) => a.t - b.t);
  return o;
}
function episodes(snaps, keyOf) {
  const open = new Map(), done = [];
  const first = snaps[0].t;
  for (const { t, rows } of snaps) {
    const seen = new Set();
    for (const r of rows) {
      const k = keyOf(r);
      if (!k) continue;
      const g = Number.isFinite(r.fundingPct8h) ? (r.fundingPct8h / 100) * 3 * 1000 : NaN;   // $/day per $1k
      if (!Number.isFinite(g) || g <= 0) continue;
      seen.add(k);
      let e = open.get(k);
      if (!e) { e = { k, startT: t, lastT: t, acc: 0, gr: [], caps: [], row: r, leftC: t === first }; open.set(k, e); }
      else { e.acc += (Number.isFinite(e.lg) ? e.lg : 0) * (t - e.lastT) / 86_400_000; e.lastT = t; }
      e.lg = g; e.gr.push(g);
      const c = r.capacityUsd ?? r.greenCapacityUsd ?? r.spotCapacityUsd;
      if (Number.isFinite(c) && c > 0) e.caps.push(c);
    }
    for (const [k, e] of open) if (!seen.has(k) && t - e.lastT > GAP_MS) { e.rightC = false; done.push(e); open.delete(k); }
  }
  for (const e of open.values()) { e.rightC = true; done.push(e); }
  for (const e of done) {
    e.durH = (e.lastT - e.startT) / 3600000; e.durD = e.durH / 24;
    e.cens = e.leftC || e.rightC;
    e.medG = q(e.gr, .5);
    e.hasCap = e.caps.length > 0; e.minCap = e.hasCap ? Math.min(...e.caps) : NaN;
  }
  return done;
}

const snaps = load(PERPSPOT_DIR);
const eps = episodes(snaps, r => (r.coin && r.shortVenue && r.spotVenueSuggested) ? `${r.coin}|${r.shortVenue}|${r.spotVenueSuggested}` : null);
const epsCoin = episodes(snaps, r => r.coin || null);

// price each episode both ways
for (const e of eps) {
  const [coin, pv, sv] = e.k.split('|');
  e.coin = coin; e.perpVenue = pv; e.spotVenue = sv;
  for (const mode of ['taker', 'maker']) {
    const useMaker = mode === 'maker';
    const p = perpFee(pv, useMaker), s = spotFee(sv, useMaker);
    const rtPct = 2 * (p.pct + s.pct);                 // open+close, both legs
    e[mode] = { perp: p, spot: s, rtPct, fee1k: rtPct * 10,
                beDays: e.medG > 0 ? (rtPct * 10) / e.medG : Infinity };
  }
  e.makerRealised = e.maker.perp.maker || e.maker.spot.maker;   // did ANY leg get a real maker rate
}

say('='.repeat(84));
say('PERP-VS-SPOT RECOMPUTE WITH REAL MAKER FEES');
say(`board snapshots ${snaps.length} · episodes ${eps.length} (venue-keyed) · ${epsCoin.length} (coin-keyed)`);
say('='.repeat(84));

say('\n--- REAL FEE TABLE (public APIs only; UNAVAILABLE = stays taker) ---');
say('venue     market  maker      taker     source');
for (const r of feeDoc.results) {
  say(`${r.venue.padEnd(9)} ${r.market.padEnd(7)} ${(r.makerPct == null ? 'UNAVAILABLE' : r.makerPct + '%').padEnd(11)}` +
      `${(r.takerPct == null ? '—' : r.takerPct + '%').padEnd(9)} ${r.available ? r.field : (r.note || '').slice(0, 46)}`);
}

// which spot venues does the lane actually use, and are any maker-able?
const spotUse = {}, perpUse = {};
for (const e of eps) { spotUse[e.spotVenue] = (spotUse[e.spotVenue] || 0) + 1; perpUse[e.perpVenue] = (perpUse[e.perpVenue] || 0) + 1; }
say('\n--- does the real table actually reach this lane? ---');
say('spot venues used by perp-vs-spot episodes:');
for (const [v, n] of Object.entries(spotUse).sort((a, b) => b[1] - a[1]))
  say(`  ${v.padEnd(10)} ${String(n).padStart(5)} episodes · spot maker ${API_MAKER[`${v}|spot`] != null ? API_MAKER[`${v}|spot`] + '% (API)' : 'UNAVAILABLE -> stays taker ' + spotVenueFeePct(v) + '%'}`);
const spotMakerable = eps.filter(e => e.maker.spot.maker).length;
say(`episodes whose SPOT leg gets a real maker rate: ${spotMakerable}/${eps.length} = ${pct(spotMakerable, eps.length)}`);
const perpMakerable = eps.filter(e => e.maker.perp.maker).length;
say(`episodes whose PERP leg gets a real maker rate: ${perpMakerable}/${eps.length} = ${pct(perpMakerable, eps.length)}`);

say('\n--- BREAKEVEN: real-taker baseline vs real-maker ---');
const beT = eps.map(e => e.taker.beDays).filter(Number.isFinite);
const beM = eps.map(e => e.maker.beDays).filter(Number.isFinite);
say(`taker  breakevenDays: p25 ${q(beT, .25).toFixed(2)} · median ${q(beT, .5).toFixed(2)} · p75 ${q(beT, .75).toFixed(2)}`);
say(`maker  breakevenDays: p25 ${q(beM, .25).toFixed(2)} · median ${q(beM, .5).toFixed(2)} · p75 ${q(beM, .75).toFixed(2)}`);
say(`=> median breakeven ${q(beT, .5).toFixed(2)}d -> ${q(beM, .5).toFixed(2)}d ` +
    `(${(100 * (1 - q(beM, .5) / q(beT, .5))).toFixed(1)}% reduction). Theory predicted 8.0d -> 1.6d.`);
const rtT = q(eps.map(e => e.taker.rtPct), .5), rtM = q(eps.map(e => e.maker.rtPct), .5);
say(`median round-trip fee: taker ${rtT.toFixed(4)}% -> maker ${rtM.toFixed(4)}% of one leg's notional`);
const spotShare = q(eps.map(e => 2 * e.maker.spot.pct / e.maker.rtPct), .5);
say(`spot leg's share of the REAL-MAKER round trip: ${(100 * spotShare).toFixed(1)}%`);

say('\n--- SURVIVAL (both bounds) ---');
const cv = eps.filter(e => !e.cens).map(e => e.durH);
const cc = epsCoin.filter(e => !e.cens).map(e => e.durH);
say(`venue-keyed (LOWER bound, what a venue-pinned position lives): median ${q(cv, .5).toFixed(2)}h · >4d ${pct(eps.filter(e => e.durH >= 96).length, eps.length)}`);
say(`coin-keyed  (UPPER bound, ignores venue flips):                median ${q(cc, .5).toFixed(2)}h · >4d ${pct(epsCoin.filter(e => e.durH >= 96).length, epsCoin.length)}`);
say(`NOTE: a second independent script measured the coin-keyed median at 33.4h. The two disagree`);
say(`because of different gap-bridging rules, so no single upper bound is treated as settled.`);

say('\n--- PROFITABLE SET: real-maker breakeven < actual survival ---');
const prof = eps.filter(e => Number.isFinite(e.maker.beDays) && e.maker.beDays < e.durD);
const profT = eps.filter(e => Number.isFinite(e.taker.beDays) && e.taker.beDays < e.durD);
say(`taker: ${profT.length}/${eps.length} = ${pct(profT.length, eps.length)}`);
say(`maker: ${prof.length}/${eps.length} = ${pct(prof.length, eps.length)}`);
const unfilled = prof.filter(e => e.durH < FILL_H);
say(`of the maker set, survival < ${FILL_H}h fill window (forfeited): ${unfilled.length} -> ${prof.length - unfilled.length} tradable`);

function pnl(set, ticket, mode) {
  let net = 0, gross = 0, fees = 0, w = 0, l = 0, noCap = 0;
  for (const e of set) {
    const size = e.hasCap ? Math.min(ticket, e.minCap) : (ticket > 1000 ? (noCap++, ticket) : ticket);
    const sc = size / 1000;
    const g = e.acc * sc, f = e[mode].fee1k * sc;
    gross += g; fees += f; net += g - f; (g - f > 0) ? w++ : l++;
  }
  return { net, gross, fees, trades: w + l, w, l, noCap };
}
const tradable = prof.filter(e => e.durH >= FILL_H);
say('\n--- NET P&L (enter first appearance, hold to board exit, round trip paid once) ---');
say('  rule                                    ticket  trades      gross       fees         NET');
for (const [lbl, set, mode] of [
  ['ALL episodes, taker', eps, 'taker'],
  ['ALL episodes, real-maker', eps, 'maker'],
  ['profitable set (maker be<surv)', tradable, 'maker'],
  ['same set BUT maker fails -> taker', tradable, 'taker'],
]) {
  for (const tk of [1000, 10000]) {
    const r = pnl(set, tk, mode);
    say(`  ${lbl.padEnd(38)} ${('$' + tk / 1000 + 'k').padStart(6)}  ${String(r.trades).padStart(6)}  ${money(r.gross).padStart(10)}  ${('-$' + r.fees.toFixed(2)).padStart(10)}  ${money(r.net).padStart(11)}`);
  }
}

// capital
const ev = [];
for (const e of tradable) { ev.push([e.startT, 1]); ev.push([e.lastT, -1]); }
ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
let cur = 0, peak = 0;
for (const [, d] of ev) { cur += d; if (cur > peak) peak = cur; }
const spanD = (snaps[snaps.length - 1].t - snaps[0].t) / 86400000;
say('\n--- CAPITAL-ADJUSTED (the honest denominator) ---');
for (const tk of [1000, 10000]) {
  const r = pnl(tradable, tk, 'maker');
  const cap = peak * 2 * tk;
  const pctWin = cap > 0 ? 100 * r.net / cap : NaN;
  const yr = pctWin * 365 / spanD;
  say(`  $${tk / 1000}k/leg: peak concurrent ${peak} positions -> capital $${cap.toLocaleString()} · net ${money(r.net)} ` +
      `= ${pctWin.toFixed(4)}% over ${spanD.toFixed(2)}d = ${yr > 200 ? '>200%/yr (capped, NOT guaranteed)' : yr.toFixed(2) + '%/yr run-rate, NOT guaranteed'}`);
}
const byCoin = {}, byV = {};
for (const e of tradable) { byCoin[e.coin] = (byCoin[e.coin] || 0) + 1; byV[e.perpVenue] = (byV[e.perpVenue] || 0) + 1; }
const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}(${v})`).join(', ');
say(`\nconcentration: ${tradable.length} tradable · coins ${Object.keys(byCoin).length} · perp venues ${Object.keys(byV).length}`);
say(`  coins:  ${top(byCoin)}`);
say(`  venues: ${top(byV)}`);
const durable = tradable.filter(e => e.durH >= 24);
say(`  surviving >=1 day: ${durable.length}${durable.length < 5 ? '   <5 INDEPENDENT DURABLE -> ANECDOTE, not evidence' : ''}`);

fs.writeFileSync(OUT, JSON.stringify({
  kind: 'funding-perpspot-realmaker', generatedAt: new Date().toISOString(),
  feeSource: FEES_FILE, window: { from: new Date(snaps[0].t).toISOString(), to: new Date(snaps[snaps.length - 1].t).toISOString() },
  episodes: eps.length, spotMakerable, perpMakerable,
  breakevenDaysMedian: { taker: q(beT, .5), maker: q(beM, .5) },
  profitable: { taker: profT.length, maker: prof.length, tradable: tradable.length, durable: durable.length },
  peakConcurrent: peak,
  report: out,
}, null, 2));
say(`\nwrote ${OUT}`);

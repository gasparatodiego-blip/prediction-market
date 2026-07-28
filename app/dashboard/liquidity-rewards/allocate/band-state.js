'use strict';
// app/dashboard/liquidity-rewards/allocate/band-state.js
//
// Pure band-edge state machine for the allocation table. This is the CANONICAL implementation, imported by
// RewardsAllocatePanel (client-safe: no React, no node builtins, no dynamic require — so webpack bundles it
// cleanly) AND exercised by selfcheckBandState() in plain node. It reads no key, builds no order.
//
// A maker quote earns iff its distance from mid is within the reward band radius (maxSpread/2). Widening does
// NOT decay the reward — one tick past the radius removes it ENTIRELY. For a row quoting at `offsetTicks`
// (offset in this market's own ticks), this returns:
//   headroomTicks : whole +1-tick steps until the reward zeroes (1 = the very NEXT step crosses the edge)
//   headroomCents : literal cents from the current quote to the band edge (radius − distance; <0 when out)
//   state         : 'comfortable' (≥2 steps of room) | 'edge' (next step zeroes) | 'out' (already zero)
//                 | 'unknown' (band radius or tick unreadable — safety CANNOT be asserted)

function fin(x) { return typeof x === 'number' && Number.isFinite(x); }

function bandStateFor(maxSpreadCents, tick, offsetTicks) {
  const tickCents = fin(tick) && tick > 0 ? tick * 100 : null;
  const radiusCents = fin(maxSpreadCents) ? maxSpreadCents / 2 : null;
  // UNKNOWN fails closed: an unreadable band is never presented as safe.
  if (radiusCents == null || tickCents == null) {
    return { state: 'unknown', headroomTicks: null, headroomCents: null, maxInBandTicks: null, radiusCents, tickCents, offsetCents: null };
  }
  const offsetCents = offsetTicks * tickCents;
  const maxInBandTicks = Math.floor(radiusCents / tickCents + 1e-9); // largest offset (ticks) still inside the band
  const headroomCents = radiusCents - offsetCents;                   // cents to the edge (negative when already out)
  const headroomTicks = maxInBandTicks - offsetTicks + 1;            // whole +1 presses until the reward zeroes
  let state;
  if (offsetCents > radiusCents + 1e-9) state = 'out';              // already past the edge → reward zero
  else if (headroomTicks <= 1) state = 'edge';                     // the very next +1 step crosses
  else state = 'comfortable';                                      // ≥2 steps of room
  return { state, headroomTicks, headroomCents, maxInBandTicks, radiusCents, tickCents, offsetCents };
}

// Selfcheck — one assertion per state, each independent. No node builtins (inline assert) so this file stays
// safe to import into the client bundle. Run: node -e "require('./app/dashboard/liquidity-rewards/allocate/band-state').selfcheckBandState()"
function selfcheckBandState() {
  let n = 0;
  const ok = (name, cond) => { if (!cond) throw new Error('BANDSTATE SELFCHECK FAIL: ' + name); console.log('  ✓ ' + name); n++; };
  // band 4.5¢ → radius 2.25¢, tick 0.01 → 1¢/tick, maxInBandTicks = floor(2.25/1) = 2
  const a = bandStateFor(4.5, 0.01, 1); // 1¢: next → 2¢ (in), then 3¢ (out) ⇒ 2 steps to zero
  ok('offset 1 tick → COMFORTABLE, 2 ticks of headroom', a.state === 'comfortable' && a.headroomTicks === 2 && Math.abs(a.headroomCents - 1.25) < 1e-9);
  const b = bandStateFor(4.5, 0.01, 2); // 2¢: next → 3¢ (out) ⇒ 1 step to zero
  ok('offset 2 ticks → AT THE EDGE, next step zeroes', b.state === 'edge' && b.headroomTicks === 1);
  const c = bandStateFor(4.5, 0.01, 3); // 3¢ > 2.25¢ radius
  ok('offset 3 ticks → OUT OF BAND, headroom cents negative', c.state === 'out' && c.headroomCents < 0);
  const d = bandStateFor(null, 0.01, 1); // unreadable band radius
  ok('null maxSpread → UNKNOWN, headroom “—”, never asserted safe', d.state === 'unknown' && d.headroomTicks === null && d.headroomCents === null);
  const e = bandStateFor(4.5, null, 1); // unreadable tick
  ok('null tick → UNKNOWN (distinct from in-band and out-of-band)', e.state === 'unknown');
  // a fine-tick market: band 3.5¢ → radius 1.75¢, tick 0.001 → 0.1¢/tick, maxInBandTicks = floor(1.75/0.1)=17
  const f = bandStateFor(3.5, 0.001, 1); // plenty of room
  ok('fine-tick (0.001) market → COMFORTABLE with many ticks of headroom', f.state === 'comfortable' && f.headroomTicks === 17);
  console.log('selfcheckBandState: ' + n + ' assertions passed');
  return n;
}

module.exports = { bandStateFor, selfcheckBandState };

'use strict';
// scripts/clob-ws-measure.js — measure the live CLOB market-channel feed against
// the old 15-min REST path on the SAME markets over the SAME window.
//
//   node scripts/clob-ws-measure.js [durationSec] [tokenId ...]
//
// With no token args it pulls the first few reward-eligible markets from
// data/liquidity-rewards.json (YES token only, to keep the sample readable).
//
// Reports, per asset: events observed by type, events/min, time-to-first-snapshot,
// event→local-recompute latency, distinct adjusted-mid values seen live, and how
// many of those band-relevant mid moves a 15-min REST poll would have missed.
// Read-only. No orders. No paid dependency (uses the already-present `ws`).

const fs = require('fs');
const path = require('path');
const { ClobWsClient } = require('../lib/clob-ws/client');
const { LiveBookStore } = require('../lib/clob-ws/live-book');
const { adjustedMid, parseOrders } = require('../lib/rewardScore');

const DATA_FILE = path.join(__dirname, '..', 'data', 'liquidity-rewards.json');
const REST_CADENCE_MS = 15 * 60_000; // the path we are replacing

function pctl(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function loadDefaultAssets(n = 2) {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return (d.markets || [])
      .filter(m => m.tokenId)
      .slice(0, n)
      .map(m => ({ assetId: String(m.tokenId), minSize: Number(m.rewardsMinSize || m.minSize || 1), maxSpread: Number(m.maxSpread) || null }));
  } catch { return []; }
}

async function main() {
  const durationSec = parseInt(process.argv[2], 10) || 75;
  const tokenArgs = process.argv.slice(3);
  const assets = tokenArgs.length
    ? tokenArgs.map(a => ({ assetId: a, minSize: 1, maxSpread: null }))
    : loadDefaultAssets(parseInt(process.env.NMKT, 10) || 2);

  if (!assets.length) { console.error('no assets to measure'); process.exit(1); }

  const store = new LiveBookStore();
  const stat = new Map(); // assetId -> {counts, latencies, mids:Set, firstSnapshotMs, midSeq:[]}
  for (const a of assets) stat.set(a.assetId, { counts: {}, latencies: [], mids: new Set(), midSeq: [], firstSnapshotMs: null, meta: a });

  const t0 = Date.now();
  const client = new ClobWsClient({ logger: (...a) => console.log('[ws]', ...a) });

  client.on('open', () => console.log(`[ws] open @ +${Date.now() - t0}ms`));
  client.on('event', (ev, now) => {
    const applyStart = process.hrtime.bigint();
    store.ingest(ev, now);
    // Recompute adjusted mid immediately (this is the "event → recomputed mid" path).
    const ids = ev.event_type === 'price_change'
      ? (ev.price_changes || []).map(p => String(p.asset_id))
      : [String(ev.asset_id)];
    for (const id of new Set(ids)) {
      const s = stat.get(id);
      if (!s) continue;
      s.counts[ev.event_type] = (s.counts[ev.event_type] || 0) + 1;
      if (ev.event_type === 'book' && s.firstSnapshotMs == null) s.firstSnapshotMs = now - t0;
      const b = store.getBook(id);
      if (b) {
        const bids = parseOrders(b.bids.map(o => ({ price: o.price, size: o.size })), true);
        const asks = parseOrders(b.asks.map(o => ({ price: o.price, size: o.size })), false);
        const mid = adjustedMid(bids, asks, s.meta.minSize, null);
        if (mid != null) {
          const r = Math.round(mid * 1000) / 1000;
          if (s.midSeq[s.midSeq.length - 1] !== r) s.midSeq.push(r);
          s.mids.add(r);
        }
      }
      // Server timestamp → local ingest latency (wire delay + our processing).
      const serverTs = parseInt(ev.timestamp, 10);
      if (Number.isFinite(serverTs) && serverTs > 1e12) s.latencies.push(now - serverTs);
      const applyUs = Number(process.hrtime.bigint() - applyStart) / 1000;
      s.recomputeUs = Math.max(s.recomputeUs || 0, applyUs);
    }
  });

  client.connect();
  client.subscribe(assets.map(a => a.assetId));

  await new Promise(r => setTimeout(r, durationSec * 1000));
  client.close();

  const windowMs = Date.now() - t0;
  const restSamples = Math.floor(windowMs / REST_CADENCE_MS) + 1; // t=0 sample + each 15-min tick

  console.log('\n================ CLOB WS vs 15-min REST — measured ================');
  console.log(`window: ${(windowMs / 1000).toFixed(0)}s   REST(15-min) would take ${restSamples} book sample(s) in this window\n`);
  for (const [id, s] of stat) {
    const total = Object.values(s.counts).reduce((a, b) => a + b, 0);
    const perMin = windowMs > 0 ? (total / (windowMs / 60_000)) : 0;
    const distinctMids = s.mids.size;
    const midMoves = Math.max(0, s.midSeq.length - 1);
    // A 15-min poll captures `restSamples` mid readings; every distinct live move
    // beyond those is a band-relevant move it never saw.
    const missedByRest = Math.max(0, distinctMids - restSamples);
    console.log(`asset …${id.slice(-8)}  (minSize=${s.meta.minSize}, maxSpread=${s.meta.maxSpread ?? '—'}¢)`);
    console.log(`  events: ${total} total  (${perMin.toFixed(1)}/min)  by type: ${JSON.stringify(s.counts)}`);
    console.log(`  time-to-first-snapshot: ${s.firstSnapshotMs != null ? s.firstSnapshotMs + 'ms' : 'NONE — no book event arrived'}`);
    console.log(`  event→mid latency: median ${pctl(s.latencies, 0.5) ?? '—'}ms  p90 ${pctl(s.latencies, 0.9) ?? '—'}ms  (samples ${s.latencies.length})`);
    console.log(`  local recompute worst: ${(s.recomputeUs || 0).toFixed(1)}µs`);
    console.log(`  adjusted-mid: ${distinctMids} distinct value(s), ${midMoves} live move(s)`);
    console.log(`  ⇒ 15-min REST would have MISSED ${missedByRest} of ${distinctMids} band-relevant mid value(s)\n`);
  }
  console.log('===================================================================');
  process.exit(0);
}

main().catch(e => { console.error('measure failed:', e); process.exit(1); });

// Shared: fetch a wallet's COMPLETE set of genuinely-OPEN Polymarket positions.
//
// WHY THIS EXISTS — data-api `/positions?user=<addr>` (no params) silently
// UNDER-COUNTS open positions two ways:
//   • sizeThreshold defaults to ~1  → small still-live holdings are dropped, and
//   • limit defaults to 100         → high-count wallets are truncated.
// A BTC Up/Down scalper or a market maker can hold dozens–thousands of open
// markets; the default fetch showed as few as 1. This walks Polymarket's OWN
// `redeemable=false` filter with `sizeThreshold=0`, paginated, so no truly-open
// position is missed.
//
// HONEST-ENGINE: only `redeemable === false && |size| > 0` counts as OPEN.
// redeemable-but-won positions are RESOLVED, not open — callers keep classifying
// those from their existing (unchanged) base fetch, so realized numbers never move.
// Extreme wallets (e.g. 1600+ open) are capped for display by currentValue; the
// TRUE observed count travels back so the UI can disclose "showing X of Y".

const DATA_API = 'https://data-api.polymarket.com';
const OPEN_PAGE = 500;            // data-api hard max page size
const OPEN_SCAN_MAX_PAGES = 4;    // scan up to 2000 open positions before flagging "capped"

// getJson(url) => Promise<Array>  — caller injects its own rate-limited fetch so
// this stays transport-agnostic (agent30 uses rlGet→{data}, agent20 uses rlJson).
async function fetchOpenPositions(getJson, addr, opts) {
  const maxKeep = (opts && opts.maxKeep) || 60;
  const all = [];
  let scanCapped = false;
  let ok = true;
  for (let page = 0; page < OPEN_SCAN_MAX_PAGES; page++) {
    const off = page * OPEN_PAGE;
    let batch;
    try {
      batch = await getJson(
        `${DATA_API}/positions?user=${addr}&redeemable=false&sizeThreshold=0&limit=${OPEN_PAGE}&offset=${off}`,
      );
    } catch (e) {
      if (page === 0) ok = false;   // couldn't fetch at all → signal caller to keep its base open set
      break;                        // partial pages: keep what we got, stop paging
    }
    if (!Array.isArray(batch)) { if (page === 0) ok = false; break; }
    for (const p of batch) {
      if (p && !p.redeemable && Math.abs(Number(p.size) || 0) > 0) all.push(p);
    }
    if (batch.length < OPEN_PAGE) break;                 // last page
    if (page === OPEN_SCAN_MAX_PAGES - 1) scanCapped = true; // more open beyond our scan budget
  }
  // Most significant first — mark-to-mid value — so a display cap keeps what matters.
  all.sort((a, b) => (Math.abs(Number(b.currentValue) || 0)) - (Math.abs(Number(a.currentValue) || 0)));
  return { ok, open: all.slice(0, maxKeep), openObserved: all.length, openScanCapped: scanCapped };
}

module.exports = { fetchOpenPositions, OPEN_PAGE, OPEN_SCAN_MAX_PAGES };

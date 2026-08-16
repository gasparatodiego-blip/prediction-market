'use strict';

// RWA commodities (beta) — canonical-underlying resolver + allow-list.
//
// Scope: COMMODITIES ONLY (gold / silver / oil), on ASTER + EXTENDED ONLY — the two
// venues with real, walkable commodity books (verified 2026-07-05). This is a pure
// string-mapping layer for OBSERVATION-mode display: it decides WHICH market a canonical
// key resolves to per venue. It changes NO funding/capacity/fee math.
//
// Excluded on purpose: Aster SHIELD* synthetic variants (SHIELDXAUUSDT…), Paradex
// commodity legs (empty books), stocks/indices/FX (deferred — need market-hours gating).
//
// Per-venue raw symbols sourced live from the Aster premiumIndex and Extended /info/markets
// lists on 2026-07-05 (do not guess): Aster commodities settle 4h; Extended settle 1h.
const RWA_COMMODITY = {
  XAU_GOLD:   { label: 'Gold',        aster: 'XAUUSDT', extended: 'XAU-USD' },
  XAG_SILVER: { label: 'Silver',      aster: 'XAGUSDT', extended: 'XAG-USD' },
  WTI_OIL:    { label: 'WTI Crude',   aster: 'CLUSDT',  extended: 'WTI-USD' },
  BRENT_OIL:  { label: 'Brent Crude', aster: 'BZUSDT',  extended: 'XBR-USD' },
};

const RWA_KEYS   = Object.keys(RWA_COMMODITY);
const RWA_VENUES = ['aster', 'extended'];

// reverse index: venue → rawSymbol → canonical key
const _reverse = { aster: {}, extended: {} };
for (const [key, m] of Object.entries(RWA_COMMODITY)) {
  _reverse.aster[m.aster]       = key;
  _reverse.extended[m.extended] = key;
}

function isRwaKey(coin) {
  return Object.prototype.hasOwnProperty.call(RWA_COMMODITY, coin);
}

// Map a venue's raw market symbol to its canonical commodity key (or null if it's not a
// tracked commodity). SHIELD* synthetic Aster variants are explicitly rejected.
function rwaCanonicalFor(venue, rawSymbol) {
  if (typeof rawSymbol !== 'string' || /SHIELD/i.test(rawSymbol)) return null;
  return (_reverse[venue] && _reverse[venue][rawSymbol]) || null;
}

// Map a canonical key back to the venue's raw market symbol (for depth/history fetches).
function rwaVenueSymbol(venue, canonicalKey) {
  const m = RWA_COMMODITY[canonicalKey];
  return (m && m[venue]) || null;
}

function rwaLabel(canonicalKey) {
  const m = RWA_COMMODITY[canonicalKey];
  return (m && m.label) || canonicalKey;
}

module.exports = { RWA_COMMODITY, RWA_KEYS, RWA_VENUES, isRwaKey, rwaCanonicalFor, rwaVenueSymbol, rwaLabel };

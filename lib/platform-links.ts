// lib/platform-links.ts — shared, honest deep-link builders for every tab.
//
// HONEST-ENGINE CONTRACT
//   Every function takes a REAL identifier already present in our data and returns
//   a well-formed URL on the source platform, or `null` when the id is missing,
//   empty, or of a shape we cannot map to a real page. We NEVER fabricate a slug,
//   guess a market page, or point at a login wall. A `null` means "render no link".
//
// URL patterns were verified by constructing each from a real id and HEAD-checking
// the result (see the task's STEP 0). Where a platform hard-rate-limits automated
// HEAD requests (Kalshi → 429), the URL is still built from the real ticker and is
// well-formed; only the automated 200-check was blocked.

// ── small guards ─────────────────────────────────────────────────────────────
function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length ? s : null;
}

function isHexId(s: string): boolean {
  // Polymarket conditionId / token id — a 0x-prefixed hex blob is NOT a URL slug.
  return /^0x[0-9a-fA-F]{6,}$/.test(s);
}

// ── Polymarket ───────────────────────────────────────────────────────────────
// Market/event page. Built from the human slug (real Gamma `slug` field).
// A raw conditionId (0x…) has no public event URL, so we return null rather than
// guess — the row simply renders no link.
export function polymarketMarketUrl(slugOrId: string | null | undefined): string | null {
  const s = clean(slugOrId);
  if (!s || isHexId(s)) return null;
  // Slugs are already url-safe; strip a leading slash or accidental full URL.
  const slug = s.replace(/^https?:\/\/[^/]+\/(?:event|market)\//i, '').replace(/^\/+/, '');
  if (!slug || isHexId(slug)) return null;
  return `https://polymarket.com/event/${slug}`;
}

// Polymarket trader profile. Address is an EVM 0x-address.
export function polymarketProfileUrl(address: string | null | undefined): string | null {
  const s = clean(address);
  if (!s || !/^0x[0-9a-fA-F]{40}$/.test(s)) return null;
  return `https://polymarket.com/profile/${s.toLowerCase()}`;
}

// ── Kalshi ───────────────────────────────────────────────────────────────────
// Market ticker shape: SERIES-EVENT-STRIKE, e.g. KXMAXSHIPSHORMUZ-26JUN30-AL60.
// Kalshi's public web route is /markets/<series_ticker_lowercased>, which lands on
// the exact market's series page. (HEAD-check blocked by Kalshi anti-bot → 429; URL
// is well-formed from the real ticker.)
export function kalshiMarketUrl(ticker: string | null | undefined): string | null {
  const s = clean(ticker);
  if (!s) return null;
  const series = s.split('-')[0].toLowerCase();
  if (!series) return null;
  return `https://kalshi.com/markets/${series}`;
}

// ── Deribit (dated futures / basis) ──────────────────────────────────────────
// instrument_name e.g. BTC-25JUN27 → /futures/<instrument_name>.
export function deribitInstrumentUrl(name: string | null | undefined): string | null {
  const s = clean(name);
  if (!s) return null;
  return `https://www.deribit.com/futures/${s}`;
}

// ── Perp venues (Funding tab) ────────────────────────────────────────────────
// venue = short/long exchange key (lowercased); symbol = bare coin ticker (BTC…).
// Only venues whose perp URL we could verify are mapped; anything else → null so the
// leg renders no link rather than a fabricated one.
type PerpBuilder = (coin: string) => string;
const PERP: Record<string, PerpBuilder> = {
  binance:     c => `https://www.binance.com/en/futures/${c}USDT`,
  bybit:       c => `https://www.bybit.com/trade/usdt/${c}USDT`,
  okx:         c => `https://www.okx.com/trade-swap/${c.toLowerCase()}-usdt-swap`,
  bitget:      c => `https://www.bitget.com/futures/usdt/${c}USDT`,
  gateio:      c => `https://www.gate.io/futures/USDT/${c}_USDT`,
  hyperliquid: c => `https://app.hyperliquid.xyz/trade/${c}`,
  dydx:        c => `https://dydx.trade/trade/${c}-USD`,
  paradex:     c => `https://app.paradex.trade/trade/${c}-USD-PERP`,
  apex:        c => `https://pro.apex.exchange/trade/${c}USDT`,
  aster:       c => `https://www.asterdex.com/en/futures/${c}USDT`,
  extended:    c => `https://app.extended.exchange/trade/${c}-USD`,
  lighter:     c => `https://app.lighter.xyz/trade/${c}`,
  // edgex / grvt / pacifica: URL scheme unverified → intentionally omitted (null).
};

export function venuePerpUrl(venue: string | null | undefined, symbol: string | null | undefined): string | null {
  const v = clean(venue);
  const c = clean(symbol);
  if (!v || !c) return null;
  const key = v.toLowerCase().replace(/[\s_-]/g, '');
  const build = PERP[key];
  if (!build) return null;
  return build(c.toUpperCase());
}

// ── Spot venues (Perp vs Spot / carry tab) ───────────────────────────────────
// The carry trade buys spot on a major. Only venues whose spot URL scheme we could
// verify are mapped; anything else → null so the leg renders no link, never a
// fabricated one. venue = spot exchange key (lowercased); coin = bare ticker (BTC…).
type SpotBuilder = (coin: string) => string;
const SPOT: Record<string, SpotBuilder> = {
  binance: c => `https://www.binance.com/en/trade/${c}_USDT?type=spot`,
  okx:     c => `https://www.okx.com/trade-spot/${c.toLowerCase()}-usdt`,
  bybit:   c => `https://www.bybit.com/en/trade/spot/${c}/USDT`,
  gateio:  c => `https://www.gate.io/trade/${c}_USDT`,
};

export function venueSpotUrl(venue: string | null | undefined, symbol: string | null | undefined): string | null {
  const v = clean(venue);
  const c = clean(symbol);
  if (!v || !c) return null;
  const key = v.toLowerCase().replace(/[\s_-]/g, '');
  const build = SPOT[key];
  if (!build) return null;
  return build(c.toUpperCase());
}

// ── Dated-future venues (Carry / Basis tab) ──────────────────────────────────
// Basis rows carry venueKey + contract (the real exchange instrument id). Deribit,
// OKX, and Binance delivery all take the contract id directly in the path.
export function venueFutureUrl(venueKey: string | null | undefined, contract: string | null | undefined): string | null {
  const v = clean(venueKey);
  const c = clean(contract);
  if (!v || !c) return null;
  const key = v.toLowerCase().replace(/[\s_-]/g, '');
  switch (key) {
    case 'deribit':          return deribitInstrumentUrl(c);
    case 'okx':              return `https://www.okx.com/trade-futures/${c.toLowerCase()}`;
    case 'bybit':            // Bybit USDT-M linear delivery (BTCUSDT-25SEP26)
    case 'bybitusdtm':       return `https://www.bybit.com/trade/usdt/futures/${c.toUpperCase()}`;
    case 'coinm':            // Binance COIN-M delivery (BTCUSD_261225)
    case 'usdtm':            // Binance USDT-M delivery (BTCUSDT_260925)
    case 'binancecoinm':
    case 'binanceusdtm':     return `https://www.binance.com/en/delivery/${c}`;
    default:                 return null;
  }
}

// ── Light unit checks (run via `npx tsx lib/platform-links.check.ts`) ─────────
// Exported so the check script can assert against a couple of known real ids.
export function _platformLinksSelfTest(): void {
  const eq = (got: string | null, want: string | null, label: string) => {
    if (got !== want) throw new Error(`FAIL ${label}\n  got:  ${got}\n  want: ${want}`);
  };
  // Polymarket
  eq(polymarketMarketUrl('putin-out-before-2027'), 'https://polymarket.com/event/putin-out-before-2027', 'poly slug');
  eq(polymarketMarketUrl('0x6bd56627aa21311850825edb27e53434a0e17a4f782be0086bc07f71eee00d0d'), null, 'poly conditionId → null');
  eq(polymarketMarketUrl(''), null, 'poly empty → null');
  eq(polymarketProfileUrl('0xeac77136cd77872e4a606367ff65b9c9f2e9953d'), 'https://polymarket.com/profile/0xeac77136cd77872e4a606367ff65b9c9f2e9953d', 'poly profile');
  eq(polymarketProfileUrl('not-an-address'), null, 'poly bad address → null');
  // Kalshi
  eq(kalshiMarketUrl('KXMAXSHIPSHORMUZ-26JUN30-AL60'), 'https://kalshi.com/markets/kxmaxshipshormuz', 'kalshi ticker');
  eq(kalshiMarketUrl(null), null, 'kalshi null → null');
  // Deribit / basis
  eq(deribitInstrumentUrl('BTC-25JUN27'), 'https://www.deribit.com/futures/BTC-25JUN27', 'deribit');
  eq(venueFutureUrl('DERIBIT', 'BTC-25JUN27'), 'https://www.deribit.com/futures/BTC-25JUN27', 'basis deribit');
  eq(venueFutureUrl('OKX', 'BTC-USD-261225'), 'https://www.okx.com/trade-futures/btc-usd-261225', 'basis okx');
  eq(venueFutureUrl('BYBIT', 'BTCUSDT-25SEP26'), 'https://www.bybit.com/trade/usdt/futures/BTCUSDT-25SEP26', 'basis bybit');
  eq(venueFutureUrl('COINM', 'BTCUSD_261225'), 'https://www.binance.com/en/delivery/BTCUSD_261225', 'basis binance coin-m');
  eq(venueFutureUrl('USDTM', 'BTCUSDT_260925'), 'https://www.binance.com/en/delivery/BTCUSDT_260925', 'basis binance usdt-m');
  eq(venueFutureUrl('bitmex', 'XBTUSD'), null, 'basis unknown venue → null');
  // Perps
  eq(venuePerpUrl('binance', 'BTC'), 'https://www.binance.com/en/futures/BTCUSDT', 'perp binance');
  eq(venuePerpUrl('okx', 'eth'), 'https://www.okx.com/trade-swap/eth-usdt-swap', 'perp okx lowercases');
  eq(venuePerpUrl('hyperliquid', 'SOL'), 'https://app.hyperliquid.xyz/trade/SOL', 'perp hyperliquid');
  eq(venuePerpUrl('edgex', 'BTC'), null, 'perp unverified venue → null');
  eq(venuePerpUrl('binance', ''), null, 'perp empty symbol → null');
}

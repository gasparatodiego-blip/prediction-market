#!/usr/bin/env node
'use strict';

const fs    = require('fs');
const { httpGet: _sharedGet } = require('../lib/httpGet');

const OUT      = '/tmp/weather-markets.json';
const HB_FILE  = '/tmp/agent-heartbeats.json';
const INTERVAL = 600_000;  // 10 min

// Kalshi public API (no auth for public markets)
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// Open-Meteo (free, no key needed) for forecast comparison
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

// Major cities for weather context
const CITIES = [
  { name: 'New York',    lat: 40.71, lon: -74.01 },
  { name: 'Los Angeles', lat: 34.05, lon: -118.24 },
  { name: 'Chicago',     lat: 41.88, lon: -87.63 },
  { name: 'Miami',       lat: 25.77, lon: -80.19 },
  { name: 'London',      lat: 51.51, lon: -0.13 },
];

const WEATHER_KEYWORDS = ['weather','temperature','rain','snow','hurricane','tornado','storm','heat','cold','wind','flood','drought','precipitation','celsius','fahrenheit','degrees','climate'];

function beat() {
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb['agent13-weather'] = Date.now();
  try { fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2)); } catch {}
}

function get(url) {
  return _sharedGet(url, { timeoutMs: 15_000, headers: { 'User-Agent': 'prediction-arb-scanner/1.0', 'Accept': 'application/json' } })
    .then(r => ({ status: r.status, data: r.data }))
    .catch(e => { console.error('[weather] GET error:', e.message); return { status: 0, data: null }; });
}

// ── Kalshi weather markets ─────────────────────────

async function fetchKalshiWeatherMarkets() {
  const markets = [];

  // Search for weather-related markets via Kalshi's event series
  const { status, data } = await get(`${KALSHI_BASE}/markets?limit=200&status=open`);
  if (status !== 200 || !Array.isArray(data?.markets)) {
    console.log(`[weather] Kalshi markets HTTP ${status}`);
    return markets;
  }

  for (const m of data.markets) {
    const text = ((m.title ?? '') + ' ' + (m.subtitle ?? '') + ' ' + (m.category ?? '')).toLowerCase();
    if (!WEATHER_KEYWORDS.some(kw => text.includes(kw))) continue;

    markets.push({
      id:          m.ticker ?? m.id,
      title:       m.title ?? m.subtitle ?? m.ticker,
      subtitle:    m.subtitle ?? '',
      category:    m.category ?? 'weather',
      probability: m.last_price != null ? Math.round(m.last_price * 100) : null,
      yesPrice:    m.yes_ask  ?? m.last_price ?? null,
      noPrice:     m.no_ask   ?? null,
      volume:      m.volume   ?? m.dollar_volume ?? null,
      openInterest: m.open_interest ?? null,
      expiresAt:   m.close_time ?? m.expected_expiration_time ?? null,
      url:         `https://kalshi.com/markets/${m.ticker ?? m.id}`,
      source:      'kalshi',
    });
  }

  console.log(`[weather] Kalshi: found ${markets.length} weather markets out of ${data.markets.length}`);
  return markets;
}

// ── Open-Meteo forecast ────────────────────────────

async function fetchForecasts() {
  const forecasts = [];
  for (const city of CITIES) {
    const url = `${OPEN_METEO_BASE}?latitude=${city.lat}&longitude=${city.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&forecast_days=7&timezone=auto`;
    const { status, data } = await get(url);
    if (status !== 200 || !data?.daily) continue;

    const d = data.daily;
    const days = (d.time ?? []).map((date, i) => ({
      date,
      maxTempF:     d.temperature_2m_max?.[i] ?? null,
      minTempF:     d.temperature_2m_min?.[i] ?? null,
      precipIn:     d.precipitation_sum?.[i] ?? null,
      precipProbPct: d.precipitation_probability_max?.[i] ?? null,
      maxWindMph:   d.wind_speed_10m_max?.[i] ?? null,
    }));

    forecasts.push({ city: city.name, lat: city.lat, lon: city.lon, days });
  }
  return forecasts;
}

async function poll() {
  console.log('[weather] Fetching Kalshi weather markets + Open-Meteo forecasts…');

  const [markets, forecasts] = await Promise.all([
    fetchKalshiWeatherMarkets(),
    fetchForecasts(),
  ]);

  const output = {
    fetchedAt:  Date.now(),
    markets:    markets.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)),
    forecasts,
    totalMarkets: markets.length,
  };

  try {
    fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
    console.log(`[weather] Wrote ${markets.length} markets, ${forecasts.length} city forecasts → ${OUT}`);
  } catch (err) {
    console.error('[weather] write error:', err.message);
  }

  beat();
}

poll();
setInterval(poll, INTERVAL);

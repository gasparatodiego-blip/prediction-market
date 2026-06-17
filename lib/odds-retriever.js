'use strict';

// ── Abstract OddsRetriever interface ──────────────────────────────────────────
// The arb engine and agent only call getActiveSports() and getOdds().
// A future StreamingRetriever (SSE/WebSocket) or CachingRetriever implements
// these same two methods and drops in without touching downstream code.

class OddsRetriever {
  // Returns Promise<Array<{ key, title, active, has_outrights }>>
  async getActiveSports() { throw new Error('not implemented'); }

  // Returns Promise<{ events: NormalizedEvent[], creditsRemaining: number|null, creditsUsed: number|null }>
  //
  // NormalizedEvent schema:
  //   eventId:      string
  //   sport:        string        (sport_key)
  //   homeTeam:     string
  //   awayTeam:     string
  //   commenceTime: string        (ISO-8601)
  //   bookmakers:   Array<{ key: string, title: string, outcomes: Array<{ name: string, price: number }> }>
  //   fetchedAt:    number        (Unix ms)
  async getOdds(_sportKey, _markets, _regions) { throw new Error('not implemented'); }
}

// ── OddsAPI v4 concrete implementation ───────────────────────────────────────
const https = require('https');

function httpsGet(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'arb-scanner/1.0', 'Accept': 'application/json' },
      timeout: 15_000,
    }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data: null });
        }
      });
    });
    req.on('error', () => resolve({ status: 0, headers: {}, data: null }));
    req.on('timeout', function () { this.destroy(); resolve({ status: 0, headers: {}, data: null }); });
  });
}

class OddsApiRetriever extends OddsRetriever {
  constructor(apiKey) {
    super();
    this.apiKey = apiKey;
    this.base   = 'https://api.the-odds-api.com/v4';
  }

  // /sports uses 0 credits — safe to call on every poll cycle
  async getActiveSports() {
    const { status, data } = await httpsGet(
      `${this.base}/sports?apiKey=${this.apiKey}&all=false`
    );
    if (status !== 200 || !Array.isArray(data)) return [];
    return data;
  }

  async getOdds(sportKey, markets = ['h2h'], regions = ['eu', 'us']) {
    const url = [
      `${this.base}/sports/${sportKey}/odds/`,
      `?apiKey=${this.apiKey}`,
      `&regions=${regions.join(',')}`,
      `&markets=${markets.join(',')}`,
      `&oddsFormat=decimal`,
    ].join('');

    const { status, headers, data } = await httpsGet(url);

    const creditsRemaining = headers['x-requests-remaining'] != null
      ? parseInt(headers['x-requests-remaining'], 10) : null;
    const creditsUsed = headers['x-requests-used'] != null
      ? parseInt(headers['x-requests-used'], 10) : null;

    if (status !== 200 || !Array.isArray(data)) {
      return { events: [], creditsRemaining, creditsUsed };
    }

    const market  = markets[0];   // h2h
    const fetchedAt = Date.now();

    const events = data.map(ev => ({
      eventId:      ev.id,
      sport:        ev.sport_key,
      homeTeam:     ev.home_team,
      awayTeam:     ev.away_team,
      commenceTime: ev.commence_time,
      bookmakers:   (ev.bookmakers ?? []).map(bk => ({
        key:      bk.key,
        title:    bk.title,
        outcomes: (bk.markets ?? [])
          .find(m => m.key === market)
          ?.outcomes
          ?.map(oc => ({ name: oc.name, price: oc.price })) ?? [],
      })).filter(bk => bk.outcomes.length > 0),
      fetchedAt,
    }));

    return { events, creditsRemaining, creditsUsed };
  }
}

module.exports = { OddsRetriever, OddsApiRetriever };

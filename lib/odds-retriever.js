'use strict';

// ── Abstract OddsRetriever interface ──────────────────────────────────────────
// The arb engine and agent only call getActiveSports() and getOdds().
// A future StreamingRetriever (SSE/WebSocket) or CachingRetriever implements
// these same two methods and drops in without touching downstream code.

class OddsRetriever {
  // Returns Promise<Array<{ key, title, active, has_outrights }>>
  async getActiveSports() { throw new Error('not implemented'); }

  // Returns Promise<OddsResult>:
  //   events:          NormalizedEvent[]
  //   creditsRemaining: number | null
  //   creditsUsed:     number | null
  //   allExhausted:    boolean          — true when every key is below the credit floor
  //   activeKeyLabel:  string           — 'key#1' / 'key#2' for logging
  //
  // NormalizedEvent schema:
  //   eventId, sport, homeTeam, awayTeam, commenceTime (ISO-8601),
  //   bookmakers: [{ key, title, outcomes: [{ name, price }] }],
  //   fetchedAt (Unix ms)
  async getOdds(_sportKey, _markets, _regions) { throw new Error('not implemented'); }
}

// ── OddsAPI v4 concrete implementation — multi-key rotation ─────────────────
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
  // apiKeys: string | string[]  — first non-empty is primary, rest are fallbacks
  // creditFloor: pause/rotate when x-requests-remaining drops below this
  constructor(apiKeys, creditFloor = 50) {
    super();
    this.keys        = (Array.isArray(apiKeys) ? apiKeys : [apiKeys]).filter(Boolean);
    this.creditFloor = creditFloor;
    this.base        = 'https://api.the-odds-api.com/v4';

    // per-key state
    this._idx       = 0;                             // currently active key index
    this._credits   = new Array(this.keys.length).fill(null);   // last known remaining credits
    this._exhausted = new Array(this.keys.length).fill(false);  // true when below floor
  }

  get activeKey()      { return this.keys[this._idx]; }
  get activeKeyLabel() { return `key#${this._idx + 1}`; }
  get allExhausted()   { return this.keys.length === 0 || this._exhausted.every(Boolean); }

  // Call after each /odds response to update credit state and maybe rotate.
  // Returns true if rotation happened.
  _updateCredits(remaining) {
    if (remaining == null) return false;
    this._credits[this._idx] = remaining;
    if (remaining >= this.creditFloor) return false;

    // This key is below the floor — mark exhausted
    this._exhausted[this._idx] = true;
    console.log(`[odds] ${this.activeKeyLabel} hit credit floor (${remaining} remaining)`);

    // Try to rotate to next non-exhausted key
    for (let i = 1; i <= this.keys.length; i++) {
      const next = (this._idx + i) % this.keys.length;
      if (!this._exhausted[next]) {
        console.log(`[odds] rotating ${this.activeKeyLabel} → key#${next + 1}`);
        this._idx = next;
        return true;
      }
    }
    return false;  // all exhausted
  }

  // /sports costs 0 credits — safe every cycle
  async getActiveSports() {
    if (!this.activeKey) return [];
    const { status, data } = await httpsGet(
      `${this.base}/sports?apiKey=${this.activeKey}&all=false`
    );
    if (status !== 200 || !Array.isArray(data)) return [];
    return data;
  }

  async getOdds(sportKey, markets = ['h2h'], regions = ['eu', 'us']) {
    const empty = { events: [], creditsRemaining: null, creditsUsed: null,
                    allExhausted: this.allExhausted, activeKeyLabel: this.activeKeyLabel };

    if (this.allExhausted) {
      console.log('[odds] all keys exhausted — skipping call');
      return { ...empty, allExhausted: true };
    }

    const url = [
      `${this.base}/sports/${sportKey}/odds/`,
      `?apiKey=${this.activeKey}`,
      `&regions=${regions.join(',')}`,
      `&markets=${markets.join(',')}`,
      `&oddsFormat=decimal`,
    ].join('');

    const { status, headers, data } = await httpsGet(url);

    const creditsRemaining = headers['x-requests-remaining'] != null
      ? parseInt(headers['x-requests-remaining'], 10) : null;
    const creditsUsed = headers['x-requests-used'] != null
      ? parseInt(headers['x-requests-used'], 10) : null;

    const label = this.activeKeyLabel;  // capture before possible rotation
    this._updateCredits(creditsRemaining);

    if (status !== 200 || !Array.isArray(data)) {
      return { events: [], creditsRemaining, creditsUsed,
               allExhausted: this.allExhausted, activeKeyLabel: label };
    }

    const market    = markets[0];
    const fetchedAt = Date.now();
    const events    = data.map(ev => ({
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

    return { events, creditsRemaining, creditsUsed,
             allExhausted: this.allExhausted, activeKeyLabel: label };
  }
}

module.exports = { OddsRetriever, OddsApiRetriever };

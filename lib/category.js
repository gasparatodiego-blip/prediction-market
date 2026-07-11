'use strict';
// Shared Polymarket category taxonomy — single source of truth for agent20
// (leaderboard) and agent21 (copy-watcher / paper engine).
//
// HONEST ENGINE: real tags first, keyword fallback second, unknown → 'other'
// (never a guessed label).
//
//  • inferCategory(tags)   — for markets that carry REAL Polymarket event tags
//    (event.tags[].label). Each tag label is matched, most-specific-first,
//    against the canonical top-level taxonomy discovered from the live gamma
//    API (https://gamma-api.polymarket.com/tags + /events tags). Structural
//    tags ("Recurring", "Hide From New", "5M", "Up or Down", …) match no
//    category and are ignored.
//  • categoryFromText(...) — for open positions from /positions, which carry NO
//    tags, only title/slug/eventSlug text. Matches the same taxonomy over the
//    free text using WORD-BOUNDARY matching, so multi-word labels ("box office",
//    "prime minister", "strait of hormuz"), single tokens ("bitcoin"), and the
//    compact sport codes embedded in slugs ("atp-…", "fifwc-…", "ucl-…") all
//    resolve instead of falling through to 'other'.
//
// Canonical labels (the real Polymarket top-level categories used across the
// app): Mentions, Sports, Elections, Crypto, Weather, Health, Tech, Economy,
// Financials, Business, Pop Culture, World, Politics  (+ 'other' residual).
//
// ORDER MATTERS — categories are checked most-specific-first so overlaps resolve
// deterministically:
//   • Sports is checked early so weather-named teams (Heat, Storm, Thunder,
//     Hurricanes) and sport-slug codes resolve to Sports, not Weather/other.
//   • Elections before Politics (a nominee/primary market → Elections).
//   • World before generic Politics (Iran/Israel/Cuba geopolitics → World).
//   • Mentions first (tweet/post-count markets are their own Polymarket category).
// Word-boundary matching means only whole words match: '\bfed\b' matches "Fed"
// but not "federal"; '\bai\b' matches "AI" but not "maine". Collision-prone bare
// tokens ("who", "heat", "storm", "markets", "house") are deliberately omitted in
// favour of specific phrases ("heatwave", "stock market", "white house").

const CATS = [
  // ── Mentions (tweet/post-count markets — a real Polymarket category) ────────
  { label: 'Mentions',
    tags: ['mentions', 'tweet markets', 'tweets'],
    phrases: ['tweets from', 'posts from', 'tweet markets', 'number of tweets',
      'number of posts', 'mentions of'] },

  // ── Sports (incl. esports; checked early for weather-named teams + slug codes)
  { label: 'Sports',
    tags: ['sports', 'soccer', 'basketball', 'baseball', 'tennis', 'football', 'hockey',
      'golf', 'mma', 'ufc', 'boxing', 'cricket', 'rugby', 'nascar', 'esports', 'games',
      'mlb', 'nba', 'nfl', 'nhl', 'wnba', 'ncaa', 'f1', 'formula 1', 'olympics',
      'fifa world cup', '2026 fifa world cup', 'world cup', 'champions league',
      'europa league', 'premier league', 'la liga', 'serie a', 'bundesliga',
      'tournament futures', 'team props'],
    phrases: ['sports', 'nba', 'nfl', 'nhl', 'mlb', 'wnba', 'ncaa', 'soccer', 'tennis',
      'golf', 'boxing', 'cricket', 'rugby', 'nascar', 'ufc', 'mma', 'pga', 'formula 1',
      'premier league', 'champions league', 'europa league', 'world cup', 'super bowl',
      'superbowl', 'nba finals', 'march madness', 'wimbledon', 'ballon d', 'ballon dor',
      'player of the year', 'end in a draw', 'exact score', 'moneyline',
      'counter-strike', 'cs2', 'csgo', 'dota', 'valorant', 'league of legends',
      'rocket league', 'overwatch', 'starcraft', 'call of duty', 'esports', 'grand prix',
      'la liga', 'serie a', 'bundesliga', 'epl', 'olympic', 'olympics', 'fifa',
      // compact sport codes that appear in real Polymarket slugs:
      'atp', 'wta', 'fifwc', 'ucl', 'uel', 'ncaab', 'ncaaf'] },

  // ── Elections (before Politics) ────────────────────────────────────────────
  { label: 'Elections',
    tags: ['elections', 'election', 'global elections', 'world elections', 'main election',
      'us election', 'u.s. election', 'presidential election', 'general election',
      'primaries', 'midterms', 'electoral college'],
    phrases: ['election', 'elections', 'midterm', 'midterms', 'primary', 'primaries',
      'gop primary', 'democratic primary', 'electoral college', 'swing state',
      'swing states', 'ballot', 'presidential nomination', 'nomination', 'nominee',
      'democratic nominee', 'republican nominee', 'general election', 'next president'] },

  // ── Crypto ─────────────────────────────────────────────────────────────────
  { label: 'Crypto',
    tags: ['crypto', 'crypto prices', 'bitcoin', 'ethereum', 'solana', 'altcoins', 'xrp',
      'defi', 'memecoins', 'stablecoins', 'nft', 'fdv'],
    phrases: ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'xrp', 'ripple',
      'bnb', 'dogecoin', 'doge', 'memecoin', 'altcoin', 'stablecoin', 'defi', 'web3',
      'blockchain', 'hyperliquid', 'cardano', 'litecoin', 'up or down', 'launch a token',
      'launch a coin', 'ordinals', 'etf approval'] },

  // ── Weather / Climate (specific tokens only — no team-collision words) ──────
  { label: 'Weather',
    tags: ['weather', 'climate', 'daily temperature', 'highest temperature', 'temperature'],
    phrases: ['weather', 'climate', 'temperature', 'hurricane', 'snowfall', 'rainfall',
      'heatwave', 'heat wave', 'el nino', 'la nina', 'global warming', 'wildfire',
      'tornado', 'co2', 'degrees fahrenheit', 'degrees celsius',
      // temperature / heat-record wording (e.g. "hottest year on record", "Nth-hottest
      // year on record") — genuine climate/weather markets that otherwise fell to 'other'.
      'hottest year', 'warmest year', 'coldest year', 'hottest on record',
      'warmest on record', 'hottest day', 'hottest month', 'record heat',
      'heat record', 'temperature record', 'record temperature'] },

  // ── Health ─────────────────────────────────────────────────────────────────
  { label: 'Health',
    tags: ['health', 'healthcare', 'medicine', 'disease', 'pandemic'],
    phrases: ['covid', 'covid-19', 'pandemic', 'vaccine', 'outbreak', 'bird flu', 'h5n1',
      'measles', 'mpox', 'ozempic', 'retatrutide', 'healthcare', 'disease', 'fda approves',
      'fda approval', 'cdc', 'influenza'] },

  // ── Tech / Science ─────────────────────────────────────────────────────────
  { label: 'Tech',
    tags: ['tech', 'ai', 'science', 'spacex', 'space'],
    phrases: ['ai', 'ai model', 'artificial intelligence', 'openai', 'chatgpt', 'gpt-5',
      'gpt-4', 'anthropic', 'claude', 'gemini', 'deepmind', 'llm', 'spacex', 'starship',
      'nasa', 'rocket launch', 'semiconductor', 'quantum computing', 'robotics', 'aliens',
      'technology', 'fields medal', 'nobel prize'] },

  // ── Economy (before Financials & Business) ─────────────────────────────────
  { label: 'Economy',
    tags: ['economy', 'economic policy', 'fed', 'fed rates', 'fomc', 'inflation',
      'interest rates', 'gdp', 'macro', 'macro indicators'],
    phrases: ['economy', 'economic', 'fed', 'fed rates', 'fomc', 'jerome powell',
      'interest rate', 'interest rates', 'rate cut', 'rate hike', 'inflation', 'cpi', 'pce',
      'recession', 'gdp', 'unemployment', 'jobs report', 'nonfarm', 'payrolls',
      'jobless claims', 'debt ceiling', 'tariff', 'tariffs', 'trade war', 'economic policy',
      'consumer confidence', 'tsa'] },

  // ── Financials / Markets ───────────────────────────────────────────────────
  { label: 'Financials',
    tags: ['finance', 'financials', 'stocks', 'commodities', 'oil', 'gold'],
    phrases: ['s&p 500', 'sp500', 'nasdaq', 'dow jones', 'stock market', 'stocks',
      'equities', 'treasury yield', 'commodities', 'crude oil', 'wti', 'brent',
      'gold price', 'silver price', 'vix'] },

  // ── Business ───────────────────────────────────────────────────────────────
  { label: 'Business',
    tags: ['business', 'companies', 'earnings'],
    phrases: ['earnings', 'ipo', 'merger', 'acquisition', 'acquire', 'layoffs',
      'bankruptcy', 'startup', 'tesla', 'nvidia', 'boeing', 'gamestop', 'iphone', 'apple',
      'microsoft', 'amazon'] },

  // ── Pop Culture / Entertainment ────────────────────────────────────────────
  { label: 'Pop Culture',
    tags: ['pop culture', 'culture', 'movies', 'music', 'awards', 'entertainment'],
    phrases: ['box office', 'opening weekend', 'rotten tomatoes', 'netflix', 'oscars',
      'oscar', 'grammys', 'grammy', 'emmys', 'emmy', 'billboard', 'met gala',
      'person of the year', 'celebrity', 'stranger things', 'toy story', 'minions',
      'taylor swift', 'kardashian', 'love island', 'big brother', 'reality show',
      'album', 'box-office'] },

  // ── World / Geopolitics (before generic Politics) ──────────────────────────
  { label: 'World',
    tags: ['world', 'geopolitics', 'middle east', 'iran', 'israel', 'russia', 'ukraine',
      'syria', 'north korea', 'nato', 'united nations', 'venezuela', 'taiwan'],
    phrases: ['geopolitics', 'middle east', 'strait of hormuz', 'hormuz', 'iran', 'iranian',
      'israel', 'gaza', 'palestine', 'ukraine', 'russia', 'putin', 'zelenskyy', 'khamenei',
      'netanyahu', 'north korea', 'kim jong', 'china', 'chinese', 'taiwan', 'venezuela',
      'cuba', 'greenland', 'nato', 'ceasefire', 'hostage', 'regime', 'military invasion',
      'united nations', 'brexit', 'world chess'] },

  // ── Politics (catch-all for domestic political figures/institutions) ───────
  { label: 'Politics',
    tags: ['politics', 'trump', 'us politics', 'uk politics', 'congress'],
    phrases: ['politics', 'trump', 'biden', 'harris', 'congress', 'senate', 'president',
      'presidential', 'white house', 'supreme court', 'scotus', 'impeachment', 'governor',
      'mayor', 'prime minister', 'united kingdom', 'government shutdown', 'gov shutdown',
      'pardon', 'filibuster', 'cabinet', 'republican', 'democrat', 'gop', 'epstein',
      'newsom', 'vance', 'desantis', 'ocasio-cortez', 'ossoff'] },
];

// Precompiled matchers (built once). Tag path uses exact set membership + the
// word-boundary regex; text path uses the regex over the full title/slug string.
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]]/g, '\\$&'); }
const CAT_MATCHERS = CATS.map(c => ({
  label: c.label,
  tagSet: new Set(c.tags.map(t => t.toLowerCase())),
  // phrases already contain a couple of intentional regex fragments (\d+); other
  // metachars are escaped so "s&p 500", "u.s." etc. match literally.
  phraseRe: new RegExp('(?:^|[^a-z0-9])(?:' + c.phrases.map(escapeRe).join('|') + ')(?![a-z0-9])', 'i'),
}));

// REAL tags first: match each event tag label (normalized) against the canonical
// per-category tag set / matcher, most-specific-first. Unknown/structural tags →
// skipped; nothing matched → honest 'other', never a guess.
function inferCategory(tags = []) {
  const labels = tags.map(t => (typeof t === 'string' ? t : t && t.label || '').toLowerCase().trim());
  for (const m of CAT_MATCHERS) {
    if (labels.some(l => l && (m.tagSet.has(l) || m.phraseRe.test(l)))) return m.label;
  }
  return 'other';   // no real tag/keyword matched → honest 'other'
}

// No tags available (open positions): run the same taxonomy over real title/slug
// text using word-boundary matching. Unmatched → 'other'.
function categoryFromText(...parts) {
  const text = parts.filter(Boolean).join(' ').toLowerCase();
  if (!text.trim()) return 'other';
  for (const m of CAT_MATCHERS) {
    if (m.phraseRe.test(text)) return m.label;
  }
  return 'other';
}

// Ordered canonical label list (single source of truth for UI display order).
const CATEGORY_ORDER = CATS.map(c => c.label);

module.exports = { inferCategory, categoryFromText, CATS, CATEGORY_ORDER };

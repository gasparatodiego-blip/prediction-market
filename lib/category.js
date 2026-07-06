'use strict';
// Shared Polymarket category taxonomy — single source of truth for agent20
// (leaderboard) and agent21 (copy-watcher / paper engine). Prefers REAL
// Polymarket event tags; unknown text falls through to 'other' (never a guess).
// Categories are checked most-specific-first so a market tagged both "Tennis"
// and "Sports" resolves to Sports, and "TSA/Economy" resolves to Economy.

const CAT_KEYWORDS = [
  ['Sports', ['sports','nba','nfl','soccer','nhl','mlb','tennis','golf','mma','basketball','football','baseball','ufc','premier league','champions league','world cup','nba finals','superbowl','super bowl','fifa','olympics','wimbledon','games','wta','atp','f1','formula 1','cricket','boxing','epl','la liga','serie a','bundesliga','ncaa','march madness','hockey','rugby','nascar']],
  ['Crypto', ['crypto','crypto prices','bitcoin','btc','ethereum','eth','solana','sol','xrp','ripple','bnb','dogecoin','doge','hype','hyperliquid','blockchain','defi','web3','memecoin','altcoin','stablecoin','nft','cardano','ada','litecoin','up or down','ordinals']],
  ['Elections', ['elections','election','presidential election','midterms','midterm','primary','gop primary','democratic primary','electoral college','swing states','ballot','poll','2024 election','2028 election','general election']],
  ['Politics', ['politics','trump','biden','harris','congress','senate','house','president','presidential','democrat','republican','gop','white house','cabinet','supreme court','scotus','impeachment','governor','mayor','nyc mayor','uk politics','gov shutdown','government shutdown','pardon','filibuster','vance','desantis','newsom']],
  ['Weather', ['weather','climate','temperature','hurricane','snow','snowfall','rain','rainfall','heat','heatwave','el nino','la nina','co2','global warming','storm','tornado','wildfire']],
  ['Health', ['health','covid','covid-19','pandemic','disease','fda','vaccine','outbreak','flu','h5n1','bird flu','medicine','cdc','who','mpox','measles','ozempic']],
  ['Tech', ['tech','technology','ai','artificial intelligence','openai','chatgpt','gpt','gpt-5','science','space','spacex','nasa','rocket','starship','semiconductor','quantum','robotics','deepmind','anthropic','claude','gemini','llm']],
  ['Financials', ['financials','markets','stocks','stock','stock market','s&p 500','sp500','s&p','nasdaq','dow','dow jones','equities','bonds','treasury','vix','commodities','gold','silver','oil','wti','brent','crude']],
  ['Economy', ['economy','economic','macro','fed','fed rates','fomc','jerome powell','interest rates','rate cut','rate hike','inflation','cpi','pce','recession','gdp','unemployment','jobs report','nonfarm','payrolls','economic policy','consumer','tsa','tariff','tariffs','trade war','debt ceiling','jobless claims']],
  ['Business', ['business','company','companies','earnings','ipo','merger','acquisition','ceo','startup','layoffs','bankruptcy','tesla','apple','google','microsoft','nvidia','amazon','meta','boeing','x corp','twitter']],
  ['Pop Culture', ['pop culture','culture','music','entertainment','tv','movies','film','celebrity','oscar','oscars','grammy','grammys','emmy','emmys','celebrity death','kardashian','taylor swift','elon musk','box office','netflix','rotten tomatoes','award','awards','show','streaming','album','billboard','met gala','time person of the year','person of the year']],
  ['World', ['world','geopolitics','middle east','iran','china','russia','ukraine','israel','gaza','palestine','north korea','war','nato','brexit','venezuela','taiwan','travel','international','united nations','ceasefire']],
];

function inferCategory(tags = []) {
  const lower = tags.map(t => (typeof t === 'string' ? t : t.label || '').toLowerCase());
  for (const [label, kws] of CAT_KEYWORDS) {
    if (lower.some(t => kws.includes(t))) return label;
  }
  return 'other';   // no real keyword/tag matched → honest 'other', never a guess
}

// Tokenize real title/slug text and run the same keyword logic. Unmatched → 'other'.
function categoryFromText(...parts) {
  const tokens = parts.filter(Boolean).join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!tokens.length) return 'other';
  return inferCategory(tokens);
}

module.exports = { inferCategory, categoryFromText, CAT_KEYWORDS };

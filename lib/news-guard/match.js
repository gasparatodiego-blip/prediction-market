'use strict';
// lib/news-guard/match.js — ENTITY matching: tie a news item to a SPECIFIC market by the market's own
// named entities, never by generic keywords.
//
// WHY (measured): the original agent27 matched on ≤6 title keywords and counted ANY article the search
// returned as "about" the market — so generic words ("win", "election", "price") pulled in unrelated
// stories, and a market flipped to medium on 2 such articles. Here a match REQUIRES a proper-noun
// entity derived from the market's title/slug to actually appear in the item's own text. Generic
// event-words are stripped out and can never, by themselves, produce a match.
//
// Pure: no IO, no clock. Same logic used by the agent, the measurement script, and the selfcheck.

// Generic / event vocabulary that is NOT an entity — stripped from both the market's entity set and
// never counted as a match token. Deliberately broad: these are the words that made the old matcher noisy.
const GENERIC = new Set([
  'will','win','wins','won','next','the','a','an','to','of','in','on','at','by','for','and','or','be','is','are','was','were',
  'before','after','during','than','with','it','its','vs','game','match','market','who','what','when','which','how','yes','no',
  'above','below','between','reach','reaches','hit','hits','close','closes','closing','election','elections','presidential',
  'president','primary','race','poll','polls','price','prices','under','over','more','less','most','least','number','total',
  'lose','loses','beat','beats','defeat','champion','championship','final','finals','cup','league','season','round','get','gets',
  'make','makes','day','week','weekend','month','year','years','could','would','should','than','end','ends','start','starts',
  'new','open','high','low','up','down','out','win','odds','favorite','favourite','vs.','win?','','this','that','then','still',
  'january','february','march','april','may','june','july','august','september','october','november','december',
  'monday','tuesday','wednesday','thursday','friday','saturday','sunday','q1','q2','q3','q4',
  // generic POLITICAL / institutional vocabulary — roles and bodies, not named entities. Measured:
  // "democratic"+"nomination" matched a REPUBLICAN nomination story; "prime"+"minister" matched
  // Lebanon's PM for an Israel market. These common nouns must never form an entity match.
  'democratic','democrat','democrats','republican','republicans','gop','nomination','nominee','nominees',
  'party','parties','house','senate','congress','congressional','parliament','parliamentary','prime','minister',
  'ministers','governor','senator','senators','mayor','seat','seats','cabinet','coalition','government','governments',
  'federal','national','general','candidate','candidates','vote','votes','voting','ballot','ballots','bill','law','court',
  'state','states','council','commission','committee','chief','leader','leadership','official','officials','administration',
]);
// lowercase connectors that stitch a multi-word proper name together ("Lula da Silva", "Man of the Match")
const CONNECTORS = new Set(['de','da','del','della','di','van','von','der','den','the','of','al','bin','and','&','la','le','el','dos','das']);
const YEAR = /^(19|20)\d{2}$/;

// Lowercase + FOLD DIACRITICS (Inácio → inacio) so an accented entity matches the same word in a
// normalized headline. Both the entity set and the item text pass through here, so they fold identically.
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const isCap = w => /^[A-Z]/.test(w);
const lc = w => w.toLowerCase();

/**
 * Derive a market's entity set from its title (primary) and slug (fallback).
 *   phrases : multi-word proper-noun phrases (lowercased, normalized), the STRONG match unit
 *   tokens  : distinctive single entity tokens (proper nouns, tickers) — never generic words
 *   query   : a compact search string for query-providers (google-news, bluesky)
 * Returns null-safe empty sets when a title yields no entity (that market simply stays uncovered — "—").
 */
// Measurement / threshold markets whose outcome is a NUMBER, not a news-driven event: weather
// temperature, and index/price levels. Their title's proper noun is an incidental LOCATION or ticker,
// not a newsworthy subject — matching "Los Angeles" to generic LA local news (or "York City" to a
// football club) is a measured false positive. These markets are news-UNCOVERED ("—"): a headline
// cannot move a temperature. They still get book-only severity upstream; we simply add no news.
const MEASUREMENT_MARKET = /\btemp\b|temperature|°|\bdegrees?\b|fahrenheit|celsius|\bhigh(est)? temp/i;

function entitiesFor({ title, slug, marketSlug } = {}) {
  const phrases = new Set();
  const tokens = new Set();
  if (MEASUREMENT_MARKET.test(title || '')) return { phrases, tokens, query: '' };   // weather/measurement → no news entities

  // ── from the cased title: runs of Capitalized tokens (+ connectors) = proper-noun phrases ──
  // A phrase entityish token must be ≥3 chars — so "U.S." (→ "U","S") can NEVER form the phrase "u s"
  // that used to match every headline containing "U.S." (incl. "U.S. Open" golf). This was a real,
  // measured false-match source.
  const raw = (title || '').replace(/[?!.,;:()"'’]/g, ' ').split(/\s+/).filter(Boolean);
  let run = [];
  const flush = () => {
    while (run.length && CONNECTORS.has(lc(run[0]))) run.shift();
    while (run.length && CONNECTORS.has(lc(run[run.length - 1]))) run.pop();
    const entityish = run.filter(w => !CONNECTORS.has(lc(w)) && !GENERIC.has(lc(w)) && !YEAR.test(w) && norm(w).length >= 3);
    // a phrase needs ≥2 real proper-noun tokens, at least one of them ≥4 chars (kills initialisms).
    // The phrase TEXT keeps connectors ("Lula da Silva") so it matches the item text verbatim; the
    // GATE is on the connector-free entityish tokens.
    if (entityish.length >= 2 && entityish.some(w => norm(w).length >= 4)) phrases.add(norm(run.join(' ')));
    for (const w of entityish) { const t = norm(w); if (t.length >= 4) tokens.add(t); }   // fold so accents match item text
    run = [];
  };
  for (const w of raw) {
    const isEntityStart = isCap(w) && !GENERIC.has(lc(w)) && !YEAR.test(w);
    if (isEntityStart || (run.length && (CONNECTORS.has(lc(w)) || (isCap(w) && !YEAR.test(w))))) run.push(w);
    else flush();
  }
  flush();

  // ── tickers / all-caps symbols anywhere in the title (BTC, ETH, GDP) ──
  for (const w of raw) if (/^[A-Z]{3,5}$/.test(w) && !GENERIC.has(lc(w))) tokens.add(lc(w));

  // ── price/threshold numbers (≥4 digits, not a year) — a strict disambiguator for crypto/finance ──
  for (const w of raw) { const n = w.replace(/[,$k]/gi, ''); if (/^\d{4,}$/.test(n) && !YEAR.test(n)) tokens.add(n); }

  // ── slug fallback: fills tokens when title casing is unhelpful. Slug words are WEAK (they never
  //    match alone — a match always needs ≥2 tokens or a phrase), so a slug-injected verb like
  //    "invade" cannot by itself pull in an unrelated story. ──
  const sl = (marketSlug || slug || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of sl) if (w.length >= 4 && !GENERIC.has(w) && !YEAR.test(w)) tokens.add(w);

  // compact query for query-providers: strongest phrase (or top 3 tokens)
  const phraseArr = [...phrases].sort((a, b) => b.length - a.length);
  const query = phraseArr[0] || [...tokens].slice(0, 3).join(' ') || '';

  return { phrases, tokens, query };
}

/**
 * Does this item match this market's entities? Requires a real, SPECIFIC entity hit; a single common
 * token can NEVER match alone (measured: lone "austin" pulled in a "Sidley Austin" law-firm story).
 * Match rule (any one):
 *   • a multi-word entity PHRASE appears in the item text (e.g. "donald trump", "lula da silva"), OR
 *   • ≥2 DISTINCT entity tokens co-occur in the item text (e.g. "bitcoin" + "150000").
 * @returns {{ matched:boolean, hits:string[], rule:string|null }}
 */
function matchItemToMarket(item, ent) {
  if (!ent || (!ent.phrases.size && ent.tokens.size < 1)) return { matched: false, hits: [], rule: null };
  const text = ' ' + norm(`${item.title} ${item.summary}`) + ' ';

  const phraseHits = [];
  for (const ph of ent.phrases) if (ph && text.includes(` ${ph} `)) phraseHits.push(ph);
  if (phraseHits.length) return { matched: true, hits: phraseHits, rule: 'phrase' };

  const tokenHits = [];
  for (const t of ent.tokens) if (t && text.includes(` ${t} `)) tokenHits.push(t);
  if (tokenHits.length >= 2) return { matched: true, hits: tokenHits, rule: 'multi-token' };

  return { matched: false, hits: tokenHits, rule: null };
}

module.exports = { entitiesFor, matchItemToMarket, GENERIC, _norm: norm };

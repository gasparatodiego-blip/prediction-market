#!/usr/bin/env node
'use strict';

/**
 * Shared deterministic matching utilities used by all matcher agents.
 * deterministic matcher — no external API calls
 */

const fs = require('fs');

const BATCH_SIZE = 20;

// ── Deterministic matching config ──────────────────
// Fees mirror agent5-calculator.js PLATFORM_FEES — keep both in sync if rates change.
const PLATFORM_FEES = {
  kalshi:     0.07,
  polymarket: 0.02,
  predictit:  0.10 + 0.05,
  manifold:   0.00,
  oddsapi:    0.00,
};
const REAL_BOOK          = new Set(['kalshi', 'polymarket']); // platforms with an executable bid/ask book
const MIN_CONFIDENCE     = 0.65;   // same confidence bar the previous matching pipeline used
// IDF must be computed over the FULL market universe (tens of thousands of markets), not a
// small per-category batch — otherwise generic context words (e.g. "world cup", "2026") look
// artificially rare/distinctive in a small sample, producing false matches, while common phrasing
// shared by genuinely-matching pairs looks artificially common, producing false rejections.
const MIN_IDF_SCORE      = 8.0;    // pair must accumulate >= this total IDF from shared tokens
// 4.0 let tournament/umbrella-event words through as "distinctive" (e.g. "fifa"/"world_cup" sit at
// idf~3.7-4.6 in a market universe that's a few % World Cup props) — enough shared umbrella terms
// alone cleared the old bar and matched unrelated props under the same event. 5.0 requires the
// shared vocabulary to include something genuinely entity-specific (a name, a narrow phrase).
const HIGH_IDF_THRESHOLD = 5.0;    // "distinctive" token: rare across the full market universe
const MIN_HIGH_IDF_SHARED = 2;     // must share >=2 distinctive tokens to be considered same event
const SUSPICIOUS_ROI     = 15;     // netROI% above this on a real-book pair → quarantine (unreliable)
const MAX_SPREAD_WIDTH   = 0.10;   // yesAsk-yesBid > 10c on either leg → illiquid, skip arb check

const STOPWORDS = new Set([
  'will','the','a','an','in','by','of','at','to','for','and','or','is','are',
  'be','as','its','it','win','wins','winning','market','prediction','happen',
  'occur','make','have','has','that','this','with','from','on','not','no',
  'yes','next','how','which','who','what','when','where','why','than','their',
  'they','he','she','we','do','did','does','before','after','during','outcome',
  'over','under','more','less','most','least','any','all','each','first','last',
  'new','old','get','got','been','were','was','would','could','should','may',
  'might','can','shall','must','about','between','against','without','within',
  'through','into','onto','upon','around','per','if',
]);

// Normalizes a platform's native resolution/expiry field to ISO 8601 UTC.
// Returns null for anything absent or unparseable — never a guessed date.
function normalizeResolutionDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function tokenize(text) {
  const clean = (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const words = clean.split(/\s+/).filter(t => t.length >= 3 && !STOPWORDS.has(t));
  const toks  = new Set(words);
  for (let i = 0; i < words.length - 1; i++) toks.add(`${words[i]}_${words[i + 1]}`);
  return toks;
}

// Document-frequency/IDF index built once per run over the FULL extracted market universe
// (all platforms, all categories) — see MIN_IDF_SCORE comment above for why this must not be
// scoped to a single category's small sample.
function buildIdfIndex(allMarkets) {
  const N = allMarkets.length;
  const tokensById = new Map();
  const df = new Map();
  for (const m of allMarkets) {
    const toks = tokenize(m.question);
    tokensById.set(m.id, toks);
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, freq] of df) idf.set(t, Math.log(N / freq));
  return { idf, tokensById };
}

// Markets built by extractAllMarkets() embed the outcome label as "[outcome: X]"
// in the question string (see predictit/kalshi below) — use it as a deterministic
// same-event gate without any external call.
function extractOutcomeLabel(question) {
  const m = /\[outcome:\s*([^\]]+)\]/i.exec(question || '');
  return m ? m[1].trim().toLowerCase() : '';
}

// If a market's raw text mentions a specific outcome word (e.g. an opponent candidate's
// surname), it must show up in the other leg's text too — otherwise the two legs are pricing
// different specific outcomes of the same umbrella event (e.g. "Trump wins" vs "[outcome: Vance]").
function questionMentions(question, label) {
  if (label === 'yes' || label === 'no') return true;
  const q = (question || '').toLowerCase();
  const words = label.split(/\s+/).filter(w => w.length >= 3);
  if (words.length === 0) return true;
  return words.some(w => q.includes(w));
}

// ── Bracket-independent same-event checks ──────────────────────────────────
// The [outcome: X] bracket convention (Kalshi/PredictIt) was the only same-event
// signal outcomesCompatible() had. Polymarket/Manifold titles never carry that
// bracket, so two unrelated events that merely share a name/keyword could clear
// the IDF token-overlap gate and get paired as if they were the same market —
// e.g. "Will Donald Trump win the 2028 Election?" (Polymarket) matched against
// "Will Donald Trump be impeached during his second term?" (Manifold): same
// person, completely different proposition.
//
// These checks run for EVERY pair (bracketed or not), in addition to the
// bracket logic above — never in place of it. Conservative by design: each
// only ever REJECTS on a positive, specific conflict signal; when a signal
// can't be determined on either side it stays neutral rather than guess,
// since here a missed match is far cheaper than a fabricated spread.

const GENERATIONAL_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// Proper-noun phrases: 2+ consecutive Title-Case words (original casing, not
// the lowercased tokenizer output) — a crude but deterministic person-name
// detector. No NER available; this only ever feeds a same-base-name +
// suffix-conflict check below, so an imprecise extraction just falls through
// neutral rather than causing a false reject.
function extractNamePhrases(question) {
  const clean = stripOutcome(question || '');
  const matches = clean.match(/\b(?:[A-Z][a-zA-Z'’-]*\s+){1,4}[A-Z][a-zA-Z'’-]*\b/g) || [];
  return matches
    .map(phrase => phrase.trim().split(/\s+/).map(w => w.toLowerCase().replace(/[.'’]/g, '')))
    .filter(words => words.length >= 2);
}

// True when both titles reference the SAME base name but exactly one phrase
// carries a generational suffix ("Trump" vs "Trump Jr.") — different people,
// a shared surname/substring alone is never enough to call this a match.
function hasEntitySuffixConflict(qa, qb) {
  const namesA = extractNamePhrases(qa);
  const namesB = extractNamePhrases(qb);
  for (const wa of namesA) {
    const suffixA = GENERATIONAL_SUFFIXES.has(wa.at(-1)) ? wa.at(-1) : null;
    const baseA   = (suffixA ? wa.slice(0, -1) : wa).join(' ');
    for (const wb of namesB) {
      const suffixB = GENERATIONAL_SUFFIXES.has(wb.at(-1)) ? wb.at(-1) : null;
      const baseB   = (suffixB ? wb.slice(0, -1) : wb).join(' ');
      if (baseA && baseA === baseB && suffixA !== suffixB) return true;
    }
  }
  return false;
}

// ── General primary-entity mismatch ─────────────────────────────────────────
// hasEntitySuffixConflict above only fires when both legs share a base name
// with a differing generational suffix (Trump vs Trump Jr) — it has no signal
// at all when two legs simply name two ENTIRELY DIFFERENT people/teams (e.g.
// Manifold "Will JD Vance win 2028?" vs Polymarket "Will Gavin Newsom win
// 2028?"): same proposition, same year, high shared IDF on generic words
// ("win", "2028", "presidential", "election"), but two different people.
// Neither leg carries an [outcome: X] bracket, so the bracket path in
// outcomesCompatible() never sees this either. This closes that gap.

function normalizeEntity(name) {
  return (name || '').toLowerCase().replace(/[.'’]/g, '').replace(/\s+/g, ' ').trim();
}

// Deliberately narrow: every token must start with a capital letter and the
// phrase must contain no digits — excludes Kalshi's date/numeric outcome
// buckets ("Before 2050", "500000", "50JAN01") which look nothing like a
// person/team/thing name, while still accepting real names and brand-style
// single words ("Nike"). Never lowercases its input — casing is the signal.
function looksLikeProperNounPhrase(text) {
  const t = (text || '').trim();
  if (!t || /\d/.test(t) || /\b(and|or|vs\.?|versus)\b/i.test(t)) return false;
  return /^(?:[A-Z][a-zA-Z'’.-]*\s*){1,4}$/.test(t);
}

function extractOutcomeLabelRaw(question) {
  const m = /\[outcome:\s*([^\]]+)\]/i.exec(question || '');
  return m ? m[1].trim() : '';
}

// Primary entity = the single person/team/thing a leg's market resolves on.
// Free text is checked FIRST, before any outcome bracket: a leg like Kalshi's
// "Will Elon Musk visit Mars in his lifetime? [outcome: Mars]" has "Mars" as
// its bracket, but "Mars" is a topic tag for a binary yes/no bet, not the
// entity — the real subject ("Elon Musk") is in the sentence itself, and must
// win over the bracket. Only when the free text yields no confident subject
// (umbrella/noun-phrase titles like "2028 Democratic presidential nominee",
// which never match the "Will <Subject> <verb>" sentence shape) does the
// resolved bracket name (from d85dedd's yes_sub_title, e.g. "Mark Cuban")
// become the primary entity. Returns null — never a guess — when neither
// source is confident, e.g. multi-subject "Will Rubio and Vance run..." or
// field markets like "Who will win the Presidency, House, and Senate?".
function extractPrimaryEntity(question) {
  const clean = stripOutcome(question || '').trim();
  // No /i flag here: it would make [A-Z] match lowercase too and swallow the
  // predicate verb into the "entity" capture (e.g. "Marco Rubio announce a").
  // Sentence-initial "Will" is case-sensitive-safe — every real title we've
  // seen capitalizes it.
  const m = /^Will\s+((?:[A-Z][a-zA-Z'’.-]*\s+){0,3}[A-Z][a-zA-Z'’.-]*)\s+([a-z]+)/.exec(clean);
  if (m) {
    if (/^(and|or|vs|versus)$/i.test(m[2])) return null; // multiple named subjects
    return normalizeEntity(m[1]);
  }

  const rawLabel = extractOutcomeLabelRaw(question);
  if (rawLabel && !/^(yes|no)$/i.test(rawLabel) && looksLikeProperNounPhrase(rawLabel)) {
    return normalizeEntity(rawLabel);
  }

  return null; // no confident subject either way — stay neutral upstream
}

// Split into significant (length>=3) tokens for a token-SET comparison rather
// than a raw substring check — a raw substring test fails on middle initials
// ("donald j trump" does not contain "donald trump" as a contiguous
// substring, since "j" sits in between) and would wrongly reject a genuine
// same-person pair. Short tokens (initials like "j", "jd") are dropped so
// "JD Vance" and "Vance" reduce to the same {vance} token set.
function entityTokens(name) {
  return name.split(' ').filter(w => w.length >= 3);
}

// Reject only when BOTH legs yield a confident primary entity AND those
// entities clearly differ. One entity's significant-token set being a subset
// of the other's ("vance" ⊆ "jd vance", "donald trump" ⊆ "donald j trump") is
// the same entity at different specificity/formatting, not a conflict —
// hasEntitySuffixConflict above is what catches the genuinely different-
// suffix case (Trump vs Trump Jr), so that stays neutral here rather than
// duplicate that logic. Two names sharing only a surname ("Hunter Biden" vs
// "Joe Biden") are NOT a subset either way, so they correctly conflict. Any
// unresolvable entity on either side (field markets, multi-subject titles,
// non-name outcome buckets) stays neutral — a missed reject is far cheaper
// than a fabricated one.
function hasEntityMismatch(qa, qb) {
  const ea = extractPrimaryEntity(qa);
  const eb = extractPrimaryEntity(qb);
  if (!ea || !eb) return false;
  if (ea === eb) return false;
  const ta = entityTokens(ea), tb = entityTokens(eb);
  if (ta.length === 0 || tb.length === 0) return false; // nothing significant to compare — stay neutral
  const setB = new Set(tb);
  const setA = new Set(ta);
  if (ta.every(t => setB.has(t)) || tb.every(t => setA.has(t))) return false;
  return true;
}

// Proposition-type signatures — ordered, first match wins. Deliberately narrow
// and specific (not a general topic classifier) so unrelated markets stay
// unclassified (null) rather than forced into a wrong bucket.
const PROPOSITION_SIGNATURES = [
  ['impeachment',     /\bimpeach/i],
  ['resign_removal',  /\bresign|\bremoved?\s+from\s+office|\bstep(s)?\s+down|\bousted?\b/i],
  // Noun form ("...Election winner?", "winner of the ... race") is a separate
  // phrasing of the SAME proposition as the verb form ("win(s) the election")
  // — Kalshi favors "winner?" titles, Polymarket favors "Will X win...?", and
  // \bwin(s)?\b's word boundary never matched "winner" (would need "winner"
  // to end right after "win", but it continues with "ner"), so these stayed
  // unclassified (null) and the proposition gate went neutral by omission
  // rather than confirming them as the same type by design. Kept as one
  // signature (not split out) since it's the same proposition, just a
  // different part of speech.
  ['election_win',    /\bwin(s)?\b[^.?]{0,40}\b(election|president|presidency|primary|race|seat)\b|\b(election|president|presidency|primary|race)\b[^.?]{0,40}\bwin(s)?\b|\bwinner\b[^.?]{0,40}\b(election|president|presidency|primary|race|seat)\b|\b(election|president|presidency|primary|race|seat)\b[^.?]{0,40}\bwinner\b/i],
  ['nomination',      /\bnominee|\bnomination|\bnominate/i],
  // Announcing/entering a race is a different proposition from winning it — a
  // candidate can announce and still lose, or win without being "first to
  // announce". Checked after election_win/nomination (first-match-wins) so a
  // title that already signals win/nominate keeps that classification; this
  // only catches the "will they run" phrasing common on both platforms
  // (verified against live titles: "announce a presidential run", "announce
  // his presidential candidacy", "run for President in 2028", etc — and does
  // NOT fire on unrelated "announced" usage like "departure announced" or
  // "announcers say during [game]", which lack a run/bid/campaign/candidacy
  // object within range).
  ['announce_candidacy', /\b(announc|declar)(e|es|ed|ing)\b[^.?]{0,40}\b(run|bid|campaign|candidacy)\b|\benter(s|ed|ing)?\b[^.?]{0,40}\b(race|campaign)\b|\blaunch(es|ed|ing)?\b[^.?]{0,40}\b(campaign|bid)\b|\bfile(s|d)?\s+to\s+run\b|\bexploratory\s+committee\b|\brun(s)?\s+for\s+(president|office|senate|governor|mayor)\b/i],
  ['holds_office',    /\bstill\s+(be\s+)?president|\bin\s+office|\bserving\s+as|\bremain(s)?\s+in\s+office|\bout\s+as\s+president/i],
  ['price_threshold', /\breach(es)?\s*\$|\babove\s*\$|\bbelow\s*\$|\$[\d,.]+[kmb]?\b/i],
];

function classifyProposition(question) {
  const clean = stripOutcome(question || '');
  for (const [label, re] of PROPOSITION_SIGNATURES) {
    if (re.test(clean)) return label;
  }
  return null; // no confident signature match — stays neutral, never blocks on its own
}

// Reject only when BOTH legs classify to a known, DIFFERENT proposition type.
// An unclassified leg on either side means we don't know enough to compare —
// that must not force a reject (it would wreck recall on ordinary markets
// that don't match any signature), so this stays neutral in that case.
function hasPropositionTypeMismatch(qa, qb) {
  const pa = classifyProposition(qa);
  const pb = classifyProposition(qb);
  return pa !== null && pb !== null && pa !== pb;
}

// Resolution-window years — if both titles name a year and the sets share
// none, they resolve on different timelines and can't be the same market.
function extractYears(question) {
  const clean = stripOutcome(question || '');
  const years = (clean.match(/\b(20[2-3]\d)\b/g) || []).map(Number);
  return new Set(years);
}

function hasDateWindowMismatch(qa, qb) {
  const ya = extractYears(qa);
  const yb = extractYears(qb);
  if (ya.size === 0 || yb.size === 0) return false; // can't compare — stay neutral
  for (const y of ya) if (yb.has(y)) return false;   // any shared year → compatible
  return true;
}

function outcomesCompatible(a, b) {
  const oa = extractOutcomeLabel(a.question);
  const ob = extractOutcomeLabel(b.question);
  let bracketOk;
  if (oa && ob) {
    if (oa === ob) bracketOk = true;
    else if (oa === 'yes' || oa === 'no' || ob === 'yes' || ob === 'no') bracketOk = true;
    else return false; // explicit different outcomes — reject immediately, unchanged behavior
  } else if (oa && !ob) {
    bracketOk = questionMentions(b.question, oa);
  } else if (ob && !oa) {
    bracketOk = questionMentions(a.question, ob);
  } else {
    bracketOk = true; // neither leg carries an explicit outcome label — nothing to cross-check from brackets
  }
  if (!bracketOk) return false;

  // Bracket-independent checks — run for ALL pairs, bracketed or not. This is
  // the layer that catches Polymarket/Manifold false pairs the bracket logic
  // above can never see (those platforms never emit an [outcome: X] bracket).
  if (hasEntitySuffixConflict(a.question, b.question)) return false;
  if (hasEntityMismatch(a.question, b.question)) return false;
  if (hasPropositionTypeMismatch(a.question, b.question)) return false;
  if (hasDateWindowMismatch(a.question, b.question)) return false;

  return true;
}

function stripOutcome(q) {
  return (q || '').replace(/\s*\[outcome:[^\]]*\]/i, '').trim();
}

function describeEvent(a, b) {
  const qa = stripOutcome(a.question), qb = stripOutcome(b.question);
  return qa.length >= qb.length ? qa : qb;
}

// Executable bid/ask arb — NEVER probability/midpoint. Only meaningful when both
// legs expose a real order book (kalshi, polymarket); returns null otherwise.
function bestNetRoi(a, b) {
  if (a.yesBid <= 0 || a.yesAsk >= 1 || b.yesBid <= 0 || b.yesAsk >= 1) return null;
  if ((a.yesAsk - a.yesBid) > MAX_SPREAD_WIDTH) return null;
  if ((b.yesAsk - b.yesBid) > MAX_SPREAD_WIDTH) return null;
  const dir1 = a.yesAsk + (1 - b.yesBid); // buy YES on A, buy NO on B
  const dir2 = b.yesAsk + (1 - a.yesBid); // buy YES on B, buy NO on A
  const bestCost = Math.min(dir1, dir2);
  const grossProfit = 1 - bestCost;
  if (grossProfit <= 0) return null;
  const grossROI = (grossProfit / bestCost) * 100;
  const feeA = PLATFORM_FEES[a.platform] || 0;
  const feeB = PLATFORM_FEES[b.platform] || 0;
  return grossROI * (1 - feeA - feeB);
}

// ── Event-level grouping (comparator buckets) ──────────────────────────────
// Additive to the pairwise matcher above: buckets ALL legs (any platform, matched
// pair or not) that resolve the same real-world event, so a UI can show every
// platform quoting an event side by side (ArbBets-style), not just the two legs
// that happened to clear the pairwise IDF/token-overlap gate.
//
// Reuses the exact same signals the same-event gate above already computes per
// leg — extractPrimaryEntity, classifyProposition, extractYears — turned into a
// single canonical KEY instead of a pairwise compatibility check. A key requires
// all three signals to resolve confidently; a leg missing any one of them is
// left out of every bucket rather than guessed into one — a missed grouping is
// cheaper than a fabricated one, same philosophy as the gate itself.

// entityTokens() already treats "JD Vance" and "Vance" as equivalent for the
// pairwise SUBSET check (hasEntityMismatch) — the exact-SET version here
// (sorted, joined) turns that same equivalence into a map key: {vance} ==
// {vance}, but {biden,hunter} != {biden,joe}, so two people who only share a
// surname still land in different buckets.
function entityKeyComponent(question) {
  const entity = extractPrimaryEntity(question);
  if (!entity) return null;
  const toks = entityTokens(entity);
  if (toks.length === 0) return null;
  // hasEntitySuffixConflict (pairwise) catches "Trump" vs "Trump Jr" separately
  // from hasEntityMismatch, because entityTokens' length>=3 filter drops "jr" —
  // without this, both would collapse to the same {trump} set here. Fold the
  // generational suffix (if present) back into the key so it isn't lost.
  const words  = entity.split(' ');
  const suffix = GENERATIONAL_SUFFIXES.has(words.at(-1)) ? words.at(-1) : null;
  const base   = [...new Set(toks)].sort().join('_');
  return suffix ? `${base}+${suffix}` : base;
}

// Canonical single year for the key: the earliest year named in the title. Title
// years are a resolution-WINDOW signal (see hasDateWindowMismatch above), not
// necessarily the exact resolution date — resolutionDate (native platform field,
// carried on the bucket itself) is the accurate value; this is only for grouping.
function yearKeyComponent(question) {
  const years = extractYears(question);
  return years.size === 0 ? null : Math.min(...years);
}

// classifyProposition's 'nomination' signature matches the bare word ("nominee",
// "nomination") with no regard to WHICH office — verified live: the same person
// carries a "2028 Democratic VP nominee" price, a "2028 Democratic presidential
// nominee" price, and (for AOC specifically) a "NY Democratic Senate nominee"
// price, all classified identically as propositionType="nomination" with wildly
// different values (0.08 / 0.14 / 0.52) because they are three different real-
// world events, not one. The pairwise gate tolerates this ambiguity because IDF
// token-overlap narrows candidates down separately before this ever matters;
// bucketing has no such secondary filter, so this office qualifier is a NEW,
// bucketing-only signal — it does not touch classifyProposition() itself (the
// pairwise gate's behavior must not change).
const OFFICE_SIGNATURES = [
  ['vice_president', /\bvice\s+president(ial)?\b|\bvp\b/i],
  ['president',      /\bpresident(ial)?\b/i],
  ['senate',         /\bsenat(e|or)\b/i],
  ['house',          /\bhouse\s+of\s+representatives\b|\brepresentative\b/i],
  ['governor',       /\bgovernor\b/i],
  ['mayor',          /\bmayor\b/i],
];

function officeKeyComponent(question) {
  const clean = stripOutcome(question || '');
  for (const [label, re] of OFFICE_SIGNATURES) {
    if (re.test(clean)) return label;
  }
  return null; // no confident office scope — stays ungroupable rather than a guess
}

// "Who will run for the nomination" and "is the nominee" both contain the bare
// word "nomination" — classifyProposition labels both 'nomination' — but running
// is not winning, and the two price very differently for the same person
// (verified live: AOC "run for the Dem nomination" priced 0.55 vs AOC "is the
// Dem nominee" priced 0.14). Same reasoning as OFFICE_SIGNATURES above: a new
// bucketing-only guard, not a change to the shared classifyProposition().
const CANDIDACY_PHRASING_RE = /\bwho\s+will\s+run\b|\brun(s)?\s+for\s+the\s+[a-z]+\s+nomination\b/i;

// Same signals the same-event gate already computes, reused as a grouping key:
// `${entity}|${propositionType}|${office}|${year}`. Returns null when any signal
// is missing, or when the text uses running/candidacy phrasing that would blur
// two different real-world propositions together — the leg stays ungrouped
// rather than joining a bucket on a guess.
function eventKeyFor(market) {
  const q = market?.question || '';
  const clean = stripOutcome(q);
  if (CANDIDACY_PHRASING_RE.test(clean)) return null;
  const entityKey = entityKeyComponent(q);
  if (!entityKey) return null;
  const prop = classifyProposition(q);
  if (!prop) return null;
  const office = officeKeyComponent(q);
  if (!office) return null;
  const year = yearKeyComponent(q);
  if (year == null) return null;
  return `${entityKey}|${prop}|${office}|${year}`;
}

// Best-effort category label from the classified proposition type — these are
// all political proposition signatures today except price_threshold.
const PROPOSITION_CATEGORY = {
  impeachment:        'politics',
  resign_removal:     'politics',
  election_win:       'politics',
  nomination:         'politics',
  announce_candidacy: 'politics',
  holds_office:       'politics',
  price_threshold:    'finance',
};

// Earliest non-null resolutionDate across a bucket's legs — same "the binding
// leg forces settlement first" rule agent5-calculator's resolutionInfo() uses
// for pairwise opportunities.
function earliestResolutionDate(legs) {
  const dates = legs
    .map(l => l.resolutionDate ? new Date(l.resolutionDate) : null)
    .filter(d => d && !isNaN(d.getTime()));
  if (dates.length === 0) return null;
  return new Date(Math.min(...dates.map(d => d.getTime()))).toISOString();
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Groups the full extracted market universe into event buckets keyed by
// eventKeyFor(). ADDITIVE ONLY — never touches pairwise matching/output.
//
// Each bucket tags every leg executable ("kalshi"/"polymarket", real order
// book) or reference (display-only — PredictIt/Manifold/OddsAPI never feed
// cashable/depth math). A referenceOnly:true market median is informational
// only. The "lockable edge" is the cheapest executable YES + cheapest
// executable NO across executable-tier legs only (never a reference leg) —
// it carries no roi/cashable fields of its own; the caller (agent5-calculator)
// attaches those from its already-computed pairwise opportunity for the same
// two leg ids, if one exists, so arb math is never computed twice from two
// different code paths.
function buildEventBuckets(markets) {
  const byKey = new Map();
  for (const m of markets) {
    const key = eventKeyFor(m);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }

  const buckets = [];
  for (const [eventKey, legs] of byKey) {
    // A comparator needs ≥2 quotes; a single-platform bucket has nothing to compare.
    if (legs.length < 2) continue;

    const prop = classifyProposition(legs[0].question);
    const platforms = legs.map(leg => ({
      platform:       leg.platform,
      tier:           REAL_BOOK.has(leg.platform) ? 'executable' : 'reference',
      yesPrice:       +leg.yesAsk.toFixed(4),
      noPrice:        +(1 - leg.yesBid).toFixed(4),
      // volumeUsd is a genuine dollar figure (Polymarket only, today) — null for
      // any platform whose native volume isn't dollar-denominated. volumeNative
      // carries that platform's own unit (Kalshi: contracts, Manifold: mana) so
      // the UI can still show a number without mislabeling its currency.
      volumeUsd:      leg.volumeUsd ?? null,
      volumeNative:   leg.volumeNative ?? null,
      marketUrl:      leg.url ?? null,
      // No order-book ladder is fetched at this discovery-time grouping stage
      // (that only happens for confirmed cashable pairs, in
      // agent23-prediction-repricer.js) — always false here, never guessed true.
      depthAvailable: false,
      legId:          leg.id,
    }));

    const executableLegs = legs.filter(l => REAL_BOOK.has(l.platform));
    let lockableEdge = null;
    if (executableLegs.length >= 2) {
      let best = null;
      for (const yesLeg of executableLegs) {
        for (const noLeg of executableLegs) {
          if (yesLeg === noLeg || yesLeg.platform === noLeg.platform) continue;
          const cost = yesLeg.yesAsk + (1 - noLeg.yesBid);
          if (!best || cost < best.cost) best = { cost, yesLeg, noLeg };
        }
      }
      if (best) {
        lockableEdge = {
          yesPlatform: best.yesLeg.platform,
          yesPrice:    +best.yesLeg.yesAsk.toFixed(4),
          yesLegId:    best.yesLeg.id,
          noPlatform:  best.noLeg.platform,
          noPrice:     +(1 - best.noLeg.yesBid).toFixed(4),
          noLegId:     best.noLeg.id,
          matchedOpportunity: null, // filled in by agent5-calculator.js when a pairwise opp exists for this pair
        };
      }
    }

    buckets.push({
      eventKey,
      title: legs.reduce((longest, l) => {
        const stripped = stripOutcome(l.question);
        return stripped.length >= longest.length ? stripped : longest;
      }, ''),
      category:        PROPOSITION_CATEGORY[prop] || 'unknown',
      resolutionDate:  earliestResolutionDate(legs),
      platforms,
      referenceMedian: {
        yesPrice:      median(platforms.map(p => p.yesPrice)),
        referenceOnly: true,
      },
      lockableEdge,
    });
  }

  return buckets;
}

// ── Heartbeat ─────────────────────────────────────

function beat(name) {
  const HB_FILE = '/tmp/agent-heartbeats.json';
  let hb = {};
  try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
  hb[name] = Date.now();
  fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2));
}

// ── OddsAPI market extraction ──────────────────────

function extractOddsApiMarkets() {
  const ODDS_FILE = '/tmp/odds-api-raw.json';
  const markets = [];
  try {
    const raw  = JSON.parse(fs.readFileSync(ODDS_FILE, 'utf8'));
    const age  = Date.now() - (raw.fetchedAt || 0);
    if (age > 600_000) return markets; // stale > 10 min
    for (const ev of (raw.events || [])) {
      const bookmakers = ev.bookmakers || [];
      if (bookmakers.length === 0) continue;
      // Average implied probability for home team across bookmakers
      const homeProbs = [];
      for (const bm of bookmakers) {
        const h2h = (bm.markets || []).find(m => m.key === 'h2h');
        const outcome = (h2h?.outcomes || []).find(o => o.name === ev.home_team);
        if (outcome?.price > 1) homeProbs.push((1 / outcome.price) * 100);
      }
      if (homeProbs.length === 0) continue;
      const avgProb = Math.round(homeProbs.reduce((a, b) => a + b, 0) / homeProbs.length);
      markets.push({
        id:          `odds-${ev.id}`,
        platform:    'oddsapi',
        question:    `Will ${ev.home_team} win against ${ev.away_team}?`,
        probability: avgProb,
        yesBid:      avgProb / 100,
        yesAsk:      avgProb / 100,
        realBook:    false,
        url:         null,
        resolutionDate: null, // handled separately via commence_time in agent5-calculator's oddsapi path
        volumeUsd:    null,
        volumeNative: null,
        _sport:      ev.sport_title || '',
        _homeTeam:   ev.home_team   || '',
        _awayTeam:   ev.away_team   || '',
      });
    }
  } catch {}
  return markets;
}

// ── Market extraction ──────────────────────────────

function extractAllMarkets(raw) {
  const markets = [];

  for (const m of (raw.predictit || [])) {
    const title = m.shortName || m.name || '';
    if (!title) continue;
    const top = (m.contracts || []).find(c => c.lastTradePrice != null);
    if (!top) continue;
    const contractLabel = top.shortName || top.name || '';
    const piQuestion = contractLabel ? `${title} [outcome: ${contractLabel}]` : title;
    const piYesAsk = top.bestBuyYesCost != null ? top.bestBuyYesCost : top.lastTradePrice;
    const piYesBid = top.bestBuyNoCost  != null ? (1 - top.bestBuyNoCost) : top.lastTradePrice;
    markets.push({
      id:          `pi-${m.id}`,
      platform:    'predictit',
      question:    piQuestion,
      probability: Math.round(top.lastTradePrice * 100),
      yesBid:      +piYesBid.toFixed(4),
      yesAsk:      +piYesAsk.toFixed(4),
      realBook:    false, // 10% profit fee + 5% withdrawal fee makes spreads unreliable — signal only
      // Prefer PredictIt's own full canonical URL (includes the slug) over a
      // reconstructed one — deep-links straight to the market, never guessed.
      url:         m.url || `https://www.predictit.org/markets/detail/${m.id}`,
      resolutionDate: null, // PredictIt raw feed carries no reliable close/expiry field
      volumeUsd:   null, // PredictIt's contract payload carries no volume field at all
      volumeNative: null,
    });
  }

  for (const m of (raw.manifold || [])) {
    if (m.outcomeType !== 'BINARY' || m.probability == null) continue;
    const q = m.question || '';
    if (!q) continue;
    markets.push({
      id:          `mf-${m.id}`,
      platform:    'manifold',
      question:    q,
      probability: Math.round(m.probability * 100),
      yesBid:      m.probability,
      yesAsk:      m.probability,
      realBook:    false, // play money, no real order book — signal only
      url:         m.url || `https://manifold.markets/${m.slug || ''}`,
      resolutionDate: normalizeResolutionDate(m.closeTime),
      // Manifold's volume is denominated in Mana (M$), its play-money unit — NOT
      // USD. Labeling it volumeUsd would misrepresent play money as real dollar
      // volume, so it stays null there; the raw Mana figure is carried separately
      // with its unit so the UI can show it without implying a $ figure.
      volumeUsd:    null,
      volumeNative: typeof m.volume === 'number' ? { amount: m.volume, unit: 'mana' } : null,
    });
  }

  for (const m of (raw.kalshi || [])) {
    const bid = parseFloat(m.yes_bid_dollars || '0');
    const ask = parseFloat(m.yes_ask_dollars || '0');
    if (bid <= 0 && ask <= 0) continue;
    const title = m.title || '';
    if (!title) continue;
    const prob = bid > 0 && ask > 0
      ? Math.round(((bid + ask) / 2) * 100)
      : Math.round((ask || bid) * 100);
    // Use Kalshi's own human-readable outcome name (yes_sub_title, e.g. "Mark Cuban"),
    // never the raw 3-6 letter ticker code (e.g. "MC"). The ticker is an id, not text
    // to match on — questionMentions() below treats bracket content as words that must
    // literally appear on the other leg, and a short opaque code either never matches a
    // real title (blocking genuine pairs) or slips under the length>=3 word filter and
    // auto-passes with no verification at all (the false Kalshi[MC]<->Poly "Kamala
    // Harris" pairing this replaces). If Kalshi ever fails to supply a name, omit the
    // bracket entirely — stay neutral rather than fall back to the ticker as text.
    const outcomeName = (m.yes_sub_title || '').trim();
    const kaQuestion = outcomeName ? `${title} [outcome: ${outcomeName}]` : title;
    markets.push({
      id:          `ka-${m.ticker}`,
      platform:    'kalshi',
      question:    kaQuestion,
      probability: prob,
      yesBid:      bid,
      yesAsk:      ask,
      realBook:    true,
      url:         `https://kalshi.com/markets/${m.ticker}`,
      resolutionDate: normalizeResolutionDate(m.close_time),
      // Kalshi's volume_fp is denominated in CONTRACTS, not dollars — each
      // contract's price varies trade to trade, so multiplying by the current
      // yes price would misrepresent historical dollar volume as a real figure.
      // volumeUsd stays null; the raw contract count is carried with its unit.
      volumeUsd:    null,
      volumeNative: (() => { const v = parseFloat(m.volume); return isFinite(v) && v > 0 ? { amount: v, unit: 'contracts' } : null; })(),
    });
  }

  for (const m of (raw.polymarket || [])) {
    const q = m.question || '';
    if (!q) continue;
    let prob = null;
    try {
      const prices = typeof m.outcomePrices === 'string'
        ? JSON.parse(m.outcomePrices)
        : m.outcomePrices;
      if (Array.isArray(prices) && prices[0]) prob = Math.round(parseFloat(prices[0]) * 100);
    } catch {}
    if (prob == null) {
      const ltp = parseFloat(m.lastTradePrice || '0');
      if (ltp > 0) prob = Math.round(ltp * 100);
    }
    if (prob == null || prob < 1 || prob > 99) continue;
    const pmBid    = parseFloat(m.bestBid || '0');
    const pmAsk    = parseFloat(m.bestAsk || '0');
    const pmSingle = prob / 100;
    const yB = pmBid > 0 ? pmBid : pmSingle;
    const yA = (pmAsk > 0 && pmAsk < 1) ? pmAsk : pmSingle;
    markets.push({
      id:          `pm-${m.id}`,
      platform:    'polymarket',
      question:    q,
      probability: prob,
      yesBid:      yB,
      yesAsk:      yA,
      realBook:    true,
      url:         m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
      resolutionDate: normalizeResolutionDate(m.endDate),
      // Polymarket's volume is USDC, 1:1 with USD (same convention already used
      // elsewhere in this codebase, e.g. capacityUsd) — a genuine dollar figure,
      // unlike Kalshi's contract-denominated volume or Manifold's play-money Mana.
      volumeUsd:    (() => { const v = parseFloat(m.volume); return isFinite(v) && v > 0 ? v : null; })(),
      volumeNative: (() => { const v = parseFloat(m.volume); return isFinite(v) && v > 0 ? { amount: v, unit: 'usd' } : null; })(),
    });
  }

  // Add OddsAPI sports markets (up to 30) for cross-platform matching
  const oddsMarkets = extractOddsApiMarkets();
  markets.push(...oddsMarkets.slice(0, 30));

  return markets;
}

// ── Category sampling ──────────────────────────────
// Broad keyword hints for routing markets to the right agent.
// Claude does the real semantic matching; these just limit the search space.

function scoreMarket(question, keywords, boostKeywords = []) {
  const q = question.toLowerCase();
  let score = keywords.filter(k => q.includes(k)).length;
  score    += boostKeywords.filter(k => q.includes(k)).length * 2;
  return score;
}

// Kalshi tickers follow "{series}-{outcome}" (e.g. "KXPRESNOMD-28-GN"; also the
// convention extractOutcomeLabel's bracket already relies on for the trailing
// segment). The part before the last "-" is Kalshi's own event/series id, shared
// by every outcome-row of one umbrella market — recoverable from data already in
// markets-raw.json, no fetcher change needed. Verified against a live snapshot:
// 62,473 Kalshi rows collapse to 7,641 umbrellas this way with only a handful of
// coincidental ticker-prefix reuse across unrelated sibling markets.
function kalshiUmbrellaKey(marketId) {
  const ticker = marketId.startsWith('ka-') ? marketId.slice(3) : marketId;
  const i = ticker.lastIndexOf('-');
  return i === -1 ? ticker : ticker.slice(0, i);
}

function sampleByCategory(markets, keywords, boostKeywords, perPlatform = 30, minScore = 1) {
  const byPlatform = {};
  for (const m of markets) {
    const s = scoreMarket(m.question, keywords, boostKeywords);
    if (s < minScore) continue;
    if (!byPlatform[m.platform]) byPlatform[m.platform] = [];
    byPlatform[m.platform].push({ ...m, _score: s });
  }
  const result = [];
  for (const [platform, list] of Object.entries(byPlatform)) {
    if (platform !== 'kalshi') {
      list.sort((a, b) => b._score - a._score);
      result.push(...list.slice(0, perPlatform));
      continue;
    }

    // Kalshi explodes one umbrella event (e.g. a multi-candidate election) into many
    // per-outcome rows. Capping that flat row list lets a single umbrella's outcome-rows
    // crowd out every other distinct Kalshi event before matching ever runs. Group by
    // umbrella first, cap over umbrellas (using each umbrella's best real per-row score,
    // never an invented blended one), then expand the selected umbrellas back to their
    // full outcome-row list so downstream pairing still sees every individual candidate.
    const byUmbrella = new Map();
    for (const m of list) {
      const key = kalshiUmbrellaKey(m.id);
      if (!byUmbrella.has(key)) byUmbrella.set(key, []);
      byUmbrella.get(key).push(m);
    }
    const umbrellas = [...byUmbrella.values()];
    umbrellas.sort((a, b) => Math.max(...b.map(m => m._score)) - Math.max(...a.map(m => m._score)));
    for (const rows of umbrellas.slice(0, perPlatform)) result.push(...rows);
  }
  return result;
}

// ── Batch creation ─────────────────────────────────
// Interleave platforms so each batch has a mix, maximising cross-platform pair opportunities.

function createBatches(markets) {
  // Group by platform
  const byPlatform = {};
  for (const m of markets) {
    if (!byPlatform[m.platform]) byPlatform[m.platform] = [];
    byPlatform[m.platform].push(m);
  }

  // Distribute each platform's queue round-robin across every batch slot (not a
  // sequential dequeue-then-chunk pass) so a platform with far more sampled rows
  // than another — e.g. Kalshi after umbrella expansion in sampleByCategory —
  // still lands alongside the smaller platforms' rows in the SAME batches instead
  // of piling into platform-only tail batches once the smaller queues run dry.
  // Those tail batches can never produce a cross-platform pair (matchBatch only
  // compares markets on different platforms), which would silently undo the
  // sampling fix that lets Kalshi keep a full umbrella's outcome-rows.
  const numBatches = Math.max(1, Math.ceil(markets.length / BATCH_SIZE));
  const batches = Array.from({ length: numBatches }, () => []);
  for (const queue of Object.values(byPlatform)) {
    queue.forEach((m, i) => batches[i % numBatches].push(m));
  }
  return batches.filter(b => b.length > 0);
}

// ── Deterministic IDF-weighted matching ────────────
// Same-event pairing via token-overlap scoring, executable bid/ask arb math,
// and a >15% netROI quarantine — no external API calls.

async function matchBatch(batch, categoryLabel, corpusIndex) {
  // corpusIndex should be built once per run over the full market universe (buildIdfIndex(allMarkets))
  // and passed in by buildRunner. Falls back to a batch-local index only for standalone/direct calls.
  const { idf, tokensById } = corpusIndex || buildIdfIndex(batch);

  const result = [];
  let rejectedNotSameEvent = 0;
  let quarantined = 0;

  for (let i = 0; i < batch.length; i++) {
    for (let j = i + 1; j < batch.length; j++) {
      const a = batch[i], b = batch[j];
      if (a.platform === b.platform) continue;

      const tokA = tokensById.get(a.id) || tokenize(a.question);
      const tokB = tokensById.get(b.id) || tokenize(b.question);
      let score = 0, distinctiveShared = 0;
      for (const t of tokA) {
        if (!tokB.has(t)) continue;
        const v = idf.get(t) || 0;
        score += v;
        if (v >= HIGH_IDF_THRESHOLD) distinctiveShared++;
      }
      if (score < MIN_IDF_SCORE) continue;
      if (distinctiveShared < MIN_HIGH_IDF_SHARED) continue;

      const confidence = +Math.min(1, score / 20).toFixed(3);
      if (confidence < MIN_CONFIDENCE) continue;

      // Same-event gate — reject when both legs carry an explicit, different outcome label
      if (!outcomesCompatible(a, b)) { rejectedNotSameEvent++; continue; }

      // Executable bid/ask arb quarantine (only meaningful when both legs have a real book;
      // predictit/manifold/futuur/oddsapi legs are unconfirmed/mid-price → signal, never cashable,
      // so they skip this check and are never quarantined for implausible ROI).
      if (REAL_BOOK.has(a.platform) && REAL_BOOK.has(b.platform)) {
        const netRoi = bestNetRoi(a, b);
        if (netRoi != null && netRoi > SUSPICIOUS_ROI) { quarantined++; continue; }
      }

      result.push({
        marketA:    a,
        marketB:    b,
        confidence,
        event:      describeEvent(a, b),
      });
    }
  }

  if (rejectedNotSameEvent > 0 || quarantined > 0) {
    console.log(`[matcher] ${categoryLabel}: ${rejectedNotSameEvent} rejected (not same event), ${quarantined} quarantined (netROI>${SUSPICIOUS_ROI}%)`);
  }

  return result;
}

// ── Deduplication ──────────────────────────────────

function deduplicateMatches(matches) {
  const seen = new Set();
  return matches.filter(m => {
    const ids = [m.marketA.id, m.marketB.id].sort().join('::');
    if (seen.has(ids)) return false;
    seen.add(ids);
    return true;
  });
}

// ── Main run loop factory ──────────────────────────

function buildRunner({ agentName, outFile, categoryLabel, keywords, boostKeywords, interval }) {
  const RAW_FILE = '/tmp/markets-raw.json';

  async function run() {
    if (!fs.existsSync(RAW_FILE)) {
      console.log(`[${agentName}] waiting for markets-raw.json...`);
      return;
    }

    let raw;
    try { raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8')); } catch {
      console.error(`[${agentName}] failed to parse markets-raw.json`);
      return;
    }

    const age = Date.now() - (raw.fetchedAt || 0);
    if (age > 300_000) {
      console.log(`[${agentName}] raw data stale (${Math.round(age / 60000)}m), skipping`);
      return;
    }

    const allMarkets  = extractAllMarkets(raw);
    const sampled     = sampleByCategory(allMarkets, keywords, boostKeywords, 30, 1);
    const batches     = createBatches(sampled);
    // Built once over the FULL market universe so IDF reflects true corpus-wide rarity —
    // see MIN_IDF_SCORE comment near the config constants.
    const corpusIndex = buildIdfIndex(allMarkets);

    console.log(`[${agentName}] ${sampled.length} markets in ${batches.length} batches for "${categoryLabel}"`);

    const allMatches = [];
    for (let i = 0; i < batches.length; i++) {
      const matches = await matchBatch(batches[i], categoryLabel, corpusIndex);
      allMatches.push(...matches);
    }

    const unique = deduplicateMatches(allMatches);
    console.log(`[${agentName}] ${allMatches.length} raw → ${unique.length} unique matches`);

    fs.writeFileSync(outFile, JSON.stringify({ updatedAt: Date.now(), matches: unique }, null, 2));
    beat(agentName);
  }

  run();
  setInterval(run, interval);
}

module.exports = { buildRunner, extractAllMarkets, sampleByCategory, createBatches, buildIdfIndex, matchBatch, deduplicateMatches, beat, kalshiUmbrellaKey, normalizeResolutionDate, buildEventBuckets, eventKeyFor };

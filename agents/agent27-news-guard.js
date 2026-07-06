#!/usr/bin/env node
// agent27-news-guard.js — adverse-news / volatility guard for liquidity-reward makers.
//
// PURPOSE
//   For every market where a user has (or would have) resting reward liquidity,
//   watch for signals that the event's price is about to move — so a maker can pull
//   quotes BEFORE getting adversely filled. Two real signal sources, both free:
//     1. Book signal (already ingested): the market's own recent volatility / TRAP /
//        wide-spread flags from agent24/25 (/tmp/liquidity-rewards.json).
//     2. News signal (free, no key): Google News RSS article-volume spike about the
//        event's keywords (recent 3h vs prior-24h baseline).
//
// HONEST-ENGINE
//   - ADVISORY ONLY. Live execution is OFF (AUTO_EXECUTE_ENABLED=false): the PROTECT
//     action is a surfaced recommendation + Telegram alert, never a real order.
//   - Never fabricates a news event. Only real, dated RSS articles count. A source we
//     can't reach for free (X/Twitter → paid key; Google Trends → token handshake) is
//     recorded as "source unavailable", not invented.
//   - No signal → "calm", stated calmly. Missing data → null, never guessed.
//   - Zero paid APIs. Rate-limited; news queried only for the top markets by pool
//     (where a maker would actually rest), each cached ~30 min.
//
// OUTPUT  /tmp/news-guard.json  — merged into the Liquidity Rewards tab by marketId.
'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const crypto = require('crypto');
const { httpPost: _sharedPost } = require('../lib/httpGet');

// ── Load .env for Telegram creds (pm2 doesn't auto-load project env files) ────
// Same read-only pattern as agent26; never hardcode/commit the token.
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* try next */ }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
const AUTO_EXECUTE_ENABLED = process.env.AUTO_EXECUTE_ENABLED === 'true'; // guard is advisory unless this is on (it is not)

// ── Config ────────────────────────────────────────────────────────────────────
const SNAPSHOT_FILE   = '/tmp/liquidity-rewards.json';
const OUT_FILE        = '/tmp/news-guard.json';
const STATE_FILE      = '/tmp/news-guard-state.json';   // dedupe/cooldown + per-market news cache
const HB_FILE         = '/tmp/agent-heartbeats.json';
const SCAN_INTERVAL_MS = 10 * 60_000;
const STARTUP_DELAY_MS = 12_000;
const NEWS_TOP_N       = 30;                 // query news only for the top-N markets by pool
const NEWS_CACHE_MS    = 30 * 60_000;        // re-query a given market's news at most every 30 min
const NEWS_RPS         = 1;                  // be gentle to Google News RSS
const FETCH_TIMEOUT_MS = 12_000;
const ALERT_COOLDOWN_MS = 3 * 3_600_000;     // same market alerts at most once / 3h

// News-spike heuristic thresholds (advisory signal, NOT a cashable number).
// Documented + conservative; recent = articles in last RECENT_H hours, baseline =
// avg articles per RECENT_H window over the preceding BASE_H hours.
const RECENT_H     = 3;
const BASE_H       = 24;
const HIGH_RATIO   = 3.0;  const HIGH_MIN = 3;   // ≥3× baseline AND ≥3 recent → HIGH
const MED_RATIO    = 1.8;  const MED_MIN  = 2;   // ≥1.8× baseline AND ≥2 recent → MEDIUM

function log(...a) { console.log('[A27]', new Date().toISOString(), ...a); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJsonSafe(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function atomicWrite(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ── HTTP GET (text) ────────────────────────────────────────────────────────────
function httpGetText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((res, rej) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const timer = setTimeout(() => { req.destroy(); done(rej, new Error('timeout')); }, timeoutMs);
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EdgeradarNewsGuard/1.0)', Accept: 'application/rss+xml,text/xml,*/*' },
    }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => { clearTimeout(timer); done(res, { status: r.statusCode, body: Buffer.concat(chunks).toString() }); });
    });
    req.on('error', e => { clearTimeout(timer); done(rej, e); });
  });
}

function httpPost(url, body) { return _sharedPost(url, body, { timeoutMs: 15_000 }).then(r => r.data); }
async function sendTelegram(text) {
  // Opt-in guard channel — respect the global mute switch.
  if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') { log('Telegram muted (TELEGRAM_ALERTS_ENABLED=false) — alert logged only'); return; }
  if (!BOT_TOKEN || !CHAT_ID) { log('Telegram not configured — alert logged only:', text.slice(0, 160)); return; }
  try { await httpPost(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }); }
  catch (e) { log('sendTelegram error:', e.message); }
}

// ── Keyword extraction for a news query ────────────────────────────────────────
const STOP = new Set(['will','the','a','an','to','of','in','on','at','by','for','and','or','be','is','are','was','were','win','next','this','that','before','after','during','than','with','it','its','vs','game','market','who','what','when','which','how','yes','no','above','below','between','reach','hit','close','2024','2025','2026','2027']);
function keywordsFor(title) {
  if (!title) return '';
  const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
  // Keep salient tokens (dedup, cap 6) — enough to disambiguate the event for a news search.
  const seen = new Set(); const out = [];
  for (const w of words) { if (!seen.has(w)) { seen.add(w); out.push(w); } if (out.length >= 6) break; }
  return out.join(' ');
}

// ── News-volume signal from Google News RSS (free, no key) ─────────────────────
async function newsSignal(title) {
  const kw = keywordsFor(title);
  if (!kw) return { level: 'low', recent: 0, baselinePer: 0, ratio: 0, source: 'google-news-rss', note: 'no usable keywords' };
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(kw)}&hl=en-US&gl=US&ceid=US:en`;
  let r;
  try { r = await httpGetText(url); }
  catch (e) { return { level: 'unknown', recent: null, baselinePer: null, ratio: null, source: 'google-news-rss', note: `fetch failed: ${e.message}` }; }
  if (!r || r.status !== 200 || !r.body) return { level: 'unknown', recent: null, baselinePer: null, ratio: null, source: 'google-news-rss', note: `HTTP ${r?.status}` };

  // Parse real article timestamps only — never invent an article.
  const now = Date.now();
  const dates = [];
  const re = /<pubDate>([^<]+)<\/pubDate>/g;
  let m;
  while ((m = re.exec(r.body)) !== null) {
    const t = Date.parse(m[1]);
    if (!isNaN(t)) dates.push(t);
  }
  if (!dates.length) return { level: 'low', recent: 0, baselinePer: 0, ratio: 0, source: 'google-news-rss', note: 'no dated articles' };

  const recent   = dates.filter(t => now - t <= RECENT_H * 3_600_000).length;
  const baseCount = dates.filter(t => { const age = now - t; return age > RECENT_H * 3_600_000 && age <= (RECENT_H + BASE_H) * 3_600_000; }).length;
  const baselinePer = (baseCount / BASE_H) * RECENT_H;             // expected articles per RECENT_H window
  const ratio = baselinePer > 0 ? recent / baselinePer : (recent > 0 ? recent : 0);

  let level = 'low';
  if (recent >= HIGH_MIN && ratio >= HIGH_RATIO) level = 'high';
  else if (recent >= MED_MIN && ratio >= MED_RATIO) level = 'medium';

  return {
    level, recent, baselinePer: Math.round(baselinePer * 100) / 100, ratio: Math.round(ratio * 100) / 100,
    source: 'google-news-rss', note: `${recent} articles in last ${RECENT_H}h vs ${baselinePer.toFixed(1)}/window baseline`,
  };
}

// ── Book signal from already-ingested volatility/flags (free) ──────────────────
// Returns structured components; the HIGH escalation lives in combineRisk() so that
// static high volatility alone (e.g. near-expiry) reads MEDIUM, and a "withdraw now"
// HIGH is reserved for genuine imminent-move signals (TRAP / news spike / corroborated).
function bookSignal(mkt) {
  const flags = Array.isArray(mkt.flags) ? mkt.flags : [];
  const vr = (mkt.volatilityRisk || '').toUpperCase();
  const notes = [];
  const trap = flags.includes('TRAP');
  if (trap) notes.push('TRAP — near-certain outcome, one side empty');
  if (vr === 'HIGH') notes.push('24h book volatility HIGH');
  else if (vr === 'MEDIUM') notes.push('24h book volatility MEDIUM');
  if (flags.includes('SHORT_BURST')) notes.push('short-burst program');
  const nearResolveH = mkt.hoursToResolution;
  if (nearResolveH != null && nearResolveH <= 12) notes.push(`resolves in ${nearResolveH.toFixed(0)}h`);
  return { trap, volHigh: vr === 'HIGH', volMed: vr === 'MEDIUM', shortBurst: flags.includes('SHORT_BURST'), hoursToResolution: nearResolveH, note: notes.join('; ') || 'book calm' };
}

const RANK = { low: 0, medium: 1, high: 2, unknown: 0 };
function worse(a, b) { return RANK[b] > RANK[a] ? b : a; }

// Combine real book components + news signal into an advisory low/med/high.
// MEDIUM = elevated, watch. HIGH = withdraw now — reserved for imminent-move signals.
function combineRisk(bs, ns) {
  const newsLvl = ns && ns.level !== 'unknown' ? ns.level : 'low';
  let level = 'low';
  // Elevations (MEDIUM):
  if (bs.volHigh || bs.volMed) level = worse(level, 'medium');
  if (bs.shortBurst) level = worse(level, 'medium');
  if (bs.hoursToResolution != null && bs.hoursToResolution <= 12) level = worse(level, 'medium');
  if (newsLvl === 'medium') level = worse(level, 'medium');
  // Escalations (HIGH — genuine imminent-move):
  if (bs.trap) level = 'high';                                             // structural adverse trap
  if (newsLvl === 'high') level = 'high';                                  // real breaking-news spike
  if (bs.volHigh && (newsLvl === 'medium' || (bs.hoursToResolution != null && bs.hoursToResolution <= 6)))
    level = 'high';                                                        // high vol corroborated by news / imminent resolution
  return level;
}

// ── Best-price exit advisory (approx from last snapshot; live exec OFF) ─────────
function exitAdvisory(mkt) {
  const mid = mkt.midpoint;
  const spr = mkt.bookSpread;
  if (mid == null) return 'exit at the best executable book price (unlock/live book required for exact levels)';
  if (spr != null) {
    const bestBid = Math.max(0.01, mid - spr / 2);
    const bestAsk = Math.min(0.99, mid + spr / 2);
    return `if long, sell down to best bid ≈ ${bestBid.toFixed(3)}; if short, buy up to best ask ≈ ${bestAsk.toFixed(3)} (approx from last snapshot — verify live book before acting)`;
  }
  return `exit at best executable price around mid ≈ ${mid.toFixed(3)} (verify live book before acting)`;
}

// ── Main scan ──────────────────────────────────────────────────────────────────
async function scan() {
  const t0 = Date.now();
  const snap = readJsonSafe(SNAPSHOT_FILE);
  if (!snap || !Array.isArray(snap.markets) || !snap.markets.length) {
    log('no unified snapshot yet — skipping cycle');
    return;
  }
  const state = readJsonSafe(STATE_FILE) || { newsCache: {}, alerted: {} };
  state.newsCache = state.newsCache || {};
  state.alerted   = state.alerted   || {};

  const markets = snap.markets;

  // Pick which markets get a (rate-limited, cached) news lookup: top by pool, deduped
  // by keyword so the same real-world event across venues isn't queried twice.
  const ranked = [...markets]
    .filter(m => m.dailyPool != null)
    .sort((a, b) => (b.dailyPool ?? 0) - (a.dailyPool ?? 0));
  const newsTargets = new Set();
  const kwSeen = new Set();
  for (const m of ranked) {
    const kw = keywordsFor(m.title);
    if (kw && !kwSeen.has(kw)) { kwSeen.add(kw); newsTargets.add(m.marketId); }
    if (newsTargets.size >= NEWS_TOP_N) break;
  }

  const now = Date.now();
  let newsQueried = 0;
  const sourcesStatus = {
    'google-news-rss': 'active (free, no key)',
    'google-trends':   'unavailable — unofficial endpoint needs a token handshake; skipped to respect rate limits/budget',
    'x-twitter':       'unavailable — requires a paid API key (not configured; budget €50/mo)',
  };

  const results = [];
  for (const m of markets) {
    const bs = bookSignal(m);

    // News signal: cached, and only for the chosen targets. Others carry book-only.
    let ns = null;
    const cached = state.newsCache[m.marketId];
    if (cached && (now - cached.at) < NEWS_CACHE_MS) {
      ns = cached.sig;
    } else if (newsTargets.has(m.marketId)) {
      ns = await newsSignal(m.title);
      state.newsCache[m.marketId] = { at: now, sig: ns };
      newsQueried++;
      await sleep(Math.ceil(1000 / NEWS_RPS));
    }

    const signals = [{ source: 'order-book-volatility', note: bs.note }];
    if (ns) signals.push({ source: ns.source, note: ns.note });

    // Overall = combined book + news signal (HIGH reserved for imminent-move).
    const newsRisk = combineRisk(bs, ns);

    const protect = newsRisk === 'high'
      ? {
          action: 'WITHDRAW_LIQUIDITY',
          detail: `Adverse signal on "${(m.title || '').slice(0, 80)}". Advisory: cancel both resting quotes now. If partially filled, ${exitAdvisory(m)}.`,
          liveExecution: AUTO_EXECUTE_ENABLED ? 'ON' : 'OFF (advisory only)',
        }
      : null;

    results.push({
      marketId: m.marketId, venue: m.venue, title: m.title,
      newsRisk, bookRisk: combineRisk(bs, null), newsSignal: ns ? ns.level : null,
      signals, protect,
    });
  }

  const highs = results.filter(r => r.newsRisk === 'high');
  const meds  = results.filter(r => r.newsRisk === 'medium');

  atomicWrite(OUT_FILE, {
    meta: {
      generatedAt: new Date().toISOString(),
      scanned: results.length,
      newsQueried,
      highCount: highs.length,
      medCount: meds.length,
      liveExecution: AUTO_EXECUTE_ENABLED ? 'ON' : 'OFF',
      sources: sourcesStatus,
      note: 'Advisory only — live execution OFF. PROTECT actions are recommendations, never real orders. ' +
            'News-risk = worst of real book volatility/flags and Google News RSS article-volume spike. No fabricated events.',
    },
    markets: results,
  });

  // Telegram: alert ONLY on genuine "something just happened" HIGH markets — a real
  // Google-News spike or a structural TRAP — not book-volatility-only highs (those are
  // still surfaced as HIGH badges in the UI, but do not warrant a push). Deduped, 3h
  // cooldown. Calm (no alert) when none — the valid, common state.
  const alertable = highs.filter(h => h.newsSignal === 'high' || (h.signals[0]?.note || '').includes('TRAP'));
  const toAlert = [];
  for (const h of alertable) {
    const prev = state.alerted[h.marketId];
    if (!prev || (now - prev) > ALERT_COOLDOWN_MS) { toAlert.push(h); state.alerted[h.marketId] = now; }
  }
  // prune stale alert/cooldown + cache entries
  for (const k of Object.keys(state.alerted))  if (now - state.alerted[k]  > 24 * 3_600_000) delete state.alerted[k];
  for (const k of Object.keys(state.newsCache)) if (now - state.newsCache[k].at > 6 * 3_600_000) delete state.newsCache[k];
  atomicWrite(STATE_FILE, state);

  if (toAlert.length) {
    const lines = toAlert.slice(0, 8).map(h =>
      `⚠️ <b>${(h.title || h.marketId).slice(0, 90)}</b> (${h.venue})\n   PROTECT: withdraw liquidity now · ${h.signals.map(s => s.note).join(' | ')}`);
    await sendTelegram(
      `🛡️ <b>News-guard: ${toAlert.length} market(s) at HIGH adverse risk</b>\n` +
      `Advisory only — live execution OFF, no orders placed.\n\n${lines.join('\n\n')}`);
    log(`ALERT sent for ${toAlert.length} HIGH-risk market(s)`);
  }

  // heartbeat
  try {
    const hb = readJsonSafe(HB_FILE) || {};
    hb['agent27-news-guard'] = { ts: Date.now(), high: highs.length, med: meds.length, scanned: results.length };
    atomicWrite(HB_FILE, hb);
  } catch { /* non-fatal */ }

  log(`scan done in ${((Date.now() - t0) / 1000).toFixed(1)}s — scanned ${results.length}, news queried ${newsQueried}, HIGH ${highs.length}, MED ${meds.length}`);
}

// ── Entry point ────────────────────────────────────────────────────────────────
(async () => {
  log(`news-guard online — advisory only, live execution ${AUTO_EXECUTE_ENABLED ? 'ON' : 'OFF'}. Sources: Google News RSS (free). X/Twitter + Google Trends: unavailable (no free/keyed access).`);
  await sleep(STARTUP_DELAY_MS);
  while (true) {
    try { await scan(); }
    catch (e) { log('cycle error (non-fatal):', e.message); }
    await sleep(SCAN_INTERVAL_MS);
  }
})();

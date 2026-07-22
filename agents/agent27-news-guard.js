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

// ── News-guard signal + action pipeline (all DISARMED / shadow by default) ──────
// Pure, framework-free modules shared with the replay tool so the agent and the audit dataset
// run identical logic. None of these talk to a venue.
const { loadNewsGuardConfig } = require('../lib/news-guard/config');
const { detectBookMove }      = require('../lib/news-guard/book-detector');
const { buildSignal }         = require('../lib/news-guard/signal');
const { decideAction }        = require('../lib/news-guard/action');
const { appendShadowRecord }  = require('../lib/news-guard/shadow-log');

// Resolved execution gates for THIS process. armed defaults FALSE → the action layer runs in
// shadow (logs every decision, sends no order). Read once at boot; a flip needs a restart, which
// is the intended, explicit, human step.
const NG = loadNewsGuardConfig();

// There is NO Polymarket/Kalshi trading key in custody (lib/key-custody stores only CEX perp
// credentials, and every venue adapter is read-only + liveVerified:false). So for the prediction
// venues the guard acts on, liveVerified is false BY CONSTRUCTION — never send an order through an
// unverified adapter. This is the third independent gate on execution.
function keyStateFor(/* venue */) { return { liveVerified: false }; }

const BOOK_HIST_MAX = 24;   // rolling window per market (~4h at the 10-min scan cadence)

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

// Telegram gating — TWO independent gates, BOTH must pass to send a push:
//   1. TELEGRAM_ALERTS_ENABLED — the project-wide mute switch. Only agent26
//      (landing auditor) + agent-monitor may bypass it; agent27 must NOT. When
//      this is 'false', the news-guard sends ZERO Telegram (advisories still go
//      to /tmp/news-guard.json and the in-app rewards news-risk badges).
//   2. NEWS_GUARD_TELEGRAM_ENABLED — per-agent OPT-IN, default FALSE. Even when
//      global alerts are ON, agent27 pushes Telegram ONLY if the user explicitly
//      opts in with this flag. Unset/absent → treated as OFF → no Telegram.
//   In-app news-risk badges + the advisory data file are unaffected by either.
const NEWS_GUARD_TELEGRAM_ENABLED = process.env.NEWS_GUARD_TELEGRAM_ENABLED === 'true';

// Prisma (local Postgres) — read stored RewardsPlacements so the guard reacts to the
// choice each user made per market (withdraw / alert / off). Guarded: if the client or
// DB is unavailable the guard degrades to book+news advisory only, never crashes.
// .env is already loaded above, so DATABASE_URL is in process.env before construction.
let prisma = null;
try { prisma = new (require('@prisma/client').PrismaClient)(); }
catch (e) { console.warn('[A27] Prisma unavailable — placement reactions disabled:', e.message); }

async function getPlacements() {
  if (!prisma) return [];
  try { return await prisma.rewardsPlacement.findMany({ select: { userId: true, marketId: true, newsMode: true, side: true, qtyPerSide: true, onFillYes: true, onFillNo: true } }); }
  catch (e) { console.warn('[A27] placement read failed:', e.message); return []; }
}

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
const ALERT_COOLDOWN_MS = 6 * 3_600_000;     // per-market cooldown: same marketId re-alerts at most once / 6h (persisted in STATE_FILE so restarts don't re-fire)

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
// Returns true only when a message was actually handed to Telegram, false when
// suppressed by a gate / missing config. Callers log honestly off this result.
async function sendTelegram(text) {
  // Gate 1: respect the project-wide mute switch (agent27 is NOT on the bypass allowlist).
  if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') { log('Telegram muted (TELEGRAM_ALERTS_ENABLED=false) — advisory kept in data file only'); return false; }
  // Gate 2: per-agent opt-in, default OFF. No opt-in → advisory stays in-app only.
  if (!NEWS_GUARD_TELEGRAM_ENABLED) { log('Telegram send skipped — news-guard opt-in gate off (NEWS_GUARD_TELEGRAM_ENABLED not true); advisory kept in data file + in-app badges only'); return false; }
  if (!BOT_TOKEN || !CHAT_ID) { log('Telegram not configured — alert logged only:', text.slice(0, 160)); return false; }
  try { await httpPost(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }); return true; }
  catch (e) { log('sendTelegram error:', e.message); return false; }
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
    level, recent, recentH: RECENT_H, baselinePer: Math.round(baselinePer * 100) / 100, ratio: Math.round(ratio * 100) / 100,
    source: 'google-news-rss', note: `${recent} articles in last ${RECENT_H}h vs ${baselinePer.toFixed(1)}/window baseline`,
  };
}

// ── Coarse upstream flags → a human-readable book note (free) ──────────────────
// This is NOT the severity source anymore — the rolling book detector (lib/news-guard/book-
// detector.js) + the severity policy (lib/news-guard/signal.js) decide severity. This function
// only produces a friendly note from the upstream volatility/TRAP flags for display fallback.
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

// ── Per-side FILL advisory ─────────────────────────────────────────────────────
// When a resting quote gets filled, honour the side's chosen rule INDEPENDENTLY:
//   'requote' → re-post the OPPOSITE side at its best executable level (stay exposed
//               until balanced, keep capturing the spread)
//   'close'   → flatten THIS side at the best executable book price (no exposure)
// Advisory only — live execution OFF. This is distinct from the news-guard's forced
// close, which always closes on adverse news regardless of the fill rule.
function sideExit(mkt, side) {
  const yesMid = mkt.midpoint;
  if (yesMid == null) return `exit the ${side.toUpperCase()} position at the best executable book price (unlock/live book required for exact level)`;
  const mid = side === 'yes' ? yesMid : (1 - yesMid);
  const spr = mkt.bookSpread;
  if (spr != null) {
    const bestBid = Math.max(0.01, mid - spr / 2);
    return `sell the ${side.toUpperCase()} position down to best bid ≈ ${bestBid.toFixed(3)} (approx from last snapshot — verify live book before acting)`;
  }
  return `exit the ${side.toUpperCase()} position at best price around mid ≈ ${mid.toFixed(3)} (verify live book before acting)`;
}

function fillAdvisory(mkt, side, rule) {
  const other = side === 'yes' ? 'no' : 'yes';
  const live = AUTO_EXECUTE_ENABLED ? 'ON' : 'OFF (advisory only)';
  if (rule === 'close') {
    return {
      side, rule: 'close', action: 'CLOSE_POSITION',
      detail: `Your ${side.toUpperCase()} order filled. Advisory: ${sideExit(mkt, side)} — no directional exposure, spread not captured.`,
      liveExecution: live,
    };
  }
  const otherMid = mkt.midpoint != null ? (other === 'yes' ? mkt.midpoint : 1 - mkt.midpoint) : null;
  const at = otherMid != null ? ` at its best executable level (≈ ${otherMid.toFixed(3)} mid — verify live book)` : ' at its best executable level';
  return {
    side, rule: 'requote', action: 'REQUOTE_OTHER_SIDE',
    detail: `Your ${side.toUpperCase()} order filled. Advisory: re-post the ${other.toUpperCase()} side${at} to keep capturing the spread; you stay directionally exposed until balanced.`,
    liveExecution: live,
  };
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
  // Rolling per-market book history (for the primary book detector) + action idempotency rails.
  state.bookHist       = state.bookHist       || {};
  state.actionCooldown = state.actionCooldown || {};   // marketId → last shadow-action ts (idempotency)
  state.actionHourly   = Array.isArray(state.actionHourly) ? state.actionHourly : []; // ts[] in last hour

  const markets = snap.markets;

  // User placements → per-market chosen reaction (withdraw / alert / off). A single
  // market may carry placements from several users; we aggregate counts and, when the
  // market is HIGH, advise the strongest opted-in reaction (withdraw ≻ alert ≻ off).
  const placements = await getPlacements();
  const placementByMarket = {};
  for (const p of placements) {
    if (!p.marketId) continue;
    const b = placementByMarket[p.marketId] || (placementByMarket[p.marketId] = {
      withdraw: 0, alert: 0, off: 0,
      yesRequote: 0, yesClose: 0, noRequote: 0, noClose: 0,   // per-side fill-rule tallies
    });
    if (p.newsMode === 'withdraw') b.withdraw++;
    else if (p.newsMode === 'alert') b.alert++;
    else b.off++;
    // Per-side fill rule (default 'requote'). 'close' is the flatten choice.
    if (p.onFillYes === 'close') b.yesClose++; else b.yesRequote++;
    if (p.onFillNo  === 'close') b.noClose++;  else b.noRequote++;
  }

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

  const signalByMarket = {};   // marketId → typed MarketMoveSignal (for the action layer below)
  const results = [];
  for (const m of markets) {
    const bs = bookSignal(m);   // coarse upstream flags (kept for the human-readable note)

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

    // ── PRIMARY: rolling book-move detector on the market's OWN measured dynamics ──
    // Build the current sample from real snapshot fields; thinner-side depth is only knowable when
    // the venue splits sides (Polymarket) — Kalshi carries a combined depth, so depthMin stays null
    // there (one-sided-collapse simply can't fire, never fabricated).
    const depthYes = m.sides && m.sides.yes ? m.sides.yes.bookDepthAtBand : null;
    const depthNo  = m.sides && m.sides.no  ? m.sides.no.bookDepthAtBand  : null;
    const depthMin = (typeof depthYes === 'number' && typeof depthNo === 'number') ? Math.min(depthYes, depthNo) : null;
    const cur = { mid: m.midpoint, spread: m.bookSpread, depthMin, bandDepth: m.bookDepthAtBand };
    const hist = Array.isArray(state.bookHist[m.marketId]) ? state.bookHist[m.marketId] : [];
    const book = detectBookMove(cur, hist);
    // Fold the upstream structural TRAP flag (one side near-empty) in as a book trigger — it is a
    // measured one-sided condition, and book alone still caps at 'medium' by policy.
    if (Array.isArray(m.flags) && m.flags.includes('TRAP')) {
      book.triggers.push({ type: 'structural-trap', note: 'near-certain outcome, one side empty (upstream flag)' });
      book.fired = true;
      if (book.severity === 'low') book.severity = 'medium';
    }
    // Advance the rolling history AFTER detecting (so the current point never baselines itself).
    if (cur.mid != null || cur.spread != null || cur.bandDepth != null) {
      state.bookHist[m.marketId] = [...hist, { t: now, ...cur }].slice(-BOOK_HIST_MAX);
    }

    // ── Combine per the book-primary severity policy (signal.js) ──
    const signal = buildSignal({ marketId: m.marketId, book, news: ns, ts: now });
    signalByMarket[m.marketId] = { signal, market: m };
    const newsRisk = signal.severity;   // 'low' | 'medium' | 'high' | 'unknown'

    const signals = [{ source: 'order-book-move', note: signal.evidence.summary || bs.note }];
    if (ns) signals.push({ source: ns.source, note: ns.note });

    const protect = newsRisk === 'high'
      ? {
          action: 'WITHDRAW_LIQUIDITY',
          detail: `Adverse signal on "${(m.title || '').slice(0, 80)}" (${signal.source}: ${signal.evidence.summary}). Advisory: monitoring is live; automatic execution is OFF (disarmed).`,
          liveExecution: 'OFF (disarmed — shadow only)',
        }
      : null;

    // Placement-driven reaction: honour the user's per-market choice. On a HIGH
    // (adverse) signal → 'withdraw' emits the advisory WITHDRAW action, 'alert' emits
    // an alert only, 'off' does nothing. Below HIGH → monitoring only. Advisory always:
    // live execution is OFF, so this is a recommendation + Telegram push, never an order.
    const pb = placementByMarket[m.marketId] || null;

    // Per-side fill advisory — apply onFillYes on a YES fill, onFillNo on a NO fill.
    // Rules are aggregated across this market's placements (majority per side, ties →
    // 'requote' default). Advisory only; live execution OFF.
    let fillAdvisoryBySide = null;
    if (pb) {
      const yesRule = pb.yesClose > pb.yesRequote ? 'close' : 'requote';
      const noRule  = pb.noClose  > pb.noRequote  ? 'close' : 'requote';
      fillAdvisoryBySide = {
        yes: fillAdvisory(m, 'yes', yesRule),
        no:  fillAdvisory(m, 'no',  noRule),
      };
    }

    let userReaction = null;
    if (pb && (pb.withdraw > 0 || pb.alert > 0)) {
      if (newsRisk === 'high') {
        if (pb.withdraw > 0) {
          userReaction = {
            mode: 'withdraw', action: 'WITHDRAW_LIQUIDITY', users: pb.withdraw,
            detail: `User chose auto-withdraw on adverse news. Advisory: cancel both resting quotes now. If partially filled, ${exitAdvisory(m)}.`,
            liveExecution: AUTO_EXECUTE_ENABLED ? 'ON' : 'OFF (advisory only)',
          };
        } else {
          userReaction = {
            mode: 'alert', action: 'ALERT_ONLY', users: pb.alert,
            detail: 'User chose alert-only. Notifying — no automatic action taken.',
            liveExecution: 'OFF (advisory only)',
          };
        }
      } else {
        userReaction = {
          mode: pb.withdraw > 0 ? 'withdraw' : 'alert', action: 'MONITOR',
          users: pb.withdraw + pb.alert, detail: 'Watching — risk not HIGH; no action advised yet.',
          liveExecution: 'OFF (advisory only)',
        };
      }
    }

    results.push({
      marketId: m.marketId, venue: m.venue, title: m.title,
      newsRisk,                                   // = signal.severity (book-primary policy)
      severity: signal.severity, source: signal.source, evidence: signal.evidence,
      bookRisk: book.fired ? 'medium' : 'low',    // book-only severity (caps at medium)
      newsSignal: ns ? ns.level : null,
      signals, protect,
      placements: pb, userReaction, fillAdvisory: fillAdvisoryBySide,
    });
  }

  const highs = results.filter(r => r.newsRisk === 'high');
  const meds  = results.filter(r => r.newsRisk === 'medium');

  // ── ACTION LAYER (DISARMED / SHADOW) ──────────────────────────────────────────
  // For each placement on a market whose signal is HIGH, decide the withdraw action and record it.
  // ARMED=false → mode is always 'shadow': the decision is fully built and logged, but ZERO venue
  // network calls happen (the only cancel adapter is the shadow one). Idempotency rails (per-market
  // cooldown + hourly cap) are consumed on a real 'withdraw' decision even in shadow, so arming
  // later behaves exactly as the shadow log predicts.
  state.actionHourly = state.actionHourly.filter(t => now - t < 3_600_000);   // prune to last hour
  let shadowWritten = 0, shadowActs = 0, shadowSuppressed = 0;
  for (const p of placements) {
    if (!p.marketId) continue;
    const sm = signalByMarket[p.marketId];
    if (!sm || sm.signal.severity !== 'high') continue;   // only actionable (HIGH) signals are logged
    const rails = {
      cooldownActive: state.actionCooldown[p.marketId] != null && (now - state.actionCooldown[p.marketId]) < NG.cooldownMs,
      hourlyCapReached: state.actionHourly.length >= NG.maxPerHour,
    };
    const { record, consumesActionSlot } = decideAction({
      signal: sm.signal, market: sm.market, placement: p,
      config: NG, keyState: keyStateFor(sm.market.venue), rails, now,
    });
    const r = appendShadowRecord(record);
    if (r.written) shadowWritten++;
    if (record.decision === 'withdraw') shadowActs++;
    if (record.decision === 'suppressed') shadowSuppressed++;
    if (consumesActionSlot) {   // burn the idempotency slot (shadow behaves like the real thing)
      state.actionCooldown[p.marketId] = now;
      state.actionHourly.push(now);
    }
  }
  if (shadowWritten) log(`shadow: wrote ${shadowWritten} decision record(s) — ${shadowActs} withdraw, ${shadowSuppressed} suppressed (armed=${NG.armed}, kill=${NG.killSwitch}); no venue calls`);

  atomicWrite(OUT_FILE, {
    meta: {
      generatedAt: new Date().toISOString(),
      scanned: results.length,
      newsQueried,
      highCount: highs.length,
      medCount: meds.length,
      placementsTracked: placements.length,
      // Execution posture — the UI reads THESE (not env) so the panel can't misstate arming.
      armed: NG.armed,
      killSwitch: NG.killSwitch,
      executionMode: NG.armed && !NG.killSwitch ? 'armed' : 'shadow',
      liveExecution: 'OFF (disarmed — shadow only)',
      shadow: { written: shadowWritten, withdraw: shadowActs, suppressed: shadowSuppressed },
      sources: sourcesStatus,
      severityPolicy: 'book-primary: book alone→medium; book+news→high; news alone→low (advisory). Every severity traces to measured evidence.',
      note: 'Monitoring is live and advisory. Automatic execution is DISARMED (NEWS_GUARD_ARMED=false): every decision is logged to data/news-guard-shadow.jsonl, no order is ever sent. No fabricated events.',
    },
    markets: results,
  });

  // Telegram: alert ONLY on genuine "something just happened" HIGH markets — a real
  // Google-News spike or a structural TRAP — not book-volatility-only highs (those are
  // still surfaced as HIGH badges in the UI, but do not warrant a push). Deduped, 6h
  // cooldown. Calm (no alert) when none — the valid, common state.
  // Alert set = genuine "something just happened" HIGHs (real news spike / structural
  // TRAP) UNION any HIGH market where a user opted into 'withdraw' or 'alert' (their
  // configured reaction fires). Deduped by marketId (Map, at most once per cycle),
  // 6h per-market cooldown persisted in STATE_FILE. Advisory only.
  const newsyHighs     = highs.filter(h => h.newsSignal === 'high' || (h.signals[0]?.note || '').includes('TRAP'));
  const placementHighs = highs.filter(h => h.userReaction && (h.userReaction.action === 'WITHDRAW_LIQUIDITY' || h.userReaction.action === 'ALERT_ONLY'));
  const alertMap = new Map();
  for (const h of [...newsyHighs, ...placementHighs]) alertMap.set(h.marketId, h);
  const alertable = [...alertMap.values()];
  // Cooldown is checked here but only STAMPED on an actual send below, so a
  // gate-suppressed "send" never burns the 6h window.
  const toAlert = [];
  for (const h of alertable) {
    const prev = state.alerted[h.marketId];
    if (!prev || (now - prev) > ALERT_COOLDOWN_MS) toAlert.push(h);
  }

  if (toAlert.length) {
    const lines = toAlert.slice(0, 8).map(h => {
      const reaction = h.userReaction?.action === 'WITHDRAW_LIQUIDITY'
        ? `your choice: WITHDRAW liquidity now (${h.userReaction.users} placement${h.userReaction.users === 1 ? '' : 's'})`
        : h.userReaction?.action === 'ALERT_ONLY'
        ? `your choice: ALERT only — no auto action (${h.userReaction.users} placement${h.userReaction.users === 1 ? '' : 's'})`
        : 'PROTECT: withdraw liquidity now';
      return `⚠️ <b>${(h.title || h.marketId).slice(0, 90)}</b> (${h.venue})\n   ${reaction} · ${h.signals.map(s => s.note).join(' | ')}`;
    });
    const sent = await sendTelegram(
      `🛡️ <b>News-guard: ${toAlert.length} market(s) at HIGH adverse risk</b>\n` +
      `Advisory only — live execution OFF, no orders placed.\n\n${lines.join('\n\n')}`);
    if (sent) {
      for (const h of toAlert) state.alerted[h.marketId] = now;   // consume cooldown only on a real send
      log(`ALERT sent for ${toAlert.length} HIGH-risk market(s)`);
    } else {
      log(`ALERT suppressed (Telegram gate off) — ${toAlert.length} HIGH-risk market(s) surfaced in /tmp/news-guard.json + in-app news-risk badges only`);
    }
  }

  // prune stale alert/cooldown + cache entries, then persist (after any send-stamp above)
  for (const k of Object.keys(state.alerted))  if (now - state.alerted[k]  > 24 * 3_600_000) delete state.alerted[k];
  for (const k of Object.keys(state.newsCache)) if (now - state.newsCache[k].at > 6 * 3_600_000) delete state.newsCache[k];
  // Drop rolling book history for markets no longer in the snapshot (bounded state file).
  const liveIds = new Set(markets.map(m => m.marketId));
  for (const k of Object.keys(state.bookHist))       if (!liveIds.has(k)) delete state.bookHist[k];
  for (const k of Object.keys(state.actionCooldown)) if (now - state.actionCooldown[k] > 24 * 3_600_000) delete state.actionCooldown[k];
  atomicWrite(STATE_FILE, state);

  // heartbeat
  try {
    const hb = readJsonSafe(HB_FILE) || {};
    hb['agent27-news-guard'] = { ts: Date.now(), high: highs.length, med: meds.length, scanned: results.length };
    atomicWrite(HB_FILE, hb);
  } catch { /* non-fatal */ }

  log(`scan done in ${((Date.now() - t0) / 1000).toFixed(1)}s — scanned ${results.length}, news queried ${newsQueried}, HIGH ${highs.length}, MED ${meds.length}`);
}

// Exported for testing the advisory selection in isolation (does not touch the DB
// or start the scan loop). The pm2 entry below only runs when invoked directly.
module.exports = { fillAdvisory, sideExit, exitAdvisory };

// ── Entry point ────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    log(`news-guard online — advisory only, live execution ${AUTO_EXECUTE_ENABLED ? 'ON' : 'OFF'}. Sources: Google News RSS (free). X/Twitter + Google Trends: unavailable (no free/keyed access).`);
    await sleep(STARTUP_DELAY_MS);
    while (true) {
      try { await scan(); }
      catch (e) { log('cycle error (non-fatal):', e.message); }
      await sleep(SCAN_INTERVAL_MS);
    }
  })();
}

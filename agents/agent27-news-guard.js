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
const { httpPost: _sharedPost } = require('../lib/httpGet');

// ── News-guard signal + action pipeline (all DISARMED / shadow by default) ──────
// Pure, framework-free modules shared with the replay tool so the agent and the audit dataset
// run identical logic. None of these talk to a venue.
const { loadNewsGuardConfig } = require('../lib/news-guard/config');
const { detectBookMove }      = require('../lib/news-guard/book-detector');
const { buildSignal }         = require('../lib/news-guard/signal');
const { stepRegime, isElevatedState } = require('../lib/news-guard/regime');
const { decideAction }        = require('../lib/news-guard/action');
const { appendShadowRecord }  = require('../lib/news-guard/shadow-log');

// ── NEWS LAYER (secondary confirmation, multi-source, €0) ───────────────────────────────────────
// Providers behind an interface (google-news / rss / reddit / bluesky), an entity matcher, cross-
// provider dedup, and N-source corroboration. News can NEVER fire a withdraw alone: corroborate()
// caps the news level at 'medium', and signal.js only reaches 'high' on book+news. Adding/swapping a
// source is a one-line edit in providers/registry.js — none of the signal logic changes.
const { collect, providerMeta } = require('../lib/news-guard/providers/registry');
const { DEFAULT_UA }            = require('../lib/news-guard/providers/base');
const { entitiesFor }           = require('../lib/news-guard/match');
const { dedup }                 = require('../lib/news-guard/dedup');
const { corroborate, RECENCY_MS } = require('../lib/news-guard/corroborate');

// Resolved execution gates for THIS process. armed defaults FALSE → the action layer runs in
// shadow (logs every decision, sends no order). Read once at boot; a flip needs a restart, which
// is the intended, explicit, human step.
const NG = loadNewsGuardConfig();

// The keyLiveVerified gate (the third of the four). Polymarket now has a live cancel-only adapter and
// a verification path (scripts/polymarket-verify-live.ts), so its liveVerified is a REAL fact read
// from the DB — true only after a human derived + verified a key (verifiedAt set, not revoked), never
// hardcoded. Every OTHER venue stays false by construction (no live adapter, no verification path).
function keyStateFor(venue, pmVerified) {
  return { liveVerified: venue === 'polymarket' ? pmVerified === true : false };
}

// Read the honest liveVerified fact for Polymarket once per scan (mirrors credentials.ts
// getPolymarketLiveVerified without importing the TS module into this plain-node agent). Degrades to
// false — the safe value — on any DB error or missing client.
async function getPolymarketVerified() {
  if (!prisma) return false;
  try {
    const row = await prisma.exchangeKey.findFirst({
      where: { venue: 'polymarket', revokedAt: null, verifiedAt: { not: null } },
      select: { id: true },
    });
    return row != null;
  } catch { return false; }
}

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
// Query-providers (google-news, bluesky) cost one HTTP call per market entity, so we issue TARGETED
// queries only for the top-N markets by pool. FIREHOSE providers (publisher RSS, Reddit) are fetched
// ONCE per cycle and matched against EVERY market's entities for free — so book-covered markets now get
// news coverage well beyond the old top-30 without a per-market query. See meta.coverage in the output.
const QUERY_TARGET_N   = 40;                 // markets that get a targeted google-news + bluesky query
const ALERT_COOLDOWN_MS = 6 * 3_600_000;     // per-market cooldown: same marketId re-alerts at most once / 6h (persisted in STATE_FILE so restarts don't re-fire)

function log(...a) { console.log('[A27]', new Date().toISOString(), ...a); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJsonSafe(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function atomicWrite(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
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
  const state = readJsonSafe(STATE_FILE) || { alerted: {} };
  state.alerted   = state.alerted   || {};
  // Rolling per-market book history (for the primary book detector) + action idempotency rails.
  state.bookHist       = state.bookHist       || {};
  state.regimeState    = state.regimeState    || {};   // marketId → persisted regime (hysteresis survives restart)
  state.actionCooldown = state.actionCooldown || {};   // marketId → last shadow-action ts (idempotency)
  state.actionHourly   = Array.isArray(state.actionHourly) ? state.actionHourly : []; // ts[] in last hour
  state.providerHealth = state.providerHealth || {};   // per-provider breaker + health (survives restart)

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

  const now = Date.now();

  // ── ENTITY sets per market (used both to build targeted queries and to match firehose items) ──
  const entByMarket = {};
  for (const m of markets) entByMarket[m.marketId] = entitiesFor({ title: m.title, slug: m.slug, marketSlug: m.marketSlug });

  // Targeted queries for the QUERY providers (google-news, bluesky): the top-N markets by pool, each
  // reduced to its strongest entity query, deduped so the same real-world event isn't queried twice.
  const ranked = [...markets].filter(m => m.dailyPool != null).sort((a, b) => (b.dailyPool ?? 0) - (a.dailyPool ?? 0));
  const querySeen = new Set();
  const queries = [];
  for (const m of ranked) {
    const q = entByMarket[m.marketId] && entByMarket[m.marketId].query;
    if (q && !querySeen.has(q)) { querySeen.add(q); queries.push(q); }
    if (queries.length >= QUERY_TARGET_N) break;
  }

  // ── ONE multi-provider collect per cycle (isolated + breaker-guarded), then cross-provider dedup ──
  // Firehose providers (rss, reddit) return recent items matched against EVERY market for free; query
  // providers (google-news, bluesky) answer the targeted entity queries above. sinceTs enforces the
  // recency bound at the source. Provider health persists in state so a dead source stays visibly off.
  state.providerHealth = state.providerHealth || {};
  const collectRes = await collect({ queries, sinceTs: now - RECENCY_MS, now, healthState: state.providerHealth, ua: DEFAULT_UA });
  const { clusters, stats: dedupStats } = dedup(collectRes.items);
  const newsQueried = queries.length;

  // Honest per-source status from live provider health (never a hardcoded "active").
  const sourcesStatus = {};
  for (const meta of providerMeta()) {
    const h = state.providerHealth[meta.id] || {};
    sourcesStatus[meta.id] = {
      kind: meta.kind, enabled: meta.enabled, defaultEnabled: meta.defaultEnabled, envFlag: meta.envFlag,
      itemsLastFetch: h.itemsLastFetch ?? 0, totalItems: h.totalItems ?? 0,
      consecutiveFailures: h.consecutiveFailures ?? 0, breakerOpen: !!h.breakerOpen,
      lastSuccessTs: h.lastSuccessTs ?? null, lastError: h.lastError ?? null,
      status: !meta.enabled ? 'disabled (env / default-off)' : h.breakerOpen ? `breaker OPEN (${h.lastError || 'repeated failures'})` : (h.itemsLastFetch > 0 ? `active — ${h.itemsLastFetch} items` : 'active — 0 items this cycle'),
    };
  }
  // Sources considered and NOT integrated (documented, never faked). No paid source is enabled.
  sourcesStatus['x-twitter'] = { kind: 'excluded', enabled: false, status: 'excluded — official X API is pay-per-use since Feb 2026, no free tier (€0 hard constraint)' };
  sourcesStatus['ap-reuters-espn'] = { kind: 'excluded', enabled: false, status: 'omitted — AP index.rss 401, Reuters RSS retired, ESPN rss 403 for automated clients (probed; free path unavailable)' };

  let newsCovered = 0, newsCorroborated = 0;
  const signalByMarket = {};   // marketId → typed MarketMoveSignal (for the action layer below)
  const results = [];
  for (const m of markets) {
    const bs = bookSignal(m);   // coarse upstream flags (kept for the human-readable note)

    // ── News signal: entity-match this market against the deduped story clusters, then corroborate ──
    // (≥N distinct publishers within the recency window). unknown ⇒ uncovered ("—"), never "calm".
    const ent = entByMarket[m.marketId];
    const cor = corroborate({ ent, clusters, now });
    const ns = (cor.level === 'unknown')
      ? { level: 'unknown', recent: 0, recentH: cor.recentH, source: cor.source, note: cor.note, distinctPublishers: 0, distinctClusters: 0, publishers: [] }
      : cor;
    if (cor.level !== 'unknown') newsCovered++;
    if (cor.level === 'medium') newsCorroborated++;

    // ── PRIMARY: rolling book-move detector on the market's OWN measured dynamics ──
    // Build the current sample from real snapshot fields; thinner-side depth is only knowable when
    // the venue splits sides (Polymarket) — Kalshi carries a combined depth, so depthMin stays null
    // there (one-sided-collapse simply can't fire, never fabricated).
    const depthYes = m.sides && m.sides.yes ? m.sides.yes.bookDepthAtBand : null;
    const depthNo  = m.sides && m.sides.no  ? m.sides.no.bookDepthAtBand  : null;
    const depthMin = (typeof depthYes === 'number' && typeof depthNo === 'number') ? Math.min(depthYes, depthNo) : null;
    // Upstream structural one-sidedness ("near-certain outcome, one side empty"). Carried as a book
    // SAMPLE field — the detector owns the structural-trap trigger AND its baseline gate now, so a
    // book that is one-sided BY CONSTRUCTION can only elevate when it CHANGES from its own baseline,
    // never as its permanent state (was the systematic false positive when folded in unconditionally).
    const trap = Array.isArray(m.flags) && m.flags.includes('TRAP');
    const cur = { mid: m.midpoint, spread: m.bookSpread, depthMin, bandDepth: m.bookDepthAtBand, trap };
    const hist = Array.isArray(state.bookHist[m.marketId]) ? state.bookHist[m.marketId] : [];
    const book = detectBookMove(cur, hist);
    // Advance the rolling history AFTER detecting (so the current point never baselines itself). The
    // trap state is recorded here so future baselines can tell a permanent one-sided book from a new one.
    if (cur.mid != null || cur.spread != null || cur.bandDepth != null || cur.trap) {
      state.bookHist[m.marketId] = [...hist, { t: now, ...cur }].slice(-BOOK_HIST_MAX);
    }

    // ── Combine per the book-primary severity policy (signal.js) ──
    const signal = buildSignal({ marketId: m.marketId, book, news: ns, ts: now });

    // ── PERSISTED, HYSTERETIC REGIME (lib/news-guard/regime.js) ──
    // Turn the instantaneous per-cycle severity into a stateful regime with a cool-off HOLD so a
    // multi-snapshot move is ONE elevated episode, not a fresh fire every cycle (measured: 47% fewer
    // firings on the 30-day replay). The regime's effective severity DRIVES the UI + action layer, so
    // the panel and the withdraw gate see the stable state, not the per-cycle twitch. EVENT ('high')
    // still requires book+news by construction — the machine never manufactures high from book alone.
    const prevRegime = state.regimeState[m.marketId] || null;
    const regime = stepRegime({
      prev: prevRegime, severity: signal.severity, source: signal.source,
      summary: signal.evidence.summary, sample: { mid: cur.mid, spread: cur.spread },
      resolved: false,   // no resolved/acceptingOrders field in our snapshot; resolved markets drop out
      now,
    });
    state.regimeState[m.marketId] = {
      state: regime.state, since: regime.since, calmStreak: regime.calmStreak,
      frozenStreak: regime.frozenStreak, lastMid: regime.lastMid, lastSpread: regime.lastSpread,
      evidence: regime.evidence,
    };
    if (regime.transition && isElevatedState(regime.transition.to) && !isElevatedState(regime.transition.from)) {
      log(`regime ${regime.transition.from}→${regime.transition.to} on ${m.marketId} (${signal.source}: ${signal.evidence.summary || 'book move'})`);
    }
    // The regime's effective severity replaces the raw per-cycle severity everywhere downstream.
    signal.severity = regime.severity;
    signal.regime = { state: regime.state, since: regime.since, cooling: regime.cooling, frozenStreak: regime.frozenStreak };

    signalByMarket[m.marketId] = { signal, market: m };
    const newsRisk = signal.severity;   // 'low' | 'medium' | 'high' | 'unknown' (regime-effective)

    const signals = [{ source: 'order-book-move', note: signal.evidence.summary || bs.note }];
    if (ns.level !== 'unknown') signals.push({ source: ns.source, note: ns.note });

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
      newsRisk,                                   // = regime-effective severity (book-primary policy + hysteresis)
      severity: signal.severity, source: signal.source, evidence: signal.evidence,
      regime: signal.regime,                      // { state, since, cooling, frozenStreak } — hysteretic state + evidence
      regimeEvidence: state.regimeState[m.marketId] ? state.regimeState[m.marketId].evidence : null,
      bookRisk: book.fired ? 'medium' : 'low',    // book-only severity (caps at medium)
      newsSignal: ns.level !== 'unknown' ? ns.level : null,   // null ⇒ uncovered ("—"), never implicit "calm"
      newsCorroboration: ns.level !== 'unknown'
        ? { distinctPublishers: ns.distinctPublishers, distinctClusters: ns.distinctClusters, publishers: ns.publishers, minSources: cor.minSources, recentH: cor.recentH, matched: cor.matched }
        : null,
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
  // The real keyLiveVerified fact for Polymarket, read once per scan (false everywhere until a human
  // derives + verifies a key). Still gated by NG.armed=false downstream → shadow regardless.
  const pmVerified = await getPolymarketVerified();
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
      config: NG, keyState: keyStateFor(sm.market.venue, pmVerified), rails, now,
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
      newsQueried,                                 // targeted entity queries issued to query-providers this cycle
      highCount: highs.length,
      medCount: meds.length,
      placementsTracked: placements.length,
      // News-layer coverage + dedup, measured this cycle (Phase 5 numbers live here honestly).
      news: {
        itemsFetched: collectRes.items.length,
        clustersAfterDedup: dedupStats.clusters,
        dedupRate: dedupStats.dedupRate,
        marketsCovered: newsCovered,               // markets with ≥1 recent matched item (vs old fixed top-30)
        marketsCorroborated: newsCorroborated,     // markets where ≥N distinct publishers agreed (news→medium)
        perProvider: collectRes.perProvider,
        corroboration: { minDistinctSources: require('../lib/news-guard/corroborate').MIN_DISTINCT_SOURCES, recencyHours: Math.round(RECENCY_MS / 3_600_000), rule: 'news level → medium only when ≥N DISTINCT publishers carry an entity-matched story within the recency window; caps at medium so news alone never reaches high' },
      },
      // Execution posture — the UI reads THESE (not env) so the panel can't misstate arming.
      armed: NG.armed,
      killSwitch: NG.killSwitch,
      executionMode: NG.armed && !NG.killSwitch ? 'armed' : 'shadow',
      liveExecution: 'OFF (disarmed — shadow only)',
      shadow: { written: shadowWritten, withdraw: shadowActs, suppressed: shadowSuppressed },
      sources: sourcesStatus,
      severityPolicy: 'book-primary + hysteresis: book alone→medium (ELEVATED); book+news→high (EVENT); news alone→low. A persisted regime holds an elevated state through a 1-snapshot cool-off so a multi-snapshot move is one episode, not a per-cycle re-fire. Every severity traces to measured evidence.',
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
  // A severity-HIGH market is book+corroborated-news by construction, so its news level is 'medium'
  // (corroborate caps news at medium — it never emits 'high'). Alert on those + structural TRAP.
  const newsyHighs     = highs.filter(h => h.newsSignal === 'medium' || h.newsSignal === 'high' || (h.signals[0]?.note || '').includes('TRAP'));
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

  // prune stale alert/cooldown entries, then persist (after any send-stamp above)
  for (const k of Object.keys(state.alerted))  if (now - state.alerted[k]  > 24 * 3_600_000) delete state.alerted[k];
  delete state.newsCache;   // legacy per-market news cache — replaced by the once-per-cycle provider collect
  // Drop rolling book history for markets no longer in the snapshot (bounded state file).
  const liveIds = new Set(markets.map(m => m.marketId));
  for (const k of Object.keys(state.bookHist))       if (!liveIds.has(k)) delete state.bookHist[k];
  for (const k of Object.keys(state.regimeState))    if (!liveIds.has(k)) delete state.regimeState[k];
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
    const pm = providerMeta().map(p => `${p.id}${p.enabled ? '' : '(off)'}`).join(', ');
    log(`news-guard online — advisory only, live execution ${AUTO_EXECUTE_ENABLED ? 'ON' : 'OFF'}. Free news providers: ${pm}. Excluded: X API (paid since Feb 2026), AP/Reuters/ESPN (no free automated feed).`);
    await sleep(STARTUP_DELAY_MS);
    while (true) {
      try { await scan(); }
      catch (e) { log('cycle error (non-fatal):', e.message); }
      await sleep(SCAN_INTERVAL_MS);
    }
  })();
}

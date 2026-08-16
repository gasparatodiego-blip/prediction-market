#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent39-net-rerun — automate the TRIGGER for the rewards NET verdict, never the conclusion.
//
// The net verdict (scripts/rewards-replay/run.js --method tape) is only meaningful once ≥48h of REAL tape
// exists; until then the replay refuses to annualise. An operator would otherwise have to remember to
// re-run it over the weekend. This agent measures the ACTUAL tape window on a schedule and, the moment it
// reaches a genuine 48h of CONTINUOUS coverage, runs the replay once, writes the full result to a dated
// file, and sends ONE Telegram headline (window hours, fills, markout mean/median, gross, cost, net, and
// whether it clears the ~4% risk-free rate).
//
// IT DOES NOT RUN EARLY AND DOES NOT RELAX THE GUARD. Its gate is STRICTER than the replay's: the replay
// guards on the window SPAN (toMs-fromMs); this agent gates on continuous COVERAGE = span − Σ(outage gaps),
// using the mid-history sampler (fixed 45s cadence) as the uptime reference. A FRAGMENTED window — agent34
// restarting mid-collection leaves gaps in mid-history and therefore the tape — is NOT a 48h window: it is
// reported as fragmented with the gaps stated, and the agent keeps waiting. It places/signs/decrypts nothing.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const { httpPost: _httpPost } = require('../lib/httpGet');

// ── Load .env (pm2 doesn't auto-load; TELEGRAM_* live in .env) ──
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* try next */ }
}

const ROOT       = path.join(__dirname, '..');
const DATA_DIR   = path.join(ROOT, 'data');
const HB_FILE    = '/tmp/agent-heartbeats.json';
const HB_KEY     = 'agent39-net-rerun';
const STATE_FILE = '/tmp/net-rerun-state.json';
const SUMMARY    = '/tmp/rewards-replay/summary.json';

const REQUIRED_HOURS    = Number(process.env.NET_RERUN_REQUIRED_HOURS || 48);
// A mid-history gap beyond this = agent34 was DOWN (the 45s sampler missed >6 samples). Sub-5min jitter
// (GC pause, a slow write) is not an outage. This is what turns a span into honest continuous coverage.
const GAP_THRESHOLD_MS  = Number(process.env.NET_RERUN_GAP_THRESHOLD_MS || 300_000); // 5 min
const CHECK_INTERVAL_MS = Number(process.env.NET_RERUN_CHECK_INTERVAL_MS || 3_600_000); // hourly — window grows 1h/h
const REPLAY_TIMEOUT_MS = Number(process.env.NET_RERUN_REPLAY_TIMEOUT_MS || 240_000);

function log(...a) { console.log('[A39]', ...a); }
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { log('state write failed:', e.message); } }
function heartbeat() {
  let hb = {}; try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')) || {}; } catch { /* fresh */ }
  hb[HB_KEY] = Date.now();
  try { const tmp = HB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(hb)); fs.renameSync(tmp, HB_FILE); } catch { /* best-effort */ }
}

async function sendTelegram(text) {
  if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') return false;   // global mute
  if (process.env.NET_RERUN_TELEGRAM_MUTED === 'true') return false;   // per-agent mute
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { log('telegram not configured — message not sent'); return false; }
  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  try { await _httpPost(`${base}/bot${token}/sendMessage`, { chat_id: chat, text, parse_mode: 'HTML' }, { timeoutMs: 15_000 }); return true; }
  catch (e) { log('sendTelegram error:', e.message); return false; }
}

function dailyFiles(prefix) {
  let files; try { files = fs.readdirSync(DATA_DIR); } catch { return []; }
  const re = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.jsonl$`);
  return files.filter((f) => re.test(f)).sort().map((f) => path.join(DATA_DIR, f));
}

// Stream the `ts` (ISO) from every mid-history row and the tsVenueMs from every tape row — never buffer a day.
function streamField(file, extract) {
  return new Promise((resolve) => {
    const out = [];
    let stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); } catch { return resolve(out); }
    stream.on('error', () => resolve(out));
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (l) => { if (!l) return; const v = extract(l); if (v != null && isFinite(v)) out.push(v); });
    rl.on('close', () => resolve(out));
    rl.on('error', () => resolve(out));
  });
}

// ── PURE window measurement (exported for the selfcheck) ────────────────────────
// Continuous coverage over the tape span, with mid-history gaps subtracted. Deterministic given the arrays.
//   tapeMs  — sorted-or-unsorted array of tape row epoch-ms
//   midMs   — array of mid-history row epoch-ms (the fixed 45s uptime reference)
function measureWindow(tapeMs, midMs, gapThresholdMs = GAP_THRESHOLD_MS) {
  if (!tapeMs.length) return { hasTape: false, tapeSpanHours: 0, coverageHours: 0, gaps: [], totalGapHours: 0, fragmented: false };
  const tSorted = [...tapeMs].sort((a, b) => a - b);
  const from = tSorted[0], to = tSorted[tSorted.length - 1];
  const spanMs = to - from;
  // gaps come from the mid-history timeline WITHIN [from, to] (the uptime reference), not the sparse tape.
  const mids = midMs.filter((t) => t >= from && t <= to).sort((a, b) => a - b);
  const gaps = [];
  let totalGapMs = 0;
  // include the shoulders: from→first mid, last mid→to (a gap at either end is still lost coverage).
  const seq = [from, ...mids, to];
  for (let i = 1; i < seq.length; i++) {
    const d = seq[i] - seq[i - 1];
    if (d > gapThresholdMs) { gaps.push({ fromMs: seq[i - 1], toMs: seq[i], minutes: Math.round(d / 60000) }); totalGapMs += d; }
  }
  const coverageMs = Math.max(0, spanMs - totalGapMs);
  return {
    hasTape: true,
    tapeSpanHours: spanMs / 3_600_000,
    coverageHours: coverageMs / 3_600_000,
    gaps,
    totalGapHours: totalGapMs / 3_600_000,
    fragmented: gaps.length > 0,
    fromMs: from, toMs: to,
  };
}

// ── PURE decision (exported) ─ what to do given the measured window + prior state ──
function decide(win, state, requiredHours = REQUIRED_HOURS) {
  if (state && state.ran) return { action: 'done' };
  if (!win.hasTape) return { action: 'wait', why: 'no tape yet' };
  if (win.coverageHours >= requiredHours) return { action: 'run', why: `continuous coverage ${win.coverageHours.toFixed(2)}h ≥ ${requiredHours}h` };
  if (win.tapeSpanHours >= requiredHours && win.coverageHours < requiredHours) {
    return { action: 'fragmented', why: `span ${win.tapeSpanHours.toFixed(2)}h but only ${win.coverageHours.toFixed(2)}h continuous (${win.gaps.length} gap(s), ${win.totalGapHours.toFixed(2)}h lost)` };
  }
  return { action: 'wait', why: `continuous coverage ${win.coverageHours.toFixed(2)}h < ${requiredHours}h — waiting` };
}

// ── PURE headline formatter (exported) — the exact fields the task requires ──
const money = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2));
const cents = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + Number(x).toFixed(2) + '¢');
function formatHeadline(summary, win) {
  const suf = summary.sufficiency || {};
  const mo = ((summary.markout || {}).all || {})['5m'] || { cents: {} };
  const net = (summary.net || {}).stale_inclusive || {};
  const clears = suf.annualisedNetPct == null ? '—'
    : (suf.annualisedNetPct > 4 ? `CLEARS ~4% risk-free (${suf.annualisedNetPct.toFixed(2)}%/yr · run-rate, not guaranteed)`
                                : `FAILS ~4% risk-free (${suf.annualisedNetPct.toFixed(2)}%/yr)`);
  const frag = win && win.fragmented ? `\n<b>window integrity:</b> ${win.gaps.length} gap(s), ${win.totalGapHours.toFixed(2)}h lost (span ${win.tapeSpanHours.toFixed(2)}h → ${win.coverageHours.toFixed(2)}h continuous)` : '';
  return (
    `📊 <b>Rewards NET verdict</b> (tape, +5m markout)\n` +
    `<b>window:</b> ${Number(suf.windowHours || 0).toFixed(2)}h · <b>fills:</b> ${summary.fills}\n` +
    `<b>markout:</b> mean ${cents(mo.cents.mean)} / median ${cents(mo.cents.median)}\n` +
    `<b>gross:</b> ${money(net.grossWindow)} · <b>cost:</b> ${money((net.costWindow || {})['5m'])} · <b>net:</b> ${money((net.netWindow || {})['5m'])}\n` +
    `<b>verdict:</b> ${clears}${frag}`
  );
}

function runReplay() {
  return new Promise((resolve) => {
    log('running scripts/rewards-replay/run.js --method tape …');
    execFile('node', ['scripts/rewards-replay/run.js', '--method', 'tape'], { cwd: ROOT, timeout: REPLAY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err) => {
      if (err) { log('replay failed:', err.message); return resolve(null); }
      try { resolve(JSON.parse(fs.readFileSync(SUMMARY, 'utf8'))); }
      catch (e) { log('could not read replay summary:', e.message); resolve(null); }
    });
  });
}

function datedOutPath() {
  // stamp with the toMs day of the analysed window, not wall-clock, so the file names the data it describes.
  const iso = new Date().toISOString().slice(0, 10);
  return path.join(DATA_DIR, `rewards-replay-net-${iso}.json`);
}

async function check() {
  const state = readState();
  const tapeMs = (await Promise.all(dailyFiles('trade-tape').map((f) => streamField(f, (l) => { try { return JSON.parse(l).tsVenueMs; } catch { return null; } })))).flat();
  const midMs  = (await Promise.all(dailyFiles('mid-history').map((f) => streamField(f, (l) => { const m = l.match(/"ts":"([^"]+)"/); return m ? Date.parse(m[1]) : null; })))).flat();

  const win = measureWindow(tapeMs, midMs);
  const d = decide(win, state);
  log(`tape span ${win.tapeSpanHours.toFixed(2)}h · continuous ${win.coverageHours.toFixed(2)}h · gaps ${win.gaps.length} (${win.totalGapHours.toFixed(2)}h) → ${d.action}${d.why ? ' — ' + d.why : ''}`);

  if (d.action === 'run') {
    const summary = await runReplay();
    if (summary && summary.sufficiency && summary.sufficiency.suffices) {
      const outPath = datedOutPath();
      try { fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), window: win, summary }, null, 2)); log('wrote', outPath); } catch (e) { log('dated write failed:', e.message); }
      const sent = await sendTelegram(formatHeadline(summary, win));
      log(sent ? 'NET verdict sent (single-shot)' : 'NET verdict computed; telegram suppressed (muted/unconfigured) — result on disk');
      writeState({ ...state, ran: true, ranAt: Date.now(), outPath });
    } else {
      // The replay's own span-guard still refused (should not happen once coverage≥48h, but never annualise early).
      log('replay did not certify sufficiency — NOT sending a verdict, will retry next cycle');
    }
  } else if (d.action === 'fragmented' && !state.fragAlerted) {
    const gapLines = win.gaps.slice(0, 8).map((g) => `  • ${new Date(g.fromMs).toISOString()} → ${new Date(g.toMs).toISOString()} (${g.minutes}min)`).join('\n');
    await sendTelegram(
      `⚠️ <b>Rewards tape window is FRAGMENTED</b>\n` +
      `Span ${win.tapeSpanHours.toFixed(2)}h but only <b>${win.coverageHours.toFixed(2)}h continuous</b> — ${win.gaps.length} outage(s) totalling ${win.totalGapHours.toFixed(2)}h (agent34 restarted mid-collection).\n` +
      `A fragmented window is NOT a 48h window; the net verdict stays on hold until 48h of continuous coverage exist.\n${gapLines}`,
    );
    writeState({ ...state, fragAlerted: true });
    log('fragmentation reported (single-shot)');
  }
  heartbeat();
}

function start() {
  log(`starting — require ${REQUIRED_HOURS}h continuous coverage (gap threshold ${GAP_THRESHOLD_MS / 60000}min), check every ${CHECK_INTERVAL_MS / 60000}min`);
  heartbeat();
  check().catch((e) => log('check error:', e.message));
  setInterval(() => check().catch((e) => log('check error:', e.message)), CHECK_INTERVAL_MS);
}

module.exports = { measureWindow, decide, formatHeadline, sendTelegram, GAP_THRESHOLD_MS, REQUIRED_HOURS };

if (require.main === module) start();

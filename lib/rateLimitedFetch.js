'use strict';

// Shared per-HOST rate limiter around lib/httpGet — ONE implementation for every
// venue whose public API needs many per-symbol calls (edgeX, Grvt, future venues).
//
// Why this exists: firing ~20 parallel ticker requests at a single host every 60s
// tripped edgeX's Cloudflare bot-protection (HTTP 429 / "Just a moment…" challenge),
// which zeroed the venue and dropped its legs from spreads. This wrapper:
//   1. Caps per-host concurrency to a small pool (default 2) — never a 20-wide fan-out.
//   2. Spaces consecutive request starts to the same host (default 120ms).
//   3. On HTTP 429 or a Cloudflare/HTML challenge, backs the WHOLE host off
//      exponentially with jitter (2s → 60s cap) and fast-fails further calls until it
//      clears — so callers render the venue as absent/Signal (honest), never hammer
//      through the limit, and never fabricate or reuse stale values as fresh.
//
// State is per-process (agent10 and agent15 each keep their own), which is fine: the
// goal is that no single process fans out unbounded to a host. Purely a networking
// wrapper — it does not touch any funding/capacity/fee value.

const { httpGet, httpPost } = require('./httpGet');

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_SPACING_MS   = 120;
const BACKOFF_BASE_MS      = 2_000;
const BACKOFF_CAP_MS       = 60_000;
const BACKOFF_MAX_EXP      = 5;

const hosts = new Map(); // host → limiter state

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url); }
}

function stateFor(url, opts) {
  const host = hostOf(url);
  let s = hosts.get(host);
  if (!s) {
    s = {
      host,
      active: 0,
      queue: [],
      lastStart: 0,
      backoffUntil: 0,
      exp: 0,
      concurrency:  opts.concurrency  ?? DEFAULT_CONCURRENCY,
      spacingMs:    opts.spacingMs    ?? DEFAULT_SPACING_MS,
      backoffCapMs: opts.backoffCapMs ?? BACKOFF_CAP_MS,
    };
    hosts.set(host, s);
  }
  return s;
}

// A 429 surfaces either as a rejected promise (Cloudflare returns an HTML challenge →
// httpGet fails JSON.parse with "bad JSON: <!DOCTYPE html…") or as a resolved response
// with status 429 (APIs that return a JSON error body). Cover both.
function isRateLimited(err) {
  const m = String((err && err.message) || '');
  return /\b429\b/.test(m)
    || /just a moment|attention required|cloudflare|cf-chl|challenge|<!doctype html|<html/i.test(m);
}

function pump(s) {
  // Host in backoff → drain the queue as fast-fail so this cycle's calls are simply
  // absent (honest), instead of hammering through the rate limit.
  if (Date.now() < s.backoffUntil) {
    const leftS = Math.round((s.backoffUntil - Date.now()) / 1000);
    while (s.queue.length) {
      s.queue.shift().reject(new Error(`[rate-limit] ${s.host} in backoff (${leftS}s left) — call skipped`));
    }
    return;
  }
  while (s.active < s.concurrency && s.queue.length) {
    const since = Date.now() - s.lastStart;
    if (since < s.spacingMs) {
      setTimeout(() => pump(s), s.spacingMs - since + 1);
      return;
    }
    const job = s.queue.shift();
    s.active++;
    s.lastStart = Date.now();
    Promise.resolve()
      .then(job.run)
      .then(
        (r) => { s.exp = 0; job.resolve(r); },   // success resets the backoff ladder
        (e) => {
          if (isRateLimited(e)) {
            s.exp = Math.min(s.exp + 1, BACKOFF_MAX_EXP);
            const base   = Math.min(s.backoffCapMs, BACKOFF_BASE_MS * 2 ** (s.exp - 1));
            const jitter = Math.floor(Math.random() * base * 0.25);
            s.backoffUntil = Date.now() + base + jitter;
            console.warn(`[rate-limit] ${s.host} 429/challenge — backing off ${Math.round((base + jitter) / 1000)}s (exp=${s.exp})`);
          }
          job.reject(e);
        },
      )
      .finally(() => { s.active--; pump(s); });
  }
}

function enqueue(url, opts, run) {
  const s = stateFor(url, opts);
  return new Promise((resolve, reject) => {
    s.queue.push({ run, resolve, reject });
    pump(s);
  });
}

// Same signatures/return shape as httpGet/httpPost ({ status, headers, data }), but
// scheduled through the per-host limiter. A resolved 429 is re-thrown so it trips the
// same backoff path as a rejected challenge.
function rlGet(url, opts = {}) {
  return enqueue(url, opts, async () => {
    const r = await httpGet(url, opts);
    if (r && r.status === 429) throw new Error(`HTTP 429 rate-limited: ${hostOf(url)}`);
    return r;
  });
}

function rlPost(url, body, opts = {}) {
  return enqueue(url, opts, async () => {
    const r = await httpPost(url, body, opts);
    if (r && r.status === 429) throw new Error(`HTTP 429 rate-limited: ${hostOf(url)}`);
    return r;
  });
}

// True if the host for `url` is currently in Cloudflare/429 backoff. Lets a caller skip
// a high-frequency per-symbol loop for a cycle (serving a bulk fallback instead) rather
// than queue calls that would all fast-fail. Read-only — never mutates limiter state.
function isHostBackedOff(url) {
  const s = hosts.get(hostOf(url));
  return !!(s && Date.now() < s.backoffUntil);
}

module.exports = { rlGet, rlPost, isRateLimited, isHostBackedOff };

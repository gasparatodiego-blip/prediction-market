'use strict';
// Shared wall-clock HTTP GET helper for agent scripts.
// Replaces the vulnerable { timeout: ms } + req.on('timeout') pattern, which
// only fires on socket INACTIVITY and hangs when a server streams slow
// keep-alive chunks.  This helper installs a hard wall-clock deadline that
// fires regardless of per-chunk activity, matching the pattern in agent24/25.

const https = require('https');
const http  = require('http');

/**
 * GET url and resolve { status, headers, data } where data is parsed JSON.
 * Rejects on network error, wall-clock timeout, or JSON parse failure.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, headers?: object }} [opts]
 */
function httpGet(url, { timeoutMs = 15_000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let res;
    // Single cleanup choke point — guarded by `settled` so it runs exactly
    // once no matter which event fires first (end, req error, res error,
    // timeout). Always clears the deadline timer and destroys req/res so a
    // timed-out response (headers received, stream never finished) doesn't
    // stay referenced by Node's http machinery after we've moved on.
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      if (res) res.destroy();
      fn(val);
    };

    // Hard wall-clock deadline — fires even when the server trickles data
    // keeping the socket alive (the failure mode that stalled agent20 for 6 days).
    // eslint-disable-next-line prefer-const
    let deadline;
    const req = (url.startsWith('http:') ? http : https).get(url, { headers }, r => {
      res = r;
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        try   { settle(resolve, { status: res.statusCode, headers: res.headers, data: JSON.parse(body) }); }
        catch (e) { settle(reject, new Error(`HTTP ${res.statusCode} / bad JSON: ${body.slice(0, 80)}`)); }
      });
      res.on('error', e => settle(reject, e));
    });
    deadline = setTimeout(() => settle(reject, new Error('wall-clock timeout: ' + url.slice(0, 80))), timeoutMs);
    req.on('error', e => settle(reject, e));
  });
}

/**
 * POST url with a JSON body and resolve { status, headers, data }.
 * body may be a pre-serialised string or an object (will be JSON.stringify'd).
 * Rejects on network error, wall-clock timeout, or JSON parse failure.
 *
 * @param {string} url
 * @param {string|object} body
 * @param {{ timeoutMs?: number, headers?: object }} [opts]
 */
function httpPost(url, body, { timeoutMs = 15_000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const u = new URL(url);

    let settled = false;
    let res;
    // Single cleanup choke point — see httpGet() above for rationale.
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      if (res) res.destroy();
      fn(val);
    };

    let deadline;
    const req = (url.startsWith('http:') ? http : https).request({
      hostname: u.hostname,
      port:     u.port || undefined,
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, r => {
      res = r;
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const respBody = Buffer.concat(chunks).toString();
        try   { settle(resolve, { status: res.statusCode, headers: res.headers, data: JSON.parse(respBody) }); }
        catch (e) { settle(reject, new Error(`HTTP ${res.statusCode} / bad JSON: ${respBody.slice(0, 80)}`)); }
      });
      res.on('error', e => settle(reject, e));
    });
    deadline = setTimeout(() => settle(reject, new Error('wall-clock timeout: ' + url.slice(0, 80))), timeoutMs);
    req.on('error', e => settle(reject, e));
    req.write(payload);
    req.end();
  });
}

module.exports = { httpGet, httpPost };

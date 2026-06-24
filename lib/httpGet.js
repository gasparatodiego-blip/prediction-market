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
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    // Hard wall-clock deadline — fires even when the server trickles data
    // keeping the socket alive (the failure mode that stalled agent20 for 6 days).
    // eslint-disable-next-line prefer-const
    let deadline;
    const req = (url.startsWith('http:') ? http : https).get(url, { headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(deadline);
        const body = Buffer.concat(chunks).toString();
        try   { settle(resolve, { status: res.statusCode, headers: res.headers, data: JSON.parse(body) }); }
        catch (e) { settle(reject, new Error(`HTTP ${res.statusCode} / bad JSON: ${body.slice(0, 80)}`)); }
      });
    });
    deadline = setTimeout(() => { req.destroy(); settle(reject, new Error('wall-clock timeout: ' + url.slice(0, 80))); }, timeoutMs);
    req.on('error', e => { clearTimeout(deadline); settle(reject, e); });
  });
}

module.exports = { httpGet };

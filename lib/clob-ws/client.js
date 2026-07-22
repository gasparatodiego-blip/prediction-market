'use strict';
// lib/clob-ws/client.js — Polymarket CLOB market-channel WebSocket client.
//
// Public, keyless feed: wss://ws-subscriptions-clob.polymarket.com/ws/market
// (protocol confirmed from docs.polymarket.com/developers/CLOB/websocket).
//
// This is a THIN transport: it owns the socket, the heartbeat, and reconnect —
// nothing about order books or rewards. It emits parsed protocol events; a
// consumer (LiveBookStore) maintains the books. Read-only by construction:
// there is no send path other than subscribe/unsubscribe/PING. It CANNOT place,
// cancel, or sign anything — the market channel takes no auth and no orders.
//
// Reconnect/watchdog mirror the battle-tested agent30 pattern (exponential
// backoff + a silent-socket watchdog that terminates half-open connections so a
// 'close' fires and re-subscribe runs). The heartbeat follows the documented
// rule: send PING every 10s; the server replies PONG; miss it and you're dropped.

const EventEmitter = require('events');
const WebSocket = require('ws');

const DEFAULT_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Heartbeat + liveness constants are PROTOCOL-DERIVED, not tuning knobs:
//   PING_INTERVAL_MS — docs: "Send PING every 10 seconds."
//   WATCHDOG_MS      — 3 missed heartbeats of silence ⇒ half-open socket, force reconnect.
// (Both are surfaced as opts so a measurement harness can override; production uses these.)
const PING_INTERVAL_MS = 10_000;
const WATCHDOG_MS = 35_000;
const MAX_BACKOFF_MS = 30_000;

class ClobWsClient extends EventEmitter {
  /**
   * @param {object} [opts]
   *   url            — override endpoint (default market channel)
   *   pingIntervalMs — heartbeat cadence (default 10s, per protocol)
   *   watchdogMs     — silence before force-reconnect (default 35s)
   *   logger         — fn(...args) for logs (default noop)
   */
  constructor(opts = {}) {
    super();
    this.url = opts.url || DEFAULT_URL;
    this.pingIntervalMs = opts.pingIntervalMs || PING_INTERVAL_MS;
    this.watchdogMs = opts.watchdogMs || WATCHDOG_MS;
    this.log = opts.logger || (() => {});

    this.ws = null;
    this.connected = false;
    this.closingByUs = false;
    this.desired = new Set();      // assetIds we want subscribed (survives reconnect)
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.watchdogTimer = null;

    this.lastMsgTs = 0;            // any inbound frame (event OR pong)
    this.lastEventTs = 0;         // last DATA event (book/price_change/…), not a pong
    this.lastPongTs = 0;
    this.connectedAt = 0;
    this.msgCount = 0;
  }

  /** Assets currently desired (subscribed across reconnects). */
  get subscriptions() {
    return [...this.desired];
  }

  /** Age (ms) since the last inbound frame of any kind, or Infinity if never. */
  silenceMs(now = Date.now()) {
    return this.lastMsgTs ? now - this.lastMsgTs : Infinity;
  }

  connect() {
    if (this.ws) return;
    this.closingByUs = false;
    this.log(`connecting → ${this.url} (attempt ${this.reconnectAttempts + 1})`);
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.log('construct failed:', e.message);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.connectedAt = Date.now();
      this.lastMsgTs = this.connectedAt;
      this.reconnectAttempts = 0;
      this.log(`open — resubscribing ${this.desired.size} asset(s)`);
      // Re-establish every desired subscription. Missed deltas during the gap are
      // gone (no server replay) — the consumer must REST-resnapshot; we emit 'open'
      // so it can. Never serve the pre-gap book as live.
      if (this.desired.size) this._sendSubscribe([...this.desired]);
      this._startPing();
      this._startWatchdog();
      this.emit('open');
    });

    ws.on('message', (buf) => {
      const now = Date.now();
      this.lastMsgTs = now;
      this.msgCount++;
      const text = buf.toString();
      // The server heartbeat reply is a bare "PONG" text frame, not JSON.
      if (text === 'PONG' || text === 'PING') {
        this.lastPongTs = now;
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON, non-PONG frame — treat as a liveness signal only, never a book.
        return;
      }
      this.lastEventTs = now;
      // The market channel batches events as an array; single objects also occur.
      const events = Array.isArray(parsed) ? parsed : [parsed];
      for (const ev of events) {
        if (ev && ev.event_type) this.emit('event', ev, now);
      }
    });

    ws.on('error', (e) => this.log('ws error:', e.message));

    ws.on('close', (code) => {
      this.connected = false;
      this._stopPing();
      this._stopWatchdog();
      this.ws = null;
      this.emit('close', code);
      if (this.closingByUs) {
        this.log(`closed (code ${code}) — shutdown, not reconnecting`);
        return;
      }
      this._scheduleReconnect(code);
    });
  }

  /** Add assets to the desired set and subscribe (if connected). Idempotent. */
  subscribe(assetIds) {
    const fresh = [];
    for (const id of assetIds) {
      const s = String(id);
      if (!this.desired.has(s)) { this.desired.add(s); fresh.push(s); }
    }
    if (fresh.length && this.connected) this._sendSubscribe(fresh, /*isDelta*/ true);
    return fresh;
  }

  /** Remove assets from the desired set and unsubscribe (if connected). */
  unsubscribe(assetIds) {
    const gone = [];
    for (const id of assetIds) {
      const s = String(id);
      if (this.desired.delete(s)) gone.push(s);
    }
    if (gone.length && this.connected) {
      try {
        this.ws.send(JSON.stringify({ assets_ids: gone, type: 'market', operation: 'unsubscribe' }));
      } catch (e) { this.log('unsubscribe send failed:', e.message); }
    }
    return gone;
  }

  close() {
    this.closingByUs = true;
    clearTimeout(this.reconnectTimer);
    this._stopPing();
    this._stopWatchdog();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connected = false;
  }

  // ── internals ──

  _sendSubscribe(assetIds, isDelta = false) {
    if (!this.ws) return;
    // Initial subscribe: base message. Delta (add on a live socket): operation-tagged.
    const msg = { assets_ids: assetIds, type: 'market' };
    if (isDelta) msg.operation = 'subscribe';
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      this.log('subscribe send failed:', e.message);
    }
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws || !this.connected) return;
      // App-level heartbeat: the market channel expects a "PING" text frame; it
      // replies "PONG". (Also send a protocol ping frame as a belt-and-braces.)
      try { this.ws.send('PING'); } catch { /* socket dying; watchdog handles it */ }
      try { if (this.ws.readyState === WebSocket.OPEN) this.ws.ping(); } catch { /* ignore */ }
    }, this.pingIntervalMs);
  }

  _stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } }

  _startWatchdog() {
    this._stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (!this.ws || !this.connected) return;
      const silent = this.silenceMs();
      if (silent > this.watchdogMs) {
        // Half-open socket: 'close' never fired, so reconnect can't run. Terminate
        // to force a real 'close' → reconnect → resubscribe. Never keep serving a
        // book behind a dead socket.
        this.log(`silent ${(silent / 1000).toFixed(0)}s while "connected" — forcing reconnect`);
        this.emit('watchdog-reconnect', silent);
        try { (this.ws.terminate ? this.ws.terminate() : this.ws.close()); } catch { /* ignore */ }
      }
    }, Math.min(this.watchdogMs, 10_000));
  }

  _stopWatchdog() { if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; } }

  _scheduleReconnect(code) {
    this.reconnectAttempts++;
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, Math.min(this.reconnectAttempts, 5)));
    this.log(`closed (code ${code ?? '—'}) — reconnecting in ${backoff}ms`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), backoff);
  }
}

module.exports = { ClobWsClient, DEFAULT_URL, PING_INTERVAL_MS, WATCHDOG_MS };

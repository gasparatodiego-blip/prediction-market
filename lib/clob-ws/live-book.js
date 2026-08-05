'use strict';
// lib/clob-ws/live-book.js — in-memory live order books maintained from the CLOB
// market-channel stream: full `book` snapshots + incremental `price_change` deltas.
//
// Honest-engine core: a book is LIVE only when it has a snapshot AND has heard a
// real event within the staleness window AND is not flagged for resnapshot. Any
// of those failing makes it STALE — the consumer must fall back to REST and say
// so. We never present a book behind a dead/lagging socket as live.
//
// The protocol gives a `hash` on book/price_change but NO monotonic sequence
// number, so a dropped delta is not directly detectable mid-stream. Our defences:
//   1. a price_change for an asset we have no snapshot for ⇒ flag resnapshot
//      (can't apply a delta to a book we never seeded);
//   2. on reconnect the consumer REST-resnapshots every desired asset;
//   3. staleness (no event within the window) ⇒ STALE ⇒ REST fallback.
// applySnapshot() (REST) and the `book` event both fully replace the book and
// clear the resnapshot flag — the only two trusted sources of truth.

// Prices arrive as strings on the wire. We key levels by the EXACT wire string to
// avoid float-identity drift (0.055 vs 0.055000001), and parse to float only when
// sorting or handing books to the reward math.
function emptyBook() {
  return {
    bids: new Map(),        // priceStr -> sizeNum
    asks: new Map(),        // priceStr -> sizeNum
    hash: null,
    tickSize: null,
    bestBid: null,          // last server-reported best (string) — advisory only
    bestAsk: null,
    lastTradePrice: null,
    lastEventTs: 0,
    snapshotTs: 0,          // when we last got a FULL book (ws snapshot or REST)
    needsResnapshot: false,
  };
}

class LiveBookStore {
  constructor() {
    this.books = new Map(); // assetId -> book
  }

  has(assetId) { return this.books.has(String(assetId)); }
  size() { return this.books.size; }
  assets() { return [...this.books.keys()]; }

  _book(assetId) {
    const id = String(assetId);
    let b = this.books.get(id);
    if (!b) { b = emptyBook(); this.books.set(id, b); }
    return b;
  }

  /** Full replace from an array of {price,size}. Shared by ws `book` + REST resnapshot. */
  _replace(book, bidsArr, asksArr, now, hash, tickSize) {
    book.bids = new Map();
    book.asks = new Map();
    for (const o of bidsArr || []) {
      const size = parseFloat(o.size);
      if (o.price != null && size > 0) book.bids.set(String(o.price), size);
    }
    for (const o of asksArr || []) {
      const size = parseFloat(o.size);
      if (o.price != null && size > 0) book.asks.set(String(o.price), size);
    }
    if (hash != null) book.hash = hash;
    if (tickSize != null) book.tickSize = tickSize;
    book.snapshotTs = now;
    book.lastEventTs = now;
    book.needsResnapshot = false;
  }

  /** Seed/replace a book from a REST GET /book payload ({bids,asks,tick_size,hash}). */
  applySnapshot(assetId, restBook, now = Date.now()) {
    if (!restBook) return;
    const b = this._book(assetId);
    const tick = restBook.tick_size != null ? parseFloat(restBook.tick_size) : null;
    this._replace(b, restBook.bids, restBook.asks, now, restBook.hash ?? null, Number.isFinite(tick) ? tick : null);
  }

  /** Ingest one parsed protocol event. Returns { assetId, needsResnapshot }. */
  ingest(ev, now = Date.now()) {
    switch (ev.event_type) {
      case 'book': {
        const b = this._book(ev.asset_id);
        const tick = ev.tick_size != null ? parseFloat(ev.tick_size) : null;
        this._replace(b, ev.bids, ev.asks, now, ev.hash ?? null, Number.isFinite(tick) ? tick : null);
        return { assetId: String(ev.asset_id), needsResnapshot: false };
      }
      case 'price_change': {
        // Batched per-level deltas. Each carries its own asset_id.
        const touched = new Set();
        for (const pc of ev.price_changes || []) {
          const id = String(pc.asset_id);
          const b = this._book(id);
          if (b.snapshotTs === 0) {
            // No snapshot to apply a delta onto → we cannot trust an incremental book.
            b.needsResnapshot = true;
            touched.add(id);
            continue;
          }
          const size = parseFloat(pc.size);
          const side = String(pc.side || '').toUpperCase();
          const levels = side === 'BUY' ? b.bids : side === 'SELL' ? b.asks : null;
          if (levels) {
            if (!(size > 0)) levels.delete(String(pc.price)); // size 0 ⇒ level removed
            else levels.set(String(pc.price), size);
          }
          if (pc.best_bid != null) b.bestBid = String(pc.best_bid);
          if (pc.best_ask != null) b.bestAsk = String(pc.best_ask);
          if (pc.hash != null) b.hash = pc.hash;
          b.lastEventTs = now;
          touched.add(id);
        }
        // Report the first touched asset for convenience; all are updated in-store.
        const first = [...touched][0] || null;
        return { assetId: first, needsResnapshot: first ? this.books.get(first).needsResnapshot : false };
      }
      case 'tick_size_change': {
        const b = this._book(ev.asset_id);
        const tick = ev.new_tick_size != null ? parseFloat(ev.new_tick_size) : null;
        if (Number.isFinite(tick)) b.tickSize = tick;
        b.lastEventTs = now;
        return { assetId: String(ev.asset_id), needsResnapshot: b.needsResnapshot };
      }
      case 'last_trade_price': {
        const b = this._book(ev.asset_id);
        b.lastTradePrice = ev.price != null ? String(ev.price) : b.lastTradePrice;
        b.lastEventTs = now;
        return { assetId: String(ev.asset_id), needsResnapshot: b.needsResnapshot };
      }
      default:
        return { assetId: ev.asset_id ? String(ev.asset_id) : null, needsResnapshot: false };
    }
  }

  /**
   * Read a book as sorted arrays (bids desc, asks asc) — the shape the reward math
   * (lib/rewardScore.js parseOrders) consumes. Returns null if never seeded.
   */
  getBook(assetId) {
    const b = this.books.get(String(assetId));
    if (!b || b.snapshotTs === 0) return null;
    const bids = [...b.bids.entries()]
      .map(([price, size]) => ({ price: parseFloat(price), size }))
      .sort((x, y) => y.price - x.price);
    const asks = [...b.asks.entries()]
      .map(([price, size]) => ({ price: parseFloat(price), size }))
      .sort((x, y) => x.price - y.price);
    return {
      bids, asks,
      tickSize: b.tickSize,
      hash: b.hash,
      bestBid: b.bestBid,
      bestAsk: b.bestAsk,
      lastTradePrice: b.lastTradePrice,
      lastEventTs: b.lastEventTs,
      snapshotTs: b.snapshotTs,
      needsResnapshot: b.needsResnapshot,
    };
  }

  /**
   * Is this asset's book live right now? LIVE ⇔ seeded AND fresh AND not flagged
   * for resnapshot. Anything else is STALE (caller falls back to REST + says so).
   */
  freshness(assetId, staleMs, now = Date.now()) {
    const b = this.books.get(String(assetId));
    if (!b || b.snapshotTs === 0) return { live: false, reason: 'no-snapshot', ageMs: null };
    if (b.needsResnapshot) return { live: false, reason: 'needs-resnapshot', ageMs: now - b.lastEventTs };
    const ageMs = now - b.lastEventTs;
    if (ageMs > staleMs) return { live: false, reason: 'stale', ageMs };
    return { live: true, reason: 'live', ageMs };
  }

  /**
   * QUANTA VITA C'E' SUL FEED, NON SU UN SINGOLO ASSET.
   *
   * `freshness()` risponde «da quanto tempo il venue non dice niente su QUESTO asset», e su un libro
   * fermo quel numero cresce mentre il nostro quadro resta perfetto — misurato il 5 agosto 2026: al
   * picco di 35s di eta' il book memorizzato coincideva esattamente con la lettura REST. Silenzio su
   * un asset e' un'informazione ambigua: puo' voler dire «nessuna notizia» oppure «siamo ciechi».
   *
   * Questo conta su QUANTI asset distinti e' arrivato un evento nella finestra. E' il segnale che
   * disambigua: se il socket sta consegnando su altri asset, il silenzio su uno solo e' genuino.
   * Restituisce anche il totale, perche' un conteggio senza denominatore non si sa leggere.
   */
  vitality(windowMs, now = Date.now()) {
    let assetsWithEvents = 0;
    let seeded = 0;
    for (const b of this.books.values()) {
      if (b.snapshotTs === 0) continue;
      seeded++;
      if (b.lastEventTs > 0 && (now - b.lastEventTs) <= windowMs) assetsWithEvents++;
    }
    return { assetsWithEvents, seededAssets: seeded, totalAssets: this.books.size, windowMs };
  }

  /** Assets flagged for REST resnapshot (delta-without-snapshot). */
  resnapshotNeeded() {
    const out = [];
    for (const [id, b] of this.books) if (b.needsResnapshot) out.push(id);
    return out;
  }

  remove(assetId) { this.books.delete(String(assetId)); }

  /** Rough resident bytes: ~48B per price level + fixed per book. Reported, not guessed at. */
  memoryBytesEstimate() {
    let levels = 0;
    for (const b of this.books.values()) levels += b.bids.size + b.asks.size;
    return this.books.size * 200 + levels * 48;
  }
}

module.exports = { LiveBookStore, emptyBook };

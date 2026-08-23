'use strict';
// SOLA LETTURA — fotografia del capitale al lavoro, 23 agosto 2026.
// Legge: ordini aperti dal venue (adapter cancel-only, sola op listOpenOrders), posizioni, saldo.
// Non piazza, non cancella, non scrive nulla fuori da data/ricerca/.
require('../cli/_comune').caricaEnv();
const fs = require('fs');
const path = require('path');
const { createCancelOnlyAdapter } = require('../../lib/venues/polymarket-clob/adapter');
const { polymarketCancelCredsProvider, cancelCredsAvailable } = require('../../lib/maker/cancel-creds-provider');

const OUT = path.join(__dirname, '../../data/ricerca/fotografia-capitale-1520.json');

(async () => {
  const now = Date.now();
  const live = await cancelCredsAvailable();
  if (!live) { console.error('credenziali di lettura non disponibili'); process.exit(2); }
  const adapter = createCancelOnlyAdapter({ credsProvider: polymarketCancelCredsProvider });

  const res = await adapter.listOpenOrders(undefined);
  const raw = Array.isArray(res.orders) ? res.orders : [];

  const ordini = raw.map((o) => {
    const created = Number(o.created_at || o.createdAt || 0);
    const createdMs = created > 0 ? (created < 1e12 ? created * 1000 : created) : null;
    const price = Number(o.price);
    const size = Number(o.original_size || o.originalSize || o.size || 0);
    const matched = Number(o.size_matched || o.sizeMatched || 0);
    const rem = (Number.isFinite(size) && Number.isFinite(matched)) ? +(size - matched).toFixed(4) : null;
    const expRaw = Number(o.expiration != null ? o.expiration : 0);
    const hasExp = Number.isFinite(expRaw) && expRaw > 0;
    return {
      orderId: o.id || o.orderID || o.order_id || null,
      marketId: o.market || o.marketId || o.condition_id || o.conditionId || null,
      tokenId: o.asset_id || o.assetId || o.token_id || o.tokenId || null,
      side: o.side || null,
      price: Number.isFinite(price) ? price : null,
      size: Number.isFinite(size) ? size : null,
      sizeMatched: Number.isFinite(matched) ? matched : null,
      sizeRemaining: rem,
      nozionaleUsd: (Number.isFinite(price) && Number.isFinite(rem)) ? +(price * rem).toFixed(4) : null,
      createdMs,
      ageSec: createdMs != null ? Math.max(0, Math.round((now - createdMs) / 1000)) : null,
      orderType: hasExp ? 'GTD' : 'GTC',
      expiresAtMs: hasExp ? (expRaw - 60) * 1000 : null,
      secondsToExpiry: hasExp ? Math.round(((expRaw - 60) * 1000 - now) / 1000) : null,
    };
  });

  // aggregazione per mercato
  const perMercato = {};
  for (const o of ordini) {
    const k = o.marketId || '(ignoto)';
    if (!perMercato[k]) perMercato[k] = { marketId: k, ordini: 0, nozionaleUsd: 0, tokens: {}, lati: {}, eta: [] };
    const m = perMercato[k];
    m.ordini++;
    if (Number.isFinite(o.nozionaleUsd)) m.nozionaleUsd = +(m.nozionaleUsd + o.nozionaleUsd).toFixed(4);
    m.tokens[o.tokenId] = +( (m.tokens[o.tokenId] || 0) + (o.sizeRemaining || 0) ).toFixed(4);
    m.lati[o.side] = (m.lati[o.side] || 0) + 1;
    if (Number.isFinite(o.ageSec)) m.eta.push(o.ageSec);
  }
  for (const m of Object.values(perMercato)) {
    m.tokenDistinti = Object.keys(m.tokens).length;
    // coppia simmetrica = due token distinti sul mercato, entrambi BUY, size uguali entro 1%
    const sizes = Object.values(m.tokens);
    m.simmetrica = m.tokenDistinti === 2 && Math.abs(sizes[0] - sizes[1]) <= 0.01 * Math.max(...sizes);
    m.etaMediaSec = m.eta.length ? Math.round(m.eta.reduce((a, b) => a + b, 0) / m.eta.length) : null;
    m.etaMaxSec = m.eta.length ? Math.max(...m.eta) : null;
    delete m.eta;
  }

  const eta = ordini.map((o) => o.ageSec).filter((x) => Number.isFinite(x));
  const nozTot = ordini.reduce((a, o) => a + (Number.isFinite(o.nozionaleUsd) ? o.nozionaleUsd : 0), 0);

  const out = {
    atIso: new Date(now).toISOString(),
    ordiniAperti: ordini.length,
    mercatiDistinti: Object.keys(perMercato).length,
    nozionaleARiposoUsd: +nozTot.toFixed(4),
    etaMediaSec: eta.length ? Math.round(eta.reduce((a, b) => a + b, 0) / eta.length) : null,
    etaMaxSec: eta.length ? Math.max(...eta) : null,
    etaMinSec: eta.length ? Math.min(...eta) : null,
    ordiniSenzaEta: ordini.length - eta.length,
    mercatiSimmetrici: Object.values(perMercato).filter((m) => m.simmetrica).length,
    mercatiUnLatoSolo: Object.values(perMercato).filter((m) => m.tokenDistinti === 1).length,
    perMercato: Object.values(perMercato).sort((a, b) => b.nozionaleUsd - a.nozionaleUsd),
    ordini,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ ...out, ordini: undefined, perMercato: undefined }, null, 1));
  console.log('scritto:', OUT);
})().catch((e) => { console.error('ERRORE', e && e.message); process.exit(1); });

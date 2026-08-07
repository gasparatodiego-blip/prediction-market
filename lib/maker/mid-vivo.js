'use strict';
// lib/maker/mid-vivo.js — LA COMPOSIZIONE DELLO STATO «MID VIVO», PURA.
//
// Vive fuori dalla rotta SSE (app/api/maker/live-mid) per una ragione sola: una funzione dentro un file
// di rotta non si può chiamare da un test senza montare Next. Qui non c'è I/O, non c'è orologio proprio
// e non c'è rete — entrano lo snapshot dei book già letto e la lista degli ordini già letta, esce la
// riga per mercato che il pannello disegna.
//
// NON DECIDE NIENTE. Non piazza, non cancella, non scrive: risponde a «dove sta il mid adesso, e quanto
// distano da lì gli ordini a riposo». La soglia dello stato «stantio» arriva da chi chiama, che la legge
// dal motore (mm-tracking.MID_STALE_PAUSE_SEC) — non ne esiste una copia qui, perché una soglia copiata
// in un pannello è una soglia che diverge dal motore al primo cambio e mostra «tutto bene» mentre il
// motore è in pausa.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * @param {object|null} books      lo snapshot di agent34 (/tmp/clob-live-books.json), già parsato
 * @param {Array}       ordini     gli ordini a riposo già letti dal venue
 * @param {number}      sogliaStantioSec
 */
function componiMidVivo(books, ordini, sogliaStantioSec) {
  const perMercato = new Map();
  for (const o of Array.isArray(ordini) ? ordini : []) {
    const id = o && o.marketId ? String(o.marketId) : '';
    if (!id) continue;
    if (!perMercato.has(id)) perMercato.set(id, []);
    perMercato.get(id).push(o);
  }

  const mercati = [];
  for (const [marketId, suoi] of Array.from(perMercato.entries())) {
    const m = books && books.markets
      ? (books.markets[marketId] || books.markets[marketId.toLowerCase()] || null) : null;
    const mid = m && fin(m.mid) ? Number(m.mid) : null;
    const ageSec = m && fin(m.ageMs) ? +(m.ageMs / 1000).toFixed(1) : null;
    mercati.push({
      marketId,
      title: m && typeof m.title === 'string' ? m.title : null,
      mid,
      midAgeSec: ageSec,
      live: !!(m && m.live === true),
      // UN'ETÀ CHE NON SI LEGGE NON È «FRESCA». Senza il dato non si può affermare che il mid sia buono,
      // e il pannello deve dirlo esattamente come lo direbbe il motore: nel dubbio, stantio.
      midStantio: ageSec == null ? true : ageSec > sogliaStantioSec,
      sogliaStantioSec,
      ordini: suoi.map((o) => {
        const p = fin(o.price) ? o.price : null;
        const d = (mid != null && p != null) ? +((p - mid) * 100).toFixed(2) : null;
        return {
          orderId: o.orderId ?? null, side: o.side ?? null, price: p,
          size: fin(o.size) ? o.size : null,
          sizeRemaining: fin(o.sizeRemaining) ? o.sizeRemaining : null,
          distanzaCents: d,
          latoDelMid: d == null ? null : (d < 0 ? 'sotto' : d > 0 ? 'sopra' : 'sul'),
        };
      }),
    });
  }
  mercati.sort((a, b) => String(a.title || a.marketId).localeCompare(String(b.title || b.marketId)));
  return { feedLetto: !!books, mercati };
}

module.exports = { componiMidVivo };

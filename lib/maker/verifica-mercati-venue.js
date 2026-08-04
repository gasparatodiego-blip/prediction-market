'use strict';
// lib/maker/verifica-mercati-venue.js — I MERCATI CHE STANNO PER RICEVERE ORDINI SONO ANCORA QUELLI?
//
// ═══ IL FATTO DA CUI NASCE ═══════════════════════════════════════════════════════════════════════════
// Tracciato il 4 agosto 2026, flusso «Ottimizza» manuale, capitale $600: dei CINQUE mercati che il piano
// aveva scelto, DUE avevano il montepremi crollato sul venue mentre il board locale raccontava ancora
// quello vecchio —
//     0xc4b07998…  il board diceva $114/g, il venue $11/g   (10%)
//     0xd66eadbd…  il board diceva   $5/g, il venue  $2/g   (40%)
// — cioè $192 dei $600 stavano per andare su due mercati che rendono una frazione di quello che il piano
// credeva. Nessuno dei due era chiuso, sospeso o senza banda: erano invisibili a qualunque controllo che
// si limiti a chiedere «esiste ancora?».
//
// Il riallocatore automatico questa verifica ce l'aveva già (realloc-cycle, PASSO 4b). Il percorso
// MANUALE no: il pannello calcolava il piano dal board e lo mandava a piazzare. Questo modulo è la
// verifica sola, estratta perché i due percorsi la facciano con lo stesso codice invece che con due.
//
// ═══ L'ASIMMETRIA, CHE È DELIBERATA ══════════════════════════════════════════════════════════════════
// Per un mercato GIÀ IN GESTIONE «illeggibile» vuol dire «lascialo dov'è»: non fa scattare niente.
// Per un mercato che sta per RICEVERE ordini veri la parte che non agisce è NON PIAZZARE. Non si
// conclude che sia morto — si conclude che non lo si è potuto confermare, e non si scommette capitale su
// una conferma mancata.
//
// Questo modulo non decide: MISURA e riporta. Chi lo chiama sceglie cosa fare dei tre insiemi.

const https = require('https');
const http = require('http');
const { marketValidity } = require('./market-validity');

const CLOB_BASE = process.env.POLY_CLOB_BASE || 'https://clob.polymarket.com';
const VENUE_TIMEOUT_MS = 12_000;

const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Interroga il venue su ogni mercato DISTINTO presente nelle righe e ne dà il verdetto.
 *
 * @param {object} args
 *   rows        [{ marketId, ... }] — le righe che si piazzerebbero. Due gambe dello stesso mercato
 *               producono UNA sola domanda al venue: stesso conditionId, stessa risposta.
 *   poolAlPiano { [marketId]: pot } il montepremi con cui il piano ha deciso, per market. È il
 *               riferimento che rende visibile il crollo: senza, quel controllo non si applica.
 *   nowMs
 * @param {object} deps
 *   readVenue({marketId}) → il record del venue (vedi market-validity). OBBLIGATORIA: senza, questo
 *               modulo non inventa una lettura e dichiara tutto illeggibile.
 * @returns {{validi:string[], bocciati:object[], illeggibili:object[], verdetti:object[]}}
 */
async function verificaMercatiAlVenue({ rows = [], poolAlPiano = {}, nowMs = Date.now() } = {}, deps = {}) {
  const ids = [...new Set((rows || []).map((r) => normId(r && r.marketId)).filter(Boolean))];
  const verdetti = [];
  for (const marketId of ids) {
    let venue = null;
    if (typeof deps.readVenue !== 'function') {
      venue = { readable: false, error: 'nessun lettore del venue iniettato' };
    } else {
      try { venue = await deps.readVenue({ marketId }); }
      catch (e) { venue = { readable: false, error: e && e.message ? e.message : String(e) }; }
    }
    const pot = poolAlPiano && fin(poolAlPiano[marketId]) ? poolAlPiano[marketId] : null;
    verdetti.push(marketValidity({ marketId, venue, poolAlPiano: pot, nowMs }));
  }
  return {
    validi: verdetti.filter((v) => v.valido === true).map((v) => v.marketId),
    bocciati: verdetti.filter((v) => v.valido === false).map((v) => ({ marketId: v.marketId, stato: v.stato, motivo: v.motivo })),
    illeggibili: verdetti.filter((v) => v.valido === null).map((v) => ({ marketId: v.marketId, stato: v.stato, motivo: v.motivo })),
    verdetti,
  };
}

/**
 * Le righe che sopravvivono alla verifica, con le COPPIE tenute insieme.
 *
 * Se un mercato è bocciato escono ENTRAMBE le sue gambe: mezza coppia sarebbe l'esposizione asimmetrica
 * che tutto il percorso di piazzamento esiste per impedire.
 */
function filtraRighe(rows, bocciati) {
  const fuori = new Set((bocciati || []).map((b) => normId(b.marketId)));
  return (rows || []).filter((r) => !fuori.has(normId(r && r.marketId)));
}

/**
 * IL LETTORE DEL VENUE — sola lettura, nessuna firma, nessuna credenziale.
 *
 * La fonte è il CLOB, non la cache locale: è la cache che il 4 agosto raccontava $114/g mentre il venue
 * diceva $11/g. Qualunque cosa vada storta — rete, HTTP, JSON, campi mancanti — produce `readable:false`,
 * che in market-validity NON è «invalido»: è il suo verdetto, e chi chiama decide cosa farne.
 *
 * Un array `rates` VUOTO è un fatto letto («questo mercato non paga»); la sua ASSENZA non lo è: il primo
 * diventa 0, il secondo resta illeggibile.
 */
function leggiVenueClob({ marketId }) {
  const url = `${CLOB_BASE}/markets/${encodeURIComponent(marketId)}`;
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: VENUE_TIMEOUT_MS, headers: { accept: 'application/json' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; if (buf.length > 4_000_000) req.destroy(new Error('risposta troppo grande')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ readable: false, error: `HTTP ${res.statusCode}` });
        let j = null;
        try { j = JSON.parse(buf); } catch (e) { return resolve({ readable: false, error: 'risposta non JSON: ' + e.message }); }
        if (!j || typeof j !== 'object' || j.error) return resolve({ readable: false, error: (j && j.error) || 'risposta vuota' });
        const rates = j.rewards && Array.isArray(j.rewards.rates) ? j.rewards.rates : null;
        let pot = null;
        if (rates) {
          pot = 0;
          for (const r of rates) { const v = Number(r && r.rewards_daily_rate); if (!Number.isFinite(v)) { pot = null; break; } pot += v; }
        }
        const maxSpread = j.rewards ? Number(j.rewards.max_spread) : NaN;
        const minSize = j.rewards ? Number(j.rewards.min_size) : NaN;
        resolve({
          readable: true,
          closed: j.closed === true,
          active: typeof j.active === 'boolean' ? j.active : null,
          acceptingOrders: typeof j.accepting_orders === 'boolean' ? j.accepting_orders : null,
          rewardsDailyRate: pot,
          maxSpreadCents: Number.isFinite(maxSpread) ? maxSpread : null,
          minSizeShares: Number.isFinite(minSize) ? minSize : null,
          endDate: typeof j.end_date_iso === 'string' ? j.end_date_iso : null,
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ readable: false, error: `timeout dopo ${VENUE_TIMEOUT_MS}ms` }); });
    req.on('error', (e) => resolve({ readable: false, error: e.message }));
  });
}

module.exports = { verificaMercatiAlVenue, filtraRighe, leggiVenueClob };

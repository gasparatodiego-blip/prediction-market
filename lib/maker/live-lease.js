'use strict';
// live-lease — LE SOTTOSCRIZIONI TEMPORANEE AL BOOK LIVE, con scadenza.
//
// IL PROBLEMA. agent34 e' sottoscritto al board reward piu' i mercati che l'operatore ha abilitato a
// mano. Per tutto il resto — che e' quasi tutto Polymarket — il prezzo piu' fresco che la dashboard sa
// dare viene dalla REST di Gamma, che serve uno snapshot suo. Misurato il 2026-08-01 su «Bitcoin Up or
// Down 3:35-3:40PM»: sette letture in 60 secondi, mid fermo a 51,5¢ tutte e sette. Su un ciclo da cinque
// minuti quel numero puo' essere vecchio quanto il ciclo.
//
// LA SOLUZIONE, E PERCHE' UN FILE. agent34 e' un PROCESSO SEPARATO: la dashboard non puo' chiamarlo. Il
// canale che i due condividono gia' oggi e' il filesystem (agent34 scrive /tmp/clob-live-books.json, la
// dashboard lo legge). Questo modulo aggiunge il canale nella direzione opposta: la dashboard scrive qui
// «tienimi sottoscritto a questo mercato», agent34 legge e obbedisce.
//
// PERCHE' SCADONO DA SOLE. Se la dashboard dovesse RILASCIARE ogni permesso per farlo sparire, basterebbe
// un browser chiuso di colpo, una scheda uccisa dal sistema o un crash del rendering per lasciare un
// mercato sottoscritto per sempre. Dopo qualche settimana agent34 si troverebbe al tetto con decine di
// mercati che nessuno guarda piu', e finirebbe per evincere quelli che contano. Quindi il permesso NON
// dura fino al rilascio: dura fino alla SCADENZA, e il pannello lo rinnova finche' resta aperto. Il
// rilascio esplicito e' un'ottimizzazione — libera lo slot subito — non il meccanismo su cui si conta.
//
// QUESTO MODULO NON DA' NESSUNA AUTORIZZAZIONE. Un permesso qui significa «guarda questo prezzo», niente
// di piu'. Il canale market del CLOB e' pubblico e senza chiavi e non ha nessun percorso d'ordine;
// allowlist, cap, gestione manuale e kill-switch vivono altrove e non leggono questo file. Sottoscriversi
// a un mercato non lo rende ordinabile, esattamente come guardare un prezzo non e' comprare.

const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', '..', 'data', 'maker-live-leases.json');

// ── LA SCADENZA ─────────────────────────────────────────────────────────────────────────────────────
// 20 secondi, contro un rinnovo dal pannello ogni 5. Tre rinnovi persi di fila prima che il permesso
// cada: sopravvive a una scheda in background che il browser rallenta, a un giro di rete andato male e a
// un riavvio della dashboard, senza tenere in piedi un mercato che nessuno guarda piu' di venti secondi.
// Piu' corto e i falsi decadimenti diventerebbero visibili come un prezzo che torna a Gamma mentre lo
// stai guardando; piu' lungo e il costo di una scheda chiusa male si allunga senza comprare nulla.
const LEASE_TTL_MS = 20_000;
// Il rinnovo che il pannello deve rispettare per stare dentro la scadenza con margine.
const LEASE_RENEW_MS = 5_000;

// ── QUANTI PERMESSI INSIEME ─────────────────────────────────────────────────────────────────────────
// Un operatore ha un pannello aperto alla volta. Otto e' largo abbastanza da coprire chi tocca card in
// sequenza mentre i permessi precedenti non sono ancora scaduti (a 20s di TTL ne restano al massimo
// quattro o cinque appesi), e stretto abbastanza da non poter mai mangiare una fetta seria del budget di
// agent34. Oltre questo numero il permesso piu' vecchio cede il posto: e' quello che l'operatore ha
// smesso di guardare per primo.
const LEASE_CAP = 8;

const isConditionId = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v.trim());
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function readRaw(deps = {}) {
  const file = deps.file || STORE_FILE;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Scrittura atomica: un lettore non deve mai poter vedere un JSON a meta'. */
function writeRaw(obj, deps = {}) {
  const file = deps.file || STORE_FILE;
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * I permessi ANCORA VALIDI, gia' ripuliti dagli scaduti.
 *
 * Un file illeggibile restituisce una lista VUOTA, non un errore: fallire chiuso qui puo' solo costare
 * una sottoscrizione temporanea, mai concederne una che nessuno ha chiesto.
 */
function readActiveLeases(deps = {}) {
  const now = deps.now || Date.now();
  const raw = readRaw(deps);
  const out = [];
  const leases = raw && raw.leases && typeof raw.leases === 'object' ? raw.leases : {};
  for (const [id, rec] of Object.entries(leases)) {
    if (!isConditionId(id) || !rec || typeof rec !== 'object') continue;
    const exp = Number(rec.expiresAt);
    if (!Number.isFinite(exp) || exp <= now) continue;
    out.push({
      marketId: id,
      by: typeof rec.by === 'string' ? rec.by : null,
      acquiredAt: Number.isFinite(rec.acquiredAt) ? rec.acquiredAt : null,
      renewedAt: Number.isFinite(rec.renewedAt) ? rec.renewedAt : null,
      expiresAt: exp,
      msLeft: exp - now,
    });
  }
  // Il piu' recentemente rinnovato per primo: e' quello che l'operatore sta guardando adesso, e in caso
  // di taglio deve essere l'ultimo a cadere.
  out.sort((a, b) => (b.renewedAt || 0) - (a.renewedAt || 0));
  return out;
}

/** Solo gli id, in minuscolo — la forma che serve a chi deve confrontare insiemi. */
function readActiveLeaseIds(deps = {}) {
  return readActiveLeases(deps).map((l) => normId(l.marketId));
}

/**
 * Prende o RINNOVA un permesso. La stessa chiamata fa entrambe le cose di proposito: il pannello manda
 * lo stesso messaggio all'apertura e a ogni battito, e non deve sapere quale dei due sta facendo.
 *
 * Oltre LEASE_CAP cede il permesso rinnovato meno di recente. Non e' un rifiuto: e' l'unico modo di
 * tenere il tetto senza far fallire l'apertura di un pannello, e cade sempre su quello che l'operatore
 * ha smesso di guardare per primo.
 */
function acquireLease(marketId, opts = {}, deps = {}) {
  const id = typeof marketId === 'string' ? marketId.trim() : '';
  if (!isConditionId(id)) return { ok: false, error: 'marketId non valido (atteso 0x + 64 esadecimali)', lease: null };
  const now = deps.now || Date.now();
  const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? Math.min(opts.ttlMs, 120_000) : LEASE_TTL_MS;

  const raw = readRaw(deps) || {};
  const leases = raw.leases && typeof raw.leases === 'object' ? { ...raw.leases } : {};

  // via gli scaduti a ogni scrittura: il file non cresce mai oltre i permessi vivi
  for (const [k, v] of Object.entries(leases)) {
    if (!v || !Number.isFinite(Number(v.expiresAt)) || Number(v.expiresAt) <= now) delete leases[k];
  }

  const existing = leases[id] || null;
  const renewed = !!existing;
  leases[id] = {
    acquiredAt: existing && Number.isFinite(existing.acquiredAt) ? existing.acquiredAt : now,
    renewedAt: now,
    expiresAt: now + ttl,
    by: typeof opts.by === 'string' ? opts.by.slice(0, 120) : 'pannello ordine',
  };

  let evicted = null;
  const ids = Object.keys(leases);
  if (ids.length > LEASE_CAP) {
    ids.sort((a, b) => (leases[a].renewedAt || 0) - (leases[b].renewedAt || 0));
    for (const victim of ids) {
      if (Object.keys(leases).length <= LEASE_CAP) break;
      if (normId(victim) === normId(id)) continue;   // mai quello appena chiesto
      delete leases[victim];
      evicted = victim;
    }
  }

  writeRaw({ at: new Date(now).toISOString(), ttlMs: ttl, cap: LEASE_CAP, leases }, deps);
  return {
    ok: true, error: null, renewed, evicted,
    lease: { marketId: id, expiresAt: leases[id].expiresAt, msLeft: ttl },
    activeCount: Object.keys(leases).length,
  };
}

/**
 * Rilascia subito. E' un'OTTIMIZZAZIONE, non il meccanismo di pulizia: rilasciare libera lo slot
 * all'istante invece di aspettare la scadenza, ma un rilascio mai arrivato non lascia niente appeso.
 */
function releaseLease(marketId, deps = {}) {
  const id = typeof marketId === 'string' ? marketId.trim() : '';
  if (!isConditionId(id)) return { ok: false, error: 'marketId non valido', released: false };
  const now = deps.now || Date.now();
  const raw = readRaw(deps) || {};
  const leases = raw.leases && typeof raw.leases === 'object' ? { ...raw.leases } : {};
  const had = Object.prototype.hasOwnProperty.call(leases, id);
  delete leases[id];
  for (const [k, v] of Object.entries(leases)) {
    if (!v || !Number.isFinite(Number(v.expiresAt)) || Number(v.expiresAt) <= now) delete leases[k];
  }
  writeRaw({ at: new Date(now).toISOString(), ttlMs: LEASE_TTL_MS, cap: LEASE_CAP, leases }, deps);
  return { ok: true, error: null, released: had, activeCount: Object.keys(leases).length };
}

module.exports = {
  LEASE_TTL_MS, LEASE_RENEW_MS, LEASE_CAP, STORE_FILE,
  readActiveLeases, readActiveLeaseIds, acquireLease, releaseLease, isConditionId,
};

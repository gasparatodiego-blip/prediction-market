'use strict';
// lib/rewards/collector-priority.js — L'OTTIMIZZATORE DICE AL RACCOGLITORE COSA GUARDARE.
//
// ═══ IL GUASTO DA CUI NASCE ══════════════════════════════════════════════════════════════════════════
// Misurato il 3 agosto 2026. Il raccoglitore di storico prezzi (agent34) sottoscrive i primi
// SUBSCRIPTION_CAP mercati del board reward, ORDINATI PER MONTEPREMI. L'ottimizzatore
// (planFromCollection) sceglie invece per reward atteso PER DOLLARO sotto il tetto di concentrazione —
// un criterio diverso, che pesca regolarmente sotto quella soglia.
//
// Il risultato, sul piano di quel giorno: dei 5 mercati proposti UNO SOLO era sottoscritto. «Spider-Man:
// Brand New Day» era in posizione 115 del board con $25/g di montepremi, quindi fuori dai primi 60: il
// suo ultimo prezzo aveva 8,4 ore. Il guard di freschezza (5 minuti, e resta 5 minuti) lo scartava, e
// il reset avrebbe messo al lavoro $188 di $665 — il 72% del capitale fermo per colpa di un dato che
// nessuno stava raccogliendo.
//
// Nessun errore silenzioso, nessuna frequenza sbagliata: i mercati sottoscritti erano campionati
// regolarmente ogni 75s. Era la SELEZIONE a essere fatta con il criterio sbagliato.
//
// ═══ COSA FA QUESTO FILE ════════════════════════════════════════════════════════════════════════════
// Chiunque calcoli un piano scrive qui l'elenco dei mercati che quel piano ha ritenuto interessanti — le
// righe scelte e i migliori candidati valutati. agent34 lo legge a ogni riconciliazione e li sottoscrive
// in una corsia dedicata, con la stessa priorità dei mercati abilitati a mano. Così, quando
// l'ottimizzatore proporrà quel mercato, il suo storico sarà già caldo da ore.
//
// ═══ COSA QUESTO FILE NON PUÒ FARE ══════════════════════════════════════════════════════════════════
// Non risolve la scoperta. Un mercato di cui non esiste NESSUNO storico non è nemmeno un candidato per
// l'ottimizzatore (finisce fra i «senza-storico»), quindi non può comparire qui. La copertura larga del
// board resta l'unico modo di scoprirlo, ed è per questo che SUBSCRIPTION_CAP è stato alzato insieme a
// questa corsia: le due cose curano due metà diverse dello stesso problema.
//
// ═══ SCADE ══════════════════════════════════════════════════════════════════════════════════════════
// Un elenco vecchio non vale: se chi lo scrive muore, la corsia deve svuotarsi e il raccoglitore tornare
// al suo comportamento di sempre, non restare inchiodato per giorni ai mercati di un piano defunto.
// Oltre MAX_AGE_MS l'elenco si legge come vuoto — fallire verso «nessuna priorità», mai verso «queste
// priorità di chissà quando».

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const PRIORITY_FILE = path.join(DATA_DIR, 'collector-priority.json');

// Due cicli del riallocatore (6h l'uno) più un margine: se dopo 13 ore nessuno ha riscritto l'elenco,
// qualcosa non sta girando e la corsia si spegne da sola.
const MAX_AGE_MS = 13 * 3_600_000;
// Quanti mercati al massimo la corsia può chiedere. È un numero piccolo di proposito: la corsia ha il
// diritto di sfrattare mercati del board, e un elenco lungo la trasformerebbe in un secondo board.
const MAX_MARKETS = 20;

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * Estrae dall'esito di planFromCollection i mercati che vale la pena tenere caldi.
 *
 * Ordine, e non è arbitrario:
 *   1. le righe SCELTE dal piano — sono quelle su cui si sta per piazzare, non possono mancare;
 *   2. i candidati VALUTATI, dal miglior reward netto atteso in giù — sono i prossimi che il piano
 *      potrebbe scegliere fra sei ore, e li si vuole già coperti quando succede.
 * I «senza-storico» non entrano: sono esattamente i mercati che questa corsia non può aiutare, e
 * metterli in elenco vorrebbe dire spendere slot per dati che non arriveranno da qui.
 */
function priorityFromPlan(plan, { max = MAX_MARKETS } = {}) {
  const scelti = [];
  for (const r of (plan && plan.rows) || []) { const id = normId(r && r.marketId); if (id) scelti.push(id); }

  const valutati = ((plan && plan.candidates) || [])
    .filter((c) => c && fin(c.bestNetPerDay) && normId(c.marketId))
    .sort((a, b) => b.bestNetPerDay - a.bestNetPerDay)
    .map((c) => normId(c.marketId));

  const out = [];
  for (const id of [...scelti, ...valutati]) {
    if (out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** Scrive l'elenco. Best-effort per chi la chiama: un piano non deve fallire perché il disco è pieno. */
function writeCollectorPriority(plan, opts = {}) {
  const marketIds = priorityFromPlan(plan, opts);
  const body = {
    at: new Date(fin(opts.nowMs) ? opts.nowMs : Date.now()).toISOString(),
    scelti: ((plan && plan.rows) || []).length,
    marketIds,
    note: 'mercati che l\'ottimizzatore ha scelto o valutato meglio — agent34 li tiene sottoscritti perché il loro storico sia gia fresco quando il piano li propone',
  };
  const file = opts.file || PRIORITY_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return body;
}

/**
 * Legge l'elenco. Ogni motivo di dubbio — file assente, JSON rotto, campo mancante, elenco vecchio —
 * produce un elenco VUOTO, mai un elenco parziale spacciato per completo.
 *
 * @returns {{marketIds, at, ageMs, fresh, reason}}
 */
function readCollectorPriority(opts = {}) {
  const file = opts.file || PRIORITY_FILE;
  const now = fin(opts.nowMs) ? opts.nowMs : Date.now();
  const maxAge = fin(opts.maxAgeMs) ? opts.maxAgeMs : MAX_AGE_MS;
  const vuoto = (reason) => ({ marketIds: [], at: null, ageMs: null, fresh: false, reason });

  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return vuoto(e && e.code === 'ENOENT' ? 'nessun elenco scritto finora' : `elenco illeggibile (${e.message})`); }
  if (!raw || !Array.isArray(raw.marketIds)) return vuoto('elenco malformato');

  const atMs = typeof raw.at === 'string' ? Date.parse(raw.at) : NaN;
  if (!fin(atMs)) return vuoto('elenco senza istante di scrittura: non se ne puo giudicare l eta');
  const ageMs = now - atMs;
  if (ageMs > maxAge) return vuoto(`elenco vecchio di ${Math.round(ageMs / 60_000)} minuti (limite ${Math.round(maxAge / 60_000)}): la corsia si spegne invece di inchiodarsi a un piano morto`);

  const marketIds = [...new Set(raw.marketIds.map(normId).filter(Boolean))].slice(0, MAX_MARKETS);
  return { marketIds, at: raw.at, ageMs, fresh: true, reason: null };
}

module.exports = { priorityFromPlan, writeCollectorPriority, readCollectorPriority, PRIORITY_FILE, MAX_AGE_MS, MAX_MARKETS };

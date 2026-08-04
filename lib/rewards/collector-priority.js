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
// ═══ IL SECONDO GUASTO: LA LISTA A FOTOGRAFIA ═══════════════════════════════════════════════════════
// Misurato il 3 agosto sera, DOPO il primo fix. Un piano calcolato due minuti dopo un ciclo mostrava 5
// righe eseguibili su 7: due mercati erano stantii con ~121 campioni contro i 484 di un mercato sano, con
// buchi di 233 e 232 minuti. Erano coperti dal feed in quel momento — ma la lista di priorità scritta
// quattro minuti prima NON li conteneva: erano rientrati per conto loro nella top-90 del board.
//
// La causa non era la copertura, era la FORMA della lista: una fotografia di UN piano, sostituita per
// intero a ogni scrittura. Chi usciva dalla graduatoria spariva subito, e se il piano lo rivoleva mezz'ora
// dopo lo ritrovava freddo. Peggio: una lista scritta da un ciclo non fa in tempo ad aiutare quel ciclo
// (agent34 la legge alla riconciliazione successiva, fino a ~21 minuti dopo, più uno o due campioni).
//
// ═══ COSA FA QUESTO FILE ════════════════════════════════════════════════════════════════════════════
// Chiunque calcoli un piano deposita qui i mercati che quel piano ha ritenuto interessanti. NON li
// sostituisce: li UNISCE a quelli già presenti, ciascuno con la data dell'ultima volta che è stato
// ritenuto interessante. Un mercato esce solo quando sono passate RETENTION_MS ore dall'ultimo interesse
// — non al primo piano che non lo sceglie.
//
// Un mercato è «interessante» in due modi, e la distinzione conta:
//   • È una RIGA del piano — ci si sta per piazzare sopra. Non può mancare, e al tetto non cede mai il posto.
//   • È fra i primi TOP_K CANDIDATI valutati — è un quasi-vincitore. Non è stato scelto oggi, ma è
//     esattamente il mercato che il piano può scegliere al giro dopo, ed è per quello che lo si tiene caldo.
//
// agent34 legge l'unione a ogni riconciliazione e la sottoscrive in una corsia dedicata, con la stessa
// priorità dei mercati abilitati a mano. Così, quando l'ottimizzatore proporrà quel mercato, il suo
// storico sarà già caldo da ore.
//
// ═══ COSA QUESTO FILE NON PUÒ FARE ══════════════════════════════════════════════════════════════════
// Non risolve la scoperta. Un mercato di cui non esiste NESSUNO storico non è nemmeno un candidato per
// l'ottimizzatore (finisce fra i «senza-storico»), quindi non può comparire qui. La copertura larga del
// board resta l'unico modo di scoprirlo, ed è per questo che SUBSCRIPTION_CAP è stato alzato insieme a
// questa corsia: le due cose curano due metà diverse dello stesso problema.
//
// E non azzera la finestra fredda: se un mercato entra nel piano senza essere MAI stato né riga né
// top-K, resta freddo per quel ciclo. L'isteresi rende il caso raro, non impossibile.
//
// ═══ SCADE ══════════════════════════════════════════════════════════════════════════════════════════
// Un elenco vecchio non vale: se chi lo scrive muore, la corsia deve svuotarsi e il raccoglitore tornare
// al suo comportamento di sempre, non restare inchiodato per giorni ai mercati di un piano defunto.
// Oltre MAX_AGE_MS l'elenco si legge come vuoto — fallire verso «nessuna priorità», mai verso «queste
// priorità di chissà quando». La stessa logica vale per la singola voce: oltre RETENTION_MS dall'ultimo
// interesse esce, e chi legge la scarta anche se chi scrive avesse dimenticato di potarla.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const PRIORITY_FILE = path.join(DATA_DIR, 'collector-priority.json');

// Due cicli del riallocatore (6h l'uno) più un margine: se dopo 13 ore nessuno ha riscritto l'elenco,
// qualcosa non sta girando e la corsia si spegne da sola.
const MAX_AGE_MS = 13 * 3_600_000;

// ── I TRE NUMERI DELL'UNIONE MOBILE ─────────────────────────────────────────────────────────────────
// Misurati il 4 agosto 2026 su 8 campioni reali di planFromCollection presi a 3 minuti l'uno dall'altro
// (07:21:20 → 07:44:44 UTC), non scelti a intuito. La domanda a cui rispondono è una sola: perché una
// lista scritta ORA basti al piano che verrà calcolato DOPO.
//
// TOP_K = 30 — quanti candidati oltre le righe del piano restano caldi.
//   Misura: per ogni coppia di campioni (t1, t2), a che posizione della graduatoria di t1 stavano le
//   righe che il piano ha scelto a t2. Su 28 coppie e 143 righe:
//       K=20 → 115/143 righe coperte (80,4%),   0 coppie su 28 coperte per intero
//       K=24 → 125/143 righe coperte (87,4%),  10 coppie su 28
//       K=30 → 143/143 righe coperte (100%),   28 coppie su 28
//   La profondità massima osservata è stata 26. Non è rumore: il knapsack sceglie sotto vincolo di
//   capitale e di tetto per mercato, quindi NON segue l'ordine di bestNetPerDay — un mercato in
//   posizione 26 può entrare nel piano perché è quello che sta nel capitale rimasto, mentre i primi sono
//   già al tetto. È per questo che K deve essere più profondo di quanto suggerirebbe l'intuito, e per cui
//   il vecchio comportamento (righe + candidati fino a 20 slot totali) copriva solo l'80% delle righe.
//   Nessuna riga futura è risultata FUORI dalla graduatoria precedente (0 su 143): il caso che K non può
//   salvare — un mercato mai valutato prima — non si è presentato in questa finestra, ma esiste, ed è
//   quello per cui lib/maker/attesa-riscaldamento.js è pronto (spento).
//
// RETENTION_MS = 12h — quanto un mercato resta caldo dopo l'ultimo interesse.
//   Il riallocatore gira ogni 6h. 12h significa: un mercato sopravvive a DUE cicli interi in cui non è
//   stato né riga né top-K prima di essere lasciato raffreddare. Un solo ciclo (6h) non darebbe margine
//   al caso che ha generato il guasto — uscire dalla graduatoria e rientrarci mezz'ora dopo.
//   Non oltre MAX_AGE_MS (13h): una voce non deve poter sopravvivere all'elenco che la contiene.
//
// MAX_MARKETS = 40 — il tetto duro della corsia.
//   Deve contenere le righe del piano (5-6 osservate) più TOP_K senza che l'isteresi possa buttare fuori
//   un mercato su cui si sta per piazzare: 6 + 30 = 36 nel caso peggiore, e restano ~4-10 slot per le voci
//   trattenute. L'unione degli 8 campioni su 23 minuti, con K=30, stava a 35 mercati: la lista respira
//   dentro il tetto invece di sbatterci contro. Il costo in copertura è misurato: dei 20 id dell'elenco
//   vecchio solo 9 erano slot EXTRA rispetto al board (gli altri 11 il board li teneva già), cioè ~45%;
//   un elenco da 40 costa quindi ~18 slot, e il feed stava a 104 mercati su 125 di tetto. La corsia ha il
//   diritto di sfrattare mercati del board: un elenco più lungo la trasformerebbe in un secondo board, ed
//   è per questo che si ferma qui.
const TOP_K = Number(process.env.COLLECTOR_PRIORITY_TOP_K || 30);
const RETENTION_MS = Number(process.env.COLLECTOR_PRIORITY_RETENTION_H || 12) * 3_600_000;
const MAX_MARKETS = Number(process.env.COLLECTOR_PRIORITY_MAX || 40);

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const normId = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const iso = (ms) => new Date(ms).toISOString();
const parseMs = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return fin(t) ? t : null; };

/**
 * I mercati che QUESTO piano rende interessanti, con il motivo — che non è cosmetico: le righe non
 * cedono mai il posto al tetto, i quasi-vincitori sì.
 *
 * I «senza-storico» non entrano: sono esattamente i mercati che questa corsia non può aiutare (non hanno
 * bestNetPerDay perché non hanno storico), e metterli in elenco vorrebbe dire spendere slot per dati che
 * da qui non arriveranno.
 *
 * @returns {{id: string, motivo: 'piano'|'topK', rank: number|null}[]}
 */
function mercatiDalPiano(plan, { topK = TOP_K } = {}) {
  const out = [];
  const visti = new Set();

  for (const r of (plan && plan.rows) || []) {
    const id = normId(r && r.marketId);
    if (!id || visti.has(id)) continue;
    visti.add(id);
    out.push({ id, motivo: 'piano', rank: null });
  }

  const graduatoria = ((plan && plan.candidates) || [])
    .filter((c) => c && fin(c.bestNetPerDay) && normId(c.marketId))
    .sort((a, b) => b.bestNetPerDay - a.bestNetPerDay);

  let rank = 0;
  for (const c of graduatoria) {
    rank += 1;                       // la posizione è quella nella graduatoria PIENA, righe comprese:
    if (rank > topK) break;          // è la profondità che si vuole misurare, non un contatore di scarti
    const id = normId(c.marketId);
    if (visti.has(id)) continue;
    visti.add(id);
    out.push({ id, motivo: 'topK', rank });
  }
  return out;
}

/**
 * Compatibilità: il solo elenco di id che questo piano rende interessanti, senza unione né isteresi.
 * Resta esportata perché è il modo più diretto di chiedere «cosa vuole QUESTO piano», ed è quello che
 * i test usano per separare la selezione dall'unione.
 */
function priorityFromPlan(plan, { max = MAX_MARKETS, topK = TOP_K } = {}) {
  return mercatiDalPiano(plan, { topK }).slice(0, max).map((m) => m.id);
}

/**
 * L'UNIONE MOBILE. Funzione pura: prende le voci di prima e quelle di adesso, restituisce le voci di dopo.
 *
 * Ordine di sopravvivenza al tetto, e non è arbitrario:
 *   1. le RIGHE del piano di adesso — ci si sta per piazzare sopra, non possono essere sfrattate;
 *   2. i TOP_K di adesso, per posizione in graduatoria — i prossimi che il piano potrebbe scegliere;
 *   3. le voci TRATTENUTE dall'isteresi, dalla più recente alla più vecchia — sono le meno urgenti,
 *      e se il tetto stringe sono le prime a cedere il posto.
 *
 * @returns {{mercati: object[], marketIds: string[], scaduti: string[], trattenuti: string[], tagliati: string[]}}
 */
function unioneMobile({ precedenti = [], freschi = [], nowMs, retentionMs = RETENTION_MS, max = MAX_MARKETS } = {}) {
  const ora = fin(nowMs) ? nowMs : Date.now();
  const oraIso = iso(ora);

  // Le voci di prima, normalizzate. Una voce senza data leggibile non si può giudicare: si tratta come
  // scaduta, mai come «vista adesso» — è la stessa regola di lettura dell'elenco intero.
  const per = new Map();
  const scaduti = [];
  for (const v of precedenti) {
    const id = normId(v && v.id);
    if (!id || per.has(id)) continue;
    const visto = parseMs(v && v.visto);
    if (visto === null || ora - visto > retentionMs) { scaduti.push(id); continue; }
    per.set(id, {
      id,
      piano: parseMs(v.piano) !== null ? v.piano : null,
      topK: parseMs(v.topK) !== null ? v.topK : null,
      visto: iso(visto),
      rank: fin(v.rank) ? v.rank : null,
    });
  }
  const trattenuti = [...per.keys()];

  // Le voci di adesso: aggiornano la data dell'interesse, non la resettano al primo motivo che capita.
  const righeOra = [];
  const topKOra = [];
  for (const f of freschi) {
    const id = normId(f && f.id);
    if (!id) continue;
    const prima = per.get(id) || { id, piano: null, topK: null, visto: null, rank: null };
    const voce = { ...prima, visto: oraIso };
    if (f.motivo === 'piano') { voce.piano = oraIso; voce.rank = null; righeOra.push(id); }
    else { voce.topK = oraIso; voce.rank = fin(f.rank) ? f.rank : null; topKOra.push(id); }
    per.set(id, voce);
  }

  const freschiSet = new Set([...righeOra, ...topKOra]);
  const ordine = [
    ...righeOra,
    ...topKOra,
    ...trattenuti
      .filter((id) => !freschiSet.has(id))
      .sort((a, b) => (parseMs(per.get(b).visto) || 0) - (parseMs(per.get(a).visto) || 0)),
  ];

  const tenuti = ordine.slice(0, max);
  const tagliati = ordine.slice(max);
  return {
    mercati: tenuti.map((id) => per.get(id)),
    marketIds: tenuti,
    scaduti,
    trattenuti: trattenuti.filter((id) => !freschiSet.has(id) && tenuti.includes(id)),
    tagliati,
  };
}

/** Scrive l'elenco. Best-effort per chi la chiama: un piano non deve fallire perché il disco è pieno. */
function writeCollectorPriority(plan, opts = {}) {
  const file = opts.file || PRIORITY_FILE;
  const ora = fin(opts.nowMs) ? opts.nowMs : Date.now();
  const max = fin(opts.max) ? opts.max : MAX_MARKETS;
  const retentionMs = fin(opts.retentionMs) ? opts.retentionMs : RETENTION_MS;

  // Le voci di prima. Un file assente, rotto o di formato vecchio non è un errore: si riparte dall'unione
  // vuota, che è esattamente il comportamento di quando questa corsia non esisteva.
  let precedenti = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && Array.isArray(raw.mercati)) precedenti = raw.mercati;
    else if (raw && Array.isArray(raw.marketIds) && parseMs(raw.at) !== null) {
      // Formato vecchio (fotografia): le voci non hanno data propria, si adotta quella dell'elenco.
      precedenti = raw.marketIds.map((id) => ({ id, piano: null, topK: raw.at, visto: raw.at, rank: null }));
    }
  } catch { /* nessuna voce di prima: si scrive l'unione di solo adesso */ }

  const freschi = mercatiDalPiano(plan, { topK: fin(opts.topK) ? opts.topK : TOP_K });
  const u = unioneMobile({ precedenti, freschi, nowMs: ora, retentionMs, max });

  const body = {
    at: iso(ora),
    versione: 2,
    scelti: ((plan && plan.rows) || []).length,
    freschi: freschi.length,
    trattenuti: u.trattenuti.length,
    scaduti: u.scaduti.length,
    marketIds: u.marketIds,
    mercati: u.mercati,
    note: 'unione mobile con isteresi: righe del piano + primi TOP_K candidati, piu i mercati visti nelle ultime ore — agent34 li tiene sottoscritti perche il loro storico sia gia fresco quando il piano li propone',
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return body;
}

/**
 * Legge l'elenco. Ogni motivo di dubbio — file assente, JSON rotto, campo mancante, elenco vecchio —
 * produce un elenco VUOTO, mai un elenco parziale spacciato per completo.
 *
 * La potatura per voce si applica anche qui, non solo in scrittura: se chi scrive avesse un difetto e
 * lasciasse dentro una voce vecchia di giorni, chi legge non deve sottoscriverla comunque.
 *
 * @returns {{marketIds, at, ageMs, fresh, reason}}
 */
function readCollectorPriority(opts = {}) {
  const file = opts.file || PRIORITY_FILE;
  const now = fin(opts.nowMs) ? opts.nowMs : Date.now();
  const maxAge = fin(opts.maxAgeMs) ? opts.maxAgeMs : MAX_AGE_MS;
  const retentionMs = fin(opts.retentionMs) ? opts.retentionMs : RETENTION_MS;
  const vuoto = (reason) => ({ marketIds: [], at: null, ageMs: null, fresh: false, reason });

  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return vuoto(e && e.code === 'ENOENT' ? 'nessun elenco scritto finora' : `elenco illeggibile (${e.message})`); }
  if (!raw || !Array.isArray(raw.marketIds)) return vuoto('elenco malformato');

  const atMs = parseMs(raw.at);
  if (atMs === null) return vuoto('elenco senza istante di scrittura: non se ne puo giudicare l eta');
  const ageMs = now - atMs;
  if (ageMs > maxAge) return vuoto(`elenco vecchio di ${Math.round(ageMs / 60_000)} minuti (limite ${Math.round(maxAge / 60_000)}): la corsia si spegne invece di inchiodarsi a un piano morto`);

  let ids;
  if (Array.isArray(raw.mercati)) {
    // Formato con isteresi: ogni voce porta la sua data, e la si giudica una per una.
    const perId = new Map();
    for (const v of raw.mercati) {
      const id = normId(v && v.id);
      if (!id || perId.has(id)) continue;
      const visto = parseMs(v && v.visto);
      if (visto === null || now - visto > retentionMs) continue;
      perId.set(id, true);
    }
    // L'ordine del file è già quello di priorità (righe, top-K, trattenuti): lo si rispetta.
    ids = raw.marketIds.map(normId).filter((id) => id && perId.has(id));
  } else {
    ids = [...new Set(raw.marketIds.map(normId).filter(Boolean))];
  }
  return { marketIds: ids.slice(0, MAX_MARKETS), at: raw.at, ageMs, fresh: true, reason: null };
}

module.exports = {
  mercatiDalPiano,
  priorityFromPlan,
  unioneMobile,
  writeCollectorPriority,
  readCollectorPriority,
  PRIORITY_FILE,
  MAX_AGE_MS,
  MAX_MARKETS,
  TOP_K,
  RETENTION_MS,
};

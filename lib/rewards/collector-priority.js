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

const { DATA_DIR } = require('../safety/store');
const PRIORITY_FILE = path.join(DATA_DIR, 'collector-priority.json');

// Due cicli del riallocatore (6h l'uno) più un margine: se dopo 13 ore nessuno ha riscritto l'elenco,
// qualcosa non sta girando e la corsia si spegne da sola.
const MAX_AGE_MS = 13 * 3_600_000;

// ── I TRE NUMERI DELL'UNIONE MOBILE ─────────────────────────────────────────────────────────────────
// RIMISURATI L'8 AGOSTO 2026, sul sistema di adesso e non su quello del 4 agosto. Due campagne, perché
// le due domande vivono su due scale diverse e una sola misura ne avrebbe risposto a metà:
//
//   VIVO      — 8 piani reali a 3,4 minuti l'uno dall'altro (00:48 → 01:12 UTC): 28 coppie, 214 righe
//               future esaminate. È la scala di TOP_K, cioè «una lista scritta ORA basta al piano di
//               fra poco?».
//   STORICO   — 14 piani ricalcolati spostando indietro la finestra del giornale (da −30h a ora):
//               91 coppie, 666 righe future. È la scala di RETENTION, che 24 ore non si aspettano
//               campionando in avanti. (Limite dichiarato: il board — montepremi, banda, scadenze — è
//               la fotografia di adesso anche per i campioni arretrati; scorre il prezzo, non il premio.)
//
// PRIMA DI MISURARE, UN DIFETTO NELLA MISURA STESSA. La graduatoria era ordinata per `bestNetPerDay`,
// che è una cifra da MOSTRARE: `calcNetPerDay` la annulla quando nessun fill è stato osservato. Con quel
// criterio la graduatoria conteneva ~80 dei 113 mercati valutati, e 412 delle 755 righe future
// esaminate erano FUORI da essa — cioè oltre metà dei mercati che il piano avrebbe scelto poco dopo
// erano invisibili a QUALSIASI K. Erano i mercati silenziosi, quelli su cui un maker vuole stare: il
// criterio li escludeva per la ragione che li rende buoni. Ora si ordina per `bestObiettivoPerDay`, il
// netto che il knapsack massimizza davvero (vedi `mercatiDalPiano`), e le righe fuori graduatoria sono
// scese da 412/755 a 142/666 nello storico e a 0/214 nel vivo.
//
// TOP_K = 15 — quanti candidati oltre le righe del piano restano caldi.
//   VIVO:    K=10 copre 214/214 righe (100%) e 28/28 coppie per intero; la profondità MASSIMA osservata
//            è 9. Nessuna riga futura era fuori dalla graduatoria precedente (0 su 214).
//   STORICO: delle 524 righe future che erano in graduatoria, K=10 ne copre 513 (97,9%), K=15 ne copre
//            516 (98,5%) — e da lì K non guadagna più niente fino a 50+: le 8 rimanenti stavano ai
//            posti 91-99. La distribuzione dice il resto: p50 rango 3, p75 rango 5, p90 rango 7,
//            p95 rango 9.
//   Quindi 15 è il ginocchio della curva, con sei ranghi di margine sulla profondità massima vista dal
//   vivo. Il vecchio 30 costava quindici slot di feed per zero righe in più: misurato, non dedotto.
//   Le 142 righe (21%) fuori graduatoria nello storico NON sono un problema di K — sono mercati che al
//   momento t1 non erano nemmeno scorabili (senza storico, sotto il pavimento del montepremi, o
//   rifiutati dall'orizzonte). Nessun K le salva; è il caso per cui lib/maker/attesa-riscaldamento.js
//   è pronto (spento).
//
// RETENTION_MS = 12h — quanto un mercato resta caldo dopo l'ultimo interesse. CONFERMATO dalla misura.
//   La domanda giusta è: chi smette di essere interessante e poi RITORNA, quante ore sta fuori? Sullo
//   storico i ritorni osservati sono stati 3, a 3,01h · 6,01h · 8,01h — massimo 8,01h. (Sulla stessa
//   finestra col vecchio criterio di graduatoria erano 8 ritorni, massimo 11,05h.) Nel vivo, in 24
//   minuti, nessuno è uscito ed è rientrato: zero ritorni.
//   12h copre il massimo osservato con il 50% di margine, ed è anche DUE cicli interi del riallocatore
//   (6h l'uno): un mercato sopravvive a due cicli che non lo scelgono prima di raffreddarsi.
//   Non oltre MAX_AGE_MS (13h): una voce non deve poter sopravvivere all'elenco che la contiene.
//
// MAX_MARKETS = 30 — il tetto duro della corsia.
//   Deve contenere le righe del piano più TOP_K senza che l'isteresi possa buttare fuori un mercato su
//   cui si sta per piazzare: le righe osservate in queste due campagne sono 7-9, quindi 9 + 15 = 24 nel
//   caso peggiore, e restano 6 slot per le voci trattenute.
//   IL COSTO È REALE E MISURATO: il feed di agent34 stava a 112 mercati sottoscritti su 125 di
//   TOTAL_MARKET_CAP (data/mid-history-coverage.json, 8 agosto 2026) — tredici slot liberi. La corsia
//   ha il diritto di sfrattare mercati del board, quindi ogni slot che chiede in più è un mercato del
//   board in meno. Il vecchio 40 chiedeva dieci slot che la misura non giustifica.
//   Che il tetto MORDA e non lasci crescere l'elenco all'infinito è provato, non sperato: l'unione dei
//   14 campioni storici (30 ore) con K=30 arrivava a 55 mercati — sopra il tetto, quindi il tetto era
//   già l'unica cosa che la fermava. Con K=15 cresce meno, e il test dei cicli consecutivi verifica che
//   oltre il tetto cedono i TRATTENUTI e mai le righe del piano.
const TOP_K = Number(process.env.COLLECTOR_PRIORITY_TOP_K || 15);
const RETENTION_MS = Number(process.env.COLLECTOR_PRIORITY_RETENTION_H || 12) * 3_600_000;
// ── 30 → 60 IL 13 AGOSTO 2026: L'ANELLO CHIUSO ────────────────────────────────────────────────────
// Il tetto era 30 perche' la corsia doveva contenere «le righe del piano piu' TOP_K». Ma il piano puo'
// contenere solo i mercati che questa corsia fa sottoscrivere ad agent34, e l'allocatore SCARTA
// (`allocator.js:1068`, `status:'scartato', capital:0`) ogni mercato la cui profondita' non e'
// VERIFICATA — e la verifica accetta solo campioni websocket (`allocator.js:109`, `r.src === 'ws'`).
// Quindi: il piano sceglie fra cio' che il feed guarda, e il feed guarda cio' che il piano ha scelto.
// Misurato il 13 agosto alle 00:20: dei 17 mercati che superavano OGNI filtro d'ingresso, solo 3 erano
// nel feed. Gli altri 14 erano invisibili all'allocatore per costruzione, con $400 di capitale fermo.
//
// 60 e non 125: agent34 dichiara `TOTAL_MARKET_CAP` 125 e questa e' UNA delle sue quattro corsie —
// board, tracking, piano, permessi — piu' i mercati con posizione aperta. Raddoppiare la corsia calda
// lascia 65 posti alle altre, che e' il margine di sicurezza. Alzarlo oltre significherebbe scoprire
// una corsia per riempirne un'altra.
const MAX_MARKETS = Number(process.env.COLLECTOR_PRIORITY_MAX || 60);

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

  // ── SU QUALE NUMERO SI ORDINA, E PERCHÉ NON PIÙ `bestNetPerDay` (8 agosto 2026) ─────────────────
  // La graduatoria deve essere quella con cui l'ottimizzatore ha ordinato, non quella che il pannello
  // mostra. `bestNetPerDay` è una cifra da mostrare: `calcNetPerDay` la annulla quando nessun fill è
  // stato osservato, che è la regola giusta per un numero da leggere (un netto senza fill non è
  // misurato) e quella sbagliata per una graduatoria — perché esclude i mercati SILENZIOSI, cioè
  // esattamente quelli su cui un maker vuole stare.
  //
  // Misurato su 14 piani reali (finestre da −30h a ora, 8 agosto 2026): ordinando per
  // `bestNetPerDay` la graduatoria conteneva ~80 dei 113 mercati valutati, e 412 delle 755 righe
  // future esaminate erano FUORI da essa — nessun K, per quanto profondo, poteva coprirle. Con
  // `bestObiettivoPerDay` (il netto che il knapsack massimizza davvero, col costo modellato a zero
  // dove nessun fill è stato osservato) la graduatoria contiene tutti i mercati scorabili.
  //
  // Il ripiego su `bestNetPerDay` resta per i piani vecchi e per i chiamanti che costruiscono a mano
  // un oggetto-piano: un campo assente non deve svuotare la corsia.
  const criterio = (c) => (fin(c.bestObiettivoPerDay) ? c.bestObiettivoPerDay : (fin(c.bestNetPerDay) ? c.bestNetPerDay : null));
  const graduatoria = ((plan && plan.candidates) || [])
    .filter((c) => c && criterio(c) != null && normId(c.marketId))
    .sort((a, b) => criterio(b) - criterio(a));

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
function unioneMobile({ precedenti = [], freschi = [], candidati = [], nowMs, retentionMs = RETENTION_MS, max = MAX_MARKETS } = {}) {
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

  // ── I CANDIDATI: I MERCATI CHE IL PIANO POTREBBE SCEGLIERE SE LI VEDESSE ────────────────────────
  // Arrivano gia' ordinati per montepremi da chi li conosce (agent41 legge il board). Entrano come
  // ultima classe e sono i PRIMI a cedere il posto: un candidato e' un'ipotesi, una riga del piano e'
  // capitale gia' deciso e un mercato con posizione e' capitale gia' esposto.
  const candidatiOra = [];
  for (const cnd of candidati) {
    const id = normId(typeof cnd === 'string' ? cnd : (cnd && cnd.id));
    if (!id || per.has(id)) continue;   // gia' presente per un motivo piu' forte: non si declassa
    per.set(id, { id, piano: null, topK: null, candidato: oraIso, visto: oraIso, rank: null });
    candidatiOra.push(id);
  }

  const freschiSet = new Set([...righeOra, ...topKOra]);
  // L'ORDINE E' L'ORDINE DI SACRIFICIO, dal piu' protetto al primo a cadere:
  //   righe del piano → quasi-vincitori → trattenuti (per freschezza) → candidati.
  const ordine = [
    ...righeOra,
    ...topKOra,
    ...trattenuti
      .filter((id) => !freschiSet.has(id))
      .sort((a, b) => (parseMs(per.get(b).visto) || 0) - (parseMs(per.get(a).visto) || 0)),
    ...candidatiOra,
  ];

  const tenuti = ordine.slice(0, max);
  const tagliati = ordine.slice(max);
  return {
    mercati: tenuti.map((id) => per.get(id)),
    marketIds: tenuti,
    scaduti,
    trattenuti: trattenuti.filter((id) => !freschiSet.has(id) && tenuti.includes(id)),
    candidati: candidatiOra.filter((id) => tenuti.includes(id)),
    candidatiTagliati: candidatiOra.filter((id) => !tenuti.includes(id)),
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
  // I mercati con POSIZIONE APERTA entrano fra le righe del piano: e' capitale gia' esposto, e la
  // regola di copertura «board ∪ posizioni» vale anche qui (§5 punti 44, 61, 62/69, 82).
  const conPosizione = (opts.posizioni || []).map((id) => ({ id: normId(id), motivo: 'piano' })).filter((x) => x.id);
  const u = unioneMobile({
    precedenti,
    freschi: [...freschi, ...conPosizione.filter((p) => !freschi.some((f) => normId(f.id) === p.id))],
    candidati: opts.candidati || [],
    nowMs: ora, retentionMs, max,
  });

  const body = {
    at: iso(ora),
    versione: 2,
    scelti: ((plan && plan.rows) || []).length,
    freschi: freschi.length,
    trattenuti: u.trattenuti.length,
    scaduti: u.scaduti.length,
    // I candidati contati a parte: «il feed e' cresciuto» e «il piano e' cresciuto» non devono essere
    // lo stesso numero, altrimenti non si vede se l'anello si e' aperto davvero.
    candidati: u.candidati.length,
    candidatiTagliati: u.candidatiTagliati.length,
    conPosizione: conPosizione.length,
    marketIds: u.marketIds,
    mercati: u.mercati,
    note: 'unione mobile con isteresi: righe del piano + mercati con posizione + primi TOP_K candidati + CANDIDATI (minSize compatibile e orizzonte valido), piu i mercati visti nelle ultime ore. I candidati esistono perche l allocatore SCARTA i mercati senza profondita verificata dal websocket: senza sottoscriverli prima, il piano non puo sceglierli mai.',
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

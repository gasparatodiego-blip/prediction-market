'use strict';
// scripts/rewards-replay/lib/journal.js — read agent34's mid-history journal (data/mid-history-*.jsonl).
// Confirms the schema against the ACTUAL rows (not the task description), groups by market, sorted by ts.
// OFFLINE, read-only. A row missing a field a computation needs is EXCLUDED and counted, never defaulted.
//
// SCHEMA (confirmed from the writer agent34-clob-ws.sampleMidHistory and the live rows):
//   ts, marketId, tokenIdYes, adjMid, plainMid, bestBid, bestAsk, bidDepthInBand, askDepthInBand,
//   bandLow, bandHigh, tick, src ("ws" | "stale")
// CADENCE: sampled every ~45s (env MID_HISTORY_INTERVAL_MS; the task's "15s" is stale — the file wins).

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const REQUIRED_KEYS = ['ts', 'marketId', 'tokenIdYes', 'adjMid', 'plainMid', 'bestBid', 'bestAsk',
  'bidDepthInBand', 'askDepthInBand', 'bandLow', 'bandHigh', 'tick', 'src'];

function listJournalFiles() {
  let files = [];
  try { files = fs.readdirSync(DATA_DIR); } catch { return []; }
  return files.filter((f) => /^mid-history-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map((f) => path.join(DATA_DIR, f));
}

// ══ I TRE MODI IN CUI QUESTO LETTORE MANGIAVA LA MEMORIA — 21 agosto 2026 ═════════════════════════
// Il processo figlio del piano moriva in OOM a 924 MB su una macchina con ~430 MB liberi, 4 cicli su
// 4 al giorno dal 19 agosto. MISURATO (data/ricerca/d-c-dove-va-la-memoria.json), non stimato:
//
//   ① LEGGEVA TUTTI I FILE, ANCHE FUORI FINESTRA. `listJournalFiles()` restituisce ogni
//      `mid-history-*.jsonl` sul disco — 7 file, 1.295 MB — e la finestra `[fromMs,toMs]` veniva
//      applicata alla RIGA, dopo averla letta e parsata. Con una finestra di 48 h si leggevano 7
//      giorni per tenerne 3.
//   ② `readFileSync` + `split('\n')`. Il file piu' grande e' 283 MB: la stringa intera piu' l'array
//      delle righe stanno in heap NELLO STESSO ISTANTE, cioe' ~566 MB di transitorio per file, sopra
//      la struttura ritenuta. E' la stessa trappola che §4.10 ha gia' chiuso per il giornale del
//      maker con `giornale-incrementale`; qui non era stata chiusa.
//   ③ LA COPIA RITENUTA PORTAVA CAMPI CHE NESSUNO LEGGE. `{ ...r, tsMs }` copia la riga INTERA:
//      misurato **887 byte/riga** in heap contro **248** con i soli campi che il piano usa. Due campi
//      valgono l'**85,3%** del testo — `no` (45,2%, aggiunto il 19 agosto per la ricerca su R4, §5.2
//      p.43) e `levels` (40,1%) — e **nessun consumatore di righe di giornale li legge**: le
//      occorrenze di `.levels` nel percorso del piano sono tutte su oggetti CURVA del knapsack, non
//      su righe. Che `levels` fosse scartabile il repo lo sapeva gia': `allocator.js:1407` fa
//      `r.levels = undefined` — ma DOPO che `loadJournal` ha costruito tutto, cioe' dopo il picco.
//
// ⚠ NESSUNA SOGLIA E' STATA ALZATA, e non per stile: alzare `--max-old-space-size` su questa macchina
// sposterebbe l'OOM killer su agent40/agent41, cioe' sui processi che tengono gli ordini veri.
//
// ⚠ LO SCARTO DEI CAMPI E' OPT-IN. Il difetto e' del CHIAMANTE che sa cosa gli serve, non del
// lettore: `scartaCampi` assente ⇒ comportamento IDENTICO a prima per qualunque altro chiamante,
// backtest compreso (§5.2 p.50: la corsia del backtest non si tocca a cuor leggero).

/** I file che possono contenere righe della finestra, per NOME. Un giorno di margine per lato:
 *  il nome dichiara il giorno UTC, e un margine rende la scelta indipendente da come lo scrittore
 *  tratta la mezzanotte. Finestra non finita ⇒ si tengono TUTTI i file, cioe' il comportamento di
 *  prima: una finestra che non si sa non deve poter ESCLUDERE dati. */
function fileNellaFinestra(files, fromMs, toMs) {
  if (!Number.isFinite(fromMs) && !Number.isFinite(toMs)) return files;
  const G = 86_400_000;
  const da = Number.isFinite(fromMs) ? fromMs - G : -Infinity;
  const a = Number.isFinite(toMs) ? toMs + G : Infinity;
  return files.filter((f) => {
    const m = path.basename(f).match(/^mid-history-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) return true;                       // nome che non si sa leggere ⇒ si tiene
    const g = Date.parse(m[1] + 'T00:00:00Z');
    if (!Number.isFinite(g)) return true;
    return g + G > da && g < a;                // il giorno interseca la finestra allargata
  });
}

/** Le righe di un file, UNA ALLA VOLTA, senza mai costruire ne' la stringa intera ne' l'array delle
 *  righe. Chunk da 4 MB piu' il resto non terminato: il transitorio e' limitato dal chunk, non dal
 *  file. Restituisce false se il file non si apre — un file illeggibile si salta, come prima. */
function perOgniRiga(file, visita) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return false; }
  const CHUNK = 4 * 1024 * 1024;
  const buf = Buffer.allocUnsafe(CHUNK);
  // ⚠ `buf.toString('utf8')` NON si puo' usare qui: un carattere multi-byte a cavallo di due chunk
  // verrebbe decodificato come due caratteri di sostituzione, la riga diventerebbe JSON non valido e
  // finirebbe in `malformed` — cioe' un dato PERSO IN SILENZIO, con il contatore a dirlo in una riga
  // che nessuno legge. `StringDecoder` tiene i byte incompleti fino al chunk dopo. Oggi le righe di
  // mid-history sono ASCII, ma «oggi e' ASCII» non e' un invariante che questo lettore possa imporre.
  const decoder = new StringDecoder('utf8');
  let resto = '';
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      const testo = resto + decoder.write(buf.slice(0, n));
      let i = 0;
      for (;;) {
        const j = testo.indexOf('\n', i);
        if (j < 0) { resto = testo.slice(i); break; }
        visita(testo.slice(i, j));
        i = j + 1;
      }
    }
    resto += decoder.end();                     // i byte incompleti finali, se ce ne sono
    if (resto.length) visita(resto);            // l'ultima riga senza `\n` non si perde
  } finally { fs.closeSync(fd); }
  return true;
}

// Load the journal, optionally windowed to [fromMs, toMs]. Returns rows grouped by market (ts-sorted),
// the observation window, the ws/stale split, and a schema report. Never throws on a short/partial file.
function loadJournal({ fromMs = -Infinity, toMs = Infinity, scartaCampi = null } = {}) {
  const tuttiIFile = listJournalFiles();
  const files = fileNellaFinestra(tuttiIFile, fromMs, toMs);
  // ⚠ `scartaCampi` va normalizzato una volta sola: dentro il ciclo sarebbe un `Set` per riga.
  const scarta = Array.isArray(scartaCampi) && scartaCampi.length ? new Set(scartaCampi) : null;
  const byMarket = new Map();
  let rows = 0, ws = 0, stale = 0, malformed = 0;
  let minTs = Infinity, maxTs = -Infinity;
  let schemaConfirmed = null, schemaMismatch = null;

  for (const file of files) {
    perOgniRiga(file, (line) => {
      if (!line.trim()) return;
      let r;
      try { r = JSON.parse(line); } catch { malformed++; return; }
      // La conferma dello schema resta sulla riga INTERA e PRIMA dello scarto: si verifica cosa lo
      // scrittore ha scritto, non cosa questo lettore ha deciso di tenere.
      if (schemaConfirmed == null) {
        const missing = REQUIRED_KEYS.filter((k) => !(k in r));
        schemaConfirmed = missing.length === 0;
        if (!schemaConfirmed) schemaMismatch = missing;
      }
      const t = Date.parse(r.ts);
      if (!Number.isFinite(t) || t < fromMs || t > toMs) return;
      rows++;
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
      if (r.src === 'stale') stale++; else if (r.src === 'ws') ws++;
      if (!byMarket.has(r.marketId)) byMarket.set(r.marketId, []);
      // ⚠ SI COSTRUISCE LA COPIA MAGRA, non si sfoltisce quella grassa: `delete` su `{...r}` avrebbe
      // gia' pagato il picco. Senza `scartaCampi` resta `{ ...r, tsMs }`, identico a prima.
      if (scarta) {
        const o = { tsMs: t };
        for (const k in r) if (!scarta.has(k)) o[k] = r[k];
        byMarket.get(r.marketId).push(o);
      } else {
        byMarket.get(r.marketId).push({ ...r, tsMs: t });
      }
    });
  }
  for (const arr of byMarket.values()) arr.sort((a, b) => a.tsMs - b.tsMs);

  const windowHours = (Number.isFinite(minTs) && Number.isFinite(maxTs)) ? (maxTs - minTs) / 3_600_000 : 0;
  return {
    files: files.map((f) => path.basename(f)),
    // Quanti file esistevano e quanti se ne sono davvero letti: senza, «ho letto tutto» e «ho letto
    // i tre che servivano» sono la stessa riga di log, ed e' esattamente la differenza che questo
    // lettore esiste per fare.
    fileTotali: tuttiIFile.length,
    fileLetti: files.length,
    campiScartati: scarta ? [...scarta] : null,
    rows, ws, stale, malformed,
    staleFrac: (ws + stale) > 0 ? stale / (ws + stale) : 0,
    window: { fromMs: Number.isFinite(minTs) ? minTs : null, toMs: Number.isFinite(maxTs) ? maxTs : null, hours: windowHours },
    byMarket,
    schemaConfirmed: !!schemaConfirmed,
    schemaMismatch,
    requiredKeys: REQUIRED_KEYS,
  };
}

// Nearest journal row for a market at target time, within ±toleranceMs (default half a 45s interval).
// Returns null when no sample is close enough (e.g., the horizon is beyond the collected window) — the
// caller EXCLUDES that horizon and counts it. Never interpolates/fabricates a value.
function rowNear(marketRows, targetMs, toleranceMs = 30_000) {
  let best = null, bestDelta = Infinity;
  // marketRows is ts-sorted; a linear scan is fine at this data size.
  for (const r of marketRows) {
    const d = Math.abs(r.tsMs - targetMs);
    if (d < bestDelta) { bestDelta = d; best = r; }
    if (r.tsMs > targetMs + toleranceMs) break;
  }
  return bestDelta <= toleranceMs ? best : null;
}

module.exports = { loadJournal, rowNear, listJournalFiles, DATA_DIR, REQUIRED_KEYS };

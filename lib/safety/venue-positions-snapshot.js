'use strict';
// lib/safety/venue-positions-snapshot.js — LE POSIZIONI VERE, LEGGIBILI DA CHI CALCOLA I TETTI.
//
// ═══ IL PROBLEMA CHE RISOLVE ═════════════════════════════════════════════════════════════════════════
// Il 4 agosto 2026 il sistema aveva DUE contabilità del rischio che non si parlavano:
//
//   · lib/safety/fills.computeExposure  derivava le posizioni dal LEDGER LOCALE dei fill, cioè da quello
//     che la riconciliazione era riuscita a scrivere. Diceva $0.
//   · lib/maker/auto-close                leggeva le posizioni dal VENUE. Vedeva 199,99 share con un
//     carico di $0,1675 sul mercato 0xad02c78e.
//
// La prima è quella che governa i tetti — `maxOpenNotionalUsd` ($600) e, per suo tramite, quanto capitale
// il piano può allocare. Quindi il bot poteva allocare come se una posizione reale non esistesse. Con un
// capitale pari al tetto, un cap che non conta le share è un cap che non c'è.
//
// ═══ PERCHÉ UNO SNAPSHOT E NON UNA LETTURA DIRETTA ══════════════════════════════════════════════════
// `readUsage` è SINCRONA ed è chiamata dentro il gate per-ordine, cioè sul percorso caldo di ogni
// piazzamento. Leggere il venue lì dentro vorrebbe dire una chiamata di rete per ordine, e un gate che
// dipende dalla latenza della rete è un gate che qualcuno prima o poi disattiva.
//
// agent40 le posizioni le legge già, sul suo throttle di 60 secondi, per l'uscita automatica. Questo
// modulo prende quella lettura — la STESSA, non una terza — e la deposita dove chi calcola i tetti può
// leggerla senza rete.
//
// ═══ LA FRESCHEZZA È UN FATTO, NON UNA SPERANZA ════════════════════════════════════════════════════
// Lo snapshot porta la sua età. Oltre MAX_AGE_MS si legge come NON LEGGIBILE — mai come «nessuna
// posizione». È la differenza fra «ho guardato e non c'è niente» e «non ho guardato», ed è la stessa
// distinzione che questo progetto applica ovunque. Chi consuma decide cosa fare di un'assenza; qui non
// si inventa uno zero.

const fs = require('fs');
const path = require('path');
// ── LA CARTELLA `data/` SI CHIEDE, NON SI CALCOLA ───────────────────────────────────────────────────
// Questo modulo lo carica agent40 come node semplice (__dirname = lib/safety/) E la dashboard dentro il
// bundle di Next (__dirname = .next/server/chunks/). `path.join(__dirname, '..', '..', 'data')` dava
// due cartelle DIVERSE: lo scrittore scriveva in data/, il lettore guardava in .next/data/ — che non è
// mai esistita e non esisterà mai. Quindi il gate leggeva ENOENT per sempre, e «mai scritto» era
// letteralmente vero dal punto di vista di chi leggeva, mentre il file c'era.
//
// `lib/safety/store.js` questo problema lo aveva GIÀ risolto — stessa cartella, e il suo commento
// descrive lo stesso guasto, inclusa la trappola del `.next/package.json` che fa fermare la risalita a
// `.next/data`. Qui si riusa quella risoluzione invece di rifarne una seconda: due modi di trovare la
// stessa cartella sono due modi di trovarne due.
const { DATA_DIR } = require('./store');

const SNAPSHOT_FILE = path.join(DATA_DIR, 'venue-positions.json');
// agent40 rilegge le posizioni ogni 60s. Tre minuti sono tre letture mancate di fila: non un ritardo,
// un processo fermo.
const MAX_AGE_MS = 180_000;

/**
 * Deposita la lettura delle posizioni. La scrive SOLO se la lettura è riuscita: sovrascrivere uno
 * snapshot buono con un fallimento trasformerebbe un guasto di rete passeggero in «nessuna posizione».
 *
 * @param {{ok:boolean, positions:Array|null, reason?:string}} lettura  l'esito di fetchVenuePositions
 */
function writeVenuePositions(lettura, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  // `snapshotFile` iniettabile come nel lettore. Senza, l'unico modo di esercitare lo scrittore era
  // sovrascrivere lo snapshot di produzione — cioè il file da cui dipende ogni piazzamento: un test che
  // per girare deve toccare quel file non lo si esegue mai, e infatti non era mai stato esercitato.
  const file = deps.snapshotFile || SNAPSHOT_FILE;
  if (!lettura || lettura.ok !== true || !Array.isArray(lettura.positions)) {
    return { ok: false, written: false, reason: (lettura && lettura.reason) || 'lettura non riuscita: lo snapshot precedente resta com era' };
  }
  const at = now();
  const body = {
    at, atIso: new Date(at).toISOString(),
    positions: lettura.positions.map((p) => ({
      tokenId: String(p.tokenId ?? p.asset ?? ''),
      conditionId: p.conditionId ?? null,
      size: Number(p.size),
      avgPrice: Number(p.avgPrice),
      curPrice: Number.isFinite(Number(p.curPrice)) ? Number(p.curPrice) : null,
      title: p.title ?? null,
    })).filter((p) => p.tokenId && Number.isFinite(p.size) && p.size > 0),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, file);   // atomico: nessun lettore vede mai un file a metà
    return { ok: true, written: true, count: body.positions.length, at };
  } catch (e) {
    return { ok: false, written: false, reason: e.message };
  }
}

/**
 * Le posizioni depositate, se abbastanza fresche.
 * @returns {{readable:boolean, positions:Array, ageMs:number|null, reason:string|null}}
 *          `readable:false` ⇒ NON si sa cosa c'è aperto. Non è «non c'è niente».
 */
function readVenuePositions(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const file = deps.snapshotFile || SNAPSHOT_FILE;
  const maxAge = Number.isFinite(deps.maxAgeMs) ? deps.maxAgeMs : MAX_AGE_MS;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { readable: false, positions: [], ageMs: null, reason: `snapshot delle posizioni non leggibile (${e.code === 'ENOENT' ? 'mai scritto' : e.message})` }; }
  const at = Number(raw && raw.at);
  if (!Number.isFinite(at)) return { readable: false, positions: [], ageMs: null, reason: 'snapshot senza data: non se ne può giudicare la freschezza' };
  const ageMs = now() - at;
  if (ageMs > maxAge) {
    return { readable: false, positions: [], ageMs, reason: `snapshot delle posizioni vecchio di ${Math.round(ageMs / 1000)}s (limite ${Math.round(maxAge / 1000)}s): chi lo scrive non sta girando` };
  }
  return { readable: true, positions: Array.isArray(raw.positions) ? raw.positions : [], ageMs, reason: null };
}

/**
 * L'ULTIMO TENTATIVO PRIMA DI RIFIUTARE (12 agosto 2026).
 *
 * ═══ IL PROBLEMA ═══════════════════════════════════════════════════════════════════════════════════
 * Sopra i 180 s di età OGNI piazzamento viene rifiutato, quindi un rate-limit prolungato su
 * `data-api /positions` blocca il bot senza che nulla sia rotto. Il backoff su quella lettura
 * (`manual-reset.fetchVenuePositions`) rende la scrittura molto più resistente, ma resta un caso: lo
 * snapshot È già vecchio quando qualcuno lo legge, e rifiutare senza aver provato a rinfrescarlo
 * significa buttare via un ordine per una fotografia che si poteva rifare.
 *
 * ⚠ LA SOGLIA DEI 180 SECONDI NON SI ALLARGA, e non è negoziabile: non è un fastidio, è la protezione
 * che impedisce di piazzare su una fotografia vecchia delle posizioni. Qui non si allenta — si prova a
 * RIFARE la fotografia. Se il tentativo non riesce, il rifiuto arriva identico a prima.
 *
 * ═══ PERCHÉ UNA FUNZIONE A PARTE E NON DENTRO `readVenuePositions` ═════════════════════════════════
 * `readVenuePositions` è SINCRONA e la chiamano percorsi che non possono aspettare — la cintura
 * dell'adapter, l'esenzione dal tetto, il gate live-min. Renderla asincrona vorrebbe dire cambiare la
 * firma di ognuno per un caso che riguarda solo chi PUÒ rinfrescare. Chi non passa `refresh` ottiene
 * esattamente il comportamento di prima.
 *
 * @param deps.refresh async () => void — rifà lo snapshot. Assente ⇒ nessun tentativo.
 * @returns lo stesso oggetto di `readVenuePositions`, più `rinfrescato` e `motivoRefresh`.
 */
async function readVenuePositionsConRefresh(deps = {}) {
  const primo = readVenuePositions(deps);
  if (primo.readable === true) return { ...primo, rinfrescato: false, motivoRefresh: null };
  if (typeof deps.refresh !== 'function') {
    return { ...primo, rinfrescato: false, motivoRefresh: 'nessun rinfrescatore iniettato: il rifiuto resta quello di prima' };
  }
  let motivo = null;
  try { await deps.refresh(); } catch (e) { motivo = e && e.message ? e.message : String(e); }
  const secondo = readVenuePositions(deps);
  return {
    ...secondo,
    rinfrescato: true,
    // Si dichiara SEMPRE se il tentativo c'è stato e com'è andato: senza questa riga «rifiutato senza
    // provare» e «rifiutato dopo aver provato» sarebbero lo stesso rifiuto, e sono due diagnosi diverse.
    motivoRefresh: motivo
      ? `ultimo tentativo di refresh fallito: ${motivo}`
      : (secondo.readable ? 'snapshot rinfrescato con successo prima di decidere' : 'refresh tentato ma lo snapshot è ancora inutilizzabile'),
  };
}

module.exports = { writeVenuePositions, readVenuePositions, readVenuePositionsConRefresh, SNAPSHOT_FILE, MAX_AGE_MS };

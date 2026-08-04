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

const ROOT = path.join(__dirname, '..', '..');
const SNAPSHOT_FILE = path.join(ROOT, 'data', 'venue-positions.json');
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
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    const tmp = SNAPSHOT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, SNAPSHOT_FILE);   // atomico: nessun lettore vede mai un file a metà
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

module.exports = { writeVenuePositions, readVenuePositions, SNAPSHOT_FILE, MAX_AGE_MS };

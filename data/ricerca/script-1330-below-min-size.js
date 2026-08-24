// Conteggio dei rifiuti BELOW_MIN_SIZE nelle ultime 24 ore.
// SOLA LETTURA. Due file: l'archivio ruotato + il file corrente, con l'OVERLAP del carryover
// (64 MB) tolto per BYTE OFFSET, non per timestamp: il rename porta nel file nuovo gli ultimi
// 64 MB dell'archivio, quindi contare i due file interi raddoppierebbe ~20 ore di righe.
const fs = require('fs');
const readline = require('readline');

const CUR = 'data/polymarket-maker-audit.jsonl';
const ARC = 'data/polymarket-maker-audit-2026-08-23T23-42-58Z.jsonl';
const OVERLAP_OFFSET = 355403083; // verificato: archivio[355403083..] === testa del file corrente

const ORA = Number(process.env.ORA_MS || Date.now());
const CUTOFF = ORA - 24 * 3600 * 1000;

const perSize = new Map();
const perOp = new Map();
const perSource = new Map();
let totale = 0, conMercato = 0, senzaMercato = 0;
let primaTs = null, ultimaTs = null;
let righeLette = 0, righeRotte = 0;

function classifica(r) {
  const outcome = String(r.outcome || '');
  if (!outcome.startsWith('reject')) return null;
  // Il motivo del RIFIUTO, non l'avviso di banda: `bandAdvisory` nomina BELOW_MIN_SIZE
  // anche quando a rifiutare e' altro, e contarlo gonfierebbe il numero.
  let ha = false;
  if (Array.isArray(r.reasons)) ha = r.reasons.some(x => x && x.code === 'BELOW_MIN_SIZE');
  if (!ha && typeof r.reason === 'string') ha = /(^|[;,]\s*)BELOW_MIN_SIZE\b/.test(r.reason);
  return ha ? true : null;
}

function mercatoNoto(r) {
  if (typeof r.marketRef === 'string' && r.marketRef) return true;
  if (typeof r.conditionId === 'string' && r.conditionId) return true;
  if (r.requested && typeof r.requested.conditionId === 'string' && r.requested.conditionId) return true;
  return false;
}

function conta(r) {
  totale++;
  const s = r.requested && r.requested.size;
  const k = Number.isFinite(s) ? String(s) : 'non-leggibile';
  perSize.set(k, (perSize.get(k) || 0) + 1);
  const op = String(r.op || 'ignoto');
  perOp.set(op, (perOp.get(op) || 0) + 1);
  const src = String(r.source || 'ignota');
  perSource.set(src, (perSource.get(src) || 0) + 1);
  if (mercatoNoto(r)) conMercato++; else senzaMercato++;
  if (primaTs === null || r.ts < primaTs) primaTs = r.ts;
  if (ultimaTs === null || r.ts > ultimaTs) ultimaTs = r.ts;
}

async function scorri(file, opts) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, opts.range || {}),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line || line.charCodeAt(0) !== 123) continue;
    if (line.indexOf('BELOW_MIN_SIZE') < 0) continue;
    righeLette++;
    let r;
    try { r = JSON.parse(line); } catch { righeRotte++; continue; }
    if (!Number.isFinite(r.ts) || r.ts < CUTOFF || r.ts > ORA) continue;
    if (classifica(r)) conta(r);
  }
}

(async () => {
  // ARCHIVIO: solo la parte NON ricopiata nel file corrente.
  await scorri(ARC, { range: { start: 0, end: OVERLAP_OFFSET - 1 } });
  const dopoArchivio = totale;
  await scorri(CUR, {});
  const out = {
    generatoIso: new Date(ORA).toISOString(),
    finestra: { daIso: new Date(CUTOFF).toISOString(), aIso: new Date(ORA).toISOString(), ore: 24 },
    fonti: { archivio: ARC, corrente: CUR, overlapOffsetByte: OVERLAP_OFFSET },
    totaleRifiuti: totale,
    dallArchivio: dopoArchivio,
    dalFileCorrente: totale - dopoArchivio,
    primoIso: primaTs ? new Date(primaTs).toISOString() : null,
    ultimoIso: ultimaTs ? new Date(ultimaTs).toISOString() : null,
    perSizeDistinta: [...perSize.entries()].sort((a, b) => b[1] - a[1]).map(([size, n]) => ({ size, n })),
    perOp: [...perOp.entries()].sort((a, b) => b[1] - a[1]).map(([op, n]) => ({ op, n })),
    perSource: [...perSource.entries()].sort((a, b) => b[1] - a[1]).map(([source, n]) => ({ source, n })),
    mercatoIdentificabile: { si: conMercato, no: senzaMercato },
    righeCandidateLette: righeLette,
    righeNonParsabili: righeRotte,
  };
  fs.writeFileSync('data/ricerca/below-min-size-24h.json', JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
})();

'use strict';
// scripts/ricerca/d2-simulazione-a-secco.js — realistic-estimate.js:269. COSA CAMBIA, PRIMA DI SCRIVERE.
// SOLA LETTURA. Nessun processo figlio: il pianificatore chiede ~1 GB e ce ne sono ~650 liberi.
//
// LA CATENA, RICOSTRUITA DAL CODICE (file:riga), perche' e' il punto del referto:
//   OBIETTIVO (decide)  : allocate.js:455 perMarketNetCurve → net.js:80 shareForCapital(..., pairCostUsd)
//                         → level.net5m → allocator.js:970 bestNetPerDay → agent41:1357 nettoPerMercato
//                         → selezione ordinaCandidati + spodestamento
//   STIMA (mostra)      : allocator.js:841 realisticEstimate → realisticByTick → realisticBestPerDay
//                         e totalRealisticPerDay
// La riga :269 vive DENTRO `realisticEstimate`, quindi tocca solo il secondo ramo.

const fs = require('fs'); const path = require('path');
const RADICE = path.resolve(__dirname, '..', '..');
const RE = require(path.join(RADICE, 'lib', 'rewards', 'realistic-estimate'));
const { shareForCapital } = require(path.join(RADICE, 'scripts', 'rewards-ceiling', 'lib', 'curve'));
const SDC = require(path.join(RADICE, 'lib', 'rewards', 'size-da-capitale'));

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const clampPrice = (m) => Math.max(0.01, Math.min(0.99, m));
/** Il costo della coppia a `d` centesimi — la stessa aritmetica di allocate.js:387 pairCostForMarket. */
const coppiaA = (dC) => (fin(dC) && dC >= 0 && dC / 100 < 0.5 ? +(1 - 2 * (dC / 100)).toFixed(9) : null);

const BOARD = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'liquidity-rewards.json'), 'utf8'));
const MER = Array.isArray(BOARD) ? BOARD : BOARD.markets;
const ORD = JSON.parse(fs.readFileSync(path.join(RADICE, 'data', 'ricerca', 'ordini-vivi-21ago.json'), 'utf8'));
const LIBRO = new Set(ORD.ordini.map((o) => String(o.market).toLowerCase()));
const SEL = require(path.join(RADICE, 'lib', 'maker', 'selezione-mercati'));
const ora = Date.now();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ① LE FUNZIONI CHE L'OBIETTIVO RIUSA DEVONO RESTARE IDENTICHE
//    `allocate.js:68` importa placementScore, placementShareFactor, credibleShareFactor, DEFAULTS.
//    `profondita-minima.js:61` importa ceilingShare, DEFAULTS. Se una sola di queste si muovesse,
//    si muoverebbe l'OBIETTIVO — cioe' la classifica. Si campiona una griglia e si stampa l'impronta.
// ════════════════════════════════════════════════════════════════════════════════════════════════
function improntaEsportate() {
  const parti = [];
  for (const s of [0, 0.1, 0.5, 1, 1.5, 2.05, 2.5, 3.5, 4.4]) {
    for (const v of [2.5, 3.5, 4.5, 5.5]) parti.push(`ps(${s},${v})=${RE.placementScore(s, v)}`);
  }
  for (const size of [10, 56.5, 524, 5000]) {
    for (const q of [0, 168, 10000, 72000]) {
      parti.push(`cs(${size},${q})=${RE.ceilingShare(size, q)}`);
      for (const S of [0.04, 0.25, 0.7396]) parti.push(`psf(${size},${q},${S})=${RE.placementShareFactor(size, q, S)}`);
      parti.push(`csf(${size},${q})=${RE.credibleShareFactor(size, q)}`);
    }
  }
  parti.push(`DEFAULTS=${JSON.stringify(RE.DEFAULTS)}`, `SPD=${RE.SAMPLES_PER_DAY}`);
  return require('crypto').createHash('sha256').update(parti.join('|')).digest('hex').slice(0, 16);
}
const IMPRONTA = improntaEsportate();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ② L'OBIETTIVO — si riproduce con la funzione VERA e si mostra che NON dipende da :269
// ════════════════════════════════════════════════════════════════════════════════════════════════
function quotaObiettivo(competitorQshares, mid, capitalTotale, minSize, dC) {
  return shareForCapital(competitorQshares, mid, capitalTotale, minSize, coppiaA(dC));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ③ LA STIMA — vecchia contro nuova, sulla riga :269 e basta
// ════════════════════════════════════════════════════════════════════════════════════════════════
const sizeVecchia = (C, mid) => (fin(C) && mid ? (C / 2) / clampPrice(mid) : null);
const sizeNuova = (C, dC) => { const pc = coppiaA(dC); return pc == null ? null : SDC.sharePerLato({ capitaleUsd: C, pairCostUsd: pc }).shares; };

const CAPITALE_RIGA = 61.25;      // il tetto per mercato: il capitale che una riga vera riceve
const OFFSET_C = 2.05;            // la distanza obiettivo in servizio (0.456 × 4,5¢)

const righe = [];
for (const m of MER) {
  const v = Number(m.rewardsMaxSpread), minSize = Number(m.rewardsMinSize) || 0;
  const mid = Number(m.mid), pool = Number(m.rewardsDailyRate);
  const depth = Number(m.existing_depth_usd);
  if (!(v > 0) || !fin(mid) || !fin(pool)) continue;
  const amm = SEL.valutaAmmissibilita(m, { ora });
  const sv = sizeVecchia(CAPITALE_RIGA, mid), sn = sizeNuova(CAPITALE_RIGA, OFFSET_C);
  righe.push({
    id: String(m.conditionId).toLowerCase(), titolo: String(m.question || '').slice(0, 42),
    mid, v, minSize, pool, depth, aLibro: LIBRO.has(String(m.conditionId).toLowerCase()),
    ammissibile: !!amm.ammissibile,
    sizeVecchia: sv, sizeNuova: sn,
    fattore: sv && sn ? +(sv / sn).toFixed(3) : null,
    coppia: coppiaA(OFFSET_C),
  });
}
const amm = righe.filter((r) => r.ammissibile);

console.log(`board ${MER.length} righe · ${righe.length} scorabili · ${amm.length} ammissibili · ${righe.filter((r) => r.aLibro).length} a libro`);
console.log(`impronta delle funzioni ESPORTATE (quelle che l'obiettivo riusa): ${IMPRONTA}`);
console.log(`costo coppia a ${OFFSET_C}¢ = ${coppiaA(OFFSET_C)}  (indipendente dal mid, per costruzione)\n`);

console.log('═══ ③ LA STIMA: fattore d\'errore di :269 — i 4 MERCATI A LIBRO ═══');
console.log('mercato                                       mid     size VECCHIA  size NUOVA   fattore');
for (const r of righe.filter((x) => x.aLibro)) {
  console.log(`${r.titolo.padEnd(43)} ${r.mid.toFixed(4).padStart(6)}  ${r.sizeVecchia.toFixed(1).padStart(12)}  ${r.sizeNuova.toFixed(1).padStart(10)}  ${String(r.fattore).padStart(7)}×`);
}
console.log('\n═══ ③-bis · gli AMMISSIBILI (i candidati che la selezione guarda) ═══');
for (const r of amm) {
  console.log(`  ${r.aLibro ? '◆' : ' '}${r.titolo.padEnd(43)} mid ${r.mid.toFixed(4)}  fattore ${String(r.fattore).padStart(7)}×`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ④ LA CLASSIFICA — si costruisce il netto con la funzione VERA dell'obiettivo e si ordina con
//    `ordinaCandidati`, la funzione VERA della selezione. `realisticEstimate` non entra: e' il punto.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const perId = new Map(MER.map((m) => [String(m.conditionId).toLowerCase(), m]));
const netto = {};
for (const r of amm) {
  // profondita' concorrente in SHARE: `limDepth` di net.js e' in share; qui si usa la profondita'
  // in dollari del board convertita al mid — approssimazione DICHIARATA, uguale nei due mondi,
  // quindi non puo' spostare il confronto.
  const qShares = fin(r.depth) && r.mid > 0 ? r.depth / clampPrice(r.mid) : null;
  if (qShares == null) continue;
  const q = quotaObiettivo(qShares, r.mid, CAPITALE_RIGA, r.minSize, OFFSET_C);
  if (q != null) netto[r.id] = q * r.pool;
}
const righeBoard = amm.map((r) => perId.get(r.id));
const ordinati = SEL.ordinaCandidati(righeBoard, netto).map((x) => String(x.question || '').slice(0, 42));
console.log('\n═══ ④ CLASSIFICA con il netto dell\'OBIETTIVO (identica nei due mondi per costruzione) ═══');
ordinati.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}  ${LIBRO.has(String((righeBoard.find((b) => String(b.question || '').slice(0, 42) === t) || {}).conditionId || '').toLowerCase()) ? '◆' : ' '}${t}   netto $${(netto[String((righeBoard.find((b) => String(b.question || '').slice(0, 42) === t) || {}).conditionId || '').toLowerCase()] ?? 0).toFixed(4)}/g`));

fs.writeFileSync(path.join(RADICE, 'data', 'ricerca', 'd2-simulazione-a-secco.json'),
  JSON.stringify({ generatoIl: new Date().toISOString(), improntaEsportate: IMPRONTA, capitaleRiga: CAPITALE_RIGA,
    offsetC: OFFSET_C, coppia: coppiaA(OFFSET_C), righe, classifica: ordinati, netto }, null, 1));
console.log('\nscritto data/ricerca/d2-simulazione-a-secco.json');

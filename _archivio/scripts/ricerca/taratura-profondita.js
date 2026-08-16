#!/usr/bin/env node
'use strict';
// TARATURA DEL FILTRO DI PROFONDITÀ — SOLA LETTURA, NESSUNA MODIFICA.
//
// Risponde a B2/B3/B4/B5 del 13 agosto 2026. Non tocca `profondita-minima.js`, non cambia `q`, non
// scrive niente fuori da `data/ricerca/`.
//
// ─── LA MECCANICA, IN UNA RIGA ──────────────────────────────────────────────────────────────────────
// `scalaProfondita` esclude un mercato quando NESSUNA size piazzabile resta entro la quota `q`:
//     S_max = depth · q/(1−q)          escluso  ⟺  minSize_venue > S_max  ⟺  depth < minSize·(1−q)/q
// Il capitale del conto NON compare: la soglia è una proprietà del BOOK e del minimo del VENUE.
//
// ⚠ CONSEGUENZA CHE ROVESCIA L'INTUIZIONE: q/(1−q) è CRESCENTE in q, quindi ABBASSARE q STRINGE il
//   filtro. q=0,60 è già il più permissivo dei cinque valori richiesti. Per ammettere più mercati si
//   deve ALZARE q. La tabella qui sotto copre entrambe le direzioni per rendere il fatto visibile.
//
// ─── PERCHÉ SI RICOSTRUISCE INVECE DI LEGGERE UN GIORNALE ───────────────────────────────────────────
// §5.2 p.10: i candidati SCARTATI non sono persistiti da nessuna parte — `realloc-ultimo-piano.json`
// tiene solo i vincitori, e l'esclusione vive in un processo figlio. Quindi il dettaglio per mercato
// NON è nei log e non lo si può leggere: si RICALCOLA, con la stessa aritmetica del modulo vero, sui
// due ingressi veri (board di agent24, campioni websocket di agent34). È una misura, non una stima.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BOARD = path.join(ROOT, 'data', 'liquidity-rewards.json');
const OUT_DIR = path.join(ROOT, 'data', 'ricerca');
const FINESTRA_MIN = Number(process.env.FINESTRA_MIN || 60);

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
function mediana(a) {
  const v = a.filter(fin).sort((x, y) => x - y);
  if (!v.length) return null;
  const i = (v.length - 1) / 2;
  return v.length % 2 ? v[i] : (v[Math.floor(i)] + v[Math.ceil(i)]) / 2;
}
function q(a, p) {
  const v = a.filter(fin).sort((x, y) => x - y);
  if (!v.length) return null;
  const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo);
}

// ── 1 · IL BOARD ────────────────────────────────────────────────────────────────────────────────────
const board = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
const mercati = board.markets || [];
const soppressi = board.suppressedThinDepthMarkets || [];

// ── 2 · LA PROFONDITÀ MISURATA, DAI CAMPIONI WEBSOCKET DI agent34 ───────────────────────────────────
// Stessa formula di `allocator.marketMeta`: mediana di min(bidDepthInBand, askDepthInBand) sui soli
// campioni `src === 'ws'`. Un campione con una delle due profondità illeggibile NON contribuisce —
// non diventa zero (§5.3, `Number(null) === 0`).
const giorno = new Date().toISOString().slice(0, 10);
const MID = path.join(ROOT, 'data', `mid-history-${giorno}.jsonl`);
const tagliaMs = Date.now() - FINESTRA_MIN * 60_000;
const campioni = new Map();   // conditionId -> number[]

{
  const st = fs.statSync(MID);
  // Si legge solo la coda: 60 minuti su un file giornaliero da ~90 MB sono pochi MB.
  const START = Math.max(0, st.size - 24 * 1024 * 1024);
  const fd = fs.openSync(MID, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  let rest = '', pos = START;
  while (pos < st.size) {
    const r = fs.readSync(fd, buf, 0, buf.length, pos); pos += r;
    const linee = (rest + buf.slice(0, r).toString('utf8')).split('\n');
    rest = linee.pop();
    for (const l of linee) {
      if (!l || l.indexOf('"src":"ws"') < 0) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      const t = Date.parse(j.ts);
      if (!Number.isFinite(t) || t < tagliaMs) continue;
      if (!fin(j.bidDepthInBand) || !fin(j.askDepthInBand)) continue;
      const k = String(j.marketId || '').toLowerCase();
      if (!k) continue;
      if (!campioni.has(k)) campioni.set(k, []);
      campioni.get(k).push(Math.min(j.bidDepthInBand, j.askDepthInBand));
    }
  }
  fs.closeSync(fd);
}

// ── 3 · IL VERDETTO, PER MERCATO E PER q ────────────────────────────────────────────────────────────
const Q_LISTA = [0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.75, 0.80, 0.90];
const sMax = (depth, qq) => depth * qq / (1 - qq);

const righe = mercati.map((m) => {
  const cid = String(m.conditionId || '').toLowerCase();
  const camp = campioni.get(cid) || [];
  const depth = mediana(camp);
  const minSize = fin(m.rewardsMinSize) ? m.rewardsMinSize : null;
  const lordo = fin(m.rewardsDailyRate) ? m.rewardsDailyRate : null;
  return {
    cid, cid10: cid.slice(0, 10), question: m.question, minSize, lordoGiornoUsd: lordo,
    depthShares: depth, nCampioni: camp.length,
    sane500: m.sane500 === true,
    thinFlag: !!(m.levels && m.levels['500'] && m.levels['500'].thinBookFlag),
    quota500: m.levels && m.levels['500'] ? m.levels['500'].share : null,
    scadenzaAmmissibile: m.scadenzaAmmissibile,
  };
});

function verdetto(r, qq) {
  if (!fin(r.depthShares)) return 'ignota';       // regola cardinale: non misurato ⇒ non esclude
  if (!fin(r.minSize)) return 'ignota';
  return r.minSize > sMax(r.depthShares, qq) ? 'escluso' : 'ammesso';
}

// ── 4 · LA TABELLA DI SENSIBILITÀ ───────────────────────────────────────────────────────────────────
const TETTO_MERCATO = 32.67;      // §4.2, derivato — qui usato SOLO per contare, non per decidere
const CAPITALE_LIBERO = 501.60;   // misurato 13/08 18:57Z, saldo − ordini a riposo
const misurabili = righe.filter((r) => fin(r.depthShares) && fin(r.minSize));

const sensibilita = Q_LISTA.map((qq) => {
  const amm = misurabili.filter((r) => verdetto(r, qq) === 'ammesso');
  const esc = misurabili.filter((r) => verdetto(r, qq) === 'escluso');
  const schierabile = Math.min(CAPITALE_LIBERO, amm.length * TETTO_MERCATO);
  return {
    q: qq,
    ammessi: amm.length,
    esclusi: esc.length,
    minimiPerCoprire: Math.ceil(CAPITALE_LIBERO / TETTO_MERCATO),
    capitaleSchierabileUsd: +schierabile.toFixed(2),
    coperturaPct: +(100 * schierabile / CAPITALE_LIBERO).toFixed(1),
    lordoAmmessoUsdGiorno: +amm.reduce((a, r) => a + (r.lordoGiornoUsd || 0), 0).toFixed(2),
    lordoEsclusoUsdGiorno: +esc.reduce((a, r) => a + (r.lordoGiornoUsd || 0), 0).toFixed(2),
    // Il rischio, MISURATO e non ipotizzato: quanto sopra la quota del 60% finirebbero gli ammessi.
    quotaMedianaAmmessi: (() => {
      const v = amm.map((r) => (fin(r.depthShares) && fin(r.minSize)) ? r.minSize / (r.minSize + r.depthShares) : null);
      const mm = mediana(v); return mm == null ? null : +mm.toFixed(3);
    })(),
    ammessiSopra60: amm.filter((r) => r.minSize / (r.minSize + r.depthShares) > 0.60).length,
    ammessiSopra90: amm.filter((r) => r.minSize / (r.minSize + r.depthShares) > 0.90).length,
  };
});

// ── 5 · I MERCATI ESCLUSI A q=0,60, ORDINATI PER LORDO PERSO (B2) ───────────────────────────────────
const esclusi60 = misurabili
  .filter((r) => verdetto(r, 0.60) === 'escluso')
  .map((r) => ({
    ...r,
    sogliaDepthRichiesta: +(r.minSize * (1 - 0.60) / 0.60).toFixed(2),
    sMaxShares: +sMax(r.depthShares, 0.60).toFixed(2),
    mancaShares: +(r.minSize - sMax(r.depthShares, 0.60)).toFixed(2),
    mancaDepthShares: +(r.minSize * (1 - 0.60) / 0.60 - r.depthShares).toFixed(2),
    quotaSeEntrasse: +(r.minSize / (r.minSize + r.depthShares)).toFixed(3),
  }))
  .sort((a, b) => (b.lordoGiornoUsd || 0) - (a.lordoGiornoUsd || 0));

const ammessi60 = misurabili.filter((r) => verdetto(r, 0.60) === 'ammesso');

// ── 6 · SCRITTURA ───────────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const dati = {
  generatoAt: new Date().toISOString(),
  finestraCampioniMin: FINESTRA_MIN,
  boardGeneratoAt: board.meta && board.meta.generatedAt,
  boardDepthFloorUsd: board.meta && board.meta.depthFloorUsd,
  rewardMarketsFound: board.meta && board.meta.rewardMarketsFound,
  scannedBeforeFloor: board.meta && board.meta.scannedBeforeFloor,
  mercatiNelBoard: mercati.length,
  soppressiDaAgent24: soppressi.length,
  conProfonditaMisurata: misurabili.length,
  senzaProfondita: righe.length - misurabili.length,
  capitaleLiberoUsd: CAPITALE_LIBERO,
  tettoPerMercatoUsd: TETTO_MERCATO,
  sensibilita, esclusi60, ammessi60, righe,
};
fs.writeFileSync(path.join(OUT_DIR, 'taratura-profondita.json'), JSON.stringify(dati, null, 2));

// ── 7 · IL REFERTO A SCHERMO ────────────────────────────────────────────────────────────────────────
console.log('\n══ INGRESSI');
console.log('  board generato        ', dati.boardGeneratoAt);
console.log('  mercati premiati visti', dati.rewardMarketsFound, '→ processati', dati.scannedBeforeFloor,
  '→ soppressi da agent24 (depthFloor $' + dati.boardDepthFloorUsd + ')', dati.soppressiDaAgent24,
  '→ sul board', dati.mercatiNelBoard);
console.log('  profondità ws misurata su', misurabili.length, 'mercati · non misurata su', dati.senzaProfondita,
  `(finestra ${FINESTRA_MIN} min)`);
console.log('  capitale libero $' + CAPITALE_LIBERO, '· tetto per mercato $' + TETTO_MERCATO,
  '⇒ minimi per coprire', Math.ceil(CAPITALE_LIBERO / TETTO_MERCATO));

console.log('\n══ B4 · SENSIBILITÀ A q  (⚠ q PIÙ BASSO = FILTRO PIÙ STRETTO)');
console.log('  q     amm  escl   S_max/minSize   capitale schierabile   copertura   lordo ammesso/g   lordo escluso/g   quota mediana amm.   amm>60%  amm>90%');
for (const s of sensibilita) {
  const rapporto = (s.q / (1 - s.q)).toFixed(2) + '×';
  console.log('  ' + String(s.q.toFixed(2)).padEnd(5)
    + String(s.ammessi).padStart(4) + String(s.esclusi).padStart(6)
    + rapporto.padStart(14)
    + ('$' + s.capitaleSchierabileUsd.toFixed(2)).padStart(22)
    + (s.coperturaPct + '%').padStart(12)
    + ('$' + s.lordoAmmessoUsdGiorno.toFixed(0)).padStart(18)
    + ('$' + s.lordoEsclusoUsdGiorno.toFixed(0)).padStart(18)
    + String(s.quotaMedianaAmmessi).padStart(21)
    + String(s.ammessiSopra60).padStart(9) + String(s.ammessiSopra90).padStart(9));
}

console.log('\n══ B2 · ESCLUSI A q=0,60, PER LORDO PERSO  (' + esclusi60.length + ' mercati)');
console.log('  lordo/g  minSize  depth  S_max  manca(share)  depth richiesta  quota se entrasse  mercato');
for (const r of esclusi60.slice(0, 40)) {
  console.log('  ' + ('$' + (r.lordoGiornoUsd || 0)).padStart(8)
    + String(r.minSize).padStart(9)
    + String(r.depthShares.toFixed(1)).padStart(7)
    + String(r.sMaxShares.toFixed(1)).padStart(7)
    + String(r.mancaShares.toFixed(1)).padStart(14)
    + String(r.sogliaDepthRichiesta.toFixed(1)).padStart(17)
    + String((r.quotaSeEntrasse * 100).toFixed(0) + '%').padStart(19)
    + '  ' + String(r.question || '').slice(0, 52));
}
if (esclusi60.length > 40) console.log('  … altri ' + (esclusi60.length - 40) + ' in data/ricerca/taratura-profondita.json');

console.log('\n  TOTALE lordo escluso a q=0,60: $' + esclusi60.reduce((a, r) => a + (r.lordoGiornoUsd || 0), 0).toFixed(2) + '/giorno');
console.log('  distribuzione del lordo escluso: mediana $' + (mediana(esclusi60.map((r) => r.lordoGiornoUsd)) || 0).toFixed(2)
  + ' · q75 $' + (q(esclusi60.map((r) => r.lordoGiornoUsd), 0.75) || 0).toFixed(2)
  + ' · max $' + Math.max(0, ...esclusi60.map((r) => r.lordoGiornoUsd || 0)).toFixed(2));
console.log('  ⚠ il lordo è il MONTEPREMI DEL MERCATO, non ciò che incasseremmo: la nostra quota va moltiplicata.');

// ── 8 · L'IMBUTO COMPLETO — chi taglia DAVVERO, in ordine ───────────────────────────────────────────
// La sensibilità qui sopra gira su TUTTI i mercati con profondità misurata, e mostra 88 superstiti a
// q=0,60 contro i 16 minimi: il filtro di profondità, DA SOLO, non affama niente. Ma un mercato deve
// prima essere FINANZIABILE — `pavimentoPremiante(minSize) ≤ tetto per mercato` — e quel cancello è
// molto più stretto. Si conta l'imbuto nell'ordine in cui morde.
const { pavimentoPremiante, capPerMarketUsd } = require(path.join(ROOT, 'lib', 'rewards', 'concentration'));
const TETTO = capPerMarketUsd(644.36);
const finanziabile = (r) => fin(r.minSize) && pavimentoPremiante(r.minSize) <= TETTO;
const orizzonteOk = (r) => r.scadenzaAmmissibile !== false;

const F = {
  board: mercati.length,
  conProfondita: misurabili.length,
  finanziabili: misurabili.filter(finanziabile).length,
  finanziabiliOrizzonte: misurabili.filter((r) => finanziabile(r) && orizzonteOk(r)).length,
  finanziabiliOrizzonteDepth: misurabili.filter((r) => finanziabile(r) && orizzonteOk(r) && verdetto(r, 0.60) === 'ammesso').length,
};
console.log('\n══ L\'IMBUTO, IN ORDINE DI MORSO  (capitale $644,36 ⇒ tetto per mercato $' + TETTO + ')');
console.log('  mercati sul board                                   ', String(F.board).padStart(4));
console.log('  · con profondità websocket misurata                 ', String(F.conProfondita).padStart(4));
console.log('  · FINANZIABILI (pavimentoPremiante ≤ tetto)         ', String(F.finanziabili).padStart(4),
  ' ← taglia ' + (F.conProfondita - F.finanziabili));
console.log('  · e con scadenza ammissibile                        ', String(F.finanziabiliOrizzonte).padStart(4),
  ' ← taglia ' + (F.finanziabili - F.finanziabiliOrizzonte));
console.log('  · e che passano il filtro di profondità (q=0,60)    ', String(F.finanziabiliOrizzonteDepth).padStart(4),
  ' ← taglia ' + (F.finanziabiliOrizzonte - F.finanziabiliOrizzonteDepth));
console.log('  minimi per coprire il capitale                      ', String(Math.ceil(CAPITALE_LIBERO / TETTO_MERCATO)).padStart(4));

console.log('\n  ─ il pavimento premiante contro il tetto, per scaglione ─');
for (const ms of [20, 50, 100, 200]) {
  const n = misurabili.filter((r) => r.minSize === ms).length;
  const pav = pavimentoPremiante(ms);
  console.log(`    minSize ${String(ms).padStart(4)} ⇒ pavimento $${String(pav.toFixed(2)).padStart(7)} contro tetto $${TETTO.toFixed(2)}  ⇒ ${pav <= TETTO ? 'FINANZIABILE' : 'mai finanziabile'}   (${n} mercati)`);
}

console.log('\n══ B4-bis · SENSIBILITÀ A q SUI SOLI MERCATI FINANZIABILI  ← è questa che conta');
console.log('  q     ammessi  esclusi   lordo ammesso/g   lordo escluso/g');
const base = misurabili.filter((r) => finanziabile(r) && orizzonteOk(r));
const sensFin = Q_LISTA.map((qq) => {
  const amm = base.filter((r) => verdetto(r, qq) === 'ammesso');
  const esc = base.filter((r) => verdetto(r, qq) === 'escluso');
  return { q: qq, ammessi: amm.length, esclusi: esc.length,
    lordoAmm: +amm.reduce((a, r) => a + (r.lordoGiornoUsd || 0), 0).toFixed(0),
    lordoEsc: +esc.reduce((a, r) => a + (r.lordoGiornoUsd || 0), 0).toFixed(0) };
});
for (const s of sensFin) {
  console.log('  ' + s.q.toFixed(2).padEnd(6) + String(s.ammessi).padStart(7) + String(s.esclusi).padStart(9)
    + ('$' + s.lordoAmm).padStart(18) + ('$' + s.lordoEsc).padStart(18));
}
dati.imbuto = F; dati.sensibilitaFinanziabili = sensFin; dati.tettoPerMercatoUsd = TETTO;
fs.writeFileSync(path.join(OUT_DIR, 'taratura-profondita.json'), JSON.stringify(dati, null, 2));

console.log('\n══ B5 · LA SOGLIA DIPENDE DAL CAPITALE?');
console.log('  NO. escluso ⟺ minSize_venue > depth · q/(1−q). Né il capitale del conto né il tetto per');
console.log('  mercato compaiono nella condizione. A q=0,60 serve depth ≥ minSize×0,667:');
for (const ms of [20, 50, 100, 200, 1000]) {
  const n = misurabili.filter((r) => r.minSize === ms).length;
  console.log(`    minSize ${String(ms).padStart(4)} ⇒ depth richiesta ${String((ms * 0.667).toFixed(1)).padStart(7)} share   (${n} mercati sul board)`);
}

console.log('\n  ─ distribuzione della profondità misurata, per scaglione di minSize ─');
for (const ms of [20, 50, 100, 200, 1000]) {
  const g = misurabili.filter((r) => r.minSize === ms).map((r) => r.depthShares);
  if (!g.length) continue;
  console.log(`    minSize ${String(ms).padStart(4)}  n=${String(g.length).padStart(3)}  depth: q25 ${String((q(g, .25) || 0).toFixed(1)).padStart(7)}  mediana ${String((mediana(g) || 0).toFixed(1)).padStart(7)}  q75 ${String((q(g, .75) || 0).toFixed(1)).padStart(7)}  max ${String(Math.max(...g).toFixed(1)).padStart(8)}`);
}
console.log('\nscritto: data/ricerca/taratura-profondita.json');

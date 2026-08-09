'use strict';
// lib/rewards/cancello-profondita.test.js — IL CANCELLO SULLA PROFONDITÀ, PROVATO DOVE DECIDE.
//
// Non prova che la funzione pura risponda giusto — quello lo fa `profondita-minima.selfcheck()`.
// Prova le tre cose che solo il CABLAGGIO può sbagliare:
//   1. che il mercato sottile sia tolto dal set passato al knapsack, non solo attenuato;
//   2. che l'attenuazione resti viva per chi supera il cancello (requisito 2 del lavoro);
//   3. che il cancello non possa affamare il piano — il rapporto superstiti/minimi necessari.
//
// Esegue `planAllocation` VERO su curve costruite a mano: nessuna rete, nessun giornale, nessun file.

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const { verdettoProfondita, esclude, MAX_QUOTA_CREDIBILE, CAPITALE_RIFERIMENTO_USD_DEFAULT } = require('./profondita-minima');
const { DEFAULTS } = require('./realistic-estimate');

let n = 0;
const ok = (name, cond, extra) => {
  assert.ok(cond, 'FAIL: ' + name + (extra ? ' — ' + extra : ''));
  console.log('  ✓ ' + name); n++;
};

// ── un giornale finto: N campioni con la profondità in banda voluta ────────────────────────────────
function righe(marketId, { depth, mid = 0.5, tick = 0.01, nPunti = 40 }) {
  const t0 = Date.now() - 6 * 3600_000;
  const out = [];
  for (let i = 0; i < nPunti; i++) {
    out.push({
      marketId, tsMs: t0 + i * 60_000, src: 'ws', adjMid: mid, tick,
      bidDepthInBand: depth, askDepthInBand: depth,
      tokenIdYes: 'tok-' + marketId, bids: [], asks: [],
    });
  }
  return out;
}

console.log('\n── 1 · IL PREDICATO È LO STESSO DELL\'ATTENUAZIONE ────────────────────────────────');
ok('la soglia del cancello È la costante dell\'attenuazione, non una copia',
  MAX_QUOTA_CREDIBILE === DEFAULTS.maxCredibleShare && MAX_QUOTA_CREDIBILE === 0.60);
ok('il capitale di riferimento è $500 — lo stesso di levels["500"] del board',
  CAPITALE_RIFERIMENTO_USD_DEFAULT === 500);
{
  // la stessa coppia (size, cQ) deve dare `capped` nell'attenuazione e `sottile` nel cancello
  const { credibleShareFactor } = require('./realistic-estimate');
  const sharePerUsd = 2, cQ = 300;                       // a $500 → 1000 share contro 300 → 76,9%
  const att = credibleShareFactor(sharePerUsd * 500, cQ);
  const gate = verdettoProfondita({ sharePerUsd, depthShares: cQ });
  ok('attenuazione dice CAPATA e cancello dice SOTTILE sulla stessa coppia',
    att.capped === true && gate.stato === 'sottile', `att=${att.capped} gate=${gate.stato}`);
  const cQok = 5000;                                     // a $500 → 1000 contro 5000 → 16,7%
  const att2 = credibleShareFactor(sharePerUsd * 500, cQok);
  const gate2 = verdettoProfondita({ sharePerUsd, depthShares: cQok });
  ok('  e su un book vero nessuno dei due morde',
    att2.capped === false && gate2.stato === 'ok');
}

console.log('\n── 2 · IL CANCELLO TOGLIE DAL SET, NON ATTENUA SOLTANTO ──────────────────────────');
{
  // Ricarico l'allocatore pulito: il modulo tiene stato di cache in scope, meglio non condividerlo.
  delete require.cache[require.resolve('./allocator')];
  const { planAllocation } = require('./allocator');

  const SOTTILE = '0x' + 'a'.repeat(64);
  const SPESSO = '0x' + 'b'.repeat(64);
  const byMarket = new Map([
    [SOTTILE, righe(SOTTILE, { depth: 5 })],       // deserto: quota ~100%
    [SPESSO, righe(SPESSO, { depth: 40_000 })],    // book vero: quota ~2%
  ]);
  const marketTokens = new Map([[SOTTILE, 'tok-' + SOTTILE], [SPESSO, 'tok-' + SPESSO]]);
  const potByCond = new Map([[SOTTILE, 900], [SPESSO, 120]]);   // il sottile paga MOLTO di più
  const maxSpreadByMarket = new Map([[SOTTILE, 4.5], [SPESSO, 4.5]]);
  const comuni = {
    byMarket, marketTokens, tapeByToken: new Map(), potByCond,
    budgetUsd: 400, unitUsd: 20, maxSpreadByMarket, horizonFilter: false,
  };

  const spento = planAllocation({ ...comuni, filtroProfondita: false });
  const acceso = planAllocation({ ...comuni, filtroProfondita: true });

  const scelti = (p) => (p.candidates || []).filter((c) => c.status === 'scelto').map((c) => c.marketId);
  const codice = (p, mid) => ((p.candidates || []).find((c) => c.marketId === mid) || {}).reasonCode || null;

  ok('a cancello SPENTO il mercato sottile entra nel piano (è il difetto che si sta correggendo)',
    scelti(spento).includes(SOTTILE), JSON.stringify(scelti(spento)));
  ok('a cancello ACCESO il mercato sottile NON entra',
    !scelti(acceso).includes(SOTTILE), JSON.stringify(scelti(acceso)));
  ok('  e il motivo dichiarato è `profondita-sottile`, non un motivo generico',
    codice(acceso, SOTTILE) === 'profondita-sottile', String(codice(acceso, SOTTILE)));
  ok('  il motivo NOMINA la quota misurata e la soglia', (() => {
    const c = (acceso.candidates || []).find((x) => x.marketId === SOTTILE);
    return c && /%/.test(c.reason) && /60%/.test(c.reason);
  })());
  // E QUESTA È LA DIMOSTRAZIONE PIÙ FORTE DEL DIFETTO, trovata scrivendo il test invece che
  // ipotizzandola: a cancello spento il mercato sottile non si limita a entrare — si prende TUTTO il
  // budget e lascia a zero quello con il book vero, perché la sua quota apparente al 99% batte
  // qualunque cosa. L'attenuazione a 0,60 non basta a impedirlo: taglia il numero, non la scelta.
  ok('a cancello SPENTO il sottile SOTTRAE il capitale al mercato con book vero',
    !scelti(spento).includes(SPESSO), JSON.stringify(scelti(spento)));
  ok('a cancello ACCESO il capitale va al mercato con book vero',
    scelti(acceso).includes(SPESSO), JSON.stringify(scelti(acceso)));
  ok('la quota misurata viaggia su OGNI candidato, anche sugli scartati', (() => {
    const c = (acceso.candidates || []).find((x) => x.marketId === SOTTILE);
    return c && typeof c.quotaRiferimento === 'number' && c.quotaRiferimento > 0.60;
  })());

  console.log('\n── 3 · IL RENDICONTO DEL CANCELLO ────────────────────────────────────────────────');
  ok('il piano dichiara il filtro, la soglia e l\'elenco degli esclusi',
    acceso.filtroProfondita === true && acceso.profonditaSoglia === 0.60
    && Array.isArray(acceso.profonditaSottile) && acceso.profonditaSottile.includes(SOTTILE));
  ok('dichiara il REWARD APPARENTE che gli esclusi rappresentavano (> 0)',
    acceso.profonditaSottileLordoApparenteUsd > 0, String(acceso.profonditaSottileLordoApparenteUsd));
  ok('  e il montepremi pubblicato dal venue su quegli stessi mercati',
    acceso.profonditaSottilePotTotaleUsd === 900, String(acceso.profonditaSottilePotTotaleUsd));
  ok('dichiara la quota mediana degli esclusi', acceso.profonditaSottileQuotaMediana > 0.60);
  ok('dichiara superstiti e minimi necessari — il rapporto che rende il cancello sicuro',
    acceso.profonditaSuperstiti >= 1 && acceso.profonditaMinimiPerCoprire >= 1);
  ok('a cancello SPENTO il rendiconto è vuoto e non finto',
    spento.filtroProfondita === false && spento.profonditaSottile.length === 0
    && spento.profonditaSottileLordoApparenteUsd === 0);

  console.log('\n── 4 · L\'ATTENUAZIONE RESTA VIVA PER CHI SUPERA IL CANCELLO ──────────────────────');
  ok('il tetto di credibilità è ancora acceso nel piano col cancello attivo',
    acceso.useCredibleShareCap === true && acceso.maxCredibleShare === 0.60);
  ok('  e la riga del superstite porta ancora i campi dell\'attenuazione', (() => {
    const r = (acceso.rows || []).find((x) => x.marketId === SPESSO);
    return r && Object.prototype.hasOwnProperty.call(r, 'fattoreCredibilita')
      && Object.prototype.hasOwnProperty.call(r, 'quotaCeiling')
      && Object.prototype.hasOwnProperty.call(r, 'quotaCapata');
  })());
  ok('  su un book vero l\'attenuazione NON morde: fattore esattamente 1, non «quasi 1»', (() => {
    const r = (acceso.rows || []).find((x) => x.marketId === SPESSO);
    return r && r.quotaCapata === false && (r.fattoreCredibilita === 1 || r.fattoreCredibilita === null);
  })());
}

console.log('\n── 5 · «NON LO SO» NON ESCLUDE MAI ───────────────────────────────────────────────');
{
  delete require.cache[require.resolve('./allocator')];
  const { planAllocation } = require('./allocator');
  const IGNOTO = '0x' + 'c'.repeat(64);
  const SPESSO = '0x' + 'd'.repeat(64);
  // profondità mai misurata: bid/askDepthInBand assenti ⇒ marketMeta().depthShares === null
  const senzaProf = righe(IGNOTO, { depth: 1000 }).map((r) => ({ ...r, bidDepthInBand: null, askDepthInBand: null }));
  const byMarket = new Map([[IGNOTO, senzaProf], [SPESSO, righe(SPESSO, { depth: 40_000 })]]);
  const p = planAllocation({
    byMarket, marketTokens: new Map([[IGNOTO, 'tok-' + IGNOTO], [SPESSO, 'tok-' + SPESSO]]),
    tapeByToken: new Map(), potByCond: new Map([[IGNOTO, 300], [SPESSO, 120]]),
    budgetUsd: 400, unitUsd: 20,
    maxSpreadByMarket: new Map([[IGNOTO, 4.5], [SPESSO, 4.5]]),
    horizonFilter: false, filtroProfondita: true,
  });
  ok('profondità non misurata ⇒ il cancello NON lo tocca',
    !p.profonditaSottile.includes(IGNOTO), JSON.stringify(p.profonditaSottile));
  const c = (p.candidates || []).find((x) => x.marketId === IGNOTO);
  ok('  e se viene scartato è per un altro motivo, mai `profondita-sottile`',
    !c || c.reasonCode !== 'profondita-sottile', c ? String(c.reasonCode) : 'assente');
}

console.log('\n── 6 · IL CANCELLO NON AFFAMA IL PIANO ───────────────────────────────────────────');
{
  delete require.cache[require.resolve('./allocator')];
  const { planAllocation } = require('./allocator');
  // dieci mercati con book vero: il cancello non deve toglierne nessuno, e il piano deve coprire
  const byMarket = new Map(), marketTokens = new Map(), potByCond = new Map(), maxSpreadByMarket = new Map();
  for (let i = 0; i < 10; i++) {
    const id = '0x' + String(i).repeat(64).slice(0, 64);
    byMarket.set(id, righe(id, { depth: 30_000 + i * 100 }));
    marketTokens.set(id, 'tok-' + id); potByCond.set(id, 150 - i); maxSpreadByMarket.set(id, 4.5);
  }
  const p = planAllocation({
    byMarket, marketTokens, tapeByToken: new Map(), potByCond,
    budgetUsd: 600, unitUsd: 12, maxPerMarketUsd: 120,
    maxSpreadByMarket, horizonFilter: false, filtroProfondita: true,
  });
  ok('su dieci book veri il cancello non toglie nessuno', p.profonditaSottile.length === 0);
  ok('  i superstiti restano ≥ dei minimi necessari a coprire il capitale',
    p.profonditaSuperstiti >= p.profonditaMinimiPerCoprire,
    `${p.profonditaSuperstiti} vs ${p.profonditaMinimiPerCoprire}`);
  ok('  e il conto dei minimi è ceil(budget / tetto per mercato)',
    p.profonditaMinimiPerCoprire === Math.ceil(600 / 120));
}

console.log('\n── 7 · NESSUN ALTRO PRESIDIO È STATO TOCCATO ─────────────────────────────────────');
{
  const fs = require('fs');
  const src = fs.readFileSync(path.join(REPO, 'lib', 'rewards', 'allocator.js'), 'utf8');
  ok('il tetto di concentrazione non è nominato dal cancello', !/filtroProfondita[^\n]*maxPerMarket/i.test(src));
  ok('`useCredibleShareCap` è ancora acceso di difetto', /useCredibleShareCap = true/.test(src));
  ok('`usaProfonditaVerificata` è ancora acceso di difetto', /usaProfonditaVerificata = true/.test(src));
  ok('il filtro orizzonte è ancora SPENTO di difetto (lo accende chi piazza)', /horizonFilter = false/.test(src));
  ok('il cancello NON tocca `allocateBudget` — i backtest restano invariati',
    !/allocateBudget\([^)]*filtroProfondita/s.test(src));
  const modProf = fs.readFileSync(path.join(REPO, 'lib', 'rewards', 'profondita-minima.js'), 'utf8');
  ok('il modulo della soglia NON ridichiara 0.60 come numero letterale',
    !/=\s*0\.60?\s*;/.test(modProf.replace(/MAX_QUOTA_CREDIBILE = DEFAULTS[^\n]*\n/, '')));
  ok('nessun modulo di lib/maker nomina il cancello (non tocca il piazzamento)', (() => {
    const dir = path.join(REPO, 'lib', 'maker');
    return !fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
      .some((f) => /filtroProfondita|profondita-minima/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  })());
}

console.log('\ncancello-profondita: ' + n + ' assertions passed\n');

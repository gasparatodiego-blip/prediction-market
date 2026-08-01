#!/usr/bin/env node
'use strict';
// Selfcheck for the FILL STRATEGY — the six scenarios the brief names, plus the config discipline.
// Plain node, no framework, matching the other lib/*.test.js files. Deterministic: no venue, no network,
// no clock (every side effect is injected). Run: node lib/maker/fill-strategy.test.js

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const FS = require('./fill-strategy');
const CFG = require('./fill-strategy-config');
const AC = require('./allocated-capital');

let n = 0;
const ok = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); console.log('  ✓ ' + name); n++; };
const near = (a, b, t = 1e-6) => a != null && b != null && Math.abs(a - b) <= t;

// A scratch dir so the durable stores are exercised for real without touching data/.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fillstrat-'));
const cfgDeps = {
  fillStrategyConfigFile: path.join(TMP, 'cfg.json'),
  fillStrategyAuditFile: path.join(TMP, 'audit.jsonl'),
  allocatedCapitalFile: path.join(TMP, 'cap.json'),
};

// ── Un mercato di prova: tick 0.01, banda 4¢ (raggio 2¢), size minima 5, mid 0.50. ──
const RULES = { tick: 0.01, minSize: 5, maxSpreadCents: 4, readable: true };
const MID = 0.50;
const P = { takeProfitCents: 0, stopLossPct: 4, maxSlippagePct: 2.5 };   // i default

console.log('\n── 1 · FILL SINGOLO → take-profit + ripiazzamento, ai prezzi attesi ──');
{
  // Entry: BUY 10 share a 0.49, cioè 1¢ SOTTO il mid 0.50.
  const d = FS.decideOnFill({
    marketId: '0xabc', book: 'yes',
    fills: [{ price: 0.49, size: 10 }],
    position: { size: 10 }, mid: MID, tick: RULES.tick, minSize: RULES.minSize, maxSpreadCents: RULES.maxSpreadCents,
    entryPrice: 0.49, entrySize: 10,
    capUsd: 100, params: P, markPrice: 0.50, bids: [{ price: 0.49, size: 500 }],
  });
  ok('take-profit specchiato: entry 0.49 a 1¢ dal mid → uscita a 0.51', near(d.takeProfit.price, 0.51));
  ok('  ed è una VENDITA del token in portafoglio, non un acquisto del lato opposto', d.takeProfit.side === 'SELL');
  ok('  della size che ha appena riempito (10 share)', near(d.takeProfit.size, 10));
  ok('  con guadagno dichiarato +2¢/share', near(d.takeProfit.gainCents, 2));
  ok('ripiazzamento: STESSO lato, STESSO prezzo 0.49, stessa size 10', d.replacement && d.replacement.side === 'BUY' && near(d.replacement.price, 0.49) && near(d.replacement.size, 10));
  ok('  non bloccato (sotto il tetto)', d.replacement.blocked === false && d.cap.allow === true);
  ok('  nessuno stop (nessun drawdown: mark 0.50 sopra il carico 0.49)', d.stop.trigger === false);
}
{
  // Take-profit FISSO, quando l'operatore lo imposta invece di specchiare.
  const t = FS.takeProfitPrice({ entryPrice: 0.49, mid: MID, tick: 0.01, takeProfitCents: 1 });
  ok('take-profit fisso a +1¢: 0.49 → 0.50', near(t.price, 0.50) && t.mode === 'fixed');
  // Arrotondamento IN SU, mai al più vicino: su tick 0.001 un target a 0.4952 non deve scendere a 0.495.
  const t2 = FS.takeProfitPrice({ entryPrice: 0.4902, mid: null, tick: 0.001, takeProfitCents: 0.5 });
  ok('arrotonda IN SU al tick (0.4952 → 0.496), mai al più vicino', near(t2.price, 0.496));
  const t3 = FS.takeProfitPrice({ entryPrice: 0.49, mid: 0.49, tick: 0.01, takeProfitCents: 0 });
  ok('entry non sotto il mid → niente da specchiare, uscita al primo tick sopra il carico', near(t3.price, 0.50));
  const t4 = FS.takeProfitPrice({ entryPrice: 0.49, mid: null, tick: null, takeProfitCents: 0 });
  ok('tick illeggibile → nessun prezzo inventato (null)', t4.price === null);
}

console.log('\n── 2 · FILL RIPETUTI FINO AL TETTO → il ripiazzamento si ferma ──');
{
  const cap = 100;   // il capitale allocato a questo mercato
  const step = (fills) => FS.decideOnFill({
    marketId: '0xabc', book: 'yes', fills,
    position: { size: fills.reduce((s, f) => s + f.size, 0) },
    mid: MID, tick: RULES.tick, minSize: RULES.minSize, maxSpreadCents: RULES.maxSpreadCents,
    entryPrice: 0.50, entrySize: 60, capUsd: cap, params: P, markPrice: 0.50, bids: [{ price: 0.50, size: 999 }],
  });
  // 1 fill: 60 share a 0.50 = $30 impegnati, il ripiazzo ne aggiungerebbe altri $30 → 60 ≤ 100 ✓
  const a = step([{ price: 0.50, size: 60 }]);
  ok('30 USD impegnati + 30 in arrivo su tetto 100 → ripiazza', a.cap.allow === true && a.replacement != null);
  // 2 fill: $60 impegnati, +30 = 90 ≤ 100 ✓
  const b = step([{ price: 0.50, size: 60 }, { price: 0.50, size: 60 }]);
  ok('60 + 30 su 100 → ripiazza ancora', b.cap.allow === true);
  // 3 fill: $90 impegnati, +30 = 120 > 100 ✗
  const c = step([{ price: 0.50, size: 60 }, { price: 0.50, size: 60 }, { price: 0.50, size: 60 }]);
  ok('90 + 30 supererebbe 100 → RIPIAZZAMENTO FERMATO', c.cap.allow === false && c.cap.gate === 'cap-reached' && c.replacement === null);
  ok('  ma il take-profit resta piazzato: si smette di comprare, non di uscire', c.takeProfit && c.takeProfit.price != null && c.takeProfit.blocked === false);
  ok('  e il motivo dice quanto resta', /restano|tetto raggiunto/.test(c.cap.reason));
  // Il tetto è PER LATO: lo stesso tetto vale su NO indipendentemente da YES.
  const capYes = FS.positionCapVerdict({ capUsd: 100, positionNotionalUsd: 95, incomingNotionalUsd: 30 });
  const capNo = FS.positionCapVerdict({ capUsd: 100, positionNotionalUsd: 0, incomingNotionalUsd: 30 });
  ok('il tetto è PER LATO: YES pieno non chiude NO', capYes.allow === false && capNo.allow === true);
}
{
  // FAIL CLOSED: tetto non leggibile ⇒ nessun ripiazzamento. Mai "non lo so" letto come "illimitato".
  const v = FS.positionCapVerdict({ capUsd: null, positionNotionalUsd: 10, incomingNotionalUsd: 1 });
  ok('tetto non leggibile → ripiazzamento RIFIUTATO (fail closed)', v.allow === false && v.gate === 'cap-unreadable');
  const v2 = FS.positionCapVerdict({ capUsd: 100, positionNotionalUsd: null, incomingNotionalUsd: 1 });
  ok('esposizione non leggibile → rifiutato (fail closed)', v2.allow === false && v2.gate === 'position-unreadable');
}

console.log('\n── 3 · DRAWDOWN 4% SU MEDIA PONDERATA con fill a prezzi diversi ──');
{
  // Tre fill: 100@0.60, 100@0.50, 200@0.40 → media ponderata = (60+50+80)/400 = 0.475
  const fills = [{ price: 0.60, size: 100 }, { price: 0.50, size: 100 }, { price: 0.40, size: 200 }];
  const w = FS.weightedAverageEntry(fills);
  ok('media ponderata di 100@0.60 + 100@0.50 + 200@0.40 = 0.475', near(w.avgPrice, 0.475));
  ok('  size totale 400, controvalore 190 USD', near(w.size, 400) && near(w.notionalUsd, 190));
  ok('  e NON è la media semplice (0.50) né l’ultimo fill (0.40)', !near(w.avgPrice, 0.50) && !near(w.avgPrice, 0.40));

  // Soglia 4% sulla media 0.475 → scatta a mark ≤ 0.456
  const justAbove = FS.decideStopLoss({ avgPrice: 0.475, markPrice: 0.4561, stopLossPct: 4 });
  const justBelow = FS.decideStopLoss({ avgPrice: 0.475, markPrice: 0.4559, stopLossPct: 4 });
  ok('mark 0.4561 → drawdown 3.98% → NON scatta', justAbove.trigger === false && justAbove.drawdownPct < 4);
  ok('mark 0.4559 → drawdown 4.02% → SCATTA', justBelow.trigger === true && justBelow.drawdownPct >= 4);
  ok('  esattamente in soglia (4.00%) scatta', FS.decideStopLoss({ avgPrice: 0.50, markPrice: 0.48, stopLossPct: 4 }).trigger === true);
  ok('  in guadagno non scatta mai', FS.decideStopLoss({ avgPrice: 0.475, markPrice: 0.60, stopLossPct: 4 }).trigger === false);
  ok('mark non leggibile → nessuno stop al buio', FS.decideStopLoss({ avgPrice: 0.475, markPrice: null, stopLossPct: 4 }).trigger === false);
  ok('carico non calcolabile → nessuno stop', FS.decideStopLoss({ avgPrice: null, markPrice: 0.40, stopLossPct: 4 }).trigger === false);

  // Lo stop ha la precedenza: niente ripiazzamento su un lato che stiamo chiudendo.
  const d = FS.decideOnFill({
    marketId: '0xabc', book: 'yes', fills,
    position: { size: 400 }, mid: 0.45, tick: RULES.tick, minSize: RULES.minSize, maxSpreadCents: RULES.maxSpreadCents,
    entryPrice: 0.45, entrySize: 10, capUsd: 10000, params: P, markPrice: 0.44,
    bids: [{ price: 0.44, size: 1000 }],
  });
  ok('stop attivo → nessun ripiazzamento e nessun take-profit nuovo', d.stop.trigger === true && d.replacement === null && d.takeProfit === null);
  ok('  e il gate lo dice', d.cap.gate === 'stop-loss');
}

console.log('\n── 4 · BOOK SOTTILE allo stop → protezione, non esecuzione alla cieca ──');
{
  // Vogliamo uscire da 1000 share. Best bid 0.50, budget slippage 2.5% → pavimento 0.4875.
  const thin = [
    { price: 0.50, size: 100 },
    { price: 0.49, size: 150 },   // sopra il pavimento
    { price: 0.40, size: 5000 },  // MOLTO sotto: fuori budget, non deve essere toccato
  ];
  const plan = FS.planStopLossExit({ size: 1000, bids: thin, tick: 0.01, maxSlippagePct: 2.5 });
  ok('pavimento = best bid 0.50 − 2.5% = 0.4875, arrotondato GIU al tick → 0.48', near(plan.floorPrice, 0.48));
  ok('esce PARZIALE per la sola profondità dentro il budget (100+150=250)', plan.action === 'partial' && near(plan.size, 250));
  ok('  il resto (750) è riportato, non abbandonato', near(plan.remainder, 750));
  ok('  con un LIMITE, mai un ordine a mercato', near(plan.limitPrice, 0.48));
  ok('  e il livello a 0.40 fuori budget NON viene toccato', plan.depthUsd < 250 * 0.5 + 1);
  ok('  il motivo spiega la scelta', /book sottile|si ritenta/.test(plan.reason));

  // Book profondo: nessun parziale.
  const deep = FS.planStopLossExit({ size: 100, bids: [{ price: 0.50, size: 9999 }], tick: 0.01, maxSlippagePct: 2.5 });
  ok('book profondo → uscita intera in una volta', deep.action === 'exit' && near(deep.size, 100) && deep.remainder === 0);

  // Book vuoto o illeggibile: NESSUN ordine.
  const empty = FS.planStopLossExit({ size: 100, bids: [], tick: 0.01, maxSlippagePct: 2.5 });
  ok('book vuoto/illeggibile → NESSUNA uscita al buio, si ritenta dopo', empty.action === 'none' && empty.size === 0 && near(empty.remainder, 100));

  // Tutta la profondità sotto il pavimento: niente da prendere entro il budget.
  const far = FS.planStopLossExit({ size: 100, bids: [{ price: 0.50, size: 1 }, { price: 0.20, size: 9999 }], tick: 0.01, maxSlippagePct: 2.5 });
  ok('profondità solo molto sotto il pavimento → prende solo quella dentro il budget', far.action === 'partial' && near(far.size, 1));
}

console.log('\n── 5 · INTERRUTTORE GLOBALE OFF DI DEFAULT ──');
{
  const st = CFG.readFillStrategyConfig(cfgDeps);
  ok('config assente → globale OFF', st.readable === true && st.globalEnabled === false);
  ok('  nessun mercato abilitato', st.enabledMarketIds.length === 0);
  const en = CFG.isFillStrategyEnabled('0xabc', cfgDeps);
  ok('  quindi nessun mercato è attivo', en.enabled === false);
  ok('  e il motivo dice che è il globale a decidere', /spenta globalmente/.test(en.reason));
}

console.log('\n── 6 · INTERRUTTORE PER MERCATO indipendente, stesso pattern di auto-reprice ──');
{
  // Mercato acceso, globale ancora spento → resta spento.
  CFG.setFillStrategy({ scope: 'market', marketId: '0xABC', enabled: true, by: 'test' }, cfgDeps);
  let en = CFG.isFillStrategyEnabled('0xabc', cfgDeps);
  ok('mercato ON + globale OFF → NON attivo (il globale ha la precedenza)', en.enabled === false && en.marketEnabled === true && en.globalEnabled === false);
  ok('  e lo dice esplicitamente', /interruttore generale ha la precedenza/.test(en.reason));

  // Acceso anche il globale → adesso è attivo.
  CFG.setFillStrategy({ scope: 'global', enabled: true, by: 'test' }, cfgDeps);
  en = CFG.isFillStrategyEnabled('0xabc', cfgDeps);
  ok('mercato ON + globale ON → ATTIVO', en.enabled === true);

  // Un ALTRO mercato non è trascinato dentro dal globale.
  ok('il globale da solo non accende un mercato mai abilitato', CFG.isFillStrategyEnabled('0xdef', cfgDeps).enabled === false);

  // Spegnere il globale spegne tutto senza toccare l'opt-in per mercato.
  CFG.setFillStrategy({ scope: 'global', enabled: false, by: 'test' }, cfgDeps);
  en = CFG.isFillStrategyEnabled('0xabc', cfgDeps);
  ok('globale OFF → tutto spento, ma l’opt-in del mercato è conservato', en.enabled === false && en.marketEnabled === true);
  CFG.setFillStrategy({ scope: 'global', enabled: true, by: 'test' }, cfgDeps);

  // Il marketId è normalizzato (case-insensitive), come gli altri store.
  ok('marketId case-insensitive', CFG.isFillStrategyEnabled('0xAbC', cfgDeps).enabled === true);
}

console.log('\n── 7 · I TUNABLE si scrivono davvero, e il TETTO non è scrivibile ──');
{
  const r = CFG.setFillStrategy({ scope: 'market', marketId: '0xabc', patch: { takeProfitCents: 0.9, stopLossPct: 3.5 }, by: 'test' }, cfgDeps);
  ok('patch accettata', r.ok === true);
  const p = CFG.paramsFor('0xabc', cfgDeps);
  ok('  take-profit persistito a 0.9¢', near(p.takeProfitCents, 0.9) && p.takeProfitIsDefault === false);
  ok('  stop-loss persistito a 3.5%', near(p.stopLossPct, 3.5) && p.stopLossIsDefault === false);
  ok('  e non ha spento il mercato', CFG.isFillStrategyEnabled('0xabc', cfgDeps).marketEnabled === true);

  const def = CFG.paramsFor('0xnever-seen', cfgDeps);
  ok('mercato mai configurato → default 0¢ (specchia) e 4%', def.takeProfitCents === 0 && def.stopLossPct === 4 && def.takeProfitMirrorsEntry === true);

  ok('take-profit fuori range → RIFIUTATO, non troncato', CFG.setFillStrategy({ scope: 'market', marketId: '0xabc', patch: { takeProfitCents: 99 } }, cfgDeps).ok === false);
  ok('stop-loss fuori range → RIFIUTATO', CFG.setFillStrategy({ scope: 'market', marketId: '0xabc', patch: { stopLossPct: 900 } }, cfgDeps).ok === false);
  ok('  e il valore precedente resta', near(CFG.paramsFor('0xabc', cfgDeps).stopLossPct, 3.5));

  const cap = CFG.setFillStrategy({ scope: 'market', marketId: '0xabc', patch: { positionCapUsd: 5000 } }, cfgDeps);
  ok('TETTO POSIZIONE non scrivibile: il campo è rifiutato', cap.ok === false && /non modificabile/.test(cap.error));
  ok('  con il motivo giusto', /derivato dal capitale allocato/.test(cap.error));
}

console.log('\n── 8 · IL TETTO È DERIVATO dal piano di allocazione, e fallisce chiuso ──');
{
  const none = AC.readAllocatedCapital('0xabc', cfgDeps);
  ok('nessun piano registrato → nessun tetto (null), non "illimitato"', none.capUsd === null && /nessun piano/.test(none.reason));

  AC.writeAllocatedCapital({ rows: [{ marketId: '0xABC', capital: 250 }, { marketId: '0xdef', capital: 0 }], capital: 500 }, cfgDeps);
  const got = AC.readAllocatedCapital('0xabc', cfgDeps);
  ok('dopo il piano → tetto 250 USD, derivato da rows[].capital', near(got.capUsd, 250));
  ok('  un mercato con capitale 0 non entra nel piano → nessun tetto', AC.readAllocatedCapital('0xdef', cfgDeps).capUsd === null);
  ok('  un mercato assente dal piano → nessun tetto', AC.readAllocatedCapital('0xzzz', cfgDeps).capUsd === null);

  // Un piano vecchio non vale come tetto.
  const oldDeps = { ...cfgDeps, now: () => Date.now() + AC.MAX_AGE_MS + 60_000 };
  const stale = AC.readAllocatedCapital('0xabc', oldDeps);
  ok('piano più vecchio di 24 h → tetto NON valido (stale), fail closed', stale.capUsd === null && stale.stale === true);
}

console.log('\n── 9 · IL CICLO: spento di default non fa nulla, e il kill lo ferma ──');
{
  const placed = [];
  const baseDeps = {
    now: () => 1_700_000_000_000,
    marketIds: ['0xabc'],
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    resolveRules: () => RULES,
    readCap: () => ({ capUsd: 100, readable: true, stale: false, ageSec: 60, reason: 'test' }),
    paramsFor: () => P,
    readSideState: async () => ({ ok: true, sides: [{
      book: 'yes', fills: [{ price: 0.49, size: 10 }], position: { size: 10 },
      mid: 0.50, markPrice: 0.50, lastEntryPrice: 0.49, lastEntrySize: 10,
      bids: [{ price: 0.49, size: 500 }],
    }] }),
    placeOrder: async (o) => { placed.push(o); return { ok: true, sent: false, orderId: null }; },
  };

  return (async () => {
    // Spento: nessun ordine, e il motivo lo dice.
    const off = await FS.runFillStrategyCycle({ ...baseDeps, isEnabled: () => ({ enabled: false, reason: 'strategia spenta globalmente' }) });
    ok('strategia spenta → NESSUN ordine proposto', placed.length === 0);
    ok('  e il mercato riporta il gate disabled', off.markets[0].gate === 'disabled');

    // Kill attivo: nessun ordine, anche con la strategia accesa.
    const killed = await FS.runFillStrategyCycle({ ...baseDeps, isEnabled: () => ({ enabled: true }), killStatus: () => ({ effectivelyKilled: true, readable: true }) });
    ok('kill-switch ATTIVO → nessun ordine', placed.length === 0 && killed.gate === 'kill');

    // Kill illeggibile: trattato come attivo.
    const unk = await FS.runFillStrategyCycle({ ...baseDeps, isEnabled: () => ({ enabled: true }), killStatus: () => ({ effectivelyKilled: false, readable: false }) });
    ok('kill non leggibile → trattato come ATTIVO (fail closed)', placed.length === 0 && unk.gate === 'kill');

    // Accesa: take-profit + ripiazzamento, entrambi ai prezzi attesi.
    const on = await FS.runFillStrategyCycle({ ...baseDeps, isEnabled: () => ({ enabled: true }) });
    ok('accesa → due ordini: take-profit e ripiazzamento', placed.length === 2 && on.ran === true);
    const tp = placed.find((o) => o.side === 'SELL');
    const rp = placed.find((o) => o.side === 'BUY');
    ok('  take-profit: SELL 10 @ 0.51', tp && near(tp.price, 0.51) && near(tp.size, 10));
    ok('  ripiazzamento: BUY 10 @ 0.49', rp && near(rp.price, 0.49) && near(rp.size, 10));
    ok('  e passano dal placeOrder iniettato — nessun venue toccato in questo test', placed.every((o) => o.source === FS.FILL_STRATEGY_SOURCE));

    // Mercato non in gestione manuale: non agisce.
    const notManual = await FS.runFillStrategyCycle({ ...baseDeps, isEnabled: () => ({ enabled: true }), isManual: () => ({ manual: false, readable: true }) });
    ok('mercato non in gestione manuale → non agisce', notManual.markets[0].gate === 'manual-mode-inactive');

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* scratch */ }
    console.log('\nfill-strategy: ' + n + ' passed, 0 failed');
  })();
}

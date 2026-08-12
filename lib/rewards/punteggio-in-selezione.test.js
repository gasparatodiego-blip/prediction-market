#!/usr/bin/env node
'use strict';
// IL TICK REALE ENTRA NELLA SELEZIONE, E SOLO NELLA SELEZIONE.
//
// ═══ IL GUASTO ═══════════════════════════════════════════════════════════════════════════════════════
// Misurato l'8 agosto 2026. `offsetTicks` aveva già corretto DOVE il motore si mette (un tick dal
// concorrente, non un centesimo fisso), ma non quanto vale starci: il lordo dell'obiettivo del knapsack
// è il ceiling a S=1 — un ordine appoggiato sul mid — e non contiene nessun termine di offset. In
// selezione quindi tutti i mercati venivano pesati uguale, che è l'equivalente esatto di una distanza
// fissa uguale per tutti: la cosa che `offsetTicks` esisteva per togliere.
//
// Il venue paga S(v,s) = ((v−s)/v)². Su una banda da 4,5¢:
//     tick 0,01  → 1,0¢ dal mid → S = 0,3086
//     tick 0,001 → 0,1¢ dal mid → S = 0,9131        → 2,96 volte tanto
// Sull'universo reale di quel giorno: 48 mercati su 113 a tick 0,001.
//
// ═══ COSA SI PROVA QUI ═══════════════════════════════════════════════════════════════════════════════
//   1. l'aritmetica del peso, e che fallisce verso il neutro invece di inventare;
//   2. che il peso CAMBIA LA SCELTA: a parità di tutto il resto il mercato a tick fine vince;
//   3. che NON cambia il piazzamento — offset e prezzi restano quelli di prima;
//   4. che il ceiling e il netto misurato restano leggibili accanto al numero di selezione;
//   5. che spento (il difetto di `allocateBudget`, cioè ogni driver di backtest) tutto è byte per byte
//      quello di prima.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { planAllocation } = require('./allocator');
const { allocateBudget, placementWeightForMarket } = require('../../scripts/rewards-replay/lib/allocate');
const { placementScore, placementShareFactor, credibleShareFactor, DEFAULTS } = require('./realistic-estimate');

let n = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { console.log('  ✓ ' + name + (extra ? ' — ' + extra : '')); n++; }
  else { console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); fail++; }
};
const near = (a, b, t = 1e-9) => a != null && b != null && Math.abs(a - b) <= t;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n══ 1 · IL PESO DELLA POSIZIONE REALE');
{
  const grosso = placementWeightForMarket([{ tick: 0.01 }], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: 4.5 });
  const fine = placementWeightForMarket([{ tick: 0.001 }], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: 4.5 });
  ok('tick 0,01 → un tick è 1¢ dal mid', near(grosso.offsetCents, 1));
  ok('  e vale il quadratico del venue a 1¢', near(grosso.S, placementScore(1, 4.5)), grosso.S.toFixed(4));
  ok('tick 0,001 → lo stesso tick è 0,1¢', near(fine.offsetCents, 0.1));
  ok('  e vale il quadratico a 0,1¢', near(fine.S, placementScore(0.1, 4.5)), fine.S.toFixed(4));
  ok('il rapporto fra i due è ~2,96: è tutta qui la sottovalutazione', Math.abs(fine.S / grosso.S - 2.958) < 0.01, (fine.S / grosso.S).toFixed(3));

  // Il peso NON è la stessa cosa a banda diversa: una banda stretta punisce di più lo stesso tick.
  const stretta = placementWeightForMarket([{ tick: 0.01 }], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: 3.5 });
  ok('a banda 3,5¢ lo stesso tick vale meno che a 4,5¢', stretta.S < grosso.S, `${stretta.S.toFixed(3)} < ${grosso.S.toFixed(3)}`);

  ok('banda illeggibile ⇒ null: nessun peso inventato', placementWeightForMarket([{ tick: 0.01 }], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: null }) === null);
  ok('banda zero o negativa ⇒ null', placementWeightForMarket([{ tick: 0.01 }], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: 0 }) === null);
  const senzaTick = placementWeightForMarket([{}], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: 4.5 });
  ok('tick illeggibile ⇒ si ricade sui centesimi, MAI su un tick inventato', senzaTick.tick === null && near(senzaTick.offsetCents, 1));
  const oltreBanda = placementWeightForMarket([{ tick: 0.05 }], { offsetCents: 1, offsetTicks: 1, maxSpreadCents: 4.5 });
  ok('un tick che porta fuori banda vale ZERO, non un numero negativo', oltreBanda.S === 0, `5¢ su banda 4,5¢ → S=${oltreBanda.S}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// DUE MERCATI GEMELLI, UNA SOLA DIFFERENZA: IL TICK.
// Stesso mid, stessa profondità altrui, stessa banda, stesso montepremi, nessun fill (nessun nastro).
// Al ceiling S=1 sono indistinguibili e il knapsack ne sceglie uno qualsiasi; col punteggio reale il
// mercato a tick fine rende 2,96 volte l'altro e deve prendersi il capitale.
const riga = (marketId, tokenId, tick) => (tsMs) => ({
  ts: new Date(tsMs).toISOString(), tsMs, marketId, tokenIdYes: tokenId,
  adjMid: 0.50, plainMid: 0.50, bestBid: 0.49, bestAsk: 0.51,
  bidDepthInBand: 1000, askDepthInBand: 1000, bandLow: 0.4775, bandHigh: 0.5225, tick, src: 'ws',
});
const G = riga('GROSSO', 'TKG', 0.01);
const F = riga('FINE', 'TKF', 0.001);
const byMarket = new Map([['GROSSO', [G(0), G(86_400_000)]], ['FINE', [F(0), F(86_400_000)]]]);
const marketTokens = new Map([['GROSSO', 'TKG'], ['FINE', 'TKF']]);
const tapeByToken = new Map();                       // nessun nastro ⇒ 0 fill ⇒ costo misurato 0
const potByCond = new Map([['GROSSO', 100], ['FINE', 100]]);
const maxSpreadByMarket = new Map([['GROSSO', 4.5], ['FINE', 4.5]]);
const base = { byMarket, marketTokens, tapeByToken, potByCond, budgetUsd: 100, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold', maxSpreadByMarket };

console.log('\n══ 2 · IL PESO CAMBIA LA SCELTA');
{
  // Budget per UN solo mercato: la scelta è forzata a essere esclusiva, quindi visibile.
  const senza = planAllocation({ ...base, usePlacementScore: false });
  const con = planAllocation({ ...base, usePlacementScore: true });
  ok('senza peso il piano prende un mercato solo (il budget basta per uno)', senza.rows.length === 1);
  ok('con il peso ne prende comunque uno solo: il capitale non cambia', con.rows.length === 1);
  ok('CON IL PESO vince il mercato a tick fine', con.rows[0].marketId === 'FINE', `scelto ${con.rows[0].marketId}`);

  const candFine = con.candidates.find((c) => c.marketId === 'FINE');
  const candGrosso = con.candidates.find((c) => c.marketId === 'GROSSO');
  ok('il peso viaggia sul candidato, non resta nel codice', near(candFine.punteggioPosizione, placementScore(0.1, 4.5)) && near(candGrosso.punteggioPosizione, placementScore(1, 4.5)));
  ok('  con la distanza reale in centesimi', near(candFine.punteggioOffsetCents, 0.1) && near(candGrosso.punteggioOffsetCents, 1));
  ok('  e col tick da cui viene', near(candFine.punteggioTick, 0.001) && near(candGrosso.punteggioTick, 0.01));
  // Il numero con cui il knapsack ha davvero deciso sta sul LIVELLO della curva. (Sulle card
  // `bestNetPerDay` resta un trattino finché nessun fill è stato osservato — regola di net-per-day.js,
  // che questa correzione non tocca: un netto senza fill non è misurato, pesato o no.)
  const curva = allocateBudget(byMarket, marketTokens, tapeByToken, potByCond, {
    offsetCents: 1, offsetTicks: 1, maxInventoryUsd: 5000, budgetUsd: 200, unitUsd: 100,
    maxPerMarketUsd: 200, policy: 'hold', usePlacementScore: true, maxSpreadByMarket,
  });
  const liv = (id) => curva.curves.find((c) => c.marketId === id).levels.find((l) => l.units > 0);
  // ── PERCHE' QUESTO NUMERO E' CAMBIATO L'8 AGOSTO 2026 (era 2,958) ────────────────────────────────
  // Fino a stamattina l'obiettivo pesava il lordo per `S`, cioe' `pot·shareCeiling·S`. E' sbagliato: la
  // quota vera di un ordine a S<1 e' `S·size/(S·size + cQ)`, e siccome `S·size + cQ < size + cQ` quella
  // e' SEMPRE piu' grande di `shareCeiling·S`. Moltiplicare per S penalizzava troppo, e penalizzava di
  // piu' proprio i tick grossi (S piccolo) — cioe' gonfiava il vantaggio del tick fine.
  // Adesso si usa `placementShareFactor`, la stessa funzione della stima realistica: il vantaggio del
  // tick fine resta grande e reale, ma vale 2,79× invece di 2,96×. Non si asserisce una costante a
  // memoria: si asserisce che il rapporto SIA quello dell'algebra esatta, calcolata dalla funzione
  // condivisa sugli stessi ingressi del fixture.
  // ⚠ LA SIZE SI DERIVA, non si scrive: era `100` perche' il modello vecchio faceva `cap/2/mid`
  // (200/2/0,50). Dal 12 agosto 2026 la conversione e' `capitale / costoCoppia`, quindi il numero e'
  // un altro — e ripeterlo a mano avrebbe prodotto un rosso a ogni ritaratura del modello.
  const sizeAttesa = liv('FINE').sizeShares != null ? liv('FINE').sizeShares
    : require('./size-da-capitale').sharePerLato({ capitaleUsd: 100 }).shares;
  const cShare = sizeAttesa / (sizeAttesa + 1000);
  const attesoFine = placementShareFactor(sizeAttesa, 1000, placementScore(0.1, 4.5));
  const attesoGrosso = placementShareFactor(sizeAttesa, 1000, placementScore(1, 4.5));
  ok('l\'obiettivo usa il fattore di quota ESATTO, non il punteggio nudo',
    near(liv('FINE').fattorePosizione, attesoFine, 1e-9) && near(liv('GROSSO').fattorePosizione, attesoGrosso, 1e-9),
    `quota-ceiling ${(cShare * 100).toFixed(2)}%`);
  ok('  e il fattore esatto NON e\' S: e\' piu\' generoso, perche\' S entra anche al denominatore',
    liv('GROSSO').fattorePosizione > placementScore(1, 4.5) && liv('FINE').fattorePosizione > placementScore(0.1, 4.5),
    `${liv('GROSSO').fattorePosizione.toFixed(4)} > ${placementScore(1, 4.5).toFixed(4)}`);
  ok('l\'obiettivo del tick fine resta molto sopra quello del tick grosso',
    Math.abs(liv('FINE').net5m / liv('GROSSO').net5m - attesoFine / attesoGrosso) < 0.01,
    `${liv('FINE').net5m.toFixed(3)} contro ${liv('GROSSO').net5m.toFixed(3)} = ${(liv('FINE').net5m / liv('GROSSO').net5m).toFixed(3)}×`);
  ok('mentre il netto MISURATO resta identico fra i due: è il numero che non distingueva',
    near(liv('FINE').netPerDay5m, liv('GROSSO').netPerDay5m, 1e-6),
    `${liv('FINE').netPerDay5m} = ${liv('GROSSO').netPerDay5m}`);
  ok('e sulle card il ceiling resta leggibile accanto al numero di selezione',
    'bestNetCeilingPerDay' in candFine && 'bestNetCeilingPerDay' in candGrosso);
  ok('nessun mercato è rimasto senza peso: la banda c\'era per entrambi', con.pesoNonApplicato.length === 0);
  ok('e il piano dichiara di aver pesato', con.usePlacementScore === true);
}

console.log('\n══ 3 · IL PIAZZAMENTO NON CAMBIA DI UN TICK');
{
  // Budget per DUE mercati: così entrambe le righe esistono in tutti e due i piani e si possono
  // confrontare riga per riga. È il controllo che questa correzione tocchi la selezione e basta.
  const b2 = { ...base, budgetUsd: 200, unitUsd: 100, maxPerMarketUsd: 100 };
  const senza = planAllocation({ ...b2, usePlacementScore: false });
  const con = planAllocation({ ...b2, usePlacementScore: true });
  ok('entrambi i piani prendono i due mercati', senza.rows.length === 2 && con.rows.length === 2);
  const perId = (p) => new Map(p.rows.map((r) => [r.marketId, r]));
  const A = perId(senza), B = perId(con);
  for (const id of ['GROSSO', 'FINE']) {
    ok(`${id}: l'offset con cui si piazza è lo stesso`, A.get(id).computedDefaultOffsetTicks === B.get(id).computedDefaultOffsetTicks,
      `${A.get(id).computedDefaultOffsetTicks} tick`);
    ok(`  ${id}: bid e ask snappati identici`, near(A.get(id).snappedBid, B.get(id).snappedBid) && near(A.get(id).snappedAsk, B.get(id).snappedAsk));
    ok(`  ${id}: il LORDO dichiarato resta il ceiling, non il pesato`, near(A.get(id).grossPerDay, B.get(id).grossPerDay));
    ok(`  ${id}: e il capitale della riga non cambia`, near(A.get(id).capital, B.get(id).capital));
  }
  // Aggiornata l'8 agosto 2026 insieme al fattore: il lordo pesato non e' piu' `lordo × S` ma
  // `lordo × fattorePosizione`, cioe' l'algebra esatta della quota. Il campo resta ACCANTO al ceiling.
  ok('il lordo PESATO è un campo in più, accanto al ceiling — mai al posto suo',
    near(B.get('FINE').grossScoredPerDay, B.get('FINE').grossPerDay * B.get('FINE').fattorePosizione, 1e-9));
  ok('  e il totale lordo del piano resta quello di sempre', near(senza.totalGrossPerDay, con.totalGrossPerDay));
}

console.log('\n══ 4 · SPENTO, È BYTE PER BYTE QUELLO DI PRIMA');
{
  // Il difetto di `allocateBudget` è SPENTO: è il percorso di ogni driver di backtest, e non deve
  // essersi mosso di un centesimo.
  const args = [byMarket, marketTokens, tapeByToken, potByCond];
  const vecchio = allocateBudget(...args, { offsetCents: 1, offsetTicks: 1, maxInventoryUsd: 5000, budgetUsd: 200, unitUsd: 100, maxPerMarketUsd: 200, policy: 'hold' });
  const esplicito = allocateBudget(...args, { offsetCents: 1, offsetTicks: 1, maxInventoryUsd: 5000, budgetUsd: 200, unitUsd: 100, maxPerMarketUsd: 200, policy: 'hold', usePlacementScore: false, maxSpreadByMarket });
  ok('il difetto è «non pesare»', vecchio.usePlacementScore === false);
  ok('  e passare la banda senza accendere non cambia niente', near(vecchio.totalNet5m, esplicito.totalNet5m) && vecchio.marketsHeld === esplicito.marketsHeld);
  for (const c of vecchio.curves) {
    const l = c.levels.find((x) => x.units > 0);
    ok(`  ${c.marketId}: senza peso l'obiettivo È il netto misurato`, near(l.net5m, l.netPerDay5m));
  }

  // E il TETTO DI CREDIBILITA' e' spento allo stesso modo: e' l'altra meta' della stessa promessa, e i
  // driver di backtest non passano nemmeno quello.
  ok('anche il tetto di credibilità è spento per difetto', vecchio.useCredibleShareCap === false && vecchio.maxCredibleShare === null);
  const conSoglia = allocateBudget(...args, { offsetCents: 1, offsetTicks: 1, maxInventoryUsd: 5000, budgetUsd: 200, unitUsd: 100, maxPerMarketUsd: 200, policy: 'hold', maxCredibleShare: 0.6 });
  ok('  e passare la soglia senza accenderlo non cambia un numero',
    near(conSoglia.totalNet5m, vecchio.totalNet5m) && conSoglia.marketsHeld === vecchio.marketsHeld);
  for (const c of conSoglia.curves) {
    const l = c.levels.find((x) => x.units > 0);
    ok(`  ${c.marketId}: nessun fattore di credibilità applicato`, l.fattoreCredibilita === null && l.quotaCapata === false);
  }

  // Acceso ma SENZA banda: nessun peso applicabile, e i mercati finiscono nell'elenco dichiarato invece
  // di essere pesati a caso o silenziosamente favoriti.
  const senzaBanda = allocateBudget(...args, { offsetCents: 1, offsetTicks: 1, maxInventoryUsd: 5000, budgetUsd: 200, unitUsd: 100, maxPerMarketUsd: 200, policy: 'hold', usePlacementScore: true });
  ok('acceso senza banda ⇒ i mercati sono ELENCATI come non pesati', senzaBanda.pesoNonApplicato.length === 2);
  ok('  e il risultato torna a essere quello di prima, non uno a caso', near(senzaBanda.totalNet5m, vecchio.totalNet5m));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// IL TETTO DI CREDIBILITA' DELLA QUOTA, DENTRO L'OBIETTIVO (8 agosto 2026).
// Due mercati identici tranne la PROFONDITA' ALTRUI: uno con un book normale, uno praticamente vuoto.
// Al ceiling il book vuoto sembra l'occasione migliore che ci sia («il 100% del montepremi»), e il
// knapsack — che massimizza — ci andava dritto. La stima realistica lo tagliava a `maxCredibleShare`,
// ma DOPO che la scelta era gia' stata fatta.
const rigaProf = (marketId, tokenId, prof) => (tsMs) => ({
  ts: new Date(tsMs).toISOString(), tsMs, marketId, tokenIdYes: tokenId,
  adjMid: 0.50, plainMid: 0.50, bestBid: 0.49, bestAsk: 0.51,
  bidDepthInBand: prof, askDepthInBand: prof, bandLow: 0.4775, bandHigh: 0.5225, tick: 0.01, src: 'ws',
});
const PIENO = rigaProf('PIENO', 'TKP', 1000);      // book normale
const VUOTO = rigaProf('VUOTO', 'TKV', 5);         // book quasi deserto: 5 share di altri
const byMarket2 = new Map([['PIENO', [PIENO(0), PIENO(86_400_000)]], ['VUOTO', [VUOTO(0), VUOTO(86_400_000)]]]);
const marketTokens2 = new Map([['PIENO', 'TKP'], ['VUOTO', 'TKV']]);
// I due montepremi sono scelti perche' il tetto RIBALTI la scelta, e il conto e' esplicito:
//   PIENO: quota 100/(100+1000) = 9,09% · fattore posizione 0,3293 → obiettivo = pot × 0,02993
//   VUOTO: quota 100/(100+5)   = 95,2% · fattore posizione 0,9039 → obiettivo = pot × 0,860
//                                        col tetto (0,6/0,952 = 0,6303) → pot × 0,5421
// Con pot 100 e 4,5: senza tetto VUOTO vale 3,87 contro 2,99; col tetto 2,44 contro 2,99. Il tetto
// non e' una penalita' generica — sposta la scelta esattamente dove il book non regge la quota.
const potByCond2 = new Map([['PIENO', 100], ['VUOTO', 4.5]]);
const maxSpread2 = new Map([['PIENO', 4.5], ['VUOTO', 4.5]]);
const base2 = {
  byMarket: byMarket2, marketTokens: marketTokens2, tapeByToken, potByCond: potByCond2,
  budgetUsd: 100, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold',
  maxSpreadByMarket: maxSpread2,
  // ── IL CANCELLO SULLA PROFONDITÀ È SPENTO QUI, E NON È UN ALLENTAMENTO (9 agosto 2026) ───────────
  // Il soggetto di queste tre sezioni è l'ATTENUAZIONE (`useCredibleShareCap`): la sua algebra, la sua
  // composizione col fattore di posizione, il fatto che ribalti una scelta. Per provarla serve un
  // mercato la cui quota SUPERI la soglia — ed è esattamente `VUOTO`, costruito apposta con 5 share di
  // concorrenza. Dal 9 agosto quel mercato non arriva più al knapsack: `filtroProfondita` lo toglie
  // prima, che è lo scopo del cancello.
  //
  // Tenere il cancello acceso qui non renderebbe il test più severo: lo renderebbe VUOTO — misurerebbe
  // l'attenuazione su un insieme in cui nessuno la attiva. Il cancello ha il suo test
  // (`cancello-profondita.test.js`), che verifica proprio che `VUOTO` non entri; questo continua a
  // verificare che, per chi il cancello lo supera, l'attenuazione faccia ancora il suo mestiere.
  filtroProfondita: false,
};

console.log('\n══ 5 · IL TETTO DI CREDIBILITÀ ENTRA NELLA SCELTA, NON SOLO NEL GIUDIZIO');
{
  const senza = planAllocation({ ...base2, useCredibleShareCap: false });
  const con = planAllocation({ ...base2, useCredibleShareCap: true });
  ok('SENZA tetto il knapsack va sul book quasi vuoto: gli sembra il 100% del montepremi',
    senza.rows[0].marketId === 'VUOTO', `scelto ${senza.rows[0].marketId}`);
  ok('CON il tetto sceglie il book vero', con.rows[0].marketId === 'PIENO', `scelto ${con.rows[0].marketId}`);

  const capVuoto = con.candidates.find((c) => c.marketId === 'VUOTO');
  const capPieno = con.candidates.find((c) => c.marketId === 'PIENO');
  ok('  il mercato sottile è marcato come capato, e la sua quota si legge',
    capVuoto.quotaCapata === true && capVuoto.quotaCeiling > DEFAULTS.maxCredibleShare,
    `quota ${(capVuoto.quotaCeiling * 100).toFixed(1)}% > tetto ${(DEFAULTS.maxCredibleShare * 100).toFixed(0)}%`);
  ok('  quello con book normale NON è toccato dal tetto: fattore esattamente 1, nessuna sovra-penalizzazione',
    capPieno.quotaCapata === false && capPieno.fattoreCredibilita === 1,
    `quota ${(capPieno.quotaCeiling * 100).toFixed(2)}% · fattore ${capPieno.fattoreCredibilita}`);
  ok('  e il tetto usato è LO STESSO numero della correzione thin-book',
    con.maxCredibleShare === DEFAULTS.maxCredibleShare, String(con.maxCredibleShare));

  // Il tetto e' un TAGLIO, non una scala: sotto la soglia il fattore e' esattamente 1.
  ok('sotto la soglia il fattore è esattamente 1, non «quasi 1»',
    credibleShareFactor(100, 1000, DEFAULTS.maxCredibleShare).factor === 1);
  ok('  e sopra è il rapporto fra tetto e quota, niente di inventato', (() => {
    const r = credibleShareFactor(900, 100, 0.6);
    return near(r.factor, 0.6 / (900 / 1000)) && r.capped === true;
  })());
  ok('quota illeggibile ⇒ null, mai un tetto applicato al buio',
    credibleShareFactor(null, 1000, 0.6) === null && credibleShareFactor(100, null, 0.6) === null);
}

console.log('\n══ 6 · LE DUE CORREZIONI NON CONTANO DUE VOLTE LA STESSA COSA');
{
  // La prova algebrica, sul livello vero della curva: il lordo pesato deve essere ESATTAMENTE
  // `lordo × fattorePosizione × fattoreCredibilità`, e i due fattori devono essere quelli che le
  // funzioni condivise restituiscono sugli stessi ingressi. Se una delle due scontasse un pezzo già
  // scontato dall'altra, questa uguaglianza non reggerebbe.
  const alloc = allocateBudget(byMarket2, marketTokens2, tapeByToken, potByCond2, {
    offsetCents: 1, offsetTicks: 1, maxInventoryUsd: 5000, budgetUsd: 200, unitUsd: 100,
    maxPerMarketUsd: 100, policy: 'hold', usePlacementScore: true, maxSpreadByMarket: maxSpread2,
    useCredibleShareCap: true,
  });
  const liv = (id) => alloc.curves.find((c) => c.marketId === id).levels.find((l) => l.units > 0);
  for (const id of ['PIENO', 'VUOTO']) {
    const L = liv(id);
    const prof = id === 'PIENO' ? 1000 : 5;
    // La size si DERIVA dalla formula unica: era `(100/2)/0,5` cioe' il modello `(C/2)/mid`, tolto il
    // 12 agosto 2026. Con `capitale / costoCoppia` il numero e' un altro, e ripeterlo a mano
    // riprodurrebbe qui la stessa divergenza che il lavoro esiste per chiudere.
    const size = require('./size-da-capitale').sharePerLato({ capitaleUsd: 100 }).shares;
    const S = placementScore(1, 4.5);             // tick 0,01, banda 4,5¢
    const fp = placementShareFactor(size, prof, S);
    const fc = credibleShareFactor(size, prof, DEFAULTS.maxCredibleShare);
    ok(`${id}: il fattore di posizione è quello della funzione condivisa`, near(L.fattorePosizione, fp, 1e-9));
    ok(`  ${id}: e il fattore di credibilità pure`, near(L.fattoreCredibilita ?? 1, fc.factor, 1e-9));
    ok(`  ${id}: il lordo pesato è il PRODOTTO dei due, senza termini in più`,
      near(L.grossScoredPerDay, L.grossPerDay * L.fattorePosizione * (L.fattoreCredibilita ?? 1), 1e-9));
  }
  // La non-duplicazione detta in modo diverso: le due correzioni agiscono su cose diverse della stessa
  // frazione — la posizione sul NUMERATORE (S·size invece di size), il tetto sul VALORE massimo. Quindi
  // cambiare il tick NON deve muovere il fattore di credibilità, e cambiare la profondità NON deve
  // muovere il fattore di posizione più di quanto l'algebra imponga.
  const fcTickGrosso = credibleShareFactor(200, 5, DEFAULTS.maxCredibleShare).factor;
  const fcTickFine = credibleShareFactor(200, 5, DEFAULTS.maxCredibleShare).factor;
  ok('il tetto di credibilità NON dipende dal tick: guarda la quota, non la posizione',
    fcTickGrosso === fcTickFine);
  // Il tetto per mercato costringe il piano a finanziare ENTRAMBI, cosi' i due mercati si confrontano
  // riga per riga invece che attraverso una scelta esclusiva.
  const due = { ...base2, budgetUsd: 200, unitUsd: 100, maxPerMarketUsd: 100 };
  const soloPos = planAllocation({ ...due, usePlacementScore: true, useCredibleShareCap: false });
  const soloTetto = planAllocation({ ...due, usePlacementScore: false, useCredibleShareCap: true });
  const entrambe = planAllocation({ ...due, usePlacementScore: true, useCredibleShareCap: true });
  const g = (p, id) => { const r = p.rows.find((x) => x.marketId === id); return r ? r.grossScoredPerDay : null; };
  for (const id of ['PIENO', 'VUOTO']) {
    ok(`${id}: acceso-entrambe è ESATTAMENTE il prodotto dei due fattori, niente in più`, (() => {
      const r = entrambe.rows.find((x) => x.marketId === id);
      return r && near(r.grossScoredPerDay, r.grossPerDay * r.fattorePosizione * (r.fattoreCredibilita ?? 1), 1e-9);
    })(), `solo posizione ${g(soloPos, id).toFixed(4)} · solo tetto ${g(soloTetto, id).toFixed(4)} · entrambe ${g(entrambe, id).toFixed(4)}`);
    ok(`  ${id}: e i due fattori isolati sono gli stessi che si compongono`, (() => {
      const a = soloPos.rows.find((x) => x.marketId === id);
      const b = soloTetto.rows.find((x) => x.marketId === id);
      const e = entrambe.rows.find((x) => x.marketId === id);
      return near(e.fattorePosizione, a.fattorePosizione, 1e-9) && near(e.fattoreCredibilita ?? 1, b.fattoreCredibilita ?? 1, 1e-9);
    })());
  }
  ok('sul book NORMALE accendere il tetto non cambia nulla: nessuna sovra-penalizzazione',
    near(g(soloPos, 'PIENO'), g(entrambe, 'PIENO'), 1e-9),
    `${g(soloPos, 'PIENO').toFixed(4)} = ${g(entrambe, 'PIENO').toFixed(4)}`);
}

console.log('\n══ 7 · IL PIAZZAMENTO REALE NON È STATO TOCCATO');
{
  // (a) sul PIANO: con e senza tetto, le righe sopravvissute si piazzano allo stesso identico posto.
  const b3 = { ...base2, budgetUsd: 200, unitUsd: 100, maxPerMarketUsd: 100 };
  const senza = planAllocation({ ...b3, useCredibleShareCap: false });
  const con = planAllocation({ ...b3, useCredibleShareCap: true });
  const A = new Map(senza.rows.map((r) => [r.marketId, r]));
  const B = new Map(con.rows.map((r) => [r.marketId, r]));
  let confrontate = 0, diverse = 0;
  for (const [id, r] of B) {
    const a = A.get(id); if (!a) continue;
    confrontate++;
    if (a.computedDefaultOffsetTicks !== r.computedDefaultOffsetTicks
      || !near(a.snappedBid, r.snappedBid) || !near(a.snappedAsk, r.snappedAsk)
      || !near(a.grossPerDay, r.grossPerDay)) diverse++;
  }
  ok('offset, bid, ask e lordo dichiarato: identici con e senza tetto', confrontate > 0 && diverse === 0,
    `${confrontate} righe confrontate, ${diverse} diverse`);

  // (b) sul CODICE: nessun modulo di lib/maker/ conosce il tetto di credibilità. Il piazzamento decide
  // dove mettere un ordine sul book; questo lavoro decide su QUALI mercati. Sono due domande diverse e
  // devono restare in due posti diversi — se un giorno `maxCredibleShare` comparisse sotto lib/maker/,
  // vorrebbe dire che una regola di selezione ha cominciato a muovere un prezzo.
  const dir = path.join(__dirname, '..', 'maker');
  const sporchi = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .filter((f) => /maxCredibleShare|credibleShareFactor|fattoreCredibilita|quotaCapata/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  ok('nessun modulo di lib/maker/ importa o nomina il tetto di credibilità',
    sporchi.length === 0, sporchi.length ? sporchi.join(', ') : `${fs.readdirSync(dir).filter((f) => f.endsWith('.js')).length} file controllati`);

  // (c) e il piazzamento non importa nemmeno l'allocatore: la selezione gli arriva come un piano già
  // fatto, mai come una funzione da richiamare.
  const motore = fs.readFileSync(path.join(dir, 'motore-unico.js'), 'utf8');
  ok('il motore di piazzamento non importa l allocatore',
    !/require\([^)]*rewards\/allocator/.test(motore));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// LO ZERO MISURATO CONTRO IL BUCO (8 agosto 2026, sera).
// `share → 1` quando la concorrenza in banda → 0, e il knapsack massimizza: un book vuoto e'
// l'occasione migliore che possa leggere. `realisticEstimate` su quel caso si RIFIUTA di stimare, ma
// solo a valle. Prima di decidere cosa fare a monte serviva sapere se quello zero e' un fatto o un buco
// — e lo si puo' sapere: agent34 scrive `null` quando non ha misurato e un numero solo dopo aver
// camminato il book, quindi uno 0 e' «ho guardato e non c'era nessuno».
console.log('\n══ 8 · «BOOK VUOTO VERIFICATO» NON È «NON L\'HO MISURATO»');
{
  const { profonditaVerificata, MIN_CAMPIONI_VUOTO } = require('../../scripts/rewards-replay/lib/allocate');
  const camp = (bd, ad, src) => ({ bidDepthInBand: bd, askDepthInBand: ad, src });
  const molti = (v, src) => Array.from({ length: 20 }, () => camp(v, v, src));

  ok('profondità misurata e positiva ⇒ «misurata»', profonditaVerificata(molti(100, 'ws')).stato === 'misurata');
  ok('venti campioni a zero su book FRESCHI ⇒ vuoto VERIFICATO',
    profonditaVerificata(molti(0, 'ws')).stato === 'vuota-verificata');
  ok(`  ma sotto ${MIN_CAMPIONI_VUOTO} campioni no: uno zero su tre letture non è un deserto`,
    profonditaVerificata(Array.from({ length: 3 }, () => camp(0, 0, 'ws'))).stato === 'non-verificata');
  ok('  e nemmeno venti zeri su book TRASCINATI: nessuno li ha guardati adesso',
    profonditaVerificata(molti(0, 'stale')).stato === 'non-verificata');
  ok('profondità mai misurata (null) ⇒ «non verificata», e la mediana resta null — mai 0',
    (() => { const p = profonditaVerificata(molti(null, 'ws')); return p.stato === 'non-verificata' && p.mediana === null; })());
  ok('  un `null` non viene MAI contato come uno zero: è la distinzione su cui poggia tutto il resto',
    profonditaVerificata([...molti(null, 'ws'), ...Array.from({ length: 12 }, () => camp(5, 5, 'ws'))]).stato === 'misurata');
  ok('la misura viaggia col verdetto, non solo il verdetto', (() => {
    const p = profonditaVerificata(molti(0, 'ws'));
    return p.misurati === 20 && p.zeri === 20 && p.zeriFreschi === 20;
  })());

  // ── SUL PIANO: il buco non vince, il deserto verificato sì (ma vedi §9) ─────────────────────────
  const rigaProf2 = (marketId, tokenId, prof, src) => (tsMs) => ({
    ts: new Date(tsMs).toISOString(), tsMs, marketId, tokenIdYes: tokenId,
    adjMid: 0.50, plainMid: 0.50, bestBid: 0.49, bestAsk: 0.51,
    bidDepthInBand: prof, askDepthInBand: prof, bandLow: 0.4775, bandHigh: 0.5225, tick: 0.01, src,
  });
  // Venti campioni per mercato: uno con book pieno, uno vuoto VERIFICATO, uno vuoto ma NON verificato
  // (i suoi zeri arrivano tutti da book trascinati).
  const serie = (f) => Array.from({ length: 20 }, (_, i) => f(i * 3600_000));
  const bm = new Map([
    ['PIENO', serie(rigaProf2('PIENO', 'TKP', 1000, 'ws'))],
    ['DESERTO', serie(rigaProf2('DESERTO', 'TKD', 0, 'ws'))],
    ['IGNOTO', serie(rigaProf2('IGNOTO', 'TKI', 0, 'stale'))],
  ]);
  const mt = new Map([['PIENO', 'TKP'], ['DESERTO', 'TKD'], ['IGNOTO', 'TKI']]);
  const pot = new Map([['PIENO', 100], ['DESERTO', 30], ['IGNOTO', 30]]);
  const spread = new Map([['PIENO', 4.5], ['DESERTO', 4.5], ['IGNOTO', 4.5]]);
  const b4 = {
    byMarket: bm, marketTokens: mt, tapeByToken, potByCond: pot,
    budgetUsd: 100, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold',
    maxSpreadByMarket: spread,
    // ── CANCELLO SPENTO, PER LA STESSA RAGIONE DI `base2` (9 agosto 2026) ──────────────────────────
    // Questa sezione prova la distinzione fra uno ZERO MISURATO e un BUCO, e la quota di categoria che
    // ne consegue. Entrambe hanno senso solo su mercati che arrivano al knapsack — e `DESERTO`, per
    // costruzione, ha concorrenza zero, quindi quota 100%: dal 9 agosto `filtroProfondita` lo toglie
    // prima che la quota di categoria possa pronunciarsi.
    //
    // VA DETTO CHE COSA SIGNIFICA IN PRODUZIONE, perché non è solo una nota di test: con il cancello
    // acceso `capVuotiFrac` diventa in pratica IRRAGGIUNGIBILE — un book vuoto verificato ha sempre
    // quota 1, quindi il cancello lo prende sempre per primo. Il meccanismo resta come seconda linea
    // (vale ancora se un domani il cancello venisse spento o la soglia alzata sopra 1), e questi test
    // continuano a coprirlo per quello che è.
    filtroProfondita: false,
  };

  const senza = planAllocation({ ...b4, usaProfonditaVerificata: false, capVuotiFrac: 0 });
  const con = planAllocation({ ...b4, usaProfonditaVerificata: true, capVuotiFrac: 0 });
  const perId = (p) => new Map((p.candidates || []).map((c) => [c.marketId, c]));
  const A = perId(senza), B = perId(con);
  ok('SENZA la distinzione, un book non misurato vale quanto uno misurato vuoto',
    A.get('IGNOTO').bestObiettivoPerDay === A.get('DESERTO').bestObiettivoPerDay,
    `${A.get('IGNOTO').bestObiettivoPerDay}`);
  ok('CON la distinzione, il non misurato è classificato come tale', B.get('IGNOTO').profondita === 'non-verificata');
  ok('  e l obiettivo si ASTIENE: zero, non un numero più basso inventato', B.get('IGNOTO').bestObiettivoPerDay === 0);
  ok('  col motivo scritto sul candidato', /non misurata abbastanza/.test(B.get('IGNOTO').reason || ''), B.get('IGNOTO').reasonCode);
  ok('  mentre il deserto VERIFICATO resta scorato: è un fatto, non un buco',
    B.get('DESERTO').profondita === 'vuota-verificata' && B.get('DESERTO').bestObiettivoPerDay > 0);
  ok('  e il piano dichiara quanti se ne è rifiutato', con.profonditaNonVerificata.includes('IGNOTO'));
  ok('la distinzione NON tocca i mercati con book vero',
    B.get('PIENO').profondita === 'misurata' && near(A.get('PIENO').bestObiettivoPerDay, B.get('PIENO').bestObiettivoPerDay, 1e-9));

  console.log('\n══ 9 · IL TETTO DI CONCENTRAZIONE SUI BOOK VUOTI VERIFICATI');
  {
    // Il deserto ha quota 1 a QUALUNQUE size, quindi il suo lordo non scende dandogli meno capitale:
    // l'unica leva è quanti ne entrano. Con budget per due mercati e il tetto al 30%, il deserto —
    // che da solo varrebbe più di metà del lordo pesato — resta fuori.
    const b5 = { ...b4, budgetUsd: 200, unitUsd: 100, maxPerMarketUsd: 100 };
    const senzaTetto = planAllocation({ ...b5, capVuotiFrac: 0 });
    const conTetto = planAllocation({ ...b5, capVuotiFrac: 0.30 });
    const idDi = (p) => p.rows.map((r) => r.marketId).sort().join(',');
    ok('senza tetto il deserto entra nel piano', idDi(senzaTetto).includes('DESERTO'), idDi(senzaTetto));
    const quota = (p) => {
      const tot = p.rows.reduce((t, r) => t + (fin(r.grossScoredPerDay) ? r.grossScoredPerDay : r.grossPerDay), 0);
      const v = p.rows.filter((r) => (p.candidates.find((c) => c.marketId === r.marketId) || {}).profondita === 'vuota-verificata')
        .reduce((t, r) => t + (fin(r.grossScoredPerDay) ? r.grossScoredPerDay : r.grossPerDay), 0);
      return tot > 0 ? v / tot : 0;
    };
    ok('  e da solo vale più del 30% del lordo pesato', quota(senzaTetto) > 0.30, `${(quota(senzaTetto) * 100).toFixed(1)}%`);
    ok('COL tetto la categoria rientra sotto il 30%', quota(conTetto) <= 0.30 + 1e-9, `${(quota(conTetto) * 100).toFixed(1)}%`);
    ok('  e il mercato lasciato fuori è dichiarato, col motivo', conTetto.vuotiOltreIlTetto.includes('DESERTO')
      && /maggioranza/.test((conTetto.candidates.find((c) => c.marketId === 'DESERTO') || {}).reason || ''));
    ok('  il capitale non resta fermo: va sul book vero', conTetto.rows.some((r) => r.marketId === 'PIENO'));
    ok('un mercato con book VERO non viene mai toccato dal tetto di categoria',
      !conTetto.vuotiOltreIlTetto.includes('PIENO'));
    ok('tetto a 0 ⇒ la regola non esiste, e il piano è quello di prima',
      idDi(planAllocation({ ...b5, capVuotiFrac: 0 })) === idDi(senzaTetto));
  }
}

console.log(`\npunteggio in selezione: ${n} passati, ${fail} falliti`);
assert.strictEqual(fail, 0, `${fail} asserzioni fallite`);

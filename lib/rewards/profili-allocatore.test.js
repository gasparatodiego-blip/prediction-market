#!/usr/bin/env node
'use strict';
// DUE PROFILI, UN ALLOCATORE — E IL PERCORSO SAFE NON SI È MOSSO DI UN BYTE.
//
// ═══ LA PROPRIETÀ CHE QUESTO FILE ESISTE PER DIMOSTRARE ══════════════════════════════════════════════
// Il percorso Safe è quello su cui c'è il capitale vero. Parametrizzare l'allocatore con un «profilo»
// è utile solo se si può DIMOSTRARE che il profilo Safe produce esattamente ciò che l'ottimizzatore
// produceva prima che i profili esistessero — non «un piano simile», non «gli stessi mercati»: lo
// STESSO OGGETTO, campo per campo.
//
// Il confronto qui sotto è quindi un deepStrictEqual fra:
//   A) planAllocation chiamato COME PRIMA          → { horizonFilter: true }
//   B) planAllocation chiamato COL PROFILO SAFE    → i parametri che SAFE_PROFILE dichiara
// sullo stesso universo sintetico e allo stesso istante. Se un giorno divergono, questo test cade, e
// cade prima che il piano diverso arrivi su del capitale.
//
// ═══ E IL PROFILO RISK CAMBIA UNA COSA SOLA ══════════════════════════════════════════════════════════
// La seconda metà verifica il simmetrico: che RISK ammetta ciò che SAFE scarta PER LA SCADENZA, che non
// ammetta ciò che il venue rifiuterebbe, e che l'unica differenza fra i due referti sia quella —
// nessun parametro di sizing, di offset, di tetto o di costo cambia col profilo.

const assert = require('assert');
const { planAllocation } = require('./allocator');
const { SAFE_PROFILE, RISK_PROFILE, resolveProfile, differenzeProfili, RULE_VENUE_FLOOR } = require('./allocator-profiles');
const { VENUE_FLOOR_MINUTES, SAFE_FLOOR_MINUTES, STALE_SECONDS } = require('../maker/risk-classifier');
const { MIN_HORIZON_DAYS } = require('./horizon');
const { VENUE_GTD_MIN_FUTURE_SEC } = require('../maker/order-ttl');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

// ── L'UNIVERSO SINTETICO ──────────────────────────────────────────────────────────────────────────
// Tre mercati identici in tutto tranne la scadenza, così l'unica variabile che può spiegare una
// differenza fra due piani è quella che i profili toccano.
const ORA = Date.parse('2026-08-06T12:00:00Z');
const riga = (mid, tsMs) => ({
  ts: new Date(tsMs).toISOString(), tsMs, marketId: mid, tokenIdYes: 'TK' + mid,
  adjMid: 0.50, plainMid: 0.50, bestBid: 0.49, bestAsk: 0.51,
  bidDepthInBand: 1000, askDepthInBand: 1000, bandLow: 0.45, bandHigh: 0.55, tick: 0.01, src: 'ws',
});
const MERCATI = ['LUNGO', 'CORTO', 'MORENTE'];
const byMarket = new Map(MERCATI.map((m) => [m, [riga(m, ORA - 86400000), riga(m, ORA)]]));
const marketTokens = new Map(MERCATI.map((m) => [m, 'TK' + m]));
const tapeByToken = new Map();
const potByCond = new Map(MERCATI.map((m) => [m, 100]));
const iso = (min) => new Date(ORA + min * 60000).toISOString();
const endDateByMarket = new Map([
  ['LUNGO', iso(60 * 24 * 30)],   // fra 30 giorni  → passa entrambi
  ['CORTO', iso(45)],             // fra 45 minuti  → sotto la soglia Safe, sopra il pavimento venue
  ['MORENTE', iso(1)],            // fra 1 minuto   → sotto il pavimento del venue
]);

const base = {
  byMarket, marketTokens, tapeByToken, potByCond,
  budgetUsd: 600, unitUsd: 100, offsetCents: 1, maxInventoryUsd: 5000, policy: 'hold',
  endDateByMarket, nowMs: ORA,
};

console.log('\n══ LE SOGLIE DEI PROFILI SONO QUELLE DEI MODULI CHE LE POSSEDEVANO');
{
  ok('SAFE usa la soglia di horizon.js', SAFE_PROFILE.safeFloorMinutes === MIN_HORIZON_DAYS * 24 * 60);
  ok('RISK usa il pavimento di order-ttl.js',
    RISK_PROFILE.safeFloorMinutes === VENUE_GTD_MIN_FUTURE_SEC / 60 && RISK_PROFILE.safeFloorMinutes === 3);
  ok('entrambi usano la stessa soglia di staleness', SAFE_PROFILE.staleSeconds === RISK_PROFILE.staleSeconds
    && SAFE_PROFILE.staleSeconds === STALE_SECONDS);
  ok('SAFE non tollera niente', SAFE_PROFILE.allowOutOfBand === false && SAFE_PROFILE.allowStaleData === false);
  ok('RISK tollera banda e staleness', RISK_PROFILE.allowOutOfBand === true && RISK_PROFILE.allowStaleData === true);
  ok('il filtro orizzonte resta ACCESO anche per RISK (i mercati chiusi restano fuori da entrambi)',
    RISK_PROFILE.horizonFilter === true && SAFE_PROFILE.horizonFilter === true);
  ok('un nome sconosciuto ricade su SAFE, mai su RISK', resolveProfile('pippo').key === 'safe');
  ok('profilo assente ⇒ SAFE', resolveProfile(undefined).key === 'safe' && resolveProfile(null).key === 'safe');
}

console.log('\n══ NON-REGRESSIONE: SAFE_PROFILE ≡ IL COMPORTAMENTO PRE-ESISTENTE');
{
  // A — la chiamata ESATTA che il percorso Ottimizza faceva prima dei profili.
  const prima = planAllocation({ ...base, horizonFilter: true });
  // B — la stessa chiamata, costruita dai campi che SAFE_PROFILE dichiara.
  const dopo = planAllocation({
    ...base,
    horizonFilter: SAFE_PROFILE.horizonFilter,
    minTimeToCloseRule: SAFE_PROFILE.minTimeToCloseRule === RULE_VENUE_FLOOR ? RULE_VENUE_FLOOR : null,
  });

  // Il campo che i profili hanno AGGIUNTO al referto non fa parte del confronto: è nuovo per
  // costruzione, e confrontarlo vorrebbe dire confrontare il test con se stesso.
  const senzaNuovi = (p) => { const c = { ...p }; delete c.minTimeToCloseRule; return c; };

  let uguali = true, dove = '';
  try { assert.deepStrictEqual(senzaNuovi(dopo), senzaNuovi(prima)); }
  catch (e) { uguali = false; dove = String(e.message).split('\n').slice(0, 3).join(' | '); }

  ok('il piano col profilo SAFE è deepStrictEqual a quello di prima', uguali, dove);
  ok('  stessi mercati scelti, nello stesso ordine',
    JSON.stringify(prima.rows.map((r) => r.marketId)) === JSON.stringify(dopo.rows.map((r) => r.marketId)),
    dopo.rows.map((r) => r.marketId).join(','));
  ok('  stesso capitale allocato per riga',
    JSON.stringify(prima.rows.map((r) => r.capital)) === JSON.stringify(dopo.rows.map((r) => r.capital)));
  ok('  stesso lordo di portafoglio', prima.totalGrossPerDay === dopo.totalGrossPerDay);
  ok('  stessi scarti per orizzonte',
    JSON.stringify([...prima.horizonRejected].sort()) === JSON.stringify([...dopo.horizonRejected].sort()),
    dopo.horizonRejected.join(','));
  ok('  e SAFE dichiara la regola storica, non quella del pavimento', dopo.minTimeToCloseRule === null);

  // La prova che il test non è vuoto: su questo universo il filtro Safe DEVE aver scartato qualcosa,
  // altrimenti l'uguaglianza sopra sarebbe l'uguaglianza fra due insiemi vuoti.
  ok('il confronto non è vuoto: SAFE ha davvero scartato i due mercati corti',
    prima.horizonRejected.length === 2
    && prima.horizonRejected.includes('CORTO') && prima.horizonRejected.includes('MORENTE'),
    prima.horizonRejected.join(','));
}

console.log('\n══ SENZA PROFILO IL RAMO È LETTERALMENTE QUELLO DI PRIMA');
{
  const senza = planAllocation({ ...base, horizonFilter: true });
  const esplicitoNull = planAllocation({ ...base, horizonFilter: true, minTimeToCloseRule: null });
  let uguali = true;
  try { assert.deepStrictEqual(esplicitoNull, senza); } catch { uguali = false; }
  ok('minTimeToCloseRule:null ≡ opzione assente', uguali);

  const spento = planAllocation({ ...base, horizonFilter: false });
  ok('col filtro spento non si scarta nulla (comportamento storico invariato)',
    spento.horizonRejected.length === 0);
  ok('  e tutti e tre i mercati restano candidati', spento.candidates.length === 3, String(spento.candidates.length));
}

console.log('\n══ IL PROFILO RISK CAMBIA LA REGOLA, NON IL FILTRO');
{
  const risk = planAllocation({ ...base, horizonFilter: true, minTimeToCloseRule: RULE_VENUE_FLOOR });
  const safe = planAllocation({ ...base, horizonFilter: true });

  ok('RISK ammette il mercato che chiude fra 45 minuti', !risk.horizonRejected.includes('CORTO'),
    risk.horizonRejected.join(','));
  ok('  che SAFE invece scartava', safe.horizonRejected.includes('CORTO'));
  ok('RISK scarta comunque quello sotto il pavimento del venue', risk.horizonRejected.includes('MORENTE'));
  ok('  e scarta SOLO quello', risk.horizonRejected.length === 1, risk.horizonRejected.join(','));
  ok('il mercato lungo passa in entrambi',
    !risk.horizonRejected.includes('LUNGO') && !safe.horizonRejected.includes('LUNGO'));
  ok('RISK dichiara la sua regola nel referto', risk.minTimeToCloseRule === RULE_VENUE_FLOOR);

  // ── LA DIFFERENZA È SOLO L'INSIEME, NON L'ARITMETICA ────────────────────────────────────────────
  // Stessa unità, stesso offset, stesso tetto, stesso budget: se un giorno un profilo cominciasse a
  // dimensionare diversamente, questo assert è dove si vedrebbe.
  ok('stessa unità di allocazione', risk.unitUsd === safe.unitUsd);
  ok('stesso offset', risk.offsetCents === safe.offsetCents);
  ok('stesso budget', risk.budgetUsd === safe.budgetUsd);
  const rLungo = risk.rows.find((r) => r.marketId === 'LUNGO');
  const sLungo = safe.rows.find((r) => r.marketId === 'LUNGO');
  // ── ATTENZIONE A COSA *DEVE* CAMBIARE ───────────────────────────────────────────────────────────
  // Il capitale per riga cambia fra i due piani, ed è CORRETTO che cambi: sotto RISK il knapsack ha
  // due mercati fra cui dividere lo stesso budget invece di uno. Confrontare `capital` o `grossPerDay`
  // qui vorrebbe dire pretendere che ammettere un mercato in più non sposti l'allocazione — cioè
  // pretendere che il profilo non serva a niente.
  //
  // Ciò che NON deve cambiare è l'aritmetica indipendente dal capitale: dove si mette l'ordine, su che
  // griglia, a che mid. Se un giorno un profilo cominciasse a quotare a un offset suo, è qui che si
  // vedrebbe.
  ok('un mercato presente in ENTRAMBI i piani è quotato allo stesso modo',
    !!rLungo && !!sLungo
    && rLungo.snappedBid === sLungo.snappedBid
    && rLungo.snappedAsk === sLungo.snappedAsk
    && rLungo.tick === sLungo.tick
    && rLungo.offsetCents === sLungo.offsetCents,
    rLungo && sLungo ? `risk ${rLungo.snappedBid}/${rLungo.snappedAsk} · safe ${sLungo.snappedBid}/${sLungo.snappedAsk}` : 'riga assente');
  ok('  e il capitale per riga INVECE cambia, perché i mercati ammessi sono due invece di uno',
    !!rLungo && !!sLungo && rLungo.capital !== sLungo.capital,
    rLungo && sLungo ? `risk $${rLungo.capital} · safe $${sLungo.capital}` : '');
}

console.log('\n══ SCADENZA ILLEGGIBILE: NESSUN PROFILO LA TRATTA COME CORTA');
{
  const senzaDate = new Map(); // nessuna scadenza per nessuno
  const risk = planAllocation({ ...base, endDateByMarket: senzaDate, horizonFilter: true, minTimeToCloseRule: RULE_VENUE_FLOOR });
  ok('RISK non scarta un mercato di cui non sa la scadenza', risk.horizonRejected.length === 0);
  const safe = planAllocation({ ...base, endDateByMarket: senzaDate, horizonFilter: true });
  ok('e nemmeno SAFE', safe.horizonRejected.length === 0);
}

console.log('\n══ LA NOTA SOTTO IL BOTTONE È GENERATA DAI VALORI VERI');
{
  const d = differenzeProfili();
  ok('quattro voci', d.length === 4, String(d.length));
  const scad = d[0];
  ok('la voce scadenza porta il numero reale del venue',
    scad.risk.includes(String(VENUE_GTD_MIN_FUTURE_SEC)) && scad.risk.includes(String(VENUE_FLOOR_MINUTES)),
    scad.risk);
  ok('e quello reale della soglia Safe',
    scad.safe.includes(String(MIN_HORIZON_DAYS)) && scad.safe.includes(String(SAFE_FLOOR_MINUTES / 60)),
    scad.safe);
  ok('la voce staleness porta i 300 s reali',
    d[2].voce.includes(String(STALE_SECONDS)), d[2].voce);
  ok('e la nota dichiara che il motore di esecuzione è identico',
    d[3].risk.includes('IDENTICO'), d[3].risk);
  ok('nessuna voce contiene un segnaposto',
    !JSON.stringify(d).match(/TODO|XXX|placeholder|N\/A/i));
}

console.log(`\nprofili dell'allocatore: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

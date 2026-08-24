'use strict';
// lib/maker/cap-2400-e-slot.test.js — IL CAP A $2.400 E I DICIOTTO SLOT. 23 agosto 2026.
//
// ═══ COSA SI DIFENDE, E PERCHE' NON E' UNA FOTOGRAFIA DEL NUMERO ═════════════════════════════════
// Le cifre ($2.400, 19, 18) sono decisioni dell'operatore e cambieranno ancora. Cio' che NON deve
// cambiare e' la catena di relazioni che le tiene insieme, e che se salta produce il guasto gia'
// misurato due volte in questo repo (16 agosto, $150 contro 3 x $61,25; 22 agosto, i quindici slot):
// **il gate smette di piazzare a meta' strada**, perche' `evaluateLimits` confronta
// `openNotionalUsd + notional` anche sulle APERTURE.
//
//   ① N x 2 x tetto per mercato <= cap versionato        ← l'invariante di §5.2 p.37
//   ② il cap versionato non viene CLAMPATO dal tetto duro ← il modo silenzioso in cui ① puo' mentire
//   ③ il numero scritto nell'ambiente e' ESPRIMIBILE      ← oltre il soffitto vale il difetto, in silenzio
//   ④ la composizione derivata offre esattamente N posti
//
// ⚠ IL BLOCCO ① E' SCRITTO COME L'OPERATORE L'HA CHIESTO: «DEVE reggere a N=19 e fallire a N=20».
// Le due meta' contano uguale — un'invariante che regge sempre non e' un'invariante, e' una tautologia:
// senza il caso che FALLISCE non si distingue «il cap copre 19» da «il confronto e' sempre vero».
//
// ⚠ ROSSO SUL SORGENTE PRECEDENTE, verificato: col cap a $1.470 il blocco ① fallisce a N=19
// ($2.327,50 > $1.470) e il blocco ③ fallisce perche' '18' oltre il soffitto 12 vale il difetto.

const SEL = require('./selezione-mercati');
const QM = require('./quanti-mercati');
const CONC = require('../rewards/concentration');
const RL = require('../safety/risk-limits');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra = '') {
  if (cond) { passati += 1; console.log(`  ok    ${nome}`); }
  else { falliti += 1; console.log(`  FAIL  ${nome}${extra ? ' — ' + extra : ''}`); }
}

const TETTO = CONC.MARKET_CAP_FIXED_USD;
const eff = RL.resolveLimits({ userId: 'op' });
const CAP = (eff && eff.ok && Number.isFinite(eff.limits.maxOpenNotionalUsd))
  ? eff.limits.maxOpenNotionalUsd : null;

// ── ① L'INVARIANTE, NEI DUE VERSI ───────────────────────────────────────────────────────────────
console.log('\n① N x 2 x tetto <= cap: regge a 19, fallisce a 20');
ok('il cap EFFETTIVO e leggibile (illeggibile ⇒ ogni piazzamento fallisce chiuso)', CAP !== null);
ok('  e il tetto per mercato e finito', Number.isFinite(TETTO) && TETTO > 0, String(TETTO));
{
  const a19 = CONC.esposizioneMassimaRaggiungibileUsd(19);
  const a20 = CONC.esposizioneMassimaRaggiungibileUsd(20);
  ok(`19 x 2 x $${TETTO} = $${a19} <= cap $${CAP}`, CAP !== null && a19 <= CAP,
    `${a19} > ${CAP}: il gate murerebbe la gestione a meta' strada`);
  // ⚠ LA META' CHE CONTA: senza questa, ① sarebbe vera anche con un cap infinito.
  ok(`20 x 2 x $${TETTO} = $${a20} >  cap $${CAP}, cioe' l'invariante MORDE`, CAP !== null && a20 > CAP,
    `${a20} <= ${CAP}: il cap non e' piu' un limite a N=20, e questo test non prova piu' niente`);
  // ⚠⚠ IL «SOFFITTO DI SORGENTE» NON ESISTE PIU' DAL 24 AGOSTO 2026, e questa asserzione e' stata
  // RISCRITTA, non tolta. Prima c'era `SEL.MAX_MERCATI_CONTEMPORANEI`, cioe' un letterale che doveva
  // restare allineato al cap a mano: due numeri per una relazione sola, il reperto D1 su una
  // decisione di capitale. Adesso il massimo che il cap autorizza si CALCOLA, e la proprieta' e'
  // che quel calcolo sia esattamente il cancello che ferma i processi all'avvio.
  const S = Math.floor(CAP / (2 * TETTO));
  ok(`  il massimo che il cap autorizza si CALCOLA dal cap: ${S}`,
    Number.isInteger(S) && S >= 1 && CONC.esposizioneMassimaRaggiungibileUsd(S) <= CAP,
    `${CONC.esposizioneMassimaRaggiungibileUsd(S)} > ${CAP}`);
  ok(`  e uno slot in piu' (${S + 1}) NON ci starebbe: e' un massimo, non una scelta`,
    CONC.esposizioneMassimaRaggiungibileUsd(S + 1) > CAP,
    `${CONC.esposizioneMassimaRaggiungibileUsd(S + 1)} <= ${CAP}`);
  // ⚠ E IL CANCELLO VERO LO SA: l'invariante d'avvio passa a S e SOLLEVA a S+1.
  const INV = require('../safety/invariante-cap-slot');
  ok(`  l'invariante d'avvio passa a N=${S}`,
    INV.misuraInvariante({ env: { MAKER_MERCATI_CONTEMPORANEI: String(S) } }).ok === true);
  if (S + 1 <= SEL.LIMITE_SLOT.max) {
    ok(`  e NON passa a N=${S + 1}`,
      INV.misuraInvariante({ env: { MAKER_MERCATI_CONTEMPORANEI: String(S + 1) } }).ok === false);
  } else {
    ok(`  e N=${S + 1} e' gia' fuori dal range sintattico (max ${SEL.LIMITE_SLOT.max}): SOLLEVA prima`,
      (() => { try { QM.quantiMercati({ MAKER_MERCATI_CONTEMPORANEI: String(S + 1) }); return false; } catch { return true; } })());
  }
}

// ── ② IL CLAMP SILENZIOSO ───────────────────────────────────────────────────────────────────────
console.log('\n② il cap scritto su disco e quello IN SERVIZIO sono lo stesso numero');
// ⚠ `clampNum` fa `min(disco, tetto duro)` e NON solleva: un tetto duro rimasto indietro rende ①
// una verifica su un numero che il gate non applica — la forma peggiore di falso verde.
{
  const fs = require('fs'); const path = require('path');
  let suDisco = null;
  try {
    suDisco = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'safety-risk-limits.json'), 'utf8'))
      .global.maxOpenNotionalUsd;
  } catch { suDisco = null; }
  ok('il cap su disco e leggibile', Number.isFinite(suDisco), String(suDisco));
  ok(`  e coincide con quello effettivo ($${suDisco} = $${CAP}): nessun clamp silenzioso`,
    suDisco === CAP, `disco ${suDisco} != servizio ${CAP}: HARD_CEILINGS lo sta tagliando`);
  ok('  il tetto duro resta un tetto: rifiuta ancora un cap piu' + "' alto",
    RL.HARD_CEILINGS.maxOpenNotionalUsd >= CAP,
    `${RL.HARD_CEILINGS.maxOpenNotionalUsd} < ${CAP}`);
  // ⚠ NESSUN ALTRO TETTO DURO SI E' MOSSO: si alza lo stretto necessario, mai «tanto».
  ok('  e gli altri tetti duri sono intatti (ordine 1000 · finestra 60 · perdita 200)',
    RL.HARD_CEILINGS.maxOrderNotionalUsd === 1000 && RL.HARD_CEILINGS.maxOrdersPerWindow === 60
    && RL.HARD_CEILINGS.maxDailyLossUsd === 200);
  ok('  il kill sulla perdita giornaliera resta $100, non toccato', eff.limits.maxDailyLossUsd === 100);
}

// ── ③ IL NUMERO IN SERVIZIO E' ESPRIMIBILE ──────────────────────────────────────────────────────
console.log('\n③ il numero scritto in ecosystem.config.js e ACCETTATO, non ridotto al difetto');
// ⚠ E' IL BLOCCO CHE HA TROVATO IL GUASTO DEL 18 AGOSTO: allora `quantiMercati` rispondeva col
// DIFETTO invece che con un errore, quindi scrivere 18 con un soffitto a 12 dava un bot che girava a
// 12 mentre il config diceva 18, e nessuno se ne accorgeva. ⚠ DAL 24 AGOSTO 2026 QUEL DIFETTO NON
// C'E' PIU': un valore fuori range SOLLEVA e il processo non parte. Il blocco resta perche' la
// proprieta' da difendere e' la stessa — «cio' che e' scritto e' cio' che gira» — e adesso e' vera
// per costruzione invece che per controllo.
{
  const eco = require('../../agents/ecosystem.config.js');
  const a41 = (eco.apps || []).find((x) => x.name === 'agent41-realloc-scheduler');
  ok('agent41 e definito nell\'ecosystem', !!(a41 && a41.env));
  const scritto = a41 && a41.env ? a41.env.MAKER_MERCATI_CONTEMPORANEI : undefined;
  const r = QM.quantiMercati({ MAKER_MERCATI_CONTEMPORANEI: scritto });
  ok(`  "${scritto}" e accettato dall'ambiente, non ridotto al difetto`,
    r.fonte === 'ambiente' && String(r.quanti) === String(scritto), r.motivo);
  ok(`  e l'esposizione che autorizza ($${CONC.esposizioneMassimaRaggiungibileUsd(r.quanti)}) sta sotto il cap`,
    CONC.esposizioneMassimaRaggiungibileUsd(r.quanti) <= CAP);
  // ⚠ IL SOFFITTO E' UNA REGOLA DI RISCHIO, IL NUMERO IN SERVIZIO UNA DECISIONE SUL CAPITALE DI OGGI:
  // il secondo puo' stare sotto il primo (la cassa e' piu' stretta del cap), mai sopra.
  ok('  il numero in servizio sta dentro il range sintattico',
    r.quanti >= SEL.LIMITE_SLOT.min && r.quanti <= SEL.LIMITE_SLOT.max, `${r.quanti}`);
  ok('  e non supera il massimo che il cap autorizza',
    CONC.esposizioneMassimaRaggiungibileUsd(r.quanti) <= CAP,
    `${CONC.esposizioneMassimaRaggiungibileUsd(r.quanti)} > ${CAP}`);
  // ⚠ LA CASSA E' LA SECONDA GRANDEZZA, e il cap non la conosce: il piano compra le sorelle con
  // denaro vero. La PROPRIETA' e' che il residuo sia dichiarabile, non un valore fotografato.
  const SALDO_LETTO = 1391.57;   // agent41, mini-ciclo delle 10:58:36Z del 23/08 (dichiarato, non asserito)
  const PAVIMENTO_CASSA = 250;   // decisione dell'operatore, stesso messaggio
  ok(`  e con saldo $${SALDO_LETTO} la cassa residua a N=${r.quanti} resta sopra $${PAVIMENTO_CASSA}`,
    SALDO_LETTO - r.quanti * TETTO >= PAVIMENTO_CASSA,
    `residua $${(SALDO_LETTO - r.quanti * TETTO).toFixed(2)}`);
  ok(`  mentre a N=${r.quanti + 1} NON ci starebbe: e' per questo che il servizio sta sotto il soffitto`,
    SALDO_LETTO - (r.quanti + 1) * TETTO < PAVIMENTO_CASSA,
    `residua $${(SALDO_LETTO - (r.quanti + 1) * TETTO).toFixed(2)}: il pavimento di cassa non e' il vincolo che morde`);
}

// ── ④ LA COMPOSIZIONE DERIVATA ──────────────────────────────────────────────────────────────────
console.log('\n④ la quota per scaglione si DERIVA da N e offre esattamente N posti');
for (const N of [3, 12, 18, 19]) {
  const q = SEL.quotaScaglioni(N);
  const posti = q.reduce((a, b) => a + b.posti, 0);
  const bassi = q.find((x) => x.chiave === 'basso');
  const alti = q.find((x) => x.chiave === 'alto');
  ok(`  N=${N} ⇒ ${bassi ? bassi.posti : 0} basso + ${alti ? alti.posti : 0} alto = ${posti} posti`,
    posti === N, `posti ${posti} != ${N}`);
  if (N >= 2) {
    ok(`    e il basso e round(N/3) = ${Math.max(1, Math.min(N - 1, Math.round(N / 3)))}`,
      bassi.posti === Math.max(1, Math.min(N - 1, Math.round(N / 3))), String(bassi.posti));
  }
}
// ⚠ LA QUOTA NON GOVERNA IL CAPITALE, e per questo attraversare un secchio e ammissibile (§4.13):
// il tetto per mercato e lo stesso nei due secchi, quindi `N x 2 x tetto` non contiene la quota.
ok('  la quota non compare in N x 2 x tetto: il capitale non dipende dai secchi',
  [3, 12, 18, 19].every((n) => CONC.esposizioneMassimaRaggiungibileUsd(n) === n * 2 * TETTO));

console.log(`\ncap $${CAP} e slot: ${passati} passati, ${falliti} falliti\n`);
process.exit(falliti === 0 ? 0 : 1);

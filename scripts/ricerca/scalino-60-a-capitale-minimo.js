#!/usr/bin/env node
'use strict';
/**
 * LO SCALINO DEL 60% A CAPITALE MINIMO — quante gambe restano piazzabili. Sola lettura.
 *
 * ═══ LA DOMANDA DELL'OPERATORE (17 agosto 2026) ══════════════════════════════════════════════════════
 * «Con capitale minimo, quante gambe superano la soglia del 60%? Se il conto ne produce zero, il giro si
 * ferma al passo 3 e voglio il numero.»
 *
 * ⚠ NIENTE E' RICALCOLATO QUI. La soglia e' `realistic-estimate.DEFAULTS.maxCredibleShare`, il verdetto
 * e' `profondita-minima.verdettoProfondita`, la size viene da `size-da-capitale.sharePerLato` e il
 * pavimento da `concentration.pavimentoPremiante`: quattro funzioni di produzione, importate. Una
 * seconda idea di «quota credibile» sarebbe il reperto D1 su una decisione di capitale.
 *
 * ⚠ «CAPITALE MINIMO» NON E' UN NUMERO SOLO, e usarne uno solo darebbe una risposta finta:
 *   · il minimo per QUEL mercato e' `pavimentoPremiante(minSize)` — sotto, il reward e' ZERO (§4.2);
 *   · il tetto per mercato ($61,25) e' il massimo che il piano puo' mettere su uno;
 *   · $500 e' il capitale di RIFERIMENTO con cui il board pubblica le quote, e serve da riscontro.
 * Si riportano tutti e tre: la quota cresce col capitale, quindi «superano la soglia» e' una funzione
 * decrescente del capitale, e il numero che conta e' quello al minimo.
 *
 * ⚠ E SI CONTA PER GAMBA, NON PER MERCATO: la profondita' in banda dei due lati e' diversa (misurato:
 * yes 158 / no 124 sullo stesso mercato), quindi un mercato puo' avere una gamba credibile e l'altra no.
 * Contare i mercati mediando i due lati nasconderebbe proprio il caso che decide.
 *
 * Uso:  node scripts/ricerca/scalino-60-a-capitale-minimo.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'ricerca', 'scalino-60-a-capitale-minimo.json');

const { verdettoProfondita } = require(path.join(ROOT, 'lib/rewards/profondita-minima'));
const { DEFAULTS } = require(path.join(ROOT, 'lib/rewards/realistic-estimate'));
const { sharePerLato, COSTO_COPPIA_TIPICO } = require(path.join(ROOT, 'lib/rewards/size-da-capitale'));
const CONC = require(path.join(ROOT, 'lib/rewards/concentration'));
const { MAX_HORIZON_DAYS } = require(path.join(ROOT, 'lib/rewards/horizon'));

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
// Gli stessi vincoli di ammissibilita' della selezione (§4.13), come nel chooser del giro controllato.
const MIN_SIZE_MAX = 50;
const ORE_MIN = 24;
const METEO = /\b(rain|snow|temperature|weather|degrees|precipitation)\b/i;

(async () => {
  const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'liquidity-rewards.json'), 'utf8'));
  const ora = Date.now();
  const soglia = DEFAULTS.maxCredibleShare;
  const tetto = CONC.MARKET_CAP_FIXED_USD;

  const righe = [];
  const scartati = new Map();
  const scarta = (p) => scartati.set(p, (scartati.get(p) || 0) + 1);

  for (const r of board.markets || []) {
    const minSize = Number(r.rewardsMinSize);
    if (!fin(minSize) || minSize <= 0) { scarta('rewardsMinSize non leggibile'); continue; }
    if (minSize > MIN_SIZE_MAX) { scarta(`rewardsMinSize > ${MIN_SIZE_MAX}`); continue; }
    const pavimento = CONC.pavimentoPremiante(minSize);
    if (fin(pavimento) && pavimento > tetto) { scarta('pavimento premiante oltre il tetto per mercato'); continue; }
    if (r.scadenzaAmmissibile === false) { scarta('scadenza non ammissibile'); continue; }
    const fine = Date.parse(r.endDate || r.endDateClob || r.endDateGamma || '');
    if (!fin(fine)) { scarta('scadenza non determinabile'); continue; }
    const ore = (fine - ora) / 3_600_000;
    if (ore < ORE_MIN) { scarta(`scadenza sotto ${ORE_MIN} h`); continue; }
    if (ore / 24 > MAX_HORIZON_DAYS) { scarta('oltre l orizzonte massimo'); continue; }
    if (METEO.test(String(r.question || ''))) { scarta('famiglia meteo'); continue; }

    // La profondita' IN BANDA dei due lati, in share: il board la pubblica in DOLLARI, e le share si
    // ottengono dividendo per il prezzo del lato — la stessa identita' `Q = C/p` di `size-da-capitale`.
    const py = fin(r.mid) ? r.mid : null;
    const dy = r.sides && r.sides.yes ? Number(r.sides.yes.existing_depth_usd) : null;
    const dn = r.sides && r.sides.no ? Number(r.sides.no.existing_depth_usd) : null;
    const profondita = {
      yes: fin(dy) && fin(py) && py > 0 ? dy / py : null,
      no: fin(dn) && fin(py) && py < 1 ? dn / (1 - py) : null,
    };

    const costoCoppia = fin(r.pairCostUsd) ? r.pairCostUsd : null;
    // `sharePerLato` e' la formula unica capitale→share: Q = C/(p_yes+p_no), col tipico dichiarato
    // quando il costo della coppia non si legge (mai la vecchia `(C/2)/mid`, §4.4).
    const perDollaro = sharePerLato({ capitaleUsd: 1, pairCostUsd: costoCoppia });
    const sharePerUsd = perDollaro && fin(perDollaro.shares) ? perDollaro.shares : null;

    righe.push({ conditionId: r.conditionId, question: String(r.question || '').slice(0, 60),
      minSize, pavimentoUsd: fin(pavimento) ? +pavimento.toFixed(2) : null,
      mid: py, sharePerUsd, profondita,
      modelloCostoCoppia: perDollaro ? perDollaro.modello : null });
  }

  // I tre capitali, e per ognuno il verdetto PER GAMBA con la funzione di produzione.
  const scenari = [
    { nome: 'minimo del mercato (pavimentoPremiante(minSize))', perRiga: (x) => x.pavimentoUsd },
    { nome: `tetto per mercato ($${tetto})`, perRiga: () => tetto },
    { nome: 'riferimento del board ($500)', perRiga: () => 500 },
  ];

  const esiti = [];
  for (const sc of scenari) {
    let ok = 0; let sottile = 0; let ignota = 0; const mercatiOk = new Set(); const dettaglio = [];
    for (const x of righe) {
      const capitale = sc.perRiga(x);
      for (const lato of ['yes', 'no']) {
        const v = verdettoProfondita({
          sharePerUsd: x.sharePerUsd,
          depthShares: x.profondita[lato],
          capitaleRiferimentoUsd: capitale,
        });
        if (v.stato === 'ok') { ok += 1; mercatiOk.add(x.conditionId); }
        else if (v.stato === 'sottile') sottile += 1;
        else ignota += 1;
        if (dettaglio.length < 400) dettaglio.push({ conditionId: x.conditionId, lato, capitale,
          quota: v.quota, stato: v.stato });
      }
    }
    esiti.push({ scenario: sc.nome, gambeOk: ok, gambeSottili: sottile, gambeIgnote: ignota,
      mercatiConAlmenoUnaGambaOk: mercatiOk.size, dettaglio });
  }

  const referto = { generatoIl: new Date().toISOString(),
    boardGeneratoIl: board.meta && board.meta.generatedAt,
    soglia, costoCoppiaTipico: COSTO_COPPIA_TIPICO, tettoPerMercatoUsd: tetto,
    righeBoard: (board.markets || []).length, ammissibili: righe.length,
    gambeAmmissibili: righe.length * 2,
    scartatiPerMotivo: [...scartati].sort((a, b) => b[1] - a[1]).map(([motivo, n]) => ({ motivo, n })),
    esiti };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(referto, null, 1));

  console.log(`\nboard del ${referto.boardGeneratoIl} · ${referto.righeBoard} righe`);
  console.log(`soglia della quota credibile: ${(soglia * 100).toFixed(0)}%  (da realistic-estimate.DEFAULTS)`);
  console.log(`ammissibili ai vincoli della selezione: ${righe.length} mercati = ${righe.length * 2} gambe\n`);
  for (const e of esiti) {
    console.log(`── capitale ${e.scenario}`);
    console.log(`   gambe SOTTO la soglia (piazzabili) : ${e.gambeOk}`);
    console.log(`   gambe OLTRE la soglia (escluse)    : ${e.gambeSottili}`);
    console.log(`   gambe con quota NON calcolabile    : ${e.gambeIgnote}`);
    console.log(`   mercati con almeno una gamba buona : ${e.mercatiConAlmenoUnaGambaOk}\n`);
  }
  console.log(`referto → ${path.relative(ROOT, OUT)}`);
})();

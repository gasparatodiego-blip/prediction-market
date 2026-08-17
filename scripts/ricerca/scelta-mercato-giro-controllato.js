#!/usr/bin/env node
'use strict';
/**
 * IL MERCATO DEL GIRO CONTROLLATO — sola lettura, nessuna scrittura fuori da data/ricerca/.
 *
 * LA RICHIESTA DELL'OPERATORE (17 agosto 2026): «scegli tu il migliore per NETTO fra gli ammissibili
 * — poche centinaia di share di concorrenza, non decine di migliaia».
 *
 * ⚠ I VINCOLI DI AMMISSIBILITA' NON SI RISCRIVONO QUI: sono quelli di §4.13, e questo script li
 * applica leggendo il board con le STESSE soglie che `selezione-mercati` usa in produzione. Una
 * seconda idea di «ammissibile» sarebbe il reperto D1 applicato a una decisione di capitale.
 *
 * ⚠ «CONCORRENZA IN SHARE» NON E' NEL BOARD, e va derivata: il board porta `existing_depth_usd`, cioe'
 * DOLLARI di profondita' del libro. Le share si ottengono dividendo per il prezzo del lato — e' la
 * stessa identita' `Q = C/p` di `size-da-capitale`. Si riporta ENTRAMBI i numeri, perche' la soglia
 * che l'operatore ha in mente e' in share e il dato di partenza e' in dollari.
 *
 * Uso:  node scripts/ricerca/scelta-mercato-giro-controllato.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'ricerca', 'scelta-mercato-giro-controllato.json');

const { MIN_HORIZON_DAYS, MAX_HORIZON_DAYS } = require(path.join(ROOT, 'lib', 'rewards', 'horizon'));
const CONC = require(path.join(ROOT, 'lib', 'rewards', 'concentration'));

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// I vincoli della selezione automatica (§4.13), letti dal modulo puro quando esporta le costanti e
// dichiarati qui quando non lo fa. Ogni numero porta la ragione accanto.
const MIN_SIZE_MAX = 50;          // `rewardsMinSize ≤ 50`: sopra, il pavimento premiante sfonda il tetto
const ORE_MIN = 24;               // scadenza ≥ 24 h (decisione del 16 agosto: 168 → 24)
const METEO = /\b(rain|snow|temperature|weather|degrees|precipitation)\b/i;

(async () => {
  const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'liquidity-rewards.json'), 'utf8'));
  const ora = Date.now();
  const tetto = CONC.MARKET_CAP_FIXED_USD;

  const scartati = new Map();
  const scarta = (m, perche) => { scartati.set(perche, (scartati.get(perche) || 0) + 1); return null; };

  const candidati = [];
  for (const r of board.markets || []) {
    const minSize = Number(r.rewardsMinSize);
    // ⚠ `Number(null) === 0` — sesta occorrenza nel repo, e qui varrebbe «il piu' finanziabile di
    // tutti». Un pavimento premiante che non si legge ESCLUDE.
    if (!fin(minSize) || minSize <= 0) { scarta(r, 'rewardsMinSize non leggibile'); continue; }
    if (minSize > MIN_SIZE_MAX) { scarta(r, `rewardsMinSize > ${MIN_SIZE_MAX}`); continue; }

    const pavimento = CONC.pavimentoPremiante(minSize);
    if (fin(pavimento) && pavimento > tetto) { scarta(r, 'pavimento premiante oltre il tetto per mercato'); continue; }

    // Scadenza: si usa il verdetto che il board ha GIA' calcolato (tre fonti, §4.7), non una quarta idea.
    if (r.scadenzaAmmissibile === false) { scarta(r, `scadenza non ammissibile (${r.scadenzaMotivo || '?'})`); continue; }
    const fine = Date.parse(r.endDate || r.endDateClob || r.endDateGamma || '');
    if (!fin(fine)) { scarta(r, 'scadenza non determinabile'); continue; }
    const ore = (fine - ora) / 3_600_000;
    if (ore < ORE_MIN) { scarta(r, `scadenza sotto ${ORE_MIN} h`); continue; }
    if (ore / 24 > MAX_HORIZON_DAYS) { scarta(r, 'oltre l orizzonte massimo'); continue; }

    if (METEO.test(String(r.question || ''))) { scarta(r, 'famiglia meteo'); continue; }

    const liv = r.levels && r.levels['500'] ? r.levels['500'] : null;
    if (!liv || !fin(liv.netRewardDay)) { scarta(r, 'netto a $500 non calcolabile'); continue; }

    // La concorrenza IN SHARE, derivata dai dollari del board. Si prende il lato PEGGIORE (il piu'
    // affollato dei due): e' quello che decide se «poche centinaia» e' vero per il mercato, non per
    // una sua meta' fortunata.
    const py = fin(r.mid) ? r.mid : null;
    const dy = r.sides && r.sides.yes ? Number(r.sides.yes.existing_depth_usd) : null;
    const dn = r.sides && r.sides.no ? Number(r.sides.no.existing_depth_usd) : null;
    const qy = fin(dy) && fin(py) && py > 0 ? dy / py : null;
    const qn = fin(dn) && fin(py) && py < 1 ? dn / (1 - py) : null;
    const qPeggiore = [qy, qn].filter(fin).length ? Math.max(...[qy, qn].filter(fin)) : null;

    candidati.push({
      conditionId: r.conditionId, question: String(r.question || '').slice(0, 78),
      categoria: r.category, minSize, tick: r.tickSize, mid: r.mid,
      bandaCents: r.rewardsMaxSpread, montepremiGiorno: r.rewardsDailyRate,
      oreAllaScadenza: +ore.toFixed(1),
      nettoGiornoA500: +Number(liv.netRewardDay).toFixed(3),
      quotaA500: liv.share,
      concorrenzaUsdYes: fin(dy) ? Math.round(dy) : null,
      concorrenzaUsdNo: fin(dn) ? Math.round(dn) : null,
      concorrenzaShareYes: fin(qy) ? Math.round(qy) : null,
      concorrenzaShareNo: fin(qn) ? Math.round(qn) : null,
      concorrenzaSharePeggiore: fin(qPeggiore) ? Math.round(qPeggiore) : null,
      pavimentoPremianteUsd: fin(pavimento) ? +pavimento.toFixed(2) : null,
      bestBid: r.bestBid, bestAsk: r.bestAsk, negRisk: r.negRisk,
      tokenId: r.tokenId, tokenIdNo: r.tokenIdNo,
    });
  }

  // ⚠ L'ORDINAMENTO E' PER NETTO, non per montepremi: §5 p.132 — il montepremi vive sui `minSize`
  // grandi, che sono esattamente quelli fuori dalla nostra portata.
  candidati.sort((a, b) => b.nettoGiornoA500 - a.nettoGiornoA500
    || String(a.conditionId).localeCompare(String(b.conditionId)));

  // La fascia che l'operatore ha chiesto: poche centinaia di share, non decine di migliaia.
  const SOGLIA_SHARE = 5_000;
  const inFascia = candidati.filter((c) => fin(c.concorrenzaSharePeggiore) && c.concorrenzaSharePeggiore <= SOGLIA_SHARE);

  const referto = {
    generatoIl: new Date().toISOString(),
    boardGeneratoIl: board.meta && board.meta.generatedAt,
    tettoPerMercatoUsd: tetto,
    vincoli: { minSizeMax: MIN_SIZE_MAX, oreMin: ORE_MIN, orizzonteMaxGiorni: MAX_HORIZON_DAYS,
      sogliaConcorrenzaShare: SOGLIA_SHARE, orizzonteMinGiorniModulo: MIN_HORIZON_DAYS },
    righeBoard: (board.markets || []).length,
    ammissibili: candidati.length,
    inFasciaDiConcorrenza: inFascia.length,
    scartatiPerMotivo: [...scartati].sort((a, b) => b[1] - a[1]).map(([motivo, n]) => ({ motivo, n })),
    scelto: inFascia[0] || null,
    primi10Ammissibili: candidati.slice(0, 10),
    primi10InFascia: inFascia.slice(0, 10),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(referto, null, 1));

  console.log(`board del ${referto.boardGeneratoIl} · ${referto.righeBoard} righe`);
  console.log(`ammissibili ${candidati.length} · in fascia di concorrenza (≤ ${SOGLIA_SHARE} share) ${inFascia.length}\n`);
  console.log('scartati:');
  for (const s of referto.scartatiPerMotivo) console.log(`  ${String(s.n).padStart(4)}  ${s.motivo}`);

  const riga = (c, i) => `${String(i + 1).padStart(2)}. $${String(c.nettoGiornoA500).padStart(7)}/g`
    + ` · conc ${String(c.concorrenzaSharePeggiore).padStart(7)} sh`
    + ` · minSize ${String(c.minSize).padStart(3)} · banda ${c.bandaCents}c · tick ${c.tick}`
    + ` · ${String(c.oreAllaScadenza).padStart(6)} h · ${c.question.slice(0, 46)}`;
  console.log('\n── i migliori per NETTO fra gli ammissibili ──');
  referto.primi10Ammissibili.forEach((c, i) => console.log(riga(c, i)));
  console.log(`\n── e fra quelli con concorrenza ≤ ${SOGLIA_SHARE} share ──`);
  referto.primi10InFascia.forEach((c, i) => console.log(riga(c, i)));
  if (referto.scelto) {
    console.log(`\n★ SCELTO: ${referto.scelto.question}`);
    console.log(`  ${referto.scelto.conditionId}`);
    console.log(`  netto $${referto.scelto.nettoGiornoA500}/g · concorrenza ${referto.scelto.concorrenzaSharePeggiore} share`
      + ` (yes ${referto.scelto.concorrenzaShareYes} / no ${referto.scelto.concorrenzaShareNo})`);
    console.log(`  minSize ${referto.scelto.minSize} · pavimento premiante $${referto.scelto.pavimentoPremianteUsd}`
      + ` · banda ±${referto.scelto.bandaCents}c · tick ${referto.scelto.tick} · mid ${referto.scelto.mid}`);
    console.log(`  scade fra ${referto.scelto.oreAllaScadenza} h · negRisk ${referto.scelto.negRisk}`);
  }
  console.log(`\nscritto ${path.relative(ROOT, OUT)}`);
})();

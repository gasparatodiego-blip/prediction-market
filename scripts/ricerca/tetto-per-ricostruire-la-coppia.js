#!/usr/bin/env node
'use strict';
/**
 * QUALE TETTO PER MERCATO RENDE RICOSTRUIBILE UNA COPPIA — sola misura, sul board vero.
 *
 * ═══ LA DOMANDA DELL'OPERATORE (17 agosto 2026) ══════════════════════════════════════════════════════
 * «Se ancora non passa, NON allargare il tetto: dimmi di quanto sarebbe sforato e quale valore di tetto
 * renderebbe ricostruibile la coppia nel caso peggiore misurato sul board vero.»
 *
 * ═══ IL FATTO DA CUI NASCE, misurato dal banco ══════════════════════════════════════════════════════
 * Il ripristino della gamba morta e' rifiutato da `nozionale-mercato-oltre-tetto`:
 *     gamba YES superstite   87,5 share × $0,32 = $28,00
 *     gamba NO da rimettere   62,2 share × $0,63 = $39,17
 *     totale $67,17  contro un tetto di $61,25  ⇒  SFORO $5,92
 *
 * ⚠ LA CAUSA NON E' IL TETTO: E' L'ASIMMETRIA DELLE DUE GAMBE. Una coppia SIMMETRICA costa, per
 * costruzione, esattamente il capitale del mercato: il piano dimensiona `Q = C/(p_yes+p_no)`, quindi
 * `Q·(p_yes+p_no) = C`. Non puo' sfondare il tetto. Qui le due gambe hanno SIZE DIVERSE — 87,5 contro
 * 62,2 — perche' il riprezzo ha inseguito il mid e ha ricalcolato la size della gamba viva, mentre il
 * ripristino dimensiona quella mancante sul piano corrente. Due sizing diversi sulla stessa coppia.
 *
 * ═══ I DUE NUMERI CHE QUESTO SCRIPT MISURA ══════════════════════════════════════════════════════════
 *   ① il tetto che servirebbe per ricostruire la coppia ALLA SIZE DELLA GAMBA SUPERSTITE, cioe'
 *      `Q_superstite · (p_yes + p_no)`. E' il numero pertinente al caso misurato;
 *   ② il LIMITE SUPERIORE sul board vero: la gamba superstite puo' arrivare, sotto il tetto attuale, a
 *      `tetto / p_min` share (il lato piu' economico e' quello che compra piu' share con lo stesso
 *      nozionale). La coppia a quella size costa `tetto · (p_yes+p_no)/p_min`. E' un limite superiore,
 *      non una previsione — e serve a dire quanto puo' andare male, non quanto andra'.
 *
 * ⚠ E LA CONCLUSIONE CHE NE SEGUE VA DETTA PRIMA DEI NUMERI: nessuno di questi due valori e' una
 * proposta. Alzare il tetto per far entrare una coppia asimmetrica significa autorizzare la size che
 * l'asimmetria ha prodotto, non correggerla. La cura sta a monte — ricostruire la COPPIA e non la gamba,
 * o non cambiare la size nel riprezzo — e questi numeri servono a misurare il costo di NON farla.
 *
 * Uso:  node scripts/ricerca/tetto-per-ricostruire-la-coppia.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'ricerca', 'tetto-per-ricostruire-la-coppia.json');

const CONC = require(path.join(ROOT, 'lib/rewards/concentration'));
const SELM = require(path.join(ROOT, 'lib/maker/selezione-mercati'));
const { MAX_HORIZON_DAYS } = require(path.join(ROOT, 'lib/rewards/horizon'));

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

// Il caso misurato dal banco, alla lettera: serve come riscontro del conto ①.
const CASO_BANCO = { sizeSuperstite: 87.5, pSuperstite: 0.32, pMancante: 0.63,
  aRiposoUsd: 28.00, gambaMancanteUsd: 39.17 };

(async () => {
  const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'liquidity-rewards.json'), 'utf8'));
  const ora = Date.now();
  const tetto = CONC.MARKET_CAP_FIXED_USD;

  // ① il caso misurato
  const coppiaSimmetricaAllaSuperstite = CASO_BANCO.sizeSuperstite * (CASO_BANCO.pSuperstite + CASO_BANCO.pMancante);
  const sforoMisurato = (CASO_BANCO.aRiposoUsd + CASO_BANCO.gambaMancanteUsd) - tetto;

  // ② il limite superiore sul board vero, mercato per mercato
  const righe = [];
  for (const r of board.markets || []) {
    const minSize = Number(r.rewardsMinSize);
    if (!fin(minSize) || minSize <= 0 || minSize > 50) continue;
    const pav = CONC.pavimentoPremiante(minSize);
    if (fin(pav) && pav > tetto) continue;
    if (SELM.valutaAmmissibilita(r, { ora, orizzonteMassimoOre: MAX_HORIZON_DAYS * 24 }).ammissibile !== true) continue;
    const py = fin(r.mid) ? r.mid : null;
    if (py == null || py <= 0 || py >= 1) continue;
    const pn = +(1 - py).toFixed(6);
    const pMin = Math.min(py, pn);
    const coppia = py + pn;                       // ≈ 1 sul board (il costo vero della coppia e' ~0,98)
    const sizeMax = tetto / pMin;                 // la size che la gamba superstite puo' raggiungere
    righe.push({ conditionId: r.conditionId, question: String(r.question || '').slice(0, 52),
      minSize, mid: +py.toFixed(4), pMin: +pMin.toFixed(4),
      sizeMassimaGambaSuperstite: +sizeMax.toFixed(1),
      tettoNecessarioUsd: +(sizeMax * coppia).toFixed(2),
      rapportoSulTettoAttuale: +((sizeMax * coppia) / tetto).toFixed(2) });
  }
  righe.sort((a, b) => b.tettoNecessarioUsd - a.tettoNecessarioUsd);
  const mediana = righe.length ? righe[Math.floor(righe.length / 2)].tettoNecessarioUsd : null;

  const referto = { generatoIl: new Date().toISOString(),
    boardGeneratoIl: board.meta && board.meta.generatedAt,
    tettoAttualeUsd: tetto,
    casoMisuratoDalBanco: { ...CASO_BANCO,
      totaleTentatoUsd: +(CASO_BANCO.aRiposoUsd + CASO_BANCO.gambaMancanteUsd).toFixed(2),
      sforoUsd: +sforoMisurato.toFixed(2),
      sforoPercentualeDelTetto: +((sforoMisurato / tetto) * 100).toFixed(1),
      tettoPerRicostruireQuestaCoppiaUsd: +coppiaSimmetricaAllaSuperstite.toFixed(2),
      rapportoSulTettoAttuale: +(coppiaSimmetricaAllaSuperstite / tetto).toFixed(2) },
    limiteSuperioreSulBoard: { mercatiAmmissibili: righe.length,
      peggiore: righe[0] || null, mediana, primi5: righe.slice(0, 5) },
    conclusione: 'nessuno di questi valori e\' una proposta: alzare il tetto autorizzerebbe la size che'
      + ' l\'asimmetria ha prodotto invece di correggerla. La cura sta a monte — ricostruire la COPPIA e non'
      + ' la gamba, o non cambiare la size nel riprezzo.' };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(referto, null, 1));

  console.log(`\ntetto per mercato attuale: $${tetto}`);
  console.log(`\n① IL CASO MISURATO DAL BANCO`);
  console.log(`   gamba superstite : ${CASO_BANCO.sizeSuperstite} share × $${CASO_BANCO.pSuperstite} = $${CASO_BANCO.aRiposoUsd.toFixed(2)}`);
  console.log(`   gamba mancante   : $${CASO_BANCO.gambaMancanteUsd.toFixed(2)} (a $${CASO_BANCO.pMancante})`);
  console.log(`   totale tentato   : $${(CASO_BANCO.aRiposoUsd + CASO_BANCO.gambaMancanteUsd).toFixed(2)}  ⇒  SFORO $${sforoMisurato.toFixed(2)} (${((sforoMisurato / tetto) * 100).toFixed(1)}% del tetto)`);
  console.log(`   tetto che servirebbe per ricostruire QUESTA coppia alla size della superstite:`);
  console.log(`     $${coppiaSimmetricaAllaSuperstite.toFixed(2)}  = ${(coppiaSimmetricaAllaSuperstite / tetto).toFixed(2)}× il tetto attuale`);
  console.log(`\n② IL LIMITE SUPERIORE SUL BOARD VERO (${righe.length} mercati ammissibili)`);
  if (righe[0]) {
    console.log(`   peggiore : $${righe[0].tettoNecessarioUsd} (${righe[0].rapportoSulTettoAttuale}× il tetto) · mid ${righe[0].mid} · ${righe[0].question}`);
    console.log(`   mediana  : $${mediana}`);
    console.log('   i primi cinque:');
    for (const c of righe.slice(0, 5)) console.log(`     $${String(c.tettoNecessarioUsd).padStart(8)} (${c.rapportoSulTettoAttuale}×) · mid ${c.mid} · ${c.question}`);
  }
  console.log(`\n⚠ ${referto.conclusione}`);
  console.log(`\nreferto → ${path.relative(ROOT, OUT)}`);
})();

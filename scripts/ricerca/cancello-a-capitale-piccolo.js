#!/usr/bin/env node
'use strict';
/**
 * IL CANCELLO VERO A CAPITALE PICCOLO — con $147 e UN MERCATO SOLO. Sola lettura.
 *
 * ═══ LA DOMANDA DELL'OPERATORE (17 agosto 2026) ══════════════════════════════════════════════════════
 * «Hai misurato che il 60% non esclude nulla e che a escludere e' `pavimentoPremiante(minSize) > tetto
 * per mercato`: 53 righe su 142 fuori per `rewardsMinSize > 50`. Con $147 e un mercato solo, dimmi
 * quante righe restano davvero candidabili.»
 *
 * ⚠ «CANDIDABILE» NON E' UNA PAROLA SOLA, e dare un numero unico nasconderebbe il cancello che decide.
 * I filtri si applicano IN FILA e ognuno ha la sua causa: si riporta l'imbuto, riga per riga, con il
 * numero che resta dopo ognuno. Il numero finale e' l'ultimo dell'imbuto; gli altri dicono PERCHE'.
 *
 * ⚠ TUTTI I NUMERI VENGONO DALLE FUNZIONI DI PRODUZIONE, importate: `concentration.pavimentoPremiante`,
 * `capPerMarketUsd`, `liveMinOrderCapUsd`, `selezione-mercati.valutaAmmissibilita` (che porta con se'
 * minSize, orizzonte, meteo e categoria), `horizon`. Una seconda idea di «candidabile» sarebbe il
 * reperto D1 su una decisione di capitale.
 *
 * ⚠ E IL TETTO PER MERCATO A $147 NON E' $61,25: `capPerMarketUsd` DERIVA il tetto dal capitale e si
 * clampa al capitale stesso. Con un mercato solo il capitale disponibile per quel mercato e' tutto,
 * quindi il vincolo che morde diventa il PAVIMENTO PREMIANTE del suo scaglione, non il tetto.
 *
 * Uso:  node scripts/ricerca/cancello-a-capitale-piccolo.js [capitale]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'ricerca', 'cancello-a-capitale-piccolo.json');

const CONC = require(path.join(ROOT, 'lib/rewards/concentration'));
const SELM = require(path.join(ROOT, 'lib/maker/selezione-mercati'));
const { MAX_HORIZON_DAYS } = require(path.join(ROOT, 'lib/rewards/horizon'));
const { sharePerLato } = require(path.join(ROOT, 'lib/rewards/size-da-capitale'));
const { verdettoProfondita } = require(path.join(ROOT, 'lib/rewards/profondita-minima'));

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const CAPITALE = Number(process.argv[2] || 147);

(async () => {
  const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'liquidity-rewards.json'), 'utf8'));
  const righe = board.markets || [];
  const ora = Date.now();

  const tetto = CONC.capPerMarketUsd(CAPITALE);
  const tettoOrdine = CONC.liveMinOrderCapUsd(CAPITALE);
  // Con UN MERCATO SOLO il capitale che quel mercato puo' ricevere e' il minimo fra il tetto derivato e
  // il capitale intero: non c'e' nessun altro con cui dividerlo.
  const perQuelMercato = Math.min(tetto, CAPITALE);

  const imbuto = [];
  const passo = (nome, sopravvissuti, causa) => { imbuto.push({ nome, sopravvissuti: sopravvissuti.length, causa }); return sopravvissuti; };

  let v = passo('righe del board', righe, null);

  v = passo('① `rewardsMinSize` leggibile', v.filter((r) => fin(Number(r.rewardsMinSize)) && Number(r.rewardsMinSize) > 0),
    '`Number(null) === 0` renderebbe il mercato «il piu\' finanziabile di tutti»');

  // ② IL CANCELLO CHE L'OPERATORE HA GIA' MISURATO, ma ricalcolato al capitale VERO invece che al tetto
  //    fisso: sotto `min_incentive_size` il reward e' ZERO, non piu' basso.
  v = passo(`② pavimento premiante ≤ capitale del mercato ($${perQuelMercato.toFixed(2)})`,
    v.filter((r) => { const p = CONC.pavimentoPremiante(Number(r.rewardsMinSize)); return fin(p) && p <= perQuelMercato + 1e-9; }),
    'sotto il pavimento il reward e\' ZERO: meglio nessun mercato che un mercato che non paga');

  // ③ I vincoli della selezione, dalla funzione di produzione: orizzonte, meteo, categoria.
  v = passo('③ ammissibile per la selezione (orizzonte ≥ 24 h, non meteo, categoria leggibile)',
    v.filter((r) => SELM.valutaAmmissibilita(r, { ora, orizzonteMassimoOre: MAX_HORIZON_DAYS * 24 }).ammissibile === true),
    'gli stessi vincoli di §4.13, dalla funzione che li applica in produzione');

  // ④ LA GAMBA CARA DEVE STARE SOTTO IL TETTO PER ORDINE. Con un mercato solo il capitale e' tutto suo,
  //    quindi la coppia costa quasi il capitale intero e la gamba cara puo' sfondare il tetto per ordine.
  v = passo(`④ la gamba cara sta sotto il tetto per ordine ($${tettoOrdine.toFixed(2)})`,
    v.filter((r) => {
      const mid = fin(r.mid) ? r.mid : null;
      if (mid == null) return false;
      const q = sharePerLato({ capitaleUsd: perQuelMercato, pairCostUsd: fin(r.pairCostUsd) ? r.pairCostUsd : null });
      if (!q || !fin(q.shares)) return false;
      const gambaCara = q.shares * Math.max(mid, 1 - mid);
      return gambaCara <= tettoOrdine + 1e-9;
    }),
    'e\' la causa a monte di `coppia-non-atomica` (§5-bis p.164): una gamba oltre il tetto abbandona la coppia INTERA');

  // ⑤ La quota credibile del 60%, al capitale vero e per GAMBA.
  v = passo('⑤ entrambe le gambe sotto la quota credibile del 60%',
    v.filter((r) => {
      const py = fin(r.mid) ? r.mid : null;
      const q = sharePerLato({ capitaleUsd: perQuelMercato, pairCostUsd: fin(r.pairCostUsd) ? r.pairCostUsd : null });
      if (py == null || !q || !fin(q.shares)) return false;
      const dep = (lato, prezzo) => {
        const d = r.sides && r.sides[lato] ? Number(r.sides[lato].existing_depth_usd) : null;
        return fin(d) && prezzo > 0 ? d / prezzo : null;
      };
      for (const [lato, prezzo] of [['yes', py], ['no', 1 - py]]) {
        const verdetto = verdettoProfondita({ sharePerUsd: q.shares / perQuelMercato, depthShares: dep(lato, prezzo),
          capitaleRiferimentoUsd: perQuelMercato });
        // `ignota` NON esclude (§4.4): l'ignoranza non e' una ragione per togliere un mercato.
        if (verdetto.stato === 'sottile') return false;
      }
      return true;
    }),
    '`ignota` non esclude: e\' la regola di §4.4, non una svista');

  const finali = v;
  const referto = { generatoIl: new Date().toISOString(), capitaleUsd: CAPITALE,
    boardGeneratoIl: board.meta && board.meta.generatedAt,
    tettoPerMercatoDerivato: +tetto.toFixed(2), capitaleDelMercatoUnico: +perQuelMercato.toFixed(2),
    tettoPerOrdine: +tettoOrdine.toFixed(2),
    imbuto, candidabili: finali.length,
    elenco: finali.slice(0, 20).map((r) => ({ conditionId: r.conditionId, question: String(r.question || '').slice(0, 64),
      minSize: Number(r.rewardsMinSize), pavimentoUsd: +CONC.pavimentoPremiante(Number(r.rewardsMinSize)).toFixed(2),
      mid: r.mid, bandaCents: r.rewardsMaxSpread,
      nettoGiornoA500: r.levels && r.levels['500'] && fin(r.levels['500'].netRewardDay) ? +Number(r.levels['500'].netRewardDay).toFixed(2) : null })) };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(referto, null, 1));

  console.log(`\ncapitale $${CAPITALE.toFixed(2)} · UN MERCATO SOLO`);
  console.log(`  tetto per mercato DERIVATO da questo capitale : $${tetto.toFixed(2)}`);
  console.log(`  capitale che quel mercato puo' ricevere       : $${perQuelMercato.toFixed(2)}`);
  console.log(`  tetto per ORDINE                             : $${tettoOrdine.toFixed(2)}`);
  console.log(`\nboard del ${referto.boardGeneratoIl}\n`);
  let prec = null;
  for (const p of imbuto) {
    const perse = prec == null ? null : prec - p.sopravvissuti;
    console.log(`  ${String(p.sopravvissuti).padStart(4)}  ${p.nome}${perse != null ? `   (−${perse})` : ''}`);
    if (p.causa && perse) console.log(`        ${p.causa}`);
    prec = p.sopravvissuti;
  }
  console.log(`\n★ CANDIDABILI DAVVERO: ${finali.length}`);
  for (const c of referto.elenco.slice(0, 10)) {
    console.log(`   minSize ${String(c.minSize).padStart(3)} · pavimento $${String(c.pavimentoUsd).padStart(6)} · mid ${c.mid} · netto/g $${c.nettoGiornoA500} · ${c.question}`);
  }
  console.log(`\nreferto → ${path.relative(ROOT, OUT)}`);
})();

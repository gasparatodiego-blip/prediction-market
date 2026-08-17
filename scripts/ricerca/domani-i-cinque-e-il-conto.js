#!/usr/bin/env node
'use strict';
/**
 * PER DOMANI: I CINQUE MIGLIORI OLTRE 7 GIORNI, E IL CONTO SU UN MERCATO SOLO — sola misura.
 *
 * ═══ LE DUE DOMANDE DELL'OPERATORE (17 agosto 2026) ══════════════════════════════════════════════════
 * ① «I cinque migliori mercati candidabili con scadenza oltre 7 giorni, con netto/giorno, concorrenza,
 *    minSize, pavimento premiante e capitale minimo per superarlo.»
 * ② «Con $147 di capitale su UN mercato solo: quante share per lato, a che distanza dal mid, quanto
 *    capitale impegnato, e se supera il pavimento premiante. Il conto in chiaro.»
 *
 * ═══ DA DOVE VENGONO I NUMERI, E COSA NON E' STATO RICALCOLATO A MANO ════════════════════════════════
 * Il netto/giorno viene da `allocator.planFromCollection`, cioe' dal PIANIFICATORE VERO, girato al
 * capitale vero ($147) col tetto per mercato vero (`capPerMarketUsd`). Non e' una mia formula: e' lo
 * stesso processo che decide il piano in produzione, e per ogni candidato porta `bestNetPerDay`,
 * `competitorShares`, `pot`, `status` e `reason`.
 * I filtri di candidabilita' sono le funzioni vere: `concentration.pavimentoPremiante`,
 * `selezione-mercati.valutaAmmissibilita`, `horizon`. La distanza dal mid viene da
 * `distanza-obiettivo` — manopola E margine dal bordo, letti dall'ambiente del PROCESSO VIVO, non dal
 * `.env` (§5-bis p.184: i due divergono, e a decidere e' il processo).
 *
 * ⚠ IL VINCOLO CHE MORDE SULLA DOMANDA ② E VA DETTO PRIMA DEL CONTO: **su UN mercato solo non entrano
 * $147**. Il tetto per mercato e' $61,25 (§4.2) e non e' una manopola — deriva dal pavimento premiante
 * dello scaglione finanziabile. Quindi «$147 su un mercato» non e' una configurazione che il bot possa
 * produrre: il conto giusto e' $61,25 su quel mercato, e il resto resta liquido finche' non si aprono
 * altri mercati. Il conto viene fatto per ENTRAMBE le letture, e la seconda e' dichiarata ipotetica.
 *
 * Uso:  node scripts/ricerca/domani-i-cinque-e-il-conto.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'ricerca', 'domani-i-cinque-e-il-conto.json');

const A = require(path.join(ROOT, 'lib/rewards/allocator'));
const CONC = require(path.join(ROOT, 'lib/rewards/concentration'));
const SELM = require(path.join(ROOT, 'lib/maker/selezione-mercati'));
const HOR = require(path.join(ROOT, 'lib/rewards/horizon'));
const DIST = require(path.join(ROOT, 'lib/maker/distanza-obiettivo'));
const { raggioBandaCents } = require(path.join(ROOT, 'lib/banda-premiante'));

const CAPITALE = 147;
const GIORNI_MINIMI = 7;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const usd = (x) => `$${Number(x).toFixed(2)}`;

/** L'ambiente del processo che decide un prezzo: la manopola vive LI', non nel `.env`. */
function ambienteDiUnProcessoVivo() {
  try {
    const { execFileSync } = require('child_process');
    const arr = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }));
    for (const p of arr) {
      if (!/agent4[01]/.test(String(p && p.name))) continue;
      const pid = p.pid;
      if (!pid) continue;
      const grezzo = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      const env = {};
      for (const v of grezzo.split('\0')) { const i = v.indexOf('='); if (i > 0) env[v.slice(0, i)] = v.slice(i + 1); }
      return { nome: p.name, pid, env };
    }
  } catch { /* si ripiega sul difetto del codice, dichiarandolo */ }
  return null;
}

(async () => {
  const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'liquidity-rewards.json'), 'utf8'));
  const righeBoard = Array.isArray(board) ? board : (board.markets || []);
  const perId = new Map(righeBoard.map((r) => [String(r.conditionId || '').toLowerCase(), r]));
  const ora = Date.now();
  const tettoMercato = CONC.capPerMarketUsd(CAPITALE);

  // ── IL PIANO VERO, al capitale vero ────────────────────────────────────────────────────────────
  const piano = A.planFromCollection({ capital: CAPITALE, maxPerMarketUsd: tettoMercato, horizonFilter: true });

  // ── ① I CANDIDABILI OLTRE 7 GIORNI ────────────────────────────────────────────────────────────
  const cinque = [];
  for (const c of piano.candidates || []) {
    const id = String(c.marketId || '').toLowerCase();
    const b = perId.get(id);
    if (!b) continue;
    const minSize = Number(b.rewardsMinSize);
    if (!fin(minSize) || minSize <= 0) continue;
    // ⚠ TRE CANCELLI VERI, non tre miei criteri: il pavimento premiante contro il tetto (§4.2), i
    // vincoli della selezione (§4.13) e l'orizzonte. Chi non li passa non e' «peggiore»: non e'
    // candidabile, ed elencarlo fra i migliori sarebbe proporre un mercato che il bot rifiuta.
    const pavimento = CONC.pavimentoPremiante(minSize);
    if (!(fin(pavimento) && pavimento <= tettoMercato)) continue;
    const amm = SELM.valutaAmmissibilita(b, { ora, orizzonteMassimoOre: HOR.MAX_HORIZON_DAYS * 24 });
    if (amm.ammissibile !== true) continue;
    // ⚠ L'ORIZZONTE NON SI LEGGE DA `c.horizon`, E LA PRIMA STESURA LO FACEVA: sul board di stasera quel
    // campo e' `undefined` per 31 candidati su 145 (`horizonUnknown`), quindi il filtro «oltre 7 giorni»
    // scartava TUTTI i superstiti e la risposta era «zero candidabili» — un `Number(null)` travestito da
    // misura (§5.3). La scadenza vera sta sul board, ancorata al VENUE col riscontro di Gamma (§4.7), ed
    // e' la stessa che la selezione ha appena usato per ammettere il mercato.
    const scad = Date.parse(b.endDate || b.endDateClob || b.endDateGamma || '');
    const giorni = Number.isFinite(scad) ? (scad - ora) / 86_400_000 : null;
    if (giorni == null || giorni <= GIORNI_MINIMI) continue;
    const netto = fin(c.bestNetPerDay) ? c.bestNetPerDay : null;
    if (netto == null) continue;
    cinque.push({
      conditionId: b.conditionId,
      question: String(b.question || '').slice(0, 58),
      categoria: b.category || null,
      giorniAllaScadenza: +giorni.toFixed(2),
      scadenza: b.endDate || null,
      nettoGiornoUsd: +netto.toFixed(4),
      // ⚠ IL LORDO ACCANTO AL NETTO, SEMPRE. Su questo board i cinque migliori oltre 7 giorni hanno un
      // netto intorno a ZERO o negativo, e un numero negativo da solo non dice se il problema e' il
      // reward (lordo minuscolo) o il costo del fill avverso: sono due cure diverse.
      lordoGiornoUsd: fin(c.bestGrossPerDay) ? +c.bestGrossPerDay.toFixed(4) : null,
      // La quota di montepremi che le nostre share prenderebbero: e' il numero che spiega il lordo.
      quotaDelMontepremi: fin(c.quotaCapata) ? +c.quotaCapata.toFixed(6) : (fin(c.quotaCeiling) ? +c.quotaCeiling.toFixed(6) : null),
      // «Concorrenza» ha due misure e sono diverse: le SHARE altrui in banda (quelle contro cui si
      // divide il montepremi) e il capitale altrui a libro. Si danno entrambe, perche' la prima decide
      // la quota e la seconda dice quanto e' profondo il mercato.
      concorrenzaShareInBanda: fin(c.competitorShares) ? +c.competitorShares.toFixed(1) : null,
      profonditaAltruiUsd: fin(Number(b.existing_depth_usd)) ? Math.round(Number(b.existing_depth_usd)) : null,
      montepremiGiornoUsd: fin(c.pot) ? c.pot : (fin(Number(b.rewardsDailyRate)) ? Number(b.rewardsDailyRate) : null),
      minSize,
      pavimentoPremianteUsd: +pavimento.toFixed(2),
      // Il capitale minimo per superare il pavimento È il pavimento: è definito come il capitale che
      // compra `minSize` share per lato al costo tipico della coppia (`minSize × 0,98 × 1,25`).
      capitaleMinimoUsd: +pavimento.toFixed(2),
      bandaCents: fin(Number(b.rewardsMaxSpread)) ? Number(b.rewardsMaxSpread) : null,
      raggioBandaCents: raggioBandaCents(Number(b.rewardsMaxSpread)),
      mid: fin(Number(b.mid)) ? +Number(b.mid).toFixed(4) : null,
      tick: fin(Number(b.tickSize)) ? Number(b.tickSize) : null,
      statoNelPiano: c.status || null,
      // Dichiarato, non nascosto: il pianificatore non conosce l'orizzonte di questo mercato.
      orizzonteIgnotoAlPianificatore: c.horizonUnknown === true || !fin(c.horizon),
      fonteScadenza: b.endDateFonte || b.endDateSource || null,
      motivoNelPiano: c.reason ? String(c.reason).slice(0, 120) : null,
    });
  }
  cinque.sort((a, b) => b.nettoGiornoUsd - a.nettoGiornoUsd);
  const primi5 = cinque.slice(0, 5);

  // ── ② IL CONTO SU UN MERCATO SOLO ─────────────────────────────────────────────────────────────
  const vivo = ambienteDiUnProcessoVivo();
  const envDist = vivo ? vivo.env : process.env;
  const scelto = primi5[0] || null;
  let conto = null;
  if (scelto) {
    const pYes = scelto.mid;
    const pNo = +(1 - pYes).toFixed(6);
    // ⚠ IL COSTO DELLA COPPIA NON E' 1: e' `p_yes + p_no` ai PREZZI DI QUOTAZIONE, che stanno DENTRO la
    // banda, un tick dietro il tocco. Al mid la somma fa 1 per costruzione; ai prezzi veri fa meno, ed è
    // quello sconto a essere il margine (§4.9). Qui si usa il costo tipico del piano quando c'è.
    const costoTipico = fin(Number(piano.sizing && piano.sizing.pairCostUsd)) ? Number(piano.sizing.pairCostUsd) : 0.98;
    const rigaPiano = (piano.rows || []).find((r) => String(r.marketId || '').toLowerCase() === String(scelto.conditionId).toLowerCase()) || null;
    const sommaPrezzi = rigaPiano && fin(rigaPiano.pairCostUsd) ? rigaPiano.pairCostUsd : costoTipico;

    const d = DIST.distanzaObiettivoCents({ maxSpreadCents: scelto.bandaCents, env: envDist });
    const v = scelto.raggioBandaCents;
    const bordi = DIST.bordiConMargine({
      bandLo: fin(pYes) && fin(v) ? +(pYes - v / 100).toFixed(6) : null,
      bandHi: fin(pYes) && fin(v) ? +(pYes + v / 100).toFixed(6) : null,
      tick: scelto.tick, maxSpreadCents: scelto.bandaCents, env: envDist,
    });
    const distanzaFinaleC = bordi.applicato && fin(pYes) ? +((pYes - bordi.lo) * 100).toFixed(2) : (fin(d.distanzaC) ? d.distanzaC : null);

    const conta = (capitale) => {
      const Q = Math.floor((capitale / sommaPrezzi) * 100) / 100;
      return {
        capitaleUsd: +capitale.toFixed(2),
        sharePerLato: Q,
        capitaleImpegnatoUsd: +(Q * sommaPrezzi).toFixed(2),
        superaIlPavimento: Q >= scelto.minSize,
        margineSulMinimoShare: +(Q - scelto.minSize).toFixed(2),
      };
    };
    conto = {
      mercato: scelto.question, conditionId: scelto.conditionId,
      mid: pYes, pNo, sommaPrezziUsatiPerLaCoppia: +sommaPrezzi.toFixed(4),
      minSize: scelto.minSize, pavimentoPremianteUsd: scelto.pavimentoPremianteUsd,
      bandaCents: scelto.bandaCents, raggioBandaCents: v, tick: scelto.tick,
      manopola: { frazione: d.frazione, distanzaObiettivoCents: d.distanzaC, motivo: d.motivo,
        letteDa: vivo ? `${vivo.nome} pid ${vivo.pid} (/proc)` : 'process.env (pm2 non leggibile)' },
      margineDalBordo: { tick: bordi.margineTick, applicato: bordi.applicato, motivo: bordi.motivo,
        bordoBassoUsato: bordi.applicato ? bordi.lo : null },
      distanzaFinaleDalMidCents: distanzaFinaleC,
      // I due conti: quello che il bot puo' davvero fare, e quello ipotetico senza tetto.
      alTettoPerMercato: { ...conta(Math.min(CAPITALE, tettoMercato)), tettoUsd: tettoMercato },
      seNonCiFosseIlTetto: { ...conta(CAPITALE), ipotetico: true,
        nota: 'il tetto per mercato NON e\' una manopola: deriva dal pavimento premiante dello scaglione finanziabile (§4.2)' },
      capitaleCheRESTAliquido: +(CAPITALE - Math.min(CAPITALE, tettoMercato)).toFixed(2),
    };
  }

  const referto = { generatoIl: new Date().toISOString(), capitale: CAPITALE,
    tettoPerMercatoUsd: tettoMercato, boardGeneratoIl: (board.meta && board.meta.generatedAt) || null,
    candidabiliOltre7Giorni: cinque.length, primi5,
    righeDelPianoVero: (piano.rows || []).map((r) => ({ marketId: r.marketId, capitale: r.capital,
      share: r.sizePerSideShares, netto: r.netPerDay, minSize: r.minSizeShares })),
    conto };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(referto, null, 1));

  console.log(`\ncapitale $${CAPITALE} · tetto per mercato ${usd(tettoMercato)} · board ${righeBoard.length} righe`);
  console.log(`\n① I CANDIDABILI CON SCADENZA OLTRE ${GIORNI_MINIMI} GIORNI: ${cinque.length} su ${righeBoard.length}\n`);
  console.log('   #  netto/g   lordo/g   quota      conc.(share)  profondità   montepremi  minSize  pavimento  giorni  mercato');
  primi5.forEach((c, i) => {
    console.log(`   ${i + 1}  ${usd(c.nettoGiornoUsd).padStart(7)}  ${String(c.lordoGiornoUsd != null ? usd(c.lordoGiornoUsd) : '—').padStart(7)}  `
      + `${String(c.quotaDelMontepremi != null ? (c.quotaDelMontepremi * 100).toFixed(4) + '%' : '—').padStart(9)}  `
      + `${String(c.concorrenzaShareInBanda ?? '—').padStart(12)}  `
      + `${String(c.profonditaAltruiUsd != null ? '$' + c.profonditaAltruiUsd : '—').padStart(10)}  `
      + `${String(c.montepremiGiornoUsd != null ? '$' + c.montepremiGiornoUsd + '/g' : '—').padStart(10)}  `
      + `${String(c.minSize).padStart(7)}  ${usd(c.pavimentoPremianteUsd).padStart(9)}  ${String(c.giorniAllaScadenza).padStart(6)}  ${c.question}`);
  });
  console.log('\n   il capitale minimo per superare il pavimento premiante È il pavimento stesso:');
  for (const c of primi5) console.log(`     minSize ${String(c.minSize).padStart(3)} ⇒ ${usd(c.capitaleMinimoUsd)}  (${c.minSize} × 0,98 × 1,25)`);

  if (conto) {
    const t = conto.alTettoPerMercato; const h = conto.seNonCiFosseIlTetto;
    console.log(`\n② IL CONTO SU UN MERCATO SOLO — ${conto.mercato}`);
    console.log(`   mid ${conto.mid} · banda ±${conto.raggioBandaCents}¢ (max_spread ${conto.bandaCents}¢) · tick ${conto.tick} · minSize ${conto.minSize}`);
    console.log(`   costo della coppia usato: $${conto.sommaPrezziUsatiPerLaCoppia}  (p_yes + p_no ai prezzi di quotazione)`);
    console.log(`\n   ⚠ IL TETTO PER MERCATO MORDE PRIMA DEL CAPITALE: su un mercato solo non entrano $${CAPITALE}.`);
    console.log(`   quello che il bot fa DAVVERO — capitale ${usd(t.capitaleUsd)} (tetto ${usd(t.tettoUsd)}):`);
    console.log(`     share per lato   Q = ${usd(t.capitaleUsd)} / $${conto.sommaPrezziUsatiPerLaCoppia} = ${t.sharePerLato}`);
    console.log(`     capitale impegnato = ${t.sharePerLato} × $${conto.sommaPrezziUsatiPerLaCoppia} = ${usd(t.capitaleImpegnatoUsd)}`);
    console.log(`     supera il pavimento premiante? ${t.superaIlPavimento ? 'SÌ' : 'NO'} — ${t.sharePerLato} share contro minSize ${conto.minSize}`
      + ` (margine ${t.margineSulMinimoShare} share)`);
    console.log(`     resta liquido: ${usd(conto.capitaleCheRESTAliquido)} — non ha dove andare finché non si apre un secondo mercato`);
    console.log(`\n   ipotetico, SENZA il tetto (non è una configurazione che il bot possa produrre):`);
    console.log(`     Q = ${usd(h.capitaleUsd)} / $${conto.sommaPrezziUsatiPerLaCoppia} = ${h.sharePerLato} share per lato · impegnato ${usd(h.capitaleImpegnatoUsd)}`);
    console.log(`\n   A CHE DISTANZA DAL MID:`);
    console.log(`     manopola  : ${conto.manopola.motivo}   [letta da ${conto.manopola.letteDa}]`);
    console.log(`     margine   : ${conto.margineDalBordo.motivo}`);
    console.log(`     ⇒ distanza finale dal mid: ${conto.distanzaFinaleDalMidCents}¢ su una banda di ±${conto.raggioBandaCents}¢`);
  }
  console.log(`\nil piano VERO a $${CAPITALE} apre ${(piano.rows || []).length} mercati:`);
  for (const r of piano.rows || []) console.log(`   ${String(r.marketId).slice(0, 12)}… ${usd(r.capital)} · ${r.sizePerSideShares} share/lato · netto ${usd(r.netPerDay)}/g · minSize ${r.minSizeShares}`);
  console.log(`\nreferto → ${path.relative(ROOT, OUT)}`);
})();

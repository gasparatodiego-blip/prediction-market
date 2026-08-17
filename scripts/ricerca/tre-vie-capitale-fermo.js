#!/usr/bin/env node
'use strict';
/**
 * IL CAPITALE FERMO: LE TRE VIE, COI NUMERI. Sola misura — NON applica niente, NON raccomanda niente.
 *
 * ═══ LA DOMANDA DELL'OPERATORE (17 agosto 2026) ═════════════════════════════════════════════════════
 * «Con un mercato solo, $85,75 su $147 non lavorano: il tetto di $61,25 morde prima del capitale.
 *  Dammi le tre vie: (a) un mercato, 58% fermo · (b) alzare il tetto, e di quanto esattamente ·
 *  (c) due mercati, e cosa cambia nel rischio e nel residuo peggiore. Scelgo io.»
 *
 * ═══ LA COSA DA SAPERE PRIMA DI LEGGERE LA VIA (b) ═════════════════════════════════════════════════
 * **Il tetto per mercato non e' una manopola con valori continui.** E' `pavimentoPremiante(minSize)`
 * dello SCAGLIONE FINANZIABILE, cioe' `minSize × 0,98 × 1,25` — e i `minSize` del venue sono
 * 20 · 50 · 100 · 200 · 1000. Quindi il tetto puo' valere $24,50 · $61,25 · $122,50 · $245 · $1.225 e
 * NIENT'ALTRO: «alzarlo a $147» non e' una configurazione esprimibile. Chiedere «di quanto esattamente»
 * ha una risposta discreta, e questo script la da' scaglione per scaglione.
 *
 * ⚠ E ALZARLO NON E' SOLO «piu' capitale per mercato»: il tetto per mercato e' l'INGRESSO da cui
 * derivano il tetto per ordine (`liveMinOrderCapUsd`) e l'ammissibilita' dei mercati
 * (`pavimentoPremiante(minSize) ≤ tetto`). Alzarlo cambia **quali mercati il bot puo' aprire**, e il
 * verso non e' ovvio: §4.2 ha gia' misurato un caso in cui i passabili CALANO da 21 a 18. Qui si conta
 * girando il pianificatore VERO a ogni tetto, invece di ragionarci.
 *
 * ⚠ E IL RESIDUO PEGGIORE CRESCE COL TETTO, perche' e' `(minSize − 0,01) × prezzo_lato_caro` limitato
 * dai due tetti: uno scaglione piu' alto significa un residuo irraggiungibile piu' grande (§5-bis p.187).
 *
 * Uso:  node scripts/ricerca/tre-vie-capitale-fermo.js [--capitale N]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'ricerca', 'tre-vie-capitale-fermo.json');

const A = require(path.join(ROOT, 'lib/rewards/allocator'));
const CONC = require(path.join(ROOT, 'lib/rewards/concentration'));
const SELM = require(path.join(ROOT, 'lib/maker/selezione-mercati'));
const HOR = require(path.join(ROOT, 'lib/rewards/horizon'));
const { DATA_DIR } = require(path.join(ROOT, 'lib/safety/store'));

const iCap = process.argv.indexOf('--capitale');
const CAPITALE = iCap > 0 && Number.isFinite(Number(process.argv[iCap + 1])) ? Number(process.argv[iCap + 1]) : 147;
const SCAGLIONI = [20, 50, 100, 200, 1000];
const PASSO_SHARE = 0.01;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const usd = (x) => (x == null ? '—' : `$${Number(x).toFixed(2)}`);
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

(async () => {
  const board = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'liquidity-rewards.json'), 'utf8'));
  const righe = Array.isArray(board) ? board : (board.markets || []);
  const ora = Date.now();
  const tettoOggi = CONC.capPerMarketUsd(CAPITALE);
  const orizzonteMassimoOre = HOR.maxHorizonDays() * 24;

  /** Il residuo irraggiungibile peggiore su UN mercato, dato un tetto. Stessa aritmetica di §5-bis p.187. */
  function residuoPeggiore(tettoMercato) {
    const tettoOrdine = CONC.liveMinOrderCapUsd(tettoMercato);
    let peggio = null;
    for (const r of righe) {
      const minSize = Number(r.rewardsMinSize);
      const mid = fin(Number(r.mid)) ? Number(r.mid) : null;
      if (!fin(minSize) || minSize <= 0 || mid == null || mid <= 0 || mid >= 1) continue;
      // ⚠ SOLO I MERCATI CHE IL BOT PUO' DAVVERO APRIRE a QUEL tetto. Il peggiore in assoluto sta su un
      // `minSize 1000` che il pavimento premiante esclude a monte: citarlo sarebbe misurare un mercato
      // in cui il bot non entra.
      if (!(CONC.pavimentoPremiante(minSize) <= tettoMercato)) continue;
      if (SELM.valutaAmmissibilita(r, { ora, orizzonteMassimoOre }).ammissibile !== true) continue;
      const pCaro = Math.max(mid, +(1 - mid).toFixed(6));
      const grezzo = (minSize - PASSO_SHARE) * pCaro;
      const bloccato = Math.min(grezzo, tettoOrdine, tettoMercato);
      if (!peggio || bloccato > peggio.usd) {
        peggio = { usd: +bloccato.toFixed(2), minSize, mid: +mid.toFixed(4),
          question: String(r.question || '').slice(0, 46),
          limitatoDa: bloccato < grezzo - 1e-9 ? (Math.abs(bloccato - tettoOrdine) < 1e-9 ? 'tetto-per-ordine' : 'tetto-per-mercato') : 'minSize×prezzo' };
      }
    }
    return peggio;
  }

  /** Il piano VERO a un dato tetto: righe, capitale impiegato, netto e lordo del piano. */
  function pianoAlTetto(tettoMercato) {
    let p;
    try { p = A.planFromCollection({ capital: CAPITALE, maxPerMarketUsd: tettoMercato, horizonFilter: true }); }
    catch (e) { return { errore: e.message }; }
    // ⚠ I NOMI DEI CAMPI SI LEGGONO DAL PIANO, NON SI INDOVINANO — la prima stesura usava
    // `capitalUsd`/`netUsdPerDay`/`grossUsdPerDay`, che NON esistono: la riga porta `capital`,
    // `grossScoredPerDay`, `netScoredPerDay`. Il `?? 0` trasformava ogni campo mancante in zero e la
    // tabella usciva «impiegato $0,00 · fermo $147,00 · netto $0,00» per TUTTI gli scaglioni — cioe' un
    // `Number(null) === 0` (§5.3) travestito da misura, e per giunta plausibile («il capitale non
    // lavora» era esattamente la tesi). Un valore che esce identico per tutte le righe della tabella e'
    // il segnale da cui insospettirsi.
    const rows = p.rows || [];
    const tot = p.totals || {};
    const impiegato = fin(Number(tot.capital)) ? Number(tot.capital)
      : rows.reduce((a, r) => a + (Number(r.capital) || 0), 0);
    // `netPerDay` del totale e' `null` quando nessun fill e' stato osservato: si usa il netto SCORED
    // per riga, che e' quello che il pianificatore usa per ordinare, e lo si dichiara.
    const netto = rows.reduce((a, r) => a + (Number(r.netScoredPerDay) || 0), 0);
    const lordo = fin(Number(tot.grossPerDay)) ? Number(tot.grossPerDay)
      : rows.reduce((a, r) => a + (Number(r.grossPerDay) || 0), 0);
    const realistico = fin(Number(tot.realisticPerDay)) ? Number(tot.realisticPerDay) : null;
    // Candidabili = quanti mercati supererebbero il pavimento premiante a QUESTO tetto. E' il numero che
    // cambia in modo non ovvio quando si alza il tetto, ed e' la meta' della domanda (b).
    let candidabili = 0;
    for (const r of righe) {
      const ms = Number(r.rewardsMinSize);
      if (!fin(ms) || ms <= 0) continue;
      if (CONC.pavimentoPremiante(ms) <= tettoMercato) candidabili += 1;
    }
    return {
      mercati: rows.length,
      capitaleImpiegatoUsd: +impiegato.toFixed(2),
      capitaleFermoUsd: +(CAPITALE - impiegato).toFixed(2),
      frazioneFerma: CAPITALE > 0 ? +((CAPITALE - impiegato) / CAPITALE).toFixed(4) : null,
      nettoScoredGiornoUsd: +netto.toFixed(3),
      lordoGiornoUsd: +lordo.toFixed(3),
      realisticoGiornoUsd: realistico == null ? null : +realistico.toFixed(3),
      candidabiliAlPavimento: candidabili,
      tettoPerOrdineUsd: +CONC.liveMinOrderCapUsd(tettoMercato).toFixed(2),
    };
  }

  // ── LE TRE VIE ─────────────────────────────────────────────────────────────────────────────────
  // (a) UN mercato al tetto di oggi. Non e' una configurazione che il bot produce da solo — la
  //     selezione ne apre tre — ma e' la domanda dell'operatore e va risposta com'e' posta.
  const unoOggi = {
    tettoPerMercatoUsd: tettoOggi,
    capitaleImpiegatoUsd: +Math.min(tettoOggi, CAPITALE).toFixed(2),
    capitaleFermoUsd: +(CAPITALE - Math.min(tettoOggi, CAPITALE)).toFixed(2),
    frazioneFerma: +((CAPITALE - Math.min(tettoOggi, CAPITALE)) / CAPITALE).toFixed(4),
    residuoPeggioreSuUnMercato: residuoPeggiore(tettoOggi),
  };

  // (b) ALZARE IL TETTO. Non e' continuo: si enumera scaglione per scaglione, e per ognuno si gira il
  //     pianificatore VERO. `capitaleMinimoPerNonSprecare` = il capitale che quel tetto vorrebbe per
  //     riempire tre mercati, cioe' la cifra sotto la quale alzare il tetto non aiuta.
  const scale = SCAGLIONI.map((minSize) => {
    const tetto = CONC.pavimentoPremiante(minSize);
    const piano = pianoAlTetto(tetto);
    return {
      scaglioneMinSize: minSize,
      tettoPerMercatoUsd: +tetto.toFixed(2),
      variazioneVsOggiUsd: +(tetto - tettoOggi).toFixed(2),
      esprimibile: true,
      superaIlCapitale: tetto > CAPITALE,
      // Il tetto si CLAMPA al capitale (`capPerMarketUsd` non restituisce mai piu' del capitale), quindi
      // uno scaglione sopra il capitale non da' un tetto piu' alto: da' il capitale intero su un mercato.
      tettoEffettivoUsd: +Math.min(tetto, CAPITALE).toFixed(2),
      piano,
      residuoPeggioreSuUnMercato: residuoPeggiore(tetto),
    };
  });
  // Il tetto che azzererebbe il capitale fermo su UN mercato solo, se fosse esprimibile.
  const tettoCheServirebbe = {
    perUnMercatoUsd: +CAPITALE.toFixed(2),
    minSizeCheLoProdurrebbe: +(CAPITALE / (CONC.COSTO_COPPIA * (1 + CONC.MARGINE_PAVIMENTO))).toFixed(1),
    esprimibile: false,
    perche: `il tetto e' pavimentoPremiante(minSize) e i minSize del venue sono ${SCAGLIONI.join(' · ')}: `
      + 'nessuno di questi produce esattamente il capitale, e la scala e\' discreta',
  };

  // (c) DUE mercati al tetto di oggi.
  const due = {
    mercati: 2,
    tettoPerMercatoUsd: tettoOggi,
    capitaleImpiegatoUsd: +Math.min(2 * tettoOggi, CAPITALE).toFixed(2),
    capitaleFermoUsd: +(CAPITALE - Math.min(2 * tettoOggi, CAPITALE)).toFixed(2),
    frazioneFerma: +((CAPITALE - Math.min(2 * tettoOggi, CAPITALE)) / CAPITALE).toFixed(4),
    // ⚠ IL RESIDUO PEGGIORE SI SOMMA SUI MERCATI: e' per-mercato per costruzione (un residuo sotto il
    // minimo del venue su UN lato di UN mercato), quindi due mercati aperti sono due residui possibili.
    residuoPeggioreTotaleUsd: unoOggi.residuoPeggioreSuUnMercato
      ? +(unoOggi.residuoPeggioreSuUnMercato.usd * 2).toFixed(2) : null,
    // I tre tetti che limitano l'esposizione, e quale morde per primo con due mercati.
    tettoEsposizioneApertaUsd: (() => {
      // ⚠ `safety-risk-limits.json` e' gitignored e la sua forma e' `{userId:{...}}`: si prende il primo
      // profilo invece di cercare una chiave di primo livello che non c'e'. Non leggibile ⇒ `null`
      // DICHIARATO, mai zero — un tetto letto come zero direbbe «nessuna esposizione permessa».
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'safety-risk-limits.json'), 'utf8'));
        if (fin(Number(j.maxOpenNotionalUsd))) return Number(j.maxOpenNotionalUsd);
        for (const v of Object.values(j || {})) {
          if (v && fin(Number(v.maxOpenNotionalUsd))) return Number(v.maxOpenNotionalUsd);
          if (v && v.limits && fin(Number(v.limits.maxOpenNotionalUsd))) return Number(v.limits.maxOpenNotionalUsd);
        }
        return null;
      } catch { return null; }
    })(),
  };
  const pianoTre = pianoAlTetto(tettoOggi);

  const referto = {
    generatoIl: new Date(ora).toISOString(), capitaleUsd: CAPITALE,
    board: { righe: righe.length, file: path.join(DATA_DIR, 'liquidity-rewards.json') },
    tettoOggiUsd: tettoOggi, tettoPerOrdineOggiUsd: CONC.liveMinOrderCapUsd(tettoOggi),
    scaglioneFinanziabileOggi: CONC.SCAGLIONE_FINANZIABILE,
    viaA: unoOggi, viaB: { scale, tettoCheServirebbe }, viaC: due,
    pianoLiberoAlTettoDiOggi: pianoTre,
  };
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(referto, null, 2)); } catch { /* pazienza */ }

  // ── STAMPA ─────────────────────────────────────────────────────────────────────────────────────
  console.log(`\n════ IL CAPITALE FERMO: LE TRE VIE ════`);
  console.log(`capitale ${usd(CAPITALE)} · tetto per mercato OGGI ${usd(tettoOggi)} (scaglione finanziabile ${CONC.SCAGLIONE_FINANZIABILE})`);
  console.log(`tetto per ordine ${usd(CONC.liveMinOrderCapUsd(tettoOggi))} · board ${righe.length} righe\n`);

  console.log('(a) UN MERCATO, al tetto di oggi');
  console.log(`    impiegato ${usd(unoOggi.capitaleImpiegatoUsd)} · fermo ${usd(unoOggi.capitaleFermoUsd)} = ${pct(unoOggi.frazioneFerma)}`);
  if (unoOggi.residuoPeggioreSuUnMercato) {
    const r = unoOggi.residuoPeggioreSuUnMercato;
    console.log(`    residuo irraggiungibile peggiore: ${usd(r.usd)} (minSize ${r.minSize}, lato caro, limitato da ${r.limitatoDa})`);
  }
  console.log('    ⚠ non e\' una configurazione che il bot produce da solo: la selezione apre TRE slot.\n');

  console.log('(b) ALZARE IL TETTO — e la scala e\' DISCRETA, non continua');
  console.log('    scaglione  tetto      Δ vs oggi   mercati  impiegato  fermo    realistico candidabili  residuo peggiore');
  for (const s of scale) {
    const p = s.piano || {};
    console.log(`    ${String(s.scaglioneMinSize).padStart(8)}  ${usd(s.tettoPerMercatoUsd).padEnd(9)} ${(s.variazioneVsOggiUsd >= 0 ? '+' : '') + s.variazioneVsOggiUsd.toFixed(2)}`.padEnd(46)
      + `${String(p.mercati ?? '—').padStart(6)}  ${usd(p.capitaleImpiegatoUsd).padStart(9)}  ${usd(p.capitaleFermoUsd).padStart(7)}  ${usd(p.realisticoGiornoUsd).padStart(7)}  ${String(p.candidabiliAlPavimento ?? '—').padStart(10)}  ${usd(s.residuoPeggioreSuUnMercato && s.residuoPeggioreSuUnMercato.usd).padStart(8)}`
      + (s.superaIlCapitale ? '   ⚠ sopra il capitale: si clampa' : ''));
  }
  console.log(`\n    ⚠ per azzerare il fermo su UN mercato servirebbe un tetto di ${usd(tettoCheServirebbe.perUnMercatoUsd)},`);
  console.log(`      cioe' uno scaglione minSize ${tettoCheServirebbe.minSizeCheLoProdurrebbe} — che il venue NON ha.`);
  console.log(`      ${tettoCheServirebbe.perche}\n`);

  console.log('(c) DUE MERCATI, al tetto di oggi');
  console.log(`    impiegato ${usd(due.capitaleImpiegatoUsd)} · fermo ${usd(due.capitaleFermoUsd)} = ${pct(due.frazioneFerma)}`);
  console.log(`    residuo irraggiungibile peggiore TOTALE: ${usd(due.residuoPeggioreTotaleUsd)} (e' per-mercato: due mercati, due residui possibili)`);
  console.log(`    tetto sull'esposizione aperta: ${usd(due.tettoEsposizioneApertaUsd)} — conta i fill riconciliati, non gli ordini a riposo\n`);

  console.log('PER CONFRONTO · il piano che il pianificatore sceglie DA SOLO al tetto di oggi');
  console.log(`    ${pianoTre.mercati} mercati · impiegato ${usd(pianoTre.capitaleImpiegatoUsd)} · fermo ${usd(pianoTre.capitaleFermoUsd)} = ${pct(pianoTre.frazioneFerma)} · realistico ${usd(pianoTre.realisticoGiornoUsd)}/g · lordo ${usd(pianoTre.lordoGiornoUsd)}/g\n`);
  console.log(`referto → ${path.relative(ROOT, OUT)}\n`);
})();

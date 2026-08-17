#!/usr/bin/env node
'use strict';
/**
 * QUANTO CAPITALE PUO' RESTARE BLOCCATO IN UN RESIDUO SOTTO IL MINIMO — sola misura, sul board vero.
 *
 * ═══ LA DOMANDA DELL'OPERATORE (17 agosto 2026) ══════════════════════════════════════════════════════
 * «Hai scritto che e' un buco strutturale ed e' capitale fermo. Dimmi quanto capitale resta bloccato nel
 * caso peggiore su un mercato solo, e che cosa si puo' fare davvero.»
 *
 * ═══ COS'E' UN RESIDUO SOTTO IL MINIMO ══════════════════════════════════════════════════════════════
 * Una gamba riempita solo in parte lascia una quantita' POSSEDUTA che sta sotto il `min_incentive_size`
 * del venue (20/50/100/200 share a seconda del mercato). Da la' in poi tutte le strade del LIBRO sono
 * chiuse contemporaneamente, e non per una regola nostra:
 *   · **vendere** vuole un ordine ≥ minSize          ⇒ rifiutato dal venue
 *   · **completare la coppia** vuole comprare `manca`, che e' la stessa quantita' ⇒ rifiutato
 *   · **ripiazzare** la gamba mancante ⇒ stesso rifiuto
 * Non e' capitale PERSO: e' capitale che non ha una via d'uscita **attraverso il libro**.
 *
 * ═══ IL CASO PEGGIORE SU UN MERCATO SOLO ════════════════════════════════════════════════════════════
 * `(minSize − passo) × prezzo`, con due tetti veri sopra: il prezzo massimo quotabile e il tetto per
 * ordine. Il conto si fa **sul board vero**, mercato per mercato, perche' `minSize` e il prezzo non sono
 * scelte nostre. ⚠ E si fa su UN LATO SOLO: un residuo su ENTRAMBI i lati e' una coppia parziale, e una
 * coppia si FONDE on-chain — `mergePosition` non ha un minimo di size, quindi quel caso non e' bloccato.
 *
 * ═══ CHE COSA SI PUO' FARE DAVVERO ══════════════════════════════════════════════════════════════════
 * Questo script non propone: verifica sul codice quali strade esistono, e con quale limite. Le stampa in
 * fondo. La risposta breve e' che la via d'uscita **esiste gia' e non passa dal libro** — il riscatto
 * on-chain dopo la risoluzione, che non ha minimi di size — e che il costo vero non e' il capitale, e' il
 * TEMPO in cui resta immobilizzato.
 *
 * Uso:  node scripts/ricerca/residui-sotto-il-minimo.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'ricerca', 'residui-sotto-il-minimo.json');

const CONC = require(path.join(ROOT, 'lib/rewards/concentration'));
const SELM = require(path.join(ROOT, 'lib/maker/selezione-mercati'));
const { MAX_HORIZON_DAYS, MIN_HORIZON_DAYS } = require(path.join(ROOT, 'lib/rewards/horizon'));
const RIS = require(path.join(ROOT, 'lib/maker/riscatto-automatico'));

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
// Il passo di size del venue: le size si troncano a due decimali in tutto il repo (`troncaShare`).
const PASSO_SHARE = 0.01;

(async () => {
  const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'liquidity-rewards.json'), 'utf8'));
  const righe = Array.isArray(board) ? board : (board.markets || []);
  const ora = Date.now();
  const tettoMercato = CONC.MARKET_CAP_FIXED_USD;
  // ⚠ DUE TETTI PER ORDINE, E VANNO DETTI ENTRAMBI. `liveMinOrderCapUsd()` SENZA capitale restituisce
  // $29,25, che e' il valore fail-closed (`capPerMarketUsd(undefined)` si clampa a $24,50): e' cio' che
  // vale quando il capitale non e' leggibile, non cio' che vale adesso. Al capitale di riferimento il
  // tetto e' $65,63. La prima stesura di questo script usava il primo e dichiarava «limitato dal tetto per
  // ordine» un caso che al capitale vero non lo e' — un caso peggiore SOTTOSTIMATO, cioe' sbagliato nella
  // direzione che rassicura. Si usa quello di riferimento e si dichiara l'altro.
  const tettoOrdine = CONC.LIVE_MIN_ORDER_CAP_USD;
  const tettoOrdineSenzaCapitale = CONC.liveMinOrderCapUsd();

  // ── ① IL CASO PEGGIORE, MERCATO PER MERCATO ───────────────────────────────────────────────────
  const casi = [];
  const perScaglione = new Map();
  for (const r of righe) {
    const minSize = Number(r.rewardsMinSize);
    if (!fin(minSize) || minSize <= 0) continue;
    const mid = fin(r.mid) ? r.mid : null;
    if (mid == null || mid <= 0 || mid >= 1) continue;
    // Il prezzo del lato PIU' CARO: e' quello che immobilizza piu' dollari per share.
    const pCaro = Math.max(mid, +(1 - mid).toFixed(6));
    const sizeMax = +(minSize - PASSO_SHARE).toFixed(2);
    // ⚠ I DUE TETTI VERI SOPRA: il residuo e' un frammento di una gamba, e la gamba non puo' valere piu'
    // del tetto per ordine ne' del tetto per mercato. Senza questi il conto darebbe numeri che il bot non
    // puo' produrre — cioe' un caso peggiore inventato.
    const grezzo = sizeMax * pCaro;
    const bloccato = Math.min(grezzo, tettoOrdine != null ? tettoOrdine : grezzo, tettoMercato);
    const ammissibile = SELM.valutaAmmissibilita(r,
      { ora, orizzonteMassimoOre: MAX_HORIZON_DAYS * 24 }).ammissibile === true;
    const finanziabile = CONC.pavimentoPremiante(minSize) <= tettoMercato;
    const c = { conditionId: r.conditionId, question: String(r.question || '').slice(0, 46),
      minSize, mid: +mid.toFixed(4), prezzoLatoCaro: +pCaro.toFixed(4),
      sizeMassimaResidua: sizeMax, bloccatoUsd: +bloccato.toFixed(2),
      limitatoDa: bloccato < grezzo - 1e-9 ? (tettoOrdine != null && bloccato === tettoOrdine ? 'tetto-per-ordine' : 'tetto-per-mercato') : 'minSize×prezzo',
      ammissibileAllaSelezione: ammissibile, finanziabileAlTetto: finanziabile };
    casi.push(c);
    const k = String(minSize);
    if (!perScaglione.has(k) || perScaglione.get(k).bloccatoUsd < c.bloccatoUsd) perScaglione.set(k, c);
  }
  casi.sort((a, b) => b.bloccatoUsd - a.bloccatoUsd);
  // ⚠ IL NUMERO CHE CONTA E' QUELLO SUI MERCATI CHE IL BOT PUO' DAVVERO APRIRE. Il peggiore in assoluto
  // sta su un `minSize 1000` che il pavimento premiante esclude a monte: citarlo come «caso peggiore»
  // sarebbe misurare un mercato in cui il bot non entra.
  const raggiungibili = casi.filter((c) => c.finanziabileAlTetto && c.ammissibileAllaSelezione);
  const peggioreRaggiungibile = raggiungibili[0] || null;

  // ── ② QUANTO C'E' BLOCCATO ADESSO, letto dai registri veri ────────────────────────────────────
  const leggi = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')); } catch { return null; } };
  const regResidui = leggi('residui-scoperti.json');
  const posizioni = leggi('venue-positions.json');
  const adesso = [];
  for (const p of (posizioni && posizioni.positions) || []) {
    const size = Number(p.size); const pr = Number(p.avgPrice ?? p.curPrice);
    if (!fin(size) || size <= 0) continue;
    adesso.push({ conditionId: p.conditionId || p.marketId || null, tokenId: p.asset || p.tokenId || null,
      size, prezzo: fin(pr) ? +pr.toFixed(4) : null, valoreUsd: fin(pr) ? +(size * pr).toFixed(2) : null });
  }
  const totaleAdesso = adesso.reduce((a, x) => a + (x.valoreUsd || 0), 0);

  // ── ③ LE STRADE CHE ESISTONO DAVVERO, verificate sul codice ───────────────────────────────────
  const strade = [
    { nome: 'riscatto on-chain dopo la risoluzione', esiste: typeof RIS.selezionaRiscattabili === 'function',
      minimoDiSize: 'NESSUNO — `redeemPosition` non passa dal libro',
      cablata: fs.readFileSync(path.join(ROOT, 'agents/agent40-manual-reprice.js'), 'utf8').includes("require('../lib/maker/riscatto-automatico')"),
      quando: 'quando `payoutDenominator(conditionId) > 0` letto ON-CHAIN (non «il mercato e\' chiuso»)',
      limite: 'restituisce $1/share al lato VINCENTE e $0 al perdente: recupera il capitale solo se il residuo ha vinto' },
    { nome: 'merge on-chain della coppia', esiste: true, minimoDiSize: 'NESSUNO',
      cablata: true, quando: 'quando la coppia e\' completa (`mancaAllaCoppia <= 0`)',
      limite: 'inapplicabile al caso bloccato: se il residuo sta su UN lato solo la coppia non e\' completa' },
    { nome: 'vendere il residuo a libro', esiste: true, minimoDiSize: 'minSize del venue (20/50/100/200)',
      cablata: true, quando: 'mai, sotto il minimo', limite: 'E\' la strada chiusa: il venue rifiuta l\'ordine' },
    { nome: 'accumulare fino a tornare piazzabile', esiste: true, minimoDiSize: 'minSize',
      cablata: fs.readFileSync(path.join(ROOT, 'agents/agent40-manual-reprice.js'), 'utf8').includes('residuiDaRitentare'),
      quando: 'quando la size accumulata su quel mercato/lato torna >= minSize',
      limite: 'richiede un ALTRO fill sullo stesso lato dello stesso mercato: non e\' una via d\'uscita, e\' un\'attesa' },
  ];

  const referto = { generatoIl: new Date().toISOString(),
    boardGeneratoIl: (board.meta && board.meta.generatedAt) || null,
    tetti: { perMercatoUsd: tettoMercato, perOrdineUsd: tettoOrdine,
      perOrdineSeIlCapitaleNonSiLeggeUsd: tettoOrdineSenzaCapitale, orizzonteMinimoGiorni: MIN_HORIZON_DAYS },
    casoPeggiore: {
      inAssoluto: casi[0] || null,
      suMercatiRAGGIUNGIBILI: peggioreRaggiungibile,
      perScaglione: [...perScaglione.values()].sort((a, b) => a.minSize - b.minSize),
      mercatiEsaminati: casi.length, mercatiRaggiungibili: raggiungibili.length,
    },
    bloccatoAdesso: { posizioni: adesso, totaleUsd: +totaleAdesso.toFixed(2),
      registroResiduiPresente: !!regResidui,
      vociNelRegistro: regResidui && regResidui.residui ? Object.keys(regResidui.residui).length : 0 },
    strade,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(referto, null, 1));

  console.log(`\ntetto per mercato $${tettoMercato} · tetto per ordine $${tettoOrdine.toFixed(2)}`
    + ` (se il capitale non si legge: $${tettoOrdineSenzaCapitale.toFixed(2)}, fail-closed)`);
  console.log(`\n① IL CASO PEGGIORE SU UN MERCATO SOLO (${casi.length} mercati del board esaminati)`);
  if (peggioreRaggiungibile) {
    const c = peggioreRaggiungibile;
    console.log(`   su mercati che il bot puo' DAVVERO aprire (${raggiungibili.length}):`);
    console.log(`     ${C(c.bloccatoUsd)}  = ${c.sizeMassimaResidua} share × $${c.prezzoLatoCaro}  (minSize ${c.minSize}, limitato da ${c.limitatoDa})`);
    console.log(`     ${c.question}`);
  } else {
    console.log('   nessun mercato del board e\' contemporaneamente finanziabile e ammissibile: non c\'e\' un caso peggiore da citare');
  }
  if (casi[0]) console.log(`   in assoluto sul board (mercati compresi quelli che il pavimento premiante esclude): ${C(casi[0].bloccatoUsd)} (minSize ${casi[0].minSize})`);
  console.log('   per scaglione di minSize:');
  for (const c of referto.casoPeggiore.perScaglione) {
    console.log(`     minSize ${String(c.minSize).padStart(4)} ⇒ fino a ${C(c.bloccatoUsd).padStart(8)}`
      + `  (${c.sizeMassimaResidua} × $${c.prezzoLatoCaro})${c.finanziabileAlTetto ? '' : '   [non finanziabile al tetto: il bot non entra]'}`);
  }
  console.log(`\n② BLOCCATO ADESSO: ${C(referto.bloccatoAdesso.totaleUsd)} in ${adesso.length} posizione/i`);
  for (const a of adesso) console.log(`     ${String(a.conditionId || a.tokenId).slice(0, 12)}… ${a.size} share × $${a.prezzo} = ${C(a.valoreUsd || 0)}`);
  console.log(`   registro dei residui: ${referto.bloccatoAdesso.registroResiduiPresente ? `${referto.bloccatoAdesso.vociNelRegistro} voci` : 'assente'}`);
  console.log('\n③ LE STRADE, verificate sul codice');
  for (const s of strade) {
    console.log(`   ${s.cablata ? '●' : '○'} ${s.nome}`);
    console.log(`       minimo di size : ${s.minimoDiSize}`);
    console.log(`       quando         : ${s.quando}`);
    console.log(`       limite         : ${s.limite}`);
  }
  console.log(`\nreferto → ${path.relative(ROOT, OUT)}`);
})();

function C(x) { return `$${Number(x).toFixed(2)}`; }

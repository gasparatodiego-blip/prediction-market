#!/usr/bin/env node
'use strict';
// scripts/simula-storico.js — IL SISTEMA RIPERCORSO SU UN'ORA DI STORICO VERO.
//
// ═══ COSA È, E COSA NON È ═══════════════════════════════════════════════════════════════════════════
// NON tocca il venue. Non c'è nessuna scrittura, nessuna firma, nessun ordine: le uniche cose che legge
// sono il journal dei mid, il tape degli scambi e il board dei montepremi, tutti già su disco. Il
// piazzamento non è simulato con un finto adattatore — semplicemente non esiste in questo file.
//
// Quello che fa è far girare le DECISIONI vere del sistema sui dati di un'ora passata: quali mercati
// avrebbe scelto, dove avrebbe messo gli ordini, quando li avrebbe spostati, quali sarebbero stati
// eseguiti secondo il tape reale.
//
// ═══ I TRE LIMITI, DETTI PRIMA E NON DOPO ═══════════════════════════════════════════════════════════
//   1. I MONTEPREMI SONO QUELLI DI ADESSO, non quelli di mezzanotte. `data/liquidity-rewards.json` è una
//      fotografia che agent24 sovrascrive ogni 15 minuti e l'archivio storico dei pot è vuoto. Quindi la
//      SCELTA dei mercati usa pot di oggi su prezzi di mezzanotte: è la parte meno fedele di tutto il
//      lavoro, e va letta come «con questi montepremi, su quei prezzi».
//   2. NON C'È LO STATO DEL VENUE nello storico. Chiuso, sospeso, non-negoziabile: non sono registrati,
//      quindi la verifica al venue e il gate «mercato risolto» NON possono essere esercitati qui.
//   3. I FILL SONO RICOSTRUITI DAL TAPE con reconstructTapeFillsForMarket, cioè con il modello del repo:
//      «un ordine a questo prezzo, di questa size, sarebbe stato colpito da questi scambi». È una
//      ricostruzione, non un estratto conto.
//
// Uso:  node scripts/simula-storico.js [capitale] [inizioISO] [ore]

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { planFromCollection } = require(path.join(ROOT, 'lib/rewards/allocator'));
const { planToOrders } = require(path.join(ROOT, 'lib/rewards/plan-to-orders'));
const { loadJournal } = require(path.join(ROOT, 'scripts/rewards-replay/lib/journal'));
const { loadTape, reconstructTapeFillsForMarket } = require(path.join(ROOT, 'scripts/rewards-replay/lib/tape'));
const { prezzoInCoda } = require(path.join(ROOT, 'lib/maker/prezzo-in-coda'));
const { decideRimpiazzo } = require(path.join(ROOT, 'lib/maker/rimpiazzo-gamba'));
const { planExit, EXIT_PROFIT_PCT } = require(path.join(ROOT, 'lib/maker/exit-plan'));
const { capPerMarketUsd, CONCENTRATION_CAP_FRAC } = require(path.join(ROOT, 'lib/rewards/concentration'));
const { inBand } = require(path.join(ROOT, 'lib/rewards-live-band'));

const CAPITALE = Number(process.argv[2]) || 200;
const INIZIO = Date.parse(process.argv[3] || '2026-08-04T00:00:00Z');
const ORE = Number(process.argv[4]) || 1;
const FINE = INIZIO + ORE * 3_600_000;

const usd = (v) => (Number.isFinite(v) ? `$${v.toFixed(2)}` : '—');
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
const tit = (s) => { console.log('\n' + '═'.repeat(100)); console.log(s); console.log('═'.repeat(100)); };

(async () => {
  tit(`SIMULAZIONE STORICA · ${usd(CAPITALE)} · ${new Date(INIZIO).toISOString()} → ${new Date(FINE).toISOString()}`);
  console.log('NESSUNA scrittura verso il venue. Solo journal, tape e board già su disco.');
  const tetto = capPerMarketUsd(CAPITALE);
  console.log(`tetto per mercato: ${usd(tetto)} (${Math.round(CONCENTRATION_CAP_FRAC * 100)}% di ${usd(CAPITALE)})`);

  // ── MINUTO 0 · IL PIANO ─────────────────────────────────────────────────────────────────────────
  // La finestra di storico è quella che il sistema avrebbe avuto a mezzanotte: le 48 ore PRECEDENTI.
  tit('1 · MINUTO 0 — IL PIANO CHE IL SISTEMA AVREBBE CALCOLATO');
  const piano = planFromCollection({
    capital: CAPITALE, maxPerMarketUsd: tetto, horizonFilter: true,
    from: new Date(INIZIO - 48 * 3_600_000).toISOString(),
    to: new Date(INIZIO).toISOString(),
  });
  console.log(`finestra di storico usata: ${new Date(piano.window.fromMs).toISOString()} → ${new Date(piano.window.toMs).toISOString()} (${piano.window.hours.toFixed(1)}h)`);
  console.log(`universo: ${piano.universe.withPot} con montepremi · ${piano.universe.evaluated} valutabili · ${piano.universe.chosen} scelti`);
  console.log(`modello di size: ${piano.sizing.model} (pairCost ${piano.sizing.pairCostUsd}) · tetto applicato: ${piano.concentration.capped}`);

  const esec = planToOrders(piano, { nowMs: INIZIO });
  console.log('');
  console.log('mercato        | mid     | capitale | share/lato |   YES |    NO | nozionale');
  for (const c of esec.coppie) {
    const r = piano.rows.find((x) => x.marketId === c.marketId);
    console.log(`  ${c.marketId.slice(0, 10)}… | ${r.mid.toFixed(4)}  | ${usd(c.capitalePianoUsd).padStart(8)} | ${String(c.shares).padStart(10)} | ${String(c.prezzoYes).padStart(5)} | ${String(c.prezzoNo).padStart(5)} | ${usd(c.capitaleImpegnatoUsd)}`);
  }
  if (esec.scartate.length) {
    console.log('\n  scartati prima di piazzare:');
    for (const s of esec.scartate) console.log(`    ${s.marketId.slice(0, 10)}… ${s.motivo} — ${s.dettaglio.slice(0, 80)}`);
  }
  console.log('');
  console.log(`TOTALE: ${esec.totals.eseguibili} mercati · ${esec.totals.righe} gambe · ${usd(esec.totals.capitaleUsd)} impegnati su ${usd(CAPITALE)}`);
  const maxRiga = Math.max(...esec.coppie.map((c) => c.capitalePianoUsd), 0);
  console.log(`massimo su un mercato: ${usd(maxRiga)} — tetto ${usd(tetto)} → ${maxRiga <= tetto + 1e-9 ? 'RISPETTATO' : 'SFORATO'}`);

  if (!esec.coppie.length) { console.log('\nnessuna coppia eseguibile: la simulazione si ferma qui.'); return; }

  // ── L'ORA ───────────────────────────────────────────────────────────────────────────────────────
  const J = loadJournal({ fromMs: INIZIO, toMs: FINE });
  const T = loadTape({ fromMs: INIZIO, toMs: FINE });

  // Lo stato vivo: per ogni gamba, dove sta l'ordine e con che mid è stato piazzato.
  const gambe = [];
  for (const c of esec.coppie) {
    const r = piano.rows.find((x) => x.marketId === c.marketId);
    for (const b of ['yes', 'no']) {
      gambe.push({
        marketId: c.marketId, book: b, prezzo: b === 'yes' ? c.prezzoYes : c.prezzoNo,
        share: c.shares, tick: r.tick, bandaC: r.maxSpreadCents, offsetC: c.offsetCents,
        midAlPiazzamento: b === 'yes' ? r.mid : +(1 - r.mid).toFixed(6),
        capitaleMercato: c.capitalePianoUsd,
        riprezzi: 0, fill: null, storia: [],
      });
    }
  }

  const eventi = [];
  const nota = (ms, tipo, testo) => eventi.push({ ms, tipo, testo });

  // ── 2 · IL MOVIMENTO DEGLI ORDINI ───────────────────────────────────────────────────────────────
  tit('2 · L\'ORA — COME SI SAREBBERO MOSSI GLI ORDINI');
  for (const g of gambe) {
    const rows = (J.byMarket.get(g.marketId) || []).filter((r) => r.tsMs >= INIZIO && r.tsMs <= FINE);
    if (!rows.length) { nota(INIZIO, 'dato', `${g.marketId.slice(0, 10)}… ${g.book}: nessun campione nell'ora`); continue; }
    for (const row of rows) {
      const midLato = g.book === 'no' ? +(1 - row.adjMid).toFixed(6) : row.adjMid;
      if (!Number.isFinite(midLato) || !Number.isFinite(g.tick)) continue;
      // Il trigger vero del watcher: l'ordine è ancora dentro la banda premiante?
      const dentro = inBand(g.prezzo, midLato, g.bandaC);
      if (dentro) continue;
      // FUORI BANDA ⇒ si riprezza. Il prezzo nuovo passa dalla regola della coda, con i livelli VERI
      // di quel campione — è l'unico punto della catena che lo storico permette di esercitare davvero.
      // Il journal salva UNA scala combinata del libro YES: [{index, bidPrice, bidSizeAtLevel,
      // askPrice, askSizeAtLevel}]. Va convertita nella forma {bids, asks} che prezzoInCoda si
      // aspetta — e per il libro NO va SPECCHIATA, perché un bid NO a q è un ask YES a 1−q. È lo
      // stesso specchio che usa il resto del sistema, non una seconda convenzione.
      const scala = Array.isArray(row.levels) ? row.levels : null;
      const pulisci = (a) => a.filter((x) => Number.isFinite(x.price) && Number.isFinite(x.size) && x.size > 0);
      let depth = null;
      if (scala && scala.length) {
        const bidsYes = pulisci(scala.map((l) => ({ price: Number(l.bidPrice), size: Number(l.bidSizeAtLevel) })));
        const asksYes = pulisci(scala.map((l) => ({ price: Number(l.askPrice), size: Number(l.askSizeAtLevel) })));
        depth = g.book === 'no'
          ? { readable: true, yes: null, no: { bids: pulisci(asksYes.map((l) => ({ price: +(1 - l.price).toFixed(10), size: l.size }))), asks: pulisci(bidsYes.map((l) => ({ price: +(1 - l.price).toFixed(10), size: l.size }))) } }
          : { readable: true, no: null, yes: { bids: bidsYes, asks: asksYes } };
      }
      const rules = { readable: true, tick: g.tick, maxSpreadCents: g.bandaC, books: { yes: { scoringMid: row.adjMid }, no: { scoringMid: +(1 - row.adjMid).toFixed(6) } } };
      const q = prezzoInCoda({ book: g.book, side: 'BUY', rules, depth, ownOrders: [{ price: g.prezzo, size: g.share }], offsetCents: g.offsetC });
      const nuovo = q.ok ? q.price : +(midLato - g.offsetC / 100).toFixed(10);
      if (Math.abs(nuovo - g.prezzo) < g.tick / 1000) continue;
      g.storia.push({ ms: row.tsMs, da: g.prezzo, a: nuovo, mid: midLato, modo: q.ok ? q.mode : 'fallback-senza-livelli', onTop: q.ok ? q.onTop : null });
      nota(row.tsMs, 'riprezzo', `${g.marketId.slice(0, 10)}… ${g.book.toUpperCase()} ${g.prezzo} → ${nuovo} (mid ${midLato.toFixed(4)}, ${q.ok ? q.mode : 'senza livelli'})`);
      g.prezzo = nuovo; g.midAlPiazzamento = midLato; g.riprezzi += 1;
    }
  }
  const conRiprezzi = gambe.filter((g) => g.riprezzi > 0);
  console.log(`riprezzi totali nell'ora: ${gambe.reduce((s, g) => s + g.riprezzi, 0)} su ${gambe.length} gambe`);
  if (conRiprezzi.length) {
    console.log('');
    console.log('gamba                        | riprezzi | primo movimento');
    for (const g of conRiprezzi) {
      const p = g.storia[0];
      console.log(`  ${g.marketId.slice(0, 10)}… ${g.book.toUpperCase().padEnd(4)}       | ${String(g.riprezzi).padStart(8)} | ${hhmm(p.ms)} ${p.da}→${p.a} (${p.modo}${p.onTop === true ? ', IN CIMA per restare in banda' : ''})`);
    }
  } else {
    console.log('nessuna gamba è mai uscita dalla banda premiante: nessun ordine sarebbe stato toccato.');
  }
  const modi = {};
  for (const g of gambe) for (const s of g.storia) modi[s.modo] = (modi[s.modo] || 0) + 1;
  if (Object.keys(modi).length) console.log(`\nmodi di riposizionamento: ${JSON.stringify(modi)}`);

  // ── 4 · I FILL, DAL TAPE VERO ───────────────────────────────────────────────────────────────────
  tit('4 · I FILL — RICOSTRUITI DAGLI SCAMBI REALI DELL\'ORA');
  for (const g of gambe) {
    const rows = (J.byMarket.get(g.marketId) || []).filter((r) => r.tsMs >= INIZIO && r.tsMs <= FINE);
    const tok = rows[0] && rows[0].tokenIdYes;
    const trades = (tok && T.byToken.get(tok)) || [];
    if (!trades.length || g.book === 'no') continue;   // il tape del repo copre il token YES
    const nozionale = g.prezzo * g.share;
    const res = reconstructTapeFillsForMarket(rows, trades, { offsetCents: g.offsetC, sizeUsd: nozionale, maxInventoryUsd: g.capitaleMercato });
    if (res.fills && res.fills.length) {
      g.fill = { n: res.fills.length, primo: res.fills[0] };
      nota(res.fills[0].tsMs || INIZIO, 'fill', `${g.marketId.slice(0, 10)}… ${g.book.toUpperCase()}: ${res.fills.length} fill ricostruiti`);
    }
  }
  const fillate = gambe.filter((g) => g.fill);
  if (!fillate.length) {
    console.log('Nessuna gamba sarebbe stata eseguita in quest\'ora, secondo il tape reale.');
    console.log('Il tape copre il token YES; il lato NO non ha uno storico di scambi separato in archivio.');
  } else {
    for (const g of fillate) {
      console.log(`\n${g.marketId.slice(0, 10)}… ${g.book.toUpperCase()} — ${g.fill.n} fill`);
      const carico = g.prezzo;
      const pe = planExit({ entryPrice: carico, scoringMid: g.midAlPiazzamento, tick: g.tick, bandRadiusCents: g.bandaC / 2 });
      console.log(`  uscita che si sarebbe aperta: ${pe.ok ? `${pe.price} (carico ${carico} +${EXIT_PROFIT_PCT}%, limitata da: ${pe.clampedBy})` : `NON calcolabile — ${pe.reason}`}`);
      const rimp = decideRimpiazzo({
        book: g.book, rules: { readable: true, mid: g.midAlPiazzamento, tick: g.tick, maxSpreadCents: g.bandaC, books: { yes: { scoringMid: g.midAlPiazzamento }, no: { scoringMid: +(1 - g.midAlPiazzamento).toFixed(6) } } },
        offsetCents: g.offsetC, tettoMercatoUsd: g.capitaleMercato,
        posizioneUsd: carico * g.share, ordiniApertiUsd: 0,
      });
      console.log(`  rimpiazzo della gamba: ${rimp.action === 'rimpiazza' ? `${rimp.price} × ${rimp.size} (spazio ${usd(rimp.disponibileUsd)})` : `NON piazzato — ${rimp.gate}: ${rimp.reason.slice(0, 90)}`}`);
    }
  }

  // ── 5-6 · TETTI E CAPITALE OPERATIVO ────────────────────────────────────────────────────────────
  tit('5-6 · TETTI E CAPITALE OPERATIVO');
  const perMercato = new Map();
  for (const g of gambe) perMercato.set(g.marketId, (perMercato.get(g.marketId) || 0) + g.prezzo * g.share);
  let totale = 0, sforati = 0;
  console.log('mercato        | nozionale a fine ora | tetto | esito');
  for (const [m, v] of perMercato.entries()) {
    totale += v;
    const ok = v <= tetto + 0.5;
    if (!ok) sforati += 1;
    console.log(`  ${m.slice(0, 10)}… | ${usd(v).padStart(19)} | ${usd(tetto)} | ${ok ? 'entro il tetto' : 'SFORATO'}`);
  }
  console.log('');
  console.log(`capitale impegnato a fine ora: ${usd(totale)} su ${usd(CAPITALE)} → ${totale <= CAPITALE + 0.5 ? 'ENTRO IL TETTO' : 'SFORATO'}`);
  console.log(`mercati oltre il tetto per mercato: ${sforati}`);
  const bloccato = fillate.reduce((s, g) => s + g.prezzo * g.share, 0);
  console.log(`capitale che sarebbe finito in posizioni da chiudere: ${usd(bloccato)}`);
  console.log(`capitale rimasto operativo sul book: ${usd(totale - bloccato)} (${totale > 0 ? ((1 - bloccato / totale) * 100).toFixed(1) : '100.0'}%)`);

  // Reward teorico dell'ora, dal modello del piano.
  const lordoGiorno = piano.totals.grossPerDay || 0;
  const correttoGiorno = piano.totals.realisticPerDay || 0;
  console.log('');
  console.log(`reward stimato dal modello: lordo ${usd(lordoGiorno / 24)}/ora · corretto ${usd(correttoGiorno / 24)}/ora`);
  console.log(`  (su base giornaliera: lordo ${usd(lordoGiorno)}/g · corretto ${usd(correttoGiorno)}/g)`);
  console.log('  è la stima del modello alla size del piano, NON un reward osservato: il venue non pubblica');
  console.log('  a posteriori quanto un ordine avrebbe maturato, e questo file non lo inventa.');

  tit('CRONOLOGIA DEGLI EVENTI');
  if (!eventi.length) console.log('nessun evento: gli ordini sarebbero rimasti fermi tutta l\'ora.');
  for (const e of eventi.sort((a, b) => a.ms - b.ms).slice(0, 40)) console.log(`  ${hhmm(e.ms)} [${e.tipo}] ${e.testo}`);
  if (eventi.length > 40) console.log(`  … e altri ${eventi.length - 40} eventi`);
})().catch((e) => { console.error('SIMULAZIONE INTERROTTA:', e.message, '\n', e.stack); process.exit(1); });

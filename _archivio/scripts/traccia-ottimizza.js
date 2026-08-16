#!/usr/bin/env node
'use strict';
// scripts/traccia-ottimizza.js — IL FLUSSO «OTTIMIZZA» PERCORSO DAVVERO, SENZA POTER TOCCARE IL VENUE.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════════
// Il riallocatore automatico ha `--once`: si guarda lavorare per intero senza aspettare sei ore. Il
// percorso MANUALE — «Ottimizza» e poi «Conferma ed esegui» — non aveva niente di equivalente. L'unico
// modo di sapere cosa avrebbe fatto era leggere il codice e dedurlo, che è esattamente il tipo di
// risposta che questo progetto non accetta altrove.
//
// ═══ PERCHÉ NON PUÒ PIAZZARE NIENTE, E NON PER BUONA VOLONTÀ ════════════════════════════════════════
// `MANUAL_ORDER_PLACEMENT` vale `send` su questa macchina: `placeManualOrder` RAGGIUNGE il venue. Quindi
// questo tracciatore non lo chiama mai. `runBulkAllocation` prende il piazzamento come dipendenza
// iniettata (`deps.placeOrder`), e qui la dipendenza è una funzione locale che registra e restituisce
// `sent:false`. Non è una modalità: è che la sola porta verso il venue, in quel modulo, è occupata da
// una funzione che non ha rete. Un ordine vero richiederebbe di cancellare questa riga.
//
// Le uniche chiamate che escono davvero sono LETTURE: il piano (che non firma niente) e l'anteprima del
// reset (che si ferma prima di ogni scrittura). Entrambe sono le stesse che il pannello fa da sé.
//
// Uso:  node scripts/traccia-ottimizza.js [capitale]
//       node scripts/traccia-ottimizza.js 600 --json

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const { planFromCollection } = require(path.join(ROOT, 'lib/rewards/allocator'));
const { planToOrders, gambeDiUnaRiga } = require(path.join(ROOT, 'lib/rewards/plan-to-orders'));
const { runBulkAllocation } = require(path.join(ROOT, 'lib/maker/bulk-allocate'));
const { capPerMarketUsd, MARKET_CAP_FIXED_USD } = require(path.join(ROOT, 'lib/rewards/concentration'));
const { resolveCaps, OPERATOR_USER } = require(path.join(ROOT, 'lib/maker/manual-order'));
const { readUsage } = require(path.join(ROOT, 'lib/safety/usage'));
const killSwitch = require(path.join(ROOT, 'lib/safety/kill-switch'));
const { marketValidity } = require(path.join(ROOT, 'lib/maker/market-validity'));
const { RESTING_GTD_SECONDS, REFRESH_MARGIN_SECONDS } = require(path.join(ROOT, 'lib/maker/auto-reprice-config'));

const https = require('https');
const CLOB_BASE = process.env.POLY_CLOB_BASE || 'https://clob.polymarket.com';

const passi = [];
const nota = (n, titolo, dati) => { passi.push({ n, titolo, ...dati }); };
const usd = (v) => (typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(2)}` : '—');
const riga = (s) => console.log(s);
const titolo = (s) => { console.log('\n' + '═'.repeat(96)); console.log(s); console.log('═'.repeat(96)); };

function getJson(url, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Lo stato del mercato al venue, con la stessa lettura che usa il riallocatore. SOLA LETTURA. */
async function leggiVenue(marketId) {
  let j;
  try { j = await getJson(`${CLOB_BASE}/markets/${encodeURIComponent(marketId)}`); }
  catch (e) { return { readable: false, error: e.message }; }
  if (!j || typeof j !== 'object' || j.error) return { readable: false, error: (j && j.error) || 'risposta vuota' };
  const rates = j.rewards && Array.isArray(j.rewards.rates) ? j.rewards.rates : null;
  let pot = null;
  if (rates) { pot = 0; for (const r of rates) { const v = Number(r && r.rewards_daily_rate); if (!Number.isFinite(v)) { pot = null; break; } pot += v; } }
  const maxSpread = j.rewards ? Number(j.rewards.max_spread) : NaN;
  const minSize = j.rewards ? Number(j.rewards.min_size) : NaN;
  return {
    readable: true, closed: j.closed === true,
    active: typeof j.active === 'boolean' ? j.active : null,
    acceptingOrders: typeof j.accepting_orders === 'boolean' ? j.accepting_orders : null,
    rewardsDailyRate: pot,
    maxSpreadCents: Number.isFinite(maxSpread) ? maxSpread : null,
    minSizeShares: Number.isFinite(minSize) ? minSize : null,
    endDate: typeof j.end_date_iso === 'string' ? j.end_date_iso : null,
  };
}

(async () => {
  const capitaleRichiesto = Number(process.argv[2]) || 600;
  const comeJson = process.argv.includes('--json');
  const t0 = Date.now();

  titolo('TRACCIA DEL FLUSSO «OTTIMIZZA» — ESECUZIONE REALE, PIAZZAMENTO SIMULATO');
  riga(`avvio ${new Date(t0).toISOString()} · capitale richiesto ${usd(capitaleRichiesto)}`);
  riga('nessuna chiamata di piazzamento: `placeOrder` è iniettato e non ha rete.');

  // ── 1 · IL TRIGGER ────────────────────────────────────────────────────────────────────────────
  titolo('1 · TRIGGER «Ottimizza»');
  riga('pannello   app/components/RewardsAllocatePanel.tsx → fetch(`/api/rewards/allocate?capital=N&auto=1`)');
  riga('route      app/api/rewards/allocate/route.ts:GET');
  riga('  · spawna un processo node separato che chiama planFromCollection (nessuna chiave, nessuna firma)');
  riga('  · `auto=1` accende il test dell\'orizzonte di risoluzione (lib/rewards/horizon)');
  riga('  · il tetto per mercato lo mette la route, non l\'operatore: capPerMarketUsd(capitale)');
  const tetto = capPerMarketUsd(capitaleRichiesto);
  riga(`funzione   lib/rewards/allocator.planFromCollection({ capital: ${capitaleRichiesto}, horizonFilter: true, maxPerMarketUsd: ${tetto} })`);
  nota(1, 'trigger', { route: 'app/api/rewards/allocate/route.ts', funzione: 'planFromCollection', tetto });

  // ── 2 · LA RACCOLTA DATI ──────────────────────────────────────────────────────────────────────
  titolo('2 · RACCOLTA DATI — cosa è stato letto, e quanto è fresco');
  const caps = resolveCaps({ userId: OPERATOR_USER });
  const kill = killSwitch.killStatus({});
  let uso = null; try { uso = readUsage({ userId: OPERATOR_USER }); } catch { uso = null; }

  const tPiano = Date.now();
  const piano = planFromCollection({ capital: capitaleRichiesto, horizonFilter: true, maxPerMarketUsd: tetto });
  const msPiano = Date.now() - tPiano;

  riga(`board reward      data/liquidity-rewards.json — scritto ${piano.board.atIso}, età ${piano.board.ageS}s`);
  riga(`finestra storico  ${new Date(piano.window.fromMs).toISOString()} → ${new Date(piano.window.toMs).toISOString()} (${piano.window.hours?.toFixed?.(1) ?? '—'}h)`);
  riga(`copertura         ${piano.coverage.coveredMarketCount} mercati con storico prezzi (${piano.coverage.truePct}% dell'universo reward)`);
  riga(`universo          ${piano.universe.withPot} con montepremi · ${piano.universe.evaluated} valutabili · ${piano.universe.chosen} scelti`);
  riga(`limiti di rischio maxOpenNotional ${usd(caps.maxOpenNotionalUsd)} · maxOrderNotional ${usd(caps.maxOrderNotionalUsd)} · rate ${caps.maxOrdersPerWindow}/${caps.windowMs / 1000}s`);
  riga(`esposizione       ordini già inviati nella finestra: ${uso && uso.ordersInWindow != null ? uso.ordersInWindow : '— (non misurabile)'}`);
  riga(`kill switch       ${kill.effectivelyKilled ? 'ATTIVO' : 'spento'} (leggibile: ${kill.readable})`);
  riga(`tempo di calcolo  ${(msPiano / 1000).toFixed(1)}s`);
  nota(2, 'raccolta-dati', {
    boardEtaS: piano.board.ageS, coperti: piano.coverage.coveredMarketCount,
    limiti: { maxOpenNotionalUsd: caps.maxOpenNotionalUsd, maxOrdersPerWindow: caps.maxOrdersPerWindow },
    ordersInWindow: uso ? uso.ordersInWindow : null, killed: kill.effectivelyKilled, msPiano,
  });

  // ── 3 · IL FILTRO DEI MERCATI ─────────────────────────────────────────────────────────────────
  titolo('3 · FILTRO MERCATI — chi è stato escluso, e perché');
  const perMotivo = new Map();
  for (const c of piano.candidates || []) {
    if (c.status === 'scelto') continue;
    const k = c.reasonCode || 'ignoto';
    perMotivo.set(k, (perMotivo.get(k) || 0) + 1);
  }
  for (const [k, v] of [...perMotivo.entries()].sort((a, b) => b[1] - a[1])) riga(`  ${String(v).padStart(4)}  ${k}`);
  riga(`  ${String(piano.universe.chosen).padStart(4)}  SCELTI`);
  riga('');
  riga('verifica al venue dei mercati SCELTI (lettura diretta del CLOB, non della cache):');
  const verdetti = [];
  for (const r of piano.rows) {
    const v = await leggiVenue(r.marketId);
    const cand = (piano.candidates || []).find((c) => c.marketId === r.marketId);
    const vd = marketValidity({ marketId: r.marketId, venue: v, poolAlPiano: cand ? cand.pot : null, nowMs: Date.now() });
    verdetti.push(vd);
    riga(`  ${r.shortId}  ${vd.stato.padEnd(16)} ${vd.valido === true ? 'OK' : vd.valido === false ? 'INVALIDO' : 'ILLEGGIBILE'}  ${vd.motivo.slice(0, 72)}`);
  }
  const invalidi = verdetti.filter((v) => v.valido === false);
  const illeggibili = verdetti.filter((v) => v.valido === null);
  riga(`  → ${verdetti.length - invalidi.length - illeggibili.length}/${verdetti.length} validi · ${invalidi.length} invalidi · ${illeggibili.length} illeggibili`);
  nota(3, 'filtro-mercati', { esclusiPerMotivo: Object.fromEntries(perMotivo), verdetti: verdetti.map((v) => ({ marketId: v.marketId, stato: v.stato, valido: v.valido })) });

  // ── 4-5 · SIZING E TETTI ──────────────────────────────────────────────────────────────────────
  titolo('4-5 · CALCOLO DEL PIANO — formula di sizing, tetto per mercato, tetto totale');
  riga(`modello di size   ${piano.sizing.model} · pairCostUsd ${piano.sizing.pairCostUsd}`);
  riga(`                  ${piano.sizing.note}`);
  riga(`tetto per mercato ${usd(piano.concentration.maxPerMarketUsd)} (tetto FISSO $${MARKET_CAP_FIXED_USD}) · applicato: ${piano.concentration.capped}`);
  riga(`capitale          richiesto ${usd(piano.requested)} · allocato ${usd(piano.totals.capital)} · non allocato ${usd(piano.totals.unallocated)}`);
  riga(`tetto esposizione ${usd(caps.maxOpenNotionalUsd)} — il capitale richiesto ${capitaleRichiesto <= caps.maxOpenNotionalUsd ? 'ci sta' : 'LO SUPERA'}`);
  riga('');
  const maxRiga = Math.max(...piano.rows.map((r) => r.capital));
  riga(`massimo su un singolo mercato: ${usd(maxRiga)} — tetto ${usd(piano.concentration.maxPerMarketUsd)} → ${maxRiga <= piano.concentration.maxPerMarketUsd + 1e-9 ? 'RISPETTATO' : 'SFORATO'}`);
  nota(4, 'sizing', { pairCostUsd: piano.sizing.pairCostUsd, tettoPerMercato: piano.concentration.maxPerMarketUsd, maxRiga, capitaleAllocato: piano.totals.capital });

  // ── 6 · LE GAMBE ──────────────────────────────────────────────────────────────────────────────
  titolo('6 · GENERAZIONE ORDINI — due gambe per mercato');
  riga('funzione condivisa  lib/rewards/plan-to-orders.gambeDiUnaRiga → lib/maker/mm-quote-math.planQuotes');
  riga('                    (la STESSA che importa il pannello e che usa il riallocatore automatico)');
  const esec = planToOrders(piano, {});
  riga('');
  riga('mercato          | share/lato |   YES BUY |    NO BUY | nozionale | capitale del piano');
  for (const c of esec.coppie) {
    riga(`  ${c.marketId.slice(0, 10)}… | ${String(c.shares).padStart(10)} | ${String(c.prezzoYes).padStart(9)} | ${String(c.prezzoNo).padStart(9)} | ${usd(c.capitaleImpegnatoUsd).padStart(9)} | ${usd(c.capitalePianoUsd)}`);
  }
  if (esec.scartate.length) {
    riga('');
    riga('scartate in questa fase:');
    for (const s of esec.scartate) riga(`  ${s.marketId.slice(0, 10)}…  ${s.motivo} — ${s.dettaglio.slice(0, 90)}`);
  }
  riga('');
  riga(`totale: ${esec.totals.eseguibili} mercati · ${esec.totals.righe} gambe · ${usd(esec.totals.capitaleUsd)} impegnati`);
  const sbilanciate = esec.coppie.filter((c) => Math.abs(c.prezzoYes + c.prezzoNo - (1 - 2 * (c.offsetCents / 100))) > 1e-6);
  riga(`coerenza p_yes + p_no = 1 − 2d: ${sbilanciate.length === 0 ? 'verificata su tutte le coppie' : `${sbilanciate.length} coppie fuori (aggancio al tick)`}`);
  nota(6, 'gambe', { mercati: esec.totals.eseguibili, gambe: esec.totals.righe, capitale: esec.totals.capitaleUsd, scartate: esec.scartate.map((s) => ({ marketId: s.marketId, motivo: s.motivo })) });

  // ── 7 · L'ANTEPRIMA ───────────────────────────────────────────────────────────────────────────
  titolo('7 · ANTEPRIMA — lo step esplicito prima di «Conferma ed esegui»');
  riga('pannello  «1 · Anteprima» → POST /api/maker/manual/bulk-allocate { rows, preview: true }');
  riga('route     runAllocationReset({ rows, dryRunOnly: true }) — legge l\'inventario e si ferma PRIMA di ogni scrittura');
  const antep = await runBulkAllocation({ rows: esec.rows, dryRunOnly: true }, {
    placeOrder: async () => { throw new Error('IMPOSSIBILE: l\'anteprima non deve mai piazzare'); },
    openNotionalUsd: 0,
    ordersInWindow: uso && uso.ordersInWindow != null ? uso.ordersInWindow : 0,
  });
  riga(`referto   ok=${antep.ok} · righe ${antep.totals.rows} · mercati ${antep.totals.mercati} · saltate ${antep.skipped} (tutte «anteprima: nulla è stato inviato»)`);
  riga(`          nozionale richiesto ${usd(antep.totals.requestedUsd)} · inviato ${usd(antep.totals.placedUsd)}`);
  nota(7, 'anteprima', { ok: antep.ok, righe: antep.totals.rows, inviato: antep.totals.placedUsd });

  // ── 8 · IL PIAZZAMENTO, SIMULATO ──────────────────────────────────────────────────────────────
  titolo('8 · PIAZZAMENTO — percorso reale di bulk-allocate, piazzamento iniettato (zero rete)');
  const inviati = [];
  const cancellati = [];
  const simulaPiazzamento = (esiti = {}) => async (spec) => {
    inviati.push(spec);
    const k = `${spec.marketId}:${spec.book}`;
    if (esiti[k]) return { ok: false, reason: esiti[k], gate: 'simulato' };
    return { ok: true, sent: false, orderId: `SIM-${inviati.length}` };
  };
  const simulaCancel = async ({ orderId, marketId }) => { cancellati.push({ orderId, marketId }); return { ok: true, cancelled: true }; };

  riga('── 8a · tutte le gambe accettate ────────────────────────────────────────────────────────');
  const r8a = await runBulkAllocation({ rows: esec.rows }, {
    placeOrder: simulaPiazzamento(), cancelOrder: simulaCancel,
    openNotionalUsd: 0, ordersInWindow: uso && uso.ordersInWindow != null ? uso.ordersInWindow : 0,
  });
  riga(`  ordini «inviati» (simulati): ${inviati.length} · placed ${r8a.placed} · refused ${r8a.refused} · skipped ${r8a.skipped}`);
  riga(`  mercati completi: ${r8a.totals.mercatiCompleti}/${r8a.totals.mercati} · nozionale ${usd(r8a.totals.placedUsd)}`);
  riga(`  ok=${r8a.ok} · stoppedBy=${r8a.stoppedBy || 'nessuno'}`);
  riga(`  ogni ordine porta sent=false (costruito, MAI inviato): ${r8a.results.filter((x) => x.status === 'placed').every((x) => x.sent === false)}`);
  const ordine = inviati.map((s) => `${s.book}`).join(',');
  riga(`  ordine delle gambe: ${ordine} — le due di uno stesso mercato sono consecutive: ${(() => { const m = inviati.map((s) => s.marketId); for (let i = 0; i < m.length; i += 2) if (m[i] !== m[i + 1]) return false; return true; })()}`);

  riga('');
  riga('── 8b · rate limit sulla coppia intera ──────────────────────────────────────────────────');
  const quasiPieno = caps.maxOrdersPerWindow - 1;
  const r8b = await runBulkAllocation({ rows: esec.rows }, {
    placeOrder: async () => ({ ok: true, sent: false, orderId: 'SIM' }), cancelOrder: simulaCancel,
    openNotionalUsd: 0, ordersInWindow: quasiPieno,
  });
  riga(`  con ${quasiPieno}/${caps.maxOrdersPerWindow} ordini già nella finestra (posto per UNA gamba sola):`);
  riga(`  stoppedBy=${r8b.stoppedBy} · placed ${r8b.placed} · skipped ${r8b.skipped}`);
  riga(`  → ${r8b.placed === 0 ? 'NESSUNA gamba inviata: meglio una coppia non inviata che una spezzata' : 'ATTENZIONE: qualcosa è passato'}`);

  riga('');
  riga('── 8c · una gamba rifiutata → ripristino dell\'altra ─────────────────────────────────────');
  inviati.length = 0; cancellati.length = 0;
  const primo = esec.coppie[0];
  const r8c = await runBulkAllocation({ rows: esec.rows }, {
    placeOrder: simulaPiazzamento({ [`${primo.marketId}:no`]: 'simulazione: il venue rifiuta la gamba NO' }),
    cancelOrder: simulaCancel,
    openNotionalUsd: 0, ordersInWindow: uso && uso.ordersInWindow != null ? uso.ordersInWindow : 0,
  });
  riga(`  gamba NO di ${primo.marketId.slice(0, 10)}… rifiutata`);
  riga(`  → gambe ritirate: ${r8c.rolledBack} · orfane: ${r8c.orphan} · cancellazioni emesse: ${cancellati.length}`);
  riga(`  → referto ok=${r8c.ok} (un ripristino non è un successo)`);
  riga(`  → il resto della sequenza ${r8c.placed > 0 ? `è proseguito (${r8c.placed} gambe piazzate sugli altri mercati)` : 'non è proseguito'}`);
  nota(8, 'piazzamento-simulato', {
    a: { placed: r8a.placed, mercatiCompleti: r8a.totals.mercatiCompleti, ok: r8a.ok },
    b: { stoppedBy: r8b.stoppedBy, placed: r8b.placed },
    c: { rolledBack: r8c.rolledBack, orphan: r8c.orphan, cancellazioni: cancellati.length },
  });

  // ── 9 · DOPO IL PIAZZAMENTO ───────────────────────────────────────────────────────────────────
  titolo('9 · POST-PIAZZAMENTO — riconciliazione e dead-man\'s switch');
  riga(`GTD a riposo      ${RESTING_GTD_SECONDS}s (${Math.round(RESTING_GTD_SECONDS / 60)} min), fatta rispettare dal VENUE su OGNI ordine`);
  riga(`rinnovo proattivo ${REFRESH_MARGIN_SECONDS}s (${Math.round(REFRESH_MARGIN_SECONDS / 60)} min) di margine — agent40 rinnova ogni gamba separatamente`);
  riga('riconciliazione   lib/maker/manual-reset.reconcileManualLane, su throttle proprio dentro agent40');
  riga('                  lettura del venue ACCOUNT-WIDE, confronto per orderId (non per mercato)');
  nota(9, 'post-piazzamento', { restingGtdSeconds: RESTING_GTD_SECONDS, refreshMarginSeconds: REFRESH_MARGIN_SECONDS });

  titolo('FINE — ordini reali inviati: 0 (il piazzamento non ha rete, per costruzione)');
  riga(`durata totale ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (comeJson) console.log('\n' + JSON.stringify({ at: new Date(t0).toISOString(), capitaleRichiesto, passi }, null, 2));
})().catch((e) => { console.error('\n!!! TRACCIA INTERROTTA:', e.message, '\n', e.stack); process.exit(1); });

#!/usr/bin/env node
'use strict';
// I TRE LIVELLI DIVENTANO VIVI — E IL GATE SMETTE DI CONFONDERE UN'USCITA CON UN INGRESSO.
//
// L'8 agosto 2026 la gerarchia del merge esisteva solo sulla carta, per quattro difetti indipendenti
// che si nascondevano a vicenda (CLAUDE.md §5 punti 26 e 27):
//
//   1 · `MERGE_STRATEGY_ENABLED` era false, e il ramo che ESEGUE i Livelli 1 e 2 non era mai stato
//       scritto: accendere l'interruttore avrebbe cambiato solo la stringa nell'audit, che è peggio
//       di lasciarlo spento — l'audit avrebbe dichiarato eseguito ciò che non accadeva.
//   2 · `readDepth` non era iniettato in `closeTask`, quindi `asksAltroLato` arrivava SEMPRE null e il
//       Livello 1 non era valutabile: si cadeva al Livello 2 a prescindere dal prezzo vero.
//   3 · lo stesso `size: 0` usciva da «scala ask assente» e da «scala letta e tutta sopra il tetto», e
//       l'audit scriveva «l ask è sopra il tetto» anche quando nessuno l'aveva letta.
//   4 · `attesaDaMs` non veniva mai passato, quindi il timeout di 60 minuti era codice irraggiungibile.
//
// E sotto tutto questo, il difetto che costava davvero: la allowlist live-min veniva applicata alle
// USCITE. Riscritta dal reset di agent41 mentre due posizioni erano aperte, ha lasciato Matt Little e
// Schwartzel senza via d'uscita — l'uscita rifiutata ogni 60 secondi dal presidio che doveva proteggerle.
//
// Tutto qui dentro gira su DATI FINTI: nessun venue, nessuna rete, nessun ordine, nessun capitale.

const { decidiLivello, quantoAlVolo, MERGE_STRATEGY_ENABLED, MERGE_WAIT_TIMEOUT_MIN } = require('./strategia-merge');
const { evaluateLiveMinMarketGate, evaluateReductionProof } = require('../venues/polymarket-clob-maker/adapter');
const { runAutoCloseCycle } = require('./auto-close');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const MERCATO = '0x' + 'ab'.repeat(32);
const FUORI  = '0x' + 'cd'.repeat(32);
const TOK_YES = '111';
const TOK_NO  = '222';

// ═══ 1 · IL GATE live-min DISTINGUE UNA RIDUZIONE DA UN INGRESSO ═══════════════════════════════════
console.log('\n1 · gate live-min: riduzione permessa, ingresso no');

const gateBase = { mode: 'live-min', liveMinMarket: '', allowedMarketIds: [MERCATO] };

{
  // Il caso vero dell'8 agosto: Matt Little era uscito dalla allowlist e teneva 32,27 share.
  const r = evaluateLiveMinMarketGate({ ...gateBase, marketId: FUORI, side: 'SELL', size: 32.27, heldSize: 32.27 });
  ok('uscita su mercato FUORI allowlist: permessa', r.allow === true && r.riduzione === true, r.gate || 'allow');
  ok('  e il motivo dice che è una riduzione provata', /riduzione provata/.test(r.reason || ''));
}
{
  const r = evaluateLiveMinMarketGate({ ...gateBase, marketId: FUORI, side: 'SELL', size: 10, heldSize: 32.27 });
  ok('uscita PARZIALE su mercato fuori allowlist: permessa', r.allow === true && r.riduzione === true);
}
{
  // LA NON-REGRESSIONE, ed è il punto: un ingresso resta bloccato esattamente come prima.
  const r = evaluateLiveMinMarketGate({ ...gateBase, marketId: FUORI, side: 'BUY', size: 10, heldSize: 32.27 });
  ok('INGRESSO su mercato fuori allowlist: ancora bloccato', r.allow === false && r.gate === 'live-min-market-mismatch');
}
{
  const r = evaluateLiveMinMarketGate({ ...gateBase, marketId: FUORI, side: 'SELL', size: 50, heldSize: 32.27 });
  ok('SELL più grande di quanto si detiene: bloccato', r.allow === false && r.gate === 'live-min-market-mismatch',
    'vendere più del posseduto non è una riduzione');
}
{
  const r = evaluateLiveMinMarketGate({ ...gateBase, marketId: FUORI, side: 'SELL', size: 10, heldSize: null });
  ok('SELL con possesso NON leggibile: bloccato', r.allow === false,
    '«non ho potuto controllare» non vale «ho controllato»');
}
{
  const r = evaluateLiveMinMarketGate({ ...gateBase, marketId: FUORI, side: 'SELL', size: 10, heldSize: 0 });
  ok('SELL con possesso ZERO: bloccato', r.allow === false, 'zero share non autorizzano nulla');
}
{
  const r = evaluateLiveMinMarketGate({ ...gateBase, marketId: MERCATO, side: 'SELL', size: 10, heldSize: 10 });
  ok('mercato IN allowlist: passa dalla via normale, non dall\'eccezione', r.allow === true && r.riduzione !== true,
    'l\'audit non deve segnalare un\'eccezione che non è servita');
}
{
  const r = evaluateLiveMinMarketGate({ mode: 'live-min', allowedMarketIds: [], marketId: FUORI, side: 'SELL', size: 5, heldSize: 5 });
  ok('allowlist VUOTA: l\'uscita passa comunque', r.allow === true && r.riduzione === true,
    'una posizione va potuta chiudere anche se nessun mercato è abilitato');
}
{
  const r = evaluateLiveMinMarketGate({ mode: 'live-min', allowedMarketIds: [], marketId: FUORI, side: 'BUY', size: 5, heldSize: 5 });
  ok('allowlist VUOTA + BUY: ancora rifiutato', r.allow === false && r.gate === 'live-min-market-unset');
}
{
  const r = evaluateLiveMinMarketGate({ mode: 'live', allowedMarketIds: [], marketId: FUORI, side: 'BUY', size: 5 });
  ok('modo diverso da live-min: il gate non si applica (invariato)', r.allow === true);
}
// La prova pura, esaurita sui bordi.
ok('prova di riduzione: BUY non è mai una riduzione', evaluateReductionProof({ side: 'BUY', size: 1, heldSize: 100 }).riduce === false);
ok('prova di riduzione: size === held è permessa (bordo incluso)', evaluateReductionProof({ side: 'SELL', size: 32.27, heldSize: 32.27 }).riduce === true);
ok('prova di riduzione: heldSize undefined non passa', evaluateReductionProof({ side: 'SELL', size: 1 }).riduce === false);
ok('prova di riduzione: heldSize negativo non passa', evaluateReductionProof({ side: 'SELL', size: 1, heldSize: -5 }).riduce === false);

// ═══ 2 · «ASK NON LETTA» NON È PIÙ «ASK SOPRA IL TETTO» ════════════════════════════════════════════
console.log('\n2 · scala ask assente ≠ scala ask cara');

const posBase = { book: 'yes', sizePosseduta: 32.27, prezzoCarico: 0.80, sizeAltroLato: 0, now: 1_000_000 };

{
  const senza = decidiLivello({ ...posBase, asksAltroLato: null });
  const cara  = decidiLivello({ ...posBase, asksAltroLato: [{ price: 0.50, size: 100 }] });
  ok('entrambi finiscono al Livello 2', senza.livello === 2 && cara.livello === 2,
    'un ordine maker sotto il tetto è limitato per costruzione: va bene in entrambi i casi');
  ok('ma il motivo è DIVERSO', senza.motivo !== cara.motivo);
  ok('  senza scala: dice che non è disponibile', /NON e' disponibile|non letta/i.test(senza.motivo));
  ok('  senza scala: NON afferma che il prezzo è sopra il tetto', !/e' sopra il tetto/.test(senza.motivo));
  ok('  con scala cara: afferma che è sopra il tetto', /e' sopra il tetto/.test(cara.motivo));
  ok('askLetta viaggia nei numeri: false quando assente', senza.numeri.askLetta === false);
  ok('askLetta viaggia nei numeri: true quando letta', cara.numeri.askLetta === true);
}
{
  const q0 = quantoAlVolo(null, 0.19, 32.27);
  const q1 = quantoAlVolo([{ price: 0.50, size: 100 }], 0.19, 32.27);
  ok('quantoAlVolo distingue i due zeri', q0.size === 0 && q1.size === 0 && q0.letta === false && q1.letta === true);
}

// ═══ 3 · IL LIVELLO 1 SCATTA QUANDO IL PREZZO C'È DAVVERO ══════════════════════════════════════════
console.log('\n3 · Livello 1 con una scala ask vera');
{
  // Carico 0,80 ⇒ tetto = 100 − 80 − 1 = 19¢. Un ask a 15¢ ci sta sotto.
  const r = decidiLivello({ ...posBase, asksAltroLato: [{ price: 0.15, size: 40 }] });
  ok('ask sotto il tetto ⇒ Livello 1', r.livello === 1 && r.azione === 'compra-taker', `${r.livello}/${r.azione}`);
  ok('  la coppia costa meno di 100¢', r.numeri.coppiaCents < 100, `${r.numeri.coppiaCents}¢`);
  ok('  size limitata a quanto manca', r.size === 32.27, String(r.size));
}
{
  const r = decidiLivello({ ...posBase, asksAltroLato: [{ price: 0.15, size: 10 }, { price: 0.60, size: 100 }] });
  ok('scala parziale: prende solo ciò che sta sotto il tetto', r.livello === 1 && r.size === 10, String(r.size));
  ok('  e dichiara il residuo che passa al Livello 2', r.numeri.residuo === 22.27, String(r.numeri.residuo));
}

// ═══ 4 · IL TIMEOUT DI 60 MINUTI ESISTE DAVVERO ════════════════════════════════════════════════════
console.log('\n4 · timeout del Livello 2');
{
  const t0 = 1_000_000;
  const dentro = decidiLivello({ ...posBase, asksAltroLato: [{ price: 0.9, size: 5 }], attesaDaMs: t0, now: t0 + 59 * 60_000 });
  const oltre  = decidiLivello({ ...posBase, asksAltroLato: [{ price: 0.9, size: 5 }], attesaDaMs: t0, now: t0 + 61 * 60_000 });
  ok('a 59 minuti si aspetta ancora (Livello 2)', dentro.livello === 2, `livello ${dentro.livello}`);
  ok('a 61 minuti scatta il Livello 3', oltre.livello === 3 && oltre.azione === 'auto-close', `livello ${oltre.livello}`);
  ok('  il motivo cita i minuti trascorsi', /61 minuti/.test(oltre.motivo));
  ok('  attesaMin è un numero, non null', oltre.numeri.attesaMin === 61);
  ok(`  il limite è ${MERGE_WAIT_TIMEOUT_MIN} minuti`, MERGE_WAIT_TIMEOUT_MIN === 60);
}
{
  const r = decidiLivello({ ...posBase, asksAltroLato: [{ price: 0.9, size: 5 }], attesaDaMs: null, now: 9e12 });
  ok('senza attesa registrata il timeout non scatta', r.livello === 2 && r.numeri.attesaMin === null);
}

// ═══ 5 · LA GERARCHIA INTERA, DENTRO IL CICLO VERO ═════════════════════════════════════════════════
console.log('\n5 · end-to-end simulato: fill → L1 / L2 → timeout → L3');

ok('l\'interruttore è ACCESO', MERGE_STRATEGY_ENABLED === true);

/** Un registro delle attese in memoria, con la stessa interfaccia di quello su file di agent40. */
function registroFinto(iniziale = {}) {
  const m = new Map(Object.entries(iniziale));
  return { leggi: (k) => m.get(k) || null, segna: (k, r) => m.set(k, r), pulisci: (k) => m.delete(k), _m: m };
}

/** Il ciclo con ogni effetto iniettato: nessun venue, nessuna rete. */
async function ciclo({ asks, registro, now = 5_000_000, ordini = [] }) {
  const piazzati = [];
  const cancellati = [];
  const res = await runAutoCloseCycle({
    now: () => now,
    marketIds: [MERCATO],
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isEnabled: () => ({ enabled: true }),
    isManual: () => ({ manual: true, readable: true }),
    resolveRules: () => ({
      readable: true, tokenId: TOK_YES, tokenIdNo: TOK_NO, tick: 0.01, minSize: 5, maxSpreadCents: 4.5,
      books: { yes: { scoringMid: 0.80, bestBid: 0.79 }, no: { scoringMid: 0.20, bestBid: 0.19 } },
    }),
    readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
    readPositions: async () => ({ ok: true, positions: [{ tokenId: TOK_YES, size: 32.27, avgPrice: 0.80 }] }),
    listOrders: async () => ({ ok: true, orders: ordini }),
    readDepth: () => ({ readable: true, yes: { asks: null }, no: { asks } }),
    attesaMerge: registro,
    placeOrder: async (spec) => { piazzati.push(spec); return { ok: true, sent: true, orderId: 'ord-' + piazzati.length }; },
    cancelOrder: async (spec) => { cancellati.push(spec); return { ok: true }; },
    audit: () => {},
  });
  return { res, piazzati, cancellati };
}

(async () => {
  // ── 5a · ask conveniente ⇒ Livello 1: compra il secondo lato, NON vende il primo ────────────────
  {
    const reg = registroFinto();
    const { piazzati } = await ciclo({ asks: [{ price: 0.15, size: 100 }], registro: reg });
    ok('L1 · piazza esattamente un ordine', piazzati.length === 1, `${piazzati.length}`);
    const o = piazzati[0] || {};
    ok('L1 · è un BUY sul secondo lato (NO)', o.side === 'BUY' && o.book === 'no', `${o.side}/${o.book}`);
    ok('L1 · NON è la vendita d\'uscita', o.side !== 'SELL');
    ok('L1 · attraversa lo spread di proposito', o.attraversaApposta === true);
    ok('L1 · prezzo sul tick e sotto il tetto', o.price <= 0.19 + 1e-9 && Math.abs(o.price * 100 - Math.round(o.price * 100)) < 1e-6, String(o.price));
    ok('L1 · non apre un\'attesa (è immediato)', reg._m.size === 0);
  }

  // ── 5b · ask troppo cara ⇒ Livello 2: ordine maker al tetto, e l'orologio parte ─────────────────
  let attesaAperta = null;
  {
    const reg = registroFinto();
    const { piazzati } = await ciclo({ asks: [{ price: 0.90, size: 100 }], registro: reg, now: 5_000_000 });
    ok('L2 · piazza esattamente un ordine', piazzati.length === 1, `${piazzati.length}`);
    const o = piazzati[0] || {};
    ok('L2 · è un BUY maker sul secondo lato', o.side === 'BUY' && o.book === 'no' && o.inCoda === true);
    ok('L2 · NON attraversa lo spread', !o.attraversaApposta);
    ok('L2 · prezzo arrotondato GIÙ al tetto', o.price === 0.19, String(o.price));
    ok('L2 · l\'orologio è partito', reg._m.size === 1);
    attesaAperta = [...reg._m.entries()][0];
    ok('L2 · l\'attesa ricorda l\'orderId da cancellare', !!(attesaAperta[1] && attesaAperta[1].orderId));
  }

  // ── 5c · attesa in corso: non si ripiazza niente ────────────────────────────────────────────────
  {
    const reg = registroFinto({ [attesaAperta[0]]: attesaAperta[1] });
    const { piazzati } = await ciclo({ asks: [{ price: 0.90, size: 100 }], registro: reg, now: 5_000_000 + 30 * 60_000 });
    ok('attesa · a 30 minuti non piazza nulla', piazzati.length === 0, `${piazzati.length}`);
  }

  // ── 5d · timeout: cancella il completamento e SOLO ALLORA vende (Livello 3) ─────────────────────
  {
    const reg = registroFinto({ [attesaAperta[0]]: attesaAperta[1] });
    const { piazzati, cancellati } = await ciclo({ asks: [{ price: 0.90, size: 100 }], registro: reg, now: 5_000_000 + 61 * 60_000 });
    ok('L3 · ha cancellato l\'ordine di completamento', cancellati.length === 1 && cancellati[0].orderId === attesaAperta[1].orderId);
    ok('L3 · e poi ha piazzato la vendita d\'uscita', piazzati.length === 1 && piazzati[0].side === 'SELL', JSON.stringify(piazzati.map((p) => p.side)));
    ok('L3 · l\'attesa è stata ripulita', reg._m.size === 0);
  }

  // ── 5e · senza registro il merge non parte: si comporta come prima ──────────────────────────────
  {
    const { piazzati } = await ciclo({ asks: [{ price: 0.15, size: 100 }], registro: null });
    ok('senza registro · ripiega sul Livello 3 (vendita)', piazzati.length === 1 && piazzati[0].side === 'SELL',
      'fail-closed: senza orologio il L2 non avrebbe scadenza');
  }

  // ── 5f · la cancellazione fallita NON lascia comprare e vendere insieme ─────────────────────────
  {
    const reg = registroFinto({ [attesaAperta[0]]: attesaAperta[1] });
    const piazzati = [];
    await runAutoCloseCycle({
      now: () => 5_000_000 + 61 * 60_000,
      marketIds: [MERCATO],
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      isEnabled: () => ({ enabled: true }),
      isManual: () => ({ manual: true, readable: true }),
      resolveRules: () => ({ readable: true, tokenId: TOK_YES, tokenIdNo: TOK_NO, tick: 0.01, minSize: 5, maxSpreadCents: 4.5,
        books: { yes: { scoringMid: 0.80, bestBid: 0.79 }, no: { scoringMid: 0.20, bestBid: 0.19 } } }),
      readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
      readPositions: async () => ({ ok: true, positions: [{ tokenId: TOK_YES, size: 32.27, avgPrice: 0.80 }] }),
      listOrders: async () => ({ ok: true, orders: [] }),
      readDepth: () => ({ readable: true, yes: { asks: null }, no: { asks: [{ price: 0.90, size: 100 }] } }),
      attesaMerge: reg,
      placeOrder: async (s) => { piazzati.push(s); return { ok: true, sent: true, orderId: 'x' }; },
      cancelOrder: async () => ({ ok: false, reason: 'venue irraggiungibile' }),
      audit: () => {},
    });
    ok('cancellazione fallita · NON vende', piazzati.length === 0,
      'con il BUY di completamento ancora vivo, vendere significherebbe comprare e vendere insieme');
  }

  // ── 5h · IL LIVELLO 1 RIFIUTATO DAL GATE ANTI-TAKER DEGRADA A LIVELLO 2, NON A LIVELLO 3 ───────
  // `manual-order` consente di attraversare lo spread solo in VENDITA: un BUY aggressivo (il Livello 1)
  // viene rifiutato, e quella regola non è stata toccata. La gerarchia deve reggere lo stesso.
  console.log('\n5h · degradazione L1 → L2 quando il BUY aggressivo è rifiutato');
  {
    const reg = registroFinto();
    const visti = [];
    await runAutoCloseCycle({
      now: () => 5_000_000,
      marketIds: [MERCATO],
      killStatus: () => ({ effectivelyKilled: false, readable: true }),
      isEnabled: () => ({ enabled: true }),
      isManual: () => ({ manual: true, readable: true }),
      resolveRules: () => ({ readable: true, tokenId: TOK_YES, tokenIdNo: TOK_NO, tick: 0.01, minSize: 5, maxSpreadCents: 4.5,
        books: { yes: { scoringMid: 0.80, bestBid: 0.79 }, no: { scoringMid: 0.20, bestBid: 0.19 } } }),
      readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
      readPositions: async () => ({ ok: true, positions: [{ tokenId: TOK_YES, size: 32.27, avgPrice: 0.80 }] }),
      listOrders: async () => ({ ok: true, orders: [] }),
      // ask a 15¢: sotto il tetto di 19¢ ⇒ decidiLivello dice Livello 1.
      readDepth: () => ({ readable: true, yes: { asks: null }, no: { asks: [{ price: 0.15, size: 100 }] } }),
      attesaMerge: reg,
      placeOrder: async (s) => {
        visti.push(s);
        // Il gate anti-taker rifiuta il BUY che attraversa, come fa quello vero.
        if (s.attraversaApposta === true && s.side === 'BUY') return { ok: false, gate: 'cross', reason: 'un BUY non puo attraversare' };
        return { ok: true, sent: true, orderId: 'ord-2' };
      },
      cancelOrder: async () => ({ ok: true }),
      audit: () => {},
    });
    ok('ha tentato il Livello 1 per primo', visti.length >= 1 && visti[0].attraversaApposta === true);
    ok('rifiutato, ha tentato il Livello 2 nello STESSO ciclo', visti.length === 2 && visti[1].inCoda === true && visti[1].side === 'BUY',
      JSON.stringify(visti.map((v) => `${v.side}/${v.attraversaApposta ? 'taker' : 'maker'}`)));
    ok('NON è precipitato al Livello 3 (nessuna vendita)', !visti.some((v) => v.side === 'SELL'));
    ok('e l\'orologio del Livello 2 è partito', reg._m.size === 1);
  }

  // ── 5i · IL LIVELLO 2 DEVE RIPOSARE, NON INCROCIARE ────────────────────────────────────────────
  console.log('\n5i · il prezzo del Livello 2 sta sotto il miglior ask');
  {
    const reg = registroFinto();
    // Tetto 19¢ e miglior ask del secondo lato a 19,5¢: sopra il tetto (quindi Livello 2, non 1), ma
    // cosi' vicino che prezzare AL tetto lascerebbe l'ordine a un tick dall'incrocio. Deve scendere.
    const { piazzati } = await ciclo({ asks: [{ price: 0.195, size: 100 }], registro: reg });
    const o = piazzati.find((p) => p.side === 'BUY') || {};
    ok('prezza sotto il miglior ask, non sul tetto', o.price === 0.18, `${o.price} (tetto 0.19, ask 0.19)`);
    ok('  e resta un ordine che riposa', o.inCoda === true);
  }

  // ── 5g · L'INIEZIONE C'È DAVVERO NEL PROCESSO VERO ─────────────────────────────────────────────
  // I test qui sopra iniettano `readDepth` da soli, quindi passerebbero anche se agent40 continuasse a
  // non passarlo — che è esattamente il difetto originale. Questo lo legge dal sorgente.
  console.log('\n5g · agent40 inietta davvero le dipendenze del merge');
  {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', '..', 'agents', 'agent40-manual-reprice.js'), 'utf8');
    const i = src.indexOf('async function closeTask');
    const j = src.indexOf('async function', i + 10);
    const blocco = src.slice(i, j > i ? j : src.length);
    ok('closeTask inietta readDepth', /readDepth:\s*\(marketId\)\s*=>\s*resolveMarketDepth\(marketId\)/.test(blocco));
    ok('closeTask inietta il registro delle attese', /attesaMerge:\s*registroAttesaMerge\(\)/.test(blocco));
    ok('il registro scrive su disco, non in memoria', /MERGE_WAIT_FILE\s*=\s*path\.join/.test(src));
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passati, ${fail} falliti\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

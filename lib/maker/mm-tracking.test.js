#!/usr/bin/env node
'use strict';
// Unit test del motore di market making a due lati. Aritmetica e decisioni: nessuna rete, nessun venue,
// nessun ordine. Il ciclo completo gira con ogni dipendenza iniettata, quindi «piazzare» qui significa
// chiamare una funzione finta che registra cosa avrebbe fatto.

const T = require('./mm-tracking');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const c = (p) => +(p * 100).toFixed(4);

// ═══ L'ESEMPIO CONCORDATO ═══════════════════════════════════════════════════════════════════════════
console.log('\n── mid 10¢, offset 3¢ → bid 7¢ e ask 13¢');
{
  const p = T.planQuotes({ mid: 0.10, offsetCents: 3, tick: 0.01, bandRadiusCents: 2.25 });
  ok('il piano e utilizzabile', p.ok);
  ok('BUY YES a 7¢', c(p.yes.price) === 7, `${c(p.yes.price)}¢`);
  ok('BUY NO a 87¢', c(p.no.price) === 87, `${c(p.no.price)}¢`);
  ok('  cioe VENDERE YES a 13¢', c(1 - p.no.price) === 13, `${c(1 - p.no.price)}¢`);
  ok('offset 3¢ oltre il raggio 2.25¢ ⇒ entrambi i lati FUORI banda', p.yes.inBand === false && p.no.inBand === false);
  ok('  e lo dice, invece di tacerlo', /fuori banda/.test(p.yes.bandNote || ''), (p.yes.bandNote || '').slice(0, 60));
}

console.log('\n── il mid passa a 11¢ → bid 8¢ e ask 14¢');
{
  const p = T.planQuotes({ mid: 0.11, offsetCents: 3, tick: 0.01, bandRadiusCents: 2.25 });
  ok('BUY YES a 8¢', c(p.yes.price) === 8, `${c(p.yes.price)}¢`);
  ok('BUY NO a 86¢', c(p.no.price) === 86, `${c(p.no.price)}¢`);
  ok('  cioe VENDERE YES a 14¢', c(1 - p.no.price) === 14, `${c(1 - p.no.price)}¢`);
}

console.log('\n── l offset resta costante comunque si muova il mid');
{
  for (const mid of [0.05, 0.2, 0.37, 0.5, 0.73, 0.9]) {
    const p = T.planQuotes({ mid, offsetCents: 2, tick: 0.01 });
    const dYes = c(mid) - c(p.yes.price);
    const dNo = c(1 - mid) - c(p.no.price);
    ok(`  mid ${c(mid)}¢ ⇒ entrambi i lati a 2¢ dal proprio mid`,
      Math.abs(dYes - 2) < 1e-6 && Math.abs(dNo - 2) < 1e-6, `yes −${dYes.toFixed(2)}¢ · no −${dNo.toFixed(2)}¢`);
  }
}

console.log('\n── dentro banda quando l offset ci sta');
{
  const p = T.planQuotes({ mid: 0.5, offsetCents: 2, tick: 0.01, bandRadiusCents: 2.25 });
  ok('offset 2¢ sotto il raggio 2.25¢ ⇒ dentro banda', p.yes.inBand === true && p.no.inBand === true);
  ok('  nessun avviso di banda', p.yes.bandNote === null);
  const q = T.planQuotes({ mid: 0.5, offsetCents: 2, tick: 0.01, bandRadiusCents: null });
  ok('banda non pubblicata ⇒ inBand null, mai "true" per comodita"', q.yes.inBand === null);
  ok('  e lo dichiara', /non pubblica una banda/.test(q.yes.bandNote || ''));
}

console.log('\n── un offset che porta un lato fuori dal libro non viene "aggiustato"');
{
  const p = T.planQuotes({ mid: 0.02, offsetCents: 5, tick: 0.01 });
  ok('il lato YES non e piazzabile', p.yes.placeable === false);
  ok('  con il motivo, non con un prezzo spostato dentro i limiti', /fuori dai limiti/.test(p.yes.reason || ''), (p.yes.reason || '').slice(0, 64));
  ok('  e il prezzo resta null', p.yes.price === null);
  ok('l altro lato resta piazzabile', p.no.placeable === true, `${c(p.no.price)}¢`);
  ok('  quindi il piano nel complesso e utilizzabile', p.ok === true);
}

console.log('\n── input non leggibili ⇒ nessun piano, mai un valore inventato');
{
  ok('mid assente', T.planQuotes({ mid: null, offsetCents: 3, tick: 0.01 }).ok === false);
  ok('mid a 0', T.planQuotes({ mid: 0, offsetCents: 3, tick: 0.01 }).ok === false);
  ok('tick assente', T.planQuotes({ mid: 0.5, offsetCents: 3, tick: null }).ok === false);
  ok('  e il motivo nomina il tick', /tick/.test(T.planQuotes({ mid: 0.5, offsetCents: 3, tick: null }).reason || ''));
  ok('offset a 0', T.planQuotes({ mid: 0.5, offsetCents: 0, tick: 0.01 }).ok === false);
}

console.log('\n── aggancio al tick');
{
  const p = T.planQuotes({ mid: 0.505, offsetCents: 2.3, tick: 0.01 });
  ok('il prezzo sta sulla griglia del tick', Math.abs(p.yes.price / 0.01 - Math.round(p.yes.price / 0.01)) < 1e-9, `${c(p.yes.price)}¢`);
  const q = T.planQuotes({ mid: 0.5, offsetCents: 2, tick: 0.001 });
  ok('tick piu fine ⇒ prezzo piu fine', c(q.yes.price) === 48, `${c(q.yes.price)}¢`);
}

// ═══ LA SOGLIA ══════════════════════════════════════════════════════════════════════════════════════
console.log('\n── la soglia: sotto non si muove nulla, sopra si riprezza');
{
  const base = { referenceMid: 0.10, minMoveCents: 1 };
  ok('mid fermo ⇒ nessun reprice', T.decideRetrack({ ...base, mid: 0.10 }).act === false);
  ok('mid +0.5¢, soglia 1¢ ⇒ NESSUN reprice', T.decideRetrack({ ...base, mid: 0.105 }).act === false, `mosso ${T.decideRetrack({ ...base, mid: 0.105 }).movedCents}¢`);
  ok('  e il motivo dice quanto e quanto serviva', /0\.5¢, sotto la soglia di 1¢/.test(T.decideRetrack({ ...base, mid: 0.105 }).reason));
  ok('mid +1¢, soglia 1¢ ⇒ REPRICE', T.decideRetrack({ ...base, mid: 0.11 }).act === true);
  ok('mid −1¢ ⇒ REPRICE anche in discesa', T.decideRetrack({ ...base, mid: 0.09 }).act === true);
  ok('primo giro senza riferimento ⇒ si piazza', T.decideRetrack({ mid: 0.1, referenceMid: null, minMoveCents: 1 }).act === true);
  ok('mid non leggibile ⇒ non si agisce', T.decideRetrack({ mid: null, referenceMid: 0.1, minMoveCents: 1 }).act === false);
}

console.log('\n── la deriva lenta viene comunque colta');
{
  // Cinque passi da 0.3¢: nessuno supera la soglia da 1¢, ma la distanza dal RIFERIMENTO si', al quarto.
  const ref = 0.10; let acted = null;
  for (const [i, mid] of [0.103, 0.106, 0.109, 0.112, 0.115].entries()) {
    const d = T.decideRetrack({ mid, referenceMid: ref, minMoveCents: 1 });
    if (d.act && acted == null) acted = { i, mid, moved: d.movedCents };
  }
  ok('una deriva a piccoli passi supera comunque la soglia', acted != null, acted ? `al passo ${acted.i + 1}, mosso ${acted.moved}¢` : 'mai');
  ok('  e scatta al primo passo che la supera', acted && acted.i === 3, acted ? `passo ${acted.i + 1}` : '—');
}

console.log('\n── il freno separato dalla soglia');
{
  const now = 1_000_000;
  const d = T.decideRetrack({ mid: 0.11, referenceMid: 0.10, minMoveCents: 1, lastRepriceAt: now - 5_000, minIntervalMs: 30_000, now });
  ok('soglia superata ma reprice troppo recente ⇒ si aspetta', d.act === false && d.gate === 'rate-limited');
  ok('  e dice quanto manca', /attendo altri 25s/.test(d.reason), d.reason.slice(0, 70));
  const e = T.decideRetrack({ mid: 0.11, referenceMid: 0.10, minMoveCents: 1, lastRepriceAt: now - 31_000, minIntervalMs: 30_000, now });
  ok('passato l intervallo ⇒ si riprezza', e.act === true);
}

console.log(`\nmm-tracking (logica): ${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);

// ═══ IL CICLO, con ogni dipendenza iniettata ════════════════════════════════════════════════════════
const MKT = '0x' + 'cd'.repeat(32);

function world(over = {}) {
  const placed = [], cancelled = [];
  const w = {
    mid: 0.10,
    orders: [],
    killed: false,
    manual: true,
    tooClose: false,
    midSource: 'live-book',
    midAgeSec: 2,
    placeOk: true,
    sent: false,
    ...over,
    placed, cancelled,
  };
  w.deps = {
    now: () => w.now || 1_000_000,
    readConfig: () => ({ readable: true, error: null, marketIds: [MKT.toLowerCase()],
      markets: { [MKT.toLowerCase()]: { marketId: MKT.toLowerCase(), enabled: true, offsetCents: 3, minMoveCents: 1, sizeShares: 100 } } }),
    killStatus: () => ({ effectivelyKilled: w.killed, readable: true }),
    isManual: () => ({ manual: w.manual, readable: true }),
    marketWindow: () => ({ tooClose: w.tooClose, gate: 'market-too-close-to-close', reason: 'scade fra meno di 3 minuti' }),
    resolveRules: () => ({
      readable: true, missing: [], marketId: MKT, mid: w.mid, tick: 0.01, minSize: 50,
      maxSpreadCents: 4.5, bandRadiusCents: 2.25, tokenId: 'tok-yes', tokenIdNo: 'tok-no',
      midSource: w.midSource, midAgeSec: w.midAgeSec,
      books: { yes: { tokenId: 'tok-yes', scoringMid: w.mid }, no: { tokenId: 'tok-no', scoringMid: +(1 - w.mid).toFixed(6) } },
    }),
    listOrders: async () => ({ ok: true, simulated: false, orders: w.orders }),
    placeOrder: async (spec) => {
      placed.push(spec);
      return w.placeOk
        ? { ok: true, sent: w.sent, orderId: `ord-${spec.book}-${placed.length}`, gate: null, reason: null }
        : { ok: false, sent: false, orderId: null, gate: 'test-refuse', reason: 'rifiutato dal test' };
    },
    cancelOrder: async (spec) => { cancelled.push(spec); return { ok: w.cancelOk !== false, reason: w.cancelOk === false ? 'cancellazione fallita nel test' : null }; },
    audit: () => {},
    tuning: { minIntervalMs: 0, maxMidAgeSec: 30, requireLiveBook: true },
    state: new Map(),
  };
  return w;
}

(async () => {
  console.log('\n── primo giro: due ordini, uno per lato');
  {
    const w = world();
    const r = await T.runTrackingCycle(w.deps);
    ok('il ciclo gira', r.ran === true, r.gate || '');
    ok('piazza esattamente due ordini', w.placed.length === 2, `${w.placed.length}`);
    ok('  uno YES a 7¢', w.placed.some((p) => p.book === 'yes' && c(p.price) === 7));
    ok('  uno NO a 87¢', w.placed.some((p) => p.book === 'no' && c(p.price) === 87));
    ok('  con la size configurata su entrambi', w.placed.every((p) => p.size === 100));
    ok('  e la sorgente che li marca come del motore', w.placed.every((p) => p.source === 'mm-tracking'));
    ok('nessuna cancellazione al primo giro', w.cancelled.length === 0);
    ok('il mid di riferimento viene registrato', r.markets[0].referenceMid === 0.10);
  }

  console.log('\n── secondo giro col mid fermo: NON tocca nulla');
  {
    const w = world();
    await T.runTrackingCycle(w.deps);
    w.orders = [{ orderId: 'ord-yes-1', tokenId: 'tok-yes', sizeMatched: 0 }, { orderId: 'ord-no-2', tokenId: 'tok-no', sizeMatched: 0 }];
    const before = w.placed.length;
    const r = await T.runTrackingCycle(w.deps);
    ok('nessun nuovo ordine', w.placed.length === before, `${w.placed.length - before} nuovi`);
    ok('nessuna cancellazione', w.cancelled.length === 0);
    ok('  e il motivo e per-lato', ['both-in-band','offset-outside-band','in-band'].includes(r.markets[0].gate), String(r.markets[0].gate));
  }

  // ═══ LA LOGICA PER-LATO ═══════════════════════════════════════════════════════════════════════
  // Il contratto e' cambiato di proposito: prima i due lati si spostavano SEMPRE insieme, adesso ognuno
  // risponde per se' alla domanda «sto ancora maturando?». Il mondo di prova ha offset 3¢ e raggio
  // 2.25¢, quindi col mid a 11¢: YES a 7¢ dista 4¢ (FUORI), NO a 87¢ dista 2¢ (DENTRO).
  console.log('\n── il mid si muove di 1¢: si sposta SOLO il lato uscito dalla banda');
  {
    const w = world();
    await T.runTrackingCycle(w.deps);
    w.orders = [{ orderId: 'ord-yes-1', tokenId: 'tok-yes', sizeMatched: 0 }, { orderId: 'ord-no-2', tokenId: 'tok-no', sizeMatched: 0 }];
    w.mid = 0.11;
    const before = w.placed.length;
    const r = await T.runTrackingCycle(w.deps);
    const nuovi = w.placed.slice(before);
    ok('UN SOLO ordine nuovo, non due', nuovi.length === 1, `${nuovi.length}`);
    ok('  ed e il lato YES, uscito dalla banda', nuovi[0].book === 'yes' && c(nuovi[0].price) === 8, `${nuovi[0].book}@${c(nuovi[0].price)}¢`);
    ok('  il lato NO NON e stato toccato: e ancora dentro banda', !nuovi.some((p) => p.book === 'no'));
    ok('  ne cancellato', w.cancelled.length === 1 && w.cancelled[0].orderId === 'ord-yes-1', w.cancelled.map((x) => x.orderId).join());
    ok('il verdetto per lato e registrato', r.markets[0].sideDecisions.yes.inBand === false && r.markets[0].sideDecisions.no.inBand === true);
    ok('  con la distanza misurata per ciascuno', r.markets[0].sideDecisions.yes.distanceCents === 4 && r.markets[0].sideDecisions.no.distanceCents === 2,
      `yes ${r.markets[0].sideDecisions.yes.distanceCents}¢ · no ${r.markets[0].sideDecisions.no.distanceCents}¢`);
    ok('  e il motivo del lato fermo lo dice', /dentro banda/.test(r.markets[0].sideDecisions.no.reason));
  }

  console.log('\n── ENTRAMBI dentro banda: nessuna azione');
  {
    const w = world();
    w.deps.readConfig = () => ({ readable: true, error: null, marketIds: [MKT.toLowerCase()],
      markets: { [MKT.toLowerCase()]: { marketId: MKT.toLowerCase(), enabled: true, offsetCents: 1, minMoveCents: 1, sizeShares: 100 } } });
    await T.runTrackingCycle(w.deps);
    w.orders = [{ orderId: 'ord-yes-1', tokenId: 'tok-yes', sizeMatched: 0 }, { orderId: 'ord-no-2', tokenId: 'tok-no', sizeMatched: 0 }];
    w.mid = 0.105;   // offset 1¢, raggio 2.25¢: entrambi restano dentro
    const before = w.placed.length;
    const r = await T.runTrackingCycle(w.deps);
    ok('nessun ordine nuovo', w.placed.length === before, `${w.placed.length - before}`);
    ok('nessuna cancellazione', w.cancelled.length === 0);
    ok('  gate «entrambi dentro banda»', r.markets[0].gate === 'both-in-band', String(r.markets[0].gate));
  }

  console.log('\n── ENTRAMBI fuori banda: si spostano entrambi, ognuno per conto suo');
  {
    const w = world();
    w.deps.readConfig = () => ({ readable: true, error: null, marketIds: [MKT.toLowerCase()],
      markets: { [MKT.toLowerCase()]: { marketId: MKT.toLowerCase(), enabled: true, offsetCents: 1, minMoveCents: 1, sizeShares: 100 } } });
    await T.runTrackingCycle(w.deps);
    w.orders = [{ orderId: 'ord-yes-1', tokenId: 'tok-yes', sizeMatched: 0 }, { orderId: 'ord-no-2', tokenId: 'tok-no', sizeMatched: 0 }];
    // +4¢. YES resta a 9¢ e il suo mid va a 14¢ ⇒ dista 5¢. NO resta a 89¢ e il suo mid va a 86¢ ⇒
    // dista 3¢. Entrambi oltre il raggio 2.25¢. (A +3¢ il lato NO distava solo 2¢ e restava dentro:
    // il primo tentativo di questo test sbagliava proprio quel conto.)
    w.mid = 0.14;
    const before = w.placed.length;
    const r = await T.runTrackingCycle(w.deps);
    const nuovi = w.placed.slice(before);
    ok('due ordini nuovi', nuovi.length === 2, `${nuovi.length}`);
    ok('  entrambi i lati erano fuori banda', r.markets[0].sideDecisions.yes.inBand === false && r.markets[0].sideDecisions.no.inBand === false);
    ok('  e ognuno torna a 1¢ dal proprio mid', nuovi.some((p) => p.book === 'yes' && c(p.price) === 13) && nuovi.some((p) => p.book === 'no' && c(p.price) === 85),
      nuovi.map((p) => `${p.book}@${c(p.price)}¢`).join(' '));
  }

  console.log('\n── movimento sotto soglia con offset piu largo della banda: il freno tiene');
  {
    const w = world();   // offset 3¢ > raggio 2.25¢ ⇒ i lati nascono fuori banda
    await T.runTrackingCycle(w.deps);
    w.orders = [{ orderId: 'ord-yes-1', tokenId: 'tok-yes', sizeMatched: 0 }, { orderId: 'ord-no-2', tokenId: 'tok-no', sizeMatched: 0 }];
    w.mid = 0.105;   // mezzo centesimo: sotto la soglia da 1¢
    const before = w.placed.length;
    const r = await T.runTrackingCycle(w.deps);
    ok('nessun riprezzo sotto soglia', w.placed.length === before, `${w.placed.length - before}`);
    ok('  con il gate che nomina il caso', r.markets[0].gate === 'offset-outside-band', String(r.markets[0].gate));
    ok('  e spiega che quel lato non maturera mai', /non maturera mai/.test(r.markets[0].reason));
  }

  console.log('\n── un lato FILLATO: quel lato si ferma, l altro continua');
  {
    const w = world();
    await T.runTrackingCycle(w.deps);
    // il venue riporta il lato YES parzialmente eseguito
    w.orders = [{ orderId: 'ord-yes-1', tokenId: 'tok-yes', sizeMatched: 40 }, { orderId: 'ord-no-2', tokenId: 'tok-no', sizeMatched: 0 }];
    w.mid = 0.11;
    const before = w.placed.length;
    const r = await T.runTrackingCycle(w.deps);
    const nuovi = w.placed.slice(before);
    ok('il fill viene rilevato', r.events.some((e) => e.type === 'fill' && e.side === 'yes'));
    ok('  e loggato con la size eseguita, non nascosto', r.events.find((e) => e.type === 'fill').sizeMatched === 40);
    ok('il lato fillato NON viene ripiazzato', !nuovi.some((p) => p.book === 'yes'), nuovi.map((p) => p.book).join());
    ok('  ne cancellato', !w.cancelled.some((x) => x.orderId === 'ord-yes-1'));
    // Col contratto per-lato il NO si muove solo se e uscito dalla banda: a mid 11¢ dista 2¢ e resta.
    // Cio che conta qui e che il lato FILLATO sia fermo e l altro sia stato VALUTATO per conto suo.
    ok('l altro lato viene valutato per conto suo', r.markets[0].sideDecisions.no.inBand !== null,
      `no: ${r.markets[0].sideDecisions.no.gate || r.markets[0].sideDecisions.no.trigger}`);
    // e resta fermo anche ai giri successivi
    w.orders = [{ orderId: 'ord-no-3', tokenId: 'tok-no', sizeMatched: 0 }];
    w.mid = 0.13;
    const b2 = w.placed.length;
    await T.runTrackingCycle(w.deps);
    ok('il lato fillato resta fermo anche dopo', !w.placed.slice(b2).some((p) => p.book === 'yes'));
    ok('  mentre l altro resta gestito', true);
  }

  console.log('\n── i gate di sicurezza');
  {
    const k = world({ killed: true });
    ok('kill-switch ⇒ non tocca nulla', (await T.runTrackingCycle(k.deps)).gate === 'kill' && k.placed.length === 0);

    const tc = world({ tooClose: true });
    const r = await T.runTrackingCycle(tc.deps);
    ok('mercato a meno di 3 minuti dalla chiusura ⇒ nessun reprice', tc.placed.length === 0);
    ok('  con il gate giusto', r.markets[0].gate === 'market-too-close-to-close', String(r.markets[0].gate));
    // IL CONTRATTO E CAMBIATO, ed e il punto della correzione: a fine vita il motore non lascia piu gli
    // ordini fermi ad aspettare la GTD — li CANCELLA. Lasciarli era il difetto misurato dal vivo il
    // 2 agosto 2026 (ordine a 53c mentre il mid saliva a 94c, per venti minuti).
    ok('  e il motivo dice che non si piazza piu', /non piazza piu/.test(r.markets[0].reason), r.markets[0].reason.slice(0, 70));
    ok('  e parla di cancellazione, NON di attesa della GTD',
      /CANCELLAT|nessun ordine a riposo/.test(r.markets[0].reason) && !/scadono per GTD/.test(r.markets[0].reason));

    const nm = world({ manual: false });
    ok('mercato non in gestione manuale ⇒ sta alla larga', (await T.runTrackingCycle(nm.deps)).markets[0].gate === 'manual-mode-inactive' && nm.placed.length === 0);

    const sm = world({ midSource: 'board-row' });
    ok('mid non dal book live ⇒ non insegue', (await T.runTrackingCycle(sm.deps)).markets[0].gate === 'mid-not-live' && sm.placed.length === 0);

    const old = world({ midAgeSec: 120 });
    ok('mid vecchio di 120s ⇒ non insegue', (await T.runTrackingCycle(old.deps)).markets[0].gate === 'mid-stale' && old.placed.length === 0);
  }

  console.log('\n── se la cancellazione fallisce NON si piazza il sostituto');
  {
    const w = world({ cancelOk: false });
    await T.runTrackingCycle(w.deps);
    w.orders = [{ orderId: 'ord-yes-1', tokenId: 'tok-yes', sizeMatched: 0 }, { orderId: 'ord-no-2', tokenId: 'tok-no', sizeMatched: 0 }];
    w.mid = 0.11;
    const before = w.placed.length;
    const r = await T.runTrackingCycle(w.deps);
    ok('nessun ordine nuovo dopo una cancellazione fallita', w.placed.length === before, `${w.placed.length - before} nuovi`);
    ok('  e il motivo nomina il raddoppio dell esposizione', /raddoppierebbe l esposizione/.test(r.markets[0].reason || ''), (r.markets[0].reason || '').slice(0, 72));
  }

  console.log('\n── dry-run: decide tutto, non invia nulla');
  {
    const w = world({ sent: false });
    const r = await T.runTrackingCycle(w.deps);
    ok('le azioni sono state decise', r.actions.filter((a) => a.action === 'place').length === 2);
    ok('  e nessuna risulta inviata al venue', r.actions.filter((a) => a.action === 'place').every((a) => a.sent === false));
    ok('  ma sono comunque registrate con prezzi e mid', r.actions.every((a) => a.action !== 'place' || (a.priceCents != null && a.toMid != null)));
  }

  console.log('\n── il rinnovo prima della scadenza GTD (il dead-man s switch)');
  {
    const w = world();
    w.deps.tuning = { minIntervalMs: 0, maxMidAgeSec: 30, requireLiveBook: true, refreshMarginSeconds: 180 };
    await T.runTrackingCycle(w.deps);
    // il venue riporta gli ordini vivi ma vicini alla scadenza, e il mid NON si e mosso
    w.orders = [
      { orderId: 'ord-yes-1', tokenId: 'tok-yes', sizeMatched: 0, secondsToExpiry: 120 },
      { orderId: 'ord-no-2', tokenId: 'tok-no', sizeMatched: 0, secondsToExpiry: 120 },
    ];
    const before = w.placed.length;
    const r = await T.runTrackingCycle(w.deps);
    ok('il rinnovo e dovuto e viene annunciato', r.events.some((e) => e.type === 'renewal-due'), `${r.events.filter((e) => e.type === 'renewal-due').length} lati`);
    ok('  entrambi i lati vengono rifatti anche col mid fermo', w.placed.length - before === 2, `${w.placed.length - before}`);
    ok('  e l azione dichiara che e un rinnovo', r.actions.filter((a) => a.action === 'place').every((a) => a.trigger === 'expiry-renewal'),
      r.actions.filter((a) => a.action === 'place').map((a) => a.trigger).join());
    ok('  cancellando prima i vecchi', w.cancelled.length === 2);
  }
  {
    const w = world();
    w.deps.tuning = { minIntervalMs: 0, maxMidAgeSec: 30, requireLiveBook: true, refreshMarginSeconds: 180 };
    await T.runTrackingCycle(w.deps);
    w.orders = [
      { orderId: 'ord-yes-1', tokenId: 'tok-yes', sizeMatched: 0, secondsToExpiry: 900 },
      { orderId: 'ord-no-2', tokenId: 'tok-no', sizeMatched: 0, secondsToExpiry: 900 },
    ];
    const before = w.placed.length;
    const r = await T.runTrackingCycle(w.deps);
    ok('un ordine con 15 minuti davanti NON viene rinnovato', w.placed.length === before);
    ok('  ne annunciato come dovuto', !r.events.some((e) => e.type === 'renewal-due'));
  }

  console.log('\n── IL FRENO sui rifiuti ripetuti');
  {
    const w = world({ placeOk: false });
    const r1 = await T.runTrackingCycle(w.deps);
    ok('un piazzamento rifiutato viene registrato', r1.actions.some((a) => a.action === 'place' && a.ok === false));
    ok('  con lo streak a 1 e un attesa di 3s', r1.actions.find((a) => a.action === 'place').failStreak === 1
      && r1.actions.find((a) => a.action === 'place').backoffMs === 3000);
    const dopo = w.placed.length;
    const r2 = await T.runTrackingCycle(w.deps);   // stesso istante simulato: siamo dentro l attesa
    ok('il ciclo successivo NON ritenta', w.placed.length === dopo, `${w.placed.length - dopo} tentativi`);
    ok('  e dice perche', r2.markets[0].sideDecisions.yes.gate === 'backoff', String(r2.markets[0].sideDecisions.yes.gate));
    ok('  nominando il gate e i secondi', /rifiuti consecutivi al gate «test-refuse»/.test(r2.markets[0].sideDecisions.yes.reason)
      && /riprovo fra \d+s/.test(r2.markets[0].sideDecisions.yes.reason), r2.markets[0].sideDecisions.yes.reason.slice(0, 76));
  }
  {
    // l attesa RADDOPPIA, e si azzera se il gate cambia
    const w = world({ placeOk: false });
    const st = new Map(); w.deps.state = st;
    let t = 1_000_000; w.deps.now = () => t;
    const streaks = [];
    for (let k = 0; k < 5; k++) {
      const r = await T.runTrackingCycle(w.deps);
      const a = r.actions.find((x) => x.action === 'place' && x.book === 'yes');
      if (a) streaks.push({ n: a.failStreak, ms: a.backoffMs });
      t += 400_000;   // oltre qualunque attesa, cosi si ritenta davvero
    }
    console.log('     attese: ' + streaks.map((s) => `${s.n}°→${s.ms / 1000}s`).join(' · '));
    ok('l attesa raddoppia a ogni rifiuto consecutivo', streaks.map((s) => s.ms).join() === '3000,6000,12000,24000,48000', streaks.map((s) => s.ms).join());
    ok('  e non supera il tetto di 5 minuti', streaks.every((s) => s.ms <= 300000));
  }

  console.log('\n── configurazione vuota o illeggibile');
  {
    const w = world(); w.deps.readConfig = () => ({ readable: true, marketIds: [], markets: {} });
    ok('nessun mercato in tracking ⇒ non fa nulla', (await T.runTrackingCycle(w.deps)).gate === 'no-markets');
    const u = world(); u.deps.readConfig = () => ({ readable: false, error: 'JSON rotto', marketIds: [], markets: {} });
    ok('configurazione illeggibile ⇒ fail closed', (await T.runTrackingCycle(u.deps)).gate === 'config-unreadable');
  }

  console.log(`\nmm-tracking: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

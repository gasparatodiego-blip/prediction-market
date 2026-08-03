#!/usr/bin/env node
'use strict';
// L'EROSIONE DENTRO IL CICLO: l'OR con il trigger esistente, il freno fra due riprezzi, l'arretramento
// al bordo premiante, e i mercati che questo meccanismo non deve toccare.
//
// Il ciclo gira con ogni dipendenza iniettata: nessuna rete, nessun venue, nessun ordine vero.
// «Piazzare» significa chiamare una funzione finta che registra, e l'orologio lo decide il test.

const T = require('./mm-tracking');
const { BASELINE_MIN_SPAN_MS, BASELINE_MIN_SAMPLES } = require('./book-erosion');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const MKT = '0x' + 'ab'.repeat(32);
const S = 1000;

/**
 * Un mercato reward realistico: tick 0.001, banda ±2.25¢, offset 1¢.
 * Il lato YES riposa a 0.49 con mid 0.50 ⇒ la zona misurata e' (0.49, 0.50), che su tick 0.001 contiene
 * livelli veri. Il bordo premiante e' a 2.2¢ dal mid: c'e' spazio per arretrare.
 */
function harness(opts = {}) {
  const {
    tick = 0.001, offsetCents = 1, bandRadiusCents = 2.25, minutesToClose = 5000, closeKnown = true,
    sides = 'both', stepMs = 30 * S, minIntervalMs = 0,
  } = opts;
  let mid = opts.mid ?? 0.50;
  let depth = 1000;
  let depthReadable = true;
  let resting = [];
  let t = 1_000_000_000;
  const placed = [], cancelled = [], audits = [], events = [];
  const state = new Map();

  const tokenOf = (b) => (b === 'yes' ? 'ty' : 'tn');
  const deps = () => ({
    now: () => t,
    readConfig: () => ({ readable: true, marketIds: [MKT], markets: { [MKT]: { offsetCents, minMoveCents: 1, sizeShares: 100, sides } } }),
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    marketWindow: () => ({ tooClose: false, closeKnown, minutesToClose }),
    resolveRules: () => ({
      readable: true, missing: [], marketId: MKT, mid, tick, minSize: 50,
      maxSpreadCents: bandRadiusCents * 2, bandRadiusCents, tokenId: 'ty', tokenIdNo: 'tn',
      midSource: 'live-book', midAgeSec: 1,
      books: { yes: { tokenId: 'ty', scoringMid: mid }, no: { tokenId: 'tn', scoringMid: +(1 - mid).toFixed(6) } },
    }),
    // I BID fra l'ordine e il mid. Una sola riga per lato: la size e' la variabile del test.
    readDepth: () => (depthReadable
      ? { readable: true, yes: { bids: [{ price: +(mid - 0.005).toFixed(6), size: depth }] },
        no: { bids: [{ price: +((1 - mid) - 0.005).toFixed(6), size: depth }] }, ageMs: 100, live: true }
      : { readable: false, reason: 'snapshot non leggibile (finto)' }),
    listOrders: async () => ({ ok: true, simulated: false, orders: resting }),
    placeOrder: async (s) => {
      placed.push({ book: s.book, price: s.price, priceCents: +(s.price * 100).toFixed(2), at: t });
      const id = `o${placed.length}`;
      resting = resting.filter((o) => o.tokenId !== tokenOf(s.book))
        .concat([{ orderId: id, tokenId: tokenOf(s.book), sizeMatched: 0, secondsToExpiry: 1380 }]);
      return { ok: true, sent: false, orderId: id, gate: null, reason: null };
    },
    cancelOrder: async (s) => { cancelled.push(s.orderId); resting = resting.filter((o) => o.orderId !== s.orderId); return { ok: true }; },
    audit: (a) => audits.push(a),
    tuning: { minIntervalMs, midStalePauseSec: 30, requireLiveBook: true, refreshMarginSeconds: 180 },
    state,
  });

  return {
    placed, cancelled, audits, events, state,
    setMid: (v) => { mid = v; },
    setDepth: (v) => { depth = v; },
    setDepthReadable: (v) => { depthReadable = v; },
    at: () => t,
    advance: (ms) => { t += ms; },
    run: async () => { const r = await T.runTrackingCycle(deps()); events.push(...(r.events || [])); t += stepMs; return r; },
    /** Tante letture stabili quante ne servono a completare il riscaldamento. */
    warm: async function warm() {
      const n = Math.ceil(BASELINE_MIN_SPAN_MS / stepMs) + BASELINE_MIN_SAMPLES + 1;
      let last = null;
      for (let i = 0; i < n; i += 1) last = await this.run();
      return last;
    },
  };
}

const placeActs = (r) => (r.actions || []).filter((a) => a.action === 'place');
const sideDec = (r, side) => r.markets[0].sideDecisions[side];

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('\n══ IL CASO NORMALE · si sta in banda e non si tocca niente');
  {
    const h = harness();
    await h.run();                       // primo giro: piazza i due lati
    ok('primo giro: due piazzamenti', h.placed.length === 2, h.placed.map((p) => `${p.book}@${p.priceCents}c`).join(' '));
    ok('  il lato YES a 1¢ dal mid', h.placed[0].priceCents === 49);
    const dopo = await h.warm();
    ok('dopo il riscaldamento con book stabile: nessun altro ordine', h.placed.length === 2, `${h.placed.length} piazzamenti in tutto`);
    ok('  entrambi i lati in banda', dopo.markets[0].gate === 'both-in-band', dopo.markets[0].gate);
    const e = dopo.markets[0].erosion.yes;
    ok('  la profondita e stata comunque campionata', e.applies === true && e.established === true, `${e.samples} campioni, baseline ${e.baseline}`);
    ok('  e giudicata normale', e.erosion === false, `${e.ratioPct}%`);
  }

  console.log('\n══ IL TRIGGER DI EROSIONE · conferma a 2 letture, poi si arretra');
  {
    const h = harness();
    await h.run();
    await h.warm();
    const prima = h.placed.length;

    h.setDepth(200);                     // 20% della baseline
    const uno = await h.run();
    ok('UNA lettura sotto soglia non muove nulla', h.placed.length === prima, `${placeActs(uno).length} piazzamenti`);
    ok('  ma il lato resta in banda e lo dice', sideDec(uno, 'yes').gate === 'in-band');
    ok('  con lo streak a 1', uno.markets[0].erosion.yes.belowStreak === 1);

    const due = await h.run();
    ok('la SECONDA consecutiva riposiziona', h.placed.length === prima + 2, `${placeActs(due).length} piazzamenti in questo giro`);
    const a = placeActs(due)[0];
    ok('  il trigger e «erosion»', a.trigger === 'erosion', a.trigger);
    ok('  e l etichetta d audit dice «erosione»', a.triggerKind === 'erosione', a.triggerKind);
    ok('  con i numeri che lo affermano', a.erosion && a.erosion.ratioPct < 40 && a.erosion.baseline > 0,
      `${a.erosion.depth} su baseline ${a.erosion.baseline} = ${a.erosion.ratioPct}%`);
  }

  console.log('\n── SI ARRETRA DAL MID, non si ripiazza dove si era');
  {
    const h = harness();
    await h.run();
    const partenza = h.placed[0].priceCents;
    await h.warm();
    h.setDepth(200);
    await h.run(); await h.run();
    const nuovo = h.placed[h.placed.length - 2];   // il lato YES del riposizionamento
    ok('il prezzo NUOVO e piu lontano dal mid', nuovo.priceCents < partenza, `${partenza}c → ${nuovo.priceCents}c`);
    ok('  esattamente al bordo premiante (2.2¢ dal mid)', nuovo.priceCents === 47.8, `${nuovo.priceCents}c`);
    ok('  che e ancora DENTRO banda (raggio 2.25¢)', Math.abs(50 - nuovo.priceCents) <= 2.25);
  }

  console.log('\n── PUNTO 7 · se non c e dove arretrare restando premianti, NON si agisce');
  {
    // tick 0.01 con raggio 2.25 ⇒ il bordo agganciato al tick e' 2¢, e l'ordine e' gia' li'.
    const h = harness({ tick: 0.01, offsetCents: 2 });
    await h.run();
    await h.warm();
    const prima = h.placed.length;
    h.setDepth(200);
    await h.run();
    const r = await h.run();
    ok('erosione confermata ma nessun ordine', h.placed.length === prima, `${h.placed.length} contro ${prima}`);
    ok('  il lato resta fermo, in banda', sideDec(r, 'yes').gate === 'in-band');
    ok('  e il motivo e scritto', sideDec(r, 'yes').erosionHeld === 'no-retreat', sideDec(r, 'yes').erosionHeld);
    ok('  a parole', /gia al bordo premiante/.test(sideDec(r, 'yes').reason), sideDec(r, 'yes').reason.slice(-90));
  }

  console.log('\n══ L OR COI DUE TRIGGER');
  {
    const h = harness();
    await h.run();
    await h.warm();
    const prima = h.placed.length;
    // Il mid si sposta abbastanza da portare l'ordine FUORI banda: e' il trigger esistente, da solo.
    h.setMid(0.54);
    const r = await h.run();
    ok('il solo trigger sul mid muove ancora, invariato', h.placed.length > prima);
    const a = placeActs(r)[0];
    ok('  con trigger «out-of-band»', a.trigger === 'out-of-band', a.trigger);
    ok('  ed etichetta «mid»', a.triggerKind === 'mid', a.triggerKind);
  }

  console.log('\n── quando scattano ENTRAMBI, l audit lo dice');
  {
    const h = harness();
    await h.run();
    await h.warm();
    h.setDepth(200);
    await h.run();          // streak 1
    h.setMid(0.54);         // ora anche fuori banda
    const r = await h.run();
    const a = placeActs(r)[0];
    ok('si riposiziona', a && a.ok === true);
    ok('  trigger «out-of-band» (il mid comanda dove si va)', a.trigger === 'out-of-band', a.trigger);
    ok('  ma l etichetta dichiara ENTRAMBI', a.triggerKind === 'entrambi', a.triggerKind);
  }

  console.log('\n── basta UNO dei due: l erosione muove un ordine perfettamente in banda');
  {
    const h = harness();
    await h.run();
    await h.warm();
    h.setDepth(200);
    await h.run();
    const r = await h.run();
    ok('il mid non si e mosso di un centesimo', r.markets[0].mid === 0.50);
    ok('  l ordine era dentro banda', placeActs(r)[0].inBandBefore === true);
    ok('  e si e mosso lo stesso', placeActs(r).length === 2, 'e esattamente cio che il secondo segnale deve fare');
  }

  console.log('\n══ IL FRENO · due trigger vicini non fanno due riprezzi');
  {
    const h = harness({ stepMs: 3 * S, minIntervalMs: 30 * S });
    await h.run();
    await h.warm();
    h.setDepth(200);
    await h.run();
    const armato = await h.run();
    const dopoErosione = h.placed.length;
    ok('l erosione ha riposizionato', placeActs(armato).length === 2, `${placeActs(armato).length}`);

    // 3 secondi dopo il mid esce dalla banda: il secondo trigger scatta subito.
    h.setMid(0.56);
    const frenato = await h.run();
    ok('il secondo trigger a 3s di distanza NON produce un secondo riprezzo', h.placed.length === dopoErosione,
      `${h.placed.length} contro ${dopoErosione}`);
    ok('  il gate lo dichiara', sideDec(frenato, 'yes').gate === 'reprice-rate-limited', sideDec(frenato, 'yes').gate);
    ok('  e dice quanto manca', /attendo altri \d+s/.test(sideDec(frenato, 'yes').reason), sideDec(frenato, 'yes').reason.slice(0, 90));
    ok('  ricordando quale trigger e stato trattenuto', sideDec(frenato, 'yes').heldTrigger === 'out-of-band');

    // Passato il minimo, il movimento trattenuto avviene.
    for (let i = 0; i < 11; i += 1) await h.run();
    ok('scaduto il minimo, il riposizionamento avviene', h.placed.length > dopoErosione, `${h.placed.length}`);
  }

  console.log('\n── il freno NON puo toccare il rinnovo GTD');
  {
    const h = harness({ stepMs: 3 * S, minIntervalMs: 300 * S });
    await h.run();
    ok('primo piazzamento avvenuto malgrado un freno da 300s', h.placed.length === 2);
    const prima = h.placed.length;
    // L'ordine sta per scadere: il rinnovo e' il dead-man's switch e non si frena mai.
    h.state.get(MKT).sides.yes.needsRenewal = true;
    const r = await h.run();
    ok('il rinnovo passa comunque', h.placed.length > prima, `${h.placed.length}`);
    ok('  con trigger «expiry-renewal»', placeActs(r)[0].trigger === 'expiry-renewal', placeActs(r)[0].trigger);
  }

  console.log('\n══ DOPO UN RIPOSIZIONAMENTO LA SERIE RIPARTE DA ZERO');
  {
    const h = harness();
    await h.run();
    await h.warm();
    h.setDepth(200);
    await h.run();
    const r = await h.run();
    ok('riposizionato per erosione', placeActs(r).length === 2);
    const subito = await h.run();
    const e = subito.markets[0].erosion.yes;
    ok('  al giro dopo la baseline non esiste piu', e.established === false, `${e.samples} campioni`);
    ok('  quindi nessun secondo trigger a raffica', placeActs(subito).length === 0);
    ok('  e lo stato lo spiega', /riscaldamento/.test(e.reason), e.reason.slice(0, 60));
  }

  console.log('\n══ I MERCATI DIREZIONALI VELOCI NON SONO TOCCATI');
  {
    // «Bitcoin Up or Down» a 5 minuti, con banda pubblicata come i veri.
    const h = harness({ minutesToClose: 5 });
    await h.run();
    await h.warm();
    const prima = h.placed.length;
    h.setDepth(1);                       // crollo totale della coda
    for (let i = 0; i < 6; i += 1) await h.run();
    const r = await h.run();
    ok('profondita crollata a 1 share: NESSUN riposizionamento', h.placed.length === prima, `${h.placed.length} contro ${prima}`);
    ok('  il mercato non e candidato', r.markets[0].erosionGate === 'market-too-short', r.markets[0].erosionGate);
    ok('  e nessuna serie viene nemmeno accumulata', r.markets[0].erosion.yes.applies === false);

    // Ma il comportamento ESISTENTE su quel mercato resta esattamente quello di prima.
    h.setMid(0.55);
    const dopo = await h.run();
    ok('il trigger sul mid continua a funzionare identico', placeActs(dopo).length > 0);
    ok('  con etichetta «mid»', placeActs(dopo)[0].triggerKind === 'mid');
  }

  console.log('\n── un mercato senza banda pubblicata non entra nel meccanismo');
  {
    const h = harness({ bandRadiusCents: null });
    await h.run();
    const r = await h.run();
    ok('nessuna banda ⇒ non candidato', r.markets[0].erosionGate === 'no-band', r.markets[0].erosionGate);
  }

  console.log('\n── chiusura non leggibile: fail closed, niente erosione');
  {
    const h = harness({ closeKnown: false, minutesToClose: null });
    await h.run();
    await h.warm();
    const prima = h.placed.length;
    h.setDepth(1);
    for (let i = 0; i < 4; i += 1) await h.run();
    const r = await h.run();
    ok('nessun riposizionamento per erosione', h.placed.length === prima);
    ok('  gate «close-unknown»', r.markets[0].erosionGate === 'close-unknown', r.markets[0].erosionGate);
  }

  console.log('\n══ CIO CHE L EROSIONE NON PUO SCAVALCARE');
  {
    const h = harness({ sides: 'yes' });
    await h.run();
    await h.warm();
    h.setDepth(200);
    await h.run();
    const r = await h.run();
    ok('un lato SPENTO resta spento', sideDec(r, 'no').gate === 'side-disabled', sideDec(r, 'no').gate);
    ok('  e non viene nemmeno misurato', r.markets[0].erosion.no.applies === false, r.markets[0].erosion.no.gate);
    ok('  mentre il lato acceso si e mosso', placeActs(r).length === 1 && placeActs(r)[0].book === 'yes');
  }

  console.log('\n── un lato ESEGUITO non viene riposizionato dall erosione');
  {
    const h = harness();
    await h.run();
    await h.warm();
    h.state.get(MKT).sides.yes.filled = true;
    h.setDepth(200);
    await h.run();
    const r = await h.run();
    ok('il lato eseguito resta fermo', sideDec(r, 'yes').gate === 'filled', sideDec(r, 'yes').gate);
    ok('  e nessun ordine parte su quel lato', placeActs(r).every((a) => a.book !== 'yes'));
  }

  console.log('\n══ IL FEED CHE SPARISCE NON E EROSIONE');
  {
    const h = harness();
    await h.run();
    await h.warm();
    h.setDepthReadable(false);
    const prima = h.placed.length;
    for (let i = 0; i < 5; i += 1) await h.run();
    const r = await h.run();
    ok('snapshot del book illeggibile ⇒ nessun riposizionamento', h.placed.length === prima);
    ok('  la lettura non e leggibile e lo dice', /non leggibile|snapshot/.test(r.markets[0].erosion.yes.reason), r.markets[0].erosion.yes.reason.slice(0, 70));
  }

  console.log('\n══ L AUDIT REGISTRA LE TRANSIZIONI');
  {
    const h = harness();
    await h.run();
    await h.warm();
    h.setDepth(200);
    await h.run(); await h.run();
    const armed = h.audits.filter((a) => a.event === 'erosion-armed');
    ok('l innesco e a registro', armed.length === 2, `${armed.length} righe (un lato per book)`);
    ok('  con soglia, rientro e finestra dichiarate', armed[0].triggerPct === 40 && armed[0].recoveryPct === 60 && armed[0].windowMs === 600_000);
    ok('  e i numeri per poter ritarare dopo', armed[0].baseline > 0 && armed[0].ratioPct < 40 && armed[0].samples > 0,
      `baseline ${armed[0].baseline}, ${armed[0].ratioPct}%, ${armed[0].samples} campioni`);
    const reprice = h.audits.filter((a) => a.event === 'reprice' && a.trigger === 'erosion');
    ok('il riposizionamento porta con se il suo trigger', reprice.length === 2 && reprice[0].triggerKind === 'erosione');
  }

  console.log(`\nerosione nel ciclo: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

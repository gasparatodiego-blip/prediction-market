#!/usr/bin/env node
'use strict';
// MAI IN CIMA AL BOOK, DENTRO IL CICLO — e le due garanzie che ci stanno attorno:
// la size resta simmetrica sui due lati, e i mercati fuori dallo scopo Ottimizza non sono toccati.
//
// Nessuna rete, nessun venue, nessun ordine vero: ogni dipendenza e' iniettata.

const T = require('./mm-tracking');
const { BASELINE_MIN_SPAN_MS, BASELINE_MIN_SAMPLES } = require('./book-erosion');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const MKT = '0x' + 'be'.repeat(32);
const S = 1000;

/**
 * `bids` e' una funzione del mid: ogni scenario decide che book vuole vedere.
 * Gli ordini NOSTRI vengono aggiunti al book dal harness stesso, come fa il venue vero — è l'unico modo
 * di verificare davvero che il motore li tolga prima di guardare.
 */
function harness(opts = {}) {
  const {
    tick = 0.001, offsetCents = 1, bandRadiusCents = 2.25, minutesToClose = 5000, closeKnown = true,
    sizeShares = 100, minMoveCents = 1, stepMs = 30 * S, minIntervalMs = 0,
    bids = (mid) => [{ price: +(mid - 0.005).toFixed(6), size: 800 }],
    depthReadable = true,
  } = opts;
  let mid = opts.mid ?? 0.50;
  let leggibile = depthReadable;
  let resting = [];
  let t = 1_000_000_000;
  const placed = [], audits = [];
  const state = new Map();
  const tokenOf = (b) => (b === 'yes' ? 'ty' : 'tn');

  // Il book PUBBLICATO: quello altrui piu' i nostri ordini, come lo vede il feed.
  const bookOf = (side) => {
    const m = side === 'yes' ? mid : +(1 - mid).toFixed(6);
    const altrui = bids(m, side).map((l) => ({ ...l }));
    for (const o of resting.filter((r) => r.tokenId === tokenOf(side))) {
      const riga = altrui.find((l) => Math.abs(l.price - o.price) < tick / 1000);
      if (riga) riga.size += o.size; else altrui.push({ price: o.price, size: o.size });
    }
    return altrui.sort((a, b) => b.price - a.price);
  };

  const deps = () => ({
    now: () => t,
    readConfig: () => ({ readable: true, marketIds: [MKT], markets: { [MKT]: { offsetCents, minMoveCents, sizeShares, sides: opts.sides || 'both' } } }),
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    marketWindow: () => ({ tooClose: false, closeKnown, minutesToClose }),
    resolveRules: () => ({
      readable: true, missing: [], marketId: MKT, mid, tick, minSize: 50,
      maxSpreadCents: bandRadiusCents == null ? null : bandRadiusCents * 2, bandRadiusCents,
      tokenId: 'ty', tokenIdNo: 'tn', midSource: 'live-book', midAgeSec: 1,
      books: { yes: { tokenId: 'ty', scoringMid: mid }, no: { tokenId: 'tn', scoringMid: +(1 - mid).toFixed(6) } },
    }),
    readDepth: () => (leggibile
      ? { readable: true, yes: { bids: bookOf('yes') }, no: { bids: bookOf('no') }, ageMs: 100, live: true }
      : { readable: false, reason: 'snapshot non leggibile (finto)' }),
    listOrders: async () => ({ ok: true, simulated: false, orders: resting }),
    placeOrder: async (s) => {
      placed.push({ book: s.book, price: s.price, priceCents: +(s.price * 100).toFixed(2), size: s.size, at: t });
      const id = `o${placed.length}`;
      resting = resting.filter((o) => o.tokenId !== tokenOf(s.book))
        .concat([{ orderId: id, tokenId: tokenOf(s.book), price: s.price, size: s.size, sizeRemaining: s.size, sizeMatched: 0, secondsToExpiry: 1380 }]);
      return { ok: true, sent: false, orderId: id, gate: null, reason: null };
    },
    cancelOrder: async (s) => { resting = resting.filter((o) => o.orderId !== s.orderId); return { ok: true }; },
    audit: (a) => audits.push(a),
    tuning: { minIntervalMs, midStalePauseSec: 30, requireLiveBook: true, refreshMarginSeconds: 180 },
    state,
  });

  return {
    placed, audits, state,
    setMid: (v) => { mid = v; },
    setReadable: (v) => { leggibile = v; },
    resting: () => resting,
    run: async () => { const r = await T.runTrackingCycle(deps()); t += stepMs; return r; },
    warm: async function warm() {
      const n = Math.ceil(BASELINE_MIN_SPAN_MS / stepMs) + BASELINE_MIN_SAMPLES + 1;
      let last = null;
      for (let i = 0; i < n; i += 1) last = await this.run();
      return last;
    },
  };
}

const acts = (r) => (r.actions || []).filter((a) => a.action === 'place');
const yesAct = (r) => acts(r).find((a) => a.book === 'yes');
const tgt = (r, side) => r.markets[0].target[side];

(async () => {
  console.log('\n══ IL CASO NORMALE · un tick dietro il migliore altrui');
  {
    const h = harness({ bids: () => [{ price: 0.495, size: 800 }, { price: 0.492, size: 400 }] });
    const r = await h.run();
    ok('due lati piazzati', h.placed.length === 2);
    ok('  YES un tick dietro il miglior bid altrui (49.5¢)', h.placed[0].priceCents === 49.4, `${h.placed[0].priceCents}c`);
    ok('  modo «behind-best»', tgt(r, 'yes').mode === 'behind-best', tgt(r, 'yes').mode);
    ok('  e NON siamo in cima', tgt(r, 'yes').onTop === false);
    ok('  la distanza dal mid e un risultato del book', yesAct(r).offsetCents === 0.6, `${yesAct(r).offsetCents}¢ (offset configurato: 1¢)`);
    ok('  l azione dichiara il migliore altrui', yesAct(r).placement.bestOther === 0.495);
  }

  console.log('\n── IL MOTORE NON INSEGUE SE STESSO');
  {
    // Il nostro ordine finisce nel book pubblicato. Se non lo togliesse, a ogni ciclo si vedrebbe
    // «migliore» e scenderebbe di un tick, fino al bordo della banda.
    const h = harness({ bids: () => [{ price: 0.495, size: 800 }] });
    await h.run();
    const primo = h.placed[0].priceCents;
    for (let i = 0; i < 8; i += 1) await h.run();
    const ultimo = h.placed[h.placed.length - 1].priceCents;
    ok('dopo 9 giri il prezzo non e sceso di un tick per giro', ultimo === primo, `${primo}c → ${ultimo}c`);
    ok('  e non ci sono stati riposizionamenti inutili', h.placed.length === 2, `${h.placed.length} piazzamenti in tutto`);
  }

  console.log('\n── IL BERSAGLIO SEGUE IL BOOK, non il mid');
  {
    let best = 0.495;
    const h = harness({ bids: () => [{ price: best, size: 800 }] });
    await h.run();
    ok('partenza a 49.4¢', h.placed[0].priceCents === 49.4);
    // Il mid NON si muove: si muove solo il book. Prima il bersaglio non se ne sarebbe accorto.
    best = 0.483;
    const r = await h.run();
    ok('il migliore altrui scende a 48.3¢ col mid fermo ⇒ ci si sposta', acts(r).length === 2, `${acts(r).length} piazzamenti`);
    ok('  a 48.2¢', h.placed[h.placed.length - 2].priceCents === 48.2, `${h.placed[h.placed.length - 2].priceCents}c`);
    ok('  con trigger «follow-book»', yesAct(r).trigger === 'follow-book', yesAct(r).trigger);
    ok('  e il mid non si e mosso', r.markets[0].mid === 0.50);
  }

  console.log('\n── un movimento del book SOTTO la soglia non muove nulla');
  {
    let best = 0.495;
    const h = harness({ minMoveCents: 1, bids: () => [{ price: best, size: 800 }] });
    await h.run();
    const prima = h.placed.length;
    best = 0.4945;   // 0.05¢ di differenza
    const r = await h.run();
    ok('bersaglio spostato di 0.05¢ con soglia 1¢ ⇒ fermo', h.placed.length === prima);
    ok('  gate «in-band»', r.markets[0].sideDecisions.yes.gate === 'in-band');
    ok('  ed e la soglia gia configurata, non una nuova', /soglia di 1¢/.test(r.markets[0].sideDecisions.yes.reason),
      r.markets[0].sideDecisions.yes.reason.slice(0, 90));
  }

  console.log('\n══ IL CONFLITTO CON LA BANDA: si rinuncia al lato (invertito il 5 agosto 2026)');
  {
    // Questo blocco pretendeva l'aggancio al bordo con `onTop:true`. La priorita' e' stata invertita:
    // «mai primi» vince, e un tick dietro fuori banda significa NON quotare quel lato.
    // Tutti gli altri quotano a 46¢: un tick dietro sarebbe 45.9¢, fuori dalla banda 47.8-52.2.
    const h = harness({ bids: () => [{ price: 0.46, size: 800 }] });
    const r = await h.run();
    ok('non si piazza niente su quel lato', h.placed.length === 0,
      `${h.placed.length} ordini piazzati`);
    const d = tgt(r, 'yes');
    ok('  e il motivo e dichiarato', !d || d.mode === 'behind-best-fuori-banda' || d.quotabile === false,
      d ? `${d.mode} · quotabile ${d.quotabile}` : 'nessun target');
  }

  console.log('\n══ IL RIPIEGO · siamo gli unici sul lato');
  {
    const h = harness({ offsetCents: 1, bids: () => [] });   // nessun altro, mai
    const r = await h.run();
    // ⚠ Era 49¢ (mid 50 − offset 1). Dal 12 agosto 2026 il ramo «soli» va al BORDO ESTERNO della
    // banda, che con raggio 2,25¢ e tick 0,01 sta a 47,8¢: il prezzo piu' lontano dal mid che resta
    // premiante. Il fill diventa improbabile e il reward matura comunque.
    // 47,8¢ era il bordo NUDO. Dal 15 agosto 2026 ci si ferma `max(1 tick, 0,22 × v)` DENTRO il bordo
    // (`distanza-obiettivo.bordiConMargine`, il margine anti-oscillazione): con v = 2,25¢ e tick 0,001
    // sono 0,495¢ arrotondati a 5 tick = 0,5¢, cioe' **48,3¢**. Resta il prezzo piu' lontano dal mid
    // AMMESSO, che e' la proprieta' che questo blocco difende.
    ok('nessun altro ⇒ BORDO ESTERNO ammesso della banda, non l offset', h.placed[0].priceCents === 48.3, `${h.placed[0].priceCents}c`);
    ok('  modo «fallback-alone-bordo-esterno»', tgt(r, 'yes').mode === 'fallback-alone-bordo-esterno', tgt(r, 'yes').mode);
    ok('  dichiarato «soli»', yesAct(r).placement.alone === true);
    ok('  e «in cima» non e affermabile', yesAct(r).placement.onTop === null);
  }

  console.log('\n── il ripiego si scioglie DA SOLO quando ricompare qualcuno');
  {
    let altri = [];
    const h = harness({ offsetCents: 2, bids: () => altri });
    await h.run();
    ok('si parte soli, al bordo esterno ammesso della banda (48,3¢)', h.placed[0].priceCents === 48.3, `${h.placed[0].priceCents}c`);
    altri = [{ price: 0.497, size: 500 }];
    const r = await h.run();
    ok('ricompare un partecipante a 49.7¢ ⇒ ci si rimette dietro di lui', h.placed[h.placed.length - 2].priceCents === 49.6,
      `${h.placed[h.placed.length - 2].priceCents}c`);
    ok('  senza che nessuno abbia toccato niente', tgt(r, 'yes').mode === 'behind-best');
    ok('  e il trigger e «follow-book»', yesAct(r).trigger === 'follow-book', yesAct(r).trigger);
  }

  console.log('\n── un book NON LETTO non e «siamo soli»');
  {
    const h = harness({ bids: () => [{ price: 0.495, size: 800 }] });
    await h.run();
    h.setReadable(false);
    const r = await h.run();
    ok('feed illeggibile ⇒ NON si ripiega fingendo di essere soli', tgt(r, 'yes').ok !== true);
    ok('  si torna al percorso a offset fisso, e lo dice', /si resta sull offset configurato/.test(tgt(r, 'yes').reason || ''),
      (tgt(r, 'yes').reason || '').slice(0, 80));
  }

  console.log('\n══ LA SIZE RESTA SIMMETRICA SUI DUE LATI, SEMPRE');
  {
    // Il punteggio reward prende il MINIMO fra le due gambe: size diseguale non aumenta il premio,
    // aggiunge solo esposizione sul lato piu' grosso.
    let best = 0.495;
    const h = harness({ sizeShares: 137, bids: () => [{ price: best, size: 800 }] });
    await h.run();
    const y = h.placed.filter((p) => p.book === 'yes');
    const n = h.placed.filter((p) => p.book === 'no');
    ok('primo giro: stessa size sui due lati', y[0].size === n[0].size && y[0].size === 137, `${y[0].size} / ${n[0].size}`);
    // Il book si muove SOLO sul lato YES: il NO non si sposta, ma quando si spostera' dovra' avere la
    // stessa size. Un riposizionamento asimmetrico non deve poter creare gambe diverse.
    best = 0.480;   // dentro banda: un tick dietro e' 0.479, sopra il bordo 0.4775
    await h.run(); await h.run();
    const tutte = new Set(h.placed.map((p) => p.size));
    ok('dopo i riposizionamenti la size non e mai cambiata', tutte.size === 1 && tutte.has(137), [...tutte].join(','));
    const perLato = { yes: h.placed.filter((p) => p.book === 'yes').at(-1).size, no: h.placed.filter((p) => p.book === 'no').at(-1).size };
    ok('  e le due gambe restano uguali', perLato.yes === perLato.no, `YES ${perLato.yes} · NO ${perLato.no}`);
    ok('  perche la size e UN campo solo nella configurazione, non due',
      h.placed.every((p) => p.size === 137), 'non esiste un percorso che possa renderle diverse');
  }

  console.log('\n══ I MERCATI FUORI SCOPO NON SONO TOCCATI');
  {
    // «Bitcoin Up or Down» a 5 minuti: banda pubblicata, ma vita troppo corta.
    const h = harness({ minutesToClose: 5, bids: () => [{ price: 0.495, size: 800 }] });
    const r = await h.run();
    ok('ciclo veloce ⇒ NESSUN bersaglio dal book', tgt(r, 'yes') === null || tgt(r, 'yes').ok !== true);
    ok('  si piazza all offset configurato, come sempre', h.placed[0].priceCents === 49, `${h.placed[0].priceCents}c`);
    ok('  e l azione lo dichiara «fixed-offset»', yesAct(r).placement.mode === 'fixed-offset', yesAct(r).placement.mode);
    ok('  con il motivo dello scopo', r.markets[0].erosionGate === 'market-too-short', r.markets[0].erosionGate);
  }

  console.log('\n── un mercato senza banda resta sul percorso di prima');
  {
    const h = harness({ bandRadiusCents: null, bids: () => [{ price: 0.495, size: 800 }] });
    const r = await h.run();
    ok('  gate di scopo «no-band»', r.markets[0].erosionGate === 'no-band');
    ok('  nessun bersaglio dal book', tgt(r, 'yes') === null);
    // E il gate che esisteva gia': senza banda pubblicata la guardia delle regole di venue rifiuta
    // qualunque quota, quindi non si piazza NULLA. Fail closed, e questo lavoro non lo tocca.
    ok('  e non si piazza nulla: la guardia delle regole rifiuta', h.placed.length === 0, `${h.placed.length} piazzamenti`);
    const skip = (r.actions || []).filter((a) => a.action === 'skip');
    ok('  con il motivo dichiarato', skip.length === 2 && /RULES_UNREADABLE/.test(skip[0].reason), (skip[0] || {}).reason);
  }

  console.log('\n── chiusura non leggibile: fail closed, percorso di prima');
  {
    const h = harness({ closeKnown: false, minutesToClose: null, bids: () => [{ price: 0.495, size: 800 }] });
    const r = await h.run();
    ok('offset fisso', h.placed[0].priceCents === 49);
    ok('  gate «close-unknown»', r.markets[0].erosionGate === 'close-unknown');
  }

  console.log('\n══ IL FRENO VALE ANCHE PER «FOLLOW-BOOK»');
  {
    let best = 0.495;
    const h = harness({ stepMs: 3 * S, minIntervalMs: 30 * S, bids: () => [{ price: best, size: 800 }] });
    await h.run();
    const prima = h.placed.length;
    // 48¢: un tick dietro e' 47,9¢, sopra il bordo premiante 47,75¢. Con la priorita' invertita del
    // 5 agosto 2026 un concorrente a 47¢ farebbe RIFIUTARE il lato invece di farlo spostare, e questo
    // blocco verifica il FRENO, non la nuova regola: serve uno spostamento che resti quotabile.
    best = 0.480;
    const r = await h.run();
    ok('il book si e spostato ma sono passati 3s ⇒ frenato', h.placed.length === prima, `${h.placed.length}`);
    ok('  gate «reprice-rate-limited»', r.markets[0].sideDecisions.yes.gate === 'reprice-rate-limited');
    ok('  ricordando quale trigger e stato trattenuto', r.markets[0].sideDecisions.yes.heldTrigger === 'follow-book');
    for (let i = 0; i < 11; i += 1) await h.run();
    ok('scaduto il minimo, il movimento avviene', h.placed.length > prima, `${h.placed.length}`);
  }

  console.log('\n══ FUORI BANDA SI MUOVE SEMPRE, a qualunque distanza dal bersaglio');
  {
    const h = harness({ bids: (m) => [{ price: +(m - 0.005).toFixed(6), size: 800 }] });
    await h.run();
    h.setMid(0.56);       // l ordine a 49.4¢ e ora fuori dalla banda 53.8-58.2
    const r = await h.run();
    ok('si riposiziona', acts(r).length === 2);
    ok('  con trigger «out-of-band»', yesAct(r).trigger === 'out-of-band', yesAct(r).trigger);
    ok('  e il nuovo prezzo e dentro la banda nuova', Math.abs(56 - h.placed[h.placed.length - 2].priceCents) <= 2.25,
      `${h.placed[h.placed.length - 2].priceCents}c`);
  }

  console.log('\n══ IL DATO ARRIVA FINO ALLO STATO PUBBLICATO');
  {
    // Il motore calcolava già `target`, ma agent40 non lo scriveva nel blocco `markets` dello stato:
    // la dashboard poteva solo mostrare l'offset CONFIGURATO, cioè un numero statico al posto di una
    // distanza che cambia a ogni ciclo. Qui si verifica il cablaggio, non la resa grafica.
    const fs = require('fs');
    const path = require('path');
    const ag = fs.readFileSync(path.join(__dirname, '../../agents/agent40-manual-reprice.js'), 'utf8');
    ok('agent40 pubblica `target` nel blocco markets', /target: m\.target/.test(ag));
    ok('  con il modo, «in cima», e la distanza REALE dal mid',
      /mode: m\.target\.yes\.mode/.test(ag) && /onTop: m\.target\.yes\.onTop/.test(ag) && /offsetCents: m\.target\.yes\.offsetCents/.test(ag));
    ok('  per entrambi i lati', /m\.target\.no\.mode/.test(ag));
    ok('  e pubblica anche il motivo per cui un mercato è fuori scopo', /dynamicGate: m\.erosionGate/.test(ag));

    // E il ciclo lo produce davvero, con i campi che la UI legge.
    const h = harness({ bids: () => [{ price: 0.495, size: 800 }] });
    const r = await h.run();
    const t = tgt(r, 'yes');
    for (const k of ['mode', 'onTop', 'alone', 'bestOther', 'offsetCents', 'priceCents']) {
      ok(`  il ciclo produce «${k}»`, t[k] !== undefined, String(t[k]));
    }
    ok('  e la distanza reale è DIVERSA da quella configurata', t.offsetCents !== 1,
      `${t.offsetCents}¢ reali contro 1¢ configurato — è esattamente il dato falso che la UI mostrava`);
  }

  console.log(`\nmai in cima nel ciclo: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

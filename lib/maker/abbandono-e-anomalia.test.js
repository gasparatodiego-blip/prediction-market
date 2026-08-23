'use strict';
// lib/maker/abbandono-e-anomalia.test.js — LE DUE PROPRIETA' CHIESTE DALL'OPERATORE IL 23 AGOSTO 2026.
//
//   ① Una posizione scoperta di valore SOTTO SOGLIA, il cui costo d'uscita SUPERA il valore residuo,
//      DEVE essere dichiarata abbandonata e NON deve essere riprovata.
//   ② Una posizione scoperta oltre 240 minuti DEVE produrre una riga di anomalia grave nel giornale —
//      e deve continuare a produrla ANCHE quando e' abbandonata.
//
// ⚠ LA ② E' LA RAGIONE PER CUI QUESTO FILE ESISTE INSIEME ALLA ①, e non e' un contorno. L'abbandono
//   fa `continue` sulla posizione: se quel `continue` stesse sopra il blocco dell'anomalia, chiudere
//   il primo difetto renderebbe MUTO un presidio — cioe' si spegnerebbe una difesa mentre si dichiara
//   di non toccarne nessuna. E' la classe «filtro a monte che svuota l'eccezione scritta a valle»
//   (§5.3), applicata a se stessi. L'asserzione qui sotto e' l'unica cosa che lo impedisce domani.
//
// ⚠ MISURA CHE HA PRODOTTO QUESTE FIXTURE (giornale vivo del 23 agosto, non inventate):
//   · `0xd947c421` NO 56,1 @ 0,065 · bid camminato 2,72¢ ⇒ valore $1,52 · costo d'uscita $2,12
//   · `0xc5cd9325` YES 56,5 @ 0,05 · bid camminato 0,72¢ ⇒ valore $0,41 · costo d'uscita $2,42
//   · `0x4d79d306` NO 56,1 @ 0,494 · bid camminato 39,0¢ ⇒ valore $21,88 · costo $5,83 ⇒ NON abbandonata
//   e l'anomalia grave era GIA' scritta: 394 righe su `0x4d79d306` (da 249,3 a 673,3 min) e 101 su
//   `0xd947c421`. Il presidio dei 240 minuti NON era muto — questo file lo difende, non lo ripara.

const assert = require('assert');
const { runAutoCloseCycle, GTD_CHIUSURA_SECONDS } = require('./auto-close');
const { valutaAbbandono, aggiornaRegistro, abbandonate, mercatiInteramenteAbbandonati,
  SOGLIA_ABBANDONO_USD, chiaveAbbandono } = require('./abbandono-posizione');
const { MERGE_WAIT_TIMEOUT_MIN } = require('./strategia-merge');
const { RESTING_GTD_SECONDS, REFRESH_MARGIN_SECONDS } = require('./auto-reprice-config');

let passati = 0;
const ok = (c, n, x) => { assert.ok(c, n + (x ? ` — ${x}` : '')); passati += 1; };

const TOK_Y = 'tokY', TOK_N = 'tokN';
const liv = (price, size) => ({ price, size });

// La fixture del caso reale: NO @ 0,065, bid a 3¢/2,7¢, ask dell'altro lato a 97¢/97,3¢.
const regole = (over = {}) => ({
  readable: true, tick: 0.001, minSize: 20, maxSpreadCents: 4.5,
  tokenId: TOK_Y, tokenIdNo: TOK_N, midSource: 'live-book', midAgeSec: 3,
  books: { yes: { scoringMid: 0.965, bestBid: 0.96, bestAsk: 0.97 },
    no: { scoringMid: 0.035, bestBid: 0.03, bestAsk: 0.04 } },
  ...over,
});
const PROFONDITA = {
  no: { bids: [liv(0.03, 20), liv(0.027, 60)], asks: [liv(0.04, 200)] },
  yes: { bids: [liv(0.96, 200)], asks: [liv(0.97, 20), liv(0.973, 60)] },
};
// Un libro RICCO sul lato posseduto: stessa posizione, ma il bid paga bene ⇒ non si abbandona.
const PROFONDITA_RICCA = {
  no: { bids: [liv(0.39, 200)], asks: [liv(0.40, 200)] },
  yes: { bids: [liv(0.60, 200)], asks: [liv(0.61, 200)] },
};

/**
 * Un giro completo con una posizione NO scoperta, scoperta da `scopertoDaMin` minuti.
 * `abbandonatePrec` sono le chiavi gia' confermate nei giri precedenti.
 */
async function giro({ scopertoDaMin = 300, profondita = PROFONDITA, abbandonatePrec = [],
  size = 56.1, carico = 0.065, conAbbandoni = true } = {}) {
  const inviati = [], righe = [], applicati = [];
  const res = await runAutoCloseCycle({
    marketIds: ['0xm'],
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isEnabled: () => ({ enabled: true, reason: null }),
    isManual: () => ({ manual: true, readable: true }),
    resolveRules: () => ({ ...regole(), marketId: '0xm' }),
    listOrders: async () => ({ ok: true, orders: [] }),
    readPositions: async () => ({ ok: true, positions: [{ tokenId: TOK_N, size, avgPrice: carico }] }),
    readVenue: async () => ({ readable: true, closed: false, acceptingOrders: true }),
    readDepth: () => profondita,
    // Il registro della modalita' chiusura: e' da qui che nasce `scopertoDaMin`, cioe' il gradino.
    chiusura: { leggi: () => ({ attiva: true, daMin: scopertoDaMin }) },
    placeOrder: async (o) => { inviati.push(o); return { ok: true, sent: true, orderId: 'x' }; },
    cancelOrder: async () => ({ ok: true }),
    audit: (r) => righe.push(r),
    ...(conAbbandoni ? { abbandoni: {
      leggi: () => ({ readable: true, chiavi: abbandonatePrec }),
      applica: (g) => { applicati.push(...g); return { entrati: [], usciti: [], confermati: [] }; },
    } } : {}),
  });
  return { res, inviati, righe, applicati };
}

const CHIAVE = chiaveAbbandono('0xm', TOK_N);

(async () => {
  // ══ ① LA POSIZIONE SOTTO SOGLIA E TROPPO CARA DA CHIUDERE E' ABBANDONATA E NON SI RIPROVA ══════
  {
    const g = await giro({ abbandonatePrec: [CHIAVE] });
    const abb = g.righe.filter((r) => r.outcome === 'posizione-abbandonata');
    ok(abb.length === 1,
      '① ⚑ la posizione confermata abbandonata produce la riga `posizione-abbandonata`',
      `righe: ${g.righe.map((r) => r.outcome).join(',')}`);
    ok(g.inviati.length === 0,
      '① ⚑ e NON SI RIPROVA: zero ordini mandati al venue', `${g.inviati.length} inviati`);
    ok((g.res.actions || []).some((a) => a.gate === 'posizione-abbandonata'),
      '① il referto porta il gate `posizione-abbandonata`');
    // I numeri della decisione finiscono a verbale, o il giorno dopo non si sa perche'.
    const o = abb[0] && abb[0].observed;
    ok(o && o.valoreResiduo != null && o.costoUscita != null && o.soglia === SOGLIA_ABBANDONO_USD,
      '① valore residuo, costo d\'uscita e soglia sono a verbale', JSON.stringify(o));
    ok(o.costoUscita >= o.valoreResiduo && o.valoreResiduo < SOGLIA_ABBANDONO_USD,
      '① e i due numeri soddisfano davvero la regola dichiarata',
      `valore ${o.valoreResiduo} costo ${o.costoUscita} soglia ${o.soglia}`);
    // L'obbligo di esito del merge si CHIUDE dichiarando, non tacendo (§4.6).
    ok(g.righe.some((r) => r.outcome === 'merge-saltato-posizione-abbandonata'),
      '① ⚑ il merge saltato e DICHIARATO, non taciuto');
    ok(!g.righe.some((r) => r.outcome === 'merge-esito-mancante'),
      '① e nessun obbligo di esito resta aperto');
  }

  // ══ ② L'ANOMALIA DELLE QUATTRO ORE E' SCRITTA — ANCHE SU UNA POSIZIONE ABBANDONATA ═════════════
  // ⚠ E' L'ASSERZIONE CHE FALLISCE se qualcuno sposta il `continue` dell'abbandono sopra il blocco
  //   dell'anomalia. Abbandonare significa smettere di AGIRE, mai smettere di DICHIARARE.
  {
    const g = await giro({ scopertoDaMin: 649, abbandonatePrec: [CHIAVE] });
    ok(g.righe.some((r) => r.outcome === 'scoperto-oltre-soglia-grave'),
      '② ⚑ posizione ABBANDONATA e scoperta da 649 min: l\'anomalia grave e\' comunque a verbale',
      g.righe.map((r) => r.outcome).join(','));
    const a = g.righe.find((r) => r.outcome === 'scoperto-oltre-soglia-grave');
    ok(a.observed.scopertoDaMin === 649 && a.observed.urgenzaLivello === 3,
      '②   e porta i minuti veri e il gradino 3', JSON.stringify(a.observed));
    ok(g.inviati.length === 0, '②   e continua a non riprovare');
  }
  {
    // E la stessa riga esiste su una posizione NON abbandonata: il presidio non dipende dall'abbandono.
    const g = await giro({ scopertoDaMin: 649, profondita: PROFONDITA_RICCA, carico: 0.494 });
    ok(g.righe.some((r) => r.outcome === 'scoperto-oltre-soglia-grave'),
      '② ⚑ CONTROLLO: anche senza abbandono i 240 min producono l\'anomalia');
    ok(!g.righe.some((r) => r.outcome === 'posizione-abbandonata'),
      '② ⚑ CONTROLLO: una posizione che vale $21,88 NON viene abbandonata');
  }
  {
    // Sotto i 240 minuti l'anomalia NON si scrive: la soglia e' quella, non «sempre».
    const g = await giro({ scopertoDaMin: 100, profondita: PROFONDITA_RICCA, carico: 0.494 });
    ok(!g.righe.some((r) => r.outcome === 'scoperto-oltre-soglia-grave'),
      '② ⚑ CONTROLLO: a 100 min nessuna anomalia — la soglia morde davvero');
  }

  // ══ ③ LA PRIMA OSSERVAZIONE ARMA SOLTANTO ═══════════════════════════════════════════════════════
  {
    const g = await giro({ abbandonatePrec: [] });
    ok(!g.righe.some((r) => r.outcome === 'posizione-abbandonata'),
      '③ ⚑ senza conferma precedente NON si abbandona: la prima osservazione arma soltanto');
    ok(g.applicati.length === 1 && g.applicati[0].giudizio.abbandonabile === true,
      '③   ma il giudizio di questo giro va nel registro, e dice `abbandonabile`',
      JSON.stringify(g.applicati.map((a) => a.giudizio && a.giudizio.causa)));
  }

  // ══ ④ MONOTONO: senza `deps.abbandoni` il ciclo e' quello di prima ══════════════════════════════
  {
    const g = await giro({ conAbbandoni: false });
    ok(!g.righe.some((r) => r.outcome === 'posizione-abbandonata'),
      '④ ⚑ dep non cablata ⇒ nessun abbandono, comportamento di prima');
  }

  // ══ ⑤ SI ESCE DALL'ABBANDONO SUBITO, senza aspettare il registro ════════════════════════════════
  {
    const g = await giro({ abbandonatePrec: [CHIAVE], profondita: PROFONDITA_RICCA, carico: 0.494 });
    ok(!g.righe.some((r) => r.outcome === 'posizione-abbandonata'),
      '⑤ ⚑ il libro e\' migliorato: si rientra nello stesso giro, senza aspettare il registro');
  }

  // ══ ⑥ IL GTD DELLA CORSIA DI CHIUSURA E' DERIVATO, E LA QUOTAZIONE NON E' TOCCATA ══════════════
  {
    ok(GTD_CHIUSURA_SECONDS === MERGE_WAIT_TIMEOUT_MIN * 60 + REFRESH_MARGIN_SECONDS,
      '⑥ ⚑ il GTD di chiusura e DERIVATO dall\'attesa del Livello 2 e dal margine di rinnovo, non ricopiato',
      `${GTD_CHIUSURA_SECONDS} vs ${MERGE_WAIT_TIMEOUT_MIN * 60 + REFRESH_MARGIN_SECONDS}`);
    ok(GTD_CHIUSURA_SECONDS > MERGE_WAIT_TIMEOUT_MIN * 60,
      '⑥ ⚑ e SUPERA l\'attesa che la regola concede: l\'inversione misurata il 23/08 non puo\' tornare',
      `${GTD_CHIUSURA_SECONDS}s vs ${MERGE_WAIT_TIMEOUT_MIN * 60}s`);
    ok(RESTING_GTD_SECONDS === 1380,
      '⑥ ⚑ la corsia di QUOTAZIONE resta a 23 minuti: il premio non conosce la coda, allungare li non compra niente',
      String(RESTING_GTD_SECONDS));
    ok(GTD_CHIUSURA_SECONDS > RESTING_GTD_SECONDS,
      '⑥ e le due corsie sono davvero diverse');
    // E il ttl viaggia davvero sull'ordine: si guarda l'ordine mandato, non la costante.
    const g = await giro({ scopertoDaMin: 300, profondita: PROFONDITA_RICCA, carico: 0.494 });
    const conTtl = g.inviati.filter((o) => o && Number.isFinite(Number(o.ttlSeconds)));
    ok(conTtl.length > 0 && conTtl.every((o) => Number(o.ttlSeconds) === GTD_CHIUSURA_SECONDS),
      '⑥ ⚑ ogni ordine di CHIUSURA parte col GTD della corsia di chiusura',
      JSON.stringify(g.inviati.map((o) => o && o.ttlSeconds)));
  }

  // ══ ⑦ LA COPPIA BATTE SEMPRE L'ABBANDONO ════════════════════════════════════════════════════════
  {
    const v = valutaAbbandono({ carico: 0.065, size: 56.1, sizeAltroLato: 56.1,
      bidsMioLato: [liv(0.001, 500)], asksAltroLato: [liv(0.999, 500)] });
    ok(v.abbandonabile === false && v.causa === 'coppia-completa',
      '⑦ ⚑ con la sorella in portafoglio non si abbandona MAI: il merge rende $1/share');
  }

  // ══ ⑧ LO SLOT SI LIBERA SOLO SE OGNI POSIZIONE DEL MERCATO E' ABBANDONATA ══════════════════════
  {
    const gi = { chiave: chiaveAbbandono('0xm', TOK_N), marketId: '0xm', tokenId: TOK_N,
      giudizio: valutaAbbandono({ carico: 0.065, size: 56.1, sizeAltroLato: 0,
        bidsMioLato: PROFONDITA.no.bids, asksAltroLato: PROFONDITA.yes.asks }) };
    let r = aggiornaRegistro({ registro: {}, giudizi: [gi], ora: 1000 });
    r = aggiornaRegistro({ registro: r.registro, giudizi: [gi], ora: 61000 });
    ok(abbandonate({ registro: r.registro }).length === 1, '⑧ due osservazioni contigue ⇒ abbandonata');
    ok(mercatiInteramenteAbbandonati({ registro: r.registro,
      posizioni: [{ conditionId: '0xm', tokenId: TOK_N }] }).has('0xm'),
      '⑧ ⚑ unica posizione abbandonata ⇒ lo slot si libera');
    ok(mercatiInteramenteAbbandonati({ registro: r.registro,
      posizioni: [{ conditionId: '0xm', tokenId: TOK_N }, { conditionId: '0xm', tokenId: TOK_Y }] }).size === 0,
      '⑧ ⚑ una gamba ancora viva ⇒ lo slot NON si libera: quel mercato sta ancora lavorando');
  }

  // ══ ⑨ FAIL-CLOSED: cio' che non si legge non puo' far smettere di provare ══════════════════════
  {
    const casi = [
      ['carico illeggibile', { carico: null, size: 56.1, sizeAltroLato: 0, bidsMioLato: PROFONDITA.no.bids, asksAltroLato: PROFONDITA.yes.asks }],
      ['sizeAltroLato non letta', { carico: 0.065, size: 56.1, bidsMioLato: PROFONDITA.no.bids, asksAltroLato: PROFONDITA.yes.asks }],
      ['bid che non copre la size', { carico: 0.065, size: 5000, sizeAltroLato: 0, bidsMioLato: PROFONDITA.no.bids, asksAltroLato: [liv(0.97, 99999)] }],
      ['ask dell\'altro lato che non copre', { carico: 0.065, size: 56.1, sizeAltroLato: 0, bidsMioLato: PROFONDITA.no.bids, asksAltroLato: [liv(0.97, 1)] }],
    ];
    for (const [nome, arg] of casi) {
      const v = valutaAbbandono(arg);
      ok(v.abbandonabile === false && v.giudicabile === false,
        `⑨ ⚑ ${nome} ⇒ non giudicabile ⇒ NON abbandonata`, JSON.stringify(v.causa));
    }
  }

  console.log(`abbandono e anomalia: ${passati}/${passati} verdi, 0 rossi`);
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });

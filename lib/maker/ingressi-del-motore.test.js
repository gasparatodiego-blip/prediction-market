#!/usr/bin/env node
'use strict';
// GLI INGRESSI DEL MOTORE: IL SALDO ALLA REGOLA 5, E UN DENOMINATORE OMOGENEO ALLA REGOLA 2.
//
// ═══ I DUE DIFETTI, ENTRAMBI DI CABLAGGIO ════════════════════════════════════════════════════════════
// 1 · REGOLA 5 SENZA INGRESSI. `tettoMercato` legge `saldoUsd` e `esposizioneMercatoUsd`; agent40 non
//     passava ne' l'uno ne' l'altro. La regola falliva chiusa a ogni giro — «saldo non leggibile:
//     nessuna nuova esposizione» — ed e' cio' che teneva fermi i rinnovi dopo il fix del 6 agosto 2026
//     sul cablaggio di `bookLevels` (2346db2). Stessa famiglia: la regola c'era, i suoi numeri no.
//
// 2 · PAVIMENTO CON DENOMINATORE GONFIO. Il pavimento e' il 10% della liquidita' media in banda, presa
//     dal giornale di agent34 (`bidDepthInBand + askDepthInBand`), che somma il book PUBBLICO — i
//     NOSTRI ordini compresi. Il confronto pero' avviene contro la profondita' ALTRUI, che
//     `othersLadder` ottiene sottraendo i nostri. Piu' capitale mettiamo a riposo, piu' alto diventa
//     il pavimento da superare: il maker si sbarra la strada da solo.
//
// ═══ COSA VERIFICA QUESTO FILE ═══════════════════════════════════════════════════════════════════════
// 1 · la cache del saldo: valore fresco usato, nessuna seconda lettura dentro la TTL, ripiego
//     sull'ultimo valido quando la catena non risponde, fail-closed oltre 3x la TTL;
// 2 · la Regola 5 con ingressi veri: sotto tetto passa, sopra tetto blocca, saldo inaffidabile blocca;
// 3 · l'esposizione: ordini a riposo + posizioni, l'ordine in valutazione escluso, e fail-closed
//     quando le posizioni non sono leggibili (contarle 0 allargherebbe il tetto in silenzio);
// 4 · il denominatore: con nostri ordini sul book la misura li esclude, e il pavimento che ne esce e'
//     PIU' BASSO di quello della vecchia media a parita' di book;
// 5 · non-regressione: il percorso storico di `pavimentoDepth` invariato per chi non passa la media
//     pulita, e il fix di `bookLevels` ancora in piedi.
//
// NESSUN ORDINE REALE: dipendenze iniettate, nessuna rete, nessun file fuori da una cartella temporanea.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AR = require('./auto-reprice');
const { valutaMercato, pavimentoDepth, DEPTH_FLOOR_PCT_OF_AVG, DEPTH_FLOOR_FALLBACK_USD } = require('./motore-unico');
const { creaCacheSaldo, SALDO_CACHE_TTL_MS, ETA_MASSIMA_MULT } = require('./saldo-cache');
const PA = require('./profondita-altrui');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const vicino = (a, b, eps = 1e-6) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < eps;

const MKT = '0xfb481845055afdf15febad269fcb534be4c5e79d5789b72659a036660b46e11b';
const NOW = 1_700_000_000_000;

const REGOLE = (mid = 0.6515) => ({
  readable: true, missing: [], marketId: MKT, title: 'Eric Barlow', mid, tick: 0.001, minSize: 50,
  maxSpreadCents: 4.5, tokenId: 'ty', tokenIdNo: 'tn', midSource: 'live-book', midAgeSec: 2,
  scoringMid: mid,
  feedVitality: { assetsWithEvents: 40, seededAssets: 100, windowMs: 30_000 },
  books: { yes: { tokenId: 'ty', scoringMid: mid }, no: { tokenId: 'tn', scoringMid: +(1 - mid).toFixed(6) } },
});

const CFG = {
  restingGtdSeconds: 1380, refreshMarginSeconds: 180, minIntervalMs: 30_000, maxPerHour: 20,
  maxMidAgeSecLive: 60, maxMidAgeSecBlind: 10, feedAliveMinAssets: 5, requireLiveBook: true,
  confirmSamples: 2, hysteresisTicks: 1, pollMs: 5000, strategy: 'band-edge', disconnectCancelSeconds: 180,
};

const NOSTRO = {
  orderId: '0xb99f5566', source: 'manual-ui', side: 'BUY', price: 0.649, size: 60.1,
  sizeRemaining: 60.1, marketId: MKT, tokenId: 'ty', secondsToExpiry: 120, orderType: 'GTD',
};
/** Come lo vede il ciclo dopo `selectOwnedOrders`: con il `book` risolto dal token, mai indovinato. */
const NOSTRO_COLLOCATO = { ...NOSTRO, book: 'yes' };

// Un book con abbondanza. La banda del mercato e' [0.629, 0.674] nello spazio YES.
const BOOK = {
  readable: true,
  yes: {
    bids: [
      { price: 0.652, size: 400 },
      { price: 0.651, size: 1000 },
      { price: 0.650, size: 800 },
      { price: 0.649, size: 60.1 },   // il NOSTRO, e nient'altro su quel livello
    ],
    asks: [{ price: 0.660, size: 300 }],
  },
  no: { bids: [{ price: 0.33, size: 500 }, { price: 0.329, size: 900 }], asks: [] },
};

/** Un ciclo completo con TUTTI gli ingressi del motore cablati. */
function giro({ saldo, posizioni, liquiditaAltrui, ordini = [NOSTRO] } = {}) {
  const righe = [];
  const visti = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingressi-motore-'));
  const configDeps = {
    configFile: path.join(dir, 'config.json'),
    autoStateFile: path.join(dir, 'state.json'),
    autoAuditFile: path.join(dir, 'audit.jsonl'),
  };
  fs.writeFileSync(configDeps.configFile, JSON.stringify({ global: { enabled: true }, markets: { [MKT.toLowerCase()]: { enabled: true } } }));
  fs.writeFileSync(configDeps.autoStateFile, JSON.stringify({
    markets: { [MKT.toLowerCase()]: { lastRepriceAt: NOW - 600_000, recentAt: [] } }, heartbeatAt: NOW, cycles: 1,
  }));
  return AR.runAutoRepriceCycle({
    now: () => NOW,
    configDeps,
    config: CFG,
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isManual: () => ({ manual: true, readable: true }),
    trackedMarketIds: () => [],
    marketWindow: () => ({ tooClose: false }),
    resolveRules: () => REGOLE(),
    resolveOffset: () => ({ targetOffsetCents: 0.55, source: 'observed', minMoveCents: 0.1 }),
    rememberObserved: () => {},
    resolveDepth: () => BOOK,
    valutaMercato: (arg) => { visti.push(arg); return valutaMercato(arg); },
    // Il denominatore pulito: $651.5 di profondita' altrui media ⇒ pavimento $65.15.
    liquiditaAltrui: () => liquiditaAltrui || { mediaUsd: 651.5, campioni: 200 },
    liquiditaMedia: () => ({ media: 1000, campioni: 200 }),
    saldo: () => saldo || { usd: 5000, affidabile: true, fonte: 'cache', etaMs: 1000, motivo: null },
    posizioniMercatoUsd: () => posizioni || { leggibile: true, usd: 0, motivo: null },
    listOrders: async () => ({ ok: true, simulated: false, orders: ordini }),
    replaceOrder: async () => ({ ok: true, oldCancelled: true, replaced: true, place: { sent: true, orderId: '0xNEW' } }),
    audit: (rec) => righe.push(rec),
  }).then((res) => ({ res, righe, visti }));
}

const skipDelMotore = (righe) => righe.find((r) => r.gate === 'motore-non-conforme') || null;

(async () => {

  console.log('\n══ 1 · LA CACHE DEL SALDO');
  {
    let chiamate = 0;
    let risposta = { usd: 1234.5, funder: '0xF', motivo: null };
    const c = creaCacheSaldo({ leggiCatena: async () => { chiamate++; return risposta; } });

    const a = await c.leggi({ now: NOW });
    ok('la prima lettura va sulla catena e torna il valore', a.affidabile === true && vicino(a.usd, 1234.5),
      `$${a.usd} · ${chiamate} lettura`);

    const b = await c.leggi({ now: NOW + SALDO_CACHE_TTL_MS - 1 });
    ok('dentro la TTL NON si torna sulla catena', chiamate === 1 && b.fonte === 'cache' && vicino(b.usd, 1234.5),
      `${chiamate} letture in ${Math.round((SALDO_CACHE_TTL_MS - 1) / 1000)}s`);

    risposta = { usd: 999, funder: '0xF', motivo: null };
    const d = await c.leggi({ now: NOW + SALDO_CACHE_TTL_MS });
    ok('scaduta la TTL si rilegge, e il valore nuovo passa', chiamate === 2 && vicino(d.usd, 999), `$${d.usd}`);

    // La catena smette di rispondere: si tiene l'ultimo valore valido, con la sua eta'.
    risposta = { usd: null, funder: '0xF', motivo: 'nodo RPC irraggiungibile' };
    const t1 = NOW + SALDO_CACHE_TTL_MS * 2;
    const e = await c.leggi({ now: t1 });
    ok('catena muta: si ripiega sull ultimo valore valido', e.affidabile === true && vicino(e.usd, 999),
      `$${e.usd}, eta ${Math.round(e.etaMs / 1000)}s · ${e.fonte}`);
    ok('  e il motivo dice che e un ripiego, non una lettura', /lettura fallita/.test(e.motivo || ''), e.motivo);

    // Oltre 3x la TTL quel valore non autorizza piu' niente.
    const t2 = NOW + SALDO_CACHE_TTL_MS + SALDO_CACHE_TTL_MS * ETA_MASSIMA_MULT + 1000;
    const f = await c.leggi({ now: t2 });
    ok(`oltre ${ETA_MASSIMA_MULT}x la TTL il saldo NON e piu affidabile`, f.affidabile === false && vicino(f.usd, 999),
      `eta ${Math.round(f.etaMs / 1000)}s > ${Math.round(SALDO_CACHE_TTL_MS * ETA_MASSIMA_MULT / 1000)}s`);
    ok('  e il valore vecchio resta visibile: «vecchio» non e «ignoto»', f.usd != null && f.fonte === 'cache-scaduta', f.motivo);

    const vuota = creaCacheSaldo({ leggiCatena: async () => ({ usd: null, funder: null, motivo: 'nessun funder configurato' }) });
    const g = await vuota.leggi({ now: NOW });
    ok('saldo mai letto: null e non affidabile, mai 0', g.usd === null && g.affidabile === false, g.motivo);

    // Uno zero LETTO e' un fatto, non un'assenza: la Regola 5 lo bocciera' con la sua frase.
    const zero = creaCacheSaldo({ leggiCatena: async () => ({ usd: 0, funder: '0xF', motivo: null }) });
    const h = await zero.leggi({ now: NOW });
    ok('uno zero letto e affidabile: «vuoto» non e «illeggibile»', h.usd === 0 && h.affidabile === true);
  }

  console.log('\n══ 2 · LA REGOLA 5 CON INGRESSI VERI');
  {
    const sotto = await giro({ saldo: { usd: 5000, affidabile: true, fonte: 'cache', etaMs: 0 } });
    const vSotto = sotto.visti[0];
    ok('il motore riceve un saldo, non null', vSotto && vSotto.saldoUsd === 5000, `$${vSotto && vSotto.saldoUsd}`);
    ok('  e sotto il tetto la Regola 5 CONSENTE', !skipDelMotore(sotto.righe),
      `nozionale $${(NOSTRO.price * NOSTRO.size).toFixed(2)} contro un tetto da $1000`);

    // ── IL TETTO È FISSO DAL 9 AGOSTO 2026, E LA FIXTURE È STATA RITARATA ──────────────────────────
    // Prima: $100 di saldo ⇒ tetto 20% = $20, e l'ordine da ~$39 sfondava. Adesso il tetto è $130 fissi
    // clampati al saldo, quindi con $100 in cassa il tetto è $100 e un ordine da $39 PASSA — ed è il
    // comportamento voluto, non una protezione persa. Per provare che la Regola 5 blocca davvero serve
    // un saldo sotto il nozionale dell'ordine: $30 ⇒ tetto $30 ⇒ $39 sfonda.
    const sopra = await giro({ saldo: { usd: 30, affidabile: true, fonte: 'cache', etaMs: 0 } });
    const rSopra = skipDelMotore(sopra.righe);
    ok('sopra il tetto la Regola 5 BLOCCA', !!rSopra && /il mercato arriverebbe a/.test(rSopra.reason || ''), rSopra && rSopra.reason);
    ok('  e il motivo dice che è il SALDO ad aver stretto il tetto, non il tetto pieno',
      !!rSopra && /il saldo è più basso/.test(rSopra.reason || ''), rSopra && rSopra.reason);
    ok('  e l audit porta il saldo che l ha deciso', rSopra && rSopra.observed && rSopra.observed.saldoUsd === 30,
      `saldoUsd=${rSopra && rSopra.observed && rSopra.observed.saldoUsd}`);

    // E il caso che conta adesso: con capitale abbondante è il TETTO FISSO a mordere, non la frazione.
    const { MARKET_CAP_FIXED_USD } = require('../rewards/concentration');
    const ricco = await giro({ saldo: { usd: 5000, affidabile: true, fonte: 'cache', etaMs: 0 },
      posizioni: { leggibile: true, usd: MARKET_CAP_FIXED_USD, motivo: null } });
    const rRicco = skipDelMotore(ricco.righe);
    // Il motivo si cerca col numero DERIVATO dal modulo, non con «130» scritto a mano: il banco difende
    // «a capitale abbondante morde il tetto FISSO, non una frazione del saldo», non un numero.
    ok(`  con $5.000 in cassa il tetto resta $${MARKET_CAP_FIXED_USD}: un mercato già al tetto non ne prende altro`,
      !!rRicco && rRicco.reason.includes(`$${MARKET_CAP_FIXED_USD.toFixed(2)}`), rRicco && rRicco.reason);

    const inaffidabile = await giro({ saldo: { usd: 5000, affidabile: false, fonte: 'cache-scaduta', etaMs: 200_000, motivo: 'vecchio di 200s' } });
    const rIn = skipDelMotore(inaffidabile.righe);
    ok('saldo inaffidabile BLOCCA, anche se un numero c e', !!rIn && /saldo non leggibile/.test(rIn.reason || ''), rIn && rIn.reason);
    ok('  e nell audit il saldo resta null: non e stato usato', rIn && rIn.observed && rIn.observed.saldoUsd === null,
      `saldoUsd=${JSON.stringify(rIn && rIn.observed && rIn.observed.saldoUsd)}`);
  }

  console.log('\n══ 3 · L ESPOSIZIONE GIA IMPEGNATA SU QUEL MERCATO');
  {
    const altro = { ...NOSTRO, orderId: '0xALTRO', price: 0.650, size: 100, sizeRemaining: 100 };

    const e1 = AR.esposizioneDelMercato({
      owned: [NOSTRO, altro], escludiOrderId: NOSTRO.orderId,
      posizioni: { leggibile: true, usd: 74.8, motivo: null },
    });
    ok('somma ordini a riposo + posizioni', e1.leggibile === true && vicino(e1.usd, 0.650 * 100 + 74.8, 1e-4),
      `$${e1.usd} = $${e1.ordiniUsd} a riposo + $${e1.posizioniUsd} di posizione`);
    ok('  e l ordine in valutazione ESCE dal conto', vicino(e1.ordiniUsd, 65, 1e-4),
      'altrimenti il suo rimpiazzo verrebbe contato due volte e il tetto si bloccherebbe da solo');

    const e2 = AR.esposizioneDelMercato({ owned: [altro], posizioni: { leggibile: false, usd: null, motivo: 'snapshot vecchio di 400s' } });
    ok('posizioni illeggibili ⇒ esposizione IGNOTA, non zero', e2.leggibile === false && e2.usd === null, e2.motivo);

    const e3 = AR.esposizioneDelMercato({ owned: [{ orderId: '0xX', price: null, size: 10 }], posizioni: { leggibile: true, usd: 0 } });
    ok('un ordine senza prezzo rende ignota tutta la somma', e3.leggibile === false, e3.motivo);

    const e4 = AR.esposizioneDelMercato({ imposta: 42 });
    ok('un valore imposto dal chiamante vince su tutto', e4.leggibile === true && e4.usd === 42);

    // E nel ciclo: posizioni illeggibili devono bloccare, senza nemmeno interpellare il motore.
    const g = await giro({ posizioni: { leggibile: false, usd: null, motivo: 'snapshot delle posizioni vecchio di 400s' } });
    const r = skipDelMotore(g.righe);
    ok('nel ciclo, posizioni illeggibili BLOCCANO', !!r && /tetto-mercato/.test(r.reason || '') && /400s/.test(r.reason || ''), r && r.reason);
    ok('  e il motore non viene nemmeno chiamato', g.visti.length === 0, `${g.visti.length} chiamate`);
  }

  console.log('\n══ 4 · IL DENOMINATORE, TOLTI I NOSTRI ORDINI');
  {
    const rules = REGOLE();
    // Senza di noi sul book: e' il conto che la vecchia media faceva, perche' non sottraeva niente.
    const lordo = PA.misuraProfonditaAltrui({ rules, depth: BOOK, ownOrders: [] });
    const netto = PA.misuraProfonditaAltrui({ rules, depth: BOOK, ownOrders: [{ book: 'yes', side: 'BUY', price: 0.649, size: 60.1 }] });
    ok('la misura e leggibile su entrambi i lati', lordo.leggibile === true && netto.leggibile === true,
      `yes $${netto.lati.yes.usd} + no $${netto.lati.no.usd}`);
    ok('la nostra size esce dal denominatore, al centesimo', vicino(lordo.usd - netto.usd, +(0.649 * 60.1).toFixed(4), 1e-3),
      `$${lordo.usd} lordo − $${netto.usd} netto = $${(lordo.usd - netto.usd).toFixed(4)}`);

    // Il caso che conta davvero: la nostra size DENTRO un livello condiviso, non su un livello tutto nostro.
    const condiviso = { ...BOOK, yes: { ...BOOK.yes, bids: [{ price: 0.651, size: 1000 }] }, no: { bids: [], asks: [] } };
    const conNoi = PA.misuraProfonditaAltrui({ rules, depth: condiviso, ownOrders: [{ book: 'yes', side: 'BUY', price: 0.651, size: 600 }] });
    ok('su un livello CONDIVISO resta solo la parte altrui', vicino(conNoi.usd, +(0.651 * 400).toFixed(4), 1e-3),
      `$${conNoi.usd} di 400 share altrui su 1000 pubblicate`);

    // ── LA FORMA VERA DELLE REGOLE ───────────────────────────────────────────────────────────────
    // `resolveMarketRules` NON espone `scoringMid` in cima: mette `mid` al primo livello e i due mid
    // di scoring dentro `books`. Passare l'oggetto cosi' com'e' a `inBandPriceBounds` la fa rispondere
    // «non leggibile» sempre, e il campionamento morirebbe in silenzio — depositando zero campioni per
    // sempre, con il pavimento inchiodato al ripiego. Preso sul book vero prima di accorgersene.
    const { scoringMid: _via, ...comeDalVenue } = rules;
    const reale = PA.misuraProfonditaAltrui({ rules: comeDalVenue, depth: BOOK, ownOrders: [] });
    ok('la misura funziona con le regole NELLA FORMA CHE IL VENUE RESTITUISCE',
      reale.leggibile === true && vicino(reale.usd, lordo.usd), `$${reale.usd}`);

    // Un SELL su NO sta sul lato bid di YES, specchiato: e' la stessa aritmetica del motore.
    const specchiato = PA.nostriSulLatoBid([{ book: 'no', side: 'SELL', price: 0.349, size: 30 }], 'yes');
    ok('un SELL su NO viene specchiato sul lato bid di YES', specchiato.length === 1 && vicino(specchiato[0].price, 0.651),
      `0.349 su NO ⇒ ${specchiato[0].price} su YES`);

    // ── IL PRIMA E IL DOPO DEL PAVIMENTO, A PARITA DI BOOK ──────────────────────────────────────
    const pavNuovo = pavimentoDepth({ liquiditaMediaUsd: netto.usd, campioniAltrui: 200, prezzoRif: 0.6515 });
    const pavVecchio = pavimentoDepth({ liquiditaMediaShare: lordo.usd / 0.6515, prezzoRif: 0.6515, campioni: 200 });
    ok('il pavimento pulito e PIU BASSO di quello gonfio', pavNuovo.usd < pavVecchio.usd,
      `$${pavNuovo.usd.toFixed(2)} contro $${pavVecchio.usd.toFixed(2)}`);
    ok('  e la differenza e esattamente il 10% della nostra size', vicino(pavVecchio.usd - pavNuovo.usd, 0.649 * 60.1 * DEPTH_FLOOR_PCT_OF_AVG, 1e-3),
      `$${(pavVecchio.usd - pavNuovo.usd).toFixed(4)}`);
    ok('  e la fonte lo dichiara', pavNuovo.fonte === 'media-altrui', pavNuovo.motivo);
  }

  console.log('\n══ 5 · IL DEPOSITO DEI CAMPIONI PULITI');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-altrui-'));
    const file = path.join(dir, 'campioni.json');
    const rules = REGOLE();
    PA.scordaProfonditaAltrui();

    const c1 = PA.campionaProfonditaAltrui({ marketId: MKT, rules, depth: BOOK, ownOrders: [NOSTRO_COLLOCATO], now: NOW, file });
    const attesoNetto = PA.misuraProfonditaAltrui({ rules, depth: BOOK, ownOrders: [NOSTRO_COLLOCATO] }).usd;
    ok('il primo campione entra, ed e il valore NETTO', c1.registrato === true && vicino(c1.usd, attesoNetto),
      `$${c1.usd} — i nostri $${(0.649 * 60.1).toFixed(2)} non ci sono dentro`);

    // Un nostro ordine che il ciclo non e' riuscito a collocare su un book NON viene ignorato: se lo
    // fosse, resterebbe nel denominatore come se fosse di qualcun altro.
    // Su un file suo, per non incrociare il passo di campionamento gia' consumato qui sopra.
    const cIgnoto = PA.campionaProfonditaAltrui({
      marketId: MKT, rules, depth: BOOK, ownOrders: [NOSTRO], now: NOW, file: path.join(dir, 'ignoti.json'),
    });
    ok('un nostro ordine senza book fa RIFIUTARE la misura', cIgnoto.registrato === false
      && /non collocabili/.test(cIgnoto.motivo || ''), cIgnoto.motivo);

    const c2 = PA.campionaProfonditaAltrui({ marketId: MKT, rules, depth: BOOK, ownOrders: [NOSTRO_COLLOCATO], now: NOW + 1000, file });
    ok('un secondo campione a 1s NON entra: il passo e 45s', c2.registrato === false, c2.motivo);

    const m1 = PA.mediaProfonditaAltrui({ marketId: MKT, now: NOW + 2000, file });
    ok('con 1 campione la media NON e ancora sufficiente', m1.campioni === 1 && m1.sufficiente === false, m1.motivo);

    for (let i = 1; i < PA.MIN_CAMPIONI; i++) {
      PA.campionaProfonditaAltrui({ marketId: MKT, rules, depth: BOOK, ownOrders: [NOSTRO_COLLOCATO], now: NOW + i * PA.PASSO_CAMPIONE_MS, file });
    }
    const m2 = PA.mediaProfonditaAltrui({ marketId: MKT, now: NOW + PA.MIN_CAMPIONI * PA.PASSO_CAMPIONE_MS, file });
    ok(`con ${PA.MIN_CAMPIONI} campioni la media diventa affidabile`, m2.campioni === PA.MIN_CAMPIONI && m2.sufficiente === true,
      `media $${m2.mediaUsd} su ${m2.campioni} campioni`);

    // Un book illeggibile NON deposita uno zero: lascia una lacuna.
    const c3 = PA.campionaProfonditaAltrui({ marketId: MKT, rules, depth: null, ownOrders: [], now: NOW + 10 * PA.PASSO_CAMPIONE_MS, file });
    ok('un book non risolto lascia una LACUNA, non uno zero', c3.registrato === false && c3.usd === null, c3.motivo);
    const m3 = PA.mediaProfonditaAltrui({ marketId: MKT, now: NOW + 10 * PA.PASSO_CAMPIONE_MS, file });
    ok('  e la media non si abbassa per una misura mancata', m3.campioni === PA.MIN_CAMPIONI, `${m3.campioni} campioni`);

    // I campioni sopravvivono a un riavvio: la memoria di processo si scorda, il file no.
    PA.scordaProfonditaAltrui();
    const m4 = PA.mediaProfonditaAltrui({ marketId: MKT, now: NOW + 10 * PA.PASSO_CAMPIONE_MS, file });
    ok('lo storico sopravvive al riavvio dell agente', m4.campioni === PA.MIN_CAMPIONI && vicino(m4.mediaUsd, m2.mediaUsd),
      `riletti dal file: ${m4.campioni} campioni, media $${m4.mediaUsd}`);
    PA.scordaProfonditaAltrui();
  }

  console.log('\n══ 6 · NON-REGRESSIONE');
  {
    // Chi non passa `campioniAltrui` resta sul percorso storico, byte per byte.
    const storico = pavimentoDepth({ liquiditaMediaShare: 94931, prezzoRif: 0.74, campioni: 192 });
    ok('senza media pulita il percorso storico e invariato', storico.fonte === 'media'
      && vicino(storico.usd, +(94931 * 0.74 * DEPTH_FLOOR_PCT_OF_AVG).toFixed(4), 1e-3), `$${storico.usd}`);

    const magro = pavimentoDepth({ liquiditaMediaShare: 300, prezzoRif: 0.5, campioni: 2 });
    ok('  e lo storico insufficiente ripiega come prima', magro.fonte === 'fallback' && magro.usd === DEPTH_FLOOR_FALLBACK_USD);

    // Sorgente pulita DICHIARATA ma non ancora pronta ⇒ ripiego, MAI ritorno alla media sporca.
    const transizione = pavimentoDepth({ liquiditaMediaUsd: null, campioniAltrui: 2, liquiditaMediaShare: 94931, prezzoRif: 0.74, campioni: 192 });
    ok('storico pulito magro: si ripiega, non si torna alla media sporca',
      transizione.fonte === 'fallback' && transizione.usd === DEPTH_FLOOR_FALLBACK_USD, transizione.motivo);
    ok('  e il pavimento gonfio resta visibile come paragone', vicino(transizione.lordoUsd, +(94931 * 0.74 * DEPTH_FLOOR_PCT_OF_AVG).toFixed(4), 1e-3),
      `lordoUsd $${transizione.lordoUsd}`);

    // Il fix di bookLevels (2346db2) e' ancora in piedi: il motore riceve una scala vera.
    const g = await giro({});
    ok('il motore riceve ancora una SCALA, non null', Array.isArray(g.visti[0] && g.visti[0].bookLevels),
      `${(g.visti[0] && g.visti[0].bookLevels || []).length} livelli`);
    ok('  e i numeri della decisione viaggiano nell audit', g.visti.length > 0
      && g.visti[0].liquiditaMediaUsd === 651.5 && g.visti[0].liquiditaCampioniAltrui === 200,
      `mediaUsd=${g.visti[0] && g.visti[0].liquiditaMediaUsd}, campioni=${g.visti[0] && g.visti[0].liquiditaCampioniAltrui}`);
  }

  console.log(`\ningressi del motore: ${pass} passati, ${fail} falliti\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

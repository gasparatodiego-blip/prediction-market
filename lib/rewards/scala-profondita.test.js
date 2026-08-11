'use strict';
// lib/rewards/scala-profondita.test.js — LA PROFONDITÀ COME LIMITE DI SIZE, PROVATA DOVE DECIDE.
//
// `profondita-minima.selfcheck()` prova l'aritmetica della funzione pura. Questo prova le cose che solo
// il CABLAGGIO può sbagliare, più il vincolo che un test affrettato non vede:
//
//   1 · le quattro regole sui numeri VERI del board dell'11 agosto 2026;
//   2 · un mercato che prima veniva escluso ora entra con MENO capitale, e il piano lo dichiara;
//   3 · VINCOLO 4 — non esiste nessun percorso che porti la size al minimo del venue oltre la quota
//       sicura. Provato sulla funzione pura, sul piano vero, e per ASSENZA nel sorgente;
//   4 · i consumatori: il rendiconto dell'allocatore e quello di agent41 leggono gli stessi campi;
//   5 · nessun altro presidio è stato toccato.
//
// Esegue `planAllocation` VERO su curve costruite a mano: nessuna rete, nessun giornale, nessun file.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const {
  scalaProfondita, sizeMassimaSicura, MAX_QUOTA_CREDIBILE,
} = require('./profondita-minima');
const { ceilingShare, DEFAULTS } = require('./realistic-estimate');

let n = 0;
const ok = (name, cond, extra) => {
  assert.ok(cond, 'FAIL: ' + name + (extra ? ' — ' + extra : ''));
  console.log('  ✓ ' + name); n++;
};

// ── IL FIXTURE: un giornale finto a mid 0,50, dove il capitale si converte 1:1 in share per lato ──────
// Misurato sul planner vero e non assunto: con mid 0,50 e il modello di size storico, $65 di capitale di
// mercato comprano ESATTAMENTE 65 share per lato. Serve perché ogni numero di questo test si possa
// leggere indifferentemente in dollari o in share senza una conversione nascosta.
function righe(marketId, { depth, mid = 0.5, tick = 0.01, nPunti = 40 }) {
  const t0 = Date.now() - 6 * 3600_000;
  const out = [];
  for (let i = 0; i < nPunti; i++) {
    out.push({
      marketId, tsMs: t0 + i * 60_000, src: 'ws', adjMid: mid, tick,
      bidDepthInBand: depth, askDepthInBand: depth,
      tokenIdYes: 'tok-' + marketId, bids: [], asks: [],
    });
  }
  return out;
}
const ID = (ch) => '0x' + String(ch).repeat(64).slice(0, 64);
const pianoPulito = () => {
  delete require.cache[require.resolve('./allocator')];
  return require('./allocator').planAllocation;
};

console.log('\n── 1 · LE QUATTRO REGOLE SUI NUMERI VERI DEL BOARD (11 agosto 2026) ──────────────');
{
  // I tre mercati misurati sul board vero con `planFromCollection`, capitale $594,10, tetto $65.
  // Sono i soli tre in tutto il board che stanno vicino al confine: gli altri 111 con profondità
  // misurata hanno cQ ≥ 44 share, cioè un book che regge il tetto per mercato senza essere scalato.
  const VERI = {
    // Wellington 15°C — book VUOTO verificato, minimo del venue 100 share
    wellington: { cQ: 0, minSize: 100, quota500: 1.0 },
    // Trump 200+ Truth Social — cQ 39 share, minimo 20: S_max 58,5 e il livello pieno al 61,1%
    trump: { cQ: 39, minSize: 20, quota500: 0.929 },
    // il mercato scelto col book più sottile: cQ 45, entra INTERO perché a $65 la quota è ancora sotto
    scelto: { cQ: 45, minSize: 20, quota500: 0.919 },
  };
  const griglia = (capMax, passo, minS) => {
    const out = [{ capital: 0, shares: 0, finanziato: false, sottoMinimoVenue: false }];
    for (let c = passo; c <= capMax + 1e-9; c += passo) {
      out.push({ capital: c, shares: c, finanziato: true, sottoMinimoVenue: c < minS });
    }
    return out;
  };

  ok('S_max sul board vero: 0 · 58,5 · 67,5 share per cQ 0 · 39 · 45', (() => {
    return sizeMassimaSicura(VERI.wellington.cQ) === 0
      && Math.abs(sizeMassimaSicura(VERI.trump.cQ) - 58.5) < 1e-9
      && Math.abs(sizeMassimaSicura(VERI.scelto.cQ) - 67.5) < 1e-9;
  })());

  ok('REGOLA 2 · Wellington (book vuoto, minimo 100) resta ESCLUSO', (() => {
    const r = scalaProfondita({ livelli: griglia(65, 5, 100), depthShares: 0, minSizeShares: 100 });
    return r.stato === 'escluso-troppo-sottile' && r.capitaleMaxUsd === null;
  })());

  ok('REGOLA 3 · Trump (cQ 39, minimo 20) esce per la GRIGLIA, non per il book', (() => {
    // I gradini oltre 58,5 share vengono tolti; se sotto quel confine non resta niente di piazzabile
    // il mercato esce, ma con la diagnosi giusta: una size sicura ≥ minimo esisterebbe.
    const livelli = [
      { capital: 0, shares: 0, finanziato: false, sottoMinimoVenue: false },
      { capital: 10, shares: 10, finanziato: true, sottoMinimoVenue: true },   // sicuro ma sotto il minimo
      { capital: 65, shares: 65, finanziato: true, sottoMinimoVenue: false },  // 65 > 58,5 ⇒ tolto
    ];
    const r = scalaProfondita({ livelli, depthShares: VERI.trump.cQ, minSizeShares: 20 });
    return r.stato === 'escluso-sotto-minimo' && r.sizeMaxSicuraShares > 20 && r.tenuti[2] === false;
  })());

  ok('REGOLA 1 · Trump con una griglia più fine ENTRA, con size ridotta a 55 share', (() => {
    const r = scalaProfondita({ livelli: griglia(65, 5, 20), depthShares: VERI.trump.cQ, minSizeShares: 20 });
    return r.stato === 'ridotto' && r.capitaleMaxUsd === 55
      && ceilingShare(55, VERI.trump.cQ) <= MAX_QUOTA_CREDIBILE
      && ceilingShare(60, VERI.trump.cQ) > MAX_QUOTA_CREDIBILE;
  })());

  ok('  quota 55-65% ALLA SIZE EFFETTIVA ⇒ il mercato entra, ridotto quel tanto che basta', (() => {
    const r = scalaProfondita({ livelli: griglia(65, 5, 20), depthShares: VERI.trump.cQ, minSizeShares: 20 });
    const qPrima = ceilingShare(65, VERI.trump.cQ);     // 62,5% al tetto pieno
    const qDopo = r.quotaTenuta;                        // 58,5% al livello tenuto
    return qPrima > 0.55 && qPrima < 0.65 && qDopo <= MAX_QUOTA_CREDIBILE && qDopo > 0.55;
  })());

  ok('il mercato SCELTO (cQ 45) entra INTERO: a $65 la sua quota è già sotto il 60%', (() => {
    const r = scalaProfondita({ livelli: griglia(65, 5, 20), depthShares: VERI.scelto.cQ, minSizeShares: 20 });
    return r.stato === 'ok' && r.finanziatiTolti === 0 && ceilingShare(65, VERI.scelto.cQ) < MAX_QUOTA_CREDIBILE;
  })());

  // ── E LA COSA CHE IL CANCELLO SBAGLIAVA, DETTA CON I NUMERI ────────────────────────────────────
  // Tutti e tre questi mercati avevano quota > 60% al metro fisso di $500 e il cancello li toglieva.
  // Ma $500 su UN mercato non è una size che questo bot possa piazzare: il tetto per mercato è $65 e
  // NON dipende più dal capitale del conto dal 9 agosto. Due dei tre reggono benissimo la size vera.
  ok('tutti e tre superavano il 60% a $500 — e due su tre reggono la size VERA', (() => {
    const sopra = Object.values(VERI).every((v) => v.quota500 > MAX_QUOTA_CREDIBILE);
    const reggono = [VERI.trump, VERI.scelto].every((v) => ceilingShare(65, v.cQ) < 0.65);
    return sopra && reggono;
  })());
}

console.log('\n── 2 · SUL PIANO VERO: SI RIDUCE INVECE DI ESCLUDERE ─────────────────────────────');
{
  const planAllocation = pianoPulito();
  const RIDOTTO = ID('a');     // cQ 30 ⇒ S_max 45 share: il tetto da $65 non ci sta, $45 sì
  const SPESSO = ID('b');
  const byMarket = new Map([
    [RIDOTTO, righe(RIDOTTO, { depth: 30 })],
    [SPESSO, righe(SPESSO, { depth: 40_000 })],
  ]);
  const comuni = {
    byMarket,
    marketTokens: new Map([[RIDOTTO, 'tok-' + RIDOTTO], [SPESSO, 'tok-' + SPESSO]]),
    tapeByToken: new Map(),
    potByCond: new Map([[RIDOTTO, 900], [SPESSO, 120]]),
    maxSpreadByMarket: new Map([[RIDOTTO, 4.5], [SPESSO, 4.5]]),
    minSizeByMarket: new Map([[RIDOTTO, 20], [SPESSO, 20]]),
    budgetUsd: 130, unitUsd: 5, maxPerMarketUsd: 65, horizonFilter: false,
  };
  const senza = planAllocation({ ...comuni, filtroProfondita: false });
  const con = planAllocation({ ...comuni, filtroProfondita: true });
  const riga = (p, mid) => (p.rows || []).find((r) => r.marketId === mid) || null;
  const cand = (p, mid) => (p.candidates || []).find((c) => c.marketId === mid) || null;

  ok('senza scala il mercato sottile prende il tetto pieno ($65) e sfonda la quota', (() => {
    const r = riga(senza, RIDOTTO);
    return r && r.capital === 65 && ceilingShare(r.sizePerSideShares, 30) > MAX_QUOTA_CREDIBILE;
  })());
  ok('CON la scala il mercato NON viene escluso: entra con meno capitale', (() => {
    const r = riga(con, RIDOTTO);
    return !!r && r.capital > 0 && r.capital < 65;
  })(), JSON.stringify((con.rows || []).map((r) => [r.marketId.slice(0, 6), r.capital])));
  ok('  e la size che riceve sta ESATTAMENTE dentro la quota sicura', (() => {
    const r = riga(con, RIDOTTO);
    return r && ceilingShare(r.sizePerSideShares, 30) <= MAX_QUOTA_CREDIBILE + 1e-12;
  })());
  ok('  il candidato dichiara la riduzione, non un capitale senza spiegazione', (() => {
    const c = cand(con, RIDOTTO);
    return c && c.profonditaScala && c.profonditaScala.stato === 'ridotto'
      && c.profonditaScala.capitaleMaxUsd > 0 && c.profonditaScala.sizeMaxSicuraShares === 45
      && /SIZE RIDOTTA DALLA PROFONDITÀ/.test(c.reason || '');
  })());
  ok('  il piano elenca i ridotti e quanto capitale la profondità ha tolto loro', (() => {
    const r = (con.profonditaRidotti || []).find((x) => x.marketId === RIDOTTO);
    return Array.isArray(con.profonditaRidotti) && con.profonditaRidotti.length === 1
      && r && r.capitalePienoUsd === 65 && r.capitaleMaxUsd < 65
      && r.quotaPiena > MAX_QUOTA_CREDIBILE && r.quotaTenuta <= MAX_QUOTA_CREDIBILE;
  })());
  ok('  e NON compare fra gli esclusi: ridurre e togliere sono due esiti diversi',
    !(con.profonditaSottile || []).includes(RIDOTTO), JSON.stringify(con.profonditaSottile));
  ok('il mercato col book vero non è stato sfiorato',
    (cand(con, SPESSO) || {}).profonditaScala.stato === 'ok'
    && riga(con, SPESSO) && riga(con, SPESSO).capital === riga(senza, SPESSO).capital);
  ok('a scala SPENTA il rendiconto è vuoto e non finto',
    senza.filtroProfondita === false && (senza.profonditaRidotti || []).length === 0
    && (senza.profonditaSottile || []).length === 0);
}

console.log('\n── 3 · VINCOLO 4 · MAI IL MINIMO DEL VENUE OLTRE LA QUOTA SICURA ─────────────────');
{
  // È il vincolo che un test affrettato non vede, perché il difetto produrrebbe un piano che SEMBRA
  // sano: un mercato in più, size esattamente al minimo del venue, e un'esposizione costruita
  // sull'ottimismo che questo modulo esiste per togliere. Tre prove indipendenti.

  // (a) sulla funzione pura, su tutto lo spazio dei casi
  ok('(a) nessun livello tenuto supera la quota, su 9 profondità × 5 minimi × 3 griglie', (() => {
    for (const cQ of [0, 1, 5, 10, 14, 22, 30, 45, 5_000]) {
      for (const minS of [20, 50, 100, 200, null]) {
        for (const passo of [1, 5, 13]) {
          const livelli = [{ capital: 0, shares: 0, finanziato: false, sottoMinimoVenue: false }];
          for (let c = passo; c <= 65; c += passo) livelli.push({ capital: c, shares: c, finanziato: true, sottoMinimoVenue: minS != null && c < minS });
          const r = scalaProfondita({ livelli, depthShares: cQ, minSizeShares: minS });
          for (let i = 0; i < livelli.length; i += 1) {
            if (!r.tenuti[i] || !livelli[i].finanziato) continue;
            const q = ceilingShare(livelli[i].shares, cQ);
            if (q != null && q > MAX_QUOTA_CREDIBILE + 1e-12) return false;
          }
        }
      }
    }
    return true;
  })());

  // (b) il caso specifico: il minimo del venue NON entra quando sfonda
  ok('(b) minimo 20 contro S_max 15: si esclude, NON si piazzano 20 share', (() => {
    const livelli = [{ capital: 0, shares: 0, finanziato: false, sottoMinimoVenue: false }];
    for (let c = 5; c <= 65; c += 5) livelli.push({ capital: c, shares: c, finanziato: true, sottoMinimoVenue: c < 20 });
    const r = scalaProfondita({ livelli, depthShares: 10, minSizeShares: 20 });
    const forzato = livelli.some((l, i) => r.tenuti[i] && l.finanziato && l.shares >= 20);
    return r.stato === 'escluso-troppo-sottile' && !forzato;
  })());

  // (c) sul piano VERO, end-to-end: nessuna riga sfonda e nessuna riga sta sotto il minimo
  ok('(c) sul piano vero: ZERO righe oltre la quota sicura e ZERO sotto il minimo del venue', (() => {
    const planAllocation = pianoPulito();
    const byMarket = new Map(), marketTokens = new Map(), potByCond = new Map();
    const maxSpreadByMarket = new Map(), minSizeByMarket = new Map(), cQdi = new Map();
    // dieci book su tutta la scala della profondità, dal deserto al pieno, con i quattro minimi veri
    const profondita = [0, 8, 12, 18, 25, 33, 44, 60, 120, 40_000];
    const minimi = [20, 20, 50, 20, 100, 20, 50, 20, 200, 20];
    profondita.forEach((d, i) => {
      const id = ID(String.fromCharCode(97 + i));
      byMarket.set(id, righe(id, { depth: d })); marketTokens.set(id, 'tok-' + id);
      potByCond.set(id, 900 - i * 10); maxSpreadByMarket.set(id, 4.5);
      minSizeByMarket.set(id, minimi[i]); cQdi.set(id, d);
    });
    const p = planAllocation({
      byMarket, marketTokens, tapeByToken: new Map(), potByCond, maxSpreadByMarket, minSizeByMarket,
      budgetUsd: 600, unitUsd: 5, maxPerMarketUsd: 65, horizonFilter: false, filtroProfondita: true,
    });
    if (!(p.rows || []).length) return false;
    for (const r of p.rows) {
      const q = ceilingShare(r.sizePerSideShares, cQdi.get(r.marketId));
      if (q != null && q > MAX_QUOTA_CREDIBILE + 1e-9) return false;
      if (typeof r.minSizeShares === 'number' && r.sizePerSideShares < r.minSizeShares) return false;
    }
    return true;
  })());

  // (d) per ASSENZA nel sorgente: nessun ramo rimette dentro un livello
  ok('(d) il modulo non ha nessun ramo che riammetta un livello dopo averlo tolto', (() => {
    const src = fs.readFileSync(path.join(REPO, 'lib', 'rewards', 'profondita-minima.js'), 'utf8');
    const da = src.indexOf('function scalaProfondita');
    const corpo = src.slice(da, src.indexOf('\n}\n', da));   // SOLO il corpo, non il selfcheck che segue
    // `tenuti` si costruisce UNA volta con un `.map` e non viene mai riassegnato per indice
    return da > 0 && /const tenuti = livelli\.map\(/.test(corpo) && !/tenuti\[[^\]]+\]\s*=(?!=)/.test(corpo);
  })());
}

console.log('\n── 4 · «NON LO SO» NON TOCCA NIENTE ──────────────────────────────────────────────');
{
  const planAllocation = pianoPulito();
  const IGNOTO = ID('c'), SPESSO = ID('d');
  const senzaProf = righe(IGNOTO, { depth: 1000 }).map((r) => ({ ...r, bidDepthInBand: null, askDepthInBand: null }));
  const p = planAllocation({
    byMarket: new Map([[IGNOTO, senzaProf], [SPESSO, righe(SPESSO, { depth: 40_000 })]]),
    marketTokens: new Map([[IGNOTO, 'tok-' + IGNOTO], [SPESSO, 'tok-' + SPESSO]]),
    tapeByToken: new Map(), potByCond: new Map([[IGNOTO, 300], [SPESSO, 120]]),
    maxSpreadByMarket: new Map([[IGNOTO, 4.5], [SPESSO, 4.5]]),
    budgetUsd: 130, unitUsd: 5, maxPerMarketUsd: 65, horizonFilter: false, filtroProfondita: true,
  });
  const c = (p.candidates || []).find((x) => x.marketId === IGNOTO);
  ok('profondità non misurata ⇒ né ridotto né escluso',
    c && c.profonditaScala && c.profonditaScala.stato === 'ignota'
    && !(p.profonditaSottile || []).includes(IGNOTO)
    && !(p.profonditaRidotti || []).some((r) => r.marketId === IGNOTO));
  ok('  e riceve lo stesso capitale che riceverebbe a scala spenta', (() => {
    const spento = pianoPulito()({
      byMarket: new Map([[IGNOTO, senzaProf], [SPESSO, righe(SPESSO, { depth: 40_000 })]]),
      marketTokens: new Map([[IGNOTO, 'tok-' + IGNOTO], [SPESSO, 'tok-' + SPESSO]]),
      tapeByToken: new Map(), potByCond: new Map([[IGNOTO, 300], [SPESSO, 120]]),
      maxSpreadByMarket: new Map([[IGNOTO, 4.5], [SPESSO, 4.5]]),
      budgetUsd: 130, unitUsd: 5, maxPerMarketUsd: 65, horizonFilter: false, filtroProfondita: false,
    });
    const a = (p.rows || []).find((r) => r.marketId === IGNOTO);
    const b = (spento.rows || []).find((r) => r.marketId === IGNOTO);
    return (a ? a.capital : null) === (b ? b.capital : null);
  })());
}

console.log('\n── 5 · LA PROFONDITÀ NON RUBA LA DIAGNOSI AL MINIMO DEL VENUE ────────────────────');
{
  // Trovato dalla misura sul board vero e non ipotizzato: la prima stesura escludeva anche i mercati
  // che nessun taglio aveva toccato, prendendosi la diagnosi di 28 mercati che il minimo del venue
  // teneva fuori da sempre — e togliendoli PRIMA del knapsack invece di lasciarli scorare zero.
  const planAllocation = pianoPulito();
  const CARO = ID('e');   // book profondissimo, ma minimo 200 share contro un tetto da $65
  const p = planAllocation({
    byMarket: new Map([[CARO, righe(CARO, { depth: 40_000 })]]),
    marketTokens: new Map([[CARO, 'tok-' + CARO]]), tapeByToken: new Map(),
    potByCond: new Map([[CARO, 900]]), maxSpreadByMarket: new Map([[CARO, 4.5]]),
    minSizeByMarket: new Map([[CARO, 200]]),
    budgetUsd: 130, unitUsd: 5, maxPerMarketUsd: 65, horizonFilter: false, filtroProfondita: true,
  });
  const c = (p.candidates || []).find((x) => x.marketId === CARO);
  ok('book profondo + minimo irraggiungibile ⇒ la scala risponde `ok` e non lo esclude',
    c && c.profonditaScala.stato === 'ok' && !(p.profonditaSottile || []).includes(CARO));
  ok('  e il motivo resta `min-size`, che è chi lo misura davvero',
    c && c.reasonCode === 'min-size', c ? String(c.reasonCode) : 'assente');
}

console.log('\n── 6 · I CONSUMATORI LEGGONO GLI STESSI CAMPI ────────────────────────────────────');
{
  const planAllocation = pianoPulito();
  const A = ID('a'), B = ID('b');
  const p = planAllocation({
    byMarket: new Map([[A, righe(A, { depth: 30 })], [B, righe(B, { depth: 40_000 })]]),
    marketTokens: new Map([[A, 'tok-' + A], [B, 'tok-' + B]]), tapeByToken: new Map(),
    potByCond: new Map([[A, 900], [B, 120]]), maxSpreadByMarket: new Map([[A, 4.5], [B, 4.5]]),
    minSizeByMarket: new Map([[A, 20], [B, 20]]),
    budgetUsd: 130, unitUsd: 5, maxPerMarketUsd: 65, horizonFilter: false, filtroProfondita: true,
  });
  ok('il piano dichiara le due cause di esclusione a parte, e la loro unione',
    Array.isArray(p.profonditaTroppoSottile) && Array.isArray(p.profonditaSottoMinimo)
    && p.profonditaTroppoSottile.length + p.profonditaSottoMinimo.length === (p.profonditaSottile || []).length);
  ok('la soglia della scala è quella dell\'attenuazione, pubblicata sul piano',
    p.profonditaSoglia === DEFAULTS.maxCredibleShare && p.profonditaSoglia === MAX_QUOTA_CREDIBILE);

  // il riassunto `selezione` che agent41 legge
  const src41 = fs.readFileSync(path.join(REPO, 'agents', 'agent41-realloc-scheduler.js'), 'utf8');
  const campi = ['profonditaRidotti', 'profonditaRidottiCapitaleTagliatoUsd', 'profonditaTroppoSottili', 'profonditaSottoMinimo'];
  ok('agent41 legge TUTTI i campi nuovi del rendiconto, non solo gli esclusi',
    campi.every((k) => src41.includes('s.' + k)), campi.filter((k) => !src41.includes('s.' + k)).join(','));
  ok('  e il rendiconto parla di SCALA, non più solo di cancello',
    /scala profondità/.test(src41) && /size RIDOTTA/.test(src41));
  ok('  la funzione è chiamata dai DUE percorsi che calcolano un piano',
    (src41.match(/annunciaScalaProfondita\(/g) || []).length === 3);   // 1 definizione + 2 chiamate
}

console.log('\n── 7 · NESSUN ALTRO PRESIDIO È STATO TOCCATO ─────────────────────────────────────');
{
  const src = fs.readFileSync(path.join(REPO, 'lib', 'rewards', 'allocator.js'), 'utf8');
  ok('`useCredibleShareCap` è ancora acceso di difetto — l\'attenuazione resta', /useCredibleShareCap = true/.test(src));
  ok('`usaProfonditaVerificata` è ancora acceso di difetto', /usaProfonditaVerificata = true/.test(src));
  ok('il filtro orizzonte è ancora SPENTO di difetto (lo accende chi piazza)', /horizonFilter = false/.test(src));
  ok('la scala è ancora ACCESA di difetto', /filtroProfondita = true/.test(src));
  ok('la scala NON tocca `allocateBudget` — i backtest restano invariati numero per numero',
    !/allocateBudget\([^)]*filtroProfondita/s.test(src) && !/allocateBudget\([^)]*scalaProfondita/s.test(src));
  ok('il tetto per mercato NON è ridichiarato né importato dal modulo della profondità', (() => {
    // Il CODICE, senza i commenti: nominare il tetto per spiegare perché non lo si dichiara è
    // esattamente ciò che l'intestazione deve fare, e non è una seconda copia della costante.
    const modProf = fs.readFileSync(path.join(REPO, 'lib', 'rewards', 'profondita-minima.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    return !/MARKET_CAP/.test(modProf) && !/concentration/.test(modProf) && !/=\s*65\b/.test(modProf);
  })());
  ok('nessun modulo di lib/maker nomina la scala: il piazzamento non è sfiorato', (() => {
    const dir = path.join(REPO, 'lib', 'maker');
    return !fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
      .some((f) => /filtroProfondita|profondita-minima|scalaProfondita/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  })());
}

console.log('\nscala-profondita: ' + n + ' assertions passed\n');

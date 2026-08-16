#!/usr/bin/env node
'use strict';
// scripts/ricerca/efficienti-btc.js — I MERCATI «BITCOIN UP OR DOWN» DEI 4 EFFICIENTI, MISURATI.
//
//   node scripts/ricerca/efficienti-btc.js               misura e scrive il referto
//   node scripts/ricerca/efficienti-btc.js --sonde 8     quante fotografie del book dal vivo (45 s)
//   node scripts/ricerca/efficienti-btc.js --ore 36      finestra dei trade da scaricare
//
// Sei domande dell'operatore (A-F). SOLA LETTURA: nessun ordine, nessuna firma, nessuna transazione.
// Passa da `screening-lib.js` (la corsia di ricerca isolata) e da `lib/banda-premiante.js`, che è puro
// — zero `require`, verificato — ed è la SSOT del raggio di banda (§5-bis p.155: `v = max_spread`,
// NON `max_spread/2`). Ricalcolare qui il raggio sarebbe il reperto D1 sul parametro che decide se un
// ordine matura.
//
// ═══ ⚠ LA SCOPERTA CHE RIBALTA LA DOMANDA A ══════════════════════════════════════════════════════
// «Montepremi giornaliero e rapporto premio/liquidità» presuppone che questi mercati paghino un
// premio di liquidità. **NON LO PAGANO.** Sul CLOB, `GET /markets/<conditionId>` restituisce per ogni
// «Bitcoin Up or Down»:
//
//     rewards: { rates: null, min_size: 50, max_spread: 4.5 }
//
// `rates: null` — contro `rates: [{ rewards_daily_rate: 400 }]` su un mercato premiante vero usato
// come controllo. `min_size` e `max_spread` sono popolati e fanno sembrare il mercato premiante, ma
// **senza un `rate` non c'è nessun montepremi da dividere**: la banda è configurata e il piatto è
// vuoto. Riscontro indipendente: paginando `/sampling-markets` (l'elenco dei mercati premianti del
// CLOB) si leggono **12.093 mercati e ZERO «Up or Down»**. E Gamma concorda: `clobRewards` è
// `undefined` su questi mercati, mentre agent24 tiene solo quelli con `clobRewards[0].rewardsDailyRate > 0`
// (`agent24:224`) — è per questo che il board del bot non ne contiene nemmeno uno.
//
// Quindi la risposta ad A non è un numero piccolo: è **zero**, e il rapporto premio/liquidità è zero
// per costruzione su tutti. La liquidità in banda si misura lo stesso — serve a dire quanto è spesso
// il libro su cui questi wallet stanno lavorando — ma il numeratore non esiste.
//
// ═══ ⚠ COSA NON È MISURABILE, E PERCHÉ ═══════════════════════════════════════════════════════════
//   · **La liquidità in banda a metà vita dei 228 mercati STORICI**: il book di un mercato passato non
//     è servito da nessun endpoint pubblico (`/book` è solo lo stato di adesso, `prices-history` dà
//     prezzi e non profondità). Si misura allora sui mercati **della stessa famiglia vivi adesso**,
//     campionati quando sono a metà vita, e lo si dichiara: è la stessa famiglia, non gli stessi 228.
//   · **«primo ordine» e «ultimo ordine»**: il venue non espone gli ordini altrui, né il loro
//     piazzamento né la loro cancellazione. Si vedono solo i FILL. Nella linea del tempo di C le due
//     righe sono quindi **primo fill** e **ultimo fill**, ed è una cosa diversa da un ordine: fra il
//     piazzamento e il primo fill può passare tutta la vita del mercato.

const fs = require('fs');
const path = require('path');
const { apiGet, inParallelo, scrivi, leggi, mediana, contatore, attesa } = require('./screening-lib');
const BANDA = require('../../lib/banda-premiante');

const argomenti = process.argv.slice(2);
const arg = (n, d) => { const i = argomenti.indexOf(n); return i >= 0 ? Number(argomenti[i + 1]) : d; };
const ORE = arg('--ore', 36);
const SONDE = arg('--sonde', 8);
const PAUSA_SONDA_MS = 45_000;
const PER_PAGINA = 500;
const PAGINE_MAX = 12;

const CLOB = 'clob.polymarket.com';
const FILE_USCITA = 'efficienti-btc.json';
const RE_BTC = /Bitcoin Up or Down/i;
const RE_FAMIGLIA = /(Bitcoin|Ethereum) Up or Down/i;

// ── LETTORI CHE NON FANNO DIVENTARE «NON SO» UNO ZERO ───────────────────────────────────────────
function numero(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '') { const v = Number(x); return Number.isFinite(v) ? v : null; }
  return null;
}
const normId = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
const q = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};

// ── 1 · L'UNIVERSO ──────────────────────────────────────────────────────────────────────────────
function universo() {
  const storico = leggi('osservatorio.json');
  const g = storico.giorni[storico.giorni.length - 1];
  // ⚠ LA SCADENZA VIENE DA GAMMA, NON DAL CLOB, e non e' un dettaglio: il CLOB **tronca
  // `end_date_iso` a mezzanotte UTC** (§4.7). Su un mercato intraday come questi la prima stesura
  // leggeva «scadenza 2026-08-15T00:00:00Z» per un mercato che finiva alle 13:45, e la linea del
  // tempo di C dava fill a +86.001 s su una vita dichiarata di 37.325 s — cioe' fill DOPO la
  // scadenza. L'osservatorio porta gia' l'`endDate` di Gamma, quindi la fonte giusta e' li' e non
  // costa una chiamata in piu'.
  const eff = (g.walletEfficienti || []).map(normId);
  const effSet = new Set(eff);
  const btc = g.mercati.filter((m) => RE_BTC.test(m.titolo || '') && (m.wallet || []).some((w) => effSet.has(normId(w))));
  return { giorno: g.giorno, efficienti: eff, btc, tuttiIMercati: g.mercati, walletOsservati: g.walletOsservati };
}

// ── 2 · LA CONFIGURAZIONE PREMIANTE VERA, DAL CLOB ──────────────────────────────────────────────
/**
 * `GET /markets/<conditionId>` del CLOB. È la fonte che decide, e non Gamma: `rewards.rates` è il
 * campo che dice se un montepremi ESISTE. `min_size`/`max_spread` senza `rates` sono una banda
 * configurata su un piatto vuoto — la trappola di questa misura.
 *
 * `accepting_order_timestamp` è l'APERTURA vera: l'istante da cui il venue accetta ordini. Serve a C.
 */
async function configurazioneClob(conditionIds) {
  const fuori = new Map();
  await inParallelo(conditionIds, 6, async (cid) => {
    const r = await apiGet(`/markets/${cid}`, 0, CLOB);
    if (!r.ok || !r.dati || !r.dati.condition_id) return null;
    const m = r.dati;
    const rate = (m.rewards && Array.isArray(m.rewards.rates) && m.rewards.rates[0])
      ? numero(m.rewards.rates[0].rewards_daily_rate) : null;
    fuori.set(normId(cid), {
      question: m.question || null,
      apertura: m.accepting_order_timestamp ? Date.parse(m.accepting_order_timestamp) : null,
      scadenza: m.end_date_iso ? Date.parse(m.end_date_iso) : null,
      // ⚠ `rates: null` ⇒ NESSUN montepremi. Non è «zero dollari al giorno di premio»: è che il
      // mercato non è nel programma. Si tiene la distinzione perché un rate 0 esplicito e un rate
      // assente sono due stati diversi del venue.
      rateDichiarato: rate,
      ratesPresenti: !!(m.rewards && Array.isArray(m.rewards.rates) && m.rewards.rates.length),
      minSize: numero(m.rewards && m.rewards.min_size),
      maxSpread: numero(m.rewards && m.rewards.max_spread),
      minOrderSize: numero(m.minimum_order_size),
      tick: numero(m.minimum_tick_size),
      chiuso: m.closed === true,
      tokens: Array.isArray(m.tokens) ? m.tokens.map((t) => String(t.token_id)) : [],
    });
    return null;
  });
  return fuori;
}

// ── 3 · I FILL DEI QUATTRO ──────────────────────────────────────────────────────────────────────
async function fillDi(wallet, daTs) {
  const righe = new Map();
  let piuVecchio = Infinity;
  for (let p = 0; p < PAGINE_MAX; p += 1) {
    const r = await apiGet(`/trades?user=${wallet}&takerOnly=false&limit=${PER_PAGINA}&offset=${p * PER_PAGINA}`);
    if (!r.ok || !Array.isArray(r.dati)) return { ok: false, errore: r.errore || 'non lista' };
    for (const t of r.dati) {
      righe.set([t.conditionId, t.asset, t.timestamp, t.price, t.size, t.side].join('|'), t);
      const ts = numero(t.timestamp);
      if (ts !== null && ts < piuVecchio) piuVecchio = ts;
    }
    if (r.dati.length < PER_PAGINA) return { ok: true, righe: [...righe.values()], coperta: true };
    if (piuVecchio <= daTs) return { ok: true, righe: [...righe.values()], coperta: true };
  }
  return { ok: true, righe: [...righe.values()], coperta: false };
}

// ── 4 · LA LIQUIDITÀ IN BANDA, DAL VIVO ─────────────────────────────────────────────────────────
/**
 * Somma il nozionale (prezzo × size) di TUTTI gli ordini altrui che stanno dentro la banda premiante,
 * su entrambi i lati. Il raggio viene da `BANDA.raggioBandaPrezzo(max_spread)` — la SSOT — e non da
 * un `max_spread/2` ricalcolato qui.
 *
 * ⚠ Il mid si prende da best bid/ask. Book a un lato solo, o vuoto ⇒ `null`, mai 0: un libro che non
 * si riesce a valutare non è un libro sottile.
 */
async function liquiditaInBanda(tokenId, maxSpreadCents) {
  const r = await apiGet(`/book?token_id=${tokenId}`, 0, CLOB);
  if (!r.ok || !r.dati) return null;
  const bids = (r.dati.bids || []).map((x) => ({ p: numero(x.price), s: numero(x.size) })).filter((x) => x.p !== null && x.s !== null);
  const asks = (r.dati.asks || []).map((x) => ({ p: numero(x.price), s: numero(x.size) })).filter((x) => x.p !== null && x.s !== null);
  if (!bids.length || !asks.length) return null;
  const bestBid = Math.max(...bids.map((x) => x.p));
  const bestAsk = Math.min(...asks.map((x) => x.p));
  const mid = (bestBid + bestAsk) / 2;
  const raggio = BANDA.raggioBandaPrezzo(maxSpreadCents);
  if (raggio === null) return null;
  const dentro = (x) => Math.abs(x.p - mid) <= raggio + 1e-12;
  const somma = (xs) => xs.filter(dentro).reduce((a, x) => a + x.p * x.s, 0);
  return {
    mid, bestBid, bestAsk, raggioPrezzo: raggio,
    usdBid: somma(bids), usdAsk: somma(asks), usdTotale: somma(bids) + somma(asks),
    livelliInBanda: bids.filter(dentro).length + asks.filter(dentro).length,
  };
}

/** Le fotografie del book sui mercati della famiglia VIVI, tenendo solo quelli vicini a metà vita. */
async function sondaggioDalVivo(quante) {
  const campioni = [];
  for (let giro = 0; giro < quante; giro += 1) {
    const iso = new Date().toISOString();
    const r = await apiGet(`/markets?closed=false&limit=100&end_date_min=${encodeURIComponent(iso)}&order=endDate&ascending=true`,
      0, 'gamma-api.polymarket.com');
    const vivi = (r.ok && Array.isArray(r.dati) ? r.dati : []).filter((m) => RE_FAMIGLIA.test(m.question || ''));
    for (const m of vivi) {
      const fine = Date.parse(m.endDate);
      if (!Number.isFinite(fine)) continue;
      const cid = normId(m.conditionId);
      const c = await apiGet(`/markets/${cid}`, 0, CLOB);
      if (!c.ok || !c.dati) continue;
      const apertura = c.dati.accepting_order_timestamp ? Date.parse(c.dati.accepting_order_timestamp) : null;
      // La «vita» che conta è la FINESTRA dichiarata nel titolo (5 o 15 minuti), non le ~24 h che
      // passano dalla creazione: il mercato è listato il giorno prima e vive davvero nella finestra.
      const durata = durataDalTitolo(m.question);
      if (durata === null) continue;
      const inizioFinestra = fine - durata;
      const frazione = (Date.now() - inizioFinestra) / durata;
      const maxSpread = numero(c.dati.rewards && c.dati.rewards.max_spread);
      const token = Array.isArray(c.dati.tokens) && c.dati.tokens[0] ? String(c.dati.tokens[0].token_id) : null;
      if (!token || maxSpread === null) continue;
      const liq = await liquiditaInBanda(token, maxSpread);
      campioni.push({
        conditionId: cid, question: m.question, durataMin: durata / 60000,
        frazioneVita: frazione, apertura, inizioFinestra, fine,
        rateDichiarato: (c.dati.rewards && Array.isArray(c.dati.rewards.rates) && c.dati.rewards.rates[0])
          ? numero(c.dati.rewards.rates[0].rewards_daily_rate) : null,
        maxSpread, liquidita: liq,
      });
    }
    if (giro < quante - 1) await attesa(PAUSA_SONDA_MS);
  }
  return campioni;
}

/** «12:00PM-12:15PM» ⇒ 900_000 ms. `null` se il titolo non lo dice: non si indovina una durata. */
function durataDalTitolo(titolo) {
  const m = String(titolo || '').match(/(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)/i);
  if (!m) return null;
  const min = (h, mi, ap) => ((Number(h) % 12) + (/pm/i.test(ap) ? 12 : 0)) * 60 + Number(mi);
  let d = min(m[4], m[5], m[6]) - min(m[1], m[2], m[3]);
  if (d <= 0) d += 24 * 60;
  return d * 60_000;
}

// ── PRINCIPALE ──────────────────────────────────────────────────────────────────────────────────
async function principale() {
  const adesso = Date.now();
  const U = universo();
  const daTs = Math.floor(adesso / 1000) - ORE * 3600;
  console.log(`efficienti su «Bitcoin Up or Down» — giorno ${U.giorno}`);
  console.log(`  ${U.efficienti.length} wallet · ${U.btc.length} mercati BTC toccati da almeno uno di loro\n`);

  // A · la configurazione vera
  console.log(`  [1/4] configurazione CLOB di ${U.btc.length} mercati…`);
  const cfg = await configurazioneClob(U.btc.map((m) => m.conditionId));
  // La scadenza VERA (Gamma) sovrascrive quella troncata del CLOB, mercato per mercato. Se Gamma non
  // l'aveva, resta `null` — mai il valore troncato, che sarebbe peggio di un'assenza.
  for (const m of U.btc) {
    const c = cfg.get(normId(m.conditionId));
    if (!c) continue;
    const t = m.endDate ? Date.parse(m.endDate) : NaN;
    c.scadenzaClobTroncata = c.scadenza;
    c.scadenza = Number.isFinite(t) ? t : null;
  }
  const conRate = [...cfg.values()].filter((c) => c.rateDichiarato !== null && c.rateDichiarato > 0);
  const senzaRates = [...cfg.values()].filter((c) => !c.ratesPresenti);
  console.log(`        ${cfg.size} letti · ${conRate.length} con montepremi · ${senzaRates.length} con \`rates: null\``);

  // B/C/D/E · i fill dei quattro
  console.log(`  [2/4] fill dei ${U.efficienti.length} efficienti (${ORE} h)…`);
  const perWallet = new Map();
  for (const w of U.efficienti) {
    const r = await fillDi(w, daTs);
    perWallet.set(w, r);
    console.log(`        ${w.slice(0, 12)}… ${r.ok ? `${r.righe.length} fill` : 'NON LETTO: ' + r.errore}${r.ok && !r.coperta ? ' ⚠ TRONCATO' : ''}`);
  }

  const btcSet = new Set(U.btc.map((m) => normId(m.conditionId)));
  /** fill dei 4 sui soli mercati BTC, normalizzati. */
  const fill = [];
  for (const [w, r] of perWallet) {
    if (!r.ok) continue;
    for (const t of r.righe) {
      const cid = normId(t.conditionId);
      if (!btcSet.has(cid)) continue;
      const size = numero(t.size), prezzo = numero(t.price), ts = numero(t.timestamp);
      if (size === null || prezzo === null || ts === null) continue;
      fill.push({ wallet: w, cid, asset: String(t.asset), side: String(t.side).toUpperCase(),
        size, prezzo, ts, usd: size * prezzo, outcome: t.outcome ?? null });
    }
  }
  console.log(`        ${fill.length} fill sui mercati BTC`);

  // C · sonda dal vivo per la liquidità in banda
  console.log(`  [3/4] ${SONDE} fotografie del book dal vivo (≈${Math.round(SONDE * PAUSA_SONDA_MS / 60000)} min)…`);
  const campioni = await sondaggioDalVivo(SONDE);
  console.log(`        ${campioni.length} osservazioni su mercati vivi della stessa famiglia`);

  console.log('  [4/4] calcolo…\n');

  // ══ A ═════════════════════════════════════════════════════════════════════════════════════════
  const aMetaVita = campioni.filter((c) => c.liquidita && c.frazioneVita >= 0.35 && c.frazioneVita <= 0.65);
  const liqMeta = aMetaVita.map((c) => c.liquidita.usdTotale);
  const A = {
    montepremiGiornaliero: {
      mercatiLetti: cfg.size,
      conMontepremi: conRate.length,
      conRatesNull: senzaRates.length,
      // Il rapporto premio/liquidità: il numeratore non esiste, quindi il rapporto è 0 su tutti.
      // Si scrive esplicitamente invece di lasciare un campo vuoto che si legge come «non misurato».
      rapportoPremioLiquidita: conRate.length === 0 ? 0 : null,
      rateMassimo: conRate.length ? Math.max(...conRate.map((c) => c.rateDichiarato)) : null,
      // ⚠ SOGLIA DERIVATA, non inventata: agent24 scarta i mercati con `rate <= 0.01` (agent24:229),
      // quindi si usa la stessa per dire cosa conta come montepremi VERO.
      conMontepremiSopraSogliaAgent24: conRate.filter((c) => c.rateDichiarato > 0.01).length,
      nota: conRate.filter((c) => c.rateDichiarato > 0.01).length === 0
        ? 'nessun mercato paga un premio di liquidita utilizzabile: 226 hanno `rewards.rates: null` e i 2 con un rate dichiarano $0,001/giorno, sotto la soglia con cui agent24 stesso li scarta. Il rapporto premio/liquidita e ZERO in pratica.'
        : 'attenzione: esistono mercati con un montepremi sopra soglia, la nota va riscritta',
    },
    liquiditaInBandaMetaVita: {
      fonte: 'mercati VIVI della stessa famiglia (i 228 storici non hanno un book interrogabile a posteriori)',
      osservazioni: aMetaVita.length,
      mediana: mediana(liqMeta),
      min: liqMeta.length ? Math.min(...liqMeta) : null,
      max: liqMeta.length ? Math.max(...liqMeta) : null,
      q25: q(liqMeta, 0.25), q75: q(liqMeta, 0.75),
      dettaglio: aMetaVita.map((c) => ({ question: c.question, frazioneVita: c.frazioneVita,
        usdTotale: c.liquidita.usdTotale, usdBid: c.liquidita.usdBid, usdAsk: c.liquidita.usdAsk,
        mid: c.liquidita.mid, livelli: c.liquidita.livelliInBanda })),
    },
    tutteLeOsservazioni: campioni.length,
  };

  // ══ B · capitale impegnato per mercato, per wallet ════════════════════════════════════════════
  // Definizione dichiarata: il capitale che il wallet ha REALMENTE messo in quel mercato è la somma
  // dei BUY eseguiti (dollari usciti). Non è il nozionale a riposo — gli ordini altrui non sono
  // osservabili a posteriori (§5-bis p.144 lo dice anche dei nostri) — e chiamarlo «impegnato»
  // sarebbe piu' di quanto la fonte sostiene.
  const B = { definizione: 'somma dei BUY eseguiti per (wallet, mercato); il nozionale a riposo non e osservabile', perWallet: [] };
  for (const w of U.efficienti) {
    const perMercato = new Map();
    for (const f of fill) {
      if (f.wallet !== w) continue;
      if (f.side !== 'BUY') continue;
      perMercato.set(f.cid, (perMercato.get(f.cid) || 0) + f.usd);
    }
    const v = [...perMercato.values()];
    B.perWallet.push({
      wallet: w, mercati: perMercato.size,
      medianaUsd: mediana(v), q25: q(v, 0.25), q75: q(v, 0.75),
      min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null,
      totaleUsd: v.reduce((a, x) => a + x, 0),
    });
  }

  // ══ C · tre linee del tempo ═══════════════════════════════════════════════════════════════════
  // Si scelgono i tre mercati con PIÙ fill di un efficiente: una linea del tempo con due fill non
  // racconta niente. Si tengono solo i mercati la cui finestra è interamente dentro l'arco scaricato,
  // o mancherebbero fill e la ricostruzione sarebbe falsa senza dirlo.
  const perMercatoFill = new Map();
  for (const f of fill) {
    if (!perMercatoFill.has(f.cid)) perMercatoFill.set(f.cid, []);
    perMercatoFill.get(f.cid).push(f);
  }
  const candidati = [...perMercatoFill.entries()]
    .map(([cid, fs]) => ({ cid, fs, c: cfg.get(cid) }))
    .filter((x) => x.c && x.c.apertura !== null && x.c.scadenza !== null && Math.floor(x.c.scadenza / 1000) > daTs)
    .sort((a, b) => b.fs.length - a.fs.length)
    .slice(0, 3);

  const C = candidati.map(({ cid, fs, c }) => {
    const durata = durataDalTitolo(c.question);
    const inizioFinestra = durata !== null ? c.scadenza - durata : null;
    const sec = (ms) => Math.round((ms - c.apertura) / 1000);
    const secFin = (ms) => (inizioFinestra === null ? null : Math.round((ms - inizioFinestra) / 1000));
    const ord = fs.slice().sort((a, b) => a.ts - b.ts);
    return {
      conditionId: cid, question: c.question,
      aperturaIso: new Date(c.apertura).toISOString(),
      scadenzaIso: new Date(c.scadenza).toISOString(),
      durataFinestraMin: durata === null ? null : durata / 60000,
      vitaTotaleSec: sec(c.scadenza),
      inizioFinestraSecDaApertura: inizioFinestra === null ? null : sec(inizioFinestra),
      // ⚠ PRIMO/ULTIMO FILL, non primo/ultimo ORDINE: il venue non espone gli ordini altrui.
      primoFillSec: sec(ord[0].ts * 1000),
      ultimoFillSec: sec(ord[ord.length - 1].ts * 1000),
      eventi: ord.map((f) => ({
        secDaApertura: sec(f.ts * 1000),
        secDaInizioFinestra: secFin(f.ts * 1000),
        secAllaScadenza: Math.round((c.scadenza - f.ts * 1000) / 1000),
        wallet: f.wallet.slice(0, 12) + '…', side: f.side, size: f.size, prezzo: f.prezzo,
        usd: Math.round(f.usd * 100) / 100, outcome: f.outcome,
      })),
    };
  });

  // ══ D · a scadenza: piatti o con posizione? ═══════════════════════════════════════════════════
  // Si ricostruisce la posizione netta per (wallet, mercato, token) sommando i BUY e sottraendo i
  // SELL. ⚠ Si contano SOLO i mercati la cui vita sta dentro l'arco scaricato: su un mercato aperto
  // prima della finestra mancherebbero i primi fill, e una posizione «aperta» sarebbe un artefatto.
  const D = {
    definizione: 'a fine mercato: PIATTO (niente in mano) · COPPIA COMPLETA (Up e Down in parti uguali: paga $1, esposizione direzionale zero) · DIREZIONALE (|netUp − netDown| > 0)',
    nota: 'su un mercato binario possedere Up E Down in parti uguali NON e una posizione aperta in senso economico: alla risoluzione la coppia vale $1 comunque. La prima stesura contava il netto PER TOKEN e dichiarava 99,3% di posizioni aperte — ma erano coppie, cioe l opposto di un rischio direzionale.',
    perWallet: [], complessivo: null,
  };
  const TOLLERANZA = 1e-6;
  let piattiTot = 0, coppiaTot = 0, direzTot = 0, valutatiTot = 0;
  for (const w of U.efficienti) {
    const perMercato = new Map();
    for (const f of fill) {
      if (f.wallet !== w) continue;
      const c = cfg.get(f.cid);
      // ⚠ SOLO i mercati la cui vita sta dentro l'arco scaricato: su un mercato aperto prima
      // mancherebbero i primi fill e una «posizione» sarebbe un artefatto della finestra.
      if (!c || c.scadenza === null || Math.floor(c.scadenza / 1000) <= daTs) continue;
      if (!perMercato.has(f.cid)) perMercato.set(f.cid, new Map());
      const perToken = perMercato.get(f.cid);
      perToken.set(f.asset, (perToken.get(f.asset) || 0) + (f.side === 'BUY' ? f.size : -f.size));
    }
    let piatti = 0, coppia = 0, direz = 0;
    for (const [, perToken] of perMercato) {
      const netti = [...perToken.values()].map((x) => (Math.abs(x) < TOLLERANZA ? 0 : x));
      const positivi = netti.filter((x) => x > 0);
      const totale = netti.reduce((a, x) => a + Math.abs(x), 0);
      if (totale < TOLLERANZA) { piatti += 1; continue; }
      // Con due token: la parte APPAIATA e' il minimo dei due netti positivi, il residuo e' direzionale.
      const appaiata = positivi.length >= 2 ? Math.min(...positivi) : 0;
      const residuo = netti.reduce((a, x) => a + x, 0) - 2 * appaiata;
      if (Math.abs(residuo) < TOLLERANZA && appaiata > 0) coppia += 1;
      else direz += 1;
    }
    const valutati = perMercato.size;
    piattiTot += piatti; coppiaTot += coppia; direzTot += direz; valutatiTot += valutati;
    D.perWallet.push({ wallet: w, mercatiValutati: valutati, piatti, coppiaCompleta: coppia, direzionale: direz,
      percentualeDirezionale: valutati ? (100 * direz / valutati) : null,
      percentualeCoppia: valutati ? (100 * coppia / valutati) : null });
  }
  D.complessivo = { mercatiValutati: valutatiTot, piatti: piattiTot, coppiaCompleta: coppiaTot, direzionale: direzTot,
    percentualeDirezionale: valutatiTot ? (100 * direzTot / valutatiTot) : null,
    percentualeCoppia: valutatiTot ? (100 * coppiaTot / valutatiTot) : null };

  // ══ E · distribuzione dei fill per ora UTC ════════════════════════════════════════════════════
  const perOra = new Array(24).fill(0);
  for (const f of fill) perOra[new Date(f.ts * 1000).getUTCHours()] += 1;
  const E = { totale: fill.length, perOra,
    perOraPerWallet: U.efficienti.map((w) => {
      const a = new Array(24).fill(0);
      for (const f of fill) if (f.wallet === w) a[new Date(f.ts * 1000).getUTCHours()] += 1;
      return { wallet: w, perOra: a, totale: a.reduce((x, y) => x + y, 0) };
    }) };

  // ══ F · quanti dei 65 sullo stesso mercato ════════════════════════════════════════════════════
  const nW = U.btc.map((m) => m.nWallet);
  const F = {
    definizione: `quanti dei ${U.walletOsservati} wallet osservati compaiono sullo stesso mercato BTC`,
    mercati: nW.length, mediana: mediana(nW), min: Math.min(...nW), max: Math.max(...nW),
    q25: q(nW, 0.25), q75: q(nW, 0.75),
    distribuzione: nW.reduce((acc, n) => { acc[n] = (acc[n] || 0) + 1; return acc; }, {}),
  };

  const out = { generatoIl: new Date(adesso).toISOString(), giornoOsservatorio: U.giorno,
    efficienti: U.efficienti, mercatiBtc: U.btc.length, finestraOreTrade: ORE,
    chiamate: { api: contatore.api, ritentate: contatore.ritentate, errori: contatore.errori },
    A, B, C, D, E, F };
  const f = scrivi(FILE_USCITA, out);
  stampa(out);
  console.log(`\n→ ${f}`);
  return out;
}

// ── IL REFERTO A SCHERMO ────────────────────────────────────────────────────────────────────────
function stampa(o) {
  const usd = (n) => (n === null || !Number.isFinite(n)) ? 'n/d' : '$' + n.toLocaleString('it-IT', { maximumFractionDigits: 0 });
  const usd2 = (n) => (n === null || !Number.isFinite(n)) ? 'n/d' : '$' + n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  console.log('═'.repeat(96));
  console.log(`A · MONTEPREMI E LIQUIDITÀ IN BANDA — ${o.mercatiBtc} mercati BTC toccati dai 4`);
  console.log('═'.repeat(96));
  const a = o.A.montepremiGiornaliero;
  console.log(`  mercati letti dal CLOB     : ${a.mercatiLetti}`);
  console.log(`  CON montepremi             : ${a.conMontepremi}`);
  console.log(`  con \`rewards.rates: null\`  : ${a.conRatesNull}   ⇐ nessun premio di liquidità`);
  console.log(`  di cui sopra la soglia di agent24 (>$0,01/g) : ${a.conMontepremiSopraSogliaAgent24}   (rate massimo osservato: $${a.rateMassimo}/g)`);
  console.log(`  RAPPORTO premio/liquidità  : ${a.conMontepremiSopraSogliaAgent24 === 0 ? 'ZERO in pratica — il numeratore non esiste' : 'da riscrivere'}`);
  const L = o.A.liquiditaInBandaMetaVita;
  console.log(`\n  liquidità in banda a metà vita (${L.osservazioni} osservazioni, mercati VIVI della stessa famiglia):`);
  console.log(`    mediana ${usd(L.mediana)} · range ${usd(L.min)} – ${usd(L.max)} · q25 ${usd(L.q25)} · q75 ${usd(L.q75)}`);
  for (const d of L.dettaglio.slice(0, 6)) {
    console.log(`      ${(d.frazioneVita * 100).toFixed(0).padStart(3)}% di vita · ${usd(d.usdTotale).padStart(9)} (bid ${usd(d.usdBid)} / ask ${usd(d.usdAsk)}) · ${d.livelli} livelli · ${String(d.question).slice(0, 40)}`);
  }

  console.log('\n' + '═'.repeat(96));
  console.log('B · CAPITALE IMPEGNATO PER MERCATO (somma dei BUY eseguiti)');
  console.log('═'.repeat(96));
  console.log('  wallet          mercati   mediana      q25        q75        min       max      totale');
  for (const b of o.B.perWallet) {
    console.log(`  ${b.wallet.slice(0, 12)}…  ${String(b.mercati).padStart(5)}  ${usd2(b.medianaUsd).padStart(10)} ${usd2(b.q25).padStart(10)} ${usd2(b.q75).padStart(10)} ${usd2(b.min).padStart(9)} ${usd2(b.max).padStart(9)} ${usd(b.totaleUsd).padStart(9)}`);
  }

  console.log('\n' + '═'.repeat(96));
  console.log('C · LINEA DEL TEMPO — secondi dall\'apertura (accepting_order_timestamp del CLOB)');
  console.log('═'.repeat(96));
  console.log('  ⚠ «primo/ultimo ORDINE» non è osservabile: il venue non espone gli ordini altrui.');
  console.log('    Qui sono PRIMO e ULTIMO FILL, che è una cosa diversa.\n');
  for (const c of o.C) {
    console.log(`  ${c.question}`);
    console.log(`    apertura   0 s  (${c.aperturaIso})`);
    if (c.inizioFinestraSecDaApertura !== null) {
      console.log(`    la finestra di ${c.durataFinestraMin} min comincia a  ${c.inizioFinestraSecDaApertura.toLocaleString('it-IT')} s`);
    }
    console.log(`    primo fill ${String(c.primoFillSec).padStart(9)} s`);
    for (const e of c.eventi) {
      console.log(`      ${String(e.secDaApertura).padStart(9)} s  ${e.side.padEnd(4)} ${String(e.size).padStart(8)} @ ${String(e.prezzo).padEnd(6)} = ${usd2(e.usd).padStart(9)}  ${e.outcome || ''}  ${C_finestra(e)}`);
    }
    console.log(`    ultimo fill ${String(c.ultimoFillSec).padStart(8)} s`);
    console.log(`    scadenza   ${String(c.vitaTotaleSec).padStart(9)} s  (${c.scadenzaIso})\n`);
  }

  console.log('═'.repeat(96));
  console.log('D · A SCADENZA: PIATTI, COPPIA COMPLETA, O DIREZIONALI?');
  console.log('═'.repeat(96));
  console.log('  ⚠ possedere Up E Down in parti uguali NON e\' esposizione: la coppia paga $1 comunque.\n');
  for (const d of o.D.perWallet) {
    if (!d.mercatiValutati) { console.log(`  ${d.wallet.slice(0, 12)}…  nessun mercato BTC`); continue; }
    console.log(`  ${d.wallet.slice(0, 12)}…  valutati ${String(d.mercatiValutati).padStart(4)} · piatti ${String(d.piatti).padStart(4)} · coppia completa ${String(d.coppiaCompleta).padStart(4)} (${d.percentualeCoppia.toFixed(1)}%) · DIREZIONALI ${String(d.direzionale).padStart(4)} (${d.percentualeDirezionale.toFixed(1)}%)`);
  }
  const dc = o.D.complessivo;
  console.log(`  COMPLESSIVO: ${dc.mercatiValutati} valutati · piatti ${dc.piatti} · coppia ${dc.coppiaCompleta} (${dc.percentualeCoppia === null ? 'n/d' : dc.percentualeCoppia.toFixed(1) + '%'}) · direzionali ${dc.direzionale} (${dc.percentualeDirezionale === null ? 'n/d' : dc.percentualeDirezionale.toFixed(1) + '%'})`);

  console.log('\n' + '═'.repeat(96));
  console.log(`E · FILL PER ORA UTC (${o.E.totale} fill)`);
  console.log('═'.repeat(96));
  const max = Math.max(...o.E.perOra, 1);
  for (let h = 0; h < 24; h += 1) {
    const n = o.E.perOra[h];
    console.log(`  ${String(h).padStart(2, '0')}:00  ${String(n).padStart(5)}  ${'█'.repeat(Math.round(40 * n / max))}`);
  }

  console.log('\n' + '═'.repeat(96));
  console.log('F · QUANTI DEI 65 SULLO STESSO MERCATO');
  console.log('═'.repeat(96));
  console.log(`  su ${o.F.mercati} mercati: mediana ${o.F.mediana} · range ${o.F.min}–${o.F.max} · q25 ${o.F.q25} · q75 ${o.F.q75}`);
  const dist = Object.entries(o.F.distribuzione).sort((a, b) => Number(a[0]) - Number(b[0]));
  console.log('  distribuzione: ' + dist.map(([k, v]) => `${k} wallet ⇒ ${v} mercati`).join(' · '));
}
const C_finestra = (e) => (e.secDaInizioFinestra === null ? '' : `[${e.secDaInizioFinestra >= 0 ? '+' : ''}${e.secDaInizioFinestra}s dalla finestra, ${e.secAllaScadenza}s alla scadenza]`);

principale().catch((e) => { console.error('\nGUASTO: ' + (e && e.stack || e)); process.exitCode = 1; });

#!/usr/bin/env node

// ══ IL CARICATORE DI `.env` — SOLO LA FAMIGLIA `REWARD_` (12 agosto 2026) ══════════════════════════
// Perche' esiste, perche' e' ristretto e perche' oggi carica zero: lib/safety/carica-env.js.
// In due righe: senza, `REWARD_MAX_CLOB_MARKETS` — la manopola che §5 punto 53 documenta come il modo
// di cambiare il tetto a 150 — messa in `.env` non verrebbe letta MAI, perche' questo processo non ha
// mai aperto `.env`. Con la lista di famiglie, le credenziali del file restano fuori: questo agent usa
// solo API pubbliche e non deve avere in ambiente ne' chiavi ne' RPC.
require('../lib/safety/carica-env').caricaEnv({
  radice: require('path').join(__dirname, '..'),
  consentite: [/^REWARD_/],
});

// agent24-liquidity-rewards.js — Polymarket Liquidity Reward Scanner
//
// Every 15 min:
//   1. Fetches all active Gamma markets with clobRewards[0].rewardsDailyRate > 0
//   2. For each, reads the CLOB order book.
//   3. Scores resting orders with Polymarket's exact quadratic formula:
//        S(v, s) = ((v - s) / v)^2,  v = rewardsMaxSpread (cents), s = dist from mid (cents)
//      Q_competitors = Q_min(Q_bids, Q_asks) per the two-sided formula (c=3).
//   4. Estimates LP reward share for THREE capital levels: $500, $5k, $50k.
//        Typical placement: s = v/2 (half the half-band, S=0.25) — HEADLINE estimate.
//        Range: high = s=0.1¢ (near-mid floor, S≈0.91); low = s=0.8v (outer band, S=0.04).
//        share = Q_user / (Q_user + Q_competitors)  — ESTIMATE.
//   5. Classifies 24h mid-price volatility as LOW / MEDIUM / HIGH.
//   6. Applies sanity cap (>2%/day typical gross → THIN BOOK flag) and
//      floor (<$1/day typical gross → below-floor flag) PER CAPITAL LEVEL.
//   7. Writes /root/prediction-market/data/liquidity-rewards.json.
//   8. Prints formula verification + top 5 markets + gap sample + placement comparison.
//
// No Claude API. No order placement. Read-only. Deterministic.
'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { scoreBook, estimateCapitalLevelRange } = require('../lib/rewardScore');
const { categoryFromText } = require('../lib/category');
const { risolviScadenza, scadenzaUnificata } = require('../lib/rewards/scadenza-mercato');
const { writeCombinedSnapshot } = require('../lib/rewards-normalize');
// Depth-at-touch suppression floor — shared SSOT (also used by lib/rewards-normalize and
// re-exported to TS via lib/reward-gating.ts). Configurable via REWARD_DEPTH_TOUCH_FLOOR_USD.
const { competitorDepthUsd, belowDepthFloor, depthFloorUsd } = require('../lib/reward-depth-floor');
const { raggioBandaPrezzo } = require('../lib/banda-premiante');

// ── Config ────────────────────────────────────────────────────────────────────
const SCAN_INTERVAL_MS  = 15 * 60_000;
const STARTUP_DELAY_MS  = 8_000;
// ⚠ LO SCRITTORE E IL LETTORE DEVONO ANCORARSI ALLO STESSO PUNTO (17 agosto 2026, migrazione root →
// bot). Questo e' il file che `lib/rewards-normalize` legge come `POLY_FILE`: correggere solo il
// lettore avrebbe prodotto la peggiore delle due situazioni — due percorsi per lo stesso file, che
// divergono in silenzio (il reperto D1). `DATA_DIR` e' la definizione unica di `lib/safety/store.js`.
const { DATA_DIR }      = require('../lib/safety/store');
const OUTPUT_FILE       = path.join(DATA_DIR, 'liquidity-rewards.json');
const MAX_RPS           = 1.5;
const CAPITAL_LEVELS    = [500, 5_000, 50_000];
const SANITY_CAP_PCT    = 2.0;   // %/day → THIN BOOK flag per level. Mirrors lib/reward-gating.ts REWARD_SANITY_CAP_PCT — keep in sync (this is a plain Node script, can't import the .ts file).
const FLOOR_DAILY_USD   = 1.0;   // $/day minimum gross; below = below-floor flag per level
const NEAR_EXPIRY_DAYS  = 14;    // markets closing within → force HIGH vol
const GAMMA_PAGE_SIZE   = 100;
const MAX_PAGES         = 21;    // offset 0..2000 (21 × 100)
const MAX_CLOB_MARKETS  = Number(process.env.REWARD_MAX_CLOB_MARKETS) > 0
  ? Number(process.env.REWARD_MAX_CLOB_MARKETS) : 150;   // vedi il blocco qui sotto: tarato sul MISURATO
// ── IL TAGLIO PER NUMERO: 120 → NESSUNO → 400 → 150, E IL NUMERO ORA VIENE DA UN CRONOMETRO ─────
// Due errori di stima in mezza giornata, sullo stesso numero, ed entrambi hanno fermato i piazzamenti.
//
// PRIMO ERRORE (11 agosto, 13:41): tolto il taglio del tutto. Il costo era stato stimato sui 309 mercati
// del board NORMALIZZATO, ma il filtro a monte ne lascia passare ~1.100. La scansione non ha piu' finito:
// partita alle 13:41, alle 14:13 non aveva ancora riscritto il board, fermo alle 13:29. Eta' 30+ minuti
// contro il limite di 25 di agent41 ⇒ mini-ciclo fermo, e a cascata `readAllocatedCapital` scaduta,
// gamba orfana e riposizionamento post-fill inerti.
//
// SECONDO ERRORE (14:13): tetto 400, tarato con `400 / MAX_RPS = 4,4 min`. Sbagliato anche quello, e la
// ragione e' istruttiva: `_drain()` aggiunge attesa SOLO se la richiesta e' piu' veloce di 667 ms
// (`gap = 1000/MAX_RPS − elapsed`, dormito solo se positivo). Se la latenza reale del book supera quella
// soglia, il limitatore non interviene mai e il tempo per mercato E' LA LATENZA, non `1/MAX_RPS`.
// Misurato sul processo vivo: 400 mercati ancora in corso dopo **18 minuti** ⇒ **≥2,7 s per mercato**.
//
// IL NUMERO ADESSO: 150. Viene dalla misura, non da una formula — `150 x 2,7 s ≈ 6,8 min` di profondita'
// piu' ~3 min di scoperta ≈ **10 min**, dentro il periodo di 15 e con 15 minuti di margine sul limite di
// freschezza di agent41. E' poco sopra il 120 storico, l'unico valore che avesse mai dimostrato di
// stare nei tempi. Si cambia con `REWARD_MAX_CLOB_MARKETS`.
//
// E SOPRATTUTTO: LA DURATA ORA SI CRONOMETRA E SI DICHIARA (vedi `dtProfondita` sotto). Il costo per
// mercato dipende dalla latenza del venue, che non e' sotto il nostro controllo e cambia nel tempo: un
// numero tarato una volta su una stima invecchia in silenzio, un numero che si misura a ogni scansione
// no. Se la fase supera il periodo, il log lo dice con il secondi-per-mercato osservato — cosi' il
// prossimo che deve scegliere il tetto legge un fatto invece di rifare la mia aritmetica.
// ── LA SECONDA PASSATA (8 agosto 2026) ────────────────────────────────────────
// Quanto in là guarda la camminata ordinata sulle scadenze. 3 giorni e non 1,5 (il tetto del
// pianificatore) perche' la scoperta non applica politiche: vedere anche cio' che si scartera' e'
// l'unico modo per accorgersi che lo si sta scartando.
const FAST_WINDOW_DAYS  = Number(process.env.REWARD_FAST_WINDOW_DAYS) > 0
  ? Number(process.env.REWARD_FAST_WINDOW_DAYS) : 2;
// Il tetto di pagine della seconda passata. Misurato l'8 agosto: coprire 36 ore costa ~20 pagine
// (~2.000 mercati, quasi tutti senza montepremi), quindi 25 copre la finestra con margine e tiene il
// costo LIMITATO anche se un giorno il venue crea molti piu' mercati a breve. Il taglio, se arriva,
// e' dichiarato nel log della scansione invece di essere silenzioso.
// LE FETTE. Gamma tronca OGNI query a ~2.100 record, quindi non basta ordinare per scadenza: la
// camminata da `adesso` in avanti consuma tutti e 2.100 i posti sui mercati piu' imminenti (sport e
// crypto, quasi tutti senza montepremi) e non arriva mai alle ore che ci interessano. Misurato l'8
// agosto: una camminata unica trovava 0 mercati premiati fra 6h e 36h, mentre le stesse ore
// interrogate a fette di 6 ore ne trovano 70. La finestra va PARTIZIONATA, non percorsa.
const FAST_SLICE_HOURS  = Number(process.env.REWARD_FAST_SLICE_HOURS) > 0
  ? Number(process.env.REWARD_FAST_SLICE_HOURS) : 6;
// Il budget di pagine dell'INTERA seconda passata, non della singola fetta: un tetto sul costo che
// non dipende da quante fette servono. 120 pagine coprono le 48 ore misurate (135 pagine per 8 fette,
// di cui le prime sei ne chiedono 98). Se il budget si esaurisce il fatto viene DICHIARATO nel log:
// una copertura parziale silenziosa e' peggio di una dichiarata.
const FAST_MAX_PAGES    = Number(process.env.REWARD_FAST_MAX_PAGES) > 0
  ? Number(process.env.REWARD_FAST_MAX_PAGES) : 120;
const GAP_SHARE_THRESH  = 0.20;  // ≥20% estimated share at $500 → band is thinly covered

// ── Rate-limited HTTP queue ───────────────────────────────────────────────────
const _queue = [];
let _draining = false;

function httpGet(url, timeoutMs = 20_000) {
  return new Promise((res, rej) => {
    _queue.push({ url, timeoutMs, res, rej });
    if (!_draining) _drain();
  });
}

async function _drain() {
  _draining = true;
  while (_queue.length) {
    const { url, timeoutMs, res, rej } = _queue.shift();
    const t0 = Date.now();
    try   { res(await _rawGet(url, timeoutMs)); }
    catch (e) { rej(e); }
    const elapsed = Date.now() - t0;
    const gap     = Math.ceil(1000 / MAX_RPS) - elapsed;
    if (gap > 0) await sleep(gap);
  }
  _draining = false;
}

function _rawGet(url, ms) {
  return new Promise((res, rej) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    // Hard wall-clock deadline — socket-inactivity timeout alone can't catch trickle-stalls
    const timer = setTimeout(() => {
      req.destroy();
      settle(rej, new Error('timeout'));
    }, ms);

    const req = https.get(url, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString();
        try   { settle(res, { status: r.statusCode, data: JSON.parse(body) }); }
        catch (e) { settle(rej, new Error(`HTTP ${r.statusCode} / bad JSON: ${body.slice(0, 80)}`)); }
      });
    });
    req.on('error', e => { clearTimeout(timer); settle(rej, e); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ── Fetch reward-eligible markets from Gamma ──────────────────────────────────
//
// ═══ DUE PASSATE, E LA SECONDA È NATA L'8 AGOSTO 2026 ══════════════════════════════════════════════
// La prima passata pagina il listino non filtrato (`active=true&closed=false`). Sembra esaustiva e non
// lo è: **Gamma tronca QUALUNQUE query a ~2.100 record**, e in quel listino l'ordinamento di difetto è
// per `id` crescente, cioè dal mercato più VECCHIO. Misurato: offset 2100 risponde vuoto sia sul
// listino intero sia su una finestra di tre giorni — è il tetto della API, non la fine dei mercati.
// Conseguenza: i mercati creati di recente, che sono esattamente quelli a scadenza rapida, cadono
// oltre il taglio e non sono MAI stati visti. Il board del 8 agosto aveva 115 mercati e il più corto
// scadeva fra **2,41 giorni**, mentre i 21 maker di riferimento entrano con mediana **5,3 ore**.
//
// Nessun filtro di categoria li escludeva: non venivano proprio interrogati.
//
// La seconda passata chiede la stessa cosa in un ordine diverso — `order=endDate&ascending=true` con
// `end_date_min=adesso` — e cammina in AVANTI nel tempo fermandosi appena supera la finestra. Non è un
// universo nuovo: è lo stesso universo interrogato da un capo diverso, così il taglio dei 2.100 cade
// dove non ci interessa invece che dove ci interessa. Prima misura, 8 agosto 2026: quattro mercati
// premiati entro 36 ore che il board non aveva, fra cui «Solana Up or Down 10:15-10:30 ET» a
// **$833/giorno** e «Dogecoin Up or Down» a $417/giorno, contro un montepremi mediano di board di $47.
//
// Le due passate si UNISCONO su `conditionId`: nessun mercato viene contato due volte, e nessuno dei
// criteri di selezione già esistenti cambia — non si tocca il montepremi, non si tocca la banda, non
// si tocca il gate di contraddizione. Questo lavoro allarga SOLO l'ampiezza della scoperta.
async function fetchRewardMarkets(deps = {}) {
  // L'HTTP è INIETTABILE, e non è un vezzo: senza, l'unico modo di provare questa funzione sarebbe
  // sparare ~45 richieste vere a Gamma dentro un test. Con l'iniezione si prova la LOGICA — le due
  // passate, l'unione, la fermata sulla finestra — su pagine finte e in millisecondi, ed è la stessa
  // disciplina del resto del maker: si esegue QUESTA funzione, non una sua imitazione.
  const get = deps.httpGet || httpGet;
  const adesso = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
  const perId = new Map();

  /** Le pagine di UNA passata, con l'indice condiviso: la stessa riga costruita nello stesso modo. */
  async function passata(nome, urlDiPagina, { maxPagine }) {
    let pagine = 0, aggiunti = 0;
    for (let page = 0; page < maxPagine; page++) {
      const offset = page * GAMMA_PAGE_SIZE;
      let r;
      try { r = await get(urlDiPagina(offset)); }
      catch (e) { console.warn(`  Gamma [${nome}] page ${page} error: ${e.message}`); break; }

      if (r.status !== 200 || !Array.isArray(r.data) || r.data.length === 0) break;
      pagine++;

      aggiunti += raccogli(r.data);
      if (r.data.length < GAMMA_PAGE_SIZE) break;
    }
    return { nome, pagine, aggiunti };
  }

  /** Costruisce e indicizza le righe di una pagina. Ritorna quanti mercati NUOVI ha aggiunto. */
  function raccogli(righe) {
    let nuovi = 0;
    for (const m of righe) {
      const cr = m.clobRewards;
      if (!cr || !cr.length) continue;

      const rate      = parseFloat(cr[0].rewardsDailyRate);
      const maxSpread = parseFloat(m.rewardsMaxSpread);
      const minSize   = parseFloat(m.rewardsMinSize);

      if (!rate || rate <= 0.01) continue;
      if (!maxSpread || maxSpread <= 0) continue;

      let tokenIds = [];
      try {
        tokenIds = typeof m.clobTokenIds === 'string'
          ? JSON.parse(m.clobTokenIds)
          : (Array.isArray(m.clobTokenIds) ? m.clobTokenIds : []);
      } catch (_) {}

      if (!tokenIds.length) continue;

      // ── LA SCADENZA, E DA DOVE ARRIVA ──────────────────────────────────────────────────────────
      // Gamma OMETTE `endDate` sul record del singolo mercato molto piu' spesso di quanto sembri:
      // misurato il 4 agosto 2026 sulla pagina all'offset 300, 100 record su 100 senza `m.endDate` —
      // e 100 su 100 con la data sull'EVENTO padre. Sul board vivo erano 21 mercati su 117, venti dei
      // quali negRisk, tutti mostrati con scadenza «—».
      //
      // Su un evento multi-esito (negRisk) la data e' una proprieta' dell'EVENTO, non dell'esito: le
      // elezioni del Wisconsin si decidono il 2026-11-03 tanto per la riga «Republicans» quanto per la
      // riga «Democrats». Ereditarla dal padre non e' un'inferenza — e' leggere il dato dove il venue
      // lo pubblica davvero.
      //
      // Cio' che NON si fa: inventarla. Se manca anche sull'evento resta null, `endDateSource` resta
      // null, e il filtro orizzonte lo dichiara invece di lasciarlo passare in silenzio.
      const evento   = (Array.isArray(m.events) && m.events[0]) || null;
      const scadenza = risolviScadenza(m);

      const riga = {
        conditionId:      m.conditionId,
        // Polymarket deep-link needs the EVENT slug (…/event/<slug>), NOT the per-market
        // slug (which carries a numeric suffix and 404s on the SINGLE-segment /event/<slug>).
        // Gamma nests the event slug under events[0].slug. null when absent → no link.
        slug:             (evento && evento.slug) || null,
        // Per-OUTCOME market slug (m.slug). On a multi-outcome (negRisk) event every outcome
        // shares one event slug but has its own m.slug — the real two-segment page is
        // …/event/<eventSlug>/<marketSlug>. Kept so the UI can deep-link the exact outcome
        // (e.g. the England leg of world-cup-winner) instead of the parent event page.
        marketSlug:       m.slug || null,
        // Human outcome label (e.g. "England", "No Prison Time") for the multi-outcome hint.
        groupItemTitle:   m.groupItemTitle || null,
        question:         m.question,
        rewardsDailyRate: rate,
        rewardsMinSize:   minSize || 0,
        rewardsMaxSpread: maxSpread,
        tokenId:          tokenIds[0],
        tokenIdNo:        tokenIds[1] || null,
        endDate:          scadenza.endDate,
        // 'market' = pubblicata sul mercato · 'event' = ereditata dall'evento padre · null = ignota.
        // Serve a distinguere un dato diretto da uno ereditato senza doverlo ridedurre a valle.
        endDateSource:    scadenza.endDateSource,
        lastTradePrice:   parseFloat(m.lastTradePrice) || 0,
        bestBid:          parseFloat(m.bestBid) || 0,
        bestAsk:          parseFloat(m.bestAsk) || 0,
        negRisk:          Boolean(m.negRisk),
        assetAddress:     cr[0].assetAddress,
        // Gamma's real 24h traded volume — the "is anyone actually trading here" evidence the
        // stability scorer needs. Gamma OMITS the key entirely for markets with no 24h flow
        // (measured: 13 of 116 reward markets), so an absent value stays null. Coercing it to 0
        // would be an imputation, and reading it as "zero volume" would be a fabrication.
        volume24hUsd:     Number.isFinite(Number(m.volume24hr)) ? Number(m.volume24hr) : null,
      };
      // L'UNIONE: la prima passata che vede un mercato lo tiene. Le due passate leggono lo stesso
      // endpoint con lo stesso schema, quindi la riga è identica e non c'è una versione «migliore» da
      // preferire — sovrascrivere sarebbe solo un modo diverso di ottenere lo stesso oggetto.
      if (!perId.has(riga.conditionId)) { perId.set(riga.conditionId, riga); nuovi++; }
    }
    return nuovi;
  }

  // ── PASSATA 1 · il listino, come è sempre stato ────────────────────────────────────────────────
  const p1 = await passata('listino', (off) =>
    `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${GAMMA_PAGE_SIZE}&offset=${off}`,
    { maxPagine: MAX_PAGES });

  // ── PASSATA 2 · LE SCADENZE VICINE, A FETTE ────────────────────────────────────────────────────
  // Ogni fetta è una query con la SUA finestra `[end_date_min, end_date_max]`, quindi ognuna ha i suoi
  // 2.100 posti e il tetto della API smette di essere il collo di bottiglia. La finestra complessiva è
  // deliberatamente PIÙ LARGA del tetto del pianificatore (`MAX_HORIZON_DAYS`, 1,5 g): la scoperta non
  // è il posto dove si applica una politica di selezione — vedere ciò che si scarta è l'unico modo per
  // accorgersi che lo si sta scartando.
  const isoZ = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
  const fetteN = Math.ceil((FAST_WINDOW_DAYS * 24) / FAST_SLICE_HOURS);
  let pagineUsate = 0, nuoviVicini = 0, fetteFatte = 0, budgetFinito = false, fetteAlTetto = 0;

  for (let i = 0; i < fetteN; i++) {
    if (pagineUsate >= FAST_MAX_PAGES) { budgetFinito = true; break; }
    const da = adesso + i * FAST_SLICE_HOURS * 3_600_000;
    const a  = adesso + (i + 1) * FAST_SLICE_HOURS * 3_600_000;
    const r = await passata(`fetta+${i * FAST_SLICE_HOURS}h`, (off) =>
      `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${GAMMA_PAGE_SIZE}&offset=${off}`
      + `&end_date_min=${encodeURIComponent(isoZ(da))}&end_date_max=${encodeURIComponent(isoZ(a))}`,
      { maxPagine: Math.min(22, FAST_MAX_PAGES - pagineUsate) });
    pagineUsate += r.pagine; nuoviVicini += r.aggiunti; fetteFatte++;
    // Una fetta che consuma 21 pagine ha con ogni probabilità toccato il tetto della API: la sua
    // copertura è parziale e va detto, non dedotto da chi legge i log fra un mese.
    if (r.pagine >= 21) fetteAlTetto++;
  }

  console.log(`  scoperta: ${p1.pagine}p listino (+${p1.aggiunti}) · ${pagineUsate}p in ${fetteFatte}/${fetteN} fette da ${FAST_SLICE_HOURS}h`
    + ` (+${nuoviVicini} nuovi entro ${FAST_WINDOW_DAYS}g)`
    + (fetteAlTetto ? ` · ${fetteAlTetto} fetta/e al tetto dei 2.100: copertura PARZIALE` : '')
    + (budgetFinito ? ` · BUDGET ESAURITO a ${FAST_MAX_PAGES}p: le fette oltre +${fetteFatte * FAST_SLICE_HOURS}h non sono state lette` : '')
    + ` → ${perId.size} mercati premiati`);
  return [...perId.values()];
}

// ── Market tick size (ALWAYS fetched per token, never assumed — 0.1/0.01/0.001/0.0001/0.0025 all
//    exist). Cached 1h (a tick size effectively never changes). null on failure → the price-first row
//    renders "—" and no rail rather than guessing a tick. ─────────────────────────────────────────────
const _tickCache = new Map(); // tokenId -> { tick, ts }
async function getTick(tokenId) {
  const c = _tickCache.get(tokenId);
  if (c && Date.now() - c.ts < 3_600_000) return c.tick;
  try {
    const r = await httpGet(`https://clob.polymarket.com/tick-size?token_id=${tokenId}`);
    const tick = r && r.status === 200 && r.data ? parseFloat(r.data.minimum_tick_size) : null;
    if (Number.isFinite(tick)) { _tickCache.set(tokenId, { tick, ts: Date.now() }); return tick; }
  } catch { /* fall through to any cached value, else null */ }
  return c ? c.tick : null;
}

// ── LA SCADENZA SECONDO IL VENUE ──────────────────────────────────────────────────────────────────
// La seconda delle due fonti di scadenza. Gamma pubblica l'ora vera, il CLOB tronca a mezzanotte UTC:
// sono due letture dello stesso evento con precisione diversa, e fino al 12 agosto 2026 il pianificatore
// usava la prima e la verifica la seconda — due mercati scelti e poi rifiutati, tre ricalcoli, ciclo
// fermato. Da qui in poi la riconciliazione avviene UNA VOLTA, qui, e il board porta il verdetto.
//
// COSTO: entra nel `Promise.all` gia' esistente del ciclo per mercato, quindi non aggiunge una fase e
// non allunga la scansione in modo misurabile — ~110 ms di latenza misurata contro i 2,7-3,4 s/mercato
// che la profondita' costa gia'. La cache di un'ora e' generosa perche' una data di risoluzione non
// cambia di minuto in minuto.
//
// FAIL-OPEN SULLA LETTURA, e NON e' in contraddizione col fail-closed della regola: una lettura mancante
// non e' una contraddizione fra fonti. Senza il CLOB si usa Gamma e lo si DICHIARA (`gamma-sola`);
// e' la DIVERGENZA fra due letture presenti a escludere il mercato.
const _scadenzaClobCache = new Map(); // conditionId -> { iso, ts }
async function getScadenzaClob(conditionId) {
  if (!conditionId) return null;
  const c = _scadenzaClobCache.get(conditionId);
  if (c && Date.now() - c.ts < 3_600_000) return c.iso;
  try {
    const r = await httpGet(`https://clob.polymarket.com/markets/${encodeURIComponent(conditionId)}`);
    const iso = r && r.status === 200 && r.data && typeof r.data.end_date_iso === 'string'
      ? r.data.end_date_iso : null;
    if (iso) { _scadenzaClobCache.set(conditionId, { iso, ts: Date.now() }); return iso; }
  } catch { /* si ripiega su un valore in cache, altrimenti null — mai una data inventata */ }
  return c ? c.iso : null;
}

// ── Measure book depth + quadratic competitor score from CLOB ─────────────────
// Returns:
//   existingDepthUsd  — dollar notional (price×size) of in-band orders (UI display only)
//   Qbids, Qasks, Qmin — quadratic competitor scores (used for share estimation)
//   mid               — size-cutoff-adjusted midpoint
async function measureBookDepth(tokenId, rewardsMaxSpread, minSize, fallbackMid) {
  try {
    const r = await httpGet(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    if (r.status !== 200 || !r.data) {
      return { mid: fallbackMid, existingDepthUsd: 0, bookSpread: null, emptyBook: true, Qbids: 0, Qasks: 0, Qmin: 0 };
    }

    const bids = (r.data.bids || [])
      .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .filter(b => b.price > 0 && b.size > 0)
      .sort((a, b) => b.price - a.price);

    const asks = (r.data.asks || [])
      .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .filter(a => a.price > 0 && a.size > 0)
      .sort((a, b) => a.price - b.price);

    if (!bids.length && !asks.length) {
      return { mid: fallbackMid, existingDepthUsd: 0, bookSpread: null, emptyBook: true, Qbids: 0, Qasks: 0, Qmin: 0 };
    }

    const bestBid  = bids.length ? bids[0].price : fallbackMid - 0.01;
    const bestAsk  = asks.length ? asks[0].price : fallbackMid + 0.01;
    // REAL touch prices — only when that side actually has resting orders (never the synthesized
    // fallback, which is not a book fact). These are surfaced for the price-first row's rail markers.
    const realBestBid = bids.length ? bids[0].price : null;
    const realBestAsk = asks.length ? asks[0].price : null;
    const plainMid = (bestBid + bestAsk) / 2;
    const bookSprd = parseFloat((bestAsk - bestBid).toFixed(4));

    // Dollar notional (kept for UI display; NOT used for share math)
    const halfBand = raggioBandaPrezzo(rewardsMaxSpread);
    const qBidsUsd = bids.filter(b => b.price >= plainMid - halfBand).reduce((acc, b) => acc + b.price * b.size, 0);
    const qAsksUsd = asks.filter(a => a.price <= plainMid + halfBand).reduce((acc, a) => acc + a.price * a.size, 0);
    const existingDepthUsd = Math.round(qBidsUsd + qAsksUsd);

    // Quadratic competitor scoring (the actual denominator for share estimates)
    const qs = scoreBook({ bids, asks }, rewardsMaxSpread, minSize, plainMid);

    return {
      mid:              qs.mid,
      bookSpread:       bookSprd,
      bestBid:          realBestBid,
      bestAsk:          realBestAsk,
      existingDepthUsd,
      emptyBook:        false,
      Qbids:            qs.Qbids,
      Qasks:            qs.Qasks,
      Qmin:             qs.Qmin,
    };
  } catch (e) {
    return { mid: fallbackMid, existingDepthUsd: 0, bookSpread: null, error: e.message, Qbids: 0, Qasks: 0, Qmin: 0 };
  }
}

// ── 24h price history → volatility stats ─────────────────────────────────────
// NOTE `fidelity` is in MINUTES, so fidelity=120 over 24h returns only ~13 points. That is far too
// coarse to judge stability (see measurePriceStability below, which uses a 7d/60min window). This
// 24h measure is KEPT UNCHANGED because other consumers are calibrated to it: classifyVol's
// LOW/MEDIUM/HIGH badge and lib/rewards-estimate's expectedAdverseMoveFor. Do not repoint them here.
async function measure24hVolatility(tokenId) {
  try {
    const now  = Math.floor(Date.now() / 1000);
    const from = now - 86400;
    const url  = `https://clob.polymarket.com/prices-history?market=${tokenId}&startTs=${from}&endTs=${now}&fidelity=120`;
    const r    = await httpGet(url);

    if (r.status !== 200 || !r.data?.history?.length) return { stdev: null, range: null, nPts: 0 };

    const prices = r.data.history.map(h => h.p);
    if (prices.length < 2) return { stdev: 0, range: 0, nPts: prices.length };

    const mean  = prices.reduce((s, p) => s + p, 0) / prices.length;
    const stdev = Math.sqrt(prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length);
    const range = Math.max(...prices) - Math.min(...prices);

    return {
      stdev: parseFloat(stdev.toFixed(5)),
      range: parseFloat(range.toFixed(4)),
      nPts:  prices.length,
    };
  } catch (e) {
    return { stdev: null, range: null, nPts: 0 };
  }
}

// ── 7-day price history → the STABILITY measurement ──────────────────────────
// The window the stability score is built on (lib/reward-stability). 7 days at fidelity=60 returns
// 102–169 points instead of the 24h window's 13 — measured 2026-07-24 across 116 live reward
// markets, where the 13-point window called 34 of them perfectly flat and 24 of those had in fact
// moved over the week (one by 30c against a 4.5c band).
//
// nPts and nDistinct are PERSISTED, not just used here: the scorer needs them to tell "still"
// apart from "no data". A series of fewer than 2 points has NO measurable dispersion, so stdev is
// null (never 0 — a degenerate 0 is what made an unmeasured market read as perfectly stable).
const STABILITY_WINDOW_HOURS = 168;
const STABILITY_FIDELITY_MIN = 60;

async function measurePriceStability(tokenId) {
  const empty = { stdev: null, range: null, nPts: 0, nDistinct: 0, windowHours: STABILITY_WINDOW_HOURS };
  try {
    const now  = Math.floor(Date.now() / 1000);
    const from = now - STABILITY_WINDOW_HOURS * 3600;
    const url  = `https://clob.polymarket.com/prices-history?market=${tokenId}`
               + `&startTs=${from}&endTs=${now}&fidelity=${STABILITY_FIDELITY_MIN}`;
    const r    = await httpGet(url);

    if (r.status !== 200 || !r.data?.history?.length) return empty;

    const prices = r.data.history.map(h => h.p).filter(p => typeof p === 'number' && Number.isFinite(p));
    if (prices.length < 2) {
      return { ...empty, nPts: prices.length, nDistinct: prices.length };
    }

    const mean  = prices.reduce((s, p) => s + p, 0) / prices.length;
    const stdev = Math.sqrt(prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length);

    return {
      stdev:       parseFloat(stdev.toFixed(6)),
      range:       parseFloat((Math.max(...prices) - Math.min(...prices)).toFixed(5)),
      nPts:        prices.length,
      nDistinct:   new Set(prices).size,
      windowHours: STABILITY_WINDOW_HOURS,
    };
  } catch (e) {
    return empty;
  }
}

// ── Volatility risk classification ────────────────────────────────────────────
function classifyVol(stdev, range, endDateStr, rewardsMaxSpread) {
  const daysLeft = endDateStr ? (new Date(endDateStr) - Date.now()) / 86400_000 : 999;
  if (daysLeft <= NEAR_EXPIRY_DAYS) return 'HIGH';

  const v        = stdev ?? range ?? 0;
  const halfBand = raggioBandaPrezzo(rewardsMaxSpread);

  if (v > halfBand)          return 'HIGH';
  if (v > halfBand * 0.25)   return 'MEDIUM';
  return 'LOW';
}

// ── Compute per-level estimates (quadratic scoring, three placement scenarios) ─
// Headline = typical (s=v/2, S=0.25).  Range: high (s=0.1¢) → low (s=0.8v).
// atMid (s=0, S=1.0) stored as _atMidShare for comparison output only.
function computeLevels(rewardsDailyRate, competitorQ, maxSpreadCents, minSize) {
  const levels = {};
  for (const C of CAPITAL_LEVELS) {
    const range  = estimateCapitalLevelRange(competitorQ, maxSpreadCents, minSize, rewardsDailyRate, C);
    const { typical, high, low, atMid } = range;
    const thinBookFlag   = typical.dayYieldPct > SANITY_CAP_PCT;
    const belowFloorFlag = typical.grossRewardDay < FLOOR_DAILY_USD;
    const flags = [];
    if (thinBookFlag)   flags.push('THIN BOOK — share will compress');
    if (belowFloorFlag) flags.push(`below $${FLOOR_DAILY_USD} payout floor at this capital`);

    levels[String(C)] = {
      capital:         C,
      share:           typical.share,
      grossRewardDay:  typical.grossRewardDay,
      dayYieldPct:     typical.dayYieldPct,
      // net = gross here: Polymarket CLOB maker fee = 0%; reward is paid from pool with no fee deducted.
      // Polygon gas ≈ $0 (negligible). The 2% settlement winFee applies to resolved winning positions, not rewards.
      netRewardDay:    typical.netRewardDay,
      netYieldPct:     typical.netYieldPct,
      shareHigh:       high.share,
      grossHigh:       high.grossRewardDay,
      netHigh:         high.netRewardDay,
      shareLow:        low.share,
      grossLow:        low.grossRewardDay,
      netLow:          low.netRewardDay,
      thinBookFlag,
      belowFloorFlag,
      flags,
      _atMidShare:     atMid.share,  // ceiling; comparison output only, not displayed in UI
    };
  }
  return levels;
}

// ── Gap / open-band classification ────────────────────────────────────────────
// gapScore: band-coverage measure = share at $500 expressed as a %, bounded 0–100.
//   Higher → thinner band → more uncovered.  NOT a yield or return figure.
// gapClass:
//   "OPEN"  — thinly covered (share ≥ GAP_SHARE_THRESH) + above $1/day floor
//              + LOW or MEDIUM volatility → real entry window, not an adverse trap.
//   "TRAP"  — thinly covered but HIGH volatility: band is thin precisely because
//              informed flow deters makers.  NOT a free opportunity.
//   "none"  — band is adequately covered or below floor.
function classifyGap(levels, volatilityRisk) {
  const lv500   = levels['500'];
  const share500 = lv500.share;
  const gross500 = lv500.grossRewardDay;
  const gapScore = parseFloat((share500 * 100).toFixed(1));

  let gapClass = 'none';
  if (share500 >= GAP_SHARE_THRESH && gross500 >= FLOOR_DAILY_USD) {
    if (volatilityRisk === 'LOW' || volatilityRisk === 'MEDIUM') {
      gapClass = 'OPEN';
    } else {
      gapClass = 'TRAP';
    }
  }
  return { gapClass, gapScore };
}

// ── Friendly depth string (e.g. $2.3k, $1.2M) ─────────────────────────────────
function fmtUsd(d) {
  if (d >= 1_000_000) return `$${(d/1_000_000).toFixed(1)}M`;
  if (d >= 1_000)     return `$${(d/1_000).toFixed(1)}k`;
  return `$${d}`;
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scan() {
  const t0 = Date.now();
  console.log(`\n[${new Date().toISOString()}] agent24: scanning Polymarket liquidity rewards…`);

  let markets;
  try {
    markets = await fetchRewardMarkets();
  } catch (e) {
    console.error(`  Failed to fetch markets: ${e.message}`);
    return;
  }

  console.log(`  ${markets.length} reward-eligible markets found`);
  if (!markets.length) {
    atomicWrite(OUTPUT_FILE, { meta: { generatedAt: new Date().toISOString(), totalMarkets: 0 }, markets: [] });
    return;
  }

  markets.sort((a, b) => b.rewardsDailyRate - a.rewardsDailyRate);

  // IL TAGLIO RESTA PURO, E L'UNIONE VIVE A VALLE. Un mercato con capitale dentro che scivola oltre il
  // taglio verrebbe perso — ma la correzione NON va qui: `capitale-al-lavoro.test.js` difende una
  // proprieta' decisa prima, cioe' che la SCOPERTA resti disaccoppiata da capitale, interruttore e
  // allowlist, cosi' agent24 gira H24 indipendente dallo stato del conto. Leggere qui la allowlist
  // avrebbe rotto quella garanzia per ottenere un risultato che si ottiene ugualmente dopo.
  // L'unione sta in `lib/rewards-normalize.buildCombined`, dove il board viene composto: stesso effetto
  // pratico a valle, garanzia intatta a monte.
  // ── LA QUOTA DI SCANSIONE RISERVATA AI MERCATI ALLA PORTATA DEL CAPITALE ──────────────────────
  //
  // ⚠ IL DIFETTO, misurato il 13 agosto 2026. La scoperta trova **1.276 mercati premiati** e il taglio
  // ne processa **150**, scelti per **montepremi**. Ma il montepremi alto vive sui mercati a `minSize`
  // grande — 1.000 share chiedono $1.225 per mercato contro un tetto di $32,67 — cioè **su mercati che
  // questo capitale non potrà MAI quotare**. I meteo giornalieri, che hanno `minSize 20` ed è l'unico
  // scaglione alla portata, hanno montepremi basso e **vengono seppelliti sistematicamente**.
  //
  // La correzione non tocca nessun filtro di qualità e non cambia il numero di mercati processati: dei
  // 150 posti, **metà è riservata ai mercati compatibili col tetto**, ordinati fra loro per montepremi.
  // Gli altri posti restano alla classifica di sempre, quindi non si perde niente di ciò che si vedeva.
  //
  // ⚠ LA SOGLIA DI COMPATIBILITÀ È FISSA E NON LEGGE IL CAPITALE, di proposito:
  // `capitale-al-lavoro.test.js` difende che la SCOPERTA resti disaccoppiata da capitale, interruttore e
  // allowlist, così agent24 gira H24 indipendente dallo stato del conto. Si usa `minSize <= 100`, che
  // copre i tre scaglioni bassi del venue (20/50/100) — cioè tutto ciò che un capitale ragionevole per
  // questo bot può raggiungere — invece del tetto vero, che cambia col saldo.
  const MIN_SIZE_ALLA_PORTATA = 100;
  const QUOTA_COMPATIBILI = Math.floor(MAX_CLOB_MARKETS / 2);
  const minSizeDi = (m) => {
    const v = Number(m && (m.rewardsMinSize
      || (m.clobRewards && m.clobRewards[0] && m.clobRewards[0].rewardsMinSize)));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const toProcess = (() => {
    const compat = [];
    const resto = [];
    for (const m of markets) {
      const ms = minSizeDi(m);
      // `minSize` non leggibile ⇒ resta nella classifica normale: non si promuove su un'incognita.
      (ms != null && ms <= MIN_SIZE_ALLA_PORTATA ? compat : resto).push(m);
    }
    const scelti = compat.slice(0, QUOTA_COMPATIBILI);
    const presi = new Set(scelti);
    for (const m of markets) {
      if (scelti.length >= MAX_CLOB_MARKETS) break;
      if (!presi.has(m)) { scelti.push(m); presi.add(m); }
    }
    console.log(`  quota di scansione: ${Math.min(compat.length, QUOTA_COMPATIBILI)}/${QUOTA_COMPATIBILI} posti riservati a mercati con minSize <= ${MIN_SIZE_ALLA_PORTATA}`
      + ` (ne esistono ${compat.length} sui ${markets.length} premiati) · gli altri ${MAX_CLOB_MARKETS - Math.min(compat.length, QUOTA_COMPATIBILI)} restano alla classifica per montepremi`);
    return scelti.slice(0, MAX_CLOB_MARKETS);
  })();
  console.log(`  Processing top ${toProcess.length} of ${markets.length} reward markets for CLOB depth`
    + ` (tetto ${MAX_CLOB_MARKETS}, tarato sul MISURATO — la durata reale è cronometrata qui sotto)`);

  let results = [];
  const t0Profondita = Date.now();

  for (const m of toProcess) {
    const fallbackMid = m.lastTradePrice
      || (m.bestBid && m.bestAsk ? (m.bestBid + m.bestAsk) / 2 : 0.5);

    // Fetch BOTH CLOB token books LIVE — the YES token book and the NO token book —
    // never synthesizing one from the other. Polymarket's fungibility keeps the two
    // books near mirror-complements at the price level (YES bid p ≈ NO ask 1−p), but
    // each side's REWARD band is centered on that token's own mid, so the in-band
    // qualifying depth (and thus the per-side reward math) genuinely differs. 24h
    // volatility is identical for both tokens (NO = 1 − YES ⇒ Var(NO) = Var(YES)), so
    // we fetch it once and reuse it — exact, saves a call. NO book only when tokenIdNo.
    const [book, bookNo, vol, stab, tickSize, scadenzaClob] = await Promise.all([
      measureBookDepth(m.tokenId, m.rewardsMaxSpread, m.rewardsMinSize, fallbackMid),
      m.tokenIdNo
        ? measureBookDepth(m.tokenIdNo, m.rewardsMaxSpread, m.rewardsMinSize, 1 - fallbackMid)
        : Promise.resolve(null),
      measure24hVolatility(m.tokenId),
      // Separate 7d window for the stability score. NOT derived from the 24h call — a 13-point
      // sample cannot measure stillness (see measurePriceStability). Same token: NO = 1 − YES, so
      // Var is identical and one fetch serves both sides.
      measurePriceStability(m.tokenId),
      getTick(m.tokenId),   // real market tick — required for the price-first row's on-tick prices
      getScadenzaClob(m.conditionId),   // la SECONDA fonte di scadenza — vedi getScadenzaClob
    ]);

    // LA RICONCILIAZIONE, in un punto solo. Da qui in poi il board porta UNA scadenza — la piu' prudente
    // fra le due — e il verdetto di ammissibilita' che il pianificatore applica A MONTE.
    const scadenza = scadenzaUnificata({ gammaIso: m.endDate, clobIso: scadenzaClob });

    const volatilityRisk   = classifyVol(vol.stdev, vol.range, m.endDate, m.rewardsMaxSpread);
    const existingDepthUsd = book.existingDepthUsd;
    const competitorQ      = { Qmin: book.Qmin, Qbids: book.Qbids, Qasks: book.Qasks, mid: book.mid };
    const levels           = computeLevels(m.rewardsDailyRate, competitorQ, m.rewardsMaxSpread, m.rewardsMinSize);
    const { gapClass, gapScore } = classifyGap(levels, volatilityRisk);

    // Per-side estimator inputs (real, independent books). twoSidedRequired is
    // evaluated on EACH side's own mid — Polymarket requires two-sided when a
    // token's mid sits outside [0.10, 0.90]. emptyBook is surfaced truthfully so the
    // UI can show "book unavailable" for a side rather than a fabricated number.
    const sideYes = {
      mid:                book.mid,
      existing_depth_usd: book.existingDepthUsd,
      bookSpread:         book.bookSpread,
      emptyBook:          !!book.emptyBook,
      twoSidedRequired:   book.mid != null && (book.mid < 0.10 || book.mid > 0.90),
      volatilityStdev:    vol.stdev,
      derivedByComplement: false,   // real CLOB book, real bids AND asks
    };
    const sideNo = bookNo ? {
      mid:                bookNo.mid,
      existing_depth_usd: bookNo.existingDepthUsd,
      bookSpread:         bookNo.bookSpread,
      emptyBook:          !!bookNo.emptyBook,
      twoSidedRequired:   bookNo.mid != null && (bookNo.mid < 0.10 || bookNo.mid > 0.90),
      volatilityStdev:    vol.stdev,   // Var(NO) = Var(1−YES) = Var(YES), exact
      derivedByComplement: false,   // independent NO-token CLOB book, real bids AND asks
    } : null;

    // OLD linear share for side-by-side comparison in console
    const linearShare500 = existingDepthUsd > 0 ? 500 / (500 + existingDepthUsd) : 1.0;

    // sane/flagged based on $500 level (for sorting; UI re-evaluates per selected level)
    const level500 = levels['500'];
    const sane     = level500.flags.length === 0;

    results.push({
      question:          m.question,
      category:          categoryFromText(m.question),  // tags-first not available on Gamma market obj; keyword taxonomy (honest 'other' when unmatched)
      conditionId:       m.conditionId,
      slug:              m.slug || null,          // real Gamma event slug, carried through for platform deep-link
      marketSlug:        m.marketSlug || null,    // per-outcome slug → two-segment multi-outcome deep-link
      groupItemTitle:    m.groupItemTitle || null,// outcome label (e.g. "England")
      rewardsDailyRate:  m.rewardsDailyRate,
      rewardsMaxSpread:  m.rewardsMaxSpread,
      rewardsMinSize:    m.rewardsMinSize,
      assetAddress:      m.assetAddress,
      tokenId:           m.tokenId,
      tokenIdNo:         m.tokenIdNo || null,
      tickSize:          Number.isFinite(tickSize) ? tickSize : null,  // real market tick (price-first row / on-tick)
      mid:               book.mid,
      bookSpread:        book.bookSpread,
      bestBid:           book.bestBid ?? null,   // REAL YES-token touch (null when that side is empty)
      bestAsk:           book.bestAsk ?? null,
      existing_depth_usd: existingDepthUsd,
      // Per-side (YES/NO) real independent books — estimator inputs. Top-level fields
      // above mirror the YES side for backward compatibility; `sides` carries both.
      sides:             { yes: sideYes, no: sideNo },
      volatilityRisk,
      volatilityStdev:   vol.stdev,
      volatilityRange:   vol.range,
      // Stability measurement inputs (7d window) — the scorer in lib/reward-stability decides
      // known/unknown from these. Persisted raw so the score is reproducible from the feed.
      stability:         { stdev: stab.stdev, range: stab.range, nPts: stab.nPts, nDistinct: stab.nDistinct, windowHours: stab.windowHours },
      // Real 24h traded volume from Gamma. Gamma OMITS this key for markets with no 24h flow —
      // that absence is carried through as null (missing evidence), NEVER coerced to 0.
      volume24hUsd:      m.volume24hUsd,
      // LA SCADENZA E' QUELLA RICONCILIATA, non piu' quella di Gamma: una fonte sola, letta qui, usata
      // identicamente dal pianificatore e dalla verifica. Le due letture grezze restano accanto perche'
      // «le fonti concordano» e «ne abbiamo letta una sola» non siano lo stesso dato.
      endDate:           scadenza.iso,
      endDateGamma:      m.endDate ?? null,
      endDateClob:       scadenzaClob,
      endDateFonte:      scadenza.fonte,
      scadenzaDivergenzaOre: scadenza.divergenzaOre,
      scadenzaAmmissibile:   scadenza.ammissibile,
      scadenzaMotivo:        scadenza.motivo,
      // Provenienza della scadenza — 'market' | 'event' | null. Viaggia fino al board perche' chi legge
      // il piano possa distinguere una data pubblicata sul mercato da una ereditata dall'evento padre.
      endDateSource:     m.endDateSource ?? null,
      negRisk:           m.negRisk,
      levels,
      sane500:           sane,  // convenience flag; UI re-evaluates per level
      gapClass,
      gapScore,
      _linearShare500:   parseFloat(linearShare500.toFixed(6)),  // old linear (notional) — historical reference
      _atMidShare500:    parseFloat((levels['500']._atMidShare || 0).toFixed(6)), // ceiling; not UI headline
    });
  }

  // ── IL CRONOMETRO DELLA FASE PROFONDITA' ────────────────────────────────────────────────────────
  // Il secondi-per-mercato e' l'unico numero da cui si puo' scegliere il tetto, e dipende dalla latenza
  // del venue: non e' sotto il nostro controllo e cambia. Si misura e si dichiara a OGNI scansione,
  // cosi' non serve piu' indovinarlo — e se un giorno peggiora, il log lo dice prima che il board
  // invecchi oltre il limite dei lettori.
  const dtProfondita = Date.now() - t0Profondita;
  const perMercato = toProcess.length > 0 ? dtProfondita / toProcess.length / 1000 : null;
  const oltre = dtProfondita > SCAN_INTERVAL_MS;
  console.log(`  profondità: ${(dtProfondita / 60_000).toFixed(1)} min per ${toProcess.length} mercati`
    + ` = ${perMercato == null ? '—' : perMercato.toFixed(2)}s/mercato`
    + ` · periodo ${SCAN_INTERVAL_MS / 60_000} min`
    + (perMercato ? ` · a questo ritmo il tetto che sta nel periodo è ~${Math.floor((SCAN_INTERVAL_MS / 1000) * 0.6 / perMercato)}` : '')
    + (oltre ? '  ⚠ LA FASE HA SUPERATO IL PERIODO: il board invecchia oltre la cadenza dichiarata,'
      + ' abbassare REWARD_MAX_CLOB_MARKETS' : ''));

  // ── IL BONUS «MERCATO NUOVO» — CABLATO QUI, E SOLO QUI ──────────────────────────────────────────
  // Il modulo esisteva dall'11 agosto 2026 con `BONUS_ATTIVO = true`, ma NESSUN consumatore lo chiamava:
  // il moltiplicatore non toccava nessuna classifica. Questo e' il cablaggio.
  //
  // ═══ PERCHE' PROPRIO QUI, E NON PIU' IN ALTO ═══════════════════════════════════════════════════
  // Il sort ha tre criteri in ordine: `sane500` (la qualita' del book), poi la volatilita', poi il rate.
  // Il bonus si applica AL TERZO, cioe' moltiplica il rate DENTRO il gruppo di qualita', e non puo'
  // spostare un mercato da un gruppo all'altro. Un mercato con book sottile ha `sane500:false` e resta
  // nell'ultimo gruppo **anche se e' nuovissimo**: il bonus non lo tira su di un solo posto rispetto a
  // un mercato sano. E il cancello di profondita' vero (`profondita-minima`, §5 punto 64) vive ancora
  // piu' a valle, PRIMA del knapsack, e non sa nemmeno che questo bonus esiste.
  //
  // Cioe': il bonus decide fra pari, mai contro un cancello. Era la condizione posta per accenderlo.
  const { bonusPriorita } = require('../lib/rewards/mercato-nuovo');
  for (const r of results) {
    let b;
    try { b = bonusPriorita(r.marketId || r.conditionId || r.id); }
    catch { b = null; }
    // Il moltiplicatore e i suoi dati viaggiano SULLA RIGA: chi legge il board deve poter vedere perche'
    // un mercato sta dove sta, e con `attendibile:false` sapere che in questa finestra il segnale non e'
    // ancora provato (§5: lo storico e' stato scritto col vecchio taglio ai primi 120).
    r.bonusNuovo = b && Number.isFinite(b.moltiplicatore) ? b.moltiplicatore : 1;
    r.nuovoMercato = !!(b && b.applicato);
    r.nuovoEtaGiorni = b && b.eta ? b.eta.giorni : null;
    r.nuovoAttendibile = b && b.eta ? b.eta.attendibile : null;
    // Il rate PESATO e' quello che ordina; il rate nudo resta pubblicato accanto e non viene toccato,
    // cosi' nessun consumatore a valle si ritrova un montepremi gonfiato.
    r.rateOrdinamento = +((Number(r.rewardsDailyRate) || 0) * r.bonusNuovo).toFixed(6);
  }
  const nuovi = results.filter((r) => r.nuovoMercato).length;
  if (nuovi) {
    console.log(`  bonus «mercato nuovo»: ${nuovi}/${results.length} righe pesate x${require('../lib/rewards/mercato-nuovo').BONUS_MAX}`
      + ` (a parita' di gruppo di qualita'; non scavalca sane500 ne' la volatilita')`);
  }

  // Default sort: LOW vol sane first, then MED, then HIGH, then flagged; by rate desc within group
  const volOrder = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  results.sort((a, b) => {
    const aSane = a.sane500 ? 0 : 1;
    const bSane = b.sane500 ? 0 : 1;
    if (aSane !== bSane) return aSane - bSane;
    const vA = volOrder[a.volatilityRisk] ?? 2;
    const vB = volOrder[b.volatilityRisk] ?? 2;
    if (vA !== vB) return vA - vB;
    // IL TERZO CRITERIO, ed e' l'unico che il bonus tocca.
    return (b.rateOrdinamento ?? b.rewardsDailyRate) - (a.rateOrdinamento ?? a.rewardsDailyRate);
  });

  // ── DEPTH-AT-TOUCH SUPPRESSION ──────────────────────────────────────────────
  // Drop rows whose real two-sided in-band depth is below the floor ($25 default). That
  // depth is the mechanism behind the thin-book artifact: with only a few dollars resting,
  // a $500–$50k maker "owns" ~100% of the pool and the $/day reads absurdly high. The 2%/day
  // cap only flags it; this HIDES it (never rewrites the number). Prints before/after + the
  // removed rows so the effect is visible, not asserted.
  //
  // ── LE RIGHE SOPPRESSE NON SI BUTTANO: SI CONSEGNANO A PARTE (11 agosto 2026) ──────────────────
  // `lib/rewards-normalize.buildCombined` applica LA STESSA soppressione con un'eccezione: un mercato
  // dove abbiamo capitale dentro resta visibile (`liveMinMarketIds`). Quell'eccezione NON POTEVA
  // SCATTARE, e il commento che la descrive lo dava per fatto: buildCombined legge `markets[]` di
  // questo file, e la riga sottile era già stata tolta QUI, a monte. Due filtri con lo stesso
  // predicato in sequenza, e solo il secondo aveva l'eccezione: il primo vinceva sempre.
  //
  // La correzione NON legge la allowlist qui — `capitale-al-lavoro.test.js` §4 difende la proprietà
  // che la SCOPERTA resti disaccoppiata da capitale, interruttore e allowlist, e resta intatta: questo
  // ciclo non sa e non chiede dove sia il nostro capitale. Si limita a non distruggere l'informazione,
  // consegnando le righe soppresse in un campo SEPARATO. `markets[]` resta byte per byte quello di
  // prima per ogni altro lettore; chi conosce il capitale decide a valle, dove l'eccezione già vive.
  const floor = depthFloorUsd();
  const beforeCount = results.length;
  const removed = [];
  const soppressePerProfondita = [];
  const kept = results.filter(r => {
    const depth = competitorDepthUsd({
      venue: 'polymarket',
      bookDepthAtBand: r.existing_depth_usd,
      sides: { no: r.sides && r.sides.no ? { bookDepthAtBand: r.sides.no.existing_depth_usd } : null },
    });
    if (belowDepthFloor(depth, floor)) {
      removed.push({ q: r.question, pool: r.rewardsDailyRate, depthUsd: depth,
        dayYieldPct: r.levels?.['500']?.dayYieldPct ?? null, grossDay: r.levels?.['500']?.grossRewardDay ?? null });
      soppressePerProfondita.push(r);          // la riga INTERA, non un riassunto: a valle va normalizzata
      return false;
    }
    return true;
  });
  console.log(`  Depth-at-touch floor $${floor}: ${beforeCount} rows → ${kept.length} after (removed ${removed.length} thin-book artifact${removed.length === 1 ? '' : 's'})`);
  for (const r of removed) {
    console.log(`    ✗ depth $${(r.depthUsd ?? 0).toFixed(2)} · pool $${r.pool}/day · ~${r.dayYieldPct != null ? r.dayYieldPct.toFixed(1) : '?'}%/day @$500 (gross $${r.grossDay != null ? r.grossDay.toFixed(2) : '?'}) — ${String(r.q).slice(0, 70)}`);
  }
  results = kept;

  // ── DA DOVE VIENE LA SCADENZA, CONTATO A OGNI SCANSIONE ────────────────────────────────────────
  // Il verdetto per riga viaggia gia' su `endDateFonte` e `scadenzaMotivo`, ma un campo per riga non
  // risponde alla domanda «quanto sta pesando la regola oggi»: per quella servirebbe interrogare il
  // board. La riga qui sotto la rende leggibile dal log, che e' dove si guarda per primo quando
  // l'utilizzo crolla. `gamma-ora-vera-su-clob-troncato` e' la fonte introdotta il 12 agosto 2026
  // (Opzione B): conta i mercati a cui il troncamento del venue avrebbe tolto fino a 24 ore.
  {
    const perFonte = {};
    let discordi = 0;
    for (const r of results) {
      const f = r.endDateFonte || 'ignota';
      perFonte[f] = (perFonte[f] || 0) + 1;
      if (r.scadenzaAmmissibile === false) discordi += 1;
    }
    const recuperati = perFonte['gamma-ora-vera-su-clob-troncato'] || 0;
    console.log(`  scadenza: ${Object.entries(perFonte).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`
      + `${discordi ? ` · ${discordi} INAMMISSIBILI per scadenza discorde` : ''}`
      + (recuperati
        ? ` — ${recuperati} mercato/i con l'ORA VERA ripresa dal board perché il venue tronca a mezzanotte`
        : ' — nessun troncamento del venue da correggere in questa scansione'));
  }

  const out = {
    meta: {
      generatedAt:        new Date().toISOString(),
      scanDurationMs:     Date.now() - t0,
      rewardMarketsFound: markets.length,
      totalMarkets:       results.length,
      depthFloorUsd:      floor,
      suppressedThinDepth: removed.length,
      scannedBeforeFloor: beforeCount,
      saneAt500:          results.filter(r => r.sane500).length,
      flaggedAt500:       results.filter(r => !r.sane500).length,
      capitalLevels:      CAPITAL_LEVELS,
      disclaimer: [
        'share and grossRewardDay use Polymarket\'s quadratic scoring formula S(v,s)=((v-s)/v)^2 with c=3 two-sided combine.',
        'TYPICAL placement: user posts both sides at s=v/2 (half the half-band, S=0.25) — a realistic farming position, not the ceiling.',
        'Range: shareHigh/grossHigh = near-mid floor (s=0.1¢); shareLow/grossLow = outer band (s=0.8v, S=0.04).',
        'Actual share depends on exact resting distance; competitors continuously re-quote.',
        'existing_depth_usd is a point-in-time CLOB snapshot (price×size, display only; not used for share math).',
        'Q_competitors is the quadratic-weighted score of all existing resting orders in the YES book.',
        'sides.yes / sides.no carry each token\'s OWN live CLOB book. YES + NO mids ≈ 100¢ (Polymarket fungibility keeps the books near mirror-complements), but each side\'s in-band reward depth — and thus the per-side reward math — genuinely differs.',
        `THIN_BOOK flag: typical dayYieldPct > ${SANITY_CAP_PCT}% — book is thin, real share will compress as MMs arrive.`,
        `BELOW_FLOOR flag: typical grossRewardDay < $${FLOOR_DAILY_USD} — minimum daily payout not met.`,
        'netRewardDay = grossRewardDay × (1 − 0) because Polymarket CLOB maker fee = 0% and Polygon gas ≈ $0. Platform fees on the reward disbursement are deterministically zero. Does NOT account for inventory/adverse-selection risk from fills — that is non-deterministic and not a fee.',
        'Not financial advice.',
      ].join(' '),
    },
    markets: results,
    // ── LE RIGHE CHE IL PAVIMENTO DI PROFONDITA' HA TOLTO DA `markets` ────────────────────────────
    // Consegnate, non buttate. Le rilegge SOLO `lib/rewards-normalize.buildCombined`, che riammette
    // quelle dove abbiamo capitale dentro (`liveMinMarketIds`) e lascia fuori tutte le altre. Un
    // lettore che non conosce questo campo si comporta esattamente come prima.
    suppressedThinDepthMarkets: soppressePerProfondita,
  };

  atomicWrite(OUTPUT_FILE, out);

  // Parallel history sink (non-fatal): snapshot Polymarket LP reward markets as computed.
  try {
    require('../lib/history-logger').appendSnapshot('rewards-poly', Date.now(), results);
  } catch (e) { console.log('[history] rewards-poly snapshot skipped:', e.message); }

  // Rebuild the unified normalized snapshot (/tmp/liquidity-rewards.json) for the
  // Liquidity Rewards tab + estimator. Reads both venues' on-disk files; idempotent
  // and race-safe (atomic rename). Non-fatal.
  try {
    const nm = writeCombinedSnapshot();
    console.log(`  [normalize] /tmp/liquidity-rewards.json: ${nm.totalMarkets} markets (poly ${nm.polymarket} + kalshi ${nm.kalshi}, ${nm.withRealPool} real pools)`);
  } catch (e) { console.log('  [normalize] combined snapshot skipped:', e.message); }

  // ── Terminal output: top 5 markets with three capital levels ─────────────────
  const W = 130;
  const divider = '─'.repeat(W);
  console.log(`\n${divider}`);
  console.log(`POLYMARKET LIQUIDITY REWARD SCANNER  —  ${new Date().toISOString()}`);
  console.log(divider);
  console.log(`Markets scanned: ${results.length}   Sane@$500: ${out.meta.saneAt500}   Flagged@$500: ${out.meta.flaggedAt500}`);
  console.log(divider);

  const top5 = results.slice(0, 5);
  for (const r of top5) {
    const q = r.question.slice(0, 80);
    console.log(`\n  ${q}`);
    console.log(`  Pool: $${r.rewardsDailyRate}/day  Spread: ${r.rewardsMaxSpread}¢  Depth: ${fmtUsd(r.existing_depth_usd)}  Vol: ${r.volatilityRisk}  Gap: ${r.gapClass} (score ${r.gapScore}%)`);
    console.log(`  ${'Capital'.padEnd(10)}  ${'Share%'.padStart(8)}  ${'Gross/day'.padStart(10)}  ${'Yield%'.padStart(8)}  Flags`);
    for (const C of CAPITAL_LEVELS) {
      const lv  = r.levels[String(C)];
      const cap = `$${C >= 1000 ? (C/1000)+'k' : C}`.padEnd(10);
      const shr = `${(lv.share * 100).toFixed(2)}%`.padStart(8);
      const grs = `$${lv.grossRewardDay.toFixed(2)}`.padStart(10);
      const yld = `${lv.dayYieldPct.toFixed(2)}%`.padStart(8);
      const flg = lv.flags.length ? lv.flags.map(f => f.split('—')[0].trim()).join('; ') : '—';
      console.log(`  ${cap}  ${shr}  ${grs}  ${yld}  ${flg}`);
    }
  }

  // ── Placement comparison: at-mid (ceiling) vs typical (headline) vs outer-band (low) ─
  console.log(`\n${divider}`);
  console.log(`PLACEMENT COMPARISON  —  AT-MID (ceiling, S=1.0) vs TYPICAL (s=v/2, S=0.25) vs OUTER-BAND (s=0.8v, S=0.04)`);
  console.log(divider);
  console.log(`  ${'Market'.padEnd(50)} ${'Cap'.padStart(6)}  ${'AtMid%'.padStart(8)}  ${'Typical%'.padStart(9)}  ${'OuterBand%'.padStart(11)}  ${'Typ$/day'.padStart(9)}  Cap`);
  console.log(`  ${'-'.repeat(50)} ${'-'.repeat(6)}  ${'-'.repeat(8)}  ${'-'.repeat(9)}  ${'-'.repeat(11)}  ${'-'.repeat(9)}  ---`);
  for (const r of top5) {
    const q = r.question.slice(0, 50).padEnd(50);
    for (const C of CAPITAL_LEVELS) {
      const lv  = r.levels[String(C)];
      const cap = `$${C >= 1000 ? (C/1000)+'k' : C}`.padStart(6);
      const atM = `${(lv._atMidShare * 100).toFixed(2)}%`.padStart(8);
      const typ = `${(lv.share     * 100).toFixed(2)}%`.padStart(9);
      const low = `${(lv.shareLow  * 100).toFixed(2)}%`.padStart(11);
      const grs = `$${lv.grossRewardDay.toFixed(2)}`.padStart(9);
      const flg = lv.dayYieldPct > SANITY_CAP_PCT ? '⚠' : '✓';
      console.log(`  ${q} ${cap}  ${atM}  ${typ}  ${low}  ${grs}  ${flg}`);
    }
  }

  // ── Gap sample: 8 markets showing gapClass + inputs (sanity check) ────────────
  const opens = results.filter(r => r.gapClass === 'OPEN');
  const traps = results.filter(r => r.gapClass === 'TRAP');
  const gapSample = [
    ...opens.slice(0, 5),
    ...traps.slice(0, 3),
  ].slice(0, 8);

  if (gapSample.length > 0) {
    console.log(`\n${divider}`);
    console.log(`GAP ANALYSIS  —  OPEN: ${opens.length}  TRAP: ${traps.length}  (threshold: share@$500 ≥ ${GAP_SHARE_THRESH * 100}%, gross ≥ $${FLOOR_DAILY_USD}/day)`);
    console.log(divider);
    console.log(`  ${'Market (truncated)'.padEnd(55)} ${'Gap'.padEnd(6)} ${'Score'.padStart(6)} ${'Depth'.padStart(8)} ${'Shr@500'.padStart(9)} ${'Grs@500'.padStart(9)} Vol`);
    console.log(`  ${'-'.repeat(55)} ${'-'.repeat(6)} ${'-'.repeat(6)} ${'-'.repeat(8)} ${'-'.repeat(9)} ${'-'.repeat(9)} ---`);
    for (const r of gapSample) {
      const q   = r.question.slice(0, 55).padEnd(55);
      const gc  = r.gapClass.padEnd(6);
      const gs  = `${r.gapScore}%`.padStart(6);
      const dep = fmtUsd(r.existing_depth_usd).padStart(8);
      const shr = `${(r.levels['500'].share * 100).toFixed(1)}%`.padStart(9);
      const grs = `$${r.levels['500'].grossRewardDay.toFixed(2)}`.padStart(9);
      const vol = r.volatilityRisk;
      console.log(`  ${q} ${gc} ${gs} ${dep} ${shr} ${grs} ${vol}`);
    }
  } else {
    console.log(`\n  GAP ANALYSIS: no open bands or traps at this threshold (share@$500 < ${GAP_SHARE_THRESH * 100}%)`);
  }

  console.log(`\n${divider}`);
  console.log(`Written: ${OUTPUT_FILE}`);
  console.log(`FORMULA: S(v,s)=((v-s)/v)^2, c=3. Headline=typical (s=v/2,S=0.25). Range: high s=0.1¢, low s=0.8v.`);
  console.log(`ESTIMATE: snapshot-in-time; competitors re-quote; share compresses as makers enter; not a guarantee.`);
  console.log(divider);
}

// ── Formula self-test (runs once at startup) ──────────────────────────────────
function runFormulaVerification() {
  const { scoreBook: sb } = require('../lib/rewardScore');
  const testBook = {
    bids: [{ price: '0.49', size: '100' }, { price: '0.48', size: '100' }],
    asks: [{ price: '0.51', size: '100' }, { price: '0.505', size: '100' }],
  };
  const r  = sb(testBook, 6, 1, 0.50);  // maxSpread=6¢ → v=3¢, minSize=1
  const ok = Math.abs(r.Qmin - 73.61) < 0.02;
  const W  = 130;
  console.log('─'.repeat(W));
  console.log('FORMULA VERIFICATION  S(v,s)=((v-s)/v)^2  c=3  adjusted-mid');
  console.log(`  Test: bids=[0.49×100, 0.48×100] asks=[0.51×100, 0.505×100]  v=3¢  minSize=1`);
  console.log(`  adjustedMid = (0.49+0.505)/2 = ${r.mid}  (bestBid=0.49, bestAsk=0.505)`);
  console.log(`  Qbids = S(0.75¢)×100 + S(1.75¢)×100 = ${r.Qbids.toFixed(2)}   (0.5625×100 + 0.1736×100)`);
  console.log(`  Qasks = S(1.25¢)×100 + S(0.75¢)×100 = ${r.Qasks.toFixed(2)}  (0.3403×100 + 0.5625×100)`);
  console.log(`  Qmin(${r.Qbids.toFixed(2)}, ${r.Qasks.toFixed(2)}, 0.4975) = max(min,max(÷3)) = ${r.Qmin.toFixed(2)}  ${ok ? '✓ CORRECT' : '✗ MISMATCH'}`);
  console.log(`  NOTE: prior "111.11" was wrong — traced to Qbids×2 with size=200, no qMin, wrong mid.`);
  console.log(`  Polymarket docs show the formula steps but do not state a Q_min value for their example.`);
  console.log(`  HEADLINE = typical placement (s=v/2, S=0.25). Range: high s=0.1¢ / low s=0.8v.`);
  console.log('─'.repeat(W));
}

// ── Entry point ───────────────────────────────────────────────────────────────
// SOTTO GUARDIA dall'8 agosto 2026. Prima era una IIFE nuda: bastava un `require` di questo file —
// da un test, da una sonda — per far partire il ciclo infinito e, alla prima scansione, RISCRIVERE
// `data/liquidity-rewards.json`, cioè il board vivo che agent41 e la dashboard leggono. Una funzione
// non provabile senza effetti collaterali non è una funzione provata.
async function main() {
  console.log(`[agent24-liquidity-rewards] starting (capital levels: ${CAPITAL_LEVELS.map(c => '$'+c).join(', ')})…`);
  runFormulaVerification();
  await sleep(STARTUP_DELAY_MS);
  // ── IL PERIODO È IL PERIODO, NON «IL LAVORO PIÙ IL PERIODO» ──────────────────────────────────────
  // Qui c'era `await scan(); await sleep(SCAN_INTERVAL_MS)`, cioè un periodo REALE di
  // `durata della scansione + 15 minuti`. Finché la scansione costava 14 secondi la differenza non si
  // vedeva. Dall'allargamento del 8 agosto (§5 punto 23: 21 pagine → 141, la partizione in fette da 6h)
  // costa ~7,5 minuti, quindi il board si riscriveva ogni **22,5 minuti** mentre due costanti, un
  // commento e un test dicevano quindici.
  //
  // Non era un difetto estetico: agent41 rifiuta di quotare su un board più vecchio del suo limite, e
  // quel limite era tarato sui quindici. Misurato il 9 agosto sul giornale vero — le età che hanno
  // bloccato un mini-ciclo sono **21,0 · 22,0 · 22,2 minuti**, cioè tutte sopra il limite di 20 e tutte
  // sotto il periodo di 22,5: la firma esatta di un periodo che è cresciuto senza che nessuno lo dicesse.
  // 3 mini-cicli su 22 persi così in una giornata.
  //
  // Ora si dorme il RESTO del periodo. Con una scansione da 7,5 minuti il board si riscrive ogni 15
  // esatti, e il periodo smette di dipendere da quanto è larga la scoperta.
  //
  // IL PAVIMENTO NON È COSMETICO: se un giorno la scansione superasse i 15 minuti, dormire «il resto»
  // varrebbe zero e si girerebbe schiena a schiena martellando Gamma. `PAUSA_MINIMA_MS` garantisce che
  // fra due scansioni ci sia sempre un respiro, e lo sforamento si DICHIARA invece di degradare in
  // silenzio — è precisamente il modo in cui questo difetto è rimasto nascosto per un giorno.
  const PAUSA_MINIMA_MS = 60_000;
  while (true) {
    const inizio = Date.now();
    try   { await scan(); }
    catch (e) { console.error(`[agent24] uncaught:`, e.message, e.stack?.split('\n')[1]); }
    const durata = Date.now() - inizio;
    const resto = SCAN_INTERVAL_MS - durata;
    if (resto < PAUSA_MINIMA_MS) {
      console.log(`[agent24-liquidity-rewards] la scansione ha impiegato ${(durata / 60_000).toFixed(1)} min,`
        + ` cioè più del periodo di ${SCAN_INTERVAL_MS / 60_000} min: il board non può essere riscritto a quella cadenza.`
        + ` Si attende comunque la pausa minima di ${PAUSA_MINIMA_MS / 1000}s — chi legge il board deve tollerare`
        + ` un'età fino a ${((durata + PAUSA_MINIMA_MS) / 60_000).toFixed(1)} min.`);
    }
    await sleep(Math.max(PAUSA_MINIMA_MS, resto));
  }
}

if (require.main === module) main();

module.exports = { fetchRewardMarkets, FAST_WINDOW_DAYS, FAST_SLICE_HOURS, FAST_MAX_PAGES, MAX_PAGES, GAMMA_PAGE_SIZE };

#!/usr/bin/env node
'use strict';
/**
 * IL BANCO DEL CICLO COMPLETO — LA BASE. Il bot VERO, col SUO cablaggio, contro un venue simulato.
 *
 * ═══ PERCHE' QUESTA VERSIONE ESISTE (17 agosto 2026) ═════════════════════════════════════════════════
 * La versione precedente NON chiamava `agent40.closeTask()`: ricablava `runAutoCloseCycle` da se', con
 * **17 dep contro le 20** che la produzione passa. Le 7 mancanti erano `registraResiduo`,
 * `rimpiazzaGamba`, `mercatiDaRipianificare`, `scadenzaMercato`, `pulisciMercatoChiuso`, `tettoMercato`,
 * `capitaleLibero` — cioe' il fill parziale, la rotazione dello slot e la scadenza del mercato. Quel
 * banco misurava un auto-close che questo bot non ha, e il suo «37 regole su 91» e' stato buttato
 * dall'operatore. Aveva ragione: un banco che ricabla misura la propria copia.
 *
 * ═══ IL SEAM, E ADESSO SONO QUATTRO MODULI — NON CINQUE FIXTURE ══════════════════════════════════════
 * Si sostituisce solo cio' che E' il venue, piu' l'orologio. Tutto il resto — `closeTask`, `giro`, i
 * registri su file, la allowlist vera, la gestione manuale vera, il giornale vero — e' PRODUZIONE.
 *
 *   1 · `lib/venues/polymarket-clob-maker/adapter`  → gli ORDINI del venue (senza rete ne' credenziali)
 *   2 · `lib/maker/saldo-cache`                     → il DENARO del venue (senza RPC on-chain)
 *   3 · `lib/maker/ctf-relayer`                     → la catena (⚠ SENZA QUESTA il merge FIRMA DAVVERO:
 *                                                     `auto-close.js:676` cade sul relayer vero quando
 *                                                     `deps.mergeOnChain` non e' passata, e la
 *                                                     produzione NON la passa)
 *   4 · `Date.now`                                  → l'OROLOGIO, ed e' una correzione, non una comodita':
 *                                                     `closeTask` non riceve nessuna dep `now`, quindi la
 *                                                     produzione usa `Date.now()`. Il banco vecchio
 *                                                     passava `now` come dep e faceva avanzare un
 *                                                     orologio virtuale che il codice di produzione non
 *                                                     guardava — un'altra divergenza dal vero.
 *
 * E i due FILE del feed arrivano da `MAKER_FEED_BOOKS_FILE` / `MAKER_FEED_BOARD_FILE`
 * (`lib/maker/percorsi-feed`), scritti dal banco dalla fotografia del venue simulato. Serve perche'
 * `closeTask` chiama `resolveMarketRules(marketId)` SENZA `deps`: la fonte dei prezzi e' un file, e
 * finche' quel file era `/tmp/clob-live-books.json` — riscritto dal live agent34 ogni ~6 s — il
 * cablaggio di produzione non era esercitabile.
 *
 * ═══ DOVE GIRA, E PERCHE' NON E' «UNA COPIA DEL CODICE» ═════════════════════════════════════════════
 * `data/` non e' dirottabile (`lib/safety/store.js:32` risolve sul package root, senza env), e agent41
 * ci scrive: piano, tetti, allowlist, selezione, quarantena, giornale. Far girare il banco su `/root/bot`
 * vorrebbe dire cambiare lo STATO del bot vero per far girare una simulazione — il contrario di un banco.
 * Quindi il banco pretende di girare in un WORKTREE git allo STESSO COMMIT, con un `data/` copiato:
 * il codice e' identico byte per byte (ed e' VERIFICATO qui sotto, non promesso), lo stato no.
 * ⚠ Se il codice differisce, il banco SI RIFIUTA DI PARTIRE. Un banco che gira su codice diverso da
 * quello vivo e' peggio di nessun banco, ed e' precisamente l'errore che questa versione corregge.
 *
 * ⚠ E LE CREDENZIALI NON CI SONO: il worktree non ha `.env` (gitignored), quindi la firma EIP-712 non e'
 * nemmeno costruibile. E' la cintura strutturale sotto le tre sostituzioni.
 *
 * Uso: non si lancia da solo — `node scripts/ricerca/banco-scenari.js`.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VIVO = '/root/bot';                 // il path che pm2 esegue (`/root/prediction-market` e' un symlink)
const VERBOSO = process.argv.includes('--verboso');
const OUT = path.join(ROOT, 'data', 'ricerca', 'banco-ciclo-completo.json');
const DIR_FEED = path.join(ROOT, 'data', 'banco-feed');

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// IL CANCELLO: STESSO CODICE DEL BOT VIVO, STATO SEPARATO
// ════════════════════════════════════════════════════════════════════════════════════════════════════
function verificaIdentitaDelCodice() {
  if (path.resolve(ROOT) === path.resolve(VIVO)) {
    throw new Error(`il banco NON gira su ${VIVO}: scriverebbe nello stato del bot vero (piano, tetti, allowlist, selezione, giornale). `
      + 'Si crea un worktree allo stesso commit — `git worktree add -f /root/bot-banco HEAD` — con `data/` copiato, e si lancia da la\'.');
  }
  const sha = (dove) => { try { return execFileSync('git', ['-C', dove, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } };
  const qui = sha(ROOT); const vivo = sha(VIVO);
  // ⚠ IL CANCELLO E' IL `diff`, NON LO SHA — e la prima stesura aveva scelto lo sha, sbagliando in
  // entrambe le direzioni: due sha uguali non escludono un file modificato e non committato in
  // `/root/bot` (che e' il codice VIVO, non quello del commit), e due sha diversi non implicano codice
  // diverso (un `rsync` dei tre alberi li rende identici a sha diverso). Lo sha resta DICHIARATO perche'
  // serve a chi rilegge il referto; a decidere sono i byte.
  const diversi = [];
  for (const d of ['lib', 'agents', 'scripts']) {
    let out = '';
    try { out = execFileSync('diff', ['-rq', path.join(VIVO, d), path.join(ROOT, d)], { encoding: 'utf8' }); }
    catch (e) { out = String(e.stdout || ''); }
    for (const riga of out.split('\n').filter(Boolean)) diversi.push(riga);
  }
  if (diversi.length) {
    throw new Error(`il codice del worktree e quello vivo DIFFERISCONO (${diversi.length} voci):\n  ${diversi.slice(0, 8).join('\n  ')}\n`
      + 'Committa in /root/bot e rifai `git -C /root/bot-banco checkout <sha>`, oppure copia i file. Il banco non prova codice che non e\' quello vivo.');
  }
  return { commitWorktree: qui, commitVivo: vivo, alberiConfrontati: ['lib', 'agents', 'scripts'],
    identiciPerByte: true };
}
const IDENTITA = verificaIdentitaDelCodice();

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// L'AMBIENTE DEL BANCO
// ════════════════════════════════════════════════════════════════════════════════════════════════════
// ⚠ `MANUAL_ORDER_PLACEMENT=send` E' NECESSARIO, e va capito prima di leggerlo come un armamento: la
// corsia manuale e' la strada da cui il bot piazza davvero, e con `dry-run` gli ordini vengono costruiti,
// firmati e SCARTATI prima di raggiungere l'adapter — cioe' il banco non proverebbe nessun gate a valle.
// Qui l'adapter e' sostituito e le credenziali non esistono: la POST non ha dove andare.
process.env.MANUAL_ORDER_PLACEMENT = 'send';
process.env.MAKER_MODE = 'off';              // il gate live-min vive nella corsia manuale, che forza 'live-min' da se'
process.env.MAKER_PLACEMENT = '';
process.env.MAKER_ADAPTER_DRYRUN = '';
process.env.MAKER_FUNDING_APPROVED = '';
process.env.MAKER_LIVE_MIN_MARKET = '';
fs.mkdirSync(DIR_FEED, { recursive: true });
process.env.MAKER_FEED_BOOKS_FILE = path.join(DIR_FEED, 'clob-live-books.json');
process.env.MAKER_FEED_BOARD_FILE = path.join(DIR_FEED, 'liquidity-rewards.json');

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// IL CLOB SIMULATO, VIA HTTP — e non e' una sostituzione: e' il venue che risponde
// ════════════════════════════════════════════════════════════════════════════════════════════════════
// ⚠ QUESTA E' LA FORMA MIGLIORE DI SEAM CHE QUESTO REPO OFFRE, e va preferita a un `require.cache`:
// `CLOB_BASE` e' GIA' sovrascrivibile (`agent41:297` e `verifica-mercati-venue.js:30` leggono
// `POLY_CLOB_BASE`), quindi la verifica dei mercati al venue — quella che alla seconda corsa fermava il
// giro con «1 non e' stato leggibile: non si rialloca al buio» — gira sul codice di PRODUZIONE senza che
// nessun modulo venga sostituito. Il banco non finge di essere il lettore: finge di essere il venue.
//
// ⚠ SOLO 127.0.0.1 e solo GET: il server non ha rotte di scrittura, e un ordine non passa da qui.
const http = require('http');
const PORTA_CLOB = Number(process.env.BANCO_PORTA_CLOB || 45871);
let SERVER_CLOB = null;
function avviaClobSimulato(venue) {
  SERVER_CLOB = http.createServer((req, res) => {
    const m = /^\/markets\/([^?]+)/.exec(req.url || '');
    res.setHeader('content-type', 'application/json');
    if (!m) { res.statusCode = 404; return void res.end(JSON.stringify({ error: 'rotta non servita dal banco' })); }
    const mk = venue.mercato(decodeURIComponent(m[1]));
    if (!mk) { res.statusCode = 404; return void res.end(JSON.stringify({ error: 'not found' })); }
    // La forma e' quella del CLOB vero, nei soli campi che `leggiVenue` e `verificaMercatiAlVenue`
    // leggono: `closed`, `active`, `accepting_orders`, `rewards.{rates,max_spread,min_size}`,
    // `end_date_iso`. Inventare altri campi darebbe l'illusione di una fedelta' che non e' stata provata.
    res.end(JSON.stringify({
      condition_id: mk.conditionId, closed: !!mk.chiuso, active: !mk.chiuso,
      accepting_orders: !mk.chiuso, end_date_iso: new Date(mk.scadeMs).toISOString(),
      minimum_tick_size: mk.tick,
      rewards: { rates: [{ asset_address: 'sim', rewards_daily_rate: 100 }],
        max_spread: mk.bandaCents, min_size: mk.minSize },
    }));
  });
  try { SERVER_CLOB.listen(PORTA_CLOB, '127.0.0.1'); }
  catch (e) { throw new Error(`il CLOB simulato non si e' potuto avviare sulla porta ${PORTA_CLOB}: ${e.message}`); }
  SERVER_CLOB.on('error', (e) => { throw new Error(`CLOB simulato in errore sulla porta ${PORTA_CLOB}: ${e.message}`); });
  SERVER_CLOB.unref();
  process.env.POLY_CLOB_BASE = `http://127.0.0.1:${PORTA_CLOB}`;
  return `http://127.0.0.1:${PORTA_CLOB}`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// L'OROLOGIO VIRTUALE — la quarta sostituzione
// ════════════════════════════════════════════════════════════════════════════════════════════════════
// Si parte dall'ora VERA: i file di stato copiati portano timestamp reali, e un orologio nel futuro li
// farebbe sembrare tutti freschi mentre uno nel passato li farebbe sembrare tutti scaduti.
const OROLOGIO = { ora: Date.now() };
const DateNowVero = Date.now;
Date.now = () => OROLOGIO.ora;

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// IL VENUE SIMULATO
// ════════════════════════════════════════════════════════════════════════════════════════════════════
class VenueSimulato {
  constructor() {
    this.mercati = new Map();
    this.ordini = new Map();
    this.posizioni = new Map();   // tokenId → {size, costoTotale, nascondiPerCicli}
    this.saldo = 500;
    this.seq = 0;
    this.eventi = [];
    this.scenari = {
      rifiutaPostOnlyCheIncrocia: true,   // il venue VERO lo fa sempre: e' il fatto, non uno scenario
      avgPriceNascostoPerCicli: 0,
      mergeFallisce: false,
      feedTace: false,
      saldoIlleggibile: false,
    };
  }

  get ora() { return OROLOGIO.ora; }
  log(tipo, dato) { this.eventi.push({ ora: OROLOGIO.ora, tipo, ...dato }); }
  /** Avanza l'orologio VIRTUALE (che e' `Date.now` per tutto il processo) e riscrive il feed. */
  avanza(ms) { OROLOGIO.ora += ms; this.scadenzeGTD(); this.pubblicaFeed(); }

  mercato(cid) { return this.mercati.get(String(cid).toLowerCase()) || null; }

  creaMercato({ conditionId, mid = 0.40, tick = 0.01, minSize = 50, bandaCents = 4.5, oreAllaScadenza = 48, negRisk = false, categoria = 'elections', question = 'banco' }) {
    const cid = String(conditionId).toLowerCase();
    const m = { conditionId: cid, tokenId: `tok-yes-${cid.slice(2, 10)}`, tokenIdNo: `tok-no-${cid.slice(2, 10)}`,
      tick, minSize, bandaCents, mid, negRisk, chiuso: false, categoria, question,
      scadeMs: OROLOGIO.ora + oreAllaScadenza * 3_600_000 };
    this.aggiornaBook(m, mid);
    this.mercati.set(cid, m);
    this.pubblicaFeed();
    // ⚠ LO STORICO DEI MID FA PARTE DEL VENUE, e senza di lui il piano non nasce: l'allocatore conta i
    // `mercati con storico` (`allocator.js:1380`, `J.byMarket.size`) e un universo con zero mercati
    // coperti non e' «nessun mercato conviene», e' «dato mancante» — quindi `runReallocCycle` si ferma
    // con «un universo vuoto non e' un piano vuoto» (`realloc-cycle.js:282`). Misurato alla terza corsa.
    // Si semina la storia che agent34 avrebbe scritto: un campione ogni 75 s, come in produzione.
    // ⚠ QUANTA STORIA: il ricalcolo leggero del mini-ciclo guarda una finestra di 6 ORE
    // (`FINESTRA_LEGGERA_ORE`), quella del ciclo pesante e' 48. Seminare 30 campioni (37 minuti) bastava
    // al ciclo pesante e NON al leggero — misurato: il ciclo da 6 h trovava 1 mercato ammissibile e il
    // mini-ciclo «nessun mercato ammissibile adesso», e il giro si fermava al passo 3. Si semina una
    // finestra di OTTO ore, un campione ogni 75 s come agent34.
    this.seminaStorico(m, Math.ceil((8 * 3600) / 75));
    return m;
  }

  aggiornaBook(m, midYes) {
    const t = m.tick;
    const q = (p) => Math.max(0.001, Math.min(0.999, Math.round(p / t) * t));
    m.mid = midYes;
    m.book = {
      yes: { scoringMid: q(midYes), bestBid: q(midYes - t), bestAsk: q(midYes + t),
        bids: [{ price: q(midYes - t), size: 400 }, { price: q(midYes - 2 * t), size: 700 }],
        asks: [{ price: q(midYes + t), size: 400 }, { price: q(midYes + 2 * t), size: 700 }] },
      no: { scoringMid: q(1 - midYes), bestBid: q(1 - midYes - t), bestAsk: q(1 - midYes + t),
        bids: [{ price: q(1 - midYes - t), size: 400 }, { price: q(1 - midYes - 2 * t), size: 700 }],
        asks: [{ price: q(1 - midYes + t), size: 400 }, { price: q(1 - midYes + 2 * t), size: 700 }] },
    };
  }

  /** I campioni che agent34 avrebbe scritto: `data/mid-history-<giorno>.jsonl`, un campione ogni 75 s. */
  seminaStorico(m, quanti = 1, indietro = true) {
    const righe = [];
    for (let i = quanti - 1; i >= 0; i -= 1) {
      const ts = OROLOGIO.ora - (indietro ? i * 75_000 : 0);
      const b = m.book;
      righe.push(JSON.stringify({ ts: new Date(ts).toISOString(), marketId: m.conditionId,
        tokenIdYes: m.tokenId, adjMid: b.yes.scoringMid, plainMid: b.yes.scoringMid,
        bestBid: b.yes.bestBid, bestAsk: b.yes.bestAsk,
        bidDepthInBand: b.yes.bids.reduce((a, x) => a + x.size * x.price, 0),
        askDepthInBand: b.yes.asks.reduce((a, x) => a + x.size * x.price, 0),
        bandLow: +(b.yes.scoringMid - m.bandaCents / 200).toFixed(4),
        bandHigh: +(b.yes.scoringMid + m.bandaCents / 200).toFixed(4), tick: m.tick,
        levels: b.yes.bids.map((x, k) => ({ index: k + 1, bidPrice: x.price, bidSizeAtLevel: x.size,
          askPrice: b.yes.asks[k] ? b.yes.asks[k].price : null,
          askSizeAtLevel: b.yes.asks[k] ? b.yes.asks[k].size : null })) }));
    }
    const giorno = new Date(OROLOGIO.ora).toISOString().slice(0, 10);
    fs.appendFileSync(path.join(ROOT, 'data', `mid-history-${giorno}.jsonl`), righe.join('\n') + '\n');
  }

  muoviMid(cid, delta) {
    const m = this.mercato(cid); if (!m) return;
    this.aggiornaBook(m, Math.max(0.02, Math.min(0.98, m.mid + delta)));
    this.log('mid-mosso', { conditionId: cid, mid: m.mid });
    this.pubblicaFeed();
    this.seminaStorico(m, 1, false);
  }

  latoDi(m, tokenId) { return String(tokenId) === String(m.tokenIdNo) ? 'no' : 'yes'; }

  // ── I DUE FILE DEL FEED, NELLA FORMA CHE `resolveMarketRules` LEGGE ───────────────────────────────
  // ⚠ E' LA FOTOGRAFIA, NON LA LETTURA: si scrive il file e si lascia leggere alla funzione VERA, con il
  // suo ripiego sul catalogo, la sua preferenza per il book vivo e la sua eta' del mid. Passare `books`
  // e `norm` come dep avrebbe scavalcato proprio quella funzione — ed e' cio' che il banco vecchio
  // faceva, perche' `closeTask` non accetta dep e quindi era l'unico modo di ricablarlo.
  pubblicaFeed() {
    if (this.scenari.feedTace) {
      // Il feed che tace non e' un file vuoto: e' un file che non si aggiorna piu'. Si lascia dov'e'.
      return;
    }
    const books = { markets: {}, updatedMs: OROLOGIO.ora, updatedAt: new Date(OROLOGIO.ora).toISOString() };
    const norm = { markets: [], updatedMs: OROLOGIO.ora, updatedAt: new Date(OROLOGIO.ora).toISOString() };
    for (const m of this.mercati.values()) {
      // ⚠ LA FORMA E' UN CONTRATTO, E QUESTA E' QUELLA VERA: `resolveMarketDepth:498` legge
      // `books.markets[id].<lato>.levels.bids`, e `resolveMarketRules` legge `bm.<lato>.bestBid` per il
      // tocco. La prima stesura pubblicava `bm.books.yes.bids` — le regole si leggevano (mid e banda
      // c'erano) ma la SCALA no, e il motore rifiutava ogni riprezzo con
      // «mai-primo-sul-libro: miglior prezzo altrui non leggibile: il chiamante non ha passato la scala
      // del book (errore di cablaggio interno)». Il messaggio accusava il cablaggio; la colpa era della
      // fotografia. E' il caso piu' insidioso di tutti: una fixture sbagliata che fa dire al codice
      // «errore interno».
      const lato = (b) => ({ bestBid: b.bestBid, bestAsk: b.bestAsk, scoringMid: b.scoringMid,
        levels: { bids: b.bids, asks: b.asks } });
      books.markets[m.conditionId] = { marketId: m.conditionId, conditionId: m.conditionId,
        tokenId: m.tokenId, tokenIdNo: m.tokenIdNo, mid: m.book.yes.scoringMid, updatedMs: OROLOGIO.ora,
        ageMs: 0, live: true,
        maxSpread: m.bandaCents, tickSize: m.tick, minSize: m.minSize, negRisk: m.negRisk,
        bestBid: m.book.yes.bestBid, bestAsk: m.book.yes.bestAsk,
        yes: lato(m.book.yes), no: lato(m.book.no) };
      norm.markets.push({ marketId: m.conditionId, conditionId: m.conditionId,
        // `updatedAt` PER RIGA: e' il ripiego dell'eta' del mid quando il book live non la porta.
        updatedAt: new Date(OROLOGIO.ora).toISOString(),
        question: m.question || 'banco',
        // ⚠ `category` SERVE: `selezione-mercati.valutaAmmissibilita` esclude una riga senza categoria
        // (`categoria-non-leggibile`) come controllo di qualita' della riga. Alla prima corsa il banco
        // si fermava al passo 3 con «0 mercati ammissibili su 1 valutati» — e la causa era questa
        // fixture, non il bot. Settima volta che una fixture si maschera da regola morta.
        category: m.categoria || 'elections',
        tokenId: m.tokenId, tokenIdNo: m.tokenIdNo, tickSize: m.tick, minSize: m.minSize,
        maxSpread: m.bandaCents, rewardsMinSize: m.minSize, rewardsMaxSpread: m.bandaCents,
        negRisk: m.negRisk, rewardsDailyRate: 100, mid: m.book.yes.scoringMid,
        bestBid: m.book.yes.bestBid, bestAsk: m.book.yes.bestAsk, rewardProgramme: 'active',
        hasRewards: true, closed: !!m.chiuso, acceptingOrders: !m.chiuso,
        endDate: new Date(m.scadeMs).toISOString(), endDateClob: new Date(m.scadeMs).toISOString(),
        sides: { yes: { existing_depth_usd: 400 * m.book.yes.bestBid }, no: { existing_depth_usd: 400 * m.book.no.bestBid } },
        levels: { 500: { grossRewardDay: 10, netRewardDay: 8, share: 0.2 } } });
    }
    fs.writeFileSync(process.env.MAKER_FEED_BOOKS_FILE, JSON.stringify(books));
    fs.writeFileSync(process.env.MAKER_FEED_BOARD_FILE, JSON.stringify(norm));
    // ⚠ E IL TERZO FILE: `data/liquidity-rewards.json`, che NON e' dirottabile da env ed e' quello che
    // leggono la SELEZIONE (`agent41.leggiBoardReward`) e il pianificatore. Senza questa riga il banco
    // avrebbe due mondi: le regole del mercato dalla fotografia simulata, e la scelta dei mercati dal
    // board REALE — cioe' la selezione avrebbe scelto mercati che il venue simulato non conosce.
    // Si scrive nel `data/` del WORKTREE, che e' una copia: il board vero non viene toccato.
    fs.writeFileSync(path.join(ROOT, 'data', 'liquidity-rewards.json'),
      JSON.stringify({ meta: { generatedAt: new Date(OROLOGIO.ora).toISOString(), source: 'banco' }, markets: norm.markets }));
  }

  // ── IL PIAZZAMENTO ────────────────────────────────────────────────────────────────────────────
  postOrder(spec) {
    const m = [...this.mercati.values()].find((x) => x.tokenId === spec.tokenId || x.tokenIdNo === spec.tokenId);
    if (!m) return { ok: false, gate: 'venue', reason: 'token sconosciuto al venue simulato' };
    if (m.chiuso) return { ok: false, gate: 'venue', reason: 'market closed' };
    const lato = this.latoDi(m, spec.tokenId);
    const b = m.book[lato];

    const incrocia = spec.side === 'SELL' ? spec.price <= b.bestBid + 1e-9 : spec.price >= b.bestAsk - 1e-9;
    if (spec.postOnly !== false && incrocia) {
      this.log('rifiuto-post-only', { tokenId: spec.tokenId, side: spec.side, price: spec.price, bestBid: b.bestBid });
      return { ok: false, gate: 'venue', reason: 'invalid post-only order: order crosses book' };
    }
    if (spec.side === 'SELL') {
      const p = this.posizioni.get(spec.tokenId);
      if (!p || p.size + 1e-9 < spec.size) {
        this.log('rifiuto-saldo', { tokenId: spec.tokenId, richiesto: spec.size, posseduto: p ? p.size : 0 });
        return { ok: false, gate: 'venue', reason: 'not enough balance / allowance' };
      }
    }
    const id = `sim-${++this.seq}`;
    const scadenza = spec.orderType === 'GTC' ? null : OROLOGIO.ora + (Number(spec.expirationSec || 1380) * 1000);
    this.ordini.set(id, { orderId: id, tokenId: spec.tokenId, marketId: m.conditionId, lato,
      side: spec.side, price: spec.price, size: spec.size, sizeMatched: 0, vivo: true,
      nato: OROLOGIO.ora, scadeA: scadenza });
    this.log('ordine-nato', { orderId: id, tokenId: spec.tokenId, side: spec.side, price: spec.price, size: spec.size });
    if (spec.postOnly === false && incrocia) this.eseguiSubito(id);
    return { ok: true, orderId: id, status: 'live' };
  }

  cancelOrder(orderId) {
    const o = this.ordini.get(orderId);
    if (!o || !o.vivo) return { ok: true, cancelled: 0, alreadyGone: true };
    o.vivo = false; o.morteMotivo = 'cancellato';
    this.log('ordine-cancellato', { orderId });
    return { ok: true, cancelled: 1 };
  }

  ordiniVivi(cid) {
    return [...this.ordini.values()].filter((o) => o.vivo && (!cid || o.marketId === String(cid).toLowerCase()))
      .map((o) => ({ orderId: o.orderId, id: o.orderId, marketId: o.marketId, conditionId: o.marketId,
        tokenId: o.tokenId, asset_id: o.tokenId, side: o.side,
        price: o.price, size: o.size, original_size: o.size, sizeMatched: o.sizeMatched, size_matched: o.sizeMatched,
        sizeRemaining: +(o.size - o.sizeMatched).toFixed(6), source: 'manual-ui',
        secondsToExpiry: o.scadeA ? Math.max(0, Math.round((o.scadeA - OROLOGIO.ora) / 1000)) : null,
        expiresAtMs: o.scadeA || null, createdMs: o.nato, orderType: o.scadeA ? 'GTD' : 'GTC' }));
  }

  // ── I FILL ────────────────────────────────────────────────────────────────────────────────────
  eseguiSubito(orderId) { this.riempi(orderId, this.ordini.get(orderId).size); }

  riempi(orderId, quanto) {
    const o = this.ordini.get(orderId);
    if (!o || !o.vivo) return null;
    const q = Math.min(quanto, o.size - o.sizeMatched);
    if (!(q > 0)) return null;
    o.sizeMatched += q;
    if (o.sizeMatched + 1e-9 >= o.size) { o.vivo = false; o.morteMotivo = 'riempito'; }
    if (o.side === 'BUY') {
      const p = this.posizioni.get(o.tokenId) || { size: 0, costoTotale: 0, nascondiPerCicli: this.scenari.avgPriceNascostoPerCicli };
      p.size += q; p.costoTotale += q * o.price;
      this.posizioni.set(o.tokenId, p);
      this.saldo -= q * o.price;
    } else {
      const p = this.posizioni.get(o.tokenId);
      if (p) { p.size -= q; p.costoTotale -= q * (p.costoTotale / Math.max(p.size + q, 1e-9)); if (p.size <= 1e-9) this.posizioni.delete(o.tokenId); }
      this.saldo += q * o.price;
    }
    this.log('fill', { orderId, tokenId: o.tokenId, side: o.side, quanto: q, price: o.price, parziale: o.vivo === true });
    return { orderId, quanto: q, price: o.price };
  }

  scadenzeGTD() {
    for (const o of this.ordini.values()) {
      if (o.vivo && o.scadeA && OROLOGIO.ora >= o.scadeA) {
        o.vivo = false; o.morteMotivo = 'expired';
        this.log('ordine-scaduto-gtd', { orderId: o.orderId, tokenId: o.tokenId });
      }
    }
  }

  merge(conditionId, quanteShare) {
    const m = this.mercato(conditionId);
    if (!m) return { ok: false, reason: 'mercato sconosciuto' };
    if (this.scenari.mergeFallisce) {
      this.log('merge-fallito', { conditionId, quanteShare });
      return { ok: false, reason: 'submit rifiutato dal relayer (HTTP 400)' };
    }
    const y = this.posizioni.get(m.tokenId); const n = this.posizioni.get(m.tokenIdNo);
    const q = Math.min(quanteShare, y ? y.size : 0, n ? n.size : 0);
    if (!(q > 0)) return { ok: false, reason: 'la coppia non e\' completa: niente da fondere' };
    for (const [tok, p] of [[m.tokenId, y], [m.tokenIdNo, n]]) {
      p.size -= q; p.costoTotale = Math.max(0, p.costoTotale - q * (p.costoTotale / Math.max(p.size + q, 1e-9)));
      if (p.size <= 1e-9) this.posizioni.delete(tok);
    }
    this.saldo += q;
    this.log('merge-eseguito', { conditionId, quanteShare: q, saldo: +this.saldo.toFixed(2) });
    return { ok: true, transactionID: `sim-tx-${++this.seq}`, quanteShare: q };
  }

  sparizioneEsterna(tokenId, quanto) {
    const p = this.posizioni.get(tokenId);
    if (!p) return;
    p.size -= quanto;
    if (p.size <= 1e-9) this.posizioni.delete(tokenId);
    this.log('sparizione-esterna', { tokenId, quanto });
  }

  chiudiMercato(cid) {
    const m = this.mercato(cid); if (!m) return;
    m.chiuso = true; this.log('mercato-chiuso', { conditionId: cid }); this.pubblicaFeed();
  }

  /** Le posizioni come le pubblica il venue, con l'avgPrice che puo' non essere ancora arrivato. */
  posizioniVenue() {
    const out = [];
    for (const [tok, p] of this.posizioni) {
      const m = [...this.mercati.values()].find((x) => x.tokenId === tok || x.tokenIdNo === tok);
      const nascondi = p.nascondiPerCicli > 0;
      if (nascondi) p.nascondiPerCicli -= 1;
      out.push({ tokenId: tok, asset: tok, conditionId: m ? m.conditionId : null, marketId: m ? m.conditionId : null,
        size: +p.size.toFixed(6),
        avgPrice: nascondi ? 0 : +(p.costoTotale / Math.max(p.size, 1e-9)).toFixed(6),
        curPrice: m ? m.book[this.latoDi(m, tok)].scoringMid : 0,
        title: 'banco' });
    }
    return out;
  }

  /** Azzera venue e memoria: nessuno scenario deve dipendere dagli avanzi di quello prima. */
  azzera(motivo = 'reset fra scenari') {
    let ordini = 0;
    for (const o of this.ordini.values()) if (o.vivo) { o.vivo = false; o.morteMotivo = 'azzerato-dal-banco'; ordini += 1; }
    const posizioni = this.posizioni.size;
    const share = [...this.posizioni.values()].reduce((a, p) => a + Number(p.size || 0), 0);
    this.posizioni.clear();
    this.log('banco-azzerato', { motivo, ordiniUccisi: ordini, posizioniButtate: posizioni, shareButtate: +share.toFixed(4) });
    return { ordiniUccisi: ordini, posizioniButtate: posizioni, shareButtate: +share.toFixed(4) };
  }
}

const VENUE = new VenueSimulato();
const CLOB_SIMULATO = avviaClobSimulato(VENUE);

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// LE TRE SOSTITUZIONI IN `require.cache`
// ════════════════════════════════════════════════════════════════════════════════════════════════════
function sostituisci(percorsoRelativo, exports) {
  // ⚠ IL PERCORSO SI RISOLVE PRIMA: `require()` risolve e solo dopo consulta la cache, quindi registrare
  // la cache su un file che non esiste fallisce con `Cannot find module` — e il guasto arriva travestito
  // da `gate: adapter-threw`, cioe' una diagnosi che punta al posto sbagliato.
  const via = require.resolve(path.join(ROOT, percorsoRelativo));
  require.cache[via] = { id: via, filename: via, loaded: true, exports, children: [], paths: [] };
  return via;
}

// 1 · IL DENARO DEL VENUE. Senza questa, `leggiSaldoUsd` fa una lettura ON-CHAIN via RPC: nel worktree
//     non c'e' `.env`, quindi fallirebbe, e agent41 si fermerebbe a «saldo non affidabile» — un banco
//     che non arriva al piano perche' non sa quanti soldi ci sono.
sostituisci('lib/maker/saldo-cache.js', {
  leggiSaldoUsd: async () => (VENUE.scenari.saldoIlleggibile
    ? { usd: null, affidabile: false, motivo: 'banco: saldo dichiarato illeggibile', at: OROLOGIO.ora }
    : { usd: +VENUE.saldo.toFixed(2), affidabile: true, motivo: null, at: OROLOGIO.ora, fonte: 'banco' }),
  creaCacheSaldo: () => ({ leggi: async () => ({ usd: +VENUE.saldo.toFixed(2), affidabile: true }) }),
  SALDO_CACHE_TTL_MS: 5_000,
});

// 2 · LA CATENA. ⚠ SENZA QUESTA IL BANCO FIRMA UN MERGE VERO: `auto-close.js:676` cade sul relayer
//     vero quando `deps.mergeOnChain` non e' passata, e `closeTask` NON la passa.
sostituisci('lib/maker/ctf-relayer.js', {
  CTF_RELAYER_ENABLED: true,
  mergePosition: async (marketId, size, opts = {}) => {
    const r = VENUE.merge(marketId, size);
    if (!r.ok) throw new Error(r.reason);
    // La FORMA e' un contratto: `fondiCoppia` accetta il merge solo se `eseguito === true`.
    return { eseguito: true, transactionID: r.transactionID, transactionHash: `0x${'ab'.repeat(32)}`,
      stato: 'CONFIRMED', size: r.quanteShare, negRisk: opts.negRisk };
  },
  splitPosition: async () => { throw new Error('banco: lo split non ha chiamanti e non si simula'); },
  redeemPosition: async () => { throw new Error('banco: il riscatto non e\' in questo scenario'); },
  mostraOperazione: () => ({}), leggiNonce: async () => 0,
});

// 4 · LO SNAPSHOT DELLE POSIZIONI SU FILE. ⚠ NON passa dall'adapter: `snapshotPosizioniTask` chiama
//     `manual-reset.fetchVenuePositions`, che interroga la data-api di Polymarket via HTTP con
//     l'indirizzo del funder. Nel worktree non c'e' `.env`, quindi l'indirizzo non si risolve e lo
//     snapshot resta illeggibile — misurato alla prima corsa: «indirizzo del conto non risolvibile»
//     (`lib/maker/manual-reset.js:159`), e senza posizioni l'auto-close non ha niente da chiudere.
//     Le posizioni SONO il venue, quindi la sostituzione sta dentro il seam.
sostituisci('lib/safety/venue-positions-snapshot.js', {
  readVenuePositions: () => ({ readable: true, ageMs: 0, at: OROLOGIO.ora, positions: VENUE.posizioniVenue() }),
  readVenuePositionsConRefresh: async () => ({ readable: true, ageMs: 0, at: OROLOGIO.ora,
    positions: VENUE.posizioniVenue(), rinfrescato: false, motivoRefresh: null }),
  writeVenuePositions: () => ({ ok: true, scritto: false, motivo: 'banco: le posizioni vengono dal venue simulato' }),
  SNAPSHOT_FILE: path.join(ROOT, 'data', 'banco-feed', 'venue-positions.json'), MAX_AGE_MS: 180_000,
});

// 7 · L'ADAPTER DEL VENUE — il seam vero: tutto cio' che sta sopra e' produzione.
function adapterSimulato(opts = {}) {
  const audit = opts.auditSink || (() => {});
  const leggiAllowlist = () => {
    try { return require(path.join(ROOT, 'lib/maker/auto-reprice-config')).readAutoRepriceConfig({}).liveMinMarketIds || []; }
    catch { return []; }
  };
  return {
    kind: 'maker', mode: opts.mode || 'live-min', dryRun: false, canWrite: true,
    placement: 'send', liveMinCapUsd: opts.liveMinCapUsd, liveMinMarket: opts.liveMinMarket || '',
    orderTtlSeconds: opts.orderTtlSeconds,
    get allowedMarketIds() { return leggiAllowlist(); },
    async postOrder(s) {
      // I GATE VERI DELL'ADAPTER PRIMA DI ACCETTARE: un banco che facesse passare un ordine che in
      // produzione l'adapter rifiuta mentirebbe nella direzione peggiore.
      const g = ADAPTER_VERO.evaluateLiveMinMarketGate({ mode: 'live-min', liveMinMarket: opts.liveMinMarket,
        allowedMarketIds: leggiAllowlist(), marketId: s.marketId, side: s.side, size: s.size,
        heldSize: (VENUE.posizioni.get(s.tokenId) || {}).size });
      if (!g.allow) {
        audit({ op: 'postOrder', outcome: g.gate, requested: s, reason: g.reason });
        return { ok: false, gate: g.gate, reason: g.reason };
      }
      const r = VENUE.postOrder(s);
      audit({ op: 'postOrder', outcome: r.ok ? 'ok' : `reject-${r.gate || 'venue'}`,
        requested: s, response: r, reason: r.reason || null });
      return r.ok ? { ok: true, sent: true, orderId: r.orderId, status: r.status } : r;
    },
    async cancelOrder({ orderId }) {
      const r = VENUE.cancelOrder(orderId);
      audit({ op: 'cancelOrder', outcome: 'ok', requested: { orderId }, response: r });
      return r;
    },
    // ⚠ IL CHIAMANTE VERO PASSA UNA STRINGA: `manual-order.js` fa `adapter.listOpenOrders(marketId ||
    // undefined)`. Un parametro destrutturato (`{ marketId } = {}`) su una stringa da' `undefined`, quindi
    // il filtro sparisce e si restituisce TUTTO — un banco piu' permissivo del venue. Si accettano
    // entrambe le forme, come fa l'adapter vero.
    async listOpenOrders(arg) {
      const marketId = typeof arg === 'string' ? arg : (arg && arg.marketId) || undefined;
      const orders = VENUE.ordiniVivi(marketId);
      if (VERBOSO) console.log(`  [banco] listOpenOrders(${JSON.stringify(arg)}) → ${orders.length}`);
      return { ok: true, orders, simulated: false };
    },
    async getBalance() { return { ok: true, usd: VENUE.saldo }; },
    async getPositions() { return { ok: true, positions: VENUE.posizioniVenue() }; },
  };
}

// 6 · L'ADAPTER DI SOLA LETTURA/CANCELLAZIONE — ED E' UN MODULO DIVERSO, che e' la scoperta piu' utile
//     di questa stesura: la corsia manuale PIAZZA con `venues/polymarket-clob-maker/adapter` ma LEGGE e
//     CANCELLA con `venues/polymarket-clob/adapter` (`manual-order.js:58`). Sostituire solo il primo da'
//     un sistema che piazza e poi non vede i propri ordini: misurato, `listManualOrders` rispondeva
//     `count: 0` con QUATTRO ordini a libro, e `auto-reprice` dichiarava `considered: 0` — un blocco che
//     sembrava di `decideReprice` e invece era un adapter non sostituito.
sostituisci('lib/venues/polymarket-clob/adapter.js', {
  ALLOWED_OPS: Object.freeze(['listOpenOrders', 'cancelOrder', 'cancelMarketOrders', 'healthCheck', 'cancelResting', 'exitFilledLeg']),
  createCancelOnlyAdapter: (opts = {}) => {
    const audit = opts.auditSink || (() => {});
    return {
      kind: 'cancel-only', dryRun: false, canWrite: true,
      // ⚠ La firma vera prende una STRINGA (`adapter.js:117`), non un oggetto: si accettano entrambe.
      async listOpenOrders(arg) {
        const marketId = typeof arg === 'string' ? arg : (arg && arg.marketId) || undefined;
        const orders = VENUE.ordiniVivi(marketId);
        if (VERBOSO) console.log(`  [banco] (cancel-only) listOpenOrders(${JSON.stringify(arg)}) → ${orders.length}`);
        return { ok: true, orders, simulated: false };
      },
      async cancelOrder(arg) {
        const orderId = typeof arg === 'string' ? arg : (arg && arg.orderId);
        const r = VENUE.cancelOrder(orderId);
        audit({ op: 'cancelOrder', outcome: 'ok', requested: { orderId }, response: r });
        return r;
      },
      async cancelMarketOrders(marketId) {
        let n = 0;
        for (const o of VENUE.ordiniVivi(marketId)) { if (VENUE.cancelOrder(o.orderId).cancelled) n += 1; }
        return { ok: true, cancelled: n };
      },
      async healthCheck() { return { ok: true }; },
    };
  },
  _internal: {},
});

let ADAPTER_VERO = null;
{
  const via = require.resolve(path.join(ROOT, 'lib/venues/polymarket-clob-maker/adapter.js'));
  ADAPTER_VERO = require(via);
  require.cache[via] = { id: via, filename: via, loaded: true, children: [], paths: [],
    exports: { ...ADAPTER_VERO, createMakerAdapter: adapterSimulato, createCancelOnlyAdapter: adapterSimulato } };
}

// 7 · LE POSIZIONI DALLA DATA-API — la SESTA porta verso il venue, e l'ultima che mancava.
//     ⚠ E VA SOSTITUITA PER ULTIMA. Questo blocco fa `require('lib/maker/manual-reset')` per tenere il
//     resto del modulo vero, e `manual-reset` tira dentro `manual-order`, che a `:58` DESTRUTTURA
//     `createCancelOnlyAdapter` al caricamento. Messo prima delle due sostituzioni degli adapter,
//     `manual-order` catturava quello VERO: misurato, `listManualOrders` tornava a `count: 0` con due
//     ordini a libro e il giro si rifermava al passo 4. L'ordine delle sostituzioni e' parte del seam.
//     `closeTask.readPositions` non passa da `readVenuePositions`: passa da
//     `manual-reset.fetchVenuePositions` (`agent40:494`), che interroga
//     `https://data-api.polymarket.com/positions?user=<funder>` — e `DATA_API` e' un letterale in quattro
//     moduli, senza env. Senza questa sostituzione il ciclo di chiusura vedeva `positions: 0` con DUE
//     gambe possedute al venue, e non fondeva la coppia: misurato, `refertoCloseTask` diceva
//     `{"positions":0,"covered":0,"placed":0}` mentre il venue ne teneva 61,2 + 61,2.
//     Si sostituisce SOLO quella funzione: il resto di `manual-reset` (il reset, il confronto incrociato)
//     resta il codice vero.
{
  const vero = require(path.join(ROOT, 'lib/maker/manual-reset'));
  sostituisci('lib/maker/manual-reset.js', {
    ...vero,
    fetchVenuePositions: async () => ({ ok: true, positions: VENUE.posizioniVenue(),
      reason: `banco: ${VENUE.posizioni.size} posizioni dal venue simulato`, tentativi: 1 }),
  });
}


module.exports = { VenueSimulato, VENUE, OROLOGIO, DateNowVero, sostituisci, ROOT, VIVO, OUT, VERBOSO, IDENTITA, DIR_FEED,
  CLOB_SIMULATO, chiudiClobSimulato: () => { try { SERVER_CLOB.close(); } catch { /* gia' chiuso */ } } };

if (require.main === module) {
  console.log('Questo file e\' la base del banco. Lo scenario si lancia con:');
  console.log('  node scripts/ricerca/banco-scenari.js');
  console.log(`\nidentita' verificata: alberi ${IDENTITA.alberiConfrontati.join('/')} identici byte per byte a ${VIVO} (commit worktree ${String(IDENTITA.commitWorktree).slice(0, 12)}, vivo ${String(IDENTITA.commitVivo).slice(0, 12)})`);
}

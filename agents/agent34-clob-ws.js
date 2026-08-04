#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// agent34-clob-ws — LIVE Polymarket CLOB order books for liquidity-rewards.
//
// HONEST ENGINE / SAFETY:
//   • Read-only. The market channel is public + keyless and carries NO order path.
//     This process cannot place, cancel, or sign anything. €0 — reuses the `ws`
//     package already in the tree (no new dependency).
//   • A book is served as LIVE only when it is seeded, fresh, and not flagged for
//     resnapshot. Otherwise it is written as STALE and consumers fall back to the
//     15-min REST path and are TOLD they are on the slower path. We never label a
//     book behind a dead/lagging socket as live.
//   • Failure isolation: this is its OWN pm2 process, NOT folded into agent27, so a
//     dead socket can never stall the news-guard or the dashboard. autorestart:true.
//   • Bounded: subscribes to reward-eligible markets (capped at SUBSCRIPTION_CAP),
//     PLUS every market the operator enabled by hand (cfg.enabledMarketIds — see
//     unionEnabledMarkets), PLUS persisted user legs. Never "everything": the whole
//     set is bounded by TOTAL_MARKET_CAP.
//
// Reward math is NOT changed here. We compute BOTH the plain mid (what the live UI
// shows today) and the dust-filtered adjusted mid (what actually scores rewards)
// and write both, plus their difference, so the divergence can be MEASURED and
// reported before any consumer switches. lib/rewardScore.js remains the SSOT.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { ClobWsClient } = require('../lib/clob-ws/client');
const { LiveBookStore } = require('../lib/clob-ws/live-book');
const { httpGet } = require('../lib/httpGet');
const { adjustedMid, parseOrders, scoreBook, quadraticUserShare } = require('../lib/rewardScore');
const { levelsInBand } = require('../lib/reward-layers'); // per-level in-band depth (multi-layer persistence)
const REWARD_REF_CAPITAL = 1000; // MUST match lib/rewards-normalize REWARD_REF_CAPITAL (refShare capital)
const { decideDrift } = require('../lib/rewards-drift');
const { loadNewsGuardConfig } = require('../lib/news-guard/config');
const { appendDriftShadowRecord } = require('../lib/news-guard/shadow-log');
const { estRewardForgone } = require('../lib/news-guard/action');

// ── config ──
const WATCHLIST_FILE = '/root/prediction-market/data/liquidity-rewards.json'; // agent24 output
const NORMALIZED_FILE = '/tmp/liquidity-rewards.json';                        // normalized (carries rewardScore)
const OUT_FILE       = '/tmp/clob-live-books.json';
const HB_FILE        = '/tmp/agent-heartbeats.json';
// Self-describing COVERAGE manifest for the mid-history journal. The journal only covers the markets
// agent34 subscribes to (a subset of the rewards universe), so a backtest must state that. This records
// the universe size AT COLLECTION TIME (not a later drifting feed read) so the mandated coverage header
// (lib/mid-history-coverage) is honest for the day the data was collected.
const COVERAGE_FILE  = path.join(__dirname, '..', 'data', 'mid-history-coverage.json');
const CLOB_BASE      = 'https://clob.polymarket.com';

// ── THE TWO BOUNDS, AND WHICH ONE IS THE VENUE'S ────────────────────────────────────────────────────
// SUBSCRIPTION_CAP is how many REWARD-BOARD markets we take from agent24's watchlist. It is OURS, not the
// venue's: it was sized against this box's budgets (RSS ~5.9 KB/subscription, and the mid-history journal's
// 50 MB/day disk budget was measured AT 60 markets — see MID_HISTORY_INTERVAL_MS below), and the watchlist
// is routinely larger than it (113 markets on 2026-07-31), so it genuinely truncates the board.
//
// TOTAL_MARKET_CAP is the bound on the WHOLE subscribed set (board + operator-enabled + legs). The venue
// publishes NO documented per-connection subscription maximum — docs.polymarket.com/developers/CLOB/
// websocket says nothing about a maximum number of assets_ids, re-checked 2026-07-31 — so the "~250/conn"
// figure this file used to cite was an assumption, never a measured venue limit. It is kept as a
// deliberately conservative asset budget for ONE connection, and stated as ours rather than the venue's.
// If the desired set ever exceeds it, we do NOT silently drop a market the operator chose by hand: the
// weakest reward-board market (lowest rewardsDailyRate) is evicted instead, and the eviction is logged.
// 60 → 90 il 3 agosto 2026, e questa è l'aritmetica per intero. Il board pubblicato quel giorno era di
// 118 mercati e a 60 se ne copriva la metà, ordinati per MONTEPREMI; l'ottimizzatore però sceglie per
// reward per dollaro e pescava sotto quella soglia (Spider-Man era in posizione 115), quindi i mercati
// che il piano proponeva non avevano storico. La corsia del piano (unionPlanMarkets) tiene caldi quelli
// GIÀ noti all'ottimizzatore; questo numero serve all'altra metà del problema, la SCOPERTA: un mercato
// senza nessuno storico non è nemmeno un candidato, quindi non può entrare in quella corsia.
//
// Perché 90 e non 118. I conti che lo limitano sono due: 90 × 2 = 180 asset più le altre corsie (fino a
// ~35 mercati fra abilitati, tracking, piano e permessi) restano sotto i 250 asset del budget di
// connessione e sotto i 125 mercati di TOTAL_MARKET_CAP.
// Il 4 agosto la corsia del piano è passata da 20 a 40 mercati (unione mobile con isteresi), e il conto
// regge perché la corsia NON costa il suo intero elenco: misurato quel giorno, dei 20 id in elenco solo 9
// erano mercati che il board non copriva già, cioè ~45%. Un elenco da 40 costa quindi ~18 slot, che con i
// 5 abilitati a mano portano il set a ~113 dei 125 di tetto — il feed misurato stava a 104. Se un giorno
// il tetto si raggiungesse davvero, la regola di sfratto resta quella: cede il mercato reward più povero,
// mai uno del piano, e lo sfratto finisce a registro.
//
// Il secondo conto è il disco: il giornale mid-history costa ~1,5 MB al giorno per mercato (misurato:
// 71,5 MB in 17,3 h su 65 mercati), quindi si passa da ~100 a ~170 MB al giorno, cioè ~2,4 GB sui 14
// giorni di retention — con 59 GB liberi è una spesa reale ma piccola.
// Portarlo a 118 lascerebbe invece zero margine alle altre corsie sul tetto totale.
const SUBSCRIPTION_CAP = 90;          // reward-board markets taken from the watchlist (× 2 tokens = ≤180 assets)
const FEED_ASSET_BUDGET = 250;        // assets on one market-channel connection — OUR budget, not a venue limit
const TOTAL_MARKET_CAP = Math.floor(FEED_ASSET_BUDGET / 2); // 125 markets (board + operator + legs), 2 tokens each
const WRITE_INTERVAL_MS = 3_000;      // recompute + persist snapshot cadence
const REFRESH_MARKETS_MS = 60_000;    // re-read the watchlist for adds/drops
// Ogni quanto si guarda il file dei permessi temporanei. Volutamente MOLTO piu' fitto della
// riconciliazione: e' una lettura di un file locale di poche centinaia di byte, e chi apre un pannello
// sta guardando lo schermo adesso. La riconciliazione vera scatta solo se l'insieme e' cambiato.
const LEASE_WATCH_MS = 2_000;
const STALE_MS = 30_000;              // no event within this ⇒ that book is STALE (≈3 heartbeats)
const RESNAPSHOT_MIN_GAP_MS = 5_000;  // don't hammer REST for the same asset
const STARTUP_DELAY_MS = 8_000;
// Ladder depth persisted per side, per token. The event terminal renders a book, not a market-data
// archive: 12 levels covers the visible ladder plus a couple of rows of context. BOUNDED ON PURPOSE —
// the in-memory store already holds the full book, and dumping it every 3s would grow this file with
// the depth of the most active market rather than with anything the UI shows.
const LADDER_LEVELS = 12;
const UA = 'edgeradar-agent34-clob-ws/1.0 (read-only)';

// ── MID-HISTORY sampling (append-only observation log for the rewards backtest) ──
// One JSONL line per market per sample, appended to a daily-rotated file. This is PURELY an append of
// data already held in memory (the live book + the same size-cutoff adjusted mid the reward math uses);
// it changes NO existing output, no estimate, and touches no order path. Memory-safe by construction:
//   • append STREAM (flags:'a') — never read the file back, never buffer the day in memory;
//   • rotate per UTC day → data/mid-history-YYYY-MM-DD.jsonl;
//   • retention: on each rotation, delete mid-history files older than MID_HISTORY_RETENTION_DAYS.
// Interval: the spec's 15s × 60 markets × ~380 B/row ≈ 131 MB/day exceeds the 50 MB/day box budget, so
// the interval is raised to the finest value that stays under it at the subscription cap (measured below).
// 2026-07-25: adding the per-level `levels[]` array (REWARDS-MULTILEVEL-QUOTING) grew the row 376→560 B
// (measured over all 60 subscribed markets, layer distribution {1:6, 2:53, 3:1}). At 45s that is
// 64.5 MB/day mid-history + 1.9 MB/day tape ≈ 66 MB/day — over budget. Per the spec we cut the INTERVAL,
// never the level count (the level count is the feature): 45s→75s → 38.7 + 1.9 ≈ 40.6 MB/day, ~19% under
// the 50 MB/day cap. 75s is still 4× finer than the 5-min continuous-coverage outage threshold (agent39),
// so raising it does not fragment the net-rerun window.
const MID_HISTORY_DIR = '/root/prediction-market/data';
const MID_HISTORY_INTERVAL_MS = Number(process.env.MID_HISTORY_INTERVAL_MS || 75_000);
const MID_HISTORY_RETENTION_DAYS = 14;

// ── TRADE TAPE (executed-trade recording for adverse-selection measurement) ──
// The market channel already delivers `last_trade_price` events (verified verbatim: fields market,
// asset_id, price, size, side, timestamp, transaction_hash). agent34 already receives them for its
// subscribed tokens — this only APPENDS them, so there is NO subscription change and NO added message
// volume. Same memory discipline as the mid-history journal: append STREAM only (never read back, never
// buffer a day), daily rotation, 14-day retention by filename. This is the OBSERVED tape that replaces the
// 45s-sampled fill inference. Read-only: no order path, agent35 stays disarmed. Rate is ~a few/min across
// the universe (measured), so bytes/day is tiny — trades are never sampled, they are the ground truth.
const TRADE_TAPE_DIR = '/root/prediction-market/data';
const TRADE_TAPE_RETENTION_DAYS = 14;

const log = (...a) => console.log(new Date().toISOString(), '[agent34]', ...a);

// Lazy Prisma — legs are persisted user data (RewardsLeg). If the client/DB isn't
// available the agent still serves the watchlist; leg markets are simply not unioned
// in. We read only DISTINCT marketIds here — never leg prices/contents — and never log them.
let prisma = null;
try { prisma = new (require('@prisma/client').PrismaClient)(); } catch { /* watchlist-only */ }
const resolvedTokens = new Map(); // conditionId -> { tokenId, tokenIdNo } (CLOB-resolved, cached)

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function atomicWrite(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
function heartbeat() {
  const hb = readJsonSafe(HB_FILE) || {};
  hb['agent34-clob-ws'] = Date.now();
  try { atomicWrite(HB_FILE, hb); } catch { /* best-effort */ }
}

function normId(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }

// ── desired markets: reward-eligible watchlist (operator-enabled markets and persisted
// user legs are unioned in afterwards). Returns a Map<conditionId, marketMeta>. ──
function collectDesiredMarkets(deps = {}) {
  const out = new Map();
  const d = deps.watchlist !== undefined ? deps.watchlist : readJsonSafe(WATCHLIST_FILE);
  const markets = (d && d.markets) || [];
  for (const m of markets) {
    if (!m.tokenId || !m.conditionId) continue;
    out.set(m.conditionId, {
      conditionId: m.conditionId,
      tokenId: String(m.tokenId),
      tokenIdNo: m.tokenIdNo ? String(m.tokenIdNo) : null,
      minSize: Number(m.rewardsMinSize || m.minSize || 1) || 1,
      maxSpread: Number(m.rewardsMaxSpread ?? m.maxSpread) || null, // cents; band radius = /2
      tick: Number(m.tickSize) > 0 ? Number(m.tickSize) : null,     // venue min tick (agent24 /tick-size); null if unknown
      title: (m.question || m.title || '').slice(0, 120),
      // WHERE this subscription came from, and how strong its reward is — the two things the overflow
      // rule below needs in order to evict the WEAKEST board market rather than an operator's choice.
      source: 'reward-board',
      rewardsDailyRate: Number.isFinite(Number(m.rewardsDailyRate)) ? Number(m.rewardsDailyRate) : null,
    });
    if (out.size >= SUBSCRIPTION_CAP) break;
  }
  return out;
}

// ── THE OPERATOR'S OWN MARKETS ──────────────────────────────────────────────────────────────────────
// A market the operator adds by hand from the Allocazione tab is written to data/maker-auto-reprice.json
// as a per-market opt-in — the SAME list lib/maker/config.js exposes as cfg.enabledMarketIds and the
// live-min allowlist gate reads. Such a market is very often NOT reward-eligible (BTC Up/Down pays no
// liquidity reward), so agent24 never sees it and the watchlist above never carries it. Without this
// union its price in the panel would be a SNAPSHOT taken when it was added (midSource:'manual-catalog'),
// and lib/maker/auto-reprice.js refuses outright to move a real order on a mid that is not agent34's live
// book (gate 'mid-not-live'). A market we let the operator quote on must therefore be a market we watch.
//
// We take the union of enabledMarketIds and optedInMarketIds. The difference is the auto-reprice MASTER
// switch: with it off, enabledMarketIds is empty by design ("what will the watcher touch right now"). But
// the master switch governs whether an automatism may MOVE an order — not whether we should know the
// current price of a market the operator picked. Subscribing is read-only and grants no authority
// whatsoever (the allowlist, caps, manual mode and kill switch all live elsewhere), so watching the wider
// list is free and strictly more honest.
function readOperatorEnabledIds(deps = {}) {
  try {
    const { readAutoRepriceConfig } = require('../lib/maker/auto-reprice-config');
    const cfg = readAutoRepriceConfig(deps);
    // An UNREADABLE config yields [] here (readAutoRepriceConfig fails closed) — the same "nothing extra
    // is subscribed" as an empty list. Fail-closed on a config read can only ever cost us a subscription.
    const ids = [...(cfg.enabledMarketIds || []), ...(cfg.optedInMarketIds || [])].map(normId).filter(Boolean);
    return [...new Set(ids)];
  } catch (e) { log('operator-enabled list unreadable (board-only this cycle):', e.message); return []; }
}

// Venue metadata for an operator-enabled market. First the durable catalog the Allocazione tab wrote when
// the market was added (no network, and it already holds the venue's own tick/tokens/negRisk); the CLOB
// lookup is the fallback for a market enabled without a catalog row. NEVER fabricates: a market whose YES
// token cannot be resolved is skipped, and the reward fields stay null when the venue publishes none —
// `minSize:null` in particular must NOT become 1, or a fabricated min_incentive_size would travel into
// lib/maker/manual-order.resolveMarketRules and quietly satisfy a gate the venue never published.
async function operatorMarketMeta(id, deps = {}) {
  let rec = null;
  try {
    rec = deps.catalogRecord !== undefined ? deps.catalogRecord : require('../lib/maker/market-catalog').readMarketRecord(id, deps);
  } catch { rec = null; }
  let tokenId = rec && rec.tokenIdYes ? String(rec.tokenIdYes) : null;
  let tokenIdNo = rec && rec.tokenIdNo ? String(rec.tokenIdNo) : null;
  if (!tokenId) {
    const t = await (deps.resolveTokens || resolveTokens)(id);
    tokenId = (t && t.tokenId) || null; tokenIdNo = (t && t.tokenIdNo) || null;
  }
  if (!tokenId) return null;
  return {
    conditionId: id,
    tokenId,
    tokenIdNo: tokenIdNo || null,
    minSize: rec && Number.isFinite(rec.rewardsMinSize) ? rec.rewardsMinSize : null,
    maxSpread: rec && Number.isFinite(rec.rewardsMaxSpreadCents) ? rec.rewardsMaxSpreadCents : null,
    tick: rec && Number.isFinite(rec.tick) && rec.tick > 0 ? rec.tick : null,
    title: ((rec && rec.question) || '').slice(0, 120),
    source: 'operator-enabled',
    rewardsDailyRate: rec && Number.isFinite(rec.rewardsDailyRate) ? rec.rewardsDailyRate : null,
    operatorEnabled: true,
  };
}

// Free ONE slot for an operator market by dropping the weakest reward-board market — lowest
// rewardsDailyRate first, an unknown rate counted as 0. A market the operator enabled is never a
// candidate (that is the whole point), and neither is a leg market. Returns the evicted id, or null when
// there is nothing left to give up — in which case the caller records the operator market as DROPPED and
// says so loudly rather than pretending it is covered.
function evictWeakestRewardMarket(into, per = 'un mercato abilitato a mano') {
  let worst = null; let worstRate = Infinity;
  for (const [id, m] of into) {
    if (m.source !== 'reward-board' || m.operatorEnabled || m.fromLeg) continue;
    const rate = Number.isFinite(m.rewardsDailyRate) ? m.rewardsDailyRate : 0;
    if (rate < worstRate) { worst = id; worstRate = rate; }
  }
  if (!worst) return null;
  into.delete(worst);
  log(`cap ${TOTAL_MARKET_CAP} reached — evicted weakest reward market ${worst.slice(0, 10)}… (rate $${worstRate}/d) to make room for ${per}`);
  return worst;
}

// Union the operator's enabled markets into `into` (mutates). Deduplicated against the board by
// conditionId, case-insensitively: a market that is BOTH on the reward board and enabled by hand (Harry
// Kane today) is subscribed ONCE and simply flagged, never counted or subscribed twice.
async function unionOperatorMarkets(into, deps = {}) {
  operatorDropped = []; operatorUnresolved = []; operatorEvicted = [];
  const ids = deps.operatorIds !== undefined ? deps.operatorIds : readOperatorEnabledIds(deps);
  if (!ids.length) return into;
  const byLower = new Map([...into.keys()].map((k) => [normId(k), k]));
  for (const id of ids) {
    const existing = byLower.get(id);
    if (existing) { into.get(existing).operatorEnabled = true; continue; }  // already covered by the board
    if (into.size >= TOTAL_MARKET_CAP) {
      const evicted = evictWeakestRewardMarket(into);
      if (!evicted) { operatorDropped.push(id); continue; }
      byLower.delete(normId(evicted));
      operatorEvicted.push(evicted);
    }
    const meta = await operatorMarketMeta(id, deps);
    if (!meta) { operatorUnresolved.push(id); continue; }   // unresolvable → skip, never fabricate a token
    into.set(id, meta);
    byLower.set(id, id);
  }
  if (operatorDropped.length) {
    log(`ATTENZIONE: ${operatorDropped.length} mercati abilitati a mano NON sottoscritti — cap totale ${TOTAL_MARKET_CAP} raggiunto e nessun mercato reward evincibile: ${operatorDropped.join(', ')}`);
  }
  if (operatorUnresolved.length) log(`operator markets with unresolvable tokens (not subscribed): ${operatorUnresolved.join(', ')}`);
  return into;
}

// ── SOTTOSCRIZIONI PERMANENTI PER IL TRACKING ──────────────────────────────────────────────────────
// Un mercato con il market making a due lati attivo ha bisogno del book live SEMPRE, non solo mentre
// qualcuno guarda il pannello: il motore continua a quotare e a riprezzare anche con l'app chiusa. Il
// permesso temporaneo (live-lease) muore in venti secondi ed e' l'attrezzo sbagliato per questo.
//
// Priorita' PIU ALTA dei permessi temporanei e pari a quella dei mercati abilitati a mano: se serve
// spazio si cede un mercato del board (il piu' povero), non uno su cui un motore sta lavorando con
// capitale reale. Alla scala prevista — 10-15 mercati in tracking su un budget di 125 — questo caso
// non si presenta comunque.
let trackedDropped = [];
let trackedActiveIds = [];
async function unionTrackedMarkets(into, deps = {}) {
  trackedDropped = [];
  let ids = [];
  try {
    const { trackedMarketIds } = require('../lib/maker/mm-tracking-config');
    ids = deps.trackedIds !== undefined ? deps.trackedIds : trackedMarketIds();
  } catch (e) {
    log('configurazione del tracking non leggibile (nessuna sottoscrizione permanente questo giro):', e.message);
    trackedActiveIds = [];
    return into;
  }
  trackedActiveIds = ids.slice();
  if (!ids.length) return into;
  const byLower = new Map([...into.keys()].map((k) => [normId(k), k]));
  for (const id of ids) {
    const existing = byLower.get(normId(id));
    if (existing) { into.get(existing).tracked = true; continue; }
    if (into.size >= TOTAL_MARKET_CAP) {
      const evicted = evictWeakestRewardMarket(into, 'un mercato con il market making attivo');
      if (!evicted) { trackedDropped.push(id); continue; }
      byLower.delete(normId(evicted));
    }
    const meta = await operatorMarketMeta(id, deps);
    if (!meta) { trackedDropped.push(id); continue; }
    meta.source = 'mm-tracking';
    meta.tracked = true;
    into.set(id, meta);
    byLower.set(normId(id), id);
  }
  if (trackedDropped.length) {
    log(`ATTENZIONE: ${trackedDropped.length} mercati CON TRACKING ATTIVO non sottoscritti — il motore li mettera in pausa per dati non freschi: ${trackedDropped.join(', ')}`);
  }
  return into;
}

// ── LA CORSIA DEL PIANO ─────────────────────────────────────────────────────────────────────────────
// Il board si ordina per MONTEPREMI; l'ottimizzatore sceglie per reward atteso PER DOLLARO sotto il
// tetto di concentrazione. Sono due criteri diversi, e il secondo pesca regolarmente sotto la soglia
// del primo: il 3 agosto 2026, dei 5 mercati del piano fresco UNO SOLO era sottoscritto, e «Spider-Man:
// Brand New Day» (posizione 115 del board, $25/g) aveva l'ultimo prezzo di 8,4 ore prima. Il piano lo
// proponeva, il guard di freschezza lo scartava, e il capitale restava fermo.
//
// Qui la si chiude: chi calcola un piano scrive in data/collector-priority.json i mercati che ha scelto
// o valutato meglio, e questa corsia li sottoscrive con la stessa priorità dei mercati abilitati a mano
// — al tetto cede il posto il mercato reward più povero, mai uno del piano. Così quando l'ottimizzatore
// riproporrà quel mercato, il suo storico sarà già caldo da ore invece che da adesso.
//
// L'elenco è un'UNIONE MOBILE, non la fotografia di un piano: un mercato ci resta per ore dopo l'ultima
// volta che è stato scelto o quasi-scelto. Serve perché la graduatoria dell'ottimizzatore ondeggia più in
// fretta di quanto si calcolino i piani — misurato il 3 agosto: due mercati usciti dall'elenco e rientrati
// nel piano mezz'ora dopo avevano buchi di campionamento di 233 e 232 minuti. Chi legge non deve
// sorprendersi se l'elenco contiene mercati che il piano PIÙ RECENTE non ha scelto: è voluto.
//
// L'elenco SCADE (lib/rewards/collector-priority.MAX_AGE_MS): se chi lo scrive muore, la corsia si
// svuota e il raccoglitore torna al comportamento di sempre, invece di restare inchiodato ai mercati di
// un piano defunto.
let planDropped = [];
let planActiveIds = [];
let planLaneReason = null;
async function unionPlanMarkets(into, deps = {}) {
  planDropped = [];
  let ids = [];
  try {
    if (deps.planIds !== undefined) { ids = deps.planIds; planLaneReason = null; }
    else {
      const { readCollectorPriority } = require('../lib/rewards/collector-priority');
      const letto = readCollectorPriority({});
      ids = letto.marketIds;
      planLaneReason = letto.reason;
    }
  } catch (e) {
    log('elenco delle priorità del piano non leggibile (nessuna sottoscrizione da questa corsia):', e.message);
    planActiveIds = []; planLaneReason = e.message;
    return into;
  }
  planActiveIds = ids.slice();
  if (!ids.length) return into;
  const byLower = new Map([...into.keys()].map((k) => [normId(k), k]));
  for (const id of ids) {
    const existing = byLower.get(normId(id));
    if (existing) { into.get(existing).fromPlan = true; continue; }   // già coperto: si marca soltanto
    if (into.size >= TOTAL_MARKET_CAP) {
      const evicted = evictWeakestRewardMarket(into, 'un mercato proposto dal piano');
      if (!evicted) { planDropped.push(id); continue; }
      byLower.delete(normId(evicted));
    }
    const meta = await operatorMarketMeta(id, deps);
    if (!meta) { planDropped.push(id); continue; }                    // token non risolvibili → mai inventati
    meta.source = 'piano';
    meta.fromPlan = true;
    meta.operatorEnabled = false;
    into.set(id, meta);
    byLower.set(normId(id), id);
  }
  if (planDropped.length) {
    log(`ATTENZIONE: ${planDropped.length} mercati PROPOSTI DAL PIANO non sottoscritti — il loro storico restera vecchio e l allocatore li scartera: ${planDropped.join(', ')}`);
  }
  return into;
}

// ── SOTTOSCRIZIONI TEMPORANEE (live-lease) ──────────────────────────────────────────────────────────
// Un permesso in data/maker-live-leases.json significa: «un pannello di piazzamento e APERTO su questo
// mercato adesso». La dashboard lo scrive all apertura e lo rinnova ogni 5s; scade da solo dopo 20s.
//
// PERCHE UN PERMESSO PUO EVINCERE UN MERCATO DEL BOARD. Al tetto, un permesso segue la stessa regola dei
// mercati abilitati a mano: cede il posto il mercato reward con il montepremi piu basso (uno sconosciuto
// conta zero). Sembra aggressivo, e la ragione per cui non lo e: l operatore sta GUARDANDO quel mercato
// in questo istante, probabilmente per piazzarci sopra, mentre il mercato evincito e quello che rende
// meno di tutti; i permessi sono al massimo otto su un budget di 125; e ognuno scade in venti secondi,
// quindi lo sfratto si ripara da solo entro il giro di riconciliazione successivo. Se non c e nulla da
// evincere il permesso viene SCARTATO e detto ad alta voce — il pannello continua a mostrare Gamma e lo
// dichiara, invece di far credere che il prezzo sia live.
//
// Un mercato gia sottoscritto per altri motivi (board, abilitato, leg) viene solo MARCATO, mai
// sottoscritto due volte: il permesso in quel caso non costa niente.
let leaseDropped = [];
let leaseActiveIds = [];
async function unionLeaseMarkets(into, deps = {}) {
  leaseDropped = [];
  let ids = [];
  try {
    const { readActiveLeaseIds } = require('../lib/maker/live-lease');
    ids = deps.leaseIds !== undefined ? deps.leaseIds : readActiveLeaseIds();
  } catch (e) {
    // File illeggibile o modulo assente ⇒ nessun permesso. Fallire chiuso qui puo solo costare una
    // sottoscrizione temporanea, mai concederne una che nessuno ha chiesto.
    log('live-lease non leggibile (nessuna sottoscrizione temporanea questo giro):', e.message);
    leaseActiveIds = [];
    return into;
  }
  leaseActiveIds = ids.slice();
  if (!ids.length) return into;
  const byLower = new Map([...into.keys()].map((k) => [normId(k), k]));
  for (const id of ids) {
    const existing = byLower.get(normId(id));
    if (existing) { into.get(existing).leased = true; continue; }
    if (into.size >= TOTAL_MARKET_CAP) {
      const evicted = evictWeakestRewardMarket(into);
      if (!evicted) { leaseDropped.push(id); continue; }
      byLower.delete(normId(evicted));
    }
    const meta = await operatorMarketMeta(id, deps);
    if (!meta) { leaseDropped.push(id); continue; }   // token non risolvibile → mai inventato
    meta.source = 'live-lease';
    meta.operatorEnabled = false;
    meta.leased = true;
    into.set(id, meta);
    byLower.set(normId(id), id);
  }
  if (leaseDropped.length) {
    log(`ATTENZIONE: ${leaseDropped.length} sottoscrizioni temporanee NON attivate (tetto ${TOTAL_MARKET_CAP} o token non risolvibili): ${leaseDropped.join(', ')}`);
  }
  return into;
}

// Resolve YES/NO token ids for a conditionId via the CLOB (cached). Needed for
// leg-only markets that aren't in the reward-eligible watchlist file.
async function resolveTokens(conditionId) {
  if (resolvedTokens.has(conditionId)) return resolvedTokens.get(conditionId);
  try {
    const r = await httpGet(`${CLOB_BASE}/markets/${conditionId}`, { timeoutMs: 6_000, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    const tokens = r && r.status === 200 && Array.isArray(r.data.tokens) ? r.data.tokens : [];
    // ── NON TUTTI I MERCATI BINARI SI CHIAMANO «Yes» E «No» ────────────────────────────────────────
    // Questa funzione cercava letteralmente `outcome === 'Yes'`, e per un «Bitcoin Up or Down» il venue
    // pubblica ['Up', 'Down']: nessun token trovato, mercato scartato, prezzo mai live. Ed e' proprio la
    // famiglia di mercati per cui la sottoscrizione a richiesta e' stata scritta.
    //
    // Prima si prova per etichetta (comportamento identico a prima dove le etichette sono Yes/No), poi
    // per POSIZIONE quando i token sono esattamente due. La posizione non e' un'invenzione: e' la
    // convenzione che il resto del progetto usa gia' (lib/maker/market-search.tokenIdsOf e agent24
    // leggono clobTokenIds[0]/[1]), e i due ordinamenti coincidono — verificato il 2026-08-01 su un
    // mercato Yes/No e su uno Up/Down, CLOB.tokens[i].token_id === Gamma.clobTokenIds[i] per entrambi.
    // Con un numero di token diverso da due non si indovina: si restituisce null e il mercato viene
    // scartato, perche' invertire i due lati significherebbe quotare il lato sbagliato.
    const byLabel = (want) => tokens.find((t) => String(t.outcome || '').trim().toLowerCase() === want);
    let yes = byLabel('yes');
    let no = byLabel('no');
    let via = 'etichetta';
    if ((!yes || !no) && tokens.length === 2) { yes = tokens[0]; no = tokens[1]; via = 'posizione'; }
    const rec = {
      tokenId: yes ? String(yes.token_id) : null,
      tokenIdNo: no ? String(no.token_id) : null,
      resolvedVia: yes && no ? via : null,
    };
    if (rec.tokenId) resolvedTokens.set(conditionId, rec);
    else log(`token non risolvibili per ${conditionId.slice(0, 10)}… (${tokens.length} token, outcome: ${tokens.map((t) => t.outcome).join('/')})`);
    return rec;
  } catch { return { tokenId: null, tokenIdNo: null, resolvedVia: null }; }
}


// Union in markets where ANY user has a persisted leg (Phase 2). We read only the
// DISTINCT (marketId, venue) — never any leg's price/side/contents. Mutates `into`.
async function unionLegMarkets(into) {
  if (!prisma) return;
  let rows = [];
  try {
    rows = await prisma.rewardsLeg.findMany({ where: { venue: 'polymarket' }, distinct: ['marketId'], select: { marketId: true } });
  } catch (e) { log('leg-market query failed (watchlist-only this cycle):', e.message); return; }
  // Legs keep exactly the bound they always had: the reward-board budget, counted over board+leg entries
  // ONLY. Operator-enabled markets are deliberately excluded from this count so that adding a market by
  // hand can never quietly push a leg market off the feed — the two lanes do not compete.
  const nonOperatorCount = (m) => [...m.values()].filter((x) => x.source !== 'operator-enabled').length;
  for (const { marketId } of rows) {
    if (into.has(marketId)) continue;            // already covered by the watchlist
    if (nonOperatorCount(into) >= SUBSCRIPTION_CAP) break; // stay bounded — never subscribe to everything
    if (into.size >= TOTAL_MARKET_CAP) break;     // and never past the whole-connection budget
    const t = await resolveTokens(marketId);
    if (!t.tokenId) continue;                      // unresolvable → skip, never fabricate a token
    into.set(marketId, {
      conditionId: marketId,
      tokenId: t.tokenId,
      tokenIdNo: t.tokenIdNo,
      minSize: 1,          // unknown for off-watchlist markets → conservative; band stays null
      maxSpread: null,     // no reward-band config known → band null (mid/drift still tracked)
      tick: null,          // off-watchlist market → venue tick unknown here → null (never fabricated)
      title: '',
      fromLeg: true,
    });
  }
}

const store = new LiveBookStore();
const client = new ClobWsClient({ logger: (...a) => log('[ws]', ...a) });
let desired = new Map();            // conditionId -> meta
let assetToMarket = new Map();      // assetId -> { conditionId, side:'yes'|'no', meta }
const lastResnapshotAt = new Map(); // assetId -> ts (throttle REST)
let reconnects = 0, watchdogReconnects = 0, restSnapshots = 0, droppedForCap = 0;
// Operator-lane bookkeeping, refreshed on every reconcile and published in the snapshot's feed block so
// "the market I added by hand is covered" is answerable from the file, not from a log line.
let operatorDropped = [];      // enabled markets NOT subscribed (total cap hit, nothing evictable)
let operatorUnresolved = [];   // enabled markets whose YES token could not be resolved
let operatorEvicted = [];      // reward-board markets given up to make room for an operator market
let driftSignals = 0;
let midHistoryStream = null;       // { day, stream } — the daily-rotated append stream (never read back)
let midHistoryRows = 0;            // rows appended this process lifetime (observability only)
let tradeTapeStream = null;        // { day, stream } — the executed-trade tape append stream
let tradeTapeRows = 0;             // trades appended this process lifetime (observability only)

// ── drift-advisory state (Phase 4). Legs are persisted user data; we track per-leg
// time-in/out-of-band and emit SHADOW DriftSignals through the news-guard rails. ──
let ngConfig = { armed: false, killSwitch: false, cooldownMs: 6 * 3_600_000, maxPerHour: 20 };
let legsByMarket = new Map();      // conditionId -> [RewardsLeg rows]
let placementByKey = new Map();    // `${userId}:${marketId}` -> placement (for est $/day)
let rewardScoreByMarket = new Map(); // marketId -> rewardScore object (from normalized snapshot)
const driftTime = new Map();       // leg.id -> { lastTs, inBandMs, outBandMs, prevInBand }
const driftCooldown = new Map();   // leg.id -> ts of last emitted signal
let driftHourly = [];              // timestamps of emitted signals in the last hour

client.on('close', () => { reconnects++; });
client.on('watchdog-reconnect', () => { watchdogReconnects++; });
client.on('open', () => {
  // Missed deltas during any gap are unrecoverable → REST-resnapshot every asset
  // before trusting the stream again.
  resnapshotAll('ws-open').catch(e => log('resnapshot on open failed:', e.message));
});
client.on('event', (ev, now) => {
  store.ingest(ev, now);
  // OBSERVED executed-trade tape — append every last_trade_price event already arriving on this socket.
  // No subscription change, no order path; the book pipeline above is untouched.
  if (ev && ev.event_type === 'last_trade_price') appendTrade(ev, now);
});

async function restBook(tokenId) {
  const r = await httpGet(`${CLOB_BASE}/book?token_id=${tokenId}`, { timeoutMs: 6_000, headers: { 'User-Agent': UA, Accept: 'application/json' } });
  return r && r.status === 200 ? r.data : null;
}

async function resnapshotAsset(assetId, reason) {
  const now = Date.now();
  if (now - (lastResnapshotAt.get(assetId) || 0) < RESNAPSHOT_MIN_GAP_MS) return;
  lastResnapshotAt.set(assetId, now);
  try {
    const b = await restBook(assetId);
    if (b) { store.applySnapshot(assetId, b, Date.now()); restSnapshots++; }
  } catch (e) { log(`resnapshot ${assetId.slice(-8)} (${reason}) failed:`, e.message); }
}

async function resnapshotAll(reason) {
  const ids = [...assetToMarket.keys()];
  for (const id of ids) await resnapshotAsset(id, reason);
}

// Reconcile subscriptions to the current desired set. Adds/drops on the live socket.
async function reconcileSubscriptions() {
  desired = collectDesiredMarkets();
  await unionOperatorMarkets(desired); // + every market the operator enabled by hand (cfg.enabledMarketIds)
  await unionLegMarkets(desired);   // Phase 2: + markets where a user has legs
  await unionTrackedMarkets(desired); // + i mercati con il market making attivo (PERMANENTI, prima dei temporanei)
  await unionPlanMarkets(desired);    // + i mercati che l'ottimizzatore ha scelto o valutato meglio
  await unionLeaseMarkets(desired); // + i mercati con un pannello di piazzamento aperto adesso (temporanei)
  await loadDriftInputs();          // Phase 4: refresh legs/placements/rewardScore/rails
  const nextAssets = new Map();
  for (const meta of desired.values()) {
    nextAssets.set(meta.tokenId, { conditionId: meta.conditionId, side: 'yes', meta });
    if (meta.tokenIdNo) nextAssets.set(meta.tokenIdNo, { conditionId: meta.conditionId, side: 'no', meta });
  }
  const add = [...nextAssets.keys()].filter(a => !assetToMarket.has(a));
  const drop = [...assetToMarket.keys()].filter(a => !nextAssets.has(a));
  assetToMarket = nextAssets;
  if (add.length) { client.subscribe(add); add.forEach(a => resnapshotAsset(a, 'new-sub')); }
  if (drop.length) { client.unsubscribe(drop); drop.forEach(a => store.remove(a)); }
  if (add.length || drop.length) log(`subs reconciled: +${add.length} -${drop.length} (markets=${desired.size}, assets=${assetToMarket.size})`);
  writeCoverageManifest();   // keep the coverage manifest current with the subscribed set + the live universe size
}

// The dust cutoff the adjusted mid is computed with. A reward market publishes a min_incentive_size and
// that IS the cutoff. A market with no reward programme publishes none: the honest cutoff is then 0 (no
// filter, adjusted mid = plain mid), NOT a made-up 1 — and `minSize` itself stays null everywhere it is
// published, so nothing downstream can mistake our arithmetic choice for a venue rule.
function sizeCutoff(minSize) { return Number.isFinite(minSize) && minSize > 0 ? minSize : 0; }

// Compute per-side mids from a live book. Returns null fields when a side isn't seeded.
function sideView(assetId, minSize, now) {
  const b = store.getBook(assetId);
  const fr = store.freshness(assetId, STALE_MS, now);
  if (!b) return { live: false, reason: fr.reason, ageMs: fr.ageMs, plainMid: null, adjustedMid: null, bestBid: null, bestAsk: null, needsResnapshot: true };
  const bids = parseOrders(b.bids, true);
  const asks = parseOrders(b.asks, false);
  const bestBid = bids[0] ? bids[0].price : null;
  const bestAsk = asks[0] ? asks[0].price : null;
  const plainMid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  const adjMid = adjustedMid(bids, asks, sizeCutoff(minSize), null);
  // The ladder itself, top-of-book first, capped at LADDER_LEVELS. parseOrders already returns bids
  // descending and asks ascending, so the slice is genuinely the top of each stack. These are the
  // SAME level objects the mid/depth math above consumed — one book, not a second fetch.
  const ladder = (arr) => arr.slice(0, LADDER_LEVELS).map((o) => ({ price: o.price, size: o.size }));
  return {
    live: fr.live, reason: fr.reason, ageMs: fr.ageMs,
    bestBid, bestAsk, plainMid,
    adjustedMid: adjMid != null ? adjMid : null,
    needsResnapshot: b.needsResnapshot,
    // Levels beyond the cap exist in the book but are NOT in this file — stated so a consumer never
    // reads the truncated ladder as the whole book.
    levels: { bids: ladder(bids), asks: ladder(asks), cap: LADDER_LEVELS, bidCount: bids.length, askCount: asks.length },
  };
}

// In-band $ (Σ price×size) around a mid, no size cutoff — matches agent24 existing_depth_usd so the live
// depth is the same measure the scan produces. Returns 0 when the band/mid is unknown or the side empty.
function inBandUsd(orders, mid, bandRadiusC) {
  if (mid == null || bandRadiusC == null || !(bandRadiusC > 0)) return 0;
  const r = bandRadiusC / 100;
  let usd = 0;
  for (const o of orders) if (o.price >= mid - r - 1e-12 && o.price <= mid + r + 1e-12) usd += o.price * o.size;
  return usd;
}

// A COHERENT live reward observation from the full live books at ONE instant — mid, competitorQ, refShare
// and the two-sided in-band depth all measured together, via the SAME SSOT the scan uses (scoreBook +
// quadraticUserShare). This is what lets the API upgrade a covered row WITHOUT ever pairing a live mid
// with a scan-time depth: the whole block travels together. Returns null (→ the API keeps the scan block)
// when the book is not live, has no reward band, or cannot be scored. Never fabricates.
function liveRewardObs(meta, now) {
  if (meta.maxSpread == null || !(meta.maxSpread > 0)) return null;   // no band → cannot score coherently
  if (!Number.isFinite(meta.minSize) || !(meta.minSize > 0)) return null; // no published min size → not scoreable
  const fr = store.freshness(meta.tokenId, STALE_MS, now);
  if (!fr.live) return null;                                          // not fresh → stay at scan speed (never mix)
  const bYes = store.getBook(meta.tokenId);
  if (!bYes) return null;
  const bids = parseOrders(bYes.bids, true);
  const asks = parseOrders(bYes.asks, false);
  const mid = adjustedMid(bids, asks, meta.minSize, null);
  if (mid == null) return null;
  const v = meta.maxSpread;                                           // full band (cents); radius = v/2
  const sc = scoreBook({ bids, asks }, v, meta.minSize, mid);         // { Qbids, Qasks, Qmin, mid }
  const competitorQ = sc.Qmin;
  const refShare = quadraticUserShare(competitorQ, mid, v, meta.minSize, REWARD_REF_CAPITAL, v / 4);
  if (refShare == null) return null;
  // Two-sided in-band $ at THIS instant (YES around its mid + NO around its mid), same measure as the scan.
  const depthYes = inBandUsd([...bids, ...asks], mid, v / 2);
  let depthNo = 0;
  if (meta.tokenIdNo) {
    const bNo = store.getBook(meta.tokenIdNo);
    if (bNo) {
      const nb = parseOrders(bNo.bids, true), na = parseOrders(bNo.asks, false);
      const midNo = adjustedMid(nb, na, meta.minSize, null);
      depthNo = inBandUsd([...nb, ...na], midNo, v / 2);
    }
  }
  return {
    observedAt: new Date(now).toISOString(),
    ageMs: fr.ageMs,
    mid: Math.round(mid * 1e6) / 1e6,
    competitorQ: Math.round(competitorQ * 1e4) / 1e4,
    refShare: Math.round(refShare * 1e6) / 1e6,
    minSize: meta.minSize,
    maxSpreadCents: v,
    inBandDepthUsd: Math.round((depthYes + depthNo) * 100) / 100,
  };
}

function buildSnapshot() {
  const now = Date.now();
  const markets = {};
  for (const meta of desired.values()) {
    const yes = sideView(meta.tokenId, meta.minSize, now);
    const no = meta.tokenIdNo ? sideView(meta.tokenIdNo, meta.minSize, now) : null;
    // Market-level mid/band anchor on the YES token (the reward book), matching agent24.
    const mid = yes.adjustedMid;
    const plainMid = yes.plainMid;
    const bandRadiusC = meta.maxSpread != null ? meta.maxSpread / 2 : null;
    // The divergence, MEASURED not acted on: adjusted − plain, in cents.
    const midAdjVsPlainC = (mid != null && plainMid != null) ? Math.round((mid - plainMid) * 1000) / 10 : null;
    markets[meta.conditionId] = {
      tokenId: meta.tokenId,
      tokenIdNo: meta.tokenIdNo,
      title: meta.title,
      // WHY this market is here. A consumer reading a null band on an 'operator-enabled' row knows the
      // venue publishes no reward programme for it, rather than suspecting a lost field.
      source: meta.source || (meta.fromLeg ? 'leg' : 'reward-board'),
      operatorEnabled: meta.operatorEnabled === true,
      minSize: meta.minSize,
      maxSpread: meta.maxSpread,
      bandRadiusC,
      mid, plainMid, midAdjVsPlainC,
      live: yes.live,
      ageMs: yes.ageMs,
      // COHERENT live reward observation (mid + competitorQ + refShare + depth, one instant) — null when
      // the book is not live / no band / unscoreable, in which case the API keeps the coherent scan block.
      rewardObs: liveRewardObs(meta, now),
      yes, no,
    };
  }
  const rss = process.memoryUsage().rss;
  const bySource = { 'reward-board': 0, 'operator-enabled': 0, leg: 0, 'live-lease': 0, 'mm-tracking': 0 };
  for (const meta of desired.values()) {
    const s = meta.source || (meta.fromLeg ? 'leg' : 'reward-board');
    bySource[s] = (bySource[s] || 0) + 1;
  }
  return {
    generatedAt: new Date(now).toISOString(),
    source: 'Polymarket CLOB market channel · live · read-only · no orders placed',
    feed: {
      connected: client.connected,
      silentMs: client.connected ? client.silenceMs(now) : null,
      subscriptions: assetToMarket.size,
      markets: desired.size,
      reconnects, watchdogReconnects, restSnapshots,
      // The operator lane, stated in the file: how many hand-enabled markets are covered, and — the part
      // that must never be silent — which ones are NOT, and what the board gave up for them.
      rewardBoardMarkets: bySource['reward-board'],
      operatorMarkets: bySource['operator-enabled'],
      legMarkets: bySource.leg,
      rewardCap: SUBSCRIPTION_CAP,
      totalCap: TOTAL_MARKET_CAP,
      operatorDropped: [...operatorDropped],
      operatorUnresolved: [...operatorUnresolved],
      operatorEvictedRewardMarkets: [...operatorEvicted],
      // Le sottoscrizioni temporanee, esposte per diagnosi: quante sono attive, quante NON e' stato
      // possibile attivare, e il tetto. Cosi' «perche' questo mercato non e' live?» ha una risposta
      // leggibile invece di richiedere i log del processo.
      trackedMarkets: bySource['mm-tracking'] || 0,
      trackedActive: [...trackedActiveIds],
      trackedDropped: [...trackedDropped],
      // La corsia del piano: quanti mercati proposti dall'ottimizzatore sono coperti, quali NON si è
      // riusciti a sottoscrivere (quelli il cui storico resterà vecchio e che il piano poi scarterà), e
      // perché l'elenco è eventualmente vuoto — scaduto, assente, malformato.
      planMarkets: bySource.piano || 0,
      planActive: [...planActiveIds],
      planDropped: [...planDropped],
      planListReason: planLaneReason,
      leaseMarkets: bySource['live-lease'] || 0,
      leaseActive: [...leaseActiveIds],
      leaseDropped: [...leaseDropped],
      leaseCap: (() => { try { return require('../lib/maker/live-lease').LEASE_CAP; } catch { return null; } })(),
    },
    staleMs: STALE_MS,
    markets,
    memory: {
      rssMB: Math.round(rss / 1e5) / 10,
      liveBookBytes: store.memoryBytesEstimate(),
      bytesPerSubscription: assetToMarket.size ? Math.round(store.memoryBytesEstimate() / assetToMarket.size) : 0,
      tokens: assetToMarket.size,
    },
  };
}

// Refresh the drift inputs: persisted legs (user data — full rows needed here to
// compute band position, but contents are NEVER logged), the user's placement (for
// est $/day), the market rewardScore (from the normalized snapshot), and the live
// news-guard rail config. Called on the slow reconcile cadence, not every tick.
async function loadDriftInputs() {
  ngConfig = loadNewsGuardConfig(process.env);
  // rewardScore per market from the normalized snapshot.
  rewardScoreByMarket = new Map();
  const snap = readJsonSafe(NORMALIZED_FILE);
  for (const m of (snap && snap.markets) || []) {
    if (m.marketId && m.rewardScore) rewardScoreByMarket.set(m.marketId, m.rewardScore);
  }
  if (!prisma) { legsByMarket = new Map(); placementByKey = new Map(); return; }
  try {
    const legs = await prisma.rewardsLeg.findMany({ where: { venue: 'polymarket' } });
    const byMarket = new Map();
    for (const l of legs) {
      if (!byMarket.has(l.marketId)) byMarket.set(l.marketId, []);
      byMarket.get(l.marketId).push(l);
    }
    legsByMarket = byMarket;
    const pls = await prisma.rewardsPlacement.findMany({ where: { venue: 'polymarket' } });
    placementByKey = new Map(pls.map(p => [`${p.userId}:${p.marketId}`, p]));
  } catch (e) {
    log('drift-input load failed (drift paused this cycle):', e.message);
    legsByMarket = new Map(); placementByKey = new Map();
  }
}

// Evaluate drift for every persisted leg against the live book. Emits SHADOW records
// only; can never execute. Respects kill-switch, cooldown, hourly cap, structural gate.
function runDrift(snapshot, now) {
  if (legsByMarket.size === 0) return;
  driftHourly = driftHourly.filter(t => now - t < 3_600_000);
  for (const [marketId, legs] of legsByMarket) {
    const mk = snapshot.markets[marketId];
    if (!mk) continue;                                    // not subscribed → cannot judge
    const feedState = mk.live ? 'live' : 'stale';
    const oneSided = !mk.yes || mk.yes.bestBid == null || mk.yes.bestAsk == null;
    const rewardScore = rewardScoreByMarket.get(marketId) || null;
    for (const leg of legs) {
      // est $/day for THIS user's placement (from rewardScore only; null when absent).
      const placement = placementByKey.get(`${leg.userId}:${marketId}`) || null;
      const forg = (rewardScore && placement)
        ? estRewardForgone({ rewardScore }, placement, ngConfig.cooldownMs)
        : null;
      const market = {
        mid: mk.mid, maxSpread: mk.maxSpread, feedState, oneSided,
        estDailyUsd: forg ? forg.estDailyUsd : null,
      };
      const rails = {
        cooldownActive: driftCooldown.get(leg.id) != null && (now - driftCooldown.get(leg.id)) < ngConfig.cooldownMs,
        hourlyCapReached: driftHourly.length >= ngConfig.maxPerHour,
      };
      const out = decideDrift({ leg, market, timeState: driftTime.get(leg.id), config: ngConfig, rails, now });
      driftTime.set(leg.id, out.timeState);
      if (out.record && out.record.decision === 'drift') {
        appendDriftShadowRecord(out.record);   // scrubbed + appended to the drift shadow dataset
        driftSignals++;
        if (out.consumesSlot) { driftCooldown.set(leg.id, now); driftHourly.push(now); }
      }
    }
  }
}

// Write the coverage manifest, captured at collection time. The denominator a backtest MUST use is the
// COLLECTABLE universe, not the full published one: Kalshi's liquidity-rewards program is US-only
// (help.kalshi.com/en/articles/13823851-liquidity-incentive-program — "International, non-U.S. users
// ineligible for rewards") and this operator is in the EU, so Kalshi markets are structurally
// uncollectable AND uncoverable by this Polymarket CLOB feed. universeMarketCount is therefore the
// Polymarket-only count; the full poly+kalshi total is kept alongside for transparency. A missing
// universe file ⇒ universeMarketCount null (the coverage header then fails honest → partial + below-half).
function writeCoverageManifest() {
  const norm = readJsonSafe(NORMALIZED_FILE);
  const all = (norm && Array.isArray(norm.markets)) ? norm.markets : null;
  const collectable = all ? all.filter((m) => m && m.venue === 'polymarket').length : null;
  const full = all ? all.length : null;
  // COVERAGE IS ABOUT THE REWARD UNIVERSE, so the numerator must stay the reward-board subset. Markets
  // the operator enabled by hand are in the journal too, but they are not part of that universe (most pay
  // no reward at all) and counting them here would inflate coverage against a denominator they were never
  // in. They are reported separately instead.
  const boardSubscribed = [...desired.values()].filter((m) => (m.source || 'reward-board') === 'reward-board').length;
  const operatorSubscribed = [...desired.values()].filter((m) => m.source === 'operator-enabled').length;
  const manifest = {
    at: new Date().toISOString(),
    subscribedMarketCount: boardSubscribed,        // reward-board markets this journal covers (the numerator)
    subscribedTotalCount: desired.size,            // every market in the journal (board + operator + legs)
    operatorSubscribedCount: operatorSubscribed,   // hand-enabled markets, outside the reward universe
    subscriptionCap: SUBSCRIPTION_CAP,             // the hard bound on coverage
    universeMarketCount: collectable,              // COLLECTABLE universe (Polymarket only) — the denominator to use
    universeMarketCountFull: full,                 // full published universe (poly + kalshi) — transparency only
    kalshiExcludedCount: (full != null && collectable != null) ? full - collectable : null,
    sampleIntervalMs: MID_HISTORY_INTERVAL_MS,
    note: 'Denominator = COLLECTABLE universe (Polymarket only). Kalshi liquidity rewards are US-only (help.kalshi.com/en/articles/13823851-liquidity-incentive-program) and this operator is in the EU, so Kalshi is not collectable and is excluded from the coverage denominator. A backtest must call lib/mid-history-coverage.coverageHeader and print its header before any result.',
  };
  try { atomicWrite(COVERAGE_FILE, manifest); } catch (e) { log('coverage manifest write failed:', e.message); }
}

// ── mid-history: rotation + 14-day retention ──
// Retention runs ON ROTATION (a new UTC day, or first open): list data/mid-history-YYYY-MM-DD.jsonl,
// parse the date out of the name, and unlink any file whose day is older than the cutoff. Delete-by-name
// (never read a file's contents), so pruning is O(files) and touches no memory.
function midHistoryPath(dayStr) { return path.join(MID_HISTORY_DIR, `mid-history-${dayStr}.jsonl`); }
function utcDayStr(now) { return new Date(now).toISOString().slice(0, 10); } // YYYY-MM-DD (UTC)
function pruneOldHistory(now) {
  const cutoff = now - MID_HISTORY_RETENTION_DAYS * 86_400_000;
  let files = [];
  try { files = fs.readdirSync(MID_HISTORY_DIR); } catch { return; }
  for (const f of files) {
    const m = f.match(/^mid-history-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isFinite(t) && t < cutoff) {
      try { fs.unlinkSync(path.join(MID_HISTORY_DIR, f)); log('mid-history: pruned', f, `(older than ${MID_HISTORY_RETENTION_DAYS}d)`); }
      catch (e) { log('mid-history: prune failed for', f, e.message); }
    }
  }
}
// The append stream for the CURRENT UTC day. On a day change we end the old stream, open the new one in
// append mode (flags:'a'), and run retention. flags:'a' means we never truncate or read an existing file.
function midHistoryStreamFor(now) {
  const day = utcDayStr(now);
  if (midHistoryStream && midHistoryStream.day === day) return midHistoryStream.stream;
  if (midHistoryStream) { try { midHistoryStream.stream.end(); } catch { /* ignore */ } }
  const stream = fs.createWriteStream(midHistoryPath(day), { flags: 'a' });
  stream.on('error', (e) => log('mid-history: stream error:', e.message));
  midHistoryStream = { day, stream };
  pruneOldHistory(now);
  log(`mid-history: appending ${midHistoryPath(day)} every ${MID_HISTORY_INTERVAL_MS / 1000}s (retain ${MID_HISTORY_RETENTION_DAYS}d)`);
  return stream;
}

// Qualifying resting SIZE inside the reward band, per side. Same size-cutoff (≥ minSize) the reward
// scoring uses, over the FULL in-memory book (not the truncated ladder). Band = adjMid ± bandRadiusC.
// When the band or the mid is unknown, every band-derived field is null — never 0, never guessed.
function inBandDepth(bids, asks, adjMid, bandRadiusC, minSize) {
  if (adjMid == null || bandRadiusC == null || !(bandRadiusC > 0)) {
    return { bandLow: null, bandHigh: null, bidDepthInBand: null, askDepthInBand: null };
  }
  const r = bandRadiusC / 100;
  const bandLow = adjMid - r;
  const bandHigh = adjMid + r;
  const cutoff = minSize > 0 ? minSize : 0;
  let bidDepth = 0, askDepth = 0;
  for (const o of bids) if (o.size >= cutoff && o.price >= bandLow - 1e-12 && o.price <= bandHigh + 1e-12) bidDepth += o.size;
  for (const o of asks) if (o.size >= cutoff && o.price >= bandLow - 1e-12 && o.price <= bandHigh + 1e-12) askDepth += o.size;
  return {
    bandLow: Math.round(bandLow * 1e6) / 1e6,
    bandHigh: Math.round(bandHigh * 1e6) / 1e6,
    bidDepthInBand: Math.round(bidDepth * 1e4) / 1e4,
    askDepthInBand: Math.round(askDepth * 1e4) / 1e4,
  };
}

// Append one row per market from IN-MEMORY book state only. A value not genuinely known at sample time
// is null (never a fallback, never a silent carry). src distinguishes a book that got a fresh ws event
// within the sampling interval ("ws") from one carried forward from an older event ("stale").
function sampleMidHistory() {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  let stream;
  try { stream = midHistoryStreamFor(now); } catch (e) { log('mid-history: stream open failed:', e.message); return; }
  let batch = '';
  let n = 0;
  for (const meta of desired.values()) {
    const assetId = meta.tokenId;
    const fr = store.freshness(assetId, STALE_MS, now);
    const b = store.getBook(assetId);
    let bestBid = null, bestAsk = null, plainMid = null, adjMid = null;
    let bidDepthInBand = null, askDepthInBand = null, bandLow = null, bandHigh = null;
    let levels = null; // per-layer in-band depth; null when there is no band to place layers within
    if (b) {
      const bids = parseOrders(b.bids, true);
      const asks = parseOrders(b.asks, false);
      bestBid = bids[0] ? bids[0].price : null;
      bestAsk = asks[0] ? asks[0].price : null;
      plainMid = (bestBid != null && bestAsk != null) ? Math.round(((bestBid + bestAsk) / 2) * 1e6) / 1e6 : null;
      const am = adjustedMid(bids, asks, sizeCutoff(meta.minSize), null);
      adjMid = am != null ? Math.round(am * 1e6) / 1e6 : null;
      const bandRadiusC = meta.maxSpread != null ? meta.maxSpread / 2 : null;
      const d = inBandDepth(bids, asks, adjMid, bandRadiusC, meta.minSize);
      bidDepthInBand = d.bidDepthInBand; askDepthInBand = d.askDepthInBand;
      bandLow = d.bandLow; bandHigh = d.bandHigh;
      // Per-level qualifying depth at each reward layer (lib/reward-layers geometry). Same size-cutoff
      // as the aggregate above. Kept alongside the aggregate fields, never replacing them. Each level
      // keeps its index; a side whose depth cannot be read is null there, never 0, never dropped.
      levels = (bandLow != null && bandHigh != null && meta.tick != null)
        ? levelsInBand(bids, asks, bandLow, bandHigh, meta.tick, meta.minSize)
        : null;
    }
    // "ws" only when the book got a fresh event within the sampling interval; otherwise the values are a
    // carried-forward book (or none) → "stale", exactly what the flag is for.
    const src = (b && fr.ageMs != null && fr.ageMs <= MID_HISTORY_INTERVAL_MS) ? 'ws' : 'stale';
    batch += JSON.stringify({
      ts: iso,
      marketId: meta.conditionId,
      tokenIdYes: meta.tokenId,
      adjMid, plainMid, bestBid, bestAsk,
      bidDepthInBand, askDepthInBand,
      bandLow, bandHigh,
      tick: meta.tick != null ? meta.tick : null,
      levels,
      src,
    }) + '\n';
    n++;
  }
  if (batch) { stream.write(batch); midHistoryRows += n; }
}

// ── trade tape: rotation + 14-day retention (mirrors the mid-history discipline) ──
function tradeTapePath(dayStr) { return path.join(TRADE_TAPE_DIR, `trade-tape-${dayStr}.jsonl`); }
function pruneOldTradeTape(now) {
  const cutoff = now - TRADE_TAPE_RETENTION_DAYS * 86_400_000;
  let files = [];
  try { files = fs.readdirSync(TRADE_TAPE_DIR); } catch { return; }
  for (const f of files) {
    const m = f.match(/^trade-tape-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isFinite(t) && t < cutoff) {
      try { fs.unlinkSync(path.join(TRADE_TAPE_DIR, f)); log('trade-tape: pruned', f, `(older than ${TRADE_TAPE_RETENTION_DAYS}d)`); }
      catch (e) { log('trade-tape: prune failed for', f, e.message); }
    }
  }
}
function tradeTapeStreamFor(now) {
  const day = utcDayStr(now);
  if (tradeTapeStream && tradeTapeStream.day === day) return tradeTapeStream.stream;
  if (tradeTapeStream) { try { tradeTapeStream.stream.end(); } catch { /* ignore */ } }
  const stream = fs.createWriteStream(tradeTapePath(day), { flags: 'a' });
  stream.on('error', (e) => log('trade-tape: stream error:', e.message));
  tradeTapeStream = { day, stream };
  pruneOldTradeTape(now);
  log(`trade-tape: appending ${tradeTapePath(day)} (retain ${TRADE_TAPE_RETENTION_DAYS}d)`);
  return stream;
}

// Build ONE tape row from a market-channel `last_trade_price` event — PURE (no I/O), so the null path is
// unit-testable. Records the venue timestamp AND the local receipt time, both. A field the venue does not
// publish is written null — never inferred, never defaulted.
function buildTradeRow(ev, now) {
  const venueMs = ev.timestamp != null && Number.isFinite(Number(ev.timestamp)) ? Number(ev.timestamp) : null;
  const price = ev.price != null && Number.isFinite(parseFloat(ev.price)) ? parseFloat(ev.price) : null;
  const size = ev.size != null && Number.isFinite(parseFloat(ev.size)) ? parseFloat(ev.size) : null;
  const feeBps = ev.fee_rate_bps != null && Number.isFinite(Number(ev.fee_rate_bps)) ? Number(ev.fee_rate_bps) : null;
  return {
    tsVenueMs: venueMs,
    tsVenueIso: venueMs != null ? new Date(venueMs).toISOString() : null,
    tsLocalIso: new Date(now).toISOString(),
    marketId: ev.market || null,
    tokenId: ev.asset_id || null,
    price,
    size,
    side: ev.side || null,               // taker direction as published by the venue (BUY|SELL) or null
    feeRateBps: feeBps,
    txHash: ev.transaction_hash || null, // lets a reader verify the trade on-chain / against REST
    src: 'ws:last_trade_price',
  };
}

// Append ONE executed trade. Wrapped so a write hiccup can never stall the socket. No order path; read-only.
function appendTrade(ev, now) {
  try {
    tradeTapeStreamFor(now).write(JSON.stringify(buildTradeRow(ev, now)) + '\n');
    tradeTapeRows++;
  } catch (e) { log('trade-tape: append failed:', e.message); }
}

async function tick() {
  // Heal any book that lost its snapshot (delta-without-seed).
  for (const id of store.resnapshotNeeded()) await resnapshotAsset(id, 'gap');
  const now = Date.now();
  const snapshot = buildSnapshot();
  try { runDrift(snapshot, now); } catch (e) { log('drift eval failed:', e.message); }
  snapshot.feed.driftSignals = driftSignals;
  try { atomicWrite(OUT_FILE, snapshot); } catch (e) { log('write failed:', e.message); }
  heartbeat();
}

async function main() {
  log('starting — LIVE CLOB books for liquidity-rewards (read-only, €0)');
  await new Promise(r => setTimeout(r, STARTUP_DELAY_MS));
  await reconcileSubscriptions();
  client.connect();
  client.subscribe([...assetToMarket.keys()]);
  await resnapshotAll('startup'); // seed immediately via REST so we're useful before the first ws snapshot

  setInterval(() => { reconcileSubscriptions().catch(e => log('reconcile failed:', e.message)); }, REFRESH_MARKETS_MS);

  // ── IL PERCORSO RAPIDO PER I PERMESSI TEMPORANEI ────────────────────────────────────────────────
  // La riconciliazione normale gira ogni 60 secondi, che va benissimo per un board che cambia con lo
  // scan. Per un permesso NO: chi apre il pannello sta guardando lo schermo adesso, e aspettare fino a
  // un minuto perche il prezzo diventi live vorrebbe dire non averlo fatto. Quindi il file dei permessi
  // si guarda ogni 2 secondi — e solo il file, che e piccolo e locale — e si riconcilia SOLO quando
  // l insieme e cambiato davvero. A regime, senza pannelli aperti, questo costa una lettura di un file
  // vuoto ogni due secondi e nient altro: nessuna riconciliazione, nessuna chiamata al venue.
  let lastLeaseKey = '';
  setInterval(() => {
    let ids = [];
    let trk = [];
    try { ids = require('../lib/maker/live-lease').readActiveLeaseIds(); } catch { return; }
    // Anche la lista del tracking: accendere il toggle su un mercato nuovo deve produrre una
    // sottoscrizione entro un paio di secondi, non al prossimo giro da sessanta.
    try { trk = require('../lib/maker/mm-tracking-config').trackedMarketIds(); } catch { trk = []; }
    const key = ids.slice().sort().join(',') + '|' + trk.slice().sort().join(',');
    if (key === lastLeaseKey) return;
    lastLeaseKey = key;
    log(`sottoscrizioni cambiate (${ids.length} temporanee, ${trk.length} in tracking) — riconcilio subito`);
    reconcileSubscriptions().catch((e) => log('reconcile (lease) failed:', e.message));
  }, LEASE_WATCH_MS);
  setInterval(() => { tick().catch(e => log('tick failed:', e.message)); }, WRITE_INTERVAL_MS);
  // Append-only mid-history sample (separate, slower cadence than the 3s snapshot). Read-only; never
  // reaches an order path. Wrapped so a write hiccup can never stall the feed loop.
  setInterval(() => { try { sampleMidHistory(); } catch (e) { log('mid-history sample failed:', e.message); } }, MID_HISTORY_INTERVAL_MS);
  log(`up: ${desired.size} markets / ${assetToMarket.size} assets subscribed`);
}

function shutdown() {
  try { client.close(); } catch { /* ignore */ }
  if (midHistoryStream) { try { midHistoryStream.stream.end(); } catch { /* ignore */ } }
  if (tradeTapeStream) { try { tradeTapeStream.stream.end(); } catch { /* ignore */ } }
  if (prisma) { prisma.$disconnect().catch(() => {}); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) main().catch(e => { log('fatal:', e.message); process.exit(1); });

module.exports = {
  collectDesiredMarkets, sideView, buildSnapshot, store, client, inBandDepth, sampleMidHistory,
  pruneOldHistory, utcDayStr, writeCoverageManifest, appendTrade, buildTradeRow, pruneOldTradeTape,
  tradeTapePath, MID_HISTORY_INTERVAL_MS, COVERAGE_FILE,
  // The operator lane — exported so the selfcheck can drive it with injected deps (no network, no data/).
  readOperatorEnabledIds, operatorMarketMeta, unionOperatorMarkets, evictWeakestRewardMarket, sizeCutoff,
  // La corsia delle sottoscrizioni temporanee, esportata per la stessa ragione: il selfcheck la guida con
  // deps iniettate, senza rete e senza toccare data/.
  unionLeaseMarkets, leaseLaneState: () => ({ dropped: [...leaseDropped], active: [...leaseActiveIds] }),
  unionTrackedMarkets, trackedLaneState: () => ({ dropped: [...trackedDropped], active: [...trackedActiveIds] }),
  unionPlanMarkets, planLaneState: () => ({ dropped: [...planDropped], active: [...planActiveIds], reason: planLaneReason }),
  operatorLaneState: () => ({ dropped: [...operatorDropped], unresolved: [...operatorUnresolved], evicted: [...operatorEvicted] }),
  SUBSCRIPTION_CAP, TOTAL_MARKET_CAP, FEED_ASSET_BUDGET,
};

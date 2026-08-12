'use strict';
// lib/maker/reward-riprova.js — CAMPO ASSENTE NON È CAMPO A ZERO: SI RICHIEDE, POI SI DECIDE.
//
// ═══ IL DIFETTO ══════════════════════════════════════════════════════════════════════════════════════
// La ricerca arricchisce i mercati con `/markets?condition_ids=…&limit=N`. Quella risposta è l'unica che
// porta `clobRewards`, e a volte NON lo porta — una riga tagliata dal `limit`, una risposta parziale, un
// campo omesso. `rewardStateOf` fa già la cosa giusta e risponde `illeggibile` invece di `senza-premio`
// (correzione del 5 agosto 2026), ma da lì in avanti il verdetto era definitivo: il gate rifiutava e il
// mercato usciva dalla coda, con un motivo onesto ma con una conclusione tratta da **una sola lettura**.
//
// ═══ LA DECISIONE (12 agosto 2026) ═══════════════════════════════════════════════════════════════════
// Un campo assente non equivale a un campo a zero, quindi non basta dirlo: si **richiede**. Un mercato
// con `clobRewards` illeggibile non viene scartato dal gate — viene messo in coda per una **seconda
// fetch mirata per condition_id**, e solo dopo quella il gate decide.
//
// ═══ TRE NUMERI, E DA DOVE VENGONO ═══════════════════════════════════════════════════════════════════
// · **TTL 10 minuti** (richiesto). Un montepremi non cambia da un secondo all'altro, e la cache serve a
//   non ripetere la stessa domanda dentro la stessa sessione di lavoro dell'operatore.
// · **TETTO 12 richieste per ciclo**, e il numero viene da una misura, non da un'intuizione: cinque
//   fetch mirate su condition id VERI del board hanno dato **97 · 100 · 106 · 122 · 143 ms**
//   (mediana 106). Dodici richieste in sequenza costano quindi ~1,3 s tipici e ~1,7 s nel caso
//   peggiore misurato — un costo che sta dentro una ricerca che già fa una `public-search` più
//   l'arricchimento, e che non si sente in un pannello. Si cambia con `MAKER_REWARD_RIPROVE_MAX`; un
//   valore fuori da [1, 50] viene SCARTATO in favore del difetto, la stessa regola di fine scala.
// · **Le richieste sono in SEQUENZA e non in parallelo**: dodici richieste simultanee a Gamma sono il
//   modo più rapido di prendersi un 429, e un 429 qui produrrebbe esattamente il dato mancante che
//   questo modulo esiste per recuperare.
//
// ═══ E SE ANCHE LA SECONDA FETCH NON RISPONDE ════════════════════════════════════════════════════════
// Allora il mercato viene scartato — ma con un motivo DIVERSO, e la differenza è tutto il punto:
//   `reward-zero`        il venue ha parlato e dice che non c'è programma premi. È un fatto.
//   `reward-sconosciuto` abbiamo chiesto due volte e non lo sappiamo. Non è un fatto sul mercato, è un
//                        fatto sulla nostra lettura, e chi legge l'audit deve poterli contare a parte.
// Schiacciarli in un motivo solo è precisamente il difetto del 5 agosto, un livello più in là.
//
// ═══ COSA NON FA ═════════════════════════════════════════════════════════════════════════════════════
// Non abilita niente, non piazza niente, non allarga nessun gate: restituisce uno STATO più informato di
// quello che aveva chi chiama. Un mercato che dopo la riprova risulta `senza-premio` viene scartato
// esattamente come prima.

const { rewardStateOf } = require('./market-search');

const TTL_MS = 10 * 60_000;
const TETTO_DEFAULT = 12;

/** Il tetto di richieste per ciclo. Un valore illeggibile o assurdo NON spegne la protezione. */
function leggiTetto(env = process.env) {
  const v = Number(env.MAKER_REWARD_RIPROVE_MAX);
  return Number.isFinite(v) && v >= 1 && v <= 50 ? Math.floor(v) : TETTO_DEFAULT;
}

// ── LA CACHE, IN MEMORIA E PER PROCESSO ─────────────────────────────────────────────────────────────
// Non su disco di proposito: è un accorgimento di latenza, non uno stato del sistema. Su disco
// diventerebbe un settimo registro da tenere pulito (§5 punto 77) per risparmiare un decimo di secondo.
const cache = new Map();   // conditionId(lower) → { stato, rate, perche, at }

function leggiCache(cid, nowMs = Date.now(), ttlMs = TTL_MS) {
  const k = String(cid || '').toLowerCase();
  const v = cache.get(k);
  if (!v) return null;
  if (nowMs - v.at > ttlMs) { cache.delete(k); return null; }
  return v;
}

function scriviCache(cid, rec, nowMs = Date.now()) {
  const k = String(cid || '').toLowerCase();
  if (!k) return;
  cache.set(k, { ...rec, at: nowMs });
}

function svuotaCache() { cache.clear(); }

/**
 * SECONDA FETCH MIRATA per i mercati il cui montepremi non si è letto.
 *
 * @param a.righe    le righe già arricchite (`normalizeMarket`), con `rewardsStato`
 * @param a.fetchOne `(conditionId) => Promise<{ok, market}>` — iniettata, così il modulo si prova senza
 *                   rete e non impara a conoscere Gamma. Di difetto usa `fetchMarketByConditionId`.
 * @returns {{righe:Array, riprovate:number, risolte:number, sconosciute:number, daCache:number,
 *            oltreIlTetto:number, tetto:number, dettaglio:Array}}
 */
async function risolviPremiMancanti({ righe = null, fetchOne = null, nowMs = Date.now(),
  tetto = null, ttlMs = TTL_MS } = {}) {
  const lista = Array.isArray(righe) ? righe : [];
  const max = Number.isFinite(Number(tetto)) && tetto >= 1 ? Math.floor(tetto) : leggiTetto();
  const chiedi = typeof fetchOne === 'function'
    ? fetchOne
    : (cid) => require('./market-search').fetchMarketByConditionId(cid);

  let riprovate = 0; let risolte = 0; let sconosciute = 0; let daCache = 0; let oltreIlTetto = 0;
  const dettaglio = [];
  const out = [];

  for (const r of lista) {
    // Solo l'illeggibile si riprova. `senza-premio` è una risposta del venue e non si mette in
    // discussione: richiederla sarebbe traffico per confermare un no già dato.
    if (!r || r.rewardsStato !== 'illeggibile' || !r.marketId) { out.push(r); continue; }

    const inCache = leggiCache(r.marketId, nowMs, ttlMs);
    if (inCache) {
      daCache += 1;
      out.push(applica(r, inCache, 'cache'));
      dettaglio.push({ marketId: r.marketId, esito: inCache.stato, fonte: 'cache' });
      continue;
    }

    if (riprovate >= max) {
      // ── IL TETTO NON PRODUCE UNA CONCLUSIONE ────────────────────────────────────────────────────
      // Un mercato che non si è potuto richiedere resta `illeggibile`, NON diventa `sconosciuto`:
      // «non abbiamo chiesto» e «abbiamo chiesto e non lo sappiamo» sono due cose diverse, e la prima
      // si risolve da sola al giro dopo. Marcarlo come sconosciuto lo condannerebbe per un limite
      // nostro di latenza.
      oltreIlTetto += 1;
      out.push({ ...r, rewardsRiprova: 'oltre-il-tetto',
        rewardsPerche: `${r.rewardsPerche} — non richiesto: raggiunto il tetto di ${max} riprove per ciclo, si riprova al giro successivo` });
      dettaglio.push({ marketId: r.marketId, esito: 'oltre-il-tetto', fonte: null });
      continue;
    }

    riprovate += 1;
    let stato = null;
    try {
      const res = await chiedi(r.marketId);
      const m = res && res.market ? res.market : null;
      if (m && m.rewardsStato && m.rewardsStato !== 'illeggibile') {
        stato = { stato: m.rewardsStato, rate: m.rewardsDailyRate ?? null, perche: m.rewardsPerche || null };
      } else if (m && m.raw) {
        // Il grezzo, se il chiamante lo porta: si rifà la lettura con la STESSA funzione della prima
        // volta, invece di una seconda interpretazione che potrebbe non essere d'accordo.
        const s = rewardStateOf(m.raw);
        if (s.stato !== 'illeggibile') stato = s;
      }
    } catch (e) {
      stato = null;
      dettaglio.push({ marketId: r.marketId, esito: 'errore', fonte: 'rete', motivo: e && e.message ? e.message : String(e) });
    }

    if (stato) {
      scriviCache(r.marketId, stato, nowMs);
      risolte += 1;
      out.push(applica(r, stato, 'riprova'));
      dettaglio.push({ marketId: r.marketId, esito: stato.stato, fonte: 'riprova' });
    } else {
      // ⚠ IL FALLIMENTO NON SI METTE IN CACHE. Mettercelo congelerebbe per dieci minuti una risposta
      // che potrebbe tornare al secondo tentativo — e il TTL esiste per risparmiare richieste, non per
      // ricordare un'assenza.
      sconosciute += 1;
      out.push({ ...r, rewardsStato: 'illeggibile', rewardsRiprova: 'sconosciuto',
        rewardsPerche: `${r.rewardsPerche} — richiesto una seconda volta per condition_id e ancora non pubblicato` });
      dettaglio.push({ marketId: r.marketId, esito: 'sconosciuto', fonte: 'riprova' });
    }
  }

  return { righe: out, riprovate, risolte, sconosciute, daCache, oltreIlTetto, tetto: max, dettaglio };
}

function applica(riga, stato, fonte) {
  return {
    ...riga,
    rewardsStato: stato.stato,
    rewardsDailyRate: stato.rate != null ? stato.rate : riga.rewardsDailyRate,
    hasRewards: stato.stato === 'premiato',
    rewardsPerche: `${stato.perche || stato.stato} (seconda lettura per condition_id, ${fonte})`,
    rewardsRiprova: fonte,
  };
}

/**
 * IL MOTIVO DELLO SCARTO, distinto. È la parte del requisito che rende contabile la differenza.
 *
 * @returns {'ok'|'reward-zero'|'reward-sconosciuto'}
 */
function motivoScarto(riga) {
  if (!riga) return 'reward-sconosciuto';
  if (riga.rewardsStato === 'premiato') return 'ok';
  if (riga.rewardsStato === 'senza-premio') return 'reward-zero';
  return 'reward-sconosciuto';
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) { p += 1; console.log(`  ✓ ${n}`); } else { f += 1; console.log(`  ✗ ${n}`); } };
  console.log('\n════ reward-riprova ════');
  svuotaCache();

  const riga = (id, stato) => ({ marketId: id, rewardsStato: stato, rewardsPerche: 'motivo originale',
    rewardsDailyRate: stato === 'premiato' ? 10 : (stato === 'senza-premio' ? 0 : null),
    hasRewards: stato === 'premiato' });

  (async () => {
    // Il caso che il difetto produceva: illeggibile alla prima, premiato alla seconda.
    let chiamate = 0;
    const r1 = await risolviPremiMancanti({
      righe: [riga('0xa', 'illeggibile'), riga('0xb', 'premiato'), riga('0xc', 'senza-premio')],
      fetchOne: async () => { chiamate += 1; return { ok: true, market: { rewardsStato: 'premiato', rewardsDailyRate: 42, rewardsPerche: 'montepremi pubblicato: 42$/g' } }; },
      nowMs: 1000,
    });
    ok('si richiede SOLO l\'illeggibile', chiamate === 1 && r1.riprovate === 1);
    ok('  e il mercato torna premiato', r1.righe[0].rewardsStato === 'premiato' && r1.righe[0].hasRewards === true);
    ok('  col montepremi vero', r1.righe[0].rewardsDailyRate === 42);
    ok('  «senza-premio» NON si rimette in discussione', r1.righe[2].rewardsStato === 'senza-premio');
    ok('  e il premiato resta intatto', r1.righe[1].rewardsStato === 'premiato');
    ok('il motivo di scarto distingue i due casi',
      motivoScarto(r1.righe[0]) === 'ok' && motivoScarto(r1.righe[2]) === 'reward-zero');

    // La cache: seconda passata, nessuna richiesta.
    const r2 = await risolviPremiMancanti({
      righe: [riga('0xa', 'illeggibile')],
      fetchOne: async () => { chiamate += 1; return { ok: true, market: { rewardsStato: 'premiato', rewardsDailyRate: 42 } }; },
      nowMs: 1000 + 60_000,
    });
    ok('dentro il TTL la cache risponde senza rete', chiamate === 1 && r2.daCache === 1 && r2.riprovate === 0);
    const r3 = await risolviPremiMancanti({
      righe: [riga('0xa', 'illeggibile')],
      fetchOne: async () => { chiamate += 1; return { ok: true, market: { rewardsStato: 'premiato', rewardsDailyRate: 42 } }; },
      nowMs: 1000 + 11 * 60_000,
    });
    ok('oltre i 10 minuti la cache scade e si richiede', chiamate === 2 && r3.riprovate === 1);

    // Il fallimento: scartato, ma con il motivo giusto.
    svuotaCache();
    const r4 = await risolviPremiMancanti({
      righe: [riga('0xz', 'illeggibile')],
      fetchOne: async () => ({ ok: false, market: null }),
      nowMs: 2000,
    });
    ok('seconda fetch a vuoto ⇒ resta illeggibile', r4.righe[0].rewardsStato === 'illeggibile' && r4.sconosciute === 1);
    ok('  e il motivo è `reward-sconosciuto`, DIVERSO da `reward-zero`',
      motivoScarto(r4.righe[0]) === 'reward-sconosciuto' && motivoScarto(r4.righe[0]) !== 'reward-zero');
    ok('  il motivo dice che si è chiesto due volte', /una seconda volta/.test(r4.righe[0].rewardsPerche));
    const r5 = await risolviPremiMancanti({
      righe: [riga('0xz', 'illeggibile')],
      fetchOne: async () => ({ ok: true, market: { rewardsStato: 'premiato', rewardsDailyRate: 7 } }),
      nowMs: 2000,
    });
    ok('  e un fallimento NON viene messo in cache: al giro dopo si riprova', r5.riprovate === 1 && r5.righe[0].rewardsStato === 'premiato');

    // Il tetto.
    svuotaCache();
    let n = 0;
    const molte = Array.from({ length: 20 }, (_, i) => riga(`0x${i}`, 'illeggibile'));
    const r6 = await risolviPremiMancanti({ righe: molte, tetto: 3, nowMs: 3000,
      fetchOne: async () => { n += 1; return { ok: false, market: null }; } });
    ok('il tetto limita le richieste per ciclo', n === 3 && r6.riprovate === 3 && r6.oltreIlTetto === 17);
    ok('  e chi resta fuori NON diventa «sconosciuto»',
      r6.righe[19].rewardsRiprova === 'oltre-il-tetto' && motivoScarto(r6.righe[19]) === 'reward-sconosciuto');
    ok('  ma il suo motivo dice che non è stato CHIESTO', /tetto di 3 riprove/.test(r6.righe[19].rewardsPerche));

    ok('un\'eccezione di rete vale «sconosciuto», non un crash',
      (await risolviPremiMancanti({ righe: [riga('0xe', 'illeggibile')], nowMs: 4000,
        fetchOne: async () => { throw new Error('ECONNRESET'); } })).sconosciute === 1);

    ok('il tetto di difetto è 12 (misurato: mediana 106ms per fetch)', leggiTetto({}) === 12);
    ok('  e un valore assurdo viene scartato',
      leggiTetto({ MAKER_REWARD_RIPROVE_MAX: '999' }) === 12 && leggiTetto({ MAKER_REWARD_RIPROVE_MAX: 'x' }) === 12);
    ok('  ma uno valido viene rispettato', leggiTetto({ MAKER_REWARD_RIPROVE_MAX: '5' }) === 5);

    console.log(`\nreward-riprova: ${p} passati, ${f} falliti`);
    if (require.main === module) process.exit(f === 0 ? 0 : 1);
  })();
  return true;
}

module.exports = {
  risolviPremiMancanti, motivoScarto, leggiTetto, leggiCache, scriviCache, svuotaCache,
  TTL_MS, TETTO_DEFAULT, selfcheck,
};

if (require.main === module) selfcheck();

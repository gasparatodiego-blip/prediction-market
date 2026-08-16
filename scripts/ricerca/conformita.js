#!/usr/bin/env node
'use strict';
/*
 * scripts/ricerca/conformita.js — IL SECONDO PARERE SUGLI ORDINI VIVI.
 * =====================================================================================================
 *
 * A COSA SERVE. Il giro di prova non verifica i premi, verifica la CONFORMITA': gli ordini che il bot
 * ha davvero sul libro rispettano le regole che il bot dice di rispettare? Ogni 30 secondi, in sola
 * lettura, questo processo guarda gli ordini vivi e il book del venue e scrive un verdetto per ordine
 * in `data/conformita.jsonl`.
 *
 * ═══ LA REGOLA CHE GOVERNA OGNI RIGA DI QUESTO FILE ═════════════════════════════════════════════════
 * **NON SI LEGGE NIENTE DI CIO' CHE IL MAKER DICHIARA.** Un controllore che legge il verdetto del
 * controllato non e' un controllore, e' un'eco: se il maker sbaglia a calcolare la banda, un
 * verificatore che importa la stessa funzione sbaglia *identicamente* e stampa «conforme». E' successo
 * davvero in questo repo — per settimane il raggio di banda e' stato la META' di quello vero, e i test
 * che lo controllavano erano verdi perche' derivavano dalla stessa definizione sbagliata (§5-bis p.155).
 *
 * In concreto, questo script NON legge:
 *   · `data/liquidity-rewards.json`      — il board di agent24: e' cio' che il maker CREDE del mercato
 *   · `data/maker-auto-reprice*.json`    — la lista e lo stato del riprezzo
 *   · `data/polymarket-maker-audit.jsonl`, `data/realloc-scheduler.jsonl`, `data/maker-offsets.json`
 *   · `data/venue-positions.json`        — lo snapshot che scrive il maker
 *   · `lib/banda-premiante`, `lib/maker/motore-unico`, `lib/maker/top-of-book`,
 *     `lib/maker/distanza-obiettivo`, `lib/rewards/concentration` — la MATEMATICA del maker
 * e ne verifica l'assenza a runtime camminando `require.cache` (§ AUTOVERIFICA, in fondo).
 *
 * Legge invece, e solo:
 *   · il CLOB pubblico  `GET /book?token_id=…`        — il libro vero, senza credenziali
 *   · il CLOB pubblico  `GET /markets/{conditionId}`  — tick, min_incentive_size, max_spread del VENUE
 *   · il CLOB firmato   `GET /data/orders`            — gli ordini vivi, firma L2 HMAC
 *   · `data/safety-risk-limits.json`                  — i tetti che l'OPERATORE ha dichiarato
 *
 * ⚠ LA DUPLICAZIONE DELLA FORMULA E' DELIBERATA, ed e' l'unico posto del repo in cui lo sia.
 * `raggioBandaCents` e' riscritta qui sotto invece di essere importata. Normalmente sarebbe il reperto
 * **D1** («costante/formula ricopiata invece che importata») e l'audit di agent44 la segnalerebbe:
 * qui e' il PUNTO. Due implementazioni indipendenti che concordano sono una prova; una sola letta due
 * volte non e' niente. Se un giorno divergono, e' esattamente il segnale che questo script esiste per
 * dare — non un difetto da «unificare».
 *
 * ═══ COSA NON PUO' FARE, PER COSTRUZIONE ════════════════════════════════════════════════════════════
 * Non piazza, non cancella, non riprezza, non tocca nessun interruttore. L'unica credenziale che
 * maneggia e' la coppia **L2 (HMAC)**, che autentica le GET e **non puo' firmare un ordine**: la chiave
 * che firma (`makerSignerProvider`) non e' importata e non e' raggiungibile da qui. E' la stessa
 * separazione su cui poggia `reward-reale.js`.
 * Scrive due soli file, entrambi suoi: `data/conformita.jsonl` (append) e `data/conformita-stato.json`
 * (l'orologio del fuori-banda, per sopravvivere a un riavvio).
 *
 * ═══ USO ═══════════════════════════════════════════════════════════════════════════════════════════
 *   node scripts/ricerca/conformita.js            # ciclo continuo, 30s
 *   node scripts/ricerca/conformita.js --once     # un giro solo, poi esce
 *   node scripts/ricerca/conformita.js --dry      # un giro, stampa e NON scrive niente su disco
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const RADICE = path.resolve(__dirname, '..', '..');
const DATI = path.join(RADICE, 'data');
const GIORNALE = path.join(DATI, 'conformita.jsonl');
const STATO = path.join(DATI, 'conformita-stato.json');
const TETTI = path.join(DATI, 'safety-risk-limits.json');

const CADENZA_MS = Number(process.env.CONFORMITA_CADENZA_MS || 30_000);
const HOST = (process.env.POLY_CLOB_BASE || 'https://clob.polymarket.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const TIMEOUT_MS = 15_000;
const SOLO_UNA = process.argv.includes('--once') || process.argv.includes('--dry');
const A_SECCO = process.argv.includes('--dry');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (x) => { const n = Number(x); return fin(n) ? n : null; };
const ora = () => Date.now();

// ═══ LA MATEMATICA, RISCRITTA APPOSTA ══════════════════════════════════════════════════════════════
// Definizione dal venue: `max_spread` e' il raggio in CENTESIMI attorno al mid entro cui un ordine
// matura. Non e' `max_spread / 2` — quella lettura e' costata a questo repo settimane di ordini fuori
// banda creduti dentro. Riscritta qui perche' un secondo parere non puo' importare il primo.
function raggioBandaC(maxSpread) {
  const v = num(maxSpread);
  if (v == null || v <= 0) return null;
  return v;
}
// Il punteggio del venue: S = ((v − s) / v)², zero al bordo e fuori.
function punteggioS(distanzaC, maxSpread) {
  const v = raggioBandaC(maxSpread);
  if (v == null || !fin(distanzaC)) return null;
  const s = Math.abs(distanzaC);
  if (s >= v) return 0;
  const r = (v - s) / v;
  return +(r * r).toFixed(6);
}
// Un prezzo e' un multiplo del tick? Si lavora in interi per non farsi ingannare dai float: 0,1 + 0,2
// non fa 0,3, e un ordine perfettamente valido sembrerebbe off-tick.
function suTick(prezzo, tick) {
  const p = num(prezzo); const t = num(tick);
  if (p == null || t == null || t <= 0) return null;
  const scala = Math.round(1 / t);
  return Math.abs(p * scala - Math.round(p * scala)) < 1e-6;
}

// ═══ RETE, SOLO GET ════════════════════════════════════════════════════════════════════════════════
function get(percorso, intestazioni = {}) {
  return new Promise((resolve) => {
    const req = https.request({ host: HOST, path: percorso, method: 'GET', timeout: TIMEOUT_MS,
      headers: { Accept: 'application/json', 'User-Agent': 'conformita/1.0 (read-only audit)', ...intestazioni } },
    (res) => {
      let corpo = '';
      res.on('data', (d) => { corpo += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return resolve({ ok: false, stato: res.statusCode, motivo: corpo.slice(0, 200) });
        try { resolve({ ok: true, dati: JSON.parse(corpo) }); }
        catch (e) { resolve({ ok: false, motivo: `JSON non valido: ${e.message}` }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, motivo: `timeout ${TIMEOUT_MS}ms` }); });
    req.on('error', (e) => resolve({ ok: false, motivo: e.message }));
    req.end();
  });
}

// La firma L2: HMAC-SHA256 base64url di `timestamp + METODO + path`. Riscritta qui, come la banda.
// ⚠ La firma e' sul percorso COMPLETO, query inclusa: firmando il solo path il CLOB risponde 400.
function firmaL2({ secret, timestamp, percorso }) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${timestamp}GET${percorso}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
}

let _creds = null;
async function credenziali() {
  if (_creds !== null) return _creds;
  try {
    // Lazy: la coppia L2 sta nel DB. E' la credenziale che CANCELLA e legge, mai quella che firma un
    // ordine — `makerSignerProvider` non e' importato in questo file e non e' raggiungibile da qui.
    const { polymarketCancelCredsProvider } = require(path.join(RADICE, 'lib/maker/cancel-creds-provider'));
    const c = await polymarketCancelCredsProvider();
    if (!c || !c.creds || !c.creds.key || !c.creds.secret || !c.creds.passphrase || !c.address) {
      _creds = { ok: false, motivo: 'credenziali L2 incomplete' }; return _creds;
    }
    _creds = { ok: true, ...c };
  } catch (e) {
    _creds = { ok: false, motivo: `credenziali L2 non disponibili: ${e && e.message ? e.message : String(e)}` };
  }
  return _creds;
}

async function ordiniVivi() {
  const c = await credenziali();
  if (!c.ok) return { ok: false, motivo: c.motivo };
  const percorso = '/data/orders';
  const timestamp = Math.floor(ora() / 1000).toString();
  const r = await get(percorso, {
    POLY_ADDRESS: c.address,
    POLY_SIGNATURE: firmaL2({ secret: c.creds.secret, timestamp, percorso }),
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: c.creds.key,
    POLY_PASSPHRASE: c.creds.passphrase,
  });
  if (!r.ok) return { ok: false, motivo: `GET ${percorso}: ${r.motivo || r.stato}` };
  const lista = Array.isArray(r.dati) ? r.dati : (Array.isArray(r.dati && r.dati.data) ? r.dati.data : null);
  if (!lista) return { ok: false, motivo: 'risposta ordini in forma inattesa' };
  return { ok: true, ordini: lista };
}

// ═══ IL MID, DAL LIBRO VERO ════════════════════════════════════════════════════════════════════════
// ⚠ IL MID SI CALCOLA DAL BOOK, NON SI CHIEDE A NESSUNO. E si calcola dal MIGLIOR BID e MIGLIOR ASK
// del token, cioe' i due estremi: un book con un solo lato non ha un mid, e `null` non diventa mai un
// numero di comodo. Un mid inventato renderebbe «conforme» qualunque cosa.
const cacheBook = new Map();
async function book(tokenId) {
  const c = cacheBook.get(tokenId);
  if (c && ora() - c.at < 5_000) return c.val;
  const r = await get(`/book?token_id=${encodeURIComponent(tokenId)}`);
  let val;
  if (!r.ok) val = { ok: false, motivo: r.motivo || `HTTP ${r.stato}` };
  else {
    const bids = Array.isArray(r.dati && r.dati.bids) ? r.dati.bids : [];
    const asks = Array.isArray(r.dati && r.dati.asks) ? r.dati.asks : [];
    // Il CLOB restituisce i livelli in ordine crescente di prezzo: il miglior BID e' l'ULTIMO,
    // il miglior ASK il PRIMO. Si prende il massimo/minimo esplicito invece di fidarsi dell'ordine.
    const bb = bids.length ? Math.max(...bids.map((x) => num(x.price)).filter(fin)) : null;
    const ba = asks.length ? Math.min(...asks.map((x) => num(x.price)).filter(fin)) : null;
    val = { ok: true, bestBid: fin(bb) ? bb : null, bestAsk: fin(ba) ? ba : null,
      mid: fin(bb) && fin(ba) ? +((bb + ba) / 2).toFixed(6) : null,
      livelliBid: bids.length, livelliAsk: asks.length };
  }
  cacheBook.set(tokenId, { at: ora(), val });
  return val;
}

const cacheMercato = new Map();
async function mercato(conditionId) {
  const c = cacheMercato.get(conditionId);
  if (c && ora() - c.at < 300_000) return c.val;
  const r = await get(`/markets/${encodeURIComponent(conditionId)}`);
  let val;
  if (!r.ok) val = { ok: false, motivo: r.motivo || `HTTP ${r.stato}` };
  else {
    const d = r.dati || {};
    // I parametri premianti stanno sotto `rewards`, e la forma e' cambiata nel tempo: si accettano
    // entrambe le grafie invece di indovinarne una.
    const rw = d.rewards || {};
    const rates = Array.isArray(rw.rates) ? rw.rates[0] || {} : {};
    val = { ok: true,
      tick: num(d.minimum_tick_size) ?? num(d.tickSize),
      minSize: num(rw.min_size) ?? num(rw.minimum_size) ?? num(d.minimum_order_size),
      maxSpread: num(rw.max_spread) ?? num(rw.maxSpread) ?? num(rates.max_spread),
      chiuso: d.closed === true, accetta: d.accepting_orders !== false,
      tokenPerOutcome: Array.isArray(d.tokens) ? d.tokens.map((t) => String(t.token_id)) : [] };
  }
  cacheMercato.set(conditionId, { at: ora(), val });
  return val;
}

// ═══ L'OROLOGIO DEL FUORI-BANDA ════════════════════════════════════════════════════════════════════
// Persistito su disco perche' la domanda «da quanti secondi?» perde senso se un riavvio la azzera. Chi
// legge deve poter distinguere un orologio ripristinato da uno osservato senza interruzioni.
function caricaStato() {
  try { const j = JSON.parse(fs.readFileSync(STATO, 'utf8')); return (j && typeof j.fuoriDa === 'object') ? j.fuoriDa : {}; }
  catch { return {}; }
}
function salvaStato(fuoriDa) {
  if (A_SECCO) return;
  try {
    const tmp = `${STATO}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ aggiornatoAl: new Date().toISOString(), fuoriDa }, null, 1));
    fs.renameSync(tmp, STATO);
  } catch { /* la sorveglianza non deve morire perche' non ha potuto salvare il proprio orologio */ }
}
let fuoriDa = caricaStato();
const ripristinati = new Set(Object.keys(fuoriDa));

function scrivi(record) {
  if (A_SECCO) { console.log(JSON.stringify(record)); return; }
  try { fs.appendFileSync(GIORNALE, `${JSON.stringify(record)}\n`); }
  catch (e) { console.error(`[conformita] scrittura fallita: ${e.message}`); }
}

function leggiTetti() {
  try {
    const j = JSON.parse(fs.readFileSync(TETTI, 'utf8'));
    const g = (j && j.global) || {};
    return { leggibile: true, perOrdine: num(g.maxOrderNotionalUsd), esposizione: num(g.maxOpenNotionalUsd) };
  } catch (e) { return { leggibile: false, motivo: e.message, perOrdine: null, esposizione: null }; }
}

// ═══ IL GIRO ═══════════════════════════════════════════════════════════════════════════════════════
async function giro() {
  const t0 = ora();
  const iso = new Date(t0).toISOString();
  const tetti = leggiTetti();

  const ord = await ordiniVivi();
  if (!ord.ok) {
    // ⚠ «NON HO LETTO» NON E' «NON CI SONO ORDINI». Zero ordini e ordini illeggibili sono due fatti
    // opposti, e schiacciarli su una riga vuota renderebbe questo giornale una bugia tranquilla.
    scrivi({ at: iso, tipo: 'giro', esito: 'ordini-non-leggibili', motivo: ord.motivo, ordini: null });
    console.error(`[conformita] ${iso} ordini non leggibili: ${ord.motivo}`);
    return;
  }

  const ordini = ord.ordini;
  const vivi = new Set();
  let esposizione = 0;
  const verdetti = [];

  for (const o of ordini) {
    const id = String(o.id || o.order_id || o.orderID || '');
    const tokenId = String(o.asset_id || o.tokenId || o.token_id || '');
    const conditionId = String(o.market || o.condition_id || o.conditionId || '').toLowerCase();
    const lato = String(o.side || '').toUpperCase();
    const prezzo = num(o.price);
    // Cio' che RESTA sul libro, non cio' che e' stato inviato: `size_matched` e' gia' eseguito.
    const originale = num(o.original_size) ?? num(o.size);
    const eseguito = num(o.size_matched) ?? 0;
    const taglia = fin(originale) ? +(originale - (fin(eseguito) ? eseguito : 0)).toFixed(6) : null;
    vivi.add(id);

    const b = tokenId ? await book(tokenId) : { ok: false, motivo: 'ordine senza tokenId' };
    const m = conditionId ? await mercato(conditionId) : { ok: false, motivo: 'ordine senza conditionId' };

    const v = m.ok ? raggioBandaC(m.maxSpread) : null;
    const mid = b.ok ? b.mid : null;
    const distC = fin(mid) && fin(prezzo) ? +(Math.abs(mid - prezzo) * 100).toFixed(4) : null;
    // ⚠ TRE STATI, NON DUE: dentro / fuori / NON GIUDICABILE. Un mid o una banda che non si leggono
    // non fanno un ordine conforme — fanno un ordine su cui questo controllore tace, e lo dice.
    const dentro = (distC == null || v == null) ? null : distC <= v + 1e-9;
    const nozionale = fin(prezzo) && fin(taglia) ? +(prezzo * taglia).toFixed(4) : null;
    if (fin(nozionale)) esposizione += nozionale;

    // L'orologio del fuori-banda, per ordine.
    let fuoriDaSec = null; let orologio = 'non-applicabile';
    if (dentro === false) {
      if (!fuoriDa[id]) { fuoriDa[id] = t0; orologio = 'appena-rilevato'; }
      else orologio = ripristinati.has(id) ? 'ripristinato-da-disco' : 'osservato';
      fuoriDaSec = Math.round((t0 - fuoriDa[id]) / 1000);
    } else if (dentro === true && fuoriDa[id]) {
      orologio = 'rientrato'; delete fuoriDa[id]; ripristinati.delete(id);
    } else if (dentro === null) {
      // Non giudicabile: l'orologio NON avanza e NON si azzera. Un buco di lettura non puo' ne'
      // aggravare ne' assolvere.
      orologio = 'sospeso-non-giudicabile';
      if (fuoriDa[id]) fuoriDaSec = Math.round((t0 - fuoriDa[id]) / 1000);
    }

    verdetti.push({
      at: iso, tipo: 'ordine', id, conditionId, tokenId, lato,
      prezzo, taglia, tagliaOriginale: originale, eseguito,
      // Il libro e la banda, come li vede QUESTO processo
      mid, bestBid: b.ok ? b.bestBid : null, bestAsk: b.ok ? b.bestAsk : null,
      bandaRaggioC: v, maxSpread: m.ok ? m.maxSpread : null,
      // I quattro verdetti chiesti
      dentroBanda: dentro,
      distanzaC: distC,
      distanzaFrazioneBanda: (distC != null && v) ? +(distC / v).toFixed(4) : null,
      punteggioS: (distC != null && v != null) ? punteggioS(distC, m.maxSpread) : null,
      tagliaSopraMinimo: (fin(taglia) && m.ok && fin(m.minSize)) ? taglia >= m.minSize : null,
      minSizeVenue: m.ok ? m.minSize : null,
      prezzoSuTick: m.ok ? suTick(prezzo, m.tick) : null,
      tickVenue: m.ok ? m.tick : null,
      nozionaleUsd: nozionale,
      oltreTettoPerOrdine: (fin(nozionale) && fin(tetti.perOrdine)) ? nozionale > tetti.perOrdine : null,
      // L'orologio
      fuoriBandaDaSec: fuoriDaSec, orologio,
      // Perche' un campo e' nullo: senza questo, «non giudicabile» e «conforme» si confondono
      motivoBook: b.ok ? null : b.motivo,
      motivoMercato: m.ok ? null : m.motivo,
      mercatoChiuso: m.ok ? m.chiuso : null,
    });
  }

  // Gli ordini spariti dal libro non tengono in vita il proprio orologio.
  for (const id of Object.keys(fuoriDa)) if (!vivi.has(id)) { delete fuoriDa[id]; ripristinati.delete(id); }
  salvaStato(fuoriDa);

  for (const v of verdetti) scrivi(v);

  const fuori = verdetti.filter((x) => x.dentroBanda === false).length;
  const muti = verdetti.filter((x) => x.dentroBanda === null).length;
  const offTick = verdetti.filter((x) => x.prezzoSuTick === false).length;
  const sottoMin = verdetti.filter((x) => x.tagliaSopraMinimo === false).length;
  const oltreOrd = verdetti.filter((x) => x.oltreTettoPerOrdine === true).length;
  const esp = +esposizione.toFixed(4);

  scrivi({ at: iso, tipo: 'giro', esito: 'ok', durataMs: ora() - t0,
    ordini: verdetti.length, fuoriBanda: fuori, nonGiudicabili: muti,
    fuoriTick: offTick, sottoMinimo: sottoMin, oltreTettoPerOrdine: oltreOrd,
    // ── L'ESPOSIZIONE: DUE DOMANDE DIVERSE, E DA QUI SE NE VEDE UNA SOLA ─────────────────────────
    //
    // ⚠ CORRETTO IL 16 AGOSTO 2026. Qui c'era `oltreTettoEsposizione: esp > tetti.esposizione`, e il
    // commento due righe piu' sotto diceva GIA' perche' era sbagliato — il codice faceva il confronto
    // lo stesso. E' il reperto D7 di questo repo (il commento e' cio' che si legge, il codice cio' che
    // accade), commesso nello strumento che esiste per non fidarsi delle dichiarazioni altrui.
    //
    // COSA CONFRONTAVA: la somma dei nozionali degli ordini A RIPOSO contro `maxOpenNotionalUsd`, che
    // governa i fill RICONCILIATI (`lib/safety/fills.js:353-357`, scelta dell'operatore del 2 agosto).
    // Misurato mentre il campo urlava `true`: **$158,75 a riposo** contro **$3,00 riconciliati** e un
    // tetto di $150. Nessun tetto era stato superato, e nessun ordine sarebbe stato rifiutato.
    // Un booleano che si chiama «oltre il tetto» e vale `true` quando niente e' oltre il tetto e' il
    // modo in cui un allarme smette di essere letto.
    //
    // COSA SI RISPONDE ADESSO, e resta una domanda utile: *se ogni ordine a riposo venisse riempito*,
    // quell'esposizione diventerebbe riconciliata e il tetto morderebbe. E' una PROIEZIONE, e va letta
    // con i suoi due limiti dichiarati:
    //   · e' un TETTO SUPERIORE di cio' che verrebbe aggiunto — una coppia completata puo' essere fusa
    //     o riscattata, e allora l'esposizione scende invece di salire;
    //   · e' un LIMITE INFERIORE della violazione, perche' NON somma l'esposizione gia' riconciliata:
    //     leggerla vorrebbe dire importare la contabilita' del maker, cioe' diventare la sua eco, che
    //     e' esattamente cio' che questo processo non deve fare.
    // Per questo il campo dice `SeRiempitiTutti` e non «oltre»: il nome porta la condizione con se'.
    esposizioneARiposoUsd: esp,
    tettoEsposizioneUsd: tetti.esposizione, tettoPerOrdineUsd: tetti.perOrdine,
    superebbeIlTettoSeRiempitiTutti: fin(tetti.esposizione) ? esp > tetti.esposizione : null,
    tettiLeggibili: tetti.leggibile,
    notaEsposizione: 'nozionali a RIPOSO. `maxOpenNotionalUsd` governa i fill RICONCILIATI: finche\' questi'
      + ' ordini non si riempiono non pesano su quel tetto. Il confronto qui e\' una proiezione, non una violazione' });

  console.log(`[conformita] ${iso} · ${verdetti.length} ordini · fuori banda ${fuori} · non giudicabili ${muti}`
    + ` · off-tick ${offTick} · sotto minimo ${sottoMin} · a riposo $${esp.toFixed(2)}`
    + (fin(tetti.esposizione) && esp > tetti.esposizione
      ? ` ⚠ se si riempissero TUTTI supererebbero il tetto di $${tetti.esposizione} (proiezione, non una violazione di adesso)` : ''));
}

// ═══ AUTOVERIFICA: QUESTO PROCESSO NON PUO' AGIRE, E LO DIMOSTRA ═══════════════════════════════════
// Si cammina `require.cache` DOPO aver caricato tutto: se una superficie che sa piazzare, cancellare o
// decidere un prezzo e' finita nell'albero — anche per una require indiretta — si esce invece di
// sorvegliare. E' la stessa forma della verifica che fa `scripts/cli/stato.js`.
// La lista contiene anche i moduli del maker la cui MATEMATICA renderebbe questo script un'eco.
const VIETATI = [
  'venues/polymarket-clob-maker/adapter', 'maker/manual-order', 'maker/bulk-allocate',
  'maker/auto-close', 'maker/auto-reprice', 'maker/cancel-all', 'maker/ctf-relayer',
  'maker/live-providers', 'maker/bot-enabled', 'safety/kill-switch',
  'banda-premiante', 'maker/motore-unico', 'maker/top-of-book', 'maker/distanza-obiettivo',
  'rewards/concentration', 'rewards/allocator', 'maker/auto-reprice-config',
];
function autoverifica() {
  const caricati = Object.keys(require.cache).map((p) => p.replace(/\\/g, '/'));
  const colpevoli = [];
  for (const v of VIETATI) {
    const hit = caricati.find((p) => p.includes(`/lib/${v}.js`) || p.endsWith(`/lib/${v}.js`));
    if (hit) colpevoli.push(v);
  }
  if (colpevoli.length) {
    console.error('[conformita] RIFIUTO DI PARTIRE: nel mio albero sono finiti moduli che agiscono o'
      + ` di cui dovrei essere il secondo parere: ${colpevoli.join(', ')}.`
      + ' Un controllore che importa il controllato e\' un\'eco, non una verifica.');
    process.exit(2);
  }
}

async function main() {
  autoverifica();
  console.log(`[conformita] avvio · cadenza ${CADENZA_MS / 1000}s · giornale ${GIORNALE}`
    + `${A_SECCO ? ' · A SECCO: nessuna scrittura' : ''}`);
  console.log('[conformita] sola lettura: book pubblico + GET firmate L2. Non piazza, non cancella, non riprezza.');
  await giro();
  if (SOLO_UNA) return;
  const t = setInterval(() => { giro().catch((e) => console.error(`[conformita] giro fallito: ${e.message}`)); }, CADENZA_MS);
  const chiudi = () => { clearInterval(t); salvaStato(fuoriDa); process.exit(0); };
  process.on('SIGINT', chiudi);
  process.on('SIGTERM', chiudi);
}

if (require.main === module) main().catch((e) => { console.error(`[conformita] ${e.stack || e.message}`); process.exit(1); });

module.exports = { raggioBandaC, punteggioS, suTick, firmaL2 };

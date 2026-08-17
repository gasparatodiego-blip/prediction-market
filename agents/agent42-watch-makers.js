#!/usr/bin/env node
'use strict';

// ══ IL CARICATORE DI `.env` — SOLO LA FAMIGLIA `WATCH21_` (12 agosto 2026) ═════════════════════════
// Perche' esiste, perche' e' ristretto e perche' oggi carica zero: lib/safety/carica-env.js.
// LA RESTRIZIONE QUI E' LA PIU' STRETTA DELLE TRE, e per la ragione piu' forte: §3 chiama questo
// «l'unico processo della flotta che non puo' toccare capitale nemmeno in linea di principio (nessun
// import da lib/maker/, nessuna credenziale)». Quella frase e' difesa da un test che cammina l'albero
// dei require; caricare `.env` per intero non la farebbe fallire — e proprio per questo sarebbe il
// modo di indebolirla senza che nulla diventi rosso.
require('../lib/safety/carica-env').caricaEnv({
  radice: require('path').join(__dirname, '..'),
  consentite: [/^WATCH21_/],
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// agent42-watch-makers — IL MONITOR LIVE DEI 21 MAKER DI RIFERIMENTO
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Segue l'attività PUBBLICA dei 21 wallet del manuale v2 (data/manuale-operativo-maker-v2.md) e la
// trasforma in tre segnali: chi ENTRA su un mercato mai toccato, quando due o più entrano sullo
// STESSO mercato in poche ore (CONVERGENZA), e quanto prima della risoluzione ciascuno SMETTE di
// farsi riempire (RITIRO).
//
// ── PERIMETRO — QUESTO PROCESSO NON AGISCE ──────────────────────────────────────────────────────
// Sola lettura di endpoint pubblici. Nessuna chiave, nessuna firma, nessun ordine, nessuna scrittura
// su nessuno stato del motore maker. Non importa nulla da lib/maker/ e non tocca i file che decidono
// il piazzamento (maker-manual-markets.json, maker-arming.json, maker-auto-*.json): li ignora del
// tutto. Scrive ESCLUSIVAMENTE i quattro file elencati qui sotto, che nessun processo che piazza
// ordini legge. Il segnale è informativo: usarlo come criterio di selezione è una decisione
// successiva dell'operatore, non una conseguenza automatica di questo agente.
//
// ── PERCHÉ POLLING E NON WEBSOCKET ──────────────────────────────────────────────────────────────
// La domanda naturale è «riusa il socket CLOB di agent34». Non si può, e il motivo è nel protocollo,
// non nel nostro codice: il market channel pubblica `book`, `price_change`, `tick_size_change` e
// `last_trade_price`, e NESSUNO di questi porta l'identità di chi ha eseguito — `last_trade_price`
// è {asset_id, price, side, size} e basta (vedi lib/clob-ws/live-book.js:125). L'unico canale che
// nomina un wallet è `user`, che è autenticato e vede SOLO il wallet delle credenziali usate. Un
// socket pubblico non può quindi attribuire un fill a uno dei 21: userebbe una connessione in più
// per un dato che non contiene la risposta.
//
// La data-api invece nomina il wallet in chiaro (`proxyWallet`) e permette il filtro `?user=`. Un
// giro completo dei 21 costa 21 GET da ~50-120 ms; con la pausa di cortesia sta in ~7-8 s. A ciclo
// da 30 s la latenza attesa di rilevamento è mediana ~23 s, peggiore ~40 s. Per un segnale che serve
// a decidere se guardare un mercato — non a competere su un book — 30 s è largamente sufficiente, e
// costa un ordine di grandezza meno di un socket che comunque non risponderebbe alla domanda.
//
// ── NESSUN EVENTO SI PERDE IN SILENZIO ──────────────────────────────────────────────────────────
// Il polling non ha «riconnessione»: ha un `ultimoTs` per wallet e ripagina all'indietro finché non
// lo raggiunge. Un processo fermo due ore, o una rete caduta, al ritorno rilegge semplicemente più
// pagine e recupera il buco — i trade persi sono ancora lì, la data-api è uno storico. L'unico caso
// in cui un evento potrebbe sfuggire è un'assenza più lunga di MAX_LOOKBACK_GG: quel caso NON viene
// ignorato, viene registrato come evento `buco` nel giornale, con il wallet e la finestra scoperta.
// Un buco dichiarato è un buco che si può recuperare a mano; un buco silenzioso no.
//
// ── I FILE ──────────────────────────────────────────────────────────────────────────────────────
//   data/maker-21-roster.json     INPUT, immutabile. I 21 wallet, indirizzo e ancore del v2.
//   data/maker-21-storico.json    INPUT, immutabile. I conditionId già toccati nei 90 giorni del v2:
//                                 è la base contro cui «primo fill su un mercato mai toccato» ha senso.
//   data/maker-21-eventi.jsonl    OUTPUT, append-only. Un evento per riga.
//   data/maker-21-stato.json      OUTPUT. Cursori, mercati nuovi visti dal vivo, convergenze aperte.
//   data/maker-21-statistiche.json OUTPUT. Il consuntivo che si riscrive ogni giorno — il v3 che si
//                                 scrive da solo.
//   data/maker-21-gamma-cache.json OUTPUT. Metadati dei mercati (montepremi, scadenza, banda), per
//                                 non richiedere due volte lo stesso conditionId.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const { fileRuntime } = require('../lib/percorsi-runtime');

// WATCH21_DATA_DIR esiste per UNA ragione: la prova di comportamento (scripts/watch-makers-selfcheck.js)
// deve poter far girare le funzioni vere su una directory usa-e-getta. In produzione non è impostata e
// l'agente scrive dove scrivono tutti gli altri.
const DATA_DIR = process.env.WATCH21_DATA_DIR || path.join(__dirname, '..', 'data');
const F_ROSTER  = path.join(DATA_DIR, 'maker-21-roster.json');
const F_STORICO = path.join(DATA_DIR, 'maker-21-storico.json');
const F_EVENTI  = path.join(DATA_DIR, 'maker-21-eventi.jsonl');
const F_STATO   = path.join(DATA_DIR, 'maker-21-stato.json');
const F_STATS   = path.join(DATA_DIR, 'maker-21-statistiche.json');
const F_GAMMA   = path.join(DATA_DIR, 'maker-21-gamma-cache.json');
const HB_FILE   = fileRuntime('agent-heartbeats.json');
const HB_KEY    = 'agent42-watch-makers';

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const UA = 'rewards-bot-maker-watch/1.0';

const POLL_MS        = Number(process.env.WATCH21_POLL_MS || 30_000);   // un giro completo dei 21
const PAUSA_MS       = Number(process.env.WATCH21_PAUSA_MS || 250);     // cortesia fra due GET
const TIMEOUT_MS     = 20_000;
const PAGINA         = 100;      // trade per pagina sul cursore normale
const PAGINA_GAP     = 500;      // trade per pagina quando si recupera un buco
const MAX_PAGINE     = 40;       // tetto duro per wallet per giro (20.000 trade)
const MAX_LOOKBACK_GG = 7;       // oltre questo un'assenza diventa un evento `buco`, non un recupero
const FINESTRA_CONV_MS = 2 * 3600_000;  // «entro una finestra breve»: due ore
const RITIRO_OGNI_MS = 15 * 60_000;     // ogni quanto si cercano i mercati risolti
const STATS_OGNI_MS  = 60 * 60_000;     // il consuntivo si riscrive ogni ora (e a ogni cambio di giorno)
const PRUNE_GG       = 120;      // per quanto si ricordano i mercati nuovi visti dal vivo

const log = (...a) => console.log(`[${new Date().toISOString()}] [21]`, ...a);

// ── i/o ─────────────────────────────────────────────────────────────────────────────────────────
function leggiJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }
function scriviJson(p, v) {
  const tmp = `${p}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, p); }
  catch (e) { log('scrittura fallita', path.basename(p), e.message); }
}
function heartbeat() {
  const hb = leggiJson(HB_FILE, {}) || {};
  hb[HB_KEY] = Date.now();
  try { fs.writeFileSync(`${HB_FILE}.tmp`, JSON.stringify(hb)); fs.renameSync(`${HB_FILE}.tmp`, HB_FILE); }
  catch { /* best-effort, come gli altri agenti */ }
}

/** Un evento per riga. Append-only: il giornale non si riscrive mai, si legge e basta. */
let emessiDaUltimaStat = 0;
function emetti(ev) {
  const riga = JSON.stringify({ tsMs: Date.now(), ...ev });
  try { fs.appendFileSync(F_EVENTI, riga + '\n'); } catch (e) { log('append evento fallito', e.message); }
  emessiDaUltimaStat++;
  return ev;
}

// ── rete: educata, con backoff, e che non solleva mai ────────────────────────────────────────────
async function get(url, tentativi = 3) {
  for (let i = 0; i < tentativi; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ac.signal });
      clearTimeout(t);
      if (r.status === 429) { await sonno(2000 * (i + 1)); continue; }   // il venue ci dice di rallentare: obbediamo
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      clearTimeout(t);
      if (i === tentativi - 1) { retiFallite++; return null; }
      await sonno(800 * (i + 1));
    }
  }
  return null;
}
const sonno = (ms) => new Promise(r => setTimeout(r, ms));
let retiFallite = 0;

// ── stato in memoria ────────────────────────────────────────────────────────────────────────────
const roster = leggiJson(F_ROSTER, null);
if (!roster || !Array.isArray(roster.wallet) || !roster.wallet.length) {
  log('FATALE: data/maker-21-roster.json assente o vuoto — niente da sorvegliare.');
  process.exit(1);
}
const WALLET = roster.wallet.map(w => ({ nome: w.nome, addr: String(w.indirizzo).toLowerCase(), v2: w.v2 || {} }));
const NOME = new Map(WALLET.map(w => [w.addr, w.nome]));

// La base storica: per ogni wallet i conditionId già toccati nella finestra del v2. In memoria come
// Set — 25k stringhe, ~3 MB, letto una volta e mai riscritto (il file resta la fotografia del v2).
const storicoRaw = leggiJson(F_STORICO, { perWallet: {} });
const VISTI = new Map();
for (const w of WALLET) VISTI.set(w.addr, new Set(storicoRaw.perWallet?.[w.addr] || []));

// Lo stato vivo. `nuoviCid` estende VISTI con quello che l'agente ha visto DOPO la fotografia, così
// un riavvio non rispara un ingresso già emesso.
const stato = leggiJson(F_STATO, null) || {
  avviatoMs: Date.now(), giri: 0,
  perWallet: {},          // addr -> { ultimoTs, ultimoGiroMs, nuoviCid: {cid: tsSec}, ultimoFill: {cid: tsSec} }
  convergenze: {},        // cid -> { partecipanti: [{addr,nome,ts}], emessoPerN, titolo, ... }
  ritiriEmessi: {},       // `${addr}:${cid}` -> tsMs
  ultimoRitiroMs: 0, ultimoStatsMs: 0, ultimoGiorno: null,
};
for (const w of WALLET) {
  stato.perWallet[w.addr] = stato.perWallet[w.addr] || { ultimoTs: 0, ultimoGiroMs: 0, nuoviCid: {}, ultimoFill: {} };
  for (const cid of Object.keys(stato.perWallet[w.addr].nuoviCid || {})) VISTI.get(w.addr).add(cid);
}

const gammaCache = leggiJson(F_GAMMA, {}) || {};
const affollamentoCache = new Map();   // cid -> n wallet distinti nei primi 500 trade (limite SUPERIORE)

// ── metadati del mercato ────────────────────────────────────────────────────────────────────────
// Gamma filtra i chiusi per default e questo archetipo lavora quasi solo su mercati che si risolvono
// in ore: la seconda chiamata con &closed=true non è ridondanza, è l'unico modo di vedere la metà
// del campione che nel frattempo si è già risolta. Stessa correzione della pipeline della ricerca.
// La cache si INVALIDA da sola quando il record cambia forma. Il campo `nelProgrammaPremi` è stato
// aggiunto il 7 agosto 2026 e i record scritti prima non ce l'hanno: senza questo controllo
// sopravviverebbero per giorni e ogni evento costruito su di loro avrebbe un buco al posto di un
// dato — un buco che poi si legge come «dentro il programma», cioè come il valore sbagliato.
// Qualunque campo aggiunto in futuro va elencato qui: costa una riga e una rilettura.
const CAMPI_RICHIESTI = ['nelProgrammaPremi'];
const cacheCompleta = (m) => m && CAMPI_RICHIESTI.every(k => k in m);

async function metadati(cid, forza = false) {
  if (!forza && cacheCompleta(gammaCache[cid])) return gammaCache[cid];
  for (const extra of ['', '&closed=true']) {
    const b = await get(`${GAMMA_API}/markets?limit=5&condition_ids=${cid}${extra}`);
    await sonno(PAUSA_MS);
    if (Array.isArray(b) && b.length) {
      const m = b.find(x => x.conditionId === cid) || b[0];
      // `clobRewards: null` NON è «montepremi zero»: è «questo mercato non è nel programma premi».
      // La ricerca del v2 le collassava entrambe a 0 (min della distribuzione = 0) e per una statistica
      // andava bene; per un operatore che guarda una riga e decide se guardarci dentro, no — «$0/g» e
      // «fuori dal programma» portano a due decisioni diverse. Il numero resta 0 per restare
      // confrontabile con il manuale, la distinzione viaggia accanto.
      const lista = Array.isArray(m.clobRewards) ? m.clobRewards : [];
      let premio = 0;
      for (const r of lista) {
        const v = Number(r.rewardsDailyRate); if (Number.isFinite(v)) premio = Math.max(premio, v);
      }
      const nelProgramma = lista.length > 0;
      const ts = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? Math.round(t / 1000) : null; };
      gammaCache[cid] = {
        titolo: m.question || m.title || null,
        slug: m.slug || null,
        eventSlug: m.events?.[0]?.slug || null,
        montepremiGiorno: premio,
        nelProgrammaPremi: nelProgramma,
        banda: Number(m.rewardsMaxSpread) || null,
        creatoTs: ts(m.createdAt) ?? ts(m.startDate),
        scadenzaTs: ts(m.endDate),
        chiuso: !!m.closed,
        chiusoTs: ts(m.closedTime),
        volume: Number(m.volumeNum ?? m.volume) || null,
        lettoMs: Date.now(),
      };
      return gammaCache[cid];
    }
  }
  gammaCache[cid] = { titolo: null, montepremiGiorno: null, nelProgrammaPremi: null, banda: null,
                      creatoTs: null, scadenzaTs: null, chiuso: null, lettoMs: Date.now(), incompleto: true };
  return gammaCache[cid];
}

/**
 * Affollamento: quanti wallet DISTINTI compaiono nei primi 500 trade del mercato. È lo stesso
 * indicatore del v2 e ha lo stesso limite, che va detto ogni volta: conta anche i taker, quindi è un
 * LIMITE SUPERIORE alla concorrenza fra maker, non una misura della concorrenza fra maker.
 */
async function affollamento(cid) {
  if (affollamentoCache.has(cid)) return affollamentoCache.get(cid);
  const b = await get(`${DATA_API}/trades?market=${cid}&limit=500`);
  await sonno(PAUSA_MS);
  const n = Array.isArray(b) ? new Set(b.map(t => t.proxyWallet)).size : null;
  affollamentoCache.set(cid, n);
  return n;
}

// ── il giro ─────────────────────────────────────────────────────────────────────────────────────
/** I trade di un wallet più recenti di `da`, dal più vecchio al più nuovo. */
async function trades(addr, da, pagina) {
  const out = [];
  for (let p = 0; p < MAX_PAGINE; p++) {
    const b = await get(`${DATA_API}/trades?user=${addr}&limit=${pagina}&offset=${p * pagina}`);
    if (!Array.isArray(b) || !b.length) break;
    out.push(...b);
    const piuVecchio = Math.min(...b.map(t => Number(t.timestamp) || 0));
    if (b.length < pagina || piuVecchio <= da) break;
    await sonno(PAUSA_MS);
  }
  return out.filter(t => (Number(t.timestamp) || 0) > da).sort((a, b) => a.timestamp - b.timestamp);
}

async function giroWallet(w, primoAvvio) {
  const st = stato.perWallet[w.addr];
  const oraS = Math.floor(Date.now() / 1000);

  // Primo avvio: si prende il cursore SENZA emettere. Sparare cento eventi «ingresso» all'avvio per
  // fill di ieri renderebbe il giornale illeggibile proprio nel momento in cui serve leggerlo.
  if (primoAvvio && !st.ultimoTs) {
    const b = await get(`${DATA_API}/trades?user=${w.addr}&limit=1`);
    st.ultimoTs = Array.isArray(b) && b.length ? Number(b[0].timestamp) || oraS : oraS;
    st.ultimoGiroMs = Date.now();
    log(`${w.nome}: cursore inizializzato a ${new Date(st.ultimoTs * 1000).toISOString()} (nessun evento emesso)`);
    return { nuovi: 0, ingressi: [] };
  }

  // Quanto indietro dobbiamo guardare? Se l'assenza supera il tetto, il buco si DICHIARA.
  const arretratoS = oraS - st.ultimoTs;
  let da = st.ultimoTs;
  if (arretratoS > MAX_LOOKBACK_GG * 86400) {
    const scoperto = { da: st.ultimoTs, a: oraS - MAX_LOOKBACK_GG * 86400 };
    emetti({ tipo: 'buco', wallet: w.addr, nome: w.nome, scoperto,
             oreScoperte: Math.round((scoperto.a - scoperto.da) / 360) / 10,
             nota: 'assenza oltre MAX_LOOKBACK_GG: la finestra qui sopra NON è stata riletta. Recuperabile a mano con /trades?user=…' });
    da = oraS - MAX_LOOKBACK_GG * 86400;
    log(`${w.nome}: BUCO dichiarato, ${((scoperto.a - scoperto.da) / 3600).toFixed(1)} h non rilette`);
  }
  const recupero = arretratoS > (POLL_MS / 1000) * 3;   // più di tre cicli di ritardo: è un recupero, non un giro normale

  const tr = await trades(w.addr, da, recupero ? PAGINA_GAP : PAGINA);
  if (!tr.length) { st.ultimoGiroMs = Date.now(); return { nuovi: 0, ingressi: [] }; }
  if (recupero) log(`${w.nome}: recuperati ${tr.length} trade su ${(arretratoS / 60).toFixed(0)} min di arretrato`);

  const visti = VISTI.get(w.addr);
  const ingressi = [];

  for (const t of tr) {
    const cid = t.conditionId; if (!cid) continue;
    const ts = Number(t.timestamp) || 0;
    st.ultimoFill[cid] = Math.max(st.ultimoFill[cid] || 0, ts);   // per il ritiro, più tardi
    if (visti.has(cid)) continue;

    // ── PRIMO FILL SU UN MERCATO MAI TOCCATO ────────────────────────────────────────────────────
    visti.add(cid);
    st.nuoviCid[cid] = ts;
    const m = await metadati(cid);
    const aff = await affollamento(cid);
    const ev = emetti({
      tipo: 'ingresso', ts, wallet: w.addr, nome: w.nome,
      conditionId: cid,
      titolo: m.titolo || t.title || null,
      slug: t.slug || m.slug || null,
      eventSlug: t.eventSlug || m.eventSlug || null,
      montepremiGiorno: m.montepremiGiorno,
      nelProgrammaPremi: m.nelProgrammaPremi ?? null,
      banda: m.banda,
      scadenzaTs: m.scadenzaTs,
      oreAScadenza: m.scadenzaTs != null ? Math.round((m.scadenzaTs - ts) / 360) / 10 : null,
      // ── LA SCADENZA DI GAMMA NON È SEMPRE VERA, E QUI SI VEDE ────────────────────────────────
      // Sui mercati ricorrenti (sport a giornate, meteo quotidiano) Gamma pubblica una `endDate`
      // NOMINALE che può essere ANTERIORE ai fill: è il limite n.2 del manuale v2, quello per cui sei
      // wallet su 21 — Lilybaeum, M1XU, NovaB, Unknown — furono esclusi dalla ricostruzione del
      // capitale. Un ingresso «a 0,3 ore DOPO la scadenza» non è un maker che entra tardi: è una data
      // sbagliata. Si registra lo stesso, con la bandierina, e le statistiche lo escludono dalle
      // mediane invece di mediarci sopra un numero negativo.
      scadenzaAttendibile: m.scadenzaTs != null ? m.scadenzaTs > ts : null,
      etaMercatoOre: m.creatoTs != null ? Math.round((ts - m.creatoTs) / 360) / 10 : null,
      affollamento: aff,
      affollamentoNota: 'wallet distinti nei primi 500 trade — include i taker, è un limite superiore',
      primoFill: { side: t.side || null, price: Number(t.price) || null, size: Number(t.size) || null,
                   nozionale: Math.round((Number(t.price) || 0) * (Number(t.size) || 0) * 100) / 100 },
    });
    ingressi.push(ev);
    convergenza(ev);
  }

  st.ultimoTs = Math.max(st.ultimoTs, ...tr.map(t => Number(t.timestamp) || 0));
  st.ultimoGiroMs = Date.now();
  return { nuovi: tr.length, ingressi };
}

// ── CONVERGENZA ─────────────────────────────────────────────────────────────────────────────────
// ≥2 dei 21 che entrano sullo stesso mercato entro FINESTRA_CONV_MS. Si conta sugli INGRESSI (primo
// fill su un mercato nuovo per quel wallet), non sui fill: due wallet che macinano da giorni lo
// stesso mercato non sono una convergenza, sono un fatto già noto. Si riemette a ogni partecipante
// in più — il terzo che arriva è un segnale diverso dal secondo — ma mai due volte per lo stesso n.
function convergenza(ev) {
  const c = stato.convergenze[ev.conditionId] || { partecipanti: [], emessoPerN: 0 };
  c.partecipanti.push({ addr: ev.wallet, nome: ev.nome, ts: ev.ts });
  c.titolo = ev.titolo; c.slug = ev.slug;
  c.montepremiGiorno = ev.montepremiGiorno; c.scadenzaTs = ev.scadenzaTs;
  stato.convergenze[ev.conditionId] = c;

  const dentro = c.partecipanti.filter(p => (ev.ts - p.ts) * 1000 <= FINESTRA_CONV_MS);
  const n = new Set(dentro.map(p => p.addr)).size;
  if (n >= 2 && n > c.emessoPerN) {
    c.emessoPerN = n;
    emetti({
      tipo: 'convergenza', ts: ev.ts, conditionId: ev.conditionId,
      titolo: c.titolo, slug: c.slug,
      n, finestraOre: FINESTRA_CONV_MS / 3600_000,
      wallet: dentro.map(p => ({ nome: p.nome, addr: p.addr, ts: p.ts })),
      spanMin: Math.round((ev.ts - Math.min(...dentro.map(p => p.ts))) / 6) / 10,
      montepremiGiorno: c.montepremiGiorno, scadenzaTs: c.scadenzaTs,
      oreAScadenza: c.scadenzaTs != null ? Math.round((c.scadenzaTs - ev.ts) / 360) / 10 : null,
    });
    log(`CONVERGENZA n=${n} · ${c.titolo || ev.conditionId.slice(0, 12)} · ${dentro.map(p => p.nome).join(', ')}`);
  }
}

// ── RITIRO ──────────────────────────────────────────────────────────────────────────────────────
// Il parametro nuovo del v2: quanto prima della risoluzione smettono di farsi riempire (mediana
// 10,65 h). Qui si misura dal vivo, con la STESSA definizione della ricerca — la distanza fra
// l'ultimo fill del wallet su quel mercato e la `endDate` di Gamma — così i numeri si sommano a
// quelli del manuale invece di essere una seconda serie incompatibile.
async function cercaRitiri() {
  const oraS = Math.floor(Date.now() / 1000);
  let emessi = 0;
  for (const w of WALLET) {
    const st = stato.perWallet[w.addr];
    for (const [cid, ultimo] of Object.entries(st.ultimoFill || {})) {
      const chiave = `${w.addr}:${cid}`;
      if (stato.ritiriEmessi[chiave]) continue;
      let m = gammaCache[cid];
      if (!cacheCompleta(m) || (m.scadenzaTs == null && Date.now() - (m.lettoMs || 0) > 6 * 3600_000)) m = await metadati(cid, true);
      if (!m?.scadenzaTs) continue;
      if (m.scadenzaTs > oraS) continue;                       // non ancora scaduto: si aspetta
      if (!m.chiuso && Date.now() - (m.lettoMs || 0) > 3600_000) m = await metadati(cid, true);
      const rif = m.chiusoTs || m.scadenzaTs;
      emetti({
        tipo: 'ritiro', ts: oraS, wallet: w.addr, nome: w.nome, conditionId: cid,
        titolo: m.titolo, slug: m.slug,
        ultimoFillTs: ultimo, risoluzioneTs: rif,
        orePrimaDellaRisoluzione: Math.round((rif - ultimo) / 360) / 10,
        // Stessa bandierina dell'ingresso, stesso motivo: un ritiro NEGATIVO significa che il wallet
        // si è fatto riempire dopo la data che Gamma dichiara come risoluzione, cioè che la data è
        // sbagliata — non che esista un ritiro a ore negative. Esce dalla mediana, resta nel giornale.
        scadenzaAttendibile: rif > ultimo,
        montepremiGiorno: m.montepremiGiorno,
        v2MedianaWalletOre: w.v2.oreUltimoFillPrimaRisoluzione ?? null,
      });
      stato.ritiriEmessi[chiave] = Date.now();
      delete st.ultimoFill[cid];
      emessi++;
      if (emessi >= 200) return emessi;                        // un ciclo non deve mai diventare lungo
    }
  }
  return emessi;
}

// ── STATISTICA CONTINUA ─────────────────────────────────────────────────────────────────────────
// Il consuntivo si ricalcola SEMPRE dal giornale, mai da un accumulatore incrementale: un file di
// contatori che si corrompe non si accorge di essersi corrotto, un file rigenerato dagli eventi sì.
function mediana(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function quantile(a, q) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * q; const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); }
function r2(v) { return v == null ? null : Math.round(v * 100) / 100; }

const FASCE = [[0, 10], [10, 25], [25, 50], [50, 100], [100, 300], [300, 1000], [1000, Infinity]];
/**
 * La fascia di montepremi di un ingresso. «Fuori dal programma premi» è una categoria a sé e non la
 * fascia più bassa: un mercato senza programma non è un mercato che paga poco, è un mercato dove la
 * nostra domanda («quanto rende stare in banda») non si pone. Mescolarli renderebbe «$0–10/g» il
 * bucket più affollato per un motivo che non ha niente a che fare con i premi.
 */
function fascia(p, nelProgramma) {
  if (nelProgramma === false) return 'fuori dal programma premi';
  if (p == null) return 'ignoto';
  const f = FASCE.find(([a, b]) => p >= a && p < b);
  return f ? (f[1] === Infinity ? `≥$${f[0]}/g` : `$${f[0]}–${f[1]}/g`) : 'ignoto';
}

function statistiche() {
  const eventi = [];
  try {
    for (const riga of fs.readFileSync(F_EVENTI, 'utf8').split('\n')) {
      if (!riga) continue;
      try { eventi.push(JSON.parse(riga)); } catch { /* riga tronca: si salta, il giornale è append-only */ }
    }
  } catch { /* nessun evento ancora */ }

  const ingressi = eventi.filter(e => e.tipo === 'ingresso');
  const conv     = eventi.filter(e => e.tipo === 'convergenza');
  const ritiri   = eventi.filter(e => e.tipo === 'ritiro');
  const giorno   = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
  const giorni   = new Set(ingressi.map(e => giorno(e.ts)));

  // ── L'ESCLUSIONE È DICHIARATA, MAI SILENZIOSA ─────────────────────────────────────────────────
  // Tutto ciò che dipende dalla `endDate` di Gamma si calcola SOLO sugli eventi con scadenza
  // attendibile; il conteggio degli scartati viene pubblicato accanto a ogni mediana che ne dipende,
  // così «mediana su 12 eventi, 5 scartati» non si legge mai come «mediana su 17». È la stessa
  // disciplina del manuale v2, che elencava i sei wallet esclusi con il loro motivo invece di
  // lasciarli dentro a peggiorare i numeri di tutti.
  const att = (e) => e.scadenzaAttendibile !== false;
  const scartati = {
    ingressi: ingressi.filter(e => !att(e)).length,
    ritiri:   ritiri.filter(e => !att(e)).length,
    motivo:   'endDate di Gamma anteriore ai fill (mercati ricorrenti) — limite n.2 del manuale v2',
  };

  const perWallet = WALLET.map(w => {
    const mie = ingressi.filter(e => e.wallet === w.addr);
    const mieR = ritiri.filter(e => e.wallet === w.addr);
    const perGiorno = {};
    for (const e of mie) perGiorno[giorno(e.ts)] = (perGiorno[giorno(e.ts)] || 0) + 1;
    const eta = mie.map(e => e.etaMercatoOre).filter(v => v != null);
    const scad = mie.filter(att).map(e => e.oreAScadenza).filter(v => v != null);
    // La mediana del montepremi si calcola sui SOLI mercati dentro il programma premi: includere i
    // mercati che un programma non ce l'hanno la trascinerebbe a zero e la risposta sarebbe «questo
    // wallet frequenta premi da $0», che è falsa. Quanti stiano fuori è una misura a parte, sotto.
    const dentroProg = mie.filter(e => e.nelProgrammaPremi !== false);
    const prem = dentroProg.map(e => e.montepremiGiorno).filter(v => v != null);
    const rit = mieR.filter(att).map(e => e.orePrimaDellaRisoluzione).filter(v => v != null);
    const fasce = {};
    for (const e of mie) {
      const f = fascia(e.montepremiGiorno, e.nelProgrammaPremi);
      fasce[f] = (fasce[f] || 0) + 1;
    }
    const gg = Object.keys(perGiorno).length || 1;
    return {
      nome: w.nome, indirizzo: w.addr,
      ingressiTotali: mie.length,
      ingressiAlGiorno: r2(mie.length / gg),
      v2NuoviAlGiorno: w.v2.nuoviMercatiGiorno ?? null,
      perGiorno,
      etaMercatoOreMediana: r2(mediana(eta)),
      etaMercatoOreQ1Q3: [r2(quantile(eta, .25)), r2(quantile(eta, .75))],
      oreAScadenzaMediana: r2(mediana(scad)),
      v2ScadenzaOreMediana: w.v2.scadenzaMedianaGg != null ? r2(w.v2.scadenzaMedianaGg * 24) : null,
      montepremiMediano: r2(mediana(prem)),
      montepremiSuNEventi: prem.length,
      fuoriDalProgrammaPremi: mie.length - dentroProg.length,
      v2PremioMediano: w.v2.premioMediano ?? null,
      fasceMontepremi: fasce,
      ritiriOsservati: mieR.length,
      ritiroOreMediana: r2(mediana(rit)),
      ritiroSuNEventi: rit.length,
      scartatiScadenzaNonAttendibile: mie.filter(e => !att(e)).length + mieR.filter(e => !att(e)).length,
      v2RitiroOreMediana: w.v2.oreUltimoFillPrimaRisoluzione ?? null,
      ultimoIngressoTs: mie.length ? Math.max(...mie.map(e => e.ts)) : null,
    };
  }).sort((a, b) => b.ingressiTotali - a.ingressiTotali);

  const dentroProgTot = ingressi.filter(e => e.nelProgrammaPremi !== false);
  const tuttiPrem = dentroProgTot.map(e => e.montepremiGiorno).filter(v => v != null);
  const tuttiEta  = ingressi.map(e => e.etaMercatoOre).filter(v => v != null);
  const tuttiRit  = ritiri.filter(att).map(e => e.orePrimaDellaRisoluzione).filter(v => v != null);
  const tuttiScad = ingressi.filter(att).map(e => e.oreAScadenza).filter(v => v != null);
  const fasceTot = {};
  for (const e of ingressi) {
    const f = fascia(e.montepremiGiorno, e.nelProgrammaPremi);
    fasceTot[f] = (fasceTot[f] || 0) + 1;
  }

  const out = {
    aggiornatoMs: Date.now(),
    finestra: {
      dalMs: stato.avviatoMs,
      giorniOsservati: giorni.size,
      nota: 'Il monitor osserva dal vivo dal suo primo avvio. La base storica dei mercati già toccati viene dalla finestra 90 giorni del manuale v2, chiusa il 7 agosto 2026.',
    },
    totali: {
      ingressi: ingressi.length,
      convergenze: conv.length,
      ritiri: ritiri.length,
      buchi: eventi.filter(e => e.tipo === 'buco').length,
      mercatiDistinti: new Set(ingressi.map(e => e.conditionId)).size,
      scartatiScadenzaNonAttendibile: scartati,
    },
    consenso: {
      etaMercatoOreMediana: r2(mediana(tuttiEta)),
      oreAScadenzaMediana: r2(mediana(tuttiScad)),
      oreAScadenzaSuNEventi: tuttiScad.length,
      montepremiMediano: r2(mediana(tuttiPrem)),
      montepremiSuNEventi: tuttiPrem.length,
      fuoriDalProgrammaPremi: ingressi.length - dentroProgTot.length,
      montepremiQ1Q3: [r2(quantile(tuttiPrem, .25)), r2(quantile(tuttiPrem, .75))],
      ritiroOreMediana: r2(mediana(tuttiRit)),
      ritiroSuNEventi: tuttiRit.length,
      v2RitiroOreMediana: 10.65,
      v2ScadenzaOreMediana: r2(0.44 * 24),
      v2MontepremiMediano: 47,
      fasceMontepremi: fasceTot,
    },
    perWallet,
  };
  scriviJson(F_STATS, out);
  return out;
}

// ── il ciclo ────────────────────────────────────────────────────────────────────────────────────
let primoAvvio = true;
let latenze = [];

async function ciclo() {
  const t0 = Date.now();
  let nuovi = 0, ingressi = 0;
  for (const w of WALLET) {
    try {
      const r = await giroWallet(w, primoAvvio);
      nuovi += r.nuovi; ingressi += r.ingressi.length;
    } catch (e) { log(`${w.nome}: giro fallito —`, e.message); }
    await sonno(PAUSA_MS);
  }
  const durata = Date.now() - t0;
  latenze.push(durata); if (latenze.length > 60) latenze.shift();

  stato.giri++;
  stato.ultimoGiroMs = Date.now();
  stato.ultimoGiroDurataMs = durata;
  stato.latenzaGiroMedianaMs = Math.round(mediana(latenze) || durata);
  // La latenza di RILEVAMENTo attesa: mezzo periodo di attesa più un giro intero nel caso peggiore.
  stato.latenzaAttesaMedianaS = Math.round((POLL_MS / 2 + durata / 2) / 100) / 10;
  stato.retiFallite = retiFallite;
  stato.wallet = WALLET.length;

  if (Date.now() - (stato.ultimoRitiroMs || 0) > RITIRO_OGNI_MS) {
    try { const n = await cercaRitiri(); stato.ultimoRitiroMs = Date.now(); if (n) log(`ritiri registrati: ${n}`); }
    catch (e) { log('ricerca ritiri fallita —', e.message); }
  }

  // ── QUANDO SI RIFÀ IL CONSUNTIVO ──────────────────────────────────────────────────────────────
  // Non solo «ogni ora»: con il solo intervallo orario, un ingresso catturato alle 12:01 resterebbe
  // invisibile nella sezione della dashboard fino alle 13:00, e chi guarda leggerebbe zero mentre il
  // giornale ha già la riga. Quindi: SUBITO (entro un minuto) se sono stati emessi eventi nuovi,
  // comunque ogni ora anche a giornale fermo, e sempre al cambio di giorno — che è il momento in cui
  // gli «ingressi al giorno» cambiano denominatore.
  const oggi = new Date().toISOString().slice(0, 10);
  const eta = Date.now() - (stato.ultimoStatsMs || 0);
  if ((emessiDaUltimaStat > 0 && eta > 60_000) || eta > STATS_OGNI_MS || stato.ultimoGiorno !== oggi) {
    try { statistiche(); stato.ultimoStatsMs = Date.now(); stato.ultimoGiorno = oggi; emessiDaUltimaStat = 0; }
    catch (e) { log('statistiche fallite —', e.message); }
  }

  potatura();
  scriviJson(F_STATO, stato);
  scriviJson(F_GAMMA, gammaCache);
  heartbeat();

  if (primoAvvio) { log(`primo giro completato in ${durata} ms — cursori pronti, sorveglianza attiva`); primoAvvio = false; }
  else if (nuovi || ingressi) log(`giro ${stato.giri}: ${nuovi} fill, ${ingressi} ingressi · ${durata} ms`);
}

/** I mercati nuovi visti dal vivo si ricordano PRUNE_GG giorni: oltre, il mercato è risolto da un
 *  pezzo e riproporlo come «ingresso» non sarebbe un falso positivo — sarebbe un dato inutile. */
function potatura() {
  const limite = Math.floor(Date.now() / 1000) - PRUNE_GG * 86400;
  for (const w of WALLET) {
    const st = stato.perWallet[w.addr];
    for (const [cid, ts] of Object.entries(st.nuoviCid)) if (ts < limite) delete st.nuoviCid[cid];
  }
  for (const [cid, c] of Object.entries(stato.convergenze)) {
    if (Math.max(...c.partecipanti.map(p => p.ts)) < limite) delete stato.convergenze[cid];
  }
  const limiteMs = Date.now() - PRUNE_GG * 86400_000;
  for (const [k, ts] of Object.entries(stato.ritiriEmessi)) if (ts < limiteMs) delete stato.ritiriEmessi[k];
  for (const [cid, m] of Object.entries(gammaCache)) {
    if (m.chiuso && (m.lettoMs || 0) < Date.now() - 14 * 86400_000) delete gammaCache[cid];
  }
}

async function main() {
  log(`avvio — ${WALLET.length} wallet, base storica ${storicoRaw.meta?.mercatiDistinti ?? '?'} mercati`);
  log(`fonte: data-api /trades?user= · ciclo ${POLL_MS / 1000}s · pausa ${PAUSA_MS}ms · nessuna capacità di firma o di ordine`);
  heartbeat();
  for (;;) {
    try { await ciclo(); } catch (e) { log('ciclo fallito —', e.message); heartbeat(); }
    await sonno(POLL_MS);
  }
}

if (require.main === module) main();

module.exports = {
  statistiche, fascia, mediana, quantile, convergenza,
  giroWallet, cercaRitiri, metadati, ciclo,
  _interni: { stato, VISTI, WALLET, gammaCache, F_EVENTI, F_STATO, F_STATS, POLL_MS },
};

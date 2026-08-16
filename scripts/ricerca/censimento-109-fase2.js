#!/usr/bin/env node
'use strict';
// scripts/ricerca/censimento-109-fase2.js — IL PROFILO DEI WALLET DEL CENSIMENTO. Sola lettura.
//
//   node scripts/ricerca/censimento-109-fase2.js [--min-mercati 5] [--giorni 14]
//                                               [--giorni-trade 7] [--orizzonte-h 24]
//                                               [--larghezza 5] [--limite N] [--rifai]
//
// Fase 2 di due. La fase 1 ha misurato la POPOLAZIONE (16.032 wallet sui 108 mercati premianti del
// board); qui si profila il sottoinsieme che vale la pena guardare — chi è comparso in almeno
// `--min-mercati` mercati distinti, che sui dati di oggi sono **973** wallet a soglia 5.
//
// SOLA LETTURA. Nessun ordine, nessuna firma, nessuna transazione. Le fonti sono quattro GET
// pubbliche (`data-api`, `lb-api`, `clob`) e una `eth_call` di `balanceOf`. Non importa niente da
// `lib/maker/` né da `lib/venues/`: le funzioni che sanno firmare o piazzare non sono raggiungibili
// da qui. L'unico import da `lib/` è `banda-premiante`, che è puro e non tocca rete (vedi sotto).
//
// ═══ COSA NON SI RICOPIA, E PERCHÉ ═══════════════════════════════════════════════════════════════
// Tre pezzi di questo censimento esistono già altrove e vengono IMPORTATI, non riscritti:
//   · `classifica` / `unisciParziali` / `scarica` dallo stadio 5 — sono la definizione delle classi
//     A/B/C/D/E, della fusione dei fill parziali e dell'etichetta taker per differenza fra le due
//     liste `/trades`. Una seconda copia divergerebbe in silenzio, e la prima a divergere sarebbe la
//     fusione, che è già stata sbagliata una volta (2.049 eventi finiti in D per un raggruppamento
//     fatto sullo stream invece che per ordine).
//   · `famiglia` e `VALORE_MIN_MERCATO` da `screening-lib` — ci sono stati spostati oggi proprio
//     perché da qui in poi li usano in due.
//   · `raggioBandaPrezzo` da `lib/banda-premiante` — **il raggio della banda NON si ricalcola qui**.
//     `v = max_spread`, non `max_spread/2`: è §5-bis p.155, il difetto che ha tenuto la banda larga
//     la metà in 60 punti del repo perché ognuno se la calcolava da sé. Scrivere `maxSpread / 2` in
//     questo file sarebbe la 61ª volta.
//
// ═══ IL COSTO, E PERCHÉ IL PER-MERCATO SI PAGA UNA VOLTA SOLA ════════════════════════════════════
// I 973 wallet vivono sugli STESSI 108 mercati. Il libro e la configurazione della banda sono quindi
// una proprietà del mercato, non del wallet: si leggono **una volta** (216 libri, due token per
// mercato) e finiscono nel checkpoint, così un riavvio non li ricompra. Per wallet restano ~8-30
// chiamate. A 8 rps il giro intero sta indicativamente in **40-70 minuti**; il numero vero lo scrive
// il log, e non è una promessa.
//
// ═══ IL CHECKPOINT, E LA RAGIONE PER CUI NON SI SALVANO GLI EVENTI ═══════════════════════════════
// Si salva ogni **25 wallet** (la cadenza con cui `inParallelo` chiama il progresso) e alla ripresa
// si rileggono i wallet già fatti dal file. ⚠ **Gli eventi di uscita NON vengono persistiti**, solo i
// loro conteggi: lo stadio 5 salvava ogni evento e per 65 wallet il file pesava 26,7 MB — qui i
// wallet sono 15 volte tanti, e un checkpoint da 400 MB riscritto ogni 25 wallet non è un
// checkpoint, è un modo di far cadere il giro che dovrebbe proteggere.
//
// ═══ LE TRE MISURE CHE NON SONO QUELLO CHE SEMBRANO, DICHIARATE QUI ══════════════════════════════
//   ① «MERCATI APERTI INSIEME» ha due letture e nessuna è la verità piena. `insiemeOra` è una
//      FOTOGRAFIA: i mercati con posizione viva sopra `VALORE_MIN_MERCATO` adesso — non dice niente
//      di ieri, e una coppia completa si fonde o si riscatta e sparisce da `/positions` (§5-bis
//      p.150), quindi chi appaia bene mostra MENO mercati di chi appaia male. `insiemeMax` è invece
//      il massimo di intervalli [primo fill · ultimo fill] sovrapposti nel campione trade, ed è un
//      **limite inferiore**: una posizione sopravvive al suo ultimo fill, spesso di giorni.
//      Il rapporto capitale/mercato usa la fotografia e ripiega sul massimo, e dichiara quale ha usato.
//   ② «DISTANZA MEDIANA DAL MID» si misura solo sui fill **maker** e solo nei 108 mercati del
//      censimento, contro il campione di `prices-history` **strettamente precedente** il fill e
//      scartato oltre 180 s. La semantica della serie è stata misurata in §5-bis p.163 e **non è
//      l'ultimo scambio**: è un punto medio del minuto. Quindi è la distanza da un mid *ricostruito*.
//   ③ «% GIORNI ATTIVI» ha due denominatori diversi e vanno tenuti separati: sui rewards il
//      denominatore è onesto (la paginazione copre i 14 giorni interi), sui trade no — il campione è
//      a numero fisso di pagine e copre archi diversi per wallet, quindi la percentuale è sui giorni
//      **coperti**, non sui 14.
//
// ⚠ NON MISURABILE DA QUI, e vale la pena saperlo prima di leggere il referto: il reward **per
// mercato**. Il venue paga un bonifico aggregato (§4.12), quindi «quanto rende questo mercato a
// questo wallet» non esiste in nessuna fonte pubblica. Tutto ciò che segue è per WALLET.

const fs = require('fs');
const path = require('path');
const {
  apiGet, rpc, inParallelo, scrivi, leggi, mediana, contatore,
  PUSD, DIR_DATI, famiglia, VALORE_MIN_MERCATO,
} = require('./screening-lib');
const { raggioBandaPrezzo } = require('../../lib/banda-premiante');
const { scarica, unisciParziali, classifica, chiave, prezzo } = require('./screening-05-uscite');

const argomenti = process.argv.slice(2);
const arg = (n, d) => { const i = argomenti.indexOf(n); return i >= 0 ? Number(argomenti[i + 1]) : d; };

const MIN_MERCATI = arg('--min-mercati', 5);
const GIORNI = arg('--giorni', 14);
const GIORNI_TRADE = arg('--giorni-trade', 7);
const ORIZZONTE_H = arg('--orizzonte-h', 24);
const LARGHEZZA = arg('--larghezza', 5);
const LIMITE = arg('--limite', null);
const RIFAI = argomenti.includes('--rifai');

const FILE_USCITA = 'censimento-109-fase2.json';
const FILE_LOG = path.join(DIR_DATI, 'fase2.log');
const PER_PAGINA = 500;
/** `/trades` si ferma a offset 10.000: oltre non c'è modo di risalire. */
const PAGINE_MAX_REWARD = 20;
/** Oltre questa età il campione di `prices-history` non descrive più il libro all'istante del fill. */
const ETA_MAX_CAMPIONE_S = 180;
/** Quanti fill maker per wallet si usano per la distanza: la mediana non migliora oltre. */
const FILL_PER_DISTANZA = 40;
/** Quante serie di prezzo si tengono in memoria insieme (~20k punti l'una a 14 giorni). */
const MAX_SERIE_IN_MEMORIA = 250;
/** `balanceOf(address)` — selettore fisso, nessuna ABI da caricare. */
const SELETTORE_BALANCE_OF = '0x70a08231';

const normId = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');
const fin = (x) => Number.isFinite(x);
function numero(x) {
  if (x === null || x === undefined) return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
}
const giornoUtc = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

// ── IL LOG SU FILE ───────────────────────────────────────────────────────────────────────────────
// In `nohup` lo stdout finisce in un file che nessuno guarda; questo invece è il giornale del giro,
// con l'ora davanti a ogni riga, e serve a rispondere a «è arrivato in fondo o si è interrotto?»
// senza dover aprire un JSON da decine di MB.
fs.mkdirSync(DIR_DATI, { recursive: true });
function registra(testo) {
  const riga = `${new Date().toISOString()}  ${testo}`;
  console.log(riga);
  try { fs.appendFileSync(FILE_LOG, riga + '\n'); } catch { /* il log non può fermare la misura */ }
}

// ══ IL PER-MERCATO, PAGATO UNA VOLTA SOLA ════════════════════════════════════════════════════════

/** I 108 mercati premianti del board, con i due token e la configurazione della banda. */
function mercatiDelBoard() {
  const b = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'liquidity-rewards.json'), 'utf8'));
  const fuori = new Map();
  for (const m of (b.markets || [])) {
    if (!(Number(m.rewardsDailyRate) > 0.01)) continue;
    const cid = normId(m.conditionId);
    if (!cid) continue;
    fuori.set(cid, {
      conditionId: cid,
      question: m.question || '',
      tokenSi: m.tokenId ? String(m.tokenId) : null,
      tokenNo: m.tokenIdNo ? String(m.tokenIdNo) : null,
      maxSpread: numero(m.rewardsMaxSpread),
      minSize: numero(m.rewardsMinSize),
      rate: numero(m.rewardsDailyRate),
      endDate: m.endDate || null,
      // Il numero del board, tenuto ACCANTO al nostro e mai fuso con lui: è un'altra misura, presa
      // in un altro istante e con un'altra definizione di profondità.
      depthBoard: numero(m.existing_depth_usd),
    });
  }
  return fuori;
}

/**
 * LA LIQUIDITÀ IN BANDA di un lato, in dollari.
 * Somma `size × price` dei livelli che cadono dentro il raggio premiante attorno al mid.
 * ⚠ È il libro INTERO, non «quello degli altri»: qui non stiamo decidendo un prezzo, stiamo
 * misurando quanto è spesso il posto dove questi wallet vanno a stare.
 */
function liquiditaDaLibro(libro, mid, raggio) {
  if (!libro || !fin(mid) || !fin(raggio)) return null;
  let usd = 0;
  for (const lato of ['bids', 'asks']) {
    for (const l of (libro[lato] || [])) {
      const p = numero(l.price);
      const s = numero(l.size);
      if (p === null || s === null) continue;
      if (Math.abs(p - mid) <= raggio) usd += p * s;
    }
  }
  return usd;
}

async function libroDi(tokenId) {
  const r = await apiGet(`/book?token_id=${tokenId}`, 0, 'clob.polymarket.com');
  if (!r.ok || !r.dati || typeof r.dati !== 'object') return null;
  return r.dati;
}

/** Il mid dal libro: `(miglior bid + miglior ask)/2`, mai un valore inventato se manca un lato. */
function midDaLibro(libro) {
  if (!libro) return null;
  const bid = (libro.bids || []).reduce((a, l) => Math.max(a, numero(l.price) ?? -Infinity), -Infinity);
  const ask = (libro.asks || []).reduce((a, l) => Math.min(a, numero(l.price) ?? Infinity), Infinity);
  if (!fin(bid) || !fin(ask)) return null;
  return (bid + ask) / 2;
}

/** Riempie la liquidità in banda dei mercati che non ce l'hanno già dal checkpoint. */
async function preparaMercati(mercati, gia) {
  const daFare = [...mercati.values()].filter((m) => !gia.has(m.conditionId));
  registra(`per-mercato: ${mercati.size} mercati · già in cache ${gia.size} · da leggere ${daFare.length}`);

  await inParallelo(daFare, 4, async (m) => {
    const raggio = raggioBandaPrezzo(m.maxSpread);   // ⚠ importato, MAI ricalcolato qui
    if (raggio === null || (!m.tokenSi && !m.tokenNo)) {
      gia.set(m.conditionId, { ...m, liquiditaBandaUsd: null, motivo: 'banda o token non leggibili' });
      return null;
    }
    let somma = 0;
    let lati = 0;
    for (const t of [m.tokenSi, m.tokenNo]) {
      if (!t) continue;
      const libro = await libroDi(t);
      const mid = midDaLibro(libro);
      const q = liquiditaDaLibro(libro, mid, raggio);
      if (q !== null) { somma += q; lati += 1; }
    }
    gia.set(m.conditionId, {
      ...m,
      raggioBanda: raggio,
      // Non letto ≠ zero: un libro illeggibile lascia `null`, e la mediana per wallet lo salta
      // invece di trascinarsi dentro uno zero che non è mai stato misurato (§5.3).
      liquiditaBandaUsd: lati > 0 ? somma : null,
      latiLetti: lati,
    });
    return null;
  }, (f, t) => { if (f % 20 === 0) registra(`  … per-mercato ${f}/${t}`); });

  return gia;
}

// ══ LE SERIE DI PREZZO, PER LA DISTANZA DAL MID ══════════════════════════════════════════════════

const serieCache = new Map();

async function serieDi(asset, daTs, aTs) {
  if (serieCache.has(asset)) return serieCache.get(asset);
  const r = await apiGet(
    `/prices-history?market=${asset}&startTs=${daTs}&endTs=${aTs}&fidelity=1`,
    0, 'clob.polymarket.com',
  );
  const punti = (r.ok && r.dati && Array.isArray(r.dati.history))
    ? r.dati.history.map((x) => ({ t: numero(x.t), p: numero(x.p) })).filter((x) => x.t !== null && x.p !== null)
    : null;
  // Sfratto FIFO: senza, 216 serie da ~20k punti stanno in memoria tutte insieme per l'intero giro.
  if (serieCache.size >= MAX_SERIE_IN_MEMORIA) serieCache.delete(serieCache.keys().next().value);
  serieCache.set(asset, punti);
  return punti;
}

/** L'ultimo campione STRETTAMENTE precedente `ts`, scartato se più vecchio di `ETA_MAX_CAMPIONE_S`. */
function midPrimaDi(punti, ts) {
  if (!punti || !punti.length) return null;
  let lo = 0;
  let hi = punti.length - 1;
  let trovato = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (punti[m].t < ts) { trovato = m; lo = m + 1; } else hi = m - 1;
  }
  if (trovato < 0) return null;
  if (ts - punti[trovato].t > ETA_MAX_CAMPIONE_S) return null;
  return punti[trovato].p;
}

// ══ IL PROFILO DI UN WALLET ══════════════════════════════════════════════════════════════════════

/** Tutti i pagamenti REWARD nella finestra, paginati fino a uscirne. */
async function rewardsDi(wallet, daTs) {
  const righe = [];
  for (let p = 0; p < PAGINE_MAX_REWARD; p += 1) {
    const r = await apiGet(`/activity?user=${wallet}&type=REWARD&limit=${PER_PAGINA}&offset=${p * PER_PAGINA}`);
    if (!r.ok || !Array.isArray(r.dati)) return { ok: false, errore: r.errore || 'non lista' };
    let piuVecchio = Infinity;
    for (const x of r.dati) {
      const ts = numero(x.timestamp);
      const usd = numero(x.usdcSize);
      if (ts === null || usd === null) continue;
      if (ts < piuVecchio) piuVecchio = ts;
      if (ts >= daTs) righe.push({ ts, usd });
    }
    if (r.dati.length < PER_PAGINA) break;
    if (piuVecchio <= daTs) break;
  }
  return { ok: true, righe };
}

/**
 * IL PRIMO TRADE IN ASSOLUTO.
 * ⚠ Si chiede in ordine crescente e si VERIFICA: se la risposta non è più vecchia del campione che
 * abbiamo già, vuol dire che `sortDirection` non ha filtrato niente e la riga è solo la più recente.
 * In quel caso il campo resta `null` — «non determinato» è un'informazione, «oggi» sarebbe una bugia.
 */
async function primoTrade(wallet, tsNotoPiuVecchio) {
  const r = await apiGet(`/activity?user=${wallet}&type=TRADE&limit=1&sortDirection=ASC`);
  if (!r.ok || !Array.isArray(r.dati) || !r.dati.length) return null;
  const ts = numero(r.dati[0].timestamp);
  if (ts === null) return null;
  if (tsNotoPiuVecchio !== null && ts > tsNotoPiuVecchio) return null;
  return ts;
}

async function contante(wallet) {
  const dato = SELETTORE_BALANCE_OF + '0'.repeat(24) + wallet.replace(/^0x/, '').toLowerCase();
  try {
    const r = await rpc('eth_call', [{ to: PUSD, data: dato }, 'latest']);
    if (!r || r === '0x') return null;
    return Number(BigInt(r)) / 1e6;
  } catch { return null; }   // non letto ≠ zero
}

/** Il massimo numero di intervalli [primo · ultimo] sovrapposti. Limite INFERIORE, vedi l'intestazione. */
function massimoSovrapposti(intervalli) {
  const eventi = [];
  for (const iv of intervalli) {
    if (!fin(iv.da) || !fin(iv.a)) continue;
    eventi.push({ t: iv.da, d: +1 });
    eventi.push({ t: iv.a, d: -1 });
  }
  // A parità di istante si chiude prima di aprire: due mercati che si toccano in un punto non sono
  // due mercati aperti insieme.
  eventi.sort((x, y) => x.t - y.t || x.d - y.d);
  let ora = 0;
  let max = 0;
  for (const e of eventi) { ora += e.d; if (ora > max) max = ora; }
  return max;
}

async function profilo(wallet, ctx) {
  const note = [];

  // ── I TRADE: una sola raccolta, che serve a taker, uscite, distanza e concorrenza ──────────────
  const [tutti, taker] = await Promise.all([
    scarica(wallet, false, ctx.daTsTrade),
    scarica(wallet, true, ctx.daTsTrade),
  ]);
  if (!tutti.ok) return { wallet, ok: false, errore: `trades: ${tutti.errore}` };
  if (!taker.ok) return { wallet, ok: false, errore: `trades taker: ${taker.errore}` };

  const insiemeTaker = new Set(taker.righe.map(chiave));
  // ⚠ La finestra utile è quella coperta da ENTRAMBE le liste: 500 righe taker risalgono più
  // indietro di 500 righe totali, e fuori dall'intersezione un fill maker sarebbe etichettato
  // «maker» solo perché la lista taker non arrivava fin lì.
  const inizio = Math.max(tutti.piuVecchio, taker.piuVecchio);
  const usabili = tutti.righe
    .filter((t) => numero(t.timestamp) !== null && t.timestamp >= inizio)
    .map((t) => ({ ...t, taker: insiemeTaker.has(chiave(t)) }));
  if (!usabili.length) return { wallet, ok: false, errore: 'nessun trade nella finestra comune' };

  const tMax = Math.max(...usabili.map((t) => t.timestamp));
  const eventi = unisciParziali(usabili);
  const c = classifica(eventi, tMax, ctx.orizzonteS);

  const conta = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const e of c.eventi) if (conta[e.classe] !== undefined) conta[e.classe] += 1;
  const nClassificati = c.eventi.length;
  const costiCoppia = c.eventi.filter((e) => e.classe === 'A' && fin(e.costoCoppiaCents)).map((e) => e.costoCoppiaCents);
  const deltaB = c.eventi.filter((e) => e.classe === 'B' && fin(e.deltaCents)).map((e) => e.deltaCents);

  // ── LE FAMIGLIE e i mercati toccati, dal censimento di fase 1 ──────────────────────────────────
  const perFamiglia = {};
  const mercatiCensiti = ctx.mercatiDelWallet.get(wallet) || [];
  for (const cid of mercatiCensiti) {
    const m = ctx.mercati.get(cid);
    const f = famiglia(m ? m.question : '');
    perFamiglia[f] = (perFamiglia[f] || 0) + 1;
  }
  const famigliaPrincipale = Object.entries(perFamiglia).sort((a, b) => b[1] - a[1])[0] || null;

  // ── LA LIQUIDITÀ IN BANDA: mediana sui mercati del wallet, saltando i non letti ────────────────
  const liq = mercatiCensiti
    .map((cid) => (ctx.mercati.get(cid) || {}).liquiditaBandaUsd)
    .filter((x) => fin(x));

  // ── LA DISTANZA DAL MID: solo fill MAKER, solo nei mercati del censimento ──────────────────────
  const perDistanza = eventi
    .filter((e) => !e.taker && ctx.mercati.has(normId(e.conditionId)) && fin(e.price))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, FILL_PER_DISTANZA);
  const distanze = [];
  for (const e of perDistanza) {
    const punti = await serieDi(e.asset, ctx.daTsTrade, ctx.aTs);
    const mid = midPrimaDi(punti, e.timestamp);
    if (mid === null) continue;
    distanze.push(Math.abs(prezzo(e.price) - mid) * 100);
  }
  if (perDistanza.length && !distanze.length) note.push('nessun campione di mid utilizzabile entro 180 s');

  // ── CAPITALE, POSIZIONI, MERCATI APERTI INSIEME ───────────────────────────────────────────────
  const [pos, val, prof] = await Promise.all([
    apiGet(`/positions?user=${wallet}&limit=${PER_PAGINA}&sortBy=CURRENT&sortDirection=DESC`),
    apiGet(`/value?user=${wallet}`),
    apiGet(`/profit?window=7d&address=${wallet}`, 0, 'lb-api.polymarket.com'),
  ]);

  let insiemeOra = null;
  if (pos.ok && Array.isArray(pos.dati)) {
    const perCid = new Map();
    for (const p of pos.dati) {
      const cid = normId(p.conditionId);
      const v = numero(p.currentValue);
      if (!cid || v === null) continue;
      perCid.set(cid, (perCid.get(cid) || 0) + v);
    }
    insiemeOra = [...perCid.values()].filter((v) => v >= VALORE_MIN_MERCATO).length;
    if (pos.dati.length >= PER_PAGINA) note.push('posizioni troncate a 500: i mercati aperti sono un limite inferiore');
  } else {
    note.push('posizioni non lette');
  }

  const intervalli = new Map();
  for (const t of usabili) {
    const cid = normId(t.conditionId);
    if (!cid) continue;
    const iv = intervalli.get(cid) || { da: t.timestamp, a: t.timestamp };
    iv.da = Math.min(iv.da, t.timestamp);
    iv.a = Math.max(iv.a, t.timestamp);
    intervalli.set(cid, iv);
  }
  const insiemeMax = massimoSovrapposti([...intervalli.values()]);

  const valorePosizioni = (val.ok && Array.isArray(val.dati) && val.dati[0] && fin(Number(val.dati[0].value)))
    ? Number(val.dati[0].value) : null;
  const pnl7g = (prof.ok && Array.isArray(prof.dati) && prof.dati[0] && fin(Number(prof.dati[0].amount)))
    ? Number(prof.dati[0].amount) : null;
  const cash = await contante(wallet);
  const capitale = (cash === null || valorePosizioni === null) ? null : cash + valorePosizioni;

  const denominatoreMercati = insiemeOra || insiemeMax || null;
  const fonteDenominatore = insiemeOra ? 'posizioni-ora' : (insiemeMax ? 'sovrapposti-trade' : null);

  // ── REWARDS, GIORNI ATTIVI, ANZIANITÀ ─────────────────────────────────────────────────────────
  const rw = await rewardsDi(wallet, ctx.daTsRewards);
  let rewards14g = null;
  let medianaGiornaliera = null;
  let giorniConRewards = null;
  if (rw.ok) {
    const perData = new Map();
    for (const r of rw.righe) {
      const d = giornoUtc(r.ts);
      perData.set(d, (perData.get(d) || 0) + r.usd);
    }
    rewards14g = [...perData.values()].reduce((a, b) => a + b, 0);
    medianaGiornaliera = mediana([...perData.values()]);
    giorniConRewards = perData.size;
  } else {
    note.push('rewards non letti');
  }

  const giorniTrade = new Set(usabili.map((t) => giornoUtc(t.timestamp))).size;
  const oreCoperte = (tMax - inizio) / 3600;
  const giorniCoperti = Math.max(1, Math.ceil(oreCoperte / 24));

  const primo = await primoTrade(wallet, inizio);

  return {
    wallet,
    ok: true,

    capitaleUsd: capitale,
    contanteUsd: cash,
    valorePosizioniUsd: valorePosizioni,

    liquiditaBandaMedianaUsd: liq.length ? mediana(liq) : null,
    mercatiConLiquiditaLetta: liq.length,

    mercatiInsiemeOra: insiemeOra,
    mercatiInsiemeMax: insiemeMax,
    mercatiCensiti: mercatiCensiti.length,
    capitalePerMercatoUsd: (capitale !== null && denominatoreMercati) ? capitale / denominatoreMercati : null,
    fonteDenominatore,

    distanzaMidMedianaCents: distanze.length ? mediana(distanze) : null,
    distanzaCampioni: distanze.length,

    rewards14gUsd: rewards14g,
    rewardsMedianaGiornaliera: medianaGiornaliera,
    giorniConRewards,
    giorniAttiviRewardsPct: giorniConRewards === null ? null : giorniConRewards / GIORNI,

    pnl7gUsd: pnl7g,

    primoTradeIso: primo === null ? null : new Date(primo * 1000).toISOString(),
    etaGiorni: primo === null ? null : (ctx.aTs - primo) / 86400,

    giorniConTrade: giorniTrade,
    giorniCopertiTrade: giorniCoperti,
    giorniAttiviTradePct: giorniTrade / giorniCoperti,

    famiglie: perFamiglia,
    famigliaPrincipale: famigliaPrincipale ? famigliaPrincipale[0] : null,

    tradeTotali: usabili.length,
    tradeTaker: usabili.filter((t) => t.taker).length,
    quotaTaker: usabili.length ? usabili.filter((t) => t.taker).length / usabili.length : null,

    uscite: {
      ...conta,
      classificati: nClassificati,
      censurati: c.censurati,
      quote: nClassificati
        ? { A: conta.A / nClassificati, B: conta.B / nClassificati, C: conta.C / nClassificati,
            D: conta.D / nClassificati, E: conta.E / nClassificati }
        : null,
      costoCoppiaMedianoCents: costiCoppia.length ? mediana(costiCoppia) : null,
      deltaBMedianoCents: deltaB.length ? mediana(deltaB) : null,
    },

    coperturaOre: oreCoperte,
    note,
  };
}

// ══ IL GIRO ══════════════════════════════════════════════════════════════════════════════════════

async function principale() {
  const aTs = Math.floor(Date.now() / 1000);
  const ctx = {
    aTs,
    daTsRewards: aTs - GIORNI * 86400,
    daTsTrade: aTs - GIORNI_TRADE * 86400,
    orizzonteS: ORIZZONTE_H * 3600,
  };

  registra('═'.repeat(94));
  registra(`CENSIMENTO FASE 2 · soglia ${MIN_MERCATI} mercati · rewards ${GIORNI}g · trade ${GIORNI_TRADE}g · orizzonte ${ORIZZONTE_H}h`);

  const fase1 = leggi('censimento-109-fase1.json');
  let lista = (fase1.wallet || []).filter((r) => Number(r.mercati) >= MIN_MERCATI);
  registra(`fase 1: ${(fase1.wallet || []).length} wallet · con ≥${MIN_MERCATI} mercati: ${lista.length}`);
  if (LIMITE) lista = lista.slice(0, LIMITE);

  ctx.mercatiDelWallet = new Map(lista.map((r) => [normId(r.wallet), (r.mercatiElenco || []).map(normId)]));
  const elenco = lista.map((r) => normId(r.wallet));

  // ── RIPRESA ───────────────────────────────────────────────────────────────────────────────────
  const fatti = new Map();
  const cacheMercati = new Map();
  if (!RIFAI) {
    try {
      const vecchio = leggi(FILE_USCITA);
      for (const r of (vecchio.perWallet || [])) if (r && r.ok) fatti.set(r.wallet, r);
      for (const m of (vecchio.perMercato || [])) if (m && m.conditionId) cacheMercati.set(m.conditionId, m);
      registra(`ripresa dal checkpoint: ${fatti.size} wallet già profilati · ${cacheMercati.size} mercati in cache`);
    } catch { registra('nessun checkpoint: si parte da zero'); }
  } else {
    registra('--rifai: il checkpoint viene ignorato');
  }

  ctx.mercati = await preparaMercati(mercatiDelBoard(), cacheMercati);
  const conLiquidita = [...ctx.mercati.values()].filter((m) => fin(m.liquiditaBandaUsd)).length;
  registra(`per-mercato pronto: ${ctx.mercati.size} mercati · con liquidità in banda letta ${conLiquidita}`);

  const daFare = elenco.filter((w) => !fatti.has(w));
  registra(`da profilare: ${daFare.length} wallet · larghezza ${LARGHEZZA}`);

  const inizioGiro = Date.now();
  let falliti = [];

  const salva = (finito) => {
    const buoni = [...fatti.values()];
    const out = {
      generatoIl: new Date().toISOString(),
      completo: finito,
      parametri: { minMercati: MIN_MERCATI, giorni: GIORNI, giorniTrade: GIORNI_TRADE,
        orizzonteH: ORIZZONTE_H, fillPerDistanza: FILL_PER_DISTANZA, etaMaxCampioneS: ETA_MAX_CAMPIONE_S },
      fonte: 'data-api + lb-api + clob.polymarket.com + RPC Polygon (sola lettura)',
      walletCandidati: elenco.length,
      walletProfilati: buoni.length,
      walletFalliti: falliti.length,
      erroriCampione: falliti.slice(0, 10),
      chiamate: { api: contatore.api, rpc: contatore.rpc, ritentate: contatore.ritentate, errori: contatore.errori },
      // ⚠ Il per-mercato sta nel checkpoint apposta: alla ripresa vale 216 letture di libro risparmiate.
      perMercato: [...ctx.mercati.values()],
      perWallet: buoni,
    };
    return scrivi(FILE_USCITA, out);
  };

  const esiti = await inParallelo(daFare, LARGHEZZA, async (wallet) => {
    try {
      const r = await profilo(wallet, ctx);
      if (r.ok) fatti.set(wallet, r);
      return r;
    } catch (e) {
      return { wallet, ok: false, errore: e && e.message ? e.message : String(e) };
    }
  }, (f, t) => {
    // `inParallelo` chiama qui ogni 25 completamenti: è esattamente la cadenza di checkpoint chiesta.
    salva(false);
    const passati = (Date.now() - inizioGiro) / 1000;
    const stima = f > 0 ? ((t - f) * (passati / f)) / 60 : null;
    registra(`  … ${f}/${t} · ${fatti.size} profilati · ${Math.round(passati)}s trascorsi`
      + (stima !== null ? ` · ~${stima.toFixed(1)} min alla fine` : '')
      + ` · api ${contatore.api} ritentate ${contatore.ritentate} errori ${contatore.errori}`);
  });

  falliti = esiti.filter((e) => e && !e.ok);
  const f = salva(true);

  const durata = (Date.now() - inizioGiro) / 60000;
  registra('═'.repeat(94));
  registra(`FINITO · profilati ${fatti.size}/${elenco.length} · falliti ${falliti.length} · ${durata.toFixed(1)} min`);
  if (falliti.length) {
    const perMotivo = new Map();
    for (const x of falliti) perMotivo.set(x.errore, (perMotivo.get(x.errore) || 0) + 1);
    for (const [m, n] of [...perMotivo].sort((a, b) => b[1] - a[1]).slice(0, 6)) registra(`   ${n}× ${m}`);
  }
  registra(`scritto ${f}`);
  registra('═'.repeat(94));
}

principale().catch((e) => {
  registra('GUASTO: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});

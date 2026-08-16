#!/usr/bin/env node
'use strict';
// scripts/ricerca/osserva-maker.js — DOVE QUOTANO OGGI I 65 MAKER DELLO SCREENING.
//
//   node scripts/ricerca/osserva-maker.js                una fotografia di oggi, in append
//   node scripts/ricerca/osserva-maker.js --ore 48       finestra diversa dalle 24 h
//   node scripts/ricerca/osserva-maker.js --prova        calcola e stampa, NON scrive niente
//
// ═══ COSA FA ═════════════════════════════════════════════════════════════════════════════════════
// Legge i 65 wallet che lo screening del 15 agosto 2026 ha isolato (§5-bis p.161: negativi sul
// trading, positivi sui premi — pagano lo spread per incassare i reward, di proposito), guarda cosa
// hanno scambiato nelle ultime 24 ore, e per ogni `conditionId` toccato registra chi c'è, quanto ha
// girato, e la configurazione premiante del mercato (banda, scaglione, scadenza).
//
// Serve a rispondere nel tempo a una domanda che una fotografia sola non può chiudere: **dove si
// spostano**. Un mercato che compare oggi e non c'era ieri è un ingresso; uno che sparisce è un
// abbandono, e l'abbandono di un gruppo che vive di liquidity rewards è l'informazione più densa che
// questa corsia possa produrre.
//
// ⚠ SOLA LETTURA, E NON SOLO PER PROMESSA. Questo file non importa NIENTE da `lib/maker/` né da
// `lib/venues/`: passa da `screening-lib.js`, che è la corsia di ricerca già isolata per costruzione
// (§5-bis p.149, p.161). Le funzioni che sanno firmare, piazzare o cancellare non sono raggiungibili
// da qui. L'unica scrittura è `data/ricerca/osservatorio.json`.
//
// ═══ ⚠ IL SUBGRAPH NON È STATO USATO, E VA DETTO SUBITO ══════════════════════════════════════════
// La richiesta diceva «dal subgraph Polygon». **Da questa macchina il subgraph non è raggiungibile**,
// e non è un'impressione — è stato provato prima di scrivere una riga di questo file:
//   · `api.thegraph.com/subgraphs/name/…` → **301** verso `error.thegraph.com/apierror.json`: il
//     servizio hosted è stato ritirato;
//   · `gateway.thegraph.com/api/subgraphs/id/…` → **`auth error: missing authorization header`**, e in
//     `.env` non esiste nessuna chiave (`SUBGRAPH_URL`, `GRAPH_API_KEY`, `GOLDSKY_*`: tutte assenti);
//   · gli endpoint pubblici Goldsky rispondono **404** ai nomi tentati, e indovinare il nome di un
//     deployment non è una fonte.
//
// Quindi si usa **`data-api.polymarket.com/trades`**, che in questo repo non è un ripiego improvvisato:
// è la fonte di `screening-05-uscite.js`, la sola che distingue maker da taker (`takerOnly`), e la sua
// semantica è stata **MISURATA** riga per riga, non assunta (§5-bis p.162). Porta esattamente i campi
// che servono qui: `proxyWallet`, `conditionId`, `side`, `size`, `price`, `timestamp`.
//
// **Cosa si perde rispetto al subgraph, detto per intero**: il subgraph darebbe una finestra temporale
// esatta e paginabile all'indietro senza limite; `/trades` pagina dal più recente, quindi la finestra
// di 24 h è coperta solo finché entra nelle pagine che si accettano di scaricare. Ogni wallet dichiara
// se la finestra è stata COPERTA o TRONCATA, e i troncati sono contati nel referto invece di sparire:
// un wallet troncato è un wallet di cui si sa MENO, mai un wallet con meno mercati.

const fs = require('fs');
const path = require('path');
const {
  apiGet, inParallelo, scrivi, leggi, DIR_DATI, contatore,
} = require('./screening-lib');

// ── ARGOMENTI ───────────────────────────────────────────────────────────────────────────────────
const argomenti = process.argv.slice(2);
const arg = (nome, difetto) => {
  const i = argomenti.indexOf(nome);
  return i >= 0 ? Number(argomenti[i + 1]) : difetto;
};
const ORE = arg('--ore', 24);
const PROVA = argomenti.includes('--prova');

const PER_PAGINA = 500;
/** Quante pagine di `/trades` si accetta di scaricare per wallet prima di dichiarare TRONCATO.
 *  12 × 500 = 6.000 fill: sui volumi misurati dei 65 copre le 24 h con margine largo. */
const PAGINE_MAX = 12;
const BLOCCO_GAMMA = 20;

const FILE_65 = 'screening-04-referto.json';
const FILE_EFFICIENTI = 'efficienti-01-gruppo.json';
const FILE_USCITA = 'osservatorio.json';

// ── LETTORI CHE NON TRASFORMANO «NON SO» IN «ZERO» ──────────────────────────────────────────────
/** ⚠ `Number(null) === 0`: otto occorrenze in questo repo, tutte trovate da una prova e mai dal
 *  ragionamento (§5.3). Qui morderebbe su `rewardsMinSize`: un mercato di cui non si conosce lo
 *  scaglione sembrerebbe quello con lo scaglione più basso, cioè il più interessante. */
function numero(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '') {
    const v = Number(x);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}
const normId = (x) => (typeof x === 'string' ? x.trim().toLowerCase() : '');

// ── LE DUE LISTE DI WALLET ──────────────────────────────────────────────────────────────────────
/**
 * I 65 arrivano da `screening-04-referto.json` (`passatiWallet`), i 4 «efficienti» da
 * `efficienti-01-gruppo.json` (`gruppo`). Si LEGGONO, non si ricopiano: due elenchi scritti a mano
 * sarebbero due elenchi che un giorno divergono, ed è il reperto D1 applicato a un campione.
 */
function leggiWallet() {
  let referto;
  try { referto = leggi(FILE_65); }
  catch (e) { return { ok: false, errore: `${FILE_65} non leggibile: ${e.message}` }; }
  const sessantacinque = (referto.passatiWallet || []).map((r) => normId(r.wallet)).filter(Boolean);
  if (!sessantacinque.length) return { ok: false, errore: `${FILE_65} non contiene 'passatiWallet'` };

  // Gli efficienti sono un SOTTOINSIEME dichiarato: se il file manca, l'osservatorio funziona lo
  // stesso e la vista di difetto lo dice, invece di fingere un gruppo vuoto.
  let efficienti = [];
  let efficientiOk = true;
  try { efficienti = (leggi(FILE_EFFICIENTI).gruppo || []).map((r) => normId(r.wallet)).filter(Boolean); }
  catch { efficientiOk = false; }

  const dentro = new Set(sessantacinque);
  const estranei = efficienti.filter((w) => !dentro.has(w));
  return {
    ok: true,
    sessantacinque,
    efficienti,
    efficientiOk,
    // Un efficiente che non stesse fra i 65 sarebbe una rottura di premessa (§5-bis p.163 dice che i
    // 4 escono DAI 65): si dichiara invece di aggiustarla in silenzio.
    efficientiEstranei: estranei,
  };
}

// ── I TRADE DELLE ULTIME `ORE` ──────────────────────────────────────────────────────────────────
/**
 * Pagina `/trades` all'indietro finché copre `daTs` o finisce le pagine concesse.
 *
 * `takerOnly=false` ⇒ **tutti** i fill, maker compresi. È la scelta giusta qui e vale la pena dirlo:
 * questo gruppo vive di ordini a riposo, quindi limitarsi ai taker mostrerebbe la parte meno
 * rappresentativa del loro comportamento (§5-bis p.162: quando mollano pagano lo spread, ed è il 16,6%).
 *
 * Restituisce sempre `copertaFinestra`: `false` significa «ho esaurito le pagine prima di arrivare a
 * 24 h fa», cioè un dato PARZIALE che il referto deve dichiarare.
 */
async function trade24h(wallet, daTs) {
  const righe = new Map();
  let piuVecchio = Infinity;
  let pagine = 0;
  for (let p = 0; p < PAGINE_MAX; p += 1) {
    const r = await apiGet(`/trades?user=${wallet}&takerOnly=false&limit=${PER_PAGINA}&offset=${p * PER_PAGINA}`);
    if (!r.ok || !Array.isArray(r.dati)) return { ok: false, errore: r.errore || 'risposta non lista' };
    pagine += 1;
    for (const t of r.dati) {
      // Chiave di deduplica: due pagine che si sovrappongono non devono contare due volte lo stesso fill.
      const k = [t.conditionId, t.asset, t.timestamp, t.price, t.size, t.side].join('|');
      righe.set(k, t);
      const ts = numero(t.timestamp);
      if (ts !== null && ts < piuVecchio) piuVecchio = ts;
    }
    if (r.dati.length < PER_PAGINA) return { ok: true, righe: [...righe.values()], pagine, copertaFinestra: true, esaurito: true };
    if (piuVecchio <= daTs) return { ok: true, righe: [...righe.values()], pagine, copertaFinestra: true, esaurito: false };
  }
  return { ok: true, righe: [...righe.values()], pagine, copertaFinestra: false, esaurito: false };
}

// ── LA CONFIGURAZIONE PREMIANTE DEI MERCATI ─────────────────────────────────────────────────────
/**
 * Banda, scaglione, scadenza e volume del mercato, da Gamma.
 *
 * ⚠ ASSENTE NON È ZERO, di nuovo: un mercato che Gamma non restituisce non entra nella mappa, e a
 * valle i suoi campi restano `null`. La differenza conta perché `minSize: 0` significherebbe «lo
 * scaglione più basso che esista», cioè il mercato più appetibile — l'errore nella direzione che
 * rassicura, come sempre in questa famiglia.
 */
async function configurazioneMercati(conditionIds) {
  const fuori = new Map();
  // ⚠ DUE PASSATE, E LA SECONDA NON È FACOLTATIVA: **Gamma restituisce di difetto i soli mercati
  // APERTI**. È la trappola già pagata in §5-bis p.162, e questo script l'ha ripagata al primo giro —
  // 453 mercati su 1.995 tornavano senza banda, senza scaglione e senza scadenza, e sembravano un
  // limite dell'API. Erano mercati CHIUSI: la sonda su uno solo dà 0 righe senza suffisso e 1 riga
  // con `&closed=true`. Un gruppo che quota su mercati a 24 ore ne ha sempre parecchi già risolti, e
  // scartarli avrebbe tolto proprio la coda che dice quando si esce.
  for (const suffisso of ['', '&closed=true']) {
    for (let i = 0; i < conditionIds.length; i += BLOCCO_GAMMA) {
      const pezzo = conditionIds.slice(i, i + BLOCCO_GAMMA).filter((c) => !fuori.has(c));
      if (!pezzo.length) continue;
      const qs = pezzo.map((c) => `condition_ids=${c}`).join('&');
      const r = await apiGet(`/markets?${qs}${suffisso}`, 0, 'gamma-api.polymarket.com');
      if (!r.ok || !Array.isArray(r.dati)) continue;
      for (const m of r.dati) {
        fuori.set(normId(m.conditionId), {
          titolo: m.question || m.title || null,
          slug: m.slug || null,
          minSize: numero(m.rewardsMinSize),
          maxSpread: numero(m.rewardsMaxSpread),
          volume24hMercato: numero(m.volume24hr),
          liquidita: numero(m.liquidity),
          endDate: m.endDate || null,
          chiuso: m.closed === true,
        });
      }
    }
  }
  return fuori;
}

/** Ore alla risoluzione, o `null` se la scadenza non è determinabile. Può essere NEGATIVO: un mercato
 *  già scaduto ma non ancora risolto è un'informazione, non un errore da nascondere. */
function oreAllaScadenza(endDate, adessoMs) {
  if (typeof endDate !== 'string' || !endDate) return null;
  const t = Date.parse(endDate);
  return Number.isFinite(t) ? (t - adessoMs) / 3_600_000 : null;
}

// ── IL GIRO ─────────────────────────────────────────────────────────────────────────────────────
async function principale() {
  const adessoMs = Date.now();
  const daTs = Math.floor(adessoMs / 1000) - ORE * 3600;
  const giorno = new Date(adessoMs).toISOString().slice(0, 10);

  const w = leggiWallet();
  if (!w.ok) { console.error('RIFIUTATO: ' + w.errore); process.exitCode = 1; return; }

  console.log(`osservatorio maker — finestra ${ORE} h, giorno ${giorno}`);
  console.log(`  ${w.sessantacinque.length} wallet dallo screening · ${w.efficienti.length} «efficienti»`
    + (w.efficientiOk ? '' : '  ⚠ elenco efficienti NON leggibile'));
  if (w.efficientiEstranei.length) {
    console.log(`  ⚠ ${w.efficientiEstranei.length} efficiente/i NON è fra i 65: ${w.efficientiEstranei.join(', ')}`);
  }
  console.log(`  fonte trade: data-api /trades (takerOnly=false) — il subgraph non è raggiungibile da qui, vedi l'intestazione`);
  console.log('');

  // ── 1 · i trade, wallet per wallet ────────────────────────────────────────────────────────────
  const esiti = await inParallelo(w.sessantacinque, 6, (wallet) => trade24h(wallet, daTs),
    (fatti, tot) => console.log(`  … ${fatti}/${tot} wallet`));

  const perMercato = new Map();
  const walletNonLetti = [];
  const walletTroncati = [];
  let fillNellaFinestra = 0;

  for (let i = 0; i < w.sessantacinque.length; i += 1) {
    const wallet = w.sessantacinque[i];
    const e = esiti[i];
    if (!e || e.ok !== true) { walletNonLetti.push({ wallet, errore: (e && (e.errore || e.error)) || 'esito non leggibile' }); continue; }
    if (e.copertaFinestra !== true) walletTroncati.push(wallet);

    for (const t of e.righe) {
      const ts = numero(t.timestamp);
      if (ts === null || ts < daTs) continue;             // fuori finestra
      const cid = normId(t.conditionId);
      if (!cid) continue;
      const size = numero(t.size);
      const prezzo = numero(t.price);
      // Un fill di cui non si legge size o prezzo non vale zero dollari: non si conta il suo nozionale,
      // e il conteggio dei fill lo registra comunque. Sono due domande diverse.
      const nozionale = (size !== null && prezzo !== null) ? size * prezzo : null;

      if (!perMercato.has(cid)) {
        // ⚠ IL TITOLO SI PRENDE ANCHE DAL TRADE, non solo da Gamma. `/trades` porta gia' `title` e
        // `slug`, e usarli come ripiego costa zero chiamate: senza, un mercato che Gamma non
        // restituisce comparirebbe nel referto come un conditionId nudo, cioe' illeggibile proprio
        // nei casi che meritano piu' attenzione. Resta un RIPIEGO dichiarato: la fonte buona e'
        // Gamma, e `configurazioneLetta` continua a dire quale delle due ha risposto.
        perMercato.set(cid, { conditionId: cid, wallet: new Set(), fill: 0, nozionaleUsd: 0, nozionaleIgnoto: 0,
          primoTs: ts, ultimoTs: ts,
          titoloDalTrade: typeof t.title === 'string' && t.title ? t.title : null,
          slugDalTrade: typeof t.slug === 'string' && t.slug ? t.slug : null });
      }
      const m = perMercato.get(cid);
      if (!m.titoloDalTrade && typeof t.title === 'string' && t.title) m.titoloDalTrade = t.title;
      m.wallet.add(wallet);
      m.fill += 1;
      if (nozionale === null) m.nozionaleIgnoto += 1; else m.nozionaleUsd += nozionale;
      if (ts < m.primoTs) m.primoTs = ts;
      if (ts > m.ultimoTs) m.ultimoTs = ts;
      fillNellaFinestra += 1;
    }
  }

  const ids = [...perMercato.keys()];
  console.log(`\n  ${fillNellaFinestra} fill nella finestra · ${ids.length} mercati toccati`
    + `${walletNonLetti.length ? ` · ⚠ ${walletNonLetti.length} wallet NON letti` : ''}`
    + `${walletTroncati.length ? ` · ⚠ ${walletTroncati.length} troncati` : ''}`);

  // ── 2 · la configurazione dei mercati ─────────────────────────────────────────────────────────
  console.log(`  configurazione premiante di ${ids.length} mercati da Gamma…`);
  const cfg = await configurazioneMercati(ids);

  const efficienti = new Set(w.efficienti);
  const mercati = ids.map((cid) => {
    const m = perMercato.get(cid);
    const c = cfg.get(cid) || {};
    const elenco = [...m.wallet].sort();
    return {
      conditionId: cid,
      titolo: c.titolo ?? m.titoloDalTrade ?? null,
      slug: c.slug ?? m.slugDalTrade ?? null,
      titoloDaRipiego: c.titolo == null && m.titoloDalTrade != null,
      wallet: elenco,
      nWallet: elenco.length,
      nWalletEfficienti: elenco.filter((x) => efficienti.has(x)).length,
      fill: m.fill,
      // Due volumi DIVERSI, e tenerli distinti è il punto: uno è quanto ha girato il GRUPPO, l'altro
      // quanto ha girato il mercato intero. Fonderli direbbe una cosa che nessuno ha misurato.
      volumeGruppo24hUsd: Math.round(m.nozionaleUsd * 100) / 100,
      fillSenzaNozionale: m.nozionaleIgnoto,
      volume24hMercato: c.volume24hMercato ?? null,
      maxSpread: c.maxSpread ?? null,
      minSize: c.minSize ?? null,
      liquidita: c.liquidita ?? null,
      endDate: c.endDate ?? null,
      oreAllaScadenza: oreAllaScadenza(c.endDate, adessoMs),
      chiuso: c.chiuso === true,
      configurazioneLetta: cfg.has(cid),
      primoTs: m.primoTs,
      ultimoTs: m.ultimoTs,
    };
  }).sort((a, b) => (b.nWallet - a.nWallet) || (b.volumeGruppo24hUsd - a.volumeGruppo24hUsd));

  const riga = {
    giorno,
    generatoIl: new Date(adessoMs).toISOString(),
    finestraOre: ORE,
    daTs,
    aTs: Math.floor(adessoMs / 1000),
    fonte: {
      trade: 'data-api.polymarket.com/trades?takerOnly=false',
      configurazione: 'gamma-api.polymarket.com/markets',
      subgraph: 'NON USATO — hosted service ritirato (301), gateway decentralizzato senza chiave in .env',
    },
    walletOsservati: w.sessantacinque.length,
    walletEfficienti: w.efficienti,
    walletNonLetti,
    walletTroncati,
    fillNellaFinestra,
    mercatiToccati: mercati.length,
    // ⚠ Quanti mercati hanno la configurazione ILLEGGIBILE. Senza questo numero, «minSize null» in una
    // riga sembra un caso isolato invece che il sintomo di una fonte che non ha risposto.
    mercatiSenzaConfigurazione: mercati.filter((m) => !m.configurazioneLetta).length,
    chiamate: { api: contatore.api, ritentate: contatore.ritentate, errori: contatore.errori },
    mercati,
  };

  // ── 3 · append, UNA RIGA PER GIORNO ───────────────────────────────────────────────────────────
  if (PROVA) {
    console.log(`\n--prova: NIENTE è stato scritto. La riga di oggi avrebbe ${mercati.length} mercati.`);
    return riga;
  }

  let storico = { versione: 1, giorni: [] };
  const percorso = path.join(DIR_DATI, FILE_USCITA);
  if (fs.existsSync(percorso)) {
    try { storico = leggi(FILE_USCITA); }
    catch (e) {
      // ⚠ NON si sovrascrive uno storico che non si è riusciti a leggere: sarebbe cancellare tutti i
      // giorni precedenti per un errore di lettura di oggi. Si rifiuta e lo si dice.
      console.error(`\nRIFIUTATO: ${FILE_USCITA} esiste ma non è leggibile (${e.message}).`
        + ' Non lo sovrascrivo: perderei lo storico. Sposta il file e rilancia.');
      process.exitCode = 1;
      return null;
    }
  }
  if (!Array.isArray(storico.giorni)) storico.giorni = [];

  // «Una riga per giorno»: un secondo giro nello stesso giorno SOSTITUISCE, non accoda. Accodare
  // farebbe sembrare due osservazioni dello stesso giorno un ingresso e un'uscita nel confronto.
  const esistente = storico.giorni.findIndex((g) => g && g.giorno === giorno);
  const sostituita = esistente >= 0;
  if (sostituita) storico.giorni[esistente] = riga; else storico.giorni.push(riga);
  storico.giorni.sort((a, b) => String(a.giorno).localeCompare(String(b.giorno)));
  storico.versione = 1;
  storico.aggiornatoIl = new Date(adessoMs).toISOString();

  const f = scrivi(FILE_USCITA, storico);
  console.log(`\n${sostituita ? 'SOSTITUITA' : 'AGGIUNTA'} la riga del ${giorno} — ${storico.giorni.length} giorno/i in archivio`);
  console.log(`→ ${f}`);
  console.log(`\nvista: node scripts/cli/osserva.js${storico.giorni.length > 1 ? '' : '   (il confronto col giorno prima arriva dal secondo giro)'}`);
  return riga;
}

principale().catch((e) => { console.error('\nGUASTO: ' + (e && e.stack || e)); process.exitCode = 1; });

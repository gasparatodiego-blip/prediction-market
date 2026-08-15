'use strict';
// scripts/ricerca/screening-lib.js — LA CORSIA DI SOLA LETTURA DELLO SCREENING DEI MAKER.
//
// ═══ PERCHÉ UNA CORSIA A SÉ, DI NUOVO ════════════════════════════════════════════════════════════
// Stessa disciplina di `lib-onchain.js` (§5-bis p.149), e per la stessa ragione: questo file non
// importa NIENTE da `lib/maker/` né da `lib/venues/`. Non è una promessa di comportamento — è che le
// funzioni che sanno firmare, piazzare o cancellare non sono raggiungibili da qui. L'unica rete che
// tocca sono due GET pubbliche e un POST JSON-RPC in lettura.
//
// ═══ LE DUE FONTI, E PERCHÉ NON SE NE USA UNA TERZA ══════════════════════════════════════════════
//   · `data-api.polymarket.com` — PUBBLICA, senza credenziali. `/activity?type=REWARD` porta i
//     pagamenti veri (§4.12), `/positions` le posizioni aperte con P&L.
//   · `POLYGON_RPC_URL` — per la ricevuta della transazione di distribuzione e per il saldo pUSD.
//
// ⚠ ETHERSCAN NON È UN'OPZIONE QUI, e va detto perché la strada sembra ovvia: `lib-onchain.js` ci
// passava, ma richiede `POLYGONSCAN_API_KEY`, che in questo `.env` NON esiste (verificato). E l'RPC
// pubblico è NON-archive — «History has been pruned for this block» oltre ~2 giorni — quindi
// quattordici giorni di `eth_getLogs` sul distributore sono irraggiungibili da questa macchina.
// Da qui la forma dello screening: l'universo lo dà la ricevuta della tx (una lettura, sempre
// disponibile), la storia dei 14 giorni la dà la Data API wallet per wallet.

const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// ── COSTANTI VERIFICATE ──────────────────────────────────────────────────────────────────────────
/** Transfer(address,address,uint256) */
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/**
 * ⚠ IL COLLATERALE NON È USDC.e. È lo stesso avvertimento di `lib-onchain.js:41`, ripetuto perché è
 * il primo posto in cui si sbaglia: assumere `0x2791bca1…` fa trovare ZERO pagamenti, un silenzio che
 * sembra «il distributore non è quello». 6 decimali.
 */
const PUSD = '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb';
const DATA_API = 'data-api.polymarket.com';

/**
 * Quante ore dopo la mezzanotte un pagamento appartiene ancora al giorno PRECEDENTE.
 * Stessa assunzione di `lib/maker/reward-reale.js:117`, e stessa origine: il venue liquida la
 * giornata UTC appena chiusa subito dopo mezzanotte. Sei ore sono margine per un batch in ritardo.
 */
const FINESTRA_PAGAMENTO_H = 6;

const DIR_DATI = path.join(process.cwd(), 'data', 'ricerca');

// ── THROTTLE E BACKOFF, PROPRI DI QUESTA CORSIA ──────────────────────────────────────────────────
// Non condivide stato con la flotta: è una quota diversa e non può far morire un ordine.
const MAX_RPS_API = 8;
const MAX_RPS_RPC = 6;
const contatore = { api: 0, rpc: 0, ritentate: 0, errori: 0 };

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * IL CANCELLO DEL THROTTLE, serializzato.
 *
 * ⚠ «leggi l'ultimo istante, aspetta la differenza, riscrivi l'ultimo istante» NON funziona con più
 * richieste in volo: sei operai leggono lo stesso valore nello stesso tick e partono insieme. Prima
 * stesura misurata: 30 chiamate in 2,2 s contro i 6 s del limite dichiarato — cioè il throttle non
 * esisteva. Qui le attese si mettono in FILA su una catena di promesse, quindi il ritmo è quello
 * dichiarato qualunque sia la concorrenza. Su un'API pubblica di terzi la cortesia è un requisito.
 */
function faiCancello(rps) {
  let coda = Promise.resolve();
  let ultimo = 0;
  return () => {
    coda = coda.then(async () => {
      const gap = 1000 / rps;
      const ora = Date.now();
      if (ora - ultimo < gap) await attesa(gap - (ora - ultimo));
      ultimo = Date.now();
    });
    return coda;
  };
}
const cancelloApi = faiCancello(MAX_RPS_API);
const cancelloRpc = faiCancello(MAX_RPS_RPC);

function env(k) {
  if (process.env[k]) return process.env[k];
  try {
    for (const l of fs.readFileSync('.env', 'utf8').split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
      if (m && m[1] === k) return m[2];
    }
  } catch { /* nessun .env */ }
  return null;
}

function getGrezzo(host, percorso, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host,
        path: percorso,
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'edgeradar-ricerca/1.0 (read-only screening)' },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', errore: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, body: '', errore: e.message }));
    req.end();
  });
}

/**
 * UNA GET PUBBLICA con throttle e backoff.
 *
 * ⚠ UN 200 CON UN CORPO CHE NON È UNA LISTA NON SI RITENTA — è la regola di §4.11: fra ritentare
 * all'infinito e dichiarare il dato mancante, il secondo errore costa meno. Qui l'esito è
 * `{ ok:false }`, che il chiamante propaga come «non misurato», mai come «zero».
 */
async function apiGet(percorso, tentativo = 0, host = DATA_API) {
  await cancelloApi();
  contatore.api += 1;

  const r = await getGrezzo(host, percorso);
  if (r.status === 429 || r.status >= 500 || r.status === 0) {
    if (tentativo >= 5) { contatore.errori += 1; return { ok: false, errore: `HTTP ${r.status} dopo 6 tentativi` }; }
    contatore.ritentate += 1;
    // jitter ±25%: senza, ogni lettore riparte dallo stesso istante dopo lo stesso 429 (§4.11).
    const base = Math.min(30_000, 1000 * Math.pow(2, tentativo));
    await attesa(base * (0.75 + Math.random() * 0.5));
    return apiGet(percorso, tentativo + 1, host);
  }
  if (r.status !== 200) { contatore.errori += 1; return { ok: false, errore: `HTTP ${r.status}` }; }
  try { return { ok: true, dati: JSON.parse(r.body) }; }
  catch (e) { contatore.errori += 1; return { ok: false, errore: `non JSON: ${e.message}` }; }
}

async function rpc(method, params, tentativo = 0) {
  const url = env('POLYGON_RPC_URL');
  if (!url) throw new Error('POLYGON_RPC_URL assente');
  await cancelloRpc();
  contatore.rpc += 1;

  const body = JSON.stringify({ jsonrpc: '2.0', id: contatore.rpc, method, params });
  const u = new URL(url);
  const r = await new Promise((res) => {
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 30_000,
    }, (resp) => {
      let d = '';
      resp.on('data', (c) => { d += c; });
      resp.on('end', () => res({ status: resp.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(); res({ status: 0, body: '' }); });
    req.on('error', (e) => res({ status: 0, body: '', errore: e.message }));
    req.write(body); req.end();
  });

  if (r.status === 429 || r.status >= 500 || r.status === 0) {
    if (tentativo >= 5) { contatore.errori += 1; throw new Error(`RPC ${method}: ${r.status} dopo 6 tentativi`); }
    contatore.ritentate += 1;
    await attesa(Math.min(30_000, 1000 * Math.pow(2, tentativo)));
    return rpc(method, params, tentativo + 1);
  }
  let j;
  try { j = JSON.parse(r.body); } catch { contatore.errori += 1; throw new Error(`RPC ${method}: risposta non JSON`); }
  if (j.error) { contatore.errori += 1; throw new Error(`RPC ${method}: ${j.error.message || 'errore'}`); }
  return j.result;
}

/**
 * ESEGUE `lavoro` su ogni elemento con al più `larghezza` in volo.
 * Il throttle vero è dentro `apiGet`; questo serve solo a tenere la pipeline piena.
 */
async function inParallelo(elementi, larghezza, lavoro, suProgresso) {
  const esiti = new Array(elementi.length);
  let prossimo = 0;
  let fatti = 0;
  const operaio = async () => {
    for (;;) {
      const i = prossimo; prossimo += 1;
      if (i >= elementi.length) return;
      try { esiti[i] = await lavoro(elementi[i], i); }
      catch (e) { esiti[i] = { errore: e.message }; }
      fatti += 1;
      if (suProgresso && fatti % 25 === 0) suProgresso(fatti, elementi.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(larghezza, elementi.length) }, operaio));
  return esiti;
}

/**
 * IL GIORNO DI COMPETENZA di un pagamento, in `YYYY-MM-DD` UTC.
 * Un pagamento nelle prime `FINESTRA_PAGAMENTO_H` ore appartiene al giorno PRIMA (vedi la costante).
 */
function giornoDiCompetenza(timestampSec) {
  const ms = timestampSec * 1000 - FINESTRA_PAGAMENTO_H * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function scrivi(nome, oggetto) {
  fs.mkdirSync(DIR_DATI, { recursive: true });
  const f = path.join(DIR_DATI, nome);
  fs.writeFileSync(f, JSON.stringify(oggetto, null, 2));
  return f;
}

function leggi(nome) {
  return JSON.parse(fs.readFileSync(path.join(DIR_DATI, nome), 'utf8'));
}

const mediana = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

module.exports = {
  TOPIC_TRANSFER, PUSD, DATA_API, FINESTRA_PAGAMENTO_H, DIR_DATI,
  apiGet, rpc, inParallelo, giornoDiCompetenza, scrivi, leggi, mediana, env, contatore, attesa,
};

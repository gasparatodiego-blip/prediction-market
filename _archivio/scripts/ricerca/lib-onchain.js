'use strict';
// scripts/ricerca/lib-onchain.js — LA CORSIA ON-CHAIN DELLA RICERCA, SEPARATA DA TUTTO IL RESTO.
//
// ═══ PERCHÉ UNA CORSIA A SÉ ══════════════════════════════════════════════════════════════════════
// Il bot è VIVO mentre questa ricerca gira. La regola della sessione è netta: gli ordini valgono più
// dei dati. Quindi:
//   · questa corsia parla SOLO con Polygon (`POLYGON_RPC_URL`), che è una quota diversa da quella di
//     Polymarket e non può far morire un ordine;
//   · non importa NIENTE da `lib/maker/` né da `lib/venues/`: non ha modo di piazzare o cancellare,
//     e non è una promessa — è che le funzioni non sono raggiungibili da qui;
//   · ha un suo throttle e un suo backoff, e non condivide stato con la flotta.
//
// ═══ COME SI TROVANO 30 GIORNI DI PAGAMENTI SENZA SCANSIONARE 1,3 MILIONI DI BLOCCHI ═════════════
// Il distributore paga UNA volta al giorno, a mezzanotte UTC. Scansionare l'intero intervallo con
// `eth_getLogs` vorrebbe dire centinaia di richieste su finestre da 2-10k blocchi, e la maggior parte
// tornerebbe vuota. Invece: Polygon ha blocchi da ~2 s, quindi un giorno vale ~43.200 blocchi. Da un
// pagamento NOTO si stima il blocco di ogni mezzanotte precedente e si interroga una finestra STRETTA
// attorno a quella stima. Trenta finestre invece di seicento.
//
// ⚠ LA STIMA VA VERIFICATA, NON CREDUTA: il tempo di blocco di Polygon non è esattamente 2 s e la
// deriva si accumula su trenta giorni. Quindi la finestra si àncora al TIMESTAMP vero: si legge il
// blocco stimato, si misura lo scarto dall'istante voluto, si corregge, e solo allora si interroga.
// Due o tre letture di blocco costano molto meno di una finestra sbagliata.

const https = require('https');
const { URL } = require('url');

// ── LE COSTANTI DELLA RICERCA ─────────────────────────────────────────────────────────────────────
// L'ancora è il pagamento verificato dall'operatore: blocco 91916118 alle 2026-08-13T00:00:04Z.
const ANCORA_BLOCCO = 91916118;
const ANCORA_MS = Date.parse('2026-08-13T00:00:04Z');
// Polygon dichiara ~2 s; la deriva reale si corregge per bisezione, questa è solo la prima ipotesi.
const BLOCCO_MS_STIMA = 2000;
// La finestra attorno alla mezzanotte stimata. 400 blocchi ≈ 13 minuti: abbastanza per assorbire una
// deriva residua e un pagamento che slitta di qualche minuto, abbastanza stretta da restare in un
// solo `eth_getLogs` su qualunque RPC pubblico.
const FINESTRA_BLOCCHI = 400;

// Transfer(address,address,uint256)
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// ⚠ IL TOKEN NON È USDC.e, E VA DETTO PERCHÉ È IL PRIMO POSTO IN CUI SI SBAGLIA.
// La prima stesura assumeva `0x2791bca1…` (USDC.e), che è il collaterale «ovvio» di Polymarket, e ha
// trovato ZERO pagamenti su trenta giorni — un silenzio che sembrava «il distributore non è quello».
// La ricevuta della transazione nota lo smentisce: i 400 Transfer sono su
// `0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb`, e il `from` di ognuno È il distributore.
// Verificato sulla tx 0xe92be413…ce34: 401 log, 400 su questo token, `to` = il contratto Disperse
// (0xd152f549…2150).
const PUSD = '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb';

// ── ⚠ L'RPC PUBBLICO NON BASTA, E LO DICE LUI STESSO ──────────────────────────────────────────────
// Il primo giro su trenta giorni ha restituito 2 giorni e 28 errori identici:
//   «History has been pruned for this block»
// `polygon-bor-rpc.publicnode.com` è un nodo NON-archive: conserva i log per ~2 giorni. Non è un
// difetto del metodo — l'ancora è esatta al secondo e la bisezione trova la mezzanotte in 3 letture —
// è che i dati oltre due giorni su quel nodo non esistono.
//
// Da qui in poi lo STORICO passa dall'API Etherscan multichain (chainid 137 = Polygon), che conserva
// tutto. L'RPC resta per le letture di blocco, dove è più veloce e non ha limiti di quota.
//
// ⚠ SONO DUE QUOTE DIVERSE E NESSUNA DELLE DUE È QUELLA DI POLYMARKET: il bot è vivo, e la regola
// della sessione è che gli ordini valgono più dei dati. Questo file non parla con Polymarket affatto.
const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api';
const CHAIN_ID = 137;
// Il piano gratuito Etherscan dà 5 chiamate al secondo. Si sta a 4 per lasciare margine: superare la
// soglia non dà un errore leggibile, dà un risultato vuoto che sembra «non ci sono dati».
const MAX_RPS_SCAN = 4;
let ultimaScan = 0;

const MAX_RPS = 6;
let ultimaRichiesta = 0;
let contatore = { chiamate: 0, ritentate: 0, errori: 0 };

function env(k) {
  if (process.env[k]) return process.env[k];
  try {
    for (const l of require('fs').readFileSync('.env', 'utf8').split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
      if (m && m[1] === k) return m[2];
    }
  } catch { /* nessun .env */ }
  return null;
}

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tentativo = 0) {
  const url = env('POLYGON_RPC_URL');
  if (!url) throw new Error('POLYGON_RPC_URL assente');
  const gap = 1000 / MAX_RPS;
  const ora = Date.now();
  if (ora - ultimaRichiesta < gap) await attesa(gap - (ora - ultimaRichiesta));
  ultimaRichiesta = Date.now();
  contatore.chiamate += 1;

  const body = JSON.stringify({ jsonrpc: '2.0', id: contatore.chiamate, method, params });
  const u = new URL(url);
  const risposta = await new Promise((res, rej) => {
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 30_000,
    }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => res({ status: r.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', rej);
    req.write(body); req.end();
  }).catch((e) => ({ status: 0, body: '', errore: e.message }));

  // BACKOFF: 429 e 5xx si ritentano con attesa crescente; il resto no. Sei tentativi al massimo —
  // oltre, il dato non c'è e va dichiarato mancante invece di essere aspettato all'infinito.
  if (risposta.status === 429 || risposta.status >= 500 || risposta.status === 0) {
    if (tentativo >= 5) { contatore.errori += 1; throw new Error(`RPC ${method}: ${risposta.status} dopo 6 tentativi`); }
    contatore.ritentate += 1;
    await attesa(Math.min(30_000, 1000 * Math.pow(2, tentativo)));
    return rpc(method, params, tentativo + 1);
  }
  let j;
  try { j = JSON.parse(risposta.body); } catch { contatore.errori += 1; throw new Error(`RPC ${method}: risposta non JSON`); }
  if (j.error) {
    // «query returned more than N results» e simili non si ritentano: si restringe la finestra.
    contatore.errori += 1;
    throw new Error(`RPC ${method}: ${j.error.message || JSON.stringify(j.error)}`);
  }
  return j.result;
}

const hex = (n) => '0x' + Number(n).toString(16);

async function blocco(n) {
  const b = await rpc('eth_getBlockByNumber', [hex(n), false]);
  if (!b) throw new Error(`blocco ${n} non trovato`);
  return { numero: Number(b.number), ms: Number(b.timestamp) * 1000 };
}

/**
 * IL BLOCCO PIÙ VICINO A UN ISTANTE, verificato e non stimato.
 * Si parte dalla stima lineare dall'ancora e si corregge finché lo scarto è sotto la tolleranza.
 * Ogni correzione costa UNA lettura di blocco: in pratica bastano due o tre giri.
 */
async function bloccoAllIstante(msVoluto, tolleranzaMs = 60_000) {
  let n = ANCORA_BLOCCO + Math.round((msVoluto - ANCORA_MS) / BLOCCO_MS_STIMA);
  if (n < 1) n = 1;
  let ultimo = null;
  for (let giro = 0; giro < 8; giro += 1) {
    const b = await blocco(n);
    ultimo = b;
    const scarto = msVoluto - b.ms;
    if (Math.abs(scarto) <= tolleranzaMs) return b;
    // Il passo si ricalcola sul tempo di blocco OSSERVATO fra l'ancora e qui, non su quello nominale:
    // è la correzione della deriva, e senza di essa trenta giorni sbagliano di ore.
    const passo = b.numero !== ANCORA_BLOCCO
      ? Math.abs((b.ms - ANCORA_MS) / (b.numero - ANCORA_BLOCCO)) || BLOCCO_MS_STIMA
      : BLOCCO_MS_STIMA;
    const delta = Math.round(scarto / passo);
    if (delta === 0) return b;
    n += delta;
    if (n < 1) n = 1;
  }
  return ultimo;
}

/** I Transfer di pUSD USCITI da `mittente` in una finestra di blocchi. */
async function trasferimentiDa(mittente, daBlocco, aBlocco) {
  const topicMittente = '0x' + '0'.repeat(24) + mittente.toLowerCase().replace(/^0x/, '');
  const logs = await rpc('eth_getLogs', [{
    fromBlock: hex(daBlocco), toBlock: hex(aBlocco),
    address: PUSD,
    topics: [TOPIC_TRANSFER, topicMittente],
  }]);
  return (logs || []).map((l) => ({
    blocco: Number(l.blockNumber),
    tx: l.transactionHash,
    a: '0x' + String(l.topics[2]).slice(26).toLowerCase(),
    // pUSD ha 6 decimali.
    usd: Number(BigInt(l.data)) / 1e6,
  }));
}

/**
 * UNA CHIAMATA A ETHERSCAN, con throttle e backoff propri.
 *
 * Il backoff qui serve a due cose diverse e va detto: il 429 è la quota, e si aspetta; ma Etherscan
 * risponde ANCHE `status: "0"` con un messaggio nel corpo e HTTP 200 — un errore travestito da
 * successo. Trattarlo come dato vuoto vorrebbe dire concludere «quel giorno non ci sono pagamenti»
 * su una chiamata che non ha mai risposto. Quindi si distingue: `NOTOK` con «rate limit» si ritenta,
 * `No transactions found` è un risultato legittimo e vale lista vuota.
 */
async function etherscan(params, tentativo = 0) {
  const key = env('POLYGONSCAN_API_KEY');
  if (!key) throw new Error('POLYGONSCAN_API_KEY assente');
  const gap = 1000 / MAX_RPS_SCAN;
  const ora = Date.now();
  if (ora - ultimaScan < gap) await attesa(gap - (ora - ultimaScan));
  ultimaScan = Date.now();
  contatore.chiamate += 1;

  const qs = new URLSearchParams({ chainid: String(CHAIN_ID), apikey: key, ...params }).toString();
  const risposta = await new Promise((res, rej) => {
    const req = https.get(`${ETHERSCAN_BASE}?${qs}`, { timeout: 30_000 }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => res({ status: r.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', rej);
  }).catch((e) => ({ status: 0, body: '', errore: e.message }));

  if (risposta.status === 429 || risposta.status >= 500 || risposta.status === 0) {
    if (tentativo >= 5) { contatore.errori += 1; throw new Error(`etherscan: HTTP ${risposta.status} dopo 6 tentativi`); }
    contatore.ritentate += 1;
    await attesa(Math.min(30_000, 1000 * Math.pow(2, tentativo)));
    return etherscan(params, tentativo + 1);
  }
  let j;
  try { j = JSON.parse(risposta.body); } catch { contatore.errori += 1; throw new Error('etherscan: risposta non JSON'); }
  if (j.status === '0') {
    const msg = String(j.message || '') + ' ' + String(j.result || '');
    if (/no transactions found|no records found/i.test(msg)) return [];   // risultato legittimo
    if (/rate limit|max calls|too many/i.test(msg)) {
      if (tentativo >= 5) { contatore.errori += 1; throw new Error(`etherscan: quota esaurita — ${msg.trim()}`); }
      contatore.ritentate += 1;
      await attesa(Math.min(30_000, 1000 * Math.pow(2, tentativo)));
      return etherscan(params, tentativo + 1);
    }
    contatore.errori += 1;
    throw new Error(`etherscan: ${msg.trim()}`);
  }
  return Array.isArray(j.result) ? j.result : [];
}

/**
 * I trasferimenti ERC-20 USCITI da `mittente` in una finestra di blocchi, dallo STORICO completo.
 * Stessa firma di `trasferimentiDa`, così i chiamanti non cambiano.
 */
async function trasferimentiDaStorico(mittente, daBlocco, aBlocco) {
  // ⚠ SI PAGINA, E NON È FACOLTATIVO. Il piano gratuito restituisce al più 1000 righe per pagina
  // qualunque `offset` si chieda: la prima prova sull'ancora ha dato esattamente 1000 righe su un
  // giorno che ne ha ~2570. Fermarsi lì vorrebbe dire troncare il 60% dei destinatari e non
  // accorgersene, perché 1000 righe sembrano un risultato pieno. Si cicla finché una pagina torna
  // corta, che è l'unico segnale affidabile di «non ce n'è altre».
  const PER_PAGINA = 1000;
  const righe = [];
  for (let pagina = 1; pagina <= 20; pagina += 1) {
    const p = await etherscan({
      module: 'account', action: 'tokentx',
      contractaddress: PUSD, address: mittente,
      startblock: String(daBlocco), endblock: String(aBlocco),
      page: String(pagina), offset: String(PER_PAGINA), sort: 'asc',
    });
    righe.push(...p);
    if (p.length < PER_PAGINA) break;
  }
  return righe
    // `tokentx` restituisce sia le uscite sia le entrate: qui servono le USCITE.
    .filter((r) => String(r.from || '').toLowerCase() === mittente.toLowerCase())
    .map((r) => ({
      blocco: Number(r.blockNumber),
      tx: r.hash,
      a: String(r.to || '').toLowerCase(),
      usd: Number(r.value) / 1e6,
    }));
}

module.exports = {
  rpc, blocco, bloccoAllIstante, trasferimentiDa, trasferimentiDaStorico, etherscan,
  ANCORA_BLOCCO, ANCORA_MS, FINESTRA_BLOCCHI, PUSD, TOPIC_TRANSFER,
  contatore, env,
};

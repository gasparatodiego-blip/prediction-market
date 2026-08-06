'use strict';
// lib/maker/reward-reale.js — IL REWARD CONFERMATO DAL VENUE. SOLA LETTURA, PER COSTRUZIONE.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════════
// Il bot stima quanto sta maturando (`summary.estGrossUsdPerDay`, lib/maker/operator-board.js). Nessuno
// ha mai confrontato quella stima col dato VERO che Polymarket conferma a giornata chiusa. Senza il
// confronto, la stima è una convinzione: può essere fuori di un ordine di grandezza per settimane e
// l'unico modo di accorgersene è guardare il portafoglio.
//
// ═══ QUESTO PERCORSO NON PUÒ PIAZZARE, E NON È UNA PROMESSA — È COME È FATTO ═════════════════════════
// Tre proprietà strutturali, tutte verificabili leggendo questo file, e tutte coperte da un test che
// legge il sorgente:
//
//   1. USA SOLO LE CREDENZIALI L2. `polymarketCancelCredsProvider` restituisce {key, secret,
//      passphrase} — l'autenticazione HMAC delle API. NON restituisce il signer, cioè la chiave
//      privata L1. Un ordine Polymarket è una struct EIP-712 FIRMATA: senza il signer non si può
//      costruire, e questo modulo il signer non lo importa nemmeno. Non è che «non lo usa»: non ce
//      l'ha.
//   2. PARLA SOLO IN GET. L'unica funzione di rete qui sotto è `httpGetFirmato`, e il metodo è la
//      costante 'GET'. Non esiste un ramo POST, PUT o DELETE in questo file.
//   3. NON IMPORTA L'ADAPTER. `lib/venues/polymarket-clob-maker/adapter.js` è l'unico oggetto del
//      progetto che sa mandare un ordine. Qui non compare, quindi non c'è nessun percorso — nemmeno
//      indiretto, nemmeno per errore futuro — da questo file a `postOrder`.
//
// Il confine è quindi leggibile: chi apre questo file vede che può solo chiedere e ricevere.
//
// ═══ COSA RESTITUISCE, E COSA NON INVENTA ════════════════════════════════════════════════════════════
// Il venue può non avere ancora consolidato la giornata quando lo si interroga. In quel caso la
// risposta è `disponibile: false` col motivo — MAI zero. «Non l'ho ancora ricevuto» e «ho guadagnato
// zero» sono due fatti diversi, e confonderli renderebbe il confronto peggio che inutile: farebbe
// sembrare la stima sbagliata del 100% ogni notte in cui il venue è in ritardo.

const https = require('https');
const crypto = require('crypto');
// SOLO LE CREDENZIALI L2. Vedi il punto 1 dell'intestazione: il signer non è importato qui.
const { polymarketCancelCredsProvider } = require('./cancel-creds-provider');

const HOST = 'clob.polymarket.com';
/** L'unico metodo che questo modulo conosce. Non è una variabile: è una costante, e resta tale. */
const METODO_UNICO = 'GET';
const TIMEOUT_MS = 12_000;

/**
 * La firma L2 che il CLOB si aspetta: HMAC-SHA256 base64url di `timestamp + method + path (+ body)`
 * con il secret in base64url. Il body qui è SEMPRE vuoto — è una GET.
 */
function firmaL2({ secret, timestamp, path }) {
  const chiave = Buffer.from(secret, 'base64');
  const messaggio = `${timestamp}${METODO_UNICO}${path}`;
  return crypto.createHmac('sha256', chiave).update(messaggio).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
}

/** Una GET firmata. È l'unica funzione di rete del modulo. */
function httpGetFirmato(path, headers, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: HOST, path, method: METODO_UNICO, headers, timeout: timeoutMs },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}`, body: raw.slice(0, 300) });
          }
          try { resolve({ ok: true, status: 200, data: JSON.parse(raw) }); }
          catch (e) { resolve({ ok: false, status: 200, error: `risposta non JSON: ${e.message}`, body: raw.slice(0, 300) }); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: null, error: `timeout dopo ${timeoutMs}ms` }); });
    req.on('error', (e) => resolve({ ok: false, status: null, error: e.message }));
    req.end();   // nessun body: è una GET
  });
}

/**
 * IL REWARD CONFERMATO PER UNA GIORNATA UTC.
 *
 * @param {object} a
 *   giorno   'YYYY-MM-DD' — la giornata UTC di cui si chiede il consuntivo
 *   deps     iniettabili per i test: { creds, get, now }
 * @returns {{disponibile:boolean, giorno:string, totaleUsd:number|null,
 *            perMercato:Array|null, motivo:string|null, status:number|null}}
 */
async function leggiRewardReale({ giorno, deps = {} } = {}) {
  const no = (motivo, status = null) => ({ disponibile: false, giorno, totaleUsd: null, perMercato: null, motivo, status });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(giorno || ''))) return no('giorno non valido: serve YYYY-MM-DD');

  let creds;
  try { creds = await (deps.creds || polymarketCancelCredsProvider)(); }
  catch (e) { return no(`credenziali non disponibili: ${e.message}`); }
  if (!creds || !creds.creds || !creds.creds.key || !creds.creds.secret || !creds.creds.passphrase || !creds.address) {
    return no('credenziali L2 incomplete: nessuna lettura tentata');
  }

  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const timestamp = Math.floor(now() / 1000).toString();
  const path = `/rewards/user?address=${encodeURIComponent(creds.address)}&date=${encodeURIComponent(giorno)}`;

  const headers = {
    POLY_ADDRESS: creds.address,
    POLY_SIGNATURE: firmaL2({ secret: creds.creds.secret, timestamp, path }),
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: creds.creds.key,
    POLY_PASSPHRASE: creds.creds.passphrase,
    Accept: 'application/json',
    'User-Agent': 'edgeradar-maker/1.0 (rewards read; read-only)',
  };

  const r = await (deps.get || httpGetFirmato)(path, headers);
  if (!r.ok) {
    // NON è zero: è «non l'ho ricevuto». La distinzione è tutto il valore del confronto.
    return no(`lettura non riuscita: ${r.error}`, r.status);
  }

  const estratto = estraiTotale(r.data, giorno);
  if (estratto.totaleUsd == null) {
    return no(estratto.motivo || 'il venue non ha ancora consolidato questa giornata', 200);
  }
  return {
    disponibile: true, giorno, totaleUsd: estratto.totaleUsd,
    perMercato: estratto.perMercato, motivo: null, status: 200,
  };
}

/**
 * Il totale dalla risposta del venue, senza dare per scontata una forma sola.
 * Se nessuna forma nota corrisponde, restituisce null col motivo — non un numero inventato.
 */
function estraiTotale(data, giorno) {
  const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
  if (!data || typeof data !== 'object') return { totaleUsd: null, perMercato: null, motivo: 'risposta vuota' };

  // Forma A: un totale diretto.
  for (const k of ['total', 'total_earnings', 'totalEarnings', 'earnings', 'amount']) {
    const v = num(data[k]);
    if (v != null) return { totaleUsd: +v.toFixed(6), perMercato: null, motivo: null };
  }
  // Forma B: un elenco per mercato/giorno, da sommare.
  const righe = Array.isArray(data) ? data
    : (Array.isArray(data.data) ? data.data : (Array.isArray(data.rewards) ? data.rewards : null));
  if (Array.isArray(righe)) {
    const perGiorno = righe.filter((r) => !r || !r.date || String(r.date).slice(0, 10) === giorno);
    if (!perGiorno.length) return { totaleUsd: null, perMercato: null, motivo: `nessuna riga per ${giorno}` };
    let tot = 0; const per = [];
    for (const r of perGiorno) {
      const v = num(r && (r.earnings ?? r.amount ?? r.total ?? r.rewards));
      if (v == null) continue;
      tot += v;
      per.push({ marketId: (r && (r.condition_id || r.conditionId || r.market)) || null, usd: +v.toFixed(6) });
    }
    if (!per.length) return { totaleUsd: null, perMercato: null, motivo: 'righe presenti ma senza importo leggibile' };
    return { totaleUsd: +tot.toFixed(6), perMercato: per, motivo: null };
  }
  return { totaleUsd: null, perMercato: null, motivo: 'forma della risposta non riconosciuta' };
}

module.exports = { leggiRewardReale, estraiTotale, firmaL2, HOST, METODO_UNICO };

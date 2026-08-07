'use strict';
// lib/maker/saldo-cache.js — IL SALDO DEL FUNDER, LETTO DALLA CATENA E TENUTO IN CACHE.
//
// PERCHE' ESISTE. La Regola 5 (`motore-unico.tettoMercato`) e' il tetto del 20% per mercato, e senza
// `saldoUsd` fallisce chiusa: «saldo non leggibile: nessuna nuova esposizione». Dal 6 agosto 2026 quel
// veto e' l'unica cosa che teneva fermi i rinnovi, perche' agent40 il saldo non lo passava proprio —
// la regola era collegata, i suoi ingressi no (la stessa famiglia di difetto del cablaggio
// `bookLevels`, commit 2346db2).
//
// PERCHE' UNA CACHE E NON UNA LETTURA DIRETTA. Il ciclo di agent40 gira ogni 5 secondi. Una eth_call
// per giro sono 720 chiamate all'ora al nodo RPC pubblico per un numero che si muove solo quando
// depositiamo o preleviamo. La TTL e' 45s: la lettura vera avviene al massimo una volta ogni 45s, il
// ciclo legge dalla cache.
//
// COSA SUCCEDE QUANDO LA CATENA NON RISPONDE. Si tiene l'ULTIMO valore valido con la sua eta'. Oltre
// 3x la TTL (135s) il valore non e' piu' considerato affidabile e la Regola 5 torna fail-closed: un
// saldo vecchio di minuti non deve autorizzare esposizione nuova. Fra «vecchio ma noto» e «ignoto»
// c'e' una differenza, e questi 135 secondi sono dove la si mette.
//
// UNO ZERO LETTO NON E' UN'ASSENZA. `usd: 0` con `affidabile: true` significa «il funder e' vuoto», ed
// e' un fatto: la Regola 5 lo bocciera' con la sua frase (`saldoUsd <= 0`). `usd: null` significa «non
// si e' letto». Le due cose non si confondono mai, qui come in lib/poly-chain-read.ts.
//
// SOLA LETTURA PER COSTRUZIONE. Una eth_call `balanceOf` piu' una `decimals()` su un provider senza
// signer. Nessuna chiave viene caricata, niente puo' essere firmato, spostato o approvato. E' la
// gemella in JS del controllo `balance` di lib/maker/preflight.js — stesso indirizzo (il FUNDER, mai
// l'EOA firmatario vuoto), stesso contratto pUSD, stessa regola «null non e' zero».

/** Ogni quanto si torna sulla catena. Sotto questa eta' il valore in cache si usa senza chiedere. */
const SALDO_CACHE_TTL_MS = 45_000;
/** Oltre TTL x questo moltiplicatore il valore in cache non autorizza piu' niente. */
const ETA_MASSIMA_MULT = 3;

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * La lettura vera: il saldo pUSD del funder, in dollari. `null` = non letto (mai 0 per ripiego).
 * @returns {Promise<{usd:number|null, funder:string|null, motivo:string|null}>}
 */
async function leggiSaldoDallaCatena(env = process.env) {
  let resolveFunder; let PUSD; let DEFAULT_RPC; let JsonRpcProvider; let Contract; let formatUnits;
  try {
    ({ resolveFunder } = require('../venues/polymarket-clob-maker/funder'));
    ({ PUSD, DEFAULT_RPC } = require('../poly-contracts'));
    ({ JsonRpcProvider, Contract, formatUnits } = require('ethers'));
  } catch (e) {
    return { usd: null, funder: null, motivo: `lettore della catena non disponibile: ${e.message}` };
  }
  let funder = null;
  try { funder = resolveFunder(env).funderAddress || null; } catch (e) { return { usd: null, funder: null, motivo: `funder non risolto: ${e.message}` }; }
  if (!funder) return { usd: null, funder: null, motivo: 'nessun indirizzo funder configurato' };

  const provider = new JsonRpcProvider((env && env.POLYGON_RPC_URL) || process.env.POLYGON_RPC_URL || DEFAULT_RPC);
  try {
    const erc20 = new Contract(PUSD, [
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
    ], provider);
    // I decimali sono a loro volta una lettura: senza di essi il saldo non si sa scalare, e un numero
    // scalato per un 6 «presunto» sarebbe un'invenzione con la forma di una misura.
    const decRaw = await erc20.decimals().catch(() => null);
    const dec = decRaw == null ? null : Number(decRaw);
    const balRaw = await erc20.balanceOf(funder).catch(() => null);
    if (balRaw == null || dec == null) {
      return { usd: null, funder, motivo: 'la catena non ha risposto (balanceOf o decimals)' };
    }
    return { usd: Number(formatUnits(balRaw, dec)), funder, motivo: null };
  } catch (e) {
    return { usd: null, funder, motivo: `lettura della catena fallita: ${e.message}` };
  } finally {
    try { provider.destroy(); } catch { /* gia' chiuso */ }
  }
}

/**
 * Una cache indipendente. La si crea per i test (con `leggiCatena` finto e `now` iniettabile); il
 * processo usa la singola istanza condivisa piu' sotto.
 */
function creaCacheSaldo({ leggiCatena = leggiSaldoDallaCatena, ttlMs = SALDO_CACHE_TTL_MS } = {}) {
  let ultimo = null;          // { usd, funder, ts }
  let ultimoErrore = null;    // motivo dell'ultima lettura fallita
  let letture = 0;            // quante volte si e' davvero andati sulla catena
  let inVolo = null;          // deduplica le letture concorrenti: due cicli non aprono due provider

  const scaduta = (now) => !ultimo || (now - ultimo.ts) >= ttlMs;

  function esito(now) {
    if (!ultimo) {
      return {
        usd: null, funder: null, etaMs: null, affidabile: false, fonte: 'nessuna', letture,
        motivo: `saldo mai letto${ultimoErrore ? `: ${ultimoErrore}` : ''}`,
      };
    }
    const etaMs = now - ultimo.ts;
    const limite = ttlMs * ETA_MASSIMA_MULT;
    if (etaMs > limite) {
      return {
        usd: ultimo.usd, funder: ultimo.funder, etaMs, affidabile: false, fonte: 'cache-scaduta', letture,
        motivo: `saldo in cache vecchio di ${Math.round(etaMs / 1000)}s (limite ${Math.round(limite / 1000)}s)`
          + `${ultimoErrore ? ` — la catena non risponde: ${ultimoErrore}` : ''}`
          + ' — un saldo di minuti fa non autorizza esposizione nuova',
      };
    }
    return {
      usd: ultimo.usd, funder: ultimo.funder, etaMs, affidabile: true,
      fonte: etaMs < ttlMs ? 'cache' : 'cache-tollerata', letture,
      motivo: etaMs < ttlMs ? null
        : `lettura fallita (${ultimoErrore || 'motivo ignoto'}): si usa il valore di ${Math.round(etaMs / 1000)}s fa, ancora dentro i ${Math.round(limite / 1000)}s`,
    };
  }

  async function leggi({ now = Date.now(), env = process.env } = {}) {
    if (!scaduta(now)) return esito(now);
    if (!inVolo) {
      inVolo = Promise.resolve()
        .then(() => leggiCatena(env))
        .then((r) => {
          letture += 1;
          if (r && fin(r.usd)) { ultimo = { usd: r.usd, funder: r.funder || null, ts: now }; ultimoErrore = null; }
          else ultimoErrore = (r && r.motivo) || 'lettura senza valore';
        })
        .catch((e) => { letture += 1; ultimoErrore = e && e.message ? e.message : String(e); })
        .finally(() => { inVolo = null; });
    }
    await inVolo;
    return esito(now);
  }

  return {
    leggi,
    /** Solo per i test e per la diagnosi: lo stato grezzo, senza toccare la catena. */
    stato: () => ({ ultimo: ultimo ? { ...ultimo } : null, ultimoErrore, letture }),
    azzera: () => { ultimo = null; ultimoErrore = null; letture = 0; inVolo = null; },
  };
}

const condivisa = creaCacheSaldo();

/**
 * Il saldo pUSD del funder, dalla cache condivisa del processo.
 * @returns {Promise<{usd:number|null, funder:string|null, etaMs:number|null, affidabile:boolean,
 *                    fonte:string, letture:number, motivo:string|null}>}
 *   `affidabile:false` ⇒ la Regola 5 deve ricevere `null`, non questo numero.
 */
async function leggiSaldoUsd(opts = {}) { return condivisa.leggi(opts); }

module.exports = {
  leggiSaldoUsd, creaCacheSaldo, leggiSaldoDallaCatena,
  statoCacheSaldo: () => condivisa.stato(),
  azzeraCacheSaldo: () => condivisa.azzera(),
  SALDO_CACHE_TTL_MS, ETA_MASSIMA_MULT,
};

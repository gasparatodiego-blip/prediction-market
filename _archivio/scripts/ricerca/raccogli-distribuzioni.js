'use strict';

/**
 * RACCOLTA DELLE DISTRIBUZIONI DI LIQUIDITY REWARD — sola lettura, nessuna chiave privata.
 *
 * Polymarket paga i reward ogni giorno intorno a mezzanotte UTC via Disperse.app su Polygon. La fonte
 * giusta non è il log di un contratto ma i **trasferimenti token in uscita dall'EOA distributore**.
 *
 * ═══ FONTE E LIMITI, MISURATI IN QUESTA SESSIONE ═══════════════════════════════════════════════
 *   · API: **Etherscan V2 multichain**, `chainid=137`. ⚠ `api.polygonscan.com` (v1) è DISMESSO e
 *     risponde HTML — verificato, non ipotizzato.
 *   · ⚠ **DUE TRONCAMENTI, ed è il motivo per cui questo script partiziona per blocchi.** Il piano
 *     gratuito tronca la pagina a **1.000 righe** anche chiedendone di più, e limita la finestra a
 *     **10.000 righe per query** (`page × offset ≤ 10.000`). Con ~2.500 destinatari al giorno una
 *     query sola copre appena quattro giorni: chi non se ne accorge scambia una pagina troncata per
 *     l'ultima e conclude che i giorni prima «non esistono». È successo ai primi due giri di questo
 *     script, ed è la ragione di questo commento.
 *   · La cura: una query **per giorno**, delimitata da `startblock`/`endblock` ricavati da
 *     `getblocknobytime`. Ogni giorno è indipendente, quindi un giorno che fallisce è un buco
 *     dichiarato e non contamina gli altri.
 *   · Rate limit del piano gratuito: 5 chiamate/s. Qui una ogni 250 ms, e su un rifiuto si RALLENTA.
 *
 * Non tocca il bot, non legge chiavi private, non scrive fuori da `data/ricerca/`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'ricerca', 'distribuzioni-reward');
const DISTRIBUTORE = '0x2c2795EA295d5Eb51F9121B728eD2eA4e936a709'.toLowerCase();
const GIORNI = Number(process.argv[2] || 30);
const PAUSA_MS = 250;

for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const KEY = process.env.POLYGONSCAN_API_KEY;
if (!KEY) { console.error('POLYGONSCAN_API_KEY assente: non si procede.'); process.exit(1); }

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));
let chiamate = 0; let limitato = 0;

async function api(params, tentativo = 0) {
  const url = `https://api.etherscan.io/v2/api?chainid=137&${params}&apikey=${KEY}`;
  chiamate++;
  let j;
  try { const r = await fetch(url); j = await r.json(); }
  catch (e) {
    if (tentativo >= 4) throw e;
    await attesa(1000 * (tentativo + 1));
    return api(params, tentativo + 1);
  }
  const msg = String((j && j.message) || '');
  const res = j && j.result;
  if (/rate limit|Max .* rate/i.test(msg) || (typeof res === 'string' && /rate limit/i.test(res))) {
    limitato++;
    if (tentativo >= 6) throw new Error('rate limit persistente');
    await attesa(1500 * (tentativo + 1));
    return api(params, tentativo + 1);
  }
  return j;
}

/** Il numero di blocco al confine del giorno. `getblocknobytime` è esatto, non si stima da 2 s/blocco. */
async function bloccoA(tsSec) {
  const j = await api(`module=block&action=getblocknobytime&timestamp=${tsSec}&closest=before`);
  const n = Number(j && j.result);
  return Number.isFinite(n) ? n : null;
}

(async () => {
  const t0 = Date.now();
  const oggi = new Date(); oggi.setUTCHours(0, 0, 0, 0);
  const giorniIso = [];
  for (let i = GIORNI; i >= 0; i--) {
    giorniIso.push(new Date(oggi.getTime() - i * 86400_000).toISOString().slice(0, 10));
  }

  console.log(`raccolta da ${DISTRIBUTORE} · ${giorniIso.length} giorni (${giorniIso[0]} → ${giorniIso[giorniIso.length - 1]})`);
  console.log('fonte: Etherscan V2 multichain (chainid=137), tokentx partizionato per blocchi\n');

  fs.mkdirSync(OUT, { recursive: true });
  const riepilogo = []; const buchi = []; const errori = [];

  for (const g of giorniIso) {
    const inizioSec = Math.floor(Date.parse(`${g}T00:00:00Z`) / 1000);
    const fineSec = inizioSec + 86400 - 1;
    let da; let a;
    try {
      da = await bloccoA(inizioSec); await attesa(PAUSA_MS);
      a = await bloccoA(fineSec); await attesa(PAUSA_MS);
    } catch (e) { errori.push({ giorno: g, motivo: `blocchi: ${e.message}` }); buchi.push(g); continue; }
    if (da === null || a === null) { errori.push({ giorno: g, motivo: 'confini di blocco non risolti' }); buchi.push(g); continue; }

    const righe = []; const hash = new Set();
    let troncato = false;
    try {
      for (let page = 1; page <= 10; page++) {
        const j = await api(`module=account&action=tokentx&address=${DISTRIBUTORE}`
          + `&startblock=${da}&endblock=${a}&page=${page}&offset=1000&sort=asc`);
        const r = Array.isArray(j.result) ? j.result : [];
        for (const t of r) {
          if (String(t.from).toLowerCase() !== DISTRIBUTORE) continue;
          hash.add(t.hash);
          righe.push({ a: String(t.to).toLowerCase(), usd: Number(t.value) / 10 ** (Number(t.tokenDecimal) || 6) });
        }
        if (r.length < 1000) break;
        // ⚠ Il tetto delle 10.000 righe per query vale anche qui: se un giorno lo raggiungesse, il
        // giorno sarebbe INCOMPLETO e va dichiarato tale invece di sembrare finito.
        if (page === 10) troncato = true;
        await attesa(PAUSA_MS);
      }
    } catch (e) { errori.push({ giorno: g, motivo: `tokentx: ${e.message}` }); buchi.push(g); continue; }

    if (!righe.length) { buchi.push(g); console.log(`  ${g}  nessuna distribuzione`); continue; }

    const totale = righe.reduce((s, r) => s + r.usd, 0);
    fs.writeFileSync(path.join(OUT, `${g}.json`), JSON.stringify({
      giorno: g, bloccoDa: da, bloccoA: a, tx: [...hash],
      totaleUsd: +totale.toFixed(6), destinatari: righe.length, troncato, righe,
    }));
    riepilogo.push({ giorno: g, totaleUsd: +totale.toFixed(2), destinatari: righe.length, tx: hash.size, troncato });
    console.log(`  ${g}  $${totale.toFixed(2).padStart(10)}  ${String(righe.length).padStart(5)} destinatari  ${hash.size} tx${troncato ? '  ⚠ TRONCATO' : ''}`);
    await attesa(PAUSA_MS);
  }

  const meta = {
    generatoIso: new Date().toISOString(), distributore: DISTRIBUTORE,
    fonte: 'Etherscan V2 multichain (chainid=137), action=tokentx partizionato per blocchi giornalieri',
    limitiDichiarati: {
      paginaTroncataA: 1000, finestraMassimaPerQuery: 10000,
      nota: 'v1 api.polygonscan.com dismesso; partizione per blocchi necessaria oltre i 4 giorni',
    },
    giorniRichiesti: giorniIso.length,
    giorniConDistribuzione: riepilogo.length,
    giorniSenzaDistribuzione: buchi,
    errori,
    giorniTroncati: riepilogo.filter((r) => r.troncato).map((r) => r.giorno),
    totaleDistribuitoUsd: +riepilogo.reduce((s, r) => s + r.totaleUsd, 0).toFixed(2),
    chiamateApi: chiamate, volteRallentatoPerRateLimit: limitato,
    durataSec: +((Date.now() - t0) / 1000).toFixed(1),
    riepilogo,
  };
  fs.writeFileSync(path.join(OUT, '_meta.json'), JSON.stringify(meta, null, 1));
  console.log(`\ngiorni con distribuzione: ${riepilogo.length}/${giorniIso.length} · buchi: ${buchi.length}`);
  console.log(`totale: $${meta.totaleDistribuitoUsd} · chiamate ${chiamate} · rallentamenti ${limitato} · ${meta.durataSec}s`);
})();

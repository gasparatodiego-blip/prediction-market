'use strict';
/**
 * scripts/ricerca/band-exit-dentro-banda-vera.js — SOLA LETTURA.
 *
 * Dei band-exit registrati, quanti erano ordini ancora DENTRO la banda vera
 * (±max_spread) e sono usciti solo perché il bot misura ±max_spread/2?
 *
 * I record di `auto-reprice-band-exit` portano observed.distanceC e
 * observed.bandRadiusC: bandRadiusC È maxSpread/2, quindi maxSpread = 2×bandRadiusC.
 * Non si ricostruisce niente: sono i due numeri che il bot ha scritto al momento.
 *
 * Lettura in STREAMING riga per riga: i giornali stanno fra 300 e 800 MB e
 * readFileSync costruirebbe una stringa oltre il limite di V8 (§4.10).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA = path.join(__dirname, '..', '..', 'data');
const OUT = path.join(DATA, 'ricerca', 'band-exit-dentro-banda-vera.json');

const FILES = fs.readdirSync(DATA)
  .filter(f => /^polymarket-maker-audit.*\.jsonl$/.test(f))
  .map(f => path.join(DATA, f));

function S(s, v) { if (!(v > 0) || s >= v) return 0; const r = (v - s) / v; return r * r; }

(async () => {
  const eventi = [];
  const perOutcome = new Map();
  let righeLette = 0;

  for (const f of FILES) {
    process.stderr.write(`  leggo ${path.basename(f)}\n`);
    const rl = readline.createInterface({ input: fs.createReadStream(f, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
    for await (const line of rl) {
      righeLette++;
      if (line.indexOf('band-exit') === -1) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.source !== 'auto-reprice-band-exit') continue;
      const o = r.observed || {};
      perOutcome.set(r.outcome, (perOutcome.get(r.outcome) || 0) + 1);
      const d = Number(o.distanceC), rad = Number(o.bandRadiusC);
      if (!Number.isFinite(d) || !Number.isFinite(rad) || !(rad > 0)) continue;
      eventi.push({ ts: r.ts, marketRef: r.marketRef, orderId: r.orderId, outcome: r.outcome,
                    distC: d, raggioStretto: rad, maxSpread: rad * 2 });
    }
    rl.close();
  }

  // Un ordine è "uscito per niente" se stava fuori dalla banda stretta ma dentro
  // quella vera: il venue lo pagava ancora, il bot lo ha dichiarato morto.
  const conMisura = eventi.filter(e => e.distC > e.raggioStretto + 1e-9);
  const dentroVera = conMisura.filter(e => e.distC < e.maxSpread - 1e-9);
  const fuoriVera  = conMisura.filter(e => e.distC >= e.maxSpread - 1e-9);

  // Quanto punteggio avrebbero maturato, per share, con v corretto.
  const sResidui = dentroVera.map(e => S(e.distC, e.maxSpread)).sort((a, b) => a - b);
  const q = p => sResidui.length ? sResidui[Math.min(sResidui.length - 1, Math.floor(sResidui.length * p))] : null;

  // Distribuzione della distanza in unità di banda vera.
  const isto = new Map();
  for (const e of conMisura) {
    const k = Math.min(20, Math.floor((e.distC / e.maxSpread) * 10));
    isto.set(k, (isto.get(k) || 0) + 1);
  }

  const ordiniDistinti = new Set(dentroVera.map(e => e.orderId)).size;
  const mercatiDistinti = new Set(dentroVera.map(e => e.marketRef)).size;
  const ts = eventi.map(e => e.ts).filter(Boolean).sort((a, b) => a - b);

  const res = {
    generatoAl: new Date().toISOString(),
    righeLette, fileLetti: FILES.map(f => path.basename(f)),
    finestra: ts.length ? { da: new Date(ts[0]).toISOString(), a: new Date(ts[ts.length - 1]).toISOString() } : null,
    eventiBandExit: eventi.length,
    perOutcome: [...perOutcome.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ outcome: k, n: v })),
    conMisuraDistanza: conMisura.length,
    fuoriBandaStretta: conMisura.length,
    ancoraDentroBandaVera: dentroVera.length,
    fuoriAncheDallaBandaVera: fuoriVera.length,
    quotaSalvabile: conMisura.length ? +(dentroVera.length / conMisura.length * 100).toFixed(1) : null,
    ordiniDistintiSalvabili: ordiniDistinti,
    mercatiDistintiSalvabili: mercatiDistinti,
    punteggioResiduoConVCorretto: {
      nota: 'S=((v−s)/v)² con v = maxSpread: quanto MATURAVA ancora l\'ordine che abbiamo cancellato',
      mediana: q(0.5), q25: q(0.25), q75: q(0.75), q90: q(0.9),
      media: sResidui.length ? +(sResidui.reduce((a, b) => a + b, 0) / sResidui.length).toFixed(4) : null,
    },
    istogrammaDistanzaSuBandaVera: [...isto.entries()].sort((a, b) => a[0] - b[0])
      .map(([k, v]) => ({ da: +(k / 10).toFixed(1), a: +((k + 1) / 10).toFixed(1), n: v })),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1));

  console.log(`righe lette: ${righeLette.toLocaleString('it')}`);
  console.log(`finestra: ${res.finestra ? res.finestra.da + ' → ' + res.finestra.a : 'n/d'}`);
  console.log(`\neventi band-exit: ${res.eventiBandExit}`);
  console.log('per outcome:');
  for (const o of res.perOutcome) console.log(`   ${String(o.n).padStart(6)}  ${o.outcome}`);
  console.log(`\ncon distanza misurata e OLTRE la banda stretta: ${res.conMisuraDistanza}`);
  console.log(`  di cui ANCORA DENTRO la banda vera (±maxSpread): ${res.ancoraDentroBandaVera}  (${res.quotaSalvabile}%)`);
  console.log(`  di cui fuori anche dalla banda vera:             ${res.fuoriAncheDallaBandaVera}`);
  console.log(`  ordini distinti coinvolti: ${res.ordiniDistintiSalvabili} su ${res.mercatiDistintiSalvabili} mercati`);
  console.log(`\npunteggio S che quegli ordini maturavano ancora (v corretto):`);
  const p = res.punteggioResiduoConVCorretto;
  console.log(`   mediana ${p.mediana}  q25 ${p.q25}  q75 ${p.q75}  q90 ${p.q90}  media ${p.media}`);
  console.log('\ndistanza / banda vera:');
  for (const b of res.istogrammaDistanzaSuBandaVera) console.log(`   ${b.da.toFixed(1)}-${b.a.toFixed(1)}  ${b.n}`);
  console.log(`\nscritto in ${OUT}`);
})();

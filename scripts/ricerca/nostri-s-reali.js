'use strict';
/**
 * scripts/ricerca/nostri-s-reali.js — SOLA LETTURA.
 *
 * Rifà il conto di §5-bis p.152 con la lettura corretta di v.
 *
 * p.152 cita la definizione ufficiale giusta («v = max spread dal mid in centesimi»)
 * e poi usa v = 2,25¢ su mercati con maxSpread 4,5¢, cioè la semiampiezza dimezzata.
 * Tutte le S di quella tabella sono quindi calcolate con la banda sbagliata.
 *
 * ⚠ NON cambia quanto abbiamo incassato: il venue ha sempre pagato con v = maxSpread.
 * Cambia quanto CREDEVAMO di incassare, e quindi le leve che ne sono state dedotte.
 *
 * Fonte: observed.distanceC e observed.bandRadiusC dei record `auto-reprice`, cioè
 * gli stessi due numeri che il bot ha scritto a ogni valutazione. maxSpread =
 * 2 × bandRadiusC. Lettura in streaming (§4.10).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA = path.join(__dirname, '..', '..', 'data');
const OUT = path.join(DATA, 'ricerca', 'nostri-s-reali.json');
const FILES = fs.readdirSync(DATA)
  .filter(f => /^polymarket-maker-audit.*\.jsonl$/.test(f))
  .map(f => path.join(DATA, f));

const S = (s, v) => (!(v > 0) || s >= v) ? 0 : ((v - s) / v) ** 2;

(async () => {
  // chiave: distC arrotondata a 0,05¢ + raggio ⇒ conteggio. Tiene la memoria bassa.
  const conteggi = new Map();
  let righe = 0, campioni = 0;

  for (const f of FILES) {
    process.stderr.write(`  ${path.basename(f)}\n`);
    const rl = readline.createInterface({ input: fs.createReadStream(f, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
    for await (const line of rl) {
      righe++;
      if (line.indexOf('distanceC') === -1) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const o = r.observed;
      if (!o) continue;
      const d = Number(o.distanceC), rad = Number(o.bandRadiusC);
      if (!Number.isFinite(d) || !Number.isFinite(rad) || !(rad > 0) || d < 0) continue;
      const k = `${Math.round(d * 20) / 20}|${rad}`;
      conteggi.set(k, (conteggi.get(k) || 0) + 1);
      campioni++;
    }
    rl.close();
  }

  // Le due letture, sugli stessi identici s.
  let sommaStretta = 0, sommaVera = 0, dentroStretta = 0, dentroVera = 0;
  const fasce = new Map();   // fascia s/v secondo la lettura STRETTA (per confronto con p.152)
  const oss = [];
  for (const [k, n] of conteggi) {
    const [ds, rs] = k.split('|');
    const d = +ds, raggio = +rs, vVera = raggio * 2;
    const sStretta = S(d, raggio), sVera = S(d, vVera);
    sommaStretta += sStretta * n; sommaVera += sVera * n;
    if (d < raggio) dentroStretta += n;
    if (d < vVera) dentroVera += n;
    const r = d / raggio;
    const f = r >= 1 ? 'oltre 100% (fuori dalla banda stretta)'
      : r < 0.2 ? '0-20%' : r < 0.4 ? '20-40%' : r < 0.6 ? '40-60%' : r < 0.8 ? '60-80%' : '80-100%';
    if (!fasce.has(f)) fasce.set(f, { n: 0, sStretta: 0, sVera: 0 });
    const b = fasce.get(f); b.n += n; b.sStretta += sStretta * n; b.sVera += sVera * n;
    oss.push({ d, raggio, n });
  }

  const ordine = ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%', 'oltre 100% (fuori dalla banda stretta)'];
  const tabella = ordine.filter(f => fasce.has(f)).map(f => {
    const b = fasce.get(f);
    return { fascia: f, osservazioni: b.n, quotaPct: +(b.n / campioni * 100).toFixed(1),
             sMedioLetturaStretta: +(b.sStretta / b.n).toFixed(4),
             sMedioLetturaVera: +(b.sVera / b.n).toFixed(4) };
  });

  // La leva ② di p.152: spostare la coda 80-100% nella fascia 20-40%. Quanto vale
  // davvero, con la banda giusta?
  const coda = fasce.get('80-100%');
  const bersaglio = fasce.get('20-40%');
  let levaVera = null, levaStretta = null;
  if (coda && bersaglio) {
    const sBersaglioVero = bersaglio.sVera / bersaglio.n;
    const sBersaglioStretto = bersaglio.sStretta / bersaglio.n;
    const nuovoVero = (sommaVera - coda.sVera + coda.n * sBersaglioVero) / campioni;
    const nuovoStretto = (sommaStretta - coda.sStretta + coda.n * sBersaglioStretto) / campioni;
    levaVera = { da: +(sommaVera / campioni).toFixed(4), a: +nuovoVero.toFixed(4),
                 guadagnoPct: +((nuovoVero / (sommaVera / campioni) - 1) * 100).toFixed(1) };
    levaStretta = { da: +(sommaStretta / campioni).toFixed(4), a: +nuovoStretto.toFixed(4),
                    guadagnoPct: +((nuovoStretto / (sommaStretta / campioni) - 1) * 100).toFixed(1) };
  }

  const res = {
    generatoAl: new Date().toISOString(),
    righeLette: righe, osservazioni: campioni,
    raggiOsservati: [...new Set(oss.map(o => o.raggio))].sort((a, b) => a - b),
    sMedio: { letturaStretta: +(sommaStretta / campioni).toFixed(4), letturaVera: +(sommaVera / campioni).toFixed(4) },
    rapporto: +((sommaVera / sommaStretta)).toFixed(3),
    ordiniGiudicatiFuoriBanda: { letturaStretta: campioni - dentroStretta, letturaVera: campioni - dentroVera },
    tabella,
    levaCodaAlBordo: { conLetturaStretta: levaStretta, conLetturaVera: levaVera },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1));

  console.log(`righe lette ${righe.toLocaleString('it')} · osservazioni con distanza e banda: ${campioni.toLocaleString('it')}`);
  console.log(`raggi di banda osservati (¢): ${res.raggiOsservati.join(', ')}  ⇒ maxSpread = il doppio`);
  console.log('\nfascia s/v (secondo la lettura STRETTA, come in §5-bis p.152)');
  console.log('  fascia                  oss.     quota   S medio (stretta)   S medio (VERA)');
  for (const t of res.tabella) {
    console.log(`  ${t.fascia.padEnd(22)} ${String(t.osservazioni).padStart(7)}  ${String(t.quotaPct).padStart(6)}%  ${String(t.sMedioLetturaStretta).padStart(15)}  ${String(t.sMedioLetturaVera).padStart(15)}`);
  }
  console.log(`\nS MEDIO sui nostri ordini reali:`);
  console.log(`  come lo calcola il bot (v = maxSpread/2): ${res.sMedio.letturaStretta}`);
  console.log(`  come lo paga il venue  (v = maxSpread):   ${res.sMedio.letturaVera}   ⇒ ${res.rapporto}× di quanto crediamo`);
  console.log(`\nordini che il bot dichiara FUORI BANDA: ${res.ordiniGiudicatiFuoriBanda.letturaStretta}`);
  console.log(`ordini davvero fuori dalla banda vera:  ${res.ordiniGiudicatiFuoriBanda.letturaVera}`);
  console.log(`\nla leva ② di p.152 (spostare la coda al bordo nella fascia 20-40%):`);
  console.log(`  come la calcolava p.152 (banda stretta): ${JSON.stringify(res.levaCodaAlBordo.conLetturaStretta)}`);
  console.log(`  con la banda VERA:                       ${JSON.stringify(res.levaCodaAlBordo.conLetturaVera)}`);
  console.log(`\nscritto in ${OUT}`);
})();

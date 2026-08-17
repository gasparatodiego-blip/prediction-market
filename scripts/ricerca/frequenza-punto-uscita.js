#!/usr/bin/env node
'use strict';
/**
 * QUANTO SPESSO IL CICLO PASSA DAL PUNTO CHE STO PER TOCCARE — sola lettura.
 *
 * LA REGOLA CHE QUESTO SCRIPT SERVE (operatore, 16 agosto 2026): «prima di toccare un ciclo vivo,
 * misura quanto spesso quel ciclo passa dal punto che tocchi». Le quattro regressioni del 16 agosto
 * sono arrivate tutte da modifiche fatte senza questa misura — in particolare la chiamata a
 * `controlloCapitaleFermo` messa su un ramo che scattava a ogni giro scoperto: 799 ricostruzioni del
 * piano consecutive, perche' la FREQUENZA DEL CICLO era diventata la frequenza dell'azione.
 *
 * COSA CONTA, e perche' proprio questi punti: sono i rami di `auto-close` che una regola di
 * take-profit dovrebbe attraversare.
 *   · `merge-livello-*`        — la gerarchia di uscita, cioe' il cuore del ciclo;
 *   · `already-covered`        — c'e' gia' un'uscita a riposo: e' QUI che un take-profit dovrebbe
 *                                rivalutare il prezzo, ed e' il ramo che il 16 agosto ritornava
 *                                prima di ricalcolare (§5-bis p.138);
 *   · `uscita-da-abbassare`    — il riprezzo verso il basso, aggiunto il 16 agosto;
 *   · `skip-no-target`         — `planExit` ha rifiutato di produrre un'uscita.
 *
 * Conta anche gli INTERVALLI fra due passaggi consecutivi, non solo il totale: «600 volte in due
 * giorni» e «600 volte in venti minuti» sono lo stesso numero e due rischi diversi.
 *
 * Scrive in data/ricerca/ e niente altro.
 *
 * Uso:  node scripts/ricerca/frequenza-punto-uscita.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'ricerca', 'frequenza-punto-uscita.json');

const q = (v, p) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null);
const sec = (ms) => (ms == null ? null : Math.round(ms / 100) / 10);

(async () => {
  const perEsito = new Map();     // outcome → { n, tsPrimo, tsUltimo, perMercato:Map, ts:[] }
  let righe = 0, autoClose = 0, tsMin = null, tsMax = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(DATA, 'polymarket-maker-audit.jsonl')),
    crlfDelay: Infinity,
  });
  for await (const riga of rl) {
    righe++;
    let o; try { o = JSON.parse(riga); } catch { continue; }
    if (!Number.isFinite(o.ts)) continue;
    if (tsMin == null || o.ts < tsMin) tsMin = o.ts;
    if (tsMax == null || o.ts > tsMax) tsMax = o.ts;
    if (o.op !== 'auto-close') continue;
    autoClose++;
    const k = o.outcome || '(senza esito)';
    if (!perEsito.has(k)) perEsito.set(k, { n: 0, perMercato: new Map(), ts: [] });
    const e = perEsito.get(k);
    e.n++; e.ts.push(o.ts);
    const m = o.marketRef || '(ignoto)';
    e.perMercato.set(m, (e.perMercato.get(m) || 0) + 1);
  }

  const durataOre = tsMin != null ? (tsMax - tsMin) / 3_600_000 : null;
  const righeOut = [];
  for (const [esito, e] of perEsito) {
    e.ts.sort((a, b) => a - b);
    const gap = [];
    for (let i = 1; i < e.ts.length; i++) gap.push(e.ts[i] - e.ts[i - 1]);
    gap.sort((a, b) => a - b);
    righeOut.push({
      esito, n: e.n,
      mercatiDistinti: e.perMercato.size,
      alOra: durataOre ? +(e.n / durataOre).toFixed(2) : null,
      intervalloSecMediana: sec(q(gap, 0.5)),
      intervalloSecQ10: sec(q(gap, 0.1)),
      intervalloSecQ90: sec(q(gap, 0.9)),
      intervalloSecMin: sec(gap[0]),
      primo: new Date(e.ts[0]).toISOString(),
      ultimo: new Date(e.ts[e.ts.length - 1]).toISOString(),
    });
  }
  righeOut.sort((a, b) => b.n - a.n);

  const referto = {
    generatoIl: new Date().toISOString(),
    giornale: 'data/polymarket-maker-audit.jsonl',
    righeLette: righe, recordAutoClose: autoClose,
    finestra: { da: new Date(tsMin).toISOString(), a: new Date(tsMax).toISOString(), ore: +durataOre.toFixed(1) },
    esiti: righeOut,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(referto, null, 1));

  console.log(`finestra ${referto.finestra.da.slice(0, 16)} → ${referto.finestra.a.slice(0, 16)} (${referto.finestra.ore} h)`);
  console.log(`${righe} righe · ${autoClose} record auto-close\n`);
  console.log('esito'.padEnd(52) + 'n'.padStart(7) + 'mkt'.padStart(5) + '/ora'.padStart(9)
    + 'gap q10'.padStart(10) + 'mediana'.padStart(10) + 'q90'.padStart(10));
  console.log('-'.repeat(103));
  for (const r of righeOut) {
    console.log(r.esito.slice(0, 51).padEnd(52) + String(r.n).padStart(7) + String(r.mercatiDistinti).padStart(5)
      + String(r.alOra).padStart(9) + String(r.intervalloSecQ10 ?? '—').padStart(10)
      + String(r.intervalloSecMediana ?? '—').padStart(10) + String(r.intervalloSecQ90 ?? '—').padStart(10));
  }
  console.log(`\nscritto ${path.relative(ROOT, OUT)}  (intervalli in secondi)`);
})();

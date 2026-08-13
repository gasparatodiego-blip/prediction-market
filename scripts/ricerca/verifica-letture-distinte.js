'use strict';

/**
 * VERIFICA RETROATTIVA DELLA CONDIZIONE «LETTURE DISTINTE» — sola lettura.
 *
 * Rigioca i tre scatti storici con le funzioni VERE (`decidiScatto` + `confermaScatto`) e conta quanti
 * sarebbero avvenuti. La domanda è: la seconda lettura veniva da una voce di cache NUOVA, o era una
 * copia della prima?
 *
 * ⚠ COME SI RICOSTRUISCE L'ISTANTE DELLA LETTURA SUI DATI STORICI. Il log di agent43 NON registra
 * `etaMs`: quel campo è entrato nel verdetto solo oggi. Quello che il log dà è il VALORE del totale a
 * ogni giro, e su quello si può decidere con una regola esplicita e conservativa:
 *
 *     due letture consecutive con lo STESSO totale al centesimo vengono dalla stessa voce di cache.
 *
 * È conservativa nella direzione giusta: se per caso due letture indipendenti avessero prodotto lo
 * stesso identico numero, la regola le tratterebbe come una sola e conterebbe uno scatto in MENO —
 * cioè non può far sembrare la correzione migliore di quello che è. Il caso opposto (due voci diverse
 * con valori diversi) è riconosciuto correttamente.
 *
 * ⚠ E IL LIMITE VA DETTO: dopo un latch il guardiano smette di misurare, quindi «lo scatto sparisce»
 * qui significa «non sarebbe scattato IN QUELL'ISTANTE». Che poi non sarebbe scattato affatto lo
 * dicono le misure INTORNO, riportate in fondo.
 */

const fs = require('fs');
const path = require('path');
const { decidiScatto, confermaScatto, LETTURE_CONSECUTIVE_PER_SCATTO } = require('../../lib/maker/guardian-perdite');

const LOG = '/root/.pm2/logs/agent43-guardian-out.log';
const SOGLIA_PCT = 5;
const SOGLIA_ABS = 30;

// ── Le letture dal log: valore, percentuale, totale. Il totale è l'impronta della voce di cache. ──
// ⚠ SI ESTRAGGONO I PEZZI SEPARATAMENTE, non con una regex sola. La prima stesura di questo script ne
// usava una monolitica e ha sbagliato due volte in modo silenzioso: prendeva la BASELINE al posto del
// totale (gruppo sbagliato), e perdeva del tutto lo scatto delle 11:24 perché quella riga porta solo
// la soglia assoluta e non la percentuale, che la regex pretendeva. Una riga persa in una verifica
// retroattiva è peggio di un errore: è una conclusione tranquillizzante costruita su meno dati.
const RE_TS = /^(\S+Z) \[agent43-guardian\] /;
// ⚠ `[\d.]+` CATTURA ANCHE IL PUNTO FINALE della frase: `$627.98.` diventa `Number('627.98.')` = NaN,
// e un NaN qui non fa fallire niente — fa solo sbagliare il confronto in silenzio, che è peggio.
// Si scrive quindi la forma esatta di un numero: cifre, poi al piu' un punto e altre cifre.
const RE_PNL_OK = /PnL ([+-][\d.]+) USD \(([+-][\d.]+)%\) · baseline \$(\d+(?:\.\d+)?) → \$(\d+(?:\.\d+)?)/;
const RE_BASE_ADESSO = /Baseline \$(\d+(?:\.\d+)?) → adesso \$(\d+(?:\.\d+)?)/;
const RE_ABS = /\(([+-][\d.]+)USD ≤/;
const RE_PCT = /\(([+-][\d.]+)% ≤/;

const letture = [];
for (const l of fs.readFileSync(LOG, 'utf8').split('\n')) {
  const t = RE_TS.exec(l);
  if (!t) continue;
  const ts = Date.parse(t[1]);
  const ok = RE_PNL_OK.exec(l);
  if (ok) { letture.push({ ts, pnlUsd: Number(ok[1]), pnlPct: Number(ok[2]), totale: Number(ok[4]), scattoReale: false }); continue; }
  const ba = RE_BASE_ADESSO.exec(l);
  if (!ba) continue;
  const abs = RE_ABS.exec(l);
  const pct = RE_PCT.exec(l);
  const baseline = Number(ba[1]);
  const totale = Number(ba[2]);
  // Se la riga non dichiara il valore assoluto (perché ha superato solo la percentuale) lo si deriva
  // dai due numeri che ci sono: totale − baseline. È la stessa aritmetica del guardiano.
  const pnlUsd = abs ? Number(abs[1]) : +(totale - baseline).toFixed(6);
  const pnlPct = pct ? Number(pct[1]) : +(((totale - baseline) / baseline) * 100).toFixed(6);
  letture.push({ ts, pnlUsd, pnlPct, totale, scattoReale: /SCATTO:/.test(l) });
}
letture.sort((a, b) => a.ts - b.ts);

/**
 * L'istante della voce di cache, ricostruito: cambia quando cambia il totale. Si usa il ts della prima
 * lettura che ha mostrato quel totale, che è esattamente «quando quella voce è comparsa».
 */
let ultimoTotale = null; let letturaAtCorrente = null;
for (const l of letture) {
  if (ultimoTotale === null || Math.abs(l.totale - ultimoTotale) > 0.004) {
    ultimoTotale = l.totale; letturaAtCorrente = l.ts;
  }
  l.letturaAt = letturaAtCorrente;
}

function rigioca({ conDistinte }) {
  let stato = null;
  const scatti = [];
  for (const l of letture) {
    const pnl = { calcolabile: true, pnlUsd: l.pnlUsd, pnlPct: l.pnlPct, motivo: null };
    const dec = decidiScatto({ pnl, sogliaPct: SOGLIA_PCT, sogliaAbs: SOGLIA_ABS });
    // Con `conDistinte:false` si simula il comportamento del 13 agosto mattina: ogni lettura conta,
    // perché l'istante veniva passato sempre nuovo (cioè: non veniva guardato affatto).
    const oss = { saldoLetturaAt: conDistinte ? l.letturaAt : l.ts };
    const c = confermaScatto({ stato, decisione: dec, pnl, now: l.ts, k: LETTURE_CONSECUTIVE_PER_SCATTO, osservazione: oss });
    stato = c.stato;
    if (c.scatta) { scatti.push({ iso: new Date(l.ts).toISOString(), pnlUsd: l.pnlUsd, conferme: c.conferme }); stato = null; }
  }
  return scatti;
}

const senza = rigioca({ conDistinte: false });
const con = rigioca({ conDistinte: true });
const reali = letture.filter((l) => l.scattoReale).map((l) => new Date(l.ts).toISOString());

console.log(`letture rigiocate: ${letture.length}`);
console.log(`finestra: ${new Date(letture[0].ts).toISOString()} → ${new Date(letture[letture.length - 1].ts).toISOString()}\n`);
console.log(`── k=2 SENZA la condizione di distinzione: ${senza.length} scatti`);
for (const s of senza) console.log(`   ${s.iso}  $${s.pnlUsd}`);
console.log(`\n── k=2 CON la condizione di distinzione: ${con.length} scatti`);
for (const s of con) console.log(`   ${s.iso}  $${s.pnlUsd}`);

console.log('\n── i tre scatti REALMENTE avvenuti:');
const conSet = new Set(con.map((s) => s.iso));
for (const r of reali) console.log(`   ${r}  →  ${conSet.has(r) ? 'SOPRAVVIVE' : 'SPARISCE'}`);

// Per ognuno: la lettura precedente aveva lo stesso totale?
console.log('\n── perché: il totale della lettura precedente');
for (const r of reali) {
  const i = letture.findIndex((l) => new Date(l.ts).toISOString() === r);
  const prima = i > 0 ? letture[i - 1] : null;
  const q = letture[i];
  console.log(`   ${r.slice(11, 19)}  totale $${q.totale}  ·  precedente ${prima ? `$${prima.totale} (${((q.ts - prima.ts) / 1000).toFixed(0)}s prima)` : '—'}`
    + `  ⇒ ${prima && Math.abs(prima.totale - q.totale) <= 0.004 ? 'STESSA voce di cache' : 'voce diversa'}`);
}

fs.writeFileSync(path.join(__dirname, '..', '..', 'data', 'ricerca', 'verifica-letture-distinte.json'),
  JSON.stringify({ generatoIso: new Date().toISOString(), letture: letture.length,
    scattiSenzaDistinzione: senza, scattiConDistinzione: con, scattiReali: reali }, null, 1));

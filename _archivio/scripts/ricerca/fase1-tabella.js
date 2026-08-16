#!/usr/bin/env node
'use strict';
// scripts/ricerca/fase1-tabella.js — FASE 1: la tabella per wallet e la forma della distribuzione.
//
// SOLA LETTURA di `data/ricerca/pagamenti-onchain.json`. Nessuna rete, nessuna API, nessun contatto
// con Polymarket: qui si contano soltanto numeri già estratti.
//
// ⚠ DUE GIORNATE SONO ANOMALE E VANNO DICHIARATE, NON MEDIATE VIA. Sui trenta giorni estratti:
//   · 2026-07-21 → 400 destinatari e $21.655, contro una mediana di ~2.600 e ~$100k;
//   · 2026-07-15 → 6.563 destinatari e $260.643, cioè il doppio di tutti gli altri.
// La prima è quasi certamente una finestra che ha catturato UNA sola delle Disperse della giornata
// (il distributore ne manda diverse di fila, e 400 è esattamente la taglia di una); la seconda è
// probabilmente una giornata con un arretrato o un secondo ciclo. Entrambe restano nei dati grezzi e
// vengono SEGNALATE nel referto: escluderle in silenzio falserebbe la continuità, che è il filtro su
// cui si regge tutta la Fase 2 — un wallet che «manca» il 21 luglio potrebbe non aver mancato niente.

const fs = require('fs');
const path = require('path');

const IN = path.join('data', 'ricerca', 'pagamenti-onchain.json');
const OUT = path.join('data', 'ricerca');

// Una giornata è «piena» se ha almeno questa frazione della mediana dei destinatari. Sotto, la
// finestra ha visto solo una parte della distribuzione e la sua assenza non prova niente.
const FRAZIONE_GIORNATA_PIENA = 0.5;

const j = JSON.parse(fs.readFileSync(IN, 'utf8'));
const giorni = j.giorni.filter((g) => g.destinatari > 0);

const dest = giorni.map((g) => g.destinatari).sort((a, b) => a - b);
const medianaDest = dest[Math.floor(dest.length / 2)];
const soglia = medianaDest * FRAZIONE_GIORNATA_PIENA;
const pieni = giorni.filter((g) => g.destinatari >= soglia);
const parziali = giorni.filter((g) => g.destinatari < soglia);

// ── LA TABELLA PER WALLET ────────────────────────────────────────────────────────────────────────
// `giorniIncassati` si conta SOLO sulle giornate piene: su una giornata parziale l'assenza di un
// wallet non significa che non abbia incassato, significa che non l'abbiamo guardato tutto.
const per = new Map();
for (const g of giorni) {
  const pieno = g.destinatari >= soglia;
  // Un wallet può comparire più volte nello stesso giorno (più Disperse): si somma per giorno.
  const oggi = new Map();
  for (const p of g.pagamenti) oggi.set(p.a, (oggi.get(p.a) || 0) + p.usd);
  for (const [a, usd] of oggi) {
    if (!per.has(a)) per.set(a, { a, giorni: 0, giorniPieni: 0, totale: 0, importi: [] });
    const v = per.get(a);
    v.giorni += 1;
    if (pieno) v.giorniPieni += 1;
    v.totale += usd;
    v.importi.push(usd);
  }
}

const mediana = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const wallet = [...per.values()].map((v) => ({
  a: v.a,
  giorni: v.giorni,
  giorniPieni: v.giorniPieni,
  totale: +v.totale.toFixed(4),
  medianaGiornaliera: +mediana(v.importi).toFixed(4),
  max: +Math.max(...v.importi).toFixed(4),
  min: +Math.min(...v.importi).toFixed(4),
})).sort((a, b) => b.totale - a.totale);

// ── LA FORMA DELLA DISTRIBUZIONE ─────────────────────────────────────────────────────────────────
const totaleGenerale = wallet.reduce((s, w) => s + w.totale, 0);
const quota = (n) => {
  const k = Math.max(1, Math.round(wallet.length * n));
  return +(100 * wallet.slice(0, k).reduce((s, w) => s + w.totale, 0) / totaleGenerale).toFixed(2);
};
const metaInferiore = +(100 * wallet.slice(Math.floor(wallet.length / 2))
  .reduce((s, w) => s + w.totale, 0) / totaleGenerale).toFixed(2);

const referto = {
  generatoIl: new Date().toISOString(),
  giorniEstratti: giorni.length,
  giorniPieni: pieni.length,
  giorniParziali: parziali.map((g) => ({ giorno: g.giorno, destinatari: g.destinatari, usd: +g.totaleUsd.toFixed(2) })),
  medianaDestinatariGiornalieri: medianaDest,
  totaleDistribuitoUsd: +totaleGenerale.toFixed(2),
  walletDistinti: wallet.length,
  distribuzione: {
    primo1pct: quota(0.01),
    primo10pct: quota(0.10),
    metaInferiore,
  },
  continuita: {
    almeno20su30: wallet.filter((w) => w.giorniPieni >= 20).length,
    almeno25su30: wallet.filter((w) => w.giorniPieni >= 25).length,
    tutti: wallet.filter((w) => w.giorniPieni >= pieni.length).length,
    unaVoltaSola: wallet.filter((w) => w.giorni === 1).length,
  },
  wallet,
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'fase1-wallet.json'), JSON.stringify(referto, null, 1));

console.log(`giorni estratti      ${referto.giorniEstratti} (pieni ${referto.giorniPieni}, parziali ${parziali.length})`);
if (parziali.length) console.log(`  ⚠ parziali: ${referto.giorniParziali.map((x) => `${x.giorno} (${x.destinatari} dest)`).join(', ')}`);
console.log(`totale distribuito   $${referto.totaleDistribuitoUsd.toLocaleString('it-IT')}`);
console.log(`wallet distinti      ${referto.walletDistinti}`);
console.log('');
console.log(`quota del primo 1%   ${referto.distribuzione.primo1pct}%`);
console.log(`quota del primo 10%  ${referto.distribuzione.primo10pct}%`);
console.log(`quota meta inferiore ${referto.distribuzione.metaInferiore}%`);
console.log('');
console.log(`continui >=20/30     ${referto.continuita.almeno20su30}`);
console.log(`continui >=25/30     ${referto.continuita.almeno25su30}`);
console.log(`presenti UNA volta   ${referto.continuita.unaVoltaSola}`);
console.log('');
console.log('primi 10 per totale incassato:');
for (const w of wallet.slice(0, 10)) {
  console.log(`  ${w.a}  $${w.totale.toFixed(2).padStart(10)}  ${String(w.giorniPieni).padStart(2)}/${pieni.length} gg  mediana $${w.medianaGiornaliera.toFixed(2)}`);
}

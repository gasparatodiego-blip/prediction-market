'use strict';

/**
 * CHI INCASSA I LIQUIDITY REWARD, E QUANTO — sola lettura sui grezzi già raccolti.
 *
 * ═══ LE SCELTE DI METODO, DICHIARATE ═══════════════════════════════════════════════════════════
 *   · **Finestra: i 30 giorni COMPLETI 14/07 → 12/08.** Il 13/08 è escluso perché la giornata non è
 *     finita — il confine di fine giornata cade nel futuro e l'API lo rifiuta. Includerlo sarebbe un
 *     giorno parziale contato come intero, cioè un abbassamento artificiale di tutte le medie.
 *   · **Due giorni sono ANOMALI e vengono marcati, non nascosti**: 15/07 ($260k, 6.563 destinatari,
 *     17 tx) e 07/08 ($644k, 9.626 destinatari, 25 tx) contro una mediana di $113k / ~2.700 / 7 tx.
 *     Hanno la firma di un recupero (più tx, più destinatari, importo multiplo), non di una giornata
 *     normale. Le statistiche per-giorno si danno **con e senza** questi due, così la differenza si
 *     vede invece di essere decisa da me.
 *   · **La soglia del rumore**: si scarta chi incassa meno di **$1 in tutto il periodo** OPPURE
 *     compare in **un solo giorno su 30**. Sono due criteri e servono a cose diverse: il primo toglie
 *     la polvere, il secondo toglie chi è passato di lì una volta. Entrambi dichiarati e misurati.
 *   · **«Sopra $100/giorno» si misura sulla media per GIORNO DI PRESENZA**, non sui 30 giorni: un
 *     wallet attivo 5 giorni a $150 fa $150/giorno, non $25. È la domanda «che ritmo tiene quando
 *     lavora», che è quella operativamente utile.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'data', 'ricerca', 'distribuzioni-reward');
const NOSTRO = '0x4c81f19a436e8174f1f3b07d7c0169150fbdbdee';
const ANOMALI = new Set(['2026-07-15', '2026-08-07']);
const SOGLIA_RUMORE_USD = 1;

const giorni = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const dati = giorni.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));

// ── AGGREGAZIONE PER DESTINATARIO ────────────────────────────────────────────────────────────────
const per = new Map();
for (const d of dati) {
  const perGiorno = new Map();
  for (const r of d.righe) perGiorno.set(r.a, (perGiorno.get(r.a) || 0) + r.usd);
  for (const [a, usd] of perGiorno) {
    if (!per.has(a)) per.set(a, { a, giorni: [], totale: 0 });
    const w = per.get(a);
    w.giorni.push({ giorno: d.giorno, usd });
    w.totale += usd;
  }
}

const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * p)] : NaN; };

const wallet = [...per.values()].map((w) => {
  const importi = w.giorni.map((g) => g.usd);
  // La TENDENZA: media della seconda metà del periodo contro la prima. Non una regressione — con
  // presenze sparse una retta direbbe più di quello che i dati sanno.
  const meta = Math.floor(dati.length / 2);
  const primaMeta = w.giorni.filter((g) => giorni.indexOf(`${g.giorno}.json`) < meta);
  const secondaMeta = w.giorni.filter((g) => giorni.indexOf(`${g.giorno}.json`) >= meta);
  const mp = primaMeta.length ? primaMeta.reduce((s, g) => s + g.usd, 0) / primaMeta.length : 0;
  const ms = secondaMeta.length ? secondaMeta.reduce((s, g) => s + g.usd, 0) / secondaMeta.length : 0;
  return {
    a: w.a, giorniPresente: w.giorni.length, totaleUsd: +w.totale.toFixed(2),
    mediaPerGiornoPresenza: +(w.totale / w.giorni.length).toFixed(2),
    medianaPerGiorno: +q(importi, 0.5).toFixed(2),
    maxGiorno: +Math.max(...importi).toFixed(2),
    primaMetaMedia: +mp.toFixed(2), secondaMetaMedia: +ms.toFixed(2),
    tendenza: mp > 0 ? +((ms - mp) / mp * 100).toFixed(1) : (ms > 0 ? Infinity : 0),
  };
});

const rumore = wallet.filter((w) => w.totaleUsd < SOGLIA_RUMORE_USD || w.giorniPresente <= 1);
const seri = wallet.filter((w) => !(w.totaleUsd < SOGLIA_RUMORE_USD || w.giorniPresente <= 1))
  .sort((a, b) => b.totaleUsd - a.totaleUsd);

const montePremi = wallet.reduce((s, w) => s + w.totaleUsd, 0);

console.log('# Chi incassa i liquidity reward — 30 giorni completi\n');
console.log(`giorni analizzati: ${dati.length} (${dati[0].giorno} → ${dati[dati.length - 1].giorno})`);
console.log(`monte premi totale: $${montePremi.toFixed(2)}`);
console.log(`wallet distinti: ${wallet.length} · scartati come rumore: ${rumore.length} `
  + `(< $${SOGLIA_RUMORE_USD} in totale, oppure presenti 1 solo giorno) · analizzati: ${seri.length}`);
const persiRumore = rumore.reduce((s, w) => s + w.totaleUsd, 0);
console.log(`il rumore scartato vale $${persiRumore.toFixed(2)}, cioè il ${(persiRumore / montePremi * 100).toFixed(2)}% del monte premi\n`);

// ── LE FASCE ─────────────────────────────────────────────────────────────────────────────────────
const fasce = [
  ['≥ $200/giorno', (w) => w.mediaPerGiornoPresenza >= 200],
  ['$100–200/giorno', (w) => w.mediaPerGiornoPresenza >= 100 && w.mediaPerGiornoPresenza < 200],
  ['$10–100/giorno', (w) => w.mediaPerGiornoPresenza >= 10 && w.mediaPerGiornoPresenza < 100],
  ['$1–10/giorno', (w) => w.mediaPerGiornoPresenza >= 1 && w.mediaPerGiornoPresenza < 10],
  ['< $1/giorno', (w) => w.mediaPerGiornoPresenza < 1],
];
console.log('## Distribuzione per fascia (media per giorno di presenza)\n');
console.log('| fascia | wallet | % wallet | incassato | % del monte | presenza mediana |');
console.log('|---|---|---|---|---|---|');
for (const [nome, f] of fasce) {
  const g = seri.filter(f);
  const usd = g.reduce((s, w) => s + w.totaleUsd, 0);
  const pres = q(g.map((w) => w.giorniPresente), 0.5);
  console.log(`| ${nome} | ${g.length} | ${(g.length / seri.length * 100).toFixed(1)}% | $${usd.toFixed(0)} `
    + `| ${(usd / montePremi * 100).toFixed(1)}% | ${Number.isFinite(pres) ? `${pres}/30` : '—'} |`);
}

// Concentrazione.
const ordinati = [...seri].sort((a, b) => b.totaleUsd - a.totaleUsd);
console.log('\n## Concentrazione\n');
for (const n of [10, 25, 50, 100, 250]) {
  const usd = ordinati.slice(0, n).reduce((s, w) => s + w.totaleUsd, 0);
  console.log(`- i primi ${String(n).padStart(3)} wallet prendono $${usd.toFixed(0).padStart(8)} = ${(usd / montePremi * 100).toFixed(1)}% del monte premi`);
}

// ── IL NOSTRO WALLET ─────────────────────────────────────────────────────────────────────────────
const noi = wallet.find((w) => w.a === NOSTRO);
console.log('\n## Il nostro wallet\n');
if (!noi) {
  console.log(`\`${NOSTRO}\` NON compare in nessuna delle ${dati.length} distribuzioni.`);
} else {
  const migliori = ordinati.filter((w) => w.totaleUsd > noi.totaleUsd).length;
  console.log(`\`${NOSTRO}\``);
  console.log(`- presente in **${noi.giorniPresente}/${dati.length}** giorni`);
  console.log(`- incassato **$${noi.totaleUsd}**, media **$${noi.mediaPerGiornoPresenza}/giorno di presenza**, mediana $${noi.medianaPerGiorno}, massimo $${noi.maxGiorno}`);
  console.log(`- posizione: **${migliori + 1}° su ${seri.length}** wallet seri ⇒ percentile **${(100 - (migliori / seri.length * 100)).toFixed(1)}**`);
  console.log(`- quota del monte premi: **${(noi.totaleUsd / montePremi * 100).toFixed(4)}%**`);
  console.log('\n  per giorno:');
  const w = per.get(NOSTRO);
  for (const g of w.giorni) console.log(`    ${g.giorno}  $${g.usd.toFixed(4)}`);
}

// ── I TOP ────────────────────────────────────────────────────────────────────────────────────────
console.log('\n## I primi 15 per incasso\n');
console.log('| # | wallet | giorni | totale | media/giorno | mediana | max | tendenza |');
console.log('|---|---|---|---|---|---|---|---|');
ordinati.slice(0, 15).forEach((w, i) => {
  const t = Number.isFinite(w.tendenza) ? `${w.tendenza > 0 ? '+' : ''}${w.tendenza}%` : 'nuovo';
  console.log(`| ${i + 1} | \`${w.a.slice(0, 10)}…\` | ${w.giorniPresente}/30 | $${w.totaleUsd.toFixed(0)} `
    + `| $${w.mediaPerGiornoPresenza.toFixed(0)} | $${w.medianaPerGiorno.toFixed(0)} | $${w.maxGiorno.toFixed(0)} | ${t} |`);
});

fs.writeFileSync(path.join(ROOT, 'data', 'ricerca', 'incassatori.json'), JSON.stringify({
  generatoIso: new Date().toISOString(),
  finestra: { da: dati[0].giorno, a: dati[dati.length - 1].giorno, giorni: dati.length },
  giorniAnomali: [...ANOMALI], sogliaRumoreUsd: SOGLIA_RUMORE_USD,
  montePremiUsd: +montePremi.toFixed(2), walletDistinti: wallet.length,
  walletSeri: seri.length, noi: noi || null,
  top50: ordinati.slice(0, 50),
}, null, 1));

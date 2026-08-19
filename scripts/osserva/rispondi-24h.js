'use strict';
// scripts/osserva/rispondi-24h.js — LE TRE DOMANDE DELLA FINESTRA, RISPOSTE DAI DATI REGISTRATI.
//
// L'operatore ne ha chieste tre, e questo file esiste perche' domani la risposta sia UN COMANDO e non
// una ricostruzione fatta a mano su cinque giornali — che e' il modo in cui il 18 agosto sera si e'
// dichiarato «4 mercati, 8 ordini, $209,08» contro i 2 veri.
//
//   ① quanti mercati ha tenuto IN MEDIA
//   ② quanto tempo il capitale e' stato FERMO senza ordini a libro
//   ③ quanto premio ha incassato
//
// ⚠ OGNI RISPOSTA DICE ANCHE QUANTO E' COPERTA. Un campione mancante non e' uno zero: se
//   l'osservatore ha saltato mezz'ora, le medie di quella mezz'ora non esistono e la riga lo dice.
// ⚠ ① E ② SI RISPONDONO SULLA LETTURA AUTOREVOLE quando c'e' (`venue-orders.json`, che agent40 scrive
//   dal venue vero) e sulla ricostruzione solo quando l'autorevole tace — dichiarando quale delle due
//   ha risposto. Le due non si mediano mai.
// ⚠ ③ E' UNA STIMA, non un incasso: e' Σ(tasso × durata) campionata da agent40. Il pagamento vero
//   arriva dal venue con giorni di ritardo e si legge da `GET /api/maker/registro-reward`.
//
// Uso:  node scripts/osserva/rispondi-24h.js [ore]      (difetto: 24)

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'data', 'osservazione-24h.jsonl');
const ORE = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 24;
const CADENZA_ATTESA_MS = 60_000;

const righe = [];
try {
  for (const l of fs.readFileSync(FILE, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { righe.push(JSON.parse(l)); } catch { /* riga troncata: si butta, non si ripara */ }
  }
} catch (e) {
  console.error(`registro non leggibile (${e.message}). Nessuna risposta e meglio di una inventata.`);
  process.exit(1);
}
const taglio = Date.now() - ORE * 3600_000;
const c = righe.filter((r) => r.at >= taglio).sort((a, b) => a.at - b.at);
if (!c.length) { console.error('nessun campione nella finestra'); process.exit(1); }

const fmt = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

// ── LA COPERTURA: quanto della finestra e' davvero osservato ─────────────────────────────────────
let copertoMs = 0; const buchi = [];
for (let i = 0; i < c.length; i++) {
  const dt = i + 1 < c.length ? c[i + 1].at - c[i].at : Math.min(CADENZA_ATTESA_MS, Date.now() - c[i].at);
  // Un campione vale al piu' due cadenze: oltre, l'intervallo non e' osservato ed e' un buco.
  if (dt > 2 * CADENZA_ATTESA_MS) { buchi.push({ da: c[i].atIso, ms: dt }); copertoMs += CADENZA_ATTESA_MS; }
  else copertoMs += Math.max(0, dt);
}
// ⚠ L'ultimo campione copre in avanti fino a «adesso» (al piu' una cadenza), quindi l'orizzonte va
//   fino li' e non all'istante dell'ultimo campione: senza, la copertura supera il 100% e un numero
//   impossibile fa dubitare di tutti gli altri.
const orizzonteMs = Math.min(Date.now(), c[c.length - 1].at + CADENZA_ATTESA_MS) - c[0].at;

// ── ① QUANTI MERCATI, IN MEDIA ───────────────────────────────────────────────────────────────────
// Media PESATA SUL TEMPO, non sui campioni: se l'osservatore salta, i minuti che restano non devono
// pesare di piu' per il fatto di essere stati guardati.
let pesoTot = 0; let mercatiPesati = 0; let ordiniPesati = 0; let nozionalePesato = 0;
let daAutorevole = 0; let daRicostruzione = 0; let senzaFonte = 0;
let divergenti = 0; let divCalcolabili = 0;
const perMercatoMs = new Map();
let fermoMs = 0; const episodiFermo = [];
let inFermoDa = null;
let maxMercati = 0; let maxNozionale = 0;

for (let i = 0; i < c.length; i++) {
  const r = c[i];
  const dt = Math.min(i + 1 < c.length ? c[i + 1].at - r.at : CADENZA_ATTESA_MS, 2 * CADENZA_ATTESA_MS);
  const aut = r.libroAutorevole && r.libroAutorevole.leggibile === true ? r.libroAutorevole.mercati : null;
  const ric = r.libro && r.libro.mercati ? Object.keys(r.libro.mercati) : null;
  const ids = aut !== null ? aut : ric;
  if (aut !== null) daAutorevole += 1; else if (ric !== null) daRicostruzione += 1; else senzaFonte += 1;
  if (r.divergenza && r.divergenza.calcolabile) { divCalcolabili += 1; if (!r.divergenza.concordi) divergenti += 1; }
  if (ids === null) continue;                    // non osservato: non entra in nessuna media

  pesoTot += dt;
  mercatiPesati += ids.length * dt;
  for (const id of ids) perMercatoMs.set(id, (perMercatoMs.get(id) || 0) + dt);
  if (ids.length > maxMercati) maxMercati = ids.length;

  if (r.libro) {
    ordiniPesati += (r.libro.ordini || 0) * dt;
    nozionalePesato += (r.libro.nozionaleUsd || 0) * dt;
    if ((r.libro.nozionaleUsd || 0) > maxNozionale) maxNozionale = r.libro.nozionaleUsd;
  }

  // ── ② IL CAPITALE FERMO ────────────────────────────────────────────────────────────────────────
  // «Fermo» = ZERO mercati con ordini a libro. ⚠ Non e' «zero ordini utili» ne' «sotto obiettivo»:
  //   e' il caso in cui il bot e' armato e non c'e' niente sul libro che possa maturare premio.
  if (ids.length === 0) {
    fermoMs += dt;
    if (inFermoDa === null) inFermoDa = r.at;
  } else if (inFermoDa !== null) {
    episodiFermo.push({ da: new Date(inFermoDa).toISOString(), ms: r.at - inFermoDa });
    inFermoDa = null;
  }
}
if (inFermoDa !== null) episodiFermo.push({ da: new Date(inFermoDa).toISOString(), ms: c[c.length - 1].at - inFermoDa, inCorso: true });

// ── ③ IL PREMIO ──────────────────────────────────────────────────────────────────────────────────
// Non si somma sui campioni (sarebbe contato mille volte): si prende l'integrale gia' cumulato, per
// giorno, e si guarda quanto e' cresciuto dentro la finestra.
const perGiorno = new Map();
for (const r of c) {
  const p = r.premio;
  if (!p || p.leggibile !== true || p.usd === null || p.usd === undefined) continue;
  const g = perGiorno.get(p.giorno) || { primo: null, ultimo: null, copertura: null, campioni: null };
  if (g.primo === null) g.primo = p.usd;
  g.ultimo = p.usd; g.copertura = p.coperturaFrazione; g.campioni = p.campioni;
  perGiorno.set(p.giorno, g);
}
let premioFinestra = 0; const dettaglioPremio = [];
for (const [g, v] of perGiorno) {
  const d = +(v.ultimo - v.primo).toFixed(4);
  premioFinestra += d;
  dettaglioPremio.push(`${g}: +$${d.toFixed(4)} (cumulato $${v.ultimo.toFixed(4)}, copertura ${(v.copertura * 100).toFixed(1)}%)`);
}

// ── IL REFERTO ───────────────────────────────────────────────────────────────────────────────────
const P = (s) => console.log(s);
P(`\n══ FINESTRA DI OSSERVAZIONE · ultime ${ORE} ore ════════════════════════════════════════════`);
P(`campioni ${c.length} · da ${c[0].atIso} a ${c[c.length - 1].atIso} (${fmt(orizzonteMs)})`);
P(`copertura ${orizzonteMs > 0 ? ((copertoMs / orizzonteMs) * 100).toFixed(1) : '0.0'}% · buchi ${buchi.length}`
  + (buchi.length ? ` (peggiore ${fmt(Math.max(...buchi.map((b) => b.ms)))})` : ''));
P(`fonte del libro: ${daAutorevole} campioni dalla LETTURA del venue · ${daRicostruzione} dalla sola ricostruzione · ${senzaFonte} senza fonte`);
P(`divergenza lettura⇄ricostruzione: ${divergenti} campioni su ${divCalcolabili} calcolabili`
  + (divergenti ? '  ⚠ dove divergono, la lettura vince e la ricostruzione va guardata' : '  — sempre concordi'));

P(`\n── ① QUANTI MERCATI HA TENUTO ─────────────────────────────────────────────────────────────`);
P(`media pesata sul tempo: ${pesoTot > 0 ? (mercatiPesati / pesoTot).toFixed(2) : 'n/d'} mercati con ordini a libro (massimo ${maxMercati})`);
P(`ordini a libro, media: ${pesoTot > 0 ? (ordiniPesati / pesoTot).toFixed(2) : 'n/d'} · capitale impegnato medio $${pesoTot > 0 ? (nozionalePesato / pesoTot).toFixed(2) : 'n/d'} (picco $${maxNozionale.toFixed(2)})`);
P(`tempo per mercato:`);
[...perMercatoMs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([id, ms]) => P(`   ${id.slice(0, 18)}…  ${fmt(ms)}  (${((ms / pesoTot) * 100).toFixed(1)}% della finestra)`));

P(`\n── ② QUANTO TEMPO IL CAPITALE E' STATO FERMO (zero mercati a libro) ───────────────────────`);
P(`fermo ${fmt(fermoMs)} su ${fmt(pesoTot)} osservati = ${pesoTot > 0 ? ((fermoMs / pesoTot) * 100).toFixed(1) : 'n/d'}%`);
P(`episodi: ${episodiFermo.length}`);
episodiFermo.sort((a, b) => b.ms - a.ms).slice(0, 10)
  .forEach((e) => P(`   ${e.da}  ${fmt(e.ms)}${e.inCorso ? '  (ancora in corso)' : ''}`));

P(`\n── ③ QUANTO PREMIO ────────────────────────────────────────────────────────────────────────`);
P(`stima maturata nella finestra: $${premioFinestra.toFixed(4)}`);
dettaglioPremio.forEach((d) => P(`   ${d}`));
P(`⚠ e' una STIMA (Σ tasso×durata, campionata ogni 5 min da agent40), non un incasso.`);
P(`   l'incasso vero arriva dal venue con giorni di ritardo: GET /api/maker/registro-reward\n`);

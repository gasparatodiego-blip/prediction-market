'use strict';
// scripts/ricerca/screening-06-analisi-uscite.js — LE MISURE SULLE USCITE, E IL CONFRONTO COL BOT.
//
//   node scripts/ricerca/screening-06-analisi-uscite.js
//
// Legge `screening-05-uscite.json` e non tocca la rete se non per le scadenze dei mercati della
// classe C, che servono a rispondere a «quanto tiene prima della risoluzione».

const { apiGet, scrivi, leggi, mediana, DIR_DATI } = require('./screening-lib');

/** Quanti mercati di classe C arricchire con la scadenza. Oltre, la copertura si dichiara parziale. */
const MERCATI_C_MAX = 6000;

const q = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const pct = (n, d) => (d ? (100 * n / d) : 0);
const durata = (s) => {
  if (s === null || s === undefined) return 'n/d';
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} g`;
};

/**
 * LE SCADENZE DEI MERCATI, APERTI **E** CHIUSI.
 *
 * ⚠ DUE PASSATE, E NON È RIDONDANZA: `/markets?condition_ids=…` di Gamma restituisce di difetto SOLO
 * i mercati aperti. Con una passata sola il primo giro ha trovato 4.350 scadenze su 9.731 eventi —
 * e tutte e 4.350 erano di mercati **ancora aperti**, cioè i 5.381 «senza scadenza» erano
 * esattamente quelli già risolti. Concludere da lì sarebbe stato il ribaltamento perfetto: la
 * domanda è «quanto tiene PRIMA della risoluzione» e mancavano tutti quelli che si erano risolti.
 * `&closed=true` li restituisce.
 */
async function scadenze(cids) {
  const fuori = new Map();
  const BLOCCO = 20;
  for (const suffisso of ['', '&closed=true']) {
    for (let i = 0; i < cids.length; i += BLOCCO) {
      const pezzo = cids.slice(i, i + BLOCCO).filter((c) => !fuori.has(c));
      if (!pezzo.length) continue;
      const qs = pezzo.map((c) => `condition_ids=${c}`).join('&');
      const r = await apiGet(`/markets?${qs}${suffisso}`, 0, 'gamma-api.polymarket.com');
      if (!r.ok || !Array.isArray(r.dati)) continue;
      for (const m of r.dati) {
        const t = Date.parse(m.endDate);
        // Una data non parsabile NON diventa mai un numero: resta fuori dalla mappa (§4.6).
        if (Number.isFinite(t)) fuori.set(String(m.conditionId), { fine: t / 1000, chiuso: m.closed === true });
      }
    }
  }
  return fuori;
}

function riassumi(eventi, etichetta) {
  const tot = eventi.length;
  const cl = {};
  for (const e of eventi) cl[e.classe] = (cl[e.classe] || 0) + 1;

  const A = eventi.filter((e) => e.classe === 'A');
  const B = eventi.filter((e) => e.classe === 'B');

  const costiA = A.map((e) => e.costoCoppiaCents).filter(Number.isFinite);
  const deltaB = B.map((e) => e.deltaCents).filter(Number.isFinite);

  return {
    etichetta,
    eventi: tot,
    distribuzione: Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((k) => [k, {
      n: cl[k] || 0, pct: +pct(cl[k] || 0, tot).toFixed(1),
    }])),
    A: {
      n: A.length,
      costoCoppiaCents: { q25: q(costiA, 0.25), mediana: q(costiA, 0.5), q75: q(costiA, 0.75) },
      // Sopra 100¢ la coppia è una perdita certa: è il numero che conta per il confronto col bot.
      quotaSopra100: +pct(costiA.filter((c) => c > 100).length, costiA.length).toFixed(1),
      quotaSopra110: +pct(costiA.filter((c) => c > 110).length, costiA.length).toFixed(1),
      quotaSopra120: +pct(costiA.filter((c) => c > 120).length, costiA.length).toFixed(1),
      tempoSec: { q25: q(A.map((e) => e.dtSec), 0.25), mediana: q(A.map((e) => e.dtSec), 0.5), q75: q(A.map((e) => e.dtSec), 0.75) },
      // La gamba che COMPLETA: ha attraversato lo spread o si è messa in coda?
      quotaCompletamentoTaker: +pct(A.filter((e) => e.seguitoTaker).length, A.length).toFixed(1),
      quotaEntroUnMinuto: +pct(A.filter((e) => e.dtSec <= 60).length, A.length).toFixed(1),
      quotaEntroUnOra: +pct(A.filter((e) => e.dtSec <= 3600).length, A.length).toFixed(1),
    },
    B: {
      n: B.length,
      deltaCents: { q25: q(deltaB, 0.25), mediana: q(deltaB, 0.5), q75: q(deltaB, 0.75) },
      quotaInPerdita: +pct(deltaB.filter((d) => d < 0).length, deltaB.length).toFixed(1),
      tempoSec: { q25: q(B.map((e) => e.dtSec), 0.25), mediana: q(B.map((e) => e.dtSec), 0.5), q75: q(B.map((e) => e.dtSec), 0.75) },
      quotaRivenditaTaker: +pct(B.filter((e) => e.seguitoTaker).length, B.length).toFixed(1),
    },
    // Il fill di PARTENZA: quanto spesso questi wallet entrano prendendo invece che posando.
    quotaIngressoTaker: +pct(eventi.filter((e) => e.taker).length, tot).toFixed(1),
  };
}

function scriviMarkdown(o) {
  const r = o.complessivo;
  const nomi = { A: 'A · completa la coppia', B: 'B · rivende lo stesso outcome', C: 'C · non fa nulla', D: 'D · aumenta sullo stesso lato', E: "E · vende l'altro lato" };
  const t = [];
  t.push('# Come escono dopo un fill i 65 maker dello screening');
  t.push('');
  t.push(`Generato ${o.generatoIl}. ${o.wallet} wallet · **${o.eventiClassificati.toLocaleString('it-IT')} fill BUY** classificati · ${o.censurati.toLocaleString('it-IT')} censurati (fill troppo recenti per essere osservati un orizzonte intero).`);
  t.push(`Copertura per wallet: mediana ${o.copertura.oreMediana.toFixed(0)} h. Orizzonte di classificazione ${o.parametri.orizzonteH} h. Fill parziali fusi entro ${o.parametri.finestraUnioneS} s.`);
  t.push('');
  t.push('| classe | n | % |');
  t.push('|---|---|---|');
  for (const k of ['A', 'B', 'C', 'D', 'E']) t.push(`| ${nomi[k]} | ${r.distribuzione[k].n} | **${r.distribuzione[k].pct}%** |`);
  t.push('');
  t.push('## A · completa la coppia');
  t.push('');
  t.push(`| misura | valore |`);
  t.push('|---|---|');
  t.push(`| costo coppia mediano | **${r.A.costoCoppiaCents.mediana.toFixed(2)}¢** (q25 ${r.A.costoCoppiaCents.q25.toFixed(2)} · q75 ${r.A.costoCoppiaCents.q75.toFixed(2)}) |`);
  t.push(`| quota ≤99¢ / ≤110¢ / ≤120¢ | ${(100 - r.A.quotaSopra100).toFixed(1)}% / ${(100 - r.A.quotaSopra110).toFixed(1)}% / ${(100 - r.A.quotaSopra120).toFixed(1)}% |`);
  t.push(`| tempo mediano | **${durata(r.A.tempoSec.mediana)}** (q25 ${durata(r.A.tempoSec.q25)} · q75 ${durata(r.A.tempoSec.q75)}) |`);
  t.push(`| entro 1 min / 1 h | ${r.A.quotaEntroUnMinuto}% / ${r.A.quotaEntroUnOra}% |`);
  t.push(`| gamba che completa presa da TAKER | **${r.A.quotaCompletamentoTaker}%** |`);
  t.push('');
  t.push('## B · rivende lo stesso outcome');
  t.push('');
  t.push('| misura | valore |');
  t.push('|---|---|');
  t.push(`| risultato mediano | **${r.B.deltaCents.mediana.toFixed(2)}¢** (q25 ${r.B.deltaCents.q25.toFixed(2)} · q75 ${r.B.deltaCents.q75.toFixed(2)}) |`);
  t.push(`| in perdita | ${r.B.quotaInPerdita}% |`);
  t.push(`| tempo mediano | **${durata(r.B.tempoSec.mediana)}** (q25 ${durata(r.B.tempoSec.q25)} · q75 ${durata(r.B.tempoSec.q75)}) |`);
  t.push(`| rivendita presa da TAKER | **${r.B.quotaRivenditaTaker}%** |`);
  t.push('');
  t.push('## C · non fa nulla');
  t.push('');
  t.push(`Durata **realizzata** (mercato già chiuso), n=${o.C.realizzate.n}: mediana **${durata(o.C.realizzate.mediana)}** (q25 ${durata(o.C.realizzate.q25)} · q75 ${durata(o.C.realizzate.q75)}).`);
  t.push(`Mercati ancora aperti (censurati), n=${o.C.previste.n}: mancano ${durata(o.C.previste.mediana)} alla scadenza. Senza scadenza: ${o.C.senzaScadenza}.`);
  t.push('');
  t.push(`## Rewards alti contro bassi (soglia $${o.sogliaRewards.toFixed(0)} su 14 giorni)`);
  t.push('');
  t.push('| | alti | bassi |');
  t.push('|---|---|---|');
  for (const k of ['A', 'B', 'C', 'D', 'E']) t.push(`| ${nomi[k]} | ${o.rewardsAlti.distribuzione[k].pct}% | ${o.rewardsBassi.distribuzione[k].pct}% |`);
  t.push(`| costo coppia mediano (A) | ${o.rewardsAlti.A.costoCoppiaCents.mediana.toFixed(2)}¢ | ${o.rewardsBassi.A.costoCoppiaCents.mediana.toFixed(2)}¢ |`);
  t.push(`| delta mediano (B) | ${o.rewardsAlti.B.deltaCents.mediana.toFixed(2)}¢ | ${o.rewardsBassi.B.deltaCents.mediana.toFixed(2)}¢ |`);
  t.push(`| completamento taker (A) | ${o.rewardsAlti.A.quotaCompletamentoTaker}% | ${o.rewardsBassi.A.quotaCompletamentoTaker}% |`);
  t.push(`| ingresso taker | ${o.rewardsAlti.quotaIngressoTaker}% | ${o.rewardsBassi.quotaIngressoTaker}% |`);

  const percorso = require('path').join(DIR_DATI, 'sintesi-uscite-maker.md');
  require('fs').writeFileSync(percorso, t.join('\n') + '\n');
  return percorso;
}

async function main() {
  const dati = leggi('screening-05-uscite.json');
  const perWallet = dati.perWallet;
  const tutti = [];
  for (const w of perWallet) for (const e of w.eventi) tutti.push({ ...e, wallet: w.wallet, rewards14g: w.rewards14g });

  // ── CLASSE C: quanto tiene prima della risoluzione ────────────────────────────────────────────
  const C = tutti.filter((e) => e.classe === 'C');
  const cidsC = [...new Set(C.map((e) => e.mercato))];
  const troncato = cidsC.length > MERCATI_C_MAX;
  const mappa = await scadenze(cidsC.slice(0, MERCATI_C_MAX));
  // ⚠ SI TENGONO SEPARATE LE DUE POPOLAZIONI. Un mercato già CHIUSO dà una durata REALIZZATA: la
  // posizione è stata tenuta fino alla risoluzione, e il numero è un fatto. Un mercato ANCORA APERTO
  // dà solo il tempo che manca alla scadenza prevista: è censurato a destra, e mescolarlo col primo
  // produrrebbe una «mediana» che non descrive nessuna delle due cose.
  const atteseRealizzate = [];
  const attesePreviste = [];
  let senzaScadenza = 0;
  for (const e of C) {
    const m = mappa.get(e.mercato);
    if (!m) { senzaScadenza += 1; continue; }
    const dt = m.fine - e.ts;
    if (dt <= 0) { senzaScadenza += 1; continue; }   // scadenza prima del fill: dato incoerente, si scarta
    (m.chiuso ? atteseRealizzate : attesePreviste).push(dt);
  }

  // ── IL TAGLIO PER REWARDS: metà alta contro metà bassa ────────────────────────────────────────
  const perRewards = [...new Set(perWallet.map((w) => w.rewards14g))].sort((a, b) => a - b);
  const soglia = perRewards[Math.floor(perRewards.length / 2)];
  const alti = tutti.filter((e) => e.rewards14g >= soglia);
  const bassi = tutti.filter((e) => e.rewards14g < soglia);

  const out = {
    generatoIl: new Date().toISOString(),
    parametri: dati.parametri,
    wallet: perWallet.length,
    eventiClassificati: tutti.length,
    censurati: perWallet.reduce((a, w) => a + w.censurati, 0),
    copertura: {
      oreMediana: q(perWallet.map((w) => w.copertura.ore), 0.5),
      oreMin: Math.min(...perWallet.map((w) => w.copertura.ore)),
      oreMax: Math.max(...perWallet.map((w) => w.copertura.ore)),
    },
    complessivo: riassumi(tutti, 'tutti i 65'),
    C: {
      n: C.length,
      mercatiDistinti: cidsC.length,
      scadenzaTrovata: atteseRealizzate.length + attesePreviste.length,
      senzaScadenza,
      troncato,
      realizzate: { n: atteseRealizzate.length, q25: q(atteseRealizzate, 0.25), mediana: q(atteseRealizzate, 0.5), q75: q(atteseRealizzate, 0.75) },
      previste: { n: attesePreviste.length, q25: q(attesePreviste, 0.25), mediana: q(attesePreviste, 0.5), q75: q(attesePreviste, 0.75) },
    },
    sogliaRewards: soglia,
    rewardsAlti: riassumi(alti, `rewards ≥ $${soglia.toFixed(0)}`),
    rewardsBassi: riassumi(bassi, `rewards < $${soglia.toFixed(0)}`),
  };
  scrivi('screening-06-analisi-uscite.json', out);
  scriviMarkdown(out);

  // ── STAMPA ────────────────────────────────────────────────────────────────────────────────────
  const r = out.complessivo;
  console.log(`\n${out.wallet} wallet · ${out.eventiClassificati.toLocaleString('it-IT')} fill BUY classificati · ${out.censurati.toLocaleString('it-IT')} censurati`);
  console.log(`copertura per wallet: mediana ${out.copertura.oreMediana.toFixed(0)}h (min ${out.copertura.oreMin.toFixed(0)}h · max ${out.copertura.oreMax.toFixed(0)}h)`);
  console.log(`fill di ingresso presi da TAKER: ${r.quotaIngressoTaker}%\n`);

  console.log('classe                                    n        %');
  const nomi = { A: 'A · completa la coppia', B: 'B · rivende lo stesso outcome', C: 'C · non fa nulla', D: 'D · aumenta sullo stesso lato', E: 'E · vende l\'altro lato' };
  for (const k of ['A', 'B', 'C', 'D', 'E']) {
    console.log(`${nomi[k].padEnd(38)} ${String(r.distribuzione[k].n).padStart(6)}  ${String(r.distribuzione[k].pct).padStart(5)}%`);
  }

  console.log(`\nA · costo coppia: mediana ${r.A.costoCoppiaCents.mediana.toFixed(2)}¢ (q25 ${r.A.costoCoppiaCents.q25.toFixed(2)} · q75 ${r.A.costoCoppiaCents.q75.toFixed(2)})`);
  console.log(`     sopra 100¢: ${r.A.quotaSopra100}% · sopra 110¢: ${r.A.quotaSopra110}% · sopra 120¢: ${r.A.quotaSopra120}%`);
  console.log(`     tempo: mediana ${durata(r.A.tempoSec.mediana)} (q25 ${durata(r.A.tempoSec.q25)} · q75 ${durata(r.A.tempoSec.q75)})`);
  console.log(`     entro 1 min: ${r.A.quotaEntroUnMinuto}% · entro 1 h: ${r.A.quotaEntroUnOra}%`);
  console.log(`     gamba che completa presa da TAKER: ${r.A.quotaCompletamentoTaker}%`);

  console.log(`\nB · risultato: mediana ${r.B.deltaCents.mediana.toFixed(2)}¢ (q25 ${r.B.deltaCents.q25.toFixed(2)} · q75 ${r.B.deltaCents.q75.toFixed(2)})`);
  console.log(`     in perdita: ${r.B.quotaInPerdita}%`);
  console.log(`     tempo: mediana ${durata(r.B.tempoSec.mediana)} (q25 ${durata(r.B.tempoSec.q25)} · q75 ${durata(r.B.tempoSec.q75)})`);
  console.log(`     rivendita presa da TAKER: ${r.B.quotaRivenditaTaker}%`);

  console.log(`\nC · tenuta fino alla risoluzione (mercati GIA' CHIUSI, durata REALIZZATA), n=${out.C.realizzate.n}`);
  console.log(`     mediana ${durata(out.C.realizzate.mediana)} (q25 ${durata(out.C.realizzate.q25)} · q75 ${durata(out.C.realizzate.q75)})`);
  console.log(`   · mercati ancora APERTI (tempo che manca alla scadenza, censurato), n=${out.C.previste.n}`);
  console.log(`     mediana ${durata(out.C.previste.mediana)} (q25 ${durata(out.C.previste.q25)} · q75 ${durata(out.C.previste.q75)})`);
  console.log(`     scadenza trovata per ${out.C.scadenzaTrovata}/${out.C.n} eventi · senza scadenza ${out.C.senzaScadenza}`);

  console.log(`\n── taglio per rewards (soglia $${soglia.toFixed(0)} su 14 giorni) ──`);
  console.log('                                   alti     bassi');
  for (const k of ['A', 'B', 'C', 'D', 'E']) {
    console.log(`${nomi[k].padEnd(32)} ${String(out.rewardsAlti.distribuzione[k].pct).padStart(6)}%  ${String(out.rewardsBassi.distribuzione[k].pct).padStart(6)}%`);
  }
  console.log(`${'costo coppia mediano (A)'.padEnd(32)} ${out.rewardsAlti.A.costoCoppiaCents.mediana.toFixed(2).padStart(6)}¢  ${out.rewardsBassi.A.costoCoppiaCents.mediana.toFixed(2).padStart(6)}¢`);
  console.log(`${'tempo mediano A'.padEnd(32)} ${durata(out.rewardsAlti.A.tempoSec.mediana).padStart(7)}  ${durata(out.rewardsBassi.A.tempoSec.mediana).padStart(7)}`);
  console.log(`${'delta mediano (B)'.padEnd(32)} ${out.rewardsAlti.B.deltaCents.mediana.toFixed(2).padStart(6)}¢  ${out.rewardsBassi.B.deltaCents.mediana.toFixed(2).padStart(6)}¢`);
  console.log(`${'completamento taker (A)'.padEnd(32)} ${String(out.rewardsAlti.A.quotaCompletamentoTaker).padStart(6)}%  ${String(out.rewardsBassi.A.quotaCompletamentoTaker).padStart(6)}%`);
  console.log(`${'ingresso taker'.padEnd(32)} ${String(out.rewardsAlti.quotaIngressoTaker).padStart(6)}%  ${String(out.rewardsBassi.quotaIngressoTaker).padStart(6)}%`);
}

main().catch((e) => { console.error('errore:', e.message); process.exit(1); });
